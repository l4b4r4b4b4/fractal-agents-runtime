# Goal 13: MCP Agent Integration

> **Status**: 🟡 In Progress
> **Priority**: P2 (Medium)
> **Created**: 2026-02-11
> **Updated**: 2026-02-14
> **Depends On**: Goal 12 (Postgres Persistence) ✅ Complete

## Overview

Deepen the MCP (Model Context Protocol) integration in both directions: improve how the agent **consumes** tools from remote MCP servers (client side), and complete the implementation that **exposes** the agent as an MCP server (server side). Currently both sides exist but have significant gaps — the client does manual tool wrapping with no connection reuse, and the server is a skeleton with a placeholder agent execution path.

### Cluster Architecture Context

**MCP servers are individual services on the Kubernetes cluster**, each implemented with **FastMCP streaming server**. This means:
- Each MCP server is a separate pod/service (e.g., `math-mcp`, `weather-mcp`, `search-mcp`)
- Transport is always **Streamable HTTP** (`http://<service-name>/mcp` or `http://<service-name>:<port>/mcp`)
- Service discovery via k8s service names or environment variables
- `stdio` transport is **never used** in production (all servers are remote HTTP services)
- FastMCP servers may be stateful (maintaining context across tool calls within a session)
- Inter-service auth may differ from user-facing Supabase JWT auth (service-to-service tokens, network policies, etc.)

This architecture strongly favors `langchain-mcp-adapters` with `MultiServerMCPClient` — each cluster MCP service maps to a named server entry:
```python
MultiServerMCPClient({
    "math": {"transport": "http", "url": "http://math-mcp:8000/mcp"},
    "search": {"transport": "http", "url": "http://search-mcp:8000/mcp", "headers": {...}},
})
```

## Task-01 Research Findings

### 1. `langchain-mcp-adapters` Package — Exists and Is Mature

**Package**: `langchain-mcp-adapters` v0.2.1 on PyPI
**Repo**: https://github.com/langchain-ai/langchain-mcp-adapters
**Maintained by**: LangChain team (Vadym Barda / @vbarda)
**Releases**: 28 versions published (0.1.2 → 0.2.1), actively developed
**Docs**: https://docs.langchain.com/oss/python/langchain/mcp (comprehensive)

#### Dependencies (minimal — 3 total)
| Dependency | Required | Our Current | Compatible? |
|------------|----------|-------------|-------------|
| `langchain-core` | `>=1.0.0,<2.0.0` | `>=1.2.11` | ✅ Yes |
| `mcp` | `>=1.9.2` | `>=1.9.1` (locked at 1.9.1) | ⚠️ Needs bump to >=1.9.2 |
| `typing-extensions` | `>=4.14.0` | transitive | ✅ Yes |
| Python | `>=3.10` | `>=3.11,<3.13` | ✅ Yes |

**Verdict**: Fully compatible. Only change needed is `mcp>=1.9.1` → `mcp>=1.9.2` (patch bump).

#### Core Features Provided

1. **`MultiServerMCPClient`** — Native multi-server MCP support with named servers
   ```python
   client = MultiServerMCPClient({
       "math": {"transport": "http", "url": "http://math-server/mcp"},
       "weather": {"transport": "http", "url": "http://weather-server/mcp"},
   })
   tools = await client.get_tools()  # Returns LangChain tools directly
   ```

2. **Multiple transports** — `stdio`, `http` (streamable HTTP), `sse` (deprecated)

3. **Stateless by default** — Each tool invocation creates a fresh MCP `ClientSession`, executes the tool, cleans up. **This is the same behavior as our current code.**

4. **Stateful sessions** — Explicit `async with client.session("server_name") as session:` context manager for persistent connections when needed. **Important for our FastMCP cluster services** which may maintain state across calls within a session.

5. **Header passing** — Per-server custom headers including auth:
   ```python
   {"weather": {"transport": "http", "url": "...", "headers": {"Authorization": "Bearer TOKEN"}}}
   ```

6. **Custom auth** — `httpx.Auth` interface support for OAuth flows

