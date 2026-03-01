/**
 * MCP server endpoint tests for the Fractal Agents Runtime — TypeScript/Bun.
 *
 * Tests the MCP server endpoint that exposes the runtime AS an MCP server:
 *   - `schemas.ts` — JSON-RPC 2.0 types, parsing, serialisation helpers
 *   - `handlers.ts` — McpMethodHandler dispatch, method routing, error handling
 *   - `routes/mcp.ts` — HTTP route handlers (POST/GET/DELETE /mcp/)
 *   - `agent.ts` — extractResponseText, getAgentToolInfo, buildMcpRunnableConfig
 *
 * All tests use mocks — no real LLM calls or MCP servers required.
 *
 * Reference: apps/python/src/server/mcp/ (schemas.py, handlers.py, __init__.py)
 *            apps/python/src/server/routes/mcp.py
 *            apps/python/src/server/agent.py
 */

import { describe, test, expect, beforeEach } from "bun:test";

import {
  JsonRpcErrorCode,
  createErrorResponse,
  createSuccessResponse,
  serialiseResponse,
  parseJsonRpcRequest,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "../src/mcp/schemas";

import {
  McpMethodHandler,
  McpInvalidParamsError,
  mcpHandler,
} from "../src/mcp/handlers";

import { router } from "../src/index";

// ---------------------------------------------------------------------------
// schemas.ts — JsonRpcErrorCode constants
// ---------------------------------------------------------------------------

describe("MCP schemas — JsonRpcErrorCode", () => {
  test("PARSE_ERROR is -32700", () => {
    expect(JsonRpcErrorCode.PARSE_ERROR).toBe(-32700);
  });

  test("INVALID_REQUEST is -32600", () => {
    expect(JsonRpcErrorCode.INVALID_REQUEST).toBe(-32600);
  });

  test("METHOD_NOT_FOUND is -32601", () => {
    expect(JsonRpcErrorCode.METHOD_NOT_FOUND).toBe(-32601);
  });

  test("INVALID_PARAMS is -32602", () => {
    expect(JsonRpcErrorCode.INVALID_PARAMS).toBe(-32602);
  });

  test("INTERNAL_ERROR is -32603", () => {
    expect(JsonRpcErrorCode.INTERNAL_ERROR).toBe(-32603);
  });
});

// ---------------------------------------------------------------------------
// schemas.ts — createErrorResponse
// ---------------------------------------------------------------------------

describe("MCP schemas — createErrorResponse", () => {
  test("creates error response with all fields", () => {
    const response = createErrorResponse(1, -32600, "Invalid request", {
      detail: "missing method",
    });

    expect(response.jsonrpc).toBe("2.0");
    expect(response.id).toBe(1);
    expect(response.error).toBeDefined();
    expect(response.error!.code).toBe(-32600);
    expect(response.error!.message).toBe("Invalid request");
    expect(response.error!.data).toEqual({ detail: "missing method" });
    expect(response.result).toBeUndefined();
  });

  test("creates error response without data", () => {
    const response = createErrorResponse("req-1", -32601, "Method not found");

    expect(response.id).toBe("req-1");
    expect(response.error!.code).toBe(-32601);
    expect(response.error!.message).toBe("Method not found");
    expect(response.error!.data).toBeUndefined();
  });

  test("creates error response with null id (parse error)", () => {
    const response = createErrorResponse(null, -32700, "Parse error");

    expect(response.id).toBeNull();
    expect(response.error!.code).toBe(-32700);
  });
});

// ---------------------------------------------------------------------------
// schemas.ts — createSuccessResponse
// ---------------------------------------------------------------------------

describe("MCP schemas — createSuccessResponse", () => {
  test("creates success response with result", () => {
    const response = createSuccessResponse(42, { tools: [] });

    expect(response.jsonrpc).toBe("2.0");
    expect(response.id).toBe(42);
    expect(response.result).toEqual({ tools: [] });
    expect(response.error).toBeUndefined();
  });

  test("creates success response with null result", () => {
    const response = createSuccessResponse("req-2", null);

    expect(response.id).toBe("req-2");
    expect(response.result).toBeNull();
    expect(response.error).toBeUndefined();
  });

  test("creates success response with string id", () => {
    const response = createSuccessResponse("abc-123", { ok: true });

    expect(response.id).toBe("abc-123");
    expect(response.result).toEqual({ ok: true });
  });

  test("creates success response with empty object result", () => {
    const response = createSuccessResponse(1, {});

    expect(response.result).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// schemas.ts — serialiseResponse
// ---------------------------------------------------------------------------

describe("MCP schemas — serialiseResponse", () => {
  test("serialises success response — includes result, excludes error", () => {
    const response: JsonRpcResponse = {
      jsonrpc: "2.0",
      id: 1,
      result: { tools: [] },
    };

    const output = serialiseResponse(response);

    expect(output.jsonrpc).toBe("2.0");
    expect(output.id).toBe(1);
    expect(output.result).toEqual({ tools: [] });
    expect(output.error).toBeUndefined();
  });

  test("serialises error response — includes error, excludes result", () => {
    const response: JsonRpcResponse = {
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32601, message: "Method not found" },
    };

    const output = serialiseResponse(response);

    expect(output.jsonrpc).toBe("2.0");
    expect(output.id).toBe(1);
    expect(output.error).toEqual({ code: -32601, message: "Method not found" });
    expect(output.result).toBeUndefined();
  });

  test("serialises response with null id", () => {
    const response: JsonRpcResponse = {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    };

    const output = serialiseResponse(response);

    expect(output.id).toBeNull();
  });

  test("prioritises error over result when both present", () => {
    // This shouldn't happen per spec, but serialiseResponse should handle it
    const response: JsonRpcResponse = {
      jsonrpc: "2.0",
      id: 1,
      result: "should not appear",
      error: { code: -32603, message: "Internal error" },
    };

    const output = serialiseResponse(response);

    expect(output.error).toBeDefined();
    expect(output.result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// schemas.ts — parseJsonRpcRequest
// ---------------------------------------------------------------------------

describe("MCP schemas — parseJsonRpcRequest", () => {
  test("parses valid request with all fields", () => {
    const data = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: { cursor: null },
    };

    const result = parseJsonRpcRequest(data);

    expect(result).not.toBeNull();
    expect(result!.jsonrpc).toBe("2.0");
    expect(result!.id).toBe(1);
    expect(result!.method).toBe("tools/list");
    expect(result!.params).toEqual({ cursor: null });
  });

  test("parses request with string id", () => {
    const data = { jsonrpc: "2.0", id: "req-abc", method: "initialize" };

    const result = parseJsonRpcRequest(data);

    expect(result).not.toBeNull();
    expect(result!.id).toBe("req-abc");
  });

  test("parses notification (no id) — id defaults to null", () => {
    const data = { jsonrpc: "2.0", method: "initialized" };

    const result = parseJsonRpcRequest(data);

    expect(result).not.toBeNull();
    expect(result!.id).toBeNull();
    expect(result!.method).toBe("initialized");
  });

  test("parses request without params", () => {
    const data = { jsonrpc: "2.0", id: 1, method: "ping" };

    const result = parseJsonRpcRequest(data);

    expect(result).not.toBeNull();
    expect(result!.params).toBeUndefined();
  });

  test("returns null for non-object input", () => {
    expect(parseJsonRpcRequest("not-an-object")).toBeNull();
    expect(parseJsonRpcRequest(42)).toBeNull();
    expect(parseJsonRpcRequest(null)).toBeNull();
    expect(parseJsonRpcRequest(true)).toBeNull();
  });

  test("returns null for array input", () => {
    expect(parseJsonRpcRequest([1, 2, 3])).toBeNull();
  });

  test("returns null when method is missing", () => {
    expect(parseJsonRpcRequest({ jsonrpc: "2.0", id: 1 })).toBeNull();
  });

  test("returns null when method is empty string", () => {
    expect(
      parseJsonRpcRequest({ jsonrpc: "2.0", id: 1, method: "" }),
    ).toBeNull();
  });

  test("returns null when method is not a string", () => {
    expect(
      parseJsonRpcRequest({ jsonrpc: "2.0", id: 1, method: 42 }),
    ).toBeNull();
  });

  test("ignores non-object params (lenient)", () => {
    const result = parseJsonRpcRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "test",
      params: "not-an-object",
    });

    expect(result).not.toBeNull();
    expect(result!.params).toBeUndefined();
  });

  test("ignores array params (lenient)", () => {
    const result = parseJsonRpcRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "test",
      params: [1, 2, 3],
    });

    expect(result).not.toBeNull();
    expect(result!.params).toBeUndefined();
  });

  test("id of non-string/non-number type defaults to null", () => {
    const result = parseJsonRpcRequest({
      jsonrpc: "2.0",
      id: { complex: true },
      method: "test",
    });

    expect(result).not.toBeNull();
    expect(result!.id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// McpInvalidParamsError
// ---------------------------------------------------------------------------

describe("MCP handlers — McpInvalidParamsError", () => {
  test("creates error with correct name", () => {
    const error = new McpInvalidParamsError("Missing field");

    expect(error.name).toBe("McpInvalidParamsError");
    expect(error.message).toBe("Missing field");
  });

  test("inherits from Error", () => {
    const error = new McpInvalidParamsError("test");

    expect(error).toBeInstanceOf(Error);
  });
});

// ---------------------------------------------------------------------------
// McpMethodHandler — initialize
// ---------------------------------------------------------------------------

describe("MCP handlers — initialize", () => {
  let handler: McpMethodHandler;

  beforeEach(() => {
    handler = new McpMethodHandler();
  });

  test("returns protocolVersion, serverInfo, and capabilities", async () => {
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "test-client", version: "1.0" },
        protocolVersion: "2025-03-26",
      },
    };

    const response = await handler.handleRequest(request);

    expect(response.jsonrpc).toBe("2.0");
    expect(response.id).toBe(1);
    expect(response.error).toBeUndefined();
    expect(response.result).toBeDefined();

    const result = response.result as Record<string, unknown>;
    expect(result.protocolVersion).toBe("2025-03-26");
    expect(result.serverInfo).toBeDefined();

    const serverInfo = result.serverInfo as Record<string, unknown>;
    expect(serverInfo.name).toBe("fractal-agents-runtime");
    expect(typeof serverInfo.version).toBe("string");

    expect(result.capabilities).toBeDefined();
    const capabilities = result.capabilities as Record<string, unknown>;
    expect(capabilities.tools).toBeDefined();
  });

  test("stores client info after initialize", async () => {
    expect(handler.clientInfo).toBeNull();

    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "claude-desktop", version: "2.0.1" },
        protocolVersion: "2025-03-26",
      },
    };

    await handler.handleRequest(request);

    expect(handler.clientInfo).not.toBeNull();
    expect(handler.clientInfo!.name).toBe("claude-desktop");
    expect(handler.clientInfo!.version).toBe("2.0.1");
  });

  test("handles missing clientInfo gracefully", async () => {
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
      },
    };

    const response = await handler.handleRequest(request);

    expect(response.error).toBeUndefined();
    expect(response.result).toBeDefined();
  });

  test("handles empty params gracefully", async () => {
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
    };

    const response = await handler.handleRequest(request);

    expect(response.error).toBeUndefined();
    expect(response.result).toBeDefined();
  });

  test("accepts client_info (snake_case) as well as clientInfo", async () => {
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        client_info: { name: "snake-client", version: "0.1" },
        protocol_version: "2025-03-26",
      },
    };

    const response = await handler.handleRequest(request);

    expect(response.error).toBeUndefined();
    expect(handler.clientInfo).not.toBeNull();
    expect(handler.clientInfo!.name).toBe("snake-client");
  });
});

