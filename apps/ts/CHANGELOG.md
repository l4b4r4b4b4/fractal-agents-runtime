# Changelog

All notable changes to the **Fractal Agents Runtime — TypeScript/Bun** will be
documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.0.3] — 2026-02-15

Third release. Adds agent sync from Supabase, Prometheus metrics, Langfuse
prompt templates, RAG tool integration, A2A protocol endpoint, research agent
graph, multi-agent checkpoint namespace isolation, and benchmark infrastructure.
Full feature parity with the Python runtime for v0.0.3 scope.

### Added

#### Agent Sync from Supabase (109 tests)
- `src/agent-sync/types.ts` — `AgentSyncMcpTool`, `AgentSyncData`, `AgentSyncScope`,
  `AgentSyncResult` types and factory functions.
- `src/agent-sync/scope.ts` — `parseAgentSyncScope()` with UUID validation for
  `none`, `all`, `org:<uuid>`, and multi-org scopes.
- `src/agent-sync/queries.ts` — SQL builders, `coerceUuid`, `toBoolOrNull`,
  `agentFromRow`, `groupAgentRows`, `fetchActiveAgents`, `fetchActiveAgentById`.
- `src/agent-sync/config-mapping.ts` — `buildAssistantConfigurable`,
  `assistantPayloadForAgent`, `extractAssistantConfigurable`, `safeMaskUrl`.
- `src/agent-sync/sync.ts` — `syncSingleAgent`, `startupAgentSync`,
  `lazySyncAgent`, `writeBackLanggraphAssistantId`.
- Startup sync runs after storage init when `AGENT_SYNC_SCOPE` is set.
- Lazy sync on assistant GET when `supabase_agent_id` is in metadata.

#### Prometheus Metrics (56 tests)
- `src/infra/metrics.ts` — Full metrics collector: counters (requests, errors),
  gauges (active streams, agent invocations/errors), duration summary
  (p50/p90/p99), storage counts callback, Prometheus exposition format, JSON format.
- `src/routes/metrics.ts` — `GET /metrics` (Prometheus), `GET /metrics/json` (JSON).
- Automatic request counting and duration recording in `Router.handle()`.

#### Langfuse Prompt Templates (77 tests)
- `src/infra/prompts.ts` — `getPrompt` (sync), `getPromptAsync`,
  `registerDefaultPrompt`, `seedDefaultPrompts`, `substituteVariablesText`,
  `substituteVariablesChat`, `extractOverrides`, variable pattern matching,
  cache TTL from `LANGFUSE_PROMPT_CACHE_TTL_SECONDS` env var.
- Supports text and chat prompt types with variable substitution.
- Graceful fallback to defaults when Langfuse is unavailable.

#### RAG Tool Integration (52 tests)
- `src/graphs/react-agent/utils/rag-tools.ts` — `sanitizeToolName`,
  `buildToolDescription`, `formatDocuments`, `parseRagConfig`, `createRagTool`,
  `createRagTools`.
- `RagConfig` type and `rag` field added to `GraphConfigValues`.
- RAG tools created before MCP tools in agent factory; integrated with
  Supabase auth token for authenticated collection access.
- XML-like `<all-documents>` formatting matching Python runtime.

#### A2A Protocol Endpoint (111 tests)
- `src/a2a/schemas.ts` — JSON-RPC 2.0 types, A2A message/task/artifact types,
  error codes, parse/validation helpers.
- `src/a2a/handlers.ts` — `A2AMethodHandler` class with `message/send`,
  `tasks/get`, `tasks/cancel` method routing.
- `src/routes/a2a.ts` — `POST /a2a/:assistantId` with JSON-RPC validation,
  SSE stub for `message/stream`.
- Injectable `A2AStorage` interface for testability.

#### Research Agent Graph (138 tests)
- `src/graphs/research-agent/configuration.ts` — `ResearchAgentConfig` with
  all fields matching Python's Pydantic model, snake_case/camelCase parsing.
- `src/graphs/research-agent/prompts.ts` — All 6 Langfuse prompt names
  identical to Python: `research-agent-analyzer-phase1/phase2`,
  `research-agent-worker-phase1/phase2`, `research-agent-aggregator-phase1/phase2`.
- `src/graphs/research-agent/worker.ts` — `extractWorkerOutput()` with lenient
  JSON extraction from ReAct agent output (code blocks, bare JSON, plain-text fallback).
- `src/graphs/research-agent/agent.ts` — Two-phase `StateGraph` with parallel
  fan-out via `Send`, HIL via `interrupt()` and `Command`, auto-approve flags,
  prompt resolution with Langfuse lookup + variable substitution + fallback.
- Registered as `graph_id = "research_agent"` in graph registry.
- Exact prompt and config parity with Python runtime.

