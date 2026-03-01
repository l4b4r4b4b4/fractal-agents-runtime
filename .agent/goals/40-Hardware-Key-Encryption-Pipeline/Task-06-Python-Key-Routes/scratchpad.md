# Task-06: Python Key Routes (API Endpoints)

> **Status**: 🟢 Complete
> **Phase**: 2 — Server Integration
> **Updated**: 2026-02-24
> **Depends On**: Task-04 (Python Key Service), Task-05 (Python Encryption Service)
> **Branch**: `goal-40-hardware-key-encryption-server`

## Objective

Build the Robyn HTTP API routes for hardware key management and encrypted asset operations. These routes expose the service layer (Task-04, Task-05) as REST endpoints that the frontend and Edge Functions interact with.

## What Was Done

### Files Created
- **`apps/python/src/server/routes/hardware_keys.py`** — 18 route handlers (~830 lines)
- **`apps/python/src/server/tests/test_hardware_key_routes.py`** — 86 unit tests (~2008 lines)

### Files Modified
- **`apps/python/src/server/routes/__init__.py`** — Added `register_hardware_key_routes` import and `__all__` entry
- **`apps/python/src/server/app.py`** — Registered `register_hardware_key_routes(app)` in the app setup

### Architecture Decisions

1. **Service models used directly** — The services (`hardware_key_service.py`, `encryption_service.py`) already define well-typed Pydantic request/response models. The routes use these directly rather than creating duplicate route-layer models. The `hardware_key_models.py` file remains for future WebAuthn ceremony models (begin/complete flows for Edge Function integration) but is NOT used by the routes.

2. **Generic error handling** — All service exceptions inherit from `HardwareKeyError` which carries a `status_code` attribute. Routes catch specific exception types for known error codes (404, 409, 410, 428) and fall back to the base `HardwareKeyError` for any others, then catch `Exception` as a final 500 safety net.

3. **Per-request connections** — Each route handler opens its own `async with get_connection() as connection:` following the established pattern. No shared pool, no cross-event-loop issues.

4. **key_assertions INSERT works** — The `record_assertion` endpoint uses the superuser Postgres connection (which bypasses RLS), so INSERT into `key_assertions` works despite having no INSERT RLS policy. In production, the Edge Function will handle assertion verification and recording.

5. **428 Precondition Required** — Key-gated retrieval returns HTTP 428 when assertions are insufficient, with a structured JSON body containing `asset_type`, `asset_id`, `action`, `required_key_count`, `assertions_present`, and `reason`. This gives the frontend everything needed to prompt for a hardware key touch.

## Endpoints Implemented (18 total)

### Key CRUD (5 endpoints)
| Method | Path | Status Codes | Description |
|--------|------|-------------|-------------|
| POST | `/keys/register` | 201, 400, 409, 422 | Register a new hardware key |
| GET | `/keys` | 200 | List user's keys (`?include_inactive=true`) |
| GET | `/keys/:key_id` | 200, 404 | Get specific key |
| PATCH | `/keys/:key_id` | 200, 400, 404 | Update key metadata |
| DELETE | `/keys/:key_id` | 200, 404 | Soft-deactivate key |

### Assertion Management (4 endpoints)
| Method | Path | Status Codes | Description |
|--------|------|-------------|-------------|
| POST | `/keys/assertions` | 201, 400, 404, 422 | Record verified assertion |
| GET | `/keys/assertions` | 200 | List valid assertions (`?asset_type&asset_id`) |
| GET | `/keys/assertions/status` | 200, 400, 422 | Check access status (`?asset_type&asset_id&action`) |
| POST | `/keys/assertions/:assertion_id/consume` | 200, 404, 410, 422 | Consume assertion |

### Asset Key Policies (4 endpoints)
| Method | Path | Status Codes | Description |
|--------|------|-------------|-------------|
| POST | `/keys/policies` | 201, 400, 409, 422 | Create key policy |
| GET | `/keys/policies` | 200, 422 | List policies (`?asset_type&asset_id`) |
| GET | `/keys/policies/:policy_id` | 200, 404 | Get specific policy |
| DELETE | `/keys/policies/:policy_id` | 200, 404 | Delete policy |

