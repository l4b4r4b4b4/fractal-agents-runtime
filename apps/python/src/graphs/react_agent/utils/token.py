"""MCP token utilities.

The MCP servers in this deployment sit behind Kong with Supabase auth.
They validate the standard Supabase JWT from the ``Authorization: Bearer``
header — exactly like every other Kong-guarded service in the stack.

No RFC 8693 token exchange is required.  ``fetch_tokens`` reads the JWT
that the server middleware already stored in
``configurable["langgraph_auth_user"]["token"]`` and returns it directly
in the shape the agent expects::

    {"access_token": "<supabase-jwt>"}

See :mod:`server.auth` and :mod:`server.routes.streams` for how the JWT
is injected into the runnable config.
"""

import logging
from typing import Any

from langchain_core.runnables import RunnableConfig

logger = logging.getLogger(__name__)


async def fetch_tokens(
    config: RunnableConfig,
    store: Any = None,
) -> dict[str, Any] | None:
    """Return the user's Supabase JWT as an MCP-compatible token dict.

    The MCP servers in this deployment authenticate via a standard Supabase
    JWT passed as ``Authorization: Bearer``.  No token exchange is required
    — the JWT from ``langgraph_auth_user`` is used directly.

    Args:
        config: The LangGraph runnable config.  Must contain
            ``configurable["langgraph_auth_user"]["token"]`` (set by the
            server auth middleware) or the legacy
            ``configurable["x-supabase-access-token"]`` key.
        store: Unused.  Kept for call-site signature compatibility —
            ``agent.py`` and ``research_agent/__init__.py`` both pass
            ``store=store``.

    Returns:
        ``{"access_token": "<jwt>"}`` when a JWT is present,
        ``None`` when no JWT is available (unauthenticated request).

    Examples:
        >>> import asyncio
        >>> from langchain_core.runnables import RunnableConfig
        >>> config = RunnableConfig(configurable={
        ...     "langgraph_auth_user": {"token": "eyJmy-jwt"}
        ... })
        >>> asyncio.run(fetch_tokens(config))
        {'access_token': 'eyJmy-jwt'}
    """
    configurable = config.get("configurable", {}) or {}

    # Prefer langgraph_auth_user (LangGraph Platform convention, set by
    # auth_middleware via _build_runnable_config).
    auth_user = configurable.get("langgraph_auth_user") or {}
    supabase_token = auth_user.get("token") or configurable.get(
        "x-supabase-access-token"
    )

    if not supabase_token:
        logger.debug("fetch_tokens: no Supabase JWT found in config")
        return None

    return {"access_token": supabase_token}
