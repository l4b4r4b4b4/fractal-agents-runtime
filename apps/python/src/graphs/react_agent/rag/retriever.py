"""ChromaDB archive search tool factory.

Creates a ``search_archives`` LangGraph tool that queries ChromaDB
collections configured via ``rag_config``.  Uses the **slim**
``chromadb-client`` package (HTTP-only — no server dependencies).

The tool is registered dynamically when ``rag_config`` is present in
the agent's configurable and has at least one archive.  The agent
decides when to invoke the tool based on the user's question.
"""

from __future__ import annotations

import logging
import os
from typing import Any
from urllib.parse import urlparse

import chromadb
from langchain_core.tools import StructuredTool

from graphs.react_agent.rag.config import ChromaRagConfig, RagArchiveConfig
from graphs.react_agent.rag.embeddings import EmbeddingError, embed_query

logger = logging.getLogger(__name__)

_DEFAULT_TOP_K = 5
_MAX_TOP_K = 20
_DEFAULT_LAYER = "chunk"
_DEFAULT_QUERY_TIMEOUT_SECONDS = 5.0


# ---------------------------------------------------------------------------
# URL parsing helpers
# ---------------------------------------------------------------------------


def _parse_host(url: str) -> str:
    """Extract hostname from a URL string.

    Args:
        url: Full URL (e.g. ``http://chromadb:8000``).

    Returns:
        The hostname component, defaulting to ``"localhost"``.
    """
    parsed = urlparse(url)
    return parsed.hostname or "localhost"


def _parse_port(url: str) -> int:
    """Extract port from a URL string, defaulting to 8000.

    Args:
        url: Full URL (e.g. ``http://chromadb:8000``).

    Returns:
        The port number, defaulting to ``8000``.
    """
    parsed = urlparse(url)
    return parsed.port or 8000


def _uses_ssl(url: str) -> bool:
    """Return True if the URL uses HTTPS."""
    parsed = urlparse(url)
    return parsed.scheme == "https"


# ---------------------------------------------------------------------------
# Environment helpers
# ---------------------------------------------------------------------------


def _resolve_default_top_k() -> int:
    """Resolve the default ``top_k`` from env or built-in default."""
    raw = os.environ.get("RAG_DEFAULT_TOP_K")
    if raw is not None:
        try:
            return max(1, min(int(raw), _MAX_TOP_K))
        except ValueError:
            logger.warning(
                "Invalid RAG_DEFAULT_TOP_K=%r — using default %d",
                raw,
                _DEFAULT_TOP_K,
            )
    return _DEFAULT_TOP_K


def _resolve_default_layer() -> str:
    """Resolve the default layer filter from env or built-in default."""
    return os.environ.get("RAG_DEFAULT_LAYER", _DEFAULT_LAYER)


def _resolve_chromadb_url(archive_url: str | None) -> str:
    """Resolve ChromaDB URL with priority: archive config > env > default.

    Args:
        archive_url: Per-archive URL from the ``rag_config`` payload.

    Returns:
        ChromaDB base URL.
    """
    return (
        archive_url or os.environ.get("DOCPROC_CHROMADB_URL") or "http://chromadb:8000"
    )


# ---------------------------------------------------------------------------
# ChromaDB client initialisation
# ---------------------------------------------------------------------------

_ArchiveClient = tuple[RagArchiveConfig, "chromadb.Collection"]


def _init_archive_clients(
    archives: list[RagArchiveConfig],
) -> list[_ArchiveClient]:
    """Pre-initialise ChromaDB ``HttpClient`` + ``Collection`` per archive.

    Archives whose ChromaDB server is unreachable or whose collection
    does not exist are **skipped** with a warning (graceful degradation).

    Args:
        archives: List of archive configurations from ``rag_config``.

    Returns:
        List of ``(archive_config, collection)`` tuples for reachable
        archives.
    """
    archive_clients: list[_ArchiveClient] = []

    for archive in archives:
        chromadb_url = _resolve_chromadb_url(archive.chromadb_url)
        host = _parse_host(chromadb_url)
        port = _parse_port(chromadb_url)
        ssl = _uses_ssl(chromadb_url)

        try:
            client = chromadb.HttpClient(host=host, port=port, ssl=ssl)
            collection = client.get_collection(name=archive.collection_name)
            archive_clients.append((archive, collection))
            logger.info(
                "ChromaDB archive connected: name=%s collection=%s url=%s",
                archive.name,
                archive.collection_name,
                chromadb_url,
            )
        except Exception as exc:
            logger.warning(
                "Skipping archive %s (collection=%s, url=%s): %s",
                archive.name,
                archive.collection_name,
                chromadb_url,
                exc,
            )

    return archive_clients


# ---------------------------------------------------------------------------
# Result formatting
# ---------------------------------------------------------------------------


