# Task-03: Wire Dependencies & Update Imports

> **Status:** 🟢 Complete
> **Parent:** [Goal 19 — Package Structure Refactor](../scratchpad.md)
> **Phase:** 2 (3-Layer Split)
> **Depends on:** Task-01 (Graph Package) ✅, Task-02 (Infra Package) ✅
> **Completed:** 2026-02-12 — Session 5

---

## Objective

Update all import paths across the codebase to use the new 3-layer packages. This is the most invasive task — it touches every file that previously imported from `fractal_agent_runtime`. The key changes are:

1. **Graph imports** → `from react_agent import ...`
2. **Infra imports** → `from fractal_agent_infra import ...`
3. **DI wiring** — runtime passes `checkpointer`/`store` to `graph()` instead of graph reaching into the server

---

## Implementation Plan

### Step 1: Update `apps/python/pyproject.toml`

Replace the single `fractal-agent-runtime` path dependency with two new ones:

```toml
[project]
dependencies = [
    # Graph package (the agent architecture)
    "fractal-graph-react-agent",
    # Infra package (tracing, auth, store namespace)
    "fractal-agent-infra",
    # ... rest of deps unchanged ...
]

[tool.uv.sources]
fractal-graph-react-agent = { path = "../../packages/python/graphs/react_agent", editable = true }
fractal-agent-infra = { path = "../../packages/python/infra/fractal_agent_infra", editable = true }
```

Also remove the old `fractal-agent-runtime` entry from both `[project.dependencies]` and `[tool.uv.sources]`.

### Step 2: Update `robyn_server` Imports

#### `apps/python/src/robyn_server/app.py`

```
# BEFORE:
from fractal_agent_runtime.tracing import (
    initialize_langfuse,
    is_langfuse_enabled,
    shutdown_langfuse,
)

# AFTER:
from fractal_agent_infra.tracing import (
    initialize_langfuse,
    is_langfuse_enabled,
    shutdown_langfuse,
)
```

#### `apps/python/src/robyn_server/agent.py`

```
# BEFORE:
from fractal_agent_runtime.tracing import inject_tracing
...
from fractal_agent_runtime.agent import graph as build_agent_graph

# AFTER:
from fractal_agent_infra.tracing import inject_tracing
...
from react_agent import graph as build_agent_graph
```

**Critical DI change** — where `build_agent_graph(config)` is called, it must now pass checkpointer and store:

```python
# BEFORE (graph imports its own checkpointer/store internally):
agent = await build_agent_graph(config)

# AFTER (runtime injects them):
from robyn_server.database import get_checkpointer, get_store

agent = await build_agent_graph(
    config,
    checkpointer=get_checkpointer(),
    store=get_store(),
)
```

#### `apps/python/src/robyn_server/routes/streams.py`

```
# BEFORE:
from fractal_agent_runtime.agent import graph as build_agent_graph
from fractal_agent_runtime.tracing import inject_tracing

# AFTER:
from react_agent import graph as build_agent_graph
from fractal_agent_infra.tracing import inject_tracing
```

Same DI change as `agent.py` — pass `checkpointer` and `store` to `build_agent_graph()` calls.

#### `apps/python/src/robyn_server/auth.py`

Check if this file imports from `fractal_agent_runtime`. If so, update. Based on Phase 1 grep, `robyn_server/auth.py` does NOT import from the package — it only imports from `robyn_server.config` and `supabase`. **No changes needed.**

#### `apps/python/src/robyn_server/agent_sync.py`

Check imports. Based on Phase 1 grep, `agent_sync.py` does NOT import from `fractal_agent_runtime`. **No changes needed.**

### Step 3: Update Test Imports

#### `apps/python/src/robyn_server/tests/test_tracing.py`

This file has ~20 imports from `fractal_agent_runtime.tracing` and patches like `fractal_agent_runtime.tracing.is_langfuse_configured`. All must change:

```
# BEFORE:
from fractal_agent_runtime.tracing import (...)
from fractal_agent_runtime import tracing
patch("fractal_agent_runtime.tracing.is_langfuse_configured", ...)
patch("fractal_agent_runtime.tracing.get_langfuse_callback_handler", ...)

# AFTER:
from fractal_agent_infra.tracing import (...)
from fractal_agent_infra import tracing
patch("fractal_agent_infra.tracing.is_langfuse_configured", ...)
patch("fractal_agent_infra.tracing.get_langfuse_callback_handler", ...)
```

#### `apps/python/tests/test_placeholder.py`

```
# BEFORE:
from fractal_agent_runtime import agent
from fractal_agent_runtime.agent import graph
from fractal_agent_runtime import __version__
from fractal_agent_runtime.tracing import (...)
from fractal_agent_runtime.utils.store_namespace import (...)

# AFTER:
from react_agent import graph
from react_agent import __version__  # (or from react_agent.agent import graph)
from fractal_agent_infra.tracing import (...)
from fractal_agent_infra.store_namespace import (...)
```

### Step 4: Update Graph-Internal Imports (in `react_agent/`)

These should already be done in Task-01, but verify:

