# Task-04: Python Hardware Key Service

> **Status**: ⚪ Not Started
> **Phase**: 2 — Server Integration
> **Updated**: 2026-02-23
> **Depends On**: Task-01 (Protocol) ✅, Task-02 (Schema) ✅

## Objective

Build the Python server-side service module for hardware key operations: registration, listing, deactivation, assertion verification, and assertion consumption. This is the core backend logic that the API routes (Task-06) will call.

## Context

The Supabase schema provides 4 tables (`hardware_keys`, `asset_key_policies`, `key_assertions`, `encrypted_asset_data`) with RLS policies and support functions. The Python runtime (Robyn) needs a service layer that:

1. **Manages hardware key lifecycle** — CRUD operations on `hardware_keys`
2. **Verifies WebAuthn assertions** — Validates authenticator signatures, checks counter monotonicity, writes `key_assertions` records
3. **Checks key-protected access** — Calls `has_key_protected_access()` from Python to gate operations
4. **Consumes assertions** — Marks single-use assertions as consumed after the protected operation completes

### Existing Infrastructure

- `apps/python/src/server/database.py` — Per-request async connection factory (`get_connection()`)
- `apps/python/src/server/auth.py` — JWT auth middleware, `AuthUser` model, `get_current_user()`/`require_user()`
- `apps/python/src/server/config.py` — Config with `SupabaseConfig`, `DatabaseConfig`
- `apps/python/src/infra/security/` — Existing security module (currently just auth)

## Implementation Plan

### File: `apps/python/src/server/hardware_key_service.py`

**Key Registration:**
- `register_hardware_key(user_id, credential_id, public_key, counter, transports, ...)` → INSERT into `hardware_keys`
- Validates: credential_id uniqueness, user_id matches auth context
- Returns: created `HardwareKey` model

**Key Listing:**
- `list_user_hardware_keys(user_id)` → SELECT from `hardware_keys` WHERE user_id AND is_active
- Returns: list of `HardwareKey` models (never exposes raw public_key bytes to API)

**Key Deactivation:**
- `deactivate_hardware_key(user_id, key_id)` → UPDATE `hardware_keys` SET is_active = false
- Validates: key belongs to user

**Assertion Verification:**
- `verify_and_record_assertion(user_id, hardware_key_id, challenge, asset_type?, asset_id?)` → INSERT into `key_assertions`
- This is the critical path: verifies that the WebAuthn assertion is cryptographically valid
- Updates `hardware_keys.counter` and `hardware_keys.last_used_at`
- Returns: assertion ID + expiry timestamp

**Assertion Consumption:**
- `consume_assertion(assertion_id, user_id)` → UPDATE `key_assertions` SET consumed = true, consumed_at = now()
- Validates: assertion belongs to user, not already consumed, not expired

**Access Check:**
- `check_key_protected_access(user_id, asset_type, asset_id, action)` → calls `has_key_protected_access()` SQL function
- Returns: boolean

### Pydantic Models: `apps/python/src/server/models.py` (extend existing)

```python
class HardwareKeyRegistration(BaseModel):
    credential_id: str  # base64url
    public_key: str  # base64url-encoded COSE key
    counter: int
    transports: list[str]
    friendly_name: str | None
    device_type: str | None
    attestation_format: str | None
    aaguid: str | None

class HardwareKeyResponse(BaseModel):
    id: str  # uuid
    credential_id: str
    friendly_name: str | None
    device_type: str | None
    transports: list[str]
    is_active: bool
    last_used_at: str | None
    created_at: str

class AssertionVerification(BaseModel):
    hardware_key_id: str  # uuid
    challenge: str
    asset_type: str | None
    asset_id: str | None

class AssertionResponse(BaseModel):
    assertion_id: str
    expires_at: str
    consumed: bool
```

### Dependencies

- `psycopg` (already in project) — async Postgres queries
- No new pip dependencies needed for the service layer
- WebAuthn signature verification: for the full flow, `py_webauthn` would be needed, BUT the initial implementation can trust the Edge Function to have verified the signature. The Python service records the assertion and checks policies.

## Design Decisions

### Edge Function vs. Python Runtime for WebAuthn Verification

**Decision**: Split responsibility.

- **Edge Function** (Supabase): Handles the actual WebAuthn assertion ceremony (challenge generation, signature verification against stored `public_key`, counter validation). This runs close to the database with SECURITY DEFINER privileges to INSERT into `key_assertions`.
- **Python Runtime**: Consumes assertion records, checks `has_key_protected_access()`, manages key CRUD, and gates protected operations.

**Rationale**: The Python runtime connects as the `postgres` superuser (bypasses RLS), so it CAN insert assertions. But WebAuthn verification is a browser↔server ceremony that should happen as close to the client as possible. The Edge Function is the natural fit for that.

However, for **development and testing**, the Python service will include assertion recording capability (simulating what the Edge Function would do) so we can test the full flow without deploying Edge Functions.

### Connection Pattern

Following the existing `database.py` pattern: per-request `async with get_connection() as conn:` — no shared pool, no cross-event-loop issues.

## Files to Create/Modify

- [ ] `apps/python/src/server/hardware_key_service.py` — Core service module (NEW)
- [ ] `apps/python/src/server/models.py` — Add Pydantic models for hardware keys (MODIFY)

## Acceptance Criteria

- [ ] `register_hardware_key()` inserts into `hardware_keys` and returns model
- [ ] `list_user_hardware_keys()` returns only active keys for the user
- [ ] `deactivate_hardware_key()` soft-deactivates (not deletes) a key
- [ ] `verify_and_record_assertion()` creates a valid `key_assertions` record
- [ ] `consume_assertion()` marks assertion as used, rejects expired/consumed
- [ ] `check_key_protected_access()` correctly delegates to SQL function
- [ ] All functions validate ownership (user_id matches)
- [ ] No raw key material (public_key bytes) exposed in API responses
- [ ] Proper error handling with descriptive exceptions
- [ ] Type annotations on all public functions

## Test Strategy

- Unit tests with mocked DB connections for service logic
- Integration tests against local Supabase for full DB round-trip
- Test cases: register → list → verify assertion → consume → check access
- Edge cases: duplicate credential_id, expired assertion, already-consumed assertion, deactivated key