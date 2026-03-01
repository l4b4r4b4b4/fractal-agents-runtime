# Task-01: Supabase JWT Authentication Middleware

> **Status:** 🟢 Complete
> **Priority:** High
> **Created:** 2025-07-20
> **Last Updated:** 2025-07-20
> **Parent Goal:** [Goal 25 — TS Runtime v0.0.2](../scratchpad.md)

---

## Objective

Secure all non-public endpoints with Supabase JWT verification, matching the Python runtime's auth middleware. Gracefully degrade when Supabase is not configured (no auth enforcement).

---

## Implementation Plan

### Files to Create

1. **`src/infra/security/auth.ts`** — Core auth primitives
   - `AuthUser` type (`identity: string`, `email: string | null`, `metadata: Record<string, unknown>`)
   - `AuthenticationError` class with `statusCode` field
   - `getSupabaseClient()` — Lazy-initialized Supabase client singleton
   - `verifyToken(token: string)` → `Promise<AuthUser>` (calls `supabase.auth.getUser()`)
   - `isAuthEnabled()` — Check if Supabase is configured

2. **`src/middleware/auth.ts`** — HTTP middleware for Bun.serve() router
   - `authMiddleware(request: Request)` → `Response | null`
   - `PUBLIC_PATHS` set: `/`, `/health`, `/ok`, `/info`, `/openapi.json`, `/metrics`
   - `isPublicPath(path: string)` → `boolean` (exact match + trailing-slash normalization)
   - Extracts `Authorization: Bearer <token>` header
   - Verifies token via `verifyToken()` → stores AuthUser on request
   - Returns 401 `{"detail": "..."}` on failure
   - Returns `null` (continue) when auth disabled or path is public

3. **`src/middleware/context.ts`** — Request-scoped user context
   - `setCurrentUser(user: AuthUser | null)` — Store user for current request
   - `getCurrentUser()` → `AuthUser | null` — Get user for current request
   - `requireUser()` → `AuthUser` — Get user or throw AuthenticationError
   - `getUserIdentity()` → `string | null` — Shorthand for user.identity
   - Uses simple module-level variable (Bun is single-threaded, one request at a time in handler)

### Files to Modify

4. **`src/config.ts`** — Add Supabase env vars
   - Add to `AppConfig`: `supabaseUrl`, `supabaseKey`, `supabaseJwtSecret`
   - Update `loadConfig()` to read `SUPABASE_URL`, `SUPABASE_KEY`, `SUPABASE_JWT_SECRET`
   - Update `isSupabaseConfigured()` to check actual config values

5. **`src/index.ts`** — Wire middleware into router
   - Import and register `authMiddleware` via `router.use()`

### Files to Create (Tests)

6. **`tests/auth.test.ts`** — Auth middleware tests
   - Valid token → user extracted correctly
   - Invalid token → 401 response
   - Missing Authorization header → 401 response
   - Invalid header format (no "Bearer") → 401 response
   - Public path bypass → continues without auth
   - Auth disabled (no Supabase config) → continues without auth
   - Error response format matches Python: `{"detail": "..."}`
   - Context helpers: getCurrentUser, requireUser, getUserIdentity

---

## Design Decisions

### Context Propagation: Module-level Variable (Not ContextVar)

The Python runtime uses `ContextVar` + `threading.local()` because Robyn crosses Rust/Python thread boundaries. Bun.serve() is single-threaded and processes one request at a time in the `fetch` handler (even though it's async, the middleware runs sequentially before the route handler). A simple module-level variable set before dispatch and cleared after is sufficient.

**However**, if Bun ever processes requests concurrently (e.g., via Workers), this would break. For now, this is the simplest correct approach. We'll revisit if concurrency is introduced.

### Error Response Format

Match Python exactly:
```json
{"detail": "Authorization header missing"}
{"detail": "Invalid authorization header format"}
{"detail": "Authentication error: <message>"}
```

Status code is always 401 for auth failures.

### Graceful Degradation

When `SUPABASE_URL` is not set:
- `isAuthEnabled()` returns `false`
- `authMiddleware()` returns `null` (continue) for ALL requests
- `getCurrentUser()` returns `null`
- No 401s ever produced
- Log a warning at startup: "⚠️ Supabase not configured — auth disabled"

This ensures the runtime works in development without Supabase, matching v0.0.1 behavior.

### Supabase Client: `supabase.auth.getUser(token)`

We use Supabase's `getUser()` API call (server-side verification) rather than local JWT decoding. This:
- Validates the token against Supabase's auth service (revoked tokens are rejected)
- Returns full user metadata (email, user_metadata)
- Matches the Python runtime's approach exactly

Trade-off: Adds ~50-100ms latency per authenticated request (network call to Supabase). Acceptable for now. Could add local JWT verification as a fast path later.

---

## Acceptance Criteria

- [x] Public endpoints accessible without token (`/`, `/health`, `/ok`, `/info`, `/openapi.json`)
- [x] Protected endpoints return 401 without valid token
- [x] Valid token extracts correct user identity
- [x] User identity available via `getCurrentUser()` / `requireUser()` / `getUserIdentity()`
- [x] Graceful degradation when Supabase not configured (no auth enforcement)
- [x] Error responses match Python format: `{"detail": "Authorization header missing"}`
- [x] `isSupabaseConfigured()` in config.ts reflects actual Supabase config state
- [x] All existing v0.0.1 tests still pass (761 tests → 857 tests total)
- [x] New auth tests pass (96 tests)

---

## Progress Log

### 2025-07-20 — Implementation Complete 🟢
- Created task scratchpad with implementation plan
- Identified 3 new files, 2 modified files, 1 test file
- Design decision: module-level variable for request context (Bun single-threaded)
- Design decision: graceful degradation when Supabase not configured

**Files created:**
- `src/infra/security/auth.ts` — `AuthUser` type, `AuthenticationError`, `getSupabaseClient()` singleton, `verifyToken()`, `isAuthEnabled()`, `resetSupabaseClient()`
- `src/middleware/auth.ts` — `authMiddleware()`, `isPublicPath()`, `logAuthStatus()`, `PUBLIC_PATHS` set, Bearer token extraction
- `src/middleware/context.ts` — `setCurrentUser()`, `clearCurrentUser()`, `getCurrentUser()`, `requireUser()`, `getUserIdentity()`
- `tests/auth.test.ts` — 96 tests covering all acceptance criteria

**Files modified:**
- `src/config.ts` — Added `supabaseUrl`, `supabaseKey`, `supabaseJwtSecret` to `AppConfig`; updated `loadConfig()` and `isSupabaseConfigured()` to check actual env values
- `src/index.ts` — Wired `authMiddleware` via `router.use()` before all routes; added `logAuthStatus()` at startup

**Test results:**
- 96 new auth tests pass
- 857 total tests pass (96 new + 761 existing), 0 failures
- TypeScript compiles clean (`bunx tsc --noEmit` — no errors)

**Key implementation details:**
- Supabase client initialized lazily via `getSupabaseClient()` using `SUPABASE_URL` + `SUPABASE_KEY` env vars
- Token verification uses `supabase.auth.getUser(token)` — server-side validation matching Python runtime
- Public paths: `/`, `/health`, `/ok`, `/info`, `/docs`, `/openapi.json`, `/metrics`, `/metrics/json`
- Graceful degradation: when `SUPABASE_URL` not set, all requests pass through (no 401s), matching v0.0.1 behavior
- Error format matches Python: `{"detail": "Authorization header missing"}` with 401 status
- Context propagation via module-level variable (safe for Bun's single-threaded model)
- Middleware registered before all routes in `index.ts` via `router.use(authMiddleware)`