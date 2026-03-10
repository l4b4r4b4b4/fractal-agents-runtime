# Task 01: Pre-Push Frozen uv Run

**Status:** 🟢 Complete  
**Goal:** Fix Lefthook uv.lock Regeneration  
**Scope:** Pre-push hook behavior (Python only)

---

## Context

The pre-push hook runs `uv run` commands that can regenerate `apps/python/uv.lock`. This introduces unintended diffs during push and breaks the expectation that hooks are read-only.

---

## Plan

- [x] Identify all pre-push `uv run` commands in `lefthook.yml`.
- [x] Add frozen/locked flags so `uv` cannot modify `uv.lock`.
- [x] Verify no `uv.lock` diff after running the pre-push hook.
- [x] Update goal/task scratchpads with results.

## Completed Work

- Added a pre-commit `python-lock-sync` hook to run `uv lock` and stage `uv.lock` automatically when `pyproject.toml` changes.
- Added `--frozen` to all pre-push `uv run` commands so hooks are read-only and fail if the lockfile is stale.
- Verified `uv.lock` remains clean after pre-push runs.

---

## Files to Modify

- `lefthook.yml`

---

## Proposed Change

- Add `--frozen` or `--locked` to every `uv run` invocation in pre-push hooks.
- Prefer `--frozen` for read-only behavior and to avoid lockfile writes.

---

## Test Strategy

- Run the pre-push hook locally and confirm `git status` is clean.
- Ensure existing lint/OpenAPI/test commands still pass.

---

## Done When

- Pre-push hooks do not modify `apps/python/uv.lock`.
- `lefthook.yml` updated with frozen/locked `uv run` commands.
- Task scratchpad updated with the completed work.