/**
 * Cron job handler — business logic for the Fractal Agents Runtime — TypeScript/Bun.
 *
 * Manages CRUD operations for cron jobs and coordinates with the scheduler
 * for timed execution. This is the TypeScript port of Python's
 * `apps/python/src/server/crons/handlers.py`.
 *
 * Design decisions:
 *   - Singleton pattern via `getCronHandler()` / `resetCronHandler()`.
 *   - Lazy scheduler initialization (avoids import-time side effects).
 *   - Owner isolation on all operations (crons are user-scoped).
 *   - Sorting and pagination in handler (not storage) — mirrors Python.
 *   - `executeCronRun()` is called by the scheduler when a job fires.
 *
 * Reference: apps/python/src/server/crons/handlers.py
 */

import type {
  Cron,
  CronCreate,
  CronSearch,
  CronCountRequest,
  CronPayload,
  CronSortBy,
  SortOrder,
} from "../models/cron";
import {
  calculateNextRunDate,
  isCronExpired,
  cronPayloadToDict,
} from "../models/cron";
import { getStorage } from "../storage";
import { getScheduler } from "./scheduler";

// ---------------------------------------------------------------------------
// CronHandler
// ---------------------------------------------------------------------------

/**
 * Handler for cron job operations.
 *
 * Manages CRUD operations for cron jobs and coordinates with the
 * scheduler for execution.
 */
export class CronHandler {
  // -------------------------------------------------------------------------
  // Create
  // -------------------------------------------------------------------------

  /**
   * Create a new cron job.
   *
   * Validates the assistant exists, creates a placeholder thread,
   * builds the payload, calculates the next run date, persists to
   * storage, and schedules the job.
   *
   * @param createData - Cron creation parameters.
   * @param ownerId - ID of the user creating the cron.
   * @returns The created Cron instance.
   * @throws Error if assistant not found or end_time is in the past.
   */
  async createCron(createData: CronCreate, ownerId: string): Promise<Cron> {
    const storage = getStorage();

    // Verify assistant exists
    let assistant = await storage.assistants.get(
      createData.assistant_id,
      ownerId,
    );

    if (assistant === null) {
      // Try to find by graph_id
      const assistants = await storage.assistants.search(
        {},
        ownerId,
      );
      assistant =
        assistants.find(
          (a) => a.graph_id === createData.assistant_id,
        ) ?? null;

      if (assistant === null) {
        throw new Error(`Assistant not found: ${createData.assistant_id}`);
      }
    }

    // Create a placeholder thread for the cron
    // (actual runs may use new threads based on on_run_completed setting)
    const thread = await storage.threads.create({}, ownerId);
    const threadId = thread.thread_id;

    // Build the payload
    const onRunCompleted = createData.on_run_completed ?? "delete";
    const payload: CronPayload = {
      assistant_id: assistant.assistant_id,
      input: createData.input ?? null,
      metadata: createData.metadata ?? null,
      config: createData.config ?? null,
      context: createData.context ?? null,
      webhook: createData.webhook ?? null,
      interrupt_before: createData.interrupt_before ?? null,
      interrupt_after: createData.interrupt_after ?? null,
      on_run_completed: onRunCompleted,
    };

    // Calculate next run date
    const nextRunDate = calculateNextRunDate(createData.schedule);

    // Check if already expired
    if (createData.end_time && isCronExpired(createData.end_time)) {
      throw new Error(
        `Cron end_time ${createData.end_time} is in the past`,
      );
    }

    // Create cron in storage
    const cronData: Record<string, unknown> = {
      assistant_id: assistant.assistant_id,
      thread_id: threadId,
      schedule: createData.schedule,
      end_time: createData.end_time ?? null,
      user_id: ownerId,
      payload: cronPayloadToDict(payload),
      next_run_date: nextRunDate,
      on_run_completed: onRunCompleted,
      metadata: createData.metadata ?? {},
    };

    const cron = await storage.crons.create(cronData, ownerId);

    // Schedule the cron job
    const scheduler = getScheduler();
    scheduler.addCronJob(cron, ownerId);

    console.log(`[cron-handler] Created cron ${cron.cron_id} for user ${ownerId}`);
    return cron;
  }

