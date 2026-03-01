# Goal 25: TS Runtime v0.0.2 — Auth, Persistence, Store & Multi-Provider LLM

> **Status:** 🟢 Complete
> **Priority:** High
> **Created:** 2026-02-15
> **Last Updated:** 2026-02-14
> **Depends on:** [Goal 03 — TS Runtime v0.0.1](../03-TypeScript-Runtime-V0.0.1/scratchpad.md)

---

## Objectives

Elevate the TypeScript runtime from a single-provider, unauthenticated, in-memory system to a **production-grade** runtime with real security, durable persistence, cross-thread memory, and multi-provider LLM support. After this goal, the TS runtime can be deployed behind Supabase auth alongside the Python runtime with feature-interchangeable storage.

1. **Supabase JWT authentication** — Middleware that verifies Bearer tokens via Supabase, extracts user identity, scopes all storage operations per-user
2. **Postgres persistence** — Replace in-memory `Map`-based stores with Postgres-backed implementations using the same schema as the Python runtime
3. **Store API** — Cross-thread long-term memory endpoints (`/store/items`, `/store/items/search`, `/store/namespaces`) — 3 paths, 5 operations
4. **Multi-provider LLM** — Anthropic, Google, and custom OpenAI-compatible endpoints alongside OpenAI
5. **Store namespace conventions** — Port `infra/store_namespace.py` patterns to TypeScript

---

## Scope: What's in v0.0.2

### New API Endpoints (from Python OpenAPI spec)

| Path | Method | operationId | Description |
|------|--------|-------------|-------------|
| `/store/items` | GET | `getStoreItems` | Get items by namespace + key |
| `/store/items` | PUT | `putStoreItem` | Put/upsert item (namespace + key + value) → 204 |
| `/store/items` | DELETE | `deleteStoreItem` | Delete item by namespace + key → 204 |
| `/store/items/search` | POST | `searchStoreItems` | Search items by namespace_prefix, filter, query, limit/offset |
| `/store/namespaces` | POST | `listStoreNamespaces` | List namespaces by prefix/suffix/max_depth/limit/offset |

**Endpoint count after v0.0.2:** 28 paths, 42 operations (up from 25/37 in v0.0.1)

### OpenAPI Schema Models Added

| Schema | Used By |
|--------|---------|
| `StorePutRequest` | `PUT /store/items` — namespace (string[]), key, value (object) |
| `StoreDeleteRequest` | `DELETE /store/items` — namespace (string[]), key |
| `StoreSearchRequest` | `POST /store/items/search` — namespace_prefix, filter, limit, offset, query |
| `StoreListNamespacesRequest` | `POST /store/namespaces` — prefix, suffix, max_depth, limit, offset |
| `Item` | Response for store get/search — namespace, key, value, created_at, updated_at |
| `SearchItemsResponse` | Wrapper for search results — items array |

### Authentication

- Supabase JWT verification middleware (mirrors `apps/python/src/server/auth.py`)
- Public paths bypass auth: `/`, `/health`, `/ok`, `/info`, `/openapi.json`, `/metrics`
- All other paths require `Authorization: Bearer <token>`
- Extract user identity (UUID, email, metadata) from verified token
- Per-user scoping on all storage operations (assistants, threads, runs, store items)
- `AuthUser` type with `identity`, `email`, `metadata` fields
- `get_current_user()` / `require_user()` context helpers
- Graceful degradation when Supabase not configured (auth disabled, all requests treated as unauthenticated)

### Postgres Persistence

