/**
 * Assistant routes for the Fractal Agents Runtime — TypeScript/Bun.
 *
 * Implements LangGraph-compatible endpoints matching the Python runtime:
 *
 *   POST   /assistants                — Create a new assistant
 *   GET    /assistants/:assistant_id  — Get an assistant by ID
 *   PATCH  /assistants/:assistant_id  — Update an assistant (partial)
 *   DELETE /assistants/:assistant_id  — Delete an assistant
 *   POST   /assistants/search         — Search/list assistants
 *   POST   /assistants/count          — Count assistants
 *
 * Response conventions (matching Python exactly):
 *   - Create returns 200 (not 201) with the Assistant object.
 *   - Delete returns 200 with `{}` (empty object, NOT `{"ok": true}`).
 *   - Count returns 200 with a bare integer (e.g., `3`).
 *   - Search returns 200 with a JSON array of Assistant objects.
 *   - Errors use `{"detail": "..."}` shape (ErrorResponse).
 *
 * Owner isolation (v0.0.2):
 *   - All operations pass `ownerId` from the authenticated user context.
 *   - When auth is disabled, `ownerId` is `undefined` — no filtering.
 *   - On create, `metadata.owner` is set to the user's identity.
 *   - On read, system-owned assistants are also visible.
 *   - On update/delete, only the actual owner can mutate.
 *
 * Reference: apps/python/src/server/routes/assistants.py
 */

import type { Router } from "../router";
import type {
  AssistantCreate,
  AssistantPatch,
  AssistantSearchRequest,
  AssistantCountRequest,
} from "../models/assistant";
import {
  jsonResponse,
  errorResponse,
  validationError,
  parseBody,
  requireBody,
} from "./helpers";
import { getStorage } from "../storage/index";
import { getUserIdentity } from "../middleware/context";
import { isDatabaseEnabled, getConnection } from "../storage/database";
import { lazySyncAgent, isValidUuid } from "../agent-sync";
import { SYSTEM_OWNER_ID } from "../storage/types";

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Register all assistant routes on the given router.
 *
 * @param router - The application Router instance.
 */
export function registerAssistantRoutes(router: Router): void {
  // IMPORTANT: Register /assistants/search and /assistants/count BEFORE
  // /assistants/:assistant_id so that "search" and "count" are matched
  // as literal path segments, not captured as :assistant_id params.
  router.post("/assistants/search", handleSearchAssistants);
  router.post("/assistants/count", handleCountAssistants);

  router.post("/assistants", handleCreateAssistant);
  router.get("/assistants/:assistant_id", handleGetAssistant);
  router.patch("/assistants/:assistant_id", handlePatchAssistant);
  router.delete("/assistants/:assistant_id", handleDeleteAssistant);
}

// ---------------------------------------------------------------------------
// POST /assistants — Create
// ---------------------------------------------------------------------------

/**
 * Create a new assistant.
 *
 * Request body: AssistantCreate (graph_id required)
 * Response: Assistant (200) or error (409, 422)
 *
 * Handles `if_exists` strategy at the route level (matching Python):
 *   - "raise" (default): returns 409 if assistant_id already exists.
 *   - "do_nothing": returns the existing assistant unchanged (200).
 */
async function handleCreateAssistant(request: Request): Promise<Response> {
  const [body, errorResp] = await requireBody<AssistantCreate>(request);
  if (errorResp) return errorResp;

  // Validate required field: graph_id
  if (!body.graph_id) {
    return validationError("graph_id is required");
  }

  const storage = getStorage();
  const ownerId = getUserIdentity();

  // ---------------------------------------------------------------------------
  // Lazy sync from Supabase (matching Python's dev-gated lazy sync)
  //
  // If the client provides a `supabase_agent_id` in metadata, attempt to
  // sync that agent into assistant storage before the normal create flow.
  // This is best-effort: failures do not block the assistant create endpoint.
  // ---------------------------------------------------------------------------
  try {
    const metadata = body.metadata;
    const supabaseAgentIdValue =
      metadata && typeof metadata === "object"
        ? (metadata as Record<string, unknown>).supabase_agent_id
        : undefined;

    if (
      typeof supabaseAgentIdValue === "string" &&
      supabaseAgentIdValue.length > 0 &&
      isValidUuid(supabaseAgentIdValue) &&
      isDatabaseEnabled()
    ) {
      const sqlConnection = getConnection();
      if (sqlConnection) {
        await lazySyncAgent(
          sqlConnection as any,
          storage as any,
          supabaseAgentIdValue,
          ownerId ?? SYSTEM_OWNER_ID,
        );
      }
    }
  } catch (syncError: unknown) {
    const syncMessage =
      syncError instanceof Error ? syncError.message : String(syncError);
    console.warn(`[assistants] Lazy sync skipped due to error: ${syncMessage}`);
  }

  // Pre-check for duplicates if assistant_id is explicitly provided
  // (matching Python route-level logic)
  if (body.assistant_id) {
    const existing = await storage.assistants.get(body.assistant_id, ownerId);
    if (existing) {
      const strategy = body.if_exists ?? "raise";
      if (strategy === "do_nothing") {
        return jsonResponse(existing);
      }
      return errorResponse(
        `Assistant ${body.assistant_id} already exists`,
        409,
      );
    }
  }

  try {
    const assistant = await storage.assistants.create(body, ownerId);
    return jsonResponse(assistant);
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "Failed to create assistant";
    return validationError(message);
  }
}

