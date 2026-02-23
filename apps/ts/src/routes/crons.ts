/**
 * Cron routes for the Fractal Agents Runtime — TypeScript/Bun.
 *
 * Implements LangGraph-compatible endpoints for scheduled cron jobs:
 *
 *   POST   /runs/crons            — Create a cron job
 *   POST   /runs/crons/search     — Search cron jobs
 *   POST   /runs/crons/count      — Count cron jobs
 *   DELETE /runs/crons/:cron_id   — Delete a cron job
 *
 * Response conventions (matching Python exactly):
 *   - Create returns 200 with the Cron object.
 *   - Delete returns 200 with `{}` (empty object).
 *   - Count returns 200 with a bare integer (e.g., `3`).
 *   - Search returns 200 with a JSON array of Cron objects.
 *   - Errors use `{"detail": "..."}` shape (ErrorResponse).
 *
 * Owner isolation:
 *   - All operations require an authenticated user.
 *   - Crons are scoped to the creating user.
 *
 * Reference: apps/python/src/server/routes/crons.py
 */

import type { Router } from "../router";
import type {
  CronCreate,
  CronSearch,
  CronCountRequest,
} from "../models/cron";
import {
  validateCronSchedule,
  validateCronSelectFields,
  ON_RUN_COMPLETED_VALUES,
  CRON_SORT_BY_VALUES,
  SORT_ORDER_VALUES,
} from "../models/cron";
import {
  jsonResponse,
  errorResponse,
  validationError,
  requireBody,
  parseBody,
} from "./helpers";
import { getCronHandler } from "../crons/handlers";
import { getUserIdentity } from "../middleware/context";

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/**
 * POST /runs/crons — Create a cron job.
 *
 * Request body: CronCreate (schedule, assistant_id required).
 * Response: Cron (200) or error (4xx).
 */
async function handleCreateCron(request: Request): Promise<Response> {
  const ownerId = getUserIdentity();

  const [body, bodyError] = await requireBody<CronCreate>(request);
  if (bodyError) return bodyError;

  // --- Validate required fields ---

  if (!body.schedule || typeof body.schedule !== "string") {
    return validationError("'schedule' is required and must be a string");
  }

  if (!body.assistant_id || typeof body.assistant_id !== "string") {
    return validationError(
      "'assistant_id' is required and must be a string",
    );
  }

  // Validate cron schedule expression
  try {
    validateCronSchedule(body.schedule);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return validationError(message);
  }

  // Validate on_run_completed if provided
  if (
    body.on_run_completed !== undefined &&
    !ON_RUN_COMPLETED_VALUES.includes(body.on_run_completed)
  ) {
    return validationError(
      `'on_run_completed' must be one of: ${ON_RUN_COMPLETED_VALUES.join(", ")}`,
    );
  }

  // --- Create the cron ---

  const handler = getCronHandler();

  try {
    const cron = await handler.createCron(body, ownerId ?? "anonymous");
    return jsonResponse(cron, 200);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);

    // Assistant not found → 404
    if (message.includes("not found")) {
      return errorResponse(message, 404);
    }
    // End time in the past → 422
    if (message.includes("in the past")) {
      return validationError(message);
    }

    console.error(`[crons] Error creating cron: ${message}`);
    return errorResponse(`Internal error: ${message}`, 500);
  }
}

/**
 * POST /runs/crons/search — Search cron jobs.
 *
 * Request body: CronSearch (all fields optional).
 * Response: Cron[] (200) or error (4xx).
 */
async function handleSearchCrons(request: Request): Promise<Response> {
  const ownerId = getUserIdentity();

  // Body is optional for search (empty body = return all)
  const body = await parseBody<CronSearch>(request);
  const searchParams: CronSearch = body ?? {};

  // Validate limit
  if (searchParams.limit !== undefined) {
    if (
      typeof searchParams.limit !== "number" ||
      searchParams.limit < 1 ||
      searchParams.limit > 1000
    ) {
      return validationError("'limit' must be a number between 1 and 1000");
    }
  }

  // Validate offset
  if (searchParams.offset !== undefined) {
    if (
      typeof searchParams.offset !== "number" ||
      searchParams.offset < 0
    ) {
      return validationError("'offset' must be a non-negative number");
    }
  }

  // Validate sort_by
  if (
    searchParams.sort_by !== undefined &&
    !CRON_SORT_BY_VALUES.includes(searchParams.sort_by)
  ) {
    return validationError(
      `'sort_by' must be one of: ${CRON_SORT_BY_VALUES.join(", ")}`,
    );
  }

  // Validate sort_order
  if (
    searchParams.sort_order !== undefined &&
    !SORT_ORDER_VALUES.includes(searchParams.sort_order)
  ) {
    return validationError(
      `'sort_order' must be one of: ${SORT_ORDER_VALUES.join(", ")}`,
    );
  }

  // Validate select fields
  if (searchParams.select !== undefined && searchParams.select !== null) {
    if (!Array.isArray(searchParams.select)) {
      return validationError("'select' must be an array of field names");
    }
    try {
      validateCronSelectFields(searchParams.select);
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : String(error);
      return validationError(message);
    }
  }

  const handler = getCronHandler();

  try {
    const crons = await handler.searchCrons(searchParams, ownerId ?? "anonymous");
    return jsonResponse(crons, 200);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[crons] Error searching crons: ${message}`);
    return errorResponse(`Internal error: ${message}`, 500);
  }
}

/**
 * POST /runs/crons/count — Count cron jobs matching filters.
 *
 * Request body: CronCountRequest (all fields optional).
 * Response: integer (200) or error (4xx).
 */
async function handleCountCrons(request: Request): Promise<Response> {
  const ownerId = getUserIdentity();

  // Body is optional (empty body = count all)
  const body = await parseBody<CronCountRequest>(request);
  const countParams: CronCountRequest = body ?? {};

  const handler = getCronHandler();

  try {
    const count = await handler.countCrons(countParams, ownerId ?? "anonymous");
    return jsonResponse(count, 200);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[crons] Error counting crons: ${message}`);
    return errorResponse(`Internal error: ${message}`, 500);
  }
}

/**
 * DELETE /runs/crons/:cron_id — Delete a cron job.
 *
 * Path parameters: cron_id (UUID of the cron to delete).
 * Response: {} (200) or error (4xx).
 */
async function handleDeleteCron(
  _request: Request,
  params: Record<string, string>,
): Promise<Response> {
  const ownerId = getUserIdentity();

  const cronId = params.cron_id;
  if (!cronId) {
    return validationError("cron_id is required");
  }

  const handler = getCronHandler();

  try {
    const result = await handler.deleteCron(cronId, ownerId ?? "anonymous");
    return jsonResponse(result, 200);
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : String(error);

    // Cron not found → 404
    if (message.includes("not found")) {
      return errorResponse(message, 404);
    }

    console.error(`[crons] Error deleting cron: ${message}`);
    return errorResponse(`Internal error: ${message}`, 500);
  }
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Register all cron API routes on the router.
 *
 * IMPORTANT: Register /runs/crons/search and /runs/crons/count BEFORE
 * /runs/crons/:cron_id so that "search" and "count" are matched as
 * literal path segments, not captured as :cron_id params.
 *
 * @param router - The application router instance.
 */
export function registerCronRoutes(router: Router): void {
  // Search and count must be registered before the parameterized delete route
  router.post("/runs/crons/search", handleSearchCrons);
  router.post("/runs/crons/count", handleCountCrons);

  router.post("/runs/crons", handleCreateCron);
  router.delete("/runs/crons/:cron_id", handleDeleteCron);
}
