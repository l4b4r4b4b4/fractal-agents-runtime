# Task-06: Agent Sync from Supabase — Scratchpad

**Status:** 🟡 In Progress (Core Implementation Complete, More Features In Progress)
**Session:** 31 (HANDOFF TO SESSION 32)
**Goal:** [26 — TS Runtime v0.0.3](../scratchpad.md)

---

## Objective

Port `apps/python/src/server/agent_sync.py` (~828 lines) to TypeScript. This module bridges the Supabase `agents` table (platform agent configurations) with the LangGraph runtime's assistant storage — creating/updating assistants on startup and on-demand so that agent IDs from the platform resolve correctly when runs are created.

## Research Summary

### Python Implementation Analysis

The Python module (`apps/python/src/server/agent_sync.py`) has these components:

**Data Models:**
- `AgentSyncMcpTool` — MCP tool metadata (tool_id, tool_name, endpoint_url, is_builtin, auth_required)
- `AgentSyncData` — Agent config from Supabase (agent_id, organization_id, name, system_prompt, temperature, max_tokens, runtime_model_name, graph_id, langgraph_assistant_id, mcp_tools[])
- `AgentSyncScope` — Parsed scope: `none` | `all` | `org` with organization_ids
- `AgentSyncResult` — Outcome: assistant_id, action (created/updated/skipped), wrote_back_assistant_id

**Scope Parsing:**
- `parse_agent_sync_scope(raw)` — Parses `AGENT_SYNC_SCOPE` env var
  - `"none"` (default) → no startup sync
  - `"all"` → sync all active agents
  - `"org:<uuid>"` → single org
  - `"org:<uuid>,org:<uuid>"` → multiple orgs