// ---------------------------------------------------------------------------
// GET /assistants/:assistant_id — Get
// ---------------------------------------------------------------------------

/**
 * Get an assistant by ID.
 *
 * Response: Assistant (200) or error (404)
 */
async function handleGetAssistant(
  _request: Request,
  params: Record<string, string>,
): Promise<Response> {
  const assistantId = params.assistant_id;
  if (!assistantId) {
    return validationError("assistant_id is required");
  }

  const storage = getStorage();
  const ownerId = getUserIdentity();
  const assistant = await storage.assistants.get(assistantId, ownerId);

  if (assistant === null) {
    return errorResponse(`Assistant ${assistantId} not found`, 404);
  }

  return jsonResponse(assistant);
}

// ---------------------------------------------------------------------------
// PATCH /assistants/:assistant_id — Update
// ---------------------------------------------------------------------------

/**
 * Update an assistant (partial update).
 *
 * Request body: AssistantPatch (all fields optional)
 * Response: Assistant (200) or error (404, 422)
 *
 * Increments `version` on every successful update (handled by storage layer).
 */
async function handlePatchAssistant(
  request: Request,
  params: Record<string, string>,
): Promise<Response> {
  const assistantId = params.assistant_id;
  if (!assistantId) {
    return validationError("assistant_id is required");
  }

  const [body, errorResp] = await requireBody<AssistantPatch>(request);
  if (errorResp) return errorResp;

  const storage = getStorage();
  const ownerId = getUserIdentity();

  // Check existence first (matching Python which returns 404 before attempting update)
  const existing = await storage.assistants.get(assistantId, ownerId);
  if (existing === null) {
    return errorResponse(`Assistant ${assistantId} not found`, 404);
  }

  const updated = await storage.assistants.update(assistantId, body, ownerId);

  if (updated === null) {
    return errorResponse(`Assistant ${assistantId} not found`, 404);
  }

  return jsonResponse(updated);
}

// ---------------------------------------------------------------------------
// DELETE /assistants/:assistant_id — Delete
// ---------------------------------------------------------------------------

/**
 * Delete an assistant.
 *
 * Response: `{}` (200) or error (404)
 *
 * Returns empty object on success — NOT `{"ok": true}`.
 * See Critical Finding #2 in the scratchpad.
 */
async function handleDeleteAssistant(
  _request: Request,
  params: Record<string, string>,
): Promise<Response> {
  const assistantId = params.assistant_id;
  if (!assistantId) {
    return validationError("assistant_id is required");
  }

  const storage = getStorage();
  const ownerId = getUserIdentity();
  const deleted = await storage.assistants.delete(assistantId, ownerId);

  if (!deleted) {
    return errorResponse(`Assistant ${assistantId} not found`, 404);
  }

  // Empty object on success (matches LangGraph API / Python behaviour)
  return jsonResponse({});
}

// ---------------------------------------------------------------------------
// POST /assistants/search — Search
// ---------------------------------------------------------------------------

/**
 * Search for assistants with filtering, sorting, and pagination.
 *
 * Request body: AssistantSearchRequest (all fields optional, empty body = all)
 * Response: Assistant[] (200)
 *
 * Python allows empty body (returns all assistants with default pagination).
 * We match that by treating a missing/empty body as `{}`.
 */
async function handleSearchAssistants(request: Request): Promise<Response> {
  // Lenient body parsing: accept empty body (treat as {})
  const body = await parseBody<AssistantSearchRequest>(request);
  const searchRequest: AssistantSearchRequest = body ?? {};

  const storage = getStorage();
  const ownerId = getUserIdentity();
  const assistants = await storage.assistants.search(searchRequest, ownerId);

  return jsonResponse(assistants);
}

// ---------------------------------------------------------------------------
// POST /assistants/count — Count
// ---------------------------------------------------------------------------

/**
 * Count assistants matching the given filters.
 *
 * Request body: AssistantCountRequest (all fields optional, empty body = total)
 * Response: bare integer (200), e.g., `3`
 *
 * Python returns a bare integer, not `{"count": 3}`.
 */
async function handleCountAssistants(request: Request): Promise<Response> {
  // Lenient body parsing: accept empty body (treat as {})
  const body = await parseBody<AssistantCountRequest>(request);
  const countRequest: AssistantCountRequest = body ?? {};

  const storage = getStorage();
  const ownerId = getUserIdentity();
  const count = await storage.assistants.count(countRequest, ownerId);

  // Bare integer response (matches Python / LangGraph API)
  return jsonResponse(count);
}