7. **Tool interceptors** — Powerful middleware-like pattern:
   - Access runtime context (user IDs, API keys, LangGraph config)
   - Access LangGraph `store` (long-term memory)
   - Access agent state
   - Modify requests/responses (add headers, transform args)
   - Retry logic, error handling, rate limiting
   - State updates via `Command` (graph flow control)
   - Short-circuit execution (return early without calling tool)

8. **Resources & Prompts** — Also loads MCP resources (as Blob objects) and prompts (as messages)

9. **Progress notifications** — Callbacks for long-running tools

10. **Logging** — Forward MCP server log messages

11. **Elicitation** — Interactive user input during tool execution

12. **Structured + Multimodal content** — Handles structured JSON and image tool responses

13. **Source code** — Clean, small codebase: `client.py` (10KB), `tools.py` (21KB), `sessions.py` (14KB), `interceptors.py` (5KB), `callbacks.py` (4KB), `resources.py` (3KB), `prompts.py` (2KB)

### 2. Current MCP Client Problems (Confirmed)

**Location**: `tools_agent/agent.py` (L298-454), `tools_agent/utils/tools.py`, `tools_agent/utils/token.py`

| Problem | Severity | `langchain-mcp-adapters` solves it? |
|---------|----------|--------------------------------------|
| **New HTTP connection per tool call** — `streamablehttp_client` opened inside each tool invocation | High | ✅ Stateful sessions OR stateless (same as their default) |
| **Single MCP server only** — `MCPConfig` has one `url` field | High | ✅ `MultiServerMCPClient` supports N named servers |
| **Manual tool wrapping** — `create_langchain_mcp_tool()` reimplements LangChain tool creation (47 lines) | Medium | ✅ `client.get_tools()` returns LangChain tools directly |
| **Manual auth error wrapping** — `wrap_mcp_authenticate_tool()` (40 lines) handles `interaction_required` | Medium | ✅ Interceptors handle this more cleanly |
| **No tool caching** — Tool list fetched fresh on every `graph()` invocation | Low | ⚠️ Same behavior (tools loaded per invocation), but simpler code |
| **Silent error swallowing** — MCP connection failures logged as warning, all tools dropped | Medium | ✅ Interceptors can implement per-server fallback |
| **No health checking** — No way to know if MCP server is reachable before invocation | Low | ❌ Not provided (but interceptors can add retry) |
| **Token exchange coupled to tools** — `fetch_tokens()` does OAuth before tool loading | Medium | ✅ Custom `httpx.Auth` or interceptors handle this |

#### Code to be replaced:
- `tools_agent/utils/tools.py` → `create_langchain_mcp_tool()` — **entire function** (replaced by `MultiServerMCPClient.get_tools()`)
- `tools_agent/utils/tools.py` → `wrap_mcp_authenticate_tool()` — **entire function** (replaced by interceptor)
- `tools_agent/agent.py` L345-400 — **~55 lines of MCP connection logic** (replaced by ~10 lines using `MultiServerMCPClient`)

#### Code to keep:
- `tools_agent/utils/tools.py` → `create_rag_tool()` — RAG tool is independent of MCP, keep as-is
- `tools_agent/utils/token.py` — Token exchange logic stays but gets simpler (interceptor calls it)

### 3. Current MCP Server Problems (Confirmed)

**Location**: `robyn_server/mcp/handlers.py`, `robyn_server/mcp/schemas.py`, `robyn_server/routes/mcp.py`

| Problem | Severity | Notes |
|---------|----------|-------|
| **Agent execution not wired** — `from robyn_server.agent import execute_agent_run` → `ImportError` → placeholder response | Critical | `robyn_server/agent.py` doesn't exist. Need to create it or extract from `streams.py` |
| **No streaming** — GET `/mcp/` returns 405. MCP spec supports SSE streaming for long-running tool calls | High | Robyn has SSE support but MCP route doesn't use it |
| **Hardcoded single tool** — Only exposes `langgraph_agent` tool, doesn't reflect actual agent capabilities | Medium | Should dynamically list agent's sub-tools (MCP tools, RAG tools) |
| **No session management** — Stateless, DELETE returns 404 | Low | Acceptable for now — stateless is simpler |
| **Manual JSON-RPC implementation** — 250+ lines of hand-written JSON-RPC 2.0 handling | Medium | Could use official `mcp` SDK's server-side support (`FastMCP`) |
| **Protocol version outdated** — Uses `2024-11-05`, current is `2025-03-26` | Low | Should update but not breaking |

