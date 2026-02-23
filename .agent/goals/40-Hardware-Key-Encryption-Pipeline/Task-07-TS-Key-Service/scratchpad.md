# Task-07: TypeScript Key Service & Routes

> **Status**: 🟢 Complete
> **Phase**: 2 — Server Integration
> **Updated**: 2026-02-25
> **Completed**: 2026-02-25 (Session 26 — Implementation)
> **Depends On**: Task-04 (Python Key Service) ✅, Task-05 (Python Encryption Service) ✅, Task-06 (Python Routes) ✅
> **Branch**: `goal-40-hardware-key-encryption-server`

## Completion Summary

### What Was Done (Session 26 — Implementation)

All 4 phases implemented in a single session with zero npm dependencies added:

**Phase A: Foundation (4 files)**
- `src/config.ts` — Added 4 env vars: `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_KEY`, `SUPABASE_JWT_SECRET`; updated `isSupabaseConfigured()` to check `DATABASE_URL`
- `src/lib/db.ts` — Bun.sql wrapper with lazy singleton, localhost SSL auto-disable, `getDb()`, `closeDb()`, `isUniqueViolation()` helper
- `src/lib/auth.ts` — JWT decode + optional HMAC-SHA256 verification via Web Crypto API; `AuthUser`, `AuthenticationError`, `requireUser()`
- `src/models/hardware-keys.ts` — 13 interfaces (7 request/response + 6 internal), 11 error classes, 5 validation constant sets

**Phase B: Service Layer (2 files)**
- `src/services/hardware-key-service.ts` (933 lines) — 15 service functions: key CRUD (register, list, get, update, deactivate), assertion management (record, get, consume, list), policy CRUD (create, list, get, delete), `checkKeyProtectedAccess()`, `consumeMatchingAssertions()`; row converters, validators, dynamic UPDATE via `sql.unsafe()`
- `src/services/encryption-service.ts` (563 lines) — 7 service functions: store, get, getWithKeyCheck, list, delete, updateAuthorizedKeys, `_consumeMatchingAssertions()`; base64↔bytea converters, validators

**Phase C: Route Layer (1 file + 1 modified)**
- `src/routes/hardware-keys.ts` (1055 lines) — 18 route handlers with auth, body parsing, error→status mapping, boolean query param parsing, 428 response body construction
- `src/index.ts` — Added `import { registerHardwareKeyRoutes }` + registration call

**Phase D: Tests (1 file)**
- `tests/hardware-keys.test.ts` (1352 lines) — 97 tests covering all 18 endpoints, auth failures, body validation, service error→HTTP status mapping, query params, 428 response body, route registration, method-not-allowed, response shapes

### Test Results
- **97 new tests**: 97 pass, 0 fail
- **813 total tests**: 813 pass, 0 fail across 14 test files
- **TypeScript**: `tsc --noEmit` clean (0 errors)
- **No npm packages added**: Bun native only (Bun.sql, crypto.subtle, bun:test)

### Files Created/Modified

| Action | Path | Lines |
|--------|------|-------|
| CREATE | `apps/ts/src/lib/db.ts` | 98 |
| CREATE | `apps/ts/src/lib/auth.ts` | 177 |
| CREATE | `apps/ts/src/models/hardware-keys.ts` | 317 |
| CREATE | `apps/ts/src/services/hardware-key-service.ts` | 933 |
| CREATE | `apps/ts/src/services/encryption-service.ts` | 563 |
| CREATE | `apps/ts/src/routes/hardware-keys.ts` | 1055 |
| CREATE | `apps/ts/tests/hardware-keys.test.ts` | 1352 |
| MODIFY | `apps/ts/src/config.ts` | +16 lines (env vars + `isSupabaseConfigured`) |
| MODIFY | `apps/ts/src/index.ts` | +3 lines (import + registration) |

### Key Design Decisions
- **Dynamic UPDATE queries** use `sql.unsafe()` with positional params (`$1`, `$2`) — safe against injection while supporting dynamic SET clauses
- **Auth module** decodes JWT payload with optional signature verification; when `SUPABASE_JWT_SECRET` is set, HMAC-SHA256 is verified via Web Crypto
- **Tests mock auth + services** (not the DB), allowing full route-level coverage without a running database
- **Route registration order**: static paths (`/keys/register`, `/keys/assertions/status`) registered before parameterized (`/keys/:key_id`) to avoid mis-matching
- **`_userId` underscore prefix** on `updateAuthorizedKeys` — parameter kept for API parity with Python but not currently used in the query (Python logs it)

## Objective

Port the Python hardware key service, encryption service, and API routes to the TypeScript runtime (Bun). This provides feature parity across both runtimes so frontend consumers can target either backend.

## Context

The TypeScript runtime lives in `apps/ts/` and uses:
- **Bun 1.3.9** as the JavaScript runtime
- **Custom zero-dependency Router** (`src/router.ts`) — pattern-matching with `:param` segments, NOT Hono
- **`Bun.sql`** — Native PostgreSQL driver (tagged template literals, connection pooling, no npm packages)
- **`apps/ts/src/routes/`** — Existing route modules registered via `registerXxxRoutes(router)` pattern
- **`apps/ts/src/config.ts`** — Configuration from env vars
- **`apps/ts/src/storage/`** — In-memory storage abstractions (no Postgres yet)
- **`bun:test`** — Native test runner

The Python implementation (Tasks 04-06) defines the canonical API contract. The TypeScript implementation MUST match:
- Endpoint paths and HTTP methods (18 endpoints)
- Request/response JSON shapes (snake_case keys for parity)
- Status codes and error format (`{"detail": "message"}`)
- Permission and assertion semantics
- Binary ↔ base64 encoding at API boundary

## Research Findings

### Database: Bun Native SQL (`Bun.sql`)

