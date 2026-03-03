# Goal 45: Fix MCP Auth Tokens Not Forwarded to Servers

**Status:** 🟡 In Progress — Token injection complete, but token exchange logic is broken (see Remaining Bug)
**Priority:** P0 — Blocking (all MCP servers with `auth_required: true` are skipped)
**Predecessor:** Goal 44 (Fix `get_config` outside runnable context) — 🟢 Complete
**Bug Report:** `.agent/bugs/runtime-bug-mcp-tokens-not-forwarded.md`

---

## Problem Statement

After the Goal 44 fix, the runtime no longer crashes during graph construction. However, **all MCP servers are skipped** because `fetch_tokens()` cannot find the user's Supabase JWT — the key `x-supabase-access-token` is never injected into `configurable`.

### Symptom

```
WARNING  [graphs.react_agent.agent] MCP server skipped (auth required but no tokens): name=supabase-mcp url=http://supabase_kong_immoflow-platform:8000/mcp
WARNING  [graphs.react_agent.agent] MCP server skipped (auth required but no tokens): name=playwright-mcp url=http://playwright-mcp:8931/mcp
WARNING  [graphs.react_agent.agent] MCP server skipped (auth required but no tokens): name=bundesmcp url=http://bundesmcp:8000/mcp
WARNING  [graphs.react_agent.agent] MCP server skipped (auth required but no tokens): name=ifc-mcp url=http://ifc-mcp:8000/mcp
```

Assistants respond (LLM works) but have **zero tool access** — they print SQL text instead of executing it.

---

## Root Cause Analysis

### The Chain of Failure

1. **Client** sends `POST /runs/stream` with `Authorization: Bearer <user-jwt>`
2. **`auth_middleware`** (`server/auth.py:449`) extracts the JWT, verifies it, stores an `AuthUser(identity, email, metadata)` in context — **but discards the raw JWT token**
3. **Route handler** (e.g. `create_run_stream`) calls `require_user()` → gets `AuthUser` with `identity` only (no token)
4. **`_build_runnable_config`** (`server/routes/streams.py:133`) builds `configurable` from assistant config + run config + runtime metadata — **never sets `x-supabase-access-token`** or `langgraph_auth_user`
5. **`execute_run_stream`** → `build_graph()` → `graph()` → `fetch_tokens(config, store=store)`
6. **`fetch_tokens`** (`utils/token.py:253`) reads `configurable.get("x-supabase-access-token")` → **`None`** → returns `None`
7. **`graph()`** sees `mcp_tokens is None` → skips all auth-required MCP servers

### Why `x-supabase-access-token` is Always `None`

Searched all Python files — **there is zero code that sets `configurable["x-supabase-access-token"]`** on the server side. The key exists as a read target in:

| File | Line | Usage |
|------|------|-------|
| `graphs/react_agent/agent.py` | L286 | `config.get("configurable", {}).get("x-supabase-access-token")` — RAG tools |
| `graphs/react_agent/utils/token.py` | L255 | `configurable.get("x-supabase-access-token")` — MCP token exchange |
| `graphs/research_agent/__init__.py` | L149 | `configurable.get("x-supabase-access-token")` — RAG tools |
| `server/tests/test_token.py` | L62 | Test helper sets it for test coverage |

But **no production code ever writes this key**. It was likely intended to be passed by the client via run config, but the server-side architecture (auth middleware → route → config builder) never bridges the gap.

### Two Things Broken by This

1. **MCP token exchange** — `fetch_tokens()` cannot exchange Supabase JWT for MCP access tokens
2. **RAG tool creation** — `create_rag_tool()` in both `react_agent` and `research_agent` also reads this key for authenticated RAG calls

### Additional Issue: `research_agent` Missing `store=store`

`research_agent/__init__.py:181` calls `fetch_tokens(config)` **without** `store=store`, so the Goal 44 fix (explicit store threading) doesn't help there. Will fix as part of this goal.

---

## LangGraph API Alignment

### How the LangGraph Platform Handles This

The LangGraph Platform has a well-defined convention for passing authenticated user context to graphs:

1. **`@auth.authenticate` handler** — validates the JWT and returns a dict with at least `identity` plus any custom fields (e.g., tokens, roles, org IDs).
2. **Platform auto-populates** `config["configurable"]["langgraph_auth_user"]` with the returned dict and `config["configurable"]["langgraph_auth_user_id"]` with the identity.
3. **Graph code reads** `config["configurable"].get("langgraph_auth_user")` to get user tokens for authenticated API calls.

