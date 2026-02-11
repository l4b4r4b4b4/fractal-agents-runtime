# Task 03: Robyn Storage → Postgres

> **Status**: 🟢 Complete
> **Parent Goal**: [12-Postgres-Persistence](../scratchpad.md)
> **Depends On**: [Task-01-Dependencies-DB-Module](../Task-01-Dependencies-DB-Module/scratchpad.md)
> **Created**: 2026-02-11
> **Updated**: 2026-02-13

## Objective

Replace the in-memory storage layer in `robyn_server/storage.py` with Postgres-backed implementations. All five stores (AssistantStore, ThreadStore, RunStore, StoreStorage, CronStore) must be reimplemented to use the Postgres instance via `psycopg` async queries. The existing `Storage` interface and `get_storage()` accessor must remain unchanged so that **zero route handler logic changes** are needed (only `await` additions).

## Implementation Phases

### Phase 1: Async Migration ✅ COMPLETE

Make all in-memory storage methods `async def` and add `await` to all call sites.

#### ✅ Completed

- [x] `pyproject.toml`: Changed `asyncio_mode` from `"strict"` to `"auto"` (less boilerplate for async tests)
- [x] `robyn_server/storage.py`: ALL methods converted to `async def` across all 6 classes:
  - `BaseStore`: `create`, `get`, `list`, `update`, `delete`, `count`, `clear`
  - `AssistantStore`: `create`, `update` (override + `await super()`)
  - `ThreadStore`: `create`, `delete`, `get_state`, `add_state_snapshot`, `get_history`, `clear`
  - `RunStore`: `create`, `list_by_thread`, `get_by_thread`, `delete_by_thread`, `get_active_run`, `update_status`, `count_by_thread`
  - `StoreStorage`: `put`, `get`, `delete`, `search`, `list_namespaces`, `clear`
  - `CronStore`: `create`, `update`, `count`
  - `Storage`: `clear_all`
- [x] `robyn_server/routes/assistants.py`: All storage calls have `await`
- [x] `robyn_server/routes/threads.py`: All storage calls have `await`
- [x] `robyn_server/routes/runs.py`: All storage calls have `await`
- [x] `robyn_server/routes/store.py`: All storage calls have `await`
- [x] `robyn_server/routes/streams.py`: All storage calls have `await` (including inner generators + final state store)
- [x] `robyn_server/routes/crons.py`: Already used `await` (handler methods were async)
- [x] `robyn_server/crons/handlers.py`: All storage calls have `await`
- [x] `robyn_server/a2a/handlers.py`: All storage calls have `await`
- [x] `robyn_server/tests/test_storage.py`: ALL 47 tests converted to `async def` + `await` — **47/47 PASSING**
- [x] `robyn_server/tests/test_a2a.py`: Mock storage fixtures updated `MagicMock` → `AsyncMock` for storage methods — **ALL PASSING**
- [x] `robyn_server/tests/test_assistants.py`: ALL 32 tests converted — **32/32 PASSING**
- [x] `robyn_server/tests/test_threads.py`: ALL 46 tests converted — **46/46 PASSING**
- [x] `robyn_server/tests/test_runs.py`: ALL 36 tests converted (including async fixtures) — **36/36 PASSING**
- [x] `robyn_server/tests/test_streams.py`: ALL 38 tests converted (including async fixtures) — **38/38 PASSING**
- [x] `robyn_server/tests/test_crons.py`: ALL 58 tests converted (async fixture + scheduler tests) — **58/58 PASSING**
- [x] Production bug fix: `streams.py` L772-773 had missing `await` on `add_state_snapshot()` and `update()`
- [x] Ruff check + format: **CLEAN**
- [x] **440/440 tests passing, 0 failures, 0 errors**

### Phase 2: Postgres Storage Implementation ✅ COMPLETE

