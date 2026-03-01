/**
 * Timer-based cron scheduler for the Fractal Agents Runtime — TypeScript/Bun.
 *
 * Uses `setTimeout` to schedule cron jobs at their next run date. When a job
 * fires, it executes the cron run and reschedules for the next occurrence.
 * This is the Bun-native equivalent of Python's APScheduler wrapper in
 * `apps/python/src/server/crons/scheduler.py`.
 *
 * Design decisions:
 *   - `setTimeout` over `setInterval`: Each firing calculates the exact next
 *     run date, avoiding drift from fixed intervals.
 *   - Single-instance per cron: `_timers` map ensures at most one pending
 *     timer per cron_id. Calling `addCronJob` with an existing ID replaces it.
 *   - Graceful shutdown: `shutdown()` clears all timers without executing.
 *   - Owner tracking: Maps cron_id → owner_id for execution context.
 *   - Singleton pattern: `getScheduler()` / `resetScheduler()` mirrors Python.
 *   - Max timer delay: JavaScript's `setTimeout` uses a 32-bit signed int
 *     for the delay (max ~24.8 days). For longer intervals, we cap at 24 hours
 *     and re-check on wake-up.
 *
 * Reference: apps/python/src/server/crons/scheduler.py
 */

import { calculateNextRunDate, isCronExpired } from "../models/cron";
import type { Cron } from "../models/cron";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Maximum setTimeout delay in milliseconds.
 *
 * JavaScript uses a 32-bit signed integer for setTimeout delay, so the
 * maximum is 2^31 - 1 ≈ 24.8 days. We cap at 24 hours for safety and
 * to allow periodic re-evaluation of cron state.
 */
const MAX_TIMER_DELAY_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Minimum timer delay in milliseconds.
 *
 * Prevents tight loops if a cron's next_run_date is in the past.
 */
const MIN_TIMER_DELAY_MS = 1000; // 1 second

// ---------------------------------------------------------------------------
// CronScheduler
// ---------------------------------------------------------------------------

/**
 * Manages timer-based scheduling for cron job execution.
 *
 * Wraps `setTimeout` to provide:
 * - Background cron job execution at scheduled times
 * - Job management (add, remove)
 * - Graceful shutdown (clear all timers)
 * - Owner tracking for execution context
 */
export class CronScheduler {
  /** Active timers keyed by cron_id. */
  private readonly _timers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  /** Maps cron_id → owner_id for execution context. */
  private readonly _jobOwnerMap: Map<string, string> = new Map();

  /** Whether the scheduler has been started. */
  private _started = false;

  /** Callback for executing a cron run. Set via `setExecutionCallback()`. */
  private _executeCallback:
    | ((cronId: string, ownerId: string) => Promise<void>)
    | null = null;

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Start the scheduler.
   *
   * Safe to call multiple times — only starts once.
   */
  start(): void {
    if (!this._started) {
      this._started = true;
      console.log("[cron-scheduler] Cron scheduler started");
    }
  }

  /**
   * Shutdown the scheduler.
   *
   * Clears all pending timers and resets state. Safe to call even if
   * not started.
   *
   * @param wait - Ignored (kept for API compatibility with Python).
   *   Timers are always cancelled immediately.
   */
  shutdown(_wait = true): void {
    if (this._started) {
      // Clear all timers
      for (const [cronId, timer] of this._timers.entries()) {
        clearTimeout(timer);
        this._timers.delete(cronId);
      }
      this._jobOwnerMap.clear();
      this._started = false;
      console.log("[cron-scheduler] Cron scheduler stopped");
    }
  }

  /**
   * Check whether the scheduler is currently running.
   */
  get isStarted(): boolean {
    return this._started;
  }

  /**
   * Get the number of active (scheduled) cron jobs.
   */
  get activeJobCount(): number {
    return this._timers.size;
  }

  // -------------------------------------------------------------------------
  // Execution callback
  // -------------------------------------------------------------------------

  /**
   * Set the callback that executes a cron run.
   *
   * This decouples the scheduler from the handler to avoid circular
   * imports. The handler sets this callback at initialization time.
   *
   * @param callback - Async function that executes a cron run.
   */
  setExecutionCallback(
    callback: (cronId: string, ownerId: string) => Promise<void>,
  ): void {
    this._executeCallback = callback;
  }

  // -------------------------------------------------------------------------
  // Job management
  // -------------------------------------------------------------------------