#### Multi-Agent Checkpoint Namespace Isolation
- `checkpoint_ns = "assistant:<assistant_id>"` in both TS and Python runtimes.
- Prevents state collisions when multiple agents run in the same chat thread.
- Applied in `buildRunnableConfig()` (runs), `buildMcpRunnableConfig()` (MCP),
  and SSE metadata (`langgraph_checkpoint_ns`).
- Architecture document: `docs/MULTI_AGENT_CHECKPOINT_ARCHITECTURE.md`.

#### Benchmark Infrastructure
- `benchmarks/mock-llm/server.ts` — Mock OpenAI `/v1/chat/completions` server
  with configurable delay and streaming (Bun, ~350 lines).
- `benchmarks/k6/agent-flow.js` — Full agent lifecycle benchmark: create
  assistant → thread → run/wait → run/stream → get state → cleanup.
- Ramp-up scenario (1→5→10 VUs over 90s) with per-operation thresholds.
- Smoke test mode (`-e SMOKE=1`) for quick verification.
- `benchmarks/README.md` — Setup instructions and result interpretation guide.

### Changed

- `src/router.ts` — Request metrics (count, duration, errors) recorded
  automatically on every request.
- `src/config.ts` — Added `agentSyncScope` config field, updated capabilities
  to `metrics: true`, `a2a: true`.
- `src/index.ts` — Wired agent sync, metrics routes, A2A routes, storage
  counts callback, cron scheduler startup.
- `src/graphs/react-agent/configuration.ts` — Added `rag` field to
  `GraphConfigValues` (field count 8→9).
- `src/graphs/react-agent/agent.ts` — Supabase token extracted once and shared
  between RAG and MCP tool creation.
- `src/graphs/registry.ts` — Added `research_agent` graph registration.

### Technical Details
- **Runtime:** Bun 1.3.9
- **New Dependencies:** `@langfuse/core`, `@langfuse/langchain`, `cron-parser`, `zod`
- **Tests:** 1923 passing, 0 failures, 3648 assertions, 28 files
- **Routes:** 47 registered
- **Graphs:** 2 (`agent`, `research_agent`)

### Environment Variables Added

| Variable | Required | Description |
|----------|----------|-------------|
| `AGENT_SYNC_SCOPE` | No | Agent sync scope (`none`, `all`, `org:<uuid>`) |
| `LANGFUSE_SECRET_KEY` | No | Langfuse secret key (enables tracing) |
| `LANGFUSE_PUBLIC_KEY` | No | Langfuse public key (enables tracing) |
| `LANGFUSE_BASE_URL` | No | Langfuse server URL (default: cloud) |
| `LANGFUSE_PROMPT_CACHE_TTL_SECONDS` | No | Prompt cache TTL (default: 300) |

## [0.0.2] — 2026-02-14

Second release. Adds Supabase JWT authentication, Postgres persistence,
cross-thread Store API, multi-provider LLM support (OpenAI, Anthropic, Google,
custom endpoints), and store namespace conventions. Full feature parity with
the Python runtime for v0.0.2 scope.

### Added

#### Authentication (Task-01)
- Supabase JWT verification middleware (`src/middleware/auth.ts`).
- `AuthUser` type with `identity`, `email`, and `metadata` fields.
- Public path bypass set: `/`, `/health`, `/ok`, `/info`, `/openapi.json`, `/metrics`.
- Request-scoped user context (`getCurrentUser()`, `requireUser()`, `getUserIdentity()`).
- Graceful degradation when Supabase is not configured (no auth enforcement).
- Error responses match Python format: `{"detail": "Authorization header missing"}`.

#### Postgres Persistence (Task-02)
- `src/storage/database.ts` — Connection pool management via `postgres` (Postgres.js).
- `src/storage/postgres.ts` — `PostgresAssistantStore`, `PostgresThreadStore`,
  `PostgresRunStore`, `PostgresStoreStorage` with full CRUD + search + count.
- Idempotent DDL migrations on startup (`langgraph_server` schema).
- Schema compatible with Python runtime — both runtimes can share a single
  Postgres database deployment.
- Owner-scoped queries (`metadata->>'owner'`) for per-user isolation.
- Automatic fallback to in-memory storage when `DATABASE_URL` not set.
- Graceful connection pool shutdown on `SIGTERM`/`SIGINT`.

#### Store API (Task-03) — 5 endpoints
- `PUT /store/items` — Store/update (upsert) an item by namespace + key.
- `GET /store/items` — Retrieve an item by namespace + key (query params).
- `DELETE /store/items` — Delete an item by namespace + key (query params).
- `POST /store/items/search` — Search items within a namespace (prefix, pagination).
- `GET /store/namespaces` — List namespaces for the authenticated user.
- `StoreStorage` interface with `InMemoryStoreStorage` and `PostgresStoreStorage`.
- All operations scoped by authenticated user (`owner_id`), defaulting to
  `"anonymous"` when auth is disabled.

