# Task-03: Server-Side Key Services (Python + TypeScript Runtimes)

> **Status**: 🟡 In Progress
> **Phase**: 1 — Foundation
> **Updated**: 2026-02-23
> **Depends On**: Task-01 (Protocol Design ✅), Task-02 (Supabase Schema ✅)

## Objective

Implement the server-side services and API endpoints for hardware key management in both the Python (Robyn) and TypeScript (Bun/Hono) runtimes. This includes key registration orchestration, assertion verification relay, encrypted asset CRUD, and key-protected access middleware.

## Success Criteria

- [ ] Python `hardware_key_service.py` — CRUD for hardware keys, assertion verification relay, assertion consumption
- [ ] Python `encryption_service.py` — Encrypted asset CRUD, key-protected access checks
- [ ] Python `/keys/*` API routes — RESTful endpoints for all key operations
- [ ] Python key-protection middleware — Intercepts protected operations, demands assertion
- [ ] TypeScript equivalent services and routes
- [ ] `pg_cron` migration for assertion cleanup (every 5 min)
- [ ] Integration tests against local Supabase dev server
- [ ] All existing tests still pass

## Architecture Decisions

### Where Services Live

```
apps/python/src/server/
├── hardware_key_service.py     # NEW — Key registration, listing, deactivation
├── encryption_service.py       # NEW — Encrypted asset CRUD + access checks
├── routes/
│   └── keys.py                 # NEW — /keys/* endpoints
├── auth.py                     # EXISTING — Extend with key assertion middleware
├── database.py                 # EXISTING — Reuse per-request connection pattern
└── config.py                   # EXISTING — No changes needed

apps/ts/src/
├── routes/
│   └── keys.ts                 # NEW — /keys/* endpoints
├── services/
│   ├── hardware-key-service.ts # NEW
│   └── encryption-service.ts   # NEW
└── config.ts                   # EXISTING
```

### Design Principles

1. **Server never sees plaintext key material** — PRF output, KEK, DEK all stay client-side
2. **Server orchestrates, client encrypts** — Server stores ciphertext, checks assertions, enforces policies
3. **Per-request connections** — Follow existing `database.py` pattern (no shared pool)
4. **Edge Function for assertion INSERT** — Runtime relays to Edge Function; no direct key_assertions INSERT
5. **Supabase client for RLS-aware queries** — Use authenticated Supabase client (respects RLS) for user-facing ops; direct Postgres for admin ops

### Assertion Flow: Runtime ↔ Edge Function

```
Client → Runtime → Edge Function → Postgres
         (relay)   (verify+insert)  (key_assertions)

The runtime does NOT verify WebAuthn signatures directly.
It relays the assertion to the Edge Function which:
  1. Verifies the cryptographic signature against hardware_keys.public_key
  2. Increments hardware_keys.counter (clone detection)
  3. INSERTs into key_assertions (bypassing RLS via service_role)
  4. Returns assertion_id + expires_at to runtime
  5. Runtime can then check has_key_protected_access() via Postgres
```

**Why not verify in the runtime?**
- `key_assertions` has no INSERT RLS policy (by design)
- Edge Function runs with `service_role` key (can bypass RLS)
- Keeps WebAuthn verification logic in one place
- Runtime stays stateless — just checks assertion existence via SQL

**Interim approach (until Edge Function exists):**
- Python runtime can verify assertions directly using `py_webauthn`
- Uses `service_role` Supabase client or direct Postgres for INSERT
- Marked as `# TODO: migrate to Edge Function` in code

## Implementation Plan

### File-by-File Breakdown

#### 1. `apps/python/src/server/hardware_key_service.py`

```python
# Functions:
async def list_user_keys(user_id: uuid) -> list[HardwareKeyInfo]
async def get_key_by_credential_id(credential_id: str) -> HardwareKeyInfo | None
async def register_key(user_id, credential_id, public_key, ...) -> HardwareKeyInfo
async def deactivate_key(user_id, key_id) -> bool
async def update_key_name(user_id, key_id, friendly_name) -> bool
async def generate_registration_challenge(user_id) -> RegistrationChallenge
async def verify_registration_response(user_id, response) -> HardwareKeyInfo
async def generate_assertion_challenge(user_id, asset_type?, asset_id?) -> AssertionChallenge
async def verify_assertion_response(user_id, response, asset_type?, asset_id?) -> KeyAssertion
async def consume_assertion(assertion_id) -> bool
async def check_key_protected_access(user_id, asset_type, asset_id, action) -> bool
```

