# Task-06: Commit, Push & PR

> **Status:** 🟡 In Progress (pre-commit checks done, awaiting commit/push/PR)
> **Parent:** [Goal 19 — Package Structure Refactor](../scratchpad.md)
> **Phase:** 2 (3-Layer Split)
> **Depends on:** Task-05 (CI/Release) ✅
> **Last Updated:** 2026-02-12 — Session 5

---

## Objective

Commit all Phase 1 + Phase 2 changes on `refactor/package-structure`, push to origin, and open a PR to `development`. This is the final task — everything must be green before this runs.

---

## Pre-Commit Checklist

All of these must be confirmed before committing:

- [x] `cd packages/python/graphs/react_agent && uv sync && uv run ruff check .` → passes ✅ (1 auto-fixed, then clean)
- [x] `cd packages/python/infra/fractal_agent_infra && uv sync && uv run ruff check .` → passes ✅ (6 files unchanged)
- [x] `cd apps/python && uv sync && uv run ruff check . --fix --unsafe-fixes && uv run ruff format .` → passes ✅ (53 files unchanged)
- [x] `cd apps/python && uv run pytest -q` → **550 passed** ✅ (7.72s)
- [x] `grep -rn "fractal_agent_runtime"` → **0 matches** outside `.agent/` ✅
- [x] `grep -rn "react_agent_with_mcp_tools"` → **0 matches** outside `.agent/` ✅
- [x] `uv lock` generated fresh for all three package directories ✅ (infra: 85, graph: 113, app: 138 packages)
- [x] `.devops/docker/python.Dockerfile` COPY paths match new structure ✅ (two COPY for graphs/ + infra/)
- [x] `.dockerignore` test exclusions updated for new paths ✅
- [x] All scratchpads updated with completion status ✅ (Tasks 01–05 marked 🟢 Complete)
- [x] `README.md` updated for 3-layer architecture ✅
- [x] `CONTRIBUTING.md` created with graph catalog guide ✅

---

## Implementation Plan

### Step 1: Stage All Changes

```bash
cd fractal-agents-runtime

# Review what's changed
git status

# Stage everything (new dirs, deletions, modifications)
git add -A

# Review the staged diff
git diff --cached --stat
```

Expected diff summary (verified via `git status`):
- **New:** `packages/python/graphs/react_agent/` (entire directory — pyproject.toml, README, src/, tests/)
- **New:** `packages/python/infra/fractal_agent_infra/` (entire directory — pyproject.toml, README, src/, tests/)
- **New:** `.devops/docker/python.Dockerfile`, `.devops/docker/ts.Dockerfile`
- **New:** `.dockerignore` (root level)
- **New:** `CONTRIBUTING.md` (441 lines — dev setup, coding standards, graph catalog guide)
- **New:** `.agent/goals/19-Package-Structure-Refactor/` (task scratchpads)
- **Deleted:** `packages/.gitkeep` (replaced by actual packages)
- **Deleted:** `apps/python/src/react_agent_with_mcp_tools/` (original code, Phase 1)
- **Deleted:** Old Dockerfiles (`apps/python/Dockerfile`, `apps/ts/Dockerfile`, `.devops/docker/{Dockerfile,Dockerfile.dev,base_cpu,base_gpu_cuda,production,staging,entrypoint.sh}`)
- **Modified:** `README.md` (rewritten for 3-layer architecture, 238 lines)
- **Modified:** `apps/python/pyproject.toml` (fractal-agent-runtime → fractal-graph-react-agent + fractal-agent-infra)
- **Modified:** `apps/python/uv.lock` (regenerated)
- **Modified:** `robyn_server/{agent,agent_sync,app,auth,routes/streams,tests/test_tracing}.py` (imports updated)
- **Modified:** `apps/python/tests/{__init__,test_placeholder}.py` (rewritten for new packages)
- **Modified:** `.github/workflows/{image-python,image-ts,release}.yml` (new paths, 4-tag scheme)
- **Modified:** `.agent/goals/scratchpad.md` (goals index)

Note: `packages/python/fractal_agent_runtime/` was created in this session and then deleted —
it only exists as untracked+deleted in the working tree. Git sees the net effect: old code deleted,
new packages created.

### Step 2: Commit

Use a descriptive conventional commit message:

