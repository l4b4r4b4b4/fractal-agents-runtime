# Goals Index & Tracking Scratchpad

> Central hub for tracking all goals in `l4b4r4b4b4/fractal-agents-runtime`

---

## Active Goals

| ID | Goal Name | Status | Priority | Last Updated |
|----|-----------|--------|----------|--------------|
| 01 | Monorepo v0.0.0 Setup — Full DevOps Pipeline | 🟢 Complete | Critical | 2026-02-11 |
| 02 | Python Runtime v0.0.1 — First Real Release | 🟡 In Progress | High | 2026-02-13 |
| 03 | TypeScript Runtime v0.0.1 — First Real TS Implementation | ⚪ Not Started | High | 2026-02-11 |
| 18 | Assistant Config Propagation Fix | 🟢 Complete | High | 2026-02-13 |
| 19 | Package Structure Refactor — 3-Layer Architecture | 🟢 Complete | Critical | 2026-02-12 |
| 20 | Rename `robyn_server` Module → `server` + BUG-01 Fix | 🟢 Complete | Medium | 2026-02-13 |
| 21 | Raise Test Coverage to 73% | 🟢 Complete | High | 2026-02-13 |
| 22 | Unified Helm Chart | 🟢 Complete | High | 2026-02-13 |
| 23 | Research Agent Graph (Parallel Research with HIL) | 🟢 Complete | High | 2026-02-14 |
| 24 | Langfuse Prompt Template Integration | 🟡 In Progress | Medium | 2026-02-13 |

---

## Status Legend

- 🟢 **Complete** — Goal achieved and verified
- 🟡 **In Progress** — Actively being worked on
- 🔴 **Blocked** — Waiting on external dependency or decision
- ⚪ **Not Started** — Planned but not yet begun
- ⚫ **Archived** — Abandoned or superseded

---

## Priority Levels

- **Critical** — Blocking other work or system stability
- **High** — Important for near-term objectives
- **Medium** — Should be addressed when time permits
- **Low** — Nice to have, no urgency

---

## Quick Links

- [01-Monorepo-V0.0.0-Setup](./01-Monorepo-V0.0.0-Setup/scratchpad.md)
- [02-Python-Runtime-V0.0.1](./02-Python-Runtime-V0.0.1/scratchpad.md)
- [03-TypeScript-Runtime-V0.0.1](./03-TypeScript-Runtime-V0.0.1/scratchpad.md)
- [18-Assistant-Config-Propagation-Fix](./18-Assistant-Config-Propagation-Fix/scratchpad.md)
- [19-Package-Structure-Refactor](./19-Package-Structure-Refactor/scratchpad.md)
- [20-Rename-Robyn-Server-Module](./20-Rename-Robyn-Server-Module/scratchpad.md)
- [21-Test-Coverage-73-Percent](./21-Test-Coverage-73-Percent/scratchpad.md)

---

## Goal Creation Guidelines

1. **Copy from template:** Use `00-Template-Goal/` as starting point
2. **Follow numbering:** Goals are `01-NN-*`, tasks are `Task-01-*`
3. **Update this index:** Add new goals to the table above
4. **Reference, don't duplicate:** Link to detailed scratchpads instead of copying content

---

## Dependency Graph

```
Goal 01: Monorepo v0.0.0 Setup ✅
  └── Goal 19: Package Structure Refactor (depends on Goal 01) ✅
        ├── Goal 20: Rename robyn_server → server (depends on Goal 19) ✅
        ├── Goal 21: Test Coverage to 73% ✅
        ├── Goal 22: Unified Helm Chart ✅
        ├── Goal 23: Research Agent Graph ✅ (depends on Goal 22, 24-Task-01)
        ├── Goal 24: Langfuse Prompt Templates 🟡 (Task-01+03 ✅, Task-02 blocked by Goal 23 ✅)
        ├── Goal 18: Assistant Config Propagation Fix ✅
        ├── Goal 02: Python Runtime v0.0.1 (depends on Goal 18, 21, 23)
        │     └── Goal 03: TypeScript Runtime v0.0.1 (depends on Goal 02)
        └── (future) GHCR image build + deploy from development
```

