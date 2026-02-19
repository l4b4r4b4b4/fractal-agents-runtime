# Runtime Schema Mismatch — `agent_sync.py` vs DocProc `agents` Table

> **Status**: 🟢 **COMPLETE** — All changes applied, 1133 tests passing, linter clean.
> **Completed**: Session 160 — Option B (full `sampling_params` JSONB) implemented.

> **Runtime version**: `fractal-agents-runtime 0.0.2` (`fractal-agents-runtime-python:local-dev`)
> **Runtime file**: `server/agent_sync.py` (lines 337–420, 504–570)
> **DB table**: `public.agents` (DocProc Platform, Supabase)
> **Error on startup**: `psycopg.errors.UndefinedColumn: column a.temperature does not exist`
> **Created**: 2026-02-18, Session 159

---

## 0. Completion Summary

### Changes Applied (Option B — full `sampling_params` JSONB)

**`apps/python/src/server/agent_sync.py`:**

| Location | Change |
|----------|--------|
| `AgentSyncData` model | Replaced `temperature: float \| None` and `max_tokens: int \| None` with `sampling_params: dict[str, Any]` (default `{}`) and `assistant_tool_ids: list[str]` (default `[]`). |
| `_build_fetch_agents_sql()` | SQL now selects `a.sampling_params, a.assistant_tool_ids` instead of `a.temperature, a.max_tokens`. |
| `fetch_active_agent_by_id()` | Same SQL fix as above. |
| `_agent_from_row()` | Parses `sampling_params` as JSONB dict (with str fallback) and `assistant_tool_ids` as list of UUID strings. |
| `_build_assistant_configurable()` | Spreads all `sampling_params` keys into `configurable` (matches frontend). Adds `configurable["agent_tools"]` from `assistant_tool_ids`. MCP servers now use `tool_name` as server `name` and **omit** the `tools` filter key (fixes Kong tool filtering bug). |

**`apps/python/src/server/tests/test_agent_sync_unit.py`:**

| Change | Details |
|--------|---------|
| `_make_agent_row()` helper | Now uses `sampling_params` dict and `assistant_tool_ids` list instead of `temperature`/`max_tokens` columns. |
| `TestAgentSyncData` | Updated to test `sampling_params` and `assistant_tool_ids`. |
| `TestAgentFromRow` | Replaced `test_row_with_temperature_and_max_tokens` / `test_row_with_none_temperature` with 7 new tests covering dict, string, empty, None, invalid-string sampling_params and assistant_tool_ids variations. |
| `TestBuildAssistantConfigurable` | Replaced `test_agent_with_temperature_and_max_tokens` with 5 new tests: `test_agent_with_sampling_params`, `test_agent_with_sampling_params_spread`, `test_agent_with_sampling_params_none_values_skipped`, `test_agent_with_assistant_tool_ids`, `test_agent_without_assistant_tool_ids`. Updated MCP server assertions to verify no `tools` key and `tool_name`-based server names. |
| `TestBuildFetchAgentsSql` | Added assertions that SQL contains `a.sampling_params` / `a.assistant_tool_ids` and does NOT contain `a.temperature` / `a.max_tokens`. |

### NOT changed (intentionally deferred)

- `GraphConfigPydantic` in `agent.py` — already has `temperature` and `max_tokens` fields that work correctly since `sampling_params` keys are spread into `configurable`. No `agent_tools` field added yet (agents-as-tools feature requires graph-level implementation).
- No DB migration needed — this fix aligns the runtime queries with the **existing** DocProc schema.

### Verification

- `pytest`: 1133 passed, 35 skipped, 0 failures
- `ruff check --fix --unsafe-fixes && ruff format`: all clean
- Remaining step: rebuild Docker image and test against live DB (see Section 10)

---

## 1. The Problem

When `AGENT_SYNC_SCOPE=all` is set, the runtime's `startup_agent_sync()` calls `fetch_active_agents()`, which runs a SQL query against `public.agents`. This query selects columns that **do not exist** in the DocProc schema:

