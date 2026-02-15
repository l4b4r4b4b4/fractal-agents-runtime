/**
 * MCP Protocol schemas — JSON-RPC 2.0 and MCP-specific types.
 *
 * Port of: apps/python/src/server/mcp/schemas.py
 *
 * Implements the data types for the Model Context Protocol (MCP)
 * Streamable HTTP Transport specification. The runtime exposes itself
 * as an MCP server that external clients (Claude Desktop, Cursor, etc.)
 * can connect to and invoke the agent as a tool.
 *
 * MCP Specification: https://modelcontextprotocol.io/
 */

// ============================================================================
// JSON-RPC 2.0 Error Codes
// ============================================================================

/**
 * Standard JSON-RPC 2.0 error codes.
 *
 * These are the well-known error codes defined by the JSON-RPC 2.0
 * specification. Custom server errors use codes in the -32000 to -32099 range.
 */
export const JsonRpcErrorCode = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

export type JsonRpcErrorCodeValue =
  (typeof JsonRpcErrorCode)[keyof typeof JsonRpcErrorCode];

// ============================================================================
// JSON-RPC 2.0 Base Types
// ============================================================================

/**
 * JSON-RPC 2.0 request object.
 *
 * When `id` is `null` or absent, the request is a notification — the server
 * should not send a response.
 */
export interface JsonRpcRequest {
  /** JSON-RPC version — always "2.0". */
  jsonrpc: "2.0";

  /** Request identifier. `null` for notifications. */
  id: string | number | null;

  /** Method name to invoke (e.g., "initialize", "tools/list", "tools/call"). */
  method: string;

  /** Optional method parameters. */
  params?: Record<string, unknown>;
}

/**
 * JSON-RPC 2.0 error object.
 */
export interface JsonRpcError {
  /** Error code (negative integer). */
  code: number;

  /** Human-readable error message. */
  message: string;

  /** Optional additional error data. */
  data?: unknown;
}

/**
 * JSON-RPC 2.0 response object.
 *
 * Exactly one of `result` or `error` should be present. The `model_dump`
 * helper serialises the response accordingly.
 */
export interface JsonRpcResponse {
  /** JSON-RPC version — always "2.0". */
  jsonrpc: "2.0";

  /** Request identifier (echoed from the request). */
  id: string | number | null;

  /** Success result (mutually exclusive with `error`). */
  result?: unknown;

  /** Error result (mutually exclusive with `result`). */
  error?: JsonRpcError;
}

// ============================================================================
// MCP Protocol Types
// ============================================================================

/**
 * MCP client information sent during initialization.
 */
export interface McpClientInfo {
  /** Client name (e.g., "claude-desktop", "cursor"). */
  name: string;

  /** Client version string. */
  version: string;
}

/**
 * MCP server/client capabilities.
 *
 * Each key is a capability category. A non-null object indicates support.
 */
export interface McpCapabilities {
  tools?: Record<string, unknown> | null;
  prompts?: Record<string, unknown> | null;
  resources?: Record<string, unknown> | null;
  logging?: Record<string, unknown> | null;
}

/**
 * MCP server information returned during initialization.
 */
export interface McpServerInfo {
  /** Server name. */
  name: string;

  /** Server version string. */
  version: string;
}

/**
 * Parameters for the `initialize` method.
 *
 * The MCP spec uses camelCase for these fields; we accept both.
 */
export interface McpInitializeParams {
  /** Client information. */
  clientInfo?: McpClientInfo;
  client_info?: McpClientInfo;

  /** Protocol version requested by the client. */
  protocolVersion?: string;
  protocol_version?: string;

  /** Client capabilities. */
  capabilities?: McpCapabilities | null;
}

/**
 * Result of the `initialize` method.
 */
export interface McpInitializeResult {
  /** Protocol version the server supports. */
  protocolVersion: string;

  /** Server identification. */
  serverInfo: McpServerInfo;

  /** Server capabilities. */
  capabilities: McpCapabilities;
}

// ============================================================================
// MCP Tool Types
// ============================================================================

