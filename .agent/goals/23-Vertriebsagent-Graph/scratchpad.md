# Goal 23: Research Agent Graph (Parallel Research with Human-in-the-Loop)

> **Status:** 🟢 Complete
> **Priority:** High
> **Created:** 2026-02-13
> **Updated:** 2026-02-14 (Session 14 — tests complete, all acceptance criteria met)
> **Depends on:** Goal 22 (Unified Helm Chart) ✅, Goal 20 (Module Rename) ✅, Goal 24 Task-01 ✅
> **Blocks:** AKS deployment verification, v0.0.1 release
> **Branch:** `fix/merge-main-into-development`

---

## Problem Statement

The BPMN `.agent/Vertriebsprozess.bpmn` describes a structured sales workflow with parallel research agents, human review loops, and iterative refinement. Currently no graph in the runtime implements this pattern — only the simple ReAct loop (`react_agent`) exists.

The goal is to implement the BPMN's research-and-review pattern as a **generic, reusable** LangGraph graph that:

- Runs parallel research workers (mini ReAct agents)
- Aggregates results via LLM
- Pauses for human-in-the-loop review (LangGraph `interrupt`)
- Supports iterative refinement based on human feedback
- Gets all domain specificity from **prompts** (Langfuse) and **tools** (MCP), not code

A "Vertriebsagent" is just an **assistant instance** that uses this graph with German real-estate prompts and Tavily MCP tools. The same graph could power an English market-research assistant with different prompts and tools.

---

## Architecture Decision: Abstract Flow, External Specialisation

### Key Principles (from user direction, Session 13)

| Principle | Implication |
|-----------|-------------|
| Graphs are abstract async agentic flows | No domain-specific models or logic in graph code |
| Domain specificity from prompts | Generic English defaults in code; German real-estate prompts in Langfuse |
| Tooling NOT encoded in graph | No `langchain-tavily` dependency; tools come from MCP config per assistant |
| Same tool assignment as react_agent | MCP servers configured per assistant; graph uses whatever's available |

### What this means concretely

- **Graph directory:** `graphs/research_agent/` (not `vertriebsagent`)
- **Graph ID:** `research_agent` (assistants reference this in `graph_id`)
- **No new deps:** Same MCP tool pattern as react_agent — no langchain-tavily
- **Workers are mini ReAct agents:** Each worker = `create_agent(model, tools, task_prompt)` using the assistant's MCP tools
- **Prompts are generic defaults:** "You are a research analyst. Break the query into tasks." — Langfuse provides the domain-specific versions

### Separation of concerns

```
Code (graph):     Flow pattern — analyze → parallel workers → aggregate → review → refine
Config (assistant): LLM model, MCP servers/tools, RAG collections
Prompts (Langfuse): Domain-specific instructions in any language
```

---

## BPMN → LangGraph Mapping

### BPMN elements mapped to LangGraph primitives

| BPMN Element | BPMN Name | LangGraph Primitive |
|--------------|-----------|-------------------|
| startEvent | (start) | `START` edge |
| serviceTask (parallel) | Research Agent Alex/Markus | `Send` API → worker nodes (parallel) |
| userTask | Ergebnis prüfen | `interrupt()` — human review node |
| exclusiveGateway | Ergebnis ok? | `Command(goto=...)` — route approve/adjust |
| sequenceFlow (loop) | Nein, anpassen | `Command(goto="analyzer_phase1")` — loop back |
| sequenceFlow (forward) | Ja | `Command(goto="set_phase2")` — proceed |
| subProcess | (phase 2 refinement) | Phase 2 nodes in same graph |
| endEvent | (end) | `END` edge |

### Full graph flow

```
START
  → analyzer_phase1 (LLM: break query into SearchTasks)
  → [Send] worker_phase1 (parallel mini ReAct agents with MCP tools)
  → aggregator_phase1 (LLM: combine results)
  → review_phase1 (interrupt: human reviews results)
      ├── Command(goto="analyzer_phase1") if "adjust" + feedback
      └── Command(goto="set_phase2") if "approve"

  set_phase2 (transition: phase marker + carry forward approved results)
  → analyzer_phase2 (LLM: create validation/refinement tasks)
  → [Send] worker_phase2 (parallel mini ReAct agents)
  → aggregator_phase2 (LLM: final selection/ranking)
  → review_phase2 (interrupt: human reviews final selection)
      ├── Command(goto="aggregator_phase2") if "adjust" + feedback
      └── Command(goto=END) if "approve"
```

### HIL interrupt pattern (from LangGraph docs)

```python
from langgraph.types import interrupt, Command

def review_node(state: WorkflowState) -> Command[Literal["analyzer_phase1", "set_phase2"]]:
    decision = interrupt({
        "type": "review_results",
        "phase": state["current_phase"],
        "results": state["phase1_results"],
        "message": "Review the research results. Approve or provide feedback.",
    })

    if isinstance(decision, dict) and decision.get("approved"):
        return Command(goto="set_phase2", update={"review_feedback": ""})
    else:
        feedback = decision.get("feedback", "") if isinstance(decision, dict) else str(decision)
        return Command(goto="analyzer_phase1", update={"review_feedback": feedback})
```

Resume from caller:
```python
# Approve
graph.invoke(Command(resume={"approved": True}), config=config)

# Adjust with feedback
graph.invoke(Command(resume={"approved": False, "feedback": "Focus more on logistics projects"}), config=config)
```

### Worker pattern (ReAct agent as Send node)

Each worker is a `create_agent()` call inside a Send node. The tools and model are captured via closure from the `graph()` factory:

```python
async def graph(config, *, checkpointer=None, store=None):
    tools = [...]  # resolved from MCP config
    model = init_chat_model(...)

    async def worker_node(state: WorkerState):
        task = state["task"]
        phase = state.get("phase", "phase1")

        worker_prompt = get_prompt(
            f"research-agent-worker-{phase}",
            fallback=DEFAULT_WORKER_PROMPTS[phase],
            config=config,
        )

        worker_agent = create_agent(
            model=model,
            tools=tools,
            system_prompt=f"{worker_prompt}\n\nTask: {task['description']}",
        )

        result = await worker_agent.ainvoke(
            {"messages": [HumanMessage(content=task["search_focus"])]},
        )

        return {"worker_results": [extract_worker_output(result)]}

    # Build StateGraph using worker_node...
```

### Two worker node names for two phases

The Send API routes all instances of a named node to the same next edge. Since phase 1 and phase 2 route to different aggregators, we use two node names that share the same function:

```python
builder.add_node("worker_phase1", worker_node)
builder.add_node("worker_phase2", worker_node)  # same function

# Phase 1: worker_phase1 → aggregator_phase1
builder.add_edge("worker_phase1", "aggregator_phase1")

# Phase 2: worker_phase2 → aggregator_phase2
builder.add_edge("worker_phase2", "aggregator_phase2")
```

---

## Directory Structure

```
apps/python/src/graphs/research_agent/
├── __init__.py              # graph() factory — async, same signature as react_agent
├── configuration.py         # Pydantic config (LLM, MCP, research-specific settings)
├── graph.py                 # Main two-phase StateGraph with HIL
├── worker.py                # Worker output extraction utilities
├── models.py                # Generic models (SearchTask, ResearchResult, ReviewDecision)
└── prompts.py               # 6 default prompts + register_default_prompt() calls
```

Intentionally flat — no `models/` or `prompts/` subdirectories. The graph is generic; there's not enough domain-specific content to warrant deeper nesting.

---

## Models (Generic)

```python
class SearchTask(BaseModel):
    """A single unit of work for a research worker."""
    task_id: str
    description: str          # What to research
    search_focus: str         # Specific angle or question
    constraints: dict[str, str] = Field(default_factory=dict)  # Optional constraints

class ResearchResult(BaseModel):
    """A single finding from the research process."""
    title: str
    summary: str
    source_url: str | None = None
    relevance_score: float | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)  # Domain-specific data

class AnalyzerOutput(BaseModel):
    """Structured output from the analyzer LLM call."""
    tasks: list[SearchTask]
    reasoning: str            # Why these tasks were chosen

class AggregatorOutput(BaseModel):
    """Structured output from the aggregator LLM call."""
    results: list[ResearchResult]
    summary: str              # Overall synthesis
    total_sources_reviewed: int
```

Note: No `ProjectData`, `asset_klasse`, `stadt`, etc. — those are domain concerns expressed in prompts and returned as `metadata` dict fields.

---

## State Design

### WorkflowState (main graph)

