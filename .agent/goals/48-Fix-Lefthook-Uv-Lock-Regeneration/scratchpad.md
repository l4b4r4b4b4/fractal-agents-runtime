# Goal 48: Fix Lefthook uv.lock Regeneration

**Status:** 🟡 In Progress  
**Priority:** High  
**Scope:** Fix pre-push hook behavior to prevent unintended `uv.lock` changes.

---

## Objectives

- Stop lefthook pre-push hooks from modifying `apps/python/uv.lock`.
- Ensure pre-push checks are read-only with respect to lockfiles.
- Keep developer workflow intact (lint, OpenAPI validate, tests).

---

## Success Criteria

- Pre-push hooks do not change `apps/python/uv.lock`.
- No diffs introduced by pre-push when no files are changed.
- CI and local checks continue to run and pass.

---

## Constraints / Notes

- Use `uv` exclusively (per repo rules).
- Avoid changes that reduce test coverage or disable hooks.
- Prefer minimal, explicit changes to hook commands.

---

## Tasks

- [ ] Task 01: Make pre-push uv commands lockfile-safe
  - [ ] Update lefthook commands to run `uv` in frozen/locked mode.
  - [ ] Verify pre-push does not touch `uv.lock`.
  - [ ] Document the change in the task scratchpad.

---

## Risks / Considerations

- Some `uv` commands may still resolve environment metadata unless frozen/locked flags are used.
- Hook changes must not hide legitimate dependency drift.

---