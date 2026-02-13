/**
 * Thread model types for the Fractal Agents Runtime — TypeScript/Bun.
 *
 * Every type here matches the Python runtime's OpenAPI spec field-for-field:
 *   apps/python/openapi-spec.json → components.schemas
 *
 * Type naming convention: PascalCase matching the schema title exactly.
 * Field naming convention: snake_case matching the JSON property names exactly.
 */

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/**
 * The current status of a thread.
 *
 * Matches: components.schemas.Thread.properties.status.enum
 *
 * - "idle": Thread is not currently executing any runs.
 * - "busy": Thread has an active run in progress.
 * - "interrupted": Thread execution was interrupted (awaiting human input or resume).
 * - "error": Thread encountered an error during execution.
 */
export type ThreadStatus = "idle" | "busy" | "interrupted" | "error";

/** All valid thread statuses as a readonly array (useful for runtime validation). */
export const THREAD_STATUSES: readonly ThreadStatus[] = [
  "idle",
  "busy",
  "interrupted",
  "error",
] as const;

/**
 * Strategy for handling duplicate thread creation.
 *
 * - "raise": Return 409 Conflict if the thread already exists.
 * - "do_nothing": Return the existing thread without modification.
 *
 * Matches: components.schemas.ThreadCreate.properties.if_exists.enum
 */
export type ThreadIfExistsStrategy = "raise" | "do_nothing";

// ---------------------------------------------------------------------------
// Thread (response model)
// ---------------------------------------------------------------------------

/**
 * A thread resource as returned by the API.
 *
 * Matches: components.schemas.Thread
 * Required fields: thread_id, created_at, updated_at, metadata, status
 */
export interface Thread {
  /** The unique identifier of the thread (UUID). */
  thread_id: string;

  /** The time the thread was created (ISO 8601 date-time). */
  created_at: string;

  /** The last time the thread was updated (ISO 8601 date-time). */
  updated_at: string;

  /** Custom metadata for the thread. */
  metadata: Record<string, unknown>;

  /** Thread configuration. */
  config?: Record<string, unknown>;

  /** The current status of the thread. */
  status: ThreadStatus;

  /** The current state values of the thread. */
  values?: Record<string, unknown>;

  /** Active interrupts on the thread. */
  interrupts?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// ThreadCreate (request model)
// ---------------------------------------------------------------------------

/**
 * Payload for creating a thread.
 *
 * Matches: components.schemas.ThreadCreate
 * All fields are optional.
 */
export interface ThreadCreate {
  /**
   * The ID of the thread. If not provided, a random UUID will be generated.
   * Format: UUID.
   */
  thread_id?: string;

  /** Metadata to add to thread. */
  metadata?: Record<string, unknown>;

  /**
   * How to handle duplicate creation.
   * - "raise": raises error (409 Conflict)
   * - "do_nothing": returns existing thread
   *
   * Default: "raise"
   */
  if_exists?: ThreadIfExistsStrategy;
}

// ---------------------------------------------------------------------------
// ThreadPatch (request model)
// ---------------------------------------------------------------------------

/**
 * Payload for updating a thread (partial update).
 *
 * Matches: components.schemas.ThreadPatch
 * All fields are optional.
 */
export interface ThreadPatch {
  /** Metadata to merge with existing thread metadata. */
  metadata?: Record<string, unknown>;

  /**
   * Update the thread's status.
   *
   * Not part of the public API (ThreadPatch in the OpenAPI spec only has
   * `metadata`), but used internally by the runs system to transition
   * threads between "idle" and "busy".
   */
  status?: "idle" | "busy" | "error" | "interrupted";

  /**
   * Replace the thread's current values.
   *
   * Not part of the public API — used internally by the runs system to
   * persist the final agent output into the thread after a run completes.
   */
  values?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// ThreadSearchRequest (request model)
// ---------------------------------------------------------------------------

/**
 * Request body for searching threads.
 *
 * Matches: components.schemas.ThreadSearchRequest
 * All fields are optional.
 */
export interface ThreadSearchRequest {
  /** Filter by specific thread IDs (array of UUIDs). */
  ids?: string[];

  /** Filter by metadata key-value pairs. */
  metadata?: Record<string, unknown>;

  /** Filter by state values. */
  values?: Record<string, unknown>;

  /** Filter by thread status. */
  status?: ThreadStatus;

  /**
   * Maximum number of results to return.
   * Default: 10. Minimum: 1. Maximum: 1000.
   */
  limit?: number;

  /**
   * Number of results to skip.
   * Default: 0. Minimum: 0.
   */
  offset?: number;

  /** Field to sort by (e.g., "created_at", "updated_at"). */
  sort_by?: string;

  /** Sort order: "asc" or "desc". */
  sort_order?: "asc" | "desc";
}

// ---------------------------------------------------------------------------
// ThreadCountRequest (request model)
// ---------------------------------------------------------------------------

/**
 * Request body for counting threads.
 *
 * Matches: components.schemas.ThreadCountRequest
 * All fields are optional.
 */
export interface ThreadCountRequest {
  /** Filter by metadata key-value pairs. */
  metadata?: Record<string, unknown>;

  /** Filter by state values. */
  values?: Record<string, unknown>;

  /** Filter by thread status. */
  status?: ThreadStatus;
}

// ---------------------------------------------------------------------------
// ThreadState (response model)
// ---------------------------------------------------------------------------

/**
 * The state of a thread at a point in time.
 *
 * Matches: components.schemas.ThreadState
 * Required fields: values, next, tasks
 *
 * Thread state represents a snapshot of the graph execution. It includes
 * the current values, pending next nodes, active tasks, and checkpoint
 * information for resumability.
 */
export interface ThreadState {
  /**
   * The current state values.
   * Can be an object (single state) or an array of objects (multiple channels).
   */
  values: Record<string, unknown> | Array<Record<string, unknown>>;

  /** The next nodes to execute. */
  next: string[];

  /** Pending tasks (array of task objects). */
  tasks: Array<Record<string, unknown>>;

  /** The current checkpoint. */
  checkpoint?: Record<string, unknown>;

  /** State metadata. */
  metadata?: Record<string, unknown>;

  /** When this state was created (ISO 8601 date-time). */
  created_at?: string;

  /** The parent checkpoint (for state history traversal). */
  parent_checkpoint?: Record<string, unknown>;

  /** Active interrupts (array of interrupt objects). */
  interrupts?: Array<Record<string, unknown>>;
}
