# Fractal Agents Runtime

[![CI](https://github.com/l4b4r4b4b4/fractal-agents-runtime/actions/workflows/ci.yml/badge.svg?branch=development)](https://github.com/l4b4r4b4b4/fractal-agents-runtime/actions/workflows/ci.yml)
[![Coverage](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/l4b4r4b4b4/COVERAGE_GIST_ID/raw/python-coverage.json)](https://github.com/l4b4r4b4b4/fractal-agents-runtime/actions/workflows/ci.yml)

A **fully open-source** LangGraph-compatible agent runtime. No vendor lock-in — every component (server, agent graphs, tracing, auth, deployment) is MIT-licensed and self-hostable.

The monorepo provides runtime implementations in **Python (Robyn)** and **TypeScript (Bun)** that serve the same LangGraph API. Both runtimes are at feature parity — pick the stack that fits your infrastructure.

| Runtime | Version | Tests | Server | Graphs |
|---------|---------|-------|--------|--------|
| **Python** | 0.0.3 | 1261 tests, 74% coverage | Robyn (multi-worker) | `agent`, `research_agent` |
| **TypeScript** | 0.1.0 | 2124 tests, 3971 assertions | Bun (single-process) | `agent`, `research_agent` |

## Repository Structure

```text
fractal-agents-runtime/
├── apps/
│   ├── python/                      # Python runtime (Robyn) — v0.0.3
│   │   └── src/
│   │       ├── server/              # HTTP server, routes, config, persistence
│   │       ├── graphs/              # Agent graphs (react_agent, research_agent)
│   │       └── infra/               # Tracing, auth, store namespace
│   └── ts/                          # TypeScript runtime (Bun) — v0.1.0
│       └── src/
│           ├── routes/              # HTTP routes (assistants, threads, runs, etc.)
│           ├── graphs/              # Agent graphs (react-agent, research-agent)
│           ├── storage/             # In-memory + Postgres persistence
│           ├── middleware/          # Supabase JWT auth
│           ├── infra/               # Tracing, metrics, prompts, store namespace
│           ├── agent-sync/          # Supabase agent synchronisation
│           ├── a2a/                 # Agent-to-Agent protocol (JSON-RPC 2.0)
│           ├── mcp/                 # MCP protocol server endpoint
│           └── crons/               # Scheduled agent runs
├── benchmarks/
│   ├── mock-llm/                    # Mock OpenAI API server (Bun)
│   ├── k6/                          # k6 benchmark scripts
│   └── results/                     # Raw k6 JSON benchmark data
├── .devops/
│   ├── docker/                      # Multi-stage Dockerfiles
│   └── helm/fractal-agents-runtime/ # Unified Helm chart with runtime toggle
├── docs/                            # Architecture documentation
├── .github/workflows/               # CI, image builds, release pipelines
├── docker-compose.yml               # Local dev stack
└── flake.nix                        # Nix dev environment
```

**Import rules — dependencies flow downward only:**

- `server`/`routes` can import from `graphs` and `infra` (wires everything together)
- `graphs` can import from `infra` (e.g. store namespace conventions)
- `graphs` must **never** import from `server`/`routes` — agent graphs are portable
- `infra` must **never** import from `server` or `graphs` — lowest-level shared layer

This keeps agent graphs deployable to LangGraph Platform, FastAPI, Lambda, or any other runtime without modification.

## Features

### LangGraph API (both runtimes)

Both runtimes implement the full LangGraph API contract:

- **Assistants** — CRUD, search, count with metadata filtering
- **Threads** — Stateful conversations with state and history
- **Runs** — Stateful and stateless agent invocations (streaming + non-streaming + background)
- **SSE Streaming** — Real-time event streaming (metadata → values → messages → end)
- **Store** — Cross-thread long-term memory (namespaced key-value store)
- **MCP Server** — JSON-RPC 2.0 endpoint for Model Context Protocol integration
- **A2A Protocol** — Agent-to-Agent communication (message/send, tasks/get, tasks/cancel)
- **Crons** — Scheduled recurring agent invocations
- **Prometheus Metrics** — `/metrics` endpoint with request counts, durations, error rates
- **Multi-Provider LLM** — OpenAI, Anthropic, Google, custom endpoints (vLLM, Ollama)
- **Supabase Auth** — JWT-based authentication with per-user/org scoping
- **Postgres Persistence** — Durable state via LangGraph checkpoint + store
- **Agent Sync** — Startup synchronisation of assistants from Supabase
- **Langfuse Tracing** — Observability with prompt templates and cache
- **OpenAPI Spec** — Auto-generated and served at `/openapi.json`
- **Multi-Agent Checkpoint Isolation** — `checkpoint_ns="assistant:<id>"` prevents state collisions

### RAG (Retrieval-Augmented Generation)

Both runtimes support two independent RAG systems that can run simultaneously:

| RAG System | Config Key | Backend | Auth | Description |
|------------|-----------|---------|------|-------------|
| **ChromaDB Archives** | `rag_config` | ChromaDB v2 + TEI embeddings | None (internal) | Document archive search via `search_archives` tool. Cross-archive ranking, German-formatted results. |
| **LangConnect** | `rag` | Supabase-hosted RAG API | Supabase token | Per-collection semantic search via dynamically created tools. |

ChromaDB RAG uses direct HTTP (`fetch()` in TS, `chromadb-client` in Python) — no heavy dependencies.

### Shipped Graphs

Both runtimes ship identical agent graphs with full prompt and config parity:

| Graph | ID | Description |
|-------|----|-------------|
| **ReAct Agent** | `agent` | General-purpose ReAct agent with MCP tool integration, ChromaDB archive RAG, LangConnect RAG, multi-provider LLM, and OAuth token exchange |
| **Research Agent** | `research_agent` | Two-phase parallel research with human-in-the-loop review, worker fan-out via `Send`, Langfuse prompt templates |

All 6 Langfuse prompt names are identical across runtimes, enabling shared prompt configuration.

### Python Runtime (Robyn)

- **Robyn HTTP Server** — Multi-worker async server (34 paths, 44 operations)
- **1261 Tests, 74% Coverage** — Three-tier enforcement (global floor, per-file floor, diff-cover)
- **APScheduler** — Cron scheduling with persistent job store

### TypeScript Runtime (Bun)

- **Bun HTTP Server** — Single-process, zero-dependency HTTP server (47 routes)
- **2124 Tests, 3971 Assertions** — Comprehensive unit and integration tests across 31 files
- **Pattern-Matching Router** — Custom router with middleware, path params, and automatic metrics
- **Bun.sql** — Native Postgres driver with zero-copy binary protocol

## Benchmarks

### v0.1.0 — Runtime Overhead (Mock LLM)

Measures pure runtime overhead — HTTP routing, serialisation, auth, storage, streaming — by pointing both runtimes at a mock LLM server (10ms base delay). This isolates the runtime from LLM inference variance.

**Test setup:** AMD Threadripper 3970X (64 threads), 64 GB RAM · NixOS 26.05, kernel 6.18.12 · Bun 1.3.9, Python 3.12.12, k6 1.6.0 · Mock LLM (10ms delay, 5ms stream chunk) · HS256 local JWT auth · In-memory storage · 5 VUs ramping (90s)

**k6 agent flow:** create assistant → thread → run/wait → stream → get state → stateless run → store put/get/search → cleanup.

#### Latency Comparison (p50 / p95 / p99, milliseconds)

| Operation | TypeScript (Bun) | Python (Robyn) | Ratio (p50) |
|-----------|-----------------|----------------|-------------|
| Create assistant | 0.9 / 7.2 / 12.6 | 1.4 / 12.6 / 30.0 | TS 1.7x |
| Create thread | 0.4 / 7.4 / 15.2 | 0.9 / 9.8 / 16.9 | TS 2.1x |
| Run/wait | 18.2 / 33.2 / 40.4 | 24.9 / 52.2 / 93.4 | TS 1.4x |
| Run/stream | 23.4 / 41.3 / 50.6 | 843.7 / 1795.2 / 1871.1 | **TS 36x** |
| Stateless run/wait | 16.3 / 29.0 / 33.2 | 25.9 / 50.0 / 164.5 | TS 1.6x |
| Store put | 0.9 / 5.4 / 8.8 | 1.2 / 15.7 / 29.3 | TS 1.2x |
| Store get | 0.3 / 4.1 / 8.8 | 0.9 / 13.7 / 25.6 | TS 2.9x |
| Store search | 0.3 / 3.6 / 6.5 | 0.9 / 11.8 / 24.1 | TS 2.9x |
| **Full flow** | **81 / 109 / 118** | **916 / 1899 / 2007** | **TS 11.3x** |

#### Throughput

| Metric | TypeScript (Bun) | Python (Robyn) |
|--------|-----------------|----------------|
| Total iterations | 1,038 | 290 |
| HTTP requests | 12,458 | 3,509 |
| HTTP error rate | 0.0% | 0.0% |
| Flow success rate | 100% | 100% |

```
Full Agent Flow — p50 Latency (ms)        v0.1.0 · HS256 local JWT · 5 VUs
──────────────────────────────────────────────────────────────────────────
             TypeScript (Bun)               Python (Robyn)
──────────────────────────────────────────────────────────────────────────
Assistant    ▏                    0.9       ▎                      1.4
Thread       ▏                    0.4       ▏                      0.9
Run/wait     █▊                  18.2       ██▌                   24.9
Run/stream   ██▍                 23.4       ████████████████████████████████████ 844
Stateless    █▋                  16.3       ██▋                   25.9
Store put    ▏                    0.9       ▏                      1.2
Store get    ▏                    0.3       ▏                      0.9
Store search ▏                    0.3       ▏                      0.9
──────────────────────────────────────────────────────────────────────────
FULL FLOW    ████████▏           81         ████████████████████████████████████ 916
──────────────────────────────────────────────────────────────────────────
```

> **Key findings:**
> - **Streaming is the dominant bottleneck in Python** — 36x slower p50 for SSE, driving the 11.3x full-flow gap. CRUD and store ops are within 2–3x.
> - **Sub-millisecond CRUD in both runtimes** — With local JWT auth (no HTTP round-trip to GoTrue), assistant/thread/store operations are < 2ms p50 in both runtimes.
> - **Both runtimes achieve 100% flow success under load** — zero dropped requests at 5 concurrent users.

#### Benchmark Infrastructure

- **Mock LLM Server** (`benchmarks/mock-llm/server.ts`) — Fake OpenAI `/v1/chat/completions` with configurable delay and streaming
- **k6 Scripts** (`benchmarks/k6/agent-flow.js`) — Full agent lifecycle: create assistant → thread → run/wait → stream → stateless run → store ops → cleanup
- **Auth Scripts** — `benchmarks/scripts/create-mock-jwt.sh` (HS256 local JWT), `benchmarks/scripts/get-benchmark-token.sh` (real Supabase)

```bash
# Start mock LLM
bun run benchmarks/mock-llm/server.ts

# Generate a local JWT for benchmarks (no Supabase dependency)
AUTH_TOKEN=$(./benchmarks/scripts/create-mock-jwt.sh)
MOCK_SECRET="benchmark-jwt-secret-that-is-at-least-32-characters-long"

# Start TS runtime with local JWT auth
PORT=9001 SUPABASE_URL=http://localhost:54321 SUPABASE_KEY=mock \
  SUPABASE_JWT_SECRET="$MOCK_SECRET" OPENAI_API_KEY=mock \
  OPENAI_BASE_URL=http://localhost:11434/v1 MODEL_NAME=openai:mock-gpt-4o \
  bun run apps/ts/src/index.ts

# Run k6
k6 run -e RUNTIME_URL=http://localhost:9001 -e RUNTIME_NAME=ts \
  -e AUTH_TOKEN="$AUTH_TOKEN" benchmarks/k6/agent-flow.js
```

See [benchmarks/README.md](benchmarks/README.md) for full documentation, configuration, and methodology.

## Getting Started

### Prerequisites

- [Nix](https://nixos.org/download/) with flakes enabled (recommended), **or**
- [Python](https://www.python.org/) 3.12 + [UV](https://docs.astral.sh/uv/) + [Bun](https://bun.sh/) ≥ 1.3.9

### Setup (Nix — recommended)

```bash
git clone https://github.com/l4b4r4b4b4/fractal-agents-runtime.git
cd fractal-agents-runtime
nix develop  # Shell with python, uv, bun, docker, helm, kubectl, etc.
```

### Setup (Manual)

```bash
git clone https://github.com/l4b4r4b4b4/fractal-agents-runtime.git
cd fractal-agents-runtime
bun install                    # Root workspace

# Python
cd apps/python
uv sync
cp .env.example .env           # Edit with your API keys

# TypeScript
cd apps/ts
bun install
```

### Running the Python Runtime

```bash
cd apps/python
uv run python -m server
# http://localhost:8081/health
# http://localhost:8081/info
# http://localhost:8081/openapi.json
```

### Running the TypeScript Runtime

```bash
cd apps/ts
bun run dev
# http://localhost:3000/health
# http://localhost:3000/info
# http://localhost:3000/openapi.json
```

### Running Tests

```bash
# Python
cd apps/python
uv run pytest
uv run ruff check . --fix --unsafe-fixes && uv run ruff format .

# TypeScript
cd apps/ts
bun test
```

## Environment Variables

Both runtimes read configuration from environment variables. The same variables work for both runtimes unless noted.

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENAI_API_KEY` | Yes* | OpenAI API key |
| `ANTHROPIC_API_KEY` | Yes* | Anthropic API key |
| `GOOGLE_API_KEY` | Yes* | Google API key |
| `SUPABASE_URL` | No | Supabase project URL (enables auth) |
| `SUPABASE_KEY` | No | Supabase anon key |
| `SUPABASE_SECRET` | No | Supabase service role key |
| `SUPABASE_JWT_SECRET` | No | JWT verification secret |
| `DATABASE_URL` | No | PostgreSQL connection string (enables persistence) |
| `DATABASE_POOL_MIN_SIZE` | No | Connection pool minimum (default: 2) |
| `DATABASE_POOL_MAX_SIZE` | No | Connection pool maximum (default: 10) |
| `DATABASE_POOL_TIMEOUT` | No | Pool acquire timeout in seconds (default: 30) |
| `AGENT_SYNC_SCOPE` | No | Startup agent sync: `none`, `all`, or `org:<uuid>` |
| `OPENAI_API_BASE` | No | Custom OpenAI-compatible endpoint (vLLM, Ollama) |
| `MODEL_NAME` | No | Default LLM model name (e.g. `openai:gpt-4o-mini`) |
| `LANGFUSE_SECRET_KEY` | No | Langfuse tracing secret key |
| `LANGFUSE_PUBLIC_KEY` | No | Langfuse tracing public key |
| `LANGFUSE_BASE_URL` | No | Langfuse server URL (default: cloud) |
| `LANGFUSE_PROMPT_CACHE_TTL_SECONDS` | No | Prompt template cache TTL (default: 300) |
| `LANGCHAIN_TRACING_V2` | No | Enable LangSmith tracing (`true`/`false`) |
| `LANGCHAIN_API_KEY` | No | LangSmith API key |
| `PORT` | No | Server port (Python: 8081, TS: 3000) |
| `DOCPROC_CHROMADB_URL` | No | ChromaDB server URL (default: `http://chromadb:8000`) |
| `DOCPROC_TEI_EMBEDDINGS_URL` | No | TEI embedding endpoint (default: `http://tei-embeddings:8080`) |
| `RAG_DEFAULT_TOP_K` | No | Default results per archive (default: 5) |
| `RAG_DEFAULT_LAYER` | No | Default metadata layer filter (default: `chunk`) |
| `RAG_QUERY_TIMEOUT_SECONDS` | No | ChromaDB query timeout (default: 5) |
| `RAG_EMBED_TIMEOUT_SECONDS` | No | TEI embedding timeout (default: 10) |

\* At least one LLM provider key is required.

## Docker

Images are published to GitHub Container Registry (GHCR):

- `ghcr.io/l4b4r4b4b4/fractal-agents-runtime-python`
- `ghcr.io/l4b4r4b4b4/fractal-agents-runtime-ts`

### Build Locally

```bash
# Python runtime
docker build -f .devops/docker/python.Dockerfile . -t fractal-agents-runtime-python:local

# TypeScript runtime
docker build -f .devops/docker/ts.Dockerfile . -t fractal-agents-runtime-ts:local
```

### Local Dev Stack

```bash
# Start both runtimes (requires .env and Supabase network)
docker compose up python-runtime ts-runtime
```

Python runtime listens on port 9091 (mapped from 8081), TypeScript on port 9092 (mapped from 3000).

### Optional Infrastructure

```bash
# ChromaDB (vector database for RAG) — port 8100
docker compose up chromadb

# TEI Embeddings (requires NVIDIA GPU) — port 8011
docker compose up embeddings

# Mock LLM (benchmarks) — port 11434
docker compose up mock-llm --scale mock-llm=1
```

## Helm Chart

A unified Helm chart at `.devops/helm/fractal-agents-runtime/` supports both runtimes via a `runtime` toggle:

```bash
# Python runtime (default)
helm install agent-runtime .devops/helm/fractal-agents-runtime \
  -f .devops/helm/fractal-agents-runtime/values-testing.yaml \
  -n agents

# TypeScript runtime
helm install agent-runtime .devops/helm/fractal-agents-runtime \
  -f .devops/helm/fractal-agents-runtime/values-ts.yaml \
  -n agents

# Dual deployment (both runtimes, shared secrets + database)
helm install agent-python .devops/helm/fractal-agents-runtime \
  --set runtime=python \
  --set existingSecret.name=fractal-agents-runtime-secrets \
  -n agents
helm install agent-ts .devops/helm/fractal-agents-runtime \
  -f .devops/helm/fractal-agents-runtime/values-ts.yaml \
  --set existingSecret.name=fractal-agents-runtime-secrets \
  -n agents
```

| Values File | Purpose | Runtime |
|-------------|---------|---------|
| `values.yaml` | Production defaults | Python |
| `values-ts.yaml` | TypeScript overrides | TS |
| `values-dev.yaml` | Local/dev (1 replica, no HPA) | Python |
| `values-testing.yaml` | AKS testing | Python |
| `values-staging.yaml` | Staging (2 replicas, ingress) | Python |
| `values-prod.yaml` | Production (5 replicas, HPA 5–20) | Python |

See [Helm chart README](.devops/helm/fractal-agents-runtime/README.md) for secrets management, env var mapping, and template documentation.

## CI/CD Pipeline

Branch strategy: `feature/*` → `development` → `main`

| Trigger | Actions |
|---------|---------|
| Push to any branch | Lint + test (both runtimes, change-detected) |
| PR to `development`/`main` | CI checks + diff-cover enforcement |
| Merge to `development` | CI + `development` Docker image tag |
| Merge to `main` | CI + `nightly` Docker image tag |
| Release tag (`python-v*` / `ts-v*`) | CI + versioned image + PyPI/npm publish + GitHub Release |

### Quality Gates

**Python:**
- 1261 tests, 74% global coverage floor
- Per-file coverage thresholds (`coverage-threshold`)
- 80% diff-cover on changed lines
- Ruff lint + format
- OpenAPI spec validation (34 paths, 44 operations)

**TypeScript:**
- 2124 tests, 3971 assertions across 31 files
- TypeScript strict type checking (`tsc --noEmit`)
- OpenAPI spec validation
- Bun version pinning (`.bun-version`)

### Branch Protection

Both `main` and `development` require:
- CI Success status check
- Changes via pull request only

## API Endpoints

Both runtimes implement the LangGraph API:

| Category | Paths | Description |
|----------|-------|-------------|
| System | `/ /health /ok /info /openapi.json` | Health checks, service info, OpenAPI spec |
| Assistants | `/assistants/*` | CRUD, search, count |
| Threads | `/threads/*` | Conversation management, state, history |
| Runs (stateful) | `/threads/{id}/runs/*` | Agent invocations (wait, stream, background), cancel, join |
| Runs (stateless) | `/runs/*` | Stateless agent invocations (wait, stream, background) |
| Store | `/store/*` | Cross-thread long-term memory |
| Crons | `/runs/crons/*` | Scheduled recurring runs |
| MCP | `/mcp` | Model Context Protocol server |
| A2A | `/a2a/{assistantId}` | Agent-to-Agent protocol |
| Metrics | `/metrics` `/metrics/json` | Prometheus + JSON metrics |

## Versioning

Components are versioned independently following [Semantic Versioning](https://semver.org/):

| Component | Current | Source of Truth |
|-----------|---------|-----------------|
| Python runtime | **0.0.3** | `apps/python/pyproject.toml` |
| TypeScript runtime | **0.1.0** | `apps/ts/package.json` |
| Helm chart | **0.0.2** | `.devops/helm/fractal-agents-runtime/Chart.yaml` |

## Architecture Documentation

| Document | Description |
|----------|-------------|
| [Multi-Agent Checkpoint Architecture](docs/MULTI_AGENT_CHECKPOINT_ARCHITECTURE.md) | Checkpoint namespace isolation for concurrent agents in shared threads |
| [RAG Archive Retrieval](docs/rag-archive-retrieval.md) | ChromaDB + TEI architecture for document archive search |
| [Benchmarks](benchmarks/README.md) | Mock LLM server, k6 benchmark setup, and methodology |
| [Helm Chart](/.devops/helm/fractal-agents-runtime/README.md) | Kubernetes deployment, secrets, env vars |
| [Contributing](CONTRIBUTING.md) | Development workflow and coding standards |

## Monorepo Tooling

| Tool | Purpose |
|------|---------|
| [UV](https://docs.astral.sh/uv/) | Python dependency management (10–100x faster than pip) |
| [Bun](https://bun.sh/) | TypeScript runtime, bundler, and test runner |
| [Ruff](https://docs.astral.sh/ruff/) | Python linting and formatting |
| [Lefthook](https://github.com/evilmartians/lefthook) | Git hooks (pre-commit lint, pre-push tests) |
| [Nix Flakes](https://nixos.wiki/wiki/Flakes) | Reproducible dev environment |
| [Helm](https://helm.sh/) | Kubernetes deployment |
| [k6](https://grafana.com/docs/k6/) | Load testing and benchmarks |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development workflow, coding standards, and the `.rules` file for project conventions.

## License

[MIT](LICENSE)