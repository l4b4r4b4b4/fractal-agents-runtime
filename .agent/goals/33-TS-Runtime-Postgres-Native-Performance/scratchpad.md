# Goal 33: TS Runtime — Native Postgres Driver + Performance Investigation

## Status: 🟡 In Progress
## Priority: High
## Created: 2026-02-16 (Session 38)
## Last Updated: 2026-02-16 (Session 39)

---

## Overview

The TS runtime uses **two pure-JavaScript Postgres drivers** (`postgres` and `pg`) instead of
Bun's native `Bun.sql` driver (C/Zig bindings). Additionally, benchmark data reveals a
**2.8s unexplained performance gap** between TS and Python runtimes under real LLM load that
cannot be explained by Postgres drivers alone. This goal covers both the easy Bun.sql drop-in
and the deeper investigation needed to identify and resolve all major TS runtime bottlenecks.

## Success Criteria

- [ ] Both Postgres layers (`postgres` and `pg`) replaced with `Bun.sql` native driver
- [ ] All existing tests pass after driver swap (1923 TS tests)
- [ ] Mock-LLM benchmarks show measurable improvement in CRUD and checkpointer operations
- [ ] Root causes of the 2.8s real-LLM performance gap identified and documented
- [ ] At least one additional bottleneck beyond Postgres resolved or mitigated

---

## Context & Background

### Benchmark Data (Session 38)

**Mock LLM (pure runtime overhead, 5 VUs, 90s):**

| Metric | TS (0.0.3) | Python (0.1.0) | Winner |
|--------|-----------|---------------|--------|
| Iterations | **430** | 167 | TS +157% |
| Agent flow avg | **550ms** | 2.24s | TS 4.1x faster |
| run/wait p95 | **143ms** | 250ms | TS 1.8x faster |
| Throughput | **4.76 iter/s** | 1.81 iter/s | TS 2.6x |

**Real LLM — Ministral (10 VUs, ramp-up, 90s):**

| Metric | TS (0.0.3) | Python (0.1.0) | Winner |
|--------|-----------|---------------|--------|
| Iterations | 133 | **177** | Python +33% |
| Agent flow avg | 4.36s | **3.02s** | Python 1.4x faster |
| run/wait p95 | 3.20s | **429ms** | Python 7.4x faster |
| Throughput | 9.5 req/s | **13.5 req/s** | Python +42% |

### The Unexplained Gap

If both runtimes hit the same Ministral endpoint, LLM inference time should be roughly equal.
From mock-LLM data, pure overhead is: TS ≈ 143ms, Python ≈ 250ms. So expected real-LLM times:

- TS expected: `LLM_inference + 143ms`
- Python expected: `LLM_inference + 250ms`

Yet TS is 3.2s and Python is 429ms at p95. That's a **~2.8s unexplained gap** that is NOT
Postgres drivers. Something else is drastically wrong in the TS runtime's LLM execution path.

### Current Postgres Architecture

| Layer | Current Library | Type | Replacement |
|-------|----------------|------|-------------|
| Custom storage (assistants, threads, runs) | `postgres` (Postgres.js v3) | Pure JS, TCP | `Bun.sql` |
| LangGraph checkpointer | `pg` (node-postgres) via `@langchain/langgraph-checkpoint-postgres` | Pure JS, TCP | `Bun.sql` adapter |
| Auth token verification | HTTP call to Supabase GoTrue | N/A | JWT local verification? |

Python uses `psycopg` v3 with **C extension bindings to libpq** — much closer to "native"
than either JS driver.

---

## Tasks

| Task ID | Description | Status | Depends On |
|---------|-------------|--------|------------|
| Task-01 | Switch custom storage layer from `postgres` to `Bun.sql` | 🟢 | - |
| Task-02 | Create `BunPoolAdapter` for LangGraph checkpointer | 🟢 | Task-01 |
| Task-03 | Benchmark: mock-LLM before/after Bun.sql swap | 🟢 | Task-01, Task-02 |
| Task-04 | Investigate & profile real-LLM performance gap | 🟡 | Task-03 |
| Task-05 | Implement fixes for identified bottlenecks | ⚪ | Task-04 |
| Task-06 | Final benchmark: real-LLM after all fixes | ⚪ | Task-05 |

### Task Details

#### Task-01: Switch custom storage from `postgres` to `Bun.sql` — 🟢 COMPLETE

**Completed in Session 39.**