/**
 * JSON Schema for a tool's input parameters.
 */
export interface McpToolInputSchema {
  type: "object";
  properties: Record<string, unknown>;
  required: string[];
}

/**
 * MCP tool definition — describes a callable tool.
 */
export interface McpTool {
  /** Tool name (identifier used in `tools/call`). */
  name: string;

  /** Human-readable tool description. */
  description: string;

  /** JSON Schema for the tool's input parameters. */
  inputSchema: McpToolInputSchema;
}

/**
 * Result of the `tools/list` method.
 */
export interface McpToolsListResult {
  tools: McpTool[];
}

/**
 * Parameters for the `tools/call` method.
 */
export interface McpToolCallParams {
  /** Tool name to invoke. */
  name: string;

  /** Tool arguments (key-value pairs). */
  arguments: Record<string, unknown>;
}

/**
 * A single content item in a tool call result.
 */
export interface McpToolCallContentItem {
  /** Content type: "text", "image", or "resource". */
  type: "text" | "image" | "resource";

  /** Text content (when type is "text"). */
  text?: string;

  /** Base64-encoded data (when type is "image" or "resource"). */
  data?: string;

  /** MIME type of the content. */
  mimeType?: string;
}

/**
 * Result of the `tools/call` method.
 */
export interface McpToolCallResult {
  /** Content items returned by the tool. */
  content: McpToolCallContentItem[];

  /** Whether the result represents an error. */
  isError: boolean;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Create a JSON-RPC 2.0 error response.
 *
 * @param requestId - The request ID to echo back (or `null` for parse errors).
 * @param code - JSON-RPC error code.
 * @param message - Human-readable error message.
 * @param data - Optional additional error data.
 * @returns A serialisable JSON-RPC response object.
 */
export function createErrorResponse(
  requestId: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id: requestId,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  };
}

/**
 * Create a JSON-RPC 2.0 success response.
 *
 * @param requestId - The request ID to echo back.
 * @param result - The method result.
 * @returns A serialisable JSON-RPC response object.
 */
export function createSuccessResponse(
  requestId: string | number | null,
  result: unknown,
): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id: requestId,
    result,
  };
}

/**
 * Serialise a JSON-RPC response for the wire.
 *
 * Mirrors the Python `model_dump` override: excludes `result` when `error`
 * is set, and vice versa — ensuring only one of the two appears in the
 * JSON output.
 *
 * @param response - The JSON-RPC response object.
 * @returns A plain object safe for `JSON.stringify()`.
 */
export function serialiseResponse(
  response: JsonRpcResponse,
): Record<string, unknown> {
  const output: Record<string, unknown> = {
    jsonrpc: response.jsonrpc,
    id: response.id,
  };

  if (response.error !== undefined) {
    output.error = response.error;
  } else {
    output.result = response.result;
  }

  return output;
}

/**
 * Parse and validate a raw JSON object as a JSON-RPC 2.0 request.
 *
 * Returns `null` if the object is not a valid request shape.
 *
 * @param data - The parsed JSON object.
 * @returns A validated `JsonRpcRequest`, or `null` if invalid.
 */
export function parseJsonRpcRequest(
  data: unknown,
): JsonRpcRequest | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return null;
  }

  const obj = data as Record<string, unknown>;

  // `method` is required and must be a string
  if (typeof obj.method !== "string" || obj.method.length === 0) {
    return null;
  }

  // `id` is optional — null means notification
  const id =
    obj.id === undefined
      ? null
      : typeof obj.id === "string" || typeof obj.id === "number"
        ? obj.id
        : null;

  // `params` is optional — must be an object if present
  let params: Record<string, unknown> | undefined;
  if (obj.params !== undefined && obj.params !== null) {
    if (typeof obj.params === "object" && !Array.isArray(obj.params)) {
      params = obj.params as Record<string, unknown>;
    }
    // If params is not an object, we ignore it (lenient parsing)
  }

  return {
    jsonrpc: "2.0",
    id,
    method: obj.method,
    ...(params !== undefined ? { params } : {}),
  };
}