// ---------------------------------------------------------------------------
// McpMethodHandler — initialized (notification)
// ---------------------------------------------------------------------------

describe("MCP handlers — initialized", () => {
  let handler: McpMethodHandler;

  beforeEach(() => {
    handler = new McpMethodHandler();
  });

  test("sets initialized flag to true", async () => {
    expect(handler.initialized).toBe(false);

    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialized",
    };

    await handler.handleRequest(request);

    expect(handler.initialized).toBe(true);
  });

  test("returns empty object result", async () => {
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialized",
    };

    const response = await handler.handleRequest(request);

    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// McpMethodHandler — tools/list
// ---------------------------------------------------------------------------

describe("MCP handlers — tools/list", () => {
  let handler: McpMethodHandler;

  beforeEach(() => {
    handler = new McpMethodHandler();
  });

  test("returns a list with at least one tool", async () => {
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    };

    const response = await handler.handleRequest(request);

    expect(response.error).toBeUndefined();
    expect(response.result).toBeDefined();

    const result = response.result as { tools: unknown[] };
    expect(Array.isArray(result.tools)).toBe(true);
    expect(result.tools.length).toBeGreaterThanOrEqual(1);
  });

  test("returned tool has correct shape", async () => {
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    };

    const response = await handler.handleRequest(request);
    const result = response.result as {
      tools: Array<Record<string, unknown>>;
    };
    const tool = result.tools[0];

    expect(tool.name).toBe("langgraph_agent");
    expect(typeof tool.description).toBe("string");
    expect((tool.description as string).length).toBeGreaterThan(0);
    expect(tool.inputSchema).toBeDefined();

    const schema = tool.inputSchema as Record<string, unknown>;
    expect(schema.type).toBe("object");
    expect(schema.properties).toBeDefined();
    expect(schema.required).toBeDefined();
    expect(Array.isArray(schema.required)).toBe(true);
  });

  test("tool input schema requires 'message' field", async () => {
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    };

    const response = await handler.handleRequest(request);
    const result = response.result as {
      tools: Array<Record<string, unknown>>;
    };
    const tool = result.tools[0];
    const schema = tool.inputSchema as {
      properties: Record<string, unknown>;
      required: string[];
    };

    expect(schema.required).toContain("message");
    expect(schema.properties.message).toBeDefined();
  });

  test("tool input schema has optional thread_id and assistant_id", async () => {
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    };

    const response = await handler.handleRequest(request);
    const result = response.result as {
      tools: Array<Record<string, unknown>>;
    };
    const tool = result.tools[0];
    const schema = tool.inputSchema as {
      properties: Record<string, unknown>;
      required: string[];
    };

    expect(schema.properties.thread_id).toBeDefined();
    expect(schema.properties.assistant_id).toBeDefined();
    // thread_id and assistant_id should NOT be in required
    expect(schema.required).not.toContain("thread_id");
    expect(schema.required).not.toContain("assistant_id");
  });
});