```python
class WorkflowState(TypedDict):
    # Input
    messages: Annotated[list[AnyMessage], add_messages]  # Conversation history
    user_input: str                                       # Original query

    # Phase tracking
    current_phase: str                                    # "phase1" or "phase2"

    # Phase 1
    task_list: list[dict]                                 # SearchTasks from analyzer
    worker_results: Annotated[list[dict], operator.add]   # Parallel workers write here
    phase1_results: list[dict]                            # Aggregated phase 1 results

    # Phase 2
    final_results: list[dict]                             # Aggregated phase 2 results
    final_summary: str                                    # Final synthesis

    # Review
    review_feedback: str                                  # Human feedback (if adjusting)
```

### WorkerState (Send API input)

```python
class WorkerState(TypedDict):
    task: dict                                            # The SearchTask for this worker
    phase: str                                            # "phase1" or "phase2"
    worker_results: Annotated[list[dict], operator.add]   # Output key (shared with parent)
```

---

## Prompts (6 LLM prompts, all via `get_prompt()`)

| # | Langfuse Name | Purpose | Default (generic English) |
|---|--------------|---------|--------------------------|
| 1 | `research-agent-analyzer-phase1` | Break query into search tasks | "You are a research analyst. Decompose the user's query into 3-5 independent search tasks..." |
| 2 | `research-agent-analyzer-phase2` | Create validation tasks from phase 1 results | "You are a research analyst. Given these preliminary results, create tasks to validate and deepen..." |
| 3 | `research-agent-worker-phase1` | Worker system prompt for broad search | "You are a research worker. Use the available tools to thoroughly research your assigned task..." |
| 4 | `research-agent-worker-phase2` | Worker system prompt for validation | "You are a research validator. Verify and enrich the preliminary findings for your task..." |
| 5 | `research-agent-aggregator-phase1` | Combine phase 1 worker results | "You are a research aggregator. Combine the results from multiple workers into a cohesive list..." |
| 6 | `research-agent-aggregator-phase2` | Final selection and ranking | "You are a research synthesizer. From the validated results, select and rank the most relevant..." |

All registered via `register_default_prompt()` in `prompts.py` for auto-seeding in Langfuse.

### Domain override example (Vertriebsagent in Langfuse)

The Vertriebsagent domain expert sets these in Langfuse UI — zero code changes:

- `research-agent-analyzer-phase1` → "Du bist ein Supervisor-Agent für Immobilien-Projektsuche. Analysiere die Anfrage und erstelle 5 Suchaufträge nach Asset-Klasse: Büro, Wohnen, Hotel, Logistik, Einzelhandel..."
- `research-agent-worker-phase1` → "Du bist ein Recherche-Agent. Nutze die verfügbaren Tools um aktuelle Immobilienprojekte in {{stadt}} zu finden..."

---

## Configuration

```python
class ResearchAgentConfig(BaseModel):
    """Configuration for the research agent graph."""
    # LLM (same pattern as react_agent)
    model_name: str = "openai:gpt-4o-mini"
    temperature: float = 0.0
    max_tokens: int | None = None
    base_url: str | None = None
    custom_model_name: str | None = None
    custom_api_key: str | None = None

    # MCP tools (same structure as react_agent)
    mcp_config: MCPConfig | None = None

    # RAG (same structure as react_agent)
    rag: RagConfig | None = None

    # Research-specific
    max_worker_iterations: int = 15        # Max ReAct steps per worker agent
    auto_approve_phase1: bool = False      # Skip HIL for phase 1 (testing/automation)
    auto_approve_phase2: bool = False      # Skip HIL for phase 2

    # System prompt (optional override, same as react_agent)
    system_prompt: str | None = None
```

---

## Task Breakdown

### Task-01: Scaffold + Models + Prompts + Configuration 🟢 Complete

- [x] Update scratchpad with revised architecture
- [x] Create directory structure: `graphs/research_agent/`
- [x] `models.py` — SearchTask, ResearchResult, AnalyzerOutput, AggregatorOutput (all generic, domain-agnostic, metadata dict for domain fields)
- [x] `prompts.py` — 6 default prompts + `register_default_prompt()` calls (generic English defaults, domain via Langfuse)
- [x] `configuration.py` — ResearchAgentConfig with LLM/MCP/RAG config + research-specific fields (max_worker_iterations, auto_approve_phase1/2)
- [x] `__init__.py` — full `graph()` factory with MCP tool + LLM resolution

### Task-02: Worker Logic 🟢 Complete

- [x] `worker.py` — `extract_worker_output()` utility with multi-strategy extraction (JSON parse, regex, code-fence, plain-text fallback)
- [x] Worker node function as closure over tools + model (inside `graph.py`)
- [ ] Test worker extraction with mocked agent output (**remaining — tests not yet written**)

