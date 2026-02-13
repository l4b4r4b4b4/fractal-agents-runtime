"""MCP (Model Context Protocol) module.

This module implements the MCP protocol endpoints for exposing
the LangGraph agent as an MCP server. External MCP clients
(Claude Desktop, Cursor, etc.) can use this agent as a tool.

MCP Specification: https://modelcontextprotocol.io/
"""

from server.mcp.handlers import mcp_handler
from server.mcp.schemas import (
    JsonRpcError,
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

__all__ = [
    # Handler
    "mcp_handler",
    # JSON-RPC types
    "JsonRpcError",
    "JsonRpcErrorCode",
    "JsonRpcRequest",
    "JsonRpcResponse",
    "create_error_response",
    "create_success_response",
    # MCP types
    "McpCapabilities",
    "McpInitializeParams",
    "McpInitializeResult",
    "McpServerInfo",
    "McpTool",
    "McpToolCallContentItem",
    "McpToolCallParams",
    "McpToolCallResult",
    "McpToolInputSchema",
    "McpToolsListResult",
]
