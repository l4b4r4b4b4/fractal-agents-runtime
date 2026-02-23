# Task-07: TypeScript Key Service & Routes

> **Status**: ⚪ Not Started
> **Phase**: 2 — Server Integration
> **Updated**: 2026-02-23
> **Depends On**: Task-04 (Python Key Service) ✅, Task-05 (Python Encryption Service) ✅, Task-06 (Python Routes) ✅

## Objective

Port the Python hardware key service, encryption service, and API routes to the TypeScript runtime (Bun/Hono). This provides feature parity across both runtimes so frontend consumers can target either backend.

## Context

The TypeScript runtime lives in `apps/ts/` and uses:
- **Bun** as the JavaScript runtime
- **Hono** (or similar) as the HTTP framework
- **`apps/ts/src/routes/`** — Existing route modules (assistants, threads, runs, health, etc.)
- **`apps/ts/src/config.ts`** — Configuration
- **`apps/ts/src/storage/`** — Storage abstractions

The Python implementation (Tasks 04-06) defines the canonical API contract. The TypeScript implementation MUST match the same:
- Endpoint paths and HTTP methods
- Request/response JSON shapes
- Status codes and error format (`{"detail": "message"}`)
- Permission and assertion semantics

### Existing TS Route Pattern (from `apps/ts/src/routes/`)

Routes are defined as Hono route handlers and registered in `apps/ts/src/router.ts`. Auth is handled via middleware that extracts the Supabase user from the JWT `Authorization` header.

## Implementation Plan

### Service Layer

#### File: `apps/ts/src/services/hardware-key-service.ts`

Mirror of Python `hardware_key_service.py`:

- `registerHardwareKey(userId, registration)` → INSERT into `hardware_keys`
- `listUserHardwareKeys(userId)` → SELECT active keys
- `getHardwareKey(userId, keyId)` → SELECT single key
- `updateHardwareKey(userId, keyId, updates)` → UPDATE metadata fields
- `deactivateHardwareKey(userId, keyId)` → SET `is_active = false`
- `verifyAndRecordAssertion(userId, verification)` → INSERT into `key_assertions`
- `consumeAssertion(assertionId, userId)` → SET `consumed = true`
- `checkKeyProtectedAccess(userId, assetType, assetId, action)` → call SQL `has_key_protected_access()`

#### File: `apps/ts/src/services/encryption-service.ts`

Mirror of Python `encryption_service.py`:

- `storeEncryptedAsset(userId, data)` → INSERT into `encrypted_asset_data`
- `getEncryptedAsset(userId, assetType, assetId)` → SELECT with base permission check
- `getEncryptedAssetWithKeyCheck(userId, assetType, assetId, action)` → SELECT + assertion gate
- `listEncryptedAssetsForUser(userId, assetType?)` → SELECT metadata only
- `deleteEncryptedAsset(userId, assetType, assetId)` → DELETE with admin check
- `updateAuthorizedKeys(userId, assetType, assetId, newKeyIds, newPayload?, newIv?)` → UPDATE for key rotation

### TypeScript Types

#### File: `apps/ts/src/models/hardware-keys.ts`

```typescript
interface HardwareKeyRegistration {
  credentialId: string;        // base64url
  publicKey: string;           // base64url-encoded COSE key
  counter: number;
  transports: string[];
  friendlyName?: string;
  deviceType?: string;
  attestationFormat?: string;
  aaguid?: string;
}

interface HardwareKeyResponse {
  id: string;                  // uuid
  credentialId: string;
  friendlyName: string | null;
  deviceType: string | null;
  transports: string[];
  isActive: boolean;
  lastUsedAt: string | null;
  createdAt: string;
}

interface HardwareKeyUpdate {
  friendlyName?: string;
  deviceType?: string;
}

interface AssertionVerification {
  hardwareKeyId: string;       // uuid
  challenge: string;
  assetType?: string;
  assetId?: string;
}

interface AssertionResponse {
  assertionId: string;
  expiresAt: string;
  consumed: boolean;
}

interface AssetKeyPolicyCreate {
  assetType: string;
  assetId: string;
  protectedAction: string;
  requiredKeyCount?: number;   // default 1
  requiredKeyIds?: string[];
}

interface AssetKeyPolicyResponse {
  id: string;
  assetType: string;
  assetId: string;
  protectedAction: string;
  requiredKeyCount: number;
  requiredKeyIds: string[] | null;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface EncryptedAssetStore {
  assetType: string;
  assetId: string;
  encryptedPayload: string;        // base64
  encryptionAlgorithm?: string;    // default "AES-GCM-256"
  keyDerivationMethod?: string;    // default "webauthn-prf-hkdf"
  initializationVector: string;    // base64
  authorizedKeyIds: string[];
}

interface EncryptedAssetResponse {
  id: string;
  assetType: string;
  assetId: string;
  encryptedPayload: string;
  encryptionAlgorithm: string;
  keyDerivationMethod: string;
  initializationVector: string;
  authorizedKeyIds: string[];
  encryptedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface EncryptedAssetMetadata {
  id: string;
  assetType: string;
  assetId: string;
  encryptionAlgorithm: string;
  keyDerivationMethod: string;
  authorizedKeyIds: string[];
  encryptedByUserId: string | null;
  createdAt: string;
}

interface KeyProtectedAccessResult {
  allowed: boolean;
  reason: string;
  requiresAssertion: boolean;
  requiredKeyCount: number | null;
  assertionsPresent: number | null;
}
```