Goal 23 complete — research agent graph with two-phase parallel workers, HIL review, Langfuse prompts, graph registry.
Goal 24 mostly complete — `infra/prompts.py` done, react_agent integrated, research_agent integrated. Remaining: docs/Helm.
Goal 02 next priority — commit all, push, PR, Docker build, AKS deploy, tag v0.0.1.

---

## Recent Activity

### 2026-02-14 — Session 14 (Goal 23 Task-05: Tests Complete — Goal 23 🟢 Complete)

- **Goal 23 🟢 Complete** — All 6 tasks done, all acceptance criteria met
- **94 tests** written in `src/server/tests/test_research_agent.py` covering:
  - Models (14 tests): Pydantic validation, serialisation roundtrips, flexible metadata
  - Prompts (7 tests): registration, naming convention, JSON hints, tools mention, idempotent
  - Configuration (8 tests): defaults, custom values, extras ignored, MCP/RAG parsing, bounds
  - Worker extraction (12 tests): JSON array, code fence, results key, plain-text fallback, multimodal, alt field names
  - Worker helpers (7 tests): `_is_ai_message`, `_safe_float`, `_get_message_content`
  - Graph response parsing (15 tests): analyzer/aggregator parsing, `_extract_content`, `_try_parse_json`
  - Graph compilation (3 tests): mocked LLM + empty tools, checkpointer+store, expected nodes
  - Graph factory (1 test): async factory with mocked `init_chat_model`
  - Graph registry (11 tests): resolve, register eager/lazy, both/neither error, `__qualname__` check
  - Server wiring (4 tests): app imports, streams/agent registry usage, info endpoint
  - Error resilience (7 tests): non-dict items, single object, string response, None config, empty tasks
- **Fixed 2 test bugs:** `__module__` assertions on lazy wrappers → use `__qualname__` instead
- **Fixed 7 pre-existing `test_streams.py` failures** caused by registry refactor:
  - `build_agent_graph` no longer exists in `streams.py` — updated all patches to mock `resolve_graph_factory` with `AsyncMock` factory wrapper
- **Full suite: 1026 passed, 35 skipped, 0 failed** (up from 932 before Goal 23)
- **Coverage: 74.12%** (threshold: 73%) — `models.py` 100%, `prompts.py` 100%, `configuration.py` 100%, `worker.py` 91%, `graph.py` 56%
- **Lint: all checks passed** (ruff check + ruff format)
- **Next:** Commit all, push branch, open PR to `development`

### 2026-02-13 — Session 13 (Goal 23 Tasks 01-04 + 06: Research Agent Implementation)

- **Goal 23 🟡 In Progress** — All implementation tasks complete, tests remaining
- **New package: `graphs/research_agent/`** — Two-phase parallel research workflow with HIL review:
  - `models.py` — Generic SearchTask/ResearchResult/AnalyzerOutput/AggregatorOutput (domain-agnostic, metadata dict)
  - `prompts.py` — 6 generic English default prompts + `register_default_prompt()` for Langfuse auto-seeding
  - `configuration.py` — ResearchAgentConfig with LLM/MCP/RAG + `max_worker_iterations`, `auto_approve_phase1/2`
  - `worker.py` — `extract_worker_output()` with multi-strategy extraction (JSON, regex, code-fence, plain-text fallback)
  - `graph.py` — Full StateGraph: analyzer → [Send] workers → aggregator → interrupt review → Command routing (800 lines)
  - `__init__.py` — graph() factory with MCP tool + LLM resolution (mirrors react_agent pattern)
- **New module: `graphs/registry.py`** — Dict-based graph registry with `register_graph()`/`resolve_graph_factory()`, lazy imports, future BPMN-to-graph ready
- **Server wiring:** `streams.py` + `agent.py` use registry dispatch, `app.py` seeds research_agent prompts
- **Goal 24 Task-06:** All 6 prompts wired through `get_prompt()` with Langfuse overrides
- **All new files lint-clean** (ruff check passed)

