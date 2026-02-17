# Goal 33: TS Runtime — Native Postgres Driver + Performance Investigation

## Status: ⚪ Not Started
## Priority: High
## Created: 2026-02-16 (Session 38)
## Last Updated: 2026-02-16

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
| Task-01 | Switch custom storage layer from `postgres` to `Bun.sql` | ⚪ | - |
| Task-02 | Create `BunPoolAdapter` for LangGraph checkpointer | ⚪ | - |
| Task-03 | Benchmark: mock-LLM before/after Bun.sql swap | ⚪ | Task-01, Task-02 |
| Task-04 | Investigate & profile real-LLM performance gap | ⚪ | Task-03 |
| Task-05 | Implement fixes for identified bottlenecks | ⚪ | Task-04 |
| Task-06 | Final benchmark: real-LLM after all fixes | ⚪ | Task-05 |

### Task Details

#### Task-01: Switch custom storage from `postgres` to `Bun.sql`

**Current state:**
- `apps/ts/src/storage/database.ts` — uses `import postgres from "postgres"` (Postgres.js)
- `apps/ts/src/storage/postgres.ts` — all queries use `sql` tagged templates from Postgres.js
- Pool config: `max: 10, idle_timeout: 20, connect_timeout: 10`

**Plan:**
- Replace `import postgres from "postgres"` with `import { SQL } from "bun"`
- `Bun.sql` also uses tagged template syntax (`sql`SELECT ...``) — API is very similar
- Update pool config to use Bun.sql options: `max`, `idleTimeout`, `connectionTimeout`
- The tagged template escaping should be compatible — verify edge cases (JSONB, arrays)
- Run all 1923 tests to confirm

**Key files:**
- `apps/ts/src/storage/database.ts` — connection management, DDL migrations
- `apps/ts/src/storage/postgres.ts` — all CRUD operations (~1200 lines)

**Risks:**
- `sql.unsafe()` for DDL statements — Bun.sql should support this
- JSONB handling — verify `Bun.sql` handles JSON serialization the same way
- Array parameters — verify `IN (...)` queries work identically

#### Task-02: Create `BunPoolAdapter` for LangGraph checkpointer

**Current state:**
- `@langchain/langgraph-checkpoint-postgres` hardcodes `import pg from "pg"`
- `PostgresSaver.fromConnString()` creates `new pg.Pool({ connectionString })`
- BUT the constructor accepts a `pool` parameter — we can inject our own

**Plan — NO upstream PR needed:**

The `PostgresSaver` constructor accepts a generic `pool` object. The entire surface area
it calls is:

```
pool.connect() → client
client.query(sql, params) → { rows }
client.release()
pool.query(sql, params) → { rows }
pool.end()
```

Create a thin adapter that wraps `Bun.sql` to satisfy this interface:

```typescript
import { SQL } from "bun";

class BunPoolAdapter {
  private sql: SQL;

  constructor(connectionString: string, options?: { max?: number }) {
    this.sql = new SQL({
      url: connectionString,
      max: options?.max ?? 20,
    });
  }

  async query(text: string, params?: unknown[]) {
    const rows = await this.sql.unsafe(text, params ?? []);
    return { rows: [...rows], rowCount: rows.length };
  }

  async connect() {
    const self = this;
    return {
      query: (text: string, params?: unknown[]) => self.query(text, params),
      release: () => {}, // Bun.sql pools internally
    };
  }

  async end() {
    await this.sql.close();
  }
}
```

Then in `storage/index.ts`, instead of:
```typescript
const { PostgresSaver } = require("@langchain/langgraph-checkpoint-postgres");
checkpointer = PostgresSaver.fromConnString(dbUrl);
```

Do:
```typescript
const { PostgresSaver } = require("@langchain/langgraph-checkpoint-postgres");
const pool = new BunPoolAdapter(dbUrl);
checkpointer = new PostgresSaver(pool);
```

**Key files:**
- `apps/ts/src/storage/bun-pool-adapter.ts` — NEW file
- `apps/ts/src/storage/index.ts` — change checkpointer initialization
- Remove `pg` from `package.json` dependencies (keep only `@langchain/langgraph-checkpoint-postgres`)