```
ERROR: column a.temperature does not exist
LINE 6:       a.temperature,
              ^
```

The startup sync fails (non-fatal), so the runtime starts but **no agents are synced**. All agents show "Nicht sync." in the frontend because `langgraph_assistant_id` remains NULL.

---

## 2. Schema Comparison

### What `agent_sync.py` expects (SQL in `_build_fetch_agents_sql`)

```sql
SELECT
  a.id AS agent_id,
  a.organization_id,
  a.name,
  a.system_prompt,
  a.temperature,              -- ❌ DOES NOT EXIST
  a.max_tokens,               -- ❌ DOES NOT EXIST
  a.langgraph_assistant_id,
  a.graph_id,
  mt.id AS mcp_tool_id,
  mt.endpoint_url AS mcp_endpoint_url,
  mt.tool_name AS mcp_tool_name,
  mt.is_builtin AS mcp_is_builtin,
  mt.auth_required AS mcp_auth_required,
  COALESCE(am.runtime_model_name, 'openai:gpt-4o') AS runtime_model_name
FROM public.agents a
LEFT JOIN public.agent_mcp_tools amt ON amt.agent_id = a.id
LEFT JOIN public.mcp_tools mt ON mt.id = amt.mcp_tool_id
LEFT JOIN public.global_ai_engines gae ON gae.id = a.engine_id
LEFT JOIN public.ai_models am ON am.id = gae.language_model_id
WHERE a.status = 'active'
  AND a.deleted_at IS NULL
ORDER BY a.organization_id, a.name
```

> **Note**: The same issue exists in `fetch_active_agent_by_id()` (used by `lazy_sync_agent()`), which has an identical SELECT list.

### What the actual `public.agents` table has

| Column | Type | Notes |
|--------|------|-------|
| `id` | `uuid` | PK, `gen_random_uuid()` |
| `organization_id` | `uuid` | NOT NULL |
| `name` | `text` | NOT NULL |
| `description` | `text` | nullable |
| `icon` | `text` | NOT NULL, default `'🤖'` |
| `avatar_url` | `text` | nullable |
| `status` | `text` | NOT NULL, CHECK `active/draft/disabled` |
| `langgraph_assistant_id` | `text` | nullable |
| `graph_id` | `text` | NOT NULL, default `'agent'` |
| `engine_type` | `text` | NOT NULL, default `'global'` |
| `engine_id` | `uuid` | nullable (FK → `global_ai_engines` or `ai_engines`) |
| `system_prompt` | `text` | nullable |
| **`sampling_params`** | **`jsonb`** | **NOT NULL, default `'{}'`** |
| `system_prompt_config` | `jsonb` | nullable |
| **`assistant_tool_ids`** | **`uuid[]`** | **NOT NULL, default `'{}'`** |
| `created_by_user_id` | `uuid` | nullable |
| `created_at` | `timestamptz` | NOT NULL |
| `updated_at` | `timestamptz` | NOT NULL |
| `deleted_at` | `timestamptz` | nullable (soft delete) |
| `is_global` | `boolean` | NOT NULL, default `false` |

### Key differences

| Runtime expects | Actual schema | How to fix |
|-----------------|---------------|------------|
| `a.temperature` (float column) | `a.sampling_params->>'temperature'` (JSONB key) | Extract from JSONB in SQL |
| `a.max_tokens` (int column) | `a.sampling_params->>'max_tokens'` (JSONB key) | Extract from JSONB in SQL |
| _(not queried)_ | `a.assistant_tool_ids` (uuid[]) | New feature — add to query + sync |
| _(not queried)_ | `a.sampling_params` (full JSONB) | Could spread all keys into configurable |

---

## 3. The `sampling_params` JSONB Structure

The `sampling_params` column stores **all** LLM sampling parameters as a single JSONB object. The frontend and agent CRUD actions write/read this as an opaque bag of overrides.

