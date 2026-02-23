/**
 * Integration test script for all 18 hardware key endpoints.
 *
 * Runs against a live TS server + Supabase Postgres. Tests are sequential
 * because later endpoints depend on data created by earlier ones (register
 * key → create assertion → create policy → store encrypted data → …).
 *
 * Usage:
 *   # 1. Start local Supabase (port 54322 Postgres, 54321 API)
 *   # 2. Start the TS runtime:
 *   DATABASE_URL="postgresql://postgres:postgres@localhost:54322/postgres" \
 *   SUPABASE_JWT_SECRET="super-secret-jwt-token-with-at-least-32-characters-long" \
 *   bun run src/index.ts
 *   # 3. Run this script (in a second terminal):
 *   bun run tests/integration/hardware-keys-integration.ts
 *
 * Environment variables (all optional — sensible defaults for local dev):
 *   BASE_URL          — Server base URL (default: http://localhost:3000)
 *   TEST_USER_ID      — UUID of user in auth.users (default: a1b2c3d4-…)
 *   TEST_USER_EMAIL   — Email for the JWT (default: adm-lcansino@ais-management.de)
 *   SUPABASE_JWT_SECRET — JWT signing secret (default: super-secret-jwt-…)
 *
 * The script exits with code 0 if all tests pass, 1 otherwise.
 */

// =============================================================================
// Configuration
// =============================================================================

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const TEST_USER_ID =
  process.env.TEST_USER_ID ?? "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const TEST_USER_EMAIL =
  process.env.TEST_USER_EMAIL ?? "adm-lcansino@ais-management.de";
const JWT_SECRET =
  process.env.SUPABASE_JWT_SECRET ??
  "super-secret-jwt-token-with-at-least-32-characters-long";

// Unique per run so parallel / repeated runs don't collide.
const RUN_ID = crypto.randomUUID().slice(0, 8);
const CREDENTIAL_ID = `integ-${RUN_ID}`;
const ASSET_ID = crypto.randomUUID();

// =============================================================================
// JWT helper — sign a real HS256 JWT via Web Crypto
// =============================================================================

async function signJwt(
  payload: Record<string, unknown>,
  secret: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const header = { alg: "HS256", typ: "JWT" };
  const headerBase64 = bufferToBase64Url(
    encoder.encode(JSON.stringify(header)),
  );
  const payloadBase64 = bufferToBase64Url(
    encoder.encode(JSON.stringify(payload)),
  );
  const data = `${headerBase64}.${payloadBase64}`;

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signatureBytes = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(data)),
  );
  const signature = bufferToBase64Url(signatureBytes);
  return `${data}.${signature}`;
}

function bufferToBase64Url(buffer: Uint8Array): string {
  let binary = "";
  for (const byte of buffer) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// =============================================================================
// HTTP helpers
// =============================================================================

interface TestResult {
  name: string;
  passed: boolean;
  status?: number;
  error?: string;
  duration_ms: number;
}

const results: TestResult[] = [];
let authToken = "";

async function generateAuthToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: TEST_USER_ID,
    email: TEST_USER_EMAIL,
    aud: "authenticated",
    role: "authenticated",
    iat: now,
    exp: now + 3600,
  };
  return signJwt(payload, JWT_SECRET);
}