#### 2. `apps/python/src/server/encryption_service.py`

```python
# Functions:
async def store_encrypted_asset(user_id, asset_type, asset_id, payload, ...) -> EncryptedAssetRecord
async def get_encrypted_asset(user_id, asset_type, asset_id) -> EncryptedAssetRecord | None
async def list_encrypted_assets(user_id, asset_type?) -> list[EncryptedAssetRecord]
async def delete_encrypted_asset(user_id, asset_type, asset_id) -> bool
async def get_asset_key_policy(asset_type, asset_id, action) -> KeyPolicy | None
async def set_asset_key_policy(user_id, asset_type, asset_id, action, ...) -> KeyPolicy
async def remove_asset_key_policy(user_id, asset_type, asset_id, action) -> bool
```

#### 3. `apps/python/src/server/routes/keys.py`

```
GET    /keys                          → List user's hardware keys
POST   /keys/register/begin           → Generate registration challenge
POST   /keys/register/complete        → Verify registration + store key
PATCH  /keys/:key_id                  → Update friendly name
DELETE /keys/:key_id                  → Deactivate key
POST   /keys/assert/begin             → Generate assertion challenge
POST   /keys/assert/complete          → Verify assertion + create assertion record
GET    /keys/assertions/status        → Check if user has valid assertion for asset
POST   /encrypted-assets              → Store encrypted payload
GET    /encrypted-assets/:type/:id    → Get encrypted payload (requires assertion)
DELETE /encrypted-assets/:type/:id    → Delete encrypted payload (requires assertion)
GET    /key-policies/:type/:id        → Get key policies for asset
POST   /key-policies                  → Create/update key policy
DELETE /key-policies/:type/:id/:action → Remove key policy
```

#### 4. `pg_cron` migration (follow-up, not in this repo)

```sql
-- Enable pg_cron extension
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Schedule assertion cleanup every 5 minutes
SELECT cron.schedule(
  'cleanup-expired-key-assertions',
  '*/5 * * * *',
  $$ SELECT public.cleanup_expired_key_assertions(); $$
);
```

#### 5. Pydantic models (`apps/python/src/server/models.py` — extend)

```python
class HardwareKeyInfo(BaseModel): ...
class RegistrationChallenge(BaseModel): ...
class AssertionChallenge(BaseModel): ...
class KeyAssertion(BaseModel): ...
class EncryptedAssetRecord(BaseModel): ...
class KeyPolicy(BaseModel): ...
```

### Dependencies to Add

**Python (`apps/python/pyproject.toml`):**
- `py-webauthn` — WebAuthn registration/assertion verification
- `cbor2` — CBOR decoding for COSE public keys (transitive dep of py-webauthn)

**TypeScript (`apps/ts/package.json`):**
- `@simplewebauthn/server` — WebAuthn verification server-side

## Test Strategy

1. **Unit tests** — Mock Supabase responses, test service logic
2. **Integration tests** — Against local Supabase dev server
   - Register a key (with mock WebAuthn credential)
   - Store encrypted asset
   - Set key policy
   - Verify assertion check logic
   - Test assertion expiry and consumption
3. **RLS verification** — Confirm users can only see their own keys

## Risk Assessment

| Risk | Mitigation |
|------|------------|
| Edge Function not yet built | Interim: verify in runtime with `py_webauthn`, mark for migration |
| `py_webauthn` version compatibility | Pin specific version, test in CI |
| WebAuthn mock data for tests | Use `py_webauthn` test utilities or generate test credentials |
| RLS policy gaps | Verify with integration tests using authenticated Supabase client |

## Progress Log

### 2026-02-23 — Session 22
- Created task directory and scratchpad
- Full schema analysis complete (see Goal 40 scratchpad for inventory)
- Architecture decisions documented
- Implementation plan finalized
- Ready to implement Python services first, then TS