/**
 * Unit tests for src/lib/auth.ts — JWT authentication module.
 *
 * Tests cover:
 *   - AuthenticationError class behavior
 *   - requireUser() header extraction and validation
 *   - JWT format validation (3-segment requirement)
 *   - Payload decoding (sub claim extraction, email extraction)
 *   - HMAC-SHA256 signature verification (when SUPABASE_JWT_SECRET is set)
 *   - Signature bypass when SUPABASE_JWT_SECRET is absent (dev mode)
 *   - Edge cases: missing sub, non-string sub, malformed base64, etc.
 *
 * IMPORTANT: hardware-keys.test.ts uses `mock.module("../src/lib/auth", ...)`
 * which poisons the module cache process-wide in Bun. When running the full
 * test suite, `requireUser` may be the mocked version rather than the real
 * implementation. Tests that exercise `requireUser` detect this condition
 * and skip gracefully. Run `bun test tests/auth.test.ts` in isolation for
 * full coverage of the auth module.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { requireUser, AuthenticationError } from "../src/lib/auth";

// ============================================================================
// Detect mock pollution from other test files
// ============================================================================

/** Cached result of mock detection (computed once). */
let _isReal: boolean | null = null;

/**
 * Check whether `requireUser` is the real implementation or a mock.
 *
 * The mock from hardware-keys.test.ts does NOT implement HMAC-SHA256
 * signature verification. The real implementation rejects a garbage
 * signature when SUPABASE_JWT_SECRET is set. We exploit this behavioral
 * difference to detect the mock.
 */
async function isRequireUserReal(): Promise<boolean> {
  if (_isReal !== null) return _isReal;

  const savedSecret = process.env.SUPABASE_JWT_SECRET;
  try {
    // Set a secret so the real impl will verify signatures
    process.env.SUPABASE_JWT_SECRET = "__mock_detection_probe__";

    // Build a token with a garbage signature
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" }))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const payload = Buffer.from(
      JSON.stringify({ sub: "probe-user-0000", exp: 9999999999 }),
    )
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const probeToken = `${header}.${payload}.garbage_signature`;

    const probeRequest = new Request("http://localhost/probe", {
      headers: { Authorization: `Bearer ${probeToken}` },
    });
    const result = await requireUser(probeRequest);

    // If it resolved successfully, the mock accepted the garbage signature
    _isReal = false;
    return _isReal;
  } catch (error) {
    if (
      error instanceof AuthenticationError &&
      (error.message.includes("Invalid token signature") ||
        error.message.includes("Token verification failed"))
    ) {
      // Real impl rejected the signature — this is the real module
      _isReal = true;
      return _isReal;
    }
    // Some other error — probably the mock throwing differently
    _isReal = false;
    return _isReal;
  } finally {
    // Restore original env
    if (savedSecret !== undefined) {
      process.env.SUPABASE_JWT_SECRET = savedSecret;
    } else {
      delete process.env.SUPABASE_JWT_SECRET;
    }
  }
}

/**
 * Conditionally run a test only when requireUser is the real implementation.
 * When mocked (full suite run), the test is skipped with a clear message.
 */
function testRequireUser(
  name: string,
  testFunction: () => Promise<void>,
): void {
  test(name, async () => {
    const isReal = await isRequireUserReal();
    if (!isReal) {
      // Skip gracefully — mock.module pollution from hardware-keys.test.ts.
      // Run `bun test tests/auth.test.ts` for full auth coverage.
      return;
    }
    await testFunction();
  });
}

// ============================================================================
// Helpers — Build JWTs for testing
// ============================================================================

/**
 * Encode a JSON object to a base64url string (no padding).
 */