#### Architecture question: Manual JSON-RPC vs. FastMCP

The `mcp` package (which we already depend on) includes `FastMCP` for building servers. Our current implementation hand-rolls JSON-RPC 2.0 parsing, method routing, and response construction across `handlers.py` (250 lines) + `schemas.py` (170 lines) + `routes/mcp.py` (160 lines) = **~580 lines**.

Using `FastMCP` would reduce this to ~50-100 lines and get protocol compliance for free. However, integrating `FastMCP` with Robyn's request/response model isn't straightforward — `FastMCP` wants to own the HTTP layer. Options:

1. **Keep manual JSON-RPC but fix the wiring** — Least risk, just implement `execute_agent_run`
2. **Replace with FastMCP** — More work upfront, better long-term (protocol updates, streaming, etc.)
3. **Hybrid** — Use `FastMCP` for tool/method definitions but handle HTTP in Robyn

**Recommendation**: Option 1 for Task-03 (get it working), consider Option 2 as a separate follow-up goal.

### 4. Decision: Adopt `langchain-mcp-adapters`

**Strong yes.** Rationale:

| Factor | Manual (current) | `langchain-mcp-adapters` |
|--------|-------------------|--------------------------|
| Multi-server | ❌ Single URL | ✅ Native named servers |
| Tool wrapping | 87 lines manual | ✅ 0 lines (automatic) |
| Connection management | Per-call reconnect | ✅ Stateless default + stateful option |
| Auth handling | 130 lines (token.py + tools.py) | ✅ Headers + httpx.Auth + interceptors |
| Error handling | Silent swallow | ✅ Interceptors with retry/fallback |
| Maintenance | We maintain | ✅ LangChain team maintains |
| LangGraph integration | Manual plumbing | ✅ Native (store, state, context access) |
| Code to maintain | ~200 lines MCP-specific | ~20 lines config |
| Multimodal | ❌ Text only | ✅ Images, structured content |
| Resources/Prompts | ❌ Not supported | ✅ Full MCP spec coverage |

**Migration risk**: Low. The package uses the same `mcp` SDK we already depend on, just wraps it with LangChain-native patterns. Our `MCPConfig` Pydantic model maps cleanly to `MultiServerMCPClient` constructor dict.

**OAP UI compatibility**: The `MCPConfig` → `MultiServerMCPClient` mapping needs careful handling. OAP UI sends a single `mcp_config: {url, tools, auth_required}`. We need to translate this into `MultiServerMCPClient({"default": {"transport": "http", "url": cfg.url, ...}})` while preserving backward compatibility. Multi-server support can be additive later.

### 5. Impact on Config Schema

#### Current `MCPConfig`:
```python
class MCPConfig(BaseModel):
    url: Optional[str] = None          # Single MCP server URL
    tools: Optional[List[str]] = None  # Tool name filter
    auth_required: Optional[bool] = False
```

#### Proposed change (backward compatible):
```python
class MCPServerConfig(BaseModel):
    """Configuration for a single MCP server."""
    url: str
    transport: str = "http"
    tools: Optional[List[str]] = None  # None = all tools from this server
    auth_required: bool = False
    headers: Optional[Dict[str, str]] = None

class MCPConfig(BaseModel):
    """MCP configuration — supports single server (legacy) or multiple servers."""
    # Legacy single-server (OAP UI sends this)
    url: Optional[str] = None
    tools: Optional[List[str]] = None
    auth_required: Optional[bool] = False
    # Multi-server (future)
    servers: Optional[Dict[str, MCPServerConfig]] = None
```

Translation logic: if `url` is set and `servers` is None, create `{"default": MCPServerConfig(url=url, ...)}`.

**Note**: In cluster deployments, MCP server URLs will be k8s service addresses (e.g., `http://math-mcp:8000`). The `servers` dict enables connecting to multiple FastMCP services simultaneously, which maps naturally to how MCP servers are deployed as individual cluster services.

## Refined Task Breakdown