1. [x] Created `robyn_server/postgres_storage.py` (~1636 lines) with:
   - `PostgresAssistantStore` — full CRUD with `WHERE metadata->>'owner' = %s`, version incrementing
   - `PostgresThreadStore` — CRUD + state snapshots via `thread_states` table + history with pagination
   - `PostgresRunStore` — CRUD + thread-scoped queries + status updates + `count_by_thread` via SQL COUNT
   - `PostgresStoreStorage` — namespace/key upsert (ON CONFLICT) + search with LIKE prefix + list_namespaces
   - `PostgresCronStore` — CRUD with schedule management + count with optional `assistant_id` filter
   - `PostgresStorage` — container with `run_migrations()` method (executes idempotent DDL)
   - `PostgresStoreItem` — Postgres-specific store item with `to_dict()` serialization
   - Embedded DDL for `langgraph_server` schema + 6 tables + 2 indexes
2. [x] Added `_create_langgraph_server_schema()` to `database.py` — called from `initialize_database()`
3. [x] Wired `get_storage()` in `storage.py` to return `PostgresStorage` when `is_postgres_enabled()`
   - Falls back to in-memory `Storage` when `DATABASE_URL` not set
   - Falls back to in-memory with warning when pool unavailable

#### DDL Tables Created

| Table | Columns | PKs/Indexes |
|-------|---------|-------------|
| `assistants` | id, graph_id, config, context, metadata, name, description, version, created_at, updated_at | PK: id |
| `threads` | id, metadata, config, status, values, interrupts, created_at, updated_at | PK: id |
| `thread_states` | id (SERIAL), thread_id (FK CASCADE), values, metadata, next, tasks, checkpoint_id, parent_checkpoint, interrupts, created_at | PK: id, IDX: (thread_id, created_at DESC) |
| `runs` | id, thread_id, assistant_id, status, metadata, kwargs, multitask_strategy, created_at, updated_at | PK: id, IDX: (thread_id, created_at DESC) |
| `store_items` | namespace, key, value, owner_id, metadata, created_at, updated_at | PK: (namespace, key, owner_id) |
| `crons` | id, assistant_id, thread_id, end_time, schedule, user_id, payload, next_run_date, metadata, created_at, updated_at | PK: id |

### Phase 3: Verification ✅ COMPLETE

1. [x] **440/440 tests pass** (all in-memory tests unaffected by Postgres additions)
2. [x] **Ruff check + format clean** (45 files unchanged)
3. [x] **DDL migration verified** against Supabase Postgres (6 tables + 8 indexes created)
4. [x] **Full E2E test with real Postgres**:
   - Assistant CRUD: create → get → update (version increment) → owner isolation → list → delete
   - Thread CRUD: create → get_state → add_state_snapshot → get_history → delete
   - Run CRUD: create → update_status → count_by_thread → delete
   - Store (KV): put → get → list_namespaces → delete
   - Cron CRUD: create → count → delete
5. [x] **`get_storage()` switch verified**: Returns `Storage` without Postgres, `PostgresStorage` with Postgres
6. [x] **Idempotent DDL**: `initialize_database()` runs cleanly on re-execution (no errors on existing schema/tables)

## Files Modified

| File | Action | Status |
|------|--------|--------|
| `pyproject.toml` | MODIFIED — `asyncio_mode = "auto"` | ✅ |
| `robyn_server/storage.py` | MODIFIED — all methods `async def` + `get_storage()` Postgres switch | ✅ |
| `robyn_server/routes/assistants.py` | MODIFIED — `await` added | ✅ |
| `robyn_server/routes/threads.py` | MODIFIED — `await` added | ✅ |
| `robyn_server/routes/runs.py` | MODIFIED — `await` added | ✅ |
| `robyn_server/routes/store.py` | MODIFIED — `await` added | ✅ |
| `robyn_server/routes/streams.py` | MODIFIED — `await` added (including final state store bug fix) | ✅ |
| `robyn_server/crons/handlers.py` | MODIFIED — `await` added | ✅ |
| `robyn_server/a2a/handlers.py` | MODIFIED — `await` added | ✅ |
| `robyn_server/database.py` | MODIFIED — added `_create_langgraph_server_schema()` DDL migration | ✅ |
| `robyn_server/tests/test_storage.py` | MODIFIED — async tests | ✅ 47/47 passing |
| `robyn_server/tests/test_a2a.py` | MODIFIED — AsyncMock | ✅ all passing |
| `robyn_server/tests/test_assistants.py` | MODIFIED — async + await | ✅ 32/32 passing |
| `robyn_server/tests/test_threads.py` | MODIFIED — async + await | ✅ 46/46 passing |
| `robyn_server/tests/test_runs.py` | MODIFIED — async + await + async fixtures | ✅ 36/36 passing |
| `robyn_server/tests/test_streams.py` | MODIFIED — async + await + async fixtures | ✅ 38/38 passing |
| `robyn_server/tests/test_crons.py` | MODIFIED — async + await + async fixtures | ✅ 58/58 passing |