```
# In react_agent/utils/token.py:
# BEFORE: from fractal_agent_runtime.utils.store_namespace import ...
# AFTER:  from fractal_agent_infra.store_namespace import ...

# In react_agent/agent.py:
# BEFORE: from fractal_agent_runtime.utils.mcp_interceptors import ...
# AFTER:  from react_agent.utils.mcp_interceptors import ...
```

### Step 5: Run `uv sync` and Verify Resolution

```bash
cd apps/python && uv sync
# Should install both fractal-graph-react-agent and fractal-agent-infra from local paths
```

---

## Files Modified (Summary)

| File | What Changes |
|------|-------------|
| `apps/python/pyproject.toml` | Replace `fractal-agent-runtime` dep with `fractal-graph-react-agent` + `fractal-agent-infra` |
| `apps/python/src/robyn_server/app.py` | `fractal_agent_runtime.tracing` → `fractal_agent_infra.tracing` |
| `apps/python/src/robyn_server/agent.py` | Import path changes + **DI: pass checkpointer/store to graph()** |
| `apps/python/src/robyn_server/routes/streams.py` | Import path changes + **DI: pass checkpointer/store to graph()** |
| `apps/python/src/robyn_server/tests/test_tracing.py` | All `fractal_agent_runtime.tracing` → `fractal_agent_infra.tracing` (imports + patches) |
| `apps/python/tests/test_placeholder.py` | All `fractal_agent_runtime` → `react_agent` / `fractal_agent_infra` |
| `apps/python/tests/__init__.py` | Update docstring if it mentions `fractal_agent_runtime` |

---

## DI Wiring Detail

The dependency injection change is the most important part of this task. Currently, `graph()` in `agent.py` has a `try/except ImportError` block at the bottom that lazily imports from `robyn_server.database`. After this task:

1. **`react_agent/agent.py`** — `graph()` signature becomes `async def graph(config, *, checkpointer=None, store=None)`
2. **`robyn_server/agent.py`** — `execute_agent_run()` calls `graph(config, checkpointer=..., store=...)`
3. **`robyn_server/routes/streams.py`** — streaming endpoint calls `graph(config, checkpointer=..., store=...)`

Both `robyn_server/agent.py` and `routes/streams.py` already import from `robyn_server.storage` / `robyn_server.database`. They have access to the checkpointer and store — they just need to pass them through.

### Finding All Call Sites

Use grep to find every place `graph()` / `build_agent_graph()` is called:

```bash
grep -rn "build_agent_graph\|graph(config" apps/python/src/robyn_server/
```

Each call site needs the `checkpointer=` and `store=` kwargs added.

---

## Acceptance Criteria

- [x] `apps/python/pyproject.toml` depends on `fractal-graph-react-agent` + `fractal-agent-infra` (not `fractal-agent-runtime`)
- [x] Zero imports of `fractal_agent_runtime` anywhere in the codebase (grep confirms — 0 matches across apps/, packages/python/graphs/, packages/python/infra/, .devops/, .github/)
- [x] `graph()` receives `checkpointer` and `store` via DI at every call site (2 call sites: `robyn_server/agent.py` L244, `robyn_server/routes/streams.py` L615)
- [x] `uv sync` resolves both path dependencies correctly (`Added fractal-agent-infra v0.0.0`, `Added fractal-graph-react-agent v0.0.0`, `Removed fractal-agent-runtime v0.0.0`)
- [x] `uv run pytest` — 550 tests pass (7.79s)
- [x] `uv run ruff check .` — all checks pass (53 files unchanged)

---

## Risk: Test Patches

The `test_tracing.py` file uses `unittest.mock.patch()` with string paths like `"fractal_agent_runtime.tracing.is_langfuse_configured"`. These are easy to miss because they're strings, not imports — they won't cause `ImportError` but will silently patch the wrong thing (causing tests to fail with confusing errors). Do a thorough find-and-replace of ALL `"fractal_agent_runtime` string occurrences.

---

## Implementation Notes (Session 5)

- **Files modified (7):** `apps/python/pyproject.toml`, `robyn_server/app.py`, `robyn_server/agent.py`, `robyn_server/routes/streams.py`, `robyn_server/auth.py` (docstring only), `robyn_server/agent_sync.py` (docstring only), `robyn_server/tests/test_tracing.py`
- **Test file (`test_tracing.py`) had ~30 `fractal_agent_runtime` references** — bulk-updated via sed (`fractal_agent_runtime.tracing` → `fractal_agent_infra.tracing`, `from fractal_agent_runtime import tracing` → `from fractal_agent_infra import tracing`)
- **Placeholder tests (`tests/test_placeholder.py`) rewritten** — split into `TestGraphPackageIntegration` (react_agent), `TestInfraPackageIntegration` (fractal_agent_infra), and `TestGraphInvocation` (skipped). All 6+1 pass.
- **DI wiring was surgical:** both call sites already had access to `robyn_server.database` — just needed `from robyn_server.database import get_checkpointer, get_store` and adding kwargs to the `build_agent_graph()` call
- **`uv lock` output confirmed clean swap:** `Removed fractal-agent-runtime v0.0.0`, `Added fractal-agent-infra v0.0.0`, `Added fractal-graph-react-agent v0.0.0`
- Risk of silent patch failures in test_tracing.py (string-based `@patch` paths) was mitigated by comprehensive sed replacement — all 550 tests pass confirming patches target correct modules
