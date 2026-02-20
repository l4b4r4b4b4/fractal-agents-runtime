/**
 * Thread routes for the Fractal Agents Runtime — TypeScript/Bun.
 *
 * Implements LangGraph-compatible endpoints matching the Python runtime:
 *
 *   POST   /threads                      — Create a new thread
 *   GET    /threads/:thread_id           — Get a thread by ID
 *   PATCH  /threads/:thread_id           — Update a thread (metadata only)
 *   DELETE /threads/:thread_id           — Delete a thread
 *   GET    /threads/:thread_id/state     — Get current thread state
 *   GET    /threads/:thread_id/history   — Get state history (query: limit, before)
 *   POST   /threads/:thread_id/history   — Get state history (body: limit, before)
 *   POST   /threads/search               — Search/list threads
 *   POST   /threads/count                — Count threads
 *
 * Response conventions (matching Python exactly):
 *   - Create returns 200 (not 201) with the Thread object.
 *   - Delete returns 200 with `{}` (empty object, NOT `{"ok": true}`).
 *   - Count returns 200 with a bare integer (e.g., `3`).
 *   - Search returns 200 with a JSON array of Thread objects.
 *   - State returns 200 with a ThreadState object.
 *   - History returns 200 with a JSON array of ThreadState objects.
 *   - Errors use `{"detail": "..."}` shape (ErrorResponse).
 *
 * Owner isolation (v0.0.2):
 *   - All operations pass `ownerId` from the authenticated user context.
 *   - When auth is disabled, `ownerId` is `undefined` — no filtering.
 *   - On create, `metadata.owner` is set to the user's identity.
 *   - On update/delete, only the actual owner can mutate.
 *
 * Reference: apps/python/src/server/routes/threads.py
 */

import type { Router } from "../router";
import type {
  ThreadCreate,
  ThreadPatch,
  ThreadSearchRequest,
  ThreadCountRequest,
} from "../models/thread";
import {
  jsonResponse,
  errorResponse,
  validationError,
  parseBody,
  requireBody,
} from "./helpers";
import { getStorage } from "../storage/index";
import { getUserIdentity } from "../middleware/context";

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Register all thread routes on the given router.
 *
 * @param router - The application Router instance.
 */
export function registerThreadRoutes(router: Router): void {
  // IMPORTANT: Register /threads/search and /threads/count BEFORE
  // /threads/:thread_id so that "search" and "count" are matched
  // as literal path segments, not captured as :thread_id params.
  router.post("/threads/search", handleSearchThreads);
  router.post("/threads/count", handleCountThreads);

  router.post("/threads", handleCreateThread);
  router.get("/threads/:thread_id", handleGetThread);
  router.patch("/threads/:thread_id", handlePatchThread);
  router.delete("/threads/:thread_id", handleDeleteThread);
  router.get("/threads/:thread_id/state", handleGetThreadState);
  router.get("/threads/:thread_id/history", handleGetThreadHistory);
  router.post("/threads/:thread_id/history", handlePostThreadHistory);
}

// ---------------------------------------------------------------------------
// POST /threads — Create
// ---------------------------------------------------------------------------

/**
 * Create a new thread.
 *
 * Request body: ThreadCreate (all fields optional)
 * Response: Thread (200) or error (409, 422)
 *
 * Handles `if_exists` strategy at the route level (matching Python):
 *   - "raise" (default): returns 409 if thread_id already exists.
 *   - "do_nothing": returns the existing thread unchanged (200).
 *
 * Python allows empty body (all ThreadCreate fields are optional).
 * We match that by treating a missing/empty body as `{}`.
 */
async function handleCreateThread(request: Request): Promise<Response> {
  // Lenient body parsing: ThreadCreate has all-optional fields, so empty is ok.
  // But if a body IS provided, it must be valid JSON.
  const contentType = request.headers.get("Content-Type") || "";
  let body: ThreadCreate;

  if (contentType.includes("application/json")) {
    const parsed = await parseBody<ThreadCreate>(request);
    if (parsed === null) {
      return validationError("Request body must be valid JSON");
    }
    body = parsed;
  } else {
    // No Content-Type or not JSON — treat as empty body (all optional)
    body = {};
  }

  const storage = getStorage();
  const ownerId = getUserIdentity();

  // Pre-check for duplicates if thread_id is explicitly provided
  // (matching Python route-level logic)
  if (body.thread_id) {
    const existing = await storage.threads.get(body.thread_id, ownerId);
    if (existing) {
      const strategy = body.if_exists ?? "raise";
      if (strategy === "do_nothing") {
        return jsonResponse(existing);
      }
      return errorResponse(
        `Thread ${body.thread_id} already exists`,
        409,
      );
    }
  }

  try {
    const thread = await storage.threads.create(body, ownerId);
    return jsonResponse(thread);
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "Failed to create thread";
    return validationError(message);
  }
}

