# Task-03: MCP Server Completion

## Status: 🟢 Complete

## Objective

Wire the MCP server's `tools/call` handler to real agent execution and make tool listing dynamic, replacing the current placeholder/hardcoded implementation.

## Implementation Plan

### 1. Create `robyn_server/agent.py` — Agent Execution Module

**Purpose**: Extract a non-streaming agent execution function that MCP (and potentially A2A) can call.

**Function**: `execute_agent_run(message, thread_id, assistant_id, owner_id) → str`

**Logic**:
- Look up assistant config from storage (fall back to defaults)
- Create or reuse thread via storage
- Build `RunnableConfig` with merged assistant + runtime configurable
- Call `graph(config)` to build the agent
- Use `agent.ainvoke()` (non-streaming) with input messages
- Extract last AI message content from result
- Return response text as string

**Key design decisions**:
- Reuses `_build_runnable_config` pattern from `routes/streams.py`
- Reuses `graph()` factory from `tools_agent.agent` (same as streaming path)
- Does NOT import from `routes/streams.py` — self-contained to avoid circular deps
- Owner ID defaults to `"mcp-client"` for unauthenticated MCP access
- Thread management: creates new thread if `thread_id` is None

### 2. Update `robyn_server/mcp/handlers.py`

**Changes**:
- [x] Simplify `_execute_agent()` — remove `ImportError` fallback (module now exists)
- [x] `_handle_tools_list()` → dynamic tool listing via `_get_agent_tools()`
- [x] `_get_agent_tools()` introspects default assistant config from storage
- [x] Update `PROTOCOL_VERSION` to `"2025-03-26"`
- [x] Remove hardcoded `LANGGRAPH_AGENT_TOOL` global
- [x] Always include `langgraph_agent` base tool
- [x] Dynamically add tool metadata from assistant config (MCP sub-tools, RAG collections)

### 3. Update `robyn_server/mcp/schemas.py`

**Changes**:
- [x] Update default `protocol_version` in `McpInitializeResult` to `"2025-03-26"`

### 4. Dynamic Tool Listing Design

The MCP server exposes the agent as a tool to external MCP clients. Tool listing reflects the agent's actual capabilities:

1. **Always present**: `langgraph_agent` tool — the main entry point
2. **Dynamically built**: Description includes available sub-tools (MCP tools, RAG collections)
3. **Approach**: Query default assistant from storage → extract config → list tools
4. **Fallback**: If no assistant configured, return base `langgraph_agent` with generic description

**NOT doing** (deferred):
- Exposing individual sub-tools as separate MCP tools (too complex, unclear benefit)
- SSE streaming via GET (keep 405)
- Session management (keep stateless)

## Files Modified

| File | Action | Description |
|------|--------|-------------|
| `robyn_server/agent.py` | **CREATE** | `execute_agent_run()` + `get_agent_tool_info()` |
| `robyn_server/mcp/handlers.py` | **MODIFY** | Wire real execution, dynamic tools, protocol bump |
| `robyn_server/mcp/schemas.py` | **MODIFY** | Default protocol version bump |

## Success Criteria

- [x] `robyn_server/agent.py` exists with `execute_agent_run()` function
- [x] `tools/call` invokes real agent execution (no placeholder)
- [x] `tools/list` returns dynamically built tool list
- [x] `PROTOCOL_VERSION` is `"2025-03-26"`
- [x] All existing tests pass (463 — 440 original + 23 new)
- [x] Ruff clean
- [x] No circular imports (lazy imports in functions)

## Risks

| Risk | Mitigation |
|------|------------|
| Circular imports between `robyn_server.agent` and `tools_agent.agent` | Lazy imports inside functions |
| Storage not initialized when MCP handler starts | Graceful fallback to defaults |
| Agent invocation fails without LLM config | Return structured MCP error (isError: true) |

## Dependencies

- Task-02 ✅ (MCP client refactored)
- `tools_agent.agent.graph()` — the agent factory
- `robyn_server.storage.get_storage()` — runtime storage

## Completed Work

### Files Created
- **`robyn_server/agent.py`** (~364 lines)
  - `execute_agent_run(message, thread_id, assistant_id, owner_id)` → str
  - `get_agent_tool_info(assistant_id, owner_id)` → dict
  - `_build_mcp_runnable_config()` — self-contained config builder (no cross-module coupling)
  - `_extract_response_text()` — extracts last AI message content from agent result
  - Handles: assistant lookup, thread create/reuse, agent build via `graph()`, `ainvoke()`, state persistence
  - All imports lazy (inside functions) to avoid circular deps

### Files Modified
- **`robyn_server/mcp/handlers.py`**
  - `PROTOCOL_VERSION` bumped `"2024-11-05"` → `"2025-03-26"`
  - Removed hardcoded `LANGGRAPH_AGENT_TOOL` global
  - Added `_build_tool_description(tool_info)` — dynamic description builder
  - Added `_get_dynamic_agent_tool()` — introspects assistant config via `get_agent_tool_info()`
  - `_handle_tools_list()` now calls `_get_dynamic_agent_tool()` (was hardcoded)
  - `_execute_agent()` simplified — removed `ImportError` fallback, delegates directly to `execute_agent_run()`
  - All f-string logging replaced with lazy `%s` formatting
- **`robyn_server/mcp/schemas.py`**
  - Default `protocol_version` in `McpInitializeResult` bumped to `"2025-03-26"`

### Tests Added (23 new tests in `test_mcp.py`)
- `TestProtocolVersion` (1 test) — verifies constant value
- `TestDynamicToolListing` (7 tests) — tool listing, description builder, fallback
- `TestAgentExecutionWiring` (6 tests) — `_execute_agent` delegation, argument passing, error propagation, full `tools/call` flow
- `TestAgentModule` (9 tests) — `_extract_response_text`, `_build_mcp_runnable_config`, `get_agent_tool_info`

### Test Results
- **463/463 tests passing** (440 original + 23 new)
- Ruff clean (no lint errors)