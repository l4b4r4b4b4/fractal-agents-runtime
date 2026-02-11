# Task 02 — Supabase JWT Auth Middleware for Robyn

Status: 🟢 Complete  
Created: 2026-02-04  
Last Updated: 2026-02-04

---

## Objective

Port the Supabase JWT authentication middleware from `tools_agent/security/auth.py` to work with Robyn's middleware system.

The middleware must:
1. Extract `Authorization: Bearer <token>` header from requests
2. Verify the JWT with Supabase (`supabase.auth.get_user(token)`)
3. Attach user identity to request context for downstream handlers
4. Return 401 errors with LangGraph-compatible error shape (`{"detail": "..."}`)

---

## Implementation Plan

### Files to Create
- `robyn_server/auth.py` — Auth middleware and user context

### Files to Modify
- `robyn_server/app.py` — Register middleware, make endpoints auth-aware
- `robyn_server/config.py` — Add `SUPABASE_SECRET` to config (needed for Supabase client)

### Key Design Decisions

1. **Supabase verification (not local JWT)**: We verify tokens by calling Supabase API, same as `tools_agent/security/auth.py`. This ensures token revocation works.

2. **Request context for user**: Robyn doesn't have built-in request context like FastAPI's `Depends()`. We'll use Robyn's middleware to inject user info.

3. **Error shape**: Return `{"detail": "..."}` to match LangGraph API error format.

4. **Public endpoints**: `/health`, `/ok`, `/info` should not require auth.

---

## Robyn Middleware Pattern

Robyn middleware signature:
```python
@app.before_request()
async def auth_middleware(request: Request) -> Request | Response:
    # Return Request to continue, or Response to short-circuit
    ...
```

We can attach user info to `request.headers` or use a context var.

---

## Implementation Steps

- [x] Research Robyn middleware API
- [x] Create `robyn_server/auth.py` with:
  - `AuthUser` dataclass for user identity
  - `get_supabase_client()` function
  - `verify_token()` async function
  - `auth_middleware()` Robyn middleware
  - `get_current_user()` helper to extract user from request
- [x] Update `robyn_server/config.py` to include `SUPABASE_SECRET`
- [x] Register middleware in `robyn_server/app.py`
- [x] Add tests for auth middleware (41 tests passing)
- [x] Manual test against running Supabase

---

## Test Strategy

1. **Unit tests**: Mock Supabase client, test token parsing and error cases
2. **Integration test**: Use real Supabase (local), create user, get JWT, verify middleware accepts

Test cases:
- Missing `Authorization` header → 401
- Invalid header format (no "Bearer") → 401
- Invalid/expired token → 401
- Valid token → request continues with user attached
- Public endpoints work without auth

---

## References

- Existing auth: `tools_agent/security/auth.py`
- Robyn middleware docs: https://robyn.tech/documentation/api_reference/middlewares
- Supabase Python client: `supabase.auth.get_user(token)`

---

## Progress Log

### 2026-02-04
- Created task scratchpad
- Implemented `robyn_server/auth.py` with:
  - `AuthUser` dataclass for user identity
  - `AuthenticationError` exception class
  - `get_supabase_client()` lazy-loading function
  - `verify_token()` async function using Supabase API
  - `auth_middleware()` Robyn before_request middleware
  - `create_error_response()` for LangGraph-compatible error format
  - `get_current_user()`, `require_user()`, `get_user_identity()` context helpers
  - `PUBLIC_PATHS` set and `is_public_path()` for public endpoint detection
- Added `SUPABASE_SECRET` to `robyn_server/config.py`
- Registered middleware in `robyn_server/app.py`
- Added `GET /ok` endpoint for LangGraph health parity
- Created `robyn_server/tests/test_auth.py` with 41 unit tests
- Created `robyn_server/tests/conftest.py` for pytest-asyncio configuration
- All 41 tests passing
- Manual test verified:
  - Public endpoints (`/health`, `/ok`) work without auth
  - Protected endpoints return 401 with `{"detail": "..."}` format
