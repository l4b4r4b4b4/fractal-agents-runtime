/**
 * Run model types for the Fractal Agents Runtime — TypeScript/Bun.
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
 * The current status of a run.
 *
 * Matches: components.schemas.Run.properties.status.enum
 *
 * - "pending": Run is queued but not yet started.
 * - "running": Run is actively executing.
 * - "success": Run completed successfully.
 * - "error": Run encountered an error.
 * - "timeout": Run exceeded its time limit.
 * - "interrupted": Run was interrupted (by user or interrupt_before/after).
 */
export type RunStatus =
  | "pending"
  | "running"
  | "success"
  | "error"
  | "timeout"
  | "interrupted";

/** All valid run statuses as a readonly array (useful for runtime validation). */
export const RUN_STATUSES: readonly RunStatus[] = [
  "pending",
  "running",
  "success",
  "error",
  "timeout",
  "interrupted",
] as const;

/**
 * Strategy for handling concurrent runs on the same thread.
 *
 * Matches: components.schemas.Run.properties.multitask_strategy.enum
 *
 * - "reject": Reject the new run if a run is already active on the thread.
 * - "enqueue": Queue the new run to execute after the current run finishes.
 * - "rollback": Cancel the current run and start the new one.
 * - "interrupt": Interrupt the current run and start the new one.
 */
export type MultitaskStrategy = "reject" | "enqueue" | "rollback" | "interrupt";

/** All valid multitask strategies as a readonly array. */
export const MULTITASK_STRATEGIES: readonly MultitaskStrategy[] = [
  "reject",
  "enqueue",
  "rollback",
  "interrupt",
] as const;

/**
 * Stream mode options for stateful runs.
 *
 * Matches: components.schemas.RunCreateStateful.properties.stream_mode enum values.
 *
 * - "values": Stream full state values after each step.
 * - "updates": Stream only the updates (deltas) after each step.
 * - "messages": Stream LLM messages as they are generated.
 * - "messages-tuple": Stream messages as [role, content] tuples.
 * - "debug": Stream detailed debug information.
 * - "events": Stream LangChain callback events.
 * - "custom": Stream custom events emitted by the graph.
 */
export type StreamMode =
  | "values"
  | "updates"
  | "messages"
  | "messages-tuple"
  | "debug"
  | "events"
  | "custom";

/** All valid stream modes for stateful runs as a readonly array. */
export const STREAM_MODES: readonly StreamMode[] = [
  "values",
  "updates",
  "messages",
  "messages-tuple",
  "debug",
  "events",
  "custom",
] as const;

/**
 * Stream mode options for stateless runs (subset of stateful stream modes).
 *
 * Matches: components.schemas.RunCreateStateless.properties.stream_mode enum values.
 */
export type StatelessStreamMode =
  | "values"
  | "updates"
  | "messages"
  | "debug"
  | "events";

/** All valid stream modes for stateless runs as a readonly array. */
export const STATELESS_STREAM_MODES: readonly StatelessStreamMode[] = [
  "values",
  "updates",
  "messages",
  "debug",
  "events",
] as const;

/**
 * What to do when the client disconnects during a run.
 *
 * Matches: components.schemas.RunCreateStateful.properties.on_disconnect.enum
 *
 * - "cancel": Cancel the run when the client disconnects.
 * - "continue": Let the run continue even if the client disconnects.
 */
export type OnDisconnect = "cancel" | "continue";

/**
 * Durability mode for a run.
 *
 * Matches: components.schemas.RunCreateStateful.properties.durability.enum
 *
 * - "sync": Synchronous execution with checkpointing.
 * - "async": Asynchronous execution with checkpointing.
 * - "exit": Execute without checkpointing.
 */
export type Durability = "sync" | "async" | "exit";

/**
 * What to do if the thread doesn't exist when creating a stateful run.
 *
 * Matches: components.schemas.RunCreateStateful.properties.if_not_exists.enum
 *
 * - "create": Create the thread automatically.
 * - "reject": Reject the run with a 404 error.
 */
export type IfNotExistsStrategy = "create" | "reject";

/**
 * What to do with the ephemeral thread when a stateless run completes.
 *
 * Matches: components.schemas.RunCreateStateless.properties.on_completion.enum
 *
 * - "delete": Delete the ephemeral thread after the run completes.
 * - "keep": Keep the ephemeral thread after the run completes.
 */
export type OnCompletion = "delete" | "keep";

// ---------------------------------------------------------------------------
// Run (response model)
// ---------------------------------------------------------------------------

/**
 * A run resource as returned by the API.
 *
 * Matches: components.schemas.Run
 * Required fields: run_id, thread_id, assistant_id, created_at, updated_at, status, metadata
 */
export interface Run {
  /** The unique identifier of the run (UUID). */
  run_id: string;

  /** The ID of the thread this run belongs to (UUID). */
  thread_id: string;

  /** The ID of the assistant used for this run (UUID). */
  assistant_id: string;

  /** The time the run was created (ISO 8601 date-time). */
  created_at: string;

  /** The last time the run was updated (ISO 8601 date-time). */
  updated_at: string;