**Supported keys** (documented in schema comment):
- `temperature` (float)
- `top_p` (float)
- `top_k` (int)
- `max_tokens` (int)
- `frequency_penalty` (float)
- `presence_penalty` (float)
- `repetition_penalty` (float)
- `stop` (string[])
- `seed` (int)

**Empty `{}` means "use engine/model defaults for everything."**

Example values from current seed data:

```json
-- Most agents:
{}

-- Rechts-Assistent, Wartungsbericht-Analyst:
{"temperature": 0.3}
```

The frontend `syncAgentToLangGraph()` in `lib/agents/actions.ts` spreads all `sampling_params` keys directly into `configurable`:

```typescript
const samplingParams = (agent.sampling_params ?? {}) as Record<string, unknown>;
for (const [paramKey, paramValue] of Object.entries(samplingParams)) {
  if (paramValue !== null && paramValue !== undefined) {
    configurable[paramKey] = paramValue;
  }
}
```

---

## 4. Recommended SQL Fix

Replace the two broken column references with JSONB extraction in both `_build_fetch_agents_sql()` and `fetch_active_agent_by_id()`:

### Option A: Extract only temperature + max_tokens (minimal change)

```sql
SELECT
  a.id AS agent_id,
  a.organization_id,
  a.name,
  a.system_prompt,
  (a.sampling_params->>'temperature')::float AS temperature,
  (a.sampling_params->>'max_tokens')::int AS max_tokens,
  a.langgraph_assistant_id,
  a.graph_id,
  -- ... rest unchanged
```

This is the smallest change. The `AgentSyncData` model and `_agent_from_row()` / `_build_assistant_configurable()` continue to work unchanged.

### Option B: Extract full sampling_params JSONB (recommended)

```sql
SELECT
  a.id AS agent_id,
  a.organization_id,
  a.name,
  a.system_prompt,
  a.sampling_params,                    -- full JSONB object
  a.assistant_tool_ids,                 -- uuid[] for agents-as-tools
  a.langgraph_assistant_id,
  a.graph_id,
  -- ... rest unchanged
```

Then update `AgentSyncData`:

```python
class AgentSyncData(BaseModel):
    agent_id: UUID
    organization_id: UUID | None = None
    name: str | None = None
    system_prompt: str | None = None

    # Replace temperature + max_tokens with full sampling_params
    sampling_params: dict[str, Any] = Field(default_factory=dict)

    # New: agents-as-tools support
    assistant_tool_ids: list[str] = Field(default_factory=list)

    runtime_model_name: str | None = None
    graph_id: str | None = None
    langgraph_assistant_id: str | None = None
    mcp_tools: list[AgentSyncMcpTool] = Field(default_factory=list)
```

Update `_agent_from_row()`:

```python
def _agent_from_row(row: dict[str, Any]) -> AgentSyncData:
    # ... existing code for agent_id, organization_id, etc ...

    # Parse sampling_params JSONB
    sampling_params_raw = row.get("sampling_params")
    sampling_params: dict[str, Any] = {}
    if isinstance(sampling_params_raw, dict):
        sampling_params = sampling_params_raw
    elif isinstance(sampling_params_raw, str):
        import json
        try:
            sampling_params = json.loads(sampling_params_raw)
        except (json.JSONDecodeError, TypeError):
            pass

    # Parse assistant_tool_ids (uuid[] comes as list of strings)
    assistant_tool_ids_raw = row.get("assistant_tool_ids") or []
    assistant_tool_ids = [str(tid) for tid in assistant_tool_ids_raw if tid]

    data = AgentSyncData(
        agent_id=agent_id,
        organization_id=organization_id,
        name=...,
        system_prompt=...,
        sampling_params=sampling_params,
        assistant_tool_ids=assistant_tool_ids,
        runtime_model_name=...,
        graph_id=...,
        langgraph_assistant_id=...,
        mcp_tools=[],
    )
    # ...
```

