/**
 * Authentication module for the Fractal Agents Runtime — TypeScript/Bun.
 *
 * Provides JWT-based user identification by decoding Supabase JWTs.
 * When SUPABASE_JWT_SECRET is configured, the token signature is verified
 * using HMAC-SHA256 via the Web Crypto API. When the secret is absent
 * (e.g. local dev without Supabase auth), the token payload is decoded
 * without verification.
 *
 * Reference:
 *   - apps/python/src/server/auth.py
 *   - Task-07 scratchpad § Auth Module
 */

// ============================================================================
// Types
// ============================================================================

/**
 * Authenticated user extracted from a Supabase JWT.
 *
 * `identity` is the `sub` claim (Supabase user UUID).
 * `email` is the optional `email` claim.
 */
export interface AuthUser {
  identity: string;
  email?: string;
}

// ============================================================================
// Errors
// ============================================================================

/**
 * Thrown when authentication fails (missing header, bad format, invalid token).
 * Always maps to HTTP 401.
 */
export class AuthenticationError extends Error {
  readonly statusCode = 401;

  constructor(message: string) {
    super(message);
    this.name = "AuthenticationError";
  }
}

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * Decode a base64url string to a Uint8Array.
 *
 * Handles the base64url → standard base64 conversion and padding.
 */
function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * Verify an HMAC-SHA256 JWT signature using the Web Crypto API.
 *
 * @param headerAndPayload - The "header.payload" portion of the JWT.
 * @param signatureBytes - The decoded signature bytes.
 * @param secretBytes - The raw secret key bytes.
 * @returns True if the signature is valid.
 */
async function verifyHmacSha256(
  headerAndPayload: string,
  signatureBytes: Uint8Array,
  secretBytes: Uint8Array,
): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    secretBytes.buffer as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    "HMAC",
    key,
    signatureBytes.buffer as ArrayBuffer,
    encoder.encode(headerAndPayload),
  );
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Extract and validate the authenticated user from a request's
 * Authorization header.
 *
 * Expected header format: `Bearer <jwt>`
 *
 * When `SUPABASE_JWT_SECRET` is set the token's HMAC-SHA256 signature
 * is verified. Otherwise only the payload is decoded (suitable for
 * local development with unsigned tokens).
 *
 * @param request - The incoming HTTP request.
 * @returns The authenticated user.
 * @throws AuthenticationError if the header is missing, malformed, or the
 *   token is invalid / has no `sub` claim.
 */
export async function requireUser(request: Request): Promise<AuthUser> {
  const authHeader =
    request.headers.get("authorization") ||
    request.headers.get("Authorization");

  if (!authHeader) {
    throw new AuthenticationError("Authorization header missing");
  }

  const parts = authHeader.split(" ");
  if (parts.length !== 2 || parts[0].toLowerCase() !== "bearer") {
    throw new AuthenticationError("Invalid authorization header format");
  }

  const token = parts[1];
  const segments = token.split(".");
  if (segments.length !== 3) {
    throw new AuthenticationError("Invalid JWT format");
  }

  // Optionally verify signature when the secret is available
  const jwtSecret = process.env.SUPABASE_JWT_SECRET;
  if (jwtSecret) {
    try {
      const headerAndPayload = `${segments[0]}.${segments[1]}`;
      const signatureBytes = decodeBase64Url(segments[2]);
      const secretBytes = new TextEncoder().encode(jwtSecret);
      const valid = await verifyHmacSha256(
        headerAndPayload,
        signatureBytes,
        secretBytes,
      );
      if (!valid) {
        throw new AuthenticationError("Invalid token signature");
      }
    } catch (error) {
      if (error instanceof AuthenticationError) {
        throw error;
      }
      throw new AuthenticationError(
        `Token verification failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // Decode payload
  let payload: Record<string, unknown>;
  try {
    const payloadJson = Buffer.from(segments[1], "base64url").toString("utf-8");
    payload = JSON.parse(payloadJson) as Record<string, unknown>;
  } catch {
    throw new AuthenticationError("Invalid token payload");
  }

  if (!payload.sub || typeof payload.sub !== "string") {
    throw new AuthenticationError("Invalid token: no sub claim");
  }

  return {
    identity: payload.sub,
    email: typeof payload.email === "string" ? payload.email : undefined,
  };
}
