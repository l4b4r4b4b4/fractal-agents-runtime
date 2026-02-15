/**
 * Core authentication primitives for Supabase JWT verification.
 *
 * Provides:
 *   - `AuthUser` type for authenticated user identity
 *   - `AuthenticationError` for auth failure signaling
 *   - `getSupabaseClient()` — Lazy-initialized Supabase client singleton
 *   - `verifyToken()` — Verify a Bearer token against Supabase Auth
 *   - `isAuthEnabled()` — Check if Supabase is configured
 *
 * Mirrors the Python runtime's `apps/python/src/server/auth.py` auth
 * primitives, adapted for the Bun/TypeScript runtime.
 *
 * The Supabase client uses `supabase.auth.getUser(token)` for server-side
 * JWT verification (validates against Supabase's auth service, rejects
 * revoked tokens, returns full user metadata). This matches the Python
 * runtime's approach exactly.
 *
 * Reference: apps/python/src/server/auth.py → AuthUser, verify_token()
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
 * Check whether Supabase authentication is enabled.
 *
 * Auth is enabled when both `SUPABASE_URL` and `SUPABASE_KEY` environment
 * variables are set. When disabled, the auth middleware passes all requests
 * through without verification.
 *
 * @returns `true` if Supabase is configured and auth is enabled.
 */
export function isAuthEnabled(): boolean {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY;
  return Boolean(supabaseUrl) && Boolean(supabaseKey);
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
