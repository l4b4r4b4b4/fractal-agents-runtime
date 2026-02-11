# Task-02: Assistant Sync Logic (Startup + Lazy + Core)

> **Goal:** Goal 15 — Startup Agent Sync from Supabase  
> **Status:** 🟢 Complete  
> **Priority:** Critical  
> **Owner:** AI assistant  
> **Scope:** Implement sync orchestration functions in `robyn_server/agent_sync.py`  
> **Depends on:** Task-01 (data models + queries)

---

## Objective

Implement the **sync orchestration layer** that takes `AgentSyncData` records (produced by Task-01 queries) and creates/updates LangGraph assistants in the runtime storage layer. This includes:

- **Startup sync**: bulk sync for configured scope at server boot
- **Lazy sync**: on-demand sync for a single agent when first referenced
- **Core sync**: shared idempotent create/update logic with write-back
- **Multi-server MCP config**: emit the new `MCPConfig.servers` shape (not backward-compatible)

---

## Success Criteria (Acceptance Checklist)

- [x] `sync_single_agent(pool, storage, agent=..., owner_id=...)` creates or updates a LangGraph assistant
- [x] Uses **deterministic assistant IDs** (assistant_id = agent UUID string)
- [x] Idempotent: create if missing, update if config changed, skip if identical
- [x] `startup_agent_sync(pool, storage, scope=..., owner_id=...)` iterates all agents for scope
- [x] Returns summary counters: `{total, created, updated, skipped, failed}`
- [x] Logs summary at INFO level
- [x] `lazy_sync_agent(pool, storage, agent_id=..., owner_id=...)` syncs one agent on-demand
- [x] Uses `metadata.synced_at` TTL check (default 5 min) to avoid excessive re-sync
- [x] Best-effort `_write_back_langgraph_assistant_id()` to `public.agents`
- [x] Storage passed explicitly via `AssistantStorageProtocol` (option 1 — testable)
- [x] Multi-server MCP config emitted (`mcp_config.servers: [...]`)

---

## Implementation Plan (What Was Done)

### 1) Storage Protocol

Defined `AssistantStorageProtocol` with nested `Assistants` protocol:
- `get(assistant_id, owner_id) -> Any`
- `create(payload, owner_id) -> Any`
- `update(assistant_id, payload, owner_id) -> Any`

This avoids importing concrete storage implementations and keeps `agent_sync.py` testable with mocks.

### 2) Config Builder — Multi-Server MCP

`_build_assistant_configurable(agent)` now emits:

```python
configurable["mcp_config"] = {
    "servers": [
        {"name": "server-1", "url": "http://legal-mcp:8002", "tools": ["search_law"], "auth_required": False},
        {"name": "server-2", "url": "http://doc-mcp:8003", "tools": ["search_docs"], "auth_required": False},
    ]
}
```

Key design choices:
- Tools are **grouped by endpoint URL** (multiple tools on same server → one entry with tool list)
- Server names are deterministic: `server-{index}` (sorted by URL for stability)
- `auth_required` is OR-aggregated per endpoint (any tool requiring auth → server entry gets `auth_required=True`)

### 3) Assistant Payload

`_assistant_payload_for_agent(agent)` builds:
```python
{
    "assistant_id": str(agent.agent_id),   # deterministic
    "graph_id": agent.graph_id or "agent",
    "config": {"configurable": {...}},
    "metadata": {
        "supabase_agent_id": str(agent.agent_id),
        "supabase_organization_id": str(agent.organization_id),
        "synced_at": "2026-02-22T12:00:00+00:00",
    },
}
```

### 4) Core Sync (`sync_single_agent`)

Flow:
1. Build payload from `AgentSyncData`
2. Check if assistant exists in storage
3. If missing → create + write-back assistant_id to DB
4. If exists but config differs → update + write-back
5. If exists and config matches → skip (no-op)
6. Returns `AgentSyncResult(assistant_id, action, wrote_back_assistant_id)`

### 5) Startup Sync (`startup_agent_sync`)

