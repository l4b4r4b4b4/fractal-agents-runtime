/**
 * Stateful run route handlers for the Fractal Agents Runtime — TypeScript/Bun.
 *
 * These endpoints manage runs scoped to a specific thread:
 *
 *   POST   /threads/:thread_id/runs                — Create a run
 *   GET    /threads/:thread_id/runs                — List runs
 *   GET    /threads/:thread_id/runs/:run_id        — Get run by ID
 *   DELETE /threads/:thread_id/runs/:run_id        — Delete a run
 *   POST   /threads/:thread_id/runs/:run_id/cancel — Cancel a running run
 *   GET    /threads/:thread_id/runs/:run_id/join   — Block until run completes
 *   POST   /threads/:thread_id/runs/wait           — Create + wait for result
 *
 * Run lifecycle: pending → running → success / error / timeout / interrupted
 *
 * The `wait` endpoint executes the agent synchronously and returns the final
 * thread state. The `create` endpoint creates the run as "pending" and returns
 * immediately (background execution is deferred to a future enhancement —
 * for v0.0.1 the run stays pending until a stream or wait triggers it).
 *
 * All response shapes match the Python runtime's OpenAPI spec field-for-field.
 *
 * Reference:
 *   - apps/python/src/server/routes/runs.py
 *   - apps/python/openapi-spec.json → paths /threads/{thread_id}/runs/*
 */

import type { Router, RouteHandler } from "../router";
import type { RunCreateStateful } from "../models/run";
import { getStorage, getCheckpointer } from "../storage/index";
import { resolveGraphFactory } from "../graphs/index";
import { injectTracing } from "../infra/tracing";
import {
  jsonResponse,
  errorResponse,
  notFound,
  conflictResponse,
  validationError,
  requireBody,
} from "./helpers";
import { getUserIdentity, getCurrentToken } from "../middleware/context";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Parse `limit` and `offset` query parameters with sensible defaults
 * and bounds clamping.
 */
function parsePagination(query: URLSearchParams): {
  limit: number;
  offset: number;
} {
  let limit = 10;
  let offset = 0;

  const limitParam = query.get("limit");
  if (limitParam !== null) {
    const parsed = parseInt(limitParam, 10);
    if (!Number.isNaN(parsed)) {
      limit = Math.max(1, Math.min(parsed, 100));
    }
  }

  const offsetParam = query.get("offset");
  if (offsetParam !== null) {
    const parsed = parseInt(offsetParam, 10);
    if (!Number.isNaN(parsed)) {
      offset = Math.max(0, parsed);
    }
  }

  return { limit, offset };
}

/**
 * Resolve an assistant by ID or graph_id fallback.
 *
 * The Python runtime allows `assistant_id` to be either a UUID or a
 * graph name. If the direct lookup fails, it falls back to searching
 * all assistants for one whose `graph_id` matches.
 *
 * @returns The assistant object if found, `null` otherwise.
 */
async function resolveAssistant(
  assistantId: string,
): Promise<Record<string, unknown> | null> {
  const storage = getStorage();

  // Direct lookup by UUID
  const assistant = await storage.assistants.get(assistantId);
  if (assistant !== null) {
    return assistant as unknown as Record<string, unknown>;
  }

  // Fallback: search by graph_id
  const allAssistants = await storage.assistants.search({ limit: 100, offset: 0 });
  for (const candidate of allAssistants) {
    if (candidate.graph_id === assistantId) {
      return candidate as unknown as Record<string, unknown>;
    }
  }

  return null;
}

/**
 * Handle multitask conflicts for a thread.
 *
 * Checks if the thread already has an active (pending or running) run.
 * Depending on the strategy:
 *   - "reject"    → returns a 409 error response
 *   - "interrupt" → marks the active run as "interrupted"
 *   - "rollback"  → marks the active run as "error"
 *   - "enqueue"   → no-op, the new run will queue
 *
 * @returns An error Response if the run should be rejected, `null` otherwise.
 */
