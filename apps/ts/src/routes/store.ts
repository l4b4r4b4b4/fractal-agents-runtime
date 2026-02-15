/**
 * Store API routes for the Fractal Agents Runtime — TypeScript/Bun.
 *
 * Implements LangGraph-compatible cross-thread key-value storage endpoints
 * matching the Python runtime:
 *
 *   PUT    /store/items         — Store/update (upsert) an item
 *   GET    /store/items         — Retrieve an item by namespace + key
 *   DELETE /store/items         — Delete an item by namespace + key
 *   POST   /store/items/search  — Search items in a namespace
 *   GET    /store/namespaces    — List namespaces for the authenticated user
 *
 * Response conventions (matching Python exactly):
 *   - PUT returns 200 with the StoreItem object.
 *   - GET returns 200 with the StoreItem, or 404 if not found.
 *   - DELETE returns 200 with `{}`, or 404 if not found.
 *   - Search returns 200 with a JSON array of StoreItem objects.
 *   - Namespaces returns 200 with a JSON array of namespace strings.
 *   - Errors use `{"detail": "..."}` shape (ErrorResponse).
 *
 * All operations are scoped by the authenticated user's identity. When
 * auth is disabled (Supabase not configured), `ownerId` defaults to
 * `"anonymous"` so the store still works in development.
 *
 * Reference: apps/python/src/server/routes/store.py
 */

import type { Router } from "../router";
import type { StorePutRequest, StoreSearchRequest } from "../models/store";
import {
  jsonResponse,
  validationError,
  requireBody,
  notFound,
} from "./helpers";
import { getStorage } from "../storage/index";
import { getUserIdentity } from "../middleware/context";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default owner ID when authentication is disabled.
 *
 * Ensures the store is usable in development without Supabase. All
 * unauthenticated requests share the same "anonymous" namespace.
 */
const ANONYMOUS_OWNER_ID = "anonymous";

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Register all store routes on the given router.
 *
 * @param router - The application Router instance.
 */
