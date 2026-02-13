# Goal 20: Rename `robyn_server` Module → `server`

> **Status:** ⚪ Not Started
> **Priority:** Medium
> **Created:** 2026-02-12
> **Depends on:** Goal 19 (Package Structure Refactor) ✅

---

## Objective

Rename the `robyn_server` Python module to `server` (or `runtime`) to decouple the module naming from the underlying HTTP framework (Robyn). The current naming leaks an implementation detail — users and developers shouldn't need to know or care that the server uses Robyn internally.

Also rename all `robyn_*` Prometheus metric names to `agent_runtime_*` for consistency.

---

## Motivation

- `robyn_server` is an implementation detail, not a product name
- If the framework is ever swapped (e.g., to FastAPI, Starlette), the module name shouldn't need to change
- Prometheus metrics like `robyn_uptime_seconds` expose framework internals to monitoring dashboards
- The package is `fractal-agents-runtime` — the module should reflect that identity

---

## Scope Assessment

| What | Count | Rename to |
|------|-------|-----------|
| `apps/python/src/robyn_server/` directory | 1 dir | `apps/python/src/server/` |
| `from robyn_server.*` / `import robyn_server.*` | ~241 refs across 40 files | `from server.*` / `import server.*` |
| `robyn_*` Prometheus metric names | ~15 metric names in `routes/metrics.py` | `agent_runtime_*` |
| `from robyn import ...` (framework imports) | ~10 refs | **NO CHANGE** — this is the actual library |
| Robyn mentions in docstrings/comments | scattered | Update to generic "server" language |
| `pyproject.toml` package discovery | `include = ["robyn_server*"]` | `include = ["server*"]` |
| Dockerfile `COPY` paths | `src/robyn_server/` | `src/server/` |
| `.dockerignore` test exclusion | `apps/python/src/robyn_server/tests/` | `apps/python/src/server/tests/` |
| `pytest.ini_options` testpaths | `src/robyn_server/tests` | `src/server/tests` |
| `__main__.py` module name | `python -m robyn_server` | `python -m server` |
| `CMD` in Dockerfile | `python -m robyn_server` | `python -m server` |
| Logger names (`__name__` based) | auto-changes with rename | n/a |

### What does NOT change

- `from robyn import Robyn, Request, Response` — framework imports stay
- `react_agent/` and `fractal_agent_infra/` — untouched
- All business logic — this is purely a mechanical rename
- External API endpoints (`/health`, `/threads`, `/runs`, etc.)

---

## Task Breakdown

### Task-01: Rename directory and update all imports

1. `git mv apps/python/src/robyn_server apps/python/src/server`
2. Find-replace all `robyn_server` → `server` in Python imports across all `.py` files
3. Update `pyproject.toml`:
   - `[tool.setuptools.packages.find]` include: `robyn_server*` → `server*`
   - `[tool.setuptools.packages.find]` exclude: `robyn_server.tests*` → `server.tests*`
   - `[tool.pytest.ini_options]` testpaths: `src/robyn_server/tests` → `src/server/tests`
4. Update `__main__.py` module docstring
5. Update `fractal_agent_infra/tracing.py` docstring (references `robyn_server.app`)

### Task-02: Rename Prometheus metrics

In `src/server/routes/metrics.py`:
- `robyn_uptime_seconds` → `agent_runtime_uptime_seconds`
- `robyn_requests_total` → `agent_runtime_requests_total`
- `robyn_errors_total` → `agent_runtime_errors_total`
- `robyn_active_streams` → `agent_runtime_active_streams`
- `robyn_agent_invocations_total` → `agent_runtime_agent_invocations_total`
- `robyn_agent_errors_total` → `agent_runtime_agent_errors_total`

Update corresponding test assertions if any.

### Task-03: Update Dockerfile and CI references

- `.devops/docker/python.Dockerfile`: `COPY apps/python/src/robyn_server/` → `COPY apps/python/src/server/`
- `.devops/docker/python.Dockerfile`: `CMD ["python", "-m", "robyn_server"]` → `CMD ["python", "-m", "server"]`
- `.dockerignore`: `apps/python/src/robyn_server/tests/` → `apps/python/src/server/tests/`

### Task-04: Update comments and docstrings

- Replace "Robyn server" / "Robyn startup" / "Robyn runtime" with "server" / "startup" / "runtime" in log messages and docstrings
- Keep references to Robyn where they genuinely describe the framework (e.g., "Robyn's Rust/Python boundary")

### Task-05: Verify

- `ruff check . --fix --unsafe-fixes && ruff format .`
- `uv run pytest -x -v` — all 556+ tests must pass
- `docker build -f ../../.devops/docker/python.Dockerfile ../.. -t agent-runtime:local`
- Verify `docker run --rm agent-runtime:local python -c "from server.app import app; print('ok')"`
- Verify `/metrics` endpoint returns `agent_runtime_*` metric names

---

## Risks & Considerations

- **Mechanical but large diff** — ~241 import references across 40 files. Use `sed`/`find-replace`, not manual edits.
- **`server` is a generic name** — Could conflict with other packages. However, since it lives under `apps/python/src/` and is only imported internally, this is safe. An alternative is `agent_server` if `server` feels too generic.
- **Prometheus metric rename is a breaking change** for any existing dashboards/alerts. Since we're pre-v0.1.0, this is acceptable.
- **No logic changes** — This is purely cosmetic. If any test fails, it's an import path issue, not a logic bug.

---

## Acceptance Criteria

- [ ] No file or import references `robyn_server` anywhere in the codebase
- [ ] All Prometheus metrics use `agent_runtime_*` prefix
- [ ] All tests pass (556+)
- [ ] Docker image builds and runs correctly
- [ ] `from robyn import ...` framework imports are untouched
- [ ] Single commit, clean diff (git detects as rename)
```

Now let me update the goals index: