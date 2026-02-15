/**
 * MCP Protocol method handlers — JSON-RPC 2.0 method dispatch.
 *
 * Port of: apps/python/src/server/mcp/handlers.py
 *
 * Implements the JSON-RPC 2.0 method handlers for the MCP protocol.
 * The runtime exposes itself as an MCP server; external clients
 * (Claude Desktop, Cursor, etc.) can connect and invoke the agent
 * as a tool via `tools/call`.
 *
 * Supported methods:
 *   - `initialize` — Handshake; returns server capabilities
 *   - `initialized` — Notification; client confirms init complete
 *   - `tools/list` — Returns the `langgraph_agent` tool definition
 *   - `tools/call` — Invokes the agent with a message
 *   - `prompts/list` — Empty list (not supported)
 *   - `resources/list` — Empty list (not supported)
 *   - `ping` — Health check (returns empty object)
 *
 * MCP Specification: https://modelcontextprotocol.io/
 */

import type {
  JsonRpcRequest,
  JsonRpcResponse,
  McpClientInfo,
  McpInitializeResult,
  McpServerInfo,
  McpTool,
  McpToolCallContentItem,
  McpToolCallResult,
  McpToolInputSchema,
  McpToolsListResult,
} from "./schemas";
import {
  JsonRpcErrorCode,
  createErrorResponse,
  createSuccessResponse,
} from "./schemas";
import { executeAgentRun, getAgentToolInfo } from "./agent";
import type { AgentToolInfo } from "./agent";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * MCP Protocol version we support.
 *
 * 2025-03-26 — Streamable HTTP Transport specification.
 */
const PROTOCOL_VERSION = "2025-03-26";

/**
 * Server identification returned during initialization.
 */
const SERVER_INFO: McpServerInfo = {
  name: "fractal-agents-runtime",
  version: "0.0.3",
};

/**
 * Base tool description — always present; may be augmented dynamically
 * with information about the agent's configured sub-tools.
 */
const BASE_TOOL_DESCRIPTION =
  "Execute the LangGraph agent with a message. " +
  "The agent can use various tools to help answer questions and perform tasks.";

/**
 * JSON Schema for the `langgraph_agent` tool's input parameters.
 *
 * Matches the Python implementation's `_BASE_TOOL_INPUT_SCHEMA` exactly.
 */
