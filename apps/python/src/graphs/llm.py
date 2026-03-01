"""Shared LLM factory for agent graphs.

Provides a single ``create_chat_model()`` entry-point that both
:mod:`graphs.react_agent` and :mod:`graphs.research_agent` use to
create their chat model instances.  This eliminates ~80 lines of
duplicated LLM initialisation logic and creates a single place to
add routing features (call-time model override, semantic router
passthrough, metadata headers).

Also provides ``get_api_key_for_model()`` — a unified API-key
resolver that supports all known LLM providers and multiple
resolution sources (configurable dict, platform-injected keys,
environment variables).

Usage::

    from graphs.llm import create_chat_model

    model = create_chat_model(
        config,
        model_name=cfg.model_name,
        temperature=cfg.temperature,
        max_tokens=cfg.max_tokens,
        base_url=cfg.base_url,
        custom_model_name=cfg.custom_model_name,
        model_name_override=configurable.get("model_name_override"),
        routing_metadata={"x-sr-graph-id": "agent"},
    )
"""

from __future__ import annotations

import logging
import os

from langchain.chat_models import init_chat_model
from langchain_core.language_models import BaseChatModel
from langchain_core.runnables import RunnableConfig
from langchain_openai import ChatOpenAI

__all__ = [
    "create_chat_model",
    "get_api_key_for_model",
]

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Provider → environment variable mapping
# ---------------------------------------------------------------------------