def _format_results(
    results: list[dict[str, Any]],
    top_k: int,
) -> str:
    """Format search results into a human-readable string for the LLM.

    Args:
        results: List of result dicts sorted by distance (ascending).
        top_k: Maximum number of results to include.

    Returns:
        Formatted string with archive name, metadata, and document text.
    """
    if not results:
        return "Keine relevanten Dokumente gefunden."

    formatted_parts: list[str] = []
    for index, result in enumerate(results[:top_k], 1):
        metadata: dict[str, Any] = result.get("metadata") or {}
        source_info: list[str] = []

        if metadata.get("layer"):
            source_info.append(f"Ebene: {metadata['layer']}")
        if metadata.get("page_number"):
            source_info.append(f"Seite: {metadata['page_number']}")
        if metadata.get("section_heading"):
            source_info.append(f"Abschnitt: {metadata['section_heading']}")

        header = f"[{index}] Archiv: {result['archive']}"
        if source_info:
            header += f" ({', '.join(source_info)})"

        formatted_parts.append(f"{header}\n{result['text']}")

    return "\n\n---\n\n".join(formatted_parts)


# ---------------------------------------------------------------------------
# Tool factory
# ---------------------------------------------------------------------------


def create_archive_search_tool(
    rag_config: ChromaRagConfig,
) -> StructuredTool | None:
    """Create a ``search_archives`` tool bound to the session's archives.

    Connects to each archive's ChromaDB collection at tool-creation time.
    Archives that are unreachable or whose collection does not exist are
    silently skipped.  If **no** archives are reachable, returns ``None``
    (the caller should not register a broken tool).

    Args:
        rag_config: The parsed ``ChromaRagConfig`` containing the list
            of archive configurations.

    Returns:
        A :class:`~langchain_core.tools.StructuredTool` instance, or
        ``None`` if no archives could be initialised.

    Examples:
        >>> from graphs.react_agent.rag.config import ChromaRagConfig
        >>> config = ChromaRagConfig(archives=[...])
        >>> tool = create_archive_search_tool(config)
        >>> if tool:
        ...     # register with agent
        ...     tools.append(tool)
    """
    if not rag_config.archives:
        logger.debug("create_archive_search_tool: no archives configured")
        return None

    archive_clients = _init_archive_clients(rag_config.archives)

    if not archive_clients:
        logger.warning(
            "create_archive_search_tool: all %d archives failed to initialise",
            len(rag_config.archives),
        )
        return None

    default_top_k = _resolve_default_top_k()
    default_layer = _resolve_default_layer()

    # Use the first archive's embedding model as the reference for query
    # embedding.  All archives in a single rag_config are expected to use
    # the same embedding model (the platform enforces this).
    reference_embedding_model = archive_clients[0][0].embedding_model

    def search_archives(query: str, top_k: int = default_top_k) -> str:
        """Search the user's document archives for relevant content.

        Use this tool when the user asks about documents, policies,
        reports, maintenance records, or any information that might be
        stored in their document archives.

        Args:
            query: Search query — rephrase the user's question for
                semantic search.
            top_k: Number of results per archive (default 5, max 20).

        Returns:
            Formatted search results with archive names and metadata,
            or a message indicating no results were found.
        """
        top_k = max(1, min(top_k, _MAX_TOP_K))

        # Embed the query
        try:
            query_embedding = embed_query(
                text=query,
                embedding_model=reference_embedding_model,
            )
        except EmbeddingError as exc:
            logger.error("Archive search embedding failed: %s", exc)
            return "Archivsuche fehlgeschlagen — Embedding-Service nicht erreichbar."

        all_results: list[dict[str, Any]] = []

        for archive_config, collection in archive_clients:
            try:
                query_kwargs: dict[str, Any] = {
                    "query_embeddings": [query_embedding],
                    "n_results": top_k,
                    "include": ["documents", "metadatas", "distances"],
                }

                # Apply layer filter if the default layer is set
                if default_layer:
                    query_kwargs["where"] = {"layer": default_layer}

                results = collection.query(**query_kwargs)

                documents: list[str] = (results.get("documents") or [[]])[0] or []  # type: ignore[index]
                metadatas: list[dict[str, Any]] = (results.get("metadatas") or [[]])[
                    0
                ] or []  # type: ignore[index]
                distances: list[float] = (results.get("distances") or [[]])[0] or []  # type: ignore[index]

                for document, metadata, distance in zip(
                    documents, metadatas, distances
                ):
                    all_results.append(
                        {
                            "archive": archive_config.name,
                            "text": document,
                            "metadata": metadata or {},
                            "distance": distance,
                        }
                    )
            except Exception as exc:
                logger.warning(
                    "Archive search failed for %s (collection=%s): %s",
                    archive_config.name,
                    archive_config.collection_name,
                    exc,
                )

        if not all_results:
            return "Keine relevanten Dokumente gefunden."

        # Sort by distance (lower = more similar for cosine distance)
        all_results.sort(key=lambda result: result["distance"])

        return _format_results(all_results, top_k)

    return StructuredTool.from_function(
        func=search_archives,
        name="search_archives",
        description=(
            "Search the user's document archives for relevant content. "
            "Use this tool when the user asks about documents, policies, "
            "reports, maintenance records, or any information that might "
            "be stored in their document archives. Rephrase the user's "
            "question into a semantic search query."
        ),
    )
