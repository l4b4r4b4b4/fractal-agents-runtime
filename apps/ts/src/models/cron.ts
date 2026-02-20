/**
 * Cron model types for the Fractal Agents Runtime — TypeScript/Bun.
 *
 * Every type here matches the Python runtime's cron schemas field-for-field:
 *   apps/python/src/server/crons/schemas.py
 *
 * Type naming convention: PascalCase matching the schema title exactly.
 * Field naming convention: snake_case matching the JSON property names exactly.
 *
 * Crons enable recurring scheduled runs on threads. A cron job fires at
 * intervals defined by a cron expression, creating runs on a designated
 * (or ephemeral) thread.
 */

import { CronExpressionParser } from "cron-parser";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/**
 * Action to take when a cron run completes.
 *
 * Matches: Python `OnRunCompleted` StrEnum
 *
 * - "delete": Delete the thread after execution (stateless).
 * - "keep": Keep the thread (creates a new thread each time).
 */
export type OnRunCompleted = "delete" | "keep";

/** All valid on_run_completed values as a readonly array. */
export const ON_RUN_COMPLETED_VALUES: readonly OnRunCompleted[] = [
  "delete",
  "keep",
] as const;

/**
 * Fields available for sorting crons.
 *
 * Matches: Python `CronSortBy` StrEnum
 */
export type CronSortBy =
  | "cron_id"
  | "assistant_id"
  | "thread_id"
  | "next_run_date"
  | "end_time"
  | "created_at"
  | "updated_at";

/** All valid sort-by fields as a readonly array. */
export const CRON_SORT_BY_VALUES: readonly CronSortBy[] = [
  "cron_id",
  "assistant_id",
  "thread_id",
  "next_run_date",
  "end_time",
  "created_at",
  "updated_at",
] as const;

/**
 * Sort direction.
 *
 * Matches: Python `SortOrder` StrEnum
 */
export type SortOrder = "asc" | "desc";

/** All valid sort orders as a readonly array. */
export const SORT_ORDER_VALUES: readonly SortOrder[] = [
  "asc",
  "desc",
] as const;

// ---------------------------------------------------------------------------
// Cron Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for cron job runs.
 *
 * Matches: Python `CronConfig` BaseModel
 */
export interface CronConfig {
  /** Tags for categorizing the run. */
  tags?: string[];

  /** Maximum recursion depth for the graph. */
  recursion_limit?: number;

  /** Configurable parameters for the graph. */
  configurable?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Cron Create Request
// ---------------------------------------------------------------------------

/**
 * Request model for creating a cron job.
 *
 * Creates a stateless cron that schedules runs on new threads.
 *
 * Matches: Python `CronCreate` BaseModel
 * Required fields: schedule, assistant_id
 */
export interface CronCreate {
  /**
   * Cron schedule expression (e.g., "0 12 * * *" for daily at noon,
   * or every N minutes using step syntax). Supports standard 5-field
   * and extended 6-field (with seconds) expressions. Required.
   */
  schedule: string;

  /**
   * Assistant ID (UUID) or graph name to run.
   * Required.
   */
  assistant_id: string;

  /**
   * End date to stop running the cron (optional).
   * Runs indefinitely if not set. ISO 8601 date-time string.
   */
  end_time?: string | null;

  /**
   * Input to pass to the graph.
   * Can be a list of message dicts or a single dict.
   */
  input?: Record<string, unknown>[] | Record<string, unknown> | null;

  /** Metadata to assign to cron job runs. */
  metadata?: Record<string, unknown> | null;

  /** Configuration for the assistant. */
  config?: CronConfig | null;

  /** Static context added to the assistant. */
  context?: Record<string, unknown> | null;

  /** Webhook URL to call after each run completes. */
  webhook?: string | null;

  /**
   * Nodes to interrupt before execution.
   * Can be "*" (all nodes) or an array of node names.
   */
  interrupt_before?: "*" | string[] | null;

  /**
   * Nodes to interrupt after execution.
   * Can be "*" (all nodes) or an array of node names.
   */
  interrupt_after?: "*" | string[] | null;

  /**
   * Action after run completes.
   * - "delete": removes thread after execution.
   * - "keep": preserves the thread.
   * Default: "delete"
   */
  on_run_completed?: OnRunCompleted;
}

// ---------------------------------------------------------------------------
// Cron Response Model
// ---------------------------------------------------------------------------

/**
 * Response model for a cron job.
 *
 * Matches: Python `Cron` BaseModel
 * Required fields: cron_id, thread_id, schedule, created_at, updated_at, payload
 */
export interface Cron {
  /** Unique identifier for the cron job (UUID). */
  cron_id: string;

  /** Assistant ID associated with this cron. */
  assistant_id: string | null;

  /** Thread ID for the cron (used for stateful crons). */
  thread_id: string;

  /** End date when the cron stops running (ISO 8601 date-time or null). */
  end_time: string | null;

  /** Cron schedule expression. */
  schedule: string;

  /** When the cron was created (ISO 8601 date-time). */
  created_at: string;

  /** When the cron was last updated (ISO 8601 date-time). */
  updated_at: string;

  /** User ID who owns this cron. */
  user_id: string | null;

  /** Run payload configuration. */
  payload: Record<string, unknown>;

  /** Next scheduled run time (ISO 8601 date-time or null). */
  next_run_date: string | null;

