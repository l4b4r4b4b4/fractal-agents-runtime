# Goal 09 — Standalone PyPI Package

> Extract `robyn_server/` into a standalone PyPI package for the broader community.

---

## Status: ⚪ Not Started (Idea Stage)

---

## Background

I opened an issue on upstream `langchain-ai/oap-langgraph-tools-agent`:
- **Issue #42**: https://github.com/langchain-ai/oap-langgraph-tools-agent/issues/42
- Asked if they're interested in the Robyn runtime or if a standalone package is preferred

Depending on their response, I may publish this as a separate package.

---

## Package Concept

**Name options:**
- `robyn-langgraph-runtime`
- `langgraph-robyn-server`
- `robyn-langgraph`

**What it would provide:**
- Drop-in replacement for `langgraph dev` server
- Full LangGraph API compatibility (Tier 1, 2, 3)
- Rust-powered performance via Robyn
- Built-in Supabase auth, Prometheus metrics
- A2A, MCP, Crons support

**Target users:**
- People who want a faster alternative to the default LangGraph server
- Production deployments needing better performance
- Anyone wanting Prometheus metrics, MCP, A2A out of the box

---

## Rough Task Breakdown (If Proceeding)

1. **Extract robyn_server/** into separate repo or package structure
2. **Decouple from tools_agent** - Make it work with any LangGraph agent
3. **Create proper pyproject.toml** for standalone package
4. **Publish to PyPI** as 0.0.0 (first release)
5. **Documentation** - Standalone README, usage examples
6. **CI/CD** - GitHub Actions for PyPI publishing

---

## Decision Point

Wait for response on Issue #42 before proceeding. Options:

| Response | Action |
|----------|--------|
| "Yes, submit a PR" | Contribute to upstream instead |
| "Standalone package preferred" | Proceed with this goal |
| No response / not interested | Decide if worth publishing independently |

---

## Notes

- Current implementation is tightly coupled to `tools_agent` agent
- Would need to make the agent configurable/pluggable
- Consider if this is worth the maintenance burden

---

## References

- Upstream issue: https://github.com/langchain-ai/oap-langgraph-tools-agent/issues/42
- My fork: https://github.com/l4b4r4b4b4/oap-langgraph-tools-agent
- Robyn framework: https://github.com/sparckles/robyn