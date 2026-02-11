# Goal 03: TypeScript Runtime v0.0.1 — First Real TS Implementation

> **Status:** ⚪ Not Started
> **Priority:** High
> **Created:** 2026-02-11
> **Last Updated:** 2026-02-11
> **Depends on:** [Goal 01 — Monorepo v0.0.0 Setup](../01-Monorepo-V0.0.0-Setup/scratchpad.md), [Goal 02 — Python Runtime v0.0.1](../02-Python-Runtime-V0.0.1/scratchpad.md)

---

## Objectives

Implement the first real TypeScript/Bun-based LangGraph-compatible agent runtime and ship v0.0.1 through the validated DevOps pipeline:

1. **Real HTTP server** — Bun.serve() with LangGraph API endpoints (core subset)
2. **OpenAPI spec** — Generated from actual routes, committed, served at runtime
3. **Full pipeline run** — feature → development → main → GHCR image + npm publish
4. **Foundation for parity** — Clean architecture that can grow toward full Python runtime feature parity

---

## Scope: What's in v0.0.1

### Core Endpoints (Minimum Viable Runtime)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `GET /health` | GET | Health check |
| `GET /info` | GET | Service info, version, capabilities |
| `GET /openapi.json` | GET | OpenAPI spec |
| `GET /assistants` | GET | List assistants |
| `GET /assistants/{id}` | GET | Get assistant by ID |
| `POST /threads` | POST | Create thread |
| `GET /threads/{id}` | GET | Get thread |
| `POST /threads/{id}/runs` | POST | Create run (basic, no streaming yet) |
| `GET /threads/{id}/runs` | GET | List runs |
| `GET /threads/{id}/runs/{run_id}` | GET | Get run status |

### Architecture

```
apps/ts/src/
├── index.ts              # Bun.serve() entrypoint
├── router.ts             # Route matching and dispatch
├── routes/
│   ├── health.ts         # GET /health
│   ├── info.ts           # GET /info
│   ├── openapi.ts        # GET /openapi.json
│   ├── assistants.ts     # Assistants CRUD
│   ├── threads.ts        # Threads CRUD
│   └── runs.ts           # Runs CRUD (basic)
├── models/
│   ├── assistant.ts      # Assistant types
│   ├── thread.ts         # Thread types
│   └── run.ts            # Run types
├── storage/
│   └── memory.ts         # In-memory storage (v0.0.1 baseline)
├── openapi/
│   ├── spec.ts           # OpenAPI spec builder
│   └── generate.ts       # CLI script to write openapi-spec.json
└── tests/
    ├── health.test.ts
    ├── info.test.ts
    ├── assistants.test.ts
    ├── threads.test.ts
    └── runs.test.ts
```

### Explicitly NOT in v0.0.1

- No SSE streaming (future — v0.0.2+)
- No LLM integration / actual agent execution (returns mock responses)
- No authentication (future)
- No Store API (future)
- No Crons API (future)
- No A2A / MCP protocol (future)
- No Postgres persistence (in-memory only)

### Design Decisions

- **Bun.serve() native** — No Express, no Hono, no framework. Raw Bun for maximum performance.
- **In-memory storage** — Simple Map-based storage for v0.0.1. Swap to Postgres later via adapter pattern.
- **Type-first** — All request/response types defined upfront matching the LangGraph API schema.
- **Tests from day one** — Every endpoint has at least basic happy-path + error-path tests.

---

## Task Breakdown

### Task-01: Core Server & Router

- Implement `Bun.serve()` entrypoint in `src/index.ts`
- Implement pattern-matching router in `src/router.ts`
  - Path parameter extraction (`:id` patterns)
  - Method-based dispatch
  - JSON request/response helpers
  - Error handling middleware
- Implement `/health` and `/info` routes
- Basic tests
- **Depends on:** Goal 01 Task-02 (TS stub exists)

### Task-02: Type Definitions & Storage

- Define TypeScript interfaces matching LangGraph API types:
  - `Assistant`, `Thread`, `Run`, `RunStatus`
  - Request/response types for each endpoint
- Implement in-memory storage with `Map<string, T>`
  - CRUD operations for assistants, threads, runs
  - Proper ID generation (crypto.randomUUID)
- Tests for storage layer
- **Depends on:** Task-01

### Task-03: Assistants & Threads Routes

- Implement `GET /assistants`, `GET /assistants/{id}`
- Implement `POST /threads`, `GET /threads/{id}`
- Wire up to in-memory storage
- Request validation, proper error responses (404, 400)
- Tests for each route
- **Depends on:** Task-02

### Task-04: Runs Routes (Basic)

- Implement `POST /threads/{id}/runs` — Creates a run, returns immediately (no actual execution)
- Implement `GET /threads/{id}/runs`, `GET /threads/{id}/runs/{run_id}`
- Run status lifecycle: `pending` → `completed` (mock — no real LLM call)
- Tests
- **Depends on:** Task-03

### Task-05: OpenAPI Spec Generation

- Build OpenAPI 3.1 spec from route definitions
- Generate `apps/ts/openapi-spec.json` via script
- Serve at `GET /openapi.json`
- Integrate with lefthook hooks (already set up in Goal 01)
- Validate spec matches actual routes
- **Depends on:** Task-03, Task-04

### Task-06: Docker Image & Pipeline Run

- Update `apps/ts/Dockerfile` for real implementation (beyond stub)
- Run full pipeline: feature → development → main
- Verify:
  - Docker image runs and serves all endpoints
  - npm package published as `@fractal/agents-runtime-ts@0.0.1`
  - Git tag `ts-v0.0.1`
  - OpenAPI spec committed and consistent
- **Depends on:** All previous tasks

---

## Success Criteria

- [ ] `bun test` passes for all routes in `apps/ts/`
- [ ] `bunx tsc --noEmit` — zero TypeScript errors
- [ ] Server starts and serves all v0.0.1 endpoints correctly
- [ ] `GET /openapi.json` returns valid OpenAPI 3.1 spec matching actual routes
- [ ] `apps/ts/openapi-spec.json` committed and matches runtime spec
- [ ] Docker image builds and runs (`ghcr.io/l4b4r4b4b4/fractal-agents-runtime-ts:v0.0.1`)
- [ ] npm package published (`@fractal/agents-runtime-ts@0.0.1`)
- [ ] Full pipeline validated: feature → development → main → release
- [ ] No framework dependencies — pure Bun.serve()
- [ ] At least 10 tests covering happy paths + error paths
- [ ] CHANGELOG.md updated with v0.0.1 entry

---

## Parity Roadmap (Future Versions)

| Version | Features |
|---------|----------|
| v0.0.1 | Health, info, assistants, threads, runs (basic), OpenAPI ✅ |
| v0.0.2 | SSE streaming for runs |
| v0.0.3 | Supabase JWT authentication |
| v0.0.4 | Store API (key-value with namespaces) |
| v0.0.5 | Postgres persistence (replace in-memory) |
| v0.1.0 | LLM integration (actual agent execution) |
| v0.2.0 | MCP tool support |
| v0.3.0 | Crons API |
| v0.4.0 | A2A Protocol |
| v1.0.0 | Full Python runtime feature parity |

---

## Notes

- The Python runtime is the reference implementation — TS should match its API surface
- v0.0.1 proves the architecture works; LLM integration comes later
- Using raw `Bun.serve()` means we own the full stack — no framework lock-in
- In-memory storage is intentional for v0.0.1: simple, testable, swappable
- Goal 02's pipeline validation gives us confidence the DevOps flow works before we ship TS