async function request(
  method: string,
  path: string,
  options: {
    body?: unknown;
    query?: Record<string, string>;
    expectStatus?: number | number[];
    skipAuth?: boolean;
  } = {},
): Promise<{ status: number; data: unknown; headers: Headers }> {
  const url = new URL(path, BASE_URL);
  if (options.query) {
    for (const [key, value] of Object.entries(options.query)) {
      url.searchParams.set(key, value);
    }
  }

  const headers: Record<string, string> = {};
  if (!options.skipAuth) {
    headers["Authorization"] = `Bearer ${authToken}`;
  }
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(url.toString(), {
    method,
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  let data: unknown;
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    data = await response.json();
  } else {
    data = await response.text();
  }

  return { status: response.status, data, headers: response.headers };
}

// =============================================================================
// Assertion helpers
// =============================================================================

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertIncludes(actual: unknown[], expected: unknown, label: string): void {
  if (!actual.includes(expected)) {
    throw new Error(`${label}: expected array to include ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertIsArray(value: unknown, label: string): asserts value is unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label}: expected array, got ${typeof value}: ${JSON.stringify(value)}`);
  }
}

function assertIsObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label}: expected object, got ${typeof value}: ${JSON.stringify(value)}`);
  }
}

function assertHasProperty(
  obj: Record<string, unknown>,
  property: string,
  label: string,
): void {
  if (!(property in obj)) {
    throw new Error(`${label}: missing property '${property}' in ${JSON.stringify(Object.keys(obj))}`);
  }
}

function assertTruthy(value: unknown, label: string): void {
  if (!value) {
    throw new Error(`${label}: expected truthy, got ${JSON.stringify(value)}`);
  }
}

// =============================================================================
// Test runner
// =============================================================================

async function runTest(
  name: string,
  testFunction: () => Promise<void>,
): Promise<void> {
  const start = performance.now();
  try {
    await testFunction();
    const duration = performance.now() - start;
    results.push({ name, passed: true, duration_ms: Math.round(duration) });
    console.log(`  ✅ ${name} (${Math.round(duration)}ms)`);
  } catch (error) {
    const duration = performance.now() - start;
    const message = error instanceof Error ? error.message : String(error);
    results.push({ name, passed: false, error: message, duration_ms: Math.round(duration) });
    console.log(`  ❌ ${name} (${Math.round(duration)}ms)`);
    console.log(`     ${message}`);
  }
}

// =============================================================================
// Shared state — populated by earlier tests, consumed by later ones
// =============================================================================

let registeredKeyId = "";
let assertionId = "";
let secondAssertionId = "";
let policyId = "";

// =============================================================================
// Tests — Phase 1: Health check & auth guard
// =============================================================================

async function testHealthCheck(): Promise<void> {
  const { status, data } = await request("GET", "/health", { skipAuth: true });
  assertEqual(status, 200, "status");
  assertIsObject(data, "body");
  assertEqual((data as Record<string, unknown>).status, "ok", "body.status");
}

async function testAuthGuard(): Promise<void> {
  const { status } = await request("GET", "/keys", { skipAuth: true });
  assertEqual(status, 401, "status");
}

// =============================================================================
// Tests — Phase 2: Key CRUD (endpoints 1–5)
// =============================================================================

async function testRegisterKey(): Promise<void> {
  // Generate a fake 65-byte public key (uncompressed ECDSA P-256 format)
  const fakePublicKey = Buffer.from(
    new Uint8Array(65).fill(0x04, 0, 1).fill(0xab, 1),
  ).toString("base64");

  const { status, data } = await request("POST", "/keys/register", {
    body: {
      credential_id: CREDENTIAL_ID,
      public_key: fakePublicKey,
      transports: ["usb", "nfc"],
      friendly_name: `Integration Test Key ${RUN_ID}`,
      device_type: "yubikey",
      attestation_format: "packed",
      aaguid: "00000000-0000-0000-0000-000000000000",
    },
    expectStatus: 201,
  });

  assertEqual(status, 201, "status");
  assertIsObject(data, "body");
  const body = data as Record<string, unknown>;
  assertHasProperty(body, "id", "body");
  assertHasProperty(body, "credential_id", "body");
  assertEqual(body.credential_id, CREDENTIAL_ID, "credential_id");
  assertEqual(body.device_type, "yubikey", "device_type");
  assertEqual(body.is_active, true, "is_active");

  // Verify transports came back as a proper array (Bun.sql array bug check)
  assertIsArray(body.transports, "transports");
  const transports = body.transports as string[];
  assertIncludes(transports, "usb", "transports includes usb");
  assertIncludes(transports, "nfc", "transports includes nfc");
  assertEqual(transports.length, 2, "transports length");

  registeredKeyId = String(body.id);
}

async function testRegisterKeyDuplicate(): Promise<void> {
  const fakePublicKey = Buffer.from(new Uint8Array(65).fill(0x04)).toString("base64");
  const { status } = await request("POST", "/keys/register", {
    body: {
      credential_id: CREDENTIAL_ID,
      public_key: fakePublicKey,
    },
  });
  assertEqual(status, 409, "status (duplicate)");
}

async function testListKeys(): Promise<void> {
  const { status, data } = await request("GET", "/keys");
  assertEqual(status, 200, "status");
  assertIsArray(data, "body");
  const keys = data as Record<string, unknown>[];
  assertTruthy(keys.length >= 1, "at least 1 key");
  const found = keys.find(
    (key) => key.credential_id === CREDENTIAL_ID,
  );
  assertTruthy(found, "registered key appears in list");
}

async function testGetKey(): Promise<void> {
  const { status, data } = await request("GET", `/keys/${registeredKeyId}`);
  assertEqual(status, 200, "status");
  assertIsObject(data, "body");
  const body = data as Record<string, unknown>;
  assertEqual(body.id, registeredKeyId, "id");
  assertEqual(body.credential_id, CREDENTIAL_ID, "credential_id");
}

async function testGetKeyNotFound(): Promise<void> {
  const fakeId = "00000000-0000-0000-0000-000000000000";
  const { status } = await request("GET", `/keys/${fakeId}`);
  assertEqual(status, 404, "status");
}

async function testUpdateKey(): Promise<void> {
  const newName = `Updated Key ${RUN_ID}`;
  const { status, data } = await request("PATCH", `/keys/${registeredKeyId}`, {
    body: { friendly_name: newName },
  });
  assertEqual(status, 200, "status");
  assertIsObject(data, "body");
  assertEqual((data as Record<string, unknown>).friendly_name, newName, "friendly_name");
}

// =============================================================================
// Tests — Phase 3: Assertion management (endpoints 6–9)
// =============================================================================

async function testRecordAssertion(): Promise<void> {
  const { status, data } = await request("POST", "/keys/assertions", {
    body: {
      hardware_key_id: registeredKeyId,
      challenge: Buffer.from("test-challenge-" + RUN_ID).toString("base64"),
      asset_type: "document",
      asset_id: ASSET_ID,
    },
  });
  assertEqual(status, 201, "status");
  assertIsObject(data, "body");
  const body = data as Record<string, unknown>;
  assertHasProperty(body, "assertion_id", "body");
  assertEqual(body.hardware_key_id, registeredKeyId, "hardware_key_id");
  assertEqual(body.consumed, false, "consumed");
  assertEqual(body.asset_type, "document", "asset_type");
  assertEqual(body.asset_id, ASSET_ID, "asset_id");

  assertionId = String(body.assertion_id);
}

async function testRecordSecondAssertion(): Promise<void> {
  // Create a second assertion for later key-gated access tests
  const { status, data } = await request("POST", "/keys/assertions", {
    body: {
      hardware_key_id: registeredKeyId,
      challenge: Buffer.from("challenge-2-" + RUN_ID).toString("base64"),
      asset_type: "document",
      asset_id: ASSET_ID,
    },
  });
  assertEqual(status, 201, "status");
  assertIsObject(data, "body");
  secondAssertionId = String((data as Record<string, unknown>).assertion_id);
}

async function testListAssertions(): Promise<void> {
  const { status, data } = await request("GET", "/keys/assertions", {
    query: { asset_type: "document", asset_id: ASSET_ID },
  });
  assertEqual(status, 200, "status");
  assertIsArray(data, "body");
  const assertions = data as Record<string, unknown>[];
  assertTruthy(assertions.length >= 2, "at least 2 assertions");
}

async function testCheckAssertionStatus(): Promise<void> {
  const { status, data } = await request("GET", "/keys/assertions/status", {
    query: {
      asset_type: "document",
      asset_id: ASSET_ID,
      action: "decrypt",
    },
  });
  assertEqual(status, 200, "status");
  assertIsObject(data, "body");
  const body = data as Record<string, unknown>;
  assertHasProperty(body, "allowed", "body");
  assertHasProperty(body, "reason", "body");
  // Without a policy, default behaviour should allow access
  assertEqual(body.allowed, true, "allowed");
}

async function testConsumeAssertion(): Promise<void> {
  const { status, data } = await request(
    "POST",
    `/keys/assertions/${assertionId}/consume`,
  );
  assertEqual(status, 200, "status");
  assertIsObject(data, "body");
  const body = data as Record<string, unknown>;
  assertEqual(body.consumed, true, "consumed");
  assertEqual(body.assertion_id, assertionId, "assertion_id");
}

async function testConsumeAssertionAlreadyConsumed(): Promise<void> {
  const { status } = await request(
    "POST",
    `/keys/assertions/${assertionId}/consume`,
  );
  assertEqual(status, 410, "status (already consumed)");
}

async function testConsumeAssertionNotFound(): Promise<void> {
  const fakeId = "00000000-0000-0000-0000-000000000000";
  const { status } = await request("POST", `/keys/assertions/${fakeId}/consume`);
  assertEqual(status, 404, "status (not found)");
}

// =============================================================================
// Tests — Phase 4: Asset key policies (endpoints 10–13)
// =============================================================================

async function testCreatePolicy(): Promise<void> {
  const { status, data } = await request("POST", "/keys/policies", {
    body: {
      asset_type: "document",
      asset_id: ASSET_ID,
      protected_action: "decrypt",
      required_key_count: 1,
      required_key_ids: [registeredKeyId],
    },
  });
  assertEqual(status, 201, "status");
  assertIsObject(data, "body");
  const body = data as Record<string, unknown>;
  assertHasProperty(body, "id", "body");
  assertEqual(body.asset_type, "document", "asset_type");
  assertEqual(body.asset_id, ASSET_ID, "asset_id");
  assertEqual(body.protected_action, "decrypt", "protected_action");
  assertEqual(body.required_key_count, 1, "required_key_count");

  // Verify required_key_ids came back as array (Bun.sql uuid[] bug check)
  assertIsArray(body.required_key_ids, "required_key_ids");
  const keyIds = body.required_key_ids as string[];
  assertEqual(keyIds.length, 1, "required_key_ids length");
  assertEqual(keyIds[0], registeredKeyId, "required_key_ids[0]");

  policyId = String(body.id);
}

async function testCreatePolicyDuplicate(): Promise<void> {
  const { status } = await request("POST", "/keys/policies", {
    body: {
      asset_type: "document",
      asset_id: ASSET_ID,
      protected_action: "decrypt",
      required_key_count: 1,
    },
  });
  assertEqual(status, 409, "status (duplicate policy)");
}

async function testListPolicies(): Promise<void> {
  const { status, data } = await request("GET", "/keys/policies", {
    query: { asset_type: "document", asset_id: ASSET_ID },
  });
  assertEqual(status, 200, "status");
  assertIsArray(data, "body");
  const policies = data as Record<string, unknown>[];
  assertTruthy(policies.length >= 1, "at least 1 policy");
  const found = policies.find((policy) => policy.id === policyId);
  assertTruthy(found, "created policy appears in list");
}

async function testGetPolicy(): Promise<void> {
  const { status, data } = await request("GET", `/keys/policies/${policyId}`);
  assertEqual(status, 200, "status");
  assertIsObject(data, "body");
  const body = data as Record<string, unknown>;
  assertEqual(body.id, policyId, "id");
  assertEqual(body.protected_action, "decrypt", "protected_action");

  // Verify required_key_ids still correct after round-trip
  assertIsArray(body.required_key_ids, "required_key_ids");
  assertEqual((body.required_key_ids as string[])[0], registeredKeyId, "required_key_ids[0]");
}

async function testGetPolicyNotFound(): Promise<void> {
  const fakeId = "00000000-0000-0000-0000-000000000000";
  const { status } = await request("GET", `/keys/policies/${fakeId}`);
  assertEqual(status, 404, "status");
}

// =============================================================================
// Tests — Phase 5: Encrypted asset data (endpoints 14–18)
// =============================================================================

const FAKE_PAYLOAD = Buffer.from("encrypted-content-" + Date.now()).toString("base64");
const FAKE_IV = Buffer.from("0123456789ab").toString("base64"); // 12-byte IV

async function testStoreEncryptedAsset(): Promise<void> {
  const { status, data } = await request("POST", "/keys/encrypted-data", {
    body: {
      asset_type: "document",
      asset_id: ASSET_ID,
      encrypted_payload: FAKE_PAYLOAD,
      encryption_algorithm: "AES-GCM-256",
      key_derivation_method: "webauthn-prf-hkdf",
      initialization_vector: FAKE_IV,
      authorized_key_ids: [registeredKeyId],
    },
  });
  assertEqual(status, 201, "status");
  assertIsObject(data, "body");
  const body = data as Record<string, unknown>;
  assertHasProperty(body, "id", "body");
  assertEqual(body.asset_type, "document", "asset_type");
  assertEqual(body.asset_id, ASSET_ID, "asset_id");
  assertEqual(body.encryption_algorithm, "AES-GCM-256", "encryption_algorithm");
  assertEqual(body.key_derivation_method, "webauthn-prf-hkdf", "key_derivation_method");
  assertEqual(body.encrypted_by_user_id, TEST_USER_ID, "encrypted_by_user_id");

  // Verify authorized_key_ids array (Bun.sql uuid[] bug check)
  assertIsArray(body.authorized_key_ids, "authorized_key_ids");
  const keyIds = body.authorized_key_ids as string[];
  assertEqual(keyIds.length, 1, "authorized_key_ids length");
  assertEqual(keyIds[0], registeredKeyId, "authorized_key_ids[0]");

  // Verify base64 payload survived round-trip
  assertTruthy(
    typeof body.encrypted_payload === "string" &&
      (body.encrypted_payload as string).length > 0,
    "encrypted_payload is non-empty string",
  );
  assertTruthy(
    typeof body.initialization_vector === "string" &&
      (body.initialization_vector as string).length > 0,
    "initialization_vector is non-empty string",
  );
}

async function testStoreEncryptedAssetInvalidKeyIds(): Promise<void> {
  const fakeKeyId = "00000000-0000-0000-0000-000000000000";
  const { status } = await request("POST", "/keys/encrypted-data", {
    body: {
      asset_type: "document",
      asset_id: crypto.randomUUID(),
      encrypted_payload: FAKE_PAYLOAD,
      initialization_vector: FAKE_IV,
      authorized_key_ids: [fakeKeyId],
    },
  });
  assertEqual(status, 400, "status (invalid key IDs)");
}

async function testListEncryptedAssets(): Promise<void> {
  const { status, data } = await request("GET", "/keys/encrypted-data", {
    query: { asset_type: "document" },
  });
  assertEqual(status, 200, "status");
  assertIsArray(data, "body");
  const assets = data as Record<string, unknown>[];
  assertTruthy(assets.length >= 1, "at least 1 encrypted asset");
  const found = assets.find((asset) => asset.asset_id === ASSET_ID);
  assertTruthy(found, "stored asset appears in list");
}

async function testGetEncryptedAssetNoKeyCheck(): Promise<void> {
  const { status, data } = await request(
    "GET",
    `/keys/encrypted-data/document/${ASSET_ID}`,
    { query: { require_key_check: "false" } },
  );
  assertEqual(status, 200, "status");
  assertIsObject(data, "body");
  const body = data as Record<string, unknown>;
  assertEqual(body.asset_type, "document", "asset_type");
  assertEqual(body.asset_id, ASSET_ID, "asset_id");
  assertTruthy(typeof body.encrypted_payload === "string", "has encrypted_payload");
}

async function testGetEncryptedAssetWithKeyCheckDenied(): Promise<void> {
  // We consumed the first assertion earlier and the second is still valid,
  // but let's first consume the second one so we have zero valid assertions
  // to test the 428 denial path.
  await request("POST", `/keys/assertions/${secondAssertionId}/consume`);

  const { status, data } = await request(
    "GET",
    `/keys/encrypted-data/document/${ASSET_ID}`,
    { query: { require_key_check: "true", action: "decrypt" } },
  );
  assertEqual(status, 428, "status (key assertion required)");
  assertIsObject(data, "body");
  const body = data as Record<string, unknown>;
  assertHasProperty(body, "detail", "body");
  assertHasProperty(body, "asset_type", "body");
  assertHasProperty(body, "required_key_count", "body");
  assertEqual(body.asset_type, "document", "asset_type in 428 body");
}

async function testGetEncryptedAssetWithKeyCheckAllowed(): Promise<void> {
  // Create a fresh assertion so key check passes
  const assertionResponse = await request("POST", "/keys/assertions", {
    body: {
      hardware_key_id: registeredKeyId,
      challenge: Buffer.from("challenge-access-" + RUN_ID).toString("base64"),
      asset_type: "document",
      asset_id: ASSET_ID,
    },
  });
  assertEqual(assertionResponse.status, 201, "new assertion status");

  const { status, data } = await request(
    "GET",
    `/keys/encrypted-data/document/${ASSET_ID}`,
    {
      query: {
        require_key_check: "true",
        action: "decrypt",
        auto_consume: "true",
      },
    },
  );
  assertEqual(status, 200, "status");
  assertIsObject(data, "body");
  const body = data as Record<string, unknown>;
  assertHasProperty(body, "access", "body");
  assertHasProperty(body, "data", "body");

  const access = body.access as Record<string, unknown>;
  assertEqual(access.allowed, true, "access.allowed");

  const encryptedData = body.data as Record<string, unknown>;
  assertTruthy(encryptedData !== null, "data is not null");
  assertEqual(encryptedData.asset_id, ASSET_ID, "data.asset_id");
}

async function testGetEncryptedAssetNotFound(): Promise<void> {
  const fakeAssetId = crypto.randomUUID();
  const { status } = await request(
    "GET",
    `/keys/encrypted-data/document/${fakeAssetId}`,
    { query: { require_key_check: "false" } },
  );
  assertEqual(status, 404, "status");
}

async function testUpdateAuthorizedKeys(): Promise<void> {
  // Update authorized keys — same key, just verify the round-trip works
  const { status, data } = await request(
    "PATCH",
    `/keys/encrypted-data/document/${ASSET_ID}/authorized-keys`,
    {
      body: {
        authorized_key_ids: [registeredKeyId],
      },
    },
  );
  assertEqual(status, 200, "status");
  assertIsObject(data, "body");
  const body = data as Record<string, unknown>;
  assertEqual(body.asset_type, "document", "asset_type");
  assertEqual(body.asset_id, ASSET_ID, "asset_id");

  // Verify authorized_key_ids survived the update
  assertIsArray(body.authorized_key_ids, "authorized_key_ids");
  const keyIds = body.authorized_key_ids as string[];
  assertEqual(keyIds.length, 1, "authorized_key_ids length");
  assertEqual(keyIds[0], registeredKeyId, "authorized_key_ids[0]");
}

async function testUpdateAuthorizedKeysWithReEncryption(): Promise<void> {
  const newPayload = Buffer.from("re-encrypted-" + Date.now()).toString("base64");
  const newIv = Buffer.from("abcdef012345").toString("base64");

  const { status, data } = await request(
    "PATCH",
    `/keys/encrypted-data/document/${ASSET_ID}/authorized-keys`,
    {
      body: {
        authorized_key_ids: [registeredKeyId],
        encrypted_payload: newPayload,
        initialization_vector: newIv,
      },
    },
  );
  assertEqual(status, 200, "status");
  assertIsObject(data, "body");
  const body = data as Record<string, unknown>;
  // Payload should have changed
  assertTruthy(
    typeof body.encrypted_payload === "string" &&
      (body.encrypted_payload as string).length > 0,
    "updated encrypted_payload is non-empty",
  );
}

async function testUpdateAuthorizedKeysNotFound(): Promise<void> {
  const fakeAssetId = crypto.randomUUID();
  const { status } = await request(
    "PATCH",
    `/keys/encrypted-data/document/${fakeAssetId}/authorized-keys`,
    {
      body: { authorized_key_ids: [registeredKeyId] },
    },
  );
  assertEqual(status, 404, "status");
}

async function testUpdateAuthorizedKeysPayloadWithoutIv(): Promise<void> {
  const { status } = await request(
    "PATCH",
    `/keys/encrypted-data/document/${ASSET_ID}/authorized-keys`,
    {
      body: {
        authorized_key_ids: [registeredKeyId],
        encrypted_payload: FAKE_PAYLOAD,
        // deliberately omit initialization_vector
      },
    },
  );
  assertEqual(status, 400, "status (payload without IV)");
}

// =============================================================================
// Tests — Phase 6: Cleanup (delete encrypted data, policy, deactivate key)
// =============================================================================

async function testDeleteEncryptedAsset(): Promise<void> {
  const { status, data } = await request(
    "DELETE",
    `/keys/encrypted-data/document/${ASSET_ID}`,
  );
  assertEqual(status, 200, "status");
  assertIsObject(data, "body");
  assertEqual((data as Record<string, unknown>).deleted, true, "deleted");
}

async function testDeleteEncryptedAssetNotFound(): Promise<void> {
  // Deleting the same asset again should 404
  const { status } = await request(
    "DELETE",
    `/keys/encrypted-data/document/${ASSET_ID}`,
  );
  assertEqual(status, 404, "status (already deleted)");
}

async function testDeletePolicy(): Promise<void> {
  const { status, data } = await request("DELETE", `/keys/policies/${policyId}`);
  assertEqual(status, 200, "status");
  assertIsObject(data, "body");
  assertEqual((data as Record<string, unknown>).deleted, true, "deleted");
}

async function testDeletePolicyNotFound(): Promise<void> {
  const { status } = await request("DELETE", `/keys/policies/${policyId}`);
  assertEqual(status, 404, "status (already deleted)");
}

async function testDeactivateKey(): Promise<void> {
  const { status, data } = await request("DELETE", `/keys/${registeredKeyId}`);
  assertEqual(status, 200, "status");
  assertIsObject(data, "body");
  const body = data as Record<string, unknown>;
  assertEqual(body.deactivated, true, "deactivated");
  assertIsObject(body.key, "body.key");
  assertEqual((body.key as Record<string, unknown>).is_active, false, "key.is_active");
}

async function testDeactivateKeyNotFound(): Promise<void> {
  const fakeId = "00000000-0000-0000-0000-000000000000";
  const { status } = await request("DELETE", `/keys/${fakeId}`);
  assertEqual(status, 404, "status");
}

// =============================================================================
// Main
// =============================================================================

async function main(): Promise<void> {
  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║  Hardware Key Integration Tests                     ║");
  console.log("╚══════════════════════════════════════════════════════╝");
  console.log(`  Server:   ${BASE_URL}`);
  console.log(`  User:     ${TEST_USER_ID}`);
  console.log(`  Run ID:   ${RUN_ID}`);
  console.log(`  Asset ID: ${ASSET_ID}`);
  console.log("");

  // Generate auth token
  console.log("  Generating signed JWT…");
  authToken = await generateAuthToken();
  console.log("  JWT ready.\n");

  // Verify server is reachable
  try {
    const response = await fetch(`${BASE_URL}/health`);
    if (!response.ok) {
      console.error(`  ⚠️  Server returned ${response.status} on /health`);
      process.exit(1);
    }
  } catch (error) {
    console.error(`  ❌ Cannot reach server at ${BASE_URL}`);
    console.error(`     Start the TS runtime first:`);
    console.error(
      `     DATABASE_URL="postgresql://postgres:postgres@localhost:54322/postgres" \\`,
    );
    console.error(
      `     SUPABASE_JWT_SECRET="super-secret-jwt-token-with-at-least-32-characters-long" \\`,
    );
    console.error(`     bun run src/index.ts`);
    process.exit(1);
  }

  // --- Phase 0: Basics ---
  console.log("Phase 0: Health & Auth Guard");
  await runTest("GET /health returns 200", testHealthCheck);
  await runTest("GET /keys without auth returns 401", testAuthGuard);

  // --- Phase 1: Key CRUD ---
  console.log("\nPhase 1: Key CRUD (endpoints 1–5)");
  await runTest("POST /keys/register → 201", testRegisterKey);
  await runTest("POST /keys/register duplicate → 409", testRegisterKeyDuplicate);
  await runTest("GET /keys → 200, lists registered key", testListKeys);
  await runTest("GET /keys/:id → 200", testGetKey);
  await runTest("GET /keys/:id not found → 404", testGetKeyNotFound);
  await runTest("PATCH /keys/:id → 200, updates name", testUpdateKey);

  // --- Phase 2: Assertions ---
  console.log("\nPhase 2: Assertion Management (endpoints 6–9)");
  await runTest("POST /keys/assertions → 201", testRecordAssertion);
  await runTest("POST /keys/assertions (2nd) → 201", testRecordSecondAssertion);
  await runTest("GET /keys/assertions → 200, ≥2 assertions", testListAssertions);
  await runTest("GET /keys/assertions/status → 200, allowed", testCheckAssertionStatus);
  await runTest("POST /keys/assertions/:id/consume → 200", testConsumeAssertion);
  await runTest("POST /keys/assertions/:id/consume again → 410", testConsumeAssertionAlreadyConsumed);
  await runTest("POST /keys/assertions/:id/consume not found → 404", testConsumeAssertionNotFound);

  // --- Phase 3: Policies ---
  console.log("\nPhase 3: Asset Key Policies (endpoints 10–13)");
  await runTest("POST /keys/policies → 201", testCreatePolicy);
  await runTest("POST /keys/policies duplicate → 409", testCreatePolicyDuplicate);
  await runTest("GET /keys/policies → 200, lists policy", testListPolicies);
  await runTest("GET /keys/policies/:id → 200", testGetPolicy);
  await runTest("GET /keys/policies/:id not found → 404", testGetPolicyNotFound);

  // --- Phase 4: Encrypted Data ---
  console.log("\nPhase 4: Encrypted Asset Data (endpoints 14–18)");
  await runTest("POST /keys/encrypted-data → 201", testStoreEncryptedAsset);
  await runTest("POST /keys/encrypted-data invalid keys → 400", testStoreEncryptedAssetInvalidKeyIds);
  await runTest("GET /keys/encrypted-data → 200, lists asset", testListEncryptedAssets);
  await runTest("GET /keys/encrypted-data/:t/:id no key check → 200", testGetEncryptedAssetNoKeyCheck);
  await runTest("GET /keys/encrypted-data/:t/:id key check denied → 428", testGetEncryptedAssetWithKeyCheckDenied);
  await runTest("GET /keys/encrypted-data/:t/:id key check allowed → 200", testGetEncryptedAssetWithKeyCheckAllowed);
  await runTest("GET /keys/encrypted-data/:t/:id not found → 404", testGetEncryptedAssetNotFound);
  await runTest("PATCH …/authorized-keys → 200", testUpdateAuthorizedKeys);
  await runTest("PATCH …/authorized-keys with re-encryption → 200", testUpdateAuthorizedKeysWithReEncryption);
  await runTest("PATCH …/authorized-keys not found → 404", testUpdateAuthorizedKeysNotFound);
  await runTest("PATCH …/authorized-keys payload without IV → 400", testUpdateAuthorizedKeysPayloadWithoutIv);

  // --- Phase 5: Cleanup ---
  console.log("\nPhase 5: Cleanup");
  await runTest("DELETE /keys/encrypted-data/:t/:id → 200", testDeleteEncryptedAsset);
  await runTest("DELETE /keys/encrypted-data/:t/:id again → 404", testDeleteEncryptedAssetNotFound);
  await runTest("DELETE /keys/policies/:id → 200", testDeletePolicy);
  await runTest("DELETE /keys/policies/:id again → 404", testDeletePolicyNotFound);
  await runTest("DELETE /keys/:id (deactivate) → 200", testDeactivateKey);
  await runTest("DELETE /keys/:id not found → 404", testDeactivateKeyNotFound);

  // ==========================================================================
  // Summary
  // ==========================================================================

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  const totalDuration = results.reduce((sum, r) => sum + r.duration_ms, 0);

  console.log("\n══════════════════════════════════════════════════════");
  console.log(
    `  Results: ${passed} passed, ${failed} failed, ${results.length} total (${totalDuration}ms)`,
  );

  if (failed > 0) {
    console.log("\n  Failed tests:");
    for (const result of results.filter((r) => !r.passed)) {
      console.log(`    ❌ ${result.name}`);
      console.log(`       ${result.error}`);
    }
  }

  console.log("══════════════════════════════════════════════════════\n");
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
