"""Configuration for the research agent graph.

Mirrors the configuration patterns established in
:pymod:`graphs.react_agent.agent` (``GraphConfigPydantic``) so that the
server can treat both graphs identically when resolving LLM, MCP tools,
and RAG collections from the assistant's ``configurable`` dict.

The research-agent-specific additions are:

- ``max_worker_iterations`` — how many ReAct steps each parallel worker
  may take before it must return whatever it has.
- ``auto_approve_phase1`` / ``auto_approve_phase2`` — skip the
  human-in-the-loop review interrupt for the respective phase.  Useful
  for automated testing and CI pipelines.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Nested config models (same shapes as react_agent)
# ---------------------------------------------------------------------------


class RagConfig(BaseModel):
    """RAG (Retrieval-Augmented Generation) tool configuration."""

    rag_url: str | None = None
    collections: list[str] = Field(default_factory=list)


class MCPServerConfig(BaseModel):
    """A single MCP server connection."""

    name: str = "default"
    url: str = ""
    auth_required: bool = False
    tools: list[str] | None = None


class MCPConfig(BaseModel):
    """MCP tool configuration — one or more remote servers."""

    servers: list[MCPServerConfig] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Main configuration
# ---------------------------------------------------------------------------


class ResearchAgentConfig(BaseModel):
    """Full configuration for a research-agent assistant.

    All fields mirror the ``configurable`` dict that the server injects
    into ``RunnableConfig`` when invoking the graph.  Unknown keys are
    silently ignored (``model_config`` allows extras).

    Attributes:
        model_name: Fully-qualified ``provider:model`` string accepted
            by :func:`langchain.chat_models.init_chat_model`.
        temperature: Sampling temperature for all LLM calls in the
            graph (analyzer, workers, aggregator).
        max_tokens: Optional hard token limit per LLM call.
        base_url: If set, routes LLM calls to this OpenAI-compatible
            endpoint instead of the standard provider.
        custom_model_name: Model name override when ``base_url`` is
            used (e.g. a vLLM deployment).
        custom_api_key: API key for the custom endpoint.
        system_prompt: Optional top-level system prompt override.
            If set and differs from the default, it is used as the
            graph's "meta-prompt" for all LLM calls.
        mcp_config: MCP server definitions — the graph resolves
            available tools from these servers at build time.
        rag: RAG tool definitions — collections to expose as tools.
        max_worker_iterations: Maximum number of ReAct reasoning
            steps each parallel worker agent may perform.  Prevents
            runaway tool-calling loops.
        auto_approve_phase1: When ``True``, the phase-1 review
            interrupt is skipped and the graph proceeds to phase 2
            automatically.  Intended for testing and CI.
        auto_approve_phase2: When ``True``, the phase-2 review
            interrupt is skipped and the graph finishes automatically.
    """

    # LLM
    model_name: str = "openai:gpt-4o-mini"
    temperature: float = 0.0
    max_tokens: int | None = None
    base_url: str | None = None
    custom_model_name: str | None = None
    custom_api_key: str | None = None

    # Optional system-prompt override (same pattern as react_agent)
    system_prompt: str | None = None

    # MCP tool servers
    mcp_config: MCPConfig | None = None

    # RAG collections
    rag: RagConfig | None = None

    # Research-agent-specific
    max_worker_iterations: int = Field(
        default=15,
        ge=1,
        le=100,
        description="Maximum ReAct steps per worker agent.",
    )
    auto_approve_phase1: bool = Field(
        default=False,
        description="Skip HIL review after phase 1 (for testing).",
    )
    auto_approve_phase2: bool = Field(
        default=False,
        description="Skip HIL review after phase 2 (for testing).",
    )

    model_config = {"extra": "ignore"}


# ---------------------------------------------------------------------------
# Helper
# ---------------------------------------------------------------------------


def parse_config(configurable: dict[str, Any] | None) -> ResearchAgentConfig:
    """Parse a ``configurable`` dict into a validated config object.

    Unknown keys are silently dropped (``extra = "ignore"``).

    Args:
        configurable: The ``config["configurable"]`` dict from a
            ``RunnableConfig``, or ``None``.

    Returns:
        A validated :class:`ResearchAgentConfig` instance.

    Example::

        cfg = parse_config(config.get("configurable"))
        model = init_chat_model(cfg.model_name, temperature=cfg.temperature)
    """
    return ResearchAgentConfig(**(configurable or {}))