```bash
git commit -m "refactor!: 3-layer package architecture (graphs / infra / apps)

BREAKING CHANGE: Package structure completely reorganized.

- Extract graph into packages/python/graphs/react_agent/
  (PyPI: fractal-graph-react-agent)
- Extract infra into packages/python/infra/fractal_agent_infra/
  (local path dep for now, PyPI later)
- apps/python/ is now a thin Robyn HTTP wrapper
- Graph receives checkpointer/store via DI (no server imports)
- Delete old react_agent_with_mcp_tools/ and fractal_agent_runtime/
- Rewrite python.Dockerfile per uv Docker best practices (pin 0.10.2,
  bind mounts, --no-editable, no source in runtime image)
- Create root .dockerignore (required for repo-root build context)
- Update CI workflows for new paths and 4-tag release scheme
- 550 tests pass, ruff clean across all packages"
```

Note: The `!` after `refactor` and `BREAKING CHANGE` footer follow Conventional Commits for breaking changes. This is appropriate because the package import paths changed.

### Step 3: Push

```bash
git push origin refactor/package-structure
```

### Step 4: Open PR

```bash
# Or use the GitHub CLI:
gh pr create \
  --base development \
  --head refactor/package-structure \
  --title "refactor!: 3-layer package architecture (graphs / infra / apps)" \
  --body "## Summary

Reorganizes the monorepo into a clean 3-layer architecture:

| Layer | Location | Purpose |
|-------|----------|---------|
| **Graphs** | \`packages/python/graphs/react_agent/\` | Portable agent graph catalog |
| **Infra** | \`packages/python/infra/fractal_agent_infra/\` | Shared runtime infrastructure |
| **Apps** | \`apps/python/src/robyn_server/\` | Thin HTTP server wrapper |

### Key Changes

- **Graph is fully portable** — no \`robyn_server\` imports, receives checkpointer/store via DI
- **Dockerfile rewritten** per [uv Docker best practices](https://docs.astral.sh/uv/guides/integration/docker/) — pinned uv 0.10.2, bind mounts, \`--no-editable\`, no source in runtime image
- **Root \`.dockerignore\` created** — old \`apps/python/.dockerignore\` was silently ignored with repo-root build context
- **CI updated** — 4-tag release scheme, new package path filters

### Verification

- \`apps/python\`: **550 tests passed**, ruff clean
- \`packages/python/graphs/react_agent\`: uv sync + ruff clean
- \`packages/python/infra/fractal_agent_infra\`: uv sync + ruff clean
- Zero stale \`react_agent_with_mcp_tools\` or \`fractal_agent_runtime\` refs in code

### After Merge

Tag \`python-graphs-v0.0.0\` and \`python-runtime-v0.0.0\` to validate the full release pipeline.

See [Goal 19 scratchpad](.agent/goals/19-Package-Structure-Refactor/scratchpad.md) for full context."
```

---

## Post-PR Actions

After the PR is opened:

1. **Wait for CI** — all checks must pass (lint, test, image build)
2. **Review the diff** — verify no secrets, no debug code, no stale references
3. **Request Copilot review** (optional) — automated feedback before human review
4. **Squash merge** into `development` when approved

### After Merge to `development`

1. Tag `python-graphs-v0.0.0` → triggers PyPI publish of `fractal-graph-react-agent`
2. Tag `python-runtime-v0.0.0` → triggers Docker image build + push to GHCR
3. Verify both release jobs succeed
4. Update Goal 19 status to 🟢 Complete
5. Begin Goal 18 (Assistant Config Propagation Fix) for v0.0.1

---

## Acceptance Criteria

- [x] All pre-commit checks pass (see checklist above)
- [ ] Commit message follows Conventional Commits with breaking change notation
- [ ] PR opened against `development` with clear description
- [ ] CI passes on the PR
- [ ] PR is merged via squash merge
- [ ] Tags `python-graphs-v0.0.0` and `python-runtime-v0.0.0` pushed after merge
- [ ] Release pipeline succeeds for both tags
- [ ] Goal 19 scratchpad updated to 🟢 Complete

---

## Notes

- This is the largest single commit in the repo's history — the diff will be substantial
- Squash merge is preferred to keep `development` history clean
- The PR body uses the goals scratchpad as the source of truth for context
- After v0.0.0 tags are pushed, the package structure is "locked in" — further changes require new versions

## Session 5 State (2026-02-12)

All Phase 1 + Phase 2 work is complete and verified but **nothing is committed yet**.
The branch `refactor/package-structure` is at the same commit as `origin/development` (`c9a4464`).
All changes are in the working tree. Next session should:
1. Run final verification (pytest, ruff, grep)
2. `git add -A && git commit` with the message above
3. `git push origin refactor/package-structure`
4. Open PR to `development`
5. After merge: tag `python-graphs-v0.0.0` and `python-runtime-v0.0.0`
6. Monitor release pipeline (PyPI publish + GHCR image build)