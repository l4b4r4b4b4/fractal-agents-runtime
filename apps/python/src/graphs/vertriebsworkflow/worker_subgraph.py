"""Worker-Subgraph fuer iterative Search-Verification + Aggregator-Anreicherung.

Ablauf: worker_query -> tavily_search (parallel) -> verifier -> retry oder aggregator -> END
Iter1: Query-Bewertung + Retry. Iter2: Final Evaluation + Projekt-Extraktion.
Aggregator: Tavily Extract + gpt-4.1 Anreicherung pro Projekt (FinalProjectData).

Tracing: Automatisch via RunnableConfig (Runtime-CallbackHandler). run_name pro Call.
"""

import json
import logging
import os
from operator import add
from typing import Annotated, TypedDict

from langchain_core.runnables import RunnableConfig
from langchain_core.runnables.config import merge_configs
from langchain_openai import ChatOpenAI
from langchain_tavily import TavilyExtract, TavilySearch
from langgraph.graph import END, START, StateGraph
from langgraph.types import Send

from graphs.vertriebsworkflow.models import (
    AIS_THEMENFELDER,
    AggregatorProjectOutput,
    SearchQueriesOutput,
    TavilySearchResult,
    VerifierOutput,
    WorkerFinalOutput,
)
from graphs.vertriebsworkflow.prompts import (
    AGGREGATOR_ENRICH_PROMPT,
    FINAL_EVALUATOR_PROMPT,
    VERIFIER_PROMPT,
    WORKER_QUERY_PROMPT,
)

logger = logging.getLogger(__name__)

SCORE_THRESHOLD = 0.5

tavily_tool = TavilySearch(
    api_key=os.getenv("TAVILY_API_KEY"),
    time_range="year",
    country="germany",
)

tavily_extract = TavilyExtract(api_key=os.getenv("TAVILY_API_KEY"))


# =============================================================================
# State Definition
# =============================================================================


class WorkerSubgraphState(TypedDict):
    """State-Schema fuer den Worker-Subgraph."""

    worker_task: dict
    search_queries: list[dict]
    search_results: Annotated[list[dict], add]
    search_history: list[dict]
    iteration_count: int
    good_query_ids: list[str]
    worker_results: list[dict]
    aggregator_results: list[dict]
    filtered_results: Annotated[list[dict], add]


class WorkerSubgraphOutputState(TypedDict):
    """Output-Schema (nur ueberlappende Keys an Parent)."""

    aggregator_results: list[dict]
    filtered_results: list[dict]


# =============================================================================
# Helper Functions
# =============================================================================


def _resolve_model(config: RunnableConfig, env_var: str, default: str) -> str:
    """Modellname aus Config > Env-Var > Hardcoded Default aufloesen."""
    env_value = os.getenv(env_var)
    if env_value:
        return env_value
    configurable = (config or {}).get("configurable", {})
    config_model = configurable.get("model_name") if isinstance(configurable, dict) else None
    if config_model:
        return config_model
    return default


def get_llm(config: RunnableConfig) -> ChatOpenAI:
    """Standard-LLM fuer Worker-Nodes."""
    return ChatOpenAI(
        model=_resolve_model(config, "DEFAULT_LLM_MODEL", "gpt-4.1"),
        temperature=float(os.getenv("DEFAULT_TEMPERATURE", "0.0")),
        max_tokens=int(os.getenv("DEFAULT_MAX_TOKENS", "8000")),
    )


def get_final_eval_llm(config: RunnableConfig) -> ChatOpenAI:
    """Spezialisiertes Reasoning-Modell fuer Final Evaluation."""
    model = _resolve_model(config, "FINAL_EVAL_MODEL", "o4-mini")
    reasoning_effort = os.getenv("FINAL_EVAL_REASONING_EFFORT", "medium")
    return ChatOpenAI(model=model, reasoning_effort=reasoning_effort)


def get_aggregator_llm(config: RunnableConfig) -> ChatOpenAI:
    """LLM fuer Aggregator-Anreicherung."""
    return ChatOpenAI(
        model=_resolve_model(config, "AGGREGATOR_LLM_MODEL", "gpt-4.1"),
        temperature=0.0,
    )


# =============================================================================
# Subgraph Nodes
# =============================================================================


def worker_query_node(state: WorkerSubgraphState, config: RunnableConfig) -> dict:
    """Erstellt/optimiert Search-Queries basierend auf History."""
    llm = get_llm(config)
    worker_task = state.get("worker_task", {})
    search_history = state.get("search_history", [])
    good_query_ids = state.get("good_query_ids", [])
    iteration = state.get("iteration_count", 0) + 1

    task_id = worker_task.get("id", "unknown")
    description = worker_task.get("description", "")

    asset_klasse = worker_task.get("asset_klasse", "")
    stadt = worker_task.get("stadt", "")
    prompt = WORKER_QUERY_PROMPT.format(asset_klasse=asset_klasse, stadt=stadt)

    logger.info("Worker Query [%s] Iter %d: Erstelle Queries...", task_id, iteration)

    structured_llm = llm.with_structured_output(SearchQueriesOutput)

    history_text = (
        "Keine bisherigen Suchanfragen."
        if not search_history
        else "\n".join(
            [
                f"- Query '{h['query_id']}': '{h['query_text']}' -> "
                f"Quality: {h['quality']}, Feedback: {h.get('feedback', 'N/A')}"
                for h in search_history
            ]
        )
    )

    user_content = f"""Subtask: {description}

Iteration: {iteration}
Bereits als gut bewertete Query-IDs (nicht nochmal suchen): {good_query_ids}

Bisherige Suchhistorie:
{history_text}

- Erstelle neue Queries nur fuer fehlende Aspekte
- Query-IDs im Format: q{{nummer}}_iter{iteration}"""

    messages = [
        {"role": "system", "content": prompt},
        {"role": "user", "content": user_content},
    ]

    result: SearchQueriesOutput = structured_llm.invoke(
        messages,
        config=merge_configs(config, {"run_name": f"worker_query_{task_id}_iter{iteration}"}),
    )

    new_queries = [q.model_dump() for q in result.new_queries]

    logger.info("Worker Query [%s]: %d neue Queries", task_id, len(new_queries))
    logger.debug("Neue Queries: %s", [q["query_text"][:50] for q in new_queries])

    return {
        "search_queries": new_queries,
        "iteration_count": iteration,
    }


def execute_tavily_search(
    query_text: str, query_id: str, task_id: str, iteration: int, config: RunnableConfig
) -> list[dict]:
    """Fuehrt eine Tavily Web-Suche aus."""
    run_name = f"tavily_{task_id}_{query_id}"
    tavily_config = merge_configs(config, {"run_name": run_name})

    raw = tavily_tool.invoke({"query": query_text}, config=tavily_config)

    if isinstance(raw, dict) and "error" in raw:
        logger.warning("Tavily [%s/%s]: API-Fehler: %s", task_id, query_id, raw["error"])
        return []

    results = []
    raw_results = raw.get("results", []) if isinstance(raw, dict) else []
    for item in raw_results:
        results.append(
            {
                "url": item.get("url", ""),
                "title": item.get("title", ""),
                "score": item.get("score", 0.0),
                "content": item.get("content", "")[:500],
            }
        )

    return results


def tavily_search_node(state: WorkerSubgraphState, config: RunnableConfig) -> dict:
    """Fuehrt eine einzelne Web-Suche aus und filtert nach Score."""
    query = state.get("current_query", {})
    query_id = query.get("query_id", "unknown")
    query_text = query.get("query_text", "")
    task_id = state.get("worker_task", {}).get("id", "unknown")
    iteration = state.get("iteration_count", 0)

    logger.debug("Tavily Search [%s]: %s...", query_id, query_text[:50])

    try:
        all_results = execute_tavily_search(query_text, query_id, task_id, iteration, config)
        all_results.sort(key=lambda x: x.get("score", 0.0), reverse=True)

        good_results = [r for r in all_results if r.get("score", 0.0) >= SCORE_THRESHOLD]
        filtered_results = [r for r in all_results if r.get("score", 0.0) < SCORE_THRESHOLD]

        result = TavilySearchResult(
            query_id=query_id,
            query_text=query_text,
            results=good_results,
            filtered_results=filtered_results,
            filtered_count=len(filtered_results),
        )
        if not all_results:
            logger.warning(
                "Tavily Search [%s/%s]: 0 Ergebnisse fuer '%s'",
                task_id, query_id, query_text[:60],
            )

        logger.info(
            "Tavily Search [%s/%s]: %d ueber Threshold, %d darunter",
            task_id, query_id, len(good_results), len(filtered_results),
        )

    except Exception as e:
        error_msg = str(e)
        logger.warning("Tavily Search [%s/%s] FEHLGESCHLAGEN: %s", task_id, query_id, error_msg)

        if "api_key" in error_msg.lower():
            logger.error("Tavily API Key fehlt oder ungueltig!")
        elif "rate limit" in error_msg.lower():
            logger.error("Tavily Rate Limit erreicht!")
        elif "timeout" in error_msg.lower():
            logger.error("Tavily Timeout!")

        result = TavilySearchResult(
            query_id=query_id,
            query_text=query_text,
            results=[],
            filtered_results=[{"error": f"Suche fehlgeschlagen - {error_msg}"}],
            filtered_count=0,
        )

    return {"search_results": [result.model_dump()]}


def verifier_node(state: WorkerSubgraphState, config: RunnableConfig) -> dict:
    """Dual-Purpose: Iter1 = Query-Bewertung, Iter2 = Projekt-Extraktion."""
    iteration = state.get("iteration_count", 1)

    if iteration >= 2:
        return _final_evaluation(state, config)
    else:
        return _query_evaluation(state, config)


def _query_evaluation(state: WorkerSubgraphState, config: RunnableConfig) -> dict:
    """Iter1-Modus: Bewertet jede Query einzeln auf Qualitaet."""
    llm = get_llm(config)
    worker_task = state.get("worker_task", {})
    search_results = state.get("search_results", [])
    search_history = state.get("search_history", [])
    iteration = state.get("iteration_count", 1)
    good_query_ids = state.get("good_query_ids", [])

    task_id = worker_task.get("id", "unknown")
    description = worker_task.get("description", "")

    logger.info("Verifier [%s] Iter1: Bewerte %d Suchergebnisse...", task_id, len(search_results))

    failed_searches = [
        r
        for r in search_results
        if not r.get("results")
        and any("error" in fr for fr in r.get("filtered_results", []))
    ]
    if len(failed_searches) == len(search_results) and len(search_results) > 0:
        logger.warning("Verifier [%s]: ALLE %d Suchen fehlgeschlagen!", task_id, len(failed_searches))

    results_formatted = _format_search_results(search_results)

    history_text = (
        "\n".join(
            [f"- Query '{h['query_id']}': Quality={h['quality']}" for h in search_history]
        )
        if search_history
        else "Keine History"
    )

    structured_llm = llm.with_structured_output(VerifierOutput)

    messages = [
        {"role": "system", "content": VERIFIER_PROMPT},
        {
            "role": "user",
            "content": f"""Subtask: {description}

Iteration: {iteration}
Bereits gute Query-IDs: {good_query_ids}

Bisherige History:
{history_text}

Zu bewertende Suchergebnisse:
{results_formatted}

Bewerte jede Query einzeln und entscheide ueber die Gesamt-Qualitaet.""",
        },
    ]

    result: VerifierOutput = structured_llm.invoke(
        messages,
        config=merge_configs(config, {"run_name": f"verifier_{task_id}_iter{iteration}"}),
    )

    new_history = list(search_history)
    new_good_ids = list(good_query_ids)

    query_text_map = {r.get("query_id"): r.get("query_text", "") for r in search_results}

    for verdict in result.query_verdicts:
        entry = {
            "query_id": verdict.query_id,
            "query_text": query_text_map.get(verdict.query_id, ""),
            "quality": verdict.quality,
            "feedback": verdict.reasoning,
            "iteration": iteration,
        }
        new_history.append(entry)

        if verdict.quality == "high":
            new_good_ids.append(verdict.query_id)

    high_count = sum(1 for v in result.query_verdicts if v.quality == "high")
    medium_count = sum(1 for v in result.query_verdicts if v.quality == "medium")
    low_count = sum(1 for v in result.query_verdicts if v.quality == "low")

    logger.info("Verifier [%s]: %d high, %d medium, %d low", task_id, high_count, medium_count, low_count)

    return {
        "search_history": new_history,
        "good_query_ids": list(set(new_good_ids)),
    }


def _final_evaluation(state: WorkerSubgraphState, config: RunnableConfig) -> dict:
    """Iter2-Modus: Evaluiert Results und extrahiert ProjectData."""
    llm = get_final_eval_llm(config)
    worker_task = state.get("worker_task", {})
    search_results = state.get("search_results", [])

    task_id = worker_task.get("id", "unknown")
    description = worker_task.get("description", "")

    iter1_results = [r for r in search_results if "_iter1" in r.get("query_id", "")]
    iter2_results = [r for r in search_results if "_iter2" in r.get("query_id", "")]

    logger.info(
        "Final Evaluator [%s]: %d Iter1-Results, %d Iter2-Results",
        task_id, len(iter1_results), len(iter2_results),
    )

    structured_llm = llm.with_structured_output(WorkerFinalOutput)
    alle_projekte = []

    for group_name, group_results in [("iter1", iter1_results), ("iter2", iter2_results)]:
        if not group_results:
            continue

        results_formatted = _format_search_results(group_results, include_filtered=False)

        messages = [
            {"role": "system", "content": FINAL_EVALUATOR_PROMPT},
            {
                "role": "user",
                "content": f"""Subtask: {description}
Task-ID: {task_id}

Suchergebnisse ueber Threshold ({group_name}):
{results_formatted}

Evaluiere jedes Suchergebnis und extrahiere max. 5 echte Immobilienprojekte.""",
            },
        ]

        result: WorkerFinalOutput = structured_llm.invoke(
            messages,
            config=merge_configs(config, {"run_name": f"final_evaluator_{task_id}_{group_name}"}),
        )

        logger.info(
            "Final Evaluator [%s/%s]: %d Projekte extrahiert",
            task_id, group_name, len(result.projekte),
        )
        alle_projekte.extend(result.projekte)

    final_output = {
        "task_id": task_id,
        "projekte": [p.model_dump() for p in alle_projekte],
    }

    logger.info("Final Evaluator [%s]: %d Projekte gesamt (merged)", task_id, len(alle_projekte))

    return {"worker_results": [final_output]}


def _format_search_results(search_results: list[dict], include_filtered: bool = True) -> str:
    """Formatiert Suchergebnisse fuer LLM-Prompts."""
    results_text = []
    for r in search_results:
        query_id = r.get("query_id", "unknown")
        query_text = r.get("query_text", "")
        good = r.get("results", [])
        filtered = r.get("filtered_results", [])

        block = f"Query '{query_id}' ({query_text}):"

        if good:
            block += f"\n  Ergebnisse ueber Threshold ({len(good)}):"
            for item in good:
                score = item.get("score", 0.0)
                title = item.get("title", "Kein Titel")
                url = item.get("url", "")
                content = item.get("content", "")[:300]
                block += f'\n    - [{score:.2f}] "{title}" ({url})'
                block += f"\n      Inhalt: {content}"
        else:
            block += "\n  Keine Ergebnisse ueber Threshold."

        if include_filtered and filtered:
            block += f"\n  Ergebnisse unter Threshold ({len(filtered)}):"
            for item in filtered:
                if "error" in item:
                    block += f"\n    - FEHLER: {item['error']}"
                else:
                    score = item.get("score", 0.0)
                    title = item.get("title", "Kein Titel")
                    url = item.get("url", "")
                    block += f'\n    - [{score:.2f}] "{title}" ({url})'

        results_text.append(block)

    return "\n\n".join(results_text)


def _filter_ansprechpartner(kontakte: list[dict]) -> list[dict]:
    """Entfernt Eintraege ohne konkreten Personennamen."""
    return [
        k for k in kontakte
        if k.get("name", "unklar") not in ("unklar", "", "unbekannt")
    ]


def _extract_content_for_url(
    url: str, task_id: str, safe_name: str, config: RunnableConfig
) -> str:
    """Tavily Extract fuer eine einzelne URL."""
    extract_config = merge_configs(config, {"run_name": f"extract_{safe_name}"})

    try:
        raw = tavily_extract.invoke({"urls": [url]}, config=extract_config)

        if isinstance(raw, dict) and "error" in raw:
            logger.warning("Aggregator [%s] Extract [%s]: API-Fehler: %s", task_id, safe_name, raw["error"])
            return ""

        raw_results = raw.get("results", []) if isinstance(raw, dict) else []
        if raw_results:
            return raw_results[0].get("raw_content", "") or ""

    except Exception as e:
        logger.warning("Aggregator [%s] Extract [%s]: Fehlgeschlagen: %s", task_id, safe_name, e)

    return ""


def aggregator_node(state: WorkerSubgraphState, config: RunnableConfig) -> dict:
    """Reichert jedes Projekt per Tavily Extract + LLM an."""
    worker_task = state.get("worker_task", {})
    task_id = worker_task.get("id", "unknown")
    worker_results = state.get("worker_results", [])

    alle_projekte = []
    for result in worker_results:
        alle_projekte.extend(result.get("projekte", []))

    logger.info("Aggregator [%s]: Starte Anreicherung von %d Projekten", task_id, len(alle_projekte))

    if not alle_projekte:
        logger.warning("Aggregator [%s]: Keine Projekte zum Anreichern", task_id)
        return {"aggregator_results": []}

    llm = get_aggregator_llm(config)

    ais_liste = "\n".join(f"  - {t}" for t in AIS_THEMENFELDER)
    enrichment_prompt = AGGREGATOR_ENRICH_PROMPT.format(ais_themenfelder_liste=ais_liste)

    enriched_projects: list[dict] = []
    filtered_projects: list[dict] = []

    for i, projekt in enumerate(alle_projekte):
        projektname = projekt.get("projektname", f"projekt_{i}")
        quellen = projekt.get("quellen", [])
        safe_name = projektname[:40].replace(" ", "_")

        extracted_content = ""
        if quellen:
            extracted_content = _extract_content_for_url(quellen[0], task_id, safe_name, config)

        try:
            structured_llm = llm.with_structured_output(AggregatorProjectOutput)
            projekt_text = json.dumps(projekt, ensure_ascii=False, indent=2)

            content_section = (
                f"\n\nEXTRAHIERTER SEITENINHALT:\n{extracted_content}"
                if extracted_content
                else "\n\nKein Seiteninhalt verfuegbar. "
                "Fuege Felder basierend auf den vorhandenen Informationen "
                "bestmoeglich aus."
            )

            messages = [
                {"role": "system", "content": enrichment_prompt},
                {
                    "role": "user",
                    "content": (
                        f"BISHERIGE PROJEKTDATEN:\n{projekt_text}"
                        f"{content_section}"
                    ),
                },
            ]

            result: AggregatorProjectOutput = structured_llm.invoke(
                messages,
                config=merge_configs(config, {"run_name": f"enrich_{task_id}_{safe_name}"}),
            )

            enriched = result.projekt.model_dump()
            enriched["ansprechpartner"] = _filter_ansprechpartner(
                enriched.get("ansprechpartner", [])
            )

            if not enriched.get("ist_relevant", True):
                logger.info("Aggregator [%s]: '%s' als nicht relevant -> aussortiert", task_id, projektname)
                filtered_projects.append(enriched)
                continue

            enriched_projects.append(enriched)
            logger.debug(
                "Aggregator [%s]: '%s' angereichert (Potenzial: %s, Kontakte: %d)",
                task_id, projektname,
                enriched.get("beratungspotenzial", "?"),
                len(enriched.get("ansprechpartner", [])),
            )

        except Exception as e:
            logger.warning(
                "Aggregator [%s] Enrich [%s]: Fehlgeschlagen: %s. Uebernehme Originaldaten.",
                task_id, safe_name, e,
            )
            enriched_projects.append(projekt)

    logger.info(
        "Aggregator [%s]: %d relevant, %d aussortiert (von %d)",
        task_id, len(enriched_projects), len(filtered_projects), len(alle_projekte),
    )

    return {
        "aggregator_results": enriched_projects,
        "filtered_results": filtered_projects,
    }


# =============================================================================
# Routing
# =============================================================================


def route_to_tavily(state: WorkerSubgraphState) -> list:
    """Sendet jede neue Query parallel an Tavily Search."""
    queries = state.get("search_queries", [])
    good_query_ids = state.get("good_query_ids", [])

    new_queries = [q for q in queries if q.get("query_id") not in good_query_ids]

    if not new_queries:
        logger.debug("Keine neuen Queries - direkt zum Verifier")
        return ["verifier"]

    logger.debug("Sende %d Queries parallel an Tavily", len(new_queries))
    return [
        Send("tavily_search", {"current_query": query, **state})
        for query in new_queries
    ]


def route_after_verification(state: WorkerSubgraphState) -> str:
    """Immer 2 Iterationen. Iter1 -> retry, Iter2 -> aggregator."""
    iteration = state.get("iteration_count", 1)

    if iteration >= 2:
        logger.debug("Iter2 abgeschlossen -> aggregator")
        return "aggregator"

    logger.debug("Iter1 -> zurueck zu worker_query fuer Iter2")
    return "worker_query"


# =============================================================================
# Graph Creation
# =============================================================================


def create_worker_subgraph():
    """Erstellt den Worker-Subgraph-Builder (nicht kompiliert)."""
    subgraph = StateGraph(
        state_schema=WorkerSubgraphState,
        output_schema=WorkerSubgraphOutputState,
    )

    subgraph.add_node("worker_query", worker_query_node)
    subgraph.add_node("tavily_search", tavily_search_node)
    subgraph.add_node("verifier", verifier_node)
    subgraph.add_node("aggregator", aggregator_node)

    subgraph.add_edge(START, "worker_query")
    subgraph.add_conditional_edges(
        "worker_query", route_to_tavily, ["tavily_search", "verifier"]
    )
    subgraph.add_edge("tavily_search", "verifier")
    subgraph.add_conditional_edges(
        "verifier",
        route_after_verification,
        {"worker_query": "worker_query", "aggregator": "aggregator"},
    )
    subgraph.add_edge("aggregator", END)

    return subgraph
