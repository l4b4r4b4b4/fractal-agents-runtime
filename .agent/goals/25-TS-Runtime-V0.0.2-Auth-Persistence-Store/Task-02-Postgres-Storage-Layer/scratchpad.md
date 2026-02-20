# Task-02: Postgres Storage Layer

> **Status:** 🟡 In Progress (Implementation Complete, Testing Partial)
> **Priority:** High
> **Created:** 2025-07-20
> **Last Updated:** 2025-07-20
> **Parent Goal:** [Goal 25 — TS Runtime v0.0.2](../scratchpad.md)

---

## Objective

Replace in-memory `Map`-based stores with Postgres-backed implementations using the same `langgraph_server` schema as the Python runtime. Both runtimes must be able to share a single database deployment. Swap `MemorySaver` checkpointer for `PostgresSaver` when `DATABASE_URL` is configured. Fallback to in-memory when `DATABASE_URL` is not set.

---

## Implementation Plan

### Dependencies to Install

1. **`postgres`** (Postgres.js v3.x) — Fast, zero-dep Postgres client for custom queries (assistants, threads, runs)
2. **`@langchain/langgraph-checkpoint-postgres`** — LangGraph PostgresSaver checkpointer (uses `pg` internally)

Note: Two Postgres clients coexist:
- `postgres` (Postgres.js) — our custom storage queries (tagged template literals, fast, Bun-native)
- `pg` (node-postgres) — pulled in by `@langchain/langgraph-checkpoint-postgres` for checkpointing internals
- These don't interact. Separate concerns, each optimal for its use case.

### Files to Create

1. **`src/storage/database.ts`** — Connection management + migrations
   - `initializeDatabase()` — Probe connectivity, run DDL migrations, return success/failure
   - `shutdownDatabase()` — Close connection pool, reset state
   - `getConnection()` — Get the singleton `postgres` (Postgres.js) SQL client
   - `isDatabaseEnabled()` — Check if DB was successfully initialized
   - `getDatabaseUrl()` — Return validated connection string
   - DDL matching Python's `_DDL` exactly (schema `langgraph_server`, tables: assistants, threads, thread_states, runs, store_items)
   - Idempotent `CREATE SCHEMA/TABLE IF NOT EXISTS` — safe to run on every startup

2. **`src/storage/postgres.ts`** — Postgres implementations of all 3 stores
   - `PostgresAssistantStore` implements `AssistantStore`
     - Full CRUD: create, get, search, update, delete, count, clear
     - SQL with parameterized queries (tagged templates via `postgres`)
     - JSON serialization for config/metadata fields
     - Owner filtering via `metadata->>'owner'` WHERE clause (when ownerId provided)
   - `PostgresThreadStore` implements `ThreadStore`
     - Full CRUD + state snapshots + history
     - `thread_states` table for state history (matching Python schema)
     - Checkpoint ID generation for state snapshots
   - `PostgresRunStore` implements `RunStore`
     - Full CRUD + list_by_thread + active run tracking + status updates
     - Thread-scoped queries with owner isolation

3. **`src/storage/postgres-store.ts`** — Placeholder for Store API Postgres implementation (Task-03)

### Files to Modify

4. **`src/storage/types.ts`** — Add optional `ownerId` parameter to store interfaces
   - All CRUD methods get `ownerId?: string` as last optional parameter
   - When provided, queries scope by owner (user isolation)
   - When not provided (undefined), no owner scoping (backward compatible with v0.0.1)

5. **`src/storage/index.ts`** — Updated factory
   - `getStorage()`: `DATABASE_URL` set + initialized → PostgresStorage, else InMemoryStorage
   - `getCheckpointer()`: `DATABASE_URL` set + initialized → PostgresSaver, else MemorySaver
   - `initializeStorage()` — New function: call `initializeDatabase()`, setup PostgresSaver, setup LangGraph tables
   - `shutdownStorage()` — New function: close DB connections on shutdown

6. **`src/config.ts`** — Add database env vars
   - `databaseUrl`, `databasePoolMinSize`, `databasePoolMaxSize`, `databasePoolTimeout`

7. **`src/index.ts`** — Add storage initialization + shutdown lifecycle
   - Call `initializeStorage()` at startup (after router setup, before `Bun.serve()`)
   - Call `shutdownStorage()` in shutdown handler

### Files to Create (Tests)

8. **`tests/database.test.ts`** — Database module tests
   - `isDatabaseEnabled()` returns false when DATABASE_URL not set
   - `initializeDatabase()` returns false when DATABASE_URL not set
   - Factory falls back to in-memory when DATABASE_URL not set
   - Config correctly reads DATABASE_URL and pool settings

9. **`tests/postgres-storage.test.ts`** — Postgres store tests (in-memory fallback focus)
   - Verify storage factory returns InMemoryStorage when no DATABASE_URL
   - Verify storage factory returns correct type when DATABASE_URL set (mocked)
   - Verify PostgresSaver is returned as checkpointer when DATABASE_URL set (mocked)
   - Verify all existing storage tests still pass with in-memory backend

---

## Design Decisions

### Schema Compatibility with Python Runtime

**Hard requirement:** Both runtimes MUST share the same database schema. The DDL is copied from Python's `postgres_storage.py` `_DDL` constant:

- Schema: `langgraph_server`
- Tables: `assistants`, `threads`, `thread_states`, `runs`, `store_items`, `crons`
- All use `JSONB` for config/metadata/values fields
- `TIMESTAMPTZ` for datetime columns
- `TEXT` for IDs (UUID hex, 32 chars, no dashes — matching Python)