| Task ID | Description | Status | Depends On | Estimated Lines Changed |
|---------|-------------|--------|------------|-------------------------|
| Task-01 | Research — LangChain MCP support, assess current code | 🟢 Complete | - | 0 (this scratchpad) |
| Task-02 | MCP Client — adopt `langchain-mcp-adapters`, refactor `graph()` | 🟢 Complete | Task-01 | -129/+148 (dep added, agent.py refactored, tools.py slimmed, interceptor created) |
| Task-03 | MCP Server — wire `execute_agent_run`, fix tools/call | 🟢 Complete | Task-01 | +364 (robyn_server/agent.py), handlers.py refactored, schemas.py bumped, +23 tests |
| Task-04 | Testing — unit + integration tests for both sides | 🟢 Complete | Task-02, Task-03 | +23 MCP tests (Task-03), +18 DB unit tests, +34 Postgres integration tests |

### Task-02 Detail: MCP Client Improvements

**Goal**: Replace manual MCP client code with `langchain-mcp-adapters`

1. `uv add langchain-mcp-adapters>=0.2.1` (auto-bumps `mcp` to >=1.9.2)
2. ✅ Refactored `tools_agent/agent.py`:
   - Replaced 55-line MCP connection block with `MultiServerMCPClient` (~15 lines)
   - `MCPConfig` backward-compatible for OAP UI (unchanged)
   - `MCPConfig` → `MultiServerMCPClient` config dict translation in `graph()`
   - Relaxed `cfg.mcp_config.tools` requirement (load all tools if not specified)
3. ✅ Refactored `tools_agent/utils/tools.py`:
   - Removed `create_langchain_mcp_tool()` (replaced by `client.get_tools()`)
   - Removed `wrap_mcp_authenticate_tool()` (replaced by interceptor)
   - Kept `create_rag_tool()` unchanged
4. ✅ Created `tools_agent/utils/mcp_interceptors.py`:
   - `handle_interaction_required` interceptor (code -32003 → clean `ToolException`)
   - Prevents noisy stack traces in logs
   - Reuses `_find_first_mcp_error_nested()` logic from removed wrapper
   - Full docstrings, type annotations, usage examples
5. ✅ All 440 existing tests pass (mcp bumped 1.9.1 → 1.26.0)
6. ⬜ Manual E2E test with live MCP server (deferred — no MCP server running locally)

### Task-03 Detail: MCP Server Completion ✅

**Goal**: Wire `tools/call` to actual agent execution — **COMPLETE**

1. ✅ Created `robyn_server/agent.py` (364 lines):
   - `execute_agent_run(message, thread_id, assistant_id, owner_id)` → str
   - `get_agent_tool_info(assistant_id, owner_id)` → dict (introspects assistant config)
   - `_build_mcp_runnable_config()` — self-contained config builder (no cross-module coupling)
   - `_extract_response_text()` — extracts last AI message content from agent result
   - Handles: assistant lookup, thread create/reuse, agent build via `graph()`, `ainvoke()`, state persistence
   - All imports lazy (inside functions) to avoid circular deps
2. ✅ Updated `robyn_server/mcp/handlers.py`:
   - `_execute_agent()` delegates directly to `execute_agent_run()` (no `ImportError` fallback)
   - `_handle_tools_list()` → dynamic via `_get_dynamic_agent_tool()` + `get_agent_tool_info()`
   - `_build_tool_description()` — includes MCP sub-tools, RAG collections, model name
   - Removed hardcoded `LANGGRAPH_AGENT_TOOL` global
   - All f-string logging replaced with lazy `%s` formatting
3. ✅ Updated `robyn_server/mcp/schemas.py`:
   - Default `protocol_version` in `McpInitializeResult` bumped to `"2025-03-26"`
4. ✅ `PROTOCOL_VERSION` updated to `"2025-03-26"`
5. ✅ 23 new tests added (463/463 total passing)
6. (Deferred) SSE streaming — keep GET as 405 for now, add in future goal

### Task-04 Detail: Testing ✅

**Goal**: Comprehensive test coverage for MCP client + server — **COMPLETE**

