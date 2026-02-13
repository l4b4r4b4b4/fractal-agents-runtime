# Goal 21: Raise Test Coverage to 73%

> **Status:** ⚪ Not Started
> **Priority:** High (hard rule in `.rules`)
> **Created:** 2026-02-13
> **Depends on:** Goal 20 (Module Rename) ✅
> **Blocks:** Goal 02 (Python v0.0.1 Release)

---

## Objective

Raise combined test coverage from **47%** to **≥73%** across `server`, `graphs`, and `infra` packages. This is a hard rule in `.rules` — no release should ship below this threshold.

---

## Current State (2026-02-13)

- **Overall:** 47.33% (4602 statements, 2424 uncovered)
- **523 tests pass**, 35 skipped (34 Postgres integration, 1 LLM)
- `pytest-cov` added to dev deps, coverage config in `pyproject.toml`
- `--cov` flag with `fail_under = 73` configured

### Coverage by Module (sorted by impact)

| Module | Stmts | Miss | Cover | Gap to close |
|--------|-------|------|-------|-------------|
| `server/postgres_storage.py` | 513 | 513 | **0%** | 🔴 Biggest single file — 513 uncovered lines |
| `server/agent_sync.py` | 301 | 238 | 21% | 🔴 Agent sync logic barely tested |
| `server/routes/runs.py` | 201 | 178 | 11% | 🔴 Run CRUD routes |
| `server/routes/threads.py` | 191 | 164 | 14% | 🔴 Thread CRUD routes |
| `server/routes/assistants.py` | 170 | 144 | 15% | 🔴 Assistant CRUD routes |
| `server/routes/streams.py` | 314 | 184 | 41% | 🟡 SSE streaming — partial |
| `server/routes/metrics.py` | 133 | 106 | 20% | 🔴 Prometheus metrics |
| `server/routes/store.py` | 104 | 86 | 17% | 🔴 Store routes |
| `graphs/react_agent/utils/token.py` | 113 | 98 | 13% | 🔴 Token exchange |
| `graphs/react_agent/utils/tools.py` | 42 | 37 | 12% | 🔴 Tool loading |
| `graphs/react_agent/agent.py` | 149 | 72 | 52% | 🟡 Graph builder |
| `infra/security/auth.py` | 68 | 68 | **0%** | 🔴 Supabase auth |
| `server/app.py` | 98 | 52 | 47% | 🟡 App startup |
| `server/database.py` | 101 | 39 | 61% | 🟡 Database lifecycle |
| `server/crons/scheduler.py` | 116 | 42 | 64% | 🟡 Cron scheduler |
| `server/a2a/handlers.py` | 195 | 67 | 66% | 🟡 A2A handlers |

### Already Well-Covered (≥80%)

| Module | Cover |
|--------|-------|
| `server/config.py` | 98% |
| `server/models.py` | 99% |
| `server/mcp/handlers.py` | 93% |
| `server/mcp/schemas.py` | 100% |
| `server/a2a/schemas.py` | 100% |
| `server/crons/schemas.py` | 96% |
| `server/routes/sse.py` | 100% |
| `server/routes/helpers.py` | 100% |
| `server/openapi_spec.py` | 100% |
| `server/storage.py` | 82% |
| `server/auth.py` | 82% |
| `infra/tracing.py` | 85% |
| `server/agent.py` | 79% |

---

## Math: What Gets Us to 73%

Total statements: **4602**. Need ≥ 3359 covered (currently 2178).

**Need ~1181 more covered statements.** Priority targets by ROI:

| Target | Uncovered | Realistic coverage | Statements gained |
|--------|-----------|-------------------|-------------------|
| `postgres_storage.py` (0% → 70%) | 513 | Mock-heavy unit tests | ~360 |
| `routes/runs.py` (11% → 70%) | 178 | Route handler tests | ~120 |
| `routes/threads.py` (14% → 70%) | 164 | Route handler tests | ~110 |
| `routes/assistants.py` (15% → 70%) | 144 | Route handler tests | ~95 |
| `agent_sync.py` (21% → 60%) | 238 | Mock DB + models | ~120 |
| `routes/metrics.py` (20% → 70%) | 106 | Metric registration tests | ~55 |
| `routes/store.py` (17% → 70%) | 86 | Route handler tests | ~55 |
| `routes/streams.py` (41% → 65%) | 184 | Mock streaming tests | ~75 |
| `infra/security/auth.py` (0% → 70%) | 68 | Mock Supabase client | ~48 |
| `graphs/react_agent/utils/token.py` (13% → 60%) | 98 | Mock HTTP exchange | ~47 |
| **Subtotal** | | | **~1085** |

With these targets plus marginal gains elsewhere, 73% is achievable.

---

## Task Breakdown

### Task-01: Route Handler Tests (~380 statements)

Test `routes/assistants.py`, `routes/threads.py`, `routes/runs.py`, `routes/store.py` with mocked storage and auth.

### Task-02: `postgres_storage.py` Tests (~360 statements)

Unit tests with mocked `AsyncConnection`. Test all CRUD methods for assistants, threads, runs, crons.

### Task-03: `agent_sync.py` Tests (~120 statements)

Mock the DB queries and storage layer. Test sync logic, deduplication, error handling.

### Task-04: Supporting Module Tests (~200 statements)

- `routes/metrics.py` — metric registration and collection
- `infra/security/auth.py` — Supabase JWT verification with mocked client
- `graphs/react_agent/utils/token.py` — token exchange with mocked HTTP
- `routes/streams.py` — additional mock streaming paths

### Task-05: Verify & Gate

- Run `pytest --cov` and confirm ≥73%
- Ensure `fail_under = 73` passes in CI
- No test should depend on external services (Postgres, LLM, Supabase)

---

## Constraints

- **Mock everything external** — no real DB, LLM, or HTTP calls in unit tests
- **Test behavior, not implementation** — tests should survive refactoring
- **One thing per test** — focused assertions
- **Don't test Pydantic/LangGraph internals** — test our code, not theirs
- **The 34 skipped Postgres integration tests are fine** — they run when Postgres is available

---

## Acceptance Criteria

- [ ] `pytest --cov` reports ≥73% combined coverage
- [ ] `fail_under = 73` in `pyproject.toml` (already configured)
- [ ] No new tests require external services
- [ ] All 523+ existing tests still pass
- [ ] Lint clean (`ruff check . && ruff format .`)