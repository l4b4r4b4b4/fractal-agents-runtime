"""Two-phase parallel research workflow with human-in-the-loop review.

This module implements the core StateGraph that maps the BPMN
``Vertriebsprozess`` pattern into a generic, reusable LangGraph graph:

.. code-block:: text

    START
      → analyzer_phase1   (LLM: decompose query into SearchTasks)
      → [Send] worker_phase1  (parallel ReAct agents with MCP tools)
      → aggregator_phase1  (LLM: combine & rank results)
      → review_phase1      (interrupt: human approves or adjusts)
          ├─ adjust → analyzer_phase1
          └─ approve → set_phase2

    set_phase2
      → analyzer_phase2   (LLM: create validation tasks)
      → [Send] worker_phase2  (parallel ReAct agents)
      → aggregator_phase2  (LLM: final selection & ranking)
      → review_phase2      (interrupt: human approves or adjusts)
          ├─ adjust → aggregator_phase2
          └─ approve → END

All domain specificity comes from **prompts** (Langfuse) and **tools**
(MCP servers assigned per assistant).  The graph code is generic.

Key LangGraph primitives used:

- :class:`~langgraph.graph.StateGraph` for the workflow definition
- :class:`~langgraph.types.Send` for parallel worker fan-out
- :func:`~langgraph.types.interrupt` for human-in-the-loop pauses
- :class:`~langgraph.types.Command` for routing after review decisions
"""

from __future__ import annotations

import json
import logging
import operator
import re
from typing import Annotated, Any, Literal

from langchain.agents import create_agent
from langchain_core.messages import AIMessage, AnyMessage, HumanMessage
from langchain_core.runnables import RunnableConfig
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages
from langgraph.types import Command, Send, interrupt

from infra.prompts import get_prompt

from graphs.research_agent.prompts import (
    AGGREGATOR_PHASE1_PROMPT,
    AGGREGATOR_PHASE2_PROMPT,
    ANALYZER_PHASE1_PROMPT,
    ANALYZER_PHASE2_PROMPT,
    WORKER_PHASE1_PROMPT,
    WORKER_PHASE2_PROMPT,
)
from graphs.research_agent.worker import extract_worker_output

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# State schemas
# ---------------------------------------------------------------------------


class WorkflowState(dict):
    """Main graph state for the two-phase research workflow.

    Uses :func:`operator.add` as a reducer for ``worker_results`` so
    that parallel workers can write to the same key concurrently.

    All result fields use plain dicts (not Pydantic models) because
    LangGraph state must be JSON-serialisable for checkpointing.
    """


# We declare the state as a TypedDict for LangGraph's type system.
from typing import TypedDict  # noqa: E402 — after class docstring


class WorkflowStateDict(TypedDict, total=False):
    """Typed state schema for the research agent workflow."""

    # Conversation / input
    messages: Annotated[list[AnyMessage], add_messages]
    user_input: str

    # Phase tracking
    current_phase: str  # "phase1" | "phase2"

    # Analyzer output
    task_list: list[dict[str, Any]]

    # Worker output (parallel writes via add reducer)
    worker_results: Annotated[list[dict[str, Any]], operator.add]

    # Aggregated results per phase
    phase1_results: list[dict[str, Any]]
    final_results: list[dict[str, Any]]
    final_summary: str

    # Review / feedback
    review_feedback: str


class WorkerStateDict(TypedDict, total=False):
    """State for individual worker Send nodes."""

    task: dict[str, Any]
    phase: str
    worker_results: Annotated[list[dict[str, Any]], operator.add]


# ---------------------------------------------------------------------------
# Graph builder
# ---------------------------------------------------------------------------


