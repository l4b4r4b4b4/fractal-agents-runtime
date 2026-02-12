# Goals Index & Tracking Scratchpad

> Central hub for tracking all goals in `l4b4r4b4b4/fractal-agents-runtime`

---

## Active Goals

| ID | Goal Name | Status | Priority | Last Updated |
|----|-----------|--------|----------|--------------|
| 01 | Monorepo v0.0.0 Setup — Full DevOps Pipeline | 🟢 Complete | Critical | 2026-02-11 |
| 02 | Python Runtime v0.0.1 — First Real Release | ⚪ Not Started | High | 2026-02-11 |
| 03 | TypeScript Runtime v0.0.1 — First Real TS Implementation | ⚪ Not Started | High | 2026-02-11 |
| 18 | Assistant Config Propagation Fix | ⚪ Not Started | High | 2026-02-11 |
| 19 | Package Structure Refactor — 3-Layer Architecture | 🟢 Complete | Critical | 2026-02-12 |

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
        ├── Goal 02: Python Runtime v0.0.1 (depends on Goal 19)
        │     └── Goal 03: TypeScript Runtime v0.0.1 (depends on Goal 02)
        └── Goal 18: Assistant Config Propagation Fix (depends on Goal 19)
```

Goal 19 complete — v0.0.0 released, 3-layer architecture established, rebase workflow in place.
Goal 18 next priority — touches graph code that has now stabilized in Goal 19.
Goal 02 depends on Goal 19 because the package structure must be finalized before first release.
Goal 03 depends on Goal 02 because the pipeline validation from the Python release confirms the workflow is trustworthy.

---

## Recent Activity

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