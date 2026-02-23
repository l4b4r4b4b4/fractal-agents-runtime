# Task-05: Python Encryption Service

> **Status**: ⚪ Not Started
> **Phase**: 2 — Server Integration
> **Updated**: 2026-02-23
> **Depends On**: Task-04 (Python Key Service)

## Objective

Build the Python server-side encryption service module for managing encrypted asset data: storing client-encrypted payloads, retrieving encrypted data with authorization checks, validating key-protected access before returning sensitive data, and coordinating with the hardware key service for assertion-based gating.

## Context

The `encrypted_asset_data` table stores client-side encrypted payloads (the server **never** sees plaintext). The encryption service doesn't encrypt or decrypt — it manages the encrypted blobs and enforces that hardware key assertions are valid before allowing access to ciphertext.

### Why the Server Doesn't Decrypt

The entire point of hardware key encryption is **client-side control**:
1. Client encrypts with a key derived from hardware key PRF output
2. Server stores ciphertext + metadata (algorithm, IV, authorized key IDs)
3. Client requests ciphertext (server checks assertion validity first)
4. Client decrypts locally using hardware key PRF output

The server is a **gatekeeper**, not a decryption engine. It verifies assertions and returns ciphertext only to authorized, key-verified users.

### Exception: Server-Side Decryption for LLM Pipeline

For the vLLM integration (Task-08), there IS a server-side decryption path where:
- Client sends encrypted context + key material (via JWE) to the runtime
- Runtime decrypts in-memory, passes plaintext to vLLM
- Plaintext is immediately zeroized after inference completes

This exception is NOT part of this task — it's scoped to Task-08.

## Implementation Plan

### File: `apps/python/src/server/encryption_service.py`

**Store Encrypted Data:**
- `store_encrypted_asset(user_id, asset_type, asset_id, encrypted_payload, encryption_algorithm, key_derivation_method, initialization_vector, authorized_key_ids)` → INSERT into `encrypted_asset_data`
- Validates: asset_type enum, authorized_key_ids non-empty, all referenced key IDs exist in `hardware_keys`
- Returns: created `EncryptedAssetData` model with ID

**Retrieve Encrypted Data:**
- `get_encrypted_asset(user_id, asset_type, asset_id)` → SELECT from `encrypted_asset_data`
- Checks: base resource permission via `has_resource_permission()`
- Returns: `EncryptedAssetData` model (ciphertext + metadata) or None

**Retrieve with Key Assertion Gate:**
- `get_encrypted_asset_with_key_check(user_id, asset_type, asset_id, action='decrypt')` → SELECT + assertion check
- Step 1: Look up `asset_key_policies` for this asset + action
- Step 2: If no policy exists, fall through to base permission check
- Step 3: If policy exists, verify valid assertion via `has_key_protected_access()`
- Step 4: If multi-key policy, verify sufficient distinct assertions via `has_multi_key_access()`
- Step 5: Consume the assertion(s) used
- Returns: `EncryptedAssetData` model OR raises `KeyAssertionRequired` error

**List Encrypted Assets for User:**
- `list_encrypted_assets_for_user(user_id, asset_type?)` → SELECT with optional type filter
- Returns: list of `EncryptedAssetMetadata` (no ciphertext, just IDs + metadata)

**Delete Encrypted Data:**
- `delete_encrypted_asset(user_id, asset_type, asset_id)` → DELETE from `encrypted_asset_data`
- Requires admin permission on the asset
- Returns: boolean (deleted or not found)

**Update Authorized Keys (Key Rotation):**
- `update_authorized_keys(user_id, asset_type, asset_id, new_authorized_key_ids, new_encrypted_payload?, new_iv?)` → UPDATE
- Used during key rotation: client re-encrypts DEK with new KEK, uploads new ciphertext
- Validates: caller has admin permission, new key IDs exist

### Pydantic Models (extend `apps/python/src/server/models.py`)

