"""Shared helper functions for Robyn API routes.

This module provides common utilities used across all route modules
to avoid code duplication.
"""

import json
from typing import Any

from robyn import Request, Response


def json_response(data: Any, status_code: int = 200) -> Response:
    """Create a JSON response.

    Args:
        data: Data to serialize to JSON. Can be a Pydantic model,
              list of Pydantic models, or any JSON-serializable object.
        status_code: HTTP status code (default: 200)

    Returns:
        Robyn Response with JSON body and appropriate headers
    """
    if hasattr(data, "model_dump"):
        # Pydantic model - use mode="json" for proper datetime serialization
        body = data.model_dump_json()
    elif isinstance(data, list) and data and hasattr(data[0], "model_dump"):
        # List of Pydantic models
        body = json.dumps([item.model_dump(mode="json") for item in data])
    else:
        body = json.dumps(data)

    return Response(
        status_code,
        {"Content-Type": "application/json"},
        body,
    )


def error_response(detail: str, status_code: int = 400) -> Response:
    """Create an error response matching LangGraph API format.

    The LangGraph API uses {"detail": "message"} for error responses.

    Args:
        detail: Error message
        status_code: HTTP status code (default: 400)

    Returns:
        Robyn Response with JSON error body
    """
    body = json.dumps({"detail": detail})
    return Response(
        status_code,
        {"Content-Type": "application/json"},
        body,
    )


def parse_json_body(request: Request) -> dict[str, Any]:
    """Parse JSON body from request.

    Args:
        request: Robyn request object

    Returns:
        Parsed JSON as dict. Returns empty dict if body is empty.

    Raises:
        json.JSONDecodeError: If body is not valid JSON
    """
    body = request.body
    if isinstance(body, bytes):
        body = body.decode("utf-8")
    if not body:
        return {}
    return json.loads(body)
