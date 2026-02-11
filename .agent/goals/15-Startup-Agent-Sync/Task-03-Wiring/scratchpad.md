# Task-03: Wire Startup + Lazy Sync into Robyn Server

> **Goal:** Goal 15 — Startup Agent Sync from Supabase  
> **Status:** 🟢 Complete  
> **Priority:** Critical  
> **Owner:** AI assistant  
> **Scope:** Wire `startup_agent_sync` into `on_startup()` and `lazy_sync_agent` into assistant creation  
> **Depends on:** Task-01 (data models + queries), Task-02 (sync orchestration)

---

## Objective

Connect the sync orchestration functions (Task-02) to the actual Robyn server lifecycle and request handling so that:

1. **Startup sync** runs automatically when the server boots (scope-controlled via `AGENT_SYNC_SCOPE` env var).
2. **Lazy sync** triggers transparently when a client creates an assistant with `metadata.supabase_agent_id` (dev-gated via `ROBYN_DEV=true`).

---

## Success Criteria (Acceptance Checklist)

- [x] `robyn_server/app.py:on_startup()` calls `startup_agent_sync()` after `initialize_database()`
- [x] Startup sync is non-fatal — server starts even if sync fails (exception caught + logged)
- [x] Startup sync is skipped when Postgres is not enabled (in-memory mode)
- [x] Startup sync is skipped when `AGENT_SYNC_SCOPE=none` (the default)
- [x] Invalid `AGENT_SYNC_SCOPE` values log a warning and skip (no crash)
- [x] `AGENT_SYNC_SCOPE=all` triggers full sync of all active agents
- [x] `AGENT_SYNC_SCOPE=org:<uuid>` triggers scoped sync for that organization
- [x] Lazy sync in `POST /assistants` is gated behind `ROBYN_DEV=true`
- [x] Lazy sync reads `metadata.supabase_agent_id` from the create payload
- [x] Lazy sync calls `lazy_sync_agent(pool, storage, agent_id=..., owner_id=...)` before normal create flow
- [x] Lazy sync failures are caught and logged (non-fatal, do not block assistant creation)
- [x] All 549 existing tests pass (1 pre-existing Postgres schema test failure unrelated)
- [x] `ruff check` and `ruff format` pass cleanly

---

## Implementation Details

### Startup Sync Wiring (`robyn_server/app.py`)

The `on_startup()` handler was extended with this flow after `initialize_database()`:

```
on_startup()
  ├─ await initialize_database()
  ├─ initialize_langfuse()
  │
  ├─ if not is_postgres_enabled():
  │     log "agent sync skipped (Postgres not enabled)"
  │     return
  │
  ├─ pool = get_pool()
  │   if pool is None:
  │     log "agent sync skipped (pool not available)"
  │     return
  │
  ├─ scope = parse_agent_sync_scope(os.getenv("AGENT_SYNC_SCOPE", "none"))
  │   on ValueError:
  │     log warning + return (no crash)
  │
  ├─ if scope.type == "none":
  │     log "agent sync disabled (AGENT_SYNC_SCOPE=none)"
  │     return
  │
  └─ try:
        storage = get_storage()
        summary = await startup_agent_sync(pool, storage, scope=scope, owner_id="system")
        log summary counters
      except Exception:
        log exception (non-fatal)
```

Key design choices:
- `owner_id="system"` is used for startup-created assistants (not tied to a user session)
- `import os` is done inline to avoid adding a top-level import for a single env var read
- No config dataclass change was needed — the env var is read directly via `parse_agent_sync_scope()`

### Lazy Sync Wiring (`robyn_server/routes/assistants.py`)

The `POST /assistants` handler was extended with a dev-gated lazy sync block inserted **before** the existing `if_exists` check:

```
create_assistant(request):
  ├─ user = require_user()
  ├─ body = parse_json_body(request)
  ├─ create_data = AssistantCreate(**body)
  ├─ storage = get_storage()
  │
  ├─ [NEW] if ROBYN_DEV=true:
  │     metadata = create_data.metadata or {}
  │     supabase_agent_id = metadata.get("supabase_agent_id")
  │     if supabase_agent_id and is_postgres_enabled() and pool:
  │       try:
  │         lazy_sync_agent(pool, storage, agent_id=UUID(supabase_agent_id), owner_id=user.identity)
  │       except (ValueError, Exception):
  │         log warning, continue
  │
  ├─ [existing] if_exists handling
  └─ [existing] create assistant
```

Key design choices:
- **Dev-gated** (`ROBYN_DEV=true`): avoids tenant/auth risks in production since the DB pool connects as Postgres superuser (bypasses RLS). Future work: add proper org-level access validation.
- **`lazy_sync_agent` import is deferred** (inside the conditional block) to avoid circular imports and to not load sync machinery when the feature is disabled.
- **UUID validation**: invalid `supabase_agent_id` strings are caught by `UUID()` constructor and silently skipped.
- **Non-blocking**: any exception in the lazy sync path is caught and logged as a warning. The normal assistant creation flow continues regardless.