  // -------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------

  /**
   * Search for cron jobs.
   *
   * Retrieves crons from storage, applies sorting and pagination,
   * and optionally selects specific fields.
   *
   * @param searchParams - Search and filter parameters.
   * @param ownerId - ID of the requesting user.
   * @returns Array of matching Cron instances.
   */
  async searchCrons(
    searchParams: CronSearch,
    ownerId: string,
  ): Promise<Cron[]> {
    const storage = getStorage();

    // Build filters
    const filters: Record<string, string> = {};
    if (searchParams.assistant_id) {
      filters.assistant_id = searchParams.assistant_id;
    }
    if (searchParams.thread_id) {
      filters.thread_id = searchParams.thread_id;
    }

    // Get all crons for user with filters
    let crons = await storage.crons.list(ownerId, filters);

    // Sort
    const sortBy: CronSortBy = searchParams.sort_by ?? "created_at";
    const sortOrder: SortOrder = searchParams.sort_order ?? "desc";
    const reverse = sortOrder === "desc";

    crons.sort((cronA, cronB) => {
      const valueA = getSortValue(cronA, sortBy);
      const valueB = getSortValue(cronB, sortBy);

      let comparison: number;
      if (valueA < valueB) {
        comparison = -1;
      } else if (valueA > valueB) {
        comparison = 1;
      } else {
        comparison = 0;
      }

      return reverse ? -comparison : comparison;
    });

    // Apply pagination
    const limit = searchParams.limit ?? 10;
    const offset = searchParams.offset ?? 0;
    crons = crons.slice(offset, offset + limit);

    // Field selection is a hint only — we return full Cron objects
    // (matching Python behavior where required fields prevent partial models)

    return crons;
  }

  // -------------------------------------------------------------------------
  // Count
  // -------------------------------------------------------------------------

  /**
   * Count cron jobs matching filters.
   *
   * @param countParams - Filter parameters.
   * @param ownerId - ID of the requesting user.
   * @returns Count of matching crons.
   */
  async countCrons(
    countParams: CronCountRequest,
    ownerId: string,
  ): Promise<number> {
    const storage = getStorage();

    // Build filters
    const filters: Record<string, string> = {};
    if (countParams.assistant_id) {
      filters.assistant_id = countParams.assistant_id;
    }
    if (countParams.thread_id) {
      filters.thread_id = countParams.thread_id;
    }

    return storage.crons.count(ownerId, filters);
  }

  // -------------------------------------------------------------------------
  // Delete
  // -------------------------------------------------------------------------

  /**
   * Delete a cron job.
   *
   * Removes from both the scheduler and storage.
   *
   * @param cronId - ID of the cron to delete.
   * @param ownerId - ID of the requesting user.
   * @returns Empty object on success.
   * @throws Error if cron not found.
   */
  async deleteCron(
    cronId: string,
    ownerId: string,
  ): Promise<Record<string, never>> {
    const storage = getStorage();

    // Verify cron exists and belongs to user
    const cron = await storage.crons.get(cronId, ownerId);
    if (cron === null) {
      throw new Error(`Cron not found: ${cronId}`);
    }

    // Remove from scheduler
    const scheduler = getScheduler();
    scheduler.removeCronJob(cronId);

    // Delete from storage
    const deleted = await storage.crons.delete(cronId, ownerId);
    if (!deleted) {
      throw new Error(`Failed to delete cron: ${cronId}`);
    }

    console.log(`[cron-handler] Deleted cron ${cronId} for user ${ownerId}`);
    return {};
  }

  // -------------------------------------------------------------------------
  // Get
  // -------------------------------------------------------------------------