async function handleMultitaskConflict(
  threadId: string,
  strategy: string,
): Promise<Response | null> {
  const storage = getStorage();
  const activeRun = await storage.runs.getActiveRun(threadId);

  if (activeRun === null) {
    return null; // No conflict.
  }

  if (strategy === "reject") {
    return conflictResponse(
      `Thread ${threadId} already has an active run. ` +
        `Use multitask_strategy='enqueue' to queue runs.`,
    );
  }

  if (strategy === "interrupt") {
    await storage.runs.updateStatus(activeRun.run_id, "interrupted");
  } else if (strategy === "rollback") {
    await storage.runs.updateStatus(activeRun.run_id, "error");
  }
  // "enqueue" → just create the new run, it will wait.

  return null;
}

/**
 * Build the `kwargs` storage blob from a `RunCreateStateful` body.
 */
function buildRunKwargs(
  body: RunCreateStateful,
): Record<string, unknown> {
  return {
    input: body.input ?? null,
    config: body.config ?? null,
    context: body.context ?? null,
    interrupt_before: body.interrupt_before ?? null,
    interrupt_after: body.interrupt_after ?? null,
    stream_mode: body.stream_mode ?? ["values"],
    webhook: body.webhook ?? null,
  };
}

/**
 * Build a RunnableConfig-style dict from assistant + run configuration.
 *
 * Merges assistant-level configurable settings with run-level overrides
 * and runtime metadata. Mirrors Python's `_build_runnable_config()`.
 */
function buildRunnableConfig(
  runId: string,
  threadId: string,
  assistantId: string,
  assistantConfig: Record<string, unknown> | null | undefined,
  runConfig: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const configurable: Record<string, unknown> = {};

  // Layer 1: Assistant-level configuration
  if (assistantConfig && typeof assistantConfig === "object") {
    const assistantConfigurable = (assistantConfig as Record<string, unknown>)
      .configurable;
    if (
      assistantConfigurable &&
      typeof assistantConfigurable === "object"
    ) {
      Object.assign(
        configurable,
        assistantConfigurable as Record<string, unknown>,
      );
    }
  }

  // Layer 2: Run-level configuration (overrides assistant)
  if (runConfig && typeof runConfig === "object") {
    const runConfigurable = (runConfig as Record<string, unknown>).configurable;
    if (runConfigurable && typeof runConfigurable === "object") {
      Object.assign(
        configurable,
        runConfigurable as Record<string, unknown>,
      );
    }
  }

  // Layer 3: Runtime metadata
  configurable.run_id = runId;
  configurable.thread_id = threadId;
  configurable.assistant_id = assistantId;

  // NOTE: checkpoint_ns intentionally NOT set here.
  //
  // We previously set `checkpoint_ns = "assistant:<id>"` for multi-agent
  // isolation (see docs/MULTI_AGENT_CHECKPOINT_ARCHITECTURE.md). However,
  // LangGraph uses checkpoint_ns internally for subgraph hierarchy — it
  // splits on NS_END (":") and NS_SEP ("|") to navigate subgraph trees.
  // Setting it to "assistant:<id>" causes getState()/aget_state() to look
  // for a subgraph named "assistant", which doesn't exist, triggering
  // `ValueError: Subgraph assistant not found` on every state read.
  //
  // Multi-agent checkpoint isolation needs a different approach (e.g.,
  // composite thread_id, or wrapping agents as actual LangGraph subgraphs).

  // Include assistant config reference for graph factory
  if (assistantConfig && typeof assistantConfig === "object") {
    configurable.assistant = assistantConfig;
  }

  // Layer 4: Inject Supabase access token for MCP token exchange.
  // The auth middleware stores the raw Bearer token in request-scoped
  // context. Downstream code (e.g., MCP tool integration) needs it
  // for OAuth2 token exchange with auth-required MCP servers.
  // Mirrors Python's `x-supabase-access-token` in configurable.
  const supabaseAccessToken = getCurrentToken();
  if (supabaseAccessToken) {
    configurable["x-supabase-access-token"] = supabaseAccessToken;
  }

  return configurable;
}

/**
 * Serialize result messages from an agent invocation into plain dicts.
 *
 * This is a fallback used when the checkpointer state read fails.
 * It handles LangChain message objects (with `toJSON` or `_getType`)
 * and plain dicts.
 */
