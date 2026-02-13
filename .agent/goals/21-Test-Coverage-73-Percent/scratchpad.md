# Goal 21: Raise Test Coverage to 73%

> **Status:** 🟡 In Progress (48% → 66%, route handler tests WIP)
> **Priority:** High (hard rule in `.rules`)
> **Created:** 2026-02-13
> **Last Updated:** 2026-02-13 (Session 9)
> **Depends on:** Goal 20 (Module Rename) ✅
> **Blocks:** Goal 02 (Python v0.0.1 Release)
> **Branch:** `chore/add-coverage-tooling-goal-21` (combined with Goal 18)

---

## Objective

Raise combined test coverage from **47%** to **≥73%** across `server`, `graphs`, and `infra` packages. This is a hard rule in `.rules` — no release should ship below this threshold.

---

## Current State (2026-02-13, Session 9)

- **Overall:** 66% (4624 statements, 1575 uncovered) — up from 48%
- **777 tests pass**, 35 skipped (34 Postgres integration, 1 LLM)
- 68 WIP failures in `test_route_handlers.py` (auth patching issue — see Remaining Work)
- `pytest-cov` added to dev deps, coverage config in `pyproject.toml`
- `--cov` flag with `fail_under = 73` configured
- Commit `6c6b41b` on `chore/add-coverage-tooling-goal-21`

### Coverage by Module — Session 9 Snapshot

| Module | Stmts | Miss | Cover | Status |
|--------|-------|------|-------|--------|
| `server/postgres_storage.py` | 514 | 2 | **99%** | 🟢 Done (was 0%) |
| `server/agent_sync.py` | 301 | 2 | **99%** | 🟢 Done (was 21%) |
| `server/storage.py` | 339 | 58 | **83%** | 🟢 OK |
| `server/routes/runs.py` | 201 | 178 | 11% | 🔴 WIP — route handler tests written but auth patch failing |
| `server/routes/threads.py` | 191 | 164 | 14% | 🔴 WIP — same issue |
| `server/routes/assistants.py` | 170 | 144 | 15% | 🔴 WIP — same issue (assistant tests DO pass already) |
| `server/routes/streams.py` | 314 | 184 | 41% | 🟡 Not yet tested |
| `server/routes/metrics.py` | 133 | 106 | 20% | 🔴 WIP — metrics GET passes, JSON fails |
| `server/routes/store.py` | 104 | 86 | 17% | 🔴 WIP — auth patch failing |
| `server/routes/a2a.py` | 67 | 53 | 21% | 🔴 Not yet tested |
| `server/routes/mcp.py` | 47 | 33 | 30% | 🔴 Not yet tested |
| `server/routes/crons.py` | 91 | 30 | 67% | 🟡 Close |
| `graphs/react_agent/utils/token.py` | 113 | 98 | 13% | 🔴 WIP tests written |
| `graphs/react_agent/utils/tools.py` | 42 | 37 | 12% | 🔴 WIP tests written |
| `graphs/react_agent/utils/mcp_interceptors.py` | 37 | 28 | 24% | 🔴 WIP tests written |
| `graphs/react_agent/agent.py` | 149 | 72 | 52% | 🟡 Not yet tested |
| `infra/security/auth.py` | 68 | 68 | **0%** | 🔴 WIP — import test failing |
| `infra/store_namespace.py` | 42 | 20 | 52% | 🟡 WIP tests written |
| `server/app.py` | 99 | 52 | 47% | 🟡 WIP — endpoint tests failing |
| `server/database.py` | 101 | 39 | 61% | 🟡 WIP tests written |
| `server/crons/scheduler.py` | 116 | 42 | 64% | 🟡 WIP tests written |
| `server/a2a/handlers.py` | 195 | 67 | 66% | 🟡 Close |

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
| `server/storage.py` | 83% |
| `server/auth.py` | 82% |
| `infra/tracing.py` | 85% |
| `server/agent.py` | 79% |

---

