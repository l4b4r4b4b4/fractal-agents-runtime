/**
 * SSE streaming route handlers for the Fractal Agents Runtime — TypeScript/Bun.
 *
 * These endpoints handle real-time streaming of agent execution:
 *
 *   POST /threads/:thread_id/runs/stream       — Create run + SSE stream
 *   GET  /threads/:thread_id/runs/:run_id/stream — Reconnect to existing stream
 *
 * The core engine is `executeRunStream`, an async generator that:
 *   1. Emits a metadata event (run_id, attempt).
 *   2. Parses input messages and emits initial values.
 *   3. Builds the agent from the graph registry.
 *   4. Streams agent events (messages, updates) as SSE.
 *   5. Emits final values and end marker.
 *
 * SSE wire format matches the LangGraph API exactly:
 *
 *   event: metadata
 *   data: {"run_id":"...","attempt":1}
 *
 *   event: values
 *   data: {"messages":[...]}
 *
 *   event: messages
 *   data: [message_delta, metadata]
 *
 *   event: end
 *   data: ""
 *
 * Reference:
 *   - apps/python/src/server/routes/streams.py
 *   - apps/python/src/server/routes/sse.py
 *   - apps/python/openapi-spec.json → paths /threads/{thread_id}/runs/stream
 */

import type { Router, RouteHandler } from "../router";
import type { RunCreateStateful } from "../models/run";
import { getStorage } from "../storage/index";
import { resolveGraphFactory } from "../graphs/index";
import {
  notFound,
  validationError,
  requireBody,
} from "./helpers";
import {
  formatMetadataEvent,
  formatValuesEvent,
  formatMessagesTupleEvent,
  formatUpdatesEvent,
  formatErrorEvent,
  formatEndEvent,
  createHumanMessage,
  createAiMessage,
  sseResponse,
} from "./sse";
import {
  resolveAssistant,
  handleMultitaskConflict,
  buildRunKwargs,
  buildRunnableConfig,
} from "./runs";

// ---------------------------------------------------------------------------
// Input message extraction
// ---------------------------------------------------------------------------

/**
 * Extract input messages from the run request body's `input` field.
 *
 * Supports multiple input formats:
 *   - `{ messages: [...] }` — array of message dicts or strings
 *   - `string` — treated as a single human message
 *   - `null/undefined` — returns empty array
 *
 * Each message is normalised to a plain dict with at least `content`,
 * `type`, and `id` fields.
 *
 * @param input - The `input` field from `RunCreateStateful`.
 * @returns Array of message dicts ready for agent invocation and SSE emission.
 */
function extractInputMessages(
  input: unknown,
): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [];

  if (input === null || input === undefined) {
    return messages;
  }

  if (typeof input === "string") {
    messages.push(
      createHumanMessage(input, crypto.randomUUID()),
    );
    return messages;
  }

  if (typeof input === "object" && !Array.isArray(input)) {
    const inputObj = input as Record<string, unknown>;

    // Handle { messages: [...] } format
    const rawMessages = inputObj.messages;
    if (Array.isArray(rawMessages)) {
      for (const msg of rawMessages) {
        if (typeof msg === "string") {
          messages.push(
            createHumanMessage(msg, crypto.randomUUID()),
          );
        } else if (typeof msg === "object" && msg !== null) {
          const msgDict = msg as Record<string, unknown>;
          const content = String(msgDict.content ?? "");
          const msgType =
            (msgDict.type as string) ??
            (msgDict.role as string) ??
            "human";
          const msgId =
            (msgDict.id as string) ?? crypto.randomUUID();

          // Normalise to LangChain message format
          if (msgType === "human" || msgType === "user") {
            messages.push(createHumanMessage(content, msgId));
          } else if (msgType === "ai" || msgType === "assistant") {
            messages.push(createAiMessage(content, msgId));
          } else {
            // Default to human
            messages.push(createHumanMessage(content, msgId));
          }
        }
      }
      return messages;
    }

    // Handle { input: "..." } fallback
    if ("input" in inputObj) {
      messages.push(
        createHumanMessage(
          String(inputObj.input),
          crypto.randomUUID(),
        ),
      );
      return messages;
    }
  }

  return messages;
}

