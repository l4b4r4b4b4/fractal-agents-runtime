# Task 01: Dependencies & DB Module

> **Status**: 🟢 Complete
> **Parent Goal**: [12-Postgres-Persistence](../scratchpad.md)
> **Depends On**: Goal 11 (packages already added in Goal 11 Task-01)
> **Created**: 2026-02-11
> **Updated**: 2026-02-12
> **Completed**: 2026-02-12

## Objective

Create the database connection infrastructure for Postgres persistence. This includes the `DATABASE_URL` environment variable configuration, a shared async connection pool module, and startup/shutdown lifecycle management. This module is the foundation that both the LangGraph checkpointer/store (Task-02) and the Robyn runtime storage (Task-03) will build on.

## Implementation Plan

### Step 1: Add `DatabaseConfig` to `robyn_server/config.py`

```python
@dataclass
class DatabaseConfig:
    """Database configuration for Postgres persistence."""

    url: str = ""
    pool_min_size: int = 2
    pool_max_size: int = 10
    pool_timeout: float = 30.0

    @classmethod
    def from_env(cls) -> "DatabaseConfig":
        return cls(
            url=os.getenv("DATABASE_URL", ""),
            pool_min_size=int(os.getenv("DATABASE_POOL_MIN_SIZE", "2")),
            pool_max_size=int(os.getenv("DATABASE_POOL_MAX_SIZE", "10")),
            pool_timeout=float(os.getenv("DATABASE_POOL_TIMEOUT", "30.0")),
        )

    @property
    def is_configured(self) -> bool:
        return bool(self.url)
```

Also add `database: DatabaseConfig` to the `Config` dataclass and wire it into `Config.from_env()`.

### Step 2: Create `robyn_server/database.py`

New module responsible for:

1. **Connection pool lifecycle** — create, manage, and close an `AsyncConnectionPool` from `psycopg_pool`
2. **LangGraph checkpointer/store initialization** — create `AsyncPostgresSaver` and `AsyncPostgresStore` instances
3. **Setup logic** — call `.setup()` on first run to auto-create LangGraph tables
4. **RLS hardening** — enable Row-Level Security on LangGraph tables to block PostgREST access
5. **Singleton access** — global accessor functions (`get_checkpointer()`, `get_store()`, `get_pool()`)
6. **Graceful shutdown** — close pool on server shutdown

### Step 3: Wire into Robyn server lifecycle

In `robyn_server/app.py`, call `initialize_database()` at startup and `shutdown_database()` at shutdown via `@app.startup_handler` and `@app.shutdown_handler`.

### Step 4: Wire checkpointer/store into agent

In `tools_agent/agent.py`, import `get_checkpointer()` and `get_store()` from `robyn_server.database` and pass them to `create_agent(checkpointer=..., store=...)`. Returns `None` when Postgres is not configured — `create_agent` handles `None` gracefully (no persistence).

## Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `robyn_server/database.py` | **CREATE** | Connection pool, checkpointer/store init, RLS hardening, lifecycle management |
| `robyn_server/config.py` | MODIFY | Add `DatabaseConfig` dataclass |
| `robyn_server/app.py` | MODIFY | Wire startup/shutdown lifecycle, update health/info endpoints |
| `tools_agent/agent.py` | MODIFY | Wire checkpointer + store into `create_agent()` call |

## Dependencies (Python packages)

All already installed by Goal 11 Task-01:

- `langgraph-checkpoint-postgres>=3.0.4` — provides `AsyncPostgresSaver`, `AsyncPostgresStore`
- `psycopg[binary,pool]>=3.2.0` — provides `AsyncConnectionPool`, async Postgres driver
- `psycopg-pool>=3.2.0` — connection pooling (transitive from above)

## Acceptance Criteria

- [x] `robyn_server/database.py` module created with pool management
- [x] `DatabaseConfig` added to `robyn_server/config.py`
- [x] `initialize_database()` successfully connects to local Supabase Postgres
- [x] `get_checkpointer()` returns a valid `AsyncPostgresSaver` when configured
- [x] `get_store()` returns a valid `AsyncPostgresStore` when configured
- [x] `is_postgres_enabled()` returns `True` when configured, `False` otherwise
- [x] Startup/shutdown lifecycle wired into Robyn server
- [x] Falls back gracefully to in-memory when `DATABASE_URL` is not set
- [x] Fast-fail on unreachable Postgres (~0.07s, not 30s+ retry loop)
- [x] RLS enabled on all 6 LangGraph tables at startup (idempotent)
- [x] Checkpointer + store wired into `create_agent()` in `tools_agent/agent.py`
- [x] Live E2E test: multi-turn conversation with memory persistence verified
- [x] Thread isolation verified (different thread = no shared memory)
- [x] `ruff check` and `ruff format` pass
- [x] Existing tests still pass (no regressions) — 440 passed