✅ **Zero npm dependencies** — `import { sql, SQL } from "bun"` is built-in since Bun 1.2
- Tagged template literals: `sql\`SELECT * FROM users WHERE id = ${userId}\``
- Auto-reads `DATABASE_URL` env var for PostgreSQL connections
- Built-in connection pooling (configurable `max`, `idleTimeout`, `maxLifetime`)
- Returns arrays of objects by default (matches Python's `dict_row`)
- `sql.array()` for PostgreSQL array literals (`ANY(${sql.array(keyIds)})`)
- Transactions via `sql.begin(async tx => { ... })`
- Error handling via `SQL.PostgresError` with `.code` (e.g., `23505` for unique violation)
- SSL mode configurable via connection string `?sslmode=disable` for local Supabase

**Key difference from Python psycopg**: No per-request connection creation needed. Bun.sql manages its own pool internally with single event loop — no cross-loop issues like Python/Robyn had. We use a module-level `sql` instance.

### Auth: Minimal JWT Extraction

The Python runtime uses `require_user()` → Supabase `auth.get_user(token)`. The TS runtime has **no auth module yet**.

Plan: Create a minimal auth helper:
1. Extract `Authorization: Bearer <token>` from request headers
2. Verify with Supabase JS client (`@supabase/supabase-js`) or decode JWT manually
3. Return `{ identity: string }` (user UUID) or throw `AuthenticationError`

Since `@supabase/supabase-js` is not in TS dependencies, we'll use Bun's native crypto to decode and verify the JWT using `SUPABASE_JWT_SECRET`. This avoids adding a dependency and is fast.

### Naming Convention: snake_case

Both Python and existing TS routes use **snake_case** JSON keys (`thread_id`, `created_at`). TypeScript interfaces will also use snake_case field names to avoid a mapping layer. This gives true API parity.

## Architecture

### File Structure

```
apps/ts/src/
├── lib/
│   ├── db.ts                          # Bun.sql wrapper, connection factory
│   └── auth.ts                        # JWT verification, requireUser() helper
├── models/
│   └── hardware-keys.ts               # TypeScript interfaces (snake_case)
├── services/
│   ├── hardware-key-service.ts        # Key CRUD, assertions, policies, access checks
│   └── encryption-service.ts          # Encrypted asset CRUD, key-gated retrieval
├── routes/
│   └── hardware-keys.ts               # 18 HTTP route handlers
├── index.ts                           # MODIFIED: register hardware key routes
└── config.ts                          # MODIFIED: add DATABASE_URL, SUPABASE_JWT_SECRET
apps/ts/tests/
└── hardware-keys.test.ts              # Route-level tests with mocked services
```

### Layer Responsibilities

| Layer | Purpose | Key Pattern |
|-------|---------|-------------|
| `lib/db.ts` | Module-level `Bun.sql` instance, auto-reads `DATABASE_URL` | Single pool, no per-request creation needed |
| `lib/auth.ts` | JWT decode + verify using `SUPABASE_JWT_SECRET` | `requireUser(request)` → `{ identity: string }` or throws |
| `models/hardware-keys.ts` | TypeScript interfaces for all request/response shapes | snake_case field names matching Python Pydantic models |
| `services/hardware-key-service.ts` | 15 functions mirroring Python `hardware_key_service.py` | Tagged template SQL, custom error classes |
| `services/encryption-service.ts` | 7 functions mirroring Python `encryption_service.py` | Base64 ↔ bytea encoding, key-gated retrieval |
| `routes/hardware-keys.ts` | 18 handlers using Router pattern | `registerHardwareKeyRoutes(router)`, error catching |

## Implementation Plan

### Phase A: Foundation (lib + models + config)

- [ ] **`src/config.ts`** — Add `databaseUrl`, `supabaseJwtSecret` to `AppConfig`, `loadConfig()`
- [ ] **`src/lib/db.ts`** — Bun.sql wrapper:
  - Module-level `sql` instance from `DATABASE_URL`
  - `getDb()` accessor (returns the sql tagged template function)
  - `isDbConfigured()` check
  - SSL disable for localhost (matching Python pattern)
- [ ] **`src/lib/auth.ts`** — JWT auth helper:
  - `requireUser(request)` → `AuthUser` or throws `AuthenticationError`
  - Decode JWT, extract `sub` as user identity
  - Verify signature with `SUPABASE_JWT_SECRET` using Bun's native `crypto.subtle`
- [ ] **`src/models/hardware-keys.ts`** — TypeScript interfaces:
  - Request: `HardwareKeyRegistration`, `HardwareKeyUpdate`, `AssertionRecord`, `AssetKeyPolicyCreate`, `EncryptedAssetStore`, `EncryptedAssetKeyUpdate`
  - Response: `HardwareKeyResponse`, `AssertionResponse`, `AssetKeyPolicyResponse`, `KeyProtectedAccessResult`, `EncryptedAssetResponse`, `EncryptedAssetMetadata`, `KeyGatedRetrievalResult`
  - All snake_case field names

### Phase B: Service Layer

- [ ] **`src/services/hardware-key-service.ts`** — Port from Python:
  - Constants: `VALID_DEVICE_TYPES`, `VALID_ASSET_TYPES`, `VALID_PROTECTED_ACTIONS`
  - Validators: `validateDeviceType()`, `validateAssetType()`, `validateProtectedAction()`, `validateAssetScope()`
  - Error classes: `HardwareKeyError`, `HardwareKeyNotFoundError`, `HardwareKeyConflictError`, `AssertionNotFoundError`, `AssertionConsumedError`, `AssertionExpiredError`, `PolicyConflictError`, `InvalidInputError`
  - Row converters: `rowToHardwareKeyResponse()`, `rowToAssertionResponse()`, `rowToPolicyResponse()`
  - CRUD: `registerHardwareKey()`, `listUserHardwareKeys()`, `getHardwareKey()`, `updateHardwareKey()`, `deactivateHardwareKey()`
  - Assertions: `recordAssertion()`, `getAssertion()`, `consumeAssertion()`, `listValidAssertions()`
  - Policies: `createAssetKeyPolicy()`, `listAssetKeyPolicies()`, `getAssetKeyPolicy()`, `deleteAssetKeyPolicy()`
  - Access: `checkKeyProtectedAccess()`

- [ ] **`src/services/encryption-service.ts`** — Port from Python:
  - Constants: `VALID_ENCRYPTION_ALGORITHMS`, `VALID_KEY_DERIVATION_METHODS`
  - Validators: `validateEncryptionAlgorithm()`, `validateKeyDerivationMethod()`
  - Base64 helpers: `decodeBase64Field()`, `encodeBytesToBase64()`
  - Error classes: `KeyAssertionRequired`, `InsufficientKeyAssertions`, `InvalidAuthorizedKeys`, `EncryptedAssetNotFoundError`
  - CRUD: `storeEncryptedAsset()`, `getEncryptedAsset()`, `getEncryptedAssetWithKeyCheck()`, `listEncryptedAssetsForUser()`, `deleteEncryptedAsset()`, `updateAuthorizedKeys()`
  - Internal: `consumeMatchingAssertions()`, `validateAuthorizedKeyIds()`

### Phase C: Route Layer

- [ ] **`src/routes/hardware-keys.ts`** — 18 endpoints:
  - `registerHardwareKeyRoutes(router)` following existing `registerXxxRoutes()` pattern
  - Each handler: `requireUser()` → parse params/query/body → call service → format response
  - Error handling: catch specific error types → status codes, fallback to 500
  - HTTP 428 for key-gated access with structured JSON body
  - HTTP 410 for consumed/expired assertions
- [ ] **`src/index.ts`** — Import and register `registerHardwareKeyRoutes(router)`

### Phase D: Tests

- [ ] **`tests/hardware-keys.test.ts`** — Route-level tests:
  - Mock service layer (avoid needing live DB for unit tests)
  - Test all 18 endpoints for success + error paths
  - Verify status codes, JSON shapes, error format
  - Test auth rejection (no Bearer token, invalid token)
  - Test 428 structured response body
  - Test 410 for consumed/expired assertions

## Endpoints (18 total — matching Python exactly)

### Key CRUD (5 endpoints)
| Method | Path | Status Codes | Handler |
|--------|------|-------------|---------|
| POST | `/keys/register` | 201, 400, 409, 422 | `handleRegisterKey` |
| GET | `/keys` | 200 | `handleListKeys` |
| GET | `/keys/:key_id` | 200, 404 | `handleGetKey` |
| PATCH | `/keys/:key_id` | 200, 400, 404 | `handleUpdateKey` |
| DELETE | `/keys/:key_id` | 200, 404 | `handleDeactivateKey` |

### Assertion Management (4 endpoints)
| Method | Path | Status Codes | Handler |
|--------|------|-------------|---------|
| POST | `/keys/assertions` | 201, 400, 404, 422 | `handleRecordAssertion` |
| GET | `/keys/assertions` | 200 | `handleListAssertions` |
| GET | `/keys/assertions/status` | 200, 400, 422 | `handleCheckAssertionStatus` |
| POST | `/keys/assertions/:assertion_id/consume` | 200, 404, 410 | `handleConsumeAssertion` |

### Asset Key Policies (4 endpoints)
| Method | Path | Status Codes | Handler |
|--------|------|-------------|---------|
| POST | `/keys/policies` | 201, 400, 409, 422 | `handleCreatePolicy` |
| GET | `/keys/policies` | 200, 422 | `handleListPolicies` |
| GET | `/keys/policies/:policy_id` | 200, 404 | `handleGetPolicy` |
| DELETE | `/keys/policies/:policy_id` | 200, 404 | `handleDeletePolicy` |

### Encrypted Asset Data (5 endpoints)
| Method | Path | Status Codes | Handler |
|--------|------|-------------|---------|
| POST | `/keys/encrypted-data` | 201, 400, 422 | `handleStoreEncryptedAsset` |
| GET | `/keys/encrypted-data` | 200 | `handleListEncryptedAssets` |
| GET | `/keys/encrypted-data/:asset_type/:asset_id` | 200, 404, 428 | `handleGetEncryptedAsset` |
| DELETE | `/keys/encrypted-data/:asset_type/:asset_id` | 200, 404 | `handleDeleteEncryptedAsset` |
| PATCH | `/keys/encrypted-data/:asset_type/:asset_id/authorized-keys` | 200, 400, 404 | `handleUpdateAuthorizedKeys` |

## SQL Translation Notes

Python psycopg named params → Bun.sql tagged templates:

```python
# Python
result = await connection.execute(
    "SELECT * FROM hardware_keys WHERE id = %(key_id)s AND user_id = %(user_id)s",
    {"key_id": key_id, "user_id": user_id},
)
```

```typescript
// TypeScript (Bun.sql)
const rows = await sql`
  SELECT * FROM public.hardware_keys
  WHERE id = ${keyId} AND user_id = ${userId}
`;
```

PostgreSQL array params:
```python
# Python
"WHERE id = ANY(%(key_ids)s)", {"key_ids": key_ids}
```
```typescript
// TypeScript (Bun.sql)
sql`WHERE id = ANY(${sql.array(keyIds)})`
```

Unique constraint detection:
```python
# Python
if "hardware_keys_credential_id_unique" in str(database_error):
    raise HardwareKeyConflictError(...)
```
```typescript
// TypeScript (Bun.sql)
if (error instanceof SQL.PostgresError && error.code === "23505") {
    // 23505 = unique_violation, check constraint name in error.detail
    throw new HardwareKeyConflictError(...);
}
```

## Key Technical Details

1. **key_assertions has NO INSERT RLS** — The Python runtime uses a superuser/service_role connection that bypasses RLS. For TS, the `DATABASE_URL` should also be the service_role connection string (same as Python).

2. **Binary data (bytea ↔ base64)** — `encrypted_payload` and `initialization_vector` are `bytea` in Postgres. Bun.sql returns `Buffer` for bytea columns. We encode to base64 for API responses and decode from base64 for inserts.

3. **Timestamp formatting** — Python uses `datetime.isoformat().replace("+00:00", "Z")`. In TS, we'll use `new Date(value).toISOString()` which already produces `Z` suffix.

4. **SSL for local Supabase** — Local dev Supabase doesn't expose TLS. The Python runtime appends `?sslmode=disable` for localhost URLs. Bun.sql accepts `ssl: "disable"` in options or `?sslmode=disable` in connection string — same approach.

5. **RETURNING \*** — Used extensively by Python for INSERT/UPDATE. Bun.sql supports `RETURNING *` natively with PostgreSQL.

6. **`rowcount`** — Python's `result.rowcount` after UPDATE. In Bun.sql, the result array has a `.count` property for affected rows.

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Bun.sql bytea handling unclear | Could break binary data round-trip | Test base64 ↔ bytea early in Phase B |
| No existing auth in TS runtime | Auth module is net-new code | Keep minimal: JWT decode + verify, no middleware |
| `sql.array()` behavior with UUID arrays | Could fail for uuid[] column types | Test with actual Supabase dev server |
| Bun.sql `result.count` vs Python `rowcount` | Could miss affected row count | Verify in integration tests |

## Acceptance Criteria

- [ ] All 18 endpoints match Python implementation's contract (paths, methods, status codes)
- [ ] JWT auth enforced on all endpoints (401 on missing/invalid token)
- [ ] Same SQL queries executed against same Supabase tables/functions
- [ ] 428 Precondition Required response matches Python's structured JSON body
- [ ] 410 Gone for consumed/expired assertions
- [ ] Error responses follow `{"detail": "message"}` format
- [ ] Base64 encoding/decoding for binary data matches Python behavior
- [ ] TypeScript types provide compile-time safety for all request/response shapes
- [ ] Routes registered and accessible in the running Bun server
- [ ] Zero npm dependencies added for DB or auth (Bun native only)
- [ ] Tests pass for all endpoints
- [ ] Existing TS tests still pass (no regressions)

## Test Strategy

- **Unit tests** (Phase D): Mock service layer, test route handlers for:
  - Correct status codes for success and error paths
  - JSON response shapes match interfaces
  - Auth rejection without/with invalid token
  - Query parameter parsing (boolean strings, defaults)
  - 428 structured body contents
- **Integration tests** (post-implementation): Against live local Supabase dev server
  - Full CRUD cycle for keys, assertions, policies, encrypted data
  - Key-gated retrieval flow (create policy → record assertion → retrieve)
  - Cross-runtime parity: same input → same output from Python and TS

## Dependencies

- **Bun 1.2+** for native SQL support (have 1.3.9 ✅)
- **`DATABASE_URL`** env var pointing to Supabase Postgres
- **`SUPABASE_JWT_SECRET`** env var for JWT verification
- **No new npm packages** — all Bun native

## Notes

- The existing TS `storage/` module (InMemoryStorage) is NOT used for hardware keys — we go direct to Postgres via Bun.sql
- The `hardware_key_models.py` Python file is NOT used by Python routes — services define their own models. Same pattern in TS.
- Route registration order matters: `/keys/assertions/status` must be registered BEFORE `/keys/assertions/:assertion_id` to avoid path parameter capture
- Similarly: `/keys/register`, `/keys/assertions`, `/keys/policies`, `/keys/encrypted-data` must come before `/keys/:key_id`

---

## Implementation Reference (for next session)

This section contains all file paths, patterns, and critical details needed to implement without re-reading the entire codebase.

### Existing TS Patterns to Follow

#### Route Registration Pattern (`src/routes/health.ts` as reference)

```typescript
import type { Router } from "../router";
import { jsonResponse, errorResponse } from "./helpers";

export function registerHardwareKeyRoutes(router: Router): void {
  // Static paths BEFORE parameterized paths
  router.post("/keys/register", handleRegisterKey);
  router.get("/keys/assertions/status", handleCheckAssertionStatus);
  router.get("/keys/assertions", handleListAssertions);
  router.post("/keys/assertions", handleRecordAssertion);
  router.get("/keys/policies", handleListPolicies);
  router.post("/keys/policies", handleCreatePolicy);
  router.post("/keys/encrypted-data", handleStoreEncryptedAsset);
  router.get("/keys/encrypted-data", handleListEncryptedAssets);
  // Parameterized paths
  router.post("/keys/assertions/:assertion_id/consume", handleConsumeAssertion);
  router.get("/keys/policies/:policy_id", handleGetPolicy);
  router.delete("/keys/policies/:policy_id", handleDeletePolicy);
  router.get("/keys/encrypted-data/:asset_type/:asset_id", handleGetEncryptedAsset);
  router.delete("/keys/encrypted-data/:asset_type/:asset_id", handleDeleteEncryptedAsset);
  router.patch("/keys/encrypted-data/:asset_type/:asset_id/authorized-keys", handleUpdateAuthorizedKeys);
  router.get("/keys/:key_id", handleGetKey);
  router.patch("/keys/:key_id", handleUpdateKey);
  router.delete("/keys/:key_id", handleDeactivateKey);
  router.get("/keys", handleListKeys);
}
```

#### Route Handler Signature (`src/router.ts` RouteHandler type)

```typescript
type RouteHandler = (
  request: Request,
  params: Record<string, string>,
  query: URLSearchParams,
) => Response | Promise<Response>;
```

- `params` = extracted `:param` path segments (e.g., `params.key_id`)
- `query` = parsed URL search params (e.g., `query.get("include_inactive")`)

#### Helper Functions Available (`src/routes/helpers.ts`)

- `jsonResponse(data, status?, headers?)` — JSON 200 by default
- `errorResponse(detail, status?)` — `{"detail": "..."}` shape, 500 by default
- `notFound(detail?)` — 404
- `methodNotAllowed(detail?)` — 405
- `conflictResponse(detail)` — 409
- `validationError(detail, errors?)` — 422
- `parseBody<T>(request)` — returns `T | null`
- `requireBody<T>(request)` — returns `[T, null] | [null, Response]`

**Missing helper needed**: No 428 helper exists. Build the 428 response inline in the route handler (matching Python which also builds it inline with `Response(428, headers, body)`).

#### Index.ts Registration (`src/index.ts`)

Add after the last `register*Routes(router)` call:
```typescript
import { registerHardwareKeyRoutes } from "./routes/hardware-keys";
registerHardwareKeyRoutes(router);
```

#### Config Pattern (`src/config.ts`)

Add to `AppConfig` interface:
```typescript
databaseUrl: string | undefined;
supabaseUrl: string | undefined;
supabaseKey: string | undefined;
supabaseJwtSecret: string | undefined;
```

Add to `loadConfig()`:
```typescript
databaseUrl: process.env.DATABASE_URL || undefined,
supabaseUrl: process.env.SUPABASE_URL || undefined,
supabaseKey: process.env.SUPABASE_KEY || undefined,
supabaseJwtSecret: process.env.SUPABASE_JWT_SECRET || undefined,
```

### Bun.sql Usage Patterns

#### Module-level DB instance (`src/lib/db.ts`)

```typescript
import { SQL, sql as defaultSql } from "bun";

// Bun auto-reads DATABASE_URL for the default `sql` export.
// For explicit control or local SSL disable:
let _sql: ReturnType<typeof SQL> | null = null;

export function getDb() {
  if (!_sql) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL not configured");
    // Local Supabase: append sslmode=disable if localhost
    const needsSslDisable = (url.includes("localhost") || url.includes("127.0.0.1")) && !url.includes("sslmode");
    const separator = url.includes("?") ? "&" : "?";
    const connUrl = needsSslDisable ? `${url}${separator}sslmode=disable` : url;
    _sql = new SQL(connUrl);
  }
  return _sql;
}
```

#### Query patterns

```typescript
const sql = getDb();

// SELECT returning array of objects
const rows = await sql`SELECT * FROM public.hardware_keys WHERE user_id = ${userId}`;
const firstRow = rows[0]; // or undefined

// INSERT ... RETURNING *
const [row] = await sql`
  INSERT INTO public.hardware_keys (user_id, credential_id, public_key)
  VALUES (${userId}, ${credentialId}, ${publicKeyBytes})
  RETURNING *
`;

// UPDATE ... RETURNING *
const [updated] = await sql`
  UPDATE public.hardware_keys SET friendly_name = ${name}
  WHERE id = ${keyId} AND user_id = ${userId}
  RETURNING *
`;
// If no row matched, `updated` is undefined

// DELETE ... RETURNING id
const [deleted] = await sql`
  DELETE FROM public.asset_key_policies WHERE id = ${policyId}
  RETURNING id
`;

// PostgreSQL array params
const rows = await sql`
  SELECT id FROM public.hardware_keys WHERE id = ANY(${sql.array(keyIds)})
`;

// Count queries
const [{ assertion_count }] = await sql`
  SELECT COUNT(*) AS assertion_count FROM public.key_assertions
  WHERE user_id = ${userId} AND consumed = false AND expires_at > now()
`;

// UPDATE without RETURNING (affected row count)
const result = await sql`
  UPDATE public.key_assertions SET consumed = true, consumed_at = now()
  WHERE user_id = ${userId} AND consumed = false AND expires_at > now()
`;
// result.count gives affected rows
```

#### Error handling

```typescript
import { SQL } from "bun";

try {
  const [row] = await sql`INSERT INTO ... RETURNING *`;
} catch (error) {
  if (error instanceof SQL.PostgresError) {
    // 23505 = unique_violation
    if (error.code === "23505") {
      throw new HardwareKeyConflictError(credentialId);
    }
  }
  throw error;
}
```

#### Binary data (bytea ↔ base64)

```typescript
// Decode base64 string to Buffer for INSERT into bytea column
function decodeBase64Field(value: string, fieldName: string): Buffer {
  try {
    // Handle both standard base64 and base64url
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    return Buffer.from(padded, "base64");
  } catch {
    throw new InvalidInputError(`Invalid base64 encoding for ${fieldName}`);
  }
}

// Encode Buffer from bytea to base64 string for API response
function encodeBytesToBase64(value: Buffer | Uint8Array): string {
  return Buffer.from(value).toString("base64");
}

// In row converter:
const encryptedPayload = row.encrypted_payload;
// Bun.sql returns bytea as Buffer — encode to base64
const base64Payload = Buffer.isBuffer(encryptedPayload)
  ? encryptedPayload.toString("base64")
  : String(encryptedPayload);
```

### Auth Module (`src/lib/auth.ts`)

```typescript
export interface AuthUser {
  identity: string;
  email?: string;
}

export class AuthenticationError extends Error {
  readonly statusCode = 401;
  constructor(message: string) {
    super(message);
    this.name = "AuthenticationError";
  }
}

export async function requireUser(request: Request): Promise<AuthUser> {
  const authHeader = request.headers.get("authorization") || request.headers.get("Authorization");
  if (!authHeader) throw new AuthenticationError("Authorization header missing");

  const parts = authHeader.split(" ");
  if (parts.length !== 2 || parts[0].toLowerCase() !== "bearer") {
    throw new AuthenticationError("Invalid authorization header format");
  }
  const token = parts[1];

  // Decode JWT payload (base64url middle segment)
  // For dev: decode only. For prod: verify with SUPABASE_JWT_SECRET using crypto.subtle HMAC-SHA256
  const jwtSecret = process.env.SUPABASE_JWT_SECRET;
  // ... verify signature if jwtSecret is available ...
  // Extract sub claim as user identity
  const payload = JSON.parse(
    Buffer.from(token.split(".")[1], "base64url").toString()
  );
  if (!payload.sub) throw new AuthenticationError("Invalid token: no sub claim");

  return { identity: payload.sub, email: payload.email };
}
```

### Error Class Hierarchy

Mirror Python's hierarchy — all extend a base class with `statusCode`:

```typescript
export class HardwareKeyError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode = 500) {
    super(message);
    this.name = "HardwareKeyError";
    this.statusCode = statusCode;
  }
}

export class HardwareKeyNotFoundError extends HardwareKeyError {
  constructor(keyId: string) {
    super(`Hardware key ${keyId} not found`, 404);
    this.name = "HardwareKeyNotFoundError";
  }
}

export class HardwareKeyConflictError extends HardwareKeyError {
  constructor(credentialId: string) {
    super(`Hardware key with credential_id '${credentialId}' already exists`, 409);
    this.name = "HardwareKeyConflictError";
  }
}

export class AssertionNotFoundError extends HardwareKeyError {
  constructor(assertionId: string) {
    super(`Assertion ${assertionId} not found`, 404);
    this.name = "AssertionNotFoundError";
  }
}

export class AssertionConsumedError extends HardwareKeyError {
  constructor(assertionId: string) {
    super(`Assertion ${assertionId} has already been consumed`, 410);
    this.name = "AssertionConsumedError";
  }
}

export class AssertionExpiredError extends HardwareKeyError {
  constructor(assertionId: string) {
    super(`Assertion ${assertionId} has expired`, 410);
    this.name = "AssertionExpiredError";
  }
}

export class PolicyConflictError extends HardwareKeyError {
  constructor(assetType: string, assetId: string, action: string) {
    super(`Policy already exists for ${assetType}/${assetId} action '${action}'`, 409);
    this.name = "PolicyConflictError";
  }
}

export class InvalidInputError extends HardwareKeyError {
  constructor(message: string) {
    super(message, 400);
    this.name = "InvalidInputError";
  }
}

// Encryption service errors
export class KeyAssertionRequired extends HardwareKeyError {
  constructor(
    public readonly assetType: string,
    public readonly assetId: string,
    public readonly action: string,
    public readonly requiredCount: number = 1,
    public readonly assertionsPresent: number = 0,
  ) {
    super(`Hardware key assertion required: ${requiredCount} key touch(es) needed`, 428);
    this.name = "KeyAssertionRequired";
  }
}

export class InvalidAuthorizedKeys extends HardwareKeyError {
  constructor(public readonly invalidKeyIds: string[]) {
    super(`Invalid authorized key IDs (not found): ${JSON.stringify(invalidKeyIds)}`, 400);
    this.name = "InvalidAuthorizedKeys";
  }
}

export class EncryptedAssetNotFoundError extends HardwareKeyError {
  constructor(assetType: string, assetId: string) {
    super(`No encrypted data found for ${assetType}/${assetId}`, 404);
    this.name = "EncryptedAssetNotFoundError";
  }
}
```

### TypeScript Interfaces (`src/models/hardware-keys.ts`)

Use snake_case field names matching Python Pydantic output and DB columns:

```typescript
// --- Request types ---
export interface HardwareKeyRegistration {
  credential_id: string;
  public_key: string;
  counter?: number;
  transports?: string[];
  friendly_name?: string | null;
  device_type?: string | null;
  attestation_format?: string | null;
  aaguid?: string | null;
}

export interface HardwareKeyUpdate {
  friendly_name?: string | null;
  device_type?: string | null;
}

export interface AssertionRecord {
  hardware_key_id: string;
  challenge: string;
  asset_type?: string | null;
  asset_id?: string | null;
}

export interface AssetKeyPolicyCreate {
  asset_type: string;
  asset_id: string;
  protected_action: string;
  required_key_count?: number;
  required_key_ids?: string[] | null;
}

export interface EncryptedAssetStore {
  asset_type: string;
  asset_id: string;
  encrypted_payload: string;
  encryption_algorithm?: string;
  key_derivation_method?: string;
  initialization_vector: string;
  authorized_key_ids: string[];
}

export interface EncryptedAssetKeyUpdate {
  authorized_key_ids: string[];
  encrypted_payload?: string | null;
  initialization_vector?: string | null;
}

// --- Response types ---
export interface HardwareKeyResponse {
  id: string;
  credential_id: string;
  friendly_name: string | null;
  device_type: string | null;
  transports: string[];
  attestation_format: string | null;
  aaguid: string | null;
  is_active: boolean;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AssertionResponse {
  assertion_id: string;
  hardware_key_id: string;
  expires_at: string;
  consumed: boolean;
  asset_type: string | null;
  asset_id: string | null;
}

export interface AssetKeyPolicyResponse {
  id: string;
  asset_type: string;
  asset_id: string;
  protected_action: string;
  required_key_count: number;
  required_key_ids: string[] | null;
  created_by_user_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface KeyProtectedAccessResult {
  allowed: boolean;
  reason: string;
  requires_assertion: boolean;
  required_key_count: number | null;
  assertions_present: number | null;
}

export interface EncryptedAssetResponse {
  id: string;
  asset_type: string;
  asset_id: string;
  encrypted_payload: string;
  encryption_algorithm: string;
  key_derivation_method: string;
  initialization_vector: string;
  authorized_key_ids: string[];
  encrypted_by_user_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface EncryptedAssetMetadata {
  id: string;
  asset_type: string;
  asset_id: string;
  encryption_algorithm: string;
  key_derivation_method: string;
  authorized_key_ids: string[];
  encrypted_by_user_id: string | null;
  created_at: string;
}

export interface KeyGatedRetrievalResult {
  access: KeyProtectedAccessResult;
  data: EncryptedAssetResponse | null;
}
```

### Constants (mirror Python exactly)

```typescript
export const VALID_DEVICE_TYPES = new Set([
  "solokey", "yubikey", "titan", "nitrokey", "onlykey",
  "trezor", "ledger", "platform", "other",
]);

export const VALID_ASSET_TYPES = new Set([
  "repository", "project", "document", "document_artifact",
  "chat_session", "agent", "ontology", "processing_profile", "ai_engine",
]);

export const VALID_PROTECTED_ACTIONS = new Set([
  "decrypt", "delete", "export", "share", "sign", "all_writes", "admin",
]);

export const VALID_ENCRYPTION_ALGORITHMS = new Set([
  "AES-GCM-256", "AES-CBC-256", "ChaCha20-Poly1305",
]);

export const VALID_KEY_DERIVATION_METHODS = new Set([
  "webauthn-prf-hkdf", "webauthn-hmac-secret-hkdf",
  "passphrase-pbkdf2", "shamir-recombine",
]);
```

### Route Handler Error Catching Pattern

Every handler follows this pattern (matching Python):

```typescript
async function handleRegisterKey(
  request: Request,
  _params: Record<string, string>,
  _query: URLSearchParams,
): Promise<Response> {
  // 1. Auth
  let user: AuthUser;
  try {
    user = await requireUser(request);
  } catch (error) {
    if (error instanceof AuthenticationError) {
      return errorResponse(error.message, 401);
    }
    return errorResponse("Authentication failed", 401);
  }

  // 2. Parse body
  const [body, bodyError] = await requireBody<HardwareKeyRegistration>(request);
  if (bodyError) return bodyError;

  // 3. Call service with error catching
  try {
    const sql = getDb();
    const result = await registerHardwareKey(sql, user.identity, body);
    return jsonResponse(result, 201);
  } catch (error) {
    if (error instanceof HardwareKeyConflictError) {
      return errorResponse(error.message, 409);
    }
    if (error instanceof InvalidInputError) {
      return errorResponse(error.message, 400);
    }
    if (error instanceof HardwareKeyError) {
      return errorResponse(error.message, error.statusCode);
    }
    console.error("Unexpected error registering hardware key:", error);
    return errorResponse("Internal server error", 500);
  }
}
```

### 428 Response Body (key-gated GET encrypted data)

The Python route builds this inline — TS should match exactly:

```typescript
// When key check fails (access denied):
const errorBody = {
  detail: "Hardware key assertion required",
  asset_type: assetType,
  asset_id: assetId,
  action: action,
  requires_assertion: accessResult.requires_assertion,
  required_key_count: accessResult.required_key_count,
  assertions_present: accessResult.assertions_present,
  reason: accessResult.reason,
};
return new Response(JSON.stringify(errorBody), {
  status: 428,
  headers: { "Content-Type": "application/json" },
});
```

### Row Converter Functions

```typescript
function formatTimestamp(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function rowToHardwareKeyResponse(row: Record<string, unknown>): HardwareKeyResponse {
  return {
    id: String(row.id),
    credential_id: String(row.credential_id),
    friendly_name: row.friendly_name != null ? String(row.friendly_name) : null,
    device_type: row.device_type != null ? String(row.device_type) : null,
    transports: (row.transports as string[]) ?? [],
    attestation_format: row.attestation_format != null ? String(row.attestation_format) : null,
    aaguid: row.aaguid != null ? String(row.aaguid) : null,
    is_active: Boolean(row.is_active ?? true),
    last_used_at: formatTimestamp(row.last_used_at),
    created_at: formatTimestamp(row.created_at)!,
    updated_at: formatTimestamp(row.updated_at)!,
  };
}

function rowToAssertionResponse(row: Record<string, unknown>): AssertionResponse {
  return {
    assertion_id: String(row.id),
    hardware_key_id: String(row.hardware_key_id),
    expires_at: formatTimestamp(row.expires_at)!,
    consumed: Boolean(row.consumed ?? false),
    asset_type: row.asset_type != null ? String(row.asset_type) : null,
    asset_id: row.asset_id != null ? String(row.asset_id) : null,
  };
}

function rowToPolicyResponse(row: Record<string, unknown>): AssetKeyPolicyResponse {
  const rawKeyIds = row.required_key_ids as string[] | null;
  return {
    id: String(row.id),
    asset_type: String(row.asset_type),
    asset_id: String(row.asset_id),
    protected_action: String(row.protected_action),
    required_key_count: Number(row.required_key_count),
    required_key_ids: rawKeyIds ? rawKeyIds.map(String) : null,
    created_by_user_id: row.created_by_user_id != null ? String(row.created_by_user_id) : null,
    created_at: formatTimestamp(row.created_at)!,
    updated_at: formatTimestamp(row.updated_at)!,
  };
}

function rowToEncryptedAssetResponse(row: Record<string, unknown>): EncryptedAssetResponse {
  const payload = row.encrypted_payload;
  const iv = row.initialization_vector;
  const rawKeyIds = (row.authorized_key_ids as string[]) ?? [];
  return {
    id: String(row.id),
    asset_type: String(row.asset_type),
    asset_id: String(row.asset_id),
    encrypted_payload: Buffer.isBuffer(payload) ? payload.toString("base64") : String(payload),
    encryption_algorithm: String(row.encryption_algorithm),
    key_derivation_method: String(row.key_derivation_method),
    initialization_vector: Buffer.isBuffer(iv) ? iv.toString("base64") : String(iv),
    authorized_key_ids: rawKeyIds.map(String),
    encrypted_by_user_id: row.encrypted_by_user_id != null ? String(row.encrypted_by_user_id) : null,
    created_at: formatTimestamp(row.created_at)!,
    updated_at: formatTimestamp(row.updated_at)!,
  };
}

function rowToEncryptedAssetMetadata(row: Record<string, unknown>): EncryptedAssetMetadata {
  const rawKeyIds = (row.authorized_key_ids as string[]) ?? [];
  return {
    id: String(row.id),
    asset_type: String(row.asset_type),
    asset_id: String(row.asset_id),
    encryption_algorithm: String(row.encryption_algorithm),
    key_derivation_method: String(row.key_derivation_method),
    authorized_key_ids: rawKeyIds.map(String),
    encrypted_by_user_id: row.encrypted_by_user_id != null ? String(row.encrypted_by_user_id) : null,
    created_at: formatTimestamp(row.created_at)!,
  };
}
```

### Test Pattern (`tests/hardware-keys.test.ts`)

Follow existing pattern from `tests/threads.test.ts`:

```typescript
import { describe, expect, test, beforeEach, mock } from "bun:test";
import { router } from "../src/index";

function makeRequest(path: string, method = "GET", body?: unknown): Request {
  const options: RequestInit = { method };
  if (body !== undefined) {
    options.headers = { "Content-Type": "application/json" };
    options.body = JSON.stringify(body);
  }
  return new Request(`http://localhost:3000${path}`, options);
}