### Task-03: Main Graph + HIL 🟢 Complete

- [x] `graph.py` — Full StateGraph with:
  - [x] Analyzer nodes (phase 1 + phase 2) — LLM calls with `get_prompt()` + structured JSON parsing with fallbacks
  - [x] Worker Send nodes (phase 1 + phase 2) — mini `create_agent()` ReAct agents with MCP tools via closure
  - [x] Aggregator nodes (phase 1 + phase 2) — LLM calls with variable substitution for worker_results/phase1_results
  - [x] Review nodes with `interrupt()` (phase 1 + phase 2) — `Command(goto=...)` for approve/adjust routing
  - [x] Phase routing via `Command` — maps to BPMN "Ergebnis ok?" exclusive gateway
  - [x] `auto_approve` bypass for testing/CI
- [x] `__init__.py` — Complete `graph()` factory with:
  - [x] MCP tool resolution (same pattern as react_agent, with auth + filtering)
  - [x] RAG tool resolution (imports `create_rag_tool` from react_agent utils)
  - [x] LLM resolution (standard provider via `init_chat_model` + custom endpoint via `ChatOpenAI`)
  - [x] Checkpointer/store DI with warning if no checkpointer for HIL

### Task-04: Server Wiring 🟢 Complete

- [x] `graphs/registry.py` — dict-based graph registry with `register_graph()` + `resolve_graph_factory()` + lazy imports
  - [x] `graph_id == "agent"` → react_agent (backwards compat, default)
  - [x] `graph_id == "research_agent"` → research_agent
  - [x] `get_available_graph_ids()` for `/info` endpoint
  - [x] Extensible design for future BPMN-to-graph plugin loading
- [x] `server/routes/streams.py` — uses `resolve_graph_factory()` with `graph_id` param threaded through `execute_run_stream()`
- [x] `server/agent.py` — uses `resolve_graph_factory()` with assistant's `graph_id`
- [x] `server/app.py` — imports `graphs.research_agent.prompts` at startup for Langfuse auto-seeding
- [ ] Update `.env.example` if needed (**minor — not blocking**)

### Task-05: Tests 🟢 Complete

- [x] Unit tests for models (Pydantic validation, serialisation, roundtrips, flexible metadata) — 14 tests
- [x] Unit tests for prompt registration and defaults (naming convention, JSON hints, tools mention, idempotent registration) — 7 tests
- [x] Unit tests for configuration parsing (defaults, custom values, extras ignored, MCP/RAG parsing, bounds validation) — 8 tests
- [x] Unit tests for worker output extraction (JSON array, code fence, results key, plain-text fallback, multimodal, alternative field names, truncation) — 12 tests
- [x] Unit tests for worker helpers (_is_ai_message, _safe_float, _get_message_content) — 7 tests
- [x] Unit tests for graph response parsing (_parse_analyzer_response, _parse_aggregator_response, _extract_content, _try_parse_json) — 15 tests
- [x] Unit tests for graph compilation (mocked LLM + empty tools, checkpointer + store, expected node names) — 3 tests
- [x] Unit tests for graph factory (async factory with mocked model via patched init_chat_model) — 1 test
- [x] Unit tests for analyzer nodes + set_phase2 node — 2 tests
- [x] Unit tests for graph registry (resolve, register eager/lazy, both/neither args error, unknown fallback, available IDs, __qualname__ check) — 11 tests
- [x] Unit tests for server wiring (app imports prompts, streams uses registry, agent uses registry, info lists research_agent) — 4 tests
- [x] Unit tests for error resilience (non-dict items, single result object, string response, None config, non-dict tasks, empty tasks, nested braces) — 7 tests
- [x] Fixed 7 pre-existing test_streams.py failures caused by registry refactor (patched `resolve_graph_factory` instead of removed `build_agent_graph`)
- [x] **94 tests total** in `test_research_agent.py`, all passing
- [x] **1026 passed, 35 skipped, 0 failed** across full suite
- [x] Coverage: **74.12%** overall (≥73% target met)
  - `models.py` 100%, `prompts.py` 100%, `configuration.py` 100%, `worker.py` 91%, `graph.py` 56% (async closures require full graph invocation)
- [x] Lint clean: `ruff check` + `ruff format` — all checks passed