// ---------------------------------------------------------------------------
// McpMethodHandler — tools/call (validation only — no real agent)
// ---------------------------------------------------------------------------

describe("MCP handlers — tools/call validation", () => {
  let handler: McpMethodHandler;

  beforeEach(() => {
    handler = new McpMethodHandler();
  });

  test("rejects missing tool name", async () => {
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        arguments: { message: "hello" },
      },
    };

    const response = await handler.handleRequest(request);

    expect(response.error).toBeDefined();
    expect(response.error!.code).toBe(JsonRpcErrorCode.INVALID_PARAMS);
    expect(response.error!.message).toContain("name");
  });

  test("rejects unknown tool name", async () => {
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "unknown_tool",
        arguments: { message: "hello" },
      },
    };

    const response = await handler.handleRequest(request);

    expect(response.error).toBeDefined();
    expect(response.error!.code).toBe(JsonRpcErrorCode.INVALID_PARAMS);
    expect(response.error!.message).toContain("unknown_tool");
  });

  test("rejects missing message argument", async () => {
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "langgraph_agent",
        arguments: {},
      },
    };

    const response = await handler.handleRequest(request);

    expect(response.error).toBeDefined();
    expect(response.error!.code).toBe(JsonRpcErrorCode.INVALID_PARAMS);
    expect(response.error!.message).toContain("message");
  });

  test("rejects empty message argument", async () => {
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "langgraph_agent",
        arguments: { message: "" },
      },
    };

    const response = await handler.handleRequest(request);

    expect(response.error).toBeDefined();
    expect(response.error!.code).toBe(JsonRpcErrorCode.INVALID_PARAMS);
  });

  test("handles missing arguments object gracefully", async () => {
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "langgraph_agent",
        // no arguments field
      },
    };

    const response = await handler.handleRequest(request);

    expect(response.error).toBeDefined();
    expect(response.error!.code).toBe(JsonRpcErrorCode.INVALID_PARAMS);
    expect(response.error!.message).toContain("message");
  });
});

