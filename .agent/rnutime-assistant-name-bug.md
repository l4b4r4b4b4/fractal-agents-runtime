# Bug: Agent Sync Does Not Pass `name` to LangGraph Assistant Store

> **Severity**: Low (UI cosmetic — agents-as-tools picker shows UUIDs instead of names)
> **Component**: `server/agent_sync.py` (fractal-agents-runtime)
> **Runtime version**: `0.0.2` (`fractal-agents-runtime-python:local-dev`)
> **Discovered**: Session 160, 2026-02-18
> **Related**: Goal 55 Task-02, agents-as-tools feature (Goal 54 Phase C)

---

## Problem

When `startup_agent_sync()` creates or updates LangGraph assistants, it does **not** pass the agent's `name` field. All rows in `langgraph_server.assistants` have `name = null`.

```sql
SELECT id, name FROM langgraph_server.assistants;
-- All 5 rows: name IS NULL
```

This causes the frontend's `listRuntimeAssistants()` (which calls `POST /assistants/search`) to fall back to displaying UUIDs:

```typescript
// lib/agents/actions.ts line 756
name: assistant.name ?? assistant.assistant_id,  // ← falls back to UUID
```

The agents-as-tools picker in the advanced agent form shows:

```
☑ a0000000-0000-4000-a000-000000000001
☑ a0000000-0000-4000-a000-000000000005
```

Instead of:

```
☑ Dokumenten-Assistent
☑ Persönlicher Assistent
```

## Root Cause

In `agent_sync.py`, the assistant create/update calls do not include the `name` parameter. The `AgentSyncData` model has `name: str | None`, and it's populated correctly from the SQL query, but it's never passed to the LangGraph assistant store.

## Fix

In `agent_sync.py`, wherever assistants are created or updated, include the `name` field:

### For assistant creation

Find the call that creates a new assistant (likely via `PostgresAssistantStore` or the internal assistant API). Add `name=agent.name`:

```python
# Before (current)
await store.create(
    assistant_id=str(agent.agent_id),
    graph_id=agent.graph_id or "agent",
    config={"configurable": configurable},
    metadata=metadata,
)

# After (fixed)
await store.create(
    assistant_id=str(agent.agent_id),
    graph_id=agent.graph_id or "agent",
    config={"configurable": configurable},
    metadata=metadata,
    name=agent.name,  # ← ADD THIS
)
```

### For assistant update

Same pattern — include `name=agent.name` in the update call so name changes in Supabase propagate to the runtime.

## Verification

After fixing, restart the runtime and check:

```sql
SELECT id, name FROM langgraph_server.assistants;
-- Expected: all rows have proper names
```

Then verify the `/assistants/search` endpoint returns names:

```bash
curl -s -X POST http://localhost:8081/assistants/search \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <jwt>" \
  -d '{"limit": 10}' | jq '.[].name'
# Expected: "Dokumenten-Assistent", "Persönlicher Assistent", etc.
```

## Frontend Workaround (Separate)

The frontend should also be updated to query `public.agents` directly instead of the runtime `/assistants/search` endpoint for the agents-as-tools picker. This gives access to `name`, `description`, and `icon` — none of which are available from the runtime API. This is tracked as a separate frontend task.