function serializeResultMessages(
  result: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const resultMessages = (result.messages ?? []) as Array<Record<string, unknown>>;
  const serialized: Array<Record<string, unknown>> = [];

  for (const message of resultMessages) {
    const msgAny = message as Record<string, unknown>;

    if (typeof (msgAny as { toJSON?: unknown }).toJSON === "function") {
      serialized.push(
        (msgAny as { toJSON: () => Record<string, unknown> }).toJSON(),
      );
    } else if (typeof (msgAny as { model_dump?: unknown }).model_dump === "function") {
      serialized.push(
        (msgAny as { model_dump: () => Record<string, unknown> }).model_dump(),
      );
    } else {
      const plain: Record<string, unknown> = {};
      const content = msgAny.content;
      const getTypeFn = msgAny._getType;
      const messageType =
        (msgAny.type as string | undefined) ??
        (typeof getTypeFn === "function"
          ? (getTypeFn as () => string)()
          : undefined) ??
        "unknown";
      const messageId = msgAny.id;
      plain.content = content ?? "";
      plain.type = messageType;
      plain.id = messageId ?? null;
      plain.additional_kwargs = msgAny.additional_kwargs ?? {};
      plain.response_metadata = msgAny.response_metadata ?? {};
      if (messageType === "ai") {
        plain.tool_calls = msgAny.tool_calls ?? [];
        plain.invalid_tool_calls = msgAny.invalid_tool_calls ?? [];
        plain.usage_metadata = msgAny.usage_metadata ?? null;
      }
      serialized.push(plain);
    }
  }

  return serialized;
}

/**
 * Execute the agent graph synchronously and update thread/run state.
 *
 * This is the core pipeline used by the `wait` endpoint:
 *   1. Resolve the graph factory from the assistant's graph_id.
 *   2. Build the agent graph (with shared checkpointer for history).
 *   3. Invoke with the input messages.
 *   4. Read accumulated state from checkpointer.
 *   5. Store the result in the thread state.
 *   6. Update run status to success (or error).
 */
