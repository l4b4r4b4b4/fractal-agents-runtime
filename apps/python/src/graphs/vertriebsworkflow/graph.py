"""LangGraph Workflow fuer Immobilien-Projektsuche.

Flow: intake (LLM) -> analyzer -> worker (5x parallel) -> collect_and_export (Dedup)

Tracing: Automatisch via Runtime-CallbackHandler ueber RunnableConfig.
"""

import logging
import os
from operator import add
from typing import Annotated, Any, TypedDict

from langchain_core.messages import AIMessage, BaseMessage
from langchain_core.runnables import RunnableConfig
from langchain_core.runnables.config import merge_configs
from langchain_openai import ChatOpenAI
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages
from langgraph.types import Send, interrupt

from graphs.vertriebsworkflow.models import IntakeDecision
from graphs.vertriebsworkflow.prompts import INTAKE_SYSTEM_PROMPT, SUBTASKS
from graphs.vertriebsworkflow.worker_subgraph import create_worker_subgraph

logger = logging.getLogger(__name__)

# =============================================================================
# State Definition
# =============================================================================


class WorkflowState(TypedDict):
    """State-Schema fuer den gesamten Workflow."""

    messages: Annotated[list[BaseMessage], add_messages]
    user_input: str
    stadt: str
    task_list: list[dict]
    worker_task: dict
    aggregator_results: Annotated[list[dict], add]
    filtered_results: Annotated[list[dict], add]
    final_projects: list[dict]


# =============================================================================
# Intake Node (konversationeller Vorbau)
# =============================================================================


def intake_node(state: WorkflowState, config: RunnableConfig) -> dict:
    """Konversationeller Intake-Node mit LLM.

    Analysiert messages, extrahiert Stadt oder fragt nach.
    Wenn keine Stadt erkannt wird: AIMessage + interrupt() zum Pausieren.
    """
    messages = state.get("messages", [])
    if not messages:
        raise ValueError("Kein Input: messages ist leer")

    intake_llm = ChatOpenAI(
        model=os.getenv("INTAKE_LLM_MODEL", "gpt-4.1-mini"),
        temperature=0,
    )
    structured_llm = intake_llm.with_structured_output(IntakeDecision)

    decision: IntakeDecision = structured_llm.invoke(
        [{"role": "system", "content": INTAKE_SYSTEM_PROMPT}] + messages,
        config=merge_configs(config, {"run_name": "intake_llm"}),
    )

    if decision.ist_startbereit and decision.stadt:
        logger.info("Intake: Stadt '%s' erkannt, starte Workflow", decision.stadt)
        return {
            "user_input": decision.stadt,
            "messages": [AIMessage(content=decision.antwort)],
        }

    logger.info("Intake: Keine Stadt erkannt, frage nach")
    interrupt(
        {
            "type": "intake_nachfrage",
            "antwort": decision.antwort,
            "messages": [AIMessage(content=decision.antwort)],
        }
    )
    return {}


# =============================================================================
# Analyzer Node
# =============================================================================


def analyzer_node(state: WorkflowState) -> dict:
    """Erstellt 5 Subtasks (je Asset-Klasse) aus dem User-Input."""
    stadt = state["user_input"].strip()

    task_list = []
    for task_template in SUBTASKS:
        task = dict(task_template)
        task["description"] = task["description"].format(stadt=stadt)
        task["stadt"] = stadt
        task_list.append(task)

    asset_klassen = ", ".join(t["asset_klasse"] for t in task_list)
    logger.info("Analyzer: %d Asset-Klassen-Tasks fuer '%s'", len(task_list), stadt)

    return {
        "task_list": task_list,
        "stadt": stadt,
        "messages": [
            AIMessage(
                content=f"Projektsuche fuer {stadt} gestartet \u2013 {len(task_list)} Asset-Klassen: {asset_klassen}"
            )
        ],
    }


# =============================================================================
# Collect + Dedup Node
# =============================================================================


def collect_and_export_node(state: WorkflowState) -> dict:
    """Sammelt angereicherte Projekte und dedupliziert (Python-Logik, kein LLM)."""
    aggregator_results = state.get("aggregator_results", [])
    filtered_results = state.get("filtered_results", [])

    logger.info(
        "Collect: %d relevante + %d aussortierte Projekte",
        len(aggregator_results),
        len(filtered_results),
    )

    asset_stats: dict[str, int] = {}
    for p in aggregator_results:
        ak = p.get("asset_klasse", "Unbekannt")
        asset_stats[ak] = asset_stats.get(ak, 0) + 1
    for ak, count in asset_stats.items():
        logger.info("  - %s: %d Projekte", ak, count)

    deduplicated = _deduplicate_projects(aggregator_results)
    n_dupes = len(aggregator_results) - len(deduplicated)

    logger.info(
        "Dedup: %d -> %d (%d Duplikate entfernt)",
        len(aggregator_results),
        len(deduplicated),
        n_dupes,
    )

    return {
        "final_projects": deduplicated,
        "messages": [
            AIMessage(
                content=f"Suche abgeschlossen: {len(deduplicated)} Projekte gefunden, "
                f"{n_dupes} Duplikate entfernt."
            )
        ],
    }


