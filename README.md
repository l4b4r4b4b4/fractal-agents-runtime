# Fractal Agents Runtime

[![CI](https://github.com/l4b4r4b4b4/fractal-agents-runtime/actions/workflows/ci.yml/badge.svg?branch=development)](https://github.com/l4b4r4b4b4/fractal-agents-runtime/actions/workflows/ci.yml)
[![Coverage](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/l4b4r4b4b4/COVERAGE_GIST_ID/raw/python-coverage.json)](https://github.com/l4b4r4b4b4/fractal-agents-runtime/actions/workflows/ci.yml)

A **fully open-source** LangGraph-compatible agent runtime. No vendor lock-in — every component (server, agent graphs, tracing, auth, deployment) is MIT-licensed and self-hostable.

The monorepo provides runtime implementations in **Python (Robyn)** and **TypeScript (Bun)** that serve the same LangGraph API, letting you pick the stack that fits your infrastructure.

**Python runtime v0.0.1** — 867 tests, 74% coverage, full LangGraph API.

## Repository Structure

```text
fractal-agents-runtime/
├── apps/
│   ├── python/                     # Python runtime (Robyn HTTP server) — v0.0.1
│   │   └── src/
│   │       ├── server/             # HTTP server, routes, config, persistence
│   │       ├── graphs/react_agent/ # ReAct agent graph (MCP tools, multi-provider LLM)
│   │       └── infra/              # Shared infra: tracing, auth, store namespace
│   └── ts/                         # TypeScript runtime (Bun) — v0.0.0 stub
│       └── src/
├── .devops/
│   ├── docker/                     # Multi-stage Dockerfiles (python.Dockerfile, ts.Dockerfile)
│   └── helm/fractal-agents-runtime/# Unified Helm chart with runtime toggle
├── .github/workflows/              # CI, image builds, release pipelines
├── docker-compose.yml              # Local dev stack (runtime + vLLM + embeddings)
└── flake.nix                       # Nix dev environment
```

All Python source lives under `apps/python/src/` in three modules:

| Module | Path | Description |
|--------|------|-------------|
| `server` | `apps/python/src/server/` | Robyn HTTP server — routes, config, Postgres persistence, agent sync |
| `graphs` | `apps/python/src/graphs/react_agent/` | Portable ReAct agent — MCP tools, RAG, multi-provider LLM |
| `infra` | `apps/python/src/infra/` | Shared infrastructure — Langfuse tracing, Supabase auth, store namespace |

**Import rules — dependencies flow downward only:**

- `server` can import from `graphs` and `infra` (it wires everything together)
- `graphs` can import from `infra` (e.g. store namespace conventions)
- `graphs` must **never** import from `server` — the agent graph is portable and must not be coupled to a specific HTTP framework
- `infra` must **never** import from `server` or `graphs` — it's the lowest-level shared layer

This keeps the agent graph deployable to LangGraph Platform, FastAPI, Lambda, or any other runtime without modification.

## Features

### LangGraph Runtime (both runtimes)

These features are part of the LangGraph API contract — both the Python and TypeScript runtimes implement them (TS runtime is v0.0.0 stub, working toward parity):

- **Full LangGraph API** — Threads, runs, assistants, store, SSE streaming
- **MCP Tool Integration** — Dynamically load tools from remote MCP servers with OAuth token exchange
- **Multi-Provider LLM** — OpenAI, Anthropic, Google, and custom OpenAI-compatible endpoints (vLLM, Ollama, etc.)
- **Semantic Router** — Optional transparent proxy for dynamic per-request model routing via [vLLM Semantic Router](https://github.com/vllm-project/semantic-router). See [docs/semantic-router.md](docs/semantic-router.md)
- **Supabase Auth** — JWT-based authentication and per-user/org scoping
- **Postgres Persistence** — Durable conversation state via LangGraph checkpoint + store
- **A2A Protocol** — Agent-to-Agent communication endpoints
- **OpenAPI Spec** — Auto-generated and served at `/openapi.json`
- **Helm Chart** — Unified Kubernetes deployment with a `runtime` toggle (`python` or `ts`)

### Shipped Graphs

Each runtime ships with pre-built agent graphs in `apps/<runtime>/src/graphs/`. Graphs are portable — they accept persistence via dependency injection and never import from the server layer.

| Graph | Path | Description |
|-------|------|-------------|
| **ReAct Agent** | `graphs/react_agent/` | General-purpose ReAct agent with MCP tool integration, Supabase RAG tool factory, multi-provider LLM support (OpenAI, Anthropic, Google, vLLM, Ollama), and OAuth token exchange for remote tool servers |

The `graphs/` directory is a catalog — additional agent architectures (plan-and-execute, multi-agent, etc.) can be added as sibling packages alongside `react_agent/`.

### Python Runtime (Robyn) — v0.0.1

- **Robyn HTTP Server** — Multi-worker async server (34 paths, 44 operations, 28 schemas)
- **Shared LLM Factory** — Single `create_chat_model()` entry point with call-time model override, routing metadata headers, and semantic router env var support
- **Supabase RAG** — LangConnect-based retrieval-augmented generation
- **Agent Sync** — Startup synchronisation of assistants from Supabase (`AGENT_SYNC_SCOPE`)
- **Cron Scheduling** — APScheduler-based recurring agent invocations
- **Langfuse Tracing** — Optional observability with per-invocation trace attribution
- **Prometheus Metrics** — `/metrics` endpoint for monitoring
- **867 Tests, 74% Coverage** — Three-tier enforcement (global floor, per-file floor, diff-cover on new code)

### TypeScript Runtime (Bun) — v0.0.0

- **Bun HTTP Server** — Single-process, compiled binary
- **Health / Info / OpenAPI** — Pipeline-validation stub, working toward full parity with Python

## Getting Started

### Prerequisites

- [Nix](https://nixos.org/download/) with flakes enabled (recommended), **or**
- [Python](https://www.python.org/) 3.12 + [UV](https://docs.astral.sh/uv/) + [Bun](https://bun.sh/) ≥ 1.1

### Setup (Nix — recommended)

```bash
git clone https://github.com/l4b4r4b4b4/fractal-agents-runtime.git
cd fractal-agents-runtime
nix develop  # Shell with python, uv, bun, docker, helm, kubectl, etc.
```

The Nix dev shell automatically creates a Python venv, runs `uv sync`, and runs `bun install`.

### Setup (Manual)

```bash
git clone https://github.com/l4b4r4b4b4/fractal-agents-runtime.git
cd fractal-agents-runtime
bun install                    # Root workspace

cd apps/python
uv sync                        # Python dependencies
cp .env.example .env           # Edit with your API keys
```

### Running the Python Runtime

```bash
cd apps/python

# Robyn HTTP server (production)
uv run python -m server

# Health check
curl http://localhost:8081/health
curl http://localhost:8081/info
curl http://localhost:8081/openapi.json
```

### Running the TypeScript Runtime

```bash
cd apps/ts
bun run dev
# http://localhost:3000/health
```

### Running Tests

```bash
cd apps/python

# Full test suite with coverage
uv run pytest

# Linting
uv run ruff check . --fix --unsafe-fixes && uv run ruff format .
```

## Environment Variables

The Python runtime reads configuration from environment variables. See `apps/python/.env.example` for the full list.

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENAI_API_KEY` | Yes* | OpenAI API key |
| `ANTHROPIC_API_KEY` | Yes* | Anthropic API key |
| `SUPABASE_URL` | Yes | Supabase project URL |
| `SUPABASE_KEY` | Yes | Supabase anon key |
| `SUPABASE_SECRET` | No | Supabase service role key |
| `SUPABASE_JWT_SECRET` | No | JWT verification secret |
| `DATABASE_URL` | No | PostgreSQL connection string (enables persistence) |
| `AGENT_SYNC_SCOPE` | No | Startup agent sync: `none`, `all`, or `org:<id>` |
| `OPENAI_API_BASE` | No | Custom OpenAI-compatible endpoint (e.g. vLLM) |
| `MODEL_NAME` | No | Default LLM model name |
| `LANGFUSE_SECRET_KEY` | No | Langfuse tracing secret key |
| `LANGFUSE_PUBLIC_KEY` | No | Langfuse tracing public key |
| `LANGFUSE_BASE_URL` | No | Langfuse server URL (default: cloud) |
| `LANGCHAIN_TRACING_V2` | No | Enable LangSmith tracing (`true`/`false`) |
| `LANGCHAIN_API_KEY` | No | LangSmith API key |
| `LANGCHAIN_PROJECT` | No | LangSmith project name |
| `SEMANTIC_ROUTER_ENABLED` | No | Route all LLM calls through semantic router (`true`/`false`) |
| `SEMANTIC_ROUTER_URL` | No | Semantic router Envoy proxy URL (e.g. `http://localhost:8801/v1`) |
| `SEMANTIC_ROUTER_MODEL` | No | Model name for router-managed selection (default: `MoM`) |

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
# Start runtime + vLLM (requires .env file and Supabase network)
docker compose up robyn-server
```

## Helm Chart

A unified Helm chart at `.devops/helm/fractal-agents-runtime/` supports both runtimes via a `runtime` toggle:

```bash
# Python runtime (default)
helm install agent-runtime .devops/helm/fractal-agents-runtime \
  -f .devops/helm/fractal-agents-runtime/values-testing.yaml \
  -n testing

# TypeScript runtime
helm install agent-runtime .devops/helm/fractal-agents-runtime \
  -f .devops/helm/fractal-agents-runtime/values-ts.yaml \
  -n testing
```

| Values File | Purpose | Runtime |
|-------------|---------|---------|
| `values.yaml` | Production defaults | Python |
| `values-ts.yaml` | TypeScript overrides | TS |
| `values-dev.yaml` | Local/dev (1 replica, no HPA) | Python |
| `values-testing.yaml` | AKS testing (real Supabase + vLLM) | Python |
| `values-staging.yaml` | Staging (2 replicas, ingress) | Python |
| `values-prod.yaml` | Production (5 replicas, HPA 5–20) | Python |

See [Helm chart README](.devops/helm/fractal-agents-runtime/README.md) for full documentation.

## CI/CD Pipeline

Branch strategy: `feature/*` → `development` → `main`

| Trigger | Actions |
|---------|---------|
| Push to any branch | Lint + test + coverage enforcement |
| Merge to `development` | CI checks + `development` image tag |
| Merge to `main` | CI checks + `nightly` image tag |
| Release tag | CI checks + versioned image + PyPI publish |

### Quality Gates

- **867 tests** must pass (`pytest`)
- **74% global coverage** floor (`pytest-cov fail_under=73`)
- **Per-file coverage** floor (`coverage-threshold`)
- **80% diff-cover** on changed lines
- **Lint** (`ruff check` + `ruff format`)
- **OpenAPI validation** (34 paths, 44 operations, 28 schemas)

### Branch Protection

Both `main` and `development` require:
- CI Success status check
- Changes via pull request only

## Monorepo Tooling

| Tool | Purpose |
|------|---------|
| [UV](https://docs.astral.sh/uv/) | Python dependency management (10–100x faster than pip) |
| [Bun Workspaces](https://bun.sh/docs/install/workspaces) | Monorepo workspace management |
| [Ruff](https://docs.astral.sh/ruff/) | Python linting and formatting |
| [Lefthook](https://github.com/evilmartians/lefthook) | Git hooks (pre-commit lint, pre-push test + coverage) |
| [Nix Flakes](https://nixos.wiki/wiki/Flakes) | Reproducible dev environment |
| [Helm](https://helm.sh/) | Kubernetes deployment |

## Versioning

Components are versioned independently following [Semantic Versioning](https://semver.org/):

| Component | Current | Source |
|-----------|---------|--------|
| Python runtime | **0.0.1** | `apps/python/pyproject.toml` |
| TypeScript runtime | 0.0.0 | `apps/ts/package.json` |
| Helm chart | 0.0.1 | `.devops/helm/fractal-agents-runtime/Chart.yaml` |

## API Endpoints

The Python runtime implements the LangGraph API:

| Category | Endpoints | Description |
|----------|-----------|-------------|
| Health | `GET /health` `/ok` `/info` | Health checks and service info |
| Assistants | `POST/GET/PUT/PATCH/DELETE /assistants/*` | CRUD + search |
| Threads | `POST/GET/PUT/PATCH/DELETE /threads/*` | Conversation thread management |
| Runs | `POST/GET /threads/{id}/runs/*` | Agent invocations + streaming |
| Store | `PUT/GET/DELETE/POST /store/*` | Cross-thread long-term memory |
| Crons | `POST/GET/PUT/PATCH/DELETE /crons/*` | Scheduled agent runs |
| MCP | `POST /mcp/*` | MCP tool management |
| A2A | `POST /a2a/*` | Agent-to-Agent protocol |
| Metrics | `GET /metrics` | Prometheus exposition format |
| OpenAPI | `GET /openapi.json` | OpenAPI 3.1 specification |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development workflow, coding standards, and the `.rules` file for project conventions.

## License

[MIT](LICENSE)