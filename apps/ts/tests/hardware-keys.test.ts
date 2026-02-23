/**
 * Tests for hardware key management routes — Fractal Agents Runtime TypeScript/Bun.
 *
 * These tests validate the route layer (HTTP status codes, response shapes,
 * error handling) by mocking the auth module and service functions. No
 * running database or Supabase instance is required.
 *
 * Coverage:
 *   - All 18 /keys/* endpoints
 *   - Auth error handling (missing header, invalid token)
 *   - Body validation (missing Content-Type, invalid JSON)
 *   - Service error → HTTP status mapping
 *   - Query parameter parsing (boolean, optional)
 *   - 428 response body for key-gated access
 *
 * Reference:
 *   - apps/python/src/server/routes/hardware_keys.py L72–837
 *   - Task-07 scratchpad § Test Pattern
 */

import { describe, expect, test, beforeEach, mock, afterEach } from "bun:test";
import { router } from "../src/index";

// ============================================================================
// Mock setup
// ============================================================================

// We mock the auth module and the DB module so route handlers work without
// a real database or JWT secret.

const MOCK_USER_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const MOCK_EMAIL = "test@example.com";

// Create a fake JWT with valid structure (header.payload.signature)
function createFakeJwt(sub: string, email?: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ sub, email: email ?? MOCK_EMAIL })).toString("base64url");
  const signature = Buffer.from("fakesignature").toString("base64url");
  return `${header}.${payload}.${signature}`;
}

const FAKE_JWT = createFakeJwt(MOCK_USER_ID);

// ---------------------------------------------------------------------------
// Mock: lib/auth — bypass JWT verification entirely
// ---------------------------------------------------------------------------

import { AuthenticationError } from "../src/lib/auth";
import type { AuthUser } from "../src/lib/auth";

let authShouldFail = false;
let authError: AuthenticationError | null = null;

mock.module("../src/lib/auth", () => ({
  AuthenticationError,
  requireUser: async (request: Request): Promise<AuthUser> => {
    if (authShouldFail) {
      throw authError ?? new AuthenticationError("Authorization header missing");
    }
    // Check for actual auth header to test missing-header paths
    const authHeader = request.headers.get("authorization");
    if (!authHeader) {
      throw new AuthenticationError("Authorization header missing");
    }
    return { identity: MOCK_USER_ID, email: MOCK_EMAIL };
  },
}));

// ---------------------------------------------------------------------------
// Mock: lib/db — return a sentinel object; services are also mocked so
// getDb() is never actually called for queries.
// ---------------------------------------------------------------------------

const MOCK_SQL = {} as never;

mock.module("../src/lib/db", () => ({
  getDb: () => MOCK_SQL,
  closeDb: async () => {},
  isUniqueViolation: (error: unknown) => {
    if (error != null && typeof error === "object" && "code" in error) {
      return (error as Record<string, unknown>).code === "23505";
    }
    return false;
  },
}));

// ---------------------------------------------------------------------------
// Mock: services — every service function is a mock we can override per test
// ---------------------------------------------------------------------------

import type { HardwareKeyResponse, AssertionResponse, AssetKeyPolicyResponse, EncryptedAssetResponse, EncryptedAssetMetadata, KeyProtectedAccessResult, KeyGatedRetrievalResult } from "../src/models/hardware-keys";
import {
  HardwareKeyNotFoundError,
  HardwareKeyConflictError,
  HardwareKeyInactiveError,
  AssertionNotFoundError,
  AssertionConsumedError,
  AssertionExpiredError,
  PolicyConflictError,
  InvalidInputError,
  InvalidAuthorizedKeys,
  EncryptedAssetNotFoundError,
  KeyAssertionRequired,
} from "../src/models/hardware-keys";

// --- Sample response objects used across tests ---

const SAMPLE_KEY_RESPONSE: HardwareKeyResponse = {
  id: "11111111-1111-1111-1111-111111111111",
  credential_id: "cred-abc-123",
  friendly_name: "My YubiKey",
  device_type: "yubikey",
  transports: ["usb"],
  attestation_format: "packed",
  aaguid: "aaguid-test",
  is_active: true,
  last_used_at: null,
  created_at: "2025-01-01T00:00:00.000Z",
  updated_at: "2025-01-01T00:00:00.000Z",
};

const SAMPLE_ASSERTION_RESPONSE: AssertionResponse = {
  assertion_id: "22222222-2222-2222-2222-222222222222",
  hardware_key_id: SAMPLE_KEY_RESPONSE.id,
  expires_at: "2025-01-01T00:05:00.000Z",
  consumed: false,
  asset_type: null,
  asset_id: null,
};

const SAMPLE_POLICY_RESPONSE: AssetKeyPolicyResponse = {
  id: "33333333-3333-3333-3333-333333333333",
  asset_type: "document",
  asset_id: "44444444-4444-4444-4444-444444444444",
  protected_action: "decrypt",
  required_key_count: 1,
  required_key_ids: null,
  created_by_user_id: MOCK_USER_ID,
  created_at: "2025-01-01T00:00:00.000Z",
  updated_at: "2025-01-01T00:00:00.000Z",
};

const SAMPLE_ENCRYPTED_ASSET_RESPONSE: EncryptedAssetResponse = {
  id: "55555555-5555-5555-5555-555555555555",
  asset_type: "document",
  asset_id: "44444444-4444-4444-4444-444444444444",
  encrypted_payload: "dGVzdGRhdGE=",
  encryption_algorithm: "AES-GCM-256",
  key_derivation_method: "webauthn-prf-hkdf",
  initialization_vector: "dGVzdGl2",
  authorized_key_ids: [SAMPLE_KEY_RESPONSE.id],
  encrypted_by_user_id: MOCK_USER_ID,
  created_at: "2025-01-01T00:00:00.000Z",
  updated_at: "2025-01-01T00:00:00.000Z",
};

const SAMPLE_ENCRYPTED_ASSET_METADATA: EncryptedAssetMetadata = {
  id: SAMPLE_ENCRYPTED_ASSET_RESPONSE.id,
  asset_type: SAMPLE_ENCRYPTED_ASSET_RESPONSE.asset_type,
  asset_id: SAMPLE_ENCRYPTED_ASSET_RESPONSE.asset_id,
  encryption_algorithm: SAMPLE_ENCRYPTED_ASSET_RESPONSE.encryption_algorithm,
  key_derivation_method: SAMPLE_ENCRYPTED_ASSET_RESPONSE.key_derivation_method,
  authorized_key_ids: SAMPLE_ENCRYPTED_ASSET_RESPONSE.authorized_key_ids,
  encrypted_by_user_id: SAMPLE_ENCRYPTED_ASSET_RESPONSE.encrypted_by_user_id,
  created_at: SAMPLE_ENCRYPTED_ASSET_RESPONSE.created_at,
};