## Implementation Notes (Completed)

### Key Design Decisions

1. **Shared pool**: Both `AsyncPostgresSaver` and `AsyncPostgresStore` accept `Union[AsyncConnection, AsyncConnectionPool]` as their `conn` parameter (the internal `_ainternal.Conn` type). We create a single `AsyncConnectionPool` and pass it to both constructors directly — no `from_conn_string()` context managers needed. This reduces Postgres connection count and simplifies lifecycle.

2. **Fast-fail probe**: Before creating the pool, we open a single throwaway `AsyncConnection` with `asyncio.wait_for(timeout=5s)`. If Postgres is unreachable, we fail in ~0.07s instead of the pool's 30s+ retry loop. The probe connection is closed immediately after success.

3. **Pool kwargs match LangGraph internals**: The pool is created with `autocommit=True, prepare_threshold=0, row_factory=dict_row` — exactly what `from_conn_string()` uses internally. This ensures the checkpointer and store operate correctly with our shared pool.

4. **Robyn lifecycle hooks**: `@app.startup_handler` calls `initialize_database()` and `@app.shutdown_handler` calls `shutdown_database()`. Both support async handlers natively.

5. **sslmode auto-append**: For localhost/127.0.0.1 URLs without `sslmode`, we auto-append `?sslmode=disable` to avoid TLS negotiation failures with local Supabase.

6. **RLS at startup, not migration**: LangGraph's `setup()` creates tables in the `public` schema without RLS, which Supabase exposes via PostgREST. We run `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` on all 6 LangGraph tables immediately after `setup()`, with no permissive policies. This means PostgREST (anon/authenticated roles) cannot access the tables, while our `psycopg` connection (postgres superuser) bypasses RLS entirely. The ALTER is idempotent — safe to run on every startup. No Supabase migration file needed.

### Files Changed

| File | Action | Description |
|------|--------|-------------|
| `robyn_server/database.py` | **CREATED** | ~320 lines — pool lifecycle, fast-fail probe, checkpointer/store init, RLS hardening, accessors |
| `robyn_server/config.py` | MODIFIED | Added `DatabaseConfig` dataclass with `url`, `pool_min_size`, `pool_max_size`, `pool_timeout`; wired into `Config` |
| `robyn_server/app.py` | MODIFIED | Added `on_startup`/`on_shutdown` handlers; updated `/health` with persistence status; updated `/info` with postgres capabilities |
| `tools_agent/agent.py` | MODIFIED | Imported `get_checkpointer`, `get_store`, `is_postgres_enabled` from `robyn_server.database`; passed checkpointer + store to `create_agent()` |

### Verified Against Live Supabase Postgres

- Connection URL: `postgresql://postgres:postgres@127.0.0.1:54322/postgres`
- 6 LangGraph tables confirmed: `checkpoints`, `checkpoint_blobs`, `checkpoint_writes`, `checkpoint_migrations`, `store`, `store_migrations`
- Init time: ~0.40s (pool creation + setup)
- Bad-URL fail time: ~0.07s (fast-fail probe)
- No-URL fallback: instant, clean log message
- All 440 existing tests pass, ruff clean

### Live E2E Persistence Test Results

1. **Message 1** (thread `c6883f368cb048ecb7f95d55d065f73d`): "Hi! My name is Alice and I love playing chess." → Agent responded with greeting, acknowledged chess interest
2. **Message 2** (same thread): "What is my name and what do I love doing?" → **"You are Alice, and you love playing chess! 😊"** ✅
3. **Message 3** (different thread `1f87b72de8604c6cbbb6bc4491f2eb38`): "What is my name?" → **"I don't have information about your personal details."** ✅ (thread isolation)
4. **Post-RLS test** (same thread as msg 1): "What did I tell you my name was?" → **"You said your name is Alice. 😄"** ✅ (RLS doesn't affect superuser)
5. **Checkpoint verification**: 6 checkpoints in Postgres for the test thread (step -1 through step 4)
6. Supabase security advisors: No "unrestricted" warnings — all LangGraph tables show "RLS enabled"

### Notes (Still Relevant)

- The `.setup()` calls are idempotent — they use `CREATE TABLE IF NOT EXISTS` internally. Safe to call on every startup.
- For production (AKS deployment), `DATABASE_URL` will point to the production Supabase Postgres instance with proper credentials. The connection string format is the same.
- The shared pool is also available via `get_pool()` for Task-03 (Robyn runtime storage tables in `langgraph_server` schema).
- Task-02 (LangGraph Checkpointer + Store Integration) was effectively completed as part of Task-01 — the `agent.py` wiring and live E2E verification cover all of Task-02's core acceptance criteria. Task-02 scratchpad should be updated to reflect this.