def build_research_graph(
    model: Any,
    tools: list[Any],
    config: RunnableConfig,
    *,
    checkpointer: Any | None = None,
    store: Any | None = None,
    max_worker_iterations: int = 15,
    auto_approve_phase1: bool = False,
    auto_approve_phase2: bool = False,
) -> Any:
    """Construct and compile the two-phase research StateGraph.

    This function is the core graph builder.  It is called by the
    public :func:`graphs.research_agent.graph` factory after tools,
    model, and configuration have been resolved.

    All node functions are defined as closures that capture ``model``,
    ``tools``, and ``config`` from the enclosing scope.

    Args:
        model: A LangChain chat model instance.
        tools: List of LangChain-compatible tool objects (from MCP /
            RAG resolution).
        config: The ``RunnableConfig`` for this invocation (used for
            prompt overrides and tracing callbacks).
        checkpointer: Optional LangGraph checkpointer for durable
            execution and HIL interrupt persistence.
        store: Optional LangGraph store for cross-thread memory.
        max_worker_iterations: Maximum ReAct steps per worker.
        auto_approve_phase1: Skip phase-1 HIL interrupt.
        auto_approve_phase2: Skip phase-2 HIL interrupt.

    Returns:
        A compiled LangGraph ``Pregel`` instance ready for
        ``.ainvoke()`` / ``.astream()``.
    """

    # -----------------------------------------------------------------------
    # Node implementations (closures over model, tools, config)
    # -----------------------------------------------------------------------

    async def analyzer_phase1(state: WorkflowStateDict) -> dict[str, Any]:
        """Decompose the user query into parallel search tasks."""
        user_input = state.get("user_input", "")
        feedback = state.get("review_feedback", "")

        prompt_text = get_prompt(
            "research-agent-analyzer-phase1",
            fallback=ANALYZER_PHASE1_PROMPT,
            config=config,
            variables={
                "review_feedback": (
                    f"\nUser feedback on previous attempt:\n{feedback}"
                    if feedback
                    else ""
                ),
            },
        )

        response = await model.ainvoke(
            [
                {"role": "system", "content": prompt_text},
                {"role": "user", "content": user_input},
            ]
        )

        tasks = _parse_analyzer_response(response)
        logger.info(
            "analyzer_phase1: generated %d tasks for query: %.80s",
            len(tasks),
            user_input,
        )
        return {
            "task_list": tasks,
            "current_phase": "phase1",
            "worker_results": [],  # Reset for new fan-out
            "messages": [
                AIMessage(
                    content=f"Phase 1 analysis complete. Created {len(tasks)} research tasks.",
                    name="analyzer",
                ),
            ],
        }

    async def analyzer_phase2(state: WorkflowStateDict) -> dict[str, Any]:
        """Create validation tasks from phase-1 results."""
        phase1_results = state.get("phase1_results", [])
        feedback = state.get("review_feedback", "")

        prompt_text = get_prompt(
            "research-agent-analyzer-phase2",
            fallback=ANALYZER_PHASE2_PROMPT,
            config=config,
            variables={
                "phase1_results": json.dumps(
                    phase1_results, ensure_ascii=False, default=str
                ),
                "review_feedback": (
                    f"\nUser feedback:\n{feedback}" if feedback else ""
                ),
            },
        )

        response = await model.ainvoke(
            [
                {"role": "system", "content": prompt_text},
                {
                    "role": "user",
                    "content": (
                        f"Create validation tasks for these {len(phase1_results)} "
                        "preliminary results."
                    ),
                },
            ]
        )

        tasks = _parse_analyzer_response(response)
        logger.info("analyzer_phase2: generated %d validation tasks", len(tasks))
        return {
            "task_list": tasks,
            "current_phase": "phase2",
            "worker_results": [],  # Reset for new fan-out
            "messages": [
                AIMessage(
                    content=f"Phase 2 analysis complete. Created {len(tasks)} validation tasks.",
                    name="analyzer",
                ),
            ],
        }

    async def worker_node(state: WorkerStateDict) -> dict[str, Any]:
        """Execute a single research task using a mini ReAct agent.

        This function is used as the node for both ``worker_phase1``
        and ``worker_phase2`` — the phase is passed in the state and
        determines which prompt is used.
        """
        task = state.get("task", {})
        phase = state.get("phase", "phase1")

        prompt_name = f"research-agent-worker-{phase}"
        fallback = WORKER_PHASE1_PROMPT if phase == "phase1" else WORKER_PHASE2_PROMPT

        worker_prompt = get_prompt(
            prompt_name,
            fallback=fallback,
            config=config,
        )

        # Append task details to the system prompt.
        task_description = task.get("description", "")
        search_focus = task.get("search_focus", task_description)
        constraints = task.get("constraints", {})

        full_prompt = worker_prompt
        if task_description:
            full_prompt += f"\n\n--- Your assigned task ---\n{task_description}"
        if constraints:
            full_prompt += (
                f"\n\nConstraints: {json.dumps(constraints, ensure_ascii=False)}"
            )

        # Create a mini ReAct agent with the shared tools.
        # No checkpointer — the parent graph handles persistence.
        worker_agent = create_agent(
            model=model,
            tools=tools,
            system_prompt=full_prompt,
        )

        try:
            result = await worker_agent.ainvoke(
                {"messages": [HumanMessage(content=search_focus)]},
                {"recursion_limit": max_worker_iterations},
            )
            output = extract_worker_output(result, task=task)
        except Exception:
            logger.warning(
                "Worker failed for task %s — returning empty result",
                task.get("task_id", "?"),
                exc_info=True,
            )
            output = {
                "results": [
                    {
                        "title": f"Worker error: {task.get('task_id', 'unknown')}",
                        "summary": "The research worker encountered an error and could not complete this task.",
                        "source_url": None,
                        "relevance_score": 0.0,
                        "metadata": {"error": True},
                    }
                ],
            }

        task_id = task.get("task_id", "unknown")
        result_count = len(output.get("results", []))
        logger.info(
            "worker (%s, %s): produced %d results", phase, task_id, result_count
        )

        return {
            "worker_results": [
                {
                    "task_id": task_id,
                    "phase": phase,
                    "results": output.get("results", []),
                }
            ],
        }

    async def aggregator_phase1(state: WorkflowStateDict) -> dict[str, Any]:
        """Combine phase-1 worker results into a ranked list."""
        worker_results = state.get("worker_results", [])
        user_input = state.get("user_input", "")

        prompt_text = get_prompt(
            "research-agent-aggregator-phase1",
            fallback=AGGREGATOR_PHASE1_PROMPT,
            config=config,
            variables={
                "user_input": user_input,
                "worker_results": json.dumps(
                    worker_results, ensure_ascii=False, default=str
                ),
            },
        )

        response = await model.ainvoke(
            [
                {"role": "system", "content": prompt_text},
                {
                    "role": "user",
                    "content": (
                        f"Aggregate results from {len(worker_results)} workers. "
                        f"Original query: {user_input}"
                    ),
                },
            ]
        )

        aggregated = _parse_aggregator_response(response, worker_results)
        result_count = len(aggregated.get("results", []))
        logger.info("aggregator_phase1: produced %d aggregated results", result_count)

        return {
            "phase1_results": aggregated.get("results", []),
            "messages": [
                AIMessage(
                    content=(
                        f"Phase 1 complete. Aggregated {result_count} results "
                        f"from {len(worker_results)} workers.\n\n"
                        f"Summary: {aggregated.get('summary', 'No summary available.')}"
                    ),
                    name="aggregator",
                ),
            ],
        }

    async def aggregator_phase2(state: WorkflowStateDict) -> dict[str, Any]:
        """Combine phase-2 worker results with phase-1 for final selection."""
        worker_results = state.get("worker_results", [])
        phase1_results = state.get("phase1_results", [])
        user_input = state.get("user_input", "")

        prompt_text = get_prompt(
            "research-agent-aggregator-phase2",
            fallback=AGGREGATOR_PHASE2_PROMPT,
            config=config,
            variables={
                "user_input": user_input,
                "phase1_results": json.dumps(
                    phase1_results, ensure_ascii=False, default=str
                ),
                "worker_results": json.dumps(
                    worker_results, ensure_ascii=False, default=str
                ),
            },
        )

        response = await model.ainvoke(
            [
                {"role": "system", "content": prompt_text},
                {
                    "role": "user",
                    "content": (
                        f"Final aggregation: {len(worker_results)} validation workers, "
                        f"{len(phase1_results)} phase-1 results. "
                        f"Original query: {user_input}"
                    ),
                },
            ]
        )

        aggregated = _parse_aggregator_response(response, worker_results)
        result_count = len(aggregated.get("results", []))
        summary = aggregated.get("summary", "Research complete.")
        logger.info("aggregator_phase2: final selection of %d results", result_count)

        return {
            "final_results": aggregated.get("results", []),
            "final_summary": summary,
            "messages": [
                AIMessage(
                    content=(
                        f"Phase 2 complete. Final selection: {result_count} results.\n\n"
                        f"Summary: {summary}"
                    ),
                    name="aggregator",
                ),
            ],
        }

    def review_phase1(
        state: WorkflowStateDict,
    ) -> Command[Literal["analyzer_phase1", "set_phase2"]]:
        """Human-in-the-loop review after phase 1.

        Presents the aggregated phase-1 results to the human via
        :func:`~langgraph.types.interrupt`.  The human's decision
        routes the graph:

        - **approve** → proceed to phase 2
        - **adjust** (with optional feedback) → loop back to analyzer
        """
        phase1_results = state.get("phase1_results", [])

        if auto_approve_phase1:
            logger.info(
                "review_phase1: auto-approved (%d results)", len(phase1_results)
            )
            return Command(
                goto="set_phase2",
                update={"review_feedback": ""},
            )

        decision = interrupt(
            {
                "type": "review_results",
                "phase": "phase1",
                "result_count": len(phase1_results),
                "results": phase1_results,
                "message": (
                    "Please review the phase 1 research results. "
                    "Respond with {'approved': true} to proceed to validation, "
                    "or {'approved': false, 'feedback': '...'} to adjust."
                ),
            }
        )

        if isinstance(decision, dict) and decision.get("approved"):
            logger.info("review_phase1: human approved — proceeding to phase 2")
            return Command(
                goto="set_phase2",
                update={"review_feedback": ""},
            )
        else:
            feedback = (
                decision.get("feedback", "")
                if isinstance(decision, dict)
                else str(decision)
            )
            logger.info(
                "review_phase1: human requested adjustments — feedback: %.200s",
                feedback,
            )
            return Command(
                goto="analyzer_phase1",
                update={"review_feedback": feedback},
            )

    def review_phase2(
        state: WorkflowStateDict,
    ) -> Command[Literal["aggregator_phase2", "__end__"]]:
        """Human-in-the-loop review after phase 2 (final review).

        Same pattern as :func:`review_phase1` but routes to either
        re-aggregation or the end of the workflow.
        """
        final_results = state.get("final_results", [])

        if auto_approve_phase2:
            logger.info(
                "review_phase2: auto-approved (%d final results)", len(final_results)
            )
            return Command(goto=END, update={"review_feedback": ""})

        decision = interrupt(
            {
                "type": "review_results",
                "phase": "phase2",
                "result_count": len(final_results),
                "results": final_results,
                "summary": state.get("final_summary", ""),
                "message": (
                    "Please review the final research results. "
                    "Respond with {'approved': true} to finish, "
                    "or {'approved': false, 'feedback': '...'} to re-aggregate."
                ),
            }
        )

        if isinstance(decision, dict) and decision.get("approved"):
            logger.info("review_phase2: human approved — finishing workflow")
            return Command(goto=END, update={"review_feedback": ""})
        else:
            feedback = (
                decision.get("feedback", "")
                if isinstance(decision, dict)
                else str(decision)
            )
            logger.info(
                "review_phase2: human requested re-aggregation — feedback: %.200s",
                feedback,
            )
            return Command(
                goto="aggregator_phase2",
                update={"review_feedback": feedback},
            )

    def set_phase2(state: WorkflowStateDict) -> dict[str, Any]:
        """Transition marker — sets phase to ``phase2``."""
        return {
            "current_phase": "phase2",
            "review_feedback": "",
        }

    # -----------------------------------------------------------------------
    # Fan-out: conditional edges that create parallel workers via Send
    # -----------------------------------------------------------------------

    def assign_phase1_workers(
        state: WorkflowStateDict,
    ) -> list[Send]:
        """Fan out phase-1 tasks to parallel worker nodes."""
        tasks = state.get("task_list", [])
        if not tasks:
            logger.warning("assign_phase1_workers: no tasks — skipping workers")
            # Return an empty list; LangGraph will skip and proceed to the
            # next node via the default edge.
            return [
                Send(
                    "worker_phase1",
                    {
                        "task": {
                            "task_id": "fallback",
                            "description": state.get("user_input", "General research"),
                            "search_focus": state.get("user_input", ""),
                        },
                        "phase": "phase1",
                    },
                )
            ]
        return [
            Send("worker_phase1", {"task": task, "phase": "phase1"}) for task in tasks
        ]

    def assign_phase2_workers(
        state: WorkflowStateDict,
    ) -> list[Send]:
        """Fan out phase-2 validation tasks to parallel worker nodes."""
        tasks = state.get("task_list", [])
        if not tasks:
            logger.warning("assign_phase2_workers: no tasks — skipping workers")
            return [
                Send(
                    "worker_phase2",
                    {
                        "task": {
                            "task_id": "fallback-v",
                            "description": "Validate preliminary results",
                            "search_focus": "Verify the preliminary research findings",
                        },
                        "phase": "phase2",
                    },
                )
            ]
        return [
            Send("worker_phase2", {"task": task, "phase": "phase2"}) for task in tasks
        ]

    # -----------------------------------------------------------------------
    # Build the StateGraph
    # -----------------------------------------------------------------------

    builder = StateGraph(WorkflowStateDict)

    # Phase 1 nodes
    builder.add_node("analyzer_phase1", analyzer_phase1)
    builder.add_node("worker_phase1", worker_node)
    builder.add_node("aggregator_phase1", aggregator_phase1)
    builder.add_node("review_phase1", review_phase1)

    # Transition
    builder.add_node("set_phase2", set_phase2)

    # Phase 2 nodes
    builder.add_node("analyzer_phase2", analyzer_phase2)
    builder.add_node("worker_phase2", worker_node)
    builder.add_node("aggregator_phase2", aggregator_phase2)
    builder.add_node("review_phase2", review_phase2)

    # Phase 1 edges
    builder.add_edge(START, "analyzer_phase1")
    builder.add_conditional_edges(
        "analyzer_phase1", assign_phase1_workers, ["worker_phase1"]
    )
    builder.add_edge("worker_phase1", "aggregator_phase1")
    builder.add_edge("aggregator_phase1", "review_phase1")
    # review_phase1 uses Command to route → analyzer_phase1 or set_phase2

    # Transition edge
    builder.add_edge("set_phase2", "analyzer_phase2")

    # Phase 2 edges
    builder.add_conditional_edges(
        "analyzer_phase2", assign_phase2_workers, ["worker_phase2"]
    )
    builder.add_edge("worker_phase2", "aggregator_phase2")
    builder.add_edge("aggregator_phase2", "review_phase2")
    # review_phase2 uses Command to route → aggregator_phase2 or END

    # Compile
    compiled = builder.compile(
        checkpointer=checkpointer,
        store=store,
    )

    logger.info(
        "research_agent graph compiled: %d tools, checkpointer=%s, store=%s",
        len(tools),
        type(checkpointer).__name__ if checkpointer else "None",
        type(store).__name__ if store else "None",
    )
    return compiled