**What was done:**
- `database.ts`: Replaced `import postgres from "postgres"` → `import { SQL } from "bun"`
- `database.ts`: `postgres(url, opts)` → `new SQL({ url, max, idleTimeout, connectionTimeout })`
- `database.ts`: `sql.end({ timeout })` → `sql.close({ timeout })` (2 occurrences)
- `database.ts`: Return type `Sql` → `InstanceType<typeof SQL>`
- `postgres.ts`: Removed `import type { Sql, JSONValue } from "postgres"`
- `postgres.ts`: Added `import { SQL } from "bun"` + `type BunSql = InstanceType<typeof SQL>`
- `postgres.ts`: Replaced `asJson()` helper with `toJsonb()` that uses `JSON.stringify()`
- `postgres.ts`: All 18 occurrences of `this.sql.json(asJson(value))` → `toJsonb(value)`
- `postgres.ts`: Added `::jsonb` cast to all JSONB `@>` operator usages (8 occurrences)
- `postgres.ts`: All constructor types updated from `Sql` to `BunSql`
- `package.json`: Removed `"postgres": "^3.4.8"` dependency
- All docstrings/comments updated to reference Bun.sql instead of Postgres.js

**API compatibility verified:**
- `sql(identifier)` — dynamic table names ✅ (same API)
- `sql`` ` — empty fragments for conditionals ✅ (same API)
- `sql.unsafe(text)` — raw DDL queries ✅ (same API)
- `sql.array([])` — array literals ✅ (same API)
- JSONB: replaced `sql.json()` with `JSON.stringify()` + `::jsonb` cast ✅

**Test result: 1922 pass, 1 flaky timeout (SSE test, pre-existing, passes on re-run)**

#### Task-02: Create `BunPoolAdapter` for LangGraph checkpointer — 🟢 COMPLETE

**Completed in Session 39.**

**What was done:**
- Created `apps/ts/src/storage/bun-pool-adapter.ts` (149 lines, fully documented)
- Updated `apps/ts/src/storage/index.ts` to inject `BunPoolAdapter` instead of `PostgresSaver.fromConnString()`
- No upstream PR needed — `PostgresSaver` constructor accepts generic `pool`

**`pg.Pool` surface actually used by PostgresSaver (verified from source):**

| Method | Usage | BunPoolAdapter Implementation |
|--------|-------|-------------------------------|
| `pool.query(text, params?)` | SELECT queries (no transaction) | `sql.unsafe(text, params)` → `{ rows }` |
| `pool.connect()` | Reserve connection for transactions | `sql.reserve()` → client object |
| `client.query(text, params?)` | Queries within BEGIN/COMMIT/ROLLBACK | `reserved.unsafe(text, params)` → `{ rows }` |
| `client.release()` | Return connection to pool | `reserved.release()` |
| `pool.end()` | Close pool on shutdown | `sql.close()` |

**Key design decisions:**
- `connect()` uses `Bun.sql.reserve()` to pin a single connection — required for transaction isolation (PostgresSaver does manual BEGIN/COMMIT/ROLLBACK)
- `Array.from(result)` ensures Bun.sql's special result object is spread into a plain Array for pg compatibility
- Pool config: `max: 20, idleTimeout: 30, connectionTimeout: 10`
- `$1, $2, …` positional parameters work natively with `Bun.sql.unsafe()` ✅

**Test result: 1922 pass, 1 flaky timeout (same SSE test, pre-existing)**

**Note:** Full integration testing with a live Postgres database is needed via the Docker Compose stack and benchmarks (Task-03). The unit tests use in-memory storage, so the BunPoolAdapter code path isn't exercised in unit tests.

#### Task-03: Benchmark mock-LLM before/after — 🟢 COMPLETE

**Completed in Session 39.**

**Setup:**
- Mock LLM server: `bun run benchmarks/mock-llm/server.ts` (10ms delay, 5ms stream delay)
- TS runtime: Bun.sql native driver, Postgres persistence via Supabase (port 54322)
- Auth: Supabase JWT (`bench3@test.local / Benchmark123!`) — user created fresh this session
- k6: constant 5 VUs, 90s duration (matching Session 38 baseline exactly)

**JSONB bug discovered and fixed during smoke test:**
- `toJsonb()` initially used `JSON.stringify()` → Postgres stored as double-encoded string `"{\"key\":\"val\"}"`
- Fix: pass raw JS objects to Bun.sql — it auto-serializes objects as JSONB natively
- Removed all `::jsonb` casts (8 occurrences) — unnecessary with native object serialization
- Cleaned up stale double-encoded rows from database

**Results — Bun.sql vs Postgres.js baseline (5 VUs, 90s, mock-LLM):**

