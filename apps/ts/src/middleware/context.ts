/**
 * Request-scoped user context for the Fractal Agents Runtime — TypeScript/Bun.
 *
 * Provides helpers to store and retrieve the authenticated user for the
 * current request. Used by route handlers to access the user identity
 * without threading it through every function signature.
 *
 * ## Threading Model
 *
 * Bun.serve() processes requests sequentially in a single thread — the
 * `fetch` handler runs to completion (including all awaited async work
 * in the middleware chain and route handler) before the next request
 * begins. This means a simple module-level variable is safe for
 * request-scoped state — no `ContextVar`, `AsyncLocalStorage`, or
 * `threading.local()` needed (unlike the Python runtime, which uses
 * `ContextVar` + `threading.local()` because Robyn crosses Rust/Python
 * thread boundaries).
 *
 * If Bun ever gains true concurrent request handling (e.g., via Workers
 * or a multi-threaded fetch handler), this module must be replaced with
 * `AsyncLocalStorage` or a similar mechanism.
 *
 * ## Usage
 *
 * The auth middleware calls `setCurrentUser()` after verifying the JWT
 * token. Route handlers call `getCurrentUser()`, `requireUser()`, or
 * `getUserIdentity()` to access the authenticated user.
 *
 * ```ts
 * // In auth middleware:
 * setCurrentUser(verifiedUser);
 *
 * // In route handler:
 * const user = getCurrentUser();        // AuthUser | null
 * const user = requireUser();           // AuthUser (throws if null)
 * const ownerId = getUserIdentity();    // string | undefined
 * ```
 *
 * Reference: apps/python/src/server/auth.py → get_current_user(), require_user()
 */

import type { AuthUser } from "../infra/security/auth";
import { AuthenticationError } from "../infra/security/auth";

// ---------------------------------------------------------------------------
// Module-level request-scoped state
// ---------------------------------------------------------------------------

/**
 * The authenticated user for the current request, or `null` if the
 * request is unauthenticated (public path or auth disabled).
 *
 * Set by `authMiddleware()` before route dispatch, cleared after
 * the response is sent (or on the next `setCurrentUser()` call).
 */
let currentUser: AuthUser | null = null;

/**
 * The raw Bearer token for the current request, or `null` if the
 * request is unauthenticated.
 *
 * Stored alongside the user so downstream code (e.g., MCP tool
 * integration) can exchange the Supabase token for service-specific
 * credentials without re-parsing the Authorization header.
 *
 * Set by `authMiddleware()` after successful JWT verification.
 */
let currentToken: string | null = null;

// ---------------------------------------------------------------------------
// Setters
// ---------------------------------------------------------------------------

/**
 * Store the authenticated user for the current request.
 *
 * Called by the auth middleware after successful JWT verification.
 * Pass `null` to clear the user (e.g., for public paths or when
 * auth is disabled).
 *
 * @param user - The verified `AuthUser`, or `null` to clear.
 */
export function setCurrentUser(user: AuthUser | null): void {
  currentUser = user;
}

/**
 * Store the raw Bearer token for the current request.
 *
 * Called by the auth middleware after successful JWT verification,
 * alongside `setCurrentUser()`. The token is needed by downstream
 * code that performs token exchange (e.g., MCP OAuth2 flow).
 *
 * @param token - The raw access token string, or `null` to clear.
 */
export function setCurrentToken(token: string | null): void {
  currentToken = token;
}

/**
 * Clear the current user context (user + token).
 *
 * Convenience wrapper around `setCurrentUser(null)` +
 * `setCurrentToken(null)`. Called after request processing completes
 * to avoid leaking user context to the next request (defense-in-depth —
 * `setCurrentUser` at the start of each request would also achieve this).
 */
export function clearCurrentUser(): void {
  currentUser = null;
  currentToken = null;
}

/**
 * Clear the current token only.
 *
 * Typically not needed — `clearCurrentUser()` clears both. Provided
 * for symmetry with `setCurrentToken()`.
 */
export function clearCurrentToken(): void {
  currentToken = null;
}

// ---------------------------------------------------------------------------
// Getters
// ---------------------------------------------------------------------------

/**
 * Get the authenticated user for the current request.
 *
 * Returns `null` if:
 *   - The request is to a public endpoint (auth was skipped)
 *   - Auth is disabled (Supabase not configured)
 *   - No auth middleware has run yet
 *
 * @returns The `AuthUser` if authenticated, `null` otherwise.
 *
 * @example
 *   const user = getCurrentUser();
 *   if (user) {
 *     console.log(`Request from user ${user.identity}`);
 *   }
 */
export function getCurrentUser(): AuthUser | null {
  return currentUser;
}

/**
 * Get the authenticated user, throwing if not authenticated.
 *
 * Use this in route handlers that **require** authentication. If the
 * auth middleware is correctly wired, this should never throw for
 * protected endpoints — but it provides a safety net.
 *
 * @returns The `AuthUser` for the current request.
 * @throws {AuthenticationError} If no user is authenticated.
 *
 * @example
 *   // In a protected route handler:
 *   const user = requireUser();
 *   const ownerId = user.identity;
 *   const assistants = await storage.assistants.search({ ownerId });
 */
export function requireUser(): AuthUser {
  if (currentUser === null) {
    throw new AuthenticationError("Authentication required");
  }
  return currentUser;
}

/**
 * Get the current user's identity (Supabase user ID).
 *
 * Shorthand for `getCurrentUser()?.identity ?? undefined`. Used when only
 * the user ID is needed (e.g., for storage scoping by `owner_id`).
 *
 * Returns `undefined` (not `null`) so it can be passed directly to
 * storage methods that accept `ownerId?: string`.
 *
 * @returns The user ID string if authenticated, `undefined` otherwise.
 *
 * @example
 *   const ownerId = getUserIdentity();
 *   // Pass to storage operations for per-user scoping
 *   const assistant = await storage.assistants.get(id, ownerId);
 */
export function getUserIdentity(): string | undefined {
  return currentUser?.identity ?? undefined;
}

/**
 * Get the raw Bearer token for the current request.
 *
 * Returns `null` if:
 *   - The request is to a public endpoint (auth was skipped)
 *   - Auth is disabled (Supabase not configured)
 *   - No auth middleware has run yet
 *
 * Used by the graph factory to pass the Supabase token into the
 * configurable dict as `x-supabase-access-token`, enabling MCP
 * servers that require OAuth2 token exchange.
 *
 * @returns The raw access token string, or `null`.
 *
 * @example
 *   const token = getCurrentToken();
 *   if (token) {
 *     configurable["x-supabase-access-token"] = token;
 *   }
 */
export function getCurrentToken(): string | null {
  return currentToken;
}
