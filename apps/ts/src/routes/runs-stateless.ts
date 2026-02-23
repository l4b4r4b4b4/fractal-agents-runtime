/**
 * Stateless run route handlers for the Fractal Agents Runtime — TypeScript/Bun.
 *
 * Stateless runs create an ephemeral thread, execute the agent, and return
 * the result. The ephemeral thread is deleted by default (`on_completion="delete"`)
 * or preserved (`on_completion="keep"`).
 *
 * Endpoints:
 *
 *   POST /runs        — Create a stateless run (returns final state)
 *   POST /runs/stream — Create a stateless run with SSE streaming
 *   POST /runs/wait   — Create a stateless run and wait for result
 *
 * All three endpoints share the same pipeline:
 *   1. Validate request body (requires `assistant_id`).
 *   2. Resolve the assistant (by UUID or graph_id fallback).
 *   3. Create an ephemeral thread.
 *   4. Create a run record.
 *   5. Execute the agent (sync for /runs and /runs/wait, SSE for /runs/stream).
 *   6. Handle `on_completion` behaviour (delete or keep the ephemeral thread).
 *
 * Response shapes match the Python runtime's OpenAPI spec field-for-field.
 *
 * Reference:
 *   - apps/python/src/server/routes/streams.py → create_stateless_run_stream
 *   - apps/python/openapi-spec.json → paths /runs, /runs/stream, /runs/wait
 */

import type { Router, RouteHandler } from "../router";
import type { RunCreateStateless } from "../models/run";
import { getStorage } from "../storage/index";
import {
  jsonResponse,
  errorResponse,
  notFound,
  validationError,
  requireBody,
} from "./helpers";
import {
  formatErrorEvent,
  formatEndEvent,
  sseResponse,
} from "./sse";
import {
  resolveAssistant,
  executeRunSync,
} from "./runs";
import { executeRunStream } from "./streams";
import { getUserIdentity } from "../middleware/context";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build the `kwargs` storage blob from a `RunCreateStateless` body.
 *
 * Similar to the stateful `buildRunKwargs` but uses the stateless schema
 * (fewer fields — no interrupt_before/after, no if_not_exists, etc.).
 */
function buildStatelessRunKwargs(
  body: RunCreateStateless,
): Record<string, unknown> {
  return {
    input: body.input ?? null,
    config: body.config ?? null,
    context: body.context ?? null,
    stream_mode: body.stream_mode ?? ["values"],
    webhook: body.webhook ?? null,
  };
}

/**
 * Handle the `on_completion` behaviour for stateless runs.
 *
 * - `"delete"` (default): Delete the ephemeral thread and its run.
 * - `"keep"`: Preserve the thread and run for later inspection.
 *
 * @param threadId - The ephemeral thread ID.
 * @param runId - The run ID.
 * @param onCompletion - The completion strategy.
 */