### 2026-02-13 — Session 12 (Goal 24: Langfuse Prompt Templates — Tasks 01 + 03 Complete)

- **Goal 24 🟡 In Progress** — `infra/prompts.py` implemented with full Langfuse prompt management
- **New module: `infra/prompts.py`** — 3 public functions:
  - `get_prompt()` — text + chat prompt support, Langfuse fetch with fallback, runtime overrides via `config.configurable.prompt_overrides` (name/label/version)
  - `register_default_prompt()` — graph-level registration for auto-seeding
  - `seed_default_prompts()` — creates missing prompts in Langfuse at startup (idempotent, non-fatal)
- **React agent integration** — system prompt now resolved via `get_prompt("react-agent-system-prompt", fallback=DEFAULT_SYSTEM_PROMPT, config=config)`. Priority: assistant config > Langfuse > hardcoded default. `UNEDITABLE_SYSTEM_PROMPT` still appended.
- **Auto-seeding at startup** — `server/app.py` calls `seed_default_prompts()` after `initialize_langfuse()`. Imports graph modules to trigger `register_default_prompt()` calls. Empty Langfuse gets populated with editable prompts on first deploy.
- **Runtime override design** — frontend can pass `prompt_overrides` in `configurable` dict to swap prompt name, label, or version at call time. Enables A/B testing, composition, and prompt debugging. Flows through standard LangGraph `RunnableConfig` — zero protocol changes.
- **65 new tests** in `src/server/tests/test_prompts.py` — 98% coverage on `infra/prompts.py`
- **Full suite: 932 passed, 35 skipped** — no regressions, lint clean
- **Updated:** `infra/__init__.py` (exports), `.env.example` (LANGFUSE_PROMPT_CACHE_TTL), Goal 24 scratchpad
- **Remaining for Goal 24:** Task-02 (vertriebsagent integration, blocked by Goal 23), Task-04 (docs/Helm)

### 2026-02-13 — Session 8 (Goal 20 Complete + BUG-01 Resolved)

- **Goal 20 🟢 Complete** — PR #25 squash-merged to `development` (`b233593`)
- **Module rename:** `robyn_server/` → `server/`, `fractal_agent_infra/` → `infra/`, `react_agent/` → `graphs/react_agent/`
- **BUG-01 RESOLVED ✅:** Eliminated shared `AsyncConnectionPool` entirely — the pool's internal `asyncio.Lock` was the real culprit (not just the checkpointer's lock). Fix: per-request connections via LangGraph's `from_conn_string()`. `PostgresStorage` now takes a `ConnectionFactory` instead of a pool.
- **Live verified:** 10/10 sequential messages on same thread with full memory, zero asyncio.Lock errors (Supabase + OpenAI)
- **Pydantic v2 compat:** Fixed deprecated `Field(optional=True)` and `Field(metadata={...})` → `json_schema_extra={}`. All warnings eliminated (tested with `-W error::DeprecationWarning`)
- **Dep cleanup:** Removed `langgraph-sdk` from explicit deps (zero imports in our code, transitive from `langgraph`)
- **Test results:** 523 passed, 35 skipped, 0 warnings, lint clean, OpenAPI valid
- **Rebase fix:** Branch was forked from old `development` SHA (`6107fe9`, amended to `1a7fe23`). Rebased onto `origin/development` — clean, no conflicts.
- **BUG-02 (messages overwritten in UI):** Likely downstream of BUG-01 — verify after deploy
- **Remaining:** Build + push GHCR image from `development`, deploy, stop test container on :8081

### 2026-02-12 — Session 7 (Monorepo Consolidation + BUG-01/BUG-03 Fixes)

