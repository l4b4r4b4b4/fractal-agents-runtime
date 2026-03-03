# Goal 46: Fix MCP Token Exchange — Remove Wrong OAuth Flow, Pass JWT Directly

**Status:** 🟡 In Progress
**Priority:** P0 — Critical (MCP tool calls fail at runtime; agents have zero tool access)
**Branch:** `feat/goal-45-mcp-auth-token-forwarding` (continue on this branch)
**Predecessor:** Goal 45 (Fix MCP Auth Tokens Not Forwarded) — 🟡 partially complete
**Latest commits on branch:**
- `27c9c2c` fix: use Robyn Headers.get_headers() API for configurable headers extraction
- `84061a6` feat(goal-45): fix MCP auth token forwarding and align with LangGraph API

---

## Problem Statement

After Goal 45, the Supabase JWT is now correctly injected into
`configurable["langgraph_auth_user"]["token"]`. Token propagation to the
graph is fixed. **But MCP tool calls still fail.**

### Symptom (Runtime)

Token exchange HTTP call returns a Supabase Studio 404 HTML page instead
of a JSON auth response. The error log shows something like:

```
ERROR [graphs.react_agent.utils.token] Token exchange failed: <!DOCTYPE html>...
```

All auth-required MCP servers are then skipped (no tokens → skipped),
and the assistant has zero tool access. The test prompt:

```
Führe bitte diese SQL-Abfrage aus:
SELECT name, is_global, auto_provision_scopes FROM agents ORDER BY name;
```

…causes the assistant to echo the SQL as text instead of executing it via
the `execute_sql` MCP tool.

---

## Root Cause Analysis

### The Wrong Assumption in `get_mcp_access_token`

`graphs/react_agent/utils/token.py` contains `get_mcp_access_token()` which
performs an RFC 8693 OAuth2 Token Exchange:

```python
form_data = {
    "client_id": "mcp_default",
    "subject_token": supabase_token,
    "grant_type": "urn:ietf:params:oauth:grant-type:token-exchange",
    "resource": base_mcp_url.rstrip("/") + "/mcp",
    "subject_token_type": "urn:ietf:params:oauth:token-type:access_token",
}

session.post(
    base_mcp_url.rstrip("/") + "/oauth/token",   # <-- THE BUG
    ...
)
```

`fetch_tokens` picks the first auth-required server from `mcp_config.servers`
as `base_mcp_url`. With the current deployment that is:

```
http://supabase_kong_immoflow-platform:8000/mcp
```

So the token exchange posts to:

```
http://supabase_kong_immoflow-platform:8000/mcp/oauth/token
```

Kong has no route for `/mcp/oauth/token`. Kong routes:
- `/auth/v1/*` → GoTrue (Supabase Auth)
- `/mcp` → the actual MCP server service

The request falls through to Supabase Studio which returns its 404 HTML
page. The code sees a non-200 response, logs the HTML as an error, and
returns `None`. All auth-required MCP servers are then skipped.

### Why Token Exchange Is Wrong Here

The LangGraph/LangChain docs are unambiguous on this. The correct pattern
for user-scoped MCP tools is:

```python
user = config["configurable"].get("langgraph_auth_user")

client = MultiServerMCPClient({
    "my-server": {
        "transport": "streamable_http",
        "url": "https://my-mcp-server/mcp",
        "headers": {
            "Authorization": f"Bearer {user['token']}"   # pass JWT directly
        }
    }
})
```

Source: https://docs.langchain.com/langsmith/server-mcp

**There is no token exchange step.** The Supabase JWT is the token. The MCP
servers in this deployment (supabase-mcp, playwright-mcp, bundesmcp,
ifc-mcp) sit behind Kong with Supabase auth. They validate the standard
Supabase JWT from the `Authorization: Bearer` header — exactly like every
other Kong-guarded service in the stack.

