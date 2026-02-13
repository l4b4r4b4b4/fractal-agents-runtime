# Goal 18: Assistant Config Propagation Fix

> **Status:** 🟡 In Progress (Bug fixes done, pending deploy verification)
> **Priority:** Critical (blocks agent functionality end-to-end)
> **Created:** 2026-02-11
> **Branch:** `chore/add-coverage-tooling-goal-21` (combined with Goal 21)
> **Depends on:** Goal 15 (Startup Agent Sync), Goal 16 (Store Namespacing)
> **Last Updated:** 2026-02-13 (Session 9)

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
| Task-01 | Deterministic Assistant IDs | 🟢 Complete | Critical |
| Task-02 | Owner Scoping Fix | 🟢 Complete | Critical |
| Task-03 | End-to-End Verification | ⚪ Not Started (needs deploy) | High |

---

## Files Involved (paths updated after PR #25 module rename)

| File | Role | Changes Made |
|------|------|-------------|
| `server/storage.py` | In-memory assistant CRUD | ✅ `SYSTEM_OWNER_ID` constant, `BaseStore.create()` honours `data[id_field]`, `AssistantStore.get()/list()` include system visibility |
| `server/postgres_storage.py` | Postgres assistant CRUD | ✅ `create()` uses `data.get("assistant_id", _generate_id())`, `get()/list()` SQL includes `OR metadata->>'owner' = 'system'` |
| `server/app.py` | Startup sync call | ✅ Uses `SYSTEM_OWNER_ID` constant instead of hardcoded `"system"` |
| `server/agent_sync.py` | Sync orchestration | No changes needed (already passes `assistant_id` correctly) |
| `server/routes/streams.py` | Stream config builder | Needs deploy verification (Task-03) |
| `server/routes/assistants.py` | Assistant CRUD routes | No changes needed (system visibility handled in storage layer) |
| `server/models.py` | `Assistant` / `AssistantConfig` | No changes needed |
| `graphs/react_agent/agent.py` | Graph builder | No changes needed |

---

## Verification Checklist

After all tasks are complete, the following must hold:

- [x] `startup_agent_sync` creates assistants with Supabase agent UUIDs as IDs
- [x] `langgraph_assistant_id` written back to Supabase matches the actual stored ID
- [x] Real users can `GET /assistants/{id}` for synced assistants (unit-tested)
- [x] Real users can `POST /assistants/search` and find synced assistants (unit-tested)
- [ ] Stream `_build_runnable_config()` receives full `assistant.config.configurable` (**needs deploy**)
- [ ] `graph()` logs show `mcp_config`, `model_name`, `system_prompt` in configurable keys (**needs deploy**)
- [ ] MCP tools are loaded (runtime logs: `MCP tools loaded: count=N`) (**needs deploy**)
- [ ] Agent uses correct model (`openai:gpt-4o-mini`, not default `gpt-4o`) (**needs deploy**)
- [ ] Agent uses synced system prompt (German responses) (**needs deploy**)
- [x] All existing tests pass (`pytest` + `ruff check` + `ruff format`) — 777 passed, 35 skipped

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
- 2026-02-13 (Session 9): **Task-01 + Task-02 COMPLETE**
  - Bug 1 fixed: `BaseStore.create()` and `PostgresAssistantStore.create()` now use `data.get(id_field, generate_id())` — caller-provided assistant_id is honoured, backward-compatible when absent
  - Bug 2 fixed: `SYSTEM_OWNER_ID = "system"` constant added to `storage.py`; `AssistantStore.get()/list()` and `PostgresAssistantStore.get()/list()` include system-owned assistants for read access; `delete()/update()` remain owner-strict
  - `app.py` updated to import and use `SYSTEM_OWNER_ID` instead of hardcoded `"system"`
  - 7 proof-of-bug tests written (`test_goal18_bugs.py`) — all 7 failed before fix, all 7 pass after
  - Committed to `chore/add-coverage-tooling-goal-21` branch (commit `6c6b41b`)
  - **Task-03 (deploy verification) deferred** — will verify end-to-end after merge + GHCR image build + deploy to webapp