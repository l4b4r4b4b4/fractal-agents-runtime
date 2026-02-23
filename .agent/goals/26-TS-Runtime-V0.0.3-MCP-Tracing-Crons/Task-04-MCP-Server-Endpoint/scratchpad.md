# Task-04: MCP Server Endpoint — Scratchpad

**Status:** 🟢 Complete
**Session:** 27-28
**Goal:** [26 — TS Runtime v0.0.3](../scratchpad.md)

---

## Objective

Expose the TS runtime as an MCP (Model Context Protocol) server via JSON-RPC 2.0, matching the Python runtime's `/mcp` endpoint. Allows external MCP clients to discover and invoke agents as tools.

## What Was Done

### Files Created
- **`src/mcp/schemas.ts`** — JSON-RPC 2.0 types, parsing, serialization helpers
  - `JsonRpcRequest`, `JsonRpcResponse`, `JsonRpcError`, `JsonRpcErrorCode`
  - MCP types: `McpInitializeParams/Result`, `McpTool`, `McpToolCallParams/Result`
  - Helpers: `createErrorResponse()`, `createSuccessResponse()`, `serialiseResponse()`, `parseJsonRpcRequest()`
- **`src/mcp/handlers.ts`** — `McpMethodHandler` class with 7 method handlers
  - `initialize` → server info + capabilities (tools)
  - `initialized` → notification acknowledged (202)
  - `tools/list` → dynamic `langgraph_agent` tool definition
  - `tools/call` → agent execution via `executeAgentRun()`
  - `prompts/list`, `resources/list` → empty lists
  - `ping` → health check
  - Error handling: invalid params (-32602), unknown method (-32601)
- **`src/mcp/agent.ts`** — Agent execution for MCP (port of Python `server/agent.py`)
  - `executeAgentRun()` → resolve assistant, create/reuse thread, invoke agent, extract response
  - `getAgentToolInfo()` → introspect agent config for dynamic tool description
  - `extractResponseText()` — walks message list backward for last AI message
  - `buildMcpRunnableConfig()` — builds configurable for non-streaming invocation
- **`src/mcp/index.ts`** — barrel re-exports
- **`src/routes/mcp.ts`** — HTTP route handlers
  - `POST /mcp` → JSON-RPC dispatch (200/202/400/500)
  - `GET /mcp` → 405 Method Not Allowed
  - `DELETE /mcp` → 404 Session Not Found (stateless)
- **`tests/mcp-server.test.ts`** — 81 tests covering schemas, handler dispatch, HTTP routes, integration

### Files Modified
- **`src/index.ts`** — Wired `registerMcpRoutes(router)`

## Design Decisions

1. **Stateless server** — No session tracking (DELETE returns 404). Matches Python implementation.
2. **Dynamic tool definition** — `tools/list` introspects the resolved assistant's config to build a meaningful tool description including system prompt, model, and available tools.
3. **Thread reuse** — MCP callers get a dedicated thread per user (via `mcp-caller-{userId}` pattern), enabling multi-turn conversations within an MCP session.
4. **Wire format compliance** — Success responses have `result` (no `error`); error responses have `error` (no `result`). Matches JSON-RPC 2.0 spec exactly.

## Test Results

- 81 MCP-specific tests: ✅ all pass
- Full test suite (1237 tests): ✅ all pass
- No diagnostics issues

## Acceptance Criteria — All Met ✅

- [x] `POST /mcp/` with `initialize` returns server capabilities
- [x] `POST /mcp/` with `tools/list` returns agent tool definition
- [x] `POST /mcp/` with `tools/call` validates params
- [x] `GET /mcp/` → 405
- [x] `DELETE /mcp/` → 404
- [x] JSON-RPC error format for unknown methods (-32601)
- [x] JSON-RPC parse error for invalid JSON (-32700)
- [x] JSON-RPC invalid request for malformed requests (-32600)
- [x] JSON-RPC invalid params for bad tool call args (-32602)
- [x] Notification requests (no id) return 202
- [x] Wire format: success has `result` not `error`; error has `error` not `result`
- [x] Full handshake flow: initialize → initialized → tools/list
- [x] Response shapes match Python implementation
- [x] Full test suite passes (1237 tests)
- [x] Task-04 scratchpad created