**SQL Queries (against Supabase's public schema):**
- `_build_fetch_agents_sql(scope)` → SQL + params for bulk fetch
- `fetch_active_agents(connection, scope)` → list of AgentSyncData
- `fetch_active_agent_by_id(connection, agent_id)` → single AgentSyncData | null
- Queries JOIN across: `public.agents`, `public.agent_mcp_tools`, `public.mcp_tools`, `public.global_ai_engines`, `public.ai_models`
- Rows grouped by agent_id (LEFT JOIN produces N rows per agent for N MCP tools)

**Config Mapping:**
- `_build_assistant_configurable(agent)` → `config.configurable` dict
  - Maps: model_name, system_prompt, temperature, max_tokens, supabase_organization_id
  - Groups MCP tools by endpoint URL into `mcp_config.servers[]` array
- `_assistant_payload_for_agent(agent)` → full assistant create/update payload

**Sync Logic:**
- `sync_single_agent(connection, storage, agent, owner_id)` → create or update assistant
  - Creates if not exists, updates if config changed, skips if unchanged
  - Optionally writes back `langgraph_assistant_id` to Supabase
- `startup_agent_sync(connection, storage, scope, owner_id)` → bulk sync at startup
  - Returns summary: {total, created, updated, skipped, failed}
  - Each agent failure is caught individually (non-fatal)
- `lazy_sync_agent(connection, storage, agent_id, owner_id, cache_ttl)` → on-demand sync
  - Checks if assistant exists and was recently synced (TTL check via metadata.synced_at)
  - Fetches from DB and syncs if missing or stale

**Wiring (in `app.py` startup):**
- Only runs if Postgres is enabled (`DATABASE_URL` set)
- Parses `AGENT_SYNC_SCOPE` from env
- Calls `startup_agent_sync()` with `SYSTEM_OWNER_ID = "system"` as owner
- Non-fatal: logs warning and continues if sync fails

**Lazy sync call site (in `routes/assistants.py`):**
- When creating an assistant, if a `supabase_agent_id` is provided in metadata, calls `lazy_sync_agent()` to pull config from Supabase

### TS Runtime Differences

- Python uses `psycopg` with named params (`%(key)s`). TS uses `postgres` (Postgres.js) with tagged templates (`sql\`...\``) or `sql.unsafe()` with positional params.
- Python has `get_connection()` returning an async context manager. TS has `getConnection()` returning a `Sql` instance directly (connection pooling is built into Postgres.js).
- `SYSTEM_OWNER_ID = "system"` already exists in TS `src/storage/types.ts`.
- The TS `AssistantStore` interface already supports `create(data, ownerId)`, `get(id, ownerId)`, `update(id, data, ownerId)` — matching what agent sync needs.

### Python Test File Analysis

Python has `test_agent_sync_unit.py` with 174 symbols across these test classes:

- `TestAgentSyncMcpTool` (2 tests) — defaults, with values
- `TestAgentSyncData` (2 tests) — minimal, full
- `TestAgentSyncResult` (2 tests) — created, with write-back
- `TestAgentSyncScope` (4 tests) — none/all/orgs factories, dedup
- `TestParseAgentSyncScope` (12 tests) — none, default, empty, whitespace, all, case-insensitive, single org, multiple orgs, invalid entry, invalid UUID, whitespace handling, empty orgs
- `TestCoerceUuid` (5 tests) — none, UUID passthrough, valid string, invalid string, other type
- `TestToBoolOrNone` (8 tests) — none, bool true/false, int truthy/falsy, string true/false, unrecognized, other type
- `TestSafeMaskUrl` (5 tests) — none, empty, plain, strips query, strips fragment, strips both
- `TestAddMcpToolFromRow` (3 tests) — adds when present, skips all null, partial fields
- `TestAgentFromRow` (8 tests) — basic, id-instead-of-agent_id, missing raises, temperature/max_tokens, none temperature, with MCP tool, none optional strings, string values
- `TestGroupAgentRows` (6 tests) — single agent, multiple tools, multiple agents, sort order, skips missing id, empty
- `TestBuildFetchAgentsSql` (3 tests) — all scope, org scope, none scope
- `TestBuildAssistantConfigurable` (7 tests) — basic, with temp/max_tokens, without optionals, with MCP tools, multiple servers, skipped tools, server naming
- `TestAssistantPayloadForAgent` (4 tests) — basic, custom graph_id, null graph_id, null org_id
- `TestExtractAssistantConfigurable` (7 tests) — pydantic config, dict config, null config, no config attr, non-dict configurable, no configurable key, opaque config
- `TestFetchActiveAgents` (6 tests) — none scope raises, all scope returns, empty rows, non-dict rows, unconvertible rows, org scope
- `TestFetchActiveAgentById` (4 tests) — found, not found, non-dict rows, unconvertible rows
- `TestWriteBackLanggraphAssistantId` (3 tests) — success, no change, rowcount exception
- `TestSyncSingleAgent` (7 tests) — creates new, creates with write-back, creates without write-back, skips unchanged, updates changed, updates with write-back, write-back failure logged
- `TestStartupAgentSync` (4 tests) — none scope zeros, creates agents, handles failure, mixed results
- `TestLazySyncAgent` (8 tests) — not found, syncs when not cached, cached recently, expired resync, missing synced_at, unparseable synced_at, Z suffix, metadata not dict

Uses mock DB connection factory pattern (`MockCursor`, `MockConnection`, `_make_factory`) and `FakeStorage`/`FakeAssistants` for testing without real DB.

---

## Implementation Plan

### Files to Create

1. **`src/agent-sync/types.ts`** — Data types
   - `AgentSyncMcpTool` interface
   - `AgentSyncData` interface
   - `AgentSyncScopeType` type (`"none" | "all" | "org"`)
   - `AgentSyncScope` interface with factory functions (`none()`, `all()`, `orgs()`)
   - `AgentSyncResult` interface

2. **`src/agent-sync/scope.ts`** — Scope parsing
   - `parseAgentSyncScope(raw: string | undefined): AgentSyncScope`
   - UUID validation (regex or try-parse)

3. **`src/agent-sync/queries.ts`** — SQL query builders and executors
   - `buildFetchAgentsSql(scope)` → SQL string + params
   - `fetchActiveAgents(sql, scope)` → AgentSyncData[]
   - `fetchActiveAgentById(sql, agentId)` → AgentSyncData | null
   - Row parsing helpers: `agentFromRow()`, `addMcpToolFromRow()`, `groupAgentRows()`
   - `coerceUuid()`, `toBoolOrNone()` helpers

4. **`src/agent-sync/config-mapping.ts`** — Config translation
   - `buildAssistantConfigurable(agent)` → configurable dict
   - `assistantPayloadForAgent(agent)` → assistant create/update payload
   - `extractAssistantConfigurable(assistant)` → existing config dict
   - `safeMaskUrl(url)` → masked URL for logging

5. **`src/agent-sync/sync.ts`** — Core sync orchestration
   - `syncSingleAgent(sql, storage, agent, ownerId, writeBack?)` → AgentSyncResult
   - `startupAgentSync(sql, storage, scope, ownerId)` → summary counters
   - `lazySyncAgent(sql, storage, agentId, ownerId, cacheTtl?)` → assistant_id | null
   - `writeBackLanggraphAssistantId(sql, agentId, assistantId)` → boolean

6. **`src/agent-sync/index.ts`** — Barrel exports

7. **`tests/agent-sync.test.ts`** — Unit tests (matching Python's test structure)

### Files to Modify

1. **`src/config.ts`** — Add `agentSyncScope` to `AppConfig`, read from `AGENT_SYNC_SCOPE` env var
2. **`src/index.ts`** — Wire `startupAgentSync()` into server startup (after storage + database init, before `Bun.serve()`)
3. **`src/routes/assistants.ts`** — Add lazy sync call when `supabase_agent_id` is in metadata (matching Python)

### Design Decisions

1. **Module structure** — Split into 5 focused files instead of one 828-line file. Better for testing and readability. The Python module is monolithic because of Python's module conventions; TS benefits from smaller files.

2. **Postgres.js tagged templates** — Use `sql.unsafe()` for the complex JOIN queries (since they have dynamic WHERE clauses based on scope). Parameterize values safely.

3. **SYSTEM_OWNER_ID** — Already exists in TS (`src/storage/types.ts`). Agent sync creates assistants with this owner, making them visible to all authenticated users.

4. **No Pydantic** — Use plain TypeScript interfaces. Validation is done at the boundary (SQL result parsing) with runtime checks.

5. **Cache TTL for lazy sync** — Default 5 minutes (matching Python). Checked via `metadata.synced_at` ISO timestamp on the existing assistant.

6. **Non-fatal startup** — Wrap entire startup sync in try/catch. Log and continue if it fails.

### Test Strategy

Port the Python test structure (`test_agent_sync_unit.py`, 174 symbols) to Bun's test framework:

- **Scope parsing** — `parseAgentSyncScope()`: none, all, org, multiple orgs, invalid, edge cases (~12 tests)
- **Row parsing** — `agentFromRow()`, `addMcpToolFromRow()`, `groupAgentRows()`: single/multiple rows, missing fields, type coercion (~20 tests)
- **Config mapping** — `buildAssistantConfigurable()`: basic, with MCP tools, multiple servers, skipped tools (~7 tests)
- **Payload building** — `assistantPayloadForAgent()`: basic, custom graph_id, null org (~4 tests)
- **Config extraction** — `extractAssistantConfigurable()`: dict config, null config, missing configurable (~7 tests)
- **SQL building** — `buildFetchAgentsSql()`: all scope, org scope (~3 tests)
- **Utility helpers** — `coerceUuid()`, `toBoolOrNone()`, `safeMaskUrl()` (~18 tests)
- **Sync logic** — Mock storage + mock SQL: create new, update changed, skip unchanged, write-back (~7 tests)
- **Startup sync** — Multiple agents, mixed results, failure handling (~4 tests)
- **Lazy sync** — Not cached, recently synced (TTL), expired, missing metadata (~8 tests)

Estimated: ~90 tests

---

## Acceptance Criteria

- [ ] `AGENT_SYNC_SCOPE=all` syncs all active agents from Supabase on startup
- [ ] `AGENT_SYNC_SCOPE=org:uuid` syncs only agents in specified org
- [ ] `AGENT_SYNC_SCOPE=none` skips sync (default)
- [ ] Synced agents appear as assistants with `SYSTEM_OWNER_ID` owner
- [ ] Synced assistants visible to all authenticated users
- [ ] `lazySyncAgent()` works for on-demand sync during assistant creation
- [ ] Cache TTL prevents redundant DB queries (5-minute default)
- [ ] MCP tools grouped by endpoint URL into `mcp_config.servers[]`
- [ ] `langgraph_assistant_id` written back to Supabase agents table
- [ ] Sync failure logs warning but doesn't crash server
- [ ] Config changes detected and assistants updated (not duplicated)
- [ ] Unchanged configs skipped (idempotent)
- [ ] All existing tests still pass (1380+)
- [ ] New tests cover all sync paths (~90 tests)

---

## What Was Done (Session 29)

- [x] Read and analyzed full Python `agent_sync.py` (828 lines, all 4 sections)
- [x] Read Python test file `test_agent_sync_unit.py` (174 symbols, ~1415 lines)
- [x] Analyzed TS storage types, database module, config, and index.ts
- [x] Verified `SYSTEM_OWNER_ID = "system"` already exists in TS
- [x] Verified `AssistantStore` interface supports create/get/update with ownerId
- [x] Verified `getConnection()` returns Postgres.js `Sql` instance
- [x] Documented complete implementation plan with 7 files to create, 3 to modify
- [x] Documented test strategy (~90 tests matching Python test structure)

## What Was Done (Session 30)

### Agent Sync — COMPLETE (109 tests)
- [x] Created `src/agent-sync/types.ts` — AgentSyncMcpTool, AgentSyncData, AgentSyncScope, AgentSyncResult, factory functions
- [x] Created `src/agent-sync/scope.ts` — parseAgentSyncScope with UUID validation
- [x] Created `src/agent-sync/queries.ts` — SQL builders, coerceUuid, toBoolOrNull, agentFromRow, groupAgentRows, fetchActiveAgents, fetchActiveAgentById
- [x] Created `src/agent-sync/config-mapping.ts` — buildAssistantConfigurable, assistantPayloadForAgent, extractAssistantConfigurable, safeMaskUrl
- [x] Created `src/agent-sync/sync.ts` — syncSingleAgent, startupAgentSync, lazySyncAgent, writeBackLanggraphAssistantId
- [x] Created `src/agent-sync/index.ts` — barrel exports
- [x] Created `tests/agent-sync.test.ts` — 109 tests, 192 assertions, all passing
- [x] Modified `src/config.ts` — added `agentSyncScope` (reads AGENT_SYNC_SCOPE env var)
- [x] Modified `src/index.ts` — wired startupAgentSync after storage init
- [x] Modified `src/routes/assistants.ts` — wired lazySyncAgent on supabase_agent_id in metadata

### Prometheus Metrics — COMPLETE (56 tests)
- [x] Created `src/infra/metrics.ts` — Full metrics collector: counters (requests, errors), gauges (streams, agent invocations/errors), duration summary (p50/p90/p99), storage counts callback, Prometheus exposition format, JSON format, reset for testing
- [x] Created `src/routes/metrics.ts` — GET /metrics (Prometheus), GET /metrics/json (JSON)
- [x] Modified `src/router.ts` — Automatic request counting/duration/error recording in Router.handle()
- [x] Modified `src/index.ts` — Registered metrics routes, storage counts callback
- [x] Modified `src/config.ts` — Updated `metrics: true` in getCapabilities()
- [x] Updated `tests/index.test.ts` — Fixed capabilities assertion for metrics=true
- [x] Created `tests/metrics.test.ts` — 56 tests, 136 assertions, all passing

### Langfuse Prompt Templates — COMPLETE (77 tests)
- [x] Created `src/infra/prompts.ts` — getPrompt (sync), getPromptAsync, registerDefaultPrompt, seedDefaultPrompts, substituteVariablesText, substituteVariablesChat, extractOverrides, variable pattern matching, cache TTL from env
- [x] Created `tests/prompts.test.ts` — 77 tests, 88 assertions, all passing

### RAG Tool Integration — COMPLETE (52 tests)
- [x] Created `src/graphs/react-agent/utils/rag-tools.ts` — sanitizeToolName, buildToolDescription, formatDocuments, parseRagConfig, createRagTool, createRagTools
- [x] Added `RagConfig` type and `rag` field to `GraphConfigValues` interface
- [x] Updated `parseGraphConfig()` to parse `rag` config from configurable dict
- [x] Integrated RAG tools into `agent.ts` graph factory (before MCP tools)
- [x] Updated `src/graphs/react-agent/configuration.ts` — import RagConfig, parseRagConfig, add `rag` to GraphConfigValues and parseGraphConfig
- [x] Updated `src/graphs/react-agent/agent.ts` — extract supabaseToken once, create RAG tools when configured, then MCP tools
- [x] Added `zod` dependency (peer dep of `@langchain/core`, needed for DynamicStructuredTool)
- [x] Updated `tests/graphs-configuration.test.ts` — fixed field count (8→9) and key list assertions
- [x] Created `tests/rag-tools.test.ts` — 52 tests, 80 assertions, all passing

### A2A Protocol Endpoint — COMPLETE (111 tests)
- [x] Created `src/a2a/schemas.ts` — JSON-RPC 2.0 types, A2A message/task/artifact types, error codes, helper functions (createErrorResponse, createSuccessResponse, parseTaskId, createTaskId, mapRunStatusToTaskState, extractTextFromParts, extractDataFromParts, hasFileParts, parseJsonRpcRequest, parseMessageSendParams, parseTaskGetParams, parseTaskCancelParams)
- [x] Created `src/a2a/handlers.ts` — A2AMethodHandler class with message/send, tasks/get, tasks/cancel; ValueError for param errors vs internal errors; mock storage interface
- [x] Created `src/a2a/index.ts` — barrel exports for all types, constants, helpers, handler
- [x] Created `src/routes/a2a.ts` — registerA2ARoutes with POST /a2a/:assistantId, JSON-RPC validation, SSE stub for message/stream, auth via x-owner-id header
- [x] Modified `src/index.ts` — registered A2A routes with lazy storage adapter
- [x] Modified `src/config.ts` — updated `a2a: true` in getCapabilities()
- [x] Updated `tests/index.test.ts` — fixed capabilities assertion for a2a=true
- [x] Created `tests/a2a.test.ts` — 111 tests, 196 assertions, all passing

### Test Suite Status
- **1785 tests, 0 failures, 3392 assertions** across 27 test files
- Previous: 1380 (Session 28) → 1489 (Session 29 end) → 1545 (Session 30) → 1785 (Session 31)

## What Remains

### Features Not Yet Implemented
- [ ] Research Agent graph (parallel workers, HIL, synthesis)

### Benchmarking (User Requested)
- [ ] Mock LLM server (~50-line Bun app, configurable delay + streaming)
- [ ] k6 benchmark scripts (full agent flow: create assistant → thread → run → stream)
- [ ] Tier 1: Mock LLM benchmark (Python vs TS runtime overhead)
- [ ] Tier 2: Local vLLM benchmark (if GPU available)
- [ ] Tier 3: OpenAI API smoke test

### Release
- [ ] Docker build + live test
- [ ] Version bump, CHANGELOG
- [ ] Push v0.0.3

### All Changes Are Uncommitted
~100+ changed/untracked files on `feat/ts-v0.0.2-auth-persistence-store` branch.
Do NOT commit yet — finish remaining features first.

## Session 32 Handoff — Critical State

### Test Suite: 1785 tests, 0 failures, 3392 assertions, 27 files
### Branch: `feat/ts-v0.0.2-auth-persistence-store` (all uncommitted)

### Files Created/Modified in Session 31:
**New files:**
- `apps/ts/tests/prompts.test.ts` — 77 tests for Langfuse prompt templates
- `apps/ts/src/graphs/react-agent/utils/rag-tools.ts` — RAG tool factory (sanitizeToolName, buildToolDescription, formatDocuments, createRagTool, createRagTools, parseRagConfig, RagConfig type)
- `apps/ts/tests/rag-tools.test.ts` — 52 tests for RAG tools
- `apps/ts/src/a2a/schemas.ts` — JSON-RPC 2.0 + A2A types, error codes, all parse/helper functions
- `apps/ts/src/a2a/handlers.ts` — A2AMethodHandler class (message/send, tasks/get, tasks/cancel), ValueError class
- `apps/ts/src/a2a/index.ts` — barrel exports
- `apps/ts/src/routes/a2a.ts` — POST /a2a/:assistantId route handler
- `apps/ts/tests/a2a.test.ts` — 111 tests for A2A protocol

**Modified files:**
- `apps/ts/src/graphs/react-agent/configuration.ts` — added `rag: RagConfig | null` to GraphConfigValues, import+call parseRagConfig
- `apps/ts/src/graphs/react-agent/agent.ts` — integrated RAG tools + refactored supabaseToken extraction
- `apps/ts/src/index.ts` — registered A2A routes with lazy storage adapter
- `apps/ts/src/config.ts` — `a2a: true` in getCapabilities()
- `apps/ts/tests/graphs-configuration.test.ts` — field count 8→9, added "rag" to key assertions
- `apps/ts/tests/index.test.ts` — a2a capability assertion true
- `apps/ts/package.json` — added `zod` dependency

### What's Done (complete with tests):
- ✅ Agent Sync (109 tests) — Session 30
- ✅ Prometheus Metrics (56 tests) — Session 30
- ✅ Langfuse Prompt Templates (77 tests) — Session 31
- ✅ RAG Tool Integration (52 tests) — Session 31
- ✅ A2A Protocol Endpoint (111 tests) — Session 31

### What Remains:
1. **Research Agent graph** — Port from `apps/python/src/graphs/research_agent/` (parallel workers, HIL, synthesis). This is the LAST feature.
2. **Mock LLM server** — ~50-line Bun app, fake `/v1/chat/completions` with configurable delay + streaming
3. **k6 benchmark scripts** — full agent flow: create assistant → thread → run → stream
4. **Tier 1 benchmarks** — Mock LLM benchmark (Python vs TS runtime overhead)
5. **Docker build + live test**
6. **Version bump to 0.0.3, CHANGELOG, push**

### Key Architecture Decisions:
- A2A handler uses injectable `A2AStorage` interface (not direct storage import) for testability
- RAG tools use `DynamicStructuredTool` from `@langchain/core/tools` with `zod` schemas
- A2A `message/stream` returns SSE stub (not fully implemented yet)
- RAG tools created before MCP tools in agent factory; supabaseToken extracted once and shared
- A2A route uses `router.post()` (NOT `router.add()` which doesn't exist)

## What Was Done (Session 31)

### Langfuse Prompt Template Tests — COMPLETE (77 tests)
- [x] Created `tests/prompts.test.ts` with 77 tests covering:
  - `substituteVariablesText` (7 tests) — basic substitution, unknown vars, empty template/vars, repeated vars
  - `substituteVariablesChat` (5 tests) — content substitution, immutability, extra keys, empty array
  - `extractOverrides` (12 tests) — null/undefined config, empty configurable, missing keys, valid overrides
  - `registerDefaultPrompt` + `resetPromptRegistry` (7 tests) — registration, dedup, reset lifecycle
  - `getPrompt` sync (8 tests) — text/chat fallback, variables, overrides ignored, Langfuse enabled path
  - `getPromptAsync` Langfuse disabled (6 tests) — fallback behavior for all types
  - `getPromptAsync` Langfuse enabled (4 tests) — error fallback, graceful degradation
  - `seedDefaultPrompts` disabled (2 tests) + enabled (3 tests) — returns 0, handles errors
  - Cache TTL from environment (5 tests) — default, custom, zero, invalid, per-call override
  - Edge cases (6 tests) — empty strings, empty arrays, multiple roles, custom labels
  - Integration (6 tests) — register+retrieve, register+seed+retrieve, reset lifecycle

### RAG Tool Integration — COMPLETE (52 tests)
- [x] Ported Python `create_rag_tool()` from `utils/tools.py` to TypeScript
- [x] Created `src/graphs/react-agent/utils/rag-tools.ts`:
  - `RagConfig` interface (rag_url, collections)
  - `sanitizeToolName()` — regex replacement, truncation, fallback naming
  - `buildToolDescription()` — base description + optional collection description
  - `formatDocuments()` — XML-like `<all-documents>` formatting matching Python
  - `createRagTool()` — fetches collection metadata, creates DynamicStructuredTool
  - `createRagTools()` — batch creation with per-collection error handling
  - `parseRagConfig()` — validates and normalizes raw config objects
- [x] Integrated into graph configuration (`GraphConfigValues.rag`) and agent factory
- [x] Added `zod` dependency for DynamicStructuredTool schema
- [x] Tests cover: name sanitization (11), description building (5), document formatting (8), config parsing (14), error handling (3), batch creation (6), type compliance (3)

### A2A Protocol Endpoint — COMPLETE (111 tests)
- [x] Created full A2A protocol implementation:
  - `src/a2a/schemas.ts` (595 lines) — complete JSON-RPC 2.0 + A2A type system
  - `src/a2a/handlers.ts` (444 lines) — A2AMethodHandler with routing, message/send, tasks/get, tasks/cancel
  - `src/a2a/index.ts` (60 lines) — barrel exports
  - `src/routes/a2a.ts` (262 lines) — route handler with JSON-RPC validation, SSE stub
- [x] Tests cover: error codes (2), createErrorResponse (5), createSuccessResponse (5), parseTaskId (5), createTaskId (3), mapRunStatusToTaskState (7), extractTextFromParts (5), extractDataFromParts (6), hasFileParts (4), parseJsonRpcRequest (12), parseMessageSendParams (14), parseTaskGetParams (8), parseTaskCancelParams (4), ValueError (4), handler routing (4), message/send (7), tasks/get (7), tasks/cancel (2), response structure (4), integration (3)

## What Was Done (Session 33)

### Multi-Agent Checkpoint Namespace Architecture — COMPLETE
- [x] **Architecture Document** — Created `docs/MULTI_AGENT_CHECKPOINT_ARCHITECTURE.md` (~870 lines):
  - Problem statement: multi-agent checkpoint collision in shared threads
  - Two thread concepts: app-level (Supabase Realtime) vs LangGraph execution context
  - Namespace policy: `checkpoint_ns = "assistant:<assistant_id>"` (per-assistant isolation)
  - Runtime changes for both TS and Python
  - Message history strategy: LangGraph accumulation (own history) + app-injected context (cross-agent)
  - Full interaction scenario walkthroughs: single-agent, multi-agent, cross-runtime, cascading edits, branching
  - Cross-runtime checkpoint compatibility analysis (not feasible; use A2A instead)
  - App-side requirements: Supabase schema (`message_runs` table), cascading regeneration logic, frontend considerations
  - API contract: run creation, run response with checkpoint metadata, resume from checkpoint
  - ASCII diagrams: namespace isolation in Postgres, multi-agent chat flow
  - FAQ: 7 questions covering migration, useStream compatibility, sub-graphs, storage-layer gap

- [x] **TS Runtime Changes** — Per-assistant checkpoint namespace isolation:
  - `apps/ts/src/routes/runs.ts` — `buildRunnableConfig()`: added `configurable.checkpoint_ns = "assistant:${assistantId}"`
  - `apps/ts/src/mcp/agent.ts` — `buildMcpRunnableConfig()`: added same `checkpoint_ns`
  - `apps/ts/src/routes/streams.ts` — SSE metadata: `langgraph_checkpoint_ns` now uses `"assistant:${assistantId}"` instead of `""`
  - All 1785 tests pass (0 failures, 3392 assertions, 27 files)

- [x] **Python Runtime Changes** — Same namespace isolation:
  - `apps/python/src/server/routes/streams.py` — `_build_runnable_config()`: added `configurable["checkpoint_ns"] = f"assistant:{assistant_id}"`
  - `apps/python/src/server/agent.py` — `_build_mcp_runnable_config()`: added same `checkpoint_ns`
  - `apps/python/src/server/routes/streams.py` — SSE metadata: `langgraph_checkpoint_ns` fallback updated to `f"assistant:{assistant_id}"`
  - All 6 Python tests pass (1 skipped)

- [x] **Known Limitation Documented** — Storage layer (`PostgresThreadStore.getState()`, `getHistory()`) still returns `checkpoint_ns: ""` in thread state API responses. This is cosmetic — does NOT affect checkpoint isolation during graph execution. Tracked as follow-up task.

### Research Agent Graph — COMPLETE (138 tests)
- [x] **Configuration** — `src/graphs/research-agent/configuration.ts` (252 lines):
  - `ResearchAgentConfig` interface with all fields matching Python's `ResearchAgentConfig` Pydantic model
  - `parseResearchConfig()` — parses both snake_case and camelCase keys, clamps `maxWorkerIterations` (1–100)
  - Nested config types: `RagConfig`, `McpConfig`, `McpServerConfig`
  - Defaults match Python exactly: `model_name="openai:gpt-4o-mini"`, `temperature=0.0`, `max_worker_iterations=15`
- [x] **Prompts** — `src/graphs/research-agent/prompts.ts` (230 lines):
  - All 6 Langfuse prompt names match Python exactly:
    - `research-agent-analyzer-phase1`, `research-agent-analyzer-phase2`
    - `research-agent-worker-phase1`, `research-agent-worker-phase2`
    - `research-agent-aggregator-phase1`, `research-agent-aggregator-phase2`
  - Default prompt text is identical to Python's `prompts.py`
  - All prompts registered at import time via `registerDefaultPrompt()` for Langfuse seeding
- [x] **Worker** — `src/graphs/research-agent/worker.ts` (364 lines):
  - `extractWorkerOutput()` — lenient JSON extraction from ReAct agent output (code blocks, bare JSON, plain-text fallback)
  - Handles multimodal content, `{ results: [...] }` wrappers, single result objects
  - `_internals` exported for testing: `getMessageContent`, `isAiMessage`, `safeFloat`, `normaliseResultList`, etc.
- [x] **Graph** — `src/graphs/research-agent/agent.ts` (1086 lines):
  - `graph()` factory — main entry point registered under `graph_id = "research_agent"`
  - `buildResearchGraph()` — constructs two-phase `StateGraph` with `Annotation.Root` state schema
  - State uses `workerResults` with concatenation reducer for parallel fan-out accumulation
  - Nodes: `analyzer_phase1`, `worker_phase1`, `aggregator_phase1`, `review_phase1`, `set_phase2`, `analyzer_phase2`, `worker_phase2`, `aggregator_phase2`, `review_phase2`
  - Parallel fan-out via `Send` in `assignPhase1Workers` / `assignPhase2Workers`
  - HIL via `interrupt()` and `Command({ goto, update })` in review nodes
  - `auto_approve_phase1` / `auto_approve_phase2` bypass interrupts (for testing/CI)
  - Prompt resolution via `resolvePrompt()` with Langfuse lookup + variable substitution + fallback
  - JSON parsing helpers: `parseAnalyzerResponse`, `parseAggregatorResponse`, `extractContent`, `tryParseJson`, `normaliseTasks`
  - Tool loading: reuses react-agent's `createChatModel`, `fetchMcpTools`, `createRagTools`
- [x] **Index** — `src/graphs/research-agent/index.ts` (37 lines): barrel exports
- [x] **Registry** — `src/graphs/registry.ts`: added `registerGraphLazy("research_agent", "./research-agent/index", "graph")`
- [x] **Tests** — `tests/research-agent.test.ts` (1212 lines, 138 tests):
  - Configuration: 42 tests (defaults, snake/camelCase, clamping, MCP/RAG parsing, full round-trip)
  - Constants: 3 tests
  - Prompts: 10 tests (names match Python, template variables, content checks)
  - Worker extractWorkerOutput: 14 tests (JSON array, code block, results wrapper, fallback, multimodal, normalisation)
  - Worker internals: 25 tests (getMessageContent, isAiMessage, safeFloat, normaliseResultList)
  - Graph extractContent: 4 tests
  - Graph tryParseJson: 6 tests
  - Graph normaliseTasks: 7 tests
  - Graph parseAnalyzerResponse: 6 tests
  - Graph parseAggregatorResponse: 5 tests
  - Registry integration: 6 tests
  - Index exports: 5 tests
  - Python parity: 5 tests (graph_id, prompt names, config keys, defaults)
- [x] Updated `tests/graphs-registry.test.ts` — 4 assertions updated to include `"research_agent"` in expected graph ID lists

### Test Suite Status (Session 33)
- **1923 tests, 0 failures, 3648 assertions, 28 files** (up from 1785/3392/27)

### What Remains
- [ ] Mock LLM server (~50-line Bun app, configurable delay + streaming)
- [ ] k6 benchmark scripts (full agent flow: create assistant → thread → run → stream)
- [ ] Tier 1: Mock LLM benchmark (Python vs TS runtime overhead)
- [ ] Docker build + live test
- [ ] Version bump to 0.0.3, CHANGELOG, push