// For auth-required endpoints, add Authorization header:
function makeAuthRequest(path: string, method = "GET", body?: unknown): Request {
  const options: RequestInit = { method };
  const headers: Record<string, string> = {
    Authorization: "Bearer <test-jwt-with-valid-sub>",
  };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }
  options.headers = headers;
  return new Request(`http://localhost:3000${path}`, options);
}
```

**Test approach**: Mock the service functions (not the DB) so tests don't need a running Supabase. Use `mock.module()` or direct function mocking in Bun.

### Critical Python Source Files (for 1:1 porting reference)

| Python File | Lines | What to port |
|-------------|-------|-------------|
| `apps/python/src/server/hardware_key_service.py` L90-166 | Pydantic request models | → `models/hardware-keys.ts` request interfaces |
| `apps/python/src/server/hardware_key_service.py` L174-272 | Pydantic response models | → `models/hardware-keys.ts` response interfaces |
| `apps/python/src/server/hardware_key_service.py` L280-358 | Error classes | → `services/hardware-key-service.ts` error classes |
| `apps/python/src/server/hardware_key_service.py` L366-522 | Validators + row converters | → `services/hardware-key-service.ts` helpers |
| `apps/python/src/server/hardware_key_service.py` L530-1331 | 15 service functions | → `services/hardware-key-service.ts` functions |
| `apps/python/src/server/encryption_service.py` L78-288 | Models + errors + validators | → `services/encryption-service.ts` |
| `apps/python/src/server/encryption_service.py` L489-915 | 7 service functions + helpers | → `services/encryption-service.ts` functions |
| `apps/python/src/server/routes/hardware_keys.py` L72-837 | 18 route handlers | → `routes/hardware-keys.ts` handlers |
| `apps/python/src/server/auth.py` | Auth module | → `lib/auth.ts` (simplified) |
| `apps/python/src/server/database.py` | DB module | → `lib/db.ts` (simplified — Bun.sql, no per-request needed) |

### GET Encrypted Data Route (most complex endpoint)

This is the most complex handler — has 3 query params and branching logic:

```
GET /keys/encrypted-data/:asset_type/:asset_id
  ?require_key_check=true|false  (default: true)
  ?action=decrypt|delete|...     (default: "decrypt")
  ?auto_consume=true|false       (default: true)
