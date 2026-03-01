/**
 * Storage interface types for the Fractal Agents Runtime — TypeScript/Bun.
 *
 * These interfaces define the contract for all storage operations. The
 * in-memory implementation lives in `./memory.ts`. The Postgres
 * implementation lives in `./postgres.ts`.
 *
 * Design decisions:
 *   - v0.0.2: All CRUD operations accept optional `ownerId` for per-user
 *     isolation. When `ownerId` is `undefined` (auth disabled), no owner
 *     filtering is applied — matching v0.0.1 behavior. When provided,
 *     owner is injected into `metadata.owner` on create and used as a
 *     WHERE filter on read/update/delete.
 *   - v0.0.2: `StoreStorage` added for cross-thread key-value memory.
 *   - `SYSTEM_OWNER_ID` ("system") marks resources visible to all
 *     authenticated users but only mutable by the system itself.
 *   - Delete returns `boolean` at the storage level; the HTTP route
 *     translates `true` → 200 `{}`, `false` → 404.
 *   - Search/count accept the request body types from `../models/`.
 *   - All async to allow drop-in replacement with Postgres later.
 *
 * Reference: apps/python/src/server/storage.py
 */

import type {
  Assistant,
  AssistantCreate,
  AssistantPatch,
  AssistantSearchRequest,
  AssistantCountRequest,
} from "../models/assistant";
import type {
  Thread,
  ThreadCreate,
  ThreadPatch,
  ThreadSearchRequest,
  ThreadCountRequest,
  ThreadState,
} from "../models/thread";
import type { Run, RunStatus } from "../models/run";
import type { StoreItem } from "../models/store";
import type { Cron } from "../models/cron";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * System owner ID for resources visible to all authenticated users.
 *
 * Assistants created with this owner (e.g., synced from Supabase agent
 * registry) are visible to all users but can only be mutated by the
 * system itself. Matches Python's `SYSTEM_OWNER_ID`.
 */
export const SYSTEM_OWNER_ID = "system";

// ---------------------------------------------------------------------------
// Assistant Store
// ---------------------------------------------------------------------------

/**
 * Storage interface for Assistant resources.
 *
 * All operations accept an optional `ownerId` for per-user isolation:
 *   - `undefined` → no owner filtering (auth disabled, v0.0.1 compat)
 *   - `string` → scoped to that owner (auth enabled)
 *
 * On `create()`, if `ownerId` is provided, it is injected into
 * `metadata.owner`. On `get()`/`search()`, resources with
 * `metadata.owner === SYSTEM_OWNER_ID` are also visible.
 *
 * Mirrors Python's `AssistantStore`.
 */
export interface AssistantStore {
  /**
   * Create a new assistant.
   *
   * When `ownerId` is provided, injects `metadata.owner = ownerId`.
   *
   * @param data - Creation payload (graph_id required, assistant_id optional).
   * @param ownerId - Owner ID for per-user isolation (optional).
   * @returns The created Assistant.
   * @throws Error if `graph_id` is missing.
   */
  create(data: AssistantCreate, ownerId?: string): Promise<Assistant>;

  /**
   * Get an assistant by ID.
   *
   * When `ownerId` is provided, only returns the assistant if owned by
   * that user or by `SYSTEM_OWNER_ID`.
   *
   * @param assistantId - UUID of the assistant.
   * @param ownerId - Owner ID for per-user isolation (optional).
   * @returns The Assistant if found (and accessible), `null` otherwise.
   */
  get(assistantId: string, ownerId?: string): Promise<Assistant | null>;

  /**
   * Search assistants with filtering, sorting, and pagination.
   *
   * When `ownerId` is provided, only returns assistants owned by that
   * user or by `SYSTEM_OWNER_ID`.
   *
   * @param request - Search parameters (metadata, graph_id, name, limit, offset, sort).
   * @param ownerId - Owner ID for per-user isolation (optional).
   * @returns Array of matching assistants.
   */
  search(request: AssistantSearchRequest, ownerId?: string): Promise<Assistant[]>;

  /**
   * Update an assistant (partial update).
   *
   * Increments `version` on every successful update.
   * When `ownerId` is provided, only updates if owned by that user
   * (system-owned resources cannot be mutated by users).
   *
   * @param assistantId - UUID of the assistant to update.
   * @param data - Fields to update.
   * @param ownerId - Owner ID for per-user isolation (optional).
   * @returns The updated Assistant if found (and accessible), `null` otherwise.
   */
  update(assistantId: string, data: AssistantPatch, ownerId?: string): Promise<Assistant | null>;

  /**
   * Delete an assistant by ID.
   *
   * When `ownerId` is provided, only deletes if owned by that user
   * (system-owned resources cannot be deleted by users).
   *
   * @param assistantId - UUID of the assistant to delete.
   * @param ownerId - Owner ID for per-user isolation (optional).
   * @returns `true` if deleted, `false` if not found (or not accessible).
   */
  delete(assistantId: string, ownerId?: string): Promise<boolean>;

