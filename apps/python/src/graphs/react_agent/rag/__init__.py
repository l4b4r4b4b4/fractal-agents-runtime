"""ChromaDB RAG retriever — runtime-side archive search for LangGraph agents.

This package provides:

- **Config models** for parsing ``rag_config`` from ``config.configurable``
- **Embedding client** for query vectorisation via TEI
- **Retriever tool factory** that creates a ``search_archives`` LangGraph tool

Usage::

    from graphs.react_agent.rag import (
        ChromaRagConfig,
        RagArchiveConfig,
        create_archive_search_tool,
        extract_rag_config,
    )

    rag_config = extract_rag_config(runnable_config)
    if rag_config and rag_config.archives:
        tool = create_archive_search_tool(rag_config)
"""

from graphs.react_agent.rag.config import (
    ChromaRagConfig,
    RagArchiveConfig,
    extract_rag_config,
)
from graphs.react_agent.rag.retriever import create_archive_search_tool

__all__ = [
    "ChromaRagConfig",
    "RagArchiveConfig",
    "create_archive_search_tool",
    "extract_rag_config",
]