export function registerStoreRoutes(router: Router): void {
  // IMPORTANT: Register /store/items/search BEFORE /store/items so that
  // "search" is matched as a literal path segment, not treated as part
  // of the /store/items pattern.
  router.post("/store/items/search", handleSearchStoreItems);

  router.put("/store/items", handlePutStoreItem);
  router.get("/store/items", handleGetStoreItem);
  router.delete("/store/items", handleDeleteStoreItem);

  router.get("/store/namespaces", handleListNamespaces);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Get the effective owner ID for the current request.
 *
 * Returns the authenticated user's identity, or "anonymous" when auth
 * is disabled.
 */
function getEffectiveOwnerId(): string {
  return getUserIdentity() ?? ANONYMOUS_OWNER_ID;
}

// ---------------------------------------------------------------------------
// PUT /store/items — Store or update an item
// ---------------------------------------------------------------------------

/**
 * Handle `PUT /store/items`.
 *
 * Upserts a store item by `(namespace, key)`. If the item already exists
 * for the authenticated user, its value and updated_at are overwritten.
 *
 * Request body: `{ namespace: string, key: string, value: object, metadata?: object }`
 * Response: StoreItem (200) or validation error (422)
 */
async function handlePutStoreItem(
  request: Request,
  _params: Record<string, string>,
  _query: URLSearchParams,
): Promise<Response> {
  const [body, bodyError] = await requireBody<StorePutRequest>(request);
  if (bodyError) return bodyError;

  // Validate required fields
  const { namespace, key, value, metadata } = body;

  if (!namespace || typeof namespace !== "string") {
    return validationError("namespace is required");
  }
  if (!key || typeof key !== "string") {
    return validationError("key is required");
  }
  if (value === undefined || value === null) {
    return validationError("value is required");
  }

  const ownerId = getEffectiveOwnerId();
  const storage = getStorage();

  const item = await storage.store.put(
    namespace,
    key,
    typeof value === "object" ? (value as Record<string, unknown>) : { _value: value },
    ownerId,
    metadata,
  );

  return jsonResponse(item);
}

// ---------------------------------------------------------------------------
// GET /store/items — Get an item by namespace + key
// ---------------------------------------------------------------------------

/**
 * Handle `GET /store/items`.
 *
 * Retrieves a store item by namespace and key, provided as query parameters.
 *
 * Query params: `?namespace=<string>&key=<string>`
 * Response: StoreItem (200) or 404
 */
async function handleGetStoreItem(
  _request: Request,
  _params: Record<string, string>,
  query: URLSearchParams,
): Promise<Response> {
  const namespace = query.get("namespace");
  const key = query.get("key");

  if (!namespace) {
    return validationError("namespace query parameter is required");
  }
  if (!key) {
    return validationError("key query parameter is required");
  }

  const ownerId = getEffectiveOwnerId();
  const storage = getStorage();

  const item = await storage.store.get(namespace, key, ownerId);

  if (item === null) {
    return notFound(`Item not found: ${namespace}/${key}`);
  }

  return jsonResponse(item);
}

// ---------------------------------------------------------------------------
// DELETE /store/items — Delete an item by namespace + key
// ---------------------------------------------------------------------------

/**
 * Handle `DELETE /store/items`.
 *
 * Deletes a store item by namespace and key, provided as query parameters.
 *
 * Query params: `?namespace=<string>&key=<string>`
 * Response: `{}` (200) or 404
 */
async function handleDeleteStoreItem(
  _request: Request,
  _params: Record<string, string>,
  query: URLSearchParams,
): Promise<Response> {
  const namespace = query.get("namespace");
  const key = query.get("key");

  if (!namespace) {
    return validationError("namespace query parameter is required");
  }
  if (!key) {
    return validationError("key query parameter is required");
  }

  const ownerId = getEffectiveOwnerId();
  const storage = getStorage();

  const deleted = await storage.store.delete(namespace, key, ownerId);

  if (!deleted) {
    return notFound(`Item not found: ${namespace}/${key}`);
  }

  return jsonResponse({});
}

// ---------------------------------------------------------------------------
// POST /store/items/search — Search items in a namespace
// ---------------------------------------------------------------------------

/**
 * Handle `POST /store/items/search`.
 *
 * Searches items within a namespace, optionally filtering by key prefix.
 * Results are sorted by key and paginated.
 *
 * Request body: `{ namespace: string, prefix?: string, limit?: number, offset?: number }`
 * Response: StoreItem[] (200)
 */
async function handleSearchStoreItems(
  request: Request,
  _params: Record<string, string>,
  _query: URLSearchParams,
): Promise<Response> {
  const [body, bodyError] = await requireBody<StoreSearchRequest>(request);
  if (bodyError) return bodyError;

  const { namespace, prefix } = body;

  if (!namespace || typeof namespace !== "string") {
    return validationError("namespace is required");
  }

  // Validate and clamp pagination params
  let limit = 10;
  let offset = 0;

  if (body.limit !== undefined) {
    const parsedLimit = Number(body.limit);
    if (Number.isNaN(parsedLimit)) {
      return validationError("limit must be a number");
    }
    limit = Math.max(1, Math.min(parsedLimit, 100));
  }

  if (body.offset !== undefined) {
    const parsedOffset = Number(body.offset);
    if (Number.isNaN(parsedOffset)) {
      return validationError("offset must be a number");
    }
    offset = Math.max(0, parsedOffset);
  }

  const ownerId = getEffectiveOwnerId();
  const storage = getStorage();

  const items = await storage.store.search(
    namespace,
    ownerId,
    prefix,
    limit,
    offset,
  );

  return jsonResponse(items);
}

// ---------------------------------------------------------------------------
// GET /store/namespaces — List namespaces for the authenticated user
// ---------------------------------------------------------------------------

/**
 * Handle `GET /store/namespaces`.
 *
 * Returns all namespace strings that contain at least one item for the
 * authenticated user.
 *
 * Response: string[] (200)
 */
async function handleListNamespaces(
  _request: Request,
  _params: Record<string, string>,
  _query: URLSearchParams,
): Promise<Response> {
  const ownerId = getEffectiveOwnerId();
  const storage = getStorage();

  const namespaces = await storage.store.listNamespaces(ownerId);

  return jsonResponse(namespaces);
}