### Why Option B (Transparent) Was Chosen Over Option A (New Endpoint)

| Criterion | Option A (`POST /agents/:id/sync`) | Option B (Transparent in `POST /assistants`) |
|-----------|-------------------------------------|----------------------------------------------|
| Frontend changes | Required (new API call) | None |
| Edge cases | Client can forget to call it | Always runs when metadata is present |
| Auth surface | New endpoint to secure | Uses existing auth middleware |
| Complexity | New route + handler | ~30 lines in existing handler |
| Dev-gating | Possible but more boilerplate | Simple env var check |

Option B wins on simplicity, zero-frontend-change, and covering the exact failure mode observed in Session 73 (frontend creating bare assistants because it doesn't know the agent's MCP config).

### Security Considerations

The lazy sync runs a DB query as the Postgres superuser (pool configured in `database.py`), which bypasses Supabase RLS. This means:

- Any authenticated user who crafts a `metadata.supabase_agent_id` pointing to another org's agent could trigger a sync of that agent into their assistant namespace.
- **Mitigation (current):** dev-gated behind `ROBYN_DEV=true`. In production, lazy sync is disabled.
- **Mitigation (future):** validate that `user.identity` (from JWT) belongs to the same organization as the agent being synced. This requires reading `organization_members` or similar from the DB.

---

## Files Changed

| File | Change Type | Description |
|------|-------------|-------------|
| `robyn_server/app.py` | Modified | Added startup sync block after `initialize_database()` |
| `robyn_server/routes/assistants.py` | Modified | Added dev-gated lazy sync in `POST /assistants` handler |

---

## Testing

### Automated
- **549/550 tests pass** — no regressions introduced
- 1 pre-existing failure: `test_langgraph_server_schema_exists` (needs running Postgres with migrations)
- `ruff check . --fix --unsafe-fixes` → all checks passed
- `ruff format .` → all files formatted

### Manual Testing Guide (Dev Scenario)

To verify startup sync with the local Supabase stack:

1. Ensure Supabase is running on port 54321 with seeded agents
2. Set environment variables:
   ```
   AGENT_SYNC_SCOPE=all
   ROBYN_DEV=true
   ```
3. Start robyn-server: `docker compose up -d robyn-server`
4. Check logs: `docker logs robyn-server`
5. Expected output:
   ```
   Robyn startup: Postgres persistence enabled
   Startup sync summary: total=N created=N updated=0 skipped=0 failed=0
   Robyn startup: agent sync complete total=N created=N updated=0 skipped=0 failed=0
   ```
6. Verify in Supabase: `SELECT id, name, langgraph_assistant_id FROM public.agents` — all active agents should have `langgraph_assistant_id` populated.

To verify lazy sync:

1. Set `AGENT_SYNC_SCOPE=none` and `ROBYN_DEV=true`
2. Start robyn-server (no startup sync runs)
3. Create an assistant via API:
   ```json
   POST /assistants
   {
     "graph_id": "agent",
     "metadata": {
       "supabase_agent_id": "<agent-uuid-from-supabase>"
     }
   }
   ```
4. The assistant should be created with the full MCP config from the database.

---

## Risks / Notes

- **`os.getenv` inside startup handler**: slightly unconventional vs. putting it in `Config.from_env()`, but avoids coupling the config dataclass to sync-specific env vars. If more sync env vars are needed later, consider adding an `AgentSyncConfig` dataclass.
- **`owner_id="system"` for startup-created assistants**: these assistants are "owned" by the system. If the storage layer enforces per-user isolation strictly, downstream handlers may need to look up assistants with `owner_id="system"` as a fallback. The current `storage.assistants.get()` uses `owner_id` for filtering, so `lazy_sync_agent` uses the requesting user's identity which creates a user-scoped copy.

---

## Progress Log

- 2026-02-22: Implemented startup sync wiring in `app.py` and lazy sync in `routes/assistants.py`
- 2026-02-22: All tests pass, ruff clean

---

## Completed

Task-03 was implemented alongside Task-02 in a single session since the wiring was straightforward and the sync functions were already ready. No separate approval step was needed as the user approved the combined plan ("go ahead").

### Remaining Tasks (Goal 15)

- **Task-04 (Multi-MCP Server):** ✅ Pulled forward into Task-02 — `MCPConfig` now supports `servers: list[MCPServerConfig]`
- **Task-05 (Testing):** ⚪ Not Started — unit tests for `agent_sync.py` query/sync logic, integration test with real Supabase