  /**
   * Get a cron job by ID.
   *
   * @param cronId - ID of the cron to retrieve.
   * @param ownerId - ID of the requesting user.
   * @returns Cron instance if found, `null` otherwise.
   */
  async getCron(cronId: string, ownerId: string): Promise<Cron | null> {
    const storage = getStorage();
    return storage.crons.get(cronId, ownerId);
  }

  // -------------------------------------------------------------------------
  // Execution
  // -------------------------------------------------------------------------

  /**
   * Execute a scheduled cron run.
   *
   * Called by the scheduler when a cron job fires. Retrieves the cron
   * from storage, checks expiry, determines the thread to use, creates
   * the run, and updates the next_run_date.
   *
   * @param cronId - ID of the cron to execute.
   * @param ownerId - ID of the cron owner.
   */
  async executeCronRun(cronId: string, ownerId: string): Promise<void> {
    const storage = getStorage();

    // Get the cron
    const cron = await storage.crons.get(cronId, ownerId);
    if (cron === null) {
      console.warn(
        `[cron-handler] Cron ${cronId} not found during execution`,
      );
      return;
    }

    // Check if expired
    if (isCronExpired(cron.end_time)) {
      console.log(
        `[cron-handler] Cron ${cronId} has expired, removing from scheduler`,
      );
      const scheduler = getScheduler();
      scheduler.removeCronJob(cronId);
      return;
    }

    // Get payload
    const payload = cron.payload;
    const onRunCompleted = (payload.on_run_completed as string) ?? "delete";

    // Determine which thread to use
    let threadId: string;
    if (onRunCompleted === "keep") {
      // Create a new thread for this execution
      const newThread = await storage.threads.create({}, ownerId);
      threadId = newThread.thread_id;
    } else {
      // Use the cron's designated thread (will be cleaned up after)
      threadId = cron.thread_id;
    }

    // Create the run
    const runData = {
      thread_id: threadId,
      assistant_id: (payload.assistant_id as string) ?? cron.assistant_id ?? "",
      metadata: (payload.metadata as Record<string, unknown>) ?? {},
    };

    try {
      const run = await storage.runs.create(runData);

      console.log(
        `[cron-handler] Cron ${cronId} created run ${run.run_id} on thread ${threadId}`,
      );

      // Update next_run_date
      const nextRun = calculateNextRunDate(cron.schedule);
      await storage.crons.update(cronId, ownerId, {
        next_run_date: nextRun,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[cron-handler] Failed to execute cron ${cronId}: ${message}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Sorting helper
// ---------------------------------------------------------------------------

/**
 * Get a sortable value from a Cron, handling null values.
 *
 * @param cron - The cron to get the sort value from.
 * @param sortBy - The field to sort by.
 * @returns A comparable value.
 */
function getSortValue(cron: Cron, sortBy: CronSortBy): string {
  const value = cron[sortBy as keyof Cron];

  if (value === null || value === undefined) {
    // Use epoch for date fields, empty string for others
    const dateFields = new Set([
      "next_run_date",
      "end_time",
      "created_at",
      "updated_at",
    ]);
    if (dateFields.has(sortBy)) {
      return new Date(0).toISOString();
    }
    return "";
  }

  if (typeof value === "string") {
    return value;
  }

  return String(value);
}

// ---------------------------------------------------------------------------
// Global singleton
// ---------------------------------------------------------------------------

let _cronHandler: CronHandler | null = null;

/**
 * Get the global cron handler instance.
 *
 * On first call, also wires the execution callback into the scheduler
 * to break the circular dependency between handler and scheduler.
 *
 * @returns CronHandler singleton instance.
 */
export function getCronHandler(): CronHandler {
  if (_cronHandler === null) {
    _cronHandler = new CronHandler();

    // Wire execution callback into the scheduler
    const scheduler = getScheduler();
    scheduler.setExecutionCallback(
      (cronId: string, ownerId: string) =>
        _cronHandler!.executeCronRun(cronId, ownerId),
    );
  }
  return _cronHandler;
}

/**
 * Reset the global cron handler (for testing).
 */
export function resetCronHandler(): void {
  _cronHandler = null;
}
