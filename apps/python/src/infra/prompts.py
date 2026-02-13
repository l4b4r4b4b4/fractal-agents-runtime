"""Langfuse prompt management integration.

Provides a thin wrapper around Langfuse's prompt fetching with:

- **Text and chat prompt support** — returns ``str`` or ``list[dict]``
  depending on the prompt type.
- **Automatic fallback** to hardcoded defaults when Langfuse is not
  configured or unreachable.
- **Runtime overrides** via ``RunnableConfig.configurable.prompt_overrides``
  — allows the frontend to select a specific prompt name, label, or
  version at call time for A/B testing and composition.
- **Caching** via the Langfuse SDK's built-in client-side cache.
- **No-op behaviour** when Langfuse is not configured — graphs work
  identically with hardcoded prompts.

Usage::

    from infra.prompts import get_prompt

    # Simple text prompt with fallback
    system_prompt = get_prompt(
        "react-agent-system-prompt",
        fallback="You are a helpful assistant.",
    )

    # Chat prompt with variables and runtime config
    messages = get_prompt(
        "vertriebsagent-analyzer-phase1",
        prompt_type="chat",
        fallback=[{"role": "system", "content": "Du bist ein Supervisor-Agent."}],
        config=config,
        variables={"stadt": "München"},
    )

Runtime override (frontend sends via configurable)::

    {
        "configurable": {
            "prompt_overrides": {
                "react-agent-system-prompt": {
                    "label": "experiment-a"
                },
                "vertriebsagent-analyzer-phase1": {
                    "version": 5
                }
            }
        }
    }

Override keys:

- ``name``  — swap to a completely different Langfuse prompt
- ``label`` — fetch a different label (default: ``"production"``)
- ``version`` — pin to an exact version number

Environment variables:

    LANGFUSE_PROMPT_CACHE_TTL: Override the default cache TTL in seconds
        (default: ``300``).  Set to ``0`` to disable caching (useful in
        development).
"""

from __future__ import annotations

import logging
import os
import re
from typing import Any, Literal, overload

from langchain_core.runnables import RunnableConfig

from infra.tracing import is_langfuse_enabled

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Types
# ---------------------------------------------------------------------------

ChatMessage = dict[str, str]
"""A single chat message dict with ``role`` and ``content`` keys."""

# ---------------------------------------------------------------------------
# Prompt registry — graphs register their defaults here
# ---------------------------------------------------------------------------

_registered_prompts: list[
    tuple[str, str | list[ChatMessage], Literal["text", "chat"]]
] = []
"""List of ``(name, default_content, prompt_type)`` tuples registered by graphs."""


def register_default_prompt(
    name: str,
    default: str | list[ChatMessage],
    prompt_type: Literal["text", "chat"] = "text",
) -> None:
    """Register a prompt default for auto-seeding in Langfuse at startup.

    Call this at module level in each graph's prompts or ``__init__`` module.
    The infra layer stores them and :func:`seed_default_prompts` creates
    any that don't yet exist in Langfuse.

    This function is safe to call even when Langfuse is not configured —
    it only stores the registration; no network calls are made.

    Args:
        name: Langfuse prompt name (e.g. ``"react-agent-system-prompt"``).
        default: The hardcoded prompt content (text string or chat messages).
        prompt_type: ``"text"`` or ``"chat"``.

    Example::

        from infra.prompts import register_default_prompt

        DEFAULT_SYSTEM_PROMPT = "You are a helpful assistant."
        register_default_prompt("react-agent-system-prompt", DEFAULT_SYSTEM_PROMPT)
    """
    # Deduplicate — only register a name once (first registration wins).
    existing_names = {entry[0] for entry in _registered_prompts}
    if name in existing_names:
        logger.debug("Prompt '%s' already registered — skipping duplicate", name)
        return
    _registered_prompts.append((name, default, prompt_type))
    logger.debug("Registered default prompt: name=%s type=%s", name, prompt_type)