### Encrypted Asset Data (5 endpoints)
| Method | Path | Status Codes | Description |
|--------|------|-------------|-------------|
| POST | `/keys/encrypted-data` | 201, 400, 422 | Store encrypted payload |
| GET | `/keys/encrypted-data` | 200 | List metadata (`?asset_type`) |
| GET | `/keys/encrypted-data/:asset_type/:asset_id` | 200, 404, 428 | Get data (`?require_key_check&action&auto_consume`) |
| DELETE | `/keys/encrypted-data/:asset_type/:asset_id` | 200, 404 | Delete encrypted data |
| PATCH | `/keys/encrypted-data/:asset_type/:asset_id/authorized-keys` | 200, 400, 404 | Rotate authorized keys |

## Test Coverage

**86 tests** covering all 18 endpoints:
- **TestKeyRegister** (7 tests): success, unauthenticated, invalid JSON, validation error, conflict, invalid input, unexpected error
- **TestKeyList** (4 tests): success, empty, include_inactive param, unauthenticated
- **TestKeyGet** (4 tests): found, not found, missing key_id, unauthenticated
- **TestKeyUpdate** (5 tests): success, not found, invalid JSON, missing key_id, invalid device_type
- **TestKeyDeactivate** (3 tests): success, not found, missing key_id
- **TestAssertionRecord** (6 tests): success, scoped assertion, unauthenticated, invalid JSON, validation error, key not found
- **TestAssertionList** (3 tests): all, with asset filter, unauthenticated
- **TestAssertionStatus** (6 tests): allowed, denied, missing asset_type, missing asset_id, default action decrypt, invalid input
- **TestAssertionConsume** (5 tests): success, not found, already consumed (410), expired (410), missing assertion_id
- **TestPolicyCreate** (5 tests): success, conflict, invalid input, validation error, unauthenticated
- **TestPolicyList** (3 tests): success, missing asset_type, missing asset_id
- **TestPolicyGet** (3 tests): found, not found, missing policy_id
- **TestPolicyDelete** (3 tests): success, not found, missing policy_id
- **TestEncryptedDataStore** (4 tests): success, invalid keys, validation error, unauthenticated
- **TestEncryptedDataList** (2 tests): all, filtered by type
- **TestEncryptedDataGet** (10 tests): key check allowed, key check denied (428), without key check, not found variants, custom action, auto_consume false, missing params, KeyAssertionRequired exception
- **TestEncryptedDataDelete** (3 tests): success, not found, missing asset_type
- **TestEncryptedDataUpdateAuthorizedKeys** (8 tests): success, with new payload, not found, invalid keys, invalid JSON, validation error, missing asset_type, unauthenticated
- **TestRouteRegistration** (2 tests): all 18 routes registered, route count

## Test Results

```
1135 passed, 34 skipped in 11.51s
```

- 1049 pre-existing tests: all pass (no regressions)
- 86 new hardware key route tests: all pass
- Ruff lint: all clean
- Ruff format: all clean

## Known Pyright Diagnostics (Not Bugs)

Pyright reports ~7 false-positive type errors in `hardware_keys.py` related to Robyn's `QueryParams.get()` returning `str | None`. Even with explicit `if x is not None:` guards, pyright doesn't narrow the types. These are type checker limitations, not actual bugs — the code is functionally correct and all tests pass. The same pattern exists in other route files (e.g., `assistants.py` has pre-existing pyright issues).

## What Remains

- [ ] `hardware_key_models.py` can be cleaned up or archived — the WebAuthn ceremony models (begin/complete) are for future Edge Function integration (Task-08), not used by current routes
- [ ] Integration tests against live Supabase (deferred to post-Task-07 or a dedicated test pass)
- [ ] OpenAPI spec updates (if auto-generated spec is maintained)