1. ✅ Unit tests for `execute_agent_run` (mock graph) — 6 tests in `TestAgentExecutionWiring` + 9 in `TestAgentModule` (done in Task-03)
2. ✅ Unit tests for dynamic tool listing — 7 tests in `TestDynamicToolListing` (done in Task-03)
3. ✅ Protocol version verification — 1 test in `TestProtocolVersion` (done in Task-03)
4. ✅ Database module unit tests — 18 tests in `test_database.py` (DB accessors, shutdown safety, config, fallback)
5. ✅ Postgres integration tests — 34 tests in `test_postgres_integration.py` (schema, all 5 stores CRUD, cascades, full lifecycle)
6. ✅ All 515 tests pass (440 original + 23 MCP + 18 DB unit + 34 Postgres integration)
7. ⬜ Unit tests for `MCPConfig` → `MultiServerMCPClient` translation (deferred — tests 10 lines of dict-building, low value)
8. ⬜ Live E2E MCP smoke test with real agent + LLM (deferred — requires manual server lifecycle)

## Success Criteria

- [x] Research complete — LangChain native MCP support evaluated
- [x] MCP client: uses `langchain-mcp-adapters` `MultiServerMCPClient`
- [x] MCP client: backward-compatible with existing OAP UI `MCPConfig`
- [ ] MCP client: connection reuse via stateful sessions (deferred — measure latency first)
- [ ] MCP client: support multiple MCP servers per agent (additive, needs OAP UI changes)
- [x] MCP client: auth handled via interceptors (`handle_interaction_required`)
- [x] MCP client: graceful degradation with clear error messages per server
- [x] MCP server: `tools/call` wired to actual agent execution via `graph()`
- [x] MCP server: dynamic tool listing that reflects agent's actual capabilities
- [ ] MCP server: proper integration with Supabase auth context (deferred — needs auth middleware for MCP routes)
- [x] All 515 tests pass (440 original + 23 MCP + 18 DB unit + 34 Postgres integration)
- [ ] New tests for MCP client (MultiServerMCPClient integration) — deferred (low value, tests official package)
- [x] New tests for MCP server (execute_agent_run, dynamic tools, protocol version)
- [x] Database module unit tests (accessors, shutdown, config, fallback)
- [x] Postgres integration tests (schema, all 5 stores CRUD, cascades, lifecycle)

## Current State

### MCP Client (agent consumes tools from remote MCP servers)

**Location**: `tools_agent/agent.py`, `tools_agent/utils/tools.py`, `tools_agent/utils/token.py`

**How it works today**:
1. `graph()` reads `MCPConfig` from assistant configurable (url, tools list, auth_required)
2. Opens a `streamablehttp_client` connection to `{mcp_url}/mcp`
3. Lists all tools, filters by name, wraps each as a LangChain `StructuredTool`
4. Each tool invocation opens a **new** `streamablehttp_client` connection (no reuse)
5. Auth: optional Supabase token → MCP OAuth token exchange via `/oauth/token`
6. Errors silently swallowed with `logger.warning`

### MCP Server (agent exposed as MCP server) — ✅ Task-03 Complete

**Location**: `robyn_server/agent.py`, `robyn_server/mcp/handlers.py`, `robyn_server/mcp/schemas.py`, `robyn_server/routes/mcp.py`

**How it works now** (after Task-03):
1. Robyn registers POST/GET/DELETE `/mcp/` routes
2. `McpMethodHandler` implements JSON-RPC 2.0 for `initialize`, `tools/list`, `tools/call`, `ping`
3. `tools/list` dynamically builds tool description from assistant config (MCP sub-tools, RAG, model)
4. `tools/call` delegates to `robyn_server.agent.execute_agent_run()` — real agent execution
5. `execute_agent_run()` handles: assistant lookup, thread create/reuse, `graph()` build, `ainvoke()`, state persistence
6. Protocol version: `2025-03-26` (Streamable HTTP Transport)
7. No streaming support (GET returns 405) — deferred
8. Stateless — no session management

## Architecture Considerations

### MCP Client — `MultiServerMCPClient` Integration

The refactored `graph()` MCP section will look approximately like:

