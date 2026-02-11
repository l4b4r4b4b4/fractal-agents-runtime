# Goal 15: Startup Agent Sync from Supabase

> **Status:** 🟡 In Progress
> **Priority:** Critical
> **Created:** 2026-02-22
> **Branch:** TBD (e.g. `feature/startup-agent-sync`)

---

## Problem Statement

When the robyn-server starts, it has **no knowledge of agents defined in the Supabase `agents` table**. Agents are currently only synced to LangGraph assistants when created through the docproc-platform web UI (`createAgent()` server action). Seeded agents (from `seed.sql`) are **never synced**, meaning:

- Agents claim hallucinated tools (Python, DALL-E, Wolfram Alpha) instead of their actual MCP tools
- The `mcp_config` from the agent's assigned MCP tools is never passed to LangGraph
- System prompts, model names, and temperature settings from the database are ignored
- The `langgraph_assistant_id` column stays NULL for seeded agents

### Observed Behavior (Session 73)

1. Created **⚖️ Rechts-Assistent** with `legal-mcp` tool assigned in seed data
2. `legal-mcp` FastMCP server running and healthy on port 8002
3. Agent picker works, chat session created with correct `agent_id`
4. **But**: Agent responds with hallucinated tool list — no MCP tools loaded
5. `docker logs robyn-server` shows **zero** MCP-related log lines
6. `docker logs legal-mcp` shows **zero** incoming tool requests from robyn

**Root cause:** The robyn-server assistant has no `mcp_config` in its configurable — it was created by `useResolvedAssistant` as a bare assistant with just `graph_id: "agent"` and no tool configuration.

---

## Solution: Startup Agent Sync

On robyn-server startup, **query Supabase for all active agents and their MCP tool assignments**, then create/update LangGraph assistants with the correct configuration.

### Architecture

Two sync mechanisms work together:

1. **Startup sync** (warm cache) — preload agents for a configured scope
2. **Lazy sync** (on-demand) — sync individual agents when first referenced in a chat

```
robyn-server startup
  │
  ├─ initialize_database()              ← existing
  ├─ initialize_langfuse()              ← existing
  ├─ startup_agent_sync(scope)          ← NEW (warm cache)
  │     │
  │     ├─ Read AGENT_SYNC_SCOPE env var (default: "none")
  │     ├─ Query public.agents + MCP tools + engines (filtered by scope)
  │     └─ For each agent: create/update LangGraph assistant
  │
  └─ Start serving requests
        │
        └─ On chat message with agent_id:
              └─ lazy_sync_agent(agent_id)    ← NEW (on-demand)
                    ├─ Check if assistant exists in storage
                    ├─ If missing or stale: query DB → create/update assistant
                    └─ Return assistant_id
```

### Scoping Model

Agents are scoped to **organizations** in the database. The sync can be configured at multiple levels:

| Scope | Env Var Value | Behavior | Use Case |
|-------|--------------|----------|----------|
| None | `AGENT_SYNC_SCOPE=none` | No startup sync; lazy only | Multi-tenant SaaS (default) |
| All | `AGENT_SYNC_SCOPE=all` | Sync ALL active agents at startup | Single-tenant / dev |
| Organization | `AGENT_SYNC_SCOPE=org:<uuid>` | Sync agents for one org | Dedicated deployment per customer |
| Multiple Orgs | `AGENT_SYNC_SCOPE=org:<uuid>,org:<uuid>` | Sync agents for listed orgs | Shared infra, known tenants |

**Why not team/project scoping?**
- Agents belong to **organizations**, not teams or projects
- Team/project filtering is a UI concern (who can *see* which agents)
- The runtime doesn't need to care — it just needs the correct assistant config
- Access control stays in the frontend + Supabase RLS

### Lazy Sync (Primary Mechanism)

The **lazy sync** is the workhorse for multi-tenant:

1. Frontend creates chat with `agent_id` → sends to robyn via `assistant_id`
2. If `assistant_id` is NULL (seeded agent, never synced), frontend falls back to `useResolvedAssistant`
3. `useResolvedAssistant` calls `POST /assistants/search` → no match → calls `POST /assistants` with bare config
4. **Problem**: Frontend doesn't know the agent's MCP tools / model config!

**Fix**: Add a **new endpoint** `POST /agents/:agent_id/sync` that:
- Queries the agent's full config from Supabase (MCP tools, model, system prompt)
- Creates/updates the LangGraph assistant with correct config
- Returns the `assistant_id`
- Frontend calls this instead of creating a bare assistant

Alternatively, integrate lazy sync into the existing `POST /assistants` flow:
- If the assistant create payload includes `metadata.supabase_agent_id`, look up the full config from DB
- This is transparent to the frontend