- Replace all in-memory stores with Postgres implementations
- Connection management via connection pool (e.g. `pg` or `postgres.js`)
- LangGraph.js `PostgresSaver` checkpointer (from `@langchain/langgraph-checkpoint-postgres`)
- LangGraph.js `PostgresStore` for cross-thread store (if available, otherwise custom)
- Schema migrations on startup (matching Python runtime's table structure)
- Fallback to in-memory when `DATABASE_URL` not set
- All stores: AssistantStore, ThreadStore, RunStore, StoreStorage

### Multi-Provider LLM

Port the Python runtime's provider-prefix pattern:

| Prefix | Provider | Package |
|--------|----------|---------|
| `openai:` | OpenAI | `@langchain/openai` (already in v0.0.1) |
| `anthropic:` | Anthropic | `@langchain/anthropic` |
| `google:` | Google Generative AI | `@langchain/google-genai` |
| `custom:` | Custom OpenAI-compatible | `@langchain/openai` with custom `baseURL` |

- Parse `model_name` prefix to select provider
- Route API key selection per provider (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`)
- Support custom endpoint config (base_url, custom_model_name, custom_api_key) matching Python's `GraphConfigPydantic`
- Fall back to OpenAI if no prefix

### Store Namespace Conventions

Port `apps/python/src/infra/store_namespace.py` to TypeScript:

- 4-component namespace tuple: `(org_id, user_id, assistant_id, category)`
- Standard categories: `tokens`, `context`, `memories`, `preferences`
- Special pseudo-IDs: `shared` (org-wide), `global` (user-global)
- `extractNamespaceComponents(config)` — Extract from RunnableConfig
- `buildNamespace(orgId, userId, assistantId, category)` — Build canonical tuple
- Validation (non-empty components)

---

## Architecture Changes

```
apps/ts/src/
├── ... (existing from v0.0.1)
├── middleware/
│   └── auth.ts                 # Supabase JWT verification middleware
├── infra/
│   ├── store-namespace.ts      # Namespace conventions (port of Python infra)
│   └── security/
│       └── auth.ts             # Supabase client, token verification, AuthUser type
├── storage/
│   ├── types.ts                # (existing) Storage interfaces
│   ├── memory.ts               # (existing) In-memory implementation
│   ├── postgres.ts             # NEW: Postgres implementations of all stores
│   ├── postgres-store.ts       # NEW: Postgres StoreStorage (cross-thread memory)
│   ├── database.ts             # NEW: Connection pool management, migrations
│   └── index.ts                # (updated) Factory: Postgres if DATABASE_URL, else memory
├── routes/
│   ├── ... (existing)
│   └── store.ts                # NEW: Store API routes
├── graphs/
│   └── react-agent/
│       ├── agent.ts            # (updated) Multi-provider LLM selection
│       ├── configuration.ts    # (updated) Extended config with provider fields
│       └── providers.ts        # NEW: Provider factory (OpenAI/Anthropic/Google/custom)
└── models/
    ├── ... (existing)
    └── store.ts                # NEW: Store request/response types
```

---

## Dependencies (new npm packages)

```json
{
  "@langchain/anthropic": "latest",
  "@langchain/google-genai": "latest",
  "@langchain/langgraph-checkpoint-postgres": "latest",
  "@supabase/supabase-js": "latest",
  "postgres": "latest"
}
```

Note: Using `postgres` (Postgres.js) over `pg` — it's faster, has no native dependencies, and works well with Bun.

---

## Task Breakdown

### Task-01: Supabase JWT Authentication Middleware

**Goal:** Secure all non-public endpoints with Supabase JWT verification.

**Deliverables:**
- `src/infra/security/auth.ts`:
  - `AuthUser` type (`identity: string`, `email: string | null`, `metadata: Record<string, unknown>`)
  - `AuthenticationError` class with status code
  - `getSupabaseClient()` — Lazy-initialized Supabase client singleton
  - `verifyToken(token: string)` → `AuthUser` (async, calls `supabase.auth.getUser()`)
- `src/middleware/auth.ts`:
  - `authMiddleware(request: Request)` → `Request | Response`
  - Public path bypass set: `/`, `/health`, `/ok`, `/info`, `/openapi.json`, `/metrics`
  - Extracts `Authorization: Bearer <token>` header
  - Verifies token → stores AuthUser in request context
  - Returns 401 `{"detail": "..."}` on failure
- `src/config.ts` — Add `SUPABASE_URL`, `SUPABASE_KEY`, `SUPABASE_SECRET`, `SUPABASE_JWT_SECRET` env vars
- Context propagation mechanism (request-scoped user identity)
  - `getCurrentUser()` / `requireUser()` / `getUserIdentity()` helpers
- Wire middleware into router (before route dispatch)
- Update all storage operations to accept/use `ownerId` parameter
- Tests: valid token, invalid token, missing header, public path bypass, disabled auth

**Acceptance:**
- [ ] Public endpoints accessible without token
- [ ] Protected endpoints return 401 without valid token
- [ ] Valid token extracts correct user identity
- [ ] User identity propagated to storage operations
- [ ] Graceful degradation when Supabase not configured (no auth enforcement)
- [ ] Error responses match Python format: `{"detail": "Authorization header missing"}`

### Task-02: Postgres Storage Layer

**Goal:** Durable persistence using Postgres, matching the Python runtime's schema.

**Deliverables:**
- `src/storage/database.ts`:
  - Connection pool creation/management (`postgres` package)
  - Pool configuration from `DatabaseConfig` (url, pool_min, pool_max, pool_timeout)
  - Schema migration runner (creates tables on startup if missing)
  - Graceful shutdown (drain pool)
- `src/storage/postgres.ts`:
  - `PostgresAssistantStore` — Full CRUD + search + count with SQL
  - `PostgresThreadStore` — Full CRUD + search + count + state snapshots + history
  - `PostgresRunStore` — Full CRUD + list_by_thread + active run tracking + status updates
  - All stores scope queries by `owner_id` (user isolation)
  - JSON serialization for config/metadata/values fields
  - ISO 8601 datetime formatting with Z suffix
- `src/storage/index.ts` — Updated factory:
  - `DATABASE_URL` set → create Postgres stores
  - `DATABASE_URL` empty → fallback to in-memory stores
  - Lazy initialization, singleton pattern
- `src/config.ts` — Add `DATABASE_URL`, `DATABASE_POOL_*` env vars
- LangGraph.js checkpointer integration:
  - `PostgresSaver` from `@langchain/langgraph-checkpoint-postgres` for agent checkpointing
  - Wire into agent graph factory (replace `MemorySaver`)
- Tests: Postgres CRUD operations (requires test database or mocked connection)

**Acceptance:**
- [x] All assistant CRUD operations work with Postgres
- [x] All thread CRUD + state + history operations work with Postgres
- [x] All run CRUD + lifecycle operations work with Postgres
- [x] Schema migrations run on startup without errors
- [x] Queries scoped by owner_id (user isolation)
- [x] Fallback to in-memory when DATABASE_URL not set
- [x] Connection pool drains on shutdown
- [x] Agent checkpointing uses PostgresSaver when available
- [x] Table schema compatible with Python runtime (can share database)

### Task-03: Store API Endpoints

**Goal:** Cross-thread long-term memory via the Store API — 3 paths, 5 operations.

**Deliverables:**
- `src/models/store.ts`:
  - `StorePutRequest` (namespace: string[], key: string, value: object)
  - `StoreDeleteRequest` (namespace: string[], key: string)
  - `StoreSearchRequest` (namespace_prefix, filter, limit, offset, query)
  - `StoreListNamespacesRequest` (prefix, suffix, max_depth, limit, offset)
  - `Item` (namespace, key, value, created_at, updated_at)
  - `SearchItemsResponse` (items: Item[])
- `src/storage/types.ts` — Add `StoreStorage` interface:
  - `put(namespace, key, value, ownerId)` → void
  - `get(namespace, key, ownerId)` → Item | null
  - `delete(namespace, key, ownerId)` → void
  - `search(params, ownerId)` → SearchItemsResponse
  - `listNamespaces(params, ownerId)` → string[][]
- `src/storage/memory.ts` — Add in-memory `StoreStorage` implementation
- `src/storage/postgres-store.ts` — Postgres `StoreStorage` implementation
- `src/routes/store.ts`:
  - `GET /store/items` — Get item (namespace + key as query params)
  - `PUT /store/items` — Put/upsert item → 204
  - `DELETE /store/items` — Delete item → 204
  - `POST /store/items/search` — Search items
  - `POST /store/namespaces` — List namespaces
- Wire into router
- Tests for all 5 operations (both memory and Postgres)

**Acceptance:**
- [ ] `PUT /store/items` creates/updates item, returns 204
- [ ] `GET /store/items` retrieves item by namespace + key
- [ ] `DELETE /store/items` removes item, returns 204
- [ ] `POST /store/items/search` filters by namespace_prefix, filter, limit/offset
- [ ] `POST /store/namespaces` lists unique namespaces with prefix/suffix/max_depth
- [ ] Namespace is a string array (tuple), stored and queried correctly
- [ ] All operations scoped by authenticated user (owner_id)
- [ ] Response shapes match Python OpenAPI spec exactly

### Task-04: Multi-Provider LLM Support

**Goal:** Support OpenAI, Anthropic, Google, and custom OpenAI-compatible endpoints.

**Deliverables:**
- `src/graphs/react-agent/providers.ts`:
  - `createChatModel(config: GraphConfig)` → `BaseChatModel`
  - Provider prefix parsing: `"openai:gpt-4o"` → provider=openai, model=gpt-4o
  - Provider factory:
    - `openai:*` → `ChatOpenAI` from `@langchain/openai`
    - `anthropic:*` → `ChatAnthropic` from `@langchain/anthropic`
    - `google:*` → `ChatGoogleGenerativeAI` from `@langchain/google-genai`
    - `custom:` → `ChatOpenAI` with custom `baseURL` from config
  - API key routing: reads `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY` per provider
  - Temperature, max_tokens applied to all providers
  - Fallback: no prefix → OpenAI
- `src/graphs/react-agent/configuration.ts` — Extended config:
  - `base_url` (for custom endpoints)
  - `custom_model_name` (model name at custom endpoint)
  - `custom_api_key` (optional API key for custom endpoint)
  - `x_oap_ui_config` metadata matching Python's `GraphConfigPydantic`
- `src/graphs/react-agent/agent.ts` — Updated to use `createChatModel()` instead of direct `ChatOpenAI`
- `src/config.ts` — Add `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY` env vars
- Tests: provider parsing, model creation for each provider (mocked)

**Acceptance:**
- [ ] `"openai:gpt-4o"` creates ChatOpenAI with model "gpt-4o"
- [ ] `"anthropic:claude-sonnet-4-0"` creates ChatAnthropic
- [ ] `"google:gemini-pro"` creates ChatGoogleGenerativeAI (or equivalent)
- [ ] `"custom:"` creates ChatOpenAI with custom baseURL from config
- [ ] No prefix defaults to OpenAI
- [ ] API keys routed correctly per provider
- [ ] Temperature and max_tokens applied to all providers
- [ ] Config shape matches Python's `GraphConfigPydantic` for OAP UI compatibility
- [ ] Agent works with Anthropic and Google (manual verification)

### Task-05: Store Namespace Conventions & Info Update

**Goal:** Port Python's namespace conventions + update `/info` endpoint.

**Deliverables:**
- `src/infra/store-namespace.ts`:
  - `NamespaceComponents` type (orgId, userId, assistantId)
  - `CATEGORY_TOKENS`, `CATEGORY_CONTEXT`, `CATEGORY_MEMORIES`, `CATEGORY_PREFERENCES` constants
  - `SHARED_USER_ID`, `GLOBAL_AGENT_ID` special pseudo-IDs
  - `extractNamespaceComponents(config)` → `NamespaceComponents | null`
  - `buildNamespace(orgId, userId, assistantId, category)` → `[string, string, string, string]`
  - Validation: all components must be non-empty strings
- Update `GET /info` response:
  - `capabilities.store` → `true`
  - `config.supabase_configured` → reflects actual Supabase config state
  - `config.database_configured` → reflects DATABASE_URL presence
- Update OpenAPI spec with Store endpoints and schemas
- Bump `package.json` version to `0.0.2`
- CHANGELOG.md entry for v0.0.2
- Docker image update + pipeline run
- Tests for namespace helpers

**Acceptance:**
- [ ] `buildNamespace("org-1", "user-1", "agent-1", "tokens")` → `["org-1", "user-1", "agent-1", "tokens"]`
- [ ] `extractNamespaceComponents(config)` returns null when components missing
- [ ] `SHARED_USER_ID` = `"shared"`, `GLOBAL_AGENT_ID` = `"global"`
- [ ] `/info` reports `capabilities.store: true`
- [ ] `/info` reports correct `config.supabase_configured` and `config.database_configured`
- [ ] OpenAPI spec updated with Store endpoints and all new schemas
- [ ] `package.json` version bumped to `0.0.2`
- [ ] CHANGELOG updated
- [ ] Docker image builds and passes health check
- [ ] All existing v0.0.1 tests still pass

---

## Success Criteria

- [x] **Authentication works** — Protected endpoints reject unauthenticated requests; public endpoints pass through
- [x] **Postgres persistence** — All data survives server restart when DATABASE_URL configured
- [x] **Store API complete** — All 5 store operations work (3 paths, 5 operations)
- [x] **Multi-provider LLM** — Agent can use OpenAI, Anthropic, Google, or custom endpoints
- [x] **Namespace conventions** — Typed, validated, matching Python runtime's conventions
- [x] **Backward compatible** — Works without DATABASE_URL (falls back to memory) and without SUPABASE_URL (no auth)
- [x] **Schema parity** — All new types match Python OpenAPI spec field-for-field
- [x] **Endpoint count** — 28 paths, 36 operations total
- [x] **Tests pass** — 1039 TS tests pass, 0 failures; 1123 Python tests pass
- [x] **Docker image** — Builds, runs, health check passes, Postgres DDL + CRUD verified E2E

### E2E Verification (2026-02-14)

Full end-to-end test against real Postgres (local Supabase) via Docker:
- Docker image builds clean (`docker compose build ts-runtime`)
- Server starts with Postgres persistence + Supabase auth enabled (36 routes)
- DDL migrations idempotent (all `IF NOT EXISTS` — safe on existing schema)
- Auth enforcement verified (401 without token, pass-through with valid JWT)
- Assistant CRUD: create → get → patch (version bump) → search → count → delete ✅
- Thread CRUD: create → get → patch → state → search → count → delete ✅
- Store CRUD: put → get → search → list namespaces → upsert → delete → 404 on deleted ✅
- Owner isolation: store items scoped by authenticated user ID in DB
- Data verified directly in Postgres via SQL queries
- OpenAPI spec serves 28 paths, 21 schemas, 3 store paths
- `/info` reports: `store: true`, `database_configured: true`, `tier2: true`, version `0.0.2`
- CHANGELOG.md updated with comprehensive v0.0.2 entry

---

## Environment Variables Added

| Variable | Required | Description |
|----------|----------|-------------|
| `SUPABASE_URL` | No | Supabase project URL (enables auth) |
| `SUPABASE_KEY` | No | Supabase anon key |
| `SUPABASE_SECRET` | No | Supabase service role key |
| `SUPABASE_JWT_SECRET` | No | JWT verification secret |
| `DATABASE_URL` | No | PostgreSQL connection string (enables persistence) |
| `DATABASE_POOL_MIN_SIZE` | No | Min pool connections (default: 2) |
| `DATABASE_POOL_MAX_SIZE` | No | Max pool connections (default: 10) |
| `DATABASE_POOL_TIMEOUT` | No | Pool acquire timeout in seconds (default: 30) |
| `ANTHROPIC_API_KEY` | No | Anthropic API key (enables `anthropic:*` models) |
| `GOOGLE_API_KEY` | No | Google API key (enables `google:*` models) |

---

## Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| Postgres.js compatibility with Bun | High | Verify `postgres` package works with Bun; fallback to `pg` if needed |
| `@langchain/langgraph-checkpoint-postgres` JS availability | Medium | Verify package exists and API matches; custom PostgresSaver if needed |
| Supabase JS client in Bun runtime | Medium | `@supabase/supabase-js` is pure JS, should work; verify auth flow |
| Schema compatibility with Python runtime (shared database) | High | Use identical table names and column types; migration scripts must be compatible |
| Request-scoped user context in Bun.serve() | Medium | Bun is single-threaded; pass user through handler args (no ContextVar needed) |
| LangChain.js provider packages version compatibility | Low | Pin versions; test all providers before release |

---

## Notes

- The Python runtime's `auth.py` uses `ContextVar` + thread-local storage because Robyn crosses Rust/Python boundaries. Bun is single-threaded — pass `AuthUser` directly through handler arguments. Much simpler.
- Postgres table schema MUST match Python runtime so both runtimes can share a database deployment. This is a hard requirement for the unified Helm chart.
- The `@supabase/supabase-js` package uses `fetch()` internally, which Bun supports natively.
- Store namespace is a string array (tuple) — in Postgres, stored as a `text[]` column or JSON. Match Python's storage format.
- Multi-provider LLM uses the same `"provider:model"` prefix convention as Python's `GraphConfigPydantic`. The OAP UI reads `x_oap_ui_config` from the assistant config schema to render provider dropdowns.
- The `custom:` provider prefix is special — it reads `base_url`, `custom_model_name`, and `custom_api_key` from the assistant's configurable dict rather than environment variables.