// ---------------------------------------------------------------------------
// McpMethodHandler — prompts/list
// ---------------------------------------------------------------------------

describe("MCP handlers — prompts/list", () => {
  test("returns empty prompts list", async () => {
    const handler = new McpMethodHandler();
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "prompts/list",
    };

    const response = await handler.handleRequest(request);

    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({ prompts: [] });
  });
});

// ---------------------------------------------------------------------------
// McpMethodHandler — resources/list
// ---------------------------------------------------------------------------

describe("MCP handlers — resources/list", () => {
  test("returns empty resources list", async () => {
    const handler = new McpMethodHandler();
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "resources/list",
    };

    const response = await handler.handleRequest(request);

    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({ resources: [] });
  });
});

// ---------------------------------------------------------------------------
// McpMethodHandler — ping
// ---------------------------------------------------------------------------

describe("MCP handlers — ping", () => {
  test("returns empty object (pong)", async () => {
    const handler = new McpMethodHandler();
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "ping",
    };

    const response = await handler.handleRequest(request);

    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// McpMethodHandler — unknown method
// ---------------------------------------------------------------------------

describe("MCP handlers — unknown method", () => {
  test("returns METHOD_NOT_FOUND error for unknown method", async () => {
    const handler = new McpMethodHandler();
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: 99,
      method: "nonexistent/method",
    };

    const response = await handler.handleRequest(request);

    expect(response.id).toBe(99);
    expect(response.error).toBeDefined();
    expect(response.error!.code).toBe(JsonRpcErrorCode.METHOD_NOT_FOUND);
    expect(response.error!.message).toContain("nonexistent/method");
  });

  test("returns METHOD_NOT_FOUND for empty-ish method (handled by parser)", async () => {
    // If the parser returns null for empty method, the route handler
    // would catch it before reaching the handler. But if it somehow
    // gets through with a valid but unregistered method:
    const handler = new McpMethodHandler();
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "completions/create",
    };

    const response = await handler.handleRequest(request);

    expect(response.error).toBeDefined();
    expect(response.error!.code).toBe(JsonRpcErrorCode.METHOD_NOT_FOUND);
  });
});

// ---------------------------------------------------------------------------
// McpMethodHandler — id echoing
// ---------------------------------------------------------------------------

describe("MCP handlers — id echoing", () => {
  test("echoes numeric id in response", async () => {
    const handler = new McpMethodHandler();
    const response = await handler.handleRequest({
      jsonrpc: "2.0",
      id: 42,
      method: "ping",
    });

    expect(response.id).toBe(42);
  });

  test("echoes string id in response", async () => {
    const handler = new McpMethodHandler();
    const response = await handler.handleRequest({
      jsonrpc: "2.0",
      id: "request-abc-123",
      method: "ping",
    });

    expect(response.id).toBe("request-abc-123");
  });

  test("echoes null id in response", async () => {
    const handler = new McpMethodHandler();
    const response = await handler.handleRequest({
      jsonrpc: "2.0",
      id: null,
      method: "ping",
    });

    expect(response.id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// McpMethodHandler — full initialisation handshake
// ---------------------------------------------------------------------------

describe("MCP handlers — full handshake", () => {
  test("initialize → initialized → tools/list flow", async () => {
    const handler = new McpMethodHandler();

    // Step 1: initialize
    const initResponse = await handler.handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "test", version: "1.0" },
        protocolVersion: "2025-03-26",
      },
    });

    expect(initResponse.error).toBeUndefined();
    expect(initResponse.result).toBeDefined();

    // Step 2: initialized
    const initializedResponse = await handler.handleRequest({
      jsonrpc: "2.0",
      id: null,
      method: "initialized",
    });

    expect(initializedResponse.error).toBeUndefined();
    expect(handler.initialized).toBe(true);

    // Step 3: tools/list
    const toolsResponse = await handler.handleRequest({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });

    expect(toolsResponse.error).toBeUndefined();
    const result = toolsResponse.result as { tools: unknown[] };
    expect(result.tools.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// mcpHandler — global singleton
// ---------------------------------------------------------------------------

describe("MCP handlers — global singleton", () => {
  test("mcpHandler is an instance of McpMethodHandler", () => {
    expect(mcpHandler).toBeInstanceOf(McpMethodHandler);
  });

  test("mcpHandler has handleRequest method", () => {
    expect(typeof mcpHandler.handleRequest).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Routes — POST /mcp (via router.handle)
// ---------------------------------------------------------------------------

describe("MCP routes — POST /mcp", () => {
  test("returns 200 with valid JSON-RPC initialize request", async () => {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "test", version: "1.0" },
        protocolVersion: "2025-03-26",
      },
    });

    const request = new Request("http://localhost/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });

    const response = await router.handle(request);

    expect(response.status).toBe(200);

    const json = await response.json();
    expect(json.jsonrpc).toBe("2.0");
    expect(json.id).toBe(1);
    expect(json.result).toBeDefined();
    expect(json.result.protocolVersion).toBe("2025-03-26");
  });

  test("returns 200 with valid ping request", async () => {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "ping",
    });

    const request = new Request("http://localhost/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });

    const response = await router.handle(request);

    expect(response.status).toBe(200);

    const json = await response.json();
    expect(json.result).toEqual({});
  });

  test("returns 200 with tools/list request", async () => {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });

    const request = new Request("http://localhost/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });

    const response = await router.handle(request);

    expect(response.status).toBe(200);

    const json = await response.json();
    expect(json.result).toBeDefined();
    expect(json.result.tools).toBeDefined();
    expect(Array.isArray(json.result.tools)).toBe(true);
  });

  test("returns 200 with METHOD_NOT_FOUND for unknown method", async () => {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "unknown/method",
    });

    const request = new Request("http://localhost/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });

    const response = await router.handle(request);

    // The HTTP status is 200 because the JSON-RPC error is in the body
    expect(response.status).toBe(200);

    const json = await response.json();
    expect(json.error).toBeDefined();
    expect(json.error.code).toBe(-32601);
  });

  test("returns 400 for invalid JSON body", async () => {
    const request = new Request("http://localhost/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-valid-json{{{",
    });

    const response = await router.handle(request);

    expect(response.status).toBe(400);

    const json = await response.json();
    expect(json.error).toBeDefined();
    expect(json.error.code).toBe(-32700);
  });

  test("returns 400 for non-object JSON (array)", async () => {
    const request = new Request("http://localhost/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([1, 2, 3]),
    });

    const response = await router.handle(request);

    expect(response.status).toBe(400);

    const json = await response.json();
    expect(json.error).toBeDefined();
    expect(json.error.code).toBe(-32600);
  });

  test("returns 400 for JSON object without method field", async () => {
    const request = new Request("http://localhost/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1 }),
    });

    const response = await router.handle(request);

    expect(response.status).toBe(400);

    const json = await response.json();
    expect(json.error).toBeDefined();
    expect(json.error.code).toBe(-32600);
  });

  test("returns 202 for notification (no id)", async () => {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      method: "initialized",
    });

    const request = new Request("http://localhost/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });

    const response = await router.handle(request);

    expect(response.status).toBe(202);
  });

  test("response has Content-Type: application/json", async () => {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "ping",
    });

    const request = new Request("http://localhost/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });

    const response = await router.handle(request);

    expect(response.headers.get("Content-Type")).toBe("application/json");
  });

  test("echoes request id in response", async () => {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: "custom-id-789",
      method: "ping",
    });

    const request = new Request("http://localhost/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });

    const response = await router.handle(request);
    const json = await response.json();

    expect(json.id).toBe("custom-id-789");
  });
});

