"""SSE (Server-Sent Events) utilities for LangGraph-compatible streaming.

This module provides helpers for creating SSE responses that match
the LangGraph Runtime API framing specification.
"""

import json
from typing import Any

from robyn.robyn import Headers


def sse_headers(
    thread_id: str | None = None,
    run_id: str | None = None,
    stateless: bool = False,
) -> Headers:
    """Create SSE response headers matching LangGraph API.

    Args:
        thread_id: Thread ID for Location/Content-Location headers
        run_id: Run ID for Location/Content-Location headers
        stateless: If True, use stateless URL pattern (/runs/...)

    Returns:
        Headers configured for SSE streaming
    """
    headers = Headers({})
    headers.set("Content-Type", "text/event-stream; charset=utf-8")
    headers.set("Cache-Control", "no-store")
    headers.set("X-Accel-Buffering", "no")
    headers.set("Access-Control-Allow-Origin", "*")
    headers.set("Access-Control-Allow-Headers", "Cache-Control")

    # Set Location and Content-Location headers
    if run_id:
        if stateless:
            headers.set("Location", f"/runs/{run_id}/stream")
            headers.set("Content-Location", f"/runs/{run_id}")
        elif thread_id:
            headers.set("Location", f"/threads/{thread_id}/runs/{run_id}/stream")
            headers.set("Content-Location", f"/threads/{thread_id}/runs/{run_id}")

    return headers


def format_sse_event(event_type: str, data: Any) -> str:
    """Format data as an SSE event.

    Matches LangGraph API SSE framing:
    ```
    event: <event_type>
    data: <json_payload>

    ```

    Args:
        event_type: The event type (e.g., "metadata", "values", "updates")
        data: Data to serialize as JSON

    Returns:
        SSE-formatted string with event and data lines
    """
    if isinstance(data, str):
        json_data = data
    else:
        json_data = json.dumps(data, separators=(",", ":"))

    return f"event: {event_type}\ndata: {json_data}\n\n"


def format_metadata_event(run_id: str, attempt: int = 1) -> str:
    """Format the initial metadata SSE event.

    This is always the first event in a stream.

    Args:
        run_id: The run ID
        attempt: Attempt number (default: 1)

    Returns:
        SSE-formatted metadata event
    """
    return format_sse_event("metadata", {"run_id": run_id, "attempt": attempt})


def format_values_event(values: dict[str, Any]) -> str:
    """Format a values SSE event.

    Used for initial state and final state.

    Args:
        values: The state values (typically {"messages": [...]})

    Returns:
        SSE-formatted values event
    """
    return format_sse_event("values", values)


def format_updates_event(node_name: str, updates: dict[str, Any]) -> str:
    """Format an updates SSE event.

    Used for graph node updates.

    Args:
        node_name: The node that produced the update (e.g., "model")
        updates: The update data

    Returns:
        SSE-formatted updates event
    """
    return format_sse_event("updates", {node_name: updates})


def format_messages_tuple_event(
    message_delta: dict[str, Any],
    metadata: dict[str, Any],
) -> str:
    """Format a messages-tuple SSE event.

    Emits ``event: messages`` with a 2-element tuple ``[message_delta, metadata]``
    matching the protocol expected by ``@langchain/langgraph-sdk`` ≥ v1.6.0.

    The *message_delta* must contain only **new** content (a delta), not
    the accumulated text.  The SDK's ``MessageTupleManager.add()`` calls
    ``.concat()`` on message chunks, so sending accumulated content would
    result in duplicated text.

    Args:
        message_delta: Message dict whose ``content`` field holds only the
            new token(s) produced since the last event.
        metadata: Flat metadata dict (e.g. ``{"langgraph_node": "model", …}``).
            Included inline with every event so the SDK does not need a
            separate metadata event.

    Returns:
        SSE-formatted ``event: messages`` string.
    """
    return format_sse_event("messages", [message_delta, metadata])


def format_error_event(error: str, code: str | None = None) -> str:
    """Format an error SSE event.

    Args:
        error: Error message
        code: Optional error code

    Returns:
        SSE-formatted error event
    """
    data: dict[str, Any] = {"error": error}
    if code:
        data["code"] = code
    return format_sse_event("error", data)


def create_human_message(content: str, message_id: str | None = None) -> dict[str, Any]:
    """Create a human message in LangChain format.

    Args:
        content: Message content
        message_id: Optional message ID

    Returns:
        Human message dict
    """
    return {
        "content": content,
        "additional_kwargs": {},
        "response_metadata": {},
        "type": "human",
        "name": None,
        "id": message_id,
    }


def create_ai_message(
    content: str,
    message_id: str | None = None,
    finish_reason: str | None = None,
    model_name: str | None = None,
    model_provider: str = "openai",
) -> dict[str, Any]:
    """Create an AI message in LangChain format.

    Args:
        content: Message content
        message_id: Optional message ID
        finish_reason: Optional finish reason (e.g., "stop")
        model_name: Optional model name
        model_provider: Model provider (default: "openai")

    Returns:
        AI message dict
    """
    response_metadata: dict[str, Any] = {"model_provider": model_provider}
    if finish_reason:
        response_metadata["finish_reason"] = finish_reason
    if model_name:
        response_metadata["model_name"] = model_name

    return {
        "content": content,
        "additional_kwargs": {},
        "response_metadata": response_metadata,
        "type": "ai",
        "name": None,
        "id": message_id,
        "tool_calls": [],
        "invalid_tool_calls": [],
        "usage_metadata": None,
    }
