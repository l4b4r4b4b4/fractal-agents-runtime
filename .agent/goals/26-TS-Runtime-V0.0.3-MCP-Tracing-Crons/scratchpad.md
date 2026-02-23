# Goal 26: TS Runtime v0.0.3 — MCP Tools, Tracing, Crons & Observability

> **Status:** 🟡 In Progress
> **Priority:** High
> **Created:** 2026-02-15
> **Last Updated:** 2026-02-15
> **Depends on:** [Goal 25 — TS Runtime v0.0.2](../25-TS-Runtime-V0.0.2-Auth-Persistence-Store/scratchpad.md)

---

## Objectives

Add the **integration layer** to the TypeScript runtime: MCP tool servers, Langfuse observability, Prometheus metrics, Supabase agent sync, and scheduled runs via Crons. After this goal, the TS runtime supports dynamic tool loading from remote MCP servers, full tracing, and all operational endpoints — only the research agent graph, A2A protocol, and RAG remain for Goal 27.

1. **MCP tool integration** — Dynamic tool loading from remote MCP servers with OAuth token exchange, matching the Python runtime's `/mcp/` endpoint (1 path, 3 operations)
2. **Crons API** — Scheduled agent runs via `/runs/crons/*` endpoints (4 paths, 4 operations)
3. **Langfuse tracing** — Per-invocation trace attribution with user_id, session_id, tags
4. **Prometheus metrics** — `/metrics` endpoint in exposition format (1 path, 1 operation)
5. **Agent sync from Supabase** — Startup synchronisation of assistants from Supabase database

---

## Scope: What's in v0.0.3

### New API Endpoints (from Python OpenAPI spec)

#### MCP Protocol (1 path, 3 operations)

| Path | Method | operationId | Description |
|------|--------|-------------|-------------|
| `/mcp/` | POST | `mcpPost` | JSON-RPC 2.0 MCP protocol handler (initialize, tools/list, tools/call, resources/list) |
| `/mcp/` | GET | `mcpGet` | Method not allowed → 405 |
| `/mcp/` | DELETE | `mcpDelete` | Not found → 404 |

The POST handler is a full MCP server implementation — it receives JSON-RPC requests and dispatches them:
- `initialize` → Returns server capabilities (tools, resources)
- `tools/list` → Lists available tools (the agent itself as a callable tool)
- `tools/call` → Invokes the agent with a message, returns result
- `resources/list` → Lists available resources (empty for now)

#### Crons API (4 paths, 4 operations)

| Path | Method | operationId | Description |
|------|--------|-------------|-------------|
| `/runs/crons` | POST | `createCron` | Create scheduled run (cron expression + assistant_id + payload) |
| `/runs/crons/search` | POST | `searchCrons` | Search crons by assistant_id, thread_id, with sort/limit/offset |
| `/runs/crons/count` | POST | `countCrons` | Count matching crons → integer |
| `/runs/crons/{cron_id}` | DELETE | `deleteCron` | Delete cron by ID |

#### Metrics (1 path, 1 operation)

| Path | Method | operationId | Description |
|------|--------|-------------|-------------|
| `/metrics` | GET | `getMetrics` | Prometheus exposition format (with `format` query param: `prometheus`\|`json`\|`text`) |

#### Summary: v0.0.3 Endpoint Count

| Category | Paths | Operations | Source |
|----------|-------|------------|--------|
| System (v0.0.1) | 5 | 5 | Goal 03 |
| Assistants (v0.0.1) | 4 | 6 | Goal 03 |
| Threads (v0.0.1) | 6 | 9 | Goal 03 |
| Runs stateful (v0.0.1) | 7 | 14 | Goal 03 |
| Runs stateless (v0.0.1) | 3 | 3 | Goal 03 |
| Store (v0.0.2) | 3 | 5 | Goal 25 |
| **MCP (v0.0.3)** | **1** | **3** | **This goal** |
| **Crons (v0.0.3)** | **4** | **4** | **This goal** |
| **Metrics (v0.0.3)** | **1** | **1** | **This goal** |
| **Total after v0.0.3** | **34** | **50** | |

### OpenAPI Schema Models Added

