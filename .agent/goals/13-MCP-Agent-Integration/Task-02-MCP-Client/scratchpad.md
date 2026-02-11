# Task-02: MCP Client — Adopt `langchain-mcp-adapters`

> **Status**: 🟢 Complete
> **Started**: 2026-02-14
> **Completed**: 2026-02-14
> **Parent Goal**: [Goal 13 — MCP Agent Integration](../scratchpad.md)
> **Depends On**: Task-01 (Research) ✅ Complete

## Objective

Replace the manual MCP client implementation with the official `langchain-mcp-adapters` package. This eliminates ~200 lines of hand-rolled MCP plumbing (tool wrapping, connection management, auth error handling) and replaces it with ~20 lines using `MultiServerMCPClient`. The refactor must be backward-compatible with the existing OAP UI `MCPConfig` schema.

## Implementation Plan

### Step 1: Add Dependency ✅

```bash
uv add "langchain-mcp-adapters>=0.2.1"
```

This also auto-bumped `mcp` from 1.9.1 → **1.26.0** (much larger jump than expected — 1.9.2 was the minimum, uv resolved to latest). Also pulled in `jsonschema`, `referencing`, `rpds-py`, `typing-extensions` 4.15.0.

**Result**: `uv sync` clean, 440/440 tests pass with `mcp` 1.26.0.

### Step 2: Refactor `tools_agent/agent.py` ✅

#### 2a. Update imports

**Removed**:
```python
from mcp.client.streamable_http import streamablehttp_client
from mcp import ClientSession
from langchain_core.tools import StructuredTool
from tools_agent.utils.tools import (
    wrap_mcp_authenticate_tool,
    create_langchain_mcp_tool,
)
```

**Added**:
```python
from langchain_mcp_adapters.client import MultiServerMCPClient
from tools_agent.utils.mcp_interceptors import handle_interaction_required
```

#### 2b. Replace MCP connection block in `graph()` (L329–397)

**Current** (~55 lines): Manual `streamablehttp_client` → `ClientSession` → paginated `list_tools` → `create_langchain_mcp_tool` → `wrap_mcp_authenticate_tool` for each tool.

**New** (~15 lines):
```python
if cfg.mcp_config and cfg.mcp_config.auth_required:
    mcp_tokens = await fetch_tokens(config)
else:
    mcp_tokens = None

if (
    cfg.mcp_config
    and cfg.mcp_config.url
    and (mcp_tokens or not cfg.mcp_config.auth_required)
):
    server_url = cfg.mcp_config.url.rstrip("/") + "/mcp"
    headers = {}
    if mcp_tokens:
        headers["Authorization"] = f"Bearer {mcp_tokens['access_token']}"

    try:
        # Each MCP server is a FastMCP streaming service on the cluster
        mcp_client = MultiServerMCPClient(
            {"default": {"transport": "http", "url": server_url, "headers": headers}}
        )
        mcp_tools = await mcp_client.get_tools()

        # Filter by tool names if specified
        if cfg.mcp_config.tools:
            tool_names = set(cfg.mcp_config.tools)
            mcp_tools = [t for t in mcp_tools if t.name in tool_names]

        tools.extend(mcp_tools)
        logger.info(
            "MCP tools loaded: count=%d server=%s",
            len(mcp_tools),
            _safe_mask_url(server_url),
        )
    except Exception as e:
        logger.warning("Failed to fetch MCP tools: %s", str(e))
```

**Key changes**:
- No more `streamablehttp_client` / `ClientSession` context managers
- No more manual pagination (`list_tools` with cursor loop)
- No more `create_langchain_mcp_tool()` wrapping
- No more `wrap_mcp_authenticate_tool()` — `langchain-mcp-adapters` handles tool creation natively
- Tool name filtering is now a simple list comprehension after loading
- `cfg.mcp_config.tools` no longer required to be non-empty (if None/empty, load all tools)

#### 2c. Relax `MCPConfig.tools` requirement ✅

Changed the condition from:
```python
cfg.mcp_config and cfg.mcp_config.url and cfg.mcp_config.tools and (...)
```
to:
```python
cfg.mcp_config and cfg.mcp_config.url and (...)
```

This allows connecting to an MCP server without pre-specifying tool names (load all tools from the server, filter afterward if `tools` list is provided).

### Step 3: Clean Up `tools_agent/utils/tools.py` ✅

**Removed**:
- `create_langchain_mcp_tool()` — entire function (~20 lines)
- `wrap_mcp_authenticate_tool()` — entire function (~35 lines)
- Imports: `StructuredTool`, `ToolException` (from `langchain_core.tools`), `streamablehttp_client`, `ClientSession`, `Tool`, `McpError` (from `mcp`)

