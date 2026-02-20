"""Unit tests for ChromaDB RAG config extraction.

Tests :func:`extract_rag_config`, :class:`RagArchiveConfig`, and
:class:`ChromaRagConfig` — the Pydantic models that parse the
``rag_config`` payload from ``config.configurable``.
"""

from __future__ import annotations

import pytest

from graphs.react_agent.rag.config import (
    ChromaRagConfig,
    RagArchiveConfig,
    extract_rag_config,
)


# ---------------------------------------------------------------------------
# RagArchiveConfig model tests
# ---------------------------------------------------------------------------


class TestRagArchiveConfig:
    """Tests for the RagArchiveConfig Pydantic model."""

    def test_minimal_required_fields(self) -> None:
        archive = RagArchiveConfig(
            name="Test Archive",
            collection_name="repo_abc123",
        )
        assert archive.name == "Test Archive"
        assert archive.collection_name == "repo_abc123"
        assert archive.chromadb_url == "http://chromadb:8000"
        assert archive.embedding_model == "jinaai/jina-embeddings-v2-base-de"

    def test_all_fields_explicit(self) -> None:
        archive = RagArchiveConfig(
            name="Custom Archive",
            collection_name="repo_custom-uuid",
            chromadb_url="http://custom-chromadb:9000",
            embedding_model="custom/embedding-model",
        )
        assert archive.name == "Custom Archive"
        assert archive.collection_name == "repo_custom-uuid"
        assert archive.chromadb_url == "http://custom-chromadb:9000"
        assert archive.embedding_model == "custom/embedding-model"

    def test_missing_name_raises(self) -> None:
        with pytest.raises(Exception):
            RagArchiveConfig(collection_name="repo_abc")  # type: ignore[call-arg]

    def test_missing_collection_name_raises(self) -> None:
        with pytest.raises(Exception):
            RagArchiveConfig(name="Test")  # type: ignore[call-arg]


# ---------------------------------------------------------------------------
# ChromaRagConfig model tests
# ---------------------------------------------------------------------------


class TestChromaRagConfig:
    """Tests for the ChromaRagConfig Pydantic model."""

    def test_default_empty_archives(self) -> None:
        config = ChromaRagConfig()
        assert config.archives == []

    def test_single_archive(self) -> None:
        config = ChromaRagConfig(
            archives=[
                RagArchiveConfig(
                    name="AIS Management",
                    collection_name="repo_a1b2c3d4",
                ),
            ],
        )
        assert len(config.archives) == 1
        assert config.archives[0].name == "AIS Management"

    def test_multiple_archives(self) -> None:
        config = ChromaRagConfig(
            archives=[
                RagArchiveConfig(
                    name="Archive One",
                    collection_name="repo_111",
                ),
                RagArchiveConfig(
                    name="Archive Two",
                    collection_name="repo_222",
                    chromadb_url="http://other-chromadb:8000",
                ),
            ],
        )
        assert len(config.archives) == 2
        assert config.archives[1].chromadb_url == "http://other-chromadb:8000"

    def test_model_validate_from_dict(self) -> None:
        raw = {
            "archives": [
                {
                    "name": "From Dict",
                    "collection_name": "repo_from_dict",
                    "chromadb_url": "http://chromadb:8000",
                    "embedding_model": "jinaai/jina-embeddings-v2-base-de",
                },
            ],
        }
        config = ChromaRagConfig.model_validate(raw)
        assert len(config.archives) == 1
        assert config.archives[0].name == "From Dict"

    def test_model_validate_with_defaults(self) -> None:
        """Only required fields in the archive dict; defaults should fill in."""
        raw = {
            "archives": [
                {
                    "name": "Minimal",
                    "collection_name": "repo_minimal",
                },
            ],
        }
        config = ChromaRagConfig.model_validate(raw)
        archive = config.archives[0]
        assert archive.chromadb_url == "http://chromadb:8000"
        assert archive.embedding_model == "jinaai/jina-embeddings-v2-base-de"


# ---------------------------------------------------------------------------
# extract_rag_config() tests
# ---------------------------------------------------------------------------