### Key Design Decisions

1. **Supabase is source of truth** — agents table drives everything
2. **Lazy sync is default** — startup sync is opt-in via env var
3. **Sync is idempotent** — safe to run on every startup and on every request
4. **Service-level DB access** — uses the existing Postgres pool (same `DATABASE_URL`), queries `public.agents` directly (bypasses RLS since pool connects as `postgres` superuser)
5. **Non-fatal** — if sync fails, server still starts (log warnings); if lazy sync fails, agent runs without MCP tools
6. **Deterministic assistant IDs** — use agent UUID as assistant_id to avoid duplicates across restarts/replicas
7. **MCPConfig mapping** — each agent gets ONE mcp_config (first assigned tool's endpoint_url); Task-04 adds multi-server support
8. **Write-back assistant_id** — store the LangGraph assistant_id back into `public.agents` so the frontend knows which assistant to use

---

## Tasks

### Task-01: Supabase Agent Query Module — 🟢 Complete

**Files to create/modify:**
- `robyn_server/agent_sync.py` (NEW) — module with query + sync logic
- `robyn_server/config.py` — add `AgentSyncConfig` with `AGENT_SYNC_SCOPE` env var

**Scope:**
- `AgentSyncConfig` dataclass: `scope` (str, default `"none"`), parsed into scope type + IDs
- `async def fetch_active_agents(pool, scope)` — query `public.agents` with JOINs, filtered by scope
- Returns list of `AgentSyncData` (Pydantic model: agent_id, name, system_prompt, temperature, max_tokens, mcp_tools list, runtime_model_name, langgraph_assistant_id, organization_id)
- Uses the existing Postgres `AsyncConnectionPool` from `database.py`
- Groups multi-tool agents (LEFT JOIN produces multiple rows per agent)

**SQL query sketch:**
```sql
SELECT
  a.id,
  a.organization_id,
  a.name,
  a.system_prompt,
  a.temperature,
  a.max_tokens,
  a.langgraph_assistant_id,
  a.graph_id,
  mt.endpoint_url AS mcp_endpoint_url,
  mt.tool_name AS mcp_tool_name,
  mt.is_builtin AS mcp_is_builtin,
  COALESCE(am.runtime_model_name, 'openai:gpt-4o') AS runtime_model_name
FROM public.agents a
LEFT JOIN public.agent_mcp_tools amt ON amt.agent_id = a.id
LEFT JOIN public.mcp_tools mt ON mt.id = amt.mcp_tool_id
LEFT JOIN public.global_ai_engines gae ON gae.id = a.engine_id
LEFT JOIN public.ai_models am ON am.id = gae.language_model_id
WHERE a.status = 'active'
  AND a.deleted_at IS NULL
  -- Scope filter (injected dynamically):
  -- AND a.organization_id = ANY(%s)  -- for org scope
ORDER BY a.organization_id, a.name;
```

### Task-02: Assistant Sync Logic (Startup + Lazy) — 🟢 Complete

**Files to modify:**
- `robyn_server/agent_sync.py` — add sync functions

**Scope:**

**Startup sync:**
- `async def startup_agent_sync(pool, storage, scope)` — main startup orchestrator
- Calls `fetch_active_agents(pool, scope)` → iterates → calls `sync_single_agent()`
- Log summary: "Startup sync: N agents (X created, Y updated, Z skipped, W failed)"

**Lazy sync (on-demand):**
- `async def lazy_sync_agent(pool, storage, agent_id)` — sync a single agent by ID
- Called when frontend references an agent that has no assistant in storage
- Queries single agent from DB → creates/updates assistant → returns assistant_id
- Cached: if assistant already exists and is recent (< 5min), skip re-sync

**Shared core:**
- `async def sync_single_agent(pool, storage, agent_data) → str | None` — create/update one assistant
  - Build `config.configurable` dict: `model_name`, `system_prompt`, `temperature`, `max_tokens`, `mcp_config`
  - Use **agent UUID as deterministic assistant_id** (avoids duplicates across replicas)
  - If assistant exists in storage → PATCH with updated config
  - If not → POST to create with `assistant_id = agent.id`
  - Write `langgraph_assistant_id` back to `public.agents` (only if changed)
- Handle multi-MCP-tool agents: currently MCPConfig supports single URL; use first tool, log warning for multiple (Task-04 fixes)

### Task-03: Wire into Startup + Request Path — 🟢 Complete

**Files to modify:**
- `robyn_server/app.py` — add startup sync call to `on_startup()`
- `robyn_server/routes/streams.py` or `robyn_server/routes/runs.py` — add lazy sync hook

**Startup wiring:**
- Call after `initialize_database()` succeeds (needs the pool)
- Parse `AGENT_SYNC_SCOPE` from config
- Non-fatal: wrap in try/except, log error but don't block startup
- Add `"agent_sync"` capability flag to `/info` endpoint

**Lazy sync wiring (two options — decide during implementation):**

*Option A: New endpoint*
- `POST /agents/:agent_id/sync` — explicit sync trigger
- Frontend calls this before starting a chat if `langgraph_assistant_id` is NULL
- Returns `{ assistant_id: "..." }`

*Option B: Transparent in assistant resolution*
- When `POST /assistants` receives `metadata.supabase_agent_id`, auto-enrich config from DB
- Transparent to frontend — no API change needed
- Preferred if we want zero frontend changes

### Task-04: Multi-MCP Server Support — 🟢 Complete (Pulled Forward)

**Status:** 🟢 Complete — pulled forward into Task-02 implementation

Originally deferred, but implemented alongside Task-02 since:
- Shipping sync with single-server would silently drop tools for multi-tool agents
- No deployed state to maintain backward compatibility with
- `MultiServerMCPClient` already supported multiple servers

**New MCPConfig (no backward compatibility — clean break):**
```python
class MCPServerConfig(BaseModel):
    name: str = "default"
    url: str
    tools: Optional[List[str]] = None
    auth_required: bool = False

class MCPConfig(BaseModel):
    servers: List[MCPServerConfig] = []
```

**Files changed:**
- `tools_agent/agent.py` — replaced old `MCPConfig`, updated `graph()` to build multi-server `MultiServerMCPClient`
- `robyn_server/agent_sync.py` — emits `mcp_config.servers` grouped by endpoint URL
- `robyn_server/agent.py` — `get_agent_tool_info()` reads new `servers` shape
- `tools_agent/utils/token.py` — `fetch_tokens()` finds first auth-required server from `servers` list
- `robyn_server/tests/test_mcp.py` — updated test fixture to new shape

### Task-05: Testing — ⚪ Not Started

**Files to create:**
- `tests/test_agent_sync.py` — unit tests for query + sync logic

**Scope:**
- Test `parse_agent_sync_scope()` edge cases
- Test `_group_agent_rows()` with mock rows (multi-tool grouping)
- Test `_build_assistant_configurable()` emits correct multi-server MCP shape
- Test `sync_single_agent()` with mock storage (create vs update vs skip paths)
- Test `startup_agent_sync()` summary counters
- Test `lazy_sync_agent()` TTL cache behavior
- Test non-fatal failure handling (DB errors, storage errors)
- Integration test with real Supabase (pytest.mark.postgres)

---

## Key Files Reference

### robyn-server (this repo)
- `robyn_server/app.py` — startup handler (`on_startup`)
- `robyn_server/database.py` — Postgres pool lifecycle
- `robyn_server/storage.py` — in-memory assistant store
- `robyn_server/postgres_storage.py` — Postgres-backed assistant store
- `robyn_server/config.py` — SupabaseConfig, DatabaseConfig
- `tools_agent/agent.py` — `graph()` function, `MCPConfig`, `GraphConfigPydantic`

### docproc-platform (consumer)
- `supabase/seed.sql` — seeded agents + MCP tool assignments
- `supabase/migrations/20260206220614_add_mcp_tool_configurations.sql` — mcp_tools table
- `supabase/migrations/20260210110000_add_ai_engines.sql` — agents table, ai_engines
- `supabase/migrations/20260222100000_openai_azure_agent_engines.sql` — runtime_model_name column
- `apps/web/lib/agents/actions.ts` — `syncAgentToLangGraph()` (current frontend-triggered sync)
- `apps/web/components/chat/chat-provider.tsx` — `useResolvedAssistant` hook

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Supabase schema changes break query | Sync fails silently | Pin column names, add schema version check |
| Postgres pool not ready when sync runs | Sync skipped | Run after `initialize_database()` confirms pool |
| MCP server unreachable at startup | Agent created without tools | Non-fatal; tools load lazily in `graph()` when called |
| Multiple runtime instances racing writes | Duplicate assistants | Use agent UUID as deterministic assistant_id |
| `langgraph_assistant_id` write-back fails | Frontend can't resolve assistant | Frontend already has fallback search/create logic |

---

## Success Criteria

### Startup Sync (with `AGENT_SYNC_SCOPE=all`)
- [ ] `docker compose up -d robyn-server` → logs show "Startup sync: N agents (X created, Y updated)"
- [ ] Seeded Rechts-Assistent has `langgraph_assistant_id` populated in DB after startup
- [ ] Scale to 0 and back up → agents re-sync automatically

### Lazy Sync (with `AGENT_SYNC_SCOPE=none` / default + `ROBYN_DEV=true`)
- [ ] First chat with an unsynced agent triggers lazy sync transparently (via `POST /assistants` with `metadata.supabase_agent_id`)
- [ ] Subsequent chats reuse the cached assistant (no re-sync within 5 min TTL)

### End-to-End (either sync mode)
- [ ] Chat with Rechts-Assistent → `docker logs robyn-server` shows `MCP tools loaded: count=N servers=[...]`
- [ ] Chat with Rechts-Assistent → `docker logs legal-mcp` shows incoming tool requests
- [ ] Agent responds with actual legal tool capabilities, not hallucinated tools
- [ ] Server starts successfully even if Supabase is unreachable (non-fatal sync)

### Multi-Server MCP
- [ ] Agent with 2+ MCP tools (e.g. legal-mcp + document-mcp) loads tools from all servers
- [ ] Per-server tool filtering works (server-specific `tools` list respected)

### Scoping
- [ ] `AGENT_SYNC_SCOPE=none` → no startup sync, lazy only
- [ ] `AGENT_SYNC_SCOPE=all` → all active agents synced at startup
- [ ] `AGENT_SYNC_SCOPE=org:<uuid>` → only agents for that org synced at startup

---

## Session Log

### Session 73 (2026-02-22) — Goal Created

**Context:** During browser testing of chat ↔ agent integration in docproc-platform, discovered that seeded agents are never synced to LangGraph. The Rechts-Assistent with `legal-mcp` tool assigned responds with hallucinated tools because robyn-server has no knowledge of the agent's MCP configuration.

**Decision:** Sync should happen at runtime startup (not UI-triggered) so that:
- Scale up/down always results in correct agent configs
- No manual intervention needed after `db reset` or fresh deployment
- Database remains single source of truth

**Codebase explored:**
- `robyn_server/app.py` — startup handler, route registration
- `robyn_server/database.py` — Postgres pool, checkpointer, store
- `robyn_server/storage.py` + `postgres_storage.py` — assistant CRUD
- `robyn_server/config.py` — SupabaseConfig, DatabaseConfig
- `tools_agent/agent.py` — `graph()`, `MCPConfig`, MCP tool loading via `MultiServerMCPClient`
- `robyn_server/routes/assistants.py` — assistant API endpoints

### Session 74 (2026-02-22) — Tasks 01–04 Implemented

**What was done:**

1. **Task-01 (Agent Query Module):** Created `robyn_server/agent_sync.py` with:
   - `AgentSyncData` + `AgentSyncMcpTool` Pydantic models
   - `AgentSyncScope` + `parse_agent_sync_scope()` for env-var-based scoping
   - `fetch_active_agents(pool, scope)` and `fetch_active_agent_by_id(pool, agent_id)` — SQL queries with LEFT JOIN grouping

2. **Task-02 (Sync Logic):** Extended `agent_sync.py` with:
   - `AssistantStorageProtocol` (structural typing for testability)
   - `sync_single_agent()` — idempotent create/update with deterministic assistant IDs
   - `startup_agent_sync()` — bulk sync with summary counters
   - `lazy_sync_agent()` — on-demand with 5-min TTL cache
   - `_write_back_langgraph_assistant_id()` — best-effort DB update
   - Multi-server MCP config builder (groups tools by endpoint URL)

3. **Task-03 (Wiring):** Connected sync to server lifecycle:
   - `robyn_server/app.py` — startup sync after `initialize_database()`, scope-controlled via `AGENT_SYNC_SCOPE`
   - `robyn_server/routes/assistants.py` — dev-gated lazy sync in `POST /assistants` (Option B, transparent)

4. **Task-04 (Multi-MCP Server — Pulled Forward):** Breaking change to `MCPConfig`:
   - Replaced `MCPConfig(url, tools, auth_required)` with `MCPConfig(servers: list[MCPServerConfig])`
   - Updated `graph()` to build `MultiServerMCPClient` from `servers` list
   - Updated `get_agent_tool_info()`, `fetch_tokens()`, and test fixtures

**Test results:** 549/550 passed (1 pre-existing), ruff clean.

**Decisions made:**
- No backward compatibility for `MCPConfig` (user confirmed: "there are no assistants deployed anywhere yet")
- Lazy sync uses Option B (transparent in `POST /assistants`) over Option A (new endpoint)
- Lazy sync is dev-gated (`ROBYN_DEV=true`) to avoid tenant/auth issues with superuser DB connections
- Storage passed explicitly (option 1) for testability

**Remaining:** Task-05 (unit + integration tests for `agent_sync.py`)