## Math: What Gets Us to 73%

Total statements: **4624**. Need ≥ 3376 covered (currently ~3049 = 66%).

**Need ~327 more covered statements.** The route handler tests (`test_route_handlers.py`) already exist but have 68 failures due to auth patching. Fixing those should cover ~400+ statements from routes alone.

### Completed (Session 9)

| Target | Before | After | Statements gained |
|--------|--------|-------|-------------------|
| `postgres_storage.py` (0% → 99%) | 0 | 512 | **+512** |
| `agent_sync.py` (21% → 99%) | 63 | 299 | **+236** |
| `storage.py` (82% → 83%) | 278 | 281 | +3 |
| **Subtotal gained** | | | **~751** |

### Remaining (need ~327 more statements)

| Target | Current | Goal | Statements needed |
|--------|---------|------|-------------------|
| Fix `test_route_handlers.py` auth patching | 68 failures | 0 failures | ~400 (routes) |
| `infra/security/auth.py` (0% → 65%) | 0 | ~44 | ~44 |
| `graphs/react_agent/agent.py` (52% → 70%) | 77 | ~104 | ~27 |
| `server/app.py` (47% → 65%) | 47 | ~64 | ~17 |
| `server/database.py` (61% → 73%) | 62 | ~74 | ~12 |
| **Subtotal** | | | **~500** (well over 327) |

### Open Question: Per-File vs Global Coverage Rule

The user raised a valid concern: the `.rules` hard rule says `≥73% coverage` as a global average. This allows gaming by spiking some files to 99% while others stay at 0%. **Recommendation for next session:**

1. Change coverage strategy from global `fail_under=73` to **per-file minimum** (e.g. 50-60% per file, no file at 0%)
2. Options:
   a. Custom CI script that parses `pytest --cov-report=json` and checks per-file minimums
   b. Use `[tool.coverage.report]` `exclude_lines` + a wrapper script
   c. Lower global `fail_under` to 65% but add per-file enforcement
3. The goal should be "no file below X%" rather than "average above Y%"

---

## Task Breakdown

### Task-01: Route Handler Tests (~380 statements) — 🟡 IN PROGRESS

Test `routes/assistants.py`, `routes/threads.py`, `routes/runs.py`, `routes/store.py` with mocked storage and auth.

**Done:**
- `conftest_routes.py` — `RouteCapture` harness that captures Robyn route handler closures + `MockRequest`
- `test_route_handlers.py` — 90+ tests written covering CRUD for assistants, threads, runs, store, metrics
- Assistant route tests (create, get, patch, delete, search, count) all **PASS** ✅

**Remaining issue:** `_MultiPatch` context manager patches `require_user` in all route module namespaces. This works for assistants but 68 tests still fail for threads/runs/store/metrics. Root cause: either the patch target strings don't match the actual import paths at runtime, or the closures capture `require_user` at registration time. **Debug in next session:**
- Try patching `server.auth.require_user` AND all `server.routes.*.require_user` simultaneously
- Or restructure route handlers to call `server.auth.require_user()` through the module (not imported name)
- Or use `@pytest.fixture` with `monkeypatch` instead of `unittest.mock.patch`

### Task-02: `postgres_storage.py` Tests (~360 statements) — 🟢 COMPLETE

- `test_postgres_storage_unit.py` — 135 tests, all pass
- Coverage: 0% → 99% (514 stmts, 2 miss)
- Mock infrastructure: `MockCursor`, `MockConnection`, `_make_factory()`
- Covers all 5 stores: assistants, threads, runs, store-items, crons
- Covers `_build_model`, `_row_to_model`, JSON string deserialization branches

### Task-03: `agent_sync.py` Tests (~120 statements) — 🟢 COMPLETE

- `test_agent_sync_unit.py` — 112 tests, all pass
- Coverage: 21% → 99% (301 stmts, 2 miss)
- `FakeStorage`/`FakeAssistants` mock matching `AssistantStorageProtocol`
- Covers: models, scope parsing, row parsing, grouping, SQL builder, configurable builder, sync_single_agent, startup_agent_sync, lazy_sync_agent, write-back

