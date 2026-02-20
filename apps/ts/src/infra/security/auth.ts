/**
 * Core authentication primitives for Supabase JWT verification.
 *
 * Provides:
 *   - `AuthUser` type for authenticated user identity
 *   - `AuthenticationError` for auth failure signaling
 *   - `getSupabaseClient()` — Lazy-initialized Supabase client singleton
 *   - `verifyToken()` — Verify a Bearer token against Supabase Auth
 *   - `verifyTokenLocal()` — Fast local JWT verification (HS256)
 *   - `isAuthEnabled()` — Check if Supabase is configured
 *
 * ## Verification Strategies
 *
 * **HTTP verification** (`verifyToken`):
 *   Calls `supabase.auth.getUser(token)` — validates against GoTrue,
 *   detects revoked tokens, returns full user metadata. Accurate but
 *   limited to ~30 req/s against a local GoTrue instance.
 *
 * **Local verification** (`verifyTokenLocal`):
 *   Verifies the HS256 JWT signature locally using `SUPABASE_JWT_SECRET`
 *   and Bun.CryptoHasher (native C/Zig HMAC-SHA256). Sub-millisecond,
 *   no network round-trip. Opt-in via `SUPABASE_JWT_SECRET` env var.
 *
 *   Tradeoffs (per Supabase docs recommendation):
 *     - Cannot detect revoked tokens (acceptable for benchmarks)
 *     - JWT secret must be kept secure (never expose client-side)
 *     - Supabase recommends JWKS/asymmetric keys for production
 *
 *   Reference: https://supabase.com/docs/guides/auth/jwts
 *
 * The active strategy is selected by `verifyTokenAuto()`:
 *   - If `SUPABASE_JWT_SECRET` is set → local verification
 *   - Otherwise → HTTP verification via GoTrue
 *
 * Mirrors the Python runtime's `apps/python/src/server/auth.py` auth
 * primitives, adapted for the Bun/TypeScript runtime.
 *
 * Reference: apps/python/src/server/auth.py → AuthUser, verify_token()
 * Reference: https://bun.com/docs/runtime/hashing (Bun.CryptoHasher HMAC)
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// AuthUser type
// ---------------------------------------------------------------------------

/**
 * Authenticated user information extracted from a verified JWT.
 *
 * Mirrors Python's `AuthUser` dataclass from `server/auth.py`.
 *
 * @example
 *   const user: AuthUser = {
 *     identity: "550e8400-e29b-41d4-a716-446655440000",
 *     email: "user@example.com",
 *     metadata: { name: "Alice" },
 *   };
 */
export interface AuthUser {
  /** Supabase user ID (UUID string). Used as `owner_id` for storage scoping. */
  identity: string;

  /** User's email address from Supabase, or `null` if not available. */
  email: string | null;

  /** Additional user metadata from Supabase's `user_metadata` field. */
  metadata: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// AuthenticationError
// ---------------------------------------------------------------------------

/**
 * Error thrown when authentication fails.
 *
 * Carries a `statusCode` (default 401) so the middleware can return the
 * appropriate HTTP status without parsing the error message.
 *
 * Mirrors Python's `AuthenticationError` from `server/auth.py`.
 */
export class AuthenticationError extends Error {
  /** HTTP status code to return (default 401). */
  readonly statusCode: number;