const BASE_TOOL_INPUT_SCHEMA: McpToolInputSchema = {
  type: "object",
  properties: {
    message: {
      type: "string",
      description: "The user message to send to the agent",
    },
    thread_id: {
      type: "string",
      description:
        "Optional thread ID for conversation continuity. " +
        "If not provided, a new thread will be created.",
    },
    assistant_id: {
      type: "string",
      description: "Optional assistant ID to use. Defaults to 'agent'.",
    },
  },
  required: ["message"],
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build a dynamic tool description from agent introspection info.
 *
 * Appends information about available sub-tools (MCP tools) and model
 * name to the base description so that MCP clients know what the agent
 * can do.
 *
 * Mirrors Python's `_build_tool_description()` from `handlers.py`.
 *
 * @param toolInfo - Info returned by `getAgentToolInfo()`.
 * @returns Human-readable tool description string.
 */
function buildToolDescription(toolInfo: AgentToolInfo): string {
  const parts = [BASE_TOOL_DESCRIPTION];

  if (toolInfo.modelName) {
    parts.push(`\n\nModel: ${toolInfo.modelName}`);
  }

  if (toolInfo.mcpTools.length > 0) {
    const toolList = toolInfo.mcpTools.join(", ");
    parts.push(`\n\nAvailable tools: ${toolList}`);
  }

  return parts.join("");
}

// ---------------------------------------------------------------------------
// Method handler type
// ---------------------------------------------------------------------------

/**
 * A handler for a single JSON-RPC method.
 *
 * Receives the `params` dict from the request and returns a result
 * object (or throws to signal an error).
 */
type MethodHandler = (params: Record<string, unknown>) => Promise<unknown>;

// ---------------------------------------------------------------------------
// McpMethodHandler class
// ---------------------------------------------------------------------------

/**
 * Handler for MCP JSON-RPC methods.
 *
 * Routes incoming JSON-RPC requests to the appropriate method handler
 * and wires `tools/call` to real agent execution.
 *
 * Mirrors Python's `McpMethodHandler` from `server/mcp/handlers.py`.
 *
 * Usage:
 *
 *   const handler = new McpMethodHandler();
 *   const response = await handler.handleRequest(jsonRpcRequest);
 */
export class McpMethodHandler {
  /** Whether the `initialized` notification has been received. */
  private _initialized = false;

  /** Client info from the `initialize` handshake. */
  private _clientInfo: { name: string; version: string } | null = null;

  /** Method dispatch table. */
  private readonly _handlers: Record<string, MethodHandler>;

  constructor() {
    // Bind all handlers so they can be looked up by name.
    this._handlers = {
      initialize: this._handleInitialize.bind(this),
      initialized: this._handleInitialized.bind(this),
      "tools/list": this._handleToolsList.bind(this),
      "tools/call": this._handleToolsCall.bind(this),
      "prompts/list": this._handlePromptsList.bind(this),
      "resources/list": this._handleResourcesList.bind(this),
      ping: this._handlePing.bind(this),
    };
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Route a JSON-RPC request to the appropriate handler.
   *
   * @param request - The JSON-RPC request to handle.
   * @returns JSON-RPC response with result or error.
   */
  async handleRequest(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    const { method } = request;
    const params = request.params ?? {};

    console.log(`[mcp-handler] Request: method=${method} id=${request.id}`);

    const handler = this._handlers[method];
    if (handler === undefined) {
      console.warn(`[mcp-handler] Method not found: ${method}`);
      return createErrorResponse(
        request.id,
        JsonRpcErrorCode.METHOD_NOT_FOUND,
        `Method not found: ${method}`,
      );
    }

    try {
      const result = await handler(params);
      return createSuccessResponse(request.id, result);
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : String(error);

      // ValueError-style errors → INVALID_PARAMS
      if (error instanceof McpInvalidParamsError) {
        console.warn(`[mcp-handler] Invalid params: ${message}`);
        return createErrorResponse(
          request.id,
          JsonRpcErrorCode.INVALID_PARAMS,
          message,
        );
      }

      // Everything else → INTERNAL_ERROR
      console.error(`[mcp-handler] Internal error: ${message}`);
      return createErrorResponse(
        request.id,
        JsonRpcErrorCode.INTERNAL_ERROR,
        `Internal error: ${message}`,
      );
    }
  }

  /**
   * Whether the handler has completed the initialization handshake.
   */
  get initialized(): boolean {
    return this._initialized;
  }

  /**
   * The connected client's info, or `null` if not yet initialized.
   */
  get clientInfo(): { name: string; version: string } | null {
    return this._clientInfo;
  }

  // -----------------------------------------------------------------------
  // Method handlers
  // -----------------------------------------------------------------------

  /**
   * Handle the `initialize` method — handshake between client and server.
   *
   * @param params - Initialize parameters (clientInfo, protocolVersion).
   * @returns Server capabilities and info.
   */
  private async _handleInitialize(
    params: Record<string, unknown>,
  ): Promise<McpInitializeResult> {
    // Parse client info (lenient — continue with defaults on failure)
    try {
      const clientInfo =
        (params.clientInfo as McpClientInfo | undefined) ??
        (params.client_info as McpClientInfo | undefined);

      if (clientInfo && typeof clientInfo === "object") {
        this._clientInfo = {
          name: typeof clientInfo.name === "string" ? clientInfo.name : "unknown",
          version:
            typeof clientInfo.version === "string" ? clientInfo.version : "unknown",
        };
        console.log(
          `[mcp-handler] Client connected: ${this._clientInfo.name} v${this._clientInfo.version}`,
        );
      }
    } catch (parseError: unknown) {
      const message =
        parseError instanceof Error ? parseError.message : String(parseError);
      console.warn(
        `[mcp-handler] Failed to parse initialize params: ${message}`,
      );
    }

    return {
      protocolVersion: PROTOCOL_VERSION,
      serverInfo: SERVER_INFO,
      capabilities: {
        tools: {}, // We support tools
      },
    };
  }

  /**
   * Handle the `initialized` notification.
   *
   * Sent by the client after receiving the `initialize` response.
   * This is a notification — the response is ignored by the route handler.
   */
  private async _handleInitialized(
    _params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    this._initialized = true;
    console.log("[mcp-handler] Client initialization complete");
    return {};
  }

  /**
   * Handle the `tools/list` method.
   *
   * Dynamically builds the tool list by introspecting the agent's
   * configured capabilities (MCP sub-tools, model name).
   */
  private async _handleToolsList(
    _params: Record<string, unknown>,
  ): Promise<McpToolsListResult> {
    const tool = await this._getDynamicAgentTool();
    return { tools: [tool] };
  }

  /**
   * Handle the `tools/call` method.
   *
   * Executes the `langgraph_agent` tool with the given arguments.
   */
  private async _handleToolsCall(
    params: Record<string, unknown>,
  ): Promise<McpToolCallResult> {
    // Validate params
    const toolName = params.name;
    if (typeof toolName !== "string" || toolName.length === 0) {
      throw new McpInvalidParamsError("Missing required field: name");
    }

    if (toolName !== "langgraph_agent") {
      throw new McpInvalidParamsError(`Unknown tool: ${toolName}`);
    }

    const args =
      params.arguments && typeof params.arguments === "object"
        ? (params.arguments as Record<string, unknown>)
        : {};

    const message = args.message;
    if (typeof message !== "string" || message.length === 0) {
      throw new McpInvalidParamsError("Missing required argument: message");
    }

    const threadId =
      typeof args.thread_id === "string" ? args.thread_id : undefined;
    const assistantId =
      typeof args.assistant_id === "string" ? args.assistant_id : "agent";

    // Execute the agent
    try {
      const resultText = await executeAgentRun(message, {
        threadId,
        assistantId,
      });

      const content: McpToolCallContentItem[] = [
        { type: "text", text: resultText },
      ];

      return { content, isError: false };
    } catch (executionError: unknown) {
      const errorMessage =
        executionError instanceof Error
          ? executionError.message
          : String(executionError);
      console.error(`[mcp-handler] Agent execution failed: ${errorMessage}`);

      const content: McpToolCallContentItem[] = [
        { type: "text", text: `Error: ${errorMessage}` },
      ];

      return { content, isError: true };
    }
  }

  /**
   * Handle the `prompts/list` method.
   *
   * We don't expose prompts — return empty list.
   */
  private async _handlePromptsList(
    _params: Record<string, unknown>,
  ): Promise<{ prompts: unknown[] }> {
    return { prompts: [] };
  }

  /**
   * Handle the `resources/list` method.
   *
   * We don't expose resources — return empty list.
   */
  private async _handleResourcesList(
    _params: Record<string, unknown>,
  ): Promise<{ resources: unknown[] }> {
    return { resources: [] };
  }

  /**
   * Handle the `ping` method.
   *
   * Simple health check — returns empty object.
   */
  private async _handlePing(
    _params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return {};
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  /**
   * Build the `langgraph_agent` tool definition with dynamic description.
   *
   * Introspects the default assistant's config to include information
   * about available sub-tools and capabilities in the tool description.
   */
  private async _getDynamicAgentTool(): Promise<McpTool> {
    let description = BASE_TOOL_DESCRIPTION;

    try {
      const toolInfo = await getAgentToolInfo();
      description = buildToolDescription(toolInfo);
    } catch (introspectError: unknown) {
      const message =
        introspectError instanceof Error
          ? introspectError.message
          : String(introspectError);
      console.log(
        `[mcp-handler] Could not introspect agent tools: ${message} — using base description`,
      );
    }

    return {
      name: "langgraph_agent",
      description,
      inputSchema: BASE_TOOL_INPUT_SCHEMA,
    };
  }
}

// ---------------------------------------------------------------------------
// Custom error types
// ---------------------------------------------------------------------------

/**
 * Error thrown for invalid JSON-RPC method parameters.
 *
 * Caught by `handleRequest()` and translated to a JSON-RPC error with
 * code `-32602` (INVALID_PARAMS).
 */
export class McpInvalidParamsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpInvalidParamsError";
  }
}

// ---------------------------------------------------------------------------
// Global handler instance
// ---------------------------------------------------------------------------

/**
 * Singleton MCP method handler instance.
 *
 * Used by the route handler in `routes/mcp.ts`. A single instance
 * maintains client info and initialization state across requests
 * (stateless between server restarts).
 */
export const mcpHandler = new McpMethodHandler();
