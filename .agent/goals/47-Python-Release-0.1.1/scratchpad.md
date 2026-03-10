# Goal 47: Python Release 0.1.1

**Status:** 🟡 In Progress  
**Priority:** High  
**Scope:** Python-only release (no TS/Bun changes)

---

## Objectives

- Cut a Python-only `0.1.1` release via release branch + PR.
- Add a Python `CHANGELOG.md` (new file).
- Document `0.1.0` as feature-parity milestone with TS/Bun and note Python maturity advantage.
- Include `0.1.1` entry for the MCP auth token exchange fix.

---

## Success Criteria

- Release branch exists (name to confirm: `python-release`).
- Python `CHANGELOG.md` added with `0.1.0` and `0.1.1` entries.
- `apps/python/pyproject.toml` version is `0.1.1`.
- PR opened against `main` for review.
- No TS/Bun files changed.

---

## Constraints / Notes

- Python is already at `0.1.x` and can continue minor/patch releases.
- `pyproject.toml` is single source of truth for Python version.
- Keep language in changelog factual and scoped to Python runtime.
- Avoid claims about TS/Bun bug-fix parity beyond user-provided guidance.

---

## Tasks

- [ ] Task 01: Release branch + Python changelog + PR
  - [ ] Rename branch to `python-release`
  - [ ] Add `apps/python/CHANGELOG.md`
  - [ ] Ensure `0.1.1` version in `apps/python/pyproject.toml`
  - [ ] Open PR via GitHub CLI

---

## Risks / Considerations

- Branch rename may require force push if already published.
- Changelog entries should avoid over-claiming parity or maturity.

---