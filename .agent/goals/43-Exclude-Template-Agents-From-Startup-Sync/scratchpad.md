# Goal 43: Remove Automatic Startup Agent Sync

> **Status**: 🟢 Complete
> **Priority**: P1 (High)
> **Created**: 2026-03-03
> **Updated**: 2026-03-03

## Overview

Remove the automatic startup agent sync from the runtime. The `startup_agent_sync()` function runs at boot and pre-loads agents from the Supabase `agents` table into LangGraph runtime assistant storage. This is a **multi-tenancy anti-pattern** — the runtime should not decide at boot time which agents exist for which tenants. Agent instantiation is the platform's responsibility, triggered on-demand when users access agents.

## Why This Is An Anti-Pattern

1. **Violates tenant isolation** — the runtime has no business deciding at boot time which agents exist for which tenants. That's the platform's job.
2. **Conflates templates with instances** — agent rows in the DB are blueprints/templates. They should never automatically become singleton runtime instances shared across all users.
3. **Doesn't scale** — 1000 orgs × 10 agents = 10,000 agents loaded at boot for zero benefit. Lazy sync handles actual demand naturally.
4. **Creates the wrong mental model** — startup sync made us think agents were "working" when they were actually shared singletons, hiding the real architecture problem (e.g., the personal assistant appeared functional but was a global singleton, not per-user).
5. **Dead code in production** — if `AGENT_SYNC_SCOPE` should always be `"none"` in production multi-tenant mode, maintaining the `"all"` and `"org:..."` codepaths is pure liability.

## Correct Architecture

```
Platform (Next.js)                          Runtime (Robyn)
───────────────────                         ────────────────
User opens chat
  → getOrCreateAssistantSession()
    → syncAgentToLangGraph(agentId)
      → PATCH /assistants/{id}              → lazy_sync_agent()
                                              → fetch_active_agent_by_id()
                                              → sync_single_agent()
                                              → assistant created/updated

User views agent list
  → auto-sync triggers for visible agents
    → syncAgentToLangGraph() per agent      → same lazy path

User checks "are my agents live?"
  → platform queries runtime API            → query assistant storage
    → shows status per agent                → return what's instantiated
    → offers "sync now" button              → sync_single_agent() on demand
```

The runtime provides **building blocks**. The platform decides **when and what** to sync.

## Success Criteria

- [x] `startup_agent_sync()` function removed
- [x] `AGENT_SYNC_SCOPE` env var handling removed from `app.py`
- [x] Runtime boots with zero agents in assistant storage (clean slate)
- [x] Lazy sync (`lazy_sync_agent`) still works — agents created on first access
- [x] `sync_single_agent()` still works — platform can sync individual agents on demand
- [x] `fetch_active_agents(scope)` retained — platform/admin can query "what agents should exist for org X?"
- [x] `fetch_active_agent_by_id()` retained — single agent lookup for on-demand sync
- [x] All data models (`AgentSyncData`, `AgentSyncMcpTool`, `AgentSyncScope`) retained
- [x] Existing tests updated (remove startup sync tests, keep building block tests)
- [x] `is_global` field added to `AgentSyncData` for downstream visibility
- [x] Linting passes (`ruff check . --fix --unsafe-fixes && ruff format .`)
- [x] Tests pass at ≥73% coverage — **77.22% total, 124 agent_sync tests, 1780 total tests**

## What To Remove

| Symbol | File | Reason |
|--------|------|--------|
| `startup_agent_sync()` | `agent_sync.py` | The automatic boot orchestrator — the anti-pattern itself |
| Startup sync call | `app.py` | The wiring that invokes it at boot |
| `AGENT_SYNC_SCOPE` env var parsing in startup | `app.py` | No longer triggered automatically |
| Startup sync log lines | `app.py` | References to removed function |

## What To Keep

