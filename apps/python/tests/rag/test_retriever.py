"""Unit tests for the ChromaDB archive search tool factory.

Tests :func:`create_archive_search_tool`, :func:`_format_results`,
:func:`_parse_host`, :func:`_parse_port`, :func:`_uses_ssl`,
:func:`_init_archive_clients`, and the inner ``search_archives`` tool
function.

All ChromaDB and TEI calls are mocked — no real services required.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock, patch


from graphs.react_agent.rag.config import ChromaRagConfig, RagArchiveConfig
from graphs.react_agent.rag.embeddings import EmbeddingError
from graphs.react_agent.rag.retriever import (
    _format_results,
    _init_archive_clients,
    _parse_host,
    _parse_port,
    _resolve_chromadb_url,
    _resolve_default_layer,
    _resolve_default_top_k,
    _uses_ssl,
    create_archive_search_tool,
)

_EMBEDDING_DIM = 768


def _make_archive(
    name: str = "Test Archive",
    collection_name: str = "repo_test-uuid",
    chromadb_url: str = "http://chromadb:8000",
    embedding_model: str = "jinaai/jina-embeddings-v2-base-de",
) -> RagArchiveConfig:
    """Build a RagArchiveConfig with sensible defaults."""
    return RagArchiveConfig(
        name=name,
        collection_name=collection_name,
        chromadb_url=chromadb_url,
        embedding_model=embedding_model,
    )


def _make_chroma_query_result(
    documents: list[str] | None = None,
    metadatas: list[dict[str, Any]] | None = None,
    distances: list[float] | None = None,
) -> dict[str, Any]:
    """Build a ChromaDB Collection.query() return value."""
    if documents is None:
        documents = ["Dies ist ein Testdokument über Immobilienverwaltung."]
    if metadatas is None:
        metadatas = [
            {
                "document_id": "doc-1",
                "repository_id": "test-uuid",
                "organization_id": "org-1",
                "layer": "chunk",
                "char_start": 0,
                "char_end": 52,
                "token_count": 8,
                "text_preview": "Dies ist ein Testdokument",
            }
        ]
    if distances is None:
        distances = [0.15]

    return {
        "ids": [["id-1"]],
        "documents": [documents],
        "metadatas": [metadatas],
        "distances": [distances],
        "embeddings": None,
    }


# ---------------------------------------------------------------------------
# URL parsing helpers
# ---------------------------------------------------------------------------


class TestParseHost:
    """Tests for _parse_host URL extraction."""

    def test_standard_url(self) -> None:
        assert _parse_host("http://chromadb:8000") == "chromadb"

    def test_https_url(self) -> None:
        assert _parse_host("https://chromadb.example.com:443") == "chromadb.example.com"

    def test_localhost(self) -> None:
        assert _parse_host("http://localhost:8000") == "localhost"

    def test_ip_address(self) -> None:
        assert _parse_host("http://192.168.1.10:8000") == "192.168.1.10"

    def test_no_port(self) -> None:
        assert _parse_host("http://chromadb") == "chromadb"

    def test_url_with_path(self) -> None:
        assert _parse_host("http://chromadb:8000/api") == "chromadb"

    def test_empty_string_returns_localhost(self) -> None:
        assert _parse_host("") == "localhost"

    def test_garbage_returns_localhost(self) -> None:
        assert _parse_host("not-a-url") == "localhost"


class TestParsePort:
    """Tests for _parse_port URL extraction."""

    def test_standard_port(self) -> None:
        assert _parse_port("http://chromadb:8000") == 8000

    def test_custom_port(self) -> None:
        assert _parse_port("http://chromadb:9999") == 9999

    def test_no_port_defaults_to_8000(self) -> None:
        assert _parse_port("http://chromadb") == 8000

    def test_empty_string_defaults_to_8000(self) -> None:
        assert _parse_port("") == 8000

    def test_https_port(self) -> None:
        assert _parse_port("https://chromadb:443") == 443


class TestUsesSsl:
    """Tests for _uses_ssl detection."""

    def test_http_is_not_ssl(self) -> None:
        assert _uses_ssl("http://chromadb:8000") is False

    def test_https_is_ssl(self) -> None:
        assert _uses_ssl("https://chromadb:443") is True

    def test_empty_string_is_not_ssl(self) -> None:
        assert _uses_ssl("") is False


# ---------------------------------------------------------------------------
# Environment helpers
# ---------------------------------------------------------------------------


class TestResolveDefaultTopK:
    """Tests for _resolve_default_top_k from env or built-in default."""

    @patch.dict("os.environ", {}, clear=True)
    def test_default_is_5(self) -> None:
        assert _resolve_default_top_k() == 5

    @patch.dict("os.environ", {"RAG_DEFAULT_TOP_K": "10"})
    def test_env_override(self) -> None:
        assert _resolve_default_top_k() == 10

    @patch.dict("os.environ", {"RAG_DEFAULT_TOP_K": "50"})
    def test_clamped_to_max_20(self) -> None:
        assert _resolve_default_top_k() == 20

    @patch.dict("os.environ", {"RAG_DEFAULT_TOP_K": "0"})
    def test_clamped_to_min_1(self) -> None:
        assert _resolve_default_top_k() == 1

    @patch.dict("os.environ", {"RAG_DEFAULT_TOP_K": "not_a_number"})
    def test_invalid_value_returns_default(self) -> None:
        assert _resolve_default_top_k() == 5


class TestResolveDefaultLayer:
    """Tests for _resolve_default_layer from env or built-in default."""

    @patch.dict("os.environ", {}, clear=True)
    def test_default_is_chunk(self) -> None:
        assert _resolve_default_layer() == "chunk"

    @patch.dict("os.environ", {"RAG_DEFAULT_LAYER": "page"})
    def test_env_override(self) -> None:
        assert _resolve_default_layer() == "page"


class TestResolveChromadbUrl:
    """Tests for _resolve_chromadb_url priority chain."""

    def test_archive_url_wins(self) -> None:
        assert _resolve_chromadb_url("http://custom:9000") == "http://custom:9000"

    @patch.dict("os.environ", {"DOCPROC_CHROMADB_URL": "http://env-chromadb:7777"})
    def test_env_fallback(self) -> None:
        assert _resolve_chromadb_url(None) == "http://env-chromadb:7777"

    @patch.dict("os.environ", {"DOCPROC_CHROMADB_URL": "http://env-chromadb:7777"})
    def test_archive_url_beats_env(self) -> None:
        assert _resolve_chromadb_url("http://explicit:1111") == "http://explicit:1111"

    @patch.dict("os.environ", {}, clear=True)
    def test_default_when_none_and_no_env(self) -> None:
        assert _resolve_chromadb_url(None) == "http://chromadb:8000"


# ---------------------------------------------------------------------------
# _init_archive_clients()
# ---------------------------------------------------------------------------


class TestInitArchiveClients:
    """Tests for _init_archive_clients ChromaDB connection setup."""

    @patch("graphs.react_agent.rag.retriever.chromadb.HttpClient")
    def test_successful_connection(self, mock_http_client_class: MagicMock) -> None:
        mock_client = MagicMock()
        mock_collection = MagicMock()
        mock_client.get_collection.return_value = mock_collection
        mock_http_client_class.return_value = mock_client

        archive = _make_archive()
        clients = _init_archive_clients([archive])

        assert len(clients) == 1
        config_out, collection_out = clients[0]
        assert config_out is archive
        assert collection_out is mock_collection
        mock_http_client_class.assert_called_once_with(
            host="chromadb", port=8000, ssl=False
        )
        mock_client.get_collection.assert_called_once_with(name="repo_test-uuid")

    @patch("graphs.react_agent.rag.retriever.chromadb.HttpClient")
    def test_unreachable_server_skips_archive(
        self, mock_http_client_class: MagicMock
    ) -> None:
        mock_http_client_class.side_effect = Exception("Connection refused")

        archive = _make_archive()
        clients = _init_archive_clients([archive])

        assert len(clients) == 0

    @patch("graphs.react_agent.rag.retriever.chromadb.HttpClient")
    def test_missing_collection_skips_archive(
        self, mock_http_client_class: MagicMock
    ) -> None:
        mock_client = MagicMock()
        mock_client.get_collection.side_effect = Exception("Collection not found")
        mock_http_client_class.return_value = mock_client

        archive = _make_archive()
        clients = _init_archive_clients([archive])

        assert len(clients) == 0

    @patch("graphs.react_agent.rag.retriever.chromadb.HttpClient")
    def test_multiple_archives_partial_success(
        self, mock_http_client_class: MagicMock
    ) -> None:
        """One archive connects, the other fails — should return only the good one."""
        mock_client_good = MagicMock()
        mock_collection_good = MagicMock()
        mock_client_good.get_collection.return_value = mock_collection_good

        mock_client_bad = MagicMock()
        mock_client_bad.get_collection.side_effect = Exception("not found")

        mock_http_client_class.side_effect = [mock_client_good, mock_client_bad]

        archive_good = _make_archive(name="Good", collection_name="repo_good")
        archive_bad = _make_archive(name="Bad", collection_name="repo_bad")

        clients = _init_archive_clients([archive_good, archive_bad])

        assert len(clients) == 1
        assert clients[0][0].name == "Good"

    @patch("graphs.react_agent.rag.retriever.chromadb.HttpClient")
    def test_ssl_url_passes_ssl_true(self, mock_http_client_class: MagicMock) -> None:
        mock_client = MagicMock()
        mock_collection = MagicMock()
        mock_client.get_collection.return_value = mock_collection
        mock_http_client_class.return_value = mock_client

        archive = _make_archive(chromadb_url="https://secure-chromadb:443")
        _init_archive_clients([archive])

        mock_http_client_class.assert_called_once_with(
            host="secure-chromadb", port=443, ssl=True
        )


# ---------------------------------------------------------------------------
# _format_results()
# ---------------------------------------------------------------------------


class TestFormatResults:
    """Tests for _format_results output formatting."""

    def test_empty_results_returns_no_results_message(self) -> None:
        result = _format_results([], top_k=5)
        assert result == "Keine relevanten Dokumente gefunden."

    def test_single_result_formatted(self) -> None:
        results = [
            {
                "archive": "My Archive",
                "text": "Some document text here.",
                "metadata": {"layer": "chunk", "page_number": 3},
                "distance": 0.1,
            }
        ]
        output = _format_results(results, top_k=5)
        assert "[1] Archiv: My Archive" in output
        assert "Ebene: chunk" in output
        assert "Seite: 3" in output
        assert "Some document text here." in output

    def test_multiple_results_separated_by_dividers(self) -> None:
        results = [
            {
                "archive": "A",
                "text": "Text A",
                "metadata": {},
                "distance": 0.1,
            },
            {
                "archive": "B",
                "text": "Text B",
                "metadata": {},
                "distance": 0.2,
            },
        ]
        output = _format_results(results, top_k=5)
        assert "\n\n---\n\n" in output
        assert "[1] Archiv: A" in output
        assert "[2] Archiv: B" in output

    def test_top_k_limits_output(self) -> None:
        results = [
            {
                "archive": f"Archive {index}",
                "text": f"Text {index}",
                "metadata": {},
                "distance": float(index) * 0.1,
            }
            for index in range(10)
        ]
        output = _format_results(results, top_k=3)
        assert "[1]" in output
        assert "[2]" in output
        assert "[3]" in output
        assert "[4]" not in output

    def test_section_heading_in_metadata(self) -> None:
        results = [
            {
                "archive": "A",
                "text": "Text",
                "metadata": {"section_heading": "Kapitel 2: Wartung"},
                "distance": 0.1,
            }
        ]
        output = _format_results(results, top_k=5)
        assert "Abschnitt: Kapitel 2: Wartung" in output

    def test_empty_metadata_no_source_info(self) -> None:
        results = [
            {
                "archive": "A",
                "text": "Text",
                "metadata": {},
                "distance": 0.1,
            }
        ]
        output = _format_results(results, top_k=5)
        assert "[1] Archiv: A" in output
        # No parenthetical source info
        assert "(" not in output

    def test_missing_metadata_key(self) -> None:
        results = [
            {
                "archive": "A",
                "text": "Text",
                "metadata": None,
                "distance": 0.1,
            }
        ]
        # Should not crash — metadata defaults to {}
        output = _format_results(results, top_k=5)
        assert "[1] Archiv: A" in output


# ---------------------------------------------------------------------------
# create_archive_search_tool()
# ---------------------------------------------------------------------------


class TestCreateArchiveSearchTool:
    """Tests for the create_archive_search_tool factory."""

    def test_empty_archives_returns_none(self) -> None:
        config = ChromaRagConfig(archives=[])
        result = create_archive_search_tool(config)
        assert result is None

    @patch("graphs.react_agent.rag.retriever._init_archive_clients")
    def test_all_archives_fail_returns_none(self, mock_init: MagicMock) -> None:
        mock_init.return_value = []
        config = ChromaRagConfig(archives=[_make_archive()])
        result = create_archive_search_tool(config)
        assert result is None

    @patch("graphs.react_agent.rag.retriever._init_archive_clients")
    def test_creates_tool_with_correct_name(self, mock_init: MagicMock) -> None:
        archive = _make_archive()
        mock_collection = MagicMock()
        mock_init.return_value = [(archive, mock_collection)]

        config = ChromaRagConfig(archives=[archive])
        tool = create_archive_search_tool(config)

        assert tool is not None
        assert tool.name == "search_archives"

    @patch("graphs.react_agent.rag.retriever._init_archive_clients")
    def test_tool_has_description(self, mock_init: MagicMock) -> None:
        archive = _make_archive()
        mock_collection = MagicMock()
        mock_init.return_value = [(archive, mock_collection)]

        config = ChromaRagConfig(archives=[archive])
        tool = create_archive_search_tool(config)

        assert tool is not None
        assert "document archives" in tool.description.lower()


# ---------------------------------------------------------------------------
# search_archives inner function — invocation tests
# ---------------------------------------------------------------------------


class TestSearchArchivesInvocation:
    """Tests for invoking the search_archives tool function."""

    @patch("graphs.react_agent.rag.retriever.embed_query")
    @patch("graphs.react_agent.rag.retriever._init_archive_clients")
    def test_returns_formatted_results(
        self,
        mock_init: MagicMock,
        mock_embed: MagicMock,
    ) -> None:
        archive = _make_archive(name="Wartungsdoku")
        mock_collection = MagicMock()
        mock_collection.query.return_value = _make_chroma_query_result(
            documents=["Wartungsplan für die Heizungsanlage im EG."],
            metadatas=[
                {
                    "layer": "chunk",
                    "page_number": 5,
                    "section_heading": "Heizung",
                }
            ],
            distances=[0.12],
        )
        mock_init.return_value = [(archive, mock_collection)]
        mock_embed.return_value = [0.1] * _EMBEDDING_DIM

        config = ChromaRagConfig(archives=[archive])
        tool = create_archive_search_tool(config)
        assert tool is not None

        result = tool.invoke({"query": "Heizung Wartung"})

        assert "Wartungsdoku" in result
        assert "Wartungsplan" in result
        assert "Heizung" in result
        mock_embed.assert_called_once_with(
            text="Heizung Wartung",
            embedding_model="jinaai/jina-embeddings-v2-base-de",
        )

    @patch("graphs.react_agent.rag.retriever.embed_query")
    @patch("graphs.react_agent.rag.retriever._init_archive_clients")
    def test_embedding_failure_returns_error_message(
        self,
        mock_init: MagicMock,
        mock_embed: MagicMock,
    ) -> None:
        archive = _make_archive()
        mock_collection = MagicMock()
        mock_init.return_value = [(archive, mock_collection)]
        mock_embed.side_effect = EmbeddingError("TEI unreachable")

        config = ChromaRagConfig(archives=[archive])
        tool = create_archive_search_tool(config)
        assert tool is not None

        result = tool.invoke({"query": "test"})
        assert "fehlgeschlagen" in result
        mock_collection.query.assert_not_called()

    @patch("graphs.react_agent.rag.retriever.embed_query")
    @patch("graphs.react_agent.rag.retriever._init_archive_clients")
    def test_chromadb_query_failure_returns_no_results(
        self,
        mock_init: MagicMock,
        mock_embed: MagicMock,
    ) -> None:
        archive = _make_archive()
        mock_collection = MagicMock()
        mock_collection.query.side_effect = Exception("ChromaDB error")
        mock_init.return_value = [(archive, mock_collection)]
        mock_embed.return_value = [0.1] * _EMBEDDING_DIM

        config = ChromaRagConfig(archives=[archive])
        tool = create_archive_search_tool(config)
        assert tool is not None

        result = tool.invoke({"query": "test"})
        assert "Keine relevanten Dokumente gefunden" in result

    @patch("graphs.react_agent.rag.retriever.embed_query")
    @patch("graphs.react_agent.rag.retriever._init_archive_clients")
    def test_empty_query_results_returns_no_results(
        self,
        mock_init: MagicMock,
        mock_embed: MagicMock,
    ) -> None:
        archive = _make_archive()
        mock_collection = MagicMock()
        mock_collection.query.return_value = _make_chroma_query_result(
            documents=[],
            metadatas=[],
            distances=[],
        )
        mock_init.return_value = [(archive, mock_collection)]
        mock_embed.return_value = [0.1] * _EMBEDDING_DIM

        config = ChromaRagConfig(archives=[archive])
        tool = create_archive_search_tool(config)
        assert tool is not None

        result = tool.invoke({"query": "nonexistent topic"})
        assert "Keine relevanten Dokumente gefunden" in result

    @patch("graphs.react_agent.rag.retriever.embed_query")
    @patch("graphs.react_agent.rag.retriever._init_archive_clients")
    def test_top_k_clamped_to_max_20(
        self,
        mock_init: MagicMock,
        mock_embed: MagicMock,
    ) -> None:
        archive = _make_archive()
        mock_collection = MagicMock()
        mock_collection.query.return_value = _make_chroma_query_result()
        mock_init.return_value = [(archive, mock_collection)]
        mock_embed.return_value = [0.1] * _EMBEDDING_DIM

        config = ChromaRagConfig(archives=[archive])
        tool = create_archive_search_tool(config)
        assert tool is not None

        # Pass top_k=100, should be clamped to 20
        tool.invoke({"query": "test", "top_k": 100})

        call_kwargs = mock_collection.query.call_args[1]
        assert call_kwargs["n_results"] == 20

    @patch("graphs.react_agent.rag.retriever.embed_query")
    @patch("graphs.react_agent.rag.retriever._init_archive_clients")
    def test_top_k_clamped_to_min_1(
        self,
        mock_init: MagicMock,
        mock_embed: MagicMock,
    ) -> None:
        archive = _make_archive()
        mock_collection = MagicMock()
        mock_collection.query.return_value = _make_chroma_query_result()
        mock_init.return_value = [(archive, mock_collection)]
        mock_embed.return_value = [0.1] * _EMBEDDING_DIM

        config = ChromaRagConfig(archives=[archive])
        tool = create_archive_search_tool(config)
        assert tool is not None

        tool.invoke({"query": "test", "top_k": -5})

        call_kwargs = mock_collection.query.call_args[1]
        assert call_kwargs["n_results"] == 1

    @patch("graphs.react_agent.rag.retriever.embed_query")
    @patch("graphs.react_agent.rag.retriever._init_archive_clients")
    @patch.dict("os.environ", {"RAG_DEFAULT_LAYER": "page"})
    def test_layer_filter_from_env(
        self,
        mock_init: MagicMock,
        mock_embed: MagicMock,
    ) -> None:
        archive = _make_archive()
        mock_collection = MagicMock()
        mock_collection.query.return_value = _make_chroma_query_result()
        mock_init.return_value = [(archive, mock_collection)]
        mock_embed.return_value = [0.1] * _EMBEDDING_DIM

        config = ChromaRagConfig(archives=[archive])
        tool = create_archive_search_tool(config)
        assert tool is not None

        tool.invoke({"query": "test"})

        call_kwargs = mock_collection.query.call_args[1]
        assert call_kwargs["where"] == {"layer": "page"}

    @patch("graphs.react_agent.rag.retriever.embed_query")
    @patch("graphs.react_agent.rag.retriever._init_archive_clients")
    def test_multiple_archives_results_sorted_by_distance(
        self,
        mock_init: MagicMock,
        mock_embed: MagicMock,
    ) -> None:
        archive_a = _make_archive(name="Archive A", collection_name="repo_a")
        archive_b = _make_archive(name="Archive B", collection_name="repo_b")

        mock_collection_a = MagicMock()
        mock_collection_a.query.return_value = _make_chroma_query_result(
            documents=["Distant doc from A"],
            metadatas=[{"layer": "chunk"}],
            distances=[0.8],
        )

        mock_collection_b = MagicMock()
        mock_collection_b.query.return_value = _make_chroma_query_result(
            documents=["Close doc from B"],
            metadatas=[{"layer": "chunk"}],
            distances=[0.1],
        )

        mock_init.return_value = [
            (archive_a, mock_collection_a),
            (archive_b, mock_collection_b),
        ]
        mock_embed.return_value = [0.1] * _EMBEDDING_DIM

        config = ChromaRagConfig(archives=[archive_a, archive_b])
        tool = create_archive_search_tool(config)
        assert tool is not None

        result = tool.invoke({"query": "test"})

        # Archive B result (distance 0.1) should appear before Archive A (distance 0.8)
        position_b = result.index("Archive B")
        position_a = result.index("Archive A")
        assert position_b < position_a

    @patch("graphs.react_agent.rag.retriever.embed_query")
    @patch("graphs.react_agent.rag.retriever._init_archive_clients")
    def test_partial_chromadb_failure_still_returns_good_results(
        self,
        mock_init: MagicMock,
        mock_embed: MagicMock,
    ) -> None:
        """One archive fails to query, the other succeeds — should return partial."""
        archive_good = _make_archive(name="Good Archive", collection_name="repo_good")
        archive_bad = _make_archive(name="Bad Archive", collection_name="repo_bad")

        mock_collection_good = MagicMock()
        mock_collection_good.query.return_value = _make_chroma_query_result(
            documents=["Good result"],
            metadatas=[{"layer": "chunk"}],
            distances=[0.2],
        )

        mock_collection_bad = MagicMock()
        mock_collection_bad.query.side_effect = Exception("network error")

        mock_init.return_value = [
            (archive_good, mock_collection_good),
            (archive_bad, mock_collection_bad),
        ]
        mock_embed.return_value = [0.1] * _EMBEDDING_DIM

        config = ChromaRagConfig(archives=[archive_good, archive_bad])
        tool = create_archive_search_tool(config)
        assert tool is not None

        result = tool.invoke({"query": "test"})
        assert "Good Archive" in result
        assert "Good result" in result
        assert "Bad Archive" not in result

    @patch("graphs.react_agent.rag.retriever.embed_query")
    @patch("graphs.react_agent.rag.retriever._init_archive_clients")
    def test_query_includes_correct_includes(
        self,
        mock_init: MagicMock,
        mock_embed: MagicMock,
    ) -> None:
        archive = _make_archive()
        mock_collection = MagicMock()
        mock_collection.query.return_value = _make_chroma_query_result()
        mock_init.return_value = [(archive, mock_collection)]
        mock_embed.return_value = [0.1] * _EMBEDDING_DIM

        config = ChromaRagConfig(archives=[archive])
        tool = create_archive_search_tool(config)
        assert tool is not None

        tool.invoke({"query": "test"})

        call_kwargs = mock_collection.query.call_args[1]
        assert "documents" in call_kwargs["include"]
        assert "metadatas" in call_kwargs["include"]
        assert "distances" in call_kwargs["include"]

    @patch("graphs.react_agent.rag.retriever.embed_query")
    @patch("graphs.react_agent.rag.retriever._init_archive_clients")
    def test_query_passes_embedding_as_list_of_list(
        self,
        mock_init: MagicMock,
        mock_embed: MagicMock,
    ) -> None:
        """ChromaDB expects query_embeddings to be a list of embedding vectors."""
        archive = _make_archive()
        mock_collection = MagicMock()
        mock_collection.query.return_value = _make_chroma_query_result()
        mock_init.return_value = [(archive, mock_collection)]
        expected_embedding = [0.5] * _EMBEDDING_DIM
        mock_embed.return_value = expected_embedding

        config = ChromaRagConfig(archives=[archive])
        tool = create_archive_search_tool(config)
        assert tool is not None

        tool.invoke({"query": "test"})

        call_kwargs = mock_collection.query.call_args[1]
        assert call_kwargs["query_embeddings"] == [expected_embedding]

    @patch("graphs.react_agent.rag.retriever.embed_query")
    @patch("graphs.react_agent.rag.retriever._init_archive_clients")
    def test_default_layer_filter_is_chunk(
        self,
        mock_init: MagicMock,
        mock_embed: MagicMock,
    ) -> None:
        archive = _make_archive()
        mock_collection = MagicMock()
        mock_collection.query.return_value = _make_chroma_query_result()
        mock_init.return_value = [(archive, mock_collection)]
        mock_embed.return_value = [0.1] * _EMBEDDING_DIM

        config = ChromaRagConfig(archives=[archive])
        tool = create_archive_search_tool(config)
        assert tool is not None

        tool.invoke({"query": "test"})

        call_kwargs = mock_collection.query.call_args[1]
        assert call_kwargs.get("where") == {"layer": "chunk"}