**Risks:**
- `Bun.sql.unsafe()` parameter binding format — verify it uses `$1, $2, ...` positional params like `pg`
- Transaction support — verify `BEGIN`/`COMMIT`/`ROLLBACK` work through `unsafe()`
- Binary data handling — checkpoints store serialized blobs, verify encoding compatibility

#### Task-03: Benchmark mock-LLM before/after

- Run identical 5-VU 90s benchmark with mock-LLM before and after the swap
- Compare: CRUD latencies (create_assistant, create_thread), run/wait, throughput
- Save results as `ts-tier1-mock-llm-bunsql.json`

#### Task-04: Investigate & profile the real-LLM performance gap

This is the critical investigation task. The 2.8s unexplained gap must come from one or
more of these suspects:

**Suspect 1: Graph re-compilation per request** (HIGH probability)
- Check: Is `createAgent()` / `resolveGraphFactory()` called on every run, or are compiled
  graphs cached per `graph_id + model_name`?
- Key files: `apps/ts/src/routes/runs.ts`, `apps/ts/src/graphs/registry.ts`
- Python comparison: Does the Python runtime cache compiled graphs?
- Impact: Graph compilation involves model instantiation, tool binding, and LangGraph
  compilation — could easily add 500ms-2s per request
- Fix: Cache compiled graphs keyed by `(graph_id, model_name, assistant_config_hash)`

**Suspect 2: Concurrent LLM request serialization** (HIGH probability)
- Check: Under 10 VUs, are graph `.invoke()` / `.stream()` calls running truly concurrently,
  or is something serializing them (shared state, pool contention, event loop blocking)?
- Key files: `apps/ts/src/routes/runs.ts` (run execution), `apps/ts/src/routes/streams.ts`
  (stream execution)
- With Ministral `--max-num-seqs 9`, the LLM can handle 9 concurrent requests. If TS is
  serializing, each VU waits for others, causing the 3.2s p95
- Tools: Add timing logs around graph.invoke() entry/exit, measure concurrency

**Suspect 3: Auth verification HTTP overhead** (MEDIUM probability)
- Every authenticated request → `verifyToken(token)` → HTTP call to Supabase GoTrue
  (`GET /auth/v1/user`)
- Under 10 VUs with fast mock-LLM, this saturated GoTrue (815 HTTP 500s)
- With real LLM, requests are slower so GoTrue isn't saturated, but each auth call still
  adds 20-50ms per request
- Fix: Cache JWT verification results with TTL (e.g., 60s), or verify JWTs locally using
  the Supabase JWT secret
- Key file: `apps/ts/src/infra/security/auth.ts`

**Suspect 4: Checkpointer pool contention** (MEDIUM probability)
- `pg.Pool` default max connections is 10. Under 10 VUs, each doing checkpoint reads and
  writes, the pool could be fully saturated
- Each graph invocation does: 1 checkpoint read (getState) + 1 checkpoint write (putState)
  + N blob writes
- Fix: Increase pool size, or use `Bun.sql` with higher `max` (Task-01/02 may help)

**Suspect 5: Streaming response handling** (LOW probability)
- The `run/wait` endpoint internally streams the graph and collects the final result
- Python streams more data (37 MB vs 2.3 MB) suggesting TS might not be streaming at all,
  or buffering differently
- Check how the TS `executeRunStream()` consumes the LangGraph stream

**Suspect 6: Node.js compatibility layer overhead** (LOW probability)
- Bun provides Node.js API compatibility, but some polyfills (like `pg`'s use of `net`,
  `tls`, `crypto`) go through compatibility layers that may be slower
- Switching to `Bun.sql` (Task-01/02) eliminates this entirely for Postgres

**Investigation approach:**
1. Add `performance.now()` timing instrumentation at key points:
   - Graph factory entry/exit (is compilation happening?)
   - LLM call entry/exit (how long does the actual HTTP call take?)
   - Checkpoint read/write entry/exit
   - Auth verification entry/exit
2. Run a single-VU real-LLM test and analyze timing breakdown
3. Run a 10-VU test and compare — look for serialization patterns

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