| Symbol | File | Purpose |
|--------|------|---------|
| `fetch_active_agents(scope)` | `agent_sync.py` | Batch query: "what agents SHOULD exist for org X?" — useful for admin/status API |
| `fetch_active_agent_by_id()` | `agent_sync.py` | Single agent lookup for on-demand sync |
| `sync_single_agent()` | `agent_sync.py` | Create/update one runtime assistant — the core sync primitive |
| `lazy_sync_agent()` | `agent_sync.py` | On-demand sync with TTL cache — the correct pattern |
| `AgentSyncScope` | `agent_sync.py` | Filtering by org — still useful for API queries |
| `parse_agent_sync_scope()` | `agent_sync.py` | Parsing scope strings — still useful for API parameters |
| `AgentSyncData`, `AgentSyncMcpTool` | `agent_sync.py` | Data models — used by all sync functions |
| `_build_fetch_agents_sql()` | `agent_sync.py` | SQL builder — used by `fetch_active_agents()` |
| `_build_assistant_configurable()` | `agent_sync.py` | Config builder — used by `sync_single_agent()` |
| `_assistant_payload_for_agent()` | `agent_sync.py` | Payload builder — used by `sync_single_agent()` |
| `_write_back_langgraph_assistant_id()` | `agent_sync.py` | Write-back — used by `sync_single_agent()` |
| All helper/parsing functions | `agent_sync.py` | `_coerce_uuid`, `_to_bool_or_none`, `_add_mcp_tool_from_row`, `_agent_from_row`, `_group_agent_rows` |

## What To Add

| Change | File | Purpose |
|--------|------|---------|
| `is_global` field on `AgentSyncData` | `agent_sync.py` | Downstream code can distinguish global vs per-user agents |
| `AND a.is_global = true` in `_build_fetch_agents_sql()` | `agent_sync.py` | Defense-in-depth: batch queries only return global agents (per-user agents are fetched by ID) |
| `a.is_global` in SELECT list of both queries | `agent_sync.py` | Populate the new field |

## Tasks

| Task ID | Description | Status | Depends On |
|---------|-------------|--------|------------|
| Task-01 | Remove `startup_agent_sync()` and its call in `app.py` | 🟢 | - |
| Task-02 | Add `is_global` field to `AgentSyncData` + SQL queries | 🟢 | - |
| Task-03 | Update tests — remove startup sync tests, verify building blocks still pass | 🟢 | Task-01, Task-02 |
| Task-04 | Platform-side: remove `AGENT_SYNC_SCOPE` from docker-compose env, set personal assistant `is_global = false` | ⚪ | Task-01 |

## Results

- **Files changed**: `agent_sync.py` (removed function, added `is_global` field/filter/SELECT), `app.py` (removed startup sync block + imports), `test_agent_sync_unit.py` (removed 4 tests, added 3 tests)
- **Net code delta**: ~-80 lines (removed startup orchestrator + tests, added `is_global` support + comments)
- **Test results**: 124 agent_sync tests pass, 1780 total tests pass, 77.22% coverage
- **Linting**: Clean (`ruff check` + `ruff format`)
- **Platform Task-04**: Deferred — requires changes in docproc-platform repo (remove `AGENT_SYNC_SCOPE=all` from docker-compose, set personal assistant `is_global = false`)

## Key Files

- `apps/python/src/server/agent_sync.py` — main module (remove `startup_agent_sync`, keep everything else)
- `apps/python/src/server/app.py` — startup wiring (remove sync call + env var handling)
- `apps/python/tests/` — update test suite
- Platform: `docker-compose.yml` → remove `AGENT_SYNC_SCOPE=all` from robyn-runtime env
- Platform: `supabase/seed-data/global/agents.sql` → set Persönlicher Assistent `is_global = false`

## Dependencies

- **Upstream**: Goal 15 (Startup Agent Sync) — the code being removed was built in Goal 15
- **Downstream**: docproc-platform Goal 77 (Agent Tool Binding & RAG) — per-user assistant creation at signup

## Notes & Decisions

### Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-03-03 | Remove automatic startup sync entirely | Multi-tenancy anti-pattern — runtime should not decide what to load at boot |
| 2026-03-03 | Keep building blocks (fetch, sync_single, lazy_sync) | Platform and users still need on-demand sync and status checking |
| 2026-03-03 | Keep `AgentSyncScope` and `parse_agent_sync_scope` | Still useful for API-driven batch queries (admin "sync all for org X") |
| 2026-03-03 | Add `is_global` filter to `_build_fetch_agents_sql` | Defense-in-depth: batch queries should only return org-level agents, not per-user templates |
| 2026-03-03 | Add `is_global` field to `AgentSyncData` | Downstream code needs to know if an agent is global (shared) or per-user (template) |

## References

- Runtime Goal 15: Startup Agent Sync — `.agent/goals/15-Startup-Agent-Sync/scratchpad.md`
- Platform Goal 77: Agent Tool Binding & RAG — `docproc-platform/.agents/goals/77-Agent-Tool-Binding-And-RAG/scratchpad.md`
- `apps/python/src/server/agent_sync.py` — full module
- `apps/python/src/server/app.py` — startup wiring