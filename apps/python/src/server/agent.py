"""Agent execution module for MCP and protocol integrations.

Provides non-streaming agent execution that MCP handlers (and potentially
A2A handlers) can call to run the LangGraph agent.

This module is intentionally self-contained — it does NOT import from
``server.routes.streams`` to avoid circular dependencies. It reuses
the same ``graph()`` factory from ``graphs.react_agent.agent`` and builds its own
``RunnableConfig``.

Example::

    result_text = await execute_agent_run(
        message="What is 2 + 2?",
        thread_id=None,
        assistant_id="agent",
        owner_id="mcp-client",
    )
"""

import logging
import uuid
from typing import Any

from langchain_core.messages import AIMessage, BaseMessage, HumanMessage
from langchain_core.runnables import RunnableConfig

from infra.tracing import inject_tracing

logger = logging.getLogger(__name__)

# Default owner ID for unauthenticated MCP access.
DEFAULT_MCP_OWNER = "mcp-client"


def _build_mcp_runnable_config(
    thread_id: str,
    assistant_id: str,
    assistant_config: dict[str, Any] | None,
    owner_id: str,
) -> RunnableConfig:
    """Build a RunnableConfig for non-streaming agent invocation.

    Merges assistant-level configurable settings with runtime metadata.
    This mirrors the logic in ``routes/streams._build_runnable_config``
    but is self-contained to avoid cross-module coupling.

    Args:
        thread_id: Thread ID for conversation continuity.
        assistant_id: Assistant identifier.
        assistant_config: Configuration dict from the assistant record.
            Expected shape: ``{"configurable": {...}}`` or ``None``.
        owner_id: Owner/user identity string.

    Returns:
        A RunnableConfig with merged configurable dict.
    """
    run_id = str(uuid.uuid4())
    configurable: dict[str, Any] = {}

    # Layer 1: Assistant-level configuration
    if assistant_config and isinstance(assistant_config, dict):
        assistant_configurable = assistant_config.get("configurable", {})
        if isinstance(assistant_configurable, dict):
            configurable.update(assistant_configurable)

    # Layer 2: Runtime metadata
    configurable["run_id"] = run_id
    configurable["thread_id"] = thread_id
    configurable["assistant_id"] = assistant_id
    configurable["owner"] = owner_id
    configurable["user_id"] = owner_id

    # Include assistant config reference for
    # _merge_assistant_configurable_into_run_config in graphs.react_agent.agent
    if assistant_config and isinstance(assistant_config, dict):
        configurable["assistant"] = assistant_config

    return RunnableConfig(
        configurable=configurable,
        run_id=run_id,
    )


def _extract_response_text(result: dict[str, Any]) -> str:
    """Extract the final AI response text from an agent invocation result.

    The agent returns ``{"messages": [HumanMessage, ..., AIMessage]}``.
    We walk backward through the message list to find the last AI message
    and return its content.

    Args:
        result: The dict returned by ``agent.ainvoke()``.

    Returns:
        The text content of the last AI message, or a JSON-serialised
        fallback if no AI message is found.
    """
    messages = result.get("messages", [])

    # Walk backward to find the last AI message
    for message in reversed(messages):
        if isinstance(message, AIMessage):
            content = message.content
            if isinstance(content, str):
                return content
            # Handle list-of-dicts content (multimodal)
            if isinstance(content, list):
                text_parts = []
                for part in content:
                    if isinstance(part, dict) and part.get("type") == "text":
                        text_parts.append(part.get("text", ""))
                    elif isinstance(part, str):
                        text_parts.append(part)
                return "\n".join(text_parts) if text_parts else str(content)
            return str(content)

        if isinstance(message, dict):
            msg_type = message.get("type", "")
            if msg_type == "ai":
                return message.get("content", "")

    # Fallback: no AI message found — shouldn't happen in normal flow
    import json

    logger.warning("No AI message found in agent result; returning raw JSON")
    return json.dumps(result, default=str)


