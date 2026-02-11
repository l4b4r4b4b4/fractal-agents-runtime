# Goals Index & Tracking Scratchpad

> Central hub for tracking all goals in `l4b4r4b4b4/fractal-agents-runtime`

---

## Active Goals

| ID | Goal Name | Status | Priority | Last Updated |
|----|-----------|--------|----------|--------------|
| 01 | Monorepo v0.0.0 Setup — Full DevOps Pipeline | 🟡 In Progress | Critical | 2026-02-11 |
| 02 | Python Runtime v0.0.1 — First Real Release | ⚪ Not Started | High | 2026-02-11 |
| 03 | TypeScript Runtime v0.0.1 — First Real TS Implementation | ⚪ Not Started | High | 2026-02-11 |

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

---

## Goal Creation Guidelines

1. **Copy from template:** Use `00-Template-Goal/` as starting point
2. **Follow numbering:** Goals are `01-NN-*`, tasks are `Task-01-*`
3. **Update this index:** Add new goals to the table above
4. **Reference, don't duplicate:** Link to detailed scratchpads instead of copying content

---

## Dependency Graph

```
Goal 01: Monorepo v0.0.0 Setup
  └── Goal 02: Python Runtime v0.0.1 (depends on Goal 01)
        └── Goal 03: TypeScript Runtime v0.0.1 (depends on Goal 01 + Goal 02)
```

Goal 02 depends on Goal 01 because the DevOps pipeline must exist before we can run a release through it.
Goal 03 depends on Goal 02 because the pipeline validation from the Python release confirms the workflow is trustworthy.

---

## Recent Activity

### 2026-02-11

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