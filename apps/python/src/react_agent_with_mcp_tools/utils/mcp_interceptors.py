"""MCP tool interceptors for langchain-mcp-adapters.

Provides middleware-like interceptors that wrap MCP tool calls to handle
cross-cutting concerns like authentication errors, logging, and retries.

These interceptors are passed to ``MultiServerMCPClient`` via the
``tool_interceptors`` parameter and execute in "onion" order (first
interceptor in the list is the outermost layer).

Usage::

    from langchain_mcp_adapters.client import MultiServerMCPClient
    from react_agent_with_mcp_tools.utils.mcp_interceptors import handle_interaction_required

    client = MultiServerMCPClient(
        {...},
        tool_interceptors=[handle_interaction_required],
    )
"""

import logging
from typing import Any

from langchain_core.tools import ToolException
from langchain_mcp_adapters.interceptors import MCPToolCallRequest
from mcp import McpError

logger = logging.getLogger(__name__)


def _find_first_mcp_error_nested(exception: BaseException) -> McpError | None:
    """Walk a (possibly nested) exception tree to find the first ``McpError``.

    The MCP SDK can raise ``McpError`` directly or wrap it inside an
    ``ExceptionGroup`` when multiple tasks fail concurrently.  This helper
    recurses into ``ExceptionGroup.exceptions`` to locate the root MCP error.

    Args:
        exception: The caught exception (may be an ``ExceptionGroup``).

    Returns:
        The first ``McpError`` found, or ``None``.
    """
    if isinstance(exception, McpError):
        return exception
    if isinstance(exception, ExceptionGroup):
        for sub_exception in exception.exceptions:
            if found := _find_first_mcp_error_nested(sub_exception):
                return found
    return None


def _extract_interaction_message(error_data: dict[str, Any]) -> str:
    """Build a user-facing message from an ``interaction_required`` error payload.

    The MCP ``interaction_required`` error (code -32003) may carry a nested
    ``message`` dict with a ``text`` field and/or a ``url`` for the user to
    visit.  This helper extracts both into a single string that the LLM can
    present to the user (e.g. as a clickable link).

    Args:
        error_data: The ``data`` dict from the MCP error response.

    Returns:
        A human-readable error message, optionally including the URL.
    """
    message_payload = error_data.get("message", {})
    error_message_text = "Required interaction"
    if isinstance(message_payload, dict):
        error_message_text = message_payload.get("text") or error_message_text

    if url := error_data.get("url"):
        error_message_text = f"{error_message_text} {url}"

    return error_message_text


async def handle_interaction_required(
    request: MCPToolCallRequest,
    handler: Any,
) -> Any:
    """Intercept ``interaction_required`` MCP errors and raise ``ToolException``.

    When an MCP server responds with error code ``-32003``
    (``interaction_required``), the raw ``McpError`` is caught and converted
    into a LangChain ``ToolException`` with a clean, user-facing message.
    This prevents noisy stack traces from cluttering the logs and gives the
    LLM a structured error it can relay to the user.

    All other exceptions are re-raised unmodified.

    Args:
        request: The incoming MCP tool call request (contains tool name, args,
            runtime context).
        handler: The next handler in the interceptor chain.  Call
            ``await handler(request)`` to proceed with the actual tool
            invocation.

    Returns:
        The tool call result if the call succeeds.

    Raises:
        ToolException: If the MCP server returns ``interaction_required``.
    """
    try:
        return await handler(request)
    except BaseException as exception:
        mcp_error = _find_first_mcp_error_nested(exception)

        if not mcp_error:
            raise

        error_details = mcp_error.error
        is_interaction_required = getattr(error_details, "code", None) == -32003
        error_data = getattr(error_details, "data", None) or {}

        if is_interaction_required:
            error_message = _extract_interaction_message(error_data)
            logger.info(
                "MCP interaction_required for tool=%s: %s",
                request.name,
                error_message,
            )
            raise ToolException(error_message) from exception

        raise