async def execute_agent_run(
    message: str,
    thread_id: str | None = None,
    assistant_id: str = "agent",
    owner_id: str = DEFAULT_MCP_OWNER,
) -> str:
    """Execute the LangGraph agent with a message and return the response text.

    This is the non-streaming counterpart to ``execute_run_stream`` in
    ``server.routes.streams``.  It is used by the MCP ``tools/call``
    handler and can be reused by any integration that needs a simple
    request → response interface.

    The function:

    1. Looks up the assistant config from storage (falls back to defaults).
    2. Creates or reuses a thread.
    3. Builds a ``RunnableConfig`` with merged assistant + runtime settings.
    4. Calls ``graph(config)`` to build the LangGraph agent.
    5. Invokes the agent with ``ainvoke`` (non-streaming).
    6. Extracts the last AI message content from the result.

    Args:
        message: The user message to send to the agent.
        thread_id: Optional thread ID for conversation continuity.
            If ``None``, a new thread is created.
        assistant_id: Assistant ID to look up in storage.
            Defaults to ``"agent"``.
        owner_id: Owner/user identity for storage operations.
            Defaults to ``"mcp-client"`` for unauthenticated MCP access.

    Returns:
        The agent's text response.

    Raises:
        Exception: Propagates any exception from agent construction or
            invocation so callers (MCP handler) can wrap it in a structured
            error response.

    Example::

        text = await execute_agent_run("Summarise the latest news")
        print(text)
    """
    # Import inside function to avoid circular imports at module level.
    from server.database import (
        checkpointer as create_checkpointer,
        store as create_store,
    )
    from server.storage import get_storage
    from graphs.registry import resolve_graph_factory

    storage = get_storage()

    # --- Resolve assistant config ---
    assistant_config: dict[str, Any] | None = None
    try:
        assistant = await storage.assistants.get(assistant_id, owner_id)
        if assistant is None:
            # Try matching by graph_id (common pattern)
            all_assistants = await storage.assistants.list(owner_id)
            assistant = next(
                (a for a in all_assistants if a.graph_id == assistant_id),
                None,
            )
        if assistant is not None:
            # assistant.config may be a Pydantic model or a dict
            if hasattr(assistant.config, "model_dump"):
                assistant_config = assistant.config.model_dump()
            elif isinstance(assistant.config, dict):
                assistant_config = assistant.config
    except Exception as assistant_error:
        logger.warning(
            "Failed to load assistant %s: %s — using defaults",
            assistant_id,
            assistant_error,
        )

    # --- Resolve thread ---
    if thread_id is None:
        thread = await storage.threads.create({}, owner_id)
        thread_id = thread.thread_id
        logger.debug("Created new thread %s for MCP run", thread_id)
    else:
        # Verify thread exists; create if missing
        existing_thread = await storage.threads.get(thread_id, owner_id)
        if existing_thread is None:
            thread = await storage.threads.create({}, owner_id)
            thread_id = thread.thread_id
            logger.debug(
                "Thread %s not found — created new thread %s",
                thread_id,
                thread.thread_id,
            )

    # --- Build config & agent ---
    runnable_config = _build_mcp_runnable_config(
        thread_id=thread_id,
        assistant_id=assistant_id,
        assistant_config=assistant_config,
        owner_id=owner_id,
    )

    # Inject Langfuse tracing (no-op if not configured)
    runnable_config = inject_tracing(
        runnable_config,
        user_id=owner_id,
        session_id=thread_id,
        trace_name="mcp-invoke",
        tags=["robyn", "mcp"],
    )

    logger.info(
        "execute_agent_run: building agent; assistant_id=%s thread_id=%s",
        assistant_id,
        thread_id,
    )

    # Resolve the graph factory from the assistant's graph_id.
    # Default is "agent" (react_agent) for backwards compatibility.
    graph_id = None
    if assistant is not None:
        graph_id = getattr(assistant, "graph_id", None)
    build_graph = resolve_graph_factory(graph_id)

    # Per-request checkpointer/store via LangGraph's from_conn_string().
    # Each creates a fresh AsyncConnection on the current event loop —
    # no shared pool, no cross-loop asyncio.Lock issues.

    async with create_checkpointer() as cp, create_store() as st:
        agent = await build_graph(
            runnable_config,
            checkpointer=cp,
            store=st,
        )

        # --- Invoke ---
        input_message = HumanMessage(content=message, id=str(uuid.uuid4()))
        agent_input = {"messages": [input_message]}

        logger.info(
            "execute_agent_run: invoking agent with %d-char message", len(message)
        )
        result = await agent.ainvoke(agent_input, runnable_config)

    # --- Extract response ---
    response_text = _extract_response_text(result)
    logger.info(
        "execute_agent_run: completed; response length=%d chars", len(response_text)
    )

    # --- Persist final state ---
    try:
        final_messages: list[dict[str, Any]] = []
        for msg in result.get("messages", []):
            if isinstance(msg, BaseMessage):
                if hasattr(msg, "model_dump"):
                    final_messages.append(msg.model_dump())
                else:
                    final_messages.append(
                        {
                            "content": getattr(msg, "content", ""),
                            "type": getattr(msg, "type", "unknown"),
                            "id": getattr(msg, "id", None),
                        }
                    )
            elif isinstance(msg, dict):
                final_messages.append(msg)

        final_values = {"messages": final_messages}
        await storage.threads.add_state_snapshot(thread_id, final_values, owner_id)
        await storage.threads.update(thread_id, {"values": final_values}, owner_id)
    except Exception as persist_error:
        # Persistence failure should not prevent returning the response
        logger.warning("Failed to persist MCP run state: %s", persist_error)

    return response_text