- **Monorepo consolidation complete:** Moved `react_agent` and `fractal_agent_infra` from `packages/python/` into `apps/python/src/` — single package eliminates Docker wheel cache staleness
- **BUG-01 Fixed:** `asyncio.Lock` event loop mismatch resolved with `_NoOpLock` — multi-message chat now works reliably
- **BUG-03 Fixed:** System prompt constrained to prevent tool hallucinations
- **Verified in Docker:** Built `agent-runtime:local`, tested 3 messages on same thread — all streamed, memory persisted, zero errors in logs
- **PRs:** #19 (consolidation → development), #23 (promote to main via squash)
- **Branch rules loosened:** Both `main` and `development` now allow merge, squash, and rebase (was rebase-only, causing promotion conflicts)
- **Closed:** PR #16 (assistant config propagation — conflicts with new structure, needs reimplementation)
- **Image live:** `ghcr.io/l4b4r4b4b4/fractal-agents-runtime-python:nightly` (sha-be5895f)
- **Goal 20 created:** Rename `robyn_server` → `server` (cosmetic, ~241 refs across 40 files)

### 2026-02-12 — Session 6 (Goal 19: v0.0.0 RELEASED 🟢)

- **Goal 19 🟢 Complete** — Task-06 done: committed, PR'd, merged, released all three components
- **PRs:** #7 (refactor→development), #9 (promote to main), #10 (rebase workflow), #11 (pipeline fixes), #13 (lint fix)
- **Branching workflow overhaul:** Switched from squash-only to rebase-only merge method
  - Both rulesets updated via API + `.github/rulesets/*.json`
  - Added `no-merge-commits` lefthook pre-push guard
  - Discovered GitHub "rebase merge" still rewrites SHAs — promotion uses force-push/fast-forward instead of PRs
- **Release pipeline fixes:** graph placeholder test (pytest exit 5), python.Dockerfile WORKDIR path traversal, ts.Dockerfile premature COPY
- **v0.0.0 released — all 3 pipelines succeeded:**
  - `python-graphs-v0.0.0` → `fractal-graph-react-agent` published to PyPI ✅
  - `python-runtime-v0.0.0` → Docker image pushed to GHCR ✅
  - `ts-runtime-v0.0.0` → Docker image pushed to GHCR ✅
- **Known issues for v0.0.1:** auth `assert` → explicit `raise`, CI path filter gap for `packages/python/**`, promotion workflow automation

### 2026-02-12 — Session 5 (Goal 19: Phase 2 Complete + Docs)

- **Goal 19 🟡 In Progress** — Phase 2 (3-layer split) code complete, docs updated, awaiting commit/push/PR (Task-06)
- **Tasks 01–05 done:** Scaffolded `packages/python/graphs/react_agent/` (PyPI: `fractal-graph-react-agent`) and `packages/python/infra/fractal_agent_infra/` (local path dep), moved all source files, refactored `graph()` for DI (`checkpointer`/`store` as kwargs), updated all imports in `robyn_server` (~30 refs in `test_tracing.py` alone), deleted old `fractal_agent_runtime/` package, updated Dockerfile COPY paths, CI release workflow, `.dockerignore`
- **Verification:** 550 tests pass (7.72s), ruff clean on all 3 packages, 0 stale `fractal_agent_runtime` references in code/config/workflows
- **README.md rewritten** (238 lines): 3-layer architecture diagram, dependency rules, DI code example, packages table, release tags table, corrected env vars
- **CONTRIBUTING.md created** (441 lines): dev setup, project structure, coding standards, step-by-step "Adding a New Graph to the Catalog" guide, testing philosophy, PR process, architecture decision rationale
- **All task scratchpads** updated with 🟢 Complete status and detailed implementation notes
- **Next (Task-06):** `git add -A && git commit`, push, open PR to `development`, merge, tag `python-graphs-v0.0.0` + `python-runtime-v0.0.0` to validate release pipeline

### 2026-02-11 — Session 4 (Goal 19: Package Structure Refactor)

