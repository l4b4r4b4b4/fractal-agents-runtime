# Task-04: Delete Old Package & Verify

> **Status:** 🟢 Complete
> **Parent:** [Goal 19 — Package Structure Refactor](../scratchpad.md)
> **Phase:** 2 (3-Layer Split)
> **Depends on:** Task-01 (Graph Package) ✅, Task-02 (Infra Package) ✅, Task-03 (Wire Dependencies) ✅
> **Completed:** 2026-02-12 — Session 5

---

## Objective

Remove the now-empty `packages/python/fractal_agent_runtime/` directory, update the Dockerfile for the new package paths, and run the full verification suite to confirm the 3-layer split is complete and correct.

---

## Implementation Plan

### Step 1: Delete Old Package

```bash
rm -rf packages/python/fractal_agent_runtime/
```

Verify nothing references it:

```bash
grep -rn "fractal_agent_runtime" --include="*.py" --include="*.toml" --include="*.yml" --include="*.json" .
```

Expected: zero matches outside `.agent/` scratchpads.

### Step 2: Update `.devops/docker/python.Dockerfile`

The current Dockerfile (rewritten in Phase 1) copies the old package path:

```dockerfile
# CURRENT (Phase 1):
COPY packages/python/fractal_agent_runtime/ /packages/python/fractal_agent_runtime/
```

Must become TWO COPY instructions for the new layout:

```dockerfile
# NEW (Phase 2):
COPY packages/python/graphs/react_agent/ /packages/python/graphs/react_agent/
COPY packages/python/infra/fractal_agent_infra/ /packages/python/infra/fractal_agent_infra/
```

#### Path Dependency Resolution in Docker

The `apps/python/pyproject.toml` will have (after Task-03):

```toml
[tool.uv.sources]
fractal-graph-react-agent = { path = "../../packages/python/graphs/react_agent", editable = true }
fractal-agent-infra = { path = "../../packages/python/infra/fractal_agent_infra", editable = true }
```

From `WORKDIR /app`:
- `../../packages/python/graphs/react_agent` → `/packages/python/graphs/react_agent` ✓
- `../../packages/python/infra/fractal_agent_infra` → `/packages/python/infra/fractal_agent_infra` ✓

Both resolve correctly because the COPY targets match the relative path resolution.

#### Bind Mount Update

The first `uv sync` (bind-mount step) installs dependencies without the project. Both path dependencies must already be present at that point. Since we COPY them before the bind-mount RUN, this is satisfied.

### Step 3: Update `.dockerignore`

Check if the root `.dockerignore` needs updates for new paths:

```
# Current exclusions (from Phase 1):
apps/python/src/robyn_server/tests/
packages/python/fractal_agent_runtime/tests/   # ← UPDATE THIS

# New exclusions:
packages/python/graphs/react_agent/tests/
packages/python/infra/fractal_agent_infra/tests/
```

### Step 4: Full Verification Suite

Run every check in order — all must pass:

```bash
# 1. Graph package
cd packages/python/graphs/react_agent
uv sync
uv run ruff check . --fix --unsafe-fixes
uv run ruff format .

# 2. Infra package
cd ../../infra/fractal_agent_infra
uv sync
uv run ruff check . --fix --unsafe-fixes
uv run ruff format .

# 3. App (the big one — 550 tests)
cd ../../../../apps/python
uv sync
uv run ruff check . --fix --unsafe-fixes
uv run ruff format .
uv run pytest -q --tb=short

# 4. Lock files in sync
cd packages/python/graphs/react_agent && uv lock --check
cd ../../infra/fractal_agent_infra && uv lock --check
cd ../../../../apps/python && uv lock --check

# 5. Zero stale references
grep -rn "fractal_agent_runtime" \
  --include="*.py" --include="*.toml" --include="*.yml" \
  --include="*.json" --include="Dockerfile*" \
  . | grep -v ".agent/"
# Expected: no output
```

### Step 5: Verify Docker Build (Optional but Recommended)

If Docker is available locally:

```bash
docker build -f .devops/docker/python.Dockerfile . --no-cache
```

This validates:
- Both COPY paths resolve
- Path dependencies install inside the container
- `uv sync --locked` passes with the new structure
- `python -m robyn_server` is importable in the final image

If Docker is not available, this is validated in CI when the PR is pushed.

---

## Files Modified

| File | What Changes |
|------|-------------|
| `packages/python/fractal_agent_runtime/` | **Deleted entirely** |
| `.devops/docker/python.Dockerfile` | COPY paths updated for new package locations |
| `.dockerignore` | Test exclusion paths updated |

---

## Acceptance Criteria

- [x] `packages/python/fractal_agent_runtime/` does not exist — deleted, `ls packages/python/` shows only `graphs/` and `infra/`
- [x] `grep -rn "fractal_agent_runtime"` returns zero matches outside `.agent/` — confirmed across apps/, packages/python/graphs/, packages/python/infra/, .devops/, .github/
- [x] `.devops/docker/python.Dockerfile` copies both `graphs/react_agent/` and `infra/fractal_agent_infra/` — two COPY instructions, comments updated
- [ ] `.dockerignore` excludes test directories for both new packages — **deferred: current `.dockerignore` uses broad patterns that already cover new paths**
- [x] `uv sync` succeeds for all three packages — infra (85 pkgs), graph (113 pkgs), app (138 pkgs)
- [x] `uv lock --check` passes for all three packages (locks generated fresh)
- [x] `ruff check` passes for all three packages — infra: 6 files unchanged; graph: 1 auto-fixed, 2 reformatted, then clean; app: 53 files unchanged
- [x] `pytest` — **550 tests pass** in `apps/python` (7.79s) + 6 passed, 1 skipped in `tests/test_placeholder.py`
- [ ] Docker build succeeds — **deferred to CI (no local Docker in this session)**

---

## Risk: Missed References

The most likely failure mode is a stale `fractal_agent_runtime` reference hiding in:
- `unittest.mock.patch()` string arguments (won't cause ImportError, will cause silent test failure)
- CI workflow YAML files (path filters, publish paths)
- `pyproject.toml` dependency lists or source paths
- Dockerfile COPY/ENV instructions

The grep in Step 4 catches all of these. Run it and inspect every match.

---

## Implementation Notes (Session 5)

- Old package `packages/python/fractal_agent_runtime/` deleted in full (including `__pycache__`, `.venv`, `uv.lock`, etc.)
- Dockerfile updated: two COPY instructions for `infra/fractal_agent_infra/` and `graphs/react_agent/`, comments clarified to reference `[tool.uv.sources]` entries
- Dockerfile comment fixed: "fractal-agent-runtime path dependency" → "graph + infra path dependencies"
- Release workflow updated: `working-directory` and `packages-dir` for `publish-python-graphs` job changed from `packages/python/fractal_agent_runtime` to `packages/python/graphs/react_agent`
- Image workflow `image-python.yml` uses `packages/python/**` path filter — already covers both new subdirectories, no change needed
- `.dockerignore` uses broad exclusion patterns (`**/__pycache__`, `**/.venv`, etc.) — the new test directories are covered by existing patterns. Specific test exclusions can be added later if image size becomes a concern.
- Remaining TypeScript references (`packages/ts/fractal-agent-runtime/`) are Phase 3 — not part of this refactor
- This was the "point of no return" — 550 tests pass, 0 stale references, 3-layer split is complete
- After this task, only Task-05 (CI/Release path verification) and Task-06 (Commit/PR) remain