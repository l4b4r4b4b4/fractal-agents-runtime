/**
 * Store API models for the Fractal Agents Runtime — TypeScript/Bun.
 *
 * Defines the `StoreItem` type and request/response shapes for the
 * cross-thread key-value Store API. Items are organized by namespace
 * and key, with per-user isolation via `owner_id`.
 *
 * These types mirror the Python runtime's `StoreItem` class and the
 * request/response shapes used by the store route handlers.
 *
 * Reference: apps/python/src/server/storage.py → StoreItem
 * Reference: apps/python/src/server/routes/store.py
 */

// ---------------------------------------------------------------------------
// StoreItem — the core stored record
// ---------------------------------------------------------------------------

/**
 * A stored item in the Store API.
 *
 * Items are scoped by `(namespace, key, owner_id)` — the composite
 * primary key in Postgres. The `owner_id` is NOT included in API
 * responses (it's implicit from the authenticated user).
 *
 * Mirrors Python's `StoreItem.to_dict()` output.
 */
export interface StoreItem {
  /** Namespace string for logical grouping. */
  namespace: string;

  /** Unique key within the namespace. */
  key: string;

  /** Arbitrary JSON-serializable value. */
  value: Record<string, unknown>;

  /** Optional metadata associated with the item. */
  metadata: Record<string, unknown>;

  /** ISO 8601 creation timestamp. */
  created_at: string;

  /** ISO 8601 last-update timestamp. */
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Request types — used by route handlers to parse request bodies/params
// ---------------------------------------------------------------------------

/**
 * Request body for `PUT /store/items`.
 *
 * Creates or updates (upserts) a store item. If an item with the same
 * `(namespace, key)` already exists for the authenticated user, its
 * `value` and `updated_at` are overwritten.
 */
export interface StorePutRequest {
  /** Namespace for the item. */
  namespace: string;

  /** Key within the namespace. */
  key: string;

  /** Value to store (JSON-serializable object). */
  value: Record<string, unknown>;

  /** Optional metadata to associate with the item. */
  metadata?: Record<string, unknown>;
}

/**
 * Query parameters for `GET /store/items` and `DELETE /store/items`.
 *
 * Both operations identify an item by `(namespace, key)` via query params.
 */
export interface StoreGetDeleteParams {
  /** Namespace for the item. */
  namespace: string;

  /** Key within the namespace. */
  key: string;
}

/**
 * Request body for `POST /store/items/search`.
 *
 * Searches items within a namespace, optionally filtering by key prefix.
 * Results are sorted by key and paginated.
 */
export interface StoreSearchRequest {
  /** Namespace to search within (required). */
  namespace: string;

  /** Optional key prefix filter (e.g., `"user-"` matches `"user-123"`). */
  prefix?: string;

  /** Maximum number of results to return (default: 10, max: 100). */
  limit?: number;

  /** Number of results to skip for pagination (default: 0). */
  offset?: number;
}

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

/**
 * Response shape for `POST /store/items/search`.
 *
 * Returns an array of matching `StoreItem` objects.
 */
export type StoreSearchResponse = StoreItem[];

/**
 * Response shape for `GET /store/namespaces`.
 *
 * Returns an array of namespace strings belonging to the authenticated user.
 */
export type StoreNamespacesResponse = string[];