// ---------------------------------------------------------------------------
// Core streaming engine
// ---------------------------------------------------------------------------

/**
 * Execute a run using the agent graph and yield SSE event strings.
 *
 * This is the core streaming engine used by both stateful and stateless
 * streaming endpoints. It resolves the graph factory, builds the agent,
 * invokes it, and yields SSE-formatted events for the client.
 *
 * In v0.0.1, streaming is simulated — the agent is invoked synchronously
 * (`.invoke()`) and the response is emitted as SSE events. True token-level
 * streaming via `.streamEvents()` will be added in a future version when
 * `@langchain/langgraph` streaming APIs are stable.
 *
 * Event sequence:
 *   1. `event: metadata` — run identification
 *   2. `event: values` — initial state (input messages)
 *   3. `event: messages` — AI message deltas (currently one full message)
 *   4. `event: updates` — graph node updates
 *   5. `event: values` — final state (all messages)
 *   6. `event: end` — stream terminator
 *
 * @param runId - The run ID.
 * @param threadId - The thread ID.
 * @param assistantId - The resolved assistant ID (UUID).
 * @param inputData - The raw `input` field from the request body.
 * @param config - Run-level configuration overrides.
 * @param assistantConfig - Configuration from the assistant record.
 * @param graphId - The assistant's `graph_id` (e.g., "agent").
 * @yields SSE-formatted event strings.
 */