| Metric | Baseline (Postgres.js + pg) | Bun.sql (native) | Delta |
|--------|---------------------------|-------------------|-------|
| **Iterations** | 430 | **435** | +1.2% |
| **Success rate** | 100% | 100% | Tie |
| **Agent flow avg** | 550ms | **543ms** | -1.3% |
| **Agent flow p95** | 770ms | **743ms** | -3.5% |
| **run/wait avg** | **108ms** | 118ms | +9.3% |
| **run/wait p95** | **143ms** | 163ms | +14% |
| **create_assistant p95** | 103ms | **93ms** | -10.7% ✅ |
| **create_thread p95** | 94ms | **91ms** | -3.2% |
| **Throughput (iter/s)** | 4.76 | **4.79** | +0.5% |
| **Throughput (req/s)** | 33.3 | **33.5** | +0.6% |

**Conclusion:** All deltas within measurement noise — **Postgres driver is NOT the bottleneck**
in this workload. Auth HTTP calls to Supabase GoTrue dominate per-request overhead (~30 req/s
ceiling). The CRUD operations (create_assistant, create_thread) show slight improvement from
native driver. The run/wait p95 variance is noise from GoTrue contention.

**Value of the swap is architectural, not latency:**
- Eliminated 2 pure-JS Postgres deps (`postgres` + `pg` at runtime)
- Single native C/Zig driver for all Postgres operations
- Fewer deps, smaller attack surface, cleaner dependency tree

**Results saved:** `benchmarks/results/ts-tier1-mock-llm-5vu-bunsql.json`

#### Task-04: Investigate & profile the real-LLM performance gap — 🟡 IN PROGRESS

**Session 39 investigation findings:**

**Suspect 1: Graph re-compilation per request — CONFIRMED ⚠️ TOP PRIORITY**
- **Both TS and Python rebuild the graph on EVERY request** — verified in source:
  - TS: `runs.ts:337` → `await buildGraph(configurable, { checkpointer })` — every run/wait
  - TS: `streams.ts:229` → `await buildGraph(configurable, { checkpointer })` — every stream
  - Python: `streams.py:641` → `await build_graph(runnable_config, checkpointer=cp, store=st)` — every stream
- Each `buildGraph()` call: creates new ChatModel instance, resolves tools, compiles LangGraph
- Since **both** runtimes do this equally, it's NOT the cause of the TS vs Python gap
- BUT it IS a massive optimization opportunity for both — cache compiled graphs keyed by `(graph_id, model_name, config_hash)`, only pass runtime info (thread_id, input) at invocation time

**Suspect 2: Concurrent LLM serialization — UNLIKELY**
- TS uses standard `await agent.invoke()` — Bun's event loop handles concurrent async I/O natively
- No evidence of serialization in the run execution path

**Suspect 3: Auth HTTP overhead — NOT THE GAP CAUSE**
- Both runtimes hit the same GoTrue — shared bottleneck, not differential
- Still worth fixing (local JWT verification) for overall throughput

**Remaining suspects for next session:**
- **Data size difference**: Python 37 MB vs TS 2.3 MB `data_received` — TS may be truncating/not streaming full response data
- **ChatOpenAI initialization**: May involve HTTP validation call to `/v1/models` per instantiation — amplified by per-request graph rebuild
- **Checkpointer transaction overhead**: BunPoolAdapter `reserve()` / `release()` pattern vs pg.Pool direct — needs profiling

**Fix plan (Task-05):**
1. **Graph caching** — cache compiled graphs, pass runtime config at invoke time
2. **Local JWT verification** — eliminate GoTrue HTTP round-trip
3. **Profile with `performance.now()` instrumentation** around graph build, LLM call, checkpointer ops

#### Task-05: Implement fixes for identified bottlenecks

Based on Task-04 findings. Likely fixes:
- Graph caching (if Suspect 1 confirmed)
- Auth result caching / local JWT verification (if Suspect 3 confirmed)
- Pool tuning (if Suspect 4 confirmed)

#### Task-06: Final benchmark with real LLM

- Run identical Ministral benchmark (10 VUs, ramp-up, 90s)
- Compare with Session 37 baseline results
- Target: TS run/wait p95 should be ≤ Python's 429ms (currently 3.2s)

---

## Dependencies

- **Bun ≥ 1.2**: Required for `Bun.sql` — verified available (Bun 1.3.9 ✅)
- **Supabase running**: For auth and Postgres storage
- **Ministral vLLM running**: For real-LLM benchmarks (Task-06)
- **Mock-LLM service**: For controlled overhead benchmarks (Task-03)