#### Multi-Provider LLM (Task-04)
- `src/graphs/react-agent/providers.ts` — `createChatModel()` factory with
  provider prefix parsing (`"provider:model"` convention).
- `openai:*` → `ChatOpenAI`, `anthropic:*` → `ChatAnthropic`,
  `google:*` → `ChatGoogleGenerativeAI`, `custom:` → `ChatOpenAI` with
  custom `baseURL`.
- API key routing per provider (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
  `GOOGLE_API_KEY`).
- Extended graph config: `base_url`, `custom_model_name`, `custom_api_key`.
- `x_oap_ui_config` metadata for OAP UI provider dropdown compatibility.

#### Store Namespace Conventions (Task-05)
- `src/infra/store-namespace.ts` — `buildNamespace()`, `extractNamespaceComponents()`.
- Category constants: `CATEGORY_TOKENS`, `CATEGORY_CONTEXT`, `CATEGORY_MEMORIES`,
  `CATEGORY_PREFERENCES`.
- Special pseudo-IDs: `SHARED_USER_ID`, `GLOBAL_AGENT_ID`.
- `/info` endpoint updated: `capabilities.store: true`, `tiers.tier2: true`,
  `config.database_configured` reflects `DATABASE_URL` presence.

#### OpenAPI Specification
- Store tag and 5 store operations added (3 paths).
- 4 new component schemas: `StoreItem`, `StorePutRequest`, `StoreSearchRequest`.
- `/info` response schema updated with `database_configured` field.
- Spec now covers 28 paths, 36 operations, 22 component schemas.

#### Version Management
- TypeScript runtime reads version from `package.json` (single source of truth).
- Python runtime reads version from `pyproject.toml` via `importlib.metadata`.
- Eliminates version drift between config, OpenAPI spec, and package metadata.

### Changed

- Agent factory uses `createChatModel()` instead of direct `ChatOpenAI`
  instantiation, enabling multi-provider support.
- Storage factory checks `DATABASE_URL` and creates Postgres stores when
  available, falling back to in-memory stores.

### Fixed

- Python `API_VERSION` was hardcoded to `"0.1.0"` — now reads from
  `pyproject.toml` via `importlib.metadata.version()`.
- Python `package.json` version was `"0.0.0"` — corrected to match release.

### Technical Details
- **Runtime:** Bun 1.3.8+
- **New Dependencies:** `@langchain/anthropic`, `@langchain/google-genai`,
  `@langchain/langgraph-checkpoint-postgres`, `@supabase/supabase-js`, `postgres`
- **Tests:** 1039 passing (TS), 1123 passing (Python)
- **Routes:** 36 registered (28 unique paths, 36 operations)
- **TypeScript:** Compiles clean (`tsc --noEmit`)

### Environment Variables Added

| Variable | Required | Description |
|----------|----------|-------------|
| `SUPABASE_URL` | No | Supabase project URL (enables auth) |
| `SUPABASE_KEY` | No | Supabase anon key |
| `SUPABASE_SECRET` | No | Supabase service role key |
| `SUPABASE_JWT_SECRET` | No | JWT verification secret |
| `DATABASE_URL` | No | PostgreSQL connection string (enables persistence) |
| `DATABASE_POOL_MAX_SIZE` | No | Max pool connections (default: 10) |
| `ANTHROPIC_API_KEY` | No | Anthropic API key (enables `anthropic:*` models) |
| `GOOGLE_API_KEY` | No | Google API key (enables `google:*` models) |

## [0.0.1] — 2025-07-16

First published release. LangGraph-compatible agent runtime with full API parity
for assistants, threads, stateful/stateless runs, and SSE streaming.

### Added

#### Server & Infrastructure
- Zero-dependency HTTP server on `Bun.serve()` with pattern-matching router.
- Graceful shutdown on `SIGTERM`/`SIGINT`.
- Typed environment configuration (`src/config.ts`) with sensible defaults.
- Multi-stage Docker image (`.devops/docker/ts.Dockerfile`) with non-root user
  and health check.
- CI pipeline: `bun test`, `bunx tsc --noEmit`, OpenAPI spec validation, GHCR
  image build & push.

#### System Endpoints (5 routes)
- `GET /` — Root service info.
- `GET /health` — Health check (`{ status: "ok" }`).
- `GET /ok` — Simple OK check (`{ ok: true }`).
- `GET /info` — Full service metadata (build, capabilities, graphs, config, tiers).
- `GET /openapi.json` — OpenAPI 3.1 specification document.