  constructor(message: string, statusCode = 401) {
    super(message);
    this.name = "AuthenticationError";
    this.statusCode = statusCode;
  }
}

// ---------------------------------------------------------------------------
// Supabase client singleton
// ---------------------------------------------------------------------------

let supabaseClient: SupabaseClient | null = null;

/**
 * Get or create the Supabase client singleton.
 *
 * The client is created lazily on first call using `SUPABASE_URL` and
 * `SUPABASE_KEY` environment variables. Subsequent calls return the
 * same instance.
 *
 * Returns `null` if Supabase is not configured (missing env vars),
 * which signals the auth middleware to operate in "disabled" mode.
 *
 * @returns The Supabase client instance, or `null` if not configured.
 */
export function getSupabaseClient(): SupabaseClient | null {
  if (supabaseClient !== null) {
    return supabaseClient;
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    return null;
  }

  try {
    supabaseClient = createClient(supabaseUrl, supabaseKey);
    console.log("[auth] Supabase client initialized");
    return supabaseClient;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[auth] Failed to create Supabase client: ${message}`);
    return null;
  }
}

/**
 * Reset the Supabase client singleton.
 *
 * **For testing only.** Forces `getSupabaseClient()` to create a fresh
 * instance on its next call.
 */
export function resetSupabaseClient(): void {
  supabaseClient = null;
}

// ---------------------------------------------------------------------------
// Auth status
// ---------------------------------------------------------------------------

/**
 * Lazy-cached auth-enabled flag.
 *
 * `null` means "not yet evaluated". On the first call to `isAuthEnabled()`
 * the flag is computed from `SUPABASE_URL` and `SUPABASE_KEY` and then
 * cached for all subsequent calls — zero per-request overhead without the
 * eager-evaluation pitfall that breaks tests (which set env vars *after*
 * module import).
 *
 * Call `resetAuthState()` in tests to force re-evaluation.
 */
let _authEnabled: boolean | null = null;

/**
 * Check whether Supabase authentication is enabled.
 *
 * Returns a cached boolean computed on first call from `SUPABASE_URL`
 * and `SUPABASE_KEY` environment variables. When disabled, the auth
 * middleware passes all requests through without verification.
 *
 * @returns `true` if Supabase is configured and auth is enabled.
 */
export function isAuthEnabled(): boolean {
  if (_authEnabled === null) {
    _authEnabled =
      Boolean(process.env.SUPABASE_URL) &&
      Boolean(process.env.SUPABASE_KEY);
  }
  return _authEnabled;
}

/**
 * Reset the cached auth-enabled flag so it is re-evaluated on next call.
 *
 * **Test-only** — call this in `beforeEach` / `afterEach` when tests
 * manipulate `SUPABASE_URL` or `SUPABASE_KEY` environment variables.
 */
export function resetAuthState(): void {
  _authEnabled = null;
}

// ---------------------------------------------------------------------------
// Token verification
// ---------------------------------------------------------------------------

/**
 * Verify a JWT access token with Supabase and return the authenticated user.
 *
 * Calls `supabase.auth.getUser(token)` to verify the token server-side.
 * This validates the JWT against Supabase's auth service, ensuring:
 *   - The token signature is valid
 *   - The token is not expired
 *   - The token has not been revoked
 *   - The user exists and is active
 *
 * Mirrors Python's `verify_token()` from `server/auth.py`.
 *
 * @param token - The raw JWT access token (without "Bearer " prefix).
 * @returns The verified `AuthUser` with identity, email, and metadata.
 * @throws {AuthenticationError} If the token is invalid, expired, or
 *   the Supabase client is not initialized.
 *
 * @example
 *   try {
 *     const user = await verifyToken("eyJhbGciOiJIUzI1NiIs...");
 *     console.log(user.identity); // "550e8400-..."
 *   } catch (error) {
 *     if (error instanceof AuthenticationError) {
 *       console.log(error.message); // "Invalid token or user not found"
 *     }
 *   }
 */
export async function verifyToken(token: string): Promise<AuthUser> {
  const client = getSupabaseClient();

  if (!client) {
    throw new AuthenticationError("Supabase client not initialized", 500);
  }

  try {
    const { data, error } = await client.auth.getUser(token);

    if (error) {
      throw new AuthenticationError(`Authentication error: ${error.message}`);
    }

    const user = data?.user;

    if (!user) {
      throw new AuthenticationError("Invalid token or user not found");
    }

    return {
      identity: user.id,
      email: user.email ?? null,
      metadata: (user.user_metadata as Record<string, unknown>) ?? {},
    };
  } catch (error: unknown) {
    // Re-throw AuthenticationError as-is
    if (error instanceof AuthenticationError) {
      throw error;
    }

    // Wrap unexpected errors — don't leak internal details
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[auth] Token verification failed: ${message}`);
    throw new AuthenticationError(`Authentication error: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// Local JWT verification (HS256 via Bun.CryptoHasher)
// ---------------------------------------------------------------------------

/**
 * Decode a Base64-URL encoded string to a Uint8Array.
 *
 * JWT signatures use Base64-URL encoding (RFC 4648 §5):
 *   - `-` instead of `+`
 *   - `_` instead of `/`
 *   - No padding `=` characters
 *
 * We convert to standard Base64, add padding, then decode via `atob`.
 */
function base64UrlToBytes(base64Url: string): Uint8Array {
  // Replace URL-safe characters with standard Base64 characters
  const base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/");

  // Add padding if needed (Base64 must be a multiple of 4 characters)
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);

  const binaryString = atob(padded);
  const bytes = new Uint8Array(binaryString.length);
  for (let index = 0; index < binaryString.length; index++) {
    bytes[index] = binaryString.charCodeAt(index);
  }
  return bytes;
}

/**
 * Decode a Base64-URL encoded string to a UTF-8 string.
 */
function base64UrlToString(base64Url: string): string {
  const bytes = base64UrlToBytes(base64Url);
  return new TextDecoder().decode(bytes);
}

/** Cached HMAC key bytes — derived once from SUPABASE_JWT_SECRET. */
let cachedJwtSecretBytes: Uint8Array | null = null;

/**
 * Get the JWT secret as bytes for HMAC computation.
 *
 * Caches the encoded bytes to avoid re-encoding on every request.
 */
function getJwtSecretBytes(): Uint8Array | null {
  if (cachedJwtSecretBytes !== null) {
    return cachedJwtSecretBytes;
  }

  const jwtSecret = process.env.SUPABASE_JWT_SECRET;
  if (!jwtSecret) {
    return null;
  }

  cachedJwtSecretBytes = new TextEncoder().encode(jwtSecret);
  return cachedJwtSecretBytes;
}

/**
 * Check whether local JWT verification is available.
 *
 * Local verification requires `SUPABASE_JWT_SECRET` to be set. When
 * available, it eliminates the GoTrue HTTP round-trip entirely.
 *
 * @returns `true` if `SUPABASE_JWT_SECRET` is configured.
 */
export function isLocalJwtEnabled(): boolean {
  return Boolean(process.env.SUPABASE_JWT_SECRET);
}

/**
 * Reset cached JWT secret bytes.
 *
 * **For testing only.** Forces re-read of SUPABASE_JWT_SECRET on next call.
 */
export function resetJwtSecretCache(): void {
  cachedJwtSecretBytes = null;
}

/**
 * Verify a JWT access token locally using HMAC-SHA256.
 *
 * Uses Bun.CryptoHasher (native C/Zig implementation) for HMAC-SHA256
 * signature verification. Sub-millisecond performance, no network I/O.
 *
 * Supabase JWT payload structure (from Supabase docs):
 *   - `sub`           — User ID (UUID)
 *   - `email`         — User email
 *   - `user_metadata` — Custom user metadata object
 *   - `exp`           — Expiration timestamp (Unix seconds)
 *   - `role`          — Postgres role (e.g. "authenticated")
 *   - `iss`           — Issuer URL
 *
 * Reference: https://supabase.com/docs/guides/auth/jwts
 * Reference: https://bun.com/docs/runtime/hashing (HMAC with CryptoHasher)
 *
 * @param token - The raw JWT access token (without "Bearer " prefix).
 * @returns The verified `AuthUser` with identity, email, and metadata.
 * @throws {AuthenticationError} If the token format is invalid, the
 *   signature doesn't match, or the token has expired.
 */
export function verifyTokenLocal(token: string): AuthUser {
  const secretBytes = getJwtSecretBytes();
  if (!secretBytes) {
    throw new AuthenticationError(
      "SUPABASE_JWT_SECRET not configured for local verification",
      500,
    );
  }

  // 1. Split JWT into parts
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new AuthenticationError("Invalid JWT format: expected 3 parts");
  }

  const [headerBase64, payloadBase64, signatureBase64] = parts;

  // 2. Verify the algorithm is HS256
  try {
    const headerJson = base64UrlToString(headerBase64);
    const header = JSON.parse(headerJson) as Record<string, unknown>;

    if (header.alg !== "HS256") {
      throw new AuthenticationError(
        `Unsupported JWT algorithm: ${String(header.alg)} (expected HS256)`,
      );
    }
  } catch (error: unknown) {
    if (error instanceof AuthenticationError) {
      throw error;
    }
    throw new AuthenticationError("Invalid JWT header");
  }

  // 3. Compute HMAC-SHA256 signature.
  //
  // Bun.CryptoHasher with a key argument computes HMAC.
  // The input is the raw ASCII bytes of "<header>.<payload>".
  // Reference: https://bun.com/docs/runtime/hashing
  const signatureInput = `${headerBase64}.${payloadBase64}`;
  const hasher = new Bun.CryptoHasher("sha256", secretBytes);
  hasher.update(signatureInput);
  const computedSignatureBytes = new Uint8Array(hasher.digest() as unknown as ArrayBuffer);

  // 4. Compare with the provided signature (constant-time via loop)
  const providedSignatureBytes = base64UrlToBytes(signatureBase64);

  if (computedSignatureBytes.length !== providedSignatureBytes.length) {
    throw new AuthenticationError("Invalid token signature");
  }

  // Constant-time comparison to prevent timing attacks
  let mismatch = 0;
  for (let index = 0; index < computedSignatureBytes.length; index++) {
    mismatch |= computedSignatureBytes[index] ^ providedSignatureBytes[index];
  }

  if (mismatch !== 0) {
    throw new AuthenticationError("Invalid token signature");
  }

  // 5. Parse and validate payload
  let payload: Record<string, unknown>;
  try {
    const payloadJson = base64UrlToString(payloadBase64);
    payload = JSON.parse(payloadJson) as Record<string, unknown>;
  } catch {
    throw new AuthenticationError("Invalid JWT payload");
  }

  // 6. Check expiration
  const expiration = payload.exp;
  if (typeof expiration === "number") {
    const nowSeconds = Date.now() / 1000;
    if (expiration < nowSeconds) {
      throw new AuthenticationError("Token expired");
    }
  }

  // 7. Extract user information from JWT claims
  //    Supabase JWT payload: sub=userId, email, user_metadata
  const userId = payload.sub;
  if (typeof userId !== "string" || userId.length === 0) {
    throw new AuthenticationError("Invalid token: missing sub claim");
  }

  return {
    identity: userId,
    email: typeof payload.email === "string" ? payload.email : null,
    metadata:
      typeof payload.user_metadata === "object" &&
      payload.user_metadata !== null
        ? (payload.user_metadata as Record<string, unknown>)
        : {},
  };
}

// ---------------------------------------------------------------------------
// Auto-selecting verification strategy
// ---------------------------------------------------------------------------

/**
 * Verify a JWT access token using the best available strategy.
 *
 * Strategy selection (logged once at startup):
 *   - If `SUPABASE_JWT_SECRET` is set → `verifyTokenLocal()` (sub-ms, no I/O)
 *   - Otherwise → `verifyToken()` (HTTP call to GoTrue, ~30ms)
 *
 * This is the function that should be called by the auth middleware.
 * It provides transparent strategy selection without changing the caller.
 *
 * @param token - The raw JWT access token (without "Bearer " prefix).
 * @returns The verified `AuthUser`.
 * @throws {AuthenticationError} On any verification failure.
 */
export async function verifyTokenAuto(token: string): Promise<AuthUser> {
  if (isLocalJwtEnabled()) {
    // Synchronous local verification — wrap in async for uniform API
    return verifyTokenLocal(token);
  }

  // Fall back to HTTP verification via GoTrue
  return verifyToken(token);
}

/** Whether we've logged the verification strategy at startup. */
let strategyLogged = false;

/**
 * Log the active JWT verification strategy (called once).
 *
 * Helps operators understand which path is active without digging
 * through env vars.
 */
export function logVerificationStrategy(): void {
  if (strategyLogged) {
    return;
  }
  strategyLogged = true;

  if (isLocalJwtEnabled()) {
    console.log(
      "[auth] JWT verification strategy: LOCAL (HMAC-SHA256 via Bun.CryptoHasher — no GoTrue HTTP round-trip)",
    );
  } else if (isAuthEnabled()) {
    console.log(
      "[auth] JWT verification strategy: HTTP (GoTrue supabase.auth.getUser — ~30ms per request)",
    );
  } else {
    console.log("[auth] JWT verification: DISABLED (no Supabase configured)");
  }
}