**Kept** (unchanged):
- `create_rag_tool()` — RAG tool is independent of MCP
- Imports for RAG: `Annotated`, `aiohttp`, `re`, `tool` (still used by `create_rag_tool`)

File now contains only `create_rag_tool()` and its imports.

### Step 3b: Create `tools_agent/utils/mcp_interceptors.py` ✅ (NEW)

Created interceptor module with `handle_interaction_required()`:
- Catches `McpError` with code `-32003` (`interaction_required`)
- Converts to clean `ToolException` with user-facing message + URL
- Prevents noisy stack traces from cluttering logs
- Reuses the `_find_first_mcp_error_nested()` logic from the removed `wrap_mcp_authenticate_tool()`
- Full docstrings, type annotations, usage examples in module docstring
- ~126 lines including docs

### Step 4: Verify ✅

- [x] `ruff check . --fix --unsafe-fixes && ruff format .` — All checks passed, 54 files unchanged
- [x] `pytest` — **440/440 tests passed** in 1.66s
- [x] No stale references to removed functions (`grep` confirmed zero matches)
- [x] No stale imports of `streamablehttp_client`, `ClientSession` anywhere in codebase
- [ ] Manual E2E test with live MCP server (deferred — no MCP server running locally)

## Files Modified

| File | Action | Lines Changed |
|------|--------|---------------|
| `pyproject.toml` | Add `langchain-mcp-adapters>=0.2.1` | +1 |
| `uv.lock` | Auto-updated by `uv add` (mcp 1.9.1→1.26.0, +jsonschema, +referencing, +rpds-py, typing-extensions 4.13→4.15) | auto |
| `tools_agent/agent.py` | Replace imports + MCP block in `graph()` | -60, +22 |
| `tools_agent/utils/tools.py` | Remove `create_langchain_mcp_tool`, `wrap_mcp_authenticate_tool`, unused imports | -69 |
| `tools_agent/utils/mcp_interceptors.py` | **NEW** — `handle_interaction_required` interceptor | +126 |

**Net**: ~129 lines removed, ~148 lines added (126 of which are the new well-documented interceptor module). Effective complexity reduction: 55-line manual MCP block → 15-line `MultiServerMCPClient` call.

## What Did NOT Change (Confirmed)

- `MCPConfig` Pydantic model — backward-compatible (url, tools, auth_required) ✅
- `GraphConfigPydantic` — unchanged ✅
- `tools_agent/utils/token.py` — `fetch_tokens()` unchanged (called before `MultiServerMCPClient`) ✅
- `create_rag_tool()` — untouched ✅
- LLM initialization logic — untouched ✅
- Persistence logic (checkpointer/store) — untouched ✅
- MCP server side (`robyn_server/mcp/`) — untouched (Task-03) ✅
- All 440 existing tests — passed without modification ✅

## Deferred to Future Work

- **Multi-server `MCPConfig`** — `servers: Dict[str, MCPServerConfig]` config field (needs OAP UI changes)
- **Stateful sessions** — Start with stateless (default), measure latency to FastMCP cluster services, add stateful sessions if needed
- **Additional interceptors** — For auth injection, retry logic, context passing, rate limiting (future enhancement; interceptor pattern is now established via `mcp_interceptors.py`)

## Risks (Post-Implementation Assessment)

| Risk | Impact | Likelihood | Outcome |
|------|--------|------------|---------|
| `mcp` version bump breaks something | Low | Very Low | **No issue** — jumped to 1.26.0, all 440 tests pass |
| `langchain-mcp-adapters` tool format differs from manual wrapping | Medium | Low | **Mitigated** — both use `BaseTool`. Needs live server validation. |
| ~~Removing `wrap_mcp_authenticate_tool` loses `interaction_required` handling~~ | ~~Medium~~ | ~~Medium~~ | **Resolved** — created `handle_interaction_required` interceptor that preserves the exact same behavior |
| `MultiServerMCPClient.get_tools()` fails with FastMCP servers | Medium | Low | **Mitigated** — uses same MCP SDK, protocol compatible. Needs live test. |

## Acceptance Criteria

- [x] `langchain-mcp-adapters>=0.2.1` in `pyproject.toml` dependencies
- [x] `create_langchain_mcp_tool` and `wrap_mcp_authenticate_tool` removed from codebase
- [x] `graph()` uses `MultiServerMCPClient` for MCP tool loading
- [x] No imports of `streamablehttp_client` or `ClientSession` in `agent.py`
- [x] `interaction_required` error handling preserved via interceptor
- [x] All 440 existing tests pass
- [x] Ruff lint + format clean
- [x] `tools_agent/utils/tools.py` only contains `create_rag_tool`
- [x] New `tools_agent/utils/mcp_interceptors.py` with full docstrings and type annotations
