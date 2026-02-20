"""Pydantic models and helpers for ChromaDB RAG configuration.

The immoFlow platform passes ``rag_config`` inside
``config.configurable.rag_config`` at both assistant-level (synced via
``agent_sync``) and thread-level (per-message override).  This module
provides the models to parse that payload and a helper to extract it
from a :class:`~langchain_core.runnables.RunnableConfig`.
"""

from __future__ import annotations

from typing import Any

from langchain_core.runnables import RunnableConfig
from pydantic import BaseModel, Field


class RagArchiveConfig(BaseModel):
    """Configuration for a single ChromaDB archive (repository collection).

    Each archive maps to one ChromaDB collection that was populated by
    the DocProc pipeline.  The ``embedding_model`` must match the model
    used when the collection was created so that query embeddings live
    in the same vector space.

    Attributes:
        name: Human-readable archive name (shown in tool output).
        collection_name: ChromaDB collection name (format: ``repo_{uuid}``).
        chromadb_url: Full URL of the ChromaDB server for this archive.
        embedding_model: HuggingFace model ID used to create the
            collection vectors (must match for query embedding).
    """

    name: str = Field(description="Human-readable archive name")
    collection_name: str = Field(
        description="ChromaDB collection name (format: repo_{repository_id})",
    )
    chromadb_url: str = Field(
        default="http://chromadb:8000",
        description="ChromaDB server URL",
    )
    embedding_model: str = Field(
        default="jinaai/jina-embeddings-v2-base-de",
        description="Embedding model used to create the collection vectors",
    )


class ChromaRagConfig(BaseModel):
    """RAG configuration passed via ``config.configurable.rag_config``.

    Thread-level config **replaces** assistant-level config entirely
    (the ``archives`` list is not deep-merged — the whole array is
    swapped).  If the user disables all archives the key is omitted.

    Attributes:
        archives: List of archive configs to search.  Empty list means
            RAG is configured but no archives are active.
    """

    archives: list[RagArchiveConfig] = Field(default_factory=list)


def extract_rag_config(config: RunnableConfig) -> ChromaRagConfig | None:
    """Extract ChromaDB RAG config from a LangGraph ``RunnableConfig``.

    Looks for the ``rag_config`` key inside ``config["configurable"]``.
    Returns ``None`` when the key is absent or falsy (meaning the user
    has disabled all archives or the agent has no RAG config).

    Args:
        config: The LangGraph runnable config dict.

    Returns:
        A validated :class:`ChromaRagConfig`, or ``None`` if RAG is not
        configured for this invocation.

    Examples:
        >>> cfg = {"configurable": {"rag_config": {"archives": [
        ...     {"name": "Test", "collection_name": "repo_abc"}
        ... ]}}}
        >>> result = extract_rag_config(cfg)
        >>> result is not None
        True
        >>> len(result.archives)
        1

        >>> extract_rag_config({"configurable": {}}) is None
        True
    """
    configurable: dict[str, Any] = config.get("configurable", {}) or {}
    raw_rag_config: dict[str, Any] | None = configurable.get("rag_config")
    if not raw_rag_config:
        return None
    return ChromaRagConfig.model_validate(raw_rag_config)
