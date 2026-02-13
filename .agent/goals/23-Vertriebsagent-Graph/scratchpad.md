# Goal 23: Vertriebsagent Graph (Immobilien-Projektsuche)

> **Status:** ⚪ Not Started
> **Priority:** High
> **Created:** 2026-02-13
> **Depends on:** Goal 22 (Unified Helm Chart) ✅, Goal 20 (Module Rename) ✅
> **Blocks:** AKS deployment verification, v0.0.1 release
> **Branch:** TBD (off `development`)

---

## Problem Statement

A colleague built a standalone "Vertriebsworkflow" — a two-phase real estate project search agent using LangGraph. The code works but is not integrated with the fractal-agents-runtime:

- Hardcoded `dotenv` / `os.getenv()` for all config
- Global `Langfuse()` client + `CallbackHandler()` instantiated at module level
- Direct `ChatOpenAI` instantiation (no multi-provider support)
- No Postgres persistence (no checkpointer/store)
- No auth/user scoping
- Imports use `src.models.*`, `src.prompts.*`, `src.workflow.*` — not portable
- No tests
- Uses Tavily web search (new dependency for the runtime)

The goal is to integrate this as a second graph in `apps/python/src/graphs/vertriebsagent/`, following the same dependency rules and DI patterns as `react_agent`.

---

## Research: Existing Vertriebsworkflow

### Source: `.agent/Vertriebsworkflow/`

### Architecture

Two-phase workflow with parallel workers via LangGraph `Send` API:

```
Phase 1 (Broad Search):
  START → analyzer_ph1 (LLM: 5 tasks by asset class)
       → [Send] workers (parallel, each with subgraph)
       → aggregator_ph1 (collect ~30-40 projects)
       → phase_router → "continue_phase2"

Phase 2 (Validation):
  set_phase2 → analyzer_ph2 (Python: chunk projects into workers)
            → [Send] workers (parallel, validation subgraph)
            → aggregator_ph2 (LLM: select best 15-20)
            → JSON export → END
```

### Worker Subgraph (iterative search-verification)

```
START → worker_query (LLM: generate search queries)
     → [Send] tavily_search (parallel per query)
     → verifier (LLM: evaluate query quality)
     → route: retry (max 2 PH1, 1 PH2) or → worker_final (LLM: extract projects)
     → END
```

### Key Components

| Component | File | Description |
|-----------|------|-------------|
| Main graph | `src/workflow/graph.py` | `WorkflowState`, analyzer, aggregator, phase router, `create_workflow()` |
| Worker subgraph | `src/workflow/worker_subgraph.py` | `WorkerSubgraphState`, query gen, tavily search, verifier, final |
| Main models | `src/models/main_models.py` | `ProjectData`, `AnalyzerOutput`, `AggregatorPhase2Output`, `Subtask` |
| Worker models | `src/models/worker_models.py` | `SearchQuery`, `TavilySearchResult`, `VerifierOutput`, `WorkerFinalOutput` |
| Main prompts | `src/prompts/main_prompts.py` | `ANALYZER_PHASE1_PROMPT`, `AGGREGATOR_PHASE2_PROMPT` |
| Worker prompts | `src/prompts/worker_prompts.py` | 6 prompts: query/verifier/final × phase1/phase2 |
| Logger | `src/utils/logger.py` | Custom logging setup |

### State Schema

**WorkflowState (main):**
- `user_input`, `stadt`, `current_phase` ("phase1"/"phase2")
- `task_list`, `worker_task`, `worker_results` (Annotated with `add` reducer)
- `phase1_projects`, `final_projects`, `final_result`, `session_id`

**WorkerSubgraphState:**
- Input: `worker_task`, `session_id`
- Internal: `search_queries`, `search_results` (add reducer), `search_history`, `iteration_count`, `quality_verified`, `good_query_ids`
- Output: `worker_results` (via `WorkerSubgraphOutputState`)

### Dependencies (new for the runtime)

- `langchain-tavily` — Tavily web search tool
- `tavily-python` — Tavily API client (transitive)
- Env var: `TAVILY_API_KEY`

### What Needs to Change for Integration

| Current (standalone) | Target (integrated) |
|---------------------|---------------------|
| `from src.models.*` | `from graphs.vertriebsagent.models.*` |
| `from src.prompts.*` | `from graphs.vertriebsagent.prompts.*` |
| `from src.workflow.*` | Internal imports within the graph |
| `load_dotenv()` + `os.getenv()` | Config via `RunnableConfig` configurable |
| Global `Langfuse()` client | Use `infra.tracing.inject_tracing()` |
| Global `CallbackHandler()` | Callbacks from config (runtime injects) |
| `ChatOpenAI(model=...)` hardcoded | `init_chat_model()` multi-provider (from config) |
| No checkpointer/store | DI via `graph(config, checkpointer=..., store=...)` |
| `_export_json()` to filesystem | Return results in state (server decides storage) |
| Module-level `tavily_tool = TavilySearch(...)` | Create per-invocation from config |

---

## Solution Design

### Directory Structure

```
apps/python/src/graphs/vertriebsagent/
├── __init__.py              # Exports graph() factory
├── graph.py                 # Main two-phase workflow (create_workflow)
├── worker_subgraph.py       # Worker search-verification subgraph
├── models/
│   ├── __init__.py
│   ├── main_models.py       # ProjectData, AnalyzerOutput, AggregatorPhase2Output
│   └── worker_models.py     # SearchQuery, VerifierOutput, WorkerFinalOutput
└── prompts/
    ├── __init__.py
    ├── main_prompts.py       # Analyzer + Aggregator prompts
    └── worker_prompts.py     # Worker query/verifier/final prompts (×2 phases)
```

