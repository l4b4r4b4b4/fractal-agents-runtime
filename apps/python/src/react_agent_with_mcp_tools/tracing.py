"""Tracing configuration for the OAP LangGraph Tools Agent.

Handles Langfuse initialization and provides callback handlers for
LangChain/LangGraph agent invocations. Disables LangSmith tracing
by default.

This module should be imported early in the application lifecycle
(e.g., from ``robyn_server.app``) so that the ``LANGCHAIN_TRACING_V2``
environment variable is set before any LangChain imports occur.

Usage::

    from react_agent_with_mcp_tools.tracing import initialize_langfuse, inject_tracing

    # At startup
    initialize_langfuse()

    # Per invocation
    config = inject_tracing(
        runnable_config,
        user_id=owner_id,
        session_id=thread_id,
        trace_name="agent-stream",
    )
    result = await agent.ainvoke(agent_input, config)

Environment variables:
    LANGFUSE_SECRET_KEY: Langfuse secret key (required for tracing).
    LANGFUSE_PUBLIC_KEY: Langfuse public key (required for tracing).
    LANGFUSE_BASE_URL: Langfuse host URL
        (default: ``https://cloud.langfuse.com``).
    LANGCHAIN_TRACING_V2: Set to ``"true"`` to re-enable LangSmith
        (default: ``"false"``).
"""

from __future__ import annotations

import logging
import os
from typing import Any

from langchain_core.runnables import RunnableConfig

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Disable LangSmith tracing by default
# ---------------------------------------------------------------------------
# LangChain checks this env var to decide whether to send traces to
# LangSmith.  We default to "false" so LangSmith is never implicitly
# enabled.  Users can still set LANGCHAIN_TRACING_V2=true explicitly
# if they want LangSmith alongside or instead of Langfuse.
if "LANGCHAIN_TRACING_V2" not in os.environ:
    os.environ["LANGCHAIN_TRACING_V2"] = "false"
    logger.debug("LANGCHAIN_TRACING_V2 defaulted to 'false' (LangSmith disabled)")

# ---------------------------------------------------------------------------
# Module state
# ---------------------------------------------------------------------------

_langfuse_initialized: bool = False


# ---------------------------------------------------------------------------
# Public helpers
# ---------------------------------------------------------------------------


def is_langfuse_configured() -> bool:
    """Return ``True`` if the required Langfuse env vars are present.

    Both ``LANGFUSE_SECRET_KEY`` and ``LANGFUSE_PUBLIC_KEY`` must be set
    and non-empty for Langfuse tracing to be enabled.

    Returns:
        Whether Langfuse configuration is available.
    """
    return bool(os.getenv("LANGFUSE_SECRET_KEY") and os.getenv("LANGFUSE_PUBLIC_KEY"))


def is_langfuse_enabled() -> bool:
    """Return ``True`` if the Langfuse client has been initialised.

    Returns:
        Whether :func:`initialize_langfuse` completed successfully.
    """
    return _langfuse_initialized


def initialize_langfuse() -> bool:
    """Initialise the Langfuse client singleton.

    Call this once at application startup (e.g., in the Robyn startup
    handler).  The ``Langfuse()`` constructor reads connection details
    from ``LANGFUSE_SECRET_KEY``, ``LANGFUSE_PUBLIC_KEY``, and
    ``LANGFUSE_BASE_URL`` automatically.

    If the required env vars are missing or initialisation fails, tracing
    is silently disabled and the application continues to function
    normally.

    Returns:
        ``True`` if Langfuse was initialised, ``False`` otherwise.
    """
    global _langfuse_initialized

    if _langfuse_initialized:
        return True

    if not is_langfuse_configured():
        logger.info(
            "Langfuse not configured "
            "(LANGFUSE_SECRET_KEY / LANGFUSE_PUBLIC_KEY not set) "
            "— tracing disabled"
        )
        return False

    try:
        from langfuse import Langfuse

        # Langfuse() reads env vars automatically and registers the
        # singleton that ``get_client()`` returns later.
        Langfuse()
        _langfuse_initialized = True

        base_url = os.getenv("LANGFUSE_BASE_URL", "https://cloud.langfuse.com")
        logger.info("Langfuse tracing initialised; base_url=%s", base_url)
        return True
    except Exception:
        logger.warning(
            "Failed to initialise Langfuse — tracing disabled",
            exc_info=True,
        )
        return False