  /**
   * Add a cron job to the scheduler.
   *
   * Calculates the next run date from the cron's schedule expression and
   * sets a timer to fire at that time. If a timer already exists for this
   * cron_id, it is replaced.
   *
   * @param cron - Cron instance with schedule and configuration.
   * @param ownerId - ID of the cron owner.
   * @returns `true` if scheduled successfully, `false` if failed.
   */
  addCronJob(cron: Cron, ownerId: string): boolean {
    try {
      // Remove any existing timer for this cron
      this.removeCronJob(cron.cron_id);

      // Ensure scheduler is running
      this.start();

      // Track owner
      this._jobOwnerMap.set(cron.cron_id, ownerId);

      // Schedule the timer
      this._scheduleTimer(cron.cron_id, cron.schedule, cron.end_time);

      console.log(
        `[cron-scheduler] Scheduled cron ${cron.cron_id} with schedule '${cron.schedule}'`,
      );
      return true;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[cron-scheduler] Failed to schedule cron ${cron.cron_id}: ${message}`,
      );
      return false;
    }
  }

  /**
   * Remove a cron job from the scheduler.
   *
   * Cancels the pending timer and removes owner tracking.
   *
   * @param cronId - ID of the cron job to remove.
   * @returns `true` if removed, `false` if not found.
   */
  removeCronJob(cronId: string): boolean {
    const timer = this._timers.get(cronId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this._timers.delete(cronId);
      this._jobOwnerMap.delete(cronId);
      console.log(`[cron-scheduler] Removed cron job ${cronId}`);
      return true;
    }

    // Also clean up owner map if timer wasn't found but owner was tracked
    if (this._jobOwnerMap.has(cronId)) {
      this._jobOwnerMap.delete(cronId);
      return true;
    }

    return false;
  }

  /**
   * Get information about a scheduled job.
   *
   * @param cronId - ID of the cron job.
   * @returns Job info or `null` if not found.
   */
  getJobInfo(
    cronId: string,
  ): { jobId: string; ownerId: string | undefined; pending: boolean } | null {
    if (!this._timers.has(cronId)) return null;

    return {
      jobId: cronId,
      ownerId: this._jobOwnerMap.get(cronId),
      pending: true,
    };
  }

  /**
   * List all scheduled jobs.
   *
   * @returns Array of job info objects.
   */
  listJobs(): Array<{
    jobId: string;
    ownerId: string | undefined;
  }> {
    const jobs: Array<{ jobId: string; ownerId: string | undefined }> = [];
    for (const cronId of this._timers.keys()) {
      jobs.push({
        jobId: cronId,
        ownerId: this._jobOwnerMap.get(cronId),
      });
    }
    return jobs;
  }

  // -------------------------------------------------------------------------
  // Internal scheduling
  // -------------------------------------------------------------------------

  /**
   * Schedule a timer to fire at the cron's next run date.
   *
   * Handles long delays (> 24.8 days) by capping the timer at 24 hours
   * and re-evaluating on wake-up.
   *
   * @param cronId - The cron ID.
   * @param schedule - Cron expression string.
   * @param endTime - Optional end time (ISO 8601). Timer won't be set if expired.
   */
  private _scheduleTimer(
    cronId: string,
    schedule: string,
    endTime: string | null,
  ): void {
    // Check if cron has expired
    if (isCronExpired(endTime)) {
      console.log(
        `[cron-scheduler] Cron ${cronId} has expired, not scheduling`,
      );
      this._timers.delete(cronId);
      this._jobOwnerMap.delete(cronId);
      return;
    }

    // Calculate next run date
    const nextRunIso = calculateNextRunDate(schedule);
    const nextRunMs = new Date(nextRunIso).getTime();
    const nowMs = Date.now();
    let delayMs = nextRunMs - nowMs;

    // Clamp delay
    if (delayMs < MIN_TIMER_DELAY_MS) {
      delayMs = MIN_TIMER_DELAY_MS;
    }

    if (delayMs > MAX_TIMER_DELAY_MS) {
      // Too far in the future — set a wake-up timer to re-evaluate
      const timer = setTimeout(() => {
        this._timers.delete(cronId);
        this._scheduleTimer(cronId, schedule, endTime);
      }, MAX_TIMER_DELAY_MS);

      // Unref the timer so it doesn't prevent process exit
      if (timer && typeof timer === "object" && "unref" in timer) {
        (timer as NodeJS.Timeout).unref();
      }

      this._timers.set(cronId, timer);
      return;
    }

    // Set the actual execution timer
    const timer = setTimeout(() => {
      this._timers.delete(cronId);
      this._fireCronJob(cronId, schedule, endTime);
    }, delayMs);

    // Unref so timers don't prevent graceful shutdown
    if (timer && typeof timer === "object" && "unref" in timer) {
      (timer as NodeJS.Timeout).unref();
    }

    this._timers.set(cronId, timer);
  }

  /**
   * Fire a cron job: execute the run and reschedule.
   *
   * Called by the timer when a cron's next_run_date is reached.
   *
   * @param cronId - The cron ID.
   * @param schedule - Cron expression for rescheduling.
   * @param endTime - Optional end time for expiry check.
   */
  private _fireCronJob(
    cronId: string,
    schedule: string,
    endTime: string | null,
  ): void {
    const ownerId = this._jobOwnerMap.get(cronId);
    if (!ownerId) {
      console.warn(
        `[cron-scheduler] No owner found for cron ${cronId}, skipping execution`,
      );
      return;
    }

    console.log(
      `[cron-scheduler] Firing cron job ${cronId} for owner ${ownerId}`,
    );

    // Execute asynchronously — don't block the timer callback
    if (this._executeCallback) {
      this._executeCallback(cronId, ownerId).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(
          `[cron-scheduler] Error executing cron job ${cronId}: ${message}`,
        );
      });
    } else {
      console.warn(
        `[cron-scheduler] No execution callback set, skipping cron ${cronId}`,
      );
    }

    // Reschedule for next occurrence
    this._scheduleTimer(cronId, schedule, endTime);
  }
}

// ---------------------------------------------------------------------------
// Global singleton
// ---------------------------------------------------------------------------

let _scheduler: CronScheduler | null = null;

/**
 * Get the global scheduler instance.
 *
 * @returns CronScheduler singleton instance.
 */
export function getScheduler(): CronScheduler {
  if (_scheduler === null) {
    _scheduler = new CronScheduler();
  }
  return _scheduler;
}

/**
 * Reset the global scheduler (for testing).
 *
 * Shuts down the existing scheduler and creates a fresh instance on
 * next `getScheduler()` call.
 */
export function resetScheduler(): void {
  if (_scheduler !== null) {
    _scheduler.shutdown(false);
  }
  _scheduler = null;
}