#### Assistants (6 routes)
- `POST /assistants` — Create assistant (with `if_exists` conflict strategy).
- `POST /assistants/search` — Search assistants (metadata, graph_id, name, pagination).
- `POST /assistants/count` — Count matching assistants.
- `GET /assistants/{assistant_id}` — Get assistant by ID.
- `PATCH /assistants/{assistant_id}` — Partial update assistant.
- `DELETE /assistants/{assistant_id}` — Delete assistant.

#### Threads (8 routes)
- `POST /threads` — Create thread (with `if_exists` conflict strategy).
- `POST /threads/search` — Search threads (metadata, status, values, pagination).
- `POST /threads/count` — Count matching threads.
- `GET /threads/{thread_id}` — Get thread by ID.
- `PATCH /threads/{thread_id}` — Partial update thread metadata.
- `DELETE /threads/{thread_id}` — Delete thread.
- `GET /threads/{thread_id}/state` — Get current thread state.
- `GET /threads/{thread_id}/history` — Get thread state history.

#### Thread Runs — Stateful (9 routes)
- `GET /threads/{thread_id}/runs` — List runs for a thread.
- `POST /threads/{thread_id}/runs` — Create run (background execution).
- `POST /threads/{thread_id}/runs/stream` — Create run and stream via SSE.
- `POST /threads/{thread_id}/runs/wait` — Create run and wait for completion.
- `GET /threads/{thread_id}/runs/{run_id}` — Get run by ID.
- `DELETE /threads/{thread_id}/runs/{run_id}` — Delete run.
- `POST /threads/{thread_id}/runs/{run_id}/cancel` — Cancel running execution.
- `GET /threads/{thread_id}/runs/{run_id}/join` — Wait for run to complete.
- `GET /threads/{thread_id}/runs/{run_id}/stream` — Reconnect to run SSE stream.

#### Stateless Runs (3 routes)
- `POST /runs` — Create stateless run (background execution).
- `POST /runs/stream` — Stateless run with SSE streaming.
- `POST /runs/wait` — Stateless run, wait for completion.

#### Agent Execution
- ReAct agent factory (`createAgent`) using `@langchain/langgraph` prebuilt
  `createReactAgent` with `ChatOpenAI`.
- Graph registry with `"agent"` graph ID registered by default.
- Run lifecycle management: `pending → running → success/error/timeout/interrupted`.
- Multitask strategies: `reject`, `enqueue`, `interrupt`, `rollback`.
- Stateless run lifecycle with `on_completion` (`delete` / `keep`).

#### SSE Streaming
- SSE formatting utilities (`src/routes/sse.ts`).
- Async generator → `ReadableStream` adapter for `Bun.serve()`.
- Wire format matching Python runtime: `event: <type>\ndata: <json>\n\n`.
- Event sequence: `metadata → values → messages → updates → values → end`.

#### Storage
- In-memory storage layer (`src/storage/memory.ts`) for assistants, threads, and runs.
- Typed storage interface (`src/storage/types.ts`) for future persistence backends.
- Singleton storage instance (`src/storage/index.ts`).

#### Models
- Full type definitions matching Python OpenAPI spec field-for-field:
  `Assistant`, `AssistantCreate`, `AssistantPatch`, `AssistantSearchRequest`,
  `AssistantCountRequest`, `Thread`, `ThreadCreate`, `ThreadPatch`,
  `ThreadSearchRequest`, `ThreadCountRequest`, `ThreadState`, `Run`,
  `RunCreateStateful`, `RunCreateStateless`, `ErrorResponse`.

#### OpenAPI Specification
- OpenAPI 3.1 spec covering all 25 paths and 31 operations.
- 18 component schemas matching Python runtime field-for-field.
- Tags: System, Assistants, Threads, Thread Runs, Stateless Runs.
- Served at runtime via `GET /openapi.json`.
- Committed as `openapi-spec.json` with CI validation.

### Technical Details
- **Runtime:** Bun 1.3.8+
- **Dependencies:** `@langchain/core`, `@langchain/langgraph`, `@langchain/openai`, `langchain`
- **Tests:** 716 passing, 0 failures, 0 TypeScript errors
- **Routes:** 31 registered (25 unique paths, 31 operations)

[0.0.3]: https://github.com/l4b4r4b4b4/fractal-agents-runtime/releases/tag/ts-v0.0.3
[0.0.2]: https://github.com/l4b4r4b4b4/fractal-agents-runtime/releases/tag/ts-v0.0.2
[0.0.1]: https://github.com/l4b4r4b4b4/fractal-agents-runtime/releases/tag/ts-v0.0.1