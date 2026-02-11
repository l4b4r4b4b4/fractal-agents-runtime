# Task-01: Supabase Agent Query Module

> **Goal:** Goal 15 — Startup Agent Sync from Supabase  
> **Status:** 🟢 Complete  
> **Priority:** Critical  
> **Owner:** AI assistant  
> **Scope:** Create `robyn_server/agent_sync.py` with Supabase query + `AgentSyncData` model  
> **Dev testing:** `AGENT_SYNC_SCOPE=all` (production default will be lazy sync)

---

## Objective

Implement the **data access + data model layer** needed to read agent configuration from Supabase/Postgres and materialize it into a runtime-friendly shape that later tasks will sync into LangGraph assistant storage.

This task explicitly does **not**:
- create/update assistants in storage
- write back `langgraph_assistant_id`
- wire into Robyn startup hooks

Those are handled in Task-02/Task-03.

---

## Success Criteria (Acceptance Checklist)

- [x] New module `robyn_server/agent_sync.py` exists
- [x] Defines `AgentSyncData` Pydantic model with fields needed for assistant config:
  - `agent_id`, `organization_id`
  - `name`, `system_prompt`, `temperature`, `max_tokens`
  - `runtime_model_name`, `graph_id`, `langgraph_assistant_id`
  - `mcp_tools: list[...]`
- [x] Supports scoping model via parsed `AGENT_SYNC_SCOPE`:
  - `none`, `all`, `org:<uuid>[,org:<uuid>...]`
- [x] Implements DB query helpers using the existing async Postgres pool:
  - `fetch_active_agents(pool, scope)`
  - `fetch_active_agent_by_id(pool, agent_id)`
- [x] JOIN row grouping is correct (LEFT JOIN duplicates collapsed into one agent record)
- [x] No sensitive data is logged (URLs must not leak tokens/query strings)

---

## Implementation Plan

### 1) Data models

Create:
- `AgentSyncMcpTool` Pydantic model:
  - tool identifiers and metadata from `public.mcp_tools` joins
  - fields optional to tolerate schema drift
- `AgentSyncData` Pydantic model:
  - agent config plus `mcp_tools: list[AgentSyncMcpTool]`

Rationale:
- Keeps Task-02/03 simple: they can convert `AgentSyncData` → `GraphConfigPydantic`/assistant config without touching SQL.

### 2) Scope parsing

Implement:
- `AgentSyncScope` model (`type: none|all|org`, `organization_ids: list[UUID]`)
- `parse_agent_sync_scope(raw: str | None) -> AgentSyncScope`

Rules:
- Missing/empty defaults to `none`
- `all` returns type `all`
- `org:<uuid>,org:<uuid>` returns type `org` with UUIDs
- Invalid entries raise `ValueError` (caller decides whether to fail fast or log + skip)

### 3) SQL query & grouping logic

Implement:
- `_build_fetch_agents_sql(scope)` returning `(sql, params)` with named params
- `_group_agent_rows(rows)` to aggregate tool join rows into per-agent records
- Always filter to active agents:
  - `a.status = 'active'`
  - `a.deleted_at IS NULL`

Query includes:
- `public.agents` base columns used to build assistant config
- joins:
  - `public.agent_mcp_tools` → `public.mcp_tools` for tool assignment
  - `public.global_ai_engines` → `public.ai_models` for `runtime_model_name`
- `COALESCE(am.runtime_model_name, 'openai:gpt-4o')` default model name

### 4) Public async functions (Task-01 deliverables)

- `async def fetch_active_agents(pool, scope) -> list[AgentSyncData]`
  - raises if called with `scope=none` (caller should skip)
- `async def fetch_active_agent_by_id(pool, agent_id) -> AgentSyncData | None`

### 5) Guardrails / non-goals

- Do not import assistant storage in this module (avoid circular deps)
- Avoid logging secrets; if logs are added, log:
  - counts (agents/tools)
  - masked URLs only (scheme+host+path, no query)

---

## Files Changed / Added

- ✅ Added: `robyn_server/agent_sync.py`

_No other files changed in Task-01._

---

## Testing Strategy (for this task)

Unit tests are planned in Task-05, but basic expectations for this module:

- Scope parsing:
  - `"none"` → none
  - `"all"` → all
  - `"org:<uuid>"` → org with 1 id
  - malformed → raises `ValueError`

- Grouping:
  - multiple join rows for same agent → single `AgentSyncData` with `mcp_tools` aggregated

Integration tests (later in Task-05) will validate behavior against the dev Supabase stack (`54321`).

---

## Notes / Risks

- **Schema drift risk:** tables/columns (`global_ai_engines`, `ai_models.runtime_model_name`, `mcp_tools.auth_required`) might differ across environments. The model keeps fields optional, and the grouping logic tolerates missing tool rows.
- **Driver row format:** expects dict-like rows (pool configured with `dict_row`), but includes defensive conversion.

---

## Progress Log

- 2026-02-11
  - Implemented `robyn_server/agent_sync.py`:
    - `AgentSyncData`, `AgentSyncMcpTool`
    - `AgentSyncScope`, `parse_agent_sync_scope`
    - `fetch_active_agents`, `fetch_active_agent_by_id`
    - grouping utilities for LEFT JOIN rows

---

## Next Steps (Task-02)

- Implement assistant sync orchestration:
  - startup sync function
  - lazy sync function
  - core `sync_single_agent()` that builds `config.configurable` (`mcp_config`, model/system prompt, etc.)
- Decide where to write back `langgraph_assistant_id` (DB update) and how to handle idempotency/races.