async function executeRunSync(
  runId: string,
  threadId: string,
  assistant: Record<string, unknown>,
  body: RunCreateStateful,
  ownerId?: string,
): Promise<{ state: Record<string, unknown> | null; error: string | null }> {
  const storage = getStorage();

  try {
    // 1. Resolve graph factory
    const graphId =
      (assistant.graph_id as string | undefined) ?? "agent";
    const buildGraph = resolveGraphFactory(graphId);

    // 2. Build configurable and agent
    const assistantConfig = assistant.config as
      | Record<string, unknown>
      | null
      | undefined;
    const configurable = buildRunnableConfig(
      runId,
      threadId,
      assistant.assistant_id as string,
      assistantConfig,
      (body.config as Record<string, unknown>) ?? null,
    );

    // The graph factory expects the flat configurable as its config param.
    // Pass the shared checkpointer so the agent accumulates message history
    // across runs on the same thread via the `add_messages` reducer.
    const agent = (await buildGraph(configurable, {
      checkpointer: getCheckpointer(),
    })) as {
      invoke: (
        input: Record<string, unknown>,
        config?: Record<string, unknown>,
      ) => Promise<Record<string, unknown>>;
      getState: (
        config: Record<string, unknown>,
      ) => Promise<{ values: Record<string, unknown> }>;
    };

    // 3. Build input
    let inputMessages: Array<Record<string, unknown>> = [];

    if (body.input && typeof body.input === "object" && !Array.isArray(body.input)) {
      const rawMessages = (body.input as Record<string, unknown>).messages;
      if (Array.isArray(rawMessages)) {
        for (const msg of rawMessages) {
          if (typeof msg === "object" && msg !== null) {
            inputMessages.push(msg as Record<string, unknown>);
          } else if (typeof msg === "string") {
            inputMessages.push({
              content: msg,
              type: "human",
              id: crypto.randomUUID(),
            });
          }
        }
      }
    } else if (typeof body.input === "string") {
      inputMessages = [
        {
          content: body.input,
          type: "human",
          id: crypto.randomUUID(),
        },
      ];
    }

    const agentInput = { messages: inputMessages };
    const runnableConfig = {
      configurable: {
        thread_id: threadId,
        ...configurable,
      },
    };

    // 4. Inject Langfuse tracing (no-op if not configured)
    const tracedConfig = injectTracing(runnableConfig, {
      userId: ownerId,
      sessionId: threadId,
      traceName: "agent-run",
      tags: ["bun", "sync"],
    });

    // 5. Invoke — the checkpointer provides previous history to the LLM
    // internally via the `add_messages` reducer. We only pass NEW input.
    const result = await agent.invoke(agentInput, tracedConfig);

    // 5. Read full accumulated state from checkpointer.
    //
    // The checkpointer is the source of truth for message history.
    // It accumulates messages across runs via the `add_messages` reducer.
    // We read the full state and write it to the runtime storage so that
    // `GET /threads/{id}/state` returns the complete conversation history.
    let finalValues: Record<string, unknown>;
    try {
      const checkpointState = await agent.getState(runnableConfig);
      if (checkpointState?.values) {
        const accumulatedMessages = (checkpointState.values.messages ?? []) as Array<unknown>;
        const serializedAccumulated: Array<Record<string, unknown>> = [];

        for (const message of accumulatedMessages) {
          if (typeof message === "object" && message !== null) {
            const msgAny = message as Record<string, unknown>;

            if (typeof (msgAny as { toJSON?: unknown }).toJSON === "function") {
              serializedAccumulated.push(
                (msgAny as { toJSON: () => Record<string, unknown> }).toJSON(),
              );
            } else if (typeof (msgAny as { model_dump?: unknown }).model_dump === "function") {
              serializedAccumulated.push(
                (msgAny as { model_dump: () => Record<string, unknown> }).model_dump(),
              );
            } else {
              const plain: Record<string, unknown> = {};
              const content = msgAny.content;
              const getTypeFn = msgAny._getType;
              const messageType =
                (msgAny.type as string | undefined) ??
                (typeof getTypeFn === "function"
                  ? (getTypeFn as () => string)()
                  : undefined) ??
                "unknown";
              const messageId = msgAny.id;
              plain.content = content ?? "";
              plain.type = messageType;
              plain.id = messageId ?? null;
              plain.additional_kwargs = msgAny.additional_kwargs ?? {};
              plain.response_metadata = msgAny.response_metadata ?? {};
              if (messageType === "ai") {
                plain.tool_calls = msgAny.tool_calls ?? [];
                plain.invalid_tool_calls = msgAny.invalid_tool_calls ?? [];
                plain.usage_metadata = msgAny.usage_metadata ?? null;
              }
              serializedAccumulated.push(plain);
            }
          }
        }

        console.log(
          `[runs] Read ${serializedAccumulated.length} accumulated messages from checkpointer for thread ${threadId}`,
        );
        finalValues = { messages: serializedAccumulated };
      } else {
        console.warn(
          `[runs] Checkpointer returned empty state for thread ${threadId}, falling back to current run messages`,
        );
        // Fallback: serialize current result messages only
        finalValues = { messages: serializeResultMessages(result) };
      }
    } catch (stateReadError: unknown) {
      console.warn(
        "[runs] Failed to read accumulated state from checkpointer, falling back to current run messages:",
        stateReadError instanceof Error ? stateReadError.message : stateReadError,
      );
      finalValues = { messages: serializeResultMessages(result) };
    }

    // Store state (with correct key shape for addStateSnapshot)
    await storage.threads.addStateSnapshot(threadId, { values: finalValues });
    await storage.threads.update(threadId, { values: finalValues });

    // Mark run as success
    await storage.runs.updateStatus(runId, "success");

    // Mark thread as idle
    await storage.threads.update(threadId, { status: "idle" });

    // Return thread state
    const state = await storage.threads.getState(threadId, ownerId);
    return { state: state as Record<string, unknown> | null, error: null };
  } catch (executionError: unknown) {
    const errorMessage =
      executionError instanceof Error
        ? executionError.message
        : String(executionError);

    // Mark run as error
    await storage.runs.updateStatus(runId, "error");

    // Mark thread as idle
    await storage.threads.update(threadId, { status: "idle" });

    return { state: null, error: errorMessage };
  }
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/**
 * POST /threads/:thread_id/runs
 *
 * Create a background run for a thread. The run is created in "pending"
 * status and returned immediately.
 */
const createRun: RouteHandler = async (request, params) => {
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
  const ownerId = getUserIdentity();

  // Check if thread exists
  const thread = await storage.threads.get(threadId, ownerId);
  if (thread === null) {
    if (body.if_not_exists === "create") {
      await storage.threads.create({}, ownerId);
      // Note: we use the original threadId since the caller specified it
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
  const conflictError = await handleMultitaskConflict(threadId, strategy);
  if (conflictError) return conflictError;

  // Create the run record
  const run = await storage.runs.create({
    thread_id: threadId,
    assistant_id: assistant.assistant_id as string,
    status: "pending",
    metadata: body.metadata ?? {},
    kwargs: buildRunKwargs(body),
    multitask_strategy: strategy,
  });

  // Update thread status to busy
  await storage.threads.update(threadId, { status: "busy" });

  // Return with Content-Location header
  return jsonResponse(run, 200, {
    "Content-Location": `/threads/${threadId}/runs/${run.run_id}`,
  });
};

/**
 * GET /threads/:thread_id/runs
 *
 * List runs for a thread with pagination and optional status filter.
 */
const listRuns: RouteHandler = async (_request, params, query) => {
  const threadId = params.thread_id;
  if (!threadId) {
    return validationError("thread_id is required");
  }

  const storage = getStorage();
  const ownerId = getUserIdentity();

  // Check if thread exists
  const thread = await storage.threads.get(threadId, ownerId);
  if (thread === null) {
    return notFound(`Thread ${threadId} not found`);
  }

  const { limit, offset } = parsePagination(query);

  const statusParam = query.get("status") ?? undefined;
  const status = statusParam as
    | "pending"
    | "running"
    | "success"
    | "error"
    | "timeout"
    | "interrupted"
    | undefined;

  const runs = await storage.runs.listByThread(
    threadId,
    limit,
    offset,
    status,
  );

  return jsonResponse(runs);
};

/**
 * GET /threads/:thread_id/runs/:run_id
 *
 * Get a specific run by ID.
 */
const getRun: RouteHandler = async (_request, params) => {
  const threadId = params.thread_id;
  const runId = params.run_id;

  if (!threadId) return validationError("thread_id is required");
  if (!runId) return validationError("run_id is required");

  const storage = getStorage();
  const ownerId = getUserIdentity();

  // Check thread exists
  const thread = await storage.threads.get(threadId, ownerId);
  if (thread === null) {
    return notFound(`Thread ${threadId} not found`);
  }

  const run = await storage.runs.getByThread(threadId, runId);
  if (run === null) {
    return notFound(`Run ${runId} not found`);
  }

  return jsonResponse(run);
};

/**
 * DELETE /threads/:thread_id/runs/:run_id
 *
 * Delete a run. Returns empty object on success.
 */
const deleteRun: RouteHandler = async (_request, params) => {
  const threadId = params.thread_id;
  const runId = params.run_id;

  if (!threadId) return validationError("thread_id is required");
  if (!runId) return validationError("run_id is required");

  const storage = getStorage();
  const ownerId = getUserIdentity();

  // Check thread exists
  const thread = await storage.threads.get(threadId, ownerId);
  if (thread === null) {
    return notFound(`Thread ${threadId} not found`);
  }

  const deleted = await storage.runs.deleteByThread(threadId, runId);
  if (!deleted) {
    return notFound(`Run ${runId} not found`);
  }

  return jsonResponse({});
};

/**
 * POST /threads/:thread_id/runs/:run_id/cancel
 *
 * Cancel a pending or running run. Returns empty object on success.
 * Only pending/running runs can be cancelled (→ 409 otherwise).
 */
const cancelRun: RouteHandler = async (_request, params) => {
  const threadId = params.thread_id;
  const runId = params.run_id;

  if (!threadId) return validationError("thread_id is required");
  if (!runId) return validationError("run_id is required");

  const storage = getStorage();
  const ownerId = getUserIdentity();

  // Check thread exists
  const thread = await storage.threads.get(threadId, ownerId);
  if (thread === null) {
    return notFound(`Thread ${threadId} not found`);
  }

  const run = await storage.runs.getByThread(threadId, runId);
  if (run === null) {
    return notFound(`Run ${runId} not found`);
  }

  // Can only cancel pending or running runs
  if (run.status !== "pending" && run.status !== "running") {
    return conflictResponse(
      `Cannot cancel run with status '${run.status}'`,
    );
  }

  await storage.runs.updateStatus(runId, "interrupted");
  await storage.threads.update(threadId, { status: "idle" }, ownerId);

  return jsonResponse({});
};

/**
 * GET /threads/:thread_id/runs/:run_id/join
 *
 * Block until a run completes and return the thread state.
 *
 * In v0.0.1, this is a simplified implementation: if the run is already
 * complete, return the thread state immediately. If still running, poll
 * briefly. Real long-polling / WebSocket upgrades are deferred.
 */
const joinRun: RouteHandler = async (_request, params) => {
  const threadId = params.thread_id;
  const runId = params.run_id;

  if (!threadId) return validationError("thread_id is required");
  if (!runId) return validationError("run_id is required");

  const storage = getStorage();
  const ownerId = getUserIdentity();

  // Check thread exists
  const thread = await storage.threads.get(threadId, ownerId);
  if (thread === null) {
    return notFound(`Thread ${threadId} not found`);
  }

  const run = await storage.runs.getByThread(threadId, runId);
  if (run === null) {
    return notFound(`Run ${runId} not found`);
  }

  // If run is terminal, return immediately
  const terminalStatuses = ["success", "error", "timeout", "interrupted"];
  if (terminalStatuses.includes(run.status)) {
    const state = await storage.threads.getState(threadId, ownerId);
    return jsonResponse(state ?? { values: {}, next: [], tasks: [] });
  }

  // Simple polling for pending/running runs (max ~5s)
  const maxAttempts = 50;
  const pollIntervalMs = 100;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));

    const currentRun = await storage.runs.getByThread(threadId, runId);
    if (
      currentRun === null ||
      terminalStatuses.includes(currentRun.status)
    ) {
      const state = await storage.threads.getState(threadId, ownerId);
      return jsonResponse(state ?? { values: {}, next: [], tasks: [] });
    }
  }

  // Timeout — return current state anyway
  const state = await storage.threads.getState(threadId, ownerId);
  return jsonResponse(state ?? { values: {}, next: [], tasks: [] });
};

