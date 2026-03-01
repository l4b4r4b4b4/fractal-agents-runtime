"""Parallel research agent — two-phase workflow with human-in-the-loop.

This package provides a generic, reusable LangGraph graph that
implements the ``Vertriebsprozess`` BPMN pattern:

1. **Phase 1 (Broad search):** An analyzer LLM decomposes the user's
   query into parallel search tasks.  Mini ReAct worker agents (each
   with the assistant's MCP tools) execute those tasks concurrently.
   An aggregator LLM combines the results, and the workflow pauses
   for human review (``interrupt``).

2. **Phase 2 (Validation):** The analyzer creates validation tasks
   from the approved phase-1 results.  Workers verify and deepen
   the findings.  A final aggregator ranks and selects the best
   results, then pauses for a second human review.

All domain specificity comes from **prompts** (Langfuse) and **tools**
(MCP servers assigned per assistant instance).  The graph code itself
is fully generic.

Usage::

    from graphs.research_agent import graph

    agent = await graph(config, checkpointer=my_checkpointer, store=my_store)
    result = await agent.ainvoke(
        {"messages": [HumanMessage(content="Find logistics projects in Munich")]},
        config,
    )
"""

from __future__ import annotations

import logging
from importlib.metadata import PackageNotFoundError, version
from typing import Any

from langchain_core.runnables import RunnableConfig
from langchain_mcp_adapters.client import MultiServerMCPClient

from graphs.llm import create_chat_model
from graphs.research_agent.configuration import parse_config
from graphs.research_agent.graph import build_research_graph

# Trigger prompt registration on import (side-effect).
import graphs.research_agent.prompts as _prompts  # noqa: F401

logger = logging.getLogger(__name__)

__all__ = ["graph"]

try:
    __version__ = version("fractal-agents-runtime")
except PackageNotFoundError:
    __version__ = "0.0.0-dev"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _safe_mask_url(url: str) -> str:
    """Mask the middle of a URL for safe logging."""
    if len(url) <= 20:
        return url
    return url[:12] + "..." + url[-8:]


def _safe_present_configurable_keys(config: RunnableConfig) -> list[str]:
    """Return the configurable keys present (names only, no values)."""
    configurable = config.get("configurable")
    if isinstance(configurable, dict):
        return sorted(configurable.keys())
    return []


# ---------------------------------------------------------------------------
# Public graph factory
# ---------------------------------------------------------------------------


