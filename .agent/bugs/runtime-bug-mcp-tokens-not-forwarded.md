# Runtime Bug: MCP Auth Tokens Not Forwarded to Servers

**Date:** 2026-03-03
**Runtime:** `fractal-agents-runtime-python:local-dev` (with `get_config` fix applied)
**Severity:** Blocking — all MCP servers with `auth_required: true` are skipped
**Predecessor:** `runtime-bug-get-config-outside-context.md` (fixed)

---

## Symptom

After fixing the `get_config outside of a runnable context` crash, the runtime no longer crashes during graph construction. However, **all MCP servers are skipped** because the token store contains no auth tokens for the user.

The assistant responds to messages but has zero tool access — it just prints SQL text or says "I can't do that" instead of calling MCP tools.

## Runtime Logs (every message, every server)

```
WARNING  [graphs.react_agent.agent] MCP server skipped (auth required but no tokens): name=supabase-mcp url=http://supabase_kong_immoflow-platform:8000/mcp
WARNING  [graphs.react_agent.agent] MCP server skipped (auth required but no tokens): name=playwright-mcp url=http://playwright-mcp:8931/mcp
WARNING  [graphs.react_agent.agent] MCP server skipped (auth required but no tokens): name=bundesmcp url=http://bundesmcp:8000/mcp
WARNING  [graphs.react_agent.agent] MCP server skipped (auth required but no tokens): name=ifc-mcp url=http://ifc-mcp:8000/mcp
```

This happens for every single run — the token store is always empty for the user.

## What's Happening

### The happy path (expected)

```
Client sends POST /runs/stream
  └─ Authorization: Bearer <user-jwt>
       │
       ▼
Server extracts JWT from request headers
       │
       ▼
Server stores JWT in AsyncPostgresStore (keyed by user_id or thread_id)
       │
       ▼
graph() is called with store instance
  └─ fetch_tokens(config, store=store)  ← the get_config fix passes store explicitly
       └─ get_tokens(config, store=store)
            └─ store.get(namespace, key)  → returns {access_token: "eyJ..."}
                 │
                 ▼
            MCP servers initialized WITH auth headers
```

### What's actually happening

```
Client sends POST /runs/stream
  └─ Authorization: Bearer <user-jwt>
       │
       ▼
Server extracts JWT ✅
       │
       ▼
Server passes JWT to graph via config ✅  (config has user_id, thread_id, etc.)
       │
       ▼
graph() is called with store instance ✅
  └─ fetch_tokens(config, store=store) ✅  (no more get_config crash)
       └─ get_tokens(config, store=store)
            └─ store.get(namespace, key) → returns NOTHING ❌
                 │
                 ▼
            "auth required but no tokens" → server skipped ❌
```

## Root Cause Analysis

The token store lookup finds nothing because **nobody writes the user's JWT into the store before `graph()` is called**. The flow is:

1. Server route receives request with `Authorization: Bearer <jwt>`
2. Server authenticates the user (validates JWT via Supabase GoTrue) ✅
3. Server calls `build_graph(config)` which calls `graph(config, store=store)`
4. `graph()` calls `fetch_tokens(config, store=store)` → `get_tokens()` → `store.get()` → **empty**

**The missing step:** Between step 2 and step 3, the server needs to **write the user's JWT into the store** so that `fetch_tokens` can find it. This is the token seeding/injection step.

### Where the token should be stored

Looking at `get_tokens()` in `utils/token.py`, it likely looks up tokens by a namespace + key pattern, e.g.:

```python
# Probable lookup pattern (check actual code):
namespace = ("mcp_tokens", user_id)  # or ("tokens", thread_id)
key = "auth"  # or server-specific key
tokens = await store.aget(namespace, key)
```

The server route needs to do the inverse — store the JWT before graph execution:

```python
# In server/routes/streams.py, before build_graph():
await store.aput(
    namespace=("mcp_tokens", user_id),
    key="auth",
    value={"access_token": request_jwt}
)
```

## Suggested Fixes

### Option A: Inject token in server route (recommended)

In `server/routes/streams.py` (or wherever `execute_run_stream` is), **before** calling `build_graph`:

```python
async def execute_run_stream(request, ...):
    # 1. Extract JWT from request
    auth_header = request.headers.get("Authorization", "")
    jwt_token = auth_header.replace("Bearer ", "") if auth_header else None
    
    # 2. Get/create store
    store = create_store(...)  # however the store is created
    
    # 3. Seed the token into the store BEFORE graph construction
    if jwt_token and user_id:
        await store.aput(
            namespace=("mcp_tokens", user_id),  # match whatever get_tokens() looks up
            key="auth",
            value={"access_token": jwt_token}
        )
    
    # 4. Now build and run the graph (tokens will be found)
    agent = await build_graph(config, store=store, ...)
```

### Option B: Pass token via config (simpler, no store needed)

Instead of storing/retrieving from the store, pass the JWT directly through config:

```python
# In server route:
config["configurable"]["__user_jwt"] = jwt_token

# In fetch_tokens / graph():
def get_auth_headers(config):
    jwt = config.get("configurable", {}).get("__user_jwt")
    if jwt:
        return {"Authorization": f"Bearer {jwt}"}
    return {}
```

This avoids the store entirely for auth token forwarding.

### Option C: Pass token as MCP server header config

Extend the MCP server config to include headers directly:

```python
# When building MCP clients, inject the auth header:
for server in mcp_servers:
    if server.auth_required and user_jwt:
        server.headers = {"Authorization": f"Bearer {user_jwt}"}
```

## Key Questions for Runtime Investigation

1. **What namespace/key does `get_tokens()` use to look up tokens?** Check `utils/token.py:get_tokens()` — the exact `store.aget()` call pattern.

2. **Is there ANY code path that writes tokens into the store?** Search for `store.aput` or `store.put` related to tokens/auth. If there's none, that confirms the token seeding step was never implemented.

3. **Does the server route pass the JWT anywhere besides config?** Check if `execute_run_stream` or `build_graph` extracts the Authorization header and does something with it.

4. **What does the store contain for a given user?** Debug by dumping: `await store.alist(("mcp_tokens", user_id))` or similar.

## Verification Steps

After fixing, runtime logs should show:

```
INFO  MCP server connected: name=supabase-mcp url=http://supabase_kong_immoflow-platform:8000/mcp
INFO  MCP server connected: name=playwright-mcp url=http://playwright-mcp:8931
INFO  MCP server connected: name=bundesmcp url=http://bundesmcp:8000
INFO  MCP server connected: name=ifc-mcp url=http://ifc-mcp:8000
```

And the assistant should actually call `execute_sql` tool instead of printing SQL text.

## Test Prompt


Once fixed, send this to the personal assistant:

```
Führe bitte diese SQL-Abfrage aus: SELECT name, is_global, auto_provision_scopes FROM agents ORDER BY name;
```

Expected: A markdown table with 5 agents and their scope arrays.
If tools still don't work: The assistant will just echo the SQL as text.

## Impact

- **All per-user personal assistant instances** have zero tool access
- **All MCP-enabled agents** are affected (every server is skipped)
- The assistant still responds (LLM works) but can only generate text — no tool calls execute
- Users see the assistant "pretending" to run queries by printing SQL text

## Relation to Previous Bug

| Bug | Status | Effect |
|-----|--------|--------|
| `get_config outside runnable context` | ✅ Fixed | Graph construction no longer crashes |
| `MCP tokens not forwarded` (this bug) | ❌ Open | Graph builds, but all MCP servers skipped — no tools |

The first fix was necessary but not sufficient. Both bugs need to be resolved for MCP tools to work end-to-end.