def seed_default_prompts() -> int:
    """Create any missing prompts in Langfuse from registered defaults.

    Call this once at application startup, **after** :func:`initialize_langfuse`
    has succeeded.  It is idempotent — prompts that already exist in
    Langfuse are skipped (no new versions created).

    Returns:
        The number of prompts that were created (0 if all already exist
        or Langfuse is not enabled).

    Example::

        # In server/app.py startup handler:
        if initialize_langfuse():
            from infra.prompts import seed_default_prompts
            created = seed_default_prompts()
            logger.info("Seeded %d prompt(s) in Langfuse", created)
    """
    if not is_langfuse_enabled():
        logger.debug("seed_default_prompts: Langfuse not enabled — skipping")
        return 0

    if not _registered_prompts:
        logger.debug("seed_default_prompts: no prompts registered — nothing to seed")
        return 0

    try:
        from langfuse import get_client

        client = get_client()
    except Exception:
        logger.warning(
            "seed_default_prompts: failed to get Langfuse client",
            exc_info=True,
        )
        return 0

    created_count = 0

    for name, default_content, prompt_type in _registered_prompts:
        try:
            # Probe whether the prompt exists by fetching with a fallback.
            # cache_ttl_seconds=0 ensures we get a fresh answer, not a
            # stale cache entry from a previous startup.
            existing = client.get_prompt(
                name,
                fallback=default_content,
                type=prompt_type,
                cache_ttl_seconds=0,
            )

            if getattr(existing, "is_fallback", False):
                # Prompt does not exist in Langfuse yet — create it.
                client.create_prompt(
                    name=name,
                    type=prompt_type,
                    prompt=default_content,
                    labels=["production"],
                )
                created_count += 1
                logger.info("Seeded Langfuse prompt: %s (type=%s)", name, prompt_type)
            else:
                logger.debug(
                    "Langfuse prompt already exists: %s (version=%s)",
                    name,
                    getattr(existing, "version", "?"),
                )

        except Exception:
            # Non-fatal — failing to seed a prompt should not break startup.
            logger.warning(
                "seed_default_prompts: failed to seed '%s'",
                name,
                exc_info=True,
            )

    return created_count


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

# Matches Langfuse-style {{variable}} placeholders.
_VARIABLE_PATTERN = re.compile(r"\{\{(\w+)\}\}")

_DEFAULT_CACHE_TTL_SECONDS = 300


def _get_default_cache_ttl() -> int:
    """Read the global cache TTL from the environment, or use the default."""
    raw = os.environ.get("LANGFUSE_PROMPT_CACHE_TTL")
    if raw is not None:
        try:
            return int(raw)
        except ValueError:
            logger.warning(
                "LANGFUSE_PROMPT_CACHE_TTL=%r is not a valid integer — "
                "using default %d",
                raw,
                _DEFAULT_CACHE_TTL_SECONDS,
            )
    return _DEFAULT_CACHE_TTL_SECONDS


def _substitute_variables_text(template: str, variables: dict[str, str]) -> str:
    """Replace ``{{key}}`` placeholders in a text string.

    Unknown placeholders are left untouched so that downstream consumers
    (e.g. LangChain ``PromptTemplate``) can still process them.
    """

    def _replacer(match: re.Match) -> str:
        key = match.group(1)
        return variables.get(key, match.group(0))

    return _VARIABLE_PATTERN.sub(_replacer, template)


def _substitute_variables_chat(
    messages: list[ChatMessage],
    variables: dict[str, str],
) -> list[ChatMessage]:
    """Replace ``{{key}}`` placeholders in every message's ``content``."""
    result: list[ChatMessage] = []
    for message in messages:
        substituted = dict(message)
        if "content" in substituted and isinstance(substituted["content"], str):
            substituted["content"] = _substitute_variables_text(
                substituted["content"], variables
            )
        result.append(substituted)
    return result


def _extract_overrides(
    name: str,
    config: RunnableConfig | None,
) -> dict[str, Any]:
    """Extract prompt overrides for *name* from the RunnableConfig.

    Returns an empty dict when no overrides are present.
    """
    if config is None:
        return {}
    configurable = config.get("configurable")
    if not isinstance(configurable, dict):
        return {}
    prompt_overrides = configurable.get("prompt_overrides")
    if not isinstance(prompt_overrides, dict):
        return {}
    entry = prompt_overrides.get(name)
    if not isinstance(entry, dict):
        return {}
    return entry


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


@overload
def get_prompt(
    name: str,
    *,
    fallback: str,
    prompt_type: Literal["text"] = ...,
    config: RunnableConfig | None = ...,
    label: str = ...,
    cache_ttl_seconds: int | None = ...,
    variables: dict[str, str] | None = ...,
) -> str: ...


@overload
def get_prompt(
    name: str,
    *,
    fallback: list[ChatMessage],
    prompt_type: Literal["chat"],
    config: RunnableConfig | None = ...,
    label: str = ...,
    cache_ttl_seconds: int | None = ...,
    variables: dict[str, str] | None = ...,
) -> list[ChatMessage]: ...


