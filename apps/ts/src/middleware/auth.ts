/**
 * Supabase JWT authentication middleware for Bun.serve() router.
 *
 * This middleware:
 *   1. Skips authentication for public endpoints (health, info, docs)
 *   2. Passes all requests through when Supabase is not configured (graceful degradation)
 *   3. Extracts and validates the `Authorization: Bearer <token>` header
 *   4. Verifies the JWT token with Supabase via `verifyToken()`
 *   5. Stores the authenticated user in request-scoped context
 *
 * Error responses match the Python runtime's format:
 *   `{ "detail": "Authorization header missing" }`
 *
 * Wired into the router via `router.use(authMiddleware)` in `index.ts`.
 *
 * Reference: apps/python/src/server/auth.py → auth_middleware()
 */

import {
  isAuthEnabled,
  verifyToken,
  AuthenticationError,
} from "../infra/security/auth";
import { setCurrentUser, setCurrentToken, clearCurrentUser } from "./context";
import { errorResponse } from "../routes/helpers";

// ---------------------------------------------------------------------------
// Public paths — no authentication required
// ---------------------------------------------------------------------------

/**
 * Set of paths that bypass authentication entirely.
 *
 * These endpoints must be accessible without a Bearer token for health
 * checks, service discovery, and documentation. Matches the Python
 * runtime's `PUBLIC_PATHS` set from `server/auth.py`.
 */
const PUBLIC_PATHS: ReadonlySet<string> = new Set([
  "/",
  "/health",
  "/ok",
  "/info",
  "/docs",
  "/openapi.json",
  "/metrics",
  "/metrics/json",
]);

/**
 * Check if a request path is public (doesn't require authentication).
 *
 * Performs an exact match against the `PUBLIC_PATHS` set, with
 * trailing-slash normalization (e.g., `/health/` matches `/health`).
 *
 * @param path - The URL path to check (e.g., `/health`, `/threads/abc`).
 * @returns `true` if the path is public and should bypass auth.
 *
 * @example
 *   isPublicPath("/health")   // true
 *   isPublicPath("/health/")  // true
 *   isPublicPath("/threads")  // false
 */
export function isPublicPath(path: string): boolean {
  if (PUBLIC_PATHS.has(path)) {
    return true;
  }

  // Strip trailing slash and check again
  const normalized = path.replace(/\/+$/, "");
  if (normalized.length > 0 && PUBLIC_PATHS.has(normalized)) {
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Header parsing
// ---------------------------------------------------------------------------

/**
 * Extract the Bearer token from an Authorization header value.
 *
 * Expects the format `Bearer <token>`. Returns the raw token string
 * on success, or `null` if the header is malformed.
 *
 * @param headerValue - The full `Authorization` header value.
 * @returns The extracted token, or `null` if the format is invalid.
 */
function extractBearerToken(headerValue: string): string | null {
  const parts = headerValue.split(" ");

  if (parts.length !== 2) {
    return null;
  }

  const [scheme, token] = parts;

  if (scheme.toLowerCase() !== "bearer") {
    return null;
  }

  if (token.length === 0) {
    return null;
  }

  return token;
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/**
 * Authentication middleware for the Bun.serve() router.
 *
 * Designed to be registered via `router.use(authMiddleware)`. The router
 * calls this function for every incoming request before route dispatch.
 *
 * Behaviour:
 *   - **Public path** → clears user context, returns `null` (continue)
 *   - **Auth disabled** (Supabase not configured) → clears user context,
 *     returns `null` (continue). Logs a one-time warning at startup.
 *   - **Missing header** → returns 401 `{"detail": "Authorization header missing"}`
 *   - **Invalid format** → returns 401 `{"detail": "Invalid authorization header format"}`
 *   - **Invalid token** → returns 401 `{"detail": "Authentication error: ..."}`
 *   - **Valid token** → sets user context, returns `null` (continue)
 *
 * The return type matches the `Middleware` type from `router.ts`:
 *   - `Response` — short-circuits the request (auth failure)
 *   - `null` — continues to the next middleware or route handler
 *
 * @param request - The incoming HTTP request from Bun.serve().
 * @returns `null` to continue, or a `Response` to short-circuit with an error.
 */
export async function authMiddleware(
  request: Request,
): Promise<Response | null> {
  // Extract the URL path for public-path checks
  const url = new URL(request.url);
  const path = url.pathname;

  // ── Public path bypass ─────────────────────────────────────────────
  if (isPublicPath(path)) {
    clearCurrentUser();
    return null;
  }

  // ── Auth disabled (Supabase not configured) ────────────────────────
  if (!isAuthEnabled()) {
    // Graceful degradation: pass all requests through without auth.
    // This matches v0.0.1 behaviour and development-mode usage.
    clearCurrentUser();
    return null;
  }

  // ── Extract Authorization header ───────────────────────────────────
  const authorizationHeader =
    request.headers.get("authorization") ??
    request.headers.get("Authorization");

  if (!authorizationHeader) {
    clearCurrentUser();
    return errorResponse("Authorization header missing", 401);
  }

  // ── Parse Bearer token ─────────────────────────────────────────────
  const token = extractBearerToken(authorizationHeader);

  if (token === null) {
    clearCurrentUser();
    return errorResponse("Invalid authorization header format", 401);
  }

  // ── Verify token with Supabase ─────────────────────────────────────
  try {
    const user = await verifyToken(token);
    setCurrentUser(user);
    setCurrentToken(token);
    return null;
  } catch (error: unknown) {
    clearCurrentUser();

    if (error instanceof AuthenticationError) {
      return errorResponse(error.message, error.statusCode);
    }

    // Unexpected error — log and return generic 401
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[auth] Unexpected auth error: ${message}`);
    return errorResponse("Authentication failed", 401);
  }
}

// ---------------------------------------------------------------------------
// Startup logging
// ---------------------------------------------------------------------------

/**
 * Log the auth configuration status at startup.
 *
 * Call this once during server initialization (in `index.ts`) to inform
 * the operator whether authentication is active or disabled.
 */
export function logAuthStatus(): void {
  if (isAuthEnabled()) {
    console.log("[auth] ✅ Supabase authentication enabled");
  } else {
    console.log(
      "[auth] ⚠️  Supabase not configured — authentication disabled (all requests pass through)",
    );
  }
}