Update `_build_assistant_configurable()`:

```python
def _build_assistant_configurable(agent: AgentSyncData) -> dict[str, Any]:
    configurable: dict[str, Any] = {}

    if agent.organization_id:
        configurable["supabase_organization_id"] = str(agent.organization_id)

    if agent.runtime_model_name:
        configurable["model_name"] = agent.runtime_model_name
    if agent.system_prompt is not None:
        configurable["system_prompt"] = agent.system_prompt

    # Spread all sampling params into configurable (matches frontend behavior)
    for param_key, param_value in agent.sampling_params.items():
        if param_value is not None:
            configurable[param_key] = param_value

    # Agents-as-tools: pass selected assistant IDs
    if agent.assistant_tool_ids:
        configurable["agent_tools"] = agent.assistant_tool_ids

    # MCP tools section (unchanged)
    if agent.mcp_tools:
        # ... existing MCP grouping logic ...
```

---

## 5. `assistant_tool_ids` — Agents-as-Tools

This is a new feature (Goal 54, Phase C) that allows agents to invoke other LangGraph assistants as sub-agent tools. The frontend already syncs this via:

```typescript
// In syncAgentToLangGraph():
const assistantToolIds = (agent.assistant_tool_ids ?? []) as string[];
if (assistantToolIds.length > 0) {
  configurable.agent_tools = assistantToolIds;
}
```

The column is `uuid[]` in Postgres. Each UUID is a reference to another agent's `id` (which doubles as the LangGraph `assistant_id` since the runtime uses `str(agent.agent_id)` as the assistant ID).

The runtime's `_build_assistant_configurable` should pass these as `configurable["agent_tools"]` — an array of assistant ID strings. The `GraphConfigPydantic` model in `agent.py` would need a corresponding field to consume them (if agents-as-tools is supported).

---

## 6. MCP Config Format (Already Correct)

The runtime's `_build_assistant_configurable` already produces the correct MCP config format:

```python
configurable["mcp_config"] = {
    "servers": [
        {"name": "server-1", "url": "...", "tools": [...], "auth_required": bool},
    ]
}
```

This matches `MCPConfig { servers: list[MCPServerConfig] }` in `agent.py`. No changes needed here.

**Note**: The frontend `buildMcpConfigFromTools()` was previously broken — it sent either a bare object or array instead of `{ servers: [...] }`. This has been fixed in this session.

---

## 7. `_build_fetch_agents_sql` — MCP Tool Name in `tools` Filter

The runtime groups MCP tools by endpoint URL and passes tool names as a filter:

```python
servers.append({
    "name": f"server-{index + 1}",
    "url": endpoint_url,
    "tools": tool_names,          # e.g. ["supabase-mcp"]
    "auth_required": ...,
})
```

**Important**: For the Kong MCP endpoint, `tool_names` will be `["supabase-mcp"]` — which is the `mcp_tools.tool_name` from our DB, **NOT** the actual MCP tool names served by Kong (like `list_tables`, `execute_sql`, etc.). This means the runtime's per-server tool filter in `agent.py` will try to match `"supabase-mcp"` against tools named `"list_tables"`, `"execute_sql"`, etc. — and **none will match**.

### Fix options

1. **Don't pass `tools` filter for built-in MCP servers** — let the agent access all tools from the server. The `tools` filter in `MCPServerConfig` is optional (defaults to `None` = all tools).

2. **Change the runtime to skip the tools filter when it's just the server name** — if `tools == [tool_name_from_db]`, it's clearly a server identifier, not a tool filter.

3. **Best approach**: Don't include `tools` at all in the server config when there's only one tool entry per endpoint (which is the common case — our `agent_mcp_tools` join produces one row per MCP server, not per individual tool within the server):

```python
server_entry = {
    "name": tool_name or f"server-{index + 1}",  # Use tool_name as server name
    "url": endpoint_url,
    "auth_required": ...,
}
# Only include "tools" filter if we explicitly want to restrict tools
# Don't include it by default — let the agent use all tools from the server
```

