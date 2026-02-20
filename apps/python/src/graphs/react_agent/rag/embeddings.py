"""TEI (Text Embeddings Inference) client for query vectorisation.

Embeds search queries using a remote TEI server that exposes an
OpenAI-compatible ``/v1/embeddings`` endpoint.  The TEI service is
already running in the Docker stack and is GPU-accelerated — this
avoids downloading a ~500 MB model into the runtime container.

Environment variables
---------------------
``DOCPROC_TEI_EMBEDDINGS_URL``
    Base URL of the TEI server.  Defaults to ``http://tei-embeddings:8080``
    (the Docker Compose service name).

``RAG_EMBED_TIMEOUT_SECONDS``
    HTTP timeout for the embedding request.  Defaults to ``10``.
"""

from __future__ import annotations

import logging
import os

import httpx

logger = logging.getLogger(__name__)

_DEFAULT_TEI_URL = "http://tei-embeddings:8080"
_DEFAULT_TIMEOUT_SECONDS = 10.0


class EmbeddingError(Exception):
    """Raised when the TEI embedding request fails."""


def _resolve_tei_url(explicit_url: str | None = None) -> str:
    """Return the TEI base URL with priority: arg > env > default.

    Args:
        explicit_url: Caller-supplied URL (highest priority).

    Returns:
        TEI base URL without a trailing slash.
    """
    url = (
        explicit_url or os.environ.get("DOCPROC_TEI_EMBEDDINGS_URL") or _DEFAULT_TEI_URL
    )
    return url.rstrip("/")


def _resolve_timeout() -> float:
    """Return the embedding HTTP timeout in seconds from env or default."""
    raw = os.environ.get("RAG_EMBED_TIMEOUT_SECONDS")
    if raw is not None:
        try:
            return float(raw)
        except ValueError:
            logger.warning(
                "Invalid RAG_EMBED_TIMEOUT_SECONDS=%r — using default %.1f",
                raw,
                _DEFAULT_TIMEOUT_SECONDS,
            )
    return _DEFAULT_TIMEOUT_SECONDS


def embed_query(
    text: str,
    embedding_model: str,
    *,
    tei_url: str | None = None,
    timeout: float | None = None,
) -> list[float]:
    """Embed a single query string via the TEI ``/v1/embeddings`` endpoint.

    Args:
        text: The query text to embed.
        embedding_model: HuggingFace model identifier
            (e.g. ``jinaai/jina-embeddings-v2-base-de``).  Passed as the
            ``model`` field in the request body — TEI uses it to select
            the loaded model or validates it matches.
        tei_url: Explicit TEI base URL.  Falls back to
            ``DOCPROC_TEI_EMBEDDINGS_URL`` env var, then the Docker
            default ``http://tei-embeddings:8080``.
        timeout: HTTP timeout in seconds.  Falls back to
            ``RAG_EMBED_TIMEOUT_SECONDS`` env var, then ``10.0``.

    Returns:
        The embedding vector as a list of floats.

    Raises:
        EmbeddingError: If the TEI server is unreachable, returns a
            non-200 status, or the response body is malformed.

    Examples:
        >>> # With a running TEI server:
        >>> vector = embed_query(
        ...     "Wartungsplan für Heizungsanlage",
        ...     "jinaai/jina-embeddings-v2-base-de",
        ...     tei_url="http://localhost:8080",
        ... )
        >>> len(vector)  # 768 for jina-v2-base-de
        768
    """
    base_url = _resolve_tei_url(tei_url)
    effective_timeout = timeout if timeout is not None else _resolve_timeout()
    endpoint = f"{base_url}/v1/embeddings"

    request_body = {
        "model": embedding_model,
        "input": [text],
    }

    try:
        response = httpx.post(
            endpoint,
            json=request_body,
            timeout=effective_timeout,
        )
        response.raise_for_status()
    except httpx.TimeoutException as exc:
        message = (
            f"TEI embedding request timed out after {effective_timeout}s: "
            f"url={endpoint} model={embedding_model}"
        )
        logger.error(message)
        raise EmbeddingError(message) from exc
    except httpx.ConnectError as exc:
        message = f"TEI server unreachable: url={endpoint} model={embedding_model}"
        logger.error(message)
        raise EmbeddingError(message) from exc
    except httpx.HTTPStatusError as exc:
        message = (
            f"TEI embedding request failed with status {exc.response.status_code}: "
            f"url={endpoint} model={embedding_model} "
            f"body={exc.response.text[:500]}"
        )
        logger.error(message)
        raise EmbeddingError(message) from exc
    except httpx.HTTPError as exc:
        message = (
            f"TEI embedding HTTP error: url={endpoint} "
            f"model={embedding_model} error={exc}"
        )
        logger.error(message)
        raise EmbeddingError(message) from exc

    data: dict | list | str | None = response.json()
    try:
        embedding: list[float] = data["data"][0]["embedding"]  # type: ignore[index]
    except (KeyError, IndexError, TypeError) as exc:
        if isinstance(data, dict):
            response_shape = f"response_keys={list(data.keys())}"
        else:
            response_shape = f"response_type={type(data).__name__}"
        message = (
            f"Malformed TEI response — expected data[0].embedding: "
            f"url={endpoint} model={embedding_model} {response_shape}"
        )
        logger.error(message)
        raise EmbeddingError(message) from exc

    logger.debug(
        "embed_query: model=%s dimensions=%d url=%s",
        embedding_model,
        len(embedding),
        endpoint,
    )
    return embedding