def get_prompt(
    name: str,
    *,
    fallback: str | list[ChatMessage],
    prompt_type: Literal["text", "chat"] = "text",
    config: RunnableConfig | None = None,
    label: str = "production",
    cache_ttl_seconds: int | None = None,
    variables: dict[str, str] | None = None,
) -> str | list[ChatMessage]:
    """Fetch a prompt from Langfuse, falling back to a hardcoded default.

    This is the single entry point for all prompt retrieval in the
    runtime.  It handles three scenarios transparently:

    1. **Langfuse configured and reachable** — returns the Langfuse
       prompt (possibly overridden by ``config.configurable.prompt_overrides``).
    2. **Langfuse configured but unreachable** — logs a warning and
       returns the hardcoded *fallback* (the Langfuse SDK's built-in
       fallback mechanism handles this).
    3. **Langfuse not configured** — returns the *fallback* immediately
       with no network calls.

    Args:
        name: Langfuse prompt name (e.g. ``"react-agent-system-prompt"``).
        fallback: Hardcoded default.  Must be a ``str`` for text prompts
            or a ``list[dict]`` of message dicts for chat prompts.
        prompt_type: ``"text"`` (default) or ``"chat"``.
        config: Optional ``RunnableConfig`` carrying runtime overrides in
            ``configurable.prompt_overrides``.  Supported override keys
            per prompt name:

            - ``name`` — use a different Langfuse prompt entirely
            - ``label`` — override the label (default ``"production"``)
            - ``version`` — pin to an exact version number

        label: Default Langfuse label (default ``"production"``).
        cache_ttl_seconds: Override the SDK cache TTL for this call.
            Defaults to ``LANGFUSE_PROMPT_CACHE_TTL`` env var or 300 s.
        variables: Optional ``{{key}}`` substitution values.  Applied
            via Langfuse ``compile(**variables)`` when fetched from
            Langfuse, or via regex substitution on the fallback.

    Returns:
        The compiled prompt string (text) or list of message dicts (chat).

    Example::

        # Text prompt — returns str
        system_prompt = get_prompt(
            "react-agent-system-prompt",
            fallback="You are a helpful assistant.",
            config=runnable_config,
        )

        # Chat prompt — returns list[dict]
        messages = get_prompt(
            "my-chat-prompt",
            prompt_type="chat",
            fallback=[
                {"role": "system", "content": "You are helpful."},
            ],
            variables={"user_name": "Alice"},
        )
    """
    # --- Resolve overrides from config -----------------------------------
    overrides = _extract_overrides(name, config)
    effective_name = overrides.get("name", name)
    effective_label = overrides.get("label", label)
    effective_version: int | None = overrides.get("version")

    if overrides:
        logger.debug(
            "Prompt override for '%s': effective_name=%s label=%s version=%s",
            name,
            effective_name,
            effective_label,
            effective_version,
        )

    # --- Resolve cache TTL -----------------------------------------------
    effective_ttl = (
        cache_ttl_seconds if cache_ttl_seconds is not None else _get_default_cache_ttl()
    )

    # --- Fast path: Langfuse not initialised -----------------------------
    if not is_langfuse_enabled():
        return _apply_fallback(fallback, prompt_type, variables)

    # --- Langfuse path ---------------------------------------------------
    try:
        from langfuse import get_client

        client = get_client()

        # Build kwargs for get_prompt — only pass version OR label, not both,
        # because Langfuse treats them as mutually exclusive selectors.
        get_prompt_kwargs: dict[str, Any] = {
            "cache_ttl_seconds": effective_ttl,
            "fallback": fallback,
            "type": prompt_type,
        }
        if effective_version is not None:
            get_prompt_kwargs["version"] = effective_version
        else:
            get_prompt_kwargs["label"] = effective_label

        prompt_object = client.get_prompt(effective_name, **get_prompt_kwargs)

        # Log whether we got a Langfuse prompt or the fallback
        is_fallback = getattr(prompt_object, "is_fallback", False)
        if is_fallback:
            logger.info(
                "Langfuse returned fallback for prompt '%s' "
                "(prompt may not exist yet in Langfuse)",
                effective_name,
            )
        else:
            logger.debug(
                "Langfuse prompt fetched: name=%s version=%s",
                effective_name,
                getattr(prompt_object, "version", "?"),
            )

        # Compile with variables (or without)
        compile_kwargs = variables or {}
        compiled = prompt_object.compile(**compile_kwargs)
        return compiled

    except Exception:
        logger.warning(
            "Failed to fetch prompt '%s' from Langfuse — using fallback",
            effective_name,
            exc_info=True,
        )
        return _apply_fallback(fallback, prompt_type, variables)


def _apply_fallback(
    fallback: str | list[ChatMessage],
    prompt_type: Literal["text", "chat"],
    variables: dict[str, str] | None,
) -> str | list[ChatMessage]:
    """Apply variable substitution to the fallback value and return it."""
    if not variables:
        return fallback

    if prompt_type == "chat" and isinstance(fallback, list):
        return _substitute_variables_chat(fallback, variables)

    if isinstance(fallback, str):
        return _substitute_variables_text(fallback, variables)

    # Shouldn't happen if caller matches types correctly, but be safe.
    return fallback
