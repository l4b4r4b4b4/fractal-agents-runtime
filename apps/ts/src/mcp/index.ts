/**
 * MCP (Model Context Protocol) module.
 *
 * This module implements the MCP protocol endpoints for exposing
 * the LangGraph agent as an MCP server. External MCP clients
 * (Claude Desktop, Cursor, etc.) can use this agent as a tool.
 *
 * Port of: apps/python/src/server/mcp/__init__.py
 *
 * MCP Specification: https://modelcontextprotocol.io/
 */

export { mcpHandler, McpMethodHandler, McpInvalidParamsError } from "./handlers";

export {
  // JSON-RPC types
  JsonRpcErrorCode,
  type JsonRpcErrorCodeValue,
  type JsonRpcError,
  type JsonRpcRequest,
  type JsonRpcResponse,

  // MCP types
  type McpCapabilities,
  type McpClientInfo,
  type McpInitializeParams,
  type McpInitializeResult,
  type McpServerInfo,
  type McpTool,
  type McpToolCallContentItem,
  type McpToolCallParams,
  type McpToolCallResult,
  type McpToolInputSchema,
  type McpToolsListResult,

  // Helper functions
  createErrorResponse,
  createSuccessResponse,
  serialiseResponse,
  parseJsonRpcRequest,
} from "./schemas";

export {
  executeAgentRun,
  getAgentToolInfo,
  type ExecuteAgentRunOptions,
  type AgentToolInfo,
} from "./agent";
