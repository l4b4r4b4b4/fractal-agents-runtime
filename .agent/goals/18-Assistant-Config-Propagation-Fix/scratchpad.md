# Goal 18: Assistant Config Propagation Fix

> **Status:** ⚪ Not Started
> **Priority:** Critical (blocks agent functionality end-to-end)
> **Created:** 2026-02-11
> **Branch:** `fix/assistant-config-propagation`
> **Depends on:** Goal 15 (Startup Agent Sync), Goal 16 (Store Namespacing)

---

## Problem Statement

Agent sync from Supabase works correctly (Goal 15) — agents are queried, LangGraph assistants are created in Postgres storage with the right `config.configurable` (including `mcp_config`, `model_name`, `system_prompt`, `supabase_organization_id`). **But the config never reaches the agent graph at runtime.**

When a user chats with an agent in the Next.js frontend, the agent responds with **default settings** — no MCP tools, wrong model, hallucinated capabilities — because the synced assistant's configuration is invisible to the requesting user.

### Observed Behavior (docproc-platform Session 72)

1. `AGENT_SYNC_SCOPE=all` → startup sync succeeds: `total=4 created=4 updated=0 skipped=0 failed=0`
2. `langgraph_assistant_id` written back to Supabase `agents` table ✅
3. Correct config stored in `langgraph_server.assistants` table:
   ```
   {"configurable": {"mcp_config": {"servers": [...]}, "model_name": "openai:gpt-4o-mini", "system_prompt": "Du bist...", "supabase_organization_id": "..."}}
   ```
4. User opens chat with **Rechts-Assistent** → `legal-mcp` is running and reachable
5. **But** runtime logs show:
   ```
   graph() invoked; configurable_keys=['assistant', 'assistant_id', 'owner', 'run_id', 'thread_id', 'user_id']
   graph() parsed_config; model_name=openai:gpt-4o base_url_present=False
   ```
   - No `mcp_config`, `system_prompt`, `model_name`, `supabase_organization_id` in configurable keys
   - Model fell back to `openai:gpt-4o` (default) instead of `openai:gpt-4o-mini`
   - Zero MCP tool log lines — no tools loaded at all
6. Agent hallucinated having Python, DALL-E, Wolfram Alpha tools

### Root Cause Analysis

**Two compounding bugs** prevent the synced assistant config from reaching the agent graph:

#### Bug 1: `PostgresAssistantStore.create()` ignores caller-provided `assistant_id`

In `robyn_server/postgres_storage.py`, the `create()` method always generates a random ID:

```python
resource_id = _generate_id()  # ← Always random, ignores data["assistant_id"]
```

The `agent_sync.py` passes `assistant_id` in the payload:

```python
payload = {
    "assistant_id": str(agent.agent_id),  # Supabase agent UUID
    "graph_id": "agent",
    "config": {"configurable": {/* mcp_config, model_name, etc. */}},
}
await storage.assistants.create(payload, owner_id)
```

But `create()` discards `data["assistant_id"]` and stores the assistant with a random hex ID like `7dc8143ca57d4735879b0fdaa3dad3cc` instead of the Supabase UUID `a0000000-0000-4000-a000-000000000001`.

**Impact:** The `langgraph_assistant_id` written back to Supabase doesn't match the actual stored assistant ID. The Next.js frontend sends the Supabase UUID → runtime can't find the assistant.

#### Bug 2: Owner mismatch between sync and user requests

The startup sync creates assistants with `owner_id="system"`:

```python
summary = await startup_agent_sync(pool, storage, scope=scope, owner_id="system")
```

This sets `metadata.owner = "system"` on each assistant. But when a real user chats, their Supabase JWT identity is used as `owner_id`. Both `get()` and `list()` filter by owner:

```sql
WHERE metadata->>'owner' = %s  -- user's JWT identity ≠ "system"
```

**Impact:** Synced assistants are invisible to all real users. The assistant lookup always returns `None`.

#### Combined Effect (What Actually Happens)

1. Frontend calls `GET /assistants/{langgraph_assistant_id}` → **404** (wrong ID + wrong owner)
2. Frontend falls back to `POST /assistants/search` → **empty** (owner mismatch)
3. Frontend falls back to `POST /assistants` → **creates a bare assistant** with only `graph_id: "agent"`, no config
4. Stream uses this empty assistant → agent runs with all defaults, no MCP tools

---

## Solution

### Task-01: Deterministic Assistant IDs

Fix `PostgresAssistantStore.create()` to respect caller-provided `assistant_id`.

### Task-02: Owner Scoping Fix

Fix ownership model so synced assistants are accessible to organization members.

### Task-03: Verification

End-to-end verification that the full chain works: sync → lookup → config merge → MCP tools loaded.

---

## Tasks

| Task | Description | Status | Priority |
|------|-------------|--------|----------|
| Task-01 | Deterministic Assistant IDs | ⚪ Not Started | Critical |
| Task-02 | Owner Scoping Fix | ⚪ Not Started | Critical |
| Task-03 | End-to-End Verification | ⚪ Not Started | High |

---

## Files Involved

| File | Role | Changes Needed |
|------|------|----------------|
| `robyn_server/postgres_storage.py` | Assistant CRUD | `create()`: use `data["assistant_id"]` when provided; ownership model changes |
| `robyn_server/app.py` | Startup sync call | May need owner_id adjustment |
| `robyn_server/agent_sync.py` | Sync orchestration | May need write-back ID fix |
| `robyn_server/routes/streams.py` | Stream config builder | Verify `_build_runnable_config` works after fixes |
| `robyn_server/routes/assistants.py` | Assistant CRUD routes | May need ownership-aware search |
| `robyn_server/models.py` | `Assistant` / `AssistantConfig` | No changes expected |
| `tools_agent/agent.py` | Graph builder | No changes expected (config merge logic is correct once data arrives) |

---

## Verification Checklist

After all tasks are complete, the following must hold:

- [ ] `startup_agent_sync` creates assistants with Supabase agent UUIDs as IDs
- [ ] `langgraph_assistant_id` written back to Supabase matches the actual stored ID
- [ ] Real users can `GET /assistants/{id}` for synced assistants
- [ ] Real users can `POST /assistants/search` and find synced assistants
- [ ] Stream `_build_runnable_config()` receives full `assistant.config.configurable`
- [ ] `graph()` logs show `mcp_config`, `model_name`, `system_prompt` in configurable keys
- [ ] MCP tools are loaded (runtime logs: `MCP tools loaded: count=N`)
- [ ] Agent uses correct model (`openai:gpt-4o-mini`, not default `gpt-4o`)
- [ ] Agent uses synced system prompt (German responses)
- [ ] All existing tests pass (`pytest` + `ruff check` + `ruff format`)

---

## Non-Goals

- Changing the Next.js frontend assistant resolution logic (it's correct — the runtime should serve the right data)
- Changing the agent sync SQL queries (they work correctly)
- Changing the `AssistantConfig` / `Assistant` Pydantic models
- Per-user assistant config overrides (future work)

---

## Risk Assessment

- **Low risk:** The changes are in storage and ownership logic — no agent graph or LLM changes
- **Backward compatibility:** Assistants created without `assistant_id` in payload should still get auto-generated IDs
- **Test coverage:** Existing assistant CRUD tests will need updates to cover the new ID behavior
- **Multi-tenancy:** The owner scoping change needs careful design to avoid leaking assistants across organizations

---

## Progress Log

- 2026-02-11: Goal created based on debugging session in docproc-platform (Session 72)
- 2026-02-11: Root cause identified — two compounding bugs in postgres_storage.py and startup sync owner_id