// ---------------------------------------------------------------------------
// Routes — GET /mcp (405)
// ---------------------------------------------------------------------------

describe("MCP routes — GET /mcp", () => {
  test("returns 405 Method Not Allowed", async () => {
    const request = new Request("http://localhost/mcp", {
      method: "GET",
    });

    const response = await router.handle(request);

    expect(response.status).toBe(405);
  });

  test("response has Content-Type: application/json", async () => {
    const request = new Request("http://localhost/mcp", {
      method: "GET",
    });

    const response = await router.handle(request);

    expect(response.headers.get("Content-Type")).toBe("application/json");
  });

  test("response has Allow header with POST, DELETE", async () => {
    const request = new Request("http://localhost/mcp", {
      method: "GET",
    });

    const response = await router.handle(request);

    expect(response.headers.get("Allow")).toBe("POST, DELETE");
  });

  test("response body contains error message", async () => {
    const request = new Request("http://localhost/mcp", {
      method: "GET",
    });

    const response = await router.handle(request);
    const json = await response.json();

    expect(json.error).toBeDefined();
    expect(typeof json.error).toBe("string");
    expect(json.error).toContain("not allowed");
  });
});

// ---------------------------------------------------------------------------
// Routes — DELETE /mcp (404)
// ---------------------------------------------------------------------------