## Files Created

| File | Action | Status |
|------|--------|--------|
| `robyn_server/postgres_storage.py` | CREATED — 5 Postgres store classes + container (~1636 lines) | ✅ |

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| Option A (all methods async) | Clean, consistent, forward-compatible — routes already `async def` |
| `asyncio_mode = "auto"` | Eliminates `@pytest.mark.asyncio` boilerplate on every test |
| Standalone Postgres stores | No `PostgresBaseStore` — simpler, avoids over-abstraction |
| Parameterized queries only | `%s` placeholders, never f-strings for SQL |
| Owner isolation via SQL WHERE | `metadata->>'owner' = %s` in every query |
| DDL at startup | Idempotent `CREATE IF NOT EXISTS` in `initialize_database()` |
| `get_storage()` stays sync | Pool exists by startup time; no async needed for constructor |

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| 107 failing tests block progress | Mechanical `async`/`await` changes — use `test_storage.py` as template |
| Mocked storage in tests needs AsyncMock | Pattern proven in `test_a2a.py` — apply same to `test_streams.py`, `test_crons.py` |
| JSONB serialization edge cases | Use `psycopg.types.json.Json` adapter; test with real data |
| SQL injection | All queries parameterized — code review every query |
| Large scope (~15 files, ~1500-2000 lines) | Split into 3 phases; gate each phase on passing tests |

## Acceptance Criteria

- [x] All in-memory storage methods are `async def`
- [x] All call sites use `await`
- [x] All 440 tests pass (Phase 1 gate)
- [x] `langgraph_server` schema created with all six tables + indexes
- [x] `PostgresStorage` container wires all stores with shared pool
- [x] `get_storage()` returns `PostgresStorage` when `DATABASE_URL` is set
- [x] `get_storage()` returns in-memory `Storage` when `DATABASE_URL` is not set
- [x] Owner isolation enforced in all SQL queries (`metadata->>'owner' = %s`)
- [x] DDL migrations are idempotent (safe to run on every startup)
- [x] No SQL injection vectors (all queries parameterized with `%s`)
- [x] `ruff check` and `ruff format` pass
- [x] Manual E2E test: full CRUD on all 5 stores against Supabase Postgres

## Notes

- The `test_storage.py` and `test_a2a.py` conversions served as proven templates for all 5 remaining test files.
- `CronStore.create()` has a custom signature (doesn't call `super().create()`) — handled in both storage.py and postgres_storage.py.
- `StoreStorage` doesn't extend `BaseStore` — independent methods, replicated in `PostgresStoreStorage`.
- Production bug fix discovered during Phase 1: `streams.py` L772-773 had missing `await` on `add_state_snapshot()` and `update()` — fixed.
- The `store_items` table uses a composite PK of `(namespace, key, owner_id)` to support multi-tenant isolation at the database level.
- `PostgresStorage.run_migrations()` splits DDL into individual statements since psycopg doesn't support multi-statement execute in all modes.
- All JSONB columns handle both `str` and `dict` deserialization for robustness across different psycopg `row_factory` modes.