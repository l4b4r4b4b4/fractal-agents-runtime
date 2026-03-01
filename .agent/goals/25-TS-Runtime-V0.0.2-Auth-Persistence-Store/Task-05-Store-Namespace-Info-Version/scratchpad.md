# Task-05: Store Namespace Conventions & Info Update

> **Status:** 🟢 Complete
> **Created:** 2025-07-21
> **Completed:** 2025-07-21
> **Parent Goal:** [Goal 25 — TS Runtime v0.0.2](../scratchpad.md)

---

## Objective

Port Python's namespace conventions to TypeScript, update the `/info` endpoint to reflect v0.0.2 capabilities, unify version management across both runtimes to a single source of truth, and bump the version to 0.0.2.

---

## Deliverables

### Files Created (2 new)

| File | Purpose |
|------|---------|
| `src/infra/store-namespace.ts` | Namespace constants, `buildNamespace()`, `extractNamespaceComponents()` |
| `tests/store-namespace.test.ts` | 51 tests — constants, builder validation, extractor edge cases, integration |

### Files Modified — TypeScript Runtime (5 existing)

| File | Changes |
|------|---------|
| `src/config.ts` | `VERSION` now reads from `package.json` via `import packageJson` — **single source of truth** |
| `src/openapi.ts` | `info.version` and description now use `VERSION` from config instead of hardcoded strings |
| `src/routes/health.ts` | Added `database_configured` to `/info` config section, imported `isDatabaseConfigured` |
| `package.json` | Version bumped to `0.0.2` (this is the single source of truth for TS) |
| `tests/index.test.ts` | Updated hardcoded `0.0.1` → `0.0.2`, updated capabilities/tiers assertions |

### Files Modified — Python Runtime (4 existing)

| File | Changes |
|------|---------|
| `src/server/__init__.py` | Added `__version__` via `importlib.metadata.version()` — reads from `pyproject.toml` |
| `src/server/models.py` | `ServiceInfoResponse.version` now uses `__version__` instead of hardcoded `"0.0.2"` |
| `src/server/openapi_spec.py` | `API_VERSION` now uses `__version__` instead of hardcoded `"0.1.0"` (was wrong!) |
| `package.json` | Synced from `"0.0.0"` to `"0.0.2"` (was already out of sync) |

---

## Version Unification (Key Deliverable)

### Problem

Version was scattered across multiple files with no single source of truth:

**TypeScript (before):**
- `package.json` → `"0.0.1"` ← should be the source
- `config.ts` → `VERSION = "0.0.1"` ← duplicated
- `openapi.ts` → `version: "0.0.1"` ← duplicated

**Python (before):**
- `pyproject.toml` → `"0.0.2"` ← should be the source
- `package.json` → `"0.0.0"` ← already wrong!
- `models.py` → `version: str = "0.0.2"` ← duplicated
- `openapi_spec.py` → `API_VERSION = "0.1.0"` ← completely wrong!

### Solution

**TypeScript:** `package.json` is the single source of truth.
```
package.json  →  config.ts (import packageJson)  →  openapi.ts (import VERSION)
                                                  →  health.ts (import VERSION)
                                                  →  all other consumers
```

**Python:** `pyproject.toml` is the single source of truth.
```
pyproject.toml  →  importlib.metadata.version()  →  server/__init__.py (__version__)
                                                  →  models.py (ServiceInfoResponse)
                                                  →  openapi_spec.py (API_VERSION)
```

### Verification

All version consumers read from the single source:
- TS: `package.json` → `config.VERSION` → `OPENAPI_SPEC.info.version` → `/info` response — all `"0.0.2"`
- Python: `pyproject.toml` → `__version__` → `ServiceInfoResponse.version` → `API_VERSION` — all `"0.0.2"`

---

## Namespace Conventions Implemented

Port of `apps/python/src/infra/store_namespace.py` to TypeScript:

### Constants

| Constant | Value | Description |
|----------|-------|-------------|
| `CATEGORY_TOKENS` | `"tokens"` | MCP token cache (per agent) |
| `CATEGORY_CONTEXT` | `"context"` | Webapp-provided agent context |
| `CATEGORY_MEMORIES` | `"memories"` | Runtime-learned facts |
| `CATEGORY_PREFERENCES` | `"preferences"` | User preferences |
| `SHARED_USER_ID` | `"shared"` | Pseudo user_id for org-wide data |
| `GLOBAL_AGENT_ID` | `"global"` | Pseudo assistant_id for user-global data |