### Task-06: Goal 24 Task-02 — Langfuse Prompt Integration 🟢 Complete (integrated into Tasks 01-03)

- [x] All 6 prompts wired through `get_prompt()` with fallbacks (in graph.py node functions)
- [x] Runtime override support via `config.configurable.prompt_overrides` (flows through `get_prompt()`)
- [x] Prompts registered for auto-seeding via `register_default_prompt()` in `prompts.py`
- [x] Server startup imports `graphs.research_agent.prompts` to trigger registration
- [x] Test: graph compiles and works without Langfuse (all tests run without Langfuse env vars — fallback path exercised)

---

## Acceptance Criteria

- [x] `from graphs.research_agent import graph` works
- [x] `graph(config, checkpointer=cp, store=st)` returns a compiled StateGraph
- [x] No `os.getenv()`, `dotenv`, or `Langfuse()` in graph code
- [x] No `from server.*` imports in graph code
- [x] No encoded tooling — no langchain-tavily, no hardcoded tool imports
- [x] Tools come from MCP config (same as react_agent)
- [x] LLM configurable via `RunnableConfig` (not hardcoded ChatOpenAI)
- [x] All 6 prompts via `get_prompt()` with generic English defaults
- [x] Prompts registered for auto-seeding in Langfuse
- [x] Phase 1: parallel workers → aggregate → HIL review → approve/adjust loop
- [x] Phase 2: parallel workers → aggregate → HIL review → approve/adjust → END
- [x] `auto_approve` config skips HIL (for testing)
- [x] Graph compiles and runs with mocked LLM + empty tools
- [x] Server dispatches to research_agent when `graph_id == "research_agent"`
- [x] Tests pass, coverage ≥73% (74.12% achieved, 1026 passed, 0 failed)
- [x] Lint clean (ruff check + ruff format)

---

## Constraints

- **No filesystem writes** — results in state, caller decides storage
- **No global state** — no module-level clients or tools
- **No encoded tooling** — tools from MCP config, not code
- **No domain-specific models** — generic ResearchResult with metadata dict
- **Dependency rules** — `graphs/research_agent/` never imports from `server/`
- **Config-driven** — all secrets and model config via `RunnableConfig.configurable`
- **Backwards compatible** — existing `react_agent` graph unaffected

---

## Risk Assessment

- **Medium risk:** The Send API + closure-based workers + interrupt pattern is the most complex LangGraph composition in this codebase. Testing carefully with mocked LLM.
- **Medium risk:** Workers are ReAct agents inside Send nodes. Need to verify `create_agent()` works correctly when invoked as a subgraph inside a Send node (no checkpointer needed for workers — parent handles persistence).
- **Low risk:** No new dependencies. Same MCP/RAG/LLM patterns as react_agent.
- **Low risk:** HIL interrupt pattern is well-documented in LangGraph. The `interrupt()` + `Command(resume=...)` API is stable.
- **Note:** Prompts are generic — the domain expert will need to create Langfuse prompt versions for their specific use case. The auto-seeded defaults are a starting point, not production-ready domain prompts.

---

## Session 13 Implementation Notes

### Files created (all new, all lint-clean)
- `src/graphs/research_agent/__init__.py` — graph factory (357 lines)
- `src/graphs/research_agent/configuration.py` — Pydantic config (148 lines)
- `src/graphs/research_agent/graph.py` — StateGraph + nodes (800 lines)
- `src/graphs/research_agent/models.py` — generic Pydantic models (124 lines)
- `src/graphs/research_agent/prompts.py` — 6 prompts + registration (214 lines)
- `src/graphs/research_agent/worker.py` — output extraction (249 lines)
- `src/graphs/registry.py` — dict-based graph registry (211 lines)

### Files modified
- `src/server/routes/streams.py` — graph registry dispatch + `graph_id` param
- `src/server/agent.py` — graph registry dispatch
- `src/server/app.py` — research_agent prompt import for seeding

### Key design decisions
- **Dict-based registry** with lazy imports — future BPMN-to-graph ready
- **Workers are `create_agent()` calls** inside Send nodes — tools via closure, no encoded tooling
- **Two node names per phase** (`worker_phase1`, `worker_phase2`) sharing same function — needed because Send fan-in routes to different aggregators
- **JSON parsing with multi-strategy fallback** — handles imperfect LLM output gracefully
- **`auto_approve` config flags** — skip HIL for testing/CI without code changes

## Session 14 Implementation Notes (Tests)

