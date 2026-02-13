"""Generic models for the research agent graph.

These models are intentionally **domain-agnostic**.  All domain-specific
data (e.g. ``asset_klasse``, ``stadt``) lives in the ``metadata`` /
``constraints`` dict fields and is injected via prompts, not code.

The graph uses these models for structured LLM output parsing
(``with_structured_output``) and for state serialisation.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Worker-level models
# ---------------------------------------------------------------------------


class SearchTask(BaseModel):
    """A single unit of work assigned to a research worker.

    The analyzer LLM produces a list of these.  Each one is dispatched
    to a parallel worker via the LangGraph ``Send`` API.

    Attributes:
        task_id: Unique identifier for this task (set by analyzer).
        description: Human-readable description of what to research.
        search_focus: The specific question or angle the worker should
            pursue with the available tools.
        constraints: Optional key-value constraints that narrow the
            search scope.  Prompt-driven — the graph never inspects
            these; it just passes them to the worker prompt.

    Example::

        SearchTask(
            task_id="task-1",
            description="Find recent logistics warehouse projects in Munich",
            search_focus="logistics warehouse development Munich 2025",
            constraints={"region": "Munich", "asset_class": "logistics"},
        )
    """

    task_id: str
    description: str
    search_focus: str
    constraints: dict[str, str] = Field(default_factory=dict)


class ResearchResult(BaseModel):
    """A single finding produced by a research worker.

    Workers extract these from their ReAct agent output.  The
    aggregator then combines results from all workers.

    Attributes:
        title: Short title or headline of the finding.
        summary: Paragraph-length description of the finding.
        source_url: URL of the primary source (if available).
        relevance_score: Optional 0.0–1.0 score assigned by the
            worker or aggregator LLM.
        metadata: Arbitrary key-value data.  Domain-specific fields
            (``projekt_name``, ``asset_klasse``, etc.) live here,
            driven entirely by the prompts.

    Example::

        ResearchResult(
            title="Logistikpark München-Ost",
            summary="A 45,000 sqm logistics park under development ...",
            source_url="https://example.com/article/123",
            relevance_score=0.85,
            metadata={"asset_klasse": "Logistik", "stadt": "München"},
        )
    """

    title: str
    summary: str
    source_url: str | None = None
    relevance_score: float | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


# ---------------------------------------------------------------------------
# Analyzer / Aggregator structured outputs
# ---------------------------------------------------------------------------


class AnalyzerOutput(BaseModel):
    """Structured output from the analyzer LLM call.

    The analyzer decomposes the user's query into independent search
    tasks that can run in parallel.

    Attributes:
        tasks: The list of search tasks to dispatch.
        reasoning: The analyzer's explanation of *why* it chose these
            tasks and how they cover the user's query.
    """

    tasks: list[SearchTask]
    reasoning: str


class AggregatorOutput(BaseModel):
    """Structured output from the aggregator LLM call.

    The aggregator combines worker results into a cohesive, ranked
    list and provides a synthesis summary.

    Attributes:
        results: De-duplicated, ranked research results.
        summary: An overall narrative synthesis of the findings.
        total_sources_reviewed: How many raw results were considered
            before filtering.
    """

    results: list[ResearchResult]
    summary: str
    total_sources_reviewed: int = 0