- **Goal 19 🟡 In Progress** — Branch `refactor/package-structure` (off `development`)
- **Phase 1 (done):** Initial extraction — moved `react_agent_with_mcp_tools/` into `packages/python/fractal_agent_runtime/`, updated all imports in `robyn_server`, deleted old directory, 550 tests pass
- **Phase 1 (done):** Docker + CI — rewrote `python.Dockerfile` per [uv Docker best practices](https://docs.astral.sh/uv/guides/integration/docker/) (pin uv 0.10.2, bind mounts, non-editable, no source in runtime image), created root `.dockerignore`, updated image + release workflows for 4-tag scheme
- **Phase 1 (done):** Cleanup — removed all `react_agent_with_mcp_tools` refs from code/config (only .agent scratchpads remain as history), fixed ruff config for graph package, all ruff + tests green
- **Architecture decision:** Refined to **3-layer architecture** after review:
  - `packages/python/graphs/` — Pure agent graph architectures (portable catalog, future submodule candidate)
  - `packages/python/infra/` — Shared runtime infrastructure (tracing, auth, store namespace)
  - `apps/python/` — Thin HTTP wrapper (Robyn server, routes, Postgres persistence)
- **Phase 2 (next session):** Restructure `packages/python/fractal_agent_runtime/` → split into `graphs/react_agent/` + `infra/fractal_agent_infra/`, proper DI for checkpointer/store, update all imports
- See [Goal 19 scratchpad](./19-Package-Structure-Refactor/scratchpad.md) for full plan and task breakdown

### 2026-02-11 — Session 3

- **Goal 01 🟢 Complete** — Task-10 finished: initial commit, push, branch setup, rulesets, CI validation
- Cleaned up 8 completed/superseded old goal directories
- Fixed root `.gitignore` (missing `node_modules/`, `.zed/`)
- Initial commit: 176 files, ~50K lines pushed to `main` (all 10 Lefthook hooks green)
- Created `development` branch, pushed
- Applied rulesets via `gh api`: `main-branch-protection` + `development-branch-protection`
- CI passed on both `main` and `development` branches
- PR #1: Fixed TS Dockerfile (pin Bun 1.3.8, fix `adduser` on slim image), added SBOM + provenance to image builds
- Full branch protection flow validated: feature → PR → CI gate → squash merge → development
- **BoS decision:** lockfiles = dependency BoS, `sbom: true` + `provenance: true` = image-level BoS

### 2026-02-11 — Sessions 1 & 2

- Created all three goals for initial monorepo lifecycle:
  - **Goal 01:** Monorepo scaffold, Python migration, TS stub, Lefthook, CI/CD, branch protection, v0.0.0 images + releases
  - **Goal 02:** Python v0.0.1 — first real release validating the full 2-branch DevOps pipeline end-to-end
  - **Goal 03:** TS v0.0.1 — first real TypeScript implementation (core LangGraph API subset with Bun.serve())
- Adapted `.rules` for monorepo context (Bun workspaces, TypeScript, Helm, polyglot)
- Adapted `flake.nix` for monorepo dev shell (bun + python/uv + k8s/helm)
- Created `fractal-agents-runtime` GitHub repo (public, NOT a fork)

### Migration Context

This repo was created as a clean break from `l4b4r4b4b4/oap-langgraph-tools-agent` (itself a fork of `langchain-ai/oap-langgraph-tools-agent`). The fork had diverged massively: 13 commits, 223 files changed, 78K+ lines added, 550+ tests — all original work. See [Goal 17 in the old repo](https://github.com/l4b4r4b4b4/oap-langgraph-tools-agent/blob/main/.agent/goals/17-Fractal-Agents-Runtime-Monorepo/scratchpad.md) for the full divergence analysis.

---

## Notes

- Python and TypeScript apps are versioned independently
- The 2-branch strategy (feature → development → main) applies to both apps
- OpenAPI specs are committed artifacts AND served at runtime
- Lefthook handles pre-commit/pre-push hooks; CI validates independently