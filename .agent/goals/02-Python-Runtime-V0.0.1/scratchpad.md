# Goal 02: Python Runtime v0.0.1 — First Real Release

> **Status:** ⚪ Not Started
> **Priority:** High
> **Created:** 2026-02-11
> **Last Updated:** 2026-02-11
> **Depends on:** [Goal 01 — Monorepo v0.0.0 Setup](../01-Monorepo-V0.0.0-Setup/scratchpad.md)

---

## Objectives

Run the full DevOps pipeline end-to-end for a real v0.0.1 release of the Python runtime, validating that every stage of the 2-branch workflow works in practice:

1. **Feature branch** — Make meaningful improvements to `apps/python/`
2. **Feature image build** — Verify GHCR image builds on push
3. **PR to `development`** — CI passes, merge succeeds
4. **Development image build** — Verify `development`-tagged image
5. **PR to `main`** — CI passes, merge succeeds
6. **Release pipeline** — v0.0.1 image tagged + PyPI publish triggered
7. **OpenAPI spec** — Updated, committed, served, validated at every stage

---

## Scope: What Changes in v0.0.1

This is the first release AFTER the migration. Focus on fixes and improvements discovered during the v0.0.0 setup:

### Candidates (finalize after Goal 01 completes)

- [ ] Fix any import issues discovered post-migration
- [ ] Update `apps/python/README.md` with accurate getting-started instructions
- [ ] Verify Robyn server starts and serves all endpoints correctly
- [ ] Verify OpenAPI spec matches actual runtime behavior
- [ ] Bump version: `0.0.0` → `0.0.1` in `pyproject.toml` and `__version__`
- [ ] Update CHANGELOG.md with v0.0.1 entries
- [ ] Any bug fixes from testing the v0.0.0 Docker image

### Explicitly Out of Scope

- No new features — this is a pipeline validation release
- No TS changes (that's Goal 03)
- No DevOps pipeline changes (those should be stable from Goal 01)

---

## Pipeline Walkthrough

This goal is as much about validating the process as the code:

### Step 1: Feature Branch

```bash
git checkout development
git pull
git checkout -b feat/python-v0.0.1-fixes
```

- Make changes in `apps/python/`
- Lefthook pre-commit: lint + generate OpenAPI spec
- Push → verify feature image builds at `sha-<short_sha>`

### Step 2: PR to `development`

- Create PR: `feat/python-v0.0.1-fixes` → `development`
- Verify CI runs: lint-python, test-python, validate-openapi
- Merge (squash) → verify `development`-tagged image builds

### Step 3: PR to `main`

- Create PR: `development` → `main`
- Verify CI runs again
- Merge (squash) → verify:
  - Release image: `latest`, `v0.0.1`, `sha-<short_sha>`
  - PyPI publish: `fractal-agents-runtime==0.0.1`
  - Git tag: `python-v0.0.1`

### Step 4: Verify Artifacts

- [ ] `docker pull ghcr.io/l4b4r4b4b4/fractal-agents-runtime-python:v0.0.1`
- [ ] `pip install fractal-agents-runtime==0.0.1` (from PyPI)
- [ ] Docker image runs and serves `/health`, `/info`, `/openapi.json`
- [ ] OpenAPI spec in repo matches runtime spec

---

## Task Breakdown

### Task-01: Code Fixes & Version Bump

- Address any issues found during Goal 01 testing
- Bump version to `0.0.1` in `pyproject.toml` and `__init__.py`
- Update CHANGELOG.md
- Update OpenAPI spec (regenerate)
- **Depends on:** Goal 01 complete

### Task-02: Pipeline Validation

- Execute the full feature → development → main flow
- Document any pipeline issues discovered
- Fix pipeline issues if any (may require hotfix to DevOps config)
- **Depends on:** Task-01

### Task-03: Artifact Verification

- Pull and run the released Docker image
- Install from PyPI and verify
- Confirm OpenAPI spec consistency
- Document results in this scratchpad
- **Depends on:** Task-02

---

## Success Criteria

- [ ] Feature branch push triggered image build with `sha-` tag
- [ ] PR to `development` passed CI and merged cleanly
- [ ] Merge to `development` triggered `development`-tagged image build
- [ ] PR to `main` passed CI and merged cleanly
- [ ] Merge to `main` triggered release pipeline:
  - [ ] Docker image tagged `v0.0.1` + `latest` on GHCR
  - [ ] PyPI package `fractal-agents-runtime==0.0.1` published
  - [ ] Git tag `python-v0.0.1` created
- [ ] Docker image runs correctly (health, info, openapi endpoints)
- [ ] PyPI install works: `pip install fractal-agents-runtime==0.0.1`
- [ ] OpenAPI spec in repo matches served spec
- [ ] Lefthook hooks fired correctly at every commit/push
- [ ] CHANGELOG.md updated with v0.0.1 entry
- [ ] Zero pipeline manual interventions required (fully automated)

---

## Notes

- This goal is primarily a **pipeline validation exercise** — the code changes are minimal
- If the pipeline works flawlessly, this goal should take < 1 hour
- Any pipeline issues found here get fixed before Goal 03 (TS v0.0.1)
- The experience from this release directly informs whether Goal 03's pipeline is trustworthy