### Functions

- `buildNamespace(orgId, userId, assistantId, category)` → `[string, string, string, string]`
  - Validates all components are non-empty strings
  - Trims whitespace
  - Throws `Error` with descriptive message on validation failure

- `extractNamespaceComponents(configurable?)` → `NamespaceComponents | null`
  - Reads `supabase_organization_id`, `owner`, `assistant_id` from configurable dict
  - Returns `null` when any component is missing, empty, or non-string
  - Trims whitespace from extracted values

### `NamespaceComponents` Interface

```ts
interface NamespaceComponents {
  readonly orgId: string;
  readonly userId: string;
  readonly assistantId: string;
}
```

---

## `/info` Endpoint Updates

### Before (v0.0.1)

```json
{
  "capabilities": { "streaming": true, "store": false, ... },
  "config": { "supabase_configured": false, "llm_configured": false },
  "tiers": { "tier1": true, "tier2": false, "tier3": "not_started" }
}
```

### After (v0.0.2)

```json
{
  "capabilities": { "streaming": true, "store": true, ... },
  "config": { "supabase_configured": false, "database_configured": false, "llm_configured": false },
  "tiers": { "tier1": true, "tier2": true, "tier3": "not_started" }
}
```

Changes:
- `capabilities.store` → `true` (Store API implemented)
- `config.database_configured` → new field (reflects `DATABASE_URL` presence)
- `tiers.tier2` → `true` (auth + persistence + store complete)

---

## Test Coverage

**51 new namespace tests** across 4 describe blocks:

| Block | Tests | Coverage |
|-------|-------|----------|
| `Store namespace constants` | 6 | All 4 categories + 2 pseudo-IDs |
| `buildNamespace` | 21 | Success cases, trimming, UUIDs, custom categories, all 8 validation failures |
| `extractNamespaceComponents` | 20 | Success cases, missing/invalid fields (null, empty, whitespace, wrong types), shape |
| `Namespace integration` | 4 | Full extract→build pipeline, shared/global variants, null handling |

**Updated existing tests:** 5 assertions in `index.test.ts` updated for v0.0.2 values.

---

## Acceptance Criteria

- [x] `buildNamespace("org-1", "user-1", "agent-1", "tokens")` → `["org-1", "user-1", "agent-1", "tokens"]`
- [x] `extractNamespaceComponents(config)` returns null when components missing
- [x] `SHARED_USER_ID` = `"shared"`, `GLOBAL_AGENT_ID` = `"global"`
- [x] `/info` reports `capabilities.store: true`
- [x] `/info` reports correct `config.supabase_configured` and `config.database_configured`
- [x] `package.json` version bumped to `0.0.2`
- [x] `VERSION` in config.ts reads from package.json (single source of truth)
- [x] OpenAPI spec version reads from `VERSION` constant (no hardcoding)
- [x] Python `ServiceInfoResponse.version` reads from pyproject.toml via `__version__`
- [x] Python `API_VERSION` reads from pyproject.toml via `__version__`
- [x] Python `package.json` synced to `0.0.2`
- [x] All existing tests updated and passing
- [x] All 1039 TS tests pass (51 new + 988 existing)
- [x] All 1123 Python tests pass (no regressions)
- [x] TypeScript compiles clean (`tsc --noEmit`)

---

## Remaining from Original Task-05 Scope (Deferred)

- [ ] OpenAPI spec updated with Store endpoint definitions (schemas + paths) — deferred to separate task
- [ ] CHANGELOG.md entry for v0.0.2 — deferred to release
- [ ] Docker image update + pipeline run — deferred to release

---

## Notes

- The version unification was prompted by the user observing that bumping version required touching 3 files — an obvious maintenance hazard. This fix ensures future version bumps require changing **exactly one file** per runtime.
- Python's `package.json` is a monorepo artifact (not used by Python tooling). It was already at `"0.0.0"` while `pyproject.toml` was at `"0.0.2"` — proof the multi-source approach was already drifting.
- Python's `openapi_spec.py` had `API_VERSION = "0.1.0"` while `models.py` had `version = "0.0.2"` — the API and the info endpoint were reporting different versions!