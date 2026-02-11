# Goal 12: Postgres Persistence

> **Status**: 🟡 In Progress
> **Priority**: P1 (High)
> **Created**: 2026-02-11
> **Updated**: 2026-02-13
> **Progress**: Tasks 01 + 02 + 03 complete, Task-04 (Integration Testing) remaining

## Overview

Integrate Postgres persistence into the LangGraph tools agent and Robyn runtime server. This goal connects both the LangGraph checkpointer/store (agent conversation state + cross-thread memory) and the Robyn runtime storage layer (assistants, threads, runs, crons, key-value store) to the Postgres instance running inside the user's Supabase stack.

**Direct Postgres connection** — bypasses the Supabase API layer for lowest latency. Auth is handled at the application layer (Robyn middleware), not via Postgres RLS.

## Success Criteria

- [ ] `DATABASE_URL` environment variable configurable for Postgres connection
- [ ] Shared connection pool module (`database.py`) with `psycopg` async pool
- [ ] `AsyncPostgresSaver` (LangGraph checkpointer) wired into agent compilation — conversation state persists across restarts
- [ ] `AsyncPostgresStore` (LangGraph store) wired into agent compilation — cross-thread memory available
- [ ] `.setup()` called at startup for both checkpointer and store (auto-creates tables)
- [x] Robyn runtime storage (`storage.py`) backed by Postgres instead of in-memory dicts
- [x] Custom `langgraph_server` schema created for Robyn runtime tables (assistants, threads, runs, crons, store_items, thread_states)
- [x] Same `Storage` interface preserved — route handlers require zero changes
- [x] Falls back to in-memory storage when `DATABASE_URL` is not set (backward compatible)
- [ ] Persistence verified across server restarts (Task-04)
- [x] All existing tests continue to pass (440/440)

## Context & Background

### Why Postgres Persistence?

Currently **all data is lost on restart**:
- Agent conversation state (no checkpointer configured)
- Assistants, threads, runs, crons, store items (all in-memory Python dicts in `storage.py`)

The Supabase stack provides a Postgres instance at:
```
postgresql://postgres:postgres@127.0.0.1:54322/postgres
```

### Two Distinct Persistence Layers

| Layer | What it stores | Solution | Tables managed by |
|-------|---------------|----------|-------------------|
| **LangGraph Checkpointer** | Agent conversation state, checkpoints per super-step, thread history, time-travel | `AsyncPostgresSaver` from `langgraph-checkpoint-postgres` | Auto-created by `.setup()` |
| **LangGraph Store** | Cross-thread long-term memory (user preferences, facts across conversations) | `AsyncPostgresStore` from `langgraph-checkpoint-postgres` | Auto-created by `.setup()` |
| **Robyn Runtime Storage** | Server resources: assistants, threads metadata, runs, crons, key-value store | Custom Postgres-backed `Storage` class using `psycopg` | Our DDL migrations in `langgraph_server` schema |

### Existing Supabase Schema

The `public` schema already has a rich application schema (profiles, organizations, chat_sessions, etc.). The `chat_sessions` table even has a `thread_id` field for LangGraph thread IDs. Our agent/runtime tables should go in a **dedicated schema** (`langgraph_server`) to avoid polluting or conflicting with the existing `public` schema.

### Official LangGraph Pattern (from docs)

```python
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from langgraph.store.postgres.aio import AsyncPostgresStore

DB_URI = "postgresql://postgres:postgres@localhost:54322/postgres?sslmode=disable"

async with (
    AsyncPostgresStore.from_conn_string(DB_URI) as store,
    AsyncPostgresSaver.from_conn_string(DB_URI) as checkpointer,
):
    await store.setup()        # one-time table creation
    await checkpointer.setup() # one-time table creation

    graph = builder.compile(
        checkpointer=checkpointer,  # short-term memory (thread state)
        store=store,                # long-term memory (cross-thread)
    )
```

## Constraints & Requirements

- **Hard Requirements**:
  - Direct Postgres connection (not Supabase API)
  - `DATABASE_URL` env var for connection string configuration
  - Backward compatible — in-memory fallback when no `DATABASE_URL`
  - Robyn runtime route handlers must NOT change (same `Storage` interface)
  - `pyproject.toml` + `uv.lock` committed together
  - No secrets in code — connection string via env var only
  - Dedicated `langgraph_server` schema for runtime tables (not `public`)
- **Soft Requirements**:
  - Single connection pool shared between checkpointer and storage
  - Connection pool with sensible defaults (min_size=2, max_size=10)
  - Graceful degradation if Postgres is temporarily unavailable
  - Schema migrations tracked and repeatable
