# Fractal Agents Runtime

A polyglot monorepo providing LangGraph-based AI agent runtimes with MCP (Model Context Protocol) tool integration, RAG capabilities, and a production-ready HTTP server.

## Architecture

```text
fractal-agents-runtime/
├── apps/
│   ├── python/          # Python runtime (Robyn HTTP server + LangGraph agent)
│   └── ts/              # TypeScript runtime (Bun HTTP server + LangGraph agent)
├── packages/            # Shared libraries (future)
├── docs/                # Monorepo-level documentation
├── .github/workflows/   # CI/CD pipelines
└── flake.nix            # Nix dev environment
```

### Apps

| App | Stack | Description |
|-----|-------|-------------|
| `apps/python` | Python 3.12, Robyn, LangGraph, UV | Production runtime — ReAct agent with MCP tools, Supabase RAG, A2A protocol, cron scheduling, Postgres checkpointing |
| `apps/ts` | Bun, TypeScript, LangGraph JS | TypeScript runtime — Core LangGraph API subset (v0.0.0 is a pipeline-validation stub) |

### Key Features (Python Runtime)

- **ReAct Agent with MCP Tools** — Dynamically loads tools from remote MCP servers
- **Supabase RAG Integration** — LangConnect-based retrieval-augmented generation
- **Robyn HTTP Server** — Implements the LangGraph API (threads, runs, assistants, store, streaming)
- **A2A Protocol** — Agent-to-Agent communication support
- **Cron Scheduling** — APScheduler-based recurring agent invocations
- **Postgres Checkpointing** — Durable conversation state via `langgraph-checkpoint-postgres`
- **OpenAPI Spec** — Auto-generated and served at `/openapi.json`
- **Helm Chart** — Production Kubernetes deployment included
- **Langfuse Tracing** — Optional observability integration

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

# Python app
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
# Python
cd apps/python
uv run pytest

# TypeScript
cd apps/ts
bun test

# Linting (Python)
cd apps/python
uv run ruff check .
uv run ruff format --check .
```

## Monorepo Tooling

| Tool | Purpose |
|------|---------|
| [Bun Workspaces](https://bun.sh/docs/install/workspaces) | Monorepo workspace management |
| [UV](https://docs.astral.sh/uv/) | Python dependency management (10-100x faster than pip) |
| [Ruff](https://docs.astral.sh/ruff/) | Python linting & formatting |
| [Lefthook](https://github.com/evilmartians/lefthook) | Git hooks (pre-commit lint, pre-push test) |
| [Nix Flakes](https://nixos.wiki/wiki/Flakes) | Reproducible dev environment |

## CI/CD Pipeline

Two-branch strategy: `feature` → `development` → `main`

| Trigger | Actions |
|---------|---------|
| Push to feature branch | CI checks + feature image build (`sha-<short>`) |
| Merge to `development` | CI checks + dev image build (`development` tag) |
| Merge to `main` | CI checks + release image build (`latest`, `vX.Y.Z`) + PyPI/npm publish |

Docker images are published to GitHub Container Registry (GHCR):
- `ghcr.io/l4b4r4b4b4/fractal-agents-runtime-python`
- `ghcr.io/l4b4r4b4b4/fractal-agents-runtime-ts`

## Environment Variables

The Python runtime requires several environment variables. See `apps/python/.env.example` for the full list. Key variables:

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes* | Anthropic Claude API key |
| `OPENAI_API_KEY` | Yes* | OpenAI API key |
| `MCP_SERVERS` | No | JSON list of MCP server configurations |
| `SUPABASE_URL` | No | Supabase project URL (for RAG) |
| `SUPABASE_SERVICE_ROLE_KEY` | No | Supabase service role key |
| `POSTGRES_URI` | No | PostgreSQL connection string (for checkpointing) |
| `LANGFUSE_SECRET_KEY` | No | Langfuse tracing secret key |
| `LANGFUSE_PUBLIC_KEY` | No | Langfuse tracing public key |

\* At least one LLM provider key is required.

## Versioning

Each app is versioned independently following [Semantic Versioning](https://semver.org/):

- **Python runtime:** Version in `apps/python/pyproject.toml`
- **TypeScript runtime:** Version in `apps/ts/package.json`

Tags follow the pattern `python-vX.Y.Z` and `ts-vX.Y.Z`.

## License

[MIT](LICENSE)