_PROVIDER_ENV_MAP: dict[str, str] = {
    "openai": "OPENAI_API_KEY",
    "anthropic": "ANTHROPIC_API_KEY",
    "google": "GOOGLE_API_KEY",
    "mistral": "MISTRAL_API_KEY",
    "groq": "GROQ_API_KEY",
    "fireworks": "FIREWORKS_API_KEY",
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _safe_mask_url(url: str | None) -> str | None:
    """Strip query strings and fragments from a URL for safe logging.

    Keeps scheme, host, and path — enough to confirm routing without
    leaking tokens that might appear in query parameters.
    """
    if not url:
        return url
    return url.split("?", 1)[0].split("#", 1)[0]


# ---------------------------------------------------------------------------
# API key resolution
# ---------------------------------------------------------------------------


def get_api_key_for_model(model_name: str, config: RunnableConfig) -> str | None:
    """Resolve an API key for the given model provider.

    Resolution order:

    * **Custom endpoints** (``model_name`` starts with ``"custom:"``):

      1. ``configurable.custom_api_key`` (user-provided via assistant UI)
      2. ``CUSTOM_API_KEY`` environment variable
      3. ``OPENAI_API_KEY`` environment variable (common for
         OpenAI-compatible endpoints like vLLM)

    * **Standard providers** (``openai:``, ``anthropic:``, etc.):

      1. ``configurable.apiKeys[ENV_VAR_NAME]`` (platform-injected)
      2. Provider-specific environment variable (e.g. ``OPENAI_API_KEY``)

    Args:
        model_name: Fully-qualified ``provider:model`` string
            (e.g. ``"openai:gpt-4o"``) or ``"custom:"`` for custom
            endpoints.
        config: ``RunnableConfig`` whose ``configurable`` dict may
            contain ``custom_api_key`` or ``apiKeys``.

    Returns:
        The resolved API key string, or ``None`` if no key could be
        found for the provider.
    """
    model_name_lower = model_name.lower()
    configurable: dict = config.get("configurable", {}) or {}

    # --- Custom endpoint ---------------------------------------------------
    if model_name_lower.startswith("custom:"):
        custom_key = configurable.get("custom_api_key")
        if custom_key:
            return custom_key
        return os.environ.get("CUSTOM_API_KEY") or os.environ.get("OPENAI_API_KEY")

    # --- Standard provider -------------------------------------------------
    provider = (
        model_name_lower.split(":")[0] if ":" in model_name_lower else model_name_lower
    )

    env_var_name = _PROVIDER_ENV_MAP.get(provider)
    if not env_var_name:
        return None

    # Check platform-injected keys first (configurable.apiKeys)
    api_keys = configurable.get("apiKeys")
    if isinstance(api_keys, dict):
        platform_key = api_keys.get(env_var_name)
        if platform_key and str(platform_key):
            return str(platform_key)

    # Fallback to environment variable
    return os.environ.get(env_var_name)


# ---------------------------------------------------------------------------
# LLM factory
# ---------------------------------------------------------------------------


def create_chat_model(
    config: RunnableConfig,
    *,
    model_name: str,
    temperature: float = 0.7,
    max_tokens: int | None = None,
    base_url: str | None = None,
    custom_model_name: str | None = None,
    model_name_override: str | None = None,
    routing_metadata: dict[str, str] | None = None,
) -> BaseChatModel:
    """Create a chat model instance from configuration.

    Handles two paths transparently:

    1. **Custom endpoint** (``base_url`` is set) — creates a
       :class:`~langchain_openai.ChatOpenAI` with
       ``openai_api_base`` pointed at the given URL.  This covers
       vLLM, Ollama, LiteLLM, and the semantic router proxy.
    2. **Standard provider** (no ``base_url``) — delegates to
       :func:`~langchain.chat_models.init_chat_model` which selects
       the correct model class from the ``provider:model`` string.

    API keys are resolved internally via :func:`get_api_key_for_model`.

    Model resolution order:

    1. ``model_name_override`` (run-time, per-invocation)
    2. ``custom_model_name`` (assistant-level, for custom endpoints)
    3. ``model_name`` (assistant-level default)

    When ``SEMANTIC_ROUTER_ENABLED=true``, ``base_url`` and the
    effective model are transparently overridden to route all LLM
    calls through the semantic router proxy.

    Args:
        config: ``RunnableConfig`` with the ``configurable`` dict
            that may contain ``custom_api_key`` and ``apiKeys``.
        model_name: Fully-qualified ``provider:model`` string
            (e.g. ``"openai:gpt-4o"``).
        temperature: Sampling temperature for generation.
        max_tokens: Optional hard token limit per LLM call.
        base_url: If set, routes calls to this OpenAI-compatible
            endpoint instead of the standard provider.
        custom_model_name: Model name override for custom endpoints
            (e.g. ``"ministral-3b-instruct"``).  Falls back to
            *model_name* if ``None``.
        model_name_override: Explicit per-invocation model override.
            Takes highest precedence in model resolution.  Typically
            set via ``configurable.model_name_override`` at
            ``runs.create()`` time, or injected by the semantic
            router env-var logic.
        routing_metadata: Optional dict of HTTP headers to forward
            to the model endpoint (e.g. ``{"x-sr-org-id": "acme"}``).
            Passed as ``default_headers`` to the model constructor.
            Only non-empty string values are included.

    Returns:
        A :class:`~langchain_core.language_models.BaseChatModel`
        instance ready for use in agent graphs.
    """
    # --- Semantic router env-var override ----------------------------------
    # When SEMANTIC_ROUTER_ENABLED=true, route LLM calls through the
    # semantic router proxy — unless the agent explicitly pins a model
    # or a custom endpoint.
    #
    # Override rules:
    #   - If the agent already has a ``base_url`` (custom vLLM, Ollama,
    #     etc.), the router does NOT hijack it.  The agent talks to its
    #     own backend directly.
    #   - If ``model_name_override`` is set by the caller (call-time
    #     pin), it is sent to the router as-is (explicit model, not
    #     "MoM").  The router passes it through without reclassifying.
    #   - If ``custom_model_name`` is set on the assistant (creation-time
    #     pin), same treatment: explicit model through the router.
    #   - Only when NO pin exists does the router inject "MoM" for
    #     dynamic classification.
    router_enabled = os.getenv("SEMANTIC_ROUTER_ENABLED", "false").lower() == "true"
    if router_enabled:
        router_url = os.getenv("SEMANTIC_ROUTER_URL")
        router_model = os.getenv("SEMANTIC_ROUTER_MODEL", "MoM")
        if router_url:
            if base_url:
                # Agent already has a custom endpoint — don't override.
                # The agent talks directly to its own backend (vLLM,
                # Ollama, LiteLLM, etc.) and skips the router entirely.
                logger.info(
                    "Semantic router: SKIPPING — agent has custom base_url=%s",
                    _safe_mask_url(base_url),
                )
            else:
                # No custom endpoint — route through the semantic router.
                base_url = router_url

                if model_name_override:
                    # Caller pinned a model at call time — send it to the
                    # router as an explicit model (router passes through).
                    logger.info(
                        "Semantic router: using caller override model=%s "
                        "through %s (passthrough, no reclassification)",
                        model_name_override,
                        _safe_mask_url(router_url),
                    )
                elif custom_model_name:
                    # Agent has a pinned model at creation time — same
                    # treatment: explicit model through the router.
                    logger.info(
                        "Semantic router: using agent-pinned model=%s "
                        "through %s (passthrough, no reclassification)",
                        custom_model_name,
                        _safe_mask_url(router_url),
                    )
                else:
                    # No pin — let the router classify dynamically.
                    model_name_override = router_model
                    logger.info(
                        "Semantic router: dynamic routing through %s (model=%s)",
                        _safe_mask_url(router_url),
                        router_model,
                    )
        else:
            logger.warning(
                "SEMANTIC_ROUTER_ENABLED=true but SEMANTIC_ROUTER_URL is not set; "
                "ignoring router mode"
            )

    # --- Resolve effective model name -------------------------------------
    # Treat empty strings as None for override.
    effective_override = model_name_override if model_name_override else None
    effective_model = effective_override or custom_model_name or model_name

    if effective_override and effective_override != model_name:
        logger.info(
            "LLM model override active: %s -> %s",
            model_name,
            effective_override,
        )

    # --- Build default_headers from routing_metadata ----------------------
    default_headers: dict[str, str] = {}
    if routing_metadata:
        default_headers = {
            key: value
            for key, value in routing_metadata.items()
            if isinstance(value, str) and value
        }
        if default_headers:
            logger.info(
                "LLM routing metadata: %s",
                list(default_headers.keys()),
            )

    # --- Create model instance --------------------------------------------
    if base_url:
        return _create_custom_endpoint_model(
            config,
            base_url=base_url,
            model_name=model_name,
            effective_model=effective_model,
            temperature=temperature,
            max_tokens=max_tokens,
            default_headers=default_headers,
        )

    return _create_standard_provider_model(
        config,
        model_name=effective_model,
        temperature=temperature,
        max_tokens=max_tokens,
        default_headers=default_headers,
    )


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _create_custom_endpoint_model(
    config: RunnableConfig,
    *,
    base_url: str,
    model_name: str,
    effective_model: str,
    temperature: float,
    max_tokens: int | None,
    default_headers: dict[str, str] | None = None,
) -> BaseChatModel:
    """Create a ChatOpenAI instance targeting a custom OpenAI-compatible endpoint."""
    masked_base_url = _safe_mask_url(base_url)
    logger.info("LLM routing: custom endpoint; base_url=%s", masked_base_url)

    api_key = get_api_key_for_model("custom:", config)
    if not api_key:
        # Use "EMPTY" for local endpoints (e.g. vLLM) that don't
        # require authentication.
        api_key = "EMPTY"
        logger.info("LLM auth: no custom API key provided; using EMPTY")
    else:
        logger.info("LLM auth: custom API key provided (masked)")

    logger.info("LLM model: %s", effective_model)

    kwargs: dict = {
        "openai_api_base": base_url,
        "openai_api_key": api_key,
        "model": effective_model,
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    if default_headers:
        kwargs["default_headers"] = default_headers

    return ChatOpenAI(**kwargs)


def _create_standard_provider_model(
    config: RunnableConfig,
    *,
    model_name: str,
    temperature: float,
    max_tokens: int | None,
    default_headers: dict[str, str] | None = None,
) -> BaseChatModel:
    """Create a model via init_chat_model for a standard cloud provider."""
    logger.info("LLM routing: standard provider; model_name=%s", model_name)

    api_key = get_api_key_for_model(model_name, config)
    logger.info("LLM auth: api key present=%s", bool(api_key))

    kwargs: dict = {
        "temperature": temperature,
        "max_tokens": max_tokens,
        "api_key": api_key or "No token found",
    }
    if default_headers:
        kwargs["default_headers"] = default_headers

    return init_chat_model(model_name, **kwargs)