- **Out of Scope**:
  - Supabase RLS for agent tables (auth handled at application layer)
  - Data migration from in-memory to Postgres (fresh start is fine)
  - Redis for pub/sub streaming (future consideration)
  - Checkpoint encryption (LANGGRAPH_AES_KEY — future enhancement)

## Approach

1. **DB connection module** — shared pool, config, setup logic
2. **LangGraph checkpointer + store** — wire into agent compilation
3. **Robyn storage backend** — Postgres implementations of all stores
4. **Integration testing** — verify persistence across restarts

## Tasks

| Task ID | Description | Status | Depends On |
|---------|-------------|--------|------------|
| Task-01 | Dependencies & DB Module — `DATABASE_URL` config, connection pool, `database.py` module, RLS hardening | 🟢 | Goal 11 (packages already added) |
| Task-02 | LangGraph Checkpointer + Store — wire into `create_agent()`, live E2E persistence verified | 🟢 | Task-01 |
| Task-03 | Robyn Storage → Postgres — async migration + `langgraph_server` schema DDL + Postgres-backed stores | 🟢 | Task-01 |
| Task-04 | Integration Testing — persistence across restarts, conversation memory, thread history, Robyn CRUD | ⚪ | Task-02, Task-03 |

## Architecture

### Connection Flow (Implemented)

```
Robyn Server startup (@app.startup_handler)
  ├── Load DATABASE_URL from env (DatabaseConfig.from_env())
  ├── Fast-fail probe: single AsyncConnection with 5s timeout
  ├── Create shared AsyncConnectionPool (psycopg_pool)
  │   └── kwargs: autocommit=True, prepare_threshold=0, row_factory=dict_row
  ├── AsyncPostgresSaver(conn=pool) → checkpointer (shared pool, not from_conn_string)
  │   └── await checkpointer.setup()  (creates checkpoint tables)
  ├── AsyncPostgresStore(conn=pool) → store (shared pool, not from_conn_string)
  │   └── await store.setup()  (creates store tables)
  ├── Enable RLS on all 6 LangGraph tables (idempotent ALTER TABLE)
  ├── Wire checkpointer + store into create_agent() via get_checkpointer()/get_store()
  └── (Future: Task-03) Create PostgresStorage(pool) → runtime storage
```

### Schema Layout

```
postgres (database)
  ├── public.*                    — existing Supabase app tables (untouched)
  ├── checkpoint_*                — LangGraph checkpointer tables (auto-created by .setup())
  ├── store.*                     — LangGraph store tables (auto-created by .setup())
  └── langgraph_server.*          — Robyn runtime tables (our DDL, created by PostgresStorage.run_migrations())
      ├── assistants              — assistant definitions with versioning
      ├── threads                 — thread metadata and current values
      ├── thread_states           — state history snapshots (FK CASCADE to threads)
      ├── runs                    — run execution records
      ├── store_items             — key-value store with owner isolation
      └── crons                   — scheduled job definitions
```

### Storage Interface (unchanged)

```python
# This interface stays the same — routes don't change
storage = get_storage()
storage.assistants.create(...)
storage.threads.create(...)
storage.runs.create(...)
storage.store.put(...)
storage.crons.create(...)
```

The `get_storage()` function returns either `InMemoryStorage` (no DATABASE_URL) or `PostgresStorage` (DATABASE_URL set).

## Risks & Mitigations

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| Connection pool exhaustion under load | High | Medium | Sensible pool defaults (max_size=10), monitoring, configurable via env |
| LangGraph `.setup()` DDL conflicts with existing schema | Medium | Low | Checkpointer/store create their own tables with unique names; verified in docs |
| Postgres unavailable at startup | High | Low | Graceful error message; fall back to in-memory with warning |
| Schema migration drift between environments | Medium | Medium | Track migrations in code; idempotent DDL (IF NOT EXISTS) |
| `psycopg` async not compatible with Robyn's event loop | Medium | Low | Both use asyncio; Robyn supports async handlers natively |
| Supabase Postgres has restricted permissions | Medium | Low | Local dev stack has full superuser access; production will need GRANT statements |

## Dependencies

- **Upstream**: Goal 11 (`create_agent` migration + `langgraph-checkpoint-postgres` dependency)
- **Downstream**: Future goals (checkpoint encryption, TTL policies, Redis streaming)

## Files Created/Modified

### Created Files
- `robyn_server/database.py` — connection pool management, setup logic, DDL migration ✅
- `robyn_server/postgres_storage.py` — Postgres-backed Storage implementations (~1636 lines) ✅