### Graph Factory Pattern

```python
# graphs/vertriebsagent/__init__.py
from graphs.vertriebsagent.graph import create_workflow

def graph(config: RunnableConfig, *, checkpointer=None, store=None):
    """Build the Vertriebsagent workflow graph.

    Args:
        config: Must contain configurable keys:
            - model_name: LLM model (default: gpt-4o-mini)
            - tavily_api_key: Tavily search API key
            - temperature: LLM temperature (default: 0.0)
        checkpointer: Optional LangGraph checkpointer for state persistence
        store: Optional LangGraph store for cross-thread memory

    Returns:
        Compiled StateGraph ready for invocation.
    """
    return create_workflow(checkpointer=checkpointer, store=store)
```

### Config Propagation

Instead of `os.getenv()`, read from `RunnableConfig.configurable`:

```python
def get_llm(config: RunnableConfig):
    configurable = config.get("configurable", {})
    model_name = configurable.get("model_name", "gpt-4o-mini")
    temperature = configurable.get("temperature", 0.0)
    return init_chat_model(model_name, temperature=temperature)
```

### Tracing Integration

Remove all manual `Langfuse()` / `CallbackHandler()` usage. Instead:
- Tracing is injected by the server via `infra.tracing.inject_tracing()`
- Callbacks flow through `config["callbacks"]` automatically
- No graph-level tracing code needed

### JSON Export

The standalone workflow writes to filesystem (`_export_json()`). In the integrated version:
- Return `final_projects` in state — the server/caller decides what to do with results
- The JSON export becomes an optional server-side action, not a graph concern

---

## Task Breakdown

### Task-01: Scaffold + Models

- Create directory structure under `apps/python/src/graphs/vertriebsagent/`
- Copy and adapt Pydantic models (fix imports, add docstrings)
- Copy prompts (no changes needed, they're just strings)
- Create `__init__.py` with `graph()` factory stub
- Add `langchain-tavily` dependency via `uv add`

### Task-02: Worker Subgraph

- Port `worker_subgraph.py` → `graphs/vertriebsagent/worker_subgraph.py`
- Replace `os.getenv()` with config-based LLM creation
- Replace global `Langfuse()` / `CallbackHandler()` with config callbacks
- Replace module-level `tavily_tool` with per-invocation creation
- Pass `config` through all node functions
- Keep the `WorkerSubgraphState` / `WorkerSubgraphOutputState` split

### Task-03: Main Graph

- Port `graph.py` → `graphs/vertriebsagent/graph.py`
- Replace all config/tracing patterns (same as Task-02)
- Remove `_export_json()` — return results in state
- Remove `run_workflow()` — the server handles invocation
- Wire `create_workflow(checkpointer, store)` with DI
- Implement `graph()` factory in `__init__.py`

### Task-04: Server Wiring

- Register vertriebsagent as an available graph in `server/agent.py`
- Add assistant config support (model, tavily_api_key, etc.)
- Add `TAVILY_API_KEY` to Helm chart values + deployment template
- Update `.env.example` with Tavily key

### Task-05: Tests

- Unit tests for models (Pydantic validation)
- Unit tests for worker subgraph nodes (mocked LLM + Tavily)
- Unit tests for main graph routing logic (phase router, should_continue)
- Integration test for full graph compilation

---

## Acceptance Criteria

- [ ] `from graphs.vertriebsagent import graph` works
- [ ] Graph compiles without errors: `graph(config)` returns a compiled StateGraph
- [ ] No `os.getenv()`, `dotenv`, or `Langfuse()` in graph code
- [ ] No `from server.*` imports in graph code
- [ ] Tracing flows through config callbacks (not manual Langfuse)
- [ ] LLM provider configurable via `RunnableConfig` (not hardcoded ChatOpenAI)
- [ ] `helm template` renders `TAVILY_API_KEY` env var for Python runtime
- [ ] Tests pass for models, subgraph, and main graph
- [ ] Worker subgraph parallelism works (Send API)
- [ ] Phase routing works (phase1 → phase2 → END)

---

## Constraints

- **No filesystem writes** — graph returns results in state, not JSON files
- **No global state** — no module-level Langfuse clients or Tavily tools
- **Dependency rules** — `graphs/vertriebsagent/` must never import from `server/`
- **Config-driven** — all secrets and model config via `RunnableConfig.configurable`
- **Backwards compatible** — existing `react_agent` graph must not be affected

---

## Risk Assessment

- **Medium risk:** The Send API (parallel workers) + subgraph pattern is complex. Need to verify it works with checkpointer/store DI.
- **Low risk:** Tavily is a well-supported LangChain integration. Adding the dependency is straightforward.
- **Low risk:** Models and prompts are pure data — copying them is safe.
- **Medium risk:** The original code has several TODOs and unfinished aspects (noted by the colleague). We should port what works, not fix their design issues.

---

## Open Questions

1. **Should the graph support both phases in a single invocation, or expose them separately?**
   - **Decision:** Keep as single invocation (matches the original design). The graph handles phase routing internally.

2. **How to handle Tavily API key — via env var or assistant config?**
   - **Decision:** Both. Env var as default (`TAVILY_API_KEY`), overridable via assistant `configurable.tavily_api_key`.

3. **Should we fix the colleague's TODOs during integration?**
   - **Decision:** No. Port what works. File issues for improvements. The colleague's TODOs are design questions for them to resolve.

4. **Does this graph need the Store (cross-thread memory)?**
   - **Decision:** Not currently. The workflow is stateless between invocations. Accept `store` parameter for future use but don't use it yet.