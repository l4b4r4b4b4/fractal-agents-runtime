"""Canonical store namespace convention for org-scoped isolation.

Every LangGraph Store operation uses a 4-component tuple namespace::

    (org_id, user_id, assistant_id, category)

This module is the **single source of truth** for namespace construction.
All store consumers (token cache, memories, context, preferences) MUST use
these helpers instead of hand-crafting namespace tuples.

Namespace Components
--------------------
- **org_id**: Organization UUID from Supabase (``supabase_organization_id``).
  Top-level isolation; Supabase RLS enforces org membership.
- **user_id**: User identity from JWT (``owner`` in configurable).
  Per-user isolation within org.
- **assistant_id**: LangGraph assistant ID = Supabase agent UUID.
  Per-agent isolation within user.
- **category**: Type of stored data (see ``CATEGORY_*`` constants below).

Special Namespace Variants
--------------------------
- ``(org_id, "shared", assistant_id, category)`` — org-wide shared data
- ``(org_id, user_id, "global", category)`` — user-global across all agents
"""

import logging
from typing import NamedTuple

from langchain_core.runnables import RunnableConfig

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Standard categories
# ---------------------------------------------------------------------------

CATEGORY_TOKENS = "tokens"
"""MCP token cache (per agent). Written and read by runtime."""

CATEGORY_CONTEXT = "context"
"""Webapp-provided agent-specific user context. Written by webapp, read by runtime."""

CATEGORY_MEMORIES = "memories"
"""Runtime-learned facts persisted across threads. Written and read by runtime."""

CATEGORY_PREFERENCES = "preferences"
"""User preferences for this agent. Written by webapp or runtime, read by runtime."""

# ---------------------------------------------------------------------------
# Special pseudo-IDs for namespace variants
# ---------------------------------------------------------------------------

SHARED_USER_ID = "shared"
"""Pseudo user_id for org-wide shared data (all org members can read)."""

GLOBAL_AGENT_ID = "global"
"""Pseudo assistant_id for user-global data (shared across all agents for a user)."""


# ---------------------------------------------------------------------------
# Namespace components
# ---------------------------------------------------------------------------


class NamespaceComponents(NamedTuple):
    """Extracted namespace components from a RunnableConfig.

    Attributes:
        org_id: Organization UUID string.
        user_id: User identity string.
        assistant_id: Assistant/agent UUID string.
    """

    org_id: str
    user_id: str
    assistant_id: str


def extract_namespace_components(
    config: RunnableConfig,
) -> NamespaceComponents | None:
    """Extract org_id, user_id, and assistant_id from a RunnableConfig.

    Reads from ``config["configurable"]``:
    - ``supabase_organization_id`` → org_id
    - ``owner`` → user_id
    - ``assistant_id`` → assistant_id

    Args:
        config: The LangGraph RunnableConfig passed to graph functions.

    Returns:
        A :class:`NamespaceComponents` tuple, or ``None`` if any required
        component is missing or empty.  Callers should treat ``None`` as
        "namespace unavailable — skip store operation gracefully".
    """
    configurable: dict = config.get("configurable", {}) or {}

    org_id = configurable.get("supabase_organization_id")
    user_id = configurable.get("owner")
    assistant_id = configurable.get("assistant_id")

    # All three components are required for a valid scoped namespace.
    if not org_id or not isinstance(org_id, str):
        logger.debug(
            "extract_namespace_components: missing or invalid org_id "
            "(supabase_organization_id=%r)",
            org_id,
        )
        return None

    if not user_id or not isinstance(user_id, str):
        logger.debug(
            "extract_namespace_components: missing or invalid user_id (owner=%r)",
            user_id,
        )
        return None

    if not assistant_id or not isinstance(assistant_id, str):
        logger.debug(
            "extract_namespace_components: missing or invalid assistant_id=%r",
            assistant_id,
        )
        return None

    return NamespaceComponents(
        org_id=str(org_id).strip(),
        user_id=str(user_id).strip(),
        assistant_id=str(assistant_id).strip(),
    )


def build_namespace(
    org_id: str,
    user_id: str,
    assistant_id: str,
    category: str,
) -> tuple[str, str, str, str]:
    """Build a canonical 4-component store namespace tuple.

    Args:
        org_id: Organization UUID string.
        user_id: User identity string (or :data:`SHARED_USER_ID` for org-wide).
        assistant_id: Assistant UUID string (or :data:`GLOBAL_AGENT_ID` for user-global).
        category: Data category (use ``CATEGORY_*`` constants).

    Returns:
        A 4-tuple ``(org_id, user_id, assistant_id, category)``.

    Raises:
        ValueError: If any component is empty or whitespace-only.

    Examples:
        >>> build_namespace("org-123", "user-456", "agent-789", CATEGORY_TOKENS)
        ('org-123', 'user-456', 'agent-789', 'tokens')

        >>> build_namespace("org-123", SHARED_USER_ID, "agent-789", CATEGORY_CONTEXT)
        ('org-123', 'shared', 'agent-789', 'context')
    """
    components = {
        "org_id": org_id,
        "user_id": user_id,
        "assistant_id": assistant_id,
        "category": category,
    }
    for name, value in components.items():
        if not value or not value.strip():
            error_message = (
                f"build_namespace: {name} must be a non-empty string, got {value!r}"
            )
            raise ValueError(error_message)

    return (
        org_id.strip(),
        user_id.strip(),
        assistant_id.strip(),
        category.strip(),
    )