  /**
   * Count assistants matching the given filters.
   *
   * When `ownerId` is provided, only counts assistants owned by that
   * user or by `SYSTEM_OWNER_ID`.
   *
   * @param request - Optional filter parameters (metadata, graph_id, name).
   * @param ownerId - Owner ID for per-user isolation (optional).
   * @returns The count of matching assistants.
   */
  count(request?: AssistantCountRequest, ownerId?: string): Promise<number>;

  /**
   * Clear all assistant data (for testing only).
   */
  clear(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Thread Store
// ---------------------------------------------------------------------------

/**
 * Storage interface for Thread resources with state history tracking.
 *
 * All operations accept an optional `ownerId` for per-user isolation.
 * Mirrors Python's `ThreadStore`.
 */
export interface ThreadStore {
  /**
   * Create a new thread.
   *
   * Initialises the thread with status "idle" and an empty state history.
   * When `ownerId` is provided, injects `metadata.owner = ownerId`.
   *
   * @param data - Creation payload (thread_id optional).
   * @param ownerId - Owner ID for per-user isolation (optional).
   * @returns The created Thread.
   */
  create(data: ThreadCreate, ownerId?: string): Promise<Thread>;

  /**
   * Get a thread by ID.
   *
   * When `ownerId` is provided, only returns the thread if owned by
   * that user.
   *
   * @param threadId - UUID of the thread.
   * @param ownerId - Owner ID for per-user isolation (optional).
   * @returns The Thread if found (and accessible), `null` otherwise.
   */
  get(threadId: string, ownerId?: string): Promise<Thread | null>;

  /**
   * Search threads with filtering, sorting, and pagination.
   *
   * When `ownerId` is provided, only returns threads owned by that user.
   *
   * @param request - Search parameters (ids, metadata, values, status, limit, offset, sort).
   * @param ownerId - Owner ID for per-user isolation (optional).
   * @returns Array of matching threads.
   */
  search(request: ThreadSearchRequest, ownerId?: string): Promise<Thread[]>;

  /**
   * Update a thread (partial update — currently only metadata).
   *
   * When `ownerId` is provided, only updates if owned by that user.
   *
   * @param threadId - UUID of the thread to update.
   * @param data - Fields to update.
   * @param ownerId - Owner ID for per-user isolation (optional).
   * @returns The updated Thread if found (and accessible), `null` otherwise.
   */
  update(threadId: string, data: ThreadPatch, ownerId?: string): Promise<Thread | null>;

  /**
   * Delete a thread and its state history.
   *
   * When `ownerId` is provided, only deletes if owned by that user.
   *
   * @param threadId - UUID of the thread to delete.
   * @param ownerId - Owner ID for per-user isolation (optional).
   * @returns `true` if deleted, `false` if not found (or not accessible).
   */
  delete(threadId: string, ownerId?: string): Promise<boolean>;

  /**
   * Count threads matching the given filters.
   *
   * When `ownerId` is provided, only counts threads owned by that user.
   *
   * @param request - Optional filter parameters (metadata, values, status).
   * @param ownerId - Owner ID for per-user isolation (optional).
   * @returns The count of matching threads.
   */
  count(request?: ThreadCountRequest, ownerId?: string): Promise<number>;

  /**
   * Get the current state of a thread.
   *
   * Builds a `ThreadState` snapshot from the thread's current values,
   * metadata, and checkpoint information.
   *
   * @param threadId - UUID of the thread.
   * @param ownerId - Owner ID for per-user isolation (optional).
   * @returns ThreadState if the thread exists (and accessible), `null` otherwise.
   */
  getState(threadId: string, ownerId?: string): Promise<ThreadState | null>;

  /**
   * Add a state snapshot to the thread's history.
   *
   * Also updates the thread's current `values` and `updated_at`.
   *
   * @param threadId - UUID of the thread.
   * @param state - State snapshot to record.
   * @param ownerId - Owner ID for per-user isolation (optional).
   * @returns `true` if added, `false` if thread not found (or not accessible).
   */
  addStateSnapshot(threadId: string, state: Record<string, unknown>, ownerId?: string): Promise<boolean>;

  /**
   * Get state history for a thread.
   *
   * Returns snapshots in reverse chronological order (most recent first).
   *
   * @param threadId - UUID of the thread.
   * @param limit - Maximum number of states to return (default 10).
   * @param before - Return states before this checkpoint ID (optional).
   * @param ownerId - Owner ID for per-user isolation (optional).
   * @returns Array of ThreadState if thread exists (and accessible), `null` otherwise.
   */
  getHistory(
    threadId: string,
    limit?: number,
    before?: string,
    ownerId?: string,
  ): Promise<ThreadState[] | null>;

  /**
   * Clear all thread data including history (for testing only).
   */
  clear(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Run Store
// ---------------------------------------------------------------------------

/**
 * Storage interface for Run resources with thread-scoped operations.
 *
 * Runs are always scoped to a thread. Owner isolation is enforced at
 * the thread level — if a user doesn't own a thread, they can't access
 * its runs. The route handlers verify thread ownership before calling
 * run storage methods, so `RunStore` itself doesn't take `ownerId`
 * on most operations (runs inherit ownership from their thread).
 *
 * Mirrors Python's `RunStore`.
 */
export interface RunStore {
  /**
   * Create a new run.
   *
   * @param data - Run data with required `thread_id` and `assistant_id`.
   * @returns The created Run.
   * @throws Error if `thread_id` or `assistant_id` is missing.
   */
  create(data: {
    thread_id: string;
    assistant_id: string;
    status?: RunStatus;
    metadata?: Record<string, unknown>;
    kwargs?: Record<string, unknown>;
    multitask_strategy?: string;
  }): Promise<Run>;

  /**
   * Get a run by its ID (not thread-scoped).
   *
   * @param runId - UUID of the run.
   * @returns The Run if found, `null` otherwise.
   */
  get(runId: string): Promise<Run | null>;

  /**
   * List runs for a specific thread with pagination and optional status filter.
   *
   * Returns runs sorted by `created_at` descending (most recent first).
   *
   * @param threadId - Thread ID to filter by.
   * @param limit - Maximum number of runs to return (default 10).
   * @param offset - Number of runs to skip (default 0).
   * @param status - Optional status filter.
   * @returns Array of matching runs.
   */
  listByThread(
    threadId: string,
    limit?: number,
    offset?: number,
    status?: RunStatus,
  ): Promise<Run[]>;

  /**
   * Get a specific run by thread ID and run ID.
   *
   * Returns `null` if the run doesn't exist or doesn't belong to the thread.
   *
   * @param threadId - Thread ID the run should belong to.
   * @param runId - Run ID to fetch.
   * @returns The Run if found and belongs to the thread, `null` otherwise.
   */
  getByThread(threadId: string, runId: string): Promise<Run | null>;

  /**
   * Delete a run by thread ID and run ID.
   *
   * @param threadId - Thread ID the run belongs to.
   * @param runId - Run ID to delete.
   * @returns `true` if deleted, `false` if not found or wrong thread.
   */
  deleteByThread(threadId: string, runId: string): Promise<boolean>;

  /**
   * Get the currently active (pending or running) run for a thread.
   *
   * @param threadId - Thread ID to check.
   * @returns The active Run if one exists, `null` otherwise.
   */
  getActiveRun(threadId: string): Promise<Run | null>;

  /**
   * Update a run's status.
   *
   * @param runId - Run ID to update.
   * @param status - New status value.
   * @returns The updated Run if found, `null` otherwise.
   */
  updateStatus(runId: string, status: RunStatus): Promise<Run | null>;

  /**
   * Count runs for a specific thread.
   *
   * @param threadId - Thread ID to count runs for.
   * @returns Number of runs for the thread.
   */
  countByThread(threadId: string): Promise<number>;

  /**
   * Clear all run data (for testing only).
   */
  clear(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Store Storage (cross-thread key-value memory)
// ---------------------------------------------------------------------------

/**
 * Storage interface for the cross-thread key-value Store API.
 *
 * Items are organized by `(namespace, key)` and scoped per-user via
 * `ownerId`. This provides long-term memory that persists across
 * threads and conversations.
 *
 * Mirrors Python's `StoreStorage` class.
 *
 * Reference: apps/python/src/server/storage.py → StoreStorage
 */
export interface StoreStorage {
  /**
   * Store or update an item (upsert).
   *
   * If an item with the same `(namespace, key, ownerId)` exists, its
   * `value` and `updated_at` are overwritten. If `metadata` is provided,
   * it replaces the existing metadata.
   *
   * @param namespace - Namespace for logical grouping.
   * @param key - Unique key within the namespace.
   * @param value - JSON-serializable value to store.
   * @param ownerId - Owner ID for per-user isolation.
   * @param metadata - Optional metadata to associate with the item.
   * @returns The stored item.
   */
  put(
    namespace: string,
    key: string,
    value: Record<string, unknown>,
    ownerId: string,
    metadata?: Record<string, unknown>,
  ): Promise<StoreItem>;

  /**
   * Get an item by namespace and key.
   *
   * @param namespace - Namespace for the item.
   * @param key - Key within the namespace.
   * @param ownerId - Owner ID for per-user isolation.
   * @returns The StoreItem if found, `null` otherwise.
   */
  get(
    namespace: string,
    key: string,
    ownerId: string,
  ): Promise<StoreItem | null>;

  /**
   * Delete an item by namespace and key.
   *
   * @param namespace - Namespace for the item.
   * @param key - Key within the namespace.
   * @param ownerId - Owner ID for per-user isolation.
   * @returns `true` if deleted, `false` if not found.
   */
  delete(
    namespace: string,
    key: string,
    ownerId: string,
  ): Promise<boolean>;

  /**
   * Search items within a namespace.
   *
   * Results are sorted by key for consistent ordering and paginated
   * via `limit` and `offset`.
   *
   * @param namespace - Namespace to search within.
   * @param ownerId - Owner ID for per-user isolation.
   * @param prefix - Optional key prefix filter.
   * @param limit - Maximum number of results (default 10).
   * @param offset - Number of results to skip (default 0).
   * @returns Array of matching StoreItem records.
   */
  search(
    namespace: string,
    ownerId: string,
    prefix?: string,
    limit?: number,
    offset?: number,
  ): Promise<StoreItem[]>;

  /**
   * List all namespaces for an owner.
   *
   * @param ownerId - Owner ID for per-user isolation.
   * @returns Array of namespace strings.
   */
  listNamespaces(ownerId: string): Promise<string[]>;

  /**
   * Clear all store items (for testing only).
   */
  clear(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Cron Store
// ---------------------------------------------------------------------------

/**
 * Storage interface for Cron resources.
 *
 * All operations require `ownerId` for per-user isolation — crons are
 * always owned by the user who created them.
 *
 * Mirrors Python's `CronStore` from `server/storage.py`.
 */
export interface CronStore {
  /**
   * Create a new cron job.
   *
   * Injects `metadata.owner = ownerId` and generates a UUID for `cron_id`.
   *
   * @param data - Cron data (schedule, assistant_id, thread_id, payload, etc.).
   * @param ownerId - Owner ID for per-user isolation.
   * @returns The created Cron.
   */
  create(data: Record<string, unknown>, ownerId: string): Promise<Cron>;

  /**
   * Get a cron job by ID.
   *
   * Only returns the cron if owned by the specified user.
   *
   * @param cronId - UUID of the cron.
   * @param ownerId - Owner ID for per-user isolation.
   * @returns The Cron if found and accessible, `null` otherwise.
   */
  get(cronId: string, ownerId: string): Promise<Cron | null>;

  /**
   * List cron jobs for a user with optional filters.
   *
   * Returns all crons owned by the user, optionally filtered by
   * `assistant_id` and/or `thread_id`.
   *
   * @param ownerId - Owner ID for per-user isolation.
   * @param filters - Optional equality filters (assistant_id, thread_id).
   * @returns Array of matching Cron records.
   */
  list(ownerId: string, filters?: Record<string, string>): Promise<Cron[]>;

  /**
   * Update a cron job.
   *
   * Only updates if owned by the specified user.
   *
   * @param cronId - UUID of the cron to update.
   * @param ownerId - Owner ID for per-user isolation.
   * @param updates - Fields to update.
   * @returns The updated Cron if found and accessible, `null` otherwise.
   */
  update(
    cronId: string,
    ownerId: string,
    updates: Record<string, unknown>,
  ): Promise<Cron | null>;

  /**
   * Delete a cron job.
   *
   * Only deletes if owned by the specified user.
   *
   * @param cronId - UUID of the cron to delete.
   * @param ownerId - Owner ID for per-user isolation.
   * @returns `true` if deleted, `false` if not found or not accessible.
   */
  delete(cronId: string, ownerId: string): Promise<boolean>;

  /**
   * Count cron jobs matching filters.
   *
   * Only counts crons owned by the specified user.
   *
   * @param ownerId - Owner ID for per-user isolation.
   * @param filters - Optional equality filters (assistant_id, thread_id).
   * @returns Count of matching crons.
   */
  count(ownerId: string, filters?: Record<string, string>): Promise<number>;

  /**
   * Clear all cron data (for testing only).
   */
  clear(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Storage Container
// ---------------------------------------------------------------------------

/**
 * Container for all resource stores.
 *
 * Provides a single access point for all storage operations.
 * Mirrors Python's `Storage` class.
 */
export interface Storage {
  /** Assistant resource store. */
  readonly assistants: AssistantStore;

  /** Thread resource store (with state history). */
  readonly threads: ThreadStore;

  /** Run resource store (thread-scoped). */
  readonly runs: RunStore;

  /** Cross-thread key-value store (long-term memory). */
  readonly store: StoreStorage;

  /** Cron job store (scheduled recurring runs). */
  readonly crons: CronStore;

  /**
   * Clear all stores (for testing only).
   */
  clearAll(): Promise<void>;
}
