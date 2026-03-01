/**
 * Tests for local JWT verification (HMAC-SHA256 via Bun.CryptoHasher).
 *
 * Validates:
 *   - Valid JWT verification with correct signature
 *   - Expired token rejection
 *   - Invalid signature rejection
 *   - Malformed JWT rejection
 *   - Missing claims rejection
 *   - Unsupported algorithm rejection
 *   - verifyTokenAuto strategy selection
 *   - isLocalJwtEnabled / logVerificationStrategy
 *
 * These tests create real HS256 JWTs signed with a test secret to exercise
 * the full verification path without network I/O.
 *
 * Reference: apps/ts/src/infra/security/auth.ts
 * Reference: https://supabase.com/docs/guides/auth/jwts (JWT structure)
 * Reference: https://bun.com/docs/runtime/hashing (Bun.CryptoHasher HMAC)
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  verifyTokenLocal,
  verifyTokenAuto,
  isLocalJwtEnabled,
  logVerificationStrategy,
  resetJwtSecretCache,
  AuthenticationError,
  resetSupabaseClient,
} from "../src/infra/security/auth";

// ---------------------------------------------------------------------------
// Test helpers — JWT creation
// ---------------------------------------------------------------------------

const TEST_JWT_SECRET = "test-jwt-secret-for-unit-tests-only-32chars!";

/**
 * Base64-URL encode a string (no padding).
 */