export async function* executeRunStream(
  runId: string,
  threadId: string,
  assistantId: string,
  inputData: unknown,
  config: Record<string, unknown> | null | undefined,
  assistantConfig: Record<string, unknown> | null | undefined,
  graphId?: string | null,
): AsyncGenerator<string, void, unknown> {
  const storage = getStorage();

  // 1. Emit metadata event (always first)
  yield formatMetadataEvent(runId, 1);

  // 2. Extract input messages and emit initial values
  const inputMessages = extractInputMessages(inputData);
  const initialValues = { messages: inputMessages };
  yield formatValuesEvent(initialValues);

  // 3. Build configurable
  const configurable = buildRunnableConfig(
    runId,
    threadId,
    assistantId,
    assistantConfig,
    config,
  );

  // 4. Build agent from graph registry
  let agent: {
    invoke: (
      input: Record<string, unknown>,
      config?: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>;
  };

  try {
    const buildGraph = resolveGraphFactory(graphId ?? undefined);
    agent = (await buildGraph(configurable)) as typeof agent;
  } catch (agentBuildError: unknown) {
    const message =
      agentBuildError instanceof Error
        ? agentBuildError.message
        : String(agentBuildError);
    yield formatErrorEvent(
      `Failed to initialize agent: ${message}`,
      "AGENT_INIT_ERROR",
    );
    yield formatEndEvent();
    return;
  }

  // Track state for SSE event generation
  const allMessages: Array<Record<string, unknown>> = [...inputMessages];
  let finalAiMessageDict: Record<string, unknown> | null = null;

  // 5. Invoke agent (synchronous invocation with SSE framing)
  //
  // In v0.0.1 we use `.invoke()` and emit the response as SSE events.
  // True token-level streaming (`.streamEvents()`) will be added later.
  try {
    const agentInput = { messages: inputMessages };
    const runnableConfig = {
      configurable: {
        thread_id: threadId,
        ...configurable,
      },
    };

    const result = await agent.invoke(agentInput, runnableConfig);

    // Extract messages from result
    const resultMessages = (result.messages ?? []) as Array<unknown>;

    for (const message of resultMessages) {
      // Determine message type and content
      let messageContent = "";
      let messageType = "unknown";
      let messageId: string | null = null;

      if (typeof message === "object" && message !== null) {
        const msgObj = message as Record<string, unknown>;

        messageContent = String(msgObj.content ?? "");
        messageId = (msgObj.id as string) ?? null;

        // Handle LangChain message objects (have _getType method)
        if (typeof (msgObj as { _getType?: unknown })._getType === "function") {
          messageType = (
            msgObj as { _getType: () => string }
          )._getType();
        } else {
          messageType = String(msgObj.type ?? "unknown");
        }

        // Serialize the message for storage
        let serialized: Record<string, unknown>;
        if (typeof (msgObj as { toJSON?: unknown }).toJSON === "function") {
          serialized = (
            msgObj as { toJSON: () => Record<string, unknown> }
          ).toJSON();
        } else {
          serialized = {
            content: messageContent,
            type: messageType,
            id: messageId,
            additional_kwargs: msgObj.additional_kwargs ?? {},
            response_metadata: msgObj.response_metadata ?? {},
          };
          if (messageType === "ai") {
            serialized.tool_calls = msgObj.tool_calls ?? [];
            serialized.invalid_tool_calls =
              msgObj.invalid_tool_calls ?? [];
            serialized.usage_metadata = msgObj.usage_metadata ?? null;
          }
        }

        // Emit SSE events for AI messages
        if (messageType === "ai") {
          const aiMsgId =
            messageId ?? `run-${runId}`;

          // Build metadata for messages-tuple event
          const eventMetadata: Record<string, unknown> = {
            graph_id: graphId ?? "agent",
            assistant_id: assistantId,
            run_id: runId,
            thread_id: threadId,
            langgraph_node: "model",
            langgraph_step: 1,
            langgraph_checkpoint_ns: "",
          };

          // Emit the AI message content as a messages-tuple event
          const aiMessageDict = createAiMessage(
            messageContent,
            aiMsgId,
            {
              finishReason: "stop",
              modelProvider: "openai",
            },
          );
          yield formatMessagesTupleEvent(aiMessageDict, eventMetadata);

          finalAiMessageDict = serialized;
        }

        allMessages.push(serialized);
      }
    }

    // Emit updates event with the model output
    if (finalAiMessageDict !== null) {
      yield formatUpdatesEvent("model", {
        messages: [finalAiMessageDict],
      });
    }
  } catch (streamError: unknown) {
    const message =
      streamError instanceof Error
        ? streamError.message
        : String(streamError);
    yield formatErrorEvent(message, "STREAM_ERROR");
    // Don't return — still emit final values with what we have
  }

  // 6. Emit final values event
  const finalValues = { messages: allMessages };
  yield formatValuesEvent(finalValues);

  // Store final state in thread
  try {
    await storage.threads.addStateSnapshot(threadId, finalValues as Record<string, unknown>);
    await storage.threads.update(threadId, { values: finalValues as Record<string, unknown> });
  } catch (persistError: unknown) {
    // Persistence failure should not prevent the stream from completing
    console.warn(
      "[streams] Failed to persist run state:",
      persistError instanceof Error ? persistError.message : persistError,
    );
  }

  // 7. Emit end marker
  yield formatEndEvent();
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/**
 * POST /threads/:thread_id/runs/stream
 *
 * Create a run and stream output via SSE. The response is a
 * `text/event-stream` containing LangGraph-compatible SSE events.
 */
const createRunStream: RouteHandler = async (request, params) => {
  const threadId = params.thread_id;
  if (!threadId) {
    return validationError("thread_id is required");
  }

  const [body, bodyError] = await requireBody<RunCreateStateful>(request);
  if (bodyError) return bodyError;

  if (!body.assistant_id) {
    return validationError("assistant_id is required");
  }

  const storage = getStorage();

  // Check if thread exists
  let effectiveThreadId = threadId;
  const thread = await storage.threads.get(threadId);
  if (thread === null) {
    if (body.if_not_exists === "create") {
      const newThread = await storage.threads.create({});
      effectiveThreadId = newThread.thread_id;
    } else {
      return notFound(`Thread ${threadId} not found`);
    }
  }

  // Resolve assistant
  const assistant = await resolveAssistant(body.assistant_id);
  if (assistant === null) {
    return notFound(`Assistant ${body.assistant_id} not found`);
  }

  // Handle multitask conflicts
  const strategy = body.multitask_strategy ?? "enqueue";
  const conflictError = await handleMultitaskConflict(
    effectiveThreadId,
    strategy,
  );
  if (conflictError) return conflictError;

  // Create the run in "running" status
  const run = await storage.runs.create({
    thread_id: effectiveThreadId,
    assistant_id: assistant.assistant_id as string,
    status: "running",
    metadata: body.metadata ?? {},
    kwargs: buildRunKwargs(body),
    multitask_strategy: strategy,
  });

  // Update thread status to busy
 await storage.threads.update(effectiveThreadId, { status: "busy" });

  // Create the SSE generator with lifecycle management
  async function* streamWithLifecycle(): AsyncGenerator<
    string,
    void,
    unknown
  > {
    try {
      yield* executeRunStream(
        run.run_id,
        effectiveThreadId,
        assistant!.assistant_id as string,
        body!.input,
        (body!.config as Record<string, unknown>) ?? null,
        (assistant!.config as Record<string, unknown>) ?? null,
        (assistant!.graph_id as string) ?? null,
      );
    } catch (streamError: unknown) {
      const message =
        streamError instanceof Error
          ? streamError.message
          : String(streamError);
      yield formatErrorEvent(message);
      yield formatEndEvent();
    } finally {
      // Update run status and thread status
      const currentRun = await storage.runs.get(run.run_id);
      if (currentRun && currentRun.status === "running") {
        await storage.runs.updateStatus(run.run_id, "success");
      }
      await storage.threads.update(effectiveThreadId, {
        status: "idle" as const,
      });
    }
  }

  return sseResponse(streamWithLifecycle(), {
    threadId: effectiveThreadId,
    runId: run.run_id,
  });
};

/**
 * GET /threads/:thread_id/runs/:run_id/stream
 *
 * Reconnect to an existing run's SSE stream. For v0.0.1, this returns
 * the current run status and thread state as SSE events (no live
 * reconnection to an in-progress stream).
 */
const joinRunStream: RouteHandler = async (_request, params) => {
  const threadId = params.thread_id;
  const runId = params.run_id;

  if (!threadId) return validationError("thread_id is required");
  if (!runId) return validationError("run_id is required");

  const storage = getStorage();

  // Check thread exists
  const thread = await storage.threads.get(threadId);
  if (thread === null) {
    return notFound(`Thread ${threadId} not found`);
  }

  // Check run exists
  const run = await storage.runs.getByThread(threadId, runId);
  if (run === null) {
    return notFound(`Run ${runId} not found`);
  }

  // Create a simple SSE generator with current state
  async function* statusGenerator(): AsyncGenerator<
    string,
    void,
    unknown
  > {
    // Emit metadata event
    yield formatMetadataEvent(runId, 1);

    // Emit current values from thread state
    const state = await storage.threads.getState(threadId);
    if (state !== null) {
      const stateValues =
        typeof state === "object" && "values" in (state as unknown as Record<string, unknown>)
              ? ((state as unknown as Record<string, unknown>).values as Record<string, unknown>)
              : { values: state };
      yield formatValuesEvent(
        stateValues && typeof stateValues === "object"
          ? (stateValues as Record<string, unknown>)
          : { values: stateValues },
      );
    }

    // If run is already completed, emit status update
    const terminalStatuses = [
      "success",
      "error",
      "interrupted",
    ];
    if (run !== null && terminalStatuses.includes(run.status)) {
      yield formatUpdatesEvent("status", {
        status: run!.status,
        message: "Run already completed",
      });
    }

    // End marker
    yield formatEndEvent();
  }

  return sseResponse(statusGenerator(), {
    threadId,
    runId,
  });
};

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Register SSE streaming routes on the given router.
 *
 * @param router - The application router instance.
 */
export function registerStreamRoutes(router: Router): void {
  router.post("/threads/:thread_id/runs/stream", createRunStream);
  router.get(
    "/threads/:thread_id/runs/:run_id/stream",
    joinRunStream,
  );
}