---

## 8. Environment Variable Reference

| Env Var | Current Value | Description |
|---------|---------------|-------------|
| `AGENT_SYNC_SCOPE` | `all` (in `.env`) | `none` = no startup sync, `all` = sync all active agents, `org:<uuid>` = specific org |
| `DATABASE_URL` | `postgresql://postgres:postgres@supabase_db_immoflow-platform:5432/postgres` | Docker-internal override |
| `SUPABASE_URL` | `http://supabase_kong_immoflow-platform:8000` | Docker-internal Kong gateway |
| `MODEL_NAME` | `openai:gpt-4o-mini` | Default model for agents without engine override |

---

## 9. Full File List of Changes Needed

### In `server/agent_sync.py`

| Location | What to change |
|----------|---------------|
| `AgentSyncData` model (line ~60) | Replace `temperature: float \| None` and `max_tokens: int \| None` with `sampling_params: dict[str, Any]`. Add `assistant_tool_ids: list[str]`. |
| `_build_fetch_agents_sql()` (line ~337) | Replace `a.temperature, a.max_tokens` with `a.sampling_params, a.assistant_tool_ids` |
| `fetch_active_agent_by_id()` SQL (line ~470) | Same SQL fix as above |
| `_agent_from_row()` (line ~290) | Parse `sampling_params` JSONB and `assistant_tool_ids` uuid[] instead of `temperature`/`max_tokens` |
| `_build_assistant_configurable()` (line ~504) | Spread `sampling_params` dict into configurable. Add `agent_tools` from `assistant_tool_ids`. Remove `tools` key from MCP server entries (or make it optional). |

### In `graphs/react_agent/agent.py` (optional, for agents-as-tools)

| Location | What to change |
|----------|---------------|
| `GraphConfigPydantic` | Add `agent_tools: list[str] \| None = None` field if agents-as-tools feature is desired |
| `graph()` function | Use `agent_tools` to create sub-agent tool instances |

---

## 10. Quick Verification After Fix

```bash
# 1. Rebuild runtime image
docker compose build agent-runtime

# 2. Reset DB + restart
docker compose down agent-runtime
supabase db reset --local
bun run db:seed
docker compose up -d agent-runtime

# 3. Check logs — should see successful sync
docker compose logs -f agent-runtime 2>&1 | grep "agent sync"
# Expected: "Robyn startup: agent sync complete total=5 created=5 ..."

# 4. Verify agents have langgraph_assistant_id set
psql -h localhost -p 54322 -U postgres -d postgres \
  -c "SELECT name, langgraph_assistant_id IS NOT NULL as synced FROM agents WHERE deleted_at IS NULL;"

# 5. Test MCP tools from runtime
docker exec agent-runtime curl -s -X POST \
  http://supabase_kong_immoflow-platform:8000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "MCP-Protocol-Version: 2025-06-18" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
# Expected: 11 tools (list_tables, execute_sql, get_logs, etc.)
```

---

## 11. Context: What Was Already Fixed (Frontend Side)

These changes were made in the DocProc Platform repo during this session:

1. **`mcp_tools.endpoint_url`** for `supabase-mcp` updated from `http://supabase-mcp:8000` to `http://supabase_kong_immoflow-platform:8000/mcp` (Kong built-in MCP endpoint — 11 tools, no custom Docker service needed)

2. **`buildMcpConfigFromTools()`** in `lib/agents/actions.ts`:
   - Now passes `name: tool.toolName` (was missing)
   - Fixed `mcp_config` format from `mcpConfig[0]` / `mcpConfig` to `{ servers: mcpConfig }` (matches runtime's `MCPConfig { servers }` Pydantic model)

3. **Migration file** updated: `20260206220614_add_mcp_tool_configurations.sql` — supabase-mcp endpoint_url now points to Kong