- Fetches all agents for scope via `fetch_active_agents(pool, scope)`
- Iterates, calling `sync_single_agent()` for each
- Catches per-agent exceptions (non-fatal, logs + increments `failed` counter)
- Logs summary at end

### 6) Lazy Sync (`lazy_sync_agent`)

- Checks if assistant already exists in storage
- If exists, checks `metadata.synced_at` against `cache_ttl` (default 5 min)
- If fresh enough → returns existing assistant_id (no DB query)
- Otherwise → fetches agent from DB → calls `sync_single_agent()`
- Returns `assistant_id` or `None` if agent not found/active

### 7) Write-Back (`_write_back_langgraph_assistant_id`)

- Best-effort UPDATE to `public.agents.langgraph_assistant_id`
- Uses `IS DISTINCT FROM` to avoid no-op writes
- Failures are caught and logged (non-fatal)

---

## Multi-Server MCP Changes (Pulled Forward from Task-04)

### Why pulled forward

The original plan deferred multi-server to Task-04. However, shipping sync with single-server-only would mean agents with multiple MCP tools (e.g., legal-mcp + document-mcp) would silently drop tools. Since there's no deployed state to maintain backward compatibility with, the clean break was made now.

### Files Changed

| File | Change |
|------|--------|
| `tools_agent/agent.py` | Replaced `MCPConfig(url, tools, auth_required)` with `MCPServerConfig` + `MCPConfig(servers: list)`. Updated `graph()` to build `MultiServerMCPClient` from `servers` list with per-server tool filtering. |
| `robyn_server/agent_sync.py` | `_build_assistant_configurable()` now groups MCP tools by endpoint URL and emits `mcp_config.servers` list. |
| `robyn_server/agent.py` | `get_agent_tool_info()` reads from `mcp_config.servers` list instead of `mcp_config.url`. |
| `tools_agent/utils/token.py` | `fetch_tokens()` finds first auth-required server URL from `mcp_config.servers` list for token exchange. |
| `robyn_server/tests/test_mcp.py` | `test_get_agent_tool_info_with_assistant` updated to use `servers` shape. |

### New Schema

```python
class MCPServerConfig(BaseModel):
    name: str = "default"
    url: str
    tools: Optional[List[str]] = None
    auth_required: bool = False

class MCPConfig(BaseModel):
    servers: List[MCPServerConfig] = []
```

---

## Files Changed / Added (Task-02 Scope)

- ✅ Modified: `robyn_server/agent_sync.py` — added sync orchestration functions
- ✅ Modified: `tools_agent/agent.py` — multi-server MCPConfig + graph() wiring
- ✅ Modified: `robyn_server/agent.py` — introspection reads new servers shape
- ✅ Modified: `tools_agent/utils/token.py` — token fetch reads new servers shape
- ✅ Modified: `robyn_server/tests/test_mcp.py` — updated test fixture

---

## Testing

- **549/550 tests pass** (1 pre-existing failure: `test_langgraph_server_schema_exists` — needs running Postgres with migrations)
- `ruff check . --fix --unsafe-fixes` → all checks passed
- `ruff format .` → 61 files unchanged (already formatted)

---

## Risks / Notes

- **`AssistantStorageProtocol` is structural typing** — if the storage API changes method signatures, this will fail at runtime rather than import time. Acceptable tradeoff for avoiding circular deps.
- **Shallow config comparison** for update detection: if assistant config has nested dicts that serialize differently (e.g., key ordering), we may update unnecessarily. This is harmless (idempotent) but slightly wasteful.
- **TTL-based lazy sync skip** depends on `metadata.synced_at` being a parseable ISO timestamp. If storage mangles metadata, we'll re-sync every time (safe, just extra work).

---

## Next Steps (Task-03)

Task-03 wires the sync functions into:
- `robyn_server/app.py` startup handler (done in this session)
- `robyn_server/routes/assistants.py` lazy sync (done in this session)

Task-03 was implemented alongside Task-02 since the wiring was straightforward.