  /** The current status of the run. */
  status: RunStatus;

  /** Custom metadata for the run. */
  metadata: Record<string, unknown>;

  /** Additional keyword arguments passed to the run. */
  kwargs?: Record<string, unknown>;

  /** Strategy for handling concurrent runs on the same thread. */
  multitask_strategy?: MultitaskStrategy;
}

// ---------------------------------------------------------------------------
// RunCreateStateful (request model)
// ---------------------------------------------------------------------------

/**
 * Payload for creating a stateful run on a thread.
 *
 * Matches: components.schemas.RunCreateStateful
 * Required fields: assistant_id
 *
 * Used by:
 *   POST /threads/{thread_id}/runs
 *   POST /threads/{thread_id}/runs/stream
 *   POST /threads/{thread_id}/runs/wait
 */
export interface RunCreateStateful {
  /**
   * The assistant to use. Can be a UUID or graph name.
   * Required.
   */
  assistant_id: string;

  /**
   * The input to the graph.
   * Can be any JSON value: object, array, string, number, boolean, or null.
   */
  input?: Record<string, unknown> | unknown[] | string | number | boolean | null;

  /** Command to control graph execution (update, resume, goto). */
  command?: Record<string, unknown>;

  /** Checkpoint to resume from. */
  checkpoint?: Record<string, unknown>;

  /** Metadata to attach to the run. */
  metadata?: Record<string, unknown>;

  /** Configuration for the graph. */
  config?: Record<string, unknown>;

  /** Context to pass to the graph. */
  context?: Record<string, unknown>;

  /** Webhook URL to call on run completion (format: URI). */
  webhook?: string;

  /**
   * Nodes to interrupt before execution.
   * Can be "*" (all nodes) or an array of node names.
   */
  interrupt_before?: "*" | string[];

  /**
   * Nodes to interrupt after execution.
   * Can be "*" (all nodes) or an array of node names.
   */
  interrupt_after?: "*" | string[];

  /**
   * What to stream back.
   * Can be a single stream mode string or an array of modes.
   * Default: ["values"]
   */
  stream_mode?: StreamMode | StreamMode[];

  /**
   * Whether to stream subgraph events.
   * Default: false
   */
  stream_subgraphs?: boolean;

  /**
   * Whether to stream resumable checkpoints.
   * Default: false
   */
  stream_resumable?: boolean;

  /**
   * What to do when client disconnects.
   * Default: "continue"
   */
  on_disconnect?: OnDisconnect;

  /** Keys to collect feedback on. */
  feedback_keys?: string[];

  /**
   * How to handle concurrent runs on the same thread.
   * Default: "enqueue"
   */
  multitask_strategy?: MultitaskStrategy;

  /**
   * What to do if the thread doesn't exist.
   * Default: "reject"
   */
  if_not_exists?: IfNotExistsStrategy;

  /** Delay before starting the run (in seconds). */
  after_seconds?: number;

  /**
   * Whether to create checkpoints during execution.
   * Default: false
   */
  checkpoint_during?: boolean;

  /**
   * Durability mode for the run.
   * Default: "async"
   */
  durability?: Durability;
}

// ---------------------------------------------------------------------------
// RunCreateStateless (request model)
// ---------------------------------------------------------------------------

/**
 * Payload for creating a stateless run.
 *
 * Matches: components.schemas.RunCreateStateless
 * Required fields: assistant_id
 *
 * Used by:
 *   POST /runs
 *   POST /runs/stream
 *   POST /runs/wait
 *
 * Stateless runs create an ephemeral thread, execute the agent, and return
 * the result. The ephemeral thread is deleted by default (on_completion="delete").
 */
export interface RunCreateStateless {
  /**
   * The assistant to use. Can be a UUID or graph name.
   * Required.
   */
  assistant_id: string;

  /**
   * The input to the graph.
   * Can be any JSON value: object, array, string, number, boolean, or null.
   */
  input?: Record<string, unknown> | unknown[] | string | number | boolean | null;

  /** Command to control graph execution. */
  command?: Record<string, unknown>;

  /** Metadata to attach to the run. */
  metadata?: Record<string, unknown>;

  /** Configuration for the graph. */
  config?: Record<string, unknown>;

  /** Context to pass to the graph. */
  context?: Record<string, unknown>;

  /** Webhook URL to call on run completion (format: URI). */
  webhook?: string;

  /**
   * What to stream back.
   * Can be a single stream mode string or an array of modes.
   * Default: ["values"]
   */
  stream_mode?: StatelessStreamMode | StatelessStreamMode[];

  /** Keys to collect feedback on. */
  feedback_keys?: string[];

  /**
   * Whether to stream subgraph events.
   * Default: false
   */
  stream_subgraphs?: boolean;

  /**
   * Whether to delete the ephemeral thread on completion.
   * Default: "delete"
   */
  on_completion?: OnCompletion;

  /**
   * What to do when client disconnects.
   * Default: "continue"
   */
  on_disconnect?: OnDisconnect;

  /** Delay before starting the run (in seconds). */
  after_seconds?: number;
}