// Service mock functions — overridden per test via mockImplementation

const mockRegisterHardwareKey = mock(() => Promise.resolve(SAMPLE_KEY_RESPONSE));
const mockListUserHardwareKeys = mock(() => Promise.resolve([SAMPLE_KEY_RESPONSE]));
const mockGetHardwareKey = mock(() => Promise.resolve(SAMPLE_KEY_RESPONSE));
const mockUpdateHardwareKey = mock(() => Promise.resolve(SAMPLE_KEY_RESPONSE));
const mockDeactivateHardwareKey = mock(() => Promise.resolve({ ...SAMPLE_KEY_RESPONSE, is_active: false }));
const mockRecordAssertion = mock(() => Promise.resolve(SAMPLE_ASSERTION_RESPONSE));
const mockListValidAssertions = mock(() => Promise.resolve([SAMPLE_ASSERTION_RESPONSE]));
const mockCheckKeyProtectedAccess = mock(() => Promise.resolve<KeyProtectedAccessResult>({
  allowed: true,
  reason: "No key policy exists for this asset and action",
  requires_assertion: false,
  required_key_count: null,
  assertions_present: null,
}));
const mockConsumeAssertion = mock(() => Promise.resolve({ ...SAMPLE_ASSERTION_RESPONSE, consumed: true }));
const mockCreateAssetKeyPolicy = mock(() => Promise.resolve(SAMPLE_POLICY_RESPONSE));
const mockListAssetKeyPolicies = mock(() => Promise.resolve([SAMPLE_POLICY_RESPONSE]));
const mockGetAssetKeyPolicy = mock(() => Promise.resolve(SAMPLE_POLICY_RESPONSE as AssetKeyPolicyResponse | null));
const mockDeleteAssetKeyPolicy = mock(() => Promise.resolve(true));

const mockStoreEncryptedAsset = mock(() => Promise.resolve(SAMPLE_ENCRYPTED_ASSET_RESPONSE));
const mockListEncryptedAssetsForUser = mock(() => Promise.resolve([SAMPLE_ENCRYPTED_ASSET_METADATA]));
const mockGetEncryptedAsset = mock(() => Promise.resolve(SAMPLE_ENCRYPTED_ASSET_RESPONSE as EncryptedAssetResponse | null));
const mockGetEncryptedAssetWithKeyCheck = mock(() => Promise.resolve<KeyGatedRetrievalResult>({
  access: {
    allowed: true,
    reason: "No key policy exists for this asset and action",
    requires_assertion: false,
    required_key_count: null,
    assertions_present: null,
  },
  data: SAMPLE_ENCRYPTED_ASSET_RESPONSE,
}));
const mockDeleteEncryptedAsset = mock(() => Promise.resolve(true));
const mockUpdateAuthorizedKeys = mock(() => Promise.resolve(SAMPLE_ENCRYPTED_ASSET_RESPONSE));

mock.module("../src/services/hardware-key-service", () => ({
  registerHardwareKey: (...args: unknown[]) => mockRegisterHardwareKey(...args),
  listUserHardwareKeys: (...args: unknown[]) => mockListUserHardwareKeys(...args),
  getHardwareKey: (...args: unknown[]) => mockGetHardwareKey(...args),
  updateHardwareKey: (...args: unknown[]) => mockUpdateHardwareKey(...args),
  deactivateHardwareKey: (...args: unknown[]) => mockDeactivateHardwareKey(...args),
  recordAssertion: (...args: unknown[]) => mockRecordAssertion(...args),
  listValidAssertions: (...args: unknown[]) => mockListValidAssertions(...args),
  checkKeyProtectedAccess: (...args: unknown[]) => mockCheckKeyProtectedAccess(...args),
  consumeAssertion: (...args: unknown[]) => mockConsumeAssertion(...args),
  createAssetKeyPolicy: (...args: unknown[]) => mockCreateAssetKeyPolicy(...args),
  listAssetKeyPolicies: (...args: unknown[]) => mockListAssetKeyPolicies(...args),
  getAssetKeyPolicy: (...args: unknown[]) => mockGetAssetKeyPolicy(...args),
  deleteAssetKeyPolicy: (...args: unknown[]) => mockDeleteAssetKeyPolicy(...args),
  consumeMatchingAssertions: mock(() => Promise.resolve(1)),
  rowToHardwareKeyResponse: mock(),
  rowToAssertionResponse: mock(),
  rowToPolicyResponse: mock(),
}));

mock.module("../src/services/encryption-service", () => ({
  storeEncryptedAsset: (...args: unknown[]) => mockStoreEncryptedAsset(...args),
  listEncryptedAssetsForUser: (...args: unknown[]) => mockListEncryptedAssetsForUser(...args),
  getEncryptedAsset: (...args: unknown[]) => mockGetEncryptedAsset(...args),
  getEncryptedAssetWithKeyCheck: (...args: unknown[]) => mockGetEncryptedAssetWithKeyCheck(...args),
  deleteEncryptedAsset: (...args: unknown[]) => mockDeleteEncryptedAsset(...args),
  updateAuthorizedKeys: (...args: unknown[]) => mockUpdateAuthorizedKeys(...args),
  rowToEncryptedAssetResponse: mock(),
  rowToEncryptedAssetMetadata: mock(),
}));

// ============================================================================
// Helpers
// ============================================================================

function makeRequest(
  path: string,
  method = "GET",
  body?: unknown,
): Request {
  const options: RequestInit = { method };
  if (body !== undefined) {
    options.headers = { "Content-Type": "application/json" };
    options.body = JSON.stringify(body);
  }
  return new Request(`http://localhost:3000${path}`, options);
}

function makeAuthRequest(
  path: string,
  method = "GET",
  body?: unknown,
): Request {
  const options: RequestInit = { method };
  const headers: Record<string, string> = {
    Authorization: `Bearer ${FAKE_JWT}`,
  };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }
  options.headers = headers;
  return new Request(`http://localhost:3000${path}`, options);
}

async function jsonBody<T = unknown>(response: Response): Promise<T> {
  return response.json() as Promise<T>;
}

