# Runtime Bug: `get_config outside of a runnable context`

**Date:** 2026-03-03
**Runtime:** `ghcr.io/l4b4r4b4b4/fractal-agents-runtime-python:latest`
**Severity:** Blocking — no MCP-enabled assistant can process messages
**Reproducible:** 100% when assistant has `mcp_config.servers` with `auth_required: true`

---

## Symptom

Any message sent to an assistant that has MCP servers configured fails immediately with:

```
RuntimeError: Called get_config outside of a runnable context
```

The assistant is created successfully, the config looks correct (model, system prompt, MCP servers all present), but the first user message triggers the crash. Assistants WITHOUT MCP tools work fine.

## Full Traceback

```
File "/app/.venv/lib/python3.12/site-packages/server/routes/streams.py", line 908, in execute_run_stream
    agent = await build_graph(
File "/app/.venv/lib/python3.12/site-packages/graphs/registry.py", line 81, in _wrapper
    return await _cached[0](config, **kwargs)
File "/app/.venv/lib/python3.12/site-packages/graphs/react_agent/agent.py", line 371, in graph
    mcp_tokens = await fetch_tokens(config)
File "/app/.venv/lib/python3.12/site-packages/graphs/react_agent/utils/token.py", line 203, in fetch_tokens
    current_tokens = await get_tokens(config)
File "/app/.venv/lib/python3.12/site-packages/graphs/react_agent/utils/token.py", line 111, in get_tokens
    store = get_store()
File "/app/.venv/lib/python3.12/site-packages/langgraph/config.py", line 123, in get_store
    return get_config()[CONF][CONFIG_KEY_RUNTIME].store
File "/app/.venv/lib/python3.12/site-packages/langgraph/config.py", line 29, in get_config
    raise RuntimeError("Called get_config outside of a runnable context")
```

## Root Cause Analysis

The call chain is:

```
execute_run_stream()          ← server route handler
  └─ build_graph(config)      ← graph CONSTRUCTION phase (no runnable context yet)
       └─ graph(config)       ← graphs/react_agent/agent.py:371
            └─ fetch_tokens(config)
                 └─ get_tokens(config)
                      └─ get_store()          ← ❌ FAILS HERE
                           └─ get_config()    ← needs LangGraph runnable context
```

### The problem

`get_store()` (from `langgraph.config`) retrieves the store from LangGraph's **runtime context variables**. These context vars are only populated when code runs **inside a graph node execution** (i.e., inside a `Runnable` that LangGraph is orchestrating).

But `fetch_tokens(config)` is called at **line 371 of `agent.py`** during the `graph()` function — which is the **graph construction/build phase**. At this point, no node is executing. There is no runnable context. The config dict is available (passed as a parameter), but the LangGraph context variables haven't been injected yet.

### Why it worked before (probable)

Previously, MCP token fetching likely happened inside a graph node (e.g., during the first agent step), where the runnable context exists. It appears the `fetch_tokens` call was moved into `graph()` (the graph builder) — possibly to eagerly fetch tokens before building tool nodes — but this breaks the context assumption.

## Affected Code Paths

| File | Line | Function | Issue |
|------|------|----------|-------|
| `graphs/react_agent/agent.py` | 371 | `graph()` | Calls `fetch_tokens(config)` during graph build |
| `graphs/react_agent/utils/token.py` | 203 | `fetch_tokens()` | Delegates to `get_tokens()` |
| `graphs/react_agent/utils/token.py` | 111 | `get_tokens()` | Calls `get_store()` which requires runnable context |
| `langgraph/config.py` | 123 | `get_store()` | Calls `get_config()` — fails outside runnable |

## Suggested Fixes

### Option A: Move `fetch_tokens` into a graph node (recommended)

Instead of fetching tokens during graph construction, defer it to the first node execution where the runnable context exists:

```python
# agent.py — graph()

# BEFORE (broken):
async def graph(config: RunnableConfig, ...):
    mcp_tokens = await fetch_tokens(config)  # ❌ no runnable context here
    # ... build graph with tokens ...

# AFTER (option A — lazy fetch inside node):
async def graph(config: RunnableConfig, ...):
    # Don't fetch tokens here. Pass config to nodes and let them fetch lazily.
    # ... build graph WITHOUT tokens ...

# Inside the agent node or a dedicated setup node:
async def agent_node(state, config: RunnableConfig):
    mcp_tokens = await fetch_tokens(config)  # ✅ runnable context exists here
    # ... use tokens for MCP tool calls ...
```

### Option B: Pass store explicitly instead of using `get_store()`

If the store is available from the config dict during build time, pass it explicitly:

```python
# token.py — get_tokens()

# BEFORE:
async def get_tokens(config):
    store = get_store()  # ❌ uses context var

# AFTER:
async def get_tokens(config, store=None):
    if store is None:
        store = get_store()  # fallback for node context
    # ... use store ...
```

Then in `graph()`:

```python
# Extract store from config if available during build phase
store = config.get("configurable", {}).get("__pregel_store", None)
mcp_tokens = await fetch_tokens(config, store=store)
```

### Option C: Wrap in try/except with fallback

Minimal change — catch the error and defer token fetching:

```python
# token.py — get_tokens()
async def get_tokens(config):
    try:
        store = get_store()
    except RuntimeError:
        # Outside runnable context (graph build phase) — return empty tokens
        # Tokens will be fetched at runtime when nodes execute
        return {}
    # ... normal path ...
```

## Reproduction Steps

1. Create an assistant with MCP config:
```bash
curl -X POST http://localhost:8081/assistants \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "graph_id": "agent",
    "name": "Test MCP Agent",
    "config": {
      "configurable": {
        "model_name": "openai:gpt-4o-mini",
        "system_prompt": "You are helpful.",
        "mcp_config": {
          "servers": [{
            "name": "supabase-mcp",
            "url": "http://supabase_kong_immoflow-platform:8000/mcp",
            "auth_required": true
          }]
        }
      }
    }
  }'
```

2. Create a thread and send a message:
```bash
# Create thread
THREAD=$(curl -s -X POST http://localhost:8081/threads \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{}' | python3 -c "import sys,json; print(json.load(sys.stdin)['thread_id'])")

# Send message — this triggers the crash
curl -X POST "http://localhost:8081/runs/stream" \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d "{
    \"assistant_id\": \"<ASSISTANT_ID>\",
    \"thread_id\": \"$THREAD\",
    \"input\": {\"messages\": [{\"role\": \"user\", \"content\": \"hello\"}]},
    \"stream_mode\": \"messages\"
  }"
```

3. Observe error in runtime logs: `RuntimeError: Called get_config outside of a runnable context`

## Runtime Config (for reference)

```
Container: robyn-runtime (docker compose service)
Image: ghcr.io/l4b4r4b4b4/fractal-agents-runtime-python:latest
Python: 3.12
LangGraph: (check pip show langgraph inside container)
Environment:
  - MODEL_NAME=openai:gpt-4o-mini
  - DATABASE_URL=postgresql://postgres:postgres@supabase_db:5432/postgres
  - SUPABASE_URL=http://supabase_kong:8000
```

## Impact

- **All per-user personal assistant instances** fail on first message (they all have MCP tools)
- **All agents with MCP tools** are affected (Dokumenten-Assistent, Wartungsbericht-Analyst, etc.)
- **Agents WITHOUT MCP tools** work fine (Allgemeiner Assistent with no tools)
- This blocks the entire chat feature for MCP-enabled agents

## Workaround

None currently. Removing `mcp_config` from the assistant config allows messages to work, but obviously without any tool access.