| Schema | Used By |
|--------|---------|
| `Cron` | Response for cron endpoints (cron_id, assistant_id, thread_id, schedule, created_at, updated_at, user_id, payload, next_run_date, metadata, end_time) |
| `CronCreate` | Request body for `POST /runs/crons` (schedule, assistant_id, input, metadata, config, context, webhook, interrupt_before/after, end_time, on_run_completed) |
| `CronSearch` | Request body for `POST /runs/crons/search` (assistant_id, thread_id, limit, offset, sort_by, sort_order, select) |
| `CronCountRequest` | Request body for `POST /runs/crons/count` (assistant_id, thread_id) |

### MCP Tool Integration in Agent

Beyond the `/mcp/` server endpoint, the agent itself needs to **consume** remote MCP tool servers:

- Parse `mcp_config` from assistant configurable: `{ servers: [{ name, url, tools, auth_required }] }`
- Connect to remote MCP servers via `@modelcontextprotocol/sdk`
- Fetch tool definitions dynamically at agent construction time
- Convert MCP tools to LangChain tool format for the ReAct agent
- OAuth token exchange for `auth_required` servers (pass user's Supabase token → MCP server)
- Tool isolation: each MCP server connection is independent

### Langfuse Tracing

Port `apps/python/src/infra/tracing.py` to TypeScript:

- `initializeLangfuse()` — Singleton client from env vars (`LANGFUSE_SECRET_KEY`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_BASE_URL`)
- `isLangfuseConfigured()` / `isLangfuseEnabled()` — Status checks
- `getLangfuseCallbackHandler()` — Create per-invocation callback handler
- `injectTracing(config, { userId, sessionId, traceName, tags })` — Augment RunnableConfig with Langfuse callbacks + metadata
- `shutdownLangfuse()` — Flush and shutdown on server stop
- Disable LangSmith by default (`LANGCHAIN_TRACING_V2=false`)
- No-op when Langfuse not configured (safe to call unconditionally)

### Prometheus Metrics

Port `apps/python/src/server/routes/metrics.py` to TypeScript:

- Request counter (by method, path, status code)
- Request duration histogram
- Active runs gauge
- Agent invocation counter (by graph_id, status)
- Error counter (by type)
- `/metrics` endpoint supports `format` query param:
  - `prometheus` (default) → text exposition format
  - `json` → JSON object
  - `text` → same as prometheus

### Agent Sync from Supabase

Port `apps/python/src/server/agent_sync.py` to TypeScript:

- `AGENT_SYNC_SCOPE` env var: `none` (default), `all`, `org:<id>`
- On startup, fetch active agents from Supabase database
- Create/update assistants in local storage from Supabase agent records
- Map Supabase agent config → assistant configurable (MCP tools, RAG, model, etc.)
- `lazySyncAgent(assistantId)` — On-demand sync for individual agents
- SQL queries against Supabase's `agents` table (matching Python's SQL)
- Graceful failure (log warning, continue startup if sync fails)

---

## Architecture Changes

```
apps/ts/src/
├── ... (existing from v0.0.1 + v0.0.2)
├── infra/
│   ├── store-namespace.ts      # (existing from v0.0.2)
│   ├── tracing.ts              # NEW: Langfuse tracing (port of Python infra/tracing.py)
│   └── security/
│       └── auth.ts             # (existing from v0.0.2)
├── server/
│   ├── metrics.ts              # NEW: Prometheus metrics collector
│   └── agent-sync.ts           # NEW: Supabase agent sync (port of Python server/agent_sync.py)
├── mcp/
│   ├── handlers.ts             # NEW: MCP JSON-RPC protocol handler
│   ├── schemas.ts              # NEW: MCP request/response types
│   └── client.ts               # NEW: MCP client for connecting to remote tool servers
├── crons/
│   ├── handlers.ts             # NEW: Cron CRUD route handlers
│   ├── scheduler.ts            # NEW: Cron scheduler (setTimeout/setInterval based)
│   └── schemas.ts              # NEW: Cron request/response types
├── routes/
│   ├── ... (existing)
│   ├── mcp.ts                  # NEW: /mcp/ route
│   ├── crons.ts                # NEW: /runs/crons/* routes
│   └── metrics.ts              # NEW: /metrics route
├── models/
│   ├── ... (existing)
│   └── cron.ts                 # NEW: Cron, CronCreate, CronSearch, CronCountRequest types
├── storage/
│   ├── ... (existing)
│   ├── types.ts                # (updated) Add CronStore interface
│   ├── memory.ts               # (updated) Add in-memory CronStore
│   └── postgres.ts             # (updated) Add Postgres CronStore
└── graphs/
    └── react-agent/
        ├── agent.ts            # (updated) MCP tool loading integration
        ├── configuration.ts    # (updated) MCPConfig, MCPServerConfig types
        └── utils/
            └── mcp-tools.ts    # NEW: MCP tool fetcher + LangChain tool converter
```

---

## Dependencies (new npm packages)

```json
{
  "@modelcontextprotocol/sdk": "latest",
  "langfuse": "latest",
  "langfuse-langchain": "latest"
}
```

Note: No external cron library needed — Bun's built-in `setTimeout`/`setInterval` plus a simple scheduler is sufficient for v0.0.3. Consider `cron-parser` for cron expression parsing.

---

## Task Breakdown

### Task-01: Langfuse Tracing Integration 🟢 Complete

**Goal:** Full observability with per-invocation trace attribution, matching Python's `infra/tracing.py`.

**Deliverables:**
- `src/infra/tracing.ts`:
  - `isLangfuseConfigured()` → boolean (checks `LANGFUSE_SECRET_KEY` + `LANGFUSE_PUBLIC_KEY`)
  - `isLangfuseEnabled()` → boolean (checks if client initialised)
  - `initializeLangfuse()` → boolean (creates Langfuse singleton, reads env vars)
  - `shutdownLangfuse()` → void (flush + shutdown, no-op if not initialised)
  - `getLangfuseCallbackHandler()` → CallbackHandler | null
  - `injectTracing(config, opts)` → RunnableConfig:
    - Appends `CallbackHandler` to config's `callbacks` list
    - Injects `langfuse_user_id`, `langfuse_session_id`, `langfuse_tags` into config metadata
    - Sets `run_name` from `traceName`
    - Returns original config unchanged if Langfuse not initialised
  - `_resetTracingState()` — Test-only helper
- Set `LANGCHAIN_TRACING_V2=false` by default (disable LangSmith)
- Wire `initializeLangfuse()` into server startup
- Wire `shutdownLangfuse()` into server shutdown
- Wire `injectTracing()` into run execution paths (streams.ts, runs.ts, agent.ts)
- `src/config.ts` — Add `LANGFUSE_SECRET_KEY`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_BASE_URL` env vars
- Tests: configured/not configured, inject tracing no-op, callback handler creation

**Acceptance:**
- [x] Langfuse initialised when env vars set; no-op when not set
- [x] `injectTracing()` adds callback handler + metadata to config
- [x] `injectTracing()` returns config unchanged when Langfuse not initialised
- [x] `shutdownLangfuse()` flushes pending events
- [x] LangSmith disabled by default
- [x] All agent invocations (streaming + non-streaming) pass through tracing injection
- [ ] Traces appear in Langfuse UI with correct user_id, session_id (manual verification — deferred to E2E)

**Implementation notes:**
- Dependencies: `@langfuse/core@4.6.1`, `@langfuse/langchain@4.6.1`
- 46 new tests, 1085 total tests pass, 0 failures
- TypeScript diagnostics clean (`tsc --noEmit`)
- Bun 1.3.9 compatibility confirmed
- Uses `CallbackHandler` approach (not OpenTelemetry) — simpler, lighter
- Per-invocation fresh handler prevents state leaks between concurrent requests
- JS/TS metadata convention: `langfuseUserId`, `langfuseSessionId`, `langfuseTags` (camelCase)
- See `Task-01-Langfuse-Tracing/scratchpad.md` for full details

### Task-02: Prometheus Metrics

**Goal:** `/metrics` endpoint with request and agent invocation metrics.

**Deliverables:**
- `src/server/metrics.ts`:
  - `MetricsCollector` class:
    - `recordRequest(method, path, statusCode, durationMs)` — Increment counters + histogram
    - `recordAgentInvocation(graphId, status, durationMs)` — Agent-specific metrics
    - `recordError(errorType)` — Error counter
    - `incrementActiveRuns()` / `decrementActiveRuns()` — Gauge
    - `toPrometheus()` → string (Prometheus exposition format)
    - `toJson()` → object (JSON format)
  - In-memory metric storage (counters, histograms, gauges)
  - Prometheus text format rendering:
    - `# HELP` and `# TYPE` headers
    - `http_requests_total{method="GET",path="/health",status="200"} 42`
    - `http_request_duration_seconds_bucket{le="0.1"} 100`
    - `agent_invocations_total{graph_id="agent",status="success"} 15`
    - `active_runs 3`
  - Singleton `getMetrics()` accessor
- `src/routes/metrics.ts`:
  - `GET /metrics` — Serve metrics in requested format
  - `format` query param: `prometheus` (default), `json`, `text`
  - `Content-Type: text/plain` for prometheus/text, `application/json` for json
- Wire metrics recording into:
  - Router middleware (request counter + duration)
  - Run execution (agent invocation counter + active runs gauge)
  - Error handling (error counter)
- Tests: metric recording, prometheus format output, json format output

**Acceptance:**
- [ ] `GET /metrics` returns Prometheus exposition format by default
- [ ] `GET /metrics?format=json` returns JSON metrics
- [ ] Request counter incremented for every HTTP request
- [ ] Request duration histogram populated
- [ ] Agent invocation counter tracks graph_id and status
- [ ] Active runs gauge reflects current running count
- [ ] Error counter tracks error types
- [ ] Prometheus format parseable by Prometheus scraper
- [ ] `/metrics` itself is a public endpoint (no auth required)

### Task-03: MCP Tool Integration in Agent 🟢 Complete

**Goal:** Dynamic tool loading from remote MCP servers, with OAuth token exchange.

**Deliverables:**
- `src/graphs/react-agent/configuration.ts` — Added types:
  - `MCPServerConfig` (name, url, tools: string[] | null, auth_required: boolean)
  - `MCPConfig` (servers: MCPServerConfig[])
  - Added `mcp_config: MCPConfig | null` to `GraphConfigValues`
  - Exported `parseMcpConfig()` for testing
- `src/graphs/react-agent/utils/token.ts` — OAuth2 token exchange:
  - `getMcpAccessToken(supabaseToken, baseMcpUrl)` → `McpTokenData | null`
  - `findAuthRequiredServerUrl(servers)` → `string | null`
- `src/graphs/react-agent/utils/mcp-tools.ts` — MCP tool fetcher:
  - `fetchMcpTools(mcpConfig, supabaseToken?)` → `DynamicStructuredTool[]`
  - `normalizeServerUrl()` — auto-append `/mcp`
  - `uniqueServerKey()` — de-duplication
  - `safeMaskUrl()` — safe logging
  - Uses `@langchain/mcp-adapters` `MultiServerMCPClient`
  - Graceful degradation (MCP failure → agent runs without tools, logs warning)
- `src/graphs/react-agent/agent.ts` — Updated:
  - Extracts `x-supabase-access-token` from config dict
  - Calls `fetchMcpTools()` when `mcp_config` is set
  - Passes MCP tools to `createAgent({ model, tools, ... })`
- `src/middleware/context.ts` — Token plumbing:
  - Added `setCurrentToken()` / `getCurrentToken()` / `clearCurrentToken()`
- `src/middleware/auth.ts` — Stores raw Bearer token via `setCurrentToken()`
- `src/routes/runs.ts` — `buildRunnableConfig()` injects `x-supabase-access-token`
- Tests: 71 new tests in `tests/mcp-tools.test.ts` (1156 total, 0 failures)

**Acceptance:**
- [x] Agent loads tools from configured MCP servers at construction time
- [x] MCP tool definitions converted to LangChain tool format correctly (via `@langchain/mcp-adapters`)
- [x] `auth_required` servers receive OAuth token in connection headers
- [x] `tools` allowlist filters which tools are exposed from each server
- [x] Unreachable MCP server logs warning and agent continues without those tools
- [x] Multiple MCP servers supported simultaneously (unique key de-duplication)
- [x] Supabase access token flows from auth middleware → configurable → graph factory
- [x] Tests pass with mocked MCP server (no real server needed)
- [x] Existing test suite unaffected — all 1085 prior tests still pass
- [x] TypeScript diagnostics clean

### Task-04: MCP Server Endpoint (`/mcp/`) 🟢 Complete

**Goal:** Expose the runtime as an MCP server via JSON-RPC 2.0 protocol.

**Status:** Complete. 81 tests pass. Full suite (1380 tests) verified. Scratchpad created.

**Deliverables (DONE):**
- `src/mcp/schemas.ts` — JSON-RPC 2.0 types, parsing, serialisation helpers:
  - `JsonRpcRequest`, `JsonRpcResponse`, `JsonRpcError`, `JsonRpcErrorCode`
  - MCP types: `McpInitializeParams/Result`, `McpTool`, `McpToolCallParams/Result`, etc.
  - Helpers: `createErrorResponse()`, `createSuccessResponse()`, `serialiseResponse()`, `parseJsonRpcRequest()`
- `src/mcp/handlers.ts` — `McpMethodHandler` class with method dispatch:
  - `initialize` → server info + capabilities (tools)
  - `initialized` → notification acknowledged (202)
  - `tools/list` → dynamic `langgraph_agent` tool definition (introspects agent config)
  - `tools/call` → executes agent via `executeAgentRun()`, returns response text
  - `prompts/list`, `resources/list` → empty lists
  - `ping` → health check (empty object)
  - Error handling: `McpInvalidParamsError` → -32602, unknown method → -32601
- `src/mcp/agent.ts` — Agent execution for MCP (port of Python `server/agent.py`):
  - `executeAgentRun(message, options?)` → resolves assistant, creates/reuses thread, invokes agent, extracts response text, persists state
  - `getAgentToolInfo(assistantId?)` → introspects agent config for dynamic tool description
  - `extractResponseText(result)` — walks message list backward for last AI message
  - `buildMcpRunnableConfig()` — builds configurable for non-streaming invocation
- `src/mcp/index.ts` — barrel re-exports
- `src/routes/mcp.ts` — HTTP route handlers:
  - `POST /mcp` → JSON-RPC dispatch, 200/202/400/500
  - `GET /mcp` → 405 Method Not Allowed (Allow: POST, DELETE)
  - `DELETE /mcp` → 404 Session Not Found (stateless)
- `src/index.ts` — wired `registerMcpRoutes(router)`
- `tests/mcp-server.test.ts` — 81 tests (all pass)

**Acceptance:**
- [x] `POST /mcp/` with `initialize` method returns server capabilities
- [x] `POST /mcp/` with `tools/list` returns agent tool definition
- [x] `POST /mcp/` with `tools/call` validates params (agent execution tested via validation only — no real LLM)
- [x] `GET /mcp/` → 405
- [x] `DELETE /mcp/` → 404
- [x] JSON-RPC error format for unknown methods (-32601)
- [x] JSON-RPC parse error for invalid JSON (-32700)
- [x] JSON-RPC invalid request for malformed requests (-32600)
- [x] JSON-RPC invalid params for bad tool call args (-32602)
- [x] Notification requests (no id) return 202 (no body)
- [x] Wire format: success has `result` not `error`; error has `error` not `result`
- [x] Full handshake flow: initialize → initialized → tools/list
- [x] Agent invocation creates/reuses thread for MCP caller (code implemented)
- [x] Response shapes match Python implementation
- [ ] Full test suite run (needs verification after BUG-A fix merge)
- [ ] Task-04 scratchpad created

### Task-05: Crons API + Scheduler 🟢 Complete

**Goal:** Scheduled agent runs with cron expressions — 4 paths, 4 operations.

**Status:** Complete. 143 tests pass. Full suite (1380 tests across 22 files) verified. Scratchpad created.

**Deliverables:**
- `src/models/cron.ts`:
  - `Cron` (cron_id, assistant_id, thread_id, schedule, created_at, updated_at, user_id, payload, next_run_date, metadata, end_time)
  - `CronCreate` (schedule, assistant_id, input, metadata, config, context, webhook, interrupt_before/after, end_time, on_run_completed)
  - `CronSearch` (assistant_id, thread_id, limit, offset, sort_by, sort_order, select)
  - `CronCountRequest` (assistant_id, thread_id)
- `src/storage/types.ts` — Add `CronStore` interface (create, get, list, update, delete, count)
- `src/storage/memory.ts` — In-memory `CronStore` implementation
- `src/storage/postgres.ts` — Postgres `CronStore` implementation
- `src/crons/scheduler.ts`:
  - `CronScheduler` class:
    - `start()` — Load active crons from storage, schedule timers
    - `stop()` — Cancel all timers, cleanup
    - `scheduleCron(cron)` — Parse cron expression, calculate next run, set timer
    - `cancelCron(cronId)` — Cancel scheduled timer
    - `executeCronRun(cron)` — Create thread (or reuse), execute agent run
  - Cron expression parsing (use `cron-parser` package or simple built-in)
  - `next_run_date` calculation and storage
  - `end_time` enforcement (don't schedule past end_time)
  - `on_run_completed`: `"delete"` (remove cron after run) or `"keep"` (reschedule)
  - Error handling: failed runs logged, cron rescheduled
- `src/routes/crons.ts`:
  - `POST /runs/crons` — Create cron (validates schedule expression)
  - `POST /runs/crons/search` — Search with assistant_id, thread_id, limit/offset/sort
  - `POST /runs/crons/count` — Count matching crons → integer
  - `DELETE /runs/crons/{cron_id}` — Delete cron (also cancels scheduled timer)
- Wire scheduler into server startup/shutdown
- Tests: CRUD operations, cron expression parsing, scheduler lifecycle

**Acceptance:**
- [ ] `POST /runs/crons` creates cron with valid schedule expression
- [ ] `POST /runs/crons/search` filters and paginates correctly
- [ ] `POST /runs/crons/count` returns accurate count
- [ ] `DELETE /runs/crons/{cron_id}` removes cron and cancels scheduled timer
- [ ] Scheduler executes agent runs at scheduled times
- [ ] `end_time` prevents scheduling past expiry
- [ ] `next_run_date` calculated and stored correctly
- [ ] `on_run_completed: "delete"` removes cron after execution
- [ ] Failed cron runs logged, cron rescheduled for next occurrence
- [ ] Response shapes match Python OpenAPI spec (Cron schema)
- [ ] Scheduler starts on server startup, stops on shutdown

### Task-06: Agent Sync from Supabase + Final Integration

**Goal:** Startup agent sync + update `/info` + bump version + pipeline.

**Deliverables:**
- `src/server/agent-sync.ts`:
  - `AgentSyncScope` type: `"none"` | `"all"` | `"org:<id>"`
  - `parseAgentSyncScope(envValue)` → `AgentSyncScope`
  - `AgentSyncData` type (agent row from Supabase: id, name, description, graph_id, config, mcp_tools, org_id)
  - `fetchActiveAgents(scope, dbPool)` → `AgentSyncData[]` (SQL query against Supabase)
  - `syncSingleAgent(agentData, storage)` → create/update assistant in local storage
  - `startupAgentSync(scope, dbPool, storage)` — Fetch + sync all matching agents
  - `lazySyncAgent(assistantId, dbPool, storage)` — On-demand sync for a single agent
  - Config mapping: Supabase agent config → assistant configurable dict (MCP tools, RAG, model)
  - Graceful failure: log warning, continue startup if sync fails
- `src/config.ts` — Add `AGENT_SYNC_SCOPE` env var
- Wire `startupAgentSync()` into server startup (after storage and database init)
- Update `GET /info` response:
  - `capabilities.crons` → `true`
  - `capabilities.mcp` → `true`
  - `capabilities.metrics` → `true`
  - Report all capabilities accurately
- Update OpenAPI spec with MCP, Crons, and Metrics endpoints + schemas
- Bump `package.json` version to `0.0.3`
- CHANGELOG.md entry for v0.0.3
- Docker image update + pipeline run
- Tests: agent sync (mocked DB), scope parsing, graceful failure

**Acceptance:**
- [ ] `AGENT_SYNC_SCOPE=all` syncs all active agents from Supabase on startup
- [ ] `AGENT_SYNC_SCOPE=org:uuid` syncs only agents in specified org
- [ ] `AGENT_SYNC_SCOPE=none` skips sync (default)
- [ ] Synced agents appear as assistants in local storage
- [ ] `lazySyncAgent()` works for on-demand sync during run creation
- [ ] Sync failure logs warning but doesn't crash server
- [ ] `/info` reports all capabilities accurately (streaming, store, crons, mcp, metrics, a2a=false)
- [ ] OpenAPI spec includes all new endpoints and schemas
- [ ] `package.json` version bumped to `0.0.3`
- [ ] CHANGELOG updated
- [ ] Docker image builds and passes health check
- [ ] All existing v0.0.1 + v0.0.2 tests still pass
- [ ] Full pipeline validated

---

## Success Criteria

- [ ] **MCP tool loading works** — Agent dynamically loads tools from remote MCP servers
- [ ] **MCP server endpoint works** — `/mcp/` implements JSON-RPC 2.0 protocol correctly
- [ ] **Crons API complete** — All 4 cron operations work (4 paths, 4 operations)
- [ ] **Cron scheduler executes** — Scheduled runs fire at correct times
- [ ] **Langfuse tracing works** — Traces appear in Langfuse UI with correct attribution
- [ ] **Prometheus metrics work** — `/metrics` returns valid Prometheus exposition format
- [ ] **Agent sync works** — Startup sync populates assistants from Supabase
- [ ] **Endpoint count** — 34 paths, 50 operations total
- [ ] **Schema parity** — All new types match Python OpenAPI spec field-for-field
- [ ] **Backward compatible** — Works without Langfuse, without MCP servers, without Supabase (graceful degradation)
- [ ] **Tests pass** — All new + existing tests pass
- [ ] **Docker image** — Updated, builds, runs with new features

---

## Environment Variables Added

| Variable | Required | Description |
|----------|----------|-------------|
| `LANGFUSE_SECRET_KEY` | No | Langfuse secret key (enables tracing) |
| `LANGFUSE_PUBLIC_KEY` | No | Langfuse public key (enables tracing) |
| `LANGFUSE_BASE_URL` | No | Langfuse server URL (default: `https://cloud.langfuse.com`) |
| `LANGCHAIN_TRACING_V2` | No | Enable LangSmith tracing (default: `false`) |
| `LANGCHAIN_API_KEY` | No | LangSmith API key |
| `LANGCHAIN_PROJECT` | No | LangSmith project name |
| `AGENT_SYNC_SCOPE` | No | Startup agent sync: `none` (default), `all`, or `org:<uuid>` |

---

## Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| `@modelcontextprotocol/sdk` JS client stability | High | Verify SDK works with Bun; test connection lifecycle; fallback to raw HTTP if needed |
| MCP OAuth token exchange flow complexity | Medium | Match Python implementation exactly; test with real MCP server |
| Langfuse JS SDK + LangChain.js callback integration | Medium | Verify `langfuse-langchain` package compatibility; test with LangChain.js |
| Cron expression parsing accuracy | Low | Use established `cron-parser` package; don't roll custom parser |
| Agent sync SQL queries against Supabase | Medium | Use same SQL as Python implementation; test with real Supabase instance |
| Prometheus text format correctness | Low | Well-documented format; validate output with `promtool check metrics` |
| Timer drift in cron scheduler (Bun setTimeout) | Low | Recalculate next run from cron expression after each execution; don't rely on timer accuracy |

---

## Notes

- The MCP server endpoint (`/mcp/`) and MCP tool consumption are **two different things**:
  - `/mcp/` makes the runtime *act as* an MCP server (external clients call the agent via MCP protocol)
  - `mcp_config` in the agent makes the runtime *consume* external MCP servers (the agent calls remote tools)
  - Both are needed for full parity with Python
- Python's cron scheduler uses APScheduler. Bun doesn't have an equivalent, but `setTimeout` + cron expression parsing is sufficient. The scheduler is in-process (not distributed) — same as Python.
- Langfuse v3 reads trace-level attributes from the `metadata` dict inside `RunnableConfig` — the `injectTracing()` function sets `langfuse_user_id`, `langfuse_session_id`, `langfuse_tags` there. This convention is shared between Python and JS SDKs.
- The `/metrics` endpoint is public (no auth) — same as Python. Prometheus scraper needs unauthenticated access.
- Agent sync reads directly from Supabase's Postgres database, not from the Supabase REST API. This requires `DATABASE_URL` to point to the Supabase Postgres instance (or a shared database).
- The `select` field in `CronSearch` allows clients to request a subset of fields in the response — an optimization for list views. The Python implementation maps this to SQL column selection.