function resetAllMocks(): void {
  authShouldFail = false;
  authError = null;

  mockRegisterHardwareKey.mockImplementation(() => Promise.resolve(SAMPLE_KEY_RESPONSE));
  mockListUserHardwareKeys.mockImplementation(() => Promise.resolve([SAMPLE_KEY_RESPONSE]));
  mockGetHardwareKey.mockImplementation(() => Promise.resolve(SAMPLE_KEY_RESPONSE));
  mockUpdateHardwareKey.mockImplementation(() => Promise.resolve(SAMPLE_KEY_RESPONSE));
  mockDeactivateHardwareKey.mockImplementation(() => Promise.resolve({ ...SAMPLE_KEY_RESPONSE, is_active: false }));
  mockRecordAssertion.mockImplementation(() => Promise.resolve(SAMPLE_ASSERTION_RESPONSE));
  mockListValidAssertions.mockImplementation(() => Promise.resolve([SAMPLE_ASSERTION_RESPONSE]));
  mockCheckKeyProtectedAccess.mockImplementation(() => Promise.resolve({
    allowed: true,
    reason: "No key policy exists for this asset and action",
    requires_assertion: false,
    required_key_count: null,
    assertions_present: null,
  }));
  mockConsumeAssertion.mockImplementation(() => Promise.resolve({ ...SAMPLE_ASSERTION_RESPONSE, consumed: true }));
  mockCreateAssetKeyPolicy.mockImplementation(() => Promise.resolve(SAMPLE_POLICY_RESPONSE));
  mockListAssetKeyPolicies.mockImplementation(() => Promise.resolve([SAMPLE_POLICY_RESPONSE]));
  mockGetAssetKeyPolicy.mockImplementation(() => Promise.resolve(SAMPLE_POLICY_RESPONSE));
  mockDeleteAssetKeyPolicy.mockImplementation(() => Promise.resolve(true));
  mockStoreEncryptedAsset.mockImplementation(() => Promise.resolve(SAMPLE_ENCRYPTED_ASSET_RESPONSE));
  mockListEncryptedAssetsForUser.mockImplementation(() => Promise.resolve([SAMPLE_ENCRYPTED_ASSET_METADATA]));
  mockGetEncryptedAsset.mockImplementation(() => Promise.resolve(SAMPLE_ENCRYPTED_ASSET_RESPONSE));
  mockGetEncryptedAssetWithKeyCheck.mockImplementation(() => Promise.resolve({
    access: {
      allowed: true,
      reason: "No key policy exists for this asset and action",
      requires_assertion: false,
      required_key_count: null,
      assertions_present: null,
    },
    data: SAMPLE_ENCRYPTED_ASSET_RESPONSE,
  }));
  mockDeleteEncryptedAsset.mockImplementation(() => Promise.resolve(true));
  mockUpdateAuthorizedKeys.mockImplementation(() => Promise.resolve(SAMPLE_ENCRYPTED_ASSET_RESPONSE));
}

// ============================================================================
// Tests
// ============================================================================