### Task-04: Supporting Module Tests (~200 statements) — 🟡 PARTIALLY DONE

WIP tests exist in `test_route_handlers.py` for these modules but many fail due to import/config issues:
- `infra/security/auth.py` — import test fails (likely needs Supabase env config mocking)
- `graphs/react_agent/utils/token.py` — `TokenExchangeConfig` and mock HTTP tests written
- `graphs/react_agent/utils/tools.py` — `get_tools` test written
- `graphs/react_agent/utils/mcp_interceptors.py` — interceptor creation test written
- `server/database.py` — lifecycle tests written
- `server/app.py` — endpoint tests written but fail (app import side effects)
- `infra/store_namespace.py` — namespace builder tests written
- `server/crons/scheduler.py` — scheduler tests written

### Task-05: Verify & Gate — ⚪ NOT STARTED

- Run `pytest --cov` and confirm ≥73%
- Ensure `fail_under = 73` passes in CI
- No test should depend on external services (Postgres, LLM, Supabase)
- **NEW:** Decide per-file vs global coverage enforcement strategy

---

## Constraints

- **Mock everything external** — no real DB, LLM, or HTTP calls in unit tests
- **Test behavior, not implementation** — tests should survive refactoring
- **One thing per test** — focused assertions
- **Don't test Pydantic/LangGraph internals** — test our code, not theirs
- **The 34 skipped Postgres integration tests are fine** — they run when Postgres is available

---

## Acceptance Criteria

- [ ] `pytest --cov` reports ≥73% combined coverage (currently 66%)
- [x] `fail_under = 73` in `pyproject.toml` (already configured)
- [x] No new tests require external services
- [x] All existing tests still pass (777 passed, 35 skipped, excluding WIP route tests)
- [x] Lint clean (`ruff check . && ruff format .`)
- [ ] Fix 68 WIP test failures in `test_route_handlers.py`
- [ ] Decide: per-file minimum coverage vs global average

## Session 10 Handoff

```
Goal 18 + 21: Fix Route Handler Tests, Reach 73% Coverage

Context:
- Branch: chore/add-coverage-tooling-goal-21 (commit 6c6b41b)
- Goal 18 bugs FIXED: deterministic assistant IDs + system owner visibility
- Coverage: 48% → 66%. Need 73% (327 more statements).
- See .agent/goals/21-Test-Coverage-73-Percent/scratchpad.md
- See .agent/goals/18-Assistant-Config-Propagation-Fix/scratchpad.md

What Was Done (Session 9):
- Bug 1 fixed: storage.py + postgres_storage.py create() honours assistant_id
- Bug 2 fixed: SYSTEM_OWNER_ID, get()/list() include system-owned assistants
- test_goal18_bugs.py: 7 proof tests, all pass
- test_postgres_storage_unit.py: 135 tests (0% → 99%)
- test_agent_sync_unit.py: 112 tests (21% → 99%)
- conftest_routes.py: RouteCapture harness for testing Robyn closures
- test_route_handlers.py: 90+ tests, 22 pass (assistants), 68 fail

What To Do:
1. Fix test_route_handlers.py auth patching (68 failures)
   - _MultiPatch patches require_user in route module namespaces
   - Works for assistants but not threads/runs/store/metrics
   - Debug: check if closures capture require_user at import time
   - Alternative: use monkeypatch fixture or patch server.auth directly
2. Fix remaining WIP tests (infra/security/auth, app.py endpoints, etc.)
3. Decide per-file vs global coverage enforcement strategy
   - User wants "all files around 73%" not "99% on some, 0% on others"
   - Options: custom CI script parsing --cov-report=json, or lower global
4. When coverage ≥73% and all tests pass: push, create PR to development
5. Goal 18 Task-03: deploy verification deferred until webapp integration
```