# Task-06: Python Key Routes (API Endpoints)

> **Status**: ⚪ Not Started
> **Phase**: 2 — Server Integration
> **Updated**: 2026-02-23
> **Depends On**: Task-04 (Python Key Service), Task-05 (Python Encryption Service)

## Objective

Build the Robyn HTTP API routes for hardware key management and encrypted asset operations. These routes expose the service layer (Task-04, Task-05) as REST endpoints that the frontend and Edge Functions interact with.

## Context

The Python runtime uses Robyn (Rust-backed async Python web framework). Existing route patterns are in `apps/python/src/server/routes/`. The auth middleware (`apps/python/src/server/auth.py`) provides `require_user()` to get the authenticated `AuthUser` from JWT context.

### Existing Route Patterns

Looking at the existing server structure:
- Routes are defined in `apps/python/src/server/routes/`
- Auth middleware extracts `AuthUser` with `identity` (Supabase user ID), `email`, `metadata`
- JSON error responses follow `{"detail": "message"}` format (LangGraph API convention)
- Per-request DB connections via `async with get_connection() as conn:`

## Implementation Plan

### File: `apps/python/src/server/routes/hardware_keys.py`

#### Key Management Endpoints

**`POST /keys/register`** — Register a new hardware key
- Auth: Required (JWT)
- Body: `HardwareKeyRegistration` (credential_id, public_key, counter, transports, friendly_name?, device_type?, attestation_format?, aaguid?)
- Calls: `hardware_key_service.register_hardware_key()`
- Returns: `201` + `HardwareKeyResponse`
- Errors: `409` duplicate credential_id, `400` invalid input, `401` unauthorized

**`GET /keys`** — List user's registered hardware keys
- Auth: Required (JWT)
- Calls: `hardware_key_service.list_user_hardware_keys(user_id)`
- Returns: `200` + `list[HardwareKeyResponse]`
- Note: Never returns raw `public_key` bytes — only metadata

**`GET /keys/:key_id`** — Get a specific hardware key
- Auth: Required (JWT)
- Calls: `hardware_key_service.get_hardware_key(user_id, key_id)`
- Returns: `200` + `HardwareKeyResponse`
- Errors: `404` not found or not owned by user

**`PATCH /keys/:key_id`** — Update hardware key metadata
- Auth: Required (JWT)
- Body: `HardwareKeyUpdate` (friendly_name?, device_type?)
- Calls: `hardware_key_service.update_hardware_key(user_id, key_id, ...)`
- Returns: `200` + `HardwareKeyResponse`
- Errors: `404` not found, `400` invalid input

**`DELETE /keys/:key_id`** — Deactivate a hardware key
- Auth: Required (JWT)
- Calls: `hardware_key_service.deactivate_hardware_key(user_id, key_id)`
- Returns: `200` + `{"deactivated": true}`
- Note: Soft-deactivation (sets `is_active = false`), not hard delete
- Errors: `404` not found

#### Assertion Endpoints

**`POST /keys/assertions`** — Record a verified key assertion
- Auth: Required (JWT)
- Body: `AssertionVerification` (hardware_key_id, challenge, asset_type?, asset_id?)
- Calls: `hardware_key_service.verify_and_record_assertion()`
- Returns: `201` + `AssertionResponse` (assertion_id, expires_at)
- Note: In production, this is handled by the Edge Function. This endpoint exists for dev/testing and for the runtime to record assertions forwarded from the Edge Function.
- Errors: `400` invalid input, `404` hardware key not found, `409` key not active

**`GET /keys/assertions/status`** — Check assertion status for an asset
- Auth: Required (JWT)
- Query params: `asset_type`, `asset_id`, `action` (default: 'decrypt')
- Calls: `hardware_key_service.check_key_protected_access()`
- Returns: `200` + `KeyProtectedAccessResult`
- Purpose: Frontend can check if a key touch is needed before attempting a protected operation

**`POST /keys/assertions/:assertion_id/consume`** — Mark assertion as consumed
- Auth: Required (JWT)
- Calls: `hardware_key_service.consume_assertion(assertion_id, user_id)`
- Returns: `200` + `{"consumed": true, "consumed_at": "..."}`
- Errors: `404` not found, `410` already consumed, `410` expired

#### Asset Key Policy Endpoints

**`POST /keys/policies`** — Create a key policy for an asset
- Auth: Required (JWT + admin permission on asset)
- Body: `AssetKeyPolicyCreate` (asset_type, asset_id, protected_action, required_key_count, required_key_ids?)
- Returns: `201` + `AssetKeyPolicyResponse`
- Errors: `403` not admin, `409` duplicate policy for same asset+action

**`GET /keys/policies`** — List key policies for an asset
- Auth: Required (JWT + read permission on asset)
- Query params: `asset_type`, `asset_id`
- Returns: `200` + `list[AssetKeyPolicyResponse]`