def shutdown_langfuse() -> None:
    """Flush pending events and shut down the Langfuse client.

    Safe to call even when Langfuse was never initialised (no-op).
    Should be called in the application shutdown handler.
    """
    global _langfuse_initialized

    if not _langfuse_initialized:
        return

    try:
        from langfuse import get_client

        client = get_client()
        client.shutdown()
        logger.info("Langfuse client shut down")
    except Exception:
        logger.warning("Error shutting down Langfuse", exc_info=True)
    finally:
        _langfuse_initialized = False


def get_langfuse_callback_handler() -> Any | None:
    """Create a Langfuse ``CallbackHandler`` for a single invocation.

    In Langfuse v3 the handler reads trace-level attributes
    (``user_id``, ``session_id``, ``tags``) from the ``metadata`` dict
    inside the ``RunnableConfig`` rather than from constructor args.
    Use :func:`inject_tracing` to set those attributes conveniently.

    Returns:
        A ``langfuse.langchain.CallbackHandler`` instance, or ``None``
        if Langfuse is not initialised.
    """
    if not _langfuse_initialized:
        return None

    try:
        from langfuse.langchain import CallbackHandler

        return CallbackHandler()
    except Exception:
        logger.warning(
            "Failed to create Langfuse callback handler",
            exc_info=True,
        )
        return None


def inject_tracing(
    config: RunnableConfig,
    *,
    user_id: str | None = None,
    session_id: str | None = None,
    trace_name: str | None = None,
    tags: list[str] | None = None,
) -> RunnableConfig:
    """Augment a ``RunnableConfig`` with Langfuse tracing.

    If Langfuse is not initialised the config is returned unchanged,
    making this safe to call unconditionally at every invocation point.

    The function:

    1. Creates a fresh ``CallbackHandler`` and appends it to the
       config's ``callbacks`` list.
    2. Injects ``langfuse_user_id``, ``langfuse_session_id``, and
       ``langfuse_tags`` into the config ``metadata`` dict so that
       Langfuse can attribute traces correctly (v3 convention).
    3. Optionally sets ``run_name`` for human-readable trace naming.

    Args:
        config: The base ``RunnableConfig`` (not mutated).
        user_id: Owner / user identity for trace attribution.
        session_id: Thread ID or session identifier for grouping.
        trace_name: Human-readable name shown in the Langfuse UI
            (e.g., ``"agent-stream"``, ``"mcp-invoke"``).
        tags: Freeform tags for filtering in the Langfuse dashboard.

    Returns:
        A **new** ``RunnableConfig`` with tracing injected, or the
        original config if Langfuse is disabled.

    Example::

        config = _build_runnable_config(...)
        config = inject_tracing(
            config,
            user_id=owner_id,
            session_id=thread_id,
            trace_name="agent-stream",
            tags=["robyn", "streaming"],
        )
        async for event in agent.astream_events(agent_input, config, version="v2"):
            ...
    """
    handler = get_langfuse_callback_handler()
    if handler is None:
        return config

    # --- Merge callback handler -------------------------------------------
    existing_callbacks: list[Any] = list(config.get("callbacks") or [])
    existing_callbacks.append(handler)

    augmented: dict[str, Any] = {**config, "callbacks": existing_callbacks}

    # --- Merge Langfuse metadata ------------------------------------------
    # Langfuse v3 CallbackHandler reads these keys from the config's
    # ``metadata`` dict to set trace-level attributes.
    langfuse_metadata: dict[str, Any] = {}
    if user_id:
        langfuse_metadata["langfuse_user_id"] = user_id
    if session_id:
        langfuse_metadata["langfuse_session_id"] = session_id
    if tags:
        langfuse_metadata["langfuse_tags"] = tags

    if langfuse_metadata:
        existing_metadata: dict[str, Any] = dict(config.get("metadata") or {})
        existing_metadata.update(langfuse_metadata)
        augmented["metadata"] = existing_metadata

    # --- Trace name -------------------------------------------------------
    if trace_name:
        augmented["run_name"] = trace_name

    return RunnableConfig(**augmented)


# ---------------------------------------------------------------------------
# Reset helper (testing only)
# ---------------------------------------------------------------------------


def _reset_tracing_state() -> None:
    """Reset module-level state for test isolation.

    .. warning:: This is intended for tests only.  Do not call in
       production code.
    """
    global _langfuse_initialized
    _langfuse_initialized = False