class TestExtractRagConfig:
    """Tests for the extract_rag_config() helper."""

    def test_present_with_one_archive(self) -> None:
        config = {
            "configurable": {
                "rag_config": {
                    "archives": [
                        {
                            "name": "Test Archive",
                            "collection_name": "repo_test-uuid",
                            "chromadb_url": "http://chromadb:8000",
                            "embedding_model": "jinaai/jina-embeddings-v2-base-de",
                        },
                    ],
                },
            },
        }
        result = extract_rag_config(config)
        assert result is not None
        assert len(result.archives) == 1
        assert result.archives[0].collection_name == "repo_test-uuid"

    def test_present_with_multiple_archives(self) -> None:
        config = {
            "configurable": {
                "rag_config": {
                    "archives": [
                        {
                            "name": "Archive A",
                            "collection_name": "repo_aaa",
                        },
                        {
                            "name": "Archive B",
                            "collection_name": "repo_bbb",
                            "chromadb_url": "http://other:9000",
                        },
                    ],
                },
            },
        }
        result = extract_rag_config(config)
        assert result is not None
        assert len(result.archives) == 2
        assert result.archives[0].name == "Archive A"
        assert result.archives[1].chromadb_url == "http://other:9000"

    def test_absent_key_returns_none(self) -> None:
        config = {"configurable": {"model_name": "openai:gpt-4o-mini"}}
        result = extract_rag_config(config)
        assert result is None

    def test_empty_configurable_returns_none(self) -> None:
        config = {"configurable": {}}
        result = extract_rag_config(config)
        assert result is None

    def test_missing_configurable_returns_none(self) -> None:
        config = {}
        result = extract_rag_config(config)
        assert result is None

    def test_none_configurable_returns_none(self) -> None:
        config = {"configurable": None}
        result = extract_rag_config(config)
        assert result is None

    def test_rag_config_is_none_returns_none(self) -> None:
        config = {"configurable": {"rag_config": None}}
        result = extract_rag_config(config)
        assert result is None

    def test_rag_config_is_empty_dict_returns_none(self) -> None:
        """An empty dict is falsy — should return None."""
        config = {"configurable": {"rag_config": {}}}
        result = extract_rag_config(config)
        assert result is None

    def test_empty_archives_list(self) -> None:
        """rag_config present but archives is empty — valid config, zero archives."""
        config = {"configurable": {"rag_config": {"archives": []}}}
        result = extract_rag_config(config)
        assert result is not None
        assert len(result.archives) == 0

    def test_thread_level_override_replaces_assistant_config(self) -> None:
        """Thread-level rag_config replaces assistant-level entirely.

        In practice LangGraph merges configurable dicts with thread-level
        taking precedence, so the graph() function receives a single
        ``rag_config`` that is the thread-level one.  This test verifies
        that extract_rag_config parses whatever is in configurable.
        """
        # Simulates what the graph sees after LangGraph merges configs:
        # thread-level had only one archive (user disabled the second)
        config = {
            "configurable": {
                "model_name": "openai:gpt-4o",
                "rag_config": {
                    "archives": [
                        {
                            "name": "Only Active Archive",
                            "collection_name": "repo_only-active",
                        },
                    ],
                },
            },
        }
        result = extract_rag_config(config)
        assert result is not None
        assert len(result.archives) == 1
        assert result.archives[0].name == "Only Active Archive"

    def test_coexists_with_old_rag_field(self) -> None:
        """Both old ``rag`` and new ``rag_config`` can be in configurable."""
        config = {
            "configurable": {
                "rag": {
                    "rag_url": "http://langconnect:3000",
                    "collections": ["uuid-1", "uuid-2"],
                },
                "rag_config": {
                    "archives": [
                        {
                            "name": "ChromaDB Archive",
                            "collection_name": "repo_chromadb",
                        },
                    ],
                },
            },
        }
        result = extract_rag_config(config)
        assert result is not None
        assert len(result.archives) == 1
        assert result.archives[0].name == "ChromaDB Archive"

    def test_extra_fields_in_archive_are_ignored(self) -> None:
        """Pydantic should ignore unknown fields by default."""
        config = {
            "configurable": {
                "rag_config": {
                    "archives": [
                        {
                            "name": "With Extras",
                            "collection_name": "repo_extras",
                            "unknown_field": "should be ignored",
                        },
                    ],
                },
            },
        }
        result = extract_rag_config(config)
        assert result is not None
        assert len(result.archives) == 1
        assert result.archives[0].name == "With Extras"