```

When `require_key_check=true`:
1. Call `getEncryptedAssetWithKeyCheck()` → returns `KeyGatedRetrievalResult`
2. If `access.allowed === false` → return 428 with structured body
3. If `access.allowed === true` → return the full result

When `require_key_check=false`:
1. Call `getEncryptedAsset()` → returns `EncryptedAssetResponse | null`
2. If null → 404
3. Return the asset

Boolean query param parsing (matching Python):
```typescript
function parseBooleanQuery(value: string | null, defaultValue: boolean): boolean {
  if (value === null) return defaultValue;
  return ["true", "1", "yes"].includes(value.toLowerCase());
}
```

### Dynamic UPDATE query (updateHardwareKey)

Python builds SET clauses dynamically. In Bun.sql, use SQL fragments:

```typescript
async function updateHardwareKey(sql, userId, keyId, updates) {
  // Build SET clause from provided fields
  const setClauses: ReturnType<typeof sql>[] = [];
  if (updates.friendly_name !== undefined) {
    setClauses.push(sql`friendly_name = ${updates.friendly_name}`);
  }
  if (updates.device_type !== undefined) {
    setClauses.push(sql`device_type = ${updates.device_type}`);
  }
  if (setClauses.length === 0) {
    return getHardwareKey(sql, userId, keyId);
  }
  // Join fragments: sql`SET ${setClauses[0]}, ${setClauses[1]}`
  // Or use sql.unsafe for the dynamic SET (less ideal) — test what works
}
```

**Note**: Bun.sql fragment joining for dynamic SET clauses may need experimentation. The Python code uses string concatenation with psycopg named params. If Bun.sql fragments don't compose easily, consider separate UPDATE queries for each field or use `sql.unsafe()` carefully.

### Deactivate Key Response Shape

Python returns `{"deactivated": true, "key": <HardwareKeyResponse dict>}` — NOT a bare HardwareKeyResponse. The key field is the `.model_dump(mode="json")` of the Pydantic model:

```typescript
return jsonResponse({
  deactivated: true,
  key: rowToHardwareKeyResponse(row),
});
```

### Files Modified (exact paths)

| Action | Path |
|--------|------|
| CREATE | `apps/ts/src/lib/db.ts` |
| CREATE | `apps/ts/src/lib/auth.ts` |
| CREATE | `apps/ts/src/models/hardware-keys.ts` |
| CREATE | `apps/ts/src/services/hardware-key-service.ts` |
| CREATE | `apps/ts/src/services/encryption-service.ts` |
| CREATE | `apps/ts/src/routes/hardware-keys.ts` |
| CREATE | `apps/ts/tests/hardware-keys.test.ts` |
| MODIFY | `apps/ts/src/config.ts` — add 4 env vars to AppConfig + loadConfig() |
| MODIFY | `apps/ts/src/index.ts` — add import + registerHardwareKeyRoutes(router) |
