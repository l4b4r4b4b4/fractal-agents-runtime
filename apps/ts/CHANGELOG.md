# Changelog

All notable changes to the **Fractal Agents Runtime — TypeScript/Bun** will be
documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.0.2]: https://github.com/l4b4r4b4b4/fractal-agents-runtime/releases/tag/ts-v0.0.2
[0.0.1]: https://github.com/l4b4r4b4b4/fractal-agents-runtime/releases/tag/ts-v0.0.1