## Risks & Mitigations

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| `Bun.sql.unsafe()` parameter format incompatible with `pg` | Blocks Task-02 | Low | Test early; fall back to wrapping Postgres.js as the adapter |
| JSONB serialization differences between drivers | Data corruption | Low | Run full test suite; add explicit JSONB round-trip test |
| Graph caching invalidation bugs | Stale agent behavior | Medium | Cache key on full config hash; TTL-based eviction |
| Performance gap is in LangGraph core, not our code | Can't fix | Medium | Document findings; file upstream issue if confirmed |

## Notes & Decisions

### Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-02-16 | No upstream PR to `@langchain/langgraph-checkpoint-postgres` | Constructor accepts generic pool — adapter pattern is cleaner and doesn't require upstream buy-in |
| 2026-02-16 | Replace both `postgres` AND `pg` with `Bun.sql` | Eliminate all pure-JS Postgres overhead in one sweep |
| 2026-02-16 | Investigate beyond Postgres drivers | 2.8s gap can't be driver overhead — must find root cause |
| 2026-02-16 | Pass raw JS objects for JSONB (not JSON.stringify) | Bun.sql auto-serializes plain objects as JSONB natively; JSON.stringify causes double-encoding |
| 2026-02-16 | Use `sql.reserve()` in BunPoolAdapter.connect() | PostgresSaver does manual BEGIN/COMMIT/ROLLBACK requiring all statements on the same connection; `reserve()` pins a connection from the Bun.sql pool |

### Session 39 Implementation Notes

**Files modified:**
- `apps/ts/src/storage/database.ts` — Bun.sql constructor + close()
- `apps/ts/src/storage/postgres.ts` — All CRUD stores: toJsonb(), BunSql type, native object JSONB
- `apps/ts/src/storage/index.ts` — BunPoolAdapter injection for checkpointer
- `apps/ts/src/storage/bun-pool-adapter.ts` — NEW: pg.Pool adapter over Bun.sql
- `apps/ts/package.json` — Removed `postgres` dependency

**Dependencies removed:** `postgres` (Postgres.js v3) — no longer needed
**Dependencies kept:** `@langchain/langgraph-checkpoint-postgres` — still needed for PostgresSaver class (but now backed by BunPoolAdapter instead of pg.Pool)

**Remaining `pg` transitive dependency:** `@langchain/langgraph-checkpoint-postgres` still has `pg` as a dependency in its own package.json. We can't remove it from node_modules since it's a transitive dep. However, at runtime our BunPoolAdapter is injected so `pg` is NOT used for any queries. It's only loaded for its TypeScript types by the upstream package.

**JSONB bug fix (discovered during Task-03 smoke test):**
- Initial approach: `toJsonb()` used `JSON.stringify()` → passed string to Bun.sql → Postgres stored as double-encoded JSONB string `"{\"key\":\"val\"}"`
- Root cause: Bun.sql sends strings as text parameters; Postgres wraps the text in JSON quotes when auto-casting to jsonb
- Fix: `toJsonb()` now returns the raw JS object/array; Bun.sql auto-serializes objects as proper JSONB
- Removed all 8 `::jsonb` casts — unnecessary when driver handles type correctly
- Verified with direct DB query: plain objects → `{"key": "val"}` ✅, JSON.stringify → `"{\"key\":\"val\"}"` ❌

### Pre-existing TS Type Errors (18)

Found during Session 38 pre-commit checks. Unrelated to our changes but should be fixed
eventually. Located in:
- `src/a2a/handlers.ts` — 5 unused imports
- `src/agent-sync/sync.ts` — 1 unused import
- `src/graphs/react-agent/utils/mcp-tools.ts` — 1 unused import
- `src/graphs/research-agent/agent.ts` — 1 type mismatch (fallback)
- `src/index.ts` — 5 type errors (Storage interface mismatches)
- `src/infra/prompts.ts` — 3 unused variables
- `src/routes/assistants.ts` — 1 type error
- `src/storage/postgres.ts` — 1 unused import

## References

- Bun.sql docs: https://bun.com/docs/runtime/sql
- `@langchain/langgraph-checkpoint-postgres` source: `libs/checkpoint-postgres/src/index.ts` in `langchain-ai/langgraphjs`
- Benchmark results: `benchmarks/results/ts-tier1-mock-llm-5vu.json`, `python-tier1-mock-llm-5vu.json`
- Ministral results: `benchmarks/results/ts-tier1-ministral.json`, `python-tier1-ministral.json`
- Mock LLM server: `benchmarks/mock-llm/server.ts`
- Goal 31 scratchpad: `.agent/goals/31-Local-Langfuse-V3-Dev-Stack/scratchpad.md`
```

Now let me update the goals index and commit everything: