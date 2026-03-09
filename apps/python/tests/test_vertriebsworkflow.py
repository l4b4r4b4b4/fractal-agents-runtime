"""Unit-Tests fuer den Vertriebsworkflow-Graphen.

Testet reine Logik-Funktionen (kein LLM, kein Tavily):
- Pydantic-Modelle (defaults, validation, serialization)
- analyzer_node (Subtask-Generierung)
- collect_and_export_node + Dedup-Logik
- Routing-Funktionen (should_continue, route_to_tavily, route_after_verification)
- Worker-Helpers (_resolve_model, _format_search_results, _filter_ansprechpartner)
- Graph-Erstellung (create_workflow, create_worker_subgraph)
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest
from langchain_core.messages import AIMessage


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------


class TestIntakeDecision:
    def test_defaults(self) -> None:
        from graphs.vertriebsworkflow.models import IntakeDecision

        decision = IntakeDecision(
            ist_startbereit=False,
            antwort="Bitte nenne mir eine Stadt.",
        )
        assert decision.ist_startbereit is False
        assert decision.stadt is None
        assert decision.antwort == "Bitte nenne mir eine Stadt."

    def test_with_stadt(self) -> None:
        from graphs.vertriebsworkflow.models import IntakeDecision

        decision = IntakeDecision(
            ist_startbereit=True,
            stadt="Muenchen",
            antwort="Starte Suche fuer Muenchen.",
        )
        assert decision.stadt == "Muenchen"
        assert decision.ist_startbereit is True


class TestProjectData:
    def test_defaults(self) -> None:
        from graphs.vertriebsworkflow.models import ProjectData

        project = ProjectData(
            projektname="Testprojekt",
            stadt="Berlin",
            asset_klasse="Buero",
            quellen=["https://example.com"],
        )
        assert project.lph_phase == "unklar"
        assert project.projektstatus == "unklar"
        assert project.info_qualitaet == "niedrig"

    def test_roundtrip(self) -> None:
        from graphs.vertriebsworkflow.models import ProjectData

        data = {
            "projektname": "Neubau Mitte",
            "stadt": "Hamburg",
            "asset_klasse": "Hotel",
            "lph_phase": "LPH 4",
            "projektstatus": "Genehmigung",
            "quellen": ["https://a.de", "https://b.de"],
            "info_qualitaet": "hoch",
        }
        project = ProjectData(**data)
        dumped = project.model_dump()
        assert dumped["projektname"] == "Neubau Mitte"
        assert len(dumped["quellen"]) == 2


class TestFinalProjectData:
    def test_defaults(self) -> None:
        from graphs.vertriebsworkflow.models import FinalProjectData

        project = FinalProjectData(
            projektname="FP Test",
            stadt="Koeln",
            asset_klasse="Logistik",
            quellen=["https://example.com"],
        )
        assert project.groessenordnung == "unklar"
        assert project.beratungspotenzial == "mittel"
        assert project.ist_relevant is True
        assert project.ansprechpartner == []
        assert project.ais_themenfelder == []

    def test_with_ansprechpartner(self) -> None:
        from graphs.vertriebsworkflow.models import Ansprechpartner, FinalProjectData

        kontakt = Ansprechpartner(name="Max Muster", firma="Dev GmbH")
        project = FinalProjectData(
            projektname="FP Test",
            stadt="Koeln",
            asset_klasse="Logistik",
            quellen=["https://example.com"],
            ansprechpartner=[kontakt],
        )
        assert len(project.ansprechpartner) == 1
        assert project.ansprechpartner[0].rolle == "unklar"


class TestAnsprechpartner:
    def test_defaults(self) -> None:
        from graphs.vertriebsworkflow.models import Ansprechpartner

        person = Ansprechpartner()
        assert person.name == "unklar"
        assert person.rolle == "unklar"
        assert person.firma == "unklar"
        assert person.email == "unklar"
        assert person.quelle == ""


class TestSearchModels:
    def test_search_query(self) -> None:
        from graphs.vertriebsworkflow.models import SearchQuery

        query = SearchQuery(
            query_id="q1_iter1",
            query_text="Buero Muenchen 2024",
            reasoning="Breite Basis-Query",
        )
        assert query.query_id == "q1_iter1"

    def test_search_queries_output(self) -> None:
        from graphs.vertriebsworkflow.models import SearchQueriesOutput

        output = SearchQueriesOutput(new_queries=[], strategy_notes="Initiale Suche")
        assert output.new_queries == []
        assert output.strategy_notes == "Initiale Suche"

    def test_tavily_search_result(self) -> None:
        from graphs.vertriebsworkflow.models import TavilySearchResult

        result = TavilySearchResult(query_id="q1_iter1", query_text="test")
        assert result.results == []
        assert result.filtered_count == 0

    def test_query_verdict(self) -> None:
        from graphs.vertriebsworkflow.models import QueryVerdict

        verdict = QueryVerdict(
            query_id="q1_iter1",
            quality="high",
            reasoning="Gute Ergebnisse",
        )
        assert verdict.improvement_suggestion == ""

    def test_verifier_output(self) -> None:
        from graphs.vertriebsworkflow.models import QueryVerdict, VerifierOutput

        output = VerifierOutput(
            query_verdicts=[
                QueryVerdict(
                    query_id="q1_iter1",
                    quality="medium",
                    reasoning="OK",
                )
            ],
            overall_reasoning="Brauchbar",
        )
        assert len(output.query_verdicts) == 1

    def test_worker_final_output(self) -> None:
        from graphs.vertriebsworkflow.models import WorkerFinalOutput

        output = WorkerFinalOutput(task_id="buero")
        assert output.projekte == []


class TestAggregatorProjectOutput:
    def test_wraps_final_project(self) -> None:
        from graphs.vertriebsworkflow.models import (
            AggregatorProjectOutput,
            FinalProjectData,
        )

        project = FinalProjectData(
            projektname="Test",
            stadt="Berlin",
            asset_klasse="Buero",
            quellen=["https://example.com"],
        )
        wrapper = AggregatorProjectOutput(projekt=project)
        assert wrapper.projekt.projektname == "Test"


class TestAisThemenfelder:
    def test_constants(self) -> None:
        from graphs.vertriebsworkflow.models import AIS_THEMENFELDER

        assert isinstance(AIS_THEMENFELDER, list)
        assert len(AIS_THEMENFELDER) == 13
        assert "Technische Due Diligence" in AIS_THEMENFELDER


# ---------------------------------------------------------------------------
# Prompts
# ---------------------------------------------------------------------------


class TestPrompts:
    def test_intake_prompt_exists(self) -> None:
        from graphs.vertriebsworkflow.prompts import INTAKE_SYSTEM_PROMPT

        assert isinstance(INTAKE_SYSTEM_PROMPT, str)
        assert "Immobilien" in INTAKE_SYSTEM_PROMPT

    def test_subtasks_structure(self) -> None:
        from graphs.vertriebsworkflow.prompts import SUBTASKS

        assert len(SUBTASKS) == 5
        ids = {t["id"] for t in SUBTASKS}
        assert ids == {"buero", "logistik", "hotel", "einzelhandel", "mixed_use"}
        for task in SUBTASKS:
            assert "{stadt}" in task["description"]
            assert "asset_klasse" in task

    def test_worker_query_prompt(self) -> None:
        from graphs.vertriebsworkflow.prompts import WORKER_QUERY_PROMPT

        assert "{asset_klasse}" in WORKER_QUERY_PROMPT
        assert "{stadt}" in WORKER_QUERY_PROMPT

    def test_aggregator_prompt(self) -> None:
        from graphs.vertriebsworkflow.prompts import AGGREGATOR_ENRICH_PROMPT

        assert "{ais_themenfelder_liste}" in AGGREGATOR_ENRICH_PROMPT

    def test_verifier_prompt(self) -> None:
        from graphs.vertriebsworkflow.prompts import VERIFIER_PROMPT

        assert isinstance(VERIFIER_PROMPT, str)

    def test_final_evaluator_prompt(self) -> None:
        from graphs.vertriebsworkflow.prompts import FINAL_EVALUATOR_PROMPT

        assert "ProjectData" in FINAL_EVALUATOR_PROMPT


# ---------------------------------------------------------------------------
# __init__
# ---------------------------------------------------------------------------


class TestInit:
    def test_graph_exported(self) -> None:
        from graphs.vertriebsworkflow import graph

        assert callable(graph)


# ---------------------------------------------------------------------------
# graph.py — Pure-Logic Nodes
# ---------------------------------------------------------------------------


class TestAnalyzerNode:
    def test_creates_5_tasks(self) -> None:
        from graphs.vertriebsworkflow.graph import analyzer_node

        state = {"user_input": "  Muenchen  "}
        result = analyzer_node(state)

        assert len(result["task_list"]) == 5
        assert result["stadt"] == "Muenchen"
        for task in result["task_list"]:
            assert "Muenchen" in task["description"]
            assert task["stadt"] == "Muenchen"

    def test_status_message(self) -> None:
        from graphs.vertriebsworkflow.graph import analyzer_node

        result = analyzer_node({"user_input": "Berlin"})
        messages = result["messages"]
        assert len(messages) == 1
        assert isinstance(messages[0], AIMessage)
        assert "Berlin" in messages[0].content
        assert "5" in messages[0].content


class TestDeduplicateProjects:
    def test_no_duplicates(self) -> None:
        from graphs.vertriebsworkflow.graph import _deduplicate_projects

        projects = [
            {"projektname": "Alpha", "quellen": ["https://a.de"]},
            {"projektname": "Beta", "quellen": ["https://b.de"]},
        ]
        result = _deduplicate_projects(projects)
        assert len(result) == 2

    def test_duplicate_by_name(self) -> None:
        from graphs.vertriebsworkflow.graph import _deduplicate_projects

        projects = [
            {"projektname": "Alpha", "quellen": ["https://a.de"]},
            {"projektname": "Alpha", "quellen": ["https://c.de"], "stadt": "Berlin"},
        ]
        result = _deduplicate_projects(projects)
        assert len(result) == 1
        assert result[0].get("stadt") == "Berlin"

    def test_duplicate_by_url(self) -> None:
        from graphs.vertriebsworkflow.graph import _deduplicate_projects

        projects = [
            {"projektname": "Alpha", "quellen": ["https://same.de"]},
            {"projektname": "Beta", "quellen": ["https://same.de"]},
        ]
        result = _deduplicate_projects(projects)
        assert len(result) == 1

    def test_keeps_richer_entry(self) -> None:
        from graphs.vertriebsworkflow.graph import _deduplicate_projects

        sparse = {"projektname": "Alpha", "quellen": []}
        rich = {
            "projektname": "Alpha",
            "quellen": ["https://a.de"],
            "stadt": "Hamburg",
            "asset_klasse": "Buero",
        }
        result = _deduplicate_projects([sparse, rich])
        assert len(result) == 1
        assert result[0].get("stadt") == "Hamburg"

    def test_empty_input(self) -> None:
        from graphs.vertriebsworkflow.graph import _deduplicate_projects

        assert _deduplicate_projects([]) == []

    def test_duplicate_skipped_when_existing_is_richer(self) -> None:
        from graphs.vertriebsworkflow.graph import _deduplicate_projects

        rich = {
            "projektname": "Alpha",
            "quellen": ["https://a.de"],
            "stadt": "Hamburg",
            "asset_klasse": "Buero",
            "info_qualitaet": "hoch",
        }
        sparse = {"projektname": "Alpha", "quellen": []}
        result = _deduplicate_projects([rich, sparse])
        assert len(result) == 1
        assert result[0].get("stadt") == "Hamburg"


class TestCountFilledFields:
    def test_empty_project(self) -> None:
        from graphs.vertriebsworkflow.graph import _count_filled_fields

        assert _count_filled_fields({}) == 0

    def test_unklar_not_counted(self) -> None:
        from graphs.vertriebsworkflow.graph import _count_filled_fields

        assert _count_filled_fields({"lph_phase": "unklar"}) == 0

    def test_filled_strings(self) -> None:
        from graphs.vertriebsworkflow.graph import _count_filled_fields

        count = _count_filled_fields({"stadt": "Berlin", "name": "Test"})
        assert count == 2

    def test_boolean_counted(self) -> None:
        from graphs.vertriebsworkflow.graph import _count_filled_fields

        assert _count_filled_fields({"ist_relevant": True}) == 1
        assert _count_filled_fields({"ist_relevant": False}) == 1

    def test_list_fields(self) -> None:
        from graphs.vertriebsworkflow.graph import _count_filled_fields

        assert _count_filled_fields({"quellen": ["https://a.de"]}) == 1
        assert _count_filled_fields({"quellen": []}) == 0
        assert _count_filled_fields({"ais_themenfelder": ["ESG"]}) == 1

    def test_empty_string_not_counted(self) -> None:
        from graphs.vertriebsworkflow.graph import _count_filled_fields

        assert _count_filled_fields({"stadt": ""}) == 0


class TestCollectAndExportNode:
    def test_basic_aggregation(self) -> None:
        from graphs.vertriebsworkflow.graph import collect_and_export_node

        state = {
            "aggregator_results": [
                {
                    "projektname": "A",
                    "asset_klasse": "Buero",
                    "quellen": ["https://a.de"],
                },
                {
                    "projektname": "B",
                    "asset_klasse": "Hotel",
                    "quellen": ["https://b.de"],
                },
            ],
            "filtered_results": [],
        }
        result = collect_and_export_node(state)
        assert len(result["final_projects"]) == 2
        assert len(result["messages"]) == 1
        assert "2" in result["messages"][0].content

    def test_dedup_in_collect(self) -> None:
        from graphs.vertriebsworkflow.graph import collect_and_export_node

        state = {
            "aggregator_results": [
                {"projektname": "Same", "quellen": ["https://a.de"]},
                {"projektname": "Same", "quellen": ["https://b.de"]},
            ],
            "filtered_results": [],
        }
        result = collect_and_export_node(state)
        assert len(result["final_projects"]) == 1
        assert "1 Duplikate" in result["messages"][0].content

    def test_empty_results(self) -> None:
        from graphs.vertriebsworkflow.graph import collect_and_export_node

        result = collect_and_export_node(
            {"aggregator_results": [], "filtered_results": []}
        )
        assert result["final_projects"] == []


class TestShouldContinue:
    def test_creates_sends(self) -> None:
        from graphs.vertriebsworkflow.graph import should_continue

        state = {
            "task_list": [
                {"id": "buero", "asset_klasse": "Buero"},
                {"id": "hotel", "asset_klasse": "Hotel"},
            ]
        }
        sends = should_continue(state)
        assert len(sends) == 2


class TestMakeWorkerNode:
    def test_invokes_subgraph(self) -> None:
        from graphs.vertriebsworkflow.graph import make_worker_node

        mock_subgraph = MagicMock()
        mock_subgraph.invoke.return_value = {
            "aggregator_results": [{"projektname": "Test"}],
            "filtered_results": [],
        }

        node = make_worker_node(mock_subgraph)
        result = node({"worker_task": {"id": "buero", "asset_klasse": "Buero"}})

        mock_subgraph.invoke.assert_called_once()
        assert len(result["messages"]) == 1
        assert "Buero" in result["messages"][0].content

    def test_empty_task(self) -> None:
        from graphs.vertriebsworkflow.graph import make_worker_node

        mock_subgraph = MagicMock()
        mock_subgraph.invoke.return_value = {
            "aggregator_results": [],
            "filtered_results": [],
        }

        node = make_worker_node(mock_subgraph)
        result = node({"worker_task": None})
        assert "0" in result["messages"][0].content


# ---------------------------------------------------------------------------
# worker_subgraph.py — Helpers
# ---------------------------------------------------------------------------


class TestResolveModel:
    def test_env_var_takes_priority(self) -> None:
        from graphs.vertriebsworkflow.worker_subgraph import _resolve_model

        with patch.dict("os.environ", {"TEST_MODEL": "gpt-test"}):
            result = _resolve_model({}, "TEST_MODEL", "fallback")
        assert result == "gpt-test"

    def test_config_used_if_no_env(self) -> None:
        from graphs.vertriebsworkflow.worker_subgraph import _resolve_model

        with patch.dict("os.environ", {}, clear=False):
            config = {"configurable": {"model_name": "from-config"}}
            result = _resolve_model(config, "NONEXISTENT_ENV_VAR_XYZ", "default")
        assert result == "from-config"

    def test_default_fallback(self) -> None:
        from graphs.vertriebsworkflow.worker_subgraph import _resolve_model

        with patch.dict("os.environ", {}, clear=False):
            result = _resolve_model({}, "NONEXISTENT_ENV_VAR_XYZ", "gpt-4.1")
        assert result == "gpt-4.1"

    def test_none_config(self) -> None:
        from graphs.vertriebsworkflow.worker_subgraph import _resolve_model

        with patch.dict("os.environ", {}, clear=False):
            result = _resolve_model(None, "NONEXISTENT_ENV_VAR_XYZ", "default")
        assert result == "default"


class TestFormatSearchResults:
    def test_empty(self) -> None:
        from graphs.vertriebsworkflow.worker_subgraph import _format_search_results

        assert _format_search_results([]) == ""

    def test_with_results(self) -> None:
        from graphs.vertriebsworkflow.worker_subgraph import _format_search_results

        results = [
            {
                "query_id": "q1_iter1",
                "query_text": "Buero Muenchen",
                "results": [
                    {
                        "score": 0.8,
                        "title": "Neubau",
                        "url": "https://a.de",
                        "content": "Beschreibung",
                    }
                ],
                "filtered_results": [
                    {"score": 0.3, "title": "Irrelevant", "url": "https://b.de"}
                ],
            }
        ]
        text = _format_search_results(results)
        assert "q1_iter1" in text
        assert "Neubau" in text
        assert "Irrelevant" in text

    def test_without_filtered(self) -> None:
        from graphs.vertriebsworkflow.worker_subgraph import _format_search_results

        results = [
            {
                "query_id": "q1",
                "query_text": "test",
                "results": [],
                "filtered_results": [
                    {"score": 0.2, "title": "X", "url": "https://x.de"}
                ],
            }
        ]
        text = _format_search_results(results, include_filtered=False)
        assert "X" not in text
        assert "Keine Ergebnisse ueber Threshold" in text

    def test_error_in_filtered(self) -> None:
        from graphs.vertriebsworkflow.worker_subgraph import _format_search_results

        results = [
            {
                "query_id": "q1",
                "query_text": "test",
                "results": [],
                "filtered_results": [{"error": "API Fehler"}],
            }
        ]
        text = _format_search_results(results)
        assert "FEHLER" in text
        assert "API Fehler" in text


class TestFilterAnsprechpartner:
    def test_removes_unklar(self) -> None:
        from graphs.vertriebsworkflow.worker_subgraph import _filter_ansprechpartner

        kontakte = [
            {"name": "Max Muster", "firma": "Test GmbH"},
            {"name": "unklar", "firma": "Unknown"},
            {"name": "", "firma": "Empty"},
            {"name": "unbekannt", "firma": "Also Unknown"},
        ]
        result = _filter_ansprechpartner(kontakte)
        assert len(result) == 1
        assert result[0]["name"] == "Max Muster"

    def test_empty_input(self) -> None:
        from graphs.vertriebsworkflow.worker_subgraph import _filter_ansprechpartner

        assert _filter_ansprechpartner([]) == []

    def test_missing_name_key(self) -> None:
        from graphs.vertriebsworkflow.worker_subgraph import _filter_ansprechpartner

        result = _filter_ansprechpartner([{"firma": "No Name Key"}])
        assert len(result) == 0


class TestRouteToTavily:
    def test_sends_new_queries(self) -> None:
        from graphs.vertriebsworkflow.worker_subgraph import route_to_tavily

        state = {
            "search_queries": [
                {"query_id": "q1_iter1", "query_text": "test1"},
                {"query_id": "q2_iter1", "query_text": "test2"},
            ],
            "good_query_ids": [],
        }
        result = route_to_tavily(state)
        assert len(result) == 2

    def test_skips_good_queries(self) -> None:
        from graphs.vertriebsworkflow.worker_subgraph import route_to_tavily

        state = {
            "search_queries": [
                {"query_id": "q1_iter1", "query_text": "test1"},
                {"query_id": "q2_iter1", "query_text": "test2"},
            ],
            "good_query_ids": ["q1_iter1"],
        }
        result = route_to_tavily(state)
        assert len(result) == 1

    def test_no_new_queries_goes_to_verifier(self) -> None:
        from graphs.vertriebsworkflow.worker_subgraph import route_to_tavily

        state = {
            "search_queries": [{"query_id": "q1_iter1"}],
            "good_query_ids": ["q1_iter1"],
        }
        result = route_to_tavily(state)
        assert result == ["verifier"]


class TestRouteAfterVerification:
    def test_iter1_retries(self) -> None:
        from graphs.vertriebsworkflow.worker_subgraph import route_after_verification

        assert route_after_verification({"iteration_count": 1}) == "worker_query"

    def test_iter2_goes_to_aggregator(self) -> None:
        from graphs.vertriebsworkflow.worker_subgraph import route_after_verification

        assert route_after_verification({"iteration_count": 2}) == "aggregator"

    def test_iter3_goes_to_aggregator(self) -> None:
        from graphs.vertriebsworkflow.worker_subgraph import route_after_verification

        assert route_after_verification({"iteration_count": 3}) == "aggregator"


class TestVerifierNodeRouting:
    """Test that verifier_node dispatches correctly based on iteration."""

    @patch("graphs.vertriebsworkflow.worker_subgraph._final_evaluation")
    def test_dispatches_to_final_on_iter2(self, mock_final: MagicMock) -> None:
        from graphs.vertriebsworkflow.worker_subgraph import verifier_node

        mock_final.return_value = {"worker_results": []}
        state = {"iteration_count": 2, "worker_task": {}, "search_results": []}
        config = {}
        verifier_node(state, config)
        mock_final.assert_called_once()

    @patch("graphs.vertriebsworkflow.worker_subgraph._query_evaluation")
    def test_dispatches_to_query_eval_on_iter1(self, mock_query: MagicMock) -> None:
        from graphs.vertriebsworkflow.worker_subgraph import verifier_node

        mock_query.return_value = {"search_history": [], "good_query_ids": []}
        state = {"iteration_count": 1, "worker_task": {}, "search_results": []}
        config = {}
        verifier_node(state, config)
        mock_query.assert_called_once()


# ---------------------------------------------------------------------------
# Graph construction (smoke tests)
# ---------------------------------------------------------------------------


class TestCreateWorkerSubgraph:
    def test_builder_has_nodes(self) -> None:
        from graphs.vertriebsworkflow.worker_subgraph import create_worker_subgraph

        builder = create_worker_subgraph()
        node_names = set(builder.nodes.keys())
        assert "worker_query" in node_names
        assert "tavily_search" in node_names
        assert "verifier" in node_names
        assert "aggregator" in node_names

    def test_compiles(self) -> None:
        from graphs.vertriebsworkflow.worker_subgraph import create_worker_subgraph

        compiled = create_worker_subgraph().compile()
        assert compiled is not None


class TestCreateWorkflow:
    def test_compiles(self) -> None:
        from graphs.vertriebsworkflow.graph import create_workflow

        compiled = create_workflow()
        assert compiled is not None

    def test_has_expected_nodes(self) -> None:
        from graphs.vertriebsworkflow.graph import create_workflow

        compiled = create_workflow()
        node_names = set(compiled.get_graph().nodes.keys())
        assert "intake" in node_names
        assert "analyzer" in node_names
        assert "worker" in node_names
        assert "collect_and_export" in node_names


class TestGraphFactory:
    @pytest.mark.asyncio
    async def test_graph_factory_returns_compiled(self) -> None:
        from graphs.vertriebsworkflow.graph import graph

        compiled = await graph({})
        assert compiled is not None