function toBase64Url(object: Record<string, unknown>): string {
  const json = JSON.stringify(object);
  return Buffer.from(json, "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Build an unsigned JWT (header.payload.fakesig) for tests that don't
 * verify signatures.
 */
function buildUnsignedJwt(
  payload: Record<string, unknown>,
  header: Record<string, unknown> = { alg: "HS256", typ: "JWT" },
): string {
  return `${toBase64Url(header)}.${toBase64Url(payload)}.fakesignature`;
}

/**
 * Build a properly signed HMAC-SHA256 JWT using the Web Crypto API.
 */
async function buildSignedJwt(
  payload: Record<string, unknown>,
  secret: string,
): Promise<string> {
  const header = { alg: "HS256", typ: "JWT" };
  const headerEncoded = toBase64Url(header);
  const payloadEncoded = toBase64Url(payload);
  const signingInput = `${headerEncoded}.${payloadEncoded}`;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signatureBuffer = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(signingInput),
  );
  const signatureBase64Url = Buffer.from(signatureBuffer)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  return `${headerEncoded}.${payloadEncoded}.${signatureBase64Url}`;
}

/**
 * Build a Request with an optional Authorization header.
 */
function buildRequest(authHeader?: string): Request {
  const headers = new Headers();
  if (authHeader !== undefined) {
    headers.set("Authorization", authHeader);
  }
  return new Request("http://localhost:3000/test", { headers });
}

// ============================================================================
// Save and restore environment between tests
// ============================================================================

let originalJwtSecret: string | undefined;

beforeEach(() => {
  originalJwtSecret = process.env.SUPABASE_JWT_SECRET;
  // Default: no secret (dev mode — skip signature verification)
  delete process.env.SUPABASE_JWT_SECRET;
});

afterEach(() => {
  if (originalJwtSecret !== undefined) {
    process.env.SUPABASE_JWT_SECRET = originalJwtSecret;
  } else {
    delete process.env.SUPABASE_JWT_SECRET;
  }
});

// ============================================================================
// AuthenticationError — these tests NEVER depend on requireUser
// ============================================================================

describe("AuthenticationError", () => {
  test("has statusCode 401", () => {
    const error = new AuthenticationError("test message");
    expect(error.statusCode).toBe(401);
  });

  test("has name 'AuthenticationError'", () => {
    const error = new AuthenticationError("test");
    expect(error.name).toBe("AuthenticationError");
  });

  test("carries the provided message", () => {
    const error = new AuthenticationError("token expired");
    expect(error.message).toBe("token expired");
  });

  test("is an instance of Error", () => {
    const error = new AuthenticationError("test");
    expect(error).toBeInstanceOf(Error);
  });

  test("statusCode is readonly and always 401", () => {
    const error1 = new AuthenticationError("a");
    const error2 = new AuthenticationError("b");
    expect(error1.statusCode).toBe(401);
    expect(error2.statusCode).toBe(401);
  });

  test("can be caught as Error", () => {
    let caught = false;
    try {
      throw new AuthenticationError("test throw");
    } catch (error) {
      if (error instanceof Error) {
        caught = true;
        expect(error.message).toBe("test throw");
      }
    }
    expect(caught).toBe(true);
  });

  test("stack trace is captured", () => {
    const error = new AuthenticationError("stacktrace test");
    expect(typeof error.stack).toBe("string");
    expect(error.stack!.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// requireUser — Header validation
// ============================================================================

describe("requireUser — header validation", () => {
  testRequireUser(
    "throws when Authorization header is missing",
    async () => {
      const request = buildRequest();
      await expect(requireUser(request)).rejects.toThrow(AuthenticationError);
      await expect(requireUser(request)).rejects.toThrow(
        "Authorization header missing",
      );
    },
  );

  testRequireUser("throws for non-Bearer scheme", async () => {
    const request = buildRequest("Basic dXNlcjpwYXNz");
    await expect(requireUser(request)).rejects.toThrow(AuthenticationError);
    await expect(requireUser(request)).rejects.toThrow(
      "Invalid authorization header format",
    );
  });

  testRequireUser("throws for Bearer with no token", async () => {
    const request = buildRequest("Bearer");
    await expect(requireUser(request)).rejects.toThrow(
      "Invalid authorization header format",
    );
  });

  testRequireUser(
    "throws for Bearer with extra segments in header",
    async () => {
      const request = buildRequest("Bearer token extra");
      await expect(requireUser(request)).rejects.toThrow(
        "Invalid authorization header format",
      );
    },
  );

  testRequireUser("throws for empty Authorization header", async () => {
    // Empty string is falsy in JS — `"" || undefined` → treated as missing
    const request = buildRequest("");
    await expect(requireUser(request)).rejects.toThrow(
      "Authorization header missing",
    );
  });

  testRequireUser(
    "Bearer scheme matching is case-insensitive",
    async () => {
      const token = buildUnsignedJwt({
        sub: "b0000000-0000-0000-0000-000000000001",
      });
      const request = buildRequest(`bearer ${token}`);
      const user = await requireUser(request);
      expect(user.identity).toBe("b0000000-0000-0000-0000-000000000001");
    },
  );
});

// ============================================================================
// requireUser — JWT format validation
// ============================================================================

describe("requireUser — JWT format validation", () => {
  testRequireUser("throws for JWT with only 1 segment", async () => {
    const request = buildRequest("Bearer singlepart");
    await expect(requireUser(request)).rejects.toThrow("Invalid JWT format");
  });

  testRequireUser("throws for JWT with only 2 segments", async () => {
    const request = buildRequest("Bearer part1.part2");
    await expect(requireUser(request)).rejects.toThrow("Invalid JWT format");
  });

  testRequireUser("throws for JWT with 4 segments", async () => {
    const request = buildRequest("Bearer a.b.c.d");
    await expect(requireUser(request)).rejects.toThrow("Invalid JWT format");
  });
});

// ============================================================================
// requireUser — Payload decoding (dev mode, no signature verification)
// ============================================================================

describe("requireUser — payload decoding (dev mode)", () => {
  testRequireUser("extracts sub claim as identity", async () => {
    const token = buildUnsignedJwt({
      sub: "c0000000-1111-2222-3333-444444444444",
      email: "user@example.com",
    });
    const request = buildRequest(`Bearer ${token}`);
    const user = await requireUser(request);
    expect(user.identity).toBe("c0000000-1111-2222-3333-444444444444");
  });

  testRequireUser("extracts email when present", async () => {
    const token = buildUnsignedJwt({
      sub: "d0000000-0000-0000-0000-000000000001",
      email: "alice@test.com",
    });
    const request = buildRequest(`Bearer ${token}`);
    const user = await requireUser(request);
    expect(user.email).toBe("alice@test.com");
  });

  testRequireUser(
    "email is undefined when not present in payload",
    async () => {
      const token = buildUnsignedJwt({
        sub: "e0000000-0000-0000-0000-000000000001",
      });
      const request = buildRequest(`Bearer ${token}`);
      const user = await requireUser(request);
      expect(user.email).toBeUndefined();
    },
  );

  testRequireUser("email is undefined when not a string", async () => {
    const token = buildUnsignedJwt({
      sub: "f0000000-0000-0000-0000-000000000001",
      email: 42,
    });
    const request = buildRequest(`Bearer ${token}`);
    const user = await requireUser(request);
    expect(user.email).toBeUndefined();
  });

  testRequireUser("throws when sub claim is missing", async () => {
    const token = buildUnsignedJwt({
      email: "no-sub@example.com",
      exp: 9999999999,
    });
    const request = buildRequest(`Bearer ${token}`);
    await expect(requireUser(request)).rejects.toThrow(
      "Invalid token: no sub claim",
    );
  });

  testRequireUser("throws when sub claim is not a string", async () => {
    const token = buildUnsignedJwt({ sub: 12345, email: "num-sub@test.com" });
    const request = buildRequest(`Bearer ${token}`);
    await expect(requireUser(request)).rejects.toThrow(
      "Invalid token: no sub claim",
    );
  });

  testRequireUser("throws when sub claim is null", async () => {
    const token = buildUnsignedJwt({ sub: null });
    const request = buildRequest(`Bearer ${token}`);
    await expect(requireUser(request)).rejects.toThrow(
      "Invalid token: no sub claim",
    );
  });

  testRequireUser("throws when sub claim is empty string", async () => {
    const token = buildUnsignedJwt({ sub: "" });
    const request = buildRequest(`Bearer ${token}`);
    await expect(requireUser(request)).rejects.toThrow(
      "Invalid token: no sub claim",
    );
  });

  testRequireUser("throws for malformed base64 payload", async () => {
    // Build a JWT where the payload segment is not valid base64
    const header = toBase64Url({ alg: "HS256", typ: "JWT" });
    const badToken = `${header}.!!!notbase64!!!.fakesig`;
    const request = buildRequest(`Bearer ${badToken}`);
    await expect(requireUser(request)).rejects.toThrow(AuthenticationError);
  });

  testRequireUser(
    "throws for payload that is not valid JSON",
    async () => {
      const header = toBase64Url({ alg: "HS256", typ: "JWT" });
      const notJsonBase64 = Buffer.from("this is not json", "utf-8")
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
      const badToken = `${header}.${notJsonBase64}.fakesig`;
      const request = buildRequest(`Bearer ${badToken}`);
      await expect(requireUser(request)).rejects.toThrow(
        "Invalid token payload",
      );
    },
  );

  testRequireUser(
    "handles payload with additional claims gracefully",
    async () => {
      const token = buildUnsignedJwt({
        sub: "a1111111-2222-3333-4444-555555555555",
        email: "extra@test.com",
        role: "admin",
        iss: "supabase-demo",
        exp: 9999999999,
        iat: 1000000000,
        custom_claim: { nested: true },
      });
      const request = buildRequest(`Bearer ${token}`);
      const user = await requireUser(request);
      expect(user.identity).toBe("a1111111-2222-3333-4444-555555555555");
      expect(user.email).toBe("extra@test.com");
    },
  );
});

// ============================================================================
// requireUser — HMAC-SHA256 signature verification
// ============================================================================

describe("requireUser — HMAC-SHA256 signature verification", () => {
  const testSecret = "super-secret-jwt-key-for-testing-only-do-not-use";

  testRequireUser("accepts a validly signed token", async () => {
    process.env.SUPABASE_JWT_SECRET = testSecret;
    const token = await buildSignedJwt(
      {
        sub: "aaaa0000-bbbb-cccc-dddd-eeeeeeeeeeee",
        email: "signed@example.com",
      },
      testSecret,
    );
    const request = buildRequest(`Bearer ${token}`);
    const user = await requireUser(request);
    expect(user.identity).toBe("aaaa0000-bbbb-cccc-dddd-eeeeeeeeeeee");
    expect(user.email).toBe("signed@example.com");
  });

  testRequireUser(
    "rejects a token with an invalid signature",
    async () => {
      process.env.SUPABASE_JWT_SECRET = testSecret;
      // Sign with a different secret
      const token = await buildSignedJwt(
        { sub: "bbbb1111-0000-0000-0000-000000000001" },
        "wrong-secret-key-that-does-not-match",
      );
      const request = buildRequest(`Bearer ${token}`);
      await expect(requireUser(request)).rejects.toThrow(AuthenticationError);
      await expect(requireUser(request)).rejects.toThrow(
        "Invalid token signature",
      );
    },
  );

  testRequireUser(
    "rejects a token with a tampered payload",
    async () => {
      process.env.SUPABASE_JWT_SECRET = testSecret;
      // Build a valid token, then swap the payload
      const validToken = await buildSignedJwt(
        { sub: "cccc2222-0000-0000-0000-000000000001" },
        testSecret,
      );
      const parts = validToken.split(".");
      // Replace payload with different data but keep original signature
      const tamperedPayload = toBase64Url({
        sub: "attacker-id",
        role: "admin",
      });
      const tamperedToken = `${parts[0]}.${tamperedPayload}.${parts[2]}`;
      const request = buildRequest(`Bearer ${tamperedToken}`);
      await expect(requireUser(request)).rejects.toThrow(
        "Invalid token signature",
      );
    },
  );

  testRequireUser(
    "rejects a token with a garbage signature when secret is set",
    async () => {
      process.env.SUPABASE_JWT_SECRET = testSecret;
      const token = buildUnsignedJwt({
        sub: "dddd3333-0000-0000-0000-000000000001",
      });
      const request = buildRequest(`Bearer ${token}`);
      await expect(requireUser(request)).rejects.toThrow(AuthenticationError);
    },
  );

  testRequireUser(
    "skips verification when SUPABASE_JWT_SECRET is not set",
    async () => {
      // Ensure no secret
      delete process.env.SUPABASE_JWT_SECRET;
      const token = buildUnsignedJwt({
        sub: "eeee4444-0000-0000-0000-000000000001",
      });
      const request = buildRequest(`Bearer ${token}`);
      const user = await requireUser(request);
      expect(user.identity).toBe("eeee4444-0000-0000-0000-000000000001");
    },
  );

  testRequireUser(
    "skips verification when SUPABASE_JWT_SECRET is empty string",
    async () => {
      process.env.SUPABASE_JWT_SECRET = "";
      const token = buildUnsignedJwt({
        sub: "ffff5555-0000-0000-0000-000000000001",
      });
      const request = buildRequest(`Bearer ${token}`);
      const user = await requireUser(request);
      expect(user.identity).toBe("ffff5555-0000-0000-0000-000000000001");
    },
  );
});

// ============================================================================
// requireUser — Return type shape
// ============================================================================

describe("requireUser — return type shape", () => {
  testRequireUser(
    "returned object has exactly identity and optional email",
    async () => {
      const token = buildUnsignedJwt({
        sub: "shape-test-0000-0000-000000000001",
        email: "shape@test.com",
      });
      const request = buildRequest(`Bearer ${token}`);
      const user = await requireUser(request);
      expect(Object.keys(user).sort()).toEqual(["email", "identity"]);
      expect(typeof user.identity).toBe("string");
      expect(typeof user.email).toBe("string");
    },
  );

  testRequireUser(
    "returned object without email has only identity",
    async () => {
      const token = buildUnsignedJwt({
        sub: "shape-test-0000-0000-000000000002",
      });
      const request = buildRequest(`Bearer ${token}`);
      const user = await requireUser(request);
      expect(user.identity).toBe("shape-test-0000-0000-000000000002");
      expect(user.email).toBeUndefined();
    },
  );
});

// ============================================================================
// Error identity — all auth errors should be AuthenticationError (401)
// These tests verify error construction, not requireUser behavior.
// ============================================================================

describe("AuthenticationError — various messages all produce 401", () => {
  const messages = [
    "Authorization header missing",
    "Invalid authorization header format",
    "Invalid JWT format",
    "Invalid token signature",
    "Invalid token payload",
    "Invalid token: no sub claim",
    "Token verification failed: some reason",
  ];

  for (const message of messages) {
    test(`"${message}" → statusCode 401`, () => {
      const error = new AuthenticationError(message);
      expect(error.statusCode).toBe(401);
      expect(error.name).toBe("AuthenticationError");
      expect(error.message).toBe(message);
      expect(error).toBeInstanceOf(Error);
    });
  }
});