# ---------------------------------------------------------------------------
# Response parsing helpers
# ---------------------------------------------------------------------------

# Regex for JSON in freeform LLM output.
_JSON_BLOCK_RE = re.compile(
    r"```(?:json)?\s*\n?([\s\S]*?)```"
    r"|"
    r"(\{[\s\S]*\})",
)


def _parse_analyzer_response(response: Any) -> list[dict[str, Any]]:
    """Extract a list of task dicts from the analyzer LLM response.

    Tries to parse structured JSON from the response content.
    Falls back to a single catch-all task if parsing fails.
    """
    content = _extract_content(response)
    parsed = _try_parse_json(content)

    if parsed is not None:
        if isinstance(parsed, dict) and "tasks" in parsed:
            tasks = parsed["tasks"]
            if isinstance(tasks, list):
                return _normalise_tasks(tasks)
        if isinstance(parsed, list):
            return _normalise_tasks(parsed)

    # Fallback: create a single task from the whole response.
    logger.warning(
        "analyzer response was not valid JSON — creating single fallback task"
    )
    return [
        {
            "task_id": "task-fallback",
            "description": content[:500] if content else "General research",
            "search_focus": content[:200] if content else "Research the query",
            "constraints": {},
        }
    ]


def _parse_aggregator_response(
    response: Any,
    worker_results: list[dict[str, Any]],
) -> dict[str, Any]:
    """Extract aggregated results from the aggregator LLM response.

    Falls back to flattening all worker results if parsing fails.
    """
    content = _extract_content(response)
    parsed = _try_parse_json(content)

    if parsed is not None and isinstance(parsed, dict):
        results = parsed.get("results", [])
        if isinstance(results, list) and results:
            return {
                "results": results,
                "summary": parsed.get("summary", ""),
                "total_sources_reviewed": parsed.get("total_sources_reviewed", 0),
            }

    # Fallback: flatten worker results.
    logger.warning("aggregator response was not valid JSON — flattening worker results")
    flat_results = []
    for worker_output in worker_results:
        for result in worker_output.get("results", []):
            flat_results.append(result)

    return {
        "results": flat_results,
        "summary": content[:500] if content else "Aggregation summary unavailable.",
        "total_sources_reviewed": len(flat_results),
    }