The RFC 8693 token exchange flow was never valid for this deployment. It
only makes sense when the MCP server itself runs a separate OAuth2
authorization server (e.g. GitHub's OAuth).

### Full Call Chain (Post Goal 45)

```
create_run_stream
  → auth_middleware saves raw JWT in AuthUser.token      ✅ (Goal 45)
  → _build_runnable_config sets langgraph_auth_user      ✅ (Goal 45)
  → execute_run_stream → graph()
      → fetch_tokens(config, store)
          → reads langgraph_auth_user["token"]           ✅ (Goal 45)
          → calls get_mcp_access_token(jwt, mcp_url)
              → POSTs to mcp_url + "/oauth/token"        ❌ 404 HTML
              → returns None
      → mcp_tokens = None
      → all auth-required servers skipped               ❌ NO TOOLS
```

---

## Solution

### The Fix (Conceptually Simple)

Replace the entire token exchange mechanism with direct JWT pass-through:

**`fetch_tokens` should return `{"access_token": "<supabase-jwt>"}` directly.**

No HTTP call. No caching (the JWT is fresh on every request from
`langgraph_auth_user`). No RFC 8693 grant type.

The agent code in `agent.py` already uses the result correctly:

```python
headers["Authorization"] = f"Bearer {mcp_tokens['access_token']}"
```

So the dict shape `{"access_token": "<jwt>"}` is all that is needed.

### Functions to Delete

- `get_mcp_access_token()` — entire function, wrong approach
- `get_tokens()` — store-based token cache, no longer needed (JWT is fresh)
- `set_tokens()` — store-based token cache, no longer needed

### `fetch_tokens` Replacement

```python
async def fetch_tokens(
    config: RunnableConfig,
    store: Any = None,   # kept for signature compat, unused
) -> dict[str, Any] | None:
    """Return the user's Supabase JWT as an MCP-compatible token dict.

    The MCP servers in this deployment authenticate via a standard
    Supabase JWT passed as Authorization: Bearer.  No token exchange
    is required — the JWT from langgraph_auth_user is used directly.

    Args:
        config: The LangGraph runnable config.
        store: Unused. Kept for call-site signature compatibility.

    Returns:
        {"access_token": "<jwt>"} or None if no JWT is available.
    """
    configurable = config.get("configurable", {}) or {}

    auth_user = configurable.get("langgraph_auth_user") or {}
    supabase_token = auth_user.get("token") or configurable.get(
        "x-supabase-access-token"
    )
    if not supabase_token:
        return None

    return {"access_token": supabase_token}
```

### Files to Change

| File | Change |
|------|--------|
| `graphs/react_agent/utils/token.py` | Delete `get_mcp_access_token`, `get_tokens`, `set_tokens`. Replace `fetch_tokens` with direct JWT pass-through. Remove `aiohttp` import. Remove store namespace imports (no longer needed). |
| `graphs/react_agent/agent.py` | No change needed. Already reads `mcp_tokens['access_token']`. |
| `graphs/research_agent/__init__.py` | No change needed. Same `fetch_tokens` call site. |
| `server/tests/test_token.py` | Delete tests for `get_mcp_access_token`, `get_tokens`, `set_tokens`. Update `fetch_tokens` tests: no HTTP mock needed, just verify JWT pass-through. |

### Imports to Remove from `token.py`

```python
import aiohttp                          # delete — no HTTP call
from infra.store_namespace import (     # delete — no store caching
    CATEGORY_TOKENS,
    build_namespace,
    extract_namespace_components,
)
```

Keep:
```python
import logging
from typing import Any
from langchain_core.runnables import RunnableConfig
```

---

## What Was Already Completed (Goal 45)

These are done and committed — do NOT redo:

- [x] `AuthUser.token` field added to `server/auth.py`
- [x] `auth_middleware` saves raw JWT in `AuthUser.token`
- [x] `_build_runnable_config` populates `langgraph_auth_user`, `langgraph_auth_user_id`, `x-supabase-access-token`
- [x] `execute_run_stream` and `execute_run_wait` accept and forward `auth_user`
- [x] All 4 authenticated route handlers pass `user` as `auth_user`
- [x] `fetch_tokens` reads from `langgraph_auth_user` with fallback to `x-supabase-access-token`
- [x] `research_agent` passes `store=store` to `fetch_tokens`
- [x] `_extract_configurable_headers` fixed to use Robyn `Headers.get_headers()` API
- [x] 1842 tests pass, 79% coverage, lint clean

## What Remains (This Goal)

- [ ] Delete `get_mcp_access_token` from `token.py`
- [ ] Delete `get_tokens` and `set_tokens` from `token.py`
- [ ] Replace `fetch_tokens` body with direct JWT pass-through
- [ ] Remove `aiohttp` and store namespace imports from `token.py`
- [ ] Update `server/tests/test_token.py` to match new behaviour
- [ ] Update `TestExtractConfigurableHeaders` tests in `test_streams.py` to use `FakeRobynHeaders` (tests currently pass plain dicts and fail since the `_extract_configurable_headers` fix — see Goal 45 commit note)
- [ ] `ruff check . --fix --unsafe-fixes && ruff format .`
- [ ] `pytest` — full suite must pass, coverage ≥ 73%
- [ ] `git commit`
- [ ] Docker rebuild + test prompt verification

---

## Implementation Plan (Step 2)

### Files Located
- `apps/python/src/graphs/react_agent/utils/token.py` - Main file to edit
- `apps/python/src/server/tests/test_token.py` - Test file to update
- `apps/python/src/server/tests/test_streams.py` - Contains TestExtractConfigurableHeaders (L1280+)

### Changes to `token.py`

**Delete entirely:**
1. `get_mcp_access_token()` function (L29-69)
2. `get_tokens()` function (L114-177)
3. `set_tokens()` function (L180-223)
4. `_build_token_namespace()` helper (L72-87)
5. Store key constant `_TOKEN_STORE_KEY` (L27)

**Remove imports:**
- `import aiohttp` (L9)
- `from infra.store_namespace import ...` (L13-17) — entire block
- `from langchain_core.runnables import RunnableConfig` (L12) - keep this
- `from langgraph.config import get_store` (L13) - remove this

**Keep imports:**
- `import contextlib` (L8) - remove, no longer used
- `import logging` (L9) - keep
- `from datetime import UTC` (L10) - remove, no longer used
- `from typing import Any` (L11) - keep
- `from langchain_core.runnables import RunnableConfig` (L12) - keep

**Replace `fetch_tokens()` (L226-280):**
```python
async def fetch_tokens(
    config: RunnableConfig,
    store: Any = None,
) -> dict[str, Any] | None:
    """Return the user's Supabase JWT as an MCP-compatible token dict.

    The MCP servers in this deployment authenticate via a standard
    Supabase JWT passed as Authorization: Bearer.  No token exchange
    is required — the JWT from langgraph_auth_user is used directly.

    Args:
        config: The LangGraph runnable config.
        store: Unused. Kept for call-site signature compatibility.

    Returns:
        {"access_token": "<jwt>"} or None if no JWT is available.
    """
    configurable = config.get("configurable", {}) or {}

    auth_user = configurable.get("langgraph_auth_user") or {}
    supabase_token = auth_user.get("token") or configurable.get(
        "x-supabase-access-token"
    )
    if not supabase_token:
        return None

    return {"access_token": supabase_token}
```

### Changes to `test_token.py`

**Delete test classes entirely:**
1. `TestGetTokens` (L141-303)
2. `TestSetTokens` (L311-401)
3. `TestGetMcpAccessToken` (L737-851)
4. `TestGraphBuildPhaseSimulation` (L859-938)

**Update `TestFetchTokens` class:**
- Delete all current tests (L409-618)
- Replace with 4 simple tests (no aiohttp mocking):
  1. `test_returns_jwt_from_langgraph_auth_user` - basic JWT pass-through
  2. `test_falls_back_to_x_supabase_access_token` - legacy fallback
  3. `test_returns_none_when_no_token` - missing token
  4. `test_store_param_accepted_but_ignored` - signature compat

**Keep `TestFetchTokensLanggraphAuthUser` class (L626-729):**
- These tests already verify the correct behavior (reading from langgraph_auth_user)
- May need minor updates if they reference the old token exchange behavior

**Delete helper functions:**
- `_make_config()` - may still be needed for remaining tests
- `_make_store()` - no longer needed
- `_make_token_record()` - no longer needed

### Changes to `test_streams.py`

**TestExtractConfigurableHeaders (L1280+):**
- `FakeRobynHeaders` class already exists (L1268-1280) ✅
- All 7 tests currently pass plain dicts to `_extract_configurable_headers`
- Need to wrap all dict inputs with `FakeRobynHeaders()`

**Tests to update:**
1. `test_forwards_x_headers` (L1286)
2. `test_excludes_authorization_header` (L1300)
3. `test_excludes_x_api_key` (L1312)
4. `test_lowercases_header_names` (L1324)
5. `test_ignores_non_x_headers` (L1338)
6. `test_multi_value_headers_takes_last` (L1352) - appears twice, handle both
7. `test_handles_none_headers` (L1374)
8. `test_handles_empty_headers` (L1389)

**FakeRobynHeaders update needed:**
Current implementation expects `dict[str, str]`, but multi-value test needs `dict[str, str | list[str]]`:
```python
def __init__(self, data: dict[str, str | list[str]]):
    self._headers = {}
    for k, v in data.items():
        if isinstance(v, list):
            self._headers[k.lower()] = v
        else:
            self._headers[k.lower()] = [v]
```

### Verification Steps
1. Run `ruff check . --fix --unsafe-fixes && ruff format .`
2. Run `pytest apps/python/src/server/tests/test_token.py -v`
3. Run `pytest apps/python/src/server/tests/test_streams.py::TestExecuteRunStreamIntegration::TestExtractConfigurableHeaders -v`
4. Run full test suite: `pytest`
5. Verify coverage ≥ 73%
6. Commit changes
7. Rebuild Docker image
8. Test with verification prompt

---

## Test Strategy for `fetch_tokens`

New tests are simple — no `aiohttp` mocking required:

```python
# Test 1: returns JWT from langgraph_auth_user
config = {"configurable": {"langgraph_auth_user": {"token": "eyJmy-jwt"}}}
result = await fetch_tokens(config)
assert result == {"access_token": "eyJmy-jwt"}

# Test 2: falls back to x-supabase-access-token
config = {"configurable": {"x-supabase-access-token": "eyJlegacy"}}
result = await fetch_tokens(config)
assert result == {"access_token": "eyJlegacy"}

# Test 3: returns None when no token
config = {"configurable": {}}
result = await fetch_tokens(config)
assert result is None

# Test 4: store param accepted but ignored
config = {"configurable": {"langgraph_auth_user": {"token": "eyJmy-jwt"}}}
result = await fetch_tokens(config, store=MagicMock())
assert result == {"access_token": "eyJmy-jwt"}
```

---

## Verification

After deploying, send this test prompt to the personal assistant
(Assistant ID: `3c570fea83a14b57b2f8310ce1fb3951`):

```
Führe bitte diese SQL-Abfrage aus:
SELECT name, is_global, auto_provision_scopes FROM agents ORDER BY name;
```

**Expected:** Markdown table with agent data — `execute_sql` MCP tool called.
**Failure indicator:** Assistant echoes the SQL as plain text (no tool access).

Runtime logs should show:
```
INFO  [graphs.react_agent.agent] MCP server connected: name=supabase-mcp
```
instead of:
```
WARNING [graphs.react_agent.agent] MCP server skipped (auth required but no tokens)
```

---

## Notes

- `aiohttp` may still be used elsewhere in the codebase — only remove the
  import from `token.py`, do NOT remove it from `pyproject.toml`.
- The `store_namespace` module is still used by other parts of the runtime —
  only remove the import from `token.py`.
- The `store` parameter on `fetch_tokens` should be kept in the signature
  (with `Any = None`) for call-site compatibility — `agent.py` and
  `research_agent/__init__.py` both pass `store=store`. Mark it as unused
  with a docstring note, not by removing it.
- Backward compat: keep the `x-supabase-access-token` fallback in
  `fetch_tokens` — some callers may still set it directly.