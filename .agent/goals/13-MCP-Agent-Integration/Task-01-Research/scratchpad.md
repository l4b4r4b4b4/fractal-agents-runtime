# Task-01: Research — LangChain MCP Support & Current Code Assessment

> **Status**: 🟢 Complete
> **Started**: 2026-02-14
> **Completed**: 2026-02-14
> **Parent Goal**: [Goal 13 — MCP Agent Integration](../scratchpad.md)

## Objective

Evaluate whether LangChain has native MCP tool support, assess current MCP client/server problems, and decide on the approach for Tasks 02-04.

## What Was Done

### 1. PyPI Package Research

- Found `langchain-mcp-adapters` v0.2.1 on PyPI
- 28 versions published (0.1.2 → 0.2.1), actively maintained by LangChain team
- Dependencies: `langchain-core>=1.0.0,<2.0.0`, `mcp>=1.9.2`, `typing-extensions>=4.14.0`
- Fully compatible with our stack (only needs `mcp` bump from 1.9.1 → 1.9.2)

### 2. LangChain Documentation Review

- Read comprehensive docs at https://docs.langchain.com/oss/python/langchain/mcp
- Covers: `MultiServerMCPClient`, transports (http/stdio/sse), stateful sessions, tool interceptors, resources, prompts, progress notifications, elicitation, structured content
- Also reviewed LangSmith Agent Server MCP endpoint architecture (reference for our MCP server side)

### 3. Source Code Review

- Inspected `langchain-mcp-adapters` GitHub repo (langchain-ai/langchain-mcp-adapters)
- Small, clean codebase: `client.py` (10KB), `tools.py` (21KB), `sessions.py` (14KB), `interceptors.py` (5KB)
- Built on official `mcp` SDK — same SDK we already depend on

### 4. Current MCP Client Assessment

- Reviewed `tools_agent/agent.py` (L298-454), `tools_agent/utils/tools.py`, `tools_agent/utils/token.py`
- Confirmed all 6 problems: no connection reuse, single server, manual wrapping, no caching, silent errors, no health checks
- Identified ~200 lines of manual MCP code that can be replaced by ~20 lines using `langchain-mcp-adapters`

### 5. Current MCP Server Assessment

- Reviewed `robyn_server/mcp/handlers.py`, `robyn_server/mcp/schemas.py`, `robyn_server/routes/mcp.py`
- Confirmed critical issue: `execute_agent_run` import fails → placeholder response
- ~580 lines of hand-rolled JSON-RPC 2.0 that could use FastMCP, but keeping manual approach for now (lower risk)

### 6. Compatibility Verification

- Checked `pyproject.toml` and `uv.lock` — `mcp` locked at 1.9.1, needs bump to 1.9.2
- All other deps compatible: `langchain-core>=1.2.11`, Python `>=3.11`
- No conflicts expected from adding `langchain-mcp-adapters>=0.2.1`

## Key Decisions Made

| Decision | Rationale |
|----------|-----------|
| **Adopt `langchain-mcp-adapters`** | Official LangChain package, mature, handles multi-server, auth, interceptors. Replaces ~200 lines with ~20. |
| **Keep MCP server manual JSON-RPC** | Rewriting to FastMCP is more risk than just wiring `execute_agent_run`. Future goal. |
| **Start with stateless MCP client** | Matches `langchain-mcp-adapters` default. Add stateful sessions later if latency is measured as a problem. |
| **Backward-compatible `MCPConfig`** | OAP UI sends single `{url, tools, auth_required}`. Translate internally. Multi-server is additive. |

## Deliverables

- [x] Evaluated `langchain-mcp-adapters` package (exists, mature, compatible)
- [x] Assessed current MCP client problems (6 confirmed issues)
- [x] Assessed current MCP server problems (5 confirmed issues)
- [x] Decided approach: adopt native package for client, fix wiring for server
- [x] Updated Goal 13 scratchpad with findings and refined task breakdown
- [x] Refined Tasks 02-04 with specific file changes and estimated scope

## References

- Goal 13 scratchpad: `../scratchpad.md` (comprehensive findings recorded there)
- `langchain-mcp-adapters` PyPI: https://pypi.org/project/langchain-mcp-adapters/
- `langchain-mcp-adapters` GitHub: https://github.com/langchain-ai/langchain-mcp-adapters
- LangChain MCP docs: https://docs.langchain.com/oss/python/langchain/mcp