def _extract_content(response: Any) -> str:
    """Get the text content from a LangChain message response."""
    if isinstance(response, str):
        return response
    if hasattr(response, "content"):
        content = response.content
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            return " ".join(
                block.get("text", str(block)) if isinstance(block, dict) else str(block)
                for block in content
            )
    return str(response)


def _try_parse_json(text: str) -> dict[str, Any] | list | None:
    """Try to parse JSON from freeform text.  Returns None on failure."""
    if not text:
        return None

    # Try full text first.
    try:
        return json.loads(text)
    except (json.JSONDecodeError, ValueError):
        pass

    # Try extracting from code fences or embedded braces.
    for match in _JSON_BLOCK_RE.finditer(text):
        candidate = match.group(1) or match.group(2)
        if candidate:
            try:
                return json.loads(candidate.strip())
            except (json.JSONDecodeError, ValueError):
                continue

    return None


def _normalise_tasks(items: list[Any]) -> list[dict[str, Any]]:
    """Ensure every task dict has the required keys."""
    normalised = []
    for index, item in enumerate(items):
        if not isinstance(item, dict):
            continue
        normalised.append(
            {
                "task_id": item.get("task_id", f"task-{index + 1}"),
                "description": str(item.get("description", "")),
                "search_focus": str(
                    item.get("search_focus", item.get("description", ""))
                ),
                "constraints": item.get("constraints", {}),
            }
        )
    return (
        normalised
        if normalised
        else [
            {
                "task_id": "task-fallback",
                "description": "General research",
                "search_focus": "Research the query",
                "constraints": {},
            }
        ]
    )
