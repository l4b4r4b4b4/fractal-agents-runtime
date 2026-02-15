# Task-05: Crons API + Scheduler — Scratchpad

**Status:** 🟢 Complete
**Session:** 28
**Goal:** [26 — TS Runtime v0.0.3](../scratchpad.md)

---

## Objective

Implement the LangGraph-compatible Crons API for scheduled recurring agent runs, matching the Python runtime's `apps/python/src/server/crons/` module. Four HTTP endpoints, in-memory storage, timer-based scheduler, and full test coverage.

## What Was Done

### New Dependency
- **`cron-parser@5.5.0`** — Cron expression parsing and next-run-date calculation (equivalent of Python's `croniter`). Pure JS, works natively in Bun.

### Files Created

- **`src/models/cron.ts`** — Type definitions and helper functions:
  - Types: `Cron`, `CronCreate`, `CronSearch`, `CronCountRequest`, `CronPayload`, `CronConfig`
  - Enums: `OnRunCompleted` ("delete" | "keep"), `CronSortBy`, `SortOrder`
  - Constants: `ON_RUN_COMPLETED_VALUES`, `CRON_SORT_BY_VALUES`, `SORT_ORDER_VALUES`, `VALID_CRON_SELECT_FIELDS`
  - Helpers: `validateCronSchedule()`, `calculateNextRunDate()`, `isCronExpired()`, `cronPayloadToDict()`, `validateCronSelectFields()`

- **`src/crons/scheduler.ts`** — `CronScheduler` class:
  - Timer-based scheduling using `setTimeout` (Bun-native, no APScheduler equivalent needed)
  - `start()`, `shutdown()`, `addCronJob()`, `removeCronJob()`, `getJobInfo()`, `listJobs()`
  - Max timer delay capping (24h) with auto-reschedule for long intervals
  - Timer unref for graceful shutdown
  - Execution callback pattern to decouple from handler (avoids circular imports)
  - Singleton: `getScheduler()` / `resetScheduler()`

- **`src/crons/handlers.ts`** — `CronHandler` class:
  - `createCron()` — validates assistant, creates placeholder thread, builds payload, calculates next run, persists, schedules
  - `searchCrons()` — list with filters, sorting, pagination
  - `countCrons()` — count with filters
  - `deleteCron()` — removes from scheduler + storage
  - `getCron()` — get by ID
  - `executeCronRun()` — called by scheduler when job fires, creates run, updates next_run_date
  - Singleton: `getCronHandler()` / `resetCronHandler()`
  - Wires execution callback into scheduler on first init

- **`src/crons/index.ts`** — Barrel exports

- **`src/routes/crons.ts`** — HTTP route handlers:
  - `POST /runs/crons` — Create cron (validates schedule, assistant_id, on_run_completed)
  - `POST /runs/crons/search` — Search with filters, sort, pagination, select validation
  - `POST /runs/crons/count` — Count with filters → bare integer
  - `DELETE /runs/crons/:cron_id` — Delete cron + cancel timer
  - All handlers use named functions (not inline), matching codebase conventions
  - Route registration order: search/count before parameterized delete (prevents `:cron_id` capture)

- **`tests/crons.test.ts`** — 143 tests across all layers:
  - Model helpers: validateCronSchedule, calculateNextRunDate, isCronExpired, cronPayloadToDict, validateCronSelectFields, enum constants
  - InMemoryCronStore: create, get, list (with filters), update, delete, count, clear, owner isolation
  - InMemoryStorage: crons field presence, clearAll includes crons
  - CronScheduler: lifecycle, addCronJob/removeCronJob, expired cron handling, getJobInfo/listJobs, execution callback, singleton
  - CronHandler: createCron, searchCrons, countCrons, deleteCron, getCron, executeCronRun, graph_id resolution, singleton
  - HTTP routes: all 4 endpoints with success/error/validation cases, CRUD lifecycle integration, pagination

### Files Modified

- **`src/storage/types.ts`** — Added `CronStore` interface (create, get, list, update, delete, count, clear) + `crons` field on `Storage` interface
- **`src/storage/memory.ts`** — Added `InMemoryCronStore` class + updated `InMemoryStorage` constructor and `clearAll()`
- **`src/storage/postgres.ts`** — Added `InMemoryCronStore` import + `crons` field on `PostgresStorage` (in-memory fallback for v0.0.3)
- **`src/config.ts`** — Updated `getCapabilities()`: `crons: true`
- **`src/index.ts`** — Registered cron routes, scheduler startup/shutdown in server lifecycle

## Design Decisions

1. **`setTimeout`-based scheduler** — Bun-native, no npm dependency. Each cron gets a timer that fires at `next_run_date`, executes, then reschedules. Handles long intervals by capping at 24h and re-evaluating.

2. **Execution callback pattern** — Scheduler calls handler's `executeCronRun()` via a callback set at init time. This avoids circular imports (scheduler ↔ handler) and keeps the scheduler decoupled.

3. **In-memory cron storage for Postgres mode** — Since the scheduler itself is in-memory (timers don't survive restarts), using `InMemoryCronStore` even when Postgres is configured is acceptable for v0.0.3. A full `PostgresCronStore` can come later.

4. **Graceful auth degradation** — Cron routes follow the same pattern as all other TS runtime routes: when Supabase auth is not configured, `ownerId` falls back to `"anonymous"`. This is consistent with v0.0.1 behavior and avoids special-casing crons.

5. **Response shapes match Python exactly** — Cron response has all 11 fields (cron_id, assistant_id, thread_id, end_time, schedule, created_at, updated_at, user_id, payload, next_run_date, metadata). Count returns bare integer. Delete returns `{}`.

## Test Results

- 143 cron-specific tests: ✅ all pass
- Full test suite (1380 tests across 22 files): ✅ all pass
- Diagnostics: ✅ clean (no errors or warnings)

## Acceptance Criteria — All Met ✅

- [x] `POST /runs/crons` creates cron with valid schedule expression
- [x] `POST /runs/crons/search` filters and paginates correctly
- [x] `POST /runs/crons/count` returns accurate count
- [x] `DELETE /runs/crons/{cron_id}` removes cron and cancels scheduled timer
- [x] Scheduler manages timers for cron execution
- [x] `end_time` prevents scheduling past expiry
- [x] `next_run_date` calculated and stored correctly
- [x] Failed cron runs logged, cron rescheduled for next occurrence
- [x] Response shapes match Python OpenAPI spec (Cron schema)
- [x] Scheduler starts on server startup, stops on shutdown
- [x] Full test suite passes (1380 tests)
- [x] Diagnostics clean