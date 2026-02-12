"""Fractal Agent Infra — shared runtime infrastructure.

Provides tracing, auth middleware, and store namespace conventions
for the fractal-agents-runtime ecosystem.

Usage::

    from fractal_agent_infra.tracing import initialize_langfuse, inject_tracing
    from fractal_agent_infra.store_namespace import build_namespace, CATEGORY_TOKENS
"""

from importlib.metadata import PackageNotFoundError, version

from fractal_agent_infra.store_namespace import (
    CATEGORY_CONTEXT,
    CATEGORY_MEMORIES,
    CATEGORY_PREFERENCES,
    CATEGORY_TOKENS,
    GLOBAL_AGENT_ID,
    SHARED_USER_ID,
    NamespaceComponents,
    build_namespace,
    extract_namespace_components,
)
from fractal_agent_infra.tracing import (
    initialize_langfuse,
    inject_tracing,
    is_langfuse_configured,
    is_langfuse_enabled,
    shutdown_langfuse,
)

__all__ = [
    "CATEGORY_CONTEXT",
    "CATEGORY_MEMORIES",
    "CATEGORY_PREFERENCES",
    "CATEGORY_TOKENS",
    "GLOBAL_AGENT_ID",
    "SHARED_USER_ID",
    "NamespaceComponents",
    "build_namespace",
    "extract_namespace_components",
    "initialize_langfuse",
    "inject_tracing",
    "is_langfuse_configured",
    "is_langfuse_enabled",
    "shutdown_langfuse",
]

try:
    __version__ = version("fractal-agent-infra")
except PackageNotFoundError:
    # Package is not installed (running from source / editable install
    # before first ``uv sync``).
    __version__ = "0.0.0-dev"
