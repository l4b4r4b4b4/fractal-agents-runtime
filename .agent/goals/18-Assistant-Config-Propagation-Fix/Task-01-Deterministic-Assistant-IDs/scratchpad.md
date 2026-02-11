# Task-01: Deterministic Assistant IDs

> **Goal:** Goal 18 — Assistant Config Propagation Fix
> **Status:** ⚪ Not Started
> **Priority:** Critical
> **Owner:** AI assistant
> **Scope:** Fix `PostgresAssistantStore.create()` to use caller-provided `assistant_id`

---

## Objective

When `agent_sync.py` creates an assistant, it passes `assistant_id` (the Supabase agent UUID) in the payload. The storage layer must use this ID instead of generating a random one. This ensures the ID round-trip works:

```
Supabase agent.id  →  agent_sync payload["assistant_id"]  →  stored assistant.id
                                                                      ↓
Supabase agents.langgraph_assistant_id  ←  write-back  ←  assistant.id
                                                                      ↓
Next.js frontend  →  GET /assistants/{id}  →  found! ✅
```

Currently the chain breaks at step 2 because `create()` generates a random ID.

---

## Success Criteria (Acceptance Checklist)

- [ ] `PostgresAssistantStore.create()` uses `data["assistant_id"]` when present in the payload
- [ ] Falls back to `_generate_id()` when `assistant_id` is not provided (backward compat)
- [ ] Synced assistants have Supabase agent UUIDs as their IDs in `langgraph_server.assistants`
- [ ] `langgraph_assistant_id` written back to Supabase matches the actual stored ID
- [ ] `GET /assistants/{supabase_agent_uuid}` returns the synced assistant
- [ ] Existing tests pass — assistants created without `assistant_id` still get auto-generated IDs
- [ ] New test: create assistant with explicit `assistant_id`, verify it's stored with that ID

---

## Implementation Plan

### 1) Fix `PostgresAssistantStore.create()` in `robyn_server/postgres_storage.py`

**Current code (broken):**

```python
async def create(self, data: dict[str, Any], owner_id: str) -> Assistant:
    resource_id = _generate_id()  # ← Always random
    # ... data["assistant_id"] is never read
```

**Fixed code:**

```python
async def create(self, data: dict[str, Any], owner_id: str) -> Assistant:
    # Use caller-provided assistant_id if present (e.g., from agent sync),
    # otherwise generate a random ID (backward compat for ad-hoc creation).
    resource_id = data.get("assistant_id") or _generate_id()
    # ... rest unchanged
```

### 2) Handle duplicate IDs gracefully

Since `assistant_id` is now caller-controlled, we need to handle the case where the ID already exists. Two options:

**Option A (recommended):** Use `INSERT ... ON CONFLICT (id) DO UPDATE` (upsert).
- Pro: Idempotent — re-running sync doesn't fail
- Pro: Matches the sync's intent (create-or-update)
- Con: Slightly more complex SQL

**Option B:** Let the DB raise a unique constraint violation, catch it, and fall back to `update()`.
- Pro: Simpler code
- Con: Exception-driven control flow, less clean

Recommend **Option A** for idempotency. However, `sync_single_agent()` in `agent_sync.py` already checks for existence before calling `create()`, so a simple unique-violation guard may suffice.

### 3) Verify write-back in `agent_sync.py`

Check that `_write_back_langgraph_assistant_id()` writes back the correct ID. Currently it writes `assistant_id = str(agent.agent_id)` which IS the Supabase UUID. After the fix, this will match the stored ID. No changes expected, but verify.

### 4) Update tests

- `robyn_server/tests/test_storage.py`: Add test for explicit `assistant_id`
- `robyn_server/tests/test_postgres_integration.py`: Add integration test if applicable
- Verify existing tests still pass with the fallback behavior

---

## Files Changed

| File | Change |
|------|--------|
| `robyn_server/postgres_storage.py` | `create()`: use `data.get("assistant_id")` for `resource_id` |
| `robyn_server/tests/test_storage.py` | Add test for explicit `assistant_id` in create payload |

---

## Testing Strategy

### Unit test (new)

```python
async def test_create_assistant_with_explicit_id():
    """Assistant created with explicit assistant_id uses that ID."""
    explicit_id = "a0000000-0000-4000-a000-000000000001"
    assistant = await store.assistants.create(
        {"graph_id": "agent", "assistant_id": explicit_id},
        owner_id="test-user",
    )
    assert assistant.assistant_id == explicit_id
```

### Unit test (backward compat)

```python
async def test_create_assistant_without_explicit_id():
    """Assistant created without assistant_id gets auto-generated ID."""
    assistant = await store.assistants.create(
        {"graph_id": "agent"},
        owner_id="test-user",
    )
    assert assistant.assistant_id is not None
    assert len(assistant.assistant_id) == 32  # hex UUID without dashes
```

### Integration test (manual)

1. Run `AGENT_SYNC_SCOPE=all` startup
2. Query `langgraph_server.assistants` — IDs should be Supabase UUIDs (with dashes)
3. Query `public.agents` — `langgraph_assistant_id` should match
4. `curl GET /assistants/{uuid}` with valid auth → 200 with full config

---

## Notes / Risks

- **ID format:** Supabase UUIDs have dashes (`a0000000-0000-4000-a000-000000000001`), while `_generate_id()` produces hex without dashes (`7dc8143ca57d4735879b0fdaa3dad3cc`). Both are valid Postgres text — no schema change needed. But be aware of format differences in tests and logging.
- **Idempotency:** If the sync runs twice, the second run should either update or skip (not fail). The `sync_single_agent()` already handles this via `get()` → `create()` / `update()` branching. After this fix, `get()` will actually find the assistant on subsequent runs.
- **This task alone does not fix the issue.** Task-02 (owner scoping) is also required — even with correct IDs, the owner mismatch will still prevent user access.

---

## Progress Log

- 2026-02-11: Task created from root cause analysis in docproc-platform Session 72