"""ReAct agent with MCP tools — portable graph architecture.

This package provides a self-contained ReAct agent graph built on LangGraph
with MCP tool integration, RAG tool factory, and multi-provider LLM support.

The graph factory uses dependency injection for persistence — it never
imports from any specific runtime.

Usage::

    from react_agent import graph

    # Build the agent — runtime injects persistence
    agent = await graph(config, checkpointer=my_checkpointer, store=my_store)
"""

from importlib.metadata import PackageNotFoundError, version

from react_agent.agent import graph

__all__ = ["graph"]

try:
    __version__ = version("fractal-graph-react-agent")
except PackageNotFoundError:
    # Package is not installed (running from source / editable install
    # before first ``uv sync``).
    __version__ = "0.0.0-dev"