### Route Layer

#### File: `apps/ts/src/routes/hardware-keys.ts`

Same endpoints as Python Task-06, same paths, same semantics:

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/keys/register` | Register a new hardware key |
| `GET` | `/keys` | List user's registered hardware keys |
| `GET` | `/keys/:keyId` | Get a specific hardware key |
| `PATCH` | `/keys/:keyId` | Update hardware key metadata |
| `DELETE` | `/keys/:keyId` | Deactivate a hardware key |
| `POST` | `/keys/assertions` | Record a verified key assertion |
| `GET` | `/keys/assertions/status` | Check assertion status for an asset |
| `POST` | `/keys/assertions/:assertionId/consume` | Mark assertion as consumed |
| `POST` | `/keys/policies` | Create a key policy for an asset |
| `GET` | `/keys/policies` | List key policies for an asset |
| `DELETE` | `/keys/policies/:policyId` | Remove a key policy |
| `POST` | `/keys/encrypted-data` | Store client-encrypted payload |
| `GET` | `/keys/encrypted-data/:assetType/:assetId` | Retrieve encrypted data |
| `GET` | `/keys/encrypted-data` | List encrypted assets metadata |
| `DELETE` | `/keys/encrypted-data/:assetType/:assetId` | Delete encrypted asset data |

### Naming Convention: snake_case ↔ camelCase

- **Database columns**: `snake_case` (Postgres convention) — `hardware_key_id`, `asset_type`, `created_at`
- **TypeScript types/API**: `camelCase` — `hardwareKeyId`, `assetType`, `createdAt`
- **JSON API responses**: `camelCase` (TypeScript convention)
- **Python API responses**: `snake_case` (Python convention)

Both runtimes serve the same logical API. The frontend must handle the naming convention of whichever runtime it targets. If we want true parity, we could normalize to one convention (e.g., `snake_case` everywhere since Supabase PostgREST uses it). **Decision deferred** — follow each language's convention for now, normalize later if needed.

## Database Access

The TS runtime's DB access pattern needs to be verified. Looking at:
- `apps/ts/src/storage/` for existing Postgres integration patterns
- Whether it uses `pg` (node-postgres), `postgres.js`, or Supabase client directly

The service layer will use whatever DB client is already established in the TS runtime.

## Files to Create/Modify

- [ ] `apps/ts/src/models/hardware-keys.ts` — TypeScript type definitions (NEW)
- [ ] `apps/ts/src/services/hardware-key-service.ts` — Key management service (NEW)
- [ ] `apps/ts/src/services/encryption-service.ts` — Encryption data service (NEW)
- [ ] `apps/ts/src/routes/hardware-keys.ts` — HTTP route handlers (NEW)
- [ ] `apps/ts/src/router.ts` — Register new routes (MODIFY)

## Acceptance Criteria

- [ ] All 15 endpoints match Python implementation's contract
- [ ] JWT auth enforced on all endpoints
- [ ] Permission checks match Python behavior (same SQL functions called)
- [ ] `428` Precondition Required response for key-assertion-required scenarios
- [ ] Error responses follow `{"detail": "message"}` format
- [ ] Base64 encoding/decoding for binary data matches Python behavior
- [ ] TypeScript types provide compile-time safety for all request/response shapes
- [ ] Routes registered and accessible in the running Bun server
- [ ] Integration tests pass against local Supabase dev server

## Test Strategy

- Mirror Python integration tests in TypeScript
- Use `bun test` for unit tests
- Integration tests against same local Supabase dev server
- Cross-runtime parity check: same input → same output from both Python and TS endpoints
- Verify snake_case/camelCase handling is consistent within each runtime

## Dependencies

- Existing TS runtime DB client (to be determined from `apps/ts/src/storage/`)
- No new npm packages expected — Bun has native crypto and fetch
- `@simplewebauthn/server` only if we add WebAuthn verification to the TS runtime (deferred — Edge Function handles this)

## Notes

- This task is intentionally sequenced AFTER the Python implementation so the Python version serves as the reference implementation
- Any API contract changes discovered during Python implementation should be reflected here before starting
- The TS runtime may have a different DB connection pattern (Supabase client vs. raw Postgres) — adapt the service layer accordingly