"""MCP Protocol method handlers.

Implements the JSON-RPC 2.0 method handlers for MCP protocol.
Wired to real agent execution via ``robyn_server.agent.execute_agent_run``
and dynamic tool listing via ``robyn_server.agent.get_agent_tool_info``.
"""

import logging
from typing import Any

from robyn_server.mcp.schemas import (
    JsonRpcErrorCode,
    JsonRpcRequest,
    JsonRpcResponse,
    McpCapabilities,
    McpInitializeParams,
    McpInitializeResult,
    McpServerInfo,
    McpTool,
    McpToolCallContentItem,
    McpToolCallParams,
    McpToolCallResult,
    McpToolInputSchema,
    McpToolsListResult,
    create_error_response,
    create_success_response,
)

logger = logging.getLogger(__name__)

# MCP Protocol version we support (2025-03-26 — Streamable HTTP Transport)
PROTOCOL_VERSION = "2025-03-26"

# Server information
SERVER_INFO = McpServerInfo(
    name="oap-langgraph-agent",
    version="0.1.0",
)

# Base tool definition — always present, description updated dynamically.
_BASE_TOOL_DESCRIPTION = (
    "Execute the LangGraph agent with a message. "
    "The agent can use various tools to help answer questions and perform tasks."
)

_BASE_TOOL_INPUT_SCHEMA = McpToolInputSchema(
    type="object",
    properties={
        "message": {
            "type": "string",
            "description": "The user message to send to the agent",
        },
        "thread_id": {
            "type": "string",
            "description": (
                "Optional thread ID for conversation continuity. "
                "If not provided, a new thread will be created."
            ),
        },
        "assistant_id": {
            "type": "string",
            "description": "Optional assistant ID to use. Defaults to 'agent'.",
        },
    },
    required=["message"],
)


def _build_tool_description(tool_info: dict[str, Any]) -> str:
    """Build a dynamic tool description from agent introspection info.

    Appends information about available sub-tools (MCP tools, RAG
    collections) to the base description so that MCP clients know
    what the agent can do.

    Args:
        tool_info: Dict returned by ``get_agent_tool_info()``.

    Returns:
        Human-readable tool description string.
    """
    parts = [_BASE_TOOL_DESCRIPTION]

    mcp_tools: list[str] = tool_info.get("mcp_tools", [])
    rag_collections: list[str] = tool_info.get("rag_collections", [])
    model_name: str | None = tool_info.get("model_name")

    if model_name:
        parts.append(f"\n\nModel: {model_name}")

    if mcp_tools:
        tool_list = ", ".join(mcp_tools)
        parts.append(f"\n\nAvailable tools: {tool_list}")

    if rag_collections:
        collection_count = len(rag_collections)
        parts.append(
            f"\n\nRAG knowledge base: {collection_count} collection(s) available"
        )

    return "".join(parts)


