# Task-02: Owner Scoping Fix

> **Goal:** Goal 18 — Assistant Config Propagation Fix
> **Status:** ⚪ Not Started
> **Priority:** Critical
> **Owner:** AI assistant
> **Scope:** Fix ownership model so synced assistants are accessible to authenticated users
> **Depends on:** Task-01 (Deterministic Assistant IDs)

---

## Objective

Startup agent sync creates assistants with `owner_id="system"`, which sets `metadata.owner = "system"` on each assistant. But when real users make requests, their Supabase JWT identity (a UUID like `d4e5f6a7-...`) is used as `owner_id`. Both `get()` and `list()` filter by owner:

```sql
WHERE metadata->>'owner' = %s  -- "d4e5f6a7-..." ≠ "system"
```

This makes all synced assistants **invisible** to every real user. The frontend falls back to creating a bare assistant with no config, which is why the agent runs with defaults and no MCP tools.

### Design Decision Required

There are multiple valid approaches to fix this. The right choice depends on the desired multi-tenancy model:

**Option A: Shared assistants (no owner filter)**
- Remove `metadata->>'owner'` filter from `get()` and `list()` for assistants
- Assistants are global resources, visible to all authenticated users
- Simplest fix, matches the current Supabase model (agents are org-scoped, not user-scoped)
- **Risk:** All users see all assistants, including ones from other organizations

**Option B: Organization-scoped ownership**
- Store `metadata.organization_id` on assistants during sync (already available from `AgentSyncData`)
- Filter by `metadata->>'organization_id'` instead of (or in addition to) owner
- Users see assistants belonging to their organization
- **Risk:** Requires knowing the user's org at query time (available from JWT or run config)

**Option C: Dual ownership — system + user-created**
- Synced assistants get `metadata.owner = "shared"` (or a list of allowed owners)
- `get()` and `list()` match `owner = %s OR owner = 'shared'`
- User-created assistants stay user-scoped
- **Risk:** More complex query logic

**Recommendation: Option A with org-id metadata (hybrid)**
- Remove strict owner filter from assistant `get()` (assistants are looked up by ID — if you know the ID, you can access it)
- Keep owner filter on `list()` but add fallback: `WHERE metadata->>'owner' = %s OR metadata->>'owner' = 'system'`
- Store `organization_id` in metadata for future org-scoping
- This unblocks the integration immediately without a major redesign

---

## Success Criteria (Acceptance Checklist)

- [ ] Synced assistants (owner="system") are returned by `get()` when queried by any authenticated user
- [ ] Synced assistants appear in `list()` results alongside user-created assistants
- [ ] User-created assistants remain scoped to their creator in `list()`
- [ ] `POST /assistants/search` returns synced assistants for authenticated users
- [ ] The frontend `useResolvedAssistant` Strategy 1 (`GET /assistants/{id}`) succeeds for synced agents
- [ ] No assistant data leaks to unauthenticated requests (auth middleware still required)
- [ ] Existing tests pass with updated ownership logic
- [ ] New tests cover the shared/system ownership scenario

---

## Implementation Plan

### 1) Fix `PostgresAssistantStore.get()` — relax owner filter

**Current code (broken for synced assistants):**

```python
async def get(self, resource_id: str, owner_id: str) -> Assistant | None:
    async with self._pool.connection() as connection:
        result = await connection.execute(
            f"""
            SELECT ... FROM {_SCHEMA}.assistants
            WHERE id = %s AND metadata->>'owner' = %s
            """,
            (resource_id, owner_id),
        )
```

**Fixed code (allow system-owned assistants):**

```python
async def get(self, resource_id: str, owner_id: str) -> Assistant | None:
    async with self._pool.connection() as connection:
        result = await connection.execute(
            f"""
            SELECT ... FROM {_SCHEMA}.assistants
            WHERE id = %s
              AND (metadata->>'owner' = %s OR metadata->>'owner' = 'system')
            """,
            (resource_id, owner_id),
        )
```

### 2) Fix `PostgresAssistantStore.list()` — include system assistants

**Current code:**

```python
async def list(self, owner_id: str, **filters) -> list[Assistant]:
    # ...
    WHERE metadata->>'owner' = %s
```

**Fixed code:**

```python
async def list(self, owner_id: str, **filters) -> list[Assistant]:
    # ...
    WHERE (metadata->>'owner' = %s OR metadata->>'owner' = 'system')
```

### 3) Verify assistant search route

Check `robyn_server/routes/assistants.py` to ensure the search endpoint uses `list()` (which will now include system assistants). Verify the graph_id filter works for search payloads like `{"graph_id": "agent"}`.