```python
class EncryptedAssetStore(BaseModel):
    asset_type: str
    asset_id: str  # uuid
    encrypted_payload: str  # base64-encoded bytes
    encryption_algorithm: str = "AES-GCM-256"
    key_derivation_method: str = "webauthn-prf-hkdf"
    initialization_vector: str  # base64-encoded bytes
    authorized_key_ids: list[str]  # list of hardware_key UUIDs

class EncryptedAssetResponse(BaseModel):
    id: str
    asset_type: str
    asset_id: str
    encrypted_payload: str  # base64-encoded bytes
    encryption_algorithm: str
    key_derivation_method: str
    initialization_vector: str  # base64-encoded bytes
    authorized_key_ids: list[str]
    encrypted_by_user_id: str | None
    created_at: str
    updated_at: str

class EncryptedAssetMetadata(BaseModel):
    """Lightweight metadata without the actual ciphertext."""
    id: str
    asset_type: str
    asset_id: str
    encryption_algorithm: str
    key_derivation_method: str
    authorized_key_ids: list[str]
    encrypted_by_user_id: str | None
    created_at: str

class KeyProtectedAccessResult(BaseModel):
    allowed: bool
    reason: str
    requires_assertion: bool
    required_key_count: int | None
    assertions_present: int | None
```

### Custom Exceptions

```python
class KeyAssertionRequired(Exception):
    """Raised when an operation requires a hardware key assertion that hasn't been provided."""
    def __init__(self, asset_type: str, asset_id: str, action: str, required_count: int = 1):
        self.asset_type = asset_type
        self.asset_id = asset_id
        self.action = action
        self.required_count = required_count

class InsufficientKeyAssertions(Exception):
    """Raised when multi-key policy requires more assertions than currently available."""
    def __init__(self, required: int, present: int, asset_type: str, asset_id: str):
        self.required = required
        self.present = present
        self.asset_type = asset_type
        self.asset_id = asset_id

class InvalidAuthorizedKeys(Exception):
    """Raised when authorized_key_ids reference non-existent hardware keys."""
    def __init__(self, invalid_key_ids: list[str]):
        self.invalid_key_ids = invalid_key_ids
```

## Design Decisions

### Base64 Encoding for Binary Data in API

`encrypted_payload` and `initialization_vector` are `bytea` in Postgres but transmitted as base64 strings in the API. The service layer handles encoding/decoding at the boundary:
- API receives base64 string → service decodes to bytes → stores as bytea
- DB returns bytea → service encodes to base64 → API returns string

### Assertion Consumption Strategy

When `get_encrypted_asset_with_key_check()` succeeds:
- **Single-key**: The matching assertion is consumed immediately
- **Multi-key**: All contributing assertions are consumed in a single transaction
- Consumption is transactional with the response — if sending the response fails, assertions are NOT consumed (rollback)

### Connection Pattern

Same as Task-04: per-request `async with get_connection() as conn:` following `database.py` conventions.

## Files to Create/Modify

- [ ] `apps/python/src/server/encryption_service.py` — Core encryption service module (NEW)
- [ ] `apps/python/src/server/models.py` — Add Pydantic models for encrypted assets (MODIFY)

## Acceptance Criteria

- [ ] `store_encrypted_asset()` validates inputs and inserts into `encrypted_asset_data`
- [ ] `get_encrypted_asset()` returns ciphertext + metadata with base permission check
- [ ] `get_encrypted_asset_with_key_check()` enforces key policy assertions before returning ciphertext
- [ ] `get_encrypted_asset_with_key_check()` raises `KeyAssertionRequired` when assertion is missing
- [ ] `get_encrypted_asset_with_key_check()` raises `InsufficientKeyAssertions` for multi-key gaps
- [ ] `list_encrypted_assets_for_user()` returns metadata without ciphertext
- [ ] `delete_encrypted_asset()` requires admin permission
- [ ] `update_authorized_keys()` supports key rotation workflow
- [ ] Assertion consumption is transactional with data retrieval
- [ ] Base64 encoding/decoding at API boundary is correct
- [ ] All functions have type annotations and docstrings
- [ ] Custom exceptions carry enough context for meaningful error responses

## Test Strategy

- Unit tests with mocked DB for service logic and validation
- Integration tests: store → retrieve → key-check → consume flow
- Edge cases: missing assertion, expired assertion, wrong user, multi-key threshold not met
- Key rotation flow: update authorized keys + new ciphertext
- Verify base64 round-trip fidelity for binary data