From the LangGraph docs on [user-scoped MCP tools](https://docs.langchain.com/langsmith/server-mcp):

```python
def mcp_tools_node(state, config):
    user = config["configurable"].get("langgraph_auth_user")
    # user["github_token"], user["email"], etc.

    client = MultiServerMCPClient({
        "github": {
            "transport": "streamable_http",
            "url": "https://my-github-mcp-server/mcp",
            "headers": {
                "Authorization": f"Bearer {user['github_token']}"
            }
        }
    })
```

From the LangGraph docs on [custom auth](https://docs.langchain.com/langsmith/custom-auth):

```python
def my_node(state, config):
    user_config = config["configurable"].get("langgraph_auth_user")
    token = user_config.get("github_token", "")
```

### `configurable_headers` (LangGraph `langgraph.json`)

The LangGraph Platform also supports forwarding HTTP headers to `config["configurable"]` via `langgraph.json`:
```json
{
  "http": {
    "configurable_headers": {
      "includes": ["x-user-id", "x-organization-id", "my-prefix-*"],
      "excludes": ["authorization", "x-api-key"]
    }
  }
}
```

Our runtime deliberately dropped `langgraph.json` (proprietary LangGraph Platform config — see Goal 01), but we can still follow the same convention for header→config forwarding in our Robyn middleware. This is a **future enhancement** — for this goal, we focus on `langgraph_auth_user`.

### What This Means for Our Fix

Instead of using the non-standard `x-supabase-access-token` key, we should:

1. **Populate `configurable["langgraph_auth_user"]`** with the authenticated user dict (including the raw JWT)
2. **Update graph code** to read from `langgraph_auth_user` instead of `x-supabase-access-token`
3. **Maintain backward compat** by also setting `x-supabase-access-token` during a transition period

This makes our graph code **portable** to the official LangGraph Platform if a user ever wants to deploy there.

---

## Solution Space Research

### Option A: Inject non-standard `x-supabase-access-token` (Quick Fix) ❌

Just bridge the gap by setting `configurable["x-supabase-access-token"]` in the config builder.

**Pros:** Minimal changes (4 files).
**Cons:** Cements a non-standard convention. Graph code not portable. Diverges further from LangGraph API.

### Option B: Adopt `langgraph_auth_user` Convention (Full Alignment) ✅ RECOMMENDED

Follow the LangGraph Platform's standard:
- Populate `configurable["langgraph_auth_user"]` = `{"identity": ..., "token": ..., "email": ..., ...}`
- Populate `configurable["langgraph_auth_user_id"]` = identity string
- Graph code reads from `langgraph_auth_user`
- Also set `x-supabase-access-token` for backward compat (can be removed in a later cleanup goal)

**Pros:**
- Follows LangGraph standard — graph code becomes portable
- `langgraph_auth_user` is richer (identity, email, metadata, token all in one place)
- Clean separation: auth middleware owns the user context, config builder formats it for LangGraph
- Future-proof for adding more user-scoped credentials

**Cons:**
- Touches more files (also graph code, not just server)
- Slightly more complex change

### Decision: Option B

The extra effort is modest and the alignment benefit is significant. We're building a LangGraph-compatible runtime — we should follow LangGraph conventions.

---

## Affected Code Paths (All Entry Points)

| # | Handler | File | Calls | Has JWT? | Needs Fix? |
|---|---------|------|-------|----------|------------|
| 1 | `create_run_stream` | `streams.py:221` | `execute_run_stream` → `_build_runnable_config` | ✅ via `require_user()` | ✅ Yes |
| 2 | `create_stateless_run_wait` | `streams.py:488` | `execute_run_wait` → `_build_runnable_config` | ✅ via `require_user()` | ✅ Yes |
| 3 | `create_stateless_run` | `streams.py:608` | `execute_run_wait` → `_build_runnable_config` | ✅ via `require_user()` | ✅ Yes |
| 4 | `create_stateless_run_stream` | `streams.py:725` | `execute_run_stream` → `_build_runnable_config` | ✅ via `require_user()` | ✅ Yes |
| 5 | A2A `_execute_agent` | `a2a/handlers.py:412` | `execute_run_stream` | ❌ (`owner_id="a2a-system"`) | ⚪ No JWT available — OK |
| 6 | `execute_agent_run` | `agent.py:145` | `_build_mcp_runnable_config` | ❌ (`owner_id="mcp-client"`) | ⚪ No JWT available — OK |

Handlers 5 and 6 don't have user JWTs — they're system/service callers. MCP auth won't work for them, which is expected and acceptable. The `langgraph_auth_user` will be `None` for these callers.

---

## Implementation Plan

### Phase 1: Auth Layer — Store Raw Token in `AuthUser`

| # | File | Change |
|---|------|--------|
| 1 | `server/auth.py` | Add `token: str \| None = None` field to `AuthUser` dataclass |
| 2 | `server/auth.py` | Update `to_dict()` to include `token` |
| 3 | `server/auth.py` | In `auth_middleware`, set `user.token = token` on the verified `AuthUser` (Note: `verify_token_auto` returns `AuthUser` without token — we set it after since the raw JWT is available in the middleware) |

### Phase 2: Config Builders — Populate `langgraph_auth_user`

| # | File | Change |
|---|------|--------|
| 4 | `server/routes/streams.py` | Add `auth_user: AuthUser \| None = None` param to `_build_runnable_config` |
| 5 | `server/routes/streams.py` | Inside `_build_runnable_config`, set `configurable["langgraph_auth_user"]` and `configurable["langgraph_auth_user_id"]` from `auth_user` |
| 6 | `server/routes/streams.py` | Also set `configurable["x-supabase-access-token"] = auth_user.token` for backward compat |
| 7 | `server/routes/streams.py` | Add `auth_user: AuthUser \| None = None` param to `execute_run_stream` and `execute_run_wait` |
| 8 | `server/routes/streams.py` | Pass `auth_user` through to `_build_runnable_config` in both functions |
| 9 | `server/routes/streams.py` | In all 4 route handlers: pass `user` (from `require_user()`) as `auth_user` to `execute_run_stream` / `execute_run_wait` |
| 10 | `server/agent.py` | Add `auth_user: AuthUser \| None = None` param to `_build_mcp_runnable_config` |
| 11 | `server/agent.py` | Inside `_build_mcp_runnable_config`, set `langgraph_auth_user` + `langgraph_auth_user_id` + `x-supabase-access-token` when `auth_user` provided |

### Phase 3: Graph Code — Read from `langgraph_auth_user`

| # | File | Change |
|---|------|--------|
| 12 | `graphs/react_agent/utils/token.py` | In `fetch_tokens()`: read token from `configurable.get("langgraph_auth_user", {}).get("token")` with fallback to `configurable.get("x-supabase-access-token")` |
| 13 | `graphs/react_agent/agent.py` | RAG token: read from `langgraph_auth_user` with fallback to `x-supabase-access-token` |
| 14 | `graphs/research_agent/__init__.py` | RAG token: read from `langgraph_auth_user` with fallback to `x-supabase-access-token` |
| 15 | `graphs/research_agent/__init__.py` | Fix missing `store=store` in `fetch_tokens(config)` → `fetch_tokens(config, store=store)` |

### Phase 4: Tests

| # | File | Change |
|---|------|--------|
| 16 | `server/tests/test_auth.py` | Test `AuthUser.token` field |
| 17 | `server/tests/test_auth.py` | Test `auth_middleware` saves raw token in `AuthUser` |
| 18 | `server/tests/test_auth.py` | Test `to_dict()` includes token |
| 19 | `server/tests/test_token.py` | Update `_make_config()` to also set `langgraph_auth_user` |
| 20 | `server/tests/test_token.py` | Add test: `fetch_tokens` reads from `langgraph_auth_user` |
| 21 | `server/tests/test_token.py` | Add test: `fetch_tokens` falls back to `x-supabase-access-token` |
| 22 | New or existing test file | Test `_build_runnable_config` sets `langgraph_auth_user` when `auth_user` provided |
| 23 | New or existing test file | Test `_build_runnable_config` skips `langgraph_auth_user` when `auth_user` is None |
| 24 | New or existing test file | Test `_build_mcp_runnable_config` sets `langgraph_auth_user` |
| 25 | Existing `test_mcp.py` | Update `test_build_mcp_runnable_config` for new param |

### Phase 5: Lint + Full Test Suite

| # | Action |
|---|--------|
| 26 | `ruff check . --fix --unsafe-fixes && ruff format .` |
| 27 | `pytest` — full suite must pass |
| 28 | Coverage ≥ 73% |

---

## Key Design Decisions

### `langgraph_auth_user` Dict Shape

Following LangGraph Platform convention:
```python
{
    "identity": "user-uuid-string",       # Required — Supabase user ID
    "token": "eyJhbGciOiJI...",           # Raw JWT — for token exchange & authenticated API calls
    "email": "user@example.com",          # Optional
    "metadata": {"name": "...", ...},     # Optional — Supabase user_metadata
}
```

This matches what LangGraph Platform puts in `langgraph_auth_user` — a dict returned by the `@auth.authenticate` handler.

### Backward Compatibility Strategy

We set **both** keys during a transition period:
- `configurable["langgraph_auth_user"]` — new standard (LangGraph-aligned)
- `configurable["langgraph_auth_user_id"]` — new standard (LangGraph-aligned)
- `configurable["x-supabase-access-token"]` — old key (backward compat)

Graph code reads `langgraph_auth_user` first, falls back to `x-supabase-access-token`:
```python
auth_user = configurable.get("langgraph_auth_user") or {}
supabase_token = auth_user.get("token") or configurable.get("x-supabase-access-token")
```

The old key can be removed in a future cleanup goal once all consumers are migrated.

### Why `token` in `AuthUser` and Not a Separate ContextVar

- `AuthUser` is the natural home for user credentials — it's already the auth context object
- Explicit > implicit — token flows through function params, not hidden global state
- Robyn's Rust/Python boundary already caused issues with ContextVars (see existing `_thread_local` fallback in auth.py) — adding another ContextVar risks the same problem
- Easy to test — `AuthUser(identity="x", token="jwt")` vs mocking a ContextVar

### Where Token Is Injected Into `AuthUser`

In `auth_middleware` **after** `verify_token_auto()` returns:
```python
user = await verify_token_auto(token)
user.token = token  # <-- inject raw JWT
_current_user.set(user)
```

We don't modify `verify_token_auto` / `verify_token_local` because:
- They don't have access to the raw token string (only the parsed claims)
- The raw token is already available in the middleware scope
- Cleaner separation: verification functions validate, middleware enriches

---

## Files Summary

| File | Type of Change |
|------|---------------|
| `server/auth.py` | Add `token` field to `AuthUser`, save in middleware |
| `server/routes/streams.py` | Add `auth_user` param to config builders + executors, populate `langgraph_auth_user` |
| `server/agent.py` | Add `auth_user` param to `_build_mcp_runnable_config`, populate `langgraph_auth_user` |
| `graphs/react_agent/utils/token.py` | Read from `langgraph_auth_user` (with fallback) |
| `graphs/react_agent/agent.py` | Read RAG token from `langgraph_auth_user` (with fallback) |
| `graphs/research_agent/__init__.py` | Read from `langgraph_auth_user` (with fallback) + fix `store=store` |
| `server/tests/test_auth.py` | Test AuthUser.token, middleware token save |
| `server/tests/test_token.py` | Update helpers, add langgraph_auth_user tests |
| `server/tests/test_mcp.py` | Update `_build_mcp_runnable_config` tests |

---

## Success Criteria

- [x] `AuthUser` stores raw JWT token
- [x] `auth_middleware` saves raw token in `AuthUser.token`
- [x] `_build_runnable_config` populates `langgraph_auth_user`, `langgraph_auth_user_id`, and `x-supabase-access-token`
- [x] `_build_mcp_runnable_config` populates the same keys
- [x] All 4 authenticated route handlers pass `auth_user` through
- [x] `execute_run_stream` and `execute_run_wait` accept and forward `auth_user`
- [x] `fetch_tokens()` reads from `langgraph_auth_user` with fallback
- [x] RAG tools in `react_agent` read from `langgraph_auth_user` with fallback
- [x] RAG tools in `research_agent` read from `langgraph_auth_user` with fallback
- [x] `research_agent` passes `store=store` to `fetch_tokens()`
- [x] MCP token exchange completes (HTTP call to `/oauth/token`)
- [x] MCP servers connect with auth headers
- [x] Runtime logs show `INFO MCP server connected` instead of `WARNING MCP server skipped`
- [x] A2A handler still works (no JWT, `langgraph_auth_user` is None — graceful)
- [x] `execute_agent_run` still works (no JWT — graceful)
- [x] All existing tests pass
- [x] New tests cover `langgraph_auth_user` propagation
- [x] Coverage ≥ 73%

---

## Verification

After deploying, send this test prompt to the personal assistant:

```
Führe bitte diese SQL-Abfrage aus: SELECT name, is_global, auto_provision_scopes FROM agents ORDER BY name;
```

**Expected:** A markdown table with agent data (tool `execute_sql` called via MCP).
**Failure:** Assistant echoes the SQL as text (no tool access).

---

## Notes

- This bug has existed since the initial implementation — `x-supabase-access-token` was designed as a config key but the server-side injection was never implemented
- The previous bug (Goal 44) was a prerequisite — without the `store` threading fix, `fetch_tokens()` crashed before it could even check for the token
- Both RAG tools and MCP token exchange read the same token, so this fix resolves both
- The `research_agent` has a secondary bug (missing `store=store` in `fetch_tokens` call) — fixed as part of this goal
- We deliberately dropped `langgraph.json` (Goal 01) since it's proprietary LangGraph Platform config, but we align with the `langgraph_auth_user` convention which is part of the open-source LangGraph library's config contract
- Future enhancement: implement `configurable_headers`-style HTTP header forwarding in our Robyn middleware (separate goal)