class McpMethodHandler:
    """Handler for MCP JSON-RPC methods.

    Routes incoming JSON-RPC requests to the appropriate handler and
    wires ``tools/call`` to real agent execution.
    """

    def __init__(self) -> None:
        """Initialize the method handler."""
        self._initialized = False
        self._client_info: dict[str, Any] | None = None

    async def handle_request(self, request: JsonRpcRequest) -> JsonRpcResponse:
        """Route a JSON-RPC request to the appropriate handler.

        Args:
            request: The JSON-RPC request to handle.

        Returns:
            JSON-RPC response with result or error.
        """
        method = request.method
        params = request.params or {}

        logger.debug("MCP request: method=%s, id=%s", method, request.id)

        # Route to appropriate handler
        handler_map = {
            "initialize": self._handle_initialize,
            "initialized": self._handle_initialized,
            "tools/list": self._handle_tools_list,
            "tools/call": self._handle_tools_call,
            "prompts/list": self._handle_prompts_list,
            "resources/list": self._handle_resources_list,
            "ping": self._handle_ping,
        }

        handler = handler_map.get(method)
        if handler is None:
            logger.warning("MCP method not found: %s", method)
            return create_error_response(
                request.id,
                JsonRpcErrorCode.METHOD_NOT_FOUND,
                f"Method not found: {method}",
            )

        try:
            result = await handler(params)
            return create_success_response(request.id, result)
        except ValueError as value_error:
            logger.error("MCP invalid params: %s", value_error)
            return create_error_response(
                request.id,
                JsonRpcErrorCode.INVALID_PARAMS,
                str(value_error),
            )
        except Exception as handler_error:
            logger.exception("MCP internal error: %s", handler_error)
            return create_error_response(
                request.id,
                JsonRpcErrorCode.INTERNAL_ERROR,
                f"Internal error: {handler_error}",
            )

    async def _handle_initialize(self, params: dict[str, Any]) -> dict[str, Any]:
        """Handle the initialize method.

        This is the handshake between client and server.

        Args:
            params: Initialize parameters including clientInfo and protocolVersion.

        Returns:
            Server capabilities and info.
        """
        try:
            init_params = McpInitializeParams.model_validate(params)
            self._client_info = {
                "name": init_params.client_info.name,
                "version": init_params.client_info.version,
            }
            logger.info(
                "MCP client connected: %s v%s",
                init_params.client_info.name,
                init_params.client_info.version,
            )
        except Exception as parse_error:
            logger.warning("Failed to parse initialize params: %s", parse_error)
            # Continue anyway with defaults

        # Return server capabilities
        result = McpInitializeResult(
            protocol_version=PROTOCOL_VERSION,
            server_info=SERVER_INFO,
            capabilities=McpCapabilities(
                tools={},  # We support tools
            ),
        )

        return result.model_dump(by_alias=True)

    async def _handle_initialized(self, params: dict[str, Any]) -> dict[str, Any]:
        """Handle the initialized notification.

        This is sent by the client after receiving initialize response.
        It's a notification (no response needed), but we return empty dict.

        Args:
            params: Empty or ignored.

        Returns:
            Empty dict (this is a notification).
        """
        self._initialized = True
        logger.info("MCP client initialization complete")
        return {}

    async def _handle_tools_list(self, params: dict[str, Any]) -> dict[str, Any]:
        """Handle the tools/list method.

        Dynamically builds the tool list by introspecting the agent's
        configured capabilities (MCP sub-tools, RAG collections, model).

        Args:
            params: Optional cursor for pagination (not implemented).

        Returns:
            List of available tools with dynamic descriptions.
        """
        tool = await self._get_dynamic_agent_tool()
        result = McpToolsListResult(tools=[tool])
        return result.model_dump(by_alias=True)

    async def _get_dynamic_agent_tool(self) -> McpTool:
        """Build the ``langgraph_agent`` tool definition with dynamic description.

        Introspects the default assistant's config to include information
        about available sub-tools and capabilities in the tool description.

        Returns:
            McpTool with a dynamically built description.
        """
        try:
            from robyn_server.agent import get_agent_tool_info

            tool_info = await get_agent_tool_info()
            description = _build_tool_description(tool_info)
        except Exception as introspect_error:
            logger.debug(
                "Could not introspect agent tools: %s — using base description",
                introspect_error,
            )
            description = _BASE_TOOL_DESCRIPTION

        return McpTool(
            name="langgraph_agent",
            description=description,
            input_schema=_BASE_TOOL_INPUT_SCHEMA,
        )

    async def _handle_tools_call(self, params: dict[str, Any]) -> dict[str, Any]:
        """Handle the tools/call method.

        Executes a tool with the given arguments. Currently only the
        ``langgraph_agent`` tool is supported.

        Args:
            params: Tool name and arguments.

        Returns:
            Tool execution result.
        """
        try:
            call_params = McpToolCallParams.model_validate(params)
        except Exception as validation_error:
            raise ValueError(
                f"Invalid tool call params: {validation_error}"
            ) from validation_error

        if call_params.name != "langgraph_agent":
            raise ValueError(f"Unknown tool: {call_params.name}")

        # Extract arguments
        message = call_params.arguments.get("message")
        if not message:
            raise ValueError("Missing required argument: message")

        thread_id = call_params.arguments.get("thread_id")
        assistant_id = call_params.arguments.get("assistant_id", "agent")

        # Execute the agent
        try:
            result_text = await self._execute_agent(
                message=message,
                thread_id=thread_id,
                assistant_id=assistant_id,
            )
            result = McpToolCallResult(
                content=[McpToolCallContentItem(type="text", text=result_text)],
                is_error=False,
            )
        except Exception as execution_error:
            logger.exception("Agent execution failed: %s", execution_error)
            result = McpToolCallResult(
                content=[
                    McpToolCallContentItem(
                        type="text", text=f"Error: {execution_error}"
                    )
                ],
                is_error=True,
            )

        return result.model_dump(by_alias=True)

    async def _execute_agent(
        self,
        message: str,
        thread_id: str | None = None,
        assistant_id: str = "agent",
    ) -> str:
        """Execute the LangGraph agent with a message.

        Delegates to ``robyn_server.agent.execute_agent_run`` for real
        agent execution.

        Args:
            message: The user message to send.
            thread_id: Optional thread ID for continuity.
            assistant_id: Assistant ID to use.

        Returns:
            The agent's response text.
        """
        # Import inside method to avoid circular imports at module level.
        from robyn_server.agent import execute_agent_run

        result = await execute_agent_run(
            message=message,
            thread_id=thread_id,
            assistant_id=assistant_id,
        )

        # execute_agent_run always returns a string
        return result

    async def _handle_prompts_list(self, params: dict[str, Any]) -> dict[str, Any]:
        """Handle the prompts/list method.

        We don't expose prompts, so return empty list.

        Args:
            params: Optional cursor for pagination.

        Returns:
            Empty prompts list.
        """
        return {"prompts": []}

    async def _handle_resources_list(self, params: dict[str, Any]) -> dict[str, Any]:
        """Handle the resources/list method.

        We don't expose resources, so return empty list.

        Args:
            params: Optional cursor for pagination.

        Returns:
            Empty resources list.
        """
        return {"resources": []}

    async def _handle_ping(self, params: dict[str, Any]) -> dict[str, Any]:
        """Handle the ping method.

        Simple health check.

        Args:
            params: Ignored.

        Returns:
            Empty dict (pong).
        """
        return {}


# Global handler instance
mcp_handler = McpMethodHandler()
