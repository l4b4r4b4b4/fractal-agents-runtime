# Fractal Agents Runtime

[![CI](https://github.com/l4b4r4b4b4/fractal-agents-runtime/actions/workflows/ci.yml/badge.svg?branch=development)](https://github.com/l4b4r4b4b4/fractal-agents-runtime/actions/workflows/ci.yml)
[![Coverage](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/l4b4r4b4b4/COVERAGE_GIST_ID/raw/python-coverage.json)](https://github.com/l4b4r4b4b4/fractal-agents-runtime/actions/workflows/ci.yml)

A **fully open-source** LangGraph-compatible agent runtime. No vendor lock-in — every component (server, agent graphs, tracing, auth, deployment) is MIT-licensed and self-hostable.

The monorepo provides runtime implementations in **Python (Robyn)** and **TypeScript (Bun)** that serve the same LangGraph API. Both runtimes are at feature parity — pick the stack that fits your infrastructure.

| Runtime | Version | Tests | Server | Graphs |
|---------|---------|-------|--------|--------|
| **Python** | 0.0.2 | 867 tests, 74% coverage | Robyn (multi-worker) | `agent`, `research_agent` |
| **TypeScript** | 0.0.3 | 1923 tests, 3648 assertions | Bun (single-process) | `agent`, `research_agent` |

## Repository Structure

```text
fractal-agents-runtime/
├── apps/
│   ├── python/                      # Python runtime (Robyn) — v0.0.2
│   │   └── src/
│   │       ├── server/              # HTTP server, routes, config, persistence
│   │       ├── graphs/              # Agent graphs (react_agent, research_agent)
│   │       └── infra/               # Tracing, auth, store namespace
│   └── ts/                          # TypeScript runtime (Bun) — v0.0.3
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
│   └── k6/                          # k6 benchmark scripts
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
- **Runs** — Stateful and stateless agent invocations with lifecycle management
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

### Shipped Graphs

Both runtimes ship identical agent graphs with full prompt and config parity:

| Graph | ID | Description |
|-------|----|-------------|
| **ReAct Agent** | `agent` | General-purpose ReAct agent with MCP tool integration, Supabase RAG tool factory, multi-provider LLM, and OAuth token exchange |
| **Research Agent** | `research_agent` | Two-phase parallel research with human-in-the-loop review, worker fan-out via `Send`, Langfuse prompt templates |

All 6 Langfuse prompt names are identical across runtimes, enabling shared prompt configuration.

### Python Runtime (Robyn)

- **Robyn HTTP Server** — Multi-worker async server (34 paths, 44 operations)
- **867 Tests, 74% Coverage** — Three-tier enforcement (global floor, per-file floor, diff-cover)
- **APScheduler** — Cron scheduling with persistent job store

### TypeScript Runtime (Bun)

- **Bun HTTP Server** — Single-process, zero-dependency HTTP server (47 routes)
- **1923 Tests, 3648 Assertions** — Comprehensive unit and integration tests across 28 files
- **Pattern-Matching Router** — Custom router with middleware, path params, and automatic metrics

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

Python runtime listens on port 8081, TypeScript on port 8082 (mapped from 3000).

## Benchmarks

The `benchmarks/` directory provides infrastructure for comparing runtime overhead:

- **Mock LLM Server** (`benchmarks/mock-llm/server.ts`) — Fake OpenAI `/v1/chat/completions` with configurable delay and streaming
- **k6 Scripts** (`benchmarks/k6/agent-flow.js`) — Full agent lifecycle: create assistant → thread → run/wait → stream → cleanup

```bash
# Start mock LLM
bun run benchmarks/mock-llm/server.ts

# Start a runtime pointed at mock LLM
OPENAI_API_KEY=mock OPENAI_BASE_URL=http://localhost:11434/v1 bun run apps/ts/src/index.ts

# Smoke test
k6 run -e SMOKE=1 benchmarks/k6/agent-flow.js
```

See [benchmarks/README.md](benchmarks/README.md) for full documentation.

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
- 867 tests, 74% global coverage floor
- Per-file coverage thresholds (`coverage-threshold`)
- 80% diff-cover on changed lines
- Ruff lint + format
- OpenAPI spec validation (34 paths, 44 operations)

**TypeScript:**
- 1923 tests, 3648 assertions
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
| Runs (stateful) | `/threads/{id}/runs/*` | Agent invocations, streaming, cancel, join |
| Runs (stateless) | `/runs/*` | Stateless agent invocations |
| Store | `/store/*` | Cross-thread long-term memory |
| Crons | `/runs/crons/*` | Scheduled recurring runs |
| MCP | `/mcp` | Model Context Protocol server |
| A2A | `/a2a/{assistantId}` | Agent-to-Agent protocol |
| Metrics | `/metrics` `/metrics/json` | Prometheus + JSON metrics |

## Versioning

Components are versioned independently following [Semantic Versioning](https://semver.org/):

| Component | Current | Source of Truth |
|-----------|---------|-----------------|
| Python runtime | **0.0.2** | `apps/python/pyproject.toml` |
| TypeScript runtime | **0.0.3** | `apps/ts/package.json` |
| Helm chart | **0.0.2** | `.devops/helm/fractal-agents-runtime/Chart.yaml` |

## Architecture Documentation

| Document | Description |
|----------|-------------|
| [Multi-Agent Checkpoint Architecture](docs/MULTI_AGENT_CHECKPOINT_ARCHITECTURE.md) | Checkpoint namespace isolation for concurrent agents in shared threads |
| [Benchmarks](benchmarks/README.md) | Mock LLM server and k6 benchmark setup |
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