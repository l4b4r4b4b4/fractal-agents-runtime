"""Graph registry — dispatches to the correct graph factory.

This module provides a dict-based registry for resolving graph factory
functions from an assistant's ``graph_id``.  The server layer uses this
instead of hard-coding imports to a specific graph package.

Built-in graphs register themselves at import time.  The dict-based
design is intentionally extensible — a future BPMN-to-LangGraph compiler
or plugin loader can call :func:`register_graph` to add new graph types
at startup without modifying this module.

Supported built-in graph IDs:

- ``"agent"`` — :func:`graphs.react_agent.graph` (ReAct agent, default)
- ``"research_agent"`` — :func:`graphs.research_agent.graph`
  (two-phase parallel research with human-in-the-loop)

Unknown ``graph_id`` values fall back to the default (``"agent"``).

Usage::

    from graphs.registry import resolve_graph_factory

    build_graph = resolve_graph_factory(assistant.graph_id)
    compiled = await build_graph(config, checkpointer=cp, store=st)

Extending with a custom graph::

    from graphs.registry import register_graph

    async def my_custom_graph(config, *, checkpointer=None, store=None):
        ...
        return compiled_graph

    register_graph("my_custom", my_custom_graph)
"""

from __future__ import annotations

import logging
from typing import Any, Callable, Coroutine

logger = logging.getLogger(__name__)

# Type alias for an async graph factory function.
# Signature: (config, *, checkpointer=None, store=None) -> compiled graph
GraphFactory = Callable[..., Coroutine[Any, Any, Any]]

# Default graph_id used when the assistant doesn't specify one or the
# value is not recognised.
DEFAULT_GRAPH_ID = "agent"

# ---------------------------------------------------------------------------
# Registry storage
# ---------------------------------------------------------------------------

_GRAPH_REGISTRY: dict[str, GraphFactory | str] = {}
"""Maps graph_id → factory function or dotted import path (lazy)."""


# ---------------------------------------------------------------------------
# Lazy import helper
# ---------------------------------------------------------------------------


def _lazy_import(module_path: str, attribute: str) -> GraphFactory:
    """Return a wrapper that imports the factory on first call.

    This avoids loading all graph packages at startup — only the
    graph actually requested by the assistant is imported.
    """

    _cached: list[GraphFactory | None] = [None]

    async def _wrapper(config: Any, **kwargs: Any) -> Any:
        if _cached[0] is None:
            import importlib

            module = importlib.import_module(module_path)
            _cached[0] = getattr(module, attribute)
        return await _cached[0](config, **kwargs)  # type: ignore[misc]

    # Preserve a human-readable name for debugging.
    _wrapper.__qualname__ = f"lazy({module_path}.{attribute})"
    _wrapper.__name__ = attribute
    return _wrapper


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def register_graph(
    graph_id: str,
    factory: GraphFactory | None = None,
    *,
    module_path: str | None = None,
    attribute: str = "graph",
) -> None:
    """Register a graph factory under a given ``graph_id``.

    You can either pass a callable directly or provide a module path
    for lazy importing (recommended for built-in graphs to keep startup
    fast).

    Args:
        graph_id: Unique identifier (e.g. ``"agent"``,
            ``"research_agent"``).
        factory: An async callable with signature
            ``(config, *, checkpointer=None, store=None) -> compiled``.
            Mutually exclusive with *module_path*.
        module_path: Dotted module path for lazy import (e.g.
            ``"graphs.react_agent"``).  Used with *attribute*.
        attribute: Name of the factory function inside *module_path*
            (default ``"graph"``).

    Raises:
        ValueError: If neither *factory* nor *module_path* is provided,
            or if both are provided.

    Example::

        # Eager registration (factory already imported)
        register_graph("my_graph", my_graph_factory)

        # Lazy registration (imported on first use)
        register_graph("my_graph", module_path="graphs.my_graph", attribute="graph")
    """
    if factory is not None and module_path is not None:
        raise ValueError(
            f"register_graph({graph_id!r}): provide either 'factory' or "
            "'module_path', not both"
        )

    if factory is not None:
        _GRAPH_REGISTRY[graph_id] = factory
        logger.debug("Registered graph: %s (eager)", graph_id)
    elif module_path is not None:
        _GRAPH_REGISTRY[graph_id] = _lazy_import(module_path, attribute)
        logger.debug(
            "Registered graph: %s (lazy: %s.%s)", graph_id, module_path, attribute
        )
    else:
        raise ValueError(
            f"register_graph({graph_id!r}): provide either 'factory' or 'module_path'"
        )


def resolve_graph_factory(graph_id: str | None = None) -> GraphFactory:
    """Resolve a graph factory function from a ``graph_id`` string.

    Args:
        graph_id: The assistant's ``graph_id`` field.  ``None`` and
            unrecognised values fall back to ``"agent"``
            (:mod:`graphs.react_agent`).

    Returns:
        An async callable with signature
        ``(config, *, checkpointer=None, store=None) -> compiled_graph``.

    Example::

        factory = resolve_graph_factory("research_agent")
        agent = await factory(config, checkpointer=cp, store=st)
    """
    effective_id = graph_id or DEFAULT_GRAPH_ID

    factory = _GRAPH_REGISTRY.get(effective_id)
    if factory is not None:
        logger.debug("resolve_graph_factory: graph_id=%s → found", effective_id)
        return factory

    if effective_id != DEFAULT_GRAPH_ID:
        logger.warning(
            "resolve_graph_factory: unknown graph_id=%r — falling back to '%s'",
            effective_id,
            DEFAULT_GRAPH_ID,
        )
        factory = _GRAPH_REGISTRY.get(DEFAULT_GRAPH_ID)
        if factory is not None:
            return factory

    # Last resort: if registry is empty (shouldn't happen), import directly.
    logger.warning(
        "resolve_graph_factory: registry has no '%s' entry — importing directly",
        DEFAULT_GRAPH_ID,
    )
    from graphs.react_agent import graph as react_agent_graph

    return react_agent_graph


def get_available_graph_ids() -> list[str]:
    """Return the list of all registered graph IDs.

    Useful for the ``/info`` endpoint, assistant validation, and
    debugging.

    Returns:
        Sorted list of graph ID strings.
    """
    return sorted(_GRAPH_REGISTRY.keys())


# ---------------------------------------------------------------------------
# Built-in graph registration (lazy imports — no packages loaded at startup)
# ---------------------------------------------------------------------------

register_graph("agent", module_path="graphs.react_agent", attribute="graph")
register_graph("research_agent", module_path="graphs.research_agent", attribute="graph")
