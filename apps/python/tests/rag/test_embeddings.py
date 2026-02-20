"""Unit tests for the TEI embedding client.

Tests :func:`embed_query`, :func:`_resolve_tei_url`, and
:func:`_resolve_timeout` — the HTTP client that calls the TEI
``/v1/embeddings`` endpoint for query vectorisation.

All HTTP calls are mocked via ``unittest.mock.patch`` on ``httpx.post``
so no real TEI server is required.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import httpx
import pytest

from graphs.react_agent.rag.embeddings import (
    EmbeddingError,
    _resolve_tei_url,
    _resolve_timeout,
    embed_query,
)

_EMBEDDING_MODEL = "jinaai/jina-embeddings-v2-base-de"
_EMBEDDING_DIM = 768
_DEFAULT_TEI_URL = "http://tei-embeddings:8080"


def _make_embedding_response(
    embedding: list[float] | None = None,
    dimensions: int = _EMBEDDING_DIM,
) -> dict:
    """Build a TEI-compatible /v1/embeddings JSON response body."""
    if embedding is None:
        embedding = [0.1] * dimensions
    return {
        "object": "list",
        "data": [
            {
                "object": "embedding",
                "index": 0,
                "embedding": embedding,
            }
        ],
        "model": _EMBEDDING_MODEL,
        "usage": {"prompt_tokens": 5, "total_tokens": 5},
    }


def _make_mock_response(
    status_code: int = 200,
    json_body: dict | None = None,
) -> MagicMock:
    """Create a mock httpx.Response with the given status and JSON body."""
    response = MagicMock(spec=httpx.Response)
    response.status_code = status_code
    response.json.return_value = json_body or _make_embedding_response()
    response.text = '{"detail": "mock error"}'

    if status_code >= 400:
        http_error = httpx.HTTPStatusError(
            message=f"Server error {status_code}",
            request=MagicMock(spec=httpx.Request),
            response=response,
        )
        response.raise_for_status.side_effect = http_error
    else:
        response.raise_for_status.return_value = None

    return response


# ---------------------------------------------------------------------------
# _resolve_tei_url() tests
# ---------------------------------------------------------------------------


class TestResolveTeiUrl:
    """Tests for _resolve_tei_url priority: explicit > env > default."""

    def test_explicit_url_wins(self) -> None:
        result = _resolve_tei_url("http://my-tei:9999")
        assert result == "http://my-tei:9999"

    def test_explicit_url_strips_trailing_slash(self) -> None:
        result = _resolve_tei_url("http://my-tei:9999/")
        assert result == "http://my-tei:9999"

    @patch.dict("os.environ", {"DOCPROC_TEI_EMBEDDINGS_URL": "http://env-tei:7777"})
    def test_env_fallback(self) -> None:
        result = _resolve_tei_url(None)
        assert result == "http://env-tei:7777"

    @patch.dict("os.environ", {"DOCPROC_TEI_EMBEDDINGS_URL": "http://env-tei:7777"})
    def test_explicit_beats_env(self) -> None:
        result = _resolve_tei_url("http://explicit:1111")
        assert result == "http://explicit:1111"

    @patch.dict("os.environ", {}, clear=True)
    def test_default_when_no_env(self) -> None:
        result = _resolve_tei_url(None)
        assert result == _DEFAULT_TEI_URL

    def test_empty_string_falls_through(self) -> None:
        """Empty string is falsy — should fall through to env/default."""
        result = _resolve_tei_url("")
        # Empty string is falsy, so it falls to env or default
        assert result  # Should be a non-empty URL


# ---------------------------------------------------------------------------
# _resolve_timeout() tests
# ---------------------------------------------------------------------------


class TestResolveTimeout:
    """Tests for _resolve_timeout from env or default."""

    @patch.dict("os.environ", {}, clear=True)
    def test_default_timeout(self) -> None:
        result = _resolve_timeout()
        assert result == 10.0

    @patch.dict("os.environ", {"RAG_EMBED_TIMEOUT_SECONDS": "30"})
    def test_env_timeout(self) -> None:
        result = _resolve_timeout()
        assert result == 30.0

    @patch.dict("os.environ", {"RAG_EMBED_TIMEOUT_SECONDS": "5.5"})
    def test_env_float_timeout(self) -> None:
        result = _resolve_timeout()
        assert result == 5.5

    @patch.dict("os.environ", {"RAG_EMBED_TIMEOUT_SECONDS": "not_a_number"})
    def test_invalid_env_timeout_falls_back_to_default(self) -> None:
        result = _resolve_timeout()
        assert result == 10.0


# ---------------------------------------------------------------------------
# embed_query() — happy path
# ---------------------------------------------------------------------------


class TestEmbedQuerySuccess:
    """Tests for embed_query() when TEI responds successfully."""

    @patch("graphs.react_agent.rag.embeddings.httpx.post")
    def test_returns_embedding_vector(self, mock_post: MagicMock) -> None:
        expected_embedding = [0.5] * _EMBEDDING_DIM
        mock_post.return_value = _make_mock_response(
            json_body=_make_embedding_response(embedding=expected_embedding),
        )

        result = embed_query(
            "Wartungsplan für Heizung",
            _EMBEDDING_MODEL,
            tei_url="http://tei:8080",
        )

        assert result == expected_embedding
        assert len(result) == _EMBEDDING_DIM

    @patch("graphs.react_agent.rag.embeddings.httpx.post")
    def test_sends_correct_request_body(self, mock_post: MagicMock) -> None:
        mock_post.return_value = _make_mock_response()

        embed_query(
            "test query",
            "custom/model",
            tei_url="http://tei:8080",
            timeout=15.0,
        )

        mock_post.assert_called_once_with(
            "http://tei:8080/v1/embeddings",
            json={
                "model": "custom/model",
                "input": ["test query"],
            },
            timeout=15.0,
        )

    @patch("graphs.react_agent.rag.embeddings.httpx.post")
    def test_trailing_slash_stripped_from_url(self, mock_post: MagicMock) -> None:
        mock_post.return_value = _make_mock_response()

        embed_query(
            "query",
            _EMBEDDING_MODEL,
            tei_url="http://tei:8080/",
        )

        call_url = mock_post.call_args[0][0]
        assert call_url == "http://tei:8080/v1/embeddings"
        assert "//" not in call_url.split("://")[1]

    @patch("graphs.react_agent.rag.embeddings.httpx.post")
    @patch.dict("os.environ", {"DOCPROC_TEI_EMBEDDINGS_URL": "http://env-tei:7777"})
    def test_env_url_used_when_no_explicit(self, mock_post: MagicMock) -> None:
        mock_post.return_value = _make_mock_response()

        embed_query("query", _EMBEDDING_MODEL)

        call_url = mock_post.call_args[0][0]
        assert call_url == "http://env-tei:7777/v1/embeddings"

    @patch("graphs.react_agent.rag.embeddings.httpx.post")
    def test_explicit_timeout_overrides_env(self, mock_post: MagicMock) -> None:
        mock_post.return_value = _make_mock_response()

        embed_query(
            "query",
            _EMBEDDING_MODEL,
            tei_url="http://tei:8080",
            timeout=42.0,
        )

        assert mock_post.call_args[1]["timeout"] == 42.0

    @patch("graphs.react_agent.rag.embeddings.httpx.post")
    @patch.dict("os.environ", {"RAG_EMBED_TIMEOUT_SECONDS": "25"})
    def test_env_timeout_used_when_no_explicit(self, mock_post: MagicMock) -> None:
        mock_post.return_value = _make_mock_response()

        embed_query(
            "query",
            _EMBEDDING_MODEL,
            tei_url="http://tei:8080",
        )

        assert mock_post.call_args[1]["timeout"] == 25.0

    @patch("graphs.react_agent.rag.embeddings.httpx.post")
    def test_returns_different_dimension_embedding(self, mock_post: MagicMock) -> None:
        """The function should return whatever dimension TEI provides."""
        small_embedding = [0.1, 0.2, 0.3]
        mock_post.return_value = _make_mock_response(
            json_body=_make_embedding_response(embedding=small_embedding),
        )

        result = embed_query(
            "query",
            _EMBEDDING_MODEL,
            tei_url="http://tei:8080",
        )

        assert result == small_embedding
        assert len(result) == 3


# ---------------------------------------------------------------------------
# embed_query() — error paths
# ---------------------------------------------------------------------------


class TestEmbedQueryErrors:
    """Tests for embed_query() when TEI is unavailable or returns errors."""

    @patch("graphs.react_agent.rag.embeddings.httpx.post")
    def test_timeout_raises_embedding_error(self, mock_post: MagicMock) -> None:
        mock_post.side_effect = httpx.TimeoutException("Connection timed out")

        with pytest.raises(EmbeddingError, match="timed out"):
            embed_query(
                "query",
                _EMBEDDING_MODEL,
                tei_url="http://tei:8080",
                timeout=1.0,
            )

    @patch("graphs.react_agent.rag.embeddings.httpx.post")
    def test_connect_error_raises_embedding_error(self, mock_post: MagicMock) -> None:
        mock_post.side_effect = httpx.ConnectError("Connection refused")

        with pytest.raises(EmbeddingError, match="unreachable"):
            embed_query(
                "query",
                _EMBEDDING_MODEL,
                tei_url="http://tei:8080",
            )

    @patch("graphs.react_agent.rag.embeddings.httpx.post")
    def test_http_500_raises_embedding_error(self, mock_post: MagicMock) -> None:
        mock_post.return_value = _make_mock_response(status_code=500)

        with pytest.raises(EmbeddingError, match="status 500"):
            embed_query(
                "query",
                _EMBEDDING_MODEL,
                tei_url="http://tei:8080",
            )

    @patch("graphs.react_agent.rag.embeddings.httpx.post")
    def test_http_422_raises_embedding_error(self, mock_post: MagicMock) -> None:
        mock_post.return_value = _make_mock_response(status_code=422)

        with pytest.raises(EmbeddingError, match="status 422"):
            embed_query(
                "query",
                _EMBEDDING_MODEL,
                tei_url="http://tei:8080",
            )

    @patch("graphs.react_agent.rag.embeddings.httpx.post")
    def test_generic_http_error_raises_embedding_error(
        self, mock_post: MagicMock
    ) -> None:
        mock_post.side_effect = httpx.HTTPError("Some low-level error")

        with pytest.raises(EmbeddingError, match="HTTP error"):
            embed_query(
                "query",
                _EMBEDDING_MODEL,
                tei_url="http://tei:8080",
            )

    @patch("graphs.react_agent.rag.embeddings.httpx.post")
    def test_malformed_response_missing_data_key(self, mock_post: MagicMock) -> None:
        response = _make_mock_response(json_body={"unexpected": "shape"})
        mock_post.return_value = response

        with pytest.raises(EmbeddingError, match="Malformed TEI response"):
            embed_query(
                "query",
                _EMBEDDING_MODEL,
                tei_url="http://tei:8080",
            )

    @patch("graphs.react_agent.rag.embeddings.httpx.post")
    def test_malformed_response_empty_data_list(self, mock_post: MagicMock) -> None:
        response = _make_mock_response(json_body={"data": []})
        mock_post.return_value = response

        with pytest.raises(EmbeddingError, match="Malformed TEI response"):
            embed_query(
                "query",
                _EMBEDDING_MODEL,
                tei_url="http://tei:8080",
            )

    @patch("graphs.react_agent.rag.embeddings.httpx.post")
    def test_malformed_response_missing_embedding_key(
        self, mock_post: MagicMock
    ) -> None:
        response = _make_mock_response(
            json_body={"data": [{"index": 0, "object": "embedding"}]},
        )
        mock_post.return_value = response

        with pytest.raises(EmbeddingError, match="Malformed TEI response"):
            embed_query(
                "query",
                _EMBEDDING_MODEL,
                tei_url="http://tei:8080",
            )

    @patch("graphs.react_agent.rag.embeddings.httpx.post")
    def test_malformed_response_data_is_not_list(self, mock_post: MagicMock) -> None:
        response = _make_mock_response(json_body={"data": "not a list"})
        mock_post.return_value = response

        with pytest.raises(EmbeddingError, match="Malformed TEI response"):
            embed_query(
                "query",
                _EMBEDDING_MODEL,
                tei_url="http://tei:8080",
            )


# ---------------------------------------------------------------------------
# embed_query() — error message content
# ---------------------------------------------------------------------------


class TestEmbedQueryErrorMessages:
    """Verify that error messages contain useful debugging information."""

    @patch("graphs.react_agent.rag.embeddings.httpx.post")
    def test_timeout_error_includes_url_and_model(self, mock_post: MagicMock) -> None:
        mock_post.side_effect = httpx.TimeoutException("timeout")

        with pytest.raises(EmbeddingError) as exc_info:
            embed_query(
                "query",
                "custom/model-name",
                tei_url="http://custom-host:1234",
                timeout=3.0,
            )

        error_message = str(exc_info.value)
        assert "custom-host:1234" in error_message
        assert "custom/model-name" in error_message
        assert "3.0" in error_message

    @patch("graphs.react_agent.rag.embeddings.httpx.post")
    def test_connect_error_includes_url_and_model(self, mock_post: MagicMock) -> None:
        mock_post.side_effect = httpx.ConnectError("refused")

        with pytest.raises(EmbeddingError) as exc_info:
            embed_query(
                "query",
                "test/model",
                tei_url="http://broken-host:5555",
            )

        error_message = str(exc_info.value)
        assert "broken-host:5555" in error_message
        assert "test/model" in error_message