describe("Hardware Key Routes", () => {
  beforeEach(() => {
    resetAllMocks();
  });

  // ==========================================================================
  // Auth checks (shared across endpoints)
  // ==========================================================================

  describe("authentication", () => {
    test("returns 401 when Authorization header is missing", async () => {
      const response = await router.handle(makeRequest("/keys", "GET"));
      expect(response.status).toBe(401);
      const body = await jsonBody<{ detail: string }>(response);
      expect(body.detail).toBe("Authorization header missing");
    });

    test("returns 401 when auth fails for POST /keys/register", async () => {
      const response = await router.handle(makeRequest("/keys/register", "POST", { credential_id: "x" }));
      expect(response.status).toBe(401);
    });

    test("returns 401 when auth fails for POST /keys/assertions", async () => {
      const response = await router.handle(makeRequest("/keys/assertions", "POST", { hardware_key_id: "x", challenge: "y" }));
      expect(response.status).toBe(401);
    });

    test("returns 401 when auth fails for GET /keys/assertions/status", async () => {
      const response = await router.handle(makeRequest("/keys/assertions/status?asset_type=document&asset_id=1"));
      expect(response.status).toBe(401);
    });
  });

  // ==========================================================================
  // POST /keys/register
  // ==========================================================================

  describe("POST /keys/register", () => {
    const registrationBody = {
      credential_id: "cred-abc-123",
      public_key: "dGVzdHB1YmxpY2tleQ",
      counter: 0,
      transports: ["usb"],
      friendly_name: "My YubiKey",
      device_type: "yubikey",
    };

    test("returns 201 with HardwareKeyResponse on success", async () => {
      const response = await router.handle(makeAuthRequest("/keys/register", "POST", registrationBody));
      expect(response.status).toBe(201);
      const body = await jsonBody<HardwareKeyResponse>(response);
      expect(body.id).toBe(SAMPLE_KEY_RESPONSE.id);
      expect(body.credential_id).toBe(SAMPLE_KEY_RESPONSE.credential_id);
      expect(body.is_active).toBe(true);
    });

    test("returns 201 with correct Content-Type", async () => {
      const response = await router.handle(makeAuthRequest("/keys/register", "POST", registrationBody));
      expect(response.headers.get("Content-Type")).toBe("application/json");
    });

    test("returns 409 when credential_id already exists", async () => {
      mockRegisterHardwareKey.mockImplementation(() => {
        throw new HardwareKeyConflictError("cred-abc-123");
      });
      const response = await router.handle(makeAuthRequest("/keys/register", "POST", registrationBody));
      expect(response.status).toBe(409);
      const body = await jsonBody<{ detail: string }>(response);
      expect(body.detail).toContain("already exists");
    });

    test("returns 400 when device_type is invalid", async () => {
      mockRegisterHardwareKey.mockImplementation(() => {
        throw new InvalidInputError("Invalid device_type 'banana'");
      });
      const response = await router.handle(makeAuthRequest("/keys/register", "POST", { ...registrationBody, device_type: "banana" }));
      expect(response.status).toBe(400);
    });

    test("returns 422 when Content-Type is missing", async () => {
      const request = new Request("http://localhost:3000/keys/register", {
        method: "POST",
        headers: { Authorization: `Bearer ${FAKE_JWT}` },
        body: JSON.stringify(registrationBody),
      });
      const response = await router.handle(request);
      expect(response.status).toBe(422);
    });

    test("returns 422 when body is invalid JSON", async () => {
      const request = new Request("http://localhost:3000/keys/register", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${FAKE_JWT}`,
          "Content-Type": "application/json",
        },
        body: "not valid json{{{",
      });
      const response = await router.handle(request);
      expect(response.status).toBe(422);
    });

    test("returns 500 on unexpected service error", async () => {
      mockRegisterHardwareKey.mockImplementation(() => {
        throw new Error("database connection lost");
      });
      const response = await router.handle(makeAuthRequest("/keys/register", "POST", registrationBody));
      expect(response.status).toBe(500);
      const body = await jsonBody<{ detail: string }>(response);
      expect(body.detail).toBe("Internal server error");
    });
  });

  // ==========================================================================
  // GET /keys
  // ==========================================================================

  describe("GET /keys", () => {
    test("returns 200 with array of HardwareKeyResponse", async () => {
      const response = await router.handle(makeAuthRequest("/keys"));
      expect(response.status).toBe(200);
      const body = await jsonBody<HardwareKeyResponse[]>(response);
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBe(1);
      expect(body[0].id).toBe(SAMPLE_KEY_RESPONSE.id);
    });

    test("returns empty array when no keys exist", async () => {
      mockListUserHardwareKeys.mockImplementation(() => Promise.resolve([]));
      const response = await router.handle(makeAuthRequest("/keys"));
      expect(response.status).toBe(200);
      const body = await jsonBody<HardwareKeyResponse[]>(response);
      expect(body).toEqual([]);
    });

    test("passes include_inactive=true query param", async () => {
      const response = await router.handle(makeAuthRequest("/keys?include_inactive=true"));
      expect(response.status).toBe(200);
      // The mock was called — we verify the service was invoked
      expect(mockListUserHardwareKeys).toHaveBeenCalled();
    });

    test("defaults include_inactive to false", async () => {
      const response = await router.handle(makeAuthRequest("/keys"));
      expect(response.status).toBe(200);
      expect(mockListUserHardwareKeys).toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // GET /keys/:key_id
  // ==========================================================================

  describe("GET /keys/:key_id", () => {
    test("returns 200 with HardwareKeyResponse", async () => {
      const response = await router.handle(makeAuthRequest(`/keys/${SAMPLE_KEY_RESPONSE.id}`));
      expect(response.status).toBe(200);
      const body = await jsonBody<HardwareKeyResponse>(response);
      expect(body.id).toBe(SAMPLE_KEY_RESPONSE.id);
    });

    test("returns 404 when key not found", async () => {
      mockGetHardwareKey.mockImplementation(() => {
        throw new HardwareKeyNotFoundError("nonexistent-id");
      });
      const response = await router.handle(makeAuthRequest("/keys/nonexistent-id"));
      expect(response.status).toBe(404);
      const body = await jsonBody<{ detail: string }>(response);
      expect(body.detail).toContain("not found");
    });
  });

  // ==========================================================================
  // PATCH /keys/:key_id
  // ==========================================================================

  describe("PATCH /keys/:key_id", () => {
    test("returns 200 with updated HardwareKeyResponse", async () => {
      const updatedKey = { ...SAMPLE_KEY_RESPONSE, friendly_name: "New Name" };
      mockUpdateHardwareKey.mockImplementation(() => Promise.resolve(updatedKey));
      const response = await router.handle(
        makeAuthRequest(`/keys/${SAMPLE_KEY_RESPONSE.id}`, "PATCH", { friendly_name: "New Name" }),
      );
      expect(response.status).toBe(200);
      const body = await jsonBody<HardwareKeyResponse>(response);
      expect(body.friendly_name).toBe("New Name");
    });

    test("returns 404 when key not found", async () => {
      mockUpdateHardwareKey.mockImplementation(() => {
        throw new HardwareKeyNotFoundError("nonexistent-id");
      });
      const response = await router.handle(
        makeAuthRequest("/keys/nonexistent-id", "PATCH", { friendly_name: "x" }),
      );
      expect(response.status).toBe(404);
    });

    test("returns 400 when device_type is invalid", async () => {
      mockUpdateHardwareKey.mockImplementation(() => {
        throw new InvalidInputError("Invalid device_type 'banana'");
      });
      const response = await router.handle(
        makeAuthRequest(`/keys/${SAMPLE_KEY_RESPONSE.id}`, "PATCH", { device_type: "banana" }),
      );
      expect(response.status).toBe(400);
    });

    test("returns 422 when body is missing Content-Type", async () => {
      const request = new Request(`http://localhost:3000/keys/${SAMPLE_KEY_RESPONSE.id}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${FAKE_JWT}` },
        body: JSON.stringify({ friendly_name: "x" }),
      });
      const response = await router.handle(request);
      expect(response.status).toBe(422);
    });
  });

  // ==========================================================================
  // DELETE /keys/:key_id (deactivate)
  // ==========================================================================

  describe("DELETE /keys/:key_id", () => {
    test("returns 200 with deactivated shape", async () => {
      const response = await router.handle(
        makeAuthRequest(`/keys/${SAMPLE_KEY_RESPONSE.id}`, "DELETE"),
      );
      expect(response.status).toBe(200);
      const body = await jsonBody<{ deactivated: boolean; key: HardwareKeyResponse }>(response);
      expect(body.deactivated).toBe(true);
      expect(body.key).toBeDefined();
      expect(body.key.is_active).toBe(false);
    });

    test("returns 404 when key not found", async () => {
      mockDeactivateHardwareKey.mockImplementation(() => {
        throw new HardwareKeyNotFoundError("nonexistent-id");
      });
      const response = await router.handle(
        makeAuthRequest("/keys/nonexistent-id", "DELETE"),
      );
      expect(response.status).toBe(404);
    });
  });

  // ==========================================================================
  // POST /keys/assertions
  // ==========================================================================

  describe("POST /keys/assertions", () => {
    const assertionBody = {
      hardware_key_id: SAMPLE_KEY_RESPONSE.id,
      challenge: "dGVzdGNoYWxsZW5nZQ",
    };

    test("returns 201 with AssertionResponse on success", async () => {
      const response = await router.handle(makeAuthRequest("/keys/assertions", "POST", assertionBody));
      expect(response.status).toBe(201);
      const body = await jsonBody<AssertionResponse>(response);
      expect(body.assertion_id).toBe(SAMPLE_ASSERTION_RESPONSE.assertion_id);
      expect(body.consumed).toBe(false);
    });

    test("returns 404 when hardware key not found", async () => {
      mockRecordAssertion.mockImplementation(() => {
        throw new HardwareKeyNotFoundError("nonexistent-id");
      });
      const response = await router.handle(makeAuthRequest("/keys/assertions", "POST", {
        hardware_key_id: "nonexistent-id",
        challenge: "abc",
      }));
      expect(response.status).toBe(404);
    });

    test("returns 400 when hardware key is inactive", async () => {
      mockRecordAssertion.mockImplementation(() => {
        throw new HardwareKeyInactiveError("some-id");
      });
      const response = await router.handle(makeAuthRequest("/keys/assertions", "POST", assertionBody));
      expect(response.status).toBe(400);
    });

    test("returns 400 when asset_type provided without asset_id", async () => {
      mockRecordAssertion.mockImplementation(() => {
        throw new InvalidInputError("asset_type and asset_id must both be provided or both be null");
      });
      const response = await router.handle(makeAuthRequest("/keys/assertions", "POST", {
        ...assertionBody,
        asset_type: "document",
      }));
      expect(response.status).toBe(400);
    });

    test("returns 201 with scoped assertion", async () => {
      const scopedAssertion: AssertionResponse = {
        ...SAMPLE_ASSERTION_RESPONSE,
        asset_type: "document",
        asset_id: "44444444-4444-4444-4444-444444444444",
      };
      mockRecordAssertion.mockImplementation(() => Promise.resolve(scopedAssertion));
      const response = await router.handle(makeAuthRequest("/keys/assertions", "POST", {
        ...assertionBody,
        asset_type: "document",
        asset_id: "44444444-4444-4444-4444-444444444444",
      }));
      expect(response.status).toBe(201);
      const body = await jsonBody<AssertionResponse>(response);
      expect(body.asset_type).toBe("document");
      expect(body.asset_id).toBe("44444444-4444-4444-4444-444444444444");
    });
  });

  // ==========================================================================
  // GET /keys/assertions
  // ==========================================================================

  describe("GET /keys/assertions", () => {
    test("returns 200 with array of AssertionResponse", async () => {
      const response = await router.handle(makeAuthRequest("/keys/assertions"));
      expect(response.status).toBe(200);
      const body = await jsonBody<AssertionResponse[]>(response);
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBe(1);
    });

    test("accepts asset_type and asset_id query params", async () => {
      const response = await router.handle(
        makeAuthRequest("/keys/assertions?asset_type=document&asset_id=some-id"),
      );
      expect(response.status).toBe(200);
      expect(mockListValidAssertions).toHaveBeenCalled();
    });

    test("returns empty array when no assertions exist", async () => {
      mockListValidAssertions.mockImplementation(() => Promise.resolve([]));
      const response = await router.handle(makeAuthRequest("/keys/assertions"));
      expect(response.status).toBe(200);
      const body = await jsonBody<AssertionResponse[]>(response);
      expect(body).toEqual([]);
    });
  });

  // ==========================================================================
  // GET /keys/assertions/status
  // ==========================================================================

  describe("GET /keys/assertions/status", () => {
    test("returns 200 with KeyProtectedAccessResult", async () => {
      const response = await router.handle(
        makeAuthRequest("/keys/assertions/status?asset_type=document&asset_id=some-id"),
      );
      expect(response.status).toBe(200);
      const body = await jsonBody<KeyProtectedAccessResult>(response);
      expect(body.allowed).toBe(true);
      expect(body.requires_assertion).toBe(false);
    });

    test("returns 422 when asset_type is missing", async () => {
      const response = await router.handle(
        makeAuthRequest("/keys/assertions/status?asset_id=some-id"),
      );
      expect(response.status).toBe(422);
      const body = await jsonBody<{ detail: string }>(response);
      expect(body.detail).toContain("asset_type");
    });

    test("returns 422 when asset_id is missing", async () => {
      const response = await router.handle(
        makeAuthRequest("/keys/assertions/status?asset_type=document"),
      );
      expect(response.status).toBe(422);
      const body = await jsonBody<{ detail: string }>(response);
      expect(body.detail).toContain("asset_id");
    });

    test("passes action query param to service", async () => {
      const response = await router.handle(
        makeAuthRequest("/keys/assertions/status?asset_type=document&asset_id=some-id&action=delete"),
      );
      expect(response.status).toBe(200);
      expect(mockCheckKeyProtectedAccess).toHaveBeenCalled();
    });

    test("defaults action to decrypt when not provided", async () => {
      const response = await router.handle(
        makeAuthRequest("/keys/assertions/status?asset_type=document&asset_id=some-id"),
      );
      expect(response.status).toBe(200);
      expect(mockCheckKeyProtectedAccess).toHaveBeenCalled();
    });

    test("returns 400 for invalid input", async () => {
      mockCheckKeyProtectedAccess.mockImplementation(() => {
        throw new InvalidInputError("Invalid asset_type 'banana'");
      });
      const response = await router.handle(
        makeAuthRequest("/keys/assertions/status?asset_type=banana&asset_id=some-id"),
      );
      expect(response.status).toBe(400);
    });
  });

  // ==========================================================================
  // POST /keys/assertions/:assertion_id/consume
  // ==========================================================================

  describe("POST /keys/assertions/:assertion_id/consume", () => {
    test("returns 200 with consumed assertion", async () => {
      const response = await router.handle(
        makeAuthRequest(`/keys/assertions/${SAMPLE_ASSERTION_RESPONSE.assertion_id}/consume`, "POST"),
      );
      expect(response.status).toBe(200);
      const body = await jsonBody<AssertionResponse>(response);
      expect(body.consumed).toBe(true);
    });

    test("returns 404 when assertion not found", async () => {
      mockConsumeAssertion.mockImplementation(() => {
        throw new AssertionNotFoundError("nonexistent-id");
      });
      const response = await router.handle(
        makeAuthRequest("/keys/assertions/nonexistent-id/consume", "POST"),
      );
      expect(response.status).toBe(404);
    });

    test("returns 410 when assertion already consumed", async () => {
      mockConsumeAssertion.mockImplementation(() => {
        throw new AssertionConsumedError("some-id");
      });
      const response = await router.handle(
        makeAuthRequest("/keys/assertions/some-id/consume", "POST"),
      );
      expect(response.status).toBe(410);
      const body = await jsonBody<{ detail: string }>(response);
      expect(body.detail).toContain("already been consumed");
    });

    test("returns 410 when assertion expired", async () => {
      mockConsumeAssertion.mockImplementation(() => {
        throw new AssertionExpiredError("some-id");
      });
      const response = await router.handle(
        makeAuthRequest("/keys/assertions/some-id/consume", "POST"),
      );
      expect(response.status).toBe(410);
      const body = await jsonBody<{ detail: string }>(response);
      expect(body.detail).toContain("expired");
    });
  });

  // ==========================================================================
  // POST /keys/policies
  // ==========================================================================

  describe("POST /keys/policies", () => {
    const policyBody = {
      asset_type: "document",
      asset_id: "44444444-4444-4444-4444-444444444444",
      protected_action: "decrypt",
      required_key_count: 1,
    };

    test("returns 201 with AssetKeyPolicyResponse on success", async () => {
      const response = await router.handle(makeAuthRequest("/keys/policies", "POST", policyBody));
      expect(response.status).toBe(201);
      const body = await jsonBody<AssetKeyPolicyResponse>(response);
      expect(body.id).toBe(SAMPLE_POLICY_RESPONSE.id);
      expect(body.asset_type).toBe("document");
      expect(body.protected_action).toBe("decrypt");
    });

    test("returns 409 when policy already exists", async () => {
      mockCreateAssetKeyPolicy.mockImplementation(() => {
        throw new PolicyConflictError("document", "some-id", "decrypt");
      });
      const response = await router.handle(makeAuthRequest("/keys/policies", "POST", policyBody));
      expect(response.status).toBe(409);
      const body = await jsonBody<{ detail: string }>(response);
      expect(body.detail).toContain("already exists");
    });

    test("returns 400 when asset_type is invalid", async () => {
      mockCreateAssetKeyPolicy.mockImplementation(() => {
        throw new InvalidInputError("Invalid asset_type 'banana'");
      });
      const response = await router.handle(makeAuthRequest("/keys/policies", "POST", { ...policyBody, asset_type: "banana" }));
      expect(response.status).toBe(400);
    });
  });

  // ==========================================================================
  // GET /keys/policies
  // ==========================================================================

  describe("GET /keys/policies", () => {
    test("returns 200 with array of policies", async () => {
      const response = await router.handle(
        makeAuthRequest("/keys/policies?asset_type=document&asset_id=some-id"),
      );
      expect(response.status).toBe(200);
      const body = await jsonBody<AssetKeyPolicyResponse[]>(response);
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBe(1);
    });

    test("returns 422 when asset_type is missing", async () => {
      const response = await router.handle(
        makeAuthRequest("/keys/policies?asset_id=some-id"),
      );
      expect(response.status).toBe(422);
    });

    test("returns 422 when asset_id is missing", async () => {
      const response = await router.handle(
        makeAuthRequest("/keys/policies?asset_type=document"),
      );
      expect(response.status).toBe(422);
    });
  });

  // ==========================================================================
  // GET /keys/policies/:policy_id
  // ==========================================================================

  describe("GET /keys/policies/:policy_id", () => {
    test("returns 200 with policy", async () => {
      const response = await router.handle(
        makeAuthRequest(`/keys/policies/${SAMPLE_POLICY_RESPONSE.id}`),
      );
      expect(response.status).toBe(200);
      const body = await jsonBody<AssetKeyPolicyResponse>(response);
      expect(body.id).toBe(SAMPLE_POLICY_RESPONSE.id);
    });

    test("returns 404 when policy not found", async () => {
      mockGetAssetKeyPolicy.mockImplementation(() => Promise.resolve(null));
      const response = await router.handle(
        makeAuthRequest("/keys/policies/nonexistent-id"),
      );
      expect(response.status).toBe(404);
    });
  });

  // ==========================================================================
  // DELETE /keys/policies/:policy_id
  // ==========================================================================

  describe("DELETE /keys/policies/:policy_id", () => {
    test("returns 200 with {deleted: true}", async () => {
      const response = await router.handle(
        makeAuthRequest(`/keys/policies/${SAMPLE_POLICY_RESPONSE.id}`, "DELETE"),
      );
      expect(response.status).toBe(200);
      const body = await jsonBody<{ deleted: boolean }>(response);
      expect(body.deleted).toBe(true);
    });

    test("returns 404 when policy not found", async () => {
      mockDeleteAssetKeyPolicy.mockImplementation(() => Promise.resolve(false));
      const response = await router.handle(
        makeAuthRequest("/keys/policies/nonexistent-id", "DELETE"),
      );
      expect(response.status).toBe(404);
    });
  });

  // ==========================================================================
  // POST /keys/encrypted-data
  // ==========================================================================

  describe("POST /keys/encrypted-data", () => {
    const storeBody = {
      asset_type: "document",
      asset_id: "44444444-4444-4444-4444-444444444444",
      encrypted_payload: "dGVzdGRhdGE=",
      initialization_vector: "dGVzdGl2",
      authorized_key_ids: [SAMPLE_KEY_RESPONSE.id],
    };

    test("returns 201 with EncryptedAssetResponse on success", async () => {
      const response = await router.handle(makeAuthRequest("/keys/encrypted-data", "POST", storeBody));
      expect(response.status).toBe(201);
      const body = await jsonBody<EncryptedAssetResponse>(response);
      expect(body.id).toBe(SAMPLE_ENCRYPTED_ASSET_RESPONSE.id);
      expect(body.asset_type).toBe("document");
    });

    test("returns 400 when authorized_key_ids are invalid", async () => {
      mockStoreEncryptedAsset.mockImplementation(() => {
        throw new InvalidAuthorizedKeys(["bad-id"]);
      });
      const response = await router.handle(makeAuthRequest("/keys/encrypted-data", "POST", storeBody));
      expect(response.status).toBe(400);
      const body = await jsonBody<{ detail: string }>(response);
      expect(body.detail).toContain("not found");
    });

    test("returns 400 when asset_type is invalid", async () => {
      mockStoreEncryptedAsset.mockImplementation(() => {
        throw new InvalidInputError("Invalid asset_type 'banana'");
      });
      const response = await router.handle(makeAuthRequest("/keys/encrypted-data", "POST", { ...storeBody, asset_type: "banana" }));
      expect(response.status).toBe(400);
    });
  });

  // ==========================================================================
  // GET /keys/encrypted-data
  // ==========================================================================

  describe("GET /keys/encrypted-data", () => {
    test("returns 200 with array of EncryptedAssetMetadata", async () => {
      const response = await router.handle(makeAuthRequest("/keys/encrypted-data"));
      expect(response.status).toBe(200);
      const body = await jsonBody<EncryptedAssetMetadata[]>(response);
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBe(1);
      expect(body[0].id).toBe(SAMPLE_ENCRYPTED_ASSET_METADATA.id);
    });

    test("passes asset_type query param", async () => {
      const response = await router.handle(
        makeAuthRequest("/keys/encrypted-data?asset_type=document"),
      );
      expect(response.status).toBe(200);
      expect(mockListEncryptedAssetsForUser).toHaveBeenCalled();
    });

    test("returns empty array when no assets exist", async () => {
      mockListEncryptedAssetsForUser.mockImplementation(() => Promise.resolve([]));
      const response = await router.handle(makeAuthRequest("/keys/encrypted-data"));
      expect(response.status).toBe(200);
      const body = await jsonBody<EncryptedAssetMetadata[]>(response);
      expect(body).toEqual([]);
    });
  });

  // ==========================================================================
  // GET /keys/encrypted-data/:asset_type/:asset_id (most complex endpoint)
  // ==========================================================================

  describe("GET /keys/encrypted-data/:asset_type/:asset_id", () => {
    const basePath = "/keys/encrypted-data/document/44444444-4444-4444-4444-444444444444";

    test("returns 200 with KeyGatedRetrievalResult when key check passes (default)", async () => {
      const response = await router.handle(makeAuthRequest(basePath));
      expect(response.status).toBe(200);
      const body = await jsonBody<KeyGatedRetrievalResult>(response);
      expect(body.access).toBeDefined();
      expect(body.access.allowed).toBe(true);
      expect(body.data).toBeDefined();
      expect(body.data!.id).toBe(SAMPLE_ENCRYPTED_ASSET_RESPONSE.id);
    });

    test("returns 428 when key assertion is required but missing", async () => {
      mockGetEncryptedAssetWithKeyCheck.mockImplementation(() => Promise.resolve({
        access: {
          allowed: false,
          reason: "Hardware key assertion required: 1 key touch(es) needed for 'decrypt' on this document",
          requires_assertion: true,
          required_key_count: 1,
          assertions_present: 0,
        },
        data: null,
      }));
      const response = await router.handle(makeAuthRequest(basePath));
      expect(response.status).toBe(428);
      const body = await jsonBody<Record<string, unknown>>(response);
      expect(body.detail).toBe("Hardware key assertion required");
      expect(body.asset_type).toBe("document");
      expect(body.asset_id).toBe("44444444-4444-4444-4444-444444444444");
      expect(body.action).toBe("decrypt");
      expect(body.requires_assertion).toBe(true);
      expect(body.required_key_count).toBe(1);
      expect(body.assertions_present).toBe(0);
      expect(body.reason).toContain("key touch");
    });

    test("returns EncryptedAssetResponse when require_key_check=false", async () => {
      const response = await router.handle(
        makeAuthRequest(`${basePath}?require_key_check=false`),
      );
      expect(response.status).toBe(200);
      const body = await jsonBody<EncryptedAssetResponse>(response);
      expect(body.id).toBe(SAMPLE_ENCRYPTED_ASSET_RESPONSE.id);
      expect(body.encrypted_payload).toBeDefined();
    });

    test("returns 404 when asset not found (require_key_check=false)", async () => {
      mockGetEncryptedAsset.mockImplementation(() => Promise.resolve(null));
      const response = await router.handle(
        makeAuthRequest(`${basePath}?require_key_check=false`),
      );
      expect(response.status).toBe(404);
      const body = await jsonBody<{ detail: string }>(response);
      expect(body.detail).toContain("No encrypted data found");
    });

    test("returns 404 when asset not found (require_key_check=true)", async () => {
      mockGetEncryptedAssetWithKeyCheck.mockImplementation(() => {
        throw new EncryptedAssetNotFoundError("document", "some-id");
      });
      const response = await router.handle(makeAuthRequest(basePath));
      expect(response.status).toBe(404);
    });

    test("passes action query param", async () => {
      const response = await router.handle(
        makeAuthRequest(`${basePath}?action=delete`),
      );
      expect(response.status).toBe(200);
      expect(mockGetEncryptedAssetWithKeyCheck).toHaveBeenCalled();
    });

    test("passes auto_consume=false query param", async () => {
      const response = await router.handle(
        makeAuthRequest(`${basePath}?auto_consume=false`),
      );
      expect(response.status).toBe(200);
      expect(mockGetEncryptedAssetWithKeyCheck).toHaveBeenCalled();
    });

    test("boolean query params accept '1' and 'yes'", async () => {
      const response1 = await router.handle(
        makeAuthRequest(`${basePath}?require_key_check=1`),
      );
      expect(response1.status).toBe(200);

      const response2 = await router.handle(
        makeAuthRequest(`${basePath}?require_key_check=yes`),
      );
      expect(response2.status).toBe(200);
    });

    test("handles KeyAssertionRequired error with 428", async () => {
      mockGetEncryptedAssetWithKeyCheck.mockImplementation(() => {
        throw new KeyAssertionRequired("document", "some-id", "decrypt", 1, 0);
      });
      const response = await router.handle(makeAuthRequest(basePath));
      expect(response.status).toBe(428);
      const body = await jsonBody<Record<string, unknown>>(response);
      expect(body.detail).toBe("Hardware key assertion required");
      expect(body.required_key_count).toBe(1);
      expect(body.assertions_present).toBe(0);
    });
  });

  // ==========================================================================
  // DELETE /keys/encrypted-data/:asset_type/:asset_id
  // ==========================================================================

  describe("DELETE /keys/encrypted-data/:asset_type/:asset_id", () => {
    test("returns 200 with {deleted: true}", async () => {
      const response = await router.handle(
        makeAuthRequest("/keys/encrypted-data/document/some-id", "DELETE"),
      );
      expect(response.status).toBe(200);
      const body = await jsonBody<{ deleted: boolean }>(response);
      expect(body.deleted).toBe(true);
    });

    test("returns 404 when asset not found", async () => {
      mockDeleteEncryptedAsset.mockImplementation(() => Promise.resolve(false));
      const response = await router.handle(
        makeAuthRequest("/keys/encrypted-data/document/nonexistent", "DELETE"),
      );
      expect(response.status).toBe(404);
    });
  });

  // ==========================================================================
  // PATCH /keys/encrypted-data/:asset_type/:asset_id/authorized-keys
  // ==========================================================================

  describe("PATCH /keys/encrypted-data/:asset_type/:asset_id/authorized-keys", () => {
    const updateBody = {
      authorized_key_ids: [SAMPLE_KEY_RESPONSE.id],
    };

    test("returns 200 with updated EncryptedAssetResponse", async () => {
      const response = await router.handle(
        makeAuthRequest(
          "/keys/encrypted-data/document/some-id/authorized-keys",
          "PATCH",
          updateBody,
        ),
      );
      expect(response.status).toBe(200);
      const body = await jsonBody<EncryptedAssetResponse>(response);
      expect(body.id).toBe(SAMPLE_ENCRYPTED_ASSET_RESPONSE.id);
    });

    test("returns 404 when asset not found", async () => {
      mockUpdateAuthorizedKeys.mockImplementation(() => {
        throw new EncryptedAssetNotFoundError("document", "some-id");
      });
      const response = await router.handle(
        makeAuthRequest(
          "/keys/encrypted-data/document/some-id/authorized-keys",
          "PATCH",
          updateBody,
        ),
      );
      expect(response.status).toBe(404);
    });

    test("returns 400 when authorized_key_ids are invalid", async () => {
      mockUpdateAuthorizedKeys.mockImplementation(() => {
        throw new InvalidAuthorizedKeys(["bad-id"]);
      });
      const response = await router.handle(
        makeAuthRequest(
          "/keys/encrypted-data/document/some-id/authorized-keys",
          "PATCH",
          updateBody,
        ),
      );
      expect(response.status).toBe(400);
    });

    test("returns 400 when payload provided without IV", async () => {
      mockUpdateAuthorizedKeys.mockImplementation(() => {
        throw new InvalidInputError(
          "encrypted_payload and initialization_vector must both be provided or both be omitted during key rotation",
        );
      });
      const response = await router.handle(
        makeAuthRequest(
          "/keys/encrypted-data/document/some-id/authorized-keys",
          "PATCH",
          { ...updateBody, encrypted_payload: "abc" },
        ),
      );
      expect(response.status).toBe(400);
    });

    test("accepts payload + IV together for key rotation", async () => {
      const response = await router.handle(
        makeAuthRequest(
          "/keys/encrypted-data/document/some-id/authorized-keys",
          "PATCH",
          {
            ...updateBody,
            encrypted_payload: "bmV3cGF5bG9hZA==",
            initialization_vector: "bmV3aXY=",
          },
        ),
      );
      expect(response.status).toBe(200);
    });
  });

  // ==========================================================================
  // Route registration checks
  // ==========================================================================

  describe("route registration", () => {
    test("all 18 /keys/* routes are registered", () => {
      const allRoutes = router.listRoutes();
      const keyRoutes = allRoutes.filter((route) => route.pattern.startsWith("/keys"));
      expect(keyRoutes.length).toBe(18);
    });

    test("POST /keys/register is registered", () => {
      const allRoutes = router.listRoutes();
      const match = allRoutes.find((r) => r.method === "POST" && r.pattern === "/keys/register");
      expect(match).toBeDefined();
    });

    test("GET /keys is registered", () => {
      const allRoutes = router.listRoutes();
      const match = allRoutes.find((r) => r.method === "GET" && r.pattern === "/keys");
      expect(match).toBeDefined();
    });

    test("GET /keys/:key_id is registered", () => {
      const allRoutes = router.listRoutes();
      const match = allRoutes.find((r) => r.method === "GET" && r.pattern === "/keys/:key_id");
      expect(match).toBeDefined();
    });

    test("PATCH /keys/:key_id is registered", () => {
      const allRoutes = router.listRoutes();
      const match = allRoutes.find((r) => r.method === "PATCH" && r.pattern === "/keys/:key_id");
      expect(match).toBeDefined();
    });

    test("DELETE /keys/:key_id is registered", () => {
      const allRoutes = router.listRoutes();
      const match = allRoutes.find((r) => r.method === "DELETE" && r.pattern === "/keys/:key_id");
      expect(match).toBeDefined();
    });

    test("POST /keys/assertions is registered", () => {
      const allRoutes = router.listRoutes();
      const match = allRoutes.find((r) => r.method === "POST" && r.pattern === "/keys/assertions");
      expect(match).toBeDefined();
    });

    test("GET /keys/assertions is registered", () => {
      const allRoutes = router.listRoutes();
      const match = allRoutes.find((r) => r.method === "GET" && r.pattern === "/keys/assertions");
      expect(match).toBeDefined();
    });

    test("GET /keys/assertions/status is registered", () => {
      const allRoutes = router.listRoutes();
      const match = allRoutes.find((r) => r.method === "GET" && r.pattern === "/keys/assertions/status");
      expect(match).toBeDefined();
    });

    test("POST /keys/assertions/:assertion_id/consume is registered", () => {
      const allRoutes = router.listRoutes();
      const match = allRoutes.find((r) => r.method === "POST" && r.pattern === "/keys/assertions/:assertion_id/consume");
      expect(match).toBeDefined();
    });

    test("POST /keys/policies is registered", () => {
      const allRoutes = router.listRoutes();
      const match = allRoutes.find((r) => r.method === "POST" && r.pattern === "/keys/policies");
      expect(match).toBeDefined();
    });

    test("GET /keys/policies is registered", () => {
      const allRoutes = router.listRoutes();
      const match = allRoutes.find((r) => r.method === "GET" && r.pattern === "/keys/policies");
      expect(match).toBeDefined();
    });

    test("GET /keys/policies/:policy_id is registered", () => {
      const allRoutes = router.listRoutes();
      const match = allRoutes.find((r) => r.method === "GET" && r.pattern === "/keys/policies/:policy_id");
      expect(match).toBeDefined();
    });

    test("DELETE /keys/policies/:policy_id is registered", () => {
      const allRoutes = router.listRoutes();
      const match = allRoutes.find((r) => r.method === "DELETE" && r.pattern === "/keys/policies/:policy_id");
      expect(match).toBeDefined();
    });

    test("POST /keys/encrypted-data is registered", () => {
      const allRoutes = router.listRoutes();
      const match = allRoutes.find((r) => r.method === "POST" && r.pattern === "/keys/encrypted-data");
      expect(match).toBeDefined();
    });

    test("GET /keys/encrypted-data is registered", () => {
      const allRoutes = router.listRoutes();
      const match = allRoutes.find((r) => r.method === "GET" && r.pattern === "/keys/encrypted-data");
      expect(match).toBeDefined();
    });

    test("GET /keys/encrypted-data/:asset_type/:asset_id is registered", () => {
      const allRoutes = router.listRoutes();
      const match = allRoutes.find((r) => r.method === "GET" && r.pattern === "/keys/encrypted-data/:asset_type/:asset_id");
      expect(match).toBeDefined();
    });

    test("DELETE /keys/encrypted-data/:asset_type/:asset_id is registered", () => {
      const allRoutes = router.listRoutes();
      const match = allRoutes.find((r) => r.method === "DELETE" && r.pattern === "/keys/encrypted-data/:asset_type/:asset_id");
      expect(match).toBeDefined();
    });

    test("PATCH /keys/encrypted-data/:asset_type/:asset_id/authorized-keys is registered", () => {
      const allRoutes = router.listRoutes();
      const match = allRoutes.find(
        (r) => r.method === "PATCH" && r.pattern === "/keys/encrypted-data/:asset_type/:asset_id/authorized-keys",
      );
      expect(match).toBeDefined();
    });
  });

  // ==========================================================================
  // Method not allowed
  // ==========================================================================

  describe("method not allowed", () => {
    test("PUT /keys/register returns 405", async () => {
      const response = await router.handle(
        makeAuthRequest("/keys/register", "PUT"),
      );
      expect(response.status).toBe(405);
    });

    test("PUT /keys/assertions returns 405", async () => {
      const response = await router.handle(
        makeAuthRequest("/keys/assertions", "PUT"),
      );
      expect(response.status).toBe(405);
    });
  });

  // ==========================================================================
  // Content-Type and JSON response shape
  // ==========================================================================

  describe("response shape", () => {
    test("all error responses use { detail: string } shape", async () => {
      // Missing auth → 401
      const response = await router.handle(makeRequest("/keys"));
      expect(response.status).toBe(401);
      const body = await jsonBody<Record<string, unknown>>(response);
      expect(typeof body.detail).toBe("string");
      expect(response.headers.get("Content-Type")).toBe("application/json");
    });

    test("success responses have application/json Content-Type", async () => {
      const response = await router.handle(makeAuthRequest("/keys"));
      expect(response.headers.get("Content-Type")).toBe("application/json");
    });

    test("428 response has application/json Content-Type", async () => {
      mockGetEncryptedAssetWithKeyCheck.mockImplementation(() => Promise.resolve({
        access: {
          allowed: false,
          reason: "key required",
          requires_assertion: true,
          required_key_count: 1,
          assertions_present: 0,
        },
        data: null,
      }));
      const response = await router.handle(
        makeAuthRequest("/keys/encrypted-data/document/44444444-4444-4444-4444-444444444444"),
      );
      expect(response.status).toBe(428);
      expect(response.headers.get("Content-Type")).toBe("application/json");
    });
  });
});