async def get_agent_tool_info(
    assistant_id: str = "agent",
    owner_id: str = DEFAULT_MCP_OWNER,
) -> dict[str, Any]:
    """Introspect the agent's configured tools for dynamic MCP tool listing.

    Queries the assistant config from storage and extracts information
    about available sub-tools (MCP tools, RAG collections).

    Args:
        assistant_id: Assistant ID to inspect.
        owner_id: Owner identity for storage access.

    Returns:
        A dict with tool metadata::

            {
                "mcp_tools": ["tool1", "tool2"],
                "mcp_url": "http://...",
                "rag_collections": ["collection-uuid-1"],
                "rag_url": "http://...",
                "model_name": "openai:gpt-4o",
            }

        All fields default to empty/None if not configured.
    """
    from server.storage import get_storage

    info: dict[str, Any] = {
        "mcp_tools": [],
        "mcp_url": None,
        "rag_collections": [],
        "rag_url": None,
        "model_name": None,
    }

    try:
        storage = get_storage()
        assistant = await storage.assistants.get(assistant_id, owner_id)
        if assistant is None:
            all_assistants = await storage.assistants.list(owner_id)
            assistant = next(
                (a for a in all_assistants if a.graph_id == assistant_id),
                None,
            )

        if assistant is None:
            return info

        # Extract configurable from assistant config
        config = assistant.config
        if hasattr(config, "model_dump"):
            config = config.model_dump()
        if not isinstance(config, dict):
            return info

        configurable = config.get("configurable", {})
        if not isinstance(configurable, dict):
            return info

        # Model name
        info["model_name"] = configurable.get("model_name")

        # MCP tools (multi-server MCP config)
        mcp_config = configurable.get("mcp_config")
        if isinstance(mcp_config, dict):
            servers = mcp_config.get("servers")

            # New shape: {"servers": [{"name": "..", "url": "..", "tools": [...]} ...]}
            if isinstance(servers, list):
                mcp_urls: list[str] = []
                mcp_tool_names: list[str] = []

                for server in servers:
                    if not isinstance(server, dict):
                        continue

                    url_value = server.get("url")
                    if isinstance(url_value, str) and url_value:
                        mcp_urls.append(url_value)

                    tools_value = server.get("tools")
                    if isinstance(tools_value, list):
                        mcp_tool_names.extend(
                            str(tool_name) for tool_name in tools_value
                        )

                # Preserve backward-compatible output schema of this introspection:
                # - info["mcp_url"] remains a single string (first URL) or None
                # - info["mcp_tools"] remains a flat list of tool names
                info["mcp_url"] = mcp_urls[0] if mcp_urls else None
                info["mcp_tools"] = sorted(set(mcp_tool_names))

        # RAG collections
        rag_config = configurable.get("rag")
        if isinstance(rag_config, dict):
            info["rag_url"] = rag_config.get("rag_url")
            collections = rag_config.get("collections")
            if isinstance(collections, list):
                info["rag_collections"] = [
                    str(collection) for collection in collections
                ]

    except Exception as introspection_error:
        logger.warning(
            "Failed to introspect agent tools for assistant %s: %s",
            assistant_id,
            introspection_error,
        )

    return info