/**
 * POST /threads/:thread_id/runs/wait
 *
 * Create a run and wait for the result. This endpoint blocks until the
 * agent completes execution, then returns the final thread state.
 */
const createRunWait: RouteHandler = async (request, params) => {
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
  const ownerId = getUserIdentity();

  // Check if thread exists
  let effectiveThreadId = threadId;
  const thread = await storage.threads.get(threadId, ownerId);
  if (thread === null) {
    if (body.if_not_exists === "create") {
      const newThread = await storage.threads.create({}, ownerId);
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
  const strategy = body.multitask_strategy ?? "reject";
  const conflictError = await handleMultitaskConflict(
    effectiveThreadId,
    strategy,
  );
  if (conflictError) return conflictError;

  // Create the run in "running" status (it will execute immediately)
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

  // Execute the agent synchronously
  const { state, error } = await executeRunSync(
    run.run_id,
    effectiveThreadId,
    assistant,
    body,
    ownerId,
  );

  if (error !== null) {
    return errorResponse(`Agent execution failed: ${error}`, 500);
  }

  return jsonResponse(state ?? { values: {}, next: [], tasks: [] }, 200, {
    "Content-Location": `/threads/${effectiveThreadId}/runs/${run.run_id}`,
  });
};

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Register all stateful run routes on the given router.
 *
 * @param router - The application router instance.
 */
export function registerRunRoutes(router: Router): void {
  // CRUD
  router.post("/threads/:thread_id/runs", createRun);
  router.get("/threads/:thread_id/runs", listRuns);
  router.get("/threads/:thread_id/runs/:run_id", getRun);
  router.delete("/threads/:thread_id/runs/:run_id", deleteRun);

  // Lifecycle
  router.post("/threads/:thread_id/runs/:run_id/cancel", cancelRun);
  router.get("/threads/:thread_id/runs/:run_id/join", joinRun);

  // Synchronous execution
  router.post("/threads/:thread_id/runs/wait", createRunWait);
}

// ---------------------------------------------------------------------------
// Exports (for use by streams.ts and runs-stateless.ts)
// ---------------------------------------------------------------------------

export {
  resolveAssistant,
  handleMultitaskConflict,
  buildRunKwargs,
  buildRunnableConfig,
  executeRunSync,
};