```python
# In graph(), after RAG tool loading:
if cfg.mcp_config and cfg.mcp_config.url:
    server_url = cfg.mcp_config.url.rstrip("/") + "/mcp"
    headers = {}
    if cfg.mcp_config.auth_required and mcp_tokens:
        headers["Authorization"] = f"Bearer {mcp_tokens['access_token']}"

    # Each MCP server is a FastMCP streaming service on the cluster
    # (e.g., http://math-mcp:8000/mcp, http://search-mcp:8000/mcp)
    mcp_client = MultiServerMCPClient(
        {"default": {"transport": "http", "url": server_url, "headers": headers}}
    )
    mcp_tools = await mcp_client.get_tools()

    # Filter by tool names if specified
    if cfg.mcp_config.tools:
        tool_names = set(cfg.mcp_config.tools)
        mcp_tools = [t for t in mcp_tools if t.name in tool_names]

    tools.extend(mcp_tools)
```

Compare to current: 55 lines → ~14 lines.

**Multi-server variant** (future, when `servers` config is supported):
```python
# Multiple FastMCP cluster services at once
if cfg.mcp_config and cfg.mcp_config.servers:
    server_configs = {}
    for name, srv in cfg.mcp_config.servers.items():
        server_configs[name] = {
            "transport": srv.transport,
            "url": srv.url.rstrip("/") + "/mcp",
            "headers": srv.headers or {},
        }
    mcp_client = MultiServerMCPClient(server_configs)
    tools.extend(await mcp_client.get_tools())
```

### MCP Client — Auth Interceptor Pattern

```python
async def supabase_auth_interceptor(request: MCPToolCallRequest, handler):
    """Handle MCP interaction_required errors with Supabase auth."""
    try:
        return await handler(request)
    except BaseException as exc:
        mcp_error = _find_mcp_error(exc)
        if mcp_error and getattr(mcp_error.error, "code", None) == -32003:
            # interaction_required — extract URL and raise as ToolException
            error_data = getattr(mcp_error.error, "data", {}) or {}
            url = error_data.get("url", "")
            message = error_data.get("message", {}).get("text", "Required interaction")
            raise ToolException(f"{message} {url}".strip()) from exc
        raise
```

### MCP Server — Agent Execution

The `execute_agent_run` function needs to:
1. Look up or create an assistant (from storage)
2. Create a thread (or reuse one via `thread_id`)
3. Build the agent graph via `graph(config)`
4. Invoke the agent with the message
5. Return the response text

This is essentially what `execute_run_stream` does in `streams.py` but non-streaming.

## Risks

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| ~~LangChain native MCP support doesn't exist or is immature~~ | ~~Medium~~ | ~~Medium~~ | **RESOLVED** — v0.2.1 is mature, 28 releases, comprehensive docs |
| `mcp>=1.9.2` bump causes conflicts | Low | Low | Patch bump, unlikely to break |
| Multi-server config breaks OAP UI compatibility | High | Low | Additive change only — keep single-server as default, translate internally |
| MCP server wiring creates circular imports | Medium | High | Use lazy imports in `robyn_server/agent.py` |
| `langchain-mcp-adapters` changes API in future versions | Low | Low | Pin to `>=0.2.1,<1.0.0`, adapters are stable |
| Connection reuse (stateful sessions) causes issues with long-lived graphs | Medium | Medium | Start with stateless (default), add stateful only if latency is a measured problem |
| FastMCP server protocol differences | Low | Low | `langchain-mcp-adapters` uses official MCP SDK which is protocol-compliant with FastMCP |
| K8s service DNS resolution failures | Low | Low | Standard k8s networking — same as any inter-service call |

## Dependencies

- **Upstream**: Goal 12 (Postgres Persistence) — ✅ Complete
- **Downstream**: None identified

## Files Likely Affected

### Task-02: MCP Client ✅
- `pyproject.toml` — added `langchain-mcp-adapters>=0.2.1` ✅
- `tools_agent/agent.py` — refactored MCP section of `graph()` (-60/+22 lines) ✅
- `tools_agent/utils/tools.py` — removed `create_langchain_mcp_tool()`, `wrap_mcp_authenticate_tool()` (-69 lines) ✅
- `tools_agent/utils/mcp_interceptors.py` — **NEW** `handle_interaction_required` interceptor (+126 lines) ✅
- `tools_agent/utils/token.py` — unchanged (called before `MultiServerMCPClient`, works as-is)