describe("MCP routes — DELETE /mcp", () => {
  test("returns 404 Session Not Found", async () => {
    const request = new Request("http://localhost/mcp", {
      method: "DELETE",
    });

    const response = await router.handle(request);

    expect(response.status).toBe(404);
  });

  test("response has Content-Type: application/json", async () => {
    const request = new Request("http://localhost/mcp", {
      method: "DELETE",
    });

    const response = await router.handle(request);

    expect(response.headers.get("Content-Type")).toBe("application/json");
  });

  test("response body indicates stateless server", async () => {
    const request = new Request("http://localhost/mcp", {
      method: "DELETE",
    });

    const response = await router.handle(request);
    const json = await response.json();

    expect(json.error).toBeDefined();
    expect(json.error).toContain("stateless");
  });
});

// ---------------------------------------------------------------------------
// Routes — POST /mcp full initialize → tools/list flow
// ---------------------------------------------------------------------------

describe("MCP routes — full handshake via HTTP", () => {
  test("initialize → 202 initialized → tools/list returns agent tool", async () => {
    // Step 1: initialize
    const initRequest = new Request("http://localhost/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name: "test-e2e", version: "1.0" },
          protocolVersion: "2025-03-26",
        },
      }),
    });

    const initResponse = await router.handle(initRequest);
    expect(initResponse.status).toBe(200);

    const initJson = await initResponse.json();
    expect(initJson.result.protocolVersion).toBe("2025-03-26");
    expect(initJson.result.serverInfo.name).toBe("fractal-agents-runtime");

    // Step 2: initialized notification (202 — no response body)
    const notifyRequest = new Request("http://localhost/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "initialized",
      }),
    });

    const notifyResponse = await router.handle(notifyRequest);
    expect(notifyResponse.status).toBe(202);

    // Step 3: tools/list
    const toolsRequest = new Request("http://localhost/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
      }),
    });

    const toolsResponse = await router.handle(toolsRequest);
    expect(toolsResponse.status).toBe(200);

    const toolsJson = await toolsResponse.json();
    expect(toolsJson.result.tools).toBeDefined();
    expect(toolsJson.result.tools.length).toBeGreaterThanOrEqual(1);
    expect(toolsJson.result.tools[0].name).toBe("langgraph_agent");
    expect(toolsJson.result.tools[0].inputSchema).toBeDefined();
    expect(toolsJson.result.tools[0].inputSchema.required).toContain("message");
  });
});