async function handleOnCompletion(
  threadId: string,
  runId: string,
  onCompletion: string,
): Promise<void> {
  if (onCompletion === "delete") {
    const storage = getStorage();
    try {
      await storage.runs.deleteByThread(threadId, runId);
      await storage.threads.delete(threadId);
    } catch (cleanupError: unknown) {
      // Cleanup failure should not propagate — the response was already sent.
      console.warn(
        "[runs-stateless] Failed to clean up ephemeral thread:",
        cleanupError instanceof Error
          ? cleanupError.message
          : cleanupError,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/**
 * POST /runs
 *
 * Create a stateless run. Creates an ephemeral thread, executes the agent
 * synchronously, and returns the run result. The ephemeral thread is
 * deleted by default.
 *
 * This is equivalent to POST /runs/wait for v0.0.1 (both block until
 * completion). The distinction matters more when background execution
 * is supported in later versions.
 */
const createStatelessRun: RouteHandler = async (request) => {
  const [body, bodyError] = await requireBody<RunCreateStateless>(request);
  if (bodyError) return bodyError;

  if (!body.assistant_id) {
    return validationError("assistant_id is required");
  }

  const storage = getStorage();

  // Resolve assistant
  const assistant = await resolveAssistant(body.assistant_id);
  if (assistant === null) {
    return notFound(`Assistant ${body.assistant_id} not found`);
  }

  const ownerId = getUserIdentity();

  // Create an ephemeral thread
  const ephemeralThread = await storage.threads.create({
    metadata: {
      stateless: true,
      on_completion: body.on_completion ?? "delete",
    },
  }, ownerId);
  const threadId = ephemeralThread.thread_id;

  // Create the run in "running" status
  const run = await storage.runs.create({
    thread_id: threadId,
    assistant_id: assistant.assistant_id as string,
    status: "running",
    metadata: { ...(body.metadata ?? {}), stateless: true },
    kwargs: buildStatelessRunKwargs(body),
  });

  // Execute the agent synchronously (reuse stateful executeRunSync)
  // We need to adapt the body shape slightly since executeRunSync expects RunCreateStateful
  const statefulBody = {
    assistant_id: body.assistant_id,
    input: body.input,
    config: body.config,
    metadata: body.metadata,
    context: body.context,
    webhook: body.webhook,
    stream_mode: body.stream_mode,
  };

  const { state, error } = await executeRunSync(
    run.run_id,
    threadId,
    assistant as Record<string, unknown>,
    statefulBody as Parameters<typeof executeRunSync>[3],
  );

  const onCompletion = body.on_completion ?? "delete";

  if (error !== null) {
    // Clean up on error too
    await handleOnCompletion(threadId, run.run_id, onCompletion);
    return errorResponse(`Agent execution failed: ${error}`, 500);
  }

  // Handle on_completion
  await handleOnCompletion(threadId, run.run_id, onCompletion);

  return jsonResponse(state ?? { values: {}, next: [], tasks: [] });
};

/**
 * POST /runs/stream
 *
 * Create a stateless run and stream output via SSE. Creates an ephemeral
 * thread, streams execution events, and handles on_completion cleanup.
 */
const createStatelessRunStream: RouteHandler = async (request) => {
  const [body, bodyError] = await requireBody<RunCreateStateless>(request);
  if (bodyError) return bodyError;

  if (!body.assistant_id) {
    return validationError("assistant_id is required");
  }

  const storage = getStorage();

  // Resolve assistant
  const assistant = await resolveAssistant(body.assistant_id);
  if (assistant === null) {
    return notFound(`Assistant ${body.assistant_id} not found`);
  }

  const ownerId = getUserIdentity();

  // Create an ephemeral thread
  const ephemeralThread = await storage.threads.create({
    metadata: {
      stateless: true,
      on_completion: body.on_completion ?? "delete",
    },
  }, ownerId);
  const threadId = ephemeralThread.thread_id;

  // Create the run in "running" status
  const run = await storage.runs.create({
    thread_id: threadId,
    assistant_id: assistant.assistant_id as string,
    status: "running",
    metadata: { ...(body.metadata ?? {}), stateless: true },
    kwargs: buildStatelessRunKwargs(body),
  });

  const onCompletion = body.on_completion ?? "delete";

  // Create the SSE generator with lifecycle management
  async function* streamWithLifecycle(): AsyncGenerator<
    string,
    void,
    unknown
  > {
    try {
      yield* executeRunStream(
        run.run_id,
        threadId,
        assistant!.assistant_id as string,
        body!.input,
        (body!.config as Record<string, unknown>) ?? null,
        (assistant!.config as Record<string, unknown>) ?? null,
        (assistant!.graph_id as string) ?? null,
        ownerId,
      );
    } catch (streamError: unknown) {
      const message =
        streamError instanceof Error
          ? streamError.message
          : String(streamError);
      yield formatErrorEvent(message);
      yield formatEndEvent();
    } finally {
      // Update run status
      const currentRun = await storage.runs.get(run.run_id);
      if (currentRun && currentRun.status === "running") {
        await storage.runs.updateStatus(run.run_id, "success");
      }

      // Handle on_completion behaviour
      await handleOnCompletion(threadId, run.run_id, onCompletion);
    }
  }

  return sseResponse(streamWithLifecycle(), {
    runId: run.run_id,
    stateless: true,
  });
};

/**
 * POST /runs/wait
 *
 * Create a stateless run and wait for the result. Identical to POST /runs
 * in v0.0.1 (both block until completion). Included for API compatibility.
 */
const createStatelessRunWait: RouteHandler = async (request) => {
  const [body, bodyError] = await requireBody<RunCreateStateless>(request);
  if (bodyError) return bodyError;

  if (!body.assistant_id) {
    return validationError("assistant_id is required");
  }

  const storage = getStorage();

  // Resolve assistant
  const assistant = await resolveAssistant(body.assistant_id);
  if (assistant === null) {
    return notFound(`Assistant ${body.assistant_id} not found`);
  }

  const ownerId = getUserIdentity();

  // Create an ephemeral thread
  const ephemeralThread = await storage.threads.create({
    metadata: {
      stateless: true,
      on_completion: body.on_completion ?? "delete",
    },
  }, ownerId);
  const threadId = ephemeralThread.thread_id;

  // Create the run in "running" status
  const run = await storage.runs.create({
    thread_id: threadId,
    assistant_id: assistant.assistant_id as string,
    status: "running",
    metadata: { ...(body.metadata ?? {}), stateless: true },
    kwargs: buildStatelessRunKwargs(body),
  });

  // Execute the agent synchronously
  const statefulBody = {
    assistant_id: body.assistant_id,
    input: body.input,
    config: body.config,
    metadata: body.metadata,
    context: body.context,
    webhook: body.webhook,
    stream_mode: body.stream_mode,
  };

  const { state, error } = await executeRunSync(
    run.run_id,
    threadId,
    assistant as Record<string, unknown>,
    statefulBody as Parameters<typeof executeRunSync>[3],
  );

  const onCompletion = body.on_completion ?? "delete";

  if (error !== null) {
    await handleOnCompletion(threadId, run.run_id, onCompletion);
    return errorResponse(`Agent execution failed: ${error}`, 500);
  }

  // Handle on_completion
  await handleOnCompletion(threadId, run.run_id, onCompletion);

  return jsonResponse(state ?? { values: {}, next: [], tasks: [] });
};

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Register all stateless run routes on the given router.
 *
 * @param router - The application router instance.
 */
export function registerStatelessRunRoutes(router: Router): void {
  router.post("/runs", createStatelessRun);
  router.post("/runs/stream", createStatelessRunStream);
  router.post("/runs/wait", createStatelessRunWait);
}