### Task-03: MCP Server ✅
- `robyn_server/agent.py` — **NEW** (+364 lines) — `execute_agent_run()`, `get_agent_tool_info()`, config builder, response extractor
- `robyn_server/mcp/handlers.py` — dynamic tools, real execution wiring, protocol bump, logging cleanup
- `robyn_server/mcp/schemas.py` — default protocol version bumped to `"2025-03-26"`

### Task-04: Testing ✅
- `robyn_server/tests/test_mcp.py` — +23 MCP tests (protocol, dynamic tools, execution wiring, agent module) ✅
- `robyn_server/tests/test_database.py` — **NEW** (+264 lines) — 18 DB module unit tests ✅
- `robyn_server/tests/test_postgres_integration.py` — **NEW** (+682 lines) — 34 Postgres integration tests ✅
- `robyn_server/tests/conftest.py` — updated with Postgres fixtures + `@pytest.mark.postgres` marker ✅

## References

- [langchain-mcp-adapters PyPI](https://pypi.org/project/langchain-mcp-adapters/) — v0.2.1
- [langchain-mcp-adapters GitHub](https://github.com/langchain-ai/langchain-mcp-adapters)
- [LangChain MCP Docs](https://docs.langchain.com/oss/python/langchain/mcp) — comprehensive usage guide
- [LangSmith Agent Server MCP endpoint](https://docs.langchain.com/langsmith/server-mcp) — reference architecture
- [MCP Specification 2025-03-26](https://modelcontextprotocol.io/specification)
- [MCP Streamable HTTP Transport](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports#streamable-http)
- Current MCP client: `tools_agent/utils/tools.py`
- Current MCP server: `robyn_server/mcp/handlers.py`

## Notes & Decisions

### Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-02-11 | Goal created as P2 after Postgres persistence | MCP improvements are valuable but not blocking |
| 2026-02-11 | Research-first approach (Task-01) | LangChain v1 may have native MCP support that changes the approach |
| 2026-02-14 | **Adopt `langchain-mcp-adapters` v0.2.1** | Official LangChain package, mature (28 releases), handles multi-server, connection mgmt, auth, interceptors. Replaces ~200 lines of manual code with ~20 lines. Compatible with our deps. |
| 2026-02-14 | Keep MCP server manual JSON-RPC for now | Rewriting to FastMCP is more work than just wiring `execute_agent_run`. Can be a future goal. |
| 2026-02-14 | Start with stateless MCP client (default) | Matches `langchain-mcp-adapters` default behavior. Add stateful sessions later if latency is measured as a problem. |
| 2026-02-14 | Backward-compatible `MCPConfig` | OAP UI sends single `{url, tools, auth_required}`. Translate internally to `MultiServerMCPClient` dict. Multi-server is additive. |

### Resolved Questions

- [x] Does LangChain provide native MCP tool integration? **YES** — `langchain-mcp-adapters` v0.2.1
- [x] Is it compatible with our deps? **YES** — only needs `mcp` bump from 1.9.1 → 1.9.2
- [x] Does it handle connection pooling? **Partially** — stateless by default (same as us), stateful sessions available
- [x] Does it handle multi-server? **YES** — `MultiServerMCPClient` supports named servers natively
- [x] Does it handle auth? **YES** — headers, `httpx.Auth`, interceptors

### Open Questions

- [x] Should the MCP server expose individual sub-tools or just the top-level agent? **RESOLVED (Task-03)**: Expose top-level `langgraph_agent` with dynamic description listing sub-tools. Individual sub-tool exposure deferred — unclear benefit, high complexity.
- [ ] What's the latency impact of per-call MCP connections to cluster FastMCP services? (Measure after Task-02)
- [ ] Should stateful sessions be used by default for FastMCP cluster services? (Depends on whether MCP servers maintain session state)
- [ ] Should MCP server support SSE streaming? (Deferred — keep GET as 405 for now)
- [x] How should MCP auth interact with Supabase JWT — pass-through or separate? **RESOLVED (Task-02)**: Interceptor handles `interaction_required` errors with clean `ToolException`. Supabase JWT pass-through for MCP server routes deferred.
- [ ] How are MCP server URLs configured in cluster deployments — env vars per service, or a discovery mechanism?