// ---------------------------------------------------------------------------
// Routes — POST /mcp prompts/list and resources/list
// ---------------------------------------------------------------------------

describe("MCP routes — prompts/list and resources/list via HTTP", () => {
  test("prompts/list returns empty list", async () => {
    const request = new Request("http://localhost/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "prompts/list",
      }),
    });

    const response = await router.handle(request);
    expect(response.status).toBe(200);

    const json = await response.json();
    expect(json.result).toEqual({ prompts: [] });
  });

  test("resources/list returns empty list", async () => {
    const request = new Request("http://localhost/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "resources/list",
      }),
    });

    const response = await router.handle(request);
    expect(response.status).toBe(200);

    const json = await response.json();
    expect(json.result).toEqual({ resources: [] });
  });
});

// ---------------------------------------------------------------------------
// Routes — error response wire format
// ---------------------------------------------------------------------------

describe("MCP routes — error response wire format", () => {
  test("error response does not include 'result' key", async () => {
    const request = new Request("http://localhost/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "nonexistent",
      }),
    });

    const response = await router.handle(request);
    const text = await response.text();
    const json = JSON.parse(text);

    // The wire format should have error but NOT result
    expect(json.error).toBeDefined();
    expect("result" in json).toBe(false);
  });

  test("success response does not include 'error' key", async () => {
    const request = new Request("http://localhost/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "ping",
      }),
    });

    const response = await router.handle(request);
    const text = await response.text();
    const json = JSON.parse(text);

    // The wire format should have result but NOT error
    expect(json.result).toBeDefined();
    expect("error" in json).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Routes — tools/call validation via HTTP
// ---------------------------------------------------------------------------

describe("MCP routes — tools/call validation via HTTP", () => {
  test("returns INVALID_PARAMS for unknown tool via HTTP", async () => {
    const request = new Request("http://localhost/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "nonexistent_tool",
          arguments: { message: "hello" },
        },
      }),
    });

    const response = await router.handle(request);
    expect(response.status).toBe(200);

    const json = await response.json();
    expect(json.error).toBeDefined();
    expect(json.error.code).toBe(-32602);
    expect(json.error.message).toContain("nonexistent_tool");
  });

  test("returns INVALID_PARAMS for missing message via HTTP", async () => {
    const request = new Request("http://localhost/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "langgraph_agent",
          arguments: { thread_id: "some-thread" },
        },
      }),
    });

    const response = await router.handle(request);
    expect(response.status).toBe(200);

    const json = await response.json();
    expect(json.error).toBeDefined();
    expect(json.error.code).toBe(-32602);
    expect(json.error.message).toContain("message");
  });
});
