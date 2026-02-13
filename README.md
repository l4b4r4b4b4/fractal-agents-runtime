# Fractal Agents Runtime

[![CI](https://github.com/l4b4r4b4b4/fractal-agents-runtime/actions/workflows/ci.yml/badge.svg?branch=development)](https://github.com/l4b4r4b4b4/fractal-agents-runtime/actions/workflows/ci.yml)
[![Coverage](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/l4b4r4b4b4/COVERAGE_GIST_ID/raw/python-coverage.json)](https://github.com/l4b4r4b4b4/fractal-agents-runtime/actions/workflows/ci.yml)

<!-- Coverage badge setup (one-time):
  1. Create a public Gist at https://gist.github.com (any content, e.g. {})
  2. Copy the Gist ID from the URL (the hex string after your username)
  3. Replace COVERAGE_GIST_ID in the badge URL above with your actual Gist ID
  4. Create a PAT at https://github.com/settings/tokens with "gist" scope
  5. Add repo secrets: COVERAGE_GIST_ID and COVERAGE_GIST_TOKEN
  6. Push to development — the badge updates automatically -->

A polyglot monorepo providing LangGraph-based AI agent runtimes with MCP (Model Context Protocol) tool integration, RAG capabilities, and a production-ready HTTP server.

## Architecture

The codebase follows a **3-layer architecture** that separates portable agent graphs from runtime infrastructure and application servers:

```text
fractal-agents-runtime/
├── apps/
│   ├── python/                        # Python runtime (Robyn HTTP server)
│   └── ts/                            # TypeScript runtime (Bun HTTP server)
├── packages/
│   └── python/
│       ├── graphs/
│       │   └── react_agent/           # Portable ReAct agent graph (PyPI: fractal-graph-react-agent)
│       └── infra/
│           └── fractal_agent_infra/   # Shared infra: tracing, auth, store namespace (PyPI: fractal-agent-infra)
├── .devops/docker/                    # Dockerfiles (multi-stage, uv best practices)
├── .github/workflows/                 # CI/CD pipelines
├── docs/                              # Monorepo-level documentation
└── flake.nix                          # Nix dev environment
```

### 3-Layer Design

```text
┌──────────────────────────────────────────────────────────┐
│  apps/                                                   │
│  Thin HTTP wrappers — Robyn (Python), Bun (TypeScript)   │
│  Routes, config, Postgres persistence, wiring            │
│  ┌──────────────────┐  ┌──────────────────────────┐      │
│  │ depends on       │  │ depends on               │      │
│  │   graphs/*       │  │   infra/                 │      │
│  └────────┬─────────┘  └────────────┬─────────────┘      │
└───────────┼─────────────────────────┼────────────────────┘
            │                         │
┌───────────▼──────────┐  ┌──────────▼──────────────────┐
│  packages/graphs/    │  │  packages/infra/            │
│  Portable agent      │  │  Shared runtime infra:      │
│  architectures:      │  │  tracing, auth,             │
│  react_agent,        │  │  store_namespace            │
│  (future: plan &     │  │                             │
│   execute, etc.)     │  │  No server coupling         │
│                      │  │                             │
│  Depends on infra    │  │                             │
└──────────────────────┘  └─────────────────────────────┘
```

**Dependency rules:**

- **Graphs → Infra:** ✅ Allowed (e.g., store namespace conventions)
- **Apps → Graphs + Infra:** ✅ Allowed (runtime picks which graph to serve)
- **Graphs → Apps:** ❌ Never (graphs are portable — no server imports)
- **Infra → Apps / Graphs:** ❌ Never

### Packages

| Package | PyPI Name | Import | Description |
|---------|-----------|--------|-------------|
| `packages/python/graphs/react_agent` | `fractal-graph-react-agent` | `react_agent` | Portable ReAct agent with MCP tools, RAG, multi-provider LLM support |
| `packages/python/infra/fractal_agent_infra` | `fractal-agent-infra` | `fractal_agent_infra` | Langfuse tracing, LangGraph SDK auth, store namespace conventions |

### Apps

| App | Stack | Description |
|-----|-------|-------------|
| `apps/python` | Python 3.12, Robyn, LangGraph, UV | Production runtime — HTTP server implementing the LangGraph API |
| `apps/ts` | Bun, TypeScript, LangGraph JS | TypeScript runtime — Core LangGraph API subset (v0.0.0 pipeline-validation stub) |

### Dependency Injection

Graphs use dependency injection for persistence — they never import from any specific runtime:

```python
from react_agent import graph

# The runtime creates and injects checkpointer/store:
agent = await graph(
    config,
    checkpointer=get_checkpointer(),  # Thread-level conversation memory
    store=get_store(),                  # Cross-thread long-term memory
)
```

When `checkpointer` and `store` are `None` (the default), the agent runs without persistence — useful for testing, stateless invocations, or deployment to LangGraph Platform.

### Key Features (Python Runtime)

- **ReAct Agent with MCP Tools** — Dynamically loads tools from remote MCP servers with OAuth token exchange
- **Supabase RAG Integration** — LangConnect-based retrieval-augmented generation
- **Robyn HTTP Server** — Implements the LangGraph API (threads, runs, assistants, store, streaming)
- **A2A Protocol** — Agent-to-Agent communication support
- **Cron Scheduling** — APScheduler-based recurring agent invocations
- **Postgres Checkpointing** — Durable conversation state via `langgraph-checkpoint-postgres`
- **Langfuse Tracing** — Optional observability with per-invocation trace attribution
- **OpenAPI Spec** — Auto-generated and served at `/openapi.json`
- **Helm Chart** — Production Kubernetes deployment included
- **Multi-Provider LLM** — OpenAI, Anthropic, Google, and custom OpenAI-compatible endpoints

## Getting Started

### Prerequisites

- [Nix](https://nixos.org/download/) with flakes enabled (recommended), **or**
- [Bun](https://bun.sh/) ≥ 1.1 + [Python](https://www.python.org/) 3.12 + [UV](https://docs.astral.sh/uv/)

### Setup (Nix — recommended)

```bash
git clone https://github.com/l4b4r4b4b4/fractal-agents-runtime.git
cd fractal-agents-runtime
nix develop  # Drops you into a shell with bun, python, uv, docker, helm, etc.
```

The Nix dev shell automatically:
- Creates a Python venv in `apps/python/.venv/`
- Runs `uv sync` for Python dependencies
- Runs `bun install` for workspace dependencies

### Setup (Manual)

```bash
git clone https://github.com/l4b4r4b4b4/fractal-agents-runtime.git
cd fractal-agents-runtime

# Root workspace
bun install

# Python app (automatically resolves graph + infra path dependencies)
cd apps/python
uv sync
cp .env.example .env  # Edit with your API keys
```

### Running the Python Runtime

```bash
cd apps/python

# Robyn HTTP server (production runtime)
uv run python -m robyn_server

# LangGraph dev server (development/debugging)
uv run langgraph dev --no-browser
```

### Running the TypeScript Runtime

```bash
cd apps/ts
bun run dev
```

### Running Tests

```bash
# Python (550+ tests)
cd apps/python
uv run pytest

# TypeScript
cd apps/ts
bun test

# Linting (Python — all three packages)
cd apps/python
uv run ruff check .
uv run ruff format --check .
```

## Monorepo Tooling

| Tool | Purpose |
|------|---------|
| [UV](https://docs.astral.sh/uv/) | Python dependency management (10-100x faster than pip) |
| [Bun Workspaces](https://bun.sh/docs/install/workspaces) | Monorepo workspace management |
| [Ruff](https://docs.astral.sh/ruff/) | Python linting & formatting |
| [Lefthook](https://github.com/evilmartians/lefthook) | Git hooks (pre-commit lint, pre-push test) |
| [Nix Flakes](https://nixos.wiki/wiki/Flakes) | Reproducible dev environment |

## CI/CD Pipeline

Branch strategy: `feature` → `development` → `main`

| Trigger | Actions |
|---------|---------|
| Push to feature branch | CI checks + feature image build (`sha-<short>`) |
| Merge to `development` | CI checks + dev image build (`development` tag) |
| Release tag | CI checks + release image + PyPI/npm publish |

### Release Tags

| Tag Pattern | What It Triggers | Source |
|-------------|-----------------|--------|
| `python-graphs-v*` | PyPI publish `fractal-graph-react-agent` | `packages/python/graphs/react_agent/` |
| `python-runtime-v*` | Docker image to GHCR | `apps/python/` + all deps |
| `ts-graphs-v*` | npm publish (future) | `packages/ts/` |
| `ts-runtime-v*` | Docker image to GHCR | `apps/ts/` + all deps |

Docker images are published to GitHub Container Registry (GHCR):
- `ghcr.io/l4b4r4b4b4/fractal-agents-runtime-python`
- `ghcr.io/l4b4r4b4b4/fractal-agents-runtime-ts`

## Environment Variables

The Python runtime requires several environment variables. See `apps/python/.env.example` for the full list. Key variables:

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENAI_API_KEY` | Yes* | OpenAI API key |
| `ANTHROPIC_API_KEY` | Yes* | Anthropic Claude API key |
| `SUPABASE_URL` | No | Supabase project URL (for auth + RAG) |
| `SUPABASE_KEY` | No | Supabase anon/service key |
| `DATABASE_URL` | No | PostgreSQL connection string (for checkpointing + store) |
| `LANGFUSE_SECRET_KEY` | No | Langfuse tracing secret key |
| `LANGFUSE_PUBLIC_KEY` | No | Langfuse tracing public key |

\* At least one LLM provider key is required.

## Versioning

Packages and apps are versioned independently following [Semantic Versioning](https://semver.org/):

| Component | Version Source | Current |
|-----------|---------------|---------|
| `fractal-graph-react-agent` | `packages/python/graphs/react_agent/pyproject.toml` | 0.0.0 |
| `fractal-agent-infra` | `packages/python/infra/fractal_agent_infra/pyproject.toml` | 0.0.0 |
| Python runtime (Docker) | `apps/python/pyproject.toml` | 0.0.0 |
| TypeScript runtime | `apps/ts/package.json` | 0.0.0 |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development workflow, coding standards, and how to add new graphs to the catalog.

## License

[MIT](LICENSE)