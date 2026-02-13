# Changelog

All notable changes to the **Fractal Agents Runtime — TypeScript/Bun** will be
documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.0.1]: https://github.com/l4b4r4b4b4/fractal-agents-runtime/releases/tag/ts-v0.0.1