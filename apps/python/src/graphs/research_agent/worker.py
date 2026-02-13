"""Worker utilities for the research agent graph.

This module provides helpers for extracting structured research results
from the raw output of a ReAct agent invocation.  Each parallel worker
is a mini ``create_agent()`` instance that reasons and uses tools to
fulfil its assigned :class:`~graphs.research_agent.models.SearchTask`.

The extraction logic is intentionally lenient — it tries multiple
strategies (JSON parsing, regex, plain-text fallback) because the
worker LLM may not always produce perfectly structured output,
especially with weaker models or complex tool interactions.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any

logger = logging.getLogger(__name__)

# Regex to find JSON arrays or objects in freeform text.
_JSON_BLOCK_PATTERN = re.compile(
    r"```(?:json)?\s*\n?([\s\S]*?)```"  # fenced code blocks
    r"|"
    r"(\[[\s\S]*?\])"  # bare JSON arrays
    r"|"
    r"(\{[\s\S]*?\})",  # bare JSON objects
)


def extract_worker_output(
    agent_result: dict[str, Any],
    task: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Extract structured research results from a ReAct agent's output.

    The function inspects the agent's ``messages`` list (newest first)
    and attempts to parse structured JSON results.  If JSON extraction
    fails, it falls back to wrapping the plain-text response as a
    single :class:`~graphs.research_agent.models.ResearchResult`-shaped
    dict.

    Args:
        agent_result: The dict returned by ``agent.ainvoke()``.
            Expected to contain a ``"messages"`` key with a list of
            LangChain message objects.
        task: Optional task dict (a serialised
            :class:`~graphs.research_agent.models.SearchTask`).  Used
            to enrich the fallback result with task metadata.

    Returns:
        A dict with a ``"results"`` key containing a list of
        result dicts, each with at least ``title``, ``summary``,
        and ``metadata`` keys.  Always returns at least one result
        (the fallback).

    Example::

        raw = await worker_agent.ainvoke({"messages": [...]})
        output = extract_worker_output(raw, task=task_dict)
        # output == {"results": [{"title": ..., "summary": ..., ...}, ...]}
    """
    messages = agent_result.get("messages", [])
    if not messages:
        logger.warning("Worker returned no messages — producing empty result")
        return _fallback_result("No output from worker.", task)

    # Walk messages newest-first looking for AI/assistant content.
    for message in reversed(messages):
        content = _get_message_content(message)
        if not content:
            continue

        # Strategy 1: Try to parse structured JSON from the content.
        parsed = _try_parse_results_json(content)
        if parsed is not None:
            logger.debug(
                "Worker output: extracted %d structured results via JSON",
                len(parsed),
            )
            return {"results": parsed}

    # Strategy 2: Use the last AI message as plain-text fallback.
    last_content = _get_last_ai_content(messages)
    if last_content:
        logger.debug("Worker output: falling back to plain-text extraction")
        return _fallback_result(last_content, task)

    logger.warning("Worker output: no usable content found in messages")
    return _fallback_result("Worker produced no usable content.", task)


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _get_message_content(message: Any) -> str | None:
    """Extract the text content from a LangChain message object or dict.

    Handles both object-style (``message.content``) and dict-style
    (``message["content"]``) messages, as well as list-of-blocks
    content (multimodal messages).
    """
    if isinstance(message, dict):
        content = message.get("content", "")
    elif hasattr(message, "content"):
        content = message.content
    else:
        return None

    if isinstance(content, list):
        # Multimodal: extract text blocks only.
        text_parts = []
        for block in content:
            if isinstance(block, str):
                text_parts.append(block)
            elif isinstance(block, dict) and block.get("type") == "text":
                text_parts.append(block.get("text", ""))
        content = "\n".join(text_parts)

    if isinstance(content, str) and content.strip():
        return content.strip()
    return None


def _is_ai_message(message: Any) -> bool:
    """Check whether a message is from the AI / assistant."""
    if isinstance(message, dict):
        role = message.get("role", "")
        msg_type = message.get("type", "")
        return role in ("assistant", "ai") or msg_type in ("ai", "AIMessage")

    # Object-style — check class name or type attribute.
    type_name = getattr(message, "type", "")
    if type_name in ("ai", "AIMessage"):
        return True
    class_name = type(message).__name__
    return class_name in ("AIMessage", "AIMessageChunk")


def _get_last_ai_content(messages: list[Any]) -> str | None:
    """Return the text content of the last AI message in the list."""
    for message in reversed(messages):
        if _is_ai_message(message):
            content = _get_message_content(message)
            if content:
                return content
    return None


def _try_parse_results_json(text: str) -> list[dict[str, Any]] | None:
    """Try to extract a JSON array of result dicts from freeform text.

    Returns ``None`` if no valid JSON could be parsed.
    """
    # First, try the whole text as JSON.
    results = _try_parse_json_string(text)
    if results is not None:
        return results

    # Try extracting from code blocks or embedded JSON.
    for match in _JSON_BLOCK_PATTERN.finditer(text):
        candidate = match.group(1) or match.group(2) or match.group(3)
        if candidate:
            results = _try_parse_json_string(candidate.strip())
            if results is not None:
                return results

    return None


def _try_parse_json_string(text: str) -> list[dict[str, Any]] | None:
    """Parse a JSON string into a list of result dicts.

    Handles both a bare JSON array and a JSON object with a
    ``"results"`` key.  Returns ``None`` on any failure.
    """
    try:
        data = json.loads(text)
    except (json.JSONDecodeError, ValueError):
        return None

    if isinstance(data, list) and len(data) > 0:
        return _normalise_result_list(data)

    if isinstance(data, dict):
        # Could be {"results": [...]} or a single result object.
        if "results" in data and isinstance(data["results"], list):
            return _normalise_result_list(data["results"])
        if "title" in data or "summary" in data:
            return _normalise_result_list([data])

    return None


def _normalise_result_list(items: list[Any]) -> list[dict[str, Any]]:
    """Ensure every item in the list has the expected result keys."""
    normalised = []
    for item in items:
        if not isinstance(item, dict):
            continue
        normalised.append(
            {
                "title": str(item.get("title", "Untitled")),
                "summary": str(item.get("summary", item.get("description", ""))),
                "source_url": item.get("source_url") or item.get("url"),
                "relevance_score": _safe_float(
                    item.get("relevance_score") or item.get("score")
                ),
                "metadata": item.get("metadata", {}),
            }
        )
    return normalised if normalised else None  # type: ignore[return-value]


def _safe_float(value: Any) -> float | None:
    """Convert a value to float, returning ``None`` on failure."""
    if value is None:
        return None
    try:
        return float(value)
    except (ValueError, TypeError):
        return None


def _fallback_result(
    content: str,
    task: dict[str, Any] | None,
) -> dict[str, Any]:
    """Wrap plain-text content as a single-result output dict."""
    task_description = ""
    if task:
        task_description = task.get("description", task.get("search_focus", ""))

    title = task_description[:120] if task_description else "Research finding"
    return {
        "results": [
            {
                "title": title,
                "summary": content[:2000],  # Truncate very long outputs
                "source_url": None,
                "relevance_score": None,
                "metadata": {"extraction_method": "plain_text_fallback"},
            }
        ],
    }