### Files created
- `src/server/tests/test_research_agent.py` — **94 tests** covering all research agent modules (1252 lines)

### Files modified
- `src/server/tests/test_streams.py` — Fixed 7 pre-existing test failures caused by registry refactor:
  - All 7 `TestExecuteRunStreamIntegration` tests patched `server.routes.streams.build_agent_graph` which no longer exists
  - Updated to patch `server.routes.streams.resolve_graph_factory` with `AsyncMock` factory wrapper
  - Pattern: `mock_factory = AsyncMock(return_value=mock_agent)` → `patch("server.routes.streams.resolve_graph_factory", return_value=mock_factory)`
  - Error case: `mock_factory = AsyncMock(side_effect=ValueError(...))` for agent init error test

### Test coverage by class (94 tests)
| Test Class | Count | What it covers |
|---|---|---|
| `TestSearchTask` | 5 | Pydantic validation, serialisation roundtrip, JSON roundtrip |
| `TestResearchResult` | 4 | Defaults, full fields, flexible metadata |
| `TestAnalyzerOutput` | 3 | Valid, empty tasks, missing reasoning |
| `TestAggregatorOutput` | 2 | Valid, default total_sources |
| `TestPromptRegistration` | 7 | All 6 registered, naming convention, JSON hints, tools mention, idempotent |
| `TestResearchAgentConfig` | 8 | Defaults, custom, extras ignored, MCP/RAG parsing, bounds |
| `TestExtractWorkerOutput` | 12 | JSON array, code fence, results key, plain-text, multimodal, alt fields |
| `TestWorkerHelpers` | 7 | _is_ai_message, _safe_float, _get_message_content |
| `TestParseAnalyzerResponse` | 7 | JSON with tasks, bare array, code fence, fallback, auto IDs |
| `TestParseAggregatorResponse` | 3 | Valid JSON, flatten workers, empty results |
| `TestExtractContent` | 3 | String, message object, list content |
| `TestTryParseJson` | 5 | Object, array, embedded, invalid, empty |
| `TestGraphRegistry` | 11 | Resolve, register eager/lazy, both/neither error, __qualname__ |
| `TestGraphCompilation` | 3 | Compile, checkpointer+store, expected nodes |
| `TestGraphFactory` | 1 | Async factory with mocked init_chat_model |
| `TestAnalyzerNodes` | 1 | Phase 1 returns tasks |
| `TestSetPhase2Node` | 1 | set_phase2 node exists |
| `TestServerWiring` | 4 | App imports, streams registry, agent registry, info endpoint |
| `TestErrorResilience` | 7 | Non-dict items, single object, string response, None config, empty tasks |

### Key fixes
- Fixed 2 `__module__` assertion failures in `TestGraphRegistry` — lazy wrappers report `__module__` as `graphs.registry`, not the target module. Changed to assert on `__qualname__` which contains the lazy target path (e.g. `"lazy(graphs.research_agent.graph)"`)
- Added 4 new registry tests: `test_register_graph_both_args_raises`, `test_register_graph_neither_args_raises`, `test_register_graph_eager`, `test_register_graph_lazy`

### Final results
- **1026 passed, 35 skipped, 0 failed** (full suite)
- **Coverage: 74.12%** (threshold: 73%)
- **Lint: all checks passed** (ruff check + ruff format)

---

## Future Improvements (Not in scope for Goal 23)

- Extract shared MCP tool resolution into `infra/tools.py` (currently duplicated between react_agent and research_agent)
- Extract shared LLM resolution into `infra/llm.py`
- BPMN-to-LangGraph compiler (generic, potentially LLM-powered) — registry is ready for plugin loading
- Additional BPMN phases: Erstansprache-Agent (outreach subprocess), Protokollant (meeting transcription)
- Streaming support for worker progress updates
- Worker-level timeout configuration
- Configurable number of phases (not just 2)

---

## References

- BPMN source of truth: `.agent/Vertriebsprozess.bpmn`
- LangGraph Send API: https://docs.langchain.com/oss/python/langgraph/workflows-agents
- LangGraph interrupts: https://docs.langchain.com/oss/python/langgraph/interrupts
- LangGraph subgraphs: https://docs.langchain.com/oss/python/langgraph/use-subgraphs
- Goal 24 (Langfuse prompts): `.agent/goals/24-Langfuse-Prompt-Templates/scratchpad.md`
- react_agent (pattern reference): `apps/python/src/graphs/react_agent/agent.py`