### 4) Consider: Update sync to set organization_id in metadata

The sync already writes `supabase_organization_id` to metadata:

```python
"metadata": {
    "supabase_agent_id": assistant_id,
    "supabase_organization_id": str(agent.organization_id),
    "synced_at": "...",
}
```

This is available for future org-scoped filtering. No code changes needed now, but document the plan for Option B migration later.

### 5) Update tests

- `robyn_server/tests/test_storage.py`: Test that `get()` returns system-owned assistants for non-system users
- `robyn_server/tests/test_storage.py`: Test that `list()` includes system-owned assistants
- `robyn_server/tests/test_streams.py`: Verify stream config builder receives full assistant config
- Verify no regressions in existing assistant CRUD tests

---

## Files Changed

| File | Change |
|------|--------|
| `robyn_server/postgres_storage.py` | `get()`: relax owner filter to include `system`; `list()`: same |
| `robyn_server/routes/assistants.py` | Verify search uses updated `list()` (likely no changes) |
| `robyn_server/tests/test_storage.py` | Add tests for cross-owner assistant access |

---

## Testing Strategy

### Unit test (new): System-owned assistants visible to users

```python
async def test_get_system_owned_assistant_as_user():
    """System-owned assistants are accessible to authenticated users."""
    # Create assistant as "system" (simulates startup sync)
    assistant = await store.assistants.create(
        {"graph_id": "agent", "assistant_id": "test-uuid"},
        owner_id="system",
    )

    # Retrieve as a regular user
    found = await store.assistants.get("test-uuid", owner_id="user-123")
    assert found is not None
    assert found.assistant_id == "test-uuid"
```

### Unit test (new): List includes system assistants

```python
async def test_list_includes_system_and_user_assistants():
    """list() returns both system-owned and user-owned assistants."""
    await store.assistants.create(
        {"graph_id": "agent", "assistant_id": "system-1"},
        owner_id="system",
    )
    await store.assistants.create(
        {"graph_id": "agent"},
        owner_id="user-123",
    )

    results = await store.assistants.list(owner_id="user-123")
    ids = {a.assistant_id for a in results}
    assert "system-1" in ids  # system assistant visible
    assert len(ids) == 2  # both assistants returned
```

### Unit test (existing — verify no regression): User isolation

```python
async def test_user_cannot_see_other_users_assistants():
    """User-created assistants are not visible to other users."""
    await store.assistants.create(
        {"graph_id": "agent"},
        owner_id="user-a",
    )

    results = await store.assistants.list(owner_id="user-b")
    assert len(results) == 0  # user-a's assistant not visible to user-b
```

### Integration test (manual)

1. Start robyn-server with `AGENT_SYNC_SCOPE=all`
2. Log in to Next.js app as seeded user
3. Open chat with Rechts-Assistent
4. Verify runtime logs show:
   - `configurable_keys` includes `mcp_config`, `model_name`, `system_prompt`
   - `model_name=openai:gpt-4o-mini` (not default gpt-4o)
   - `MCP tools loaded: count=N` (N > 0)
5. Ask agent "Was für Tools hast du?" — should list real MCP tools, not hallucinated ones

---

## Future Work (Not in Scope)

- **Full org-scoping (Option B):** Filter assistants by `metadata.supabase_organization_id` matching the user's organization. This requires extracting org membership from the JWT or a Supabase lookup at request time. Deferred to a future goal.
- **Per-user assistant config overrides:** Allow users to customize model, temperature, etc. on top of the org-defined base config. Future feature.
- **Assistant deletion cascading:** When an agent is deleted in Supabase, the synced assistant should be cleaned up. Currently handled by `deleteAgent()` server action in the Next.js app, but lazy sync should also handle stale assistants.

---

## Notes / Risks

- **Security consideration:** Relaxing the owner filter means any authenticated user can `GET` a system assistant by ID. This is acceptable because:
  - The auth middleware still requires a valid Supabase JWT
  - Assistant IDs are UUIDs — not guessable
  - The Supabase RLS model (not the runtime) is the source of truth for agent access control
  - This matches how LangGraph Cloud handles assistants (shared within a deployment)
- **`list()` ordering:** After including system assistants, ensure the `ORDER BY created_at DESC` still produces sensible results. System assistants may have older timestamps.
- **This task combined with Task-01 should fully fix the issue.** Task-03 is verification only.

---

## Progress Log

- 2026-02-11: Task created from root cause analysis in docproc-platform Session 72