**`DELETE /keys/policies/:policy_id`** — Remove a key policy
- Auth: Required (JWT + admin permission on asset)
- Returns: `200` + `{"deleted": true}`

#### Encrypted Asset Data Endpoints

**`POST /keys/encrypted-data`** — Store client-encrypted payload
- Auth: Required (JWT + write permission on asset)
- Body: `EncryptedAssetStore` (asset_type, asset_id, encrypted_payload, encryption_algorithm, key_derivation_method, initialization_vector, authorized_key_ids)
- Calls: `encryption_service.store_encrypted_asset()`
- Returns: `201` + `EncryptedAssetResponse`
- Errors: `400` invalid key IDs, `403` no write permission

**`GET /keys/encrypted-data/:asset_type/:asset_id`** — Retrieve encrypted data (with optional key check)
- Auth: Required (JWT)
- Query params: `require_key_check=true` (default), `action=decrypt` (default)
- When `require_key_check=true`: calls `encryption_service.get_encrypted_asset_with_key_check()`
- When `require_key_check=false`: calls `encryption_service.get_encrypted_asset()` (base permission only)
- Returns: `200` + `EncryptedAssetResponse`
- Errors: `403` permission denied, `428` key assertion required (with details), `404` no encrypted data

**`GET /keys/encrypted-data`** — List encrypted assets for current user
- Auth: Required (JWT)
- Query params: `asset_type` (optional filter)
- Calls: `encryption_service.list_encrypted_assets_for_user()`
- Returns: `200` + `list[EncryptedAssetMetadata]` (no ciphertext)

**`DELETE /keys/encrypted-data/:asset_type/:asset_id`** — Delete encrypted asset data
- Auth: Required (JWT + admin permission on asset)
- Calls: `encryption_service.delete_encrypted_asset()`
- Returns: `200` + `{"deleted": true}`

### HTTP Status Code Conventions

| Status | Meaning |
|--------|---------|
| `200` | Success |
| `201` | Created |
| `400` | Invalid input / validation error |
| `401` | Not authenticated |
| `403` | Insufficient permission |
| `404` | Resource not found |
| `409` | Conflict (duplicate) |
| `410` | Gone (assertion expired or consumed) |
| `428` | Precondition Required (key assertion needed) |

The `428` status is particularly important — it tells the client "you have permission, but you need to touch your hardware key first." The response body includes:
```json
{
  "detail": "Hardware key assertion required",
  "asset_type": "chat_session",
  "asset_id": "...",
  "action": "decrypt",
  "required_key_count": 1,
  "assertions_present": 0
}
```

### Route Registration

Routes will be registered in the Robyn app setup, following the existing pattern in `apps/python/src/server/app.py`. All routes are prefixed under `/keys/` to namespace them clearly.

## Pydantic Models (additions to `models.py`)

```python
class HardwareKeyUpdate(BaseModel):
    friendly_name: str | None = None
    device_type: str | None = None

class AssetKeyPolicyCreate(BaseModel):
    asset_type: str
    asset_id: str  # uuid
    protected_action: str
    required_key_count: int = 1
    required_key_ids: list[str] | None = None  # optional specific key UUIDs

class AssetKeyPolicyResponse(BaseModel):
    id: str
    asset_type: str
    asset_id: str
    protected_action: str
    required_key_count: int
    required_key_ids: list[str] | None
    created_by_user_id: str | None
    created_at: str
    updated_at: str
```

## Files to Create/Modify

- [ ] `apps/python/src/server/routes/hardware_keys.py` — All route handlers (NEW)
- [ ] `apps/python/src/server/models.py` — Add remaining Pydantic models (MODIFY)
- [ ] `apps/python/src/server/app.py` — Register new routes (MODIFY)

## Acceptance Criteria

- [ ] All 12 endpoints implemented and return correct status codes
- [ ] JWT auth enforced on all endpoints via `require_user()`
- [ ] Permission checks use `has_resource_permission()` for asset operations
- [ ] `428` response for key-assertion-required scenarios includes actionable details
- [ ] Error responses follow `{"detail": "message"}` convention
- [ ] Routes registered and accessible in the running Robyn server
- [ ] Input validation via Pydantic models with clear error messages
- [ ] No raw binary data in JSON responses (base64 encoding at boundary)
- [ ] OpenAPI spec updated if auto-generated

## Test Strategy

- Integration tests against local Supabase dev server
- Test auth: missing token → 401, invalid token → 401
- Test CRUD: register key → list → get → update → deactivate
- Test assertion flow: create assertion → check status → consume
- Test policy flow: create policy → list → require assertion → delete
- Test encrypted data: store → retrieve with key check → retrieve without → delete
- Test error cases: 404, 409, 428, 410 for each relevant endpoint
- Test permission boundaries: user A cannot access user B's keys