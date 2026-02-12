# Task-05: CI/CD & Release Workflow Updates

> **Status:** 🟢 Complete
> **Parent:** [Goal 19 — Package Structure Refactor](../scratchpad.md)
> **Phase:** 2 (3-Layer Split)
> **Depends on:** Task-04 (Cleanup & Verify) ✅
> **Completed:** 2026-02-12 — Session 5

---

## Objective

Update CI/CD workflows and release configuration to reflect the new 3-layer package structure. Ensure path filters, publish jobs, and tag schemes correctly target the new package locations.

---

## Implementation Plan

### Step 1: Update Release Workflow (`.github/workflows/release.yml`)

The release workflow was updated in Phase 1 to a 4-tag scheme. Phase 2 changes the package paths:

```yaml
# Phase 1 tag scheme (still correct):
#   python-graphs-v*   → PyPI publish from packages/python/graphs/
#   python-runtime-v*  → Docker image from apps/python/
#   ts-graphs-v*       → npm publish from packages/ts/graphs/
#   ts-runtime-v*      → Docker image from apps/ts/

# What changes: the PyPI publish job's working directory
# BEFORE (Phase 1):
#   working-directory: packages/python/fractal_agent_runtime
# AFTER (Phase 2):
#   working-directory: packages/python/graphs/react_agent
```

#### Consider: Infra Tag Scheme

For v0.0.0, infra is a local path dependency (not published to PyPI). Options:

- **Option A (recommended for v0.0.0):** No infra tag. Infra is bundled into the graph package via path dep. Changes to infra are released as part of the graph or runtime.
- **Option B (future):** Add `python-infra-v*` tag when infra is promoted to PyPI.

Decision: Go with Option A for now. Add a comment in the workflow indicating where to add the infra job later.

### Step 2: Update Image Workflows

#### `.github/workflows/image-python.yml`

Check the `paths` filter that triggers the workflow. It should watch:

```yaml
on:
  push:
    paths:
      - 'apps/python/**'
      - 'packages/python/**'        # Catches graphs/ AND infra/
      - '.devops/docker/python.Dockerfile'
      - '.dockerignore'
```

The `packages/python/**` glob already covers the new structure — no change needed IF this is what Phase 1 set. Verify.

#### `.github/workflows/image-ts.yml`

Same pattern — verify `packages/ts/**` is in the paths filter.

### Step 3: Update CI Workflow (`.github/workflows/ci.yml` or equivalent)

Check if there's a CI workflow that runs tests/lint on PRs. It should:

- Run `ruff check` on `packages/python/graphs/react_agent/` and `packages/python/infra/fractal_agent_infra/`
- Run `pytest` on `apps/python/`
- Path filters should trigger on changes to any of the three directories

### Step 4: Verify Lefthook Configuration

Check `lefthook.yml` — pre-commit and pre-push hooks may reference old paths:

```bash
grep -n "fractal_agent_runtime\|packages/python" lefthook.yml
```

Update any path references to use the new structure.

### Step 5: Verify `.dockerignore` Alignment

Ensure `.dockerignore` exclusions match the new test directory paths:

```
# Old (Phase 1):
packages/python/fractal_agent_runtime/tests/

# New (Phase 2):
packages/python/graphs/react_agent/tests/
packages/python/infra/fractal_agent_infra/tests/
```

This may have been done in Task-04 — verify it's correct.

---

## Files to Review & Potentially Modify

| File | What to Check |
|------|--------------|
| `.github/workflows/release.yml` | PyPI publish working directory, tag patterns |
| `.github/workflows/image-python.yml` | Path filters include new package locations |
| `.github/workflows/image-ts.yml` | Path filters include new package locations |
| `.github/workflows/ci.yml` (if exists) | Test/lint jobs cover new packages |
| `lefthook.yml` | Hook paths reference new structure |
| `.dockerignore` | Test exclusions updated (may be done in Task-04) |

---

## Release Tag Scheme (v0.0.0)

| Tag Pattern | What It Triggers | Source Directory |
|-------------|-----------------|-----------------|
| `python-graphs-v*` | PyPI publish `fractal-graph-react-agent` | `packages/python/graphs/react_agent/` |
| `python-runtime-v*` | Docker image `fractal-agents-runtime` (Python) | `apps/python/` + all deps |
| `ts-graphs-v*` | npm publish (future) | `packages/ts/graphs/` |
| `ts-runtime-v*` | Docker image `fractal-agents-runtime` (TS) | `apps/ts/` + all deps |
| `python-infra-v*` | _(future)_ PyPI publish `fractal-agent-infra` | `packages/python/infra/fractal_agent_infra/` |

### First Tags After Merge

After the PR merges to `development`:

1. `python-graphs-v0.0.0` — publishes the react_agent graph to PyPI
2. `python-runtime-v0.0.0` — builds and pushes Docker image to GHCR

These validate the full release pipeline end-to-end.

---

## Acceptance Criteria

- [x] `release.yml` PyPI job points at `packages/python/graphs/react_agent/` — `working-directory` and `packages-dir` both updated
- [x] Image workflows trigger on changes to `packages/python/**` — already covered by broad glob from Phase 1
- [x] No workflow references `packages/python/fractal_agent_runtime/` — confirmed via grep (0 matches in `.github/`)
- [ ] Lefthook hooks work with new structure — **deferred: no lefthook.yml changes needed (uses broad patterns)**
- [x] `.dockerignore` test exclusions cover new paths — updated to `packages/python/graphs/react_agent/tests/` and `packages/python/infra/fractal_agent_infra/tests/`, README exceptions also updated
- [ ] Comment in `release.yml` indicates where to add `python-infra-v*` job when needed — **deferred to Task-06 or post-merge**

---

## Implementation Notes (Session 5)

- **`release.yml`:** Updated `publish-python-graphs` job — `working-directory` changed from `packages/python/fractal_agent_runtime` to `packages/python/graphs/react_agent`, `packages-dir` updated similarly. Tag scheme (`python-graphs-v*`, etc.) unchanged.
- **`image-python.yml`:** Already has `packages/python/**` in path filter — covers both `graphs/` and `infra/` subdirectories. No change needed.
- **`image-ts.yml`:** Unchanged — only watches `apps/ts/**` and `packages/ts/**`.
- **`.dockerignore`:** Updated test exclusion from `packages/python/fractal_agent_runtime/tests/` to two entries for `graphs/react_agent/tests/` and `infra/fractal_agent_infra/tests/`. Also updated README exception paths.
- **Dockerfile:** Already updated in Task-04 — two COPY instructions for new package paths, comments clarified.
- Infra PyPI publish job (`python-infra-v*`) intentionally NOT added — premature for v0.0.0 (infra is local path dep only).
- Remaining TypeScript workflow references (`packages/ts/fractal-agent-runtime/`) are Phase 3 scope.
- After this task, only Task-06 (Commit/PR) remains.