def _deduplicate_projects(projekte: list[dict]) -> list[dict]:
    """Dedupliziert Projekte anhand von normalisiertem Projektname ODER erster URL."""
    seen_names: dict[str, int] = {}
    seen_urls: dict[str, int] = {}
    result: list[dict] = []

    for projekt in projekte:
        name = projekt.get("projektname", "").strip().lower()
        quellen = projekt.get("quellen", [])
        first_url = quellen[0].strip().lower() if quellen else ""

        existing_idx = None
        if name and name in seen_names:
            existing_idx = seen_names[name]
        elif first_url and first_url in seen_urls:
            existing_idx = seen_urls[first_url]

        if existing_idx is not None:
            existing = result[existing_idx]
            if _count_filled_fields(projekt) > _count_filled_fields(existing):
                result[existing_idx] = projekt
                logger.debug("Dedup: '%s' ersetzt aelteres Duplikat", projekt.get("projektname", ""))
            else:
                logger.debug("Dedup: '%s' uebersprungen (Duplikat)", projekt.get("projektname", ""))
        else:
            idx = len(result)
            result.append(projekt)
            if name:
                seen_names[name] = idx
            if first_url:
                seen_urls[first_url] = idx

    return result


def _count_filled_fields(projekt: dict) -> int:
    """Zaehlt wie viele Felder eines Projekts nicht 'unklar' oder leer sind."""
    count = 0
    for key, value in projekt.items():
        if key in ("quellen", "ais_themenfelder"):
            if isinstance(value, list) and len(value) > 0:
                count += 1
        elif isinstance(value, str) and value and value != "unklar":
            count += 1
        elif isinstance(value, bool):
            count += 1
    return count


# =============================================================================
# Routing
# =============================================================================


def should_continue(state: WorkflowState) -> list[Send]:
    """Fuer jede Task einen parallelen Worker-Subgraph starten."""
    return [
        Send("worker", {"worker_task": task})
        for task in state["task_list"]
    ]


# =============================================================================
# Worker Node Wrapper
# =============================================================================


def make_worker_node(compiled_subgraph):
    """Erzeugt den Worker-Node-Wrapper fuer den Worker-Subgraph."""

    def worker_node(state: WorkflowState) -> dict:
        worker_task = state.get("worker_task", {}) or {}

        subgraph_state = {
            "worker_task": worker_task,
            "search_queries": [],
            "search_results": [],
            "search_history": [],
            "iteration_count": 0,
            "good_query_ids": [],
            "worker_results": [],
            "aggregator_results": [],
            "filtered_results": [],
        }

        result = compiled_subgraph.invoke(subgraph_state)

        asset_klasse = worker_task.get("asset_klasse", worker_task.get("id", "unknown"))
        n = len(result.get("aggregator_results", []))
        result["messages"] = [
            AIMessage(content=f"{asset_klasse}: {n} relevante Projekte gefunden")
        ]

        return result

    return worker_node


# =============================================================================
# Graph Creation
# =============================================================================


def create_workflow(*, checkpointer=None):
    """Erstellt und kompiliert den Workflow.

    Flow: START -> intake -> analyzer -> (Send) worker -> collect_and_export -> END
    """
    workflow = StateGraph(WorkflowState)

    compiled_worker = create_worker_subgraph().compile()

    workflow.add_node("intake", intake_node)
    workflow.add_node("analyzer", analyzer_node)
    workflow.add_node("worker", make_worker_node(compiled_worker))
    workflow.add_node("collect_and_export", collect_and_export_node)

    workflow.add_edge(START, "intake")
    workflow.add_edge("intake", "analyzer")
    workflow.add_conditional_edges("analyzer", should_continue, ["worker"])
    workflow.add_edge("worker", "collect_and_export")
    workflow.add_edge("collect_and_export", END)

    return workflow.compile(checkpointer=checkpointer)


# =============================================================================
# Runtime Graph Factory
# =============================================================================


async def graph(
    config: RunnableConfig,
    *,
    checkpointer: Any | None = None,
    store: Any | None = None,
) -> Any:
    """Graph Factory fuer fractal-agents-runtime.

    Wird von der Runtime ueber die Graph Registry aufgerufen:
        build_graph = resolve_graph_factory("vertriebsworkflow")
        compiled = await build_graph(config, checkpointer=cp, store=st)
    """
    return create_workflow(checkpointer=checkpointer)