// ---------------------------------------------------------------------------
// GET /threads/:thread_id — Get
// ---------------------------------------------------------------------------

/**
 * Get a thread by ID.
 *
 * Response: Thread (200) or error (404)
 */
async function handleGetThread(
  _request: Request,
  params: Record<string, string>,
): Promise<Response> {
  const threadId = params.thread_id;
  if (!threadId) {
    return validationError("thread_id is required");
  }

  const storage = getStorage();
  const ownerId = getUserIdentity();
  const thread = await storage.threads.get(threadId, ownerId);

  if (thread === null) {
    return errorResponse(`Thread ${threadId} not found`, 404);
  }

  return jsonResponse(thread);
}

// ---------------------------------------------------------------------------
// PATCH /threads/:thread_id — Update
// ---------------------------------------------------------------------------

/**
 * Update a thread (partial update — currently metadata only).
 *
 * Request body: ThreadPatch (metadata optional)
 * Response: Thread (200) or error (404, 422)
 */
async function handlePatchThread(
  request: Request,
  params: Record<string, string>,
): Promise<Response> {
  const threadId = params.thread_id;
  if (!threadId) {
    return validationError("thread_id is required");
  }

  const [body, errorResp] = await requireBody<ThreadPatch>(request);
  if (errorResp) return errorResp;

  const storage = getStorage();
  const ownerId = getUserIdentity();

  // Check existence first (matching Python which returns 404 before attempting update)
  const existing = await storage.threads.get(threadId, ownerId);
  if (existing === null) {
    return errorResponse(`Thread ${threadId} not found`, 404);
  }

  const updated = await storage.threads.update(threadId, body, ownerId);

  if (updated === null) {
    return errorResponse(`Thread ${threadId} not found`, 404);
  }

  return jsonResponse(updated);
}

// ---------------------------------------------------------------------------
// DELETE /threads/:thread_id — Delete
// ---------------------------------------------------------------------------

/**
 * Delete a thread and its state history.
 *
 * Response: `{}` (200) or error (404)
 *
 * Returns empty object on success — NOT `{"ok": true}`.
 * See Critical Finding #2 in the scratchpad.
 */
async function handleDeleteThread(
  _request: Request,
  params: Record<string, string>,
): Promise<Response> {
  const threadId = params.thread_id;
  if (!threadId) {
    return validationError("thread_id is required");
  }

  const storage = getStorage();
  const ownerId = getUserIdentity();
  const deleted = await storage.threads.delete(threadId, ownerId);

  if (!deleted) {
    return errorResponse(`Thread ${threadId} not found`, 404);
  }

  // Empty object on success (matches LangGraph API / Python behaviour)
  return jsonResponse({});
}

// ---------------------------------------------------------------------------
// GET /threads/:thread_id/state — Get State
// ---------------------------------------------------------------------------

/**
 * Get the current state of a thread.
 *
 * Response: ThreadState (200) or error (404)
 *
 * Returns a state snapshot with values, next nodes, tasks, checkpoint info,
 * metadata, and interrupts.
 */
async function handleGetThreadState(
  _request: Request,
  params: Record<string, string>,
): Promise<Response> {
  const threadId = params.thread_id;
  if (!threadId) {
    return validationError("thread_id is required");
  }

  const storage = getStorage();
  const ownerId = getUserIdentity();
  const state = await storage.threads.getState(threadId, ownerId);

  if (state === null) {
    return errorResponse(`Thread ${threadId} not found`, 404);
  }

  return jsonResponse(state);
}

// ---------------------------------------------------------------------------
// GET /threads/:thread_id/history — Get History
// ---------------------------------------------------------------------------

/**
 * Get state history for a thread.
 *
 * Query params (matching Python):
 *   - limit: Maximum number of states to return (default 10, clamped to 1–1000)
 *   - before: Return states before this checkpoint ID (optional)
 *
 * Response: ThreadState[] (200) or error (404)
 *
 * Returns snapshots in reverse chronological order (most recent first).
 */
