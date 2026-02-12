# Goal 19: Package Structure Refactor — 3-Layer Architecture

> **Status:** 🟡 In Progress (Phase 2 complete, Task-06 commit/push/PR remaining)
> **Priority:** Critical (blocks v0.0.0 tagging)
> **Branch:** `refactor/package-structure` (off `development`)
> **Created:** 2026-02-11
> **Last Updated:** 2026-02-12 — Session 5 (Phase 2 code complete, docs updated, awaiting commit)
> **Depends on:** Goal 01 (Monorepo v0.0.0 Setup) ✅

---

## Problem Statement

The initial extraction (Phase 1) moved all of `react_agent_with_mcp_tools/` into a single `packages/python/fractal_agent_runtime/` package. This mixed three concerns:

1. **Graph architecture** — the agent graph definition (`agent.py`, MCP utils, token exchange, RAG tool factory)
2. **Runtime infrastructure** — tracing (Langfuse), auth (LangGraph SDK), store namespace conventions
3. **Server application** — Robyn HTTP server, routes, Postgres persistence, config

The user's vision is a **graph architecture catalog** — a collection of portable, independently publishable agent graphs that can be:
- Deployed to LangGraph Platform
- Embedded in any runtime (Robyn, FastAPI, Lambda, etc.)
- Eventually extracted into a separate repo as a git submodule

This requires graphs to have **zero coupling** to any specific runtime.

---

## Architecture: 3-Layer Design

```
┌──────────────────────────────────────────────────────┐
│  apps/<lang>/  (fractal-agents-runtime)              │
│  Thin HTTP wrappers — Robyn (Python), Bun (TS)       │
│  Routes, config, Postgres persistence, wiring        │
│  ┌────────────────┐  ┌────────────────────────┐      │
│  │ depends on     │  │ depends on             │      │
│  │  graphs/*      │  │  infra/                │      │
│  └───────┬────────┘  └───────────┬────────────┘      │
└──────────┼───────────────────────┼───────────────────┘
           │                       │
┌──────────▼─────────┐  ┌─────────▼─────────────────┐
│ packages/<lang>/   │  │ packages/<lang>/          │
│   graphs/          │  │   infra/                  │
│   react_agent/     │  │   tracing, auth,          │
│   plan_execute/    │  │   store_namespace, ...    │
│   supervisor/      │  │                           │
│   ...              │  │ (standalone, no server    │
│                    │  │  coupling)                │
│ (depends on infra  │  │                           │
│  for shared utils) │  │                           │
└────────────────────┘  └───────────────────────────┘
```

### Dependency Rules

- **Graphs → Infra:** Allowed (e.g., store namespace convention)
- **Graphs → Apps:** ❌ NEVER (no `from robyn_server...` imports)
- **Apps → Graphs:** Allowed (runtime picks which graph to serve)
- **Apps → Infra:** Allowed (runtime uses tracing, auth, etc.)
- **Infra → Apps:** ❌ NEVER
- **Infra → Graphs:** ❌ NEVER

### Key Design Decision: Dependency Injection for Graphs

Graphs receive checkpointer/store as parameters — they never import them from the server:

```python
# BEFORE (coupled to robyn_server):
async def graph(config: RunnableConfig):
    ...
    from robyn_server.database import get_checkpointer, get_store  # ❌
    return agent.compile(checkpointer=get_checkpointer(), store=get_store())

# AFTER (portable):
async def graph(config: RunnableConfig, *, checkpointer=None, store=None):
    ...
    return agent.compile(checkpointer=checkpointer, store=store)  # ✅
```

The runtime is responsible for creating the checkpointer/store and passing them in.

---

## Target Directory Structure

```
packages/python/
├── graphs/
│   └── react_agent/                    # PyPI: fractal-graph-react-agent
│       ├── pyproject.toml
│       ├── README.md
│       ├── uv.lock
│       └── src/react_agent/
│           ├── __init__.py             # exports `graph`
│           ├── agent.py                # Graph definition (pure, no server imports)
│           └── utils/
│               ├── __init__.py
│               ├── mcp_interceptors.py # MCP tool call auth error handling
│               ├── token.py            # MCP OAuth token exchange & caching
│               └── tools.py            # RAG tool factory
└── infra/
    └── fractal_agent_infra/            # PyPI: fractal-agent-infra (later)
        ├── pyproject.toml
        ├── README.md
        ├── uv.lock
        └── src/fractal_agent_infra/
            ├── __init__.py
            ├── tracing.py              # Langfuse init, callback handlers
            ├── store_namespace.py      # Canonical namespace convention
            └── security/
                ├── __init__.py
                └── auth.py             # LangGraph SDK auth (for Platform deploy)

apps/python/
└── src/robyn_server/                   # The runtime — unchanged structure
    ├── app.py                          # imports from infra (tracing)
    ├── agent.py                        # imports from graphs (react_agent)
    ├── routes/streams.py               # imports from graphs + infra
    ├── database.py                     # creates checkpointer/store, passes to graph
    └── ...
```

