"""Shared configuration models for agent graphs.

Provides Pydantic models used by both :mod:`graphs.react_agent` and
:mod:`graphs.research_agent` for MCP tool server and RAG collection
configuration.  Centralising these avoids ~45 lines of duplication
and ensures both graphs validate identically.

These models describe the *shape* of the ``configurable`` sub-dicts
that the platform injects into ``RunnableConfig`` at invocation time.
Agent-specific configuration (UI metadata, graph-specific fields)
stays in the respective agent modules.

Usage::

    from graphs.configuration import MCPConfig, MCPServerConfig, RagConfig

    class MyAgentConfig(BaseModel):
        mcp_config: MCPConfig | None = None
        rag: RagConfig | None = None
        ...
"""

from __future__ import annotations

from pydantic import BaseModel, Field

__all__ = [
    "MCPConfig",
    "MCPServerConfig",
    "RagConfig",
]


class RagConfig(BaseModel):
    """RAG (Retrieval-Augmented Generation) tool configuration.

    Attributes:
        rag_url: Base URL of the RAG server that provides collection
            search endpoints.
        collections: List of collection identifiers to expose as
            retrieval tools.  ``None`` means no RAG tools are
            configured.
    """

    rag_url: str | None = None
    collections: list[str] | None = None


class MCPServerConfig(BaseModel):
    """Configuration for a single MCP tool server connection.

    Each entry maps to one upstream MCP server that the agent can
    call for tool execution.

    Attributes:
        name: Stable identifier for this server entry.  Used as the
            key when building the ``MultiServerMCPClient`` config dict.
        url: Base URL for the MCP server (may or may not end with
            ``/mcp``; the graph factory appends it if missing).
        tools: Optional allowlist of tool names to expose from this
            server.  ``None`` means expose all discovered tools.
        auth_required: Whether this server requires an OAuth bearer
            token obtained via the platform's token exchange flow.
    """

    name: str = Field(default="default")
    url: str
    tools: list[str] | None = Field(default=None)
    auth_required: bool = Field(default=False)


class MCPConfig(BaseModel):
    """MCP tool configuration — one or more remote servers.

    Attributes:
        servers: List of MCP server connection definitions.  An empty
            list means no MCP tools are available.
    """

    servers: list[MCPServerConfig] = Field(default_factory=list)
