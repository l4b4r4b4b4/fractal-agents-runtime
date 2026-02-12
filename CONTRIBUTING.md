# Contributing to Fractal Agents Runtime

Thank you for your interest in contributing! This guide covers development setup, project structure, coding standards, and how to add new agent graphs to the catalog.

## Table of Contents

- [Development Setup](#development-setup)
- [Project Structure](#project-structure)
- [Development Workflow](#development-workflow)
- [Coding Standards](#coding-standards)
- [Adding a New Graph to the Catalog](#adding-a-new-graph-to-the-catalog)
- [Adding Infra Modules](#adding-infra-modules)
- [Testing](#testing)
- [Pull Request Process](#pull-request-process)
- [Architecture Decisions](#architecture-decisions)

---

## Development Setup

### Option A: Nix (recommended)

```bash
git clone https://github.com/l4b4r4b4b4/fractal-agents-runtime.git
cd fractal-agents-runtime
nix develop
```

The Nix dev shell provides Python 3.12, UV, Bun, Docker, Helm, and Lefthook — and automatically runs `uv sync` and `bun install`.

### Option B: Manual

**Prerequisites:** Python 3.12, [UV](https://docs.astral.sh/uv/) ≥ 0.10, [Bun](https://bun.sh/) ≥ 1.1

```bash
git clone https://github.com/l4b4r4b4b4/fractal-agents-runtime.git
cd fractal-agents-runtime

# Root workspace (TypeScript tooling)
bun install

# Python app (resolves graph + infra path dependencies)
cd apps/python
uv sync
cp .env.example .env  # Edit with your API keys
```

### Verify Your Setup

```bash
cd apps/python
uv run pytest          # Should pass 550+ tests
uv run ruff check .    # Should report "All checks passed"
```

---

## Project Structure

The monorepo follows a **3-layer architecture**:

```text
fractal-agents-runtime/
├── packages/python/
│   ├── graphs/                         # Layer 1: Portable agent architectures
│   │   └── react_agent/               #   ReAct agent with MCP tools
│   │       ├── pyproject.toml          #   PyPI: fractal-graph-react-agent
│   │       └── src/react_agent/
│   │           ├── agent.py            #   Graph factory (DI for persistence)
│   │           └── utils/              #   MCP interceptors, token exchange, RAG
│   └── infra/                          # Layer 2: Shared runtime infrastructure
│       └── fractal_agent_infra/        #   PyPI: fractal-agent-infra
│           └── src/fractal_agent_infra/
│               ├── tracing.py          #   Langfuse init + inject_tracing()
│               ├── store_namespace.py  #   Canonical 4-component namespace
│               └── security/auth.py    #   LangGraph SDK auth (Supabase JWT)
├── apps/
│   ├── python/                         # Layer 3: HTTP server (Robyn)
│   │   ├── src/robyn_server/           #   Routes, config, Postgres, wiring
│   │   └── pyproject.toml              #   Depends on graph + infra packages
│   └── ts/                             # TypeScript runtime (Bun)
├── .devops/docker/                     # Multi-stage Dockerfiles
├── .github/workflows/                  # CI/CD pipelines
└── flake.nix                           # Nix dev environment
```

### Dependency Rules

| Direction | Allowed? | Example |
|-----------|----------|---------|
| Graphs → Infra | ✅ Yes | `from fractal_agent_infra.store_namespace import build_namespace` |
| Apps → Graphs | ✅ Yes | `from react_agent import graph` |
| Apps → Infra | ✅ Yes | `from fractal_agent_infra.tracing import inject_tracing` |
| Graphs → Apps | ❌ Never | No `from robyn_server...` in graph code |
| Infra → Apps | ❌ Never | |
| Infra → Graphs | ❌ Never | |

### Dependency Injection

Graphs receive persistence components as parameters — they never import them from a server:

```python
# In the graph package (portable):
async def graph(config: RunnableConfig, *, checkpointer=None, store=None):
    ...
    return agent.compile(checkpointer=checkpointer, store=store)

# In the app (wiring layer):
from robyn_server.database import get_checkpointer, get_store
from react_agent import graph

agent = await graph(config, checkpointer=get_checkpointer(), store=get_store())
```

---

## Development Workflow

### Branch Strategy

- `main` — stable releases only
- `development` — integration branch, PRs merge here
- `feature/*` or `refactor/*` — working branches off `development`

### Day-to-Day Commands

```bash
# Sync dependencies after pulling
cd apps/python && uv sync

# Run tests
uv run pytest

# Lint and format (run before committing)
uv run ruff check . --fix --unsafe-fixes && uv run ruff format .

# Run linting on a specific package
cd packages/python/graphs/react_agent && uv run ruff check .
cd packages/python/infra/fractal_agent_infra && uv run ruff check .
```

### Dependency Management

**Use `uv` exclusively** — never pip or pip-compile.

```bash
# Add a runtime dependency
uv add <package>

# Add a dev dependency
uv add --group dev <package>

# Always commit pyproject.toml + uv.lock together
```

- **Runtime deps** go in `[project.dependencies]`
- **Dev deps** go in `[dependency-groups.dev]`
- **Path deps** between packages use `[tool.uv.sources]`

---

## Coding Standards

### Python

- **Python 3.12** target (supports ≥3.11, <3.13)
- **Ruff** for linting and formatting (`select = ["ALL"]` with tuned ignores)
- **Type annotations** required for all public functions, methods, and classes
- **Pydantic models** for public API data structures
- **Google-style docstrings** with summary, parameters, returns, and exceptions
- **No bare `except:`** — always catch specific exceptions

### Naming

- **No single-letter variable names** — always descriptive
- **No abbreviations** — `user_repository` not `usr_repo`
- **No "Utils" or "Helper" classes** — organize into proper modules

### Before Committing

```bash
cd apps/python
uv run ruff check . --fix --unsafe-fixes && uv run ruff format .
uv run pytest
```

Lefthook runs these automatically on `git commit` and `git push` if installed.

---

## Adding a New Graph to the Catalog

The `packages/python/graphs/` directory is a catalog of portable agent architectures. Here's how to add a new one:

### 1. Scaffold the Package

```bash
mkdir -p packages/python/graphs/my_agent/src/my_agent
mkdir -p packages/python/graphs/my_agent/tests
```

### 2. Create `pyproject.toml`

```toml
[project]
name = "fractal-graph-my-agent"
version = "0.0.0"
description = "My custom agent graph"
requires-python = ">=3.11.0,<3.13"
dependencies = [
    "langgraph>=1.0.8",
    "langchain-core>=1.2.11",
    # Add only what your graph actually imports
    "fractal-agent-infra",  # If you need tracing or store namespace
]

[build-system]
requires = ["setuptools>=75.0", "wheel"]
build-backend = "setuptools.build_meta"

[tool.setuptools.packages.find]
where = ["src"]
include = ["my_agent*"]

[tool.uv.sources]
fractal-agent-infra = { path = "../../infra/fractal_agent_infra", editable = true }
```

### 3. Implement the Graph

Create `src/my_agent/agent.py`:

```python
from langchain_core.runnables import RunnableConfig

async def graph(config: RunnableConfig, *, checkpointer=None, store=None):
    """Build and return a compiled agent graph.

    Args:
        config: LangGraph RunnableConfig with model settings, tool config, etc.
        checkpointer: Optional thread-level persistence (injected by runtime).
        store: Optional cross-thread memory store (injected by runtime).

    Returns:
        A compiled LangGraph agent ready for invocation.
    """
    # Your graph logic here...

    return agent.compile(checkpointer=checkpointer, store=store)
```

**Critical rules:**
- Accept `checkpointer` and `store` as keyword-only arguments with `None` defaults
- **Never** import from `robyn_server` or any app package
- Only import from `fractal_agent_infra` or third-party packages

### 4. Export from `__init__.py`

Create `src/my_agent/__init__.py`:

```python
from importlib.metadata import PackageNotFoundError, version
from my_agent.agent import graph

__all__ = ["graph"]

try:
    __version__ = version("fractal-graph-my-agent")
except PackageNotFoundError:
    __version__ = "0.0.0-dev"
```

### 5. Wire into the App

Add the new graph as a dependency in `apps/python/pyproject.toml`:

```toml
[project]
dependencies = [
    "fractal-graph-my-agent",
    # ...
]

[tool.uv.sources]
fractal-graph-my-agent = { path = "../../packages/python/graphs/my_agent", editable = true }
```

### 6. Verify

```bash
cd packages/python/graphs/my_agent
uv lock && uv sync
uv run ruff check . --fix --unsafe-fixes && uv run ruff format .

cd ../../../../apps/python
uv sync
uv run pytest
```

---

## Adding Infra Modules

The `packages/python/infra/fractal_agent_infra/` package contains shared runtime infrastructure. To add a new module:

1. Create the module in `src/fractal_agent_infra/`
2. Keep it self-contained — no imports from graphs or apps
3. Export public API from `__init__.py` (keep `__all__` alphabetically sorted)
4. Add any new dependencies to `pyproject.toml`
5. Run `uv lock` to update the lockfile

---

## Testing

### Philosophy

We follow a **pragmatic testing** approach: implement → manual test → write tests.

### Rules

- **Test behavior, not implementation** — tests should survive refactoring
- **One thing per test** — focused test cases with clear assertions
- **Deterministic tests** — mock time, randomness, and I/O
- **Test error paths** — exceptions with correct types and messages
- **Critical paths require tests** before merge

### Running Tests

```bash
# Full suite (550+ tests)
cd apps/python && uv run pytest

# Specific test file
uv run pytest src/robyn_server/tests/test_tracing.py -v

# With short traceback
uv run pytest --tb=short

# Package integration tests
uv run pytest tests/test_placeholder.py -v
```

### Test Coverage

Maintain ≥73% code coverage. The test suite covers:
- Agent configuration and graph building
- Streaming and SSE event formatting
- Thread, run, and assistant CRUD operations
- Authentication and authorization middleware
- Tracing integration (Langfuse)
- A2A protocol handling
- Cron scheduling
- Store namespace conventions

---

## Pull Request Process

### Before Opening a PR

1. **Branch off `development`** (not `main`)
2. **Run the full verification suite:**
   ```bash
   # Lint all packages
   cd packages/python/graphs/react_agent && uv run ruff check . --fix --unsafe-fixes && uv run ruff format .
   cd ../../infra/fractal_agent_infra && uv run ruff check . --fix --unsafe-fixes && uv run ruff format .
   cd ../../../../apps/python && uv run ruff check . --fix --unsafe-fixes && uv run ruff format .

   # Run all tests
   cd apps/python && uv run pytest
   ```
3. **Check for stale references** if you moved or renamed packages:
   ```bash
   grep -rn "old_package_name" --include="*.py" --include="*.toml" apps/ packages/
   ```
4. **Commit `pyproject.toml` + `uv.lock` together** for any dependency changes

### PR Guidelines

- Use descriptive commit messages ([Conventional Commits](https://www.conventionalcommits.org/) preferred)
- Keep PRs focused — one logical change per PR
- Update docstrings and README if the public API changed
- Add or update tests for new behavior
- Target `development` as the base branch

### What Reviewers Check

- [ ] Tests pass (550+ in Python suite)
- [ ] Ruff clean (all three packages)
- [ ] No stale import references
- [ ] Dependency rules respected (no graphs → apps imports)
- [ ] Public APIs have docstrings
- [ ] Lock files committed alongside `pyproject.toml` changes

---

## Architecture Decisions

### Why 3 Layers?

The separation enables **portable agent graphs** that can be:
- Deployed to [LangGraph Platform](https://langchain-ai.github.io/langgraph/concepts/langgraph_platform/)
- Embedded in any runtime (Robyn, FastAPI, Lambda, CLI)
- Published independently to PyPI
- Eventually extracted into a separate repository as a git submodule

### Why Dependency Injection for Persistence?

If `graph()` imports `get_checkpointer()` from a specific server, it's coupled to that server. DI makes the graph a pure function of its inputs — the runtime decides how to persist state.

### Why UV over pip?

UV is 10–100× faster, follows PEP 621, provides reproducible lockfiles, and is our single source of truth for dependency management. See the [UV docs](https://docs.astral.sh/uv/).

### Why Ruff `select = ["ALL"]`?

We enable all rules and explicitly ignore the ones that don't fit. This catches issues early and ensures consistency. The ignore list in each `pyproject.toml` documents exactly which rules we've opted out of and why.

---

## Release Process

Releases are triggered by git tags:

| Tag | Published Artifact |
|-----|--------------------|
| `python-graphs-v0.0.1` | `fractal-graph-react-agent` → PyPI |
| `python-runtime-v0.0.1` | Docker image → GHCR |
| `ts-graphs-v0.0.1` | npm package (future) |
| `ts-runtime-v0.0.1` | Docker image → GHCR |

**Version progression:** `0.0.0` → `0.0.x` (patches) → `0.1.0` (after 5–10 patches) → `1.0.0` (production-ready).

Versions must be synchronized between the git tag and `pyproject.toml` / `package.json` — the release workflow verifies this automatically.

---

## Questions?

Open an [issue](https://github.com/l4b4r4b4b4/fractal-agents-runtime/issues) or start a [discussion](https://github.com/l4b4r4b4b4/fractal-agents-runtime/discussions).