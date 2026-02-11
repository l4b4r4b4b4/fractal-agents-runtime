# Task-03: End-to-End Verification

> **Goal:** Goal 18 — Assistant Config Propagation Fix
> **Status:** ⚪ Not Started
> **Priority:** High
> **Owner:** AI assistant
> **Scope:** Verify the full chain works: sync → lookup → config merge → MCP tools loaded
> **Depends on:** Task-01 (Deterministic IDs), Task-02 (Owner Scoping)

---

## Objective

After Task-01 and Task-02 are implemented, verify end-to-end that synced Supabase agents are accessible to real users and that assistant configuration (MCP tools, model name, system prompt, temperature, org ID) reaches the agent graph at runtime.

This task is **verification only** — no new code unless issues are discovered during testing.

---

## Success Criteria (Acceptance Checklist)

### Automated

- [ ] All existing tests pass: `pytest` (550+ tests)
- [ ] `ruff check` clean
- [ ] `ruff format` clean
- [ ] New tests from Task-01 and Task-02 pass

### Startup Sync Verification

- [ ] `AGENT_SYNC_SCOPE=all` → sync succeeds with correct counts
- [ ] `langgraph_server.assistants` table contains Supabase agent UUIDs as IDs (with dashes)
- [ ] `public.agents.langgraph_assistant_id` matches the stored assistant IDs
- [ ] Second startup (without reset) → `skipped=4` (idempotent, no duplicates)

### Runtime Config Propagation

- [ ] `docker logs robyn-server` shows `configurable_keys` including:
  - `mcp_config`
  - `model_name`
  - `system_prompt`
  - `supabase_organization_id`
  - `temperature`
  - `max_tokens`
- [ ] `model_name=openai:gpt-4o-mini` (from agent config, not default `gpt-4o`)
- [ ] `MCP tools loaded: count=N` where N > 0 (for agents with assigned MCP tools)

### Frontend Integration

- [ ] `useResolvedAssistant` Strategy 1 succeeds: `GET /assistants/{langgraph_assistant_id}` → 200
- [ ] No fallback to Strategy 2 (search) or Strategy 3 (create bare assistant)
- [ ] Chat uses correct model and system prompt
- [ ] Agent with MCP tools actually calls them (no hallucinated tool lists)

---

## Verification Procedure

### Step 1: Clean Environment

```bash
# Reset Supabase to apply latest migrations + seed data
cd docproc-platform
bunx supabase db reset

# Pull latest runtime image (or build locally)
docker pull ghcr.io/l4b4r4b4b4/oap-langgraph-tools-agent:latest

# Restart robyn-server with fresh image
docker compose down robyn-server
docker compose up -d robyn-server
```

### Step 2: Verify Sync Logs

```bash
# Wait for startup, then check logs
sleep 10
docker logs robyn-server --tail 30 2>&1 | grep -E "agent sync|Startup sync"
```

**Expected output:**

```
INFO:robyn_server.agent_sync:Startup sync summary: total=4 created=4 updated=0 skipped=0 failed=0
INFO:robyn_server.app:Robyn startup: agent sync complete total=4 created=4 updated=0 skipped=0 failed=0
```

### Step 3: Verify Database State

```bash
# Check langgraph_server.assistants — IDs should be UUIDs with dashes
docker exec -i supabase_db_immoflow-platform psql -U postgres -d postgres -c \
  "SELECT id, config->'configurable'->>'model_name' AS model FROM langgraph_server.assistants;"

# Check public.agents — langgraph_assistant_id should match
docker exec -i supabase_db_immoflow-platform psql -U postgres -d postgres -c \
  "SELECT name, langgraph_assistant_id FROM public.agents ORDER BY name;"

# Verify IDs match between the two tables
docker exec -i supabase_db_immoflow-platform psql -U postgres -d postgres -c \
  "SELECT a.name, a.langgraph_assistant_id, la.id AS stored_id,
          (a.langgraph_assistant_id = la.id) AS ids_match
   FROM public.agents a
   LEFT JOIN langgraph_server.assistants la ON la.id = a.langgraph_assistant_id
   ORDER BY a.name;"
```

**Expected:** All `ids_match = true`, no NULLs in `stored_id`.

### Step 4: Verify API Access

```bash
# Get a valid Supabase JWT (use the seeded test user)
# Then test assistant lookup
AGENT_UUID="a0000000-0000-4000-a000-000000000001"  # Dokumenten-Assistent
TOKEN="<valid-supabase-jwt>"

curl -s "http://localhost:8081/assistants/${AGENT_UUID}" \
  -H "Authorization: Bearer ${TOKEN}" | python3 -m json.tool

# Should return full assistant with config.configurable containing mcp_config
```

### Step 5: Verify Chat Integration

1. Start Next.js dev server: `bun run --filter @docproc/web dev`
2. Log in as seeded user
3. Navigate to `/dashboard/chat`
4. Select **Rechts-Assistent** (has legal-mcp assigned)
5. Send message: "Was für Tools hast du?"
6. Check runtime logs:

```bash
docker logs robyn-server --tail 30 2>&1 | grep -E "graph\(\)|mcp_config|MCP tools|model_name"
```

**Expected log lines:**

```
INFO:tools_agent.agent:graph() invoked; configurable_keys=['assistant', 'assistant_id', 'max_tokens', 'mcp_config', 'model_name', 'owner', 'run_id', 'supabase_organization_id', 'system_prompt', 'temperature', 'thread_id', 'user_id']
INFO:tools_agent.agent:graph() parsed_config; model_name=openai:gpt-4o-mini ...
INFO:tools_agent.agent:MCP tools loaded: count=1 servers=['http://legal-mcp:8000/mcp']
```

### Step 6: Verify Idempotency

```bash
# Restart robyn-server without DB reset
docker compose down robyn-server
docker compose up -d robyn-server
sleep 10
docker logs robyn-server --tail 10 2>&1 | grep "Startup sync"
```

**Expected:** `updated=0 skipped=4` or `updated=4 skipped=0` (no `created`, no `failed`).

---

## Troubleshooting

### If assistant lookup still returns 404

- Check owner metadata: `SELECT id, metadata->>'owner' FROM langgraph_server.assistants;`
- If owner is `system`, Task-02 fix is not applied
- If IDs don't have dashes, Task-01 fix is not applied

### If config is empty in graph() logs

- Check `assistant.config` in the stream route: add temporary `logger.info("assistant_config=%s", assistant.config)` in `_build_runnable_config()`
- Verify `AssistantConfig.configurable` is populated (not empty dict)
- Check if `config` column in DB is correctly parsed by `_build_model()`

### If MCP tools fail to load

- Verify MCP server is running: `docker ps | grep legal-mcp`
- Verify network connectivity: `docker exec robyn-server curl -s http://legal-mcp:8000/mcp`
- Check `auth_required` column: if `true`, token exchange must work
- Check runtime logs for `Failed to fetch MCP tools` warnings

---

## Files Changed

None expected — this is a verification task. If issues are found, document them and create follow-up tasks.

---

## Progress Log

- 2026-02-11: Task created from root cause analysis in docproc-platform Session 72