  /** Cron metadata. */
  metadata: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Cron Search Request
// ---------------------------------------------------------------------------

/**
 * Valid fields for the `select` parameter in cron search.
 */
export const VALID_CRON_SELECT_FIELDS: ReadonlySet<string> = new Set([
  "cron_id",
  "assistant_id",
  "thread_id",
  "on_run_completed",
  "end_time",
  "schedule",
  "created_at",
  "updated_at",
  "user_id",
  "payload",
  "next_run_date",
  "metadata",
]);

/**
 * Request model for searching crons.
 *
 * Matches: Python `CronSearch` BaseModel
 * All fields are optional.
 */
export interface CronSearch {
  /** Filter by assistant ID (exact match). */
  assistant_id?: string | null;

  /** Filter by thread ID. */
  thread_id?: string | null;

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

  /** Field to sort by. Default: "created_at". */
  sort_by?: CronSortBy;

  /** Sort direction. Default: "desc". */
  sort_order?: SortOrder;

  /**
   * Fields to include in response (null = all fields).
   * Must be valid Cron field names.
   */
  select?: string[] | null;
}

// ---------------------------------------------------------------------------
// Cron Count Request
// ---------------------------------------------------------------------------

/**
 * Request model for counting crons.
 *
 * Matches: Python `CronCountRequest` BaseModel
 * All fields are optional.
 */
export interface CronCountRequest {
  /** Filter by assistant ID. */
  assistant_id?: string | null;

  /** Filter by thread ID. */
  thread_id?: string | null;
}

// ---------------------------------------------------------------------------
// Cron Payload (internal)
// ---------------------------------------------------------------------------

/**
 * Internal model for storing cron run configuration.
 *
 * Captures all settings needed to create a run when the cron fires.
 *
 * Matches: Python `CronPayload` BaseModel
 */
export interface CronPayload {
  /** Assistant ID to run. */
  assistant_id: string;

  /** Input to pass to the graph. */
  input?: Record<string, unknown>[] | Record<string, unknown> | null;

  /** Metadata to attach to the run. */
  metadata?: Record<string, unknown> | null;

  /** Configuration for the assistant. */
  config?: CronConfig | null;

  /** Static context added to the assistant. */
  context?: Record<string, unknown> | null;

  /** Webhook URL. */
  webhook?: string | null;

  /** Nodes to interrupt before execution. */
  interrupt_before?: "*" | string[] | null;

  /** Nodes to interrupt after execution. */
  interrupt_after?: "*" | string[] | null;

  /** Action after run completes. */
  on_run_completed: OnRunCompleted;
}

/**
 * Convert a CronPayload to a plain dict for storage.
 *
 * @param payload - The cron payload to serialize.
 * @returns Plain object suitable for JSON storage.
 */
export function cronPayloadToDict(payload: CronPayload): Record<string, unknown> {
  return {
    assistant_id: payload.assistant_id,
    input: payload.input ?? null,
    metadata: payload.metadata ?? null,
    config: payload.config ?? null,
    context: payload.context ?? null,
    webhook: payload.webhook ?? null,
    interrupt_before: payload.interrupt_before ?? null,
    interrupt_after: payload.interrupt_after ?? null,
    on_run_completed: payload.on_run_completed,
  };
}

// ---------------------------------------------------------------------------
// Helper Functions
// ---------------------------------------------------------------------------

/**
 * Validate a cron schedule expression.
 *
 * Accepts standard 5-field (minute hour day month day-of-week) and
 * extended 6-field (second minute hour day month day-of-week) expressions.
 *
 * @param schedule - Cron expression string.
 * @returns `true` if valid.
 * @throws Error with descriptive message if invalid.
 */
export function validateCronSchedule(schedule: string): true {
  const trimmed = schedule.trim();
  if (trimmed.length === 0) {
    throw new Error("Cron schedule expression cannot be empty");
  }

  try {
    CronExpressionParser.parse(trimmed, { tz: "UTC" });
    return true;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid cron schedule expression: ${message}`);
  }
}

/**
 * Calculate the next run date for a cron schedule.
 *
 * Matches: Python `calculate_next_run_date()` in schemas.py
 *
 * @param schedule - Cron expression string.
 * @param baseTime - Base time to calculate from (defaults to now UTC).
 * @returns Next scheduled run time as an ISO 8601 string.
 */
export function calculateNextRunDate(
  schedule: string,
  baseTime?: Date,
): string {
  const currentDate = baseTime ?? new Date();
  const expression = CronExpressionParser.parse(schedule, {
    currentDate,
    tz: "UTC",
  });
  const nextRun = expression.next();
  const isoString = nextRun.toISOString();
  if (isoString === null) {
    throw new Error(`No next run date could be calculated for schedule: ${schedule}`);
  }
  return isoString;
}

/**
 * Check if a cron job has expired.
 *
 * Matches: Python `is_cron_expired()` in schemas.py
 *
 * @param cronEndTime - The cron's end time as ISO 8601 string (null = never expires).
 * @returns `true` if the cron has expired, `false` otherwise.
 */
export function isCronExpired(cronEndTime: string | null | undefined): boolean {
  if (cronEndTime === null || cronEndTime === undefined) {
    return false;
  }

  const endTime = new Date(cronEndTime);
  const now = new Date();
  return now >= endTime;
}

/**
 * Validate the `select` fields in a CronSearch request.
 *
 * @param select - Array of field names to validate.
 * @returns `true` if all fields are valid.
 * @throws Error listing invalid field names.
 */
export function validateCronSelectFields(select: string[]): true {
  const invalidFields = select.filter(
    (field) => !VALID_CRON_SELECT_FIELDS.has(field),
  );
  if (invalidFields.length > 0) {
    const validList = [...VALID_CRON_SELECT_FIELDS].sort().join(", ");
    throw new Error(
      `Invalid select field(s): '${invalidFields.join("', '")}'. ` +
      `Valid fields: ${validList}`,
    );
  }
  return true;
}