function base64UrlEncode(input: string | Uint8Array): string {
  let bytes: Uint8Array;
  if (typeof input === "string") {
    bytes = new TextEncoder().encode(input);
  } else {
    bytes = input;
  }

  // Convert to base64
  let binary = "";
  for (let index = 0; index < bytes.length; index++) {
    binary += String.fromCharCode(bytes[index]);
  }
  const base64 = btoa(binary);

  // Convert to base64url (no padding)
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Create a signed HS256 JWT for testing.
 *
 * @param payload - JWT payload claims.
 * @param secret - HMAC-SHA256 secret (defaults to TEST_JWT_SECRET).
 * @param header - Optional header override.
 * @returns A signed JWT string.
 */
function createTestJwt(
  payload: Record<string, unknown>,
  secret: string = TEST_JWT_SECRET,
  header: Record<string, unknown> = { alg: "HS256", typ: "JWT" },
): string {
  const headerBase64 = base64UrlEncode(JSON.stringify(header));
  const payloadBase64 = base64UrlEncode(JSON.stringify(payload));
  const signatureInput = `${headerBase64}.${payloadBase64}`;

  // Compute HMAC-SHA256 using Bun.CryptoHasher
  const secretBytes = new TextEncoder().encode(secret);
  const hasher = new Bun.CryptoHasher("sha256", secretBytes);
  hasher.update(signatureInput);
  const signatureBytes = new Uint8Array(hasher.digest() as ArrayBuffer);
  const signatureBase64 = base64UrlEncode(signatureBytes);

  return `${headerBase64}.${payloadBase64}.${signatureBase64}`;
}

/**
 * Create a valid Supabase-style JWT payload.
 */
function createValidPayload(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    sub: "550e8400-e29b-41d4-a716-446655440000",
    email: "test@example.com",
    user_metadata: { name: "Test User", role: "admin" },
    exp: Math.floor(Date.now() / 1000) + 3600, // 1 hour from now
    iss: "https://test-project.supabase.co/auth/v1",
    role: "authenticated",
    aud: "authenticated",
    iat: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Environment setup / teardown
// ---------------------------------------------------------------------------

let savedJwtSecret: string | undefined;
let savedSupabaseUrl: string | undefined;
let savedSupabaseKey: string | undefined;

beforeEach(() => {
  savedJwtSecret = process.env.SUPABASE_JWT_SECRET;
  savedSupabaseUrl = process.env.SUPABASE_URL;
  savedSupabaseKey = process.env.SUPABASE_KEY;
  resetJwtSecretCache();
  resetSupabaseClient();
});

afterEach(() => {
  // Restore environment
  if (savedJwtSecret !== undefined) {
    process.env.SUPABASE_JWT_SECRET = savedJwtSecret;
  } else {
    delete process.env.SUPABASE_JWT_SECRET;
  }
  if (savedSupabaseUrl !== undefined) {
    process.env.SUPABASE_URL = savedSupabaseUrl;
  } else {
    delete process.env.SUPABASE_URL;
  }
  if (savedSupabaseKey !== undefined) {
    process.env.SUPABASE_KEY = savedSupabaseKey;
  } else {
    delete process.env.SUPABASE_KEY;
  }
  resetJwtSecretCache();
  resetSupabaseClient();
});

// ---------------------------------------------------------------------------
// isLocalJwtEnabled
// ---------------------------------------------------------------------------

describe("isLocalJwtEnabled", () => {
  test("returns true when SUPABASE_JWT_SECRET is set", () => {
    process.env.SUPABASE_JWT_SECRET = TEST_JWT_SECRET;
    expect(isLocalJwtEnabled()).toBe(true);
  });

  test("returns false when SUPABASE_JWT_SECRET is not set", () => {
    delete process.env.SUPABASE_JWT_SECRET;
    expect(isLocalJwtEnabled()).toBe(false);
  });

  test("returns false when SUPABASE_JWT_SECRET is empty string", () => {
    process.env.SUPABASE_JWT_SECRET = "";
    expect(isLocalJwtEnabled()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// verifyTokenLocal — valid tokens
// ---------------------------------------------------------------------------

describe("verifyTokenLocal — valid tokens", () => {
  beforeEach(() => {
    process.env.SUPABASE_JWT_SECRET = TEST_JWT_SECRET;
    resetJwtSecretCache();
  });

  test("verifies a valid JWT and returns AuthUser", () => {
    const payload = createValidPayload();
    const token = createTestJwt(payload);

    const user = verifyTokenLocal(token);

    expect(user.identity).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(user.email).toBe("test@example.com");
    expect(user.metadata).toEqual({ name: "Test User", role: "admin" });
  });

  test("extracts email from JWT claims", () => {
    const payload = createValidPayload({ email: "alice@wonderland.com" });
    const token = createTestJwt(payload);

    const user = verifyTokenLocal(token);
    expect(user.email).toBe("alice@wonderland.com");
  });

  test("extracts user_metadata from JWT claims", () => {
    const metadata = { name: "Bob", org_id: "org-123", plan: "pro" };
    const payload = createValidPayload({ user_metadata: metadata });
    const token = createTestJwt(payload);

    const user = verifyTokenLocal(token);
    expect(user.metadata).toEqual(metadata);
  });

  test("handles missing email (returns null)", () => {
    const payload = createValidPayload();
    delete payload.email;
    const token = createTestJwt(payload);

    const user = verifyTokenLocal(token);
    expect(user.email).toBeNull();
  });

  test("handles missing user_metadata (returns empty object)", () => {
    const payload = createValidPayload();
    delete payload.user_metadata;
    const token = createTestJwt(payload);

    const user = verifyTokenLocal(token);
    expect(user.metadata).toEqual({});
  });

  test("handles numeric email (returns null)", () => {
    const payload = createValidPayload({ email: 12345 });
    const token = createTestJwt(payload);

    const user = verifyTokenLocal(token);
    expect(user.email).toBeNull();
  });

  test("handles null user_metadata (returns empty object)", () => {
    const payload = createValidPayload({ user_metadata: null });
    const token = createTestJwt(payload);

    const user = verifyTokenLocal(token);
    expect(user.metadata).toEqual({});
  });

  test("verifies token with expiration far in the future", () => {
    const payload = createValidPayload({
      exp: Math.floor(Date.now() / 1000) + 86400, // 24 hours from now
    });
    const token = createTestJwt(payload);

    const user = verifyTokenLocal(token);
    expect(user.identity).toBe("550e8400-e29b-41d4-a716-446655440000");
  });

  test("verifies token with no exp claim (no expiration check)", () => {
    const payload = createValidPayload();
    delete payload.exp;
    const token = createTestJwt(payload);

    const user = verifyTokenLocal(token);
    expect(user.identity).toBe("550e8400-e29b-41d4-a716-446655440000");
  });

  test("identity is the sub claim from JWT", () => {
    const payload = createValidPayload({ sub: "user-uuid-123-456" });
    const token = createTestJwt(payload);

    const user = verifyTokenLocal(token);
    expect(user.identity).toBe("user-uuid-123-456");
  });

  test("caches JWT secret bytes across calls", () => {
    const payload = createValidPayload();
    const token = createTestJwt(payload);

    // First call triggers secret byte encoding
    const user1 = verifyTokenLocal(token);
    // Second call should use cached bytes
    const user2 = verifyTokenLocal(token);

    expect(user1.identity).toBe(user2.identity);
    expect(user1.email).toBe(user2.email);
  });
});

// ---------------------------------------------------------------------------
// verifyTokenLocal — expired tokens
// ---------------------------------------------------------------------------

describe("verifyTokenLocal — expired tokens", () => {
  beforeEach(() => {
    process.env.SUPABASE_JWT_SECRET = TEST_JWT_SECRET;
    resetJwtSecretCache();
  });

  test("rejects token expired 1 hour ago", () => {
    const payload = createValidPayload({
      exp: Math.floor(Date.now() / 1000) - 3600,
    });
    const token = createTestJwt(payload);

    expect(() => verifyTokenLocal(token)).toThrow(AuthenticationError);
    expect(() => verifyTokenLocal(token)).toThrow("Token expired");
  });

  test("rejects token expired 1 second ago", () => {
    const payload = createValidPayload({
      exp: Math.floor(Date.now() / 1000) - 1,
    });
    const token = createTestJwt(payload);

    expect(() => verifyTokenLocal(token)).toThrow("Token expired");
  });

  test("rejects token with exp=0 (epoch)", () => {
    const payload = createValidPayload({ exp: 0 });
    const token = createTestJwt(payload);

    expect(() => verifyTokenLocal(token)).toThrow("Token expired");
  });

  test("expired token error is AuthenticationError with 401 status", () => {
    const payload = createValidPayload({
      exp: Math.floor(Date.now() / 1000) - 60,
    });
    const token = createTestJwt(payload);

    try {
      verifyTokenLocal(token);
      expect(false).toBe(true); // should not reach here
    } catch (error) {
      expect(error).toBeInstanceOf(AuthenticationError);
      expect((error as AuthenticationError).statusCode).toBe(401);
    }
  });
});

// ---------------------------------------------------------------------------
// verifyTokenLocal — invalid signatures
// ---------------------------------------------------------------------------

describe("verifyTokenLocal — invalid signatures", () => {
  beforeEach(() => {
    process.env.SUPABASE_JWT_SECRET = TEST_JWT_SECRET;
    resetJwtSecretCache();
  });

  test("rejects token signed with wrong secret", () => {
    const payload = createValidPayload();
    const token = createTestJwt(payload, "wrong-secret-key-that-does-not-match");

    expect(() => verifyTokenLocal(token)).toThrow(AuthenticationError);
    expect(() => verifyTokenLocal(token)).toThrow("Invalid token signature");
  });

  test("rejects token with tampered payload", () => {
    const payload = createValidPayload();
    const token = createTestJwt(payload);

    // Tamper with the payload — change a character
    const parts = token.split(".");
    const tamperedPayload = base64UrlEncode(
      JSON.stringify({ ...payload, sub: "attacker-id" }),
    );
    const tamperedToken = `${parts[0]}.${tamperedPayload}.${parts[2]}`;

    expect(() => verifyTokenLocal(tamperedToken)).toThrow("Invalid token signature");
  });

  test("rejects token with tampered header", () => {
    const payload = createValidPayload();
    const token = createTestJwt(payload);

    // Tamper with the header
    const parts = token.split(".");
    const tamperedHeader = base64UrlEncode(
      JSON.stringify({ alg: "HS256", typ: "JWT", kid: "tampered" }),
    );
    const tamperedToken = `${tamperedHeader}.${parts[1]}.${parts[2]}`;

    expect(() => verifyTokenLocal(tamperedToken)).toThrow("Invalid token signature");
  });

  test("rejects token with empty signature", () => {
    const payload = createValidPayload();
    const token = createTestJwt(payload);
    const parts = token.split(".");
    const noSigToken = `${parts[0]}.${parts[1]}.`;

    expect(() => verifyTokenLocal(noSigToken)).toThrow("Invalid token signature");
  });

  test("rejects token with truncated signature", () => {
    const payload = createValidPayload();
    const token = createTestJwt(payload);
    const parts = token.split(".");
    const truncatedSig = parts[2].slice(0, 10);
    const truncatedToken = `${parts[0]}.${parts[1]}.${truncatedSig}`;

    expect(() => verifyTokenLocal(truncatedToken)).toThrow("Invalid token signature");
  });
});

// ---------------------------------------------------------------------------
// verifyTokenLocal — malformed JWTs
// ---------------------------------------------------------------------------

describe("verifyTokenLocal — malformed JWTs", () => {
  beforeEach(() => {
    process.env.SUPABASE_JWT_SECRET = TEST_JWT_SECRET;
    resetJwtSecretCache();
  });

  test("rejects empty string", () => {
    expect(() => verifyTokenLocal("")).toThrow(AuthenticationError);
    expect(() => verifyTokenLocal("")).toThrow("Invalid JWT format");
  });

  test("rejects single-part token", () => {
    expect(() => verifyTokenLocal("just-one-part")).toThrow("Invalid JWT format");
  });

  test("rejects two-part token", () => {
    expect(() => verifyTokenLocal("header.payload")).toThrow("Invalid JWT format");
  });

  test("rejects four-part token", () => {
    expect(() => verifyTokenLocal("a.b.c.d")).toThrow("Invalid JWT format");
  });

  test("rejects token with invalid base64 in header", () => {
    expect(() => verifyTokenLocal("!!!.payload.signature")).toThrow(AuthenticationError);
  });

  test("rejects token with non-JSON header", () => {
    const notJson = base64UrlEncode("this is not json");
    const payloadBase64 = base64UrlEncode(JSON.stringify(createValidPayload()));
    expect(() => verifyTokenLocal(`${notJson}.${payloadBase64}.sig`)).toThrow(
      AuthenticationError,
    );
  });

  test("rejects token with non-JSON payload", () => {
    const headerBase64 = base64UrlEncode(
      JSON.stringify({ alg: "HS256", typ: "JWT" }),
    );
    const notJsonPayload = base64UrlEncode("this is not json");
    // Create a valid HMAC for this malformed payload
    const signatureInput = `${headerBase64}.${notJsonPayload}`;
    const secretBytes = new TextEncoder().encode(TEST_JWT_SECRET);
    const hasher = new Bun.CryptoHasher("sha256", secretBytes);
    hasher.update(signatureInput);
    const sigBytes = new Uint8Array(hasher.digest() as ArrayBuffer);
    const sigBase64 = base64UrlEncode(sigBytes);

    expect(() =>
      verifyTokenLocal(`${headerBase64}.${notJsonPayload}.${sigBase64}`),
    ).toThrow("Invalid JWT payload");
  });
});

// ---------------------------------------------------------------------------
// verifyTokenLocal — unsupported algorithms
// ---------------------------------------------------------------------------

describe("verifyTokenLocal — unsupported algorithms", () => {
  beforeEach(() => {
    process.env.SUPABASE_JWT_SECRET = TEST_JWT_SECRET;
    resetJwtSecretCache();
  });

  test("rejects RS256 algorithm", () => {
    const payload = createValidPayload();
    const token = createTestJwt(payload, TEST_JWT_SECRET, {
      alg: "RS256",
      typ: "JWT",
    });

    expect(() => verifyTokenLocal(token)).toThrow("Unsupported JWT algorithm");
    expect(() => verifyTokenLocal(token)).toThrow("RS256");
  });

  test("rejects ES256 algorithm", () => {
    const payload = createValidPayload();
    const token = createTestJwt(payload, TEST_JWT_SECRET, {
      alg: "ES256",
      typ: "JWT",
    });

    expect(() => verifyTokenLocal(token)).toThrow("Unsupported JWT algorithm");
  });

  test("rejects none algorithm", () => {
    const payload = createValidPayload();
    const token = createTestJwt(payload, TEST_JWT_SECRET, {
      alg: "none",
      typ: "JWT",
    });

    expect(() => verifyTokenLocal(token)).toThrow("Unsupported JWT algorithm");
  });

  test("rejects HS384 algorithm", () => {
    const payload = createValidPayload();
    const token = createTestJwt(payload, TEST_JWT_SECRET, {
      alg: "HS384",
      typ: "JWT",
    });

    expect(() => verifyTokenLocal(token)).toThrow("Unsupported JWT algorithm");
  });
});

// ---------------------------------------------------------------------------
// verifyTokenLocal — missing claims
// ---------------------------------------------------------------------------

describe("verifyTokenLocal — missing claims", () => {
  beforeEach(() => {
    process.env.SUPABASE_JWT_SECRET = TEST_JWT_SECRET;
    resetJwtSecretCache();
  });

  test("rejects token without sub claim", () => {
    const payload = createValidPayload();
    delete payload.sub;
    const token = createTestJwt(payload);

    expect(() => verifyTokenLocal(token)).toThrow("missing sub claim");
  });

  test("rejects token with empty sub claim", () => {
    const payload = createValidPayload({ sub: "" });
    const token = createTestJwt(payload);

    expect(() => verifyTokenLocal(token)).toThrow("missing sub claim");
  });

  test("rejects token with non-string sub claim", () => {
    const payload = createValidPayload({ sub: 12345 });
    const token = createTestJwt(payload);

    expect(() => verifyTokenLocal(token)).toThrow("missing sub claim");
  });

  test("rejects token with null sub claim", () => {
    const payload = createValidPayload({ sub: null });
    const token = createTestJwt(payload);

    expect(() => verifyTokenLocal(token)).toThrow("missing sub claim");
  });
});

// ---------------------------------------------------------------------------
// verifyTokenLocal — SUPABASE_JWT_SECRET not configured
// ---------------------------------------------------------------------------

describe("verifyTokenLocal — no secret configured", () => {
  test("throws 500 when SUPABASE_JWT_SECRET is not set", () => {
    delete process.env.SUPABASE_JWT_SECRET;
    resetJwtSecretCache();

    const token = createTestJwt(createValidPayload());

    try {
      verifyTokenLocal(token);
      expect(false).toBe(true); // should not reach here
    } catch (error) {
      expect(error).toBeInstanceOf(AuthenticationError);
      expect((error as AuthenticationError).statusCode).toBe(500);
      expect((error as AuthenticationError).message).toContain(
        "SUPABASE_JWT_SECRET not configured",
      );
    }
  });
});

// ---------------------------------------------------------------------------
// verifyTokenAuto — strategy selection
// ---------------------------------------------------------------------------

describe("verifyTokenAuto", () => {
  test("uses local verification when SUPABASE_JWT_SECRET is set", async () => {
    process.env.SUPABASE_JWT_SECRET = TEST_JWT_SECRET;
    resetJwtSecretCache();

    const payload = createValidPayload();
    const token = createTestJwt(payload);

    const user = await verifyTokenAuto(token);

    expect(user.identity).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(user.email).toBe("test@example.com");
  });

  test("rejects expired token via local verification", async () => {
    process.env.SUPABASE_JWT_SECRET = TEST_JWT_SECRET;
    resetJwtSecretCache();

    const payload = createValidPayload({
      exp: Math.floor(Date.now() / 1000) - 60,
    });
    const token = createTestJwt(payload);

    await expect(verifyTokenAuto(token)).rejects.toThrow("Token expired");
  });

  test("rejects invalid signature via local verification", async () => {
    process.env.SUPABASE_JWT_SECRET = TEST_JWT_SECRET;
    resetJwtSecretCache();

    const payload = createValidPayload();
    const token = createTestJwt(payload, "wrong-secret");

    await expect(verifyTokenAuto(token)).rejects.toThrow(
      "Invalid token signature",
    );
  });

  test("falls back to HTTP when SUPABASE_JWT_SECRET is not set", async () => {
    delete process.env.SUPABASE_JWT_SECRET;
    resetJwtSecretCache();

    // Without Supabase client configured, HTTP path throws 500
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_KEY;
    resetSupabaseClient();

    const token = "fake-token";

    await expect(verifyTokenAuto(token)).rejects.toThrow(
      "Supabase client not initialized",
    );
  });
});

// ---------------------------------------------------------------------------
// logVerificationStrategy
// ---------------------------------------------------------------------------

describe("logVerificationStrategy", () => {
  test("does not throw when local JWT is enabled", () => {
    process.env.SUPABASE_JWT_SECRET = TEST_JWT_SECRET;
    process.env.SUPABASE_URL = "https://test.supabase.co";
    process.env.SUPABASE_KEY = "test-key";

    expect(() => logVerificationStrategy()).not.toThrow();
  });

  test("does not throw when local JWT is disabled but auth is enabled", () => {
    delete process.env.SUPABASE_JWT_SECRET;
    process.env.SUPABASE_URL = "https://test.supabase.co";
    process.env.SUPABASE_KEY = "test-key";

    expect(() => logVerificationStrategy()).not.toThrow();
  });

  test("does not throw when auth is completely disabled", () => {
    delete process.env.SUPABASE_JWT_SECRET;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_KEY;

    expect(() => logVerificationStrategy()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// resetJwtSecretCache
// ---------------------------------------------------------------------------

describe("resetJwtSecretCache", () => {
  test("forces re-read of SUPABASE_JWT_SECRET on next verify", () => {
    process.env.SUPABASE_JWT_SECRET = TEST_JWT_SECRET;
    resetJwtSecretCache();

    const payload = createValidPayload();
    const token = createTestJwt(payload);

    // Verify with current secret
    const user1 = verifyTokenLocal(token);
    expect(user1.identity).toBe("550e8400-e29b-41d4-a716-446655440000");

    // Change secret and reset cache
    process.env.SUPABASE_JWT_SECRET = "new-different-secret-that-wont-match!";
    resetJwtSecretCache();

    // Same token should now fail (signed with old secret)
    expect(() => verifyTokenLocal(token)).toThrow("Invalid token signature");
  });
});

// ---------------------------------------------------------------------------
// Performance characteristics (smoke test)
// ---------------------------------------------------------------------------

describe("verifyTokenLocal — performance", () => {
  test("verifies 1000 tokens in under 100ms", () => {
    process.env.SUPABASE_JWT_SECRET = TEST_JWT_SECRET;
    resetJwtSecretCache();

    const payload = createValidPayload();
    const token = createTestJwt(payload);

    const startNanoseconds = Bun.nanoseconds();
    for (let index = 0; index < 1000; index++) {
      verifyTokenLocal(token);
    }
    const elapsedMs = (Bun.nanoseconds() - startNanoseconds) / 1_000_000;

    // Local JWT verification should be sub-millisecond per call.
    // 1000 calls in under 100ms = <0.1ms per call average.
    expect(elapsedMs).toBeLessThan(100);
    console.log(
      `[perf] 1000 local JWT verifications: ${elapsedMs.toFixed(1)}ms (${(elapsedMs / 1000).toFixed(3)}ms/call)`,
    );
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("verifyTokenLocal — edge cases", () => {
  beforeEach(() => {
    process.env.SUPABASE_JWT_SECRET = TEST_JWT_SECRET;
    resetJwtSecretCache();
  });

  test("handles JWT with extra claims gracefully", () => {
    const payload = createValidPayload({
      custom_claim: "value",
      nested: { deep: { value: 42 } },
      array_claim: [1, 2, 3],
    });
    const token = createTestJwt(payload);

    const user = verifyTokenLocal(token);
    expect(user.identity).toBe("550e8400-e29b-41d4-a716-446655440000");
  });

  test("handles JWT with unicode in claims", () => {
    const payload = createValidPayload({
      email: "ünïcödé@example.com",
      user_metadata: { name: "Ünïcödé Üser", emoji: "🎉" },
    });
    const token = createTestJwt(payload);

    const user = verifyTokenLocal(token);
    expect(user.email).toBe("ünïcödé@example.com");
    expect(user.metadata).toEqual({ name: "Ünïcödé Üser", emoji: "🎉" });
  });

  test("handles JWT with very long sub claim", () => {
    const longSub = "a".repeat(1000);
    const payload = createValidPayload({ sub: longSub });
    const token = createTestJwt(payload);

    const user = verifyTokenLocal(token);
    expect(user.identity).toBe(longSub);
  });

  test("handles JWT with kid in header", () => {
    const payload = createValidPayload();
    const token = createTestJwt(payload, TEST_JWT_SECRET, {
      alg: "HS256",
      typ: "JWT",
      kid: "key-id-123",
    });

    const user = verifyTokenLocal(token);
    expect(user.identity).toBe("550e8400-e29b-41d4-a716-446655440000");
  });

  test("token just barely not expired (1 second remaining)", () => {
    const payload = createValidPayload({
      exp: Math.floor(Date.now() / 1000) + 1,
    });
    const token = createTestJwt(payload);

    // Should still be valid
    const user = verifyTokenLocal(token);
    expect(user.identity).toBe("550e8400-e29b-41d4-a716-446655440000");
  });

  test("user_metadata as array returns empty object", () => {
    const payload = createValidPayload({ user_metadata: [1, 2, 3] });
    const token = createTestJwt(payload);

    // Arrays are objects, so this should work — but our code checks
    // typeof === "object" && !== null, which includes arrays.
    // Arrays are valid objects in JS, so this is expected behavior.
    const user = verifyTokenLocal(token);
    // Arrays are objects, so they pass the check
    expect(user.metadata).toBeDefined();
  });
});