async function handleGetThreadHistory(
  _request: Request,
  params: Record<string, string>,
  query: URLSearchParams,
): Promise<Response> {
  const threadId = params.thread_id;
  if (!threadId) {
    return validationError("thread_id is required");
  }

  // Parse query params (matching Python's clamping logic)
  let limit = 10;
  const limitParam = query.get("limit");
  if (limitParam) {
    const parsed = parseInt(limitParam, 10);
    if (!isNaN(parsed)) {
      limit = Math.max(1, Math.min(parsed, 1000));
    }
  }

  const before = query.get("before") ?? undefined;

  const storage = getStorage();
  const ownerId = getUserIdentity();
  const history = await storage.threads.getHistory(threadId, limit, before, ownerId);

  if (history === null) {
    return errorResponse(`Thread ${threadId} not found`, 404);
  }

  return jsonResponse(history);
}

// ---------------------------------------------------------------------------
// POST /threads/:thread_id/history — Get History (POST variant)
// ---------------------------------------------------------------------------

/**
 * Get state history for a thread (POST variant).
 *
 * The `@langchain/langgraph-sdk` client (and the `useStream` hook with
 * `fetchStateHistory: true`) sends POST requests to this endpoint with
 * an optional JSON body for filtering. The official LangGraph Server API
 * supports POST here — our GET-only registration caused 404s for the SDK.
 *
 * Request body (all fields optional):
 *   - limit (number): Maximum number of states to return (default 10, clamped 1–1000)
 *   - before (string): Return states before this checkpoint ID
 *   - metadata (object): Filter by metadata (reserved for future use)
 *   - checkpoint (object): Filter by specific checkpoint (reserved)
 *
 * Response: ThreadState[] (200) or error (404)
 */
async function handlePostThreadHistory(
  request: Request,
  params: Record<string, string>,
): Promise<Response> {
  const threadId = params.thread_id;
  if (!threadId) {
    return validationError("thread_id is required");
  }

  // Parse filter parameters from JSON body
  let limit = 10;
  let before: string | undefined;

  const body = await parseBody<Record<string, unknown>>(request);
  if (body) {
    const limitParam = body.limit;
    if (limitParam !== undefined && limitParam !== null) {
      const parsed = typeof limitParam === "number" ? limitParam : parseInt(String(limitParam), 10);
      if (!isNaN(parsed)) {
        limit = Math.max(1, Math.min(parsed, 1000));
      }
    }
    if (typeof body.before === "string") {
      before = body.before;
    }
  }

  const storage = getStorage();
  const ownerId = getUserIdentity();
  const history = await storage.threads.getHistory(threadId, limit, before, ownerId);

  if (history === null) {
    return errorResponse(`Thread ${threadId} not found`, 404);
  }

  return jsonResponse(history);
}

// ---------------------------------------------------------------------------
// POST /threads/search — Search
// ---------------------------------------------------------------------------

/**
 * Search for threads with filtering, sorting, and pagination.
 *
 * Request body: ThreadSearchRequest (all fields optional, empty body = all)
 * Response: Thread[] (200)
 *
 * Python allows empty body (returns all threads with default pagination).
 * We match that by treating a missing/empty body as `{}`.
 */
async function handleSearchThreads(request: Request): Promise<Response> {
  // Lenient body parsing: accept empty body (treat as {})
  const body = await parseBody<ThreadSearchRequest>(request);
  const searchRequest: ThreadSearchRequest = body ?? {};

  const storage = getStorage();
  const ownerId = getUserIdentity();
  const threads = await storage.threads.search(searchRequest, ownerId);

  return jsonResponse(threads);
}

// ---------------------------------------------------------------------------
// POST /threads/count — Count
// ---------------------------------------------------------------------------

/**
 * Count threads matching the given filters.
 *
 * Request body: ThreadCountRequest (all fields optional, empty body = total)
 * Response: bare integer (200), e.g., `3`
 *
 * Python returns a bare integer, not `{"count": 3}`.
 */
async function handleCountThreads(request: Request): Promise<Response> {
  // Lenient body parsing: accept empty body (treat as {})
  const body = await parseBody<ThreadCountRequest>(request);
  const countRequest: ThreadCountRequest = body ?? {};

  const storage = getStorage();
  const ownerId = getUserIdentity();
  const count = await storage.threads.count(countRequest, ownerId);

  // Bare integer response (matches Python / LangGraph API)
  return jsonResponse(count);
}