async def graph(
    config: RunnableConfig,
    *,
    checkpointer: Any | None = None,
    store: Any | None = None,
) -> Any:
    """Build the research agent graph.

    This factory follows the same pattern as
    :func:`graphs.react_agent.graph`:

    1. Resolves tools from the assistant's MCP config.
    2. Resolves the LLM from the assistant's model config.
    3. Builds and compiles the two-phase StateGraph.

    Args:
        config: ``RunnableConfig`` containing the assistant's
            ``configurable`` dict with LLM, MCP, and research-agent
            settings.
        checkpointer: Optional LangGraph checkpointer for durable
            execution (required for HIL interrupts to persist).
        store: Optional LangGraph store for cross-thread memory.

    Returns:
        A compiled LangGraph graph ready for ``.ainvoke()`` or
        ``.astream()``.

    Example::

        from graphs.research_agent import graph

        config = {
            "configurable": {
                "model_name": "openai:gpt-4o-mini",
                "auto_approve_phase1": True,
                "auto_approve_phase2": True,
            }
        }
        agent = await graph(config, checkpointer=cp, store=st)
        result = await agent.ainvoke(
            {"messages": [HumanMessage(content="Research topic X")]},
            config,
        )
    """
    logger.info(
        "research_agent graph() invoked; configurable_keys=%s",
        _safe_present_configurable_keys(config),
    )

    cfg = parse_config(config.get("configurable"))

    logger.info(
        "research_agent parsed_config; model_name=%s base_url_present=%s "
        "max_worker_iterations=%d auto_approve=(%s, %s)",
        cfg.model_name,
        bool(cfg.base_url),
        cfg.max_worker_iterations,
        cfg.auto_approve_phase1,
        cfg.auto_approve_phase2,
    )

    # --- Resolve tools (MCP + RAG) — same pattern as react_agent ----------

    tools: list[Any] = []

    # RAG tools
    supabase_token = (config.get("configurable", {}) or {}).get(
        "x-supabase-access-token"
    )
    if cfg.rag and cfg.rag.rag_url and cfg.rag.collections and supabase_token:
        try:
            from graphs.react_agent.utils.tools import create_rag_tool

            for collection in cfg.rag.collections:
                rag_tool = await create_rag_tool(
                    cfg.rag.rag_url, collection, supabase_token
                )
                tools.append(rag_tool)
            logger.info("research_agent: loaded %d RAG tools", len(cfg.rag.collections))
        except ImportError:
            logger.warning(
                "research_agent: could not import create_rag_tool — "
                "RAG tools unavailable"
            )

    # MCP tools
    if cfg.mcp_config and cfg.mcp_config.servers:
        mcp_server_entries: dict[str, dict[str, Any]] = {}
        server_tool_filters: dict[str, set[str] | None] = {}
        any_auth_required = any(
            server.auth_required for server in cfg.mcp_config.servers
        )

        mcp_tokens = None
        if any_auth_required:
            try:
                from graphs.react_agent.utils.token import fetch_tokens

                mcp_tokens = await fetch_tokens(config)
            except Exception:
                logger.warning(
                    "research_agent: failed to fetch MCP auth tokens",
                    exc_info=True,
                )

        for server in cfg.mcp_config.servers:
            raw_url = server.url.rstrip("/")
            server_url = raw_url if raw_url.endswith("/mcp") else raw_url + "/mcp"

            headers: dict[str, str] = {}
            if server.auth_required:
                if not mcp_tokens:
                    logger.warning(
                        "MCP server skipped (auth required but no tokens): name=%s url=%s",
                        server.name,
                        _safe_mask_url(server_url),
                    )
                    continue
                headers["Authorization"] = f"Bearer {mcp_tokens['access_token']}"

            server_key = server.name or "default"
            if server_key in mcp_server_entries:
                index = 2
                while f"{server_key}-{index}" in mcp_server_entries:
                    index += 1
                server_key = f"{server_key}-{index}"

            mcp_server_entries[server_key] = {
                "transport": "http",
                "url": server_url,
                "headers": headers,
            }
            server_tool_filters[server_key] = (
                set(server.tools) if server.tools else None
            )

        if mcp_server_entries:
            try:
                # Try to import the MCP interceptor; fall back gracefully.
                try:
                    from graphs.react_agent.utils.mcp_interceptors import (
                        handle_interaction_required,
                    )

                    interceptors = [handle_interaction_required]
                except ImportError:
                    interceptors = []

                mcp_client = MultiServerMCPClient(
                    mcp_server_entries,
                    **({"tool_interceptors": interceptors} if interceptors else {}),
                )
                mcp_tools = await mcp_client.get_tools()

                # Apply per-server filtering.
                filtered_tools = []
                for tool in mcp_tools:
                    tool_origin = getattr(tool, "server_name", None)
                    if tool_origin and tool_origin in server_tool_filters:
                        requested = server_tool_filters[tool_origin]
                        if requested is None or tool.name in requested:
                            filtered_tools.append(tool)
                    else:
                        filtered_tools.append(tool)

                tools.extend(filtered_tools)
                logger.info(
                    "research_agent: MCP tools loaded; count=%d servers=%s",
                    len(filtered_tools),
                    [
                        _safe_mask_url(entry["url"])
                        for entry in mcp_server_entries.values()
                    ],
                )
            except Exception as mcp_error:
                logger.warning(
                    "research_agent: failed to fetch MCP tools: %s", str(mcp_error)
                )

    # --- Resolve LLM via shared factory -----------------------------------

    configurable = config.get("configurable", {}) or {}

    # Build routing metadata for the semantic router (or any proxy).
    # These headers help the router make better routing decisions.
    routing_metadata: dict[str, str] = {"x-sr-graph-id": "research_agent"}
    org_id = configurable.get("x-org-id")
    if org_id:
        routing_metadata["x-sr-org-id"] = org_id
    user_tier = configurable.get("x-user-tier")
    if user_tier:
        routing_metadata["x-sr-user-tier"] = user_tier

    model = create_chat_model(
        config,
        model_name=cfg.model_name,
        temperature=cfg.temperature,
        max_tokens=cfg.max_tokens,
        base_url=cfg.base_url,
        custom_model_name=cfg.custom_model_name,
        model_name_override=configurable.get("model_name_override"),
        routing_metadata=routing_metadata,
    )

    # --- Log persistence ---------------------------------------------------

    if checkpointer is not None:
        logger.info(
            "research_agent: using injected checkpointer for thread persistence"
        )
    else:
        logger.warning(
            "research_agent: no checkpointer provided — HIL interrupts will "
            "NOT persist across server restarts"
        )

    if store is not None:
        logger.info("research_agent: using injected store for cross-thread memory")

    # --- Build the graph ---------------------------------------------------

    compiled = build_research_graph(
        model=model,
        tools=tools,
        config=config,
        checkpointer=checkpointer,
        store=store,
        max_worker_iterations=cfg.max_worker_iterations,
        auto_approve_phase1=cfg.auto_approve_phase1,
        auto_approve_phase2=cfg.auto_approve_phase2,
    )

    logger.info(
        "research_agent graph ready; tools=%d, model=%s",
        len(tools),
        cfg.model_name,
    )
    return compiled