### Modified Files
- `robyn_server/config.py` — `DatabaseConfig` dataclass with `DATABASE_URL` ✅
- `robyn_server/storage.py` — all methods `async def` + `get_storage()` Postgres switch ✅
- `robyn_server/app.py` — startup/shutdown handlers for pool + `.setup()` ✅
- `tools_agent/agent.py` — checkpointer + store wiring ✅
- `robyn_server/routes/*.py` — `await` added to all storage calls ✅
- `robyn_server/crons/handlers.py` — `await` added ✅
- `robyn_server/a2a/handlers.py` — `await` added ✅
- `robyn_server/routes/streams.py` — `await` added + bug fix (missing await on final state store) ✅
- `pyproject.toml` — `asyncio_mode = "auto"` ✅
- All 7 test files — converted to async ✅

## Notes & Decisions

### Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-02-11 | Direct Postgres, not Supabase API | Lowest latency; auth already at app layer; no need for RLS on agent internals |
| 2026-02-11 | Dedicated `langgraph_server` schema | Avoid polluting existing `public` schema; clear ownership boundary |
| 2026-02-11 | In-memory fallback when no DATABASE_URL | Backward compatible for dev/testing without Postgres |
| 2026-02-11 | Same `Storage` interface | Routes must not change — swap implementation, not API |
| 2026-02-11 | Checkpointer + Store are separate from runtime storage | LangGraph manages its own tables; we manage ours |
| 2026-02-12 | Shared pool via direct constructor, not `from_conn_string()` | Both accept `AsyncConnectionPool` as `conn` param — fewer connections, simpler lifecycle, no context manager gymnastics |
| 2026-02-12 | Fast-fail probe before pool creation | Single throwaway `AsyncConnection` with 5s timeout catches unreachable hosts in ~0.07s instead of 30s+ pool retry loop |
| 2026-02-12 | RLS at startup, not Supabase migration | `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` (idempotent) runs after `setup()` — no permissive policies means PostgREST can't access; superuser bypasses RLS |
| 2026-02-12 | Task-02 merged into Task-01 | Agent wiring + live E2E test naturally fit the same implementation session; no reason to split |

### Open Questions

- [x] Should the connection pool be shared between LangGraph checkpointer/store and our runtime storage? → **YES** — single `AsyncConnectionPool` shared by checkpointer, store, and runtime `PostgresStorage`. Both accept `Union[AsyncConnection, AsyncConnectionPool]` as `conn` param.
- [x] What connection pool size is appropriate? → **min=2, max=10** (configurable via `DATABASE_POOL_MIN_SIZE`/`DATABASE_POOL_MAX_SIZE` env vars)
- [x] Should we add health check for Postgres connectivity to the `/health` endpoint? → **YES** — `/health` returns `"persistence": "postgres"` or `"persistence": "in-memory"`
- [x] How to handle sync→async migration for storage methods? → **Option A: make all methods async** — in-memory methods are trivially async, Postgres methods naturally async. All route handlers already `async def` so adding `await` is mechanical.
- [ ] Do we need to handle Postgres connection drops gracefully mid-stream? (retry logic — future enhancement)
- [ ] Should `chat_sessions.thread_id` in the existing `public` schema be linked to LangGraph thread IDs? (cross-system integration)

### Task-03 Complete (All 3 Phases)

**Phase 1 — Async Migration ✅:**
- All storage methods in `storage.py` converted to `async def` (6 classes, ~30 methods)
- All route handlers + handler modules updated with `await`
- All 7 test files converted to async — **440/440 tests passing**
- Production bug fix: `streams.py` had missing `await` on final state store calls

**Phase 2 — Postgres Storage Implementation ✅:**
- Created `robyn_server/postgres_storage.py` (~1636 lines) with 5 Postgres store classes + container
- Added `_create_langgraph_server_schema()` DDL migration to `database.py`
- Wired `get_storage()` to return `PostgresStorage` when `is_postgres_enabled()`
- 6 tables + 2 indexes created in `langgraph_server` schema

**Phase 3 — Verification ✅:**
- 440/440 tests pass, ruff clean
- DDL migration verified against Supabase Postgres (6 tables, 8 indexes)
- Full E2E test: CRUD on all 5 stores against real Postgres
- `get_storage()` switch verified: `Storage` without Postgres, `PostgresStorage` with Postgres
- Idempotent DDL: re-runs cleanly without errors

## References

- [LangGraph Persistence Docs](https://docs.langchain.com/oss/python/langgraph/persistence)
- [LangGraph Add Memory Guide](https://docs.langchain.com/oss/python/langgraph/add-memory)
- [langgraph-checkpoint-postgres PyPI](https://pypi.org/project/langgraph-checkpoint-postgres/)
- [psycopg3 Docs](https://www.psycopg.org/psycopg3/docs/)
- [LangGraph Agent Server Data Plane](https://docs.langchain.com/langsmith/data-plane) — "PostgreSQL is the persistence layer for all user, run, and long-term memory data"
- Goal 04 scratchpad — Supabase integration context, DB connection string
- Goal 11 scratchpad — `create_agent` migration (prerequisite)