### Package Names

| Package | PyPI Name | Import Name | Purpose |
|---------|-----------|-------------|---------|
| Graph: React Agent | `fractal-graph-react-agent` | `react_agent` | ReAct agent with MCP tools |
| Infra | `fractal-agent-infra` (later) | `fractal_agent_infra` | Shared runtime infrastructure |
| App: Python Runtime | `fractal-agents-runtime` | `robyn_server` | Robyn HTTP server (Docker image) |

---

## Phase 1: Initial Extraction — ✅ COMPLETE

> Done in Session 4 (2026-02-11). All changes on `refactor/package-structure` branch, uncommitted.

### What was done

1. **Created `packages/python/fractal_agent_runtime/`** — skeleton with `pyproject.toml`, `README.md`, `src/` layout
2. **Moved code** from `apps/python/src/react_agent_with_mcp_tools/` into the package
3. **Updated all `robyn_server` imports** — `agent.py`, `app.py`, `routes/streams.py`, `agent_sync.py`, `auth.py`, `tests/test_tracing.py` now import `fractal_agent_runtime`
4. **Updated `apps/python/pyproject.toml`** — added `fractal-agent-runtime` as path dependency via `[tool.uv.sources]`, removed graph deps (now transitive), removed `react_agent_with_mcp_tools*` from setuptools find
5. **Docker best practices** — rewrote `.devops/docker/python.Dockerfile` per [official uv Docker guide](https://docs.astral.sh/uv/guides/integration/docker/):
   - Pin uv 0.10.2 via `COPY --from` distroless pattern
   - Bind-mount `pyproject.toml` + `uv.lock` for dependency layer (no extra COPY)
   - `--no-editable` so `.venv` is self-contained (no source in runtime image)
   - Same `python:3.12-slim-bookworm` base for builder + runtime (better layer sharing)
   - Labels only on runtime stage
6. **Created root `.dockerignore`** — old `apps/python/.dockerignore` was silently ignored with repo-root build context
7. **Updated CI workflows** — `image-python.yml`, `image-ts.yml`, `release.yml` for new Dockerfile paths, 4-tag scheme (`python-graphs-v*`, `python-runtime-v*`, `ts-graphs-v*`, `ts-runtime-v*`)
8. **Cleaned stale references** — 0 `react_agent_with_mcp_tools` refs in code/config/workflows (12 remain only in `.agent/` scratchpads as history)
9. **Fixed ruff config** for graph package — added intentional ignores (BLE001, ERA001, PLC0415, etc.), fixed B904 raise-from, E501 line length, TRY002 bare Exception

### Phase 1 Verification

- `cd apps/python && uv sync` → path dep resolves ✓
- `cd apps/python && uv run pytest` → **550 passed** ✓
- `cd apps/python && uv run ruff check .` → All checks passed ✓
- `cd packages/python/fractal_agent_runtime && uv sync` → installs ✓
- `cd packages/python/fractal_agent_runtime && uv run ruff check .` → All checks passed ✓
- `uv lock --check` → both lockfiles in sync ✓

### Phase 2 Verification (Session 5)

- `cd packages/python/infra/fractal_agent_infra && uv lock` → 85 packages resolved ✓
- `cd packages/python/graphs/react_agent && uv lock` → 113 packages resolved ✓
- `cd apps/python && uv lock` → 138 packages resolved (Added fractal-agent-infra, Added fractal-graph-react-agent, Removed fractal-agent-runtime) ✓
- `cd apps/python && uv sync` → 3 packages built, installed ✓
- `cd apps/python && uv run pytest` → **550 passed** (7.79s) ✓
- `cd apps/python && uv run pytest tests/test_placeholder.py` → **6 passed, 1 skipped** ✓
- `cd packages/python/infra/fractal_agent_infra && uv run ruff check .` → All checks passed ✓
- `cd packages/python/graphs/react_agent && uv run ruff check .` → All checks passed (after 1 auto-fix) ✓
- `cd apps/python && uv run ruff check .` → All checks passed ✓
- `grep -rn "fractal_agent_runtime"` → **0 matches** outside `.agent/` ✓

---

## Phase 2: 3-Layer Split — ✅ COMPLETE

> Done in Session 5 (2026-02-12). All changes on `refactor/package-structure` branch, uncommitted.

### Task Breakdown

#### Task-01: Create Graph Package (`packages/python/graphs/react_agent/`) — ✅

- [x] Create directory structure: `src/react_agent/`, `utils/`
- [x] Create `pyproject.toml` (name: `fractal-graph-react-agent`, deps: langchain, langgraph, mcp, pydantic, aiohttp + `fractal-agent-infra` path dep)
- [x] Move `agent.py` → `src/react_agent/agent.py`
- [x] Move `utils/mcp_interceptors.py`, `utils/token.py`, `utils/tools.py` → `src/react_agent/utils/`
- [x] **Refactor `agent.py` for DI:** Removed 11-line `try/except ImportError` block for `robyn_server.database` — accept `checkpointer` and `store` as keyword arguments to `graph()` factory
- [x] Create `__init__.py` that exports `graph`
- [x] Create `README.md`
- [x] Run `uv lock` (113 packages resolved)

**Files created:** `packages/python/graphs/react_agent/` (entire directory)
**Files moved from:** `packages/python/fractal_agent_runtime/src/fractal_agent_runtime/agent.py`, `*/utils/{mcp_interceptors,token,tools}.py`

#### Task-02: Create Infra Package (`packages/python/infra/fractal_agent_infra/`) — ✅

- [x] Create directory structure: `src/fractal_agent_infra/`, `security/`
- [x] Create `pyproject.toml` (name: `fractal-agent-infra`, minimal deps: langfuse, langchain-core, langgraph-sdk, supabase)
- [x] Move `tracing.py` → `src/fractal_agent_infra/tracing.py`
- [x] Move `utils/store_namespace.py` → `src/fractal_agent_infra/store_namespace.py`
- [x] Move `security/auth.py` → `src/fractal_agent_infra/security/auth.py`
- [x] Create `__init__.py` files (full public API export with alphabetically sorted `__all__`)
- [x] Create `README.md`
- [x] Run `uv lock` (85 packages resolved)

**Files created:** `packages/python/infra/fractal_agent_infra/` (entire directory)
**Files moved from:** `packages/python/fractal_agent_runtime/src/fractal_agent_runtime/{tracing,security/,utils/store_namespace}.py`

#### Task-03: Update Imports & Wire Dependencies — ✅

- [x] Update `apps/python/pyproject.toml`:
  - Removed `fractal-agent-runtime` dependency
  - Added `fractal-graph-react-agent` + `fractal-agent-infra` as path dependencies
  - Updated `[tool.uv.sources]` with new paths
- [x] Update `robyn_server` imports:
  - `from fractal_agent_runtime.agent import graph` → `from react_agent import graph`
  - `from fractal_agent_runtime.tracing import ...` → `from fractal_agent_infra.tracing import ...`
  - Store namespace imports → `from fractal_agent_infra.store_namespace import ...`
- [x] Update `robyn_server/agent.py` and `robyn_server/routes/streams.py`:
  - Pass `checkpointer` and `store` to `graph()` call (DI pattern) at both call sites
  - Import checkpointer/store from `robyn_server.database` in the RUNTIME
- [x] Update `react_agent/utils/token.py`:
  - `from fractal_agent_runtime.utils.store_namespace import ...` → `from fractal_agent_infra.store_namespace import ...`
- [x] Update test imports in `robyn_server/tests/test_tracing.py` (~30 references bulk-updated via sed)
- [x] Rewrote `apps/python/tests/test_placeholder.py` for new package structure
- [x] Run `uv sync` for all three packages (138 packages resolved for app)

**Files modified:** `apps/python/pyproject.toml`, `robyn_server/{agent,app,auth,agent_sync,routes/streams,tests/test_tracing}.py`, `apps/python/tests/test_placeholder.py`

#### Task-04: Delete Old Package & Verify — ✅

- [x] Delete `packages/python/fractal_agent_runtime/` entirely
- [x] Run `cd apps/python && uv sync && uv run pytest` → **550 tests pass** (7.79s)
- [x] Run `cd packages/python/graphs/react_agent && uv sync && uv run ruff check .` — clean (1 auto-fixed, then all passed)
- [x] Run `cd packages/python/infra/fractal_agent_infra && uv sync && uv run ruff check .` — clean (all passed)
- [x] Run ruff on apps/python — all checks passed (53 files unchanged)
- [x] Docker COPY paths updated: `packages/python/graphs/react_agent/` + `packages/python/infra/fractal_agent_infra/`
- [x] `.dockerignore` updated: test exclusions + README exceptions for new paths
- [ ] Docker build verification — deferred to CI (no local Docker in this session)

#### Task-05: Update CI/CD & Release Workflow — ✅

- [x] Update `release.yml` — `python-graphs-v*` tag now publishes from `packages/python/graphs/react_agent/` (working-directory + packages-dir updated)
- [x] Image workflows already use `packages/python/**` path filter — covers both new subdirectories
- [x] `.dockerignore` test exclusion paths updated for new structure
- [x] Zero workflow references to `packages/python/fractal_agent_runtime/` — confirmed via grep
- [ ] `python-infra-v*` tag — deferred (infra is local path dep only for v0.0.0)

#### Task-06: Commit, Push, PR — 🟡 IN PROGRESS

Pre-commit checks all passing (verified Session 5). Remaining steps:

- [x] Run full verification: `uv sync`, `pytest` (550 pass), `ruff check/format` on all dirs
- [ ] `git add` all changes (new dirs, deleted dirs, modified files)
- [ ] Commit with descriptive message
- [ ] Push `refactor/package-structure` → PR to `development`

---

## Phase 3: TypeScript Equivalent — ⚪ NOT STARTED

> After Phase 2 is merged and Python v0.0.0 is tagged.

- [ ] Create `packages/ts/graphs/react-agent/` (LangGraph.js graph using MCP tools)
- [ ] Create `packages/ts/infra/fractal-agent-infra/` if needed
- [ ] Update `apps/ts/` to import from packages
- [ ] Update `.devops/docker/ts.Dockerfile`
- [ ] Tag `ts-graphs-v0.0.0` and `ts-runtime-v0.0.0`

---

## Future Vision (v2+)

- **Graph catalog grows:** `plan_and_execute/`, `multi_agent_supervisor/`, `code_agent/`, etc.
- **LangGraph Platform deployment:** Graphs deploy directly to LangGraph Platform for both default system agents and user-invoked agents
- **Separate repo:** `graphs/` becomes its own repository (`fractal-agent-graphs`), added here as a git submodule
- **Infra promoted to PyPI:** When multiple consumers exist, publish `fractal-agent-infra` as a real PyPI package

---

## Open Questions (Resolved)

- [x] ~~Should `react_agent_with_mcp_tools` be renamed?~~ → Yes, to `react_agent` (graph) + `fractal_agent_infra` (infra)
- [x] ~~What stays in apps vs moves to packages?~~ → Server config, routes, Postgres persistence stay in apps. Graph logic + shared infra move to packages.
- [x] ~~Does the Python package need its own `uv.lock`?~~ → Yes, each package has its own `uv.lock`

## Open Questions (Pending)

- [x] ~~Should the graph package on PyPI be `fractal-graph-react-agent` or something shorter?~~ → `fractal-graph-react-agent` (decided Session 4)
- [x] ~~Should infra be published to PyPI for v0.0.0 or stay as local path dep only?~~ → Local path dep only for v0.0.0
- [ ] Does `security/auth.py` (LangGraph SDK auth) belong in infra or should it travel with the graph when deploying to LangGraph Platform? → Staying in infra for now; revisit when Platform deploy is implemented

---

## Notes

- The `react_agent_with_mcp_tools` → `react_agent` rename drops the verbose name in favor of a graph catalog naming convention
- Python packages use `src/` layout per UV best practices
- All changes are on `refactor/package-structure` branch — nothing committed yet from Phase 1
- Phase 1 + Phase 2 work is verified (550 tests, ruff clean, 0 stale references) — ready to commit
- The `.devops/docker/python.Dockerfile` was rewritten for uv best practices in Phase 1, COPY paths updated for 3-layer structure in Phase 2
- `README.md` rewritten (238 lines) with 3-layer architecture docs, DI examples, release tag table
- `CONTRIBUTING.md` created (441 lines) with graph catalog guide, coding standards, PR workflow
- All 6 task scratchpads updated with completion status and implementation notes
- **Nothing is committed yet** — all changes are in the working tree on `refactor/package-structure` at `c9a4464`

---

## Session 5 Summary (2026-02-12)

**What was done:**
- Tasks 01–05 implemented and verified: scaffolded both packages, moved files, refactored `graph()` for DI, updated all imports (~30 references in test_tracing.py alone), deleted old package, updated Dockerfile/CI/dockerignore
- `README.md` rewritten for 3-layer architecture with dependency diagram, DI code example, release tags table, corrected env vars
- `CONTRIBUTING.md` created: dev setup, project structure, coding standards, step-by-step "Adding a New Graph" guide, PR process, architecture decisions
- Full verification: 550 tests pass (7.72s), ruff clean on all 3 packages, 0 stale `fractal_agent_runtime` references
- All task scratchpads updated with 🟢 Complete status and detailed implementation notes

**What remains (Task-06 — next session):**
1. Re-run final verification (pytest, ruff, grep) as sanity check
2. `git add -A && git commit` with conventional commit message (see Task-06 scratchpad for exact message)
3. `git push origin refactor/package-structure`
4. Open PR to `development` (see Task-06 scratchpad for PR body)
5. Wait for CI to pass
6. Squash merge into `development`
7. Tag `python-graphs-v0.0.0` → triggers PyPI publish of `fractal-graph-react-agent`
8. Tag `python-runtime-v0.0.0` → triggers Docker image build + push to GHCR
9. Monitor both release pipeline jobs
10. Update Goal 19 status to 🟢 Complete