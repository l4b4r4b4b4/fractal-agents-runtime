# Task 01: Release Branch and Python Changelog

**Status:** 🟡 In Progress  
**Goal:** Python Release 0.1.1  
**Scope:** Python-only release (no TS/Bun changes)

---

## Context

We need a Python-only release branch, add a Python `CHANGELOG.md`, and open a PR for `0.1.1`. The version source of truth is `apps/python/pyproject.toml`. The changelog must include a `0.1.0` entry (feature parity with TS/Bun; Python more mature due to additional bug fixes) and a `0.1.1` entry (MCP token exchange fix).

---

## Plan

- [x] Rename current release branch to `python-release`.
- [x] Add `apps/python/CHANGELOG.md` with `0.1.0` and `0.1.1` entries.
- [x] Verify `apps/python/pyproject.toml` version is `0.1.1`.
- [ ] Commit changes with conventional commit message.
- [ ] Push branch and open PR via GitHub CLI.

---

## Completed Work

- Renamed the release branch to `python-release`.
- Added `apps/python/CHANGELOG.md` with `0.1.1` (MCP token exchange removal) and `0.1.0` (feature parity milestone + Python maturity note).
- Confirmed `apps/python/pyproject.toml` is already set to `0.1.1`.

---

## Files to Modify

- `apps/python/CHANGELOG.md` (new)
- `apps/python/pyproject.toml` (ensure `version = "0.1.1"`)

---

## Changelog Content Notes

- `0.1.0`: mention feature parity with TS/Bun, and Python maturity advantage because some bug fixes are not yet in Bun.
- `0.1.1`: mention MCP token exchange removal and direct JWT pass-through.

Keep statements factual and scoped to Python runtime.

---

## Test Strategy

- No tests required for changelog-only updates.
- Do not touch TS/Bun files.

---

## Done When

- Branch is named `python-release`.
- Python changelog exists and includes `0.1.0` and `0.1.1`.
- Version in `pyproject.toml` is `0.1.1`.
- PR opened against `main`.