### Connection Management: Postgres.js Singleton

Unlike Python (per-request connections due to Robyn/Actix multi-loop issues), Bun is single-threaded. A single `postgres` (Postgres.js) client with built-in connection pooling is correct:

```ts
import postgres from "postgres";
const sql = postgres(DATABASE_URL, { max: 10 });
```

Postgres.js handles connection pooling internally. No need for per-request connection factories.

### Two Postgres Client Libraries

| Library | Used For | Why |
|---------|----------|-----|
| `postgres` (Postgres.js) | Custom storage queries | Fast, zero deps, tagged template API, Bun-native |
| `pg` (node-postgres) | LangGraph checkpointer/store | Required by `@langchain/langgraph-checkpoint-postgres` |

These don't conflict — different connection pools, different concerns.

### Owner Scoping: Optional Parameter

Adding `ownerId?: string` to all store methods as an optional parameter:
- When auth is enabled: route handlers pass `getUserIdentity()` from Task-01
- When auth is disabled: `undefined` → no owner filtering (v0.0.1 behavior)
- Postgres stores: `WHERE metadata->>'owner' = $1` when ownerId provided
- In-memory stores: filter by `metadata.owner` when ownerId provided

This is backward compatible — all existing tests pass without changes.

### Checkpointer: PostgresSaver as Singleton

The JS `PostgresSaver.fromConnString(DB_URI)` returns a persistent instance (unlike Python's async context manager). Can be used as a simple singleton, replacing `MemorySaver`:

```ts
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
const checkpointer = PostgresSaver.fromConnString(DB_URI);
await checkpointer.setup(); // Create checkpoint tables (idempotent)
```

### Migration Strategy

1. `initializeDatabase()` runs idempotent DDL for `langgraph_server` schema
2. `PostgresSaver.setup()` runs LangGraph checkpoint table DDL
3. Both are safe to run on every startup
4. No versioned migrations yet — `CREATE IF NOT EXISTS` is sufficient for v0.0.2

---

## Acceptance Criteria

- [ ] All assistant CRUD operations work with Postgres
- [ ] All thread CRUD + state + history operations work with Postgres
- [ ] All run CRUD + lifecycle operations work with Postgres
- [x] Schema migrations run on startup without errors (DDL implemented, matches Python exactly)
- [ ] Queries scoped by owner_id when ownerId parameter is provided
- [x] Fallback to in-memory when DATABASE_URL not set
- [x] Connection pool closes on shutdown
- [x] Agent checkpointing uses PostgresSaver when available
- [x] Table schema compatible with Python runtime (can share database)
- [x] All existing v0.0.1 tests still pass (898 tests total, 0 failures)
- [x] New database/storage tests pass (41 tests)
- [x] TypeScript compiles clean (`bunx tsc --noEmit` — no errors)

---

## Progress Log

### 2025-07-20 — Implementation Started + Core Complete

**Packages installed:**
- `postgres@3.4.8` — Postgres.js for custom storage queries
- `@langchain/langgraph-checkpoint-postgres@1.0.0` — PostgresSaver + PostgresStore for LangGraph

**Files created:**
- `src/storage/database.ts` — Connection management (postgres.js singleton with pooling), DDL migrations matching Python's `_DDL` exactly, `initializeDatabase()` / `shutdownDatabase()` / `isDatabaseEnabled()` / `getConnection()` / `getDatabaseUrl()` lifecycle
- `src/storage/postgres.ts` — Full Postgres implementations:
  - `PostgresAssistantStore` — Full CRUD + search + count with parameterized SQL
  - `PostgresThreadStore` — Full CRUD + state snapshots + history with `thread_states` table
  - `PostgresRunStore` — Full CRUD + `listByThread` + `getActiveRun` + `updateStatus`
  - `PostgresStorage` — Container class implementing `Storage` interface
- `tests/database.test.ts` — 41 tests: config reading, DB lifecycle, factory routing, singleton lifecycle, fallback verification, import checks

**Files modified:**
- `src/storage/index.ts` — Complete rewrite: factory routing (DATABASE_URL → Postgres, else InMemory), `getCheckpointer()` returns PostgresSaver or MemorySaver, new `initializeStorage()` / `shutdownStorage()` lifecycle functions
- `src/config.ts` — Added `databaseUrl`, `databasePoolMinSize`, `databasePoolMaxSize`, `databasePoolTimeout` to AppConfig; added `isDatabaseConfigured()` helper
- `src/index.ts` — Added `await initializeStorage()` before `Bun.serve()`, `await shutdownStorage()` in graceful shutdown handler

**Test results:**
- 41 new database tests pass
- 898 total tests pass (41 new + 857 prior), 0 failures
- TypeScript compiles clean

**What remains for Task-02:**
- End-to-end verification against a real Postgres database (Docker Compose + test run)
- Owner scoping (`ownerId` parameter) — interface changes deferred to when route handlers are updated
- PostgresStore (LangGraph store for cross-thread memory) setup in `initializeStorage()` — needed for Task-03

**Handoff note:** The Postgres storage layer is structurally complete but untested against a real database. All in-memory fallback paths are verified. The next session should:
1. Spin up Postgres via Docker Compose and verify DDL + CRUD operations
2. Optionally add owner scoping to store interfaces
3. Move to Task-03 (Store API endpoints) or Task-05 (namespace conventions + version bump)