"""Unit tests for the shared LLM factory (graphs.llm).

Covers:
- ``get_api_key_for_model()`` — all provider paths, custom endpoint
  fallback chain, configurable.apiKeys injection, edge cases.
- ``create_chat_model()`` — custom endpoint (ChatOpenAI) path,
  standard provider (init_chat_model) path, EMPTY fallback, model
  name resolution.
- ``model_name_override`` — per-invocation model override precedence,
  logging, edge cases (Task-03).
- ``routing_metadata`` — HTTP header injection, value filtering,
  logging keys only (Task-04).
- Semantic router env vars — ``SEMANTIC_ROUTER_ENABLED``,
  ``SEMANTIC_ROUTER_URL``, ``SEMANTIC_ROUTER_MODEL`` (Task-04).
- Integration scenarios — router overriding existing base_url,
  router model vs custom_model_name precedence, full integration
  with all params interacting simultaneously (Task-05).
"""

from __future__ import annotations

import logging
from unittest.mock import MagicMock, patch

import pytest


# ============================================================================
# get_api_key_for_model
# ============================================================================


class TestGetApiKeyForModel:
    """Tests for the unified API key resolver."""

    # --- Standard providers ------------------------------------------------

    def test_openai_provider_from_env(self, monkeypatch: pytest.MonkeyPatch) -> None:
        from graphs.llm import get_api_key_for_model

        monkeypatch.setenv("OPENAI_API_KEY", "sk-openai-test")
        key = get_api_key_for_model("openai:gpt-4o", {})
        assert key == "sk-openai-test"

    def test_anthropic_provider_from_env(self, monkeypatch: pytest.MonkeyPatch) -> None:
        from graphs.llm import get_api_key_for_model

        monkeypatch.setenv("ANTHROPIC_API_KEY", "ant-key-123")
        key = get_api_key_for_model("anthropic:claude-sonnet-4-20250514", {})
        assert key == "ant-key-123"

    def test_google_provider_from_env(self, monkeypatch: pytest.MonkeyPatch) -> None:
        from graphs.llm import get_api_key_for_model

        monkeypatch.setenv("GOOGLE_API_KEY", "goog-key")
        key = get_api_key_for_model("google:gemini-pro", {})
        assert key == "goog-key"

    def test_mistral_provider_from_env(self, monkeypatch: pytest.MonkeyPatch) -> None:
        from graphs.llm import get_api_key_for_model

        monkeypatch.setenv("MISTRAL_API_KEY", "mistral-key")
        key = get_api_key_for_model("mistral:ministral-3b", {})
        assert key == "mistral-key"

    def test_groq_provider_from_env(self, monkeypatch: pytest.MonkeyPatch) -> None:
        from graphs.llm import get_api_key_for_model

        monkeypatch.setenv("GROQ_API_KEY", "groq-key")
        key = get_api_key_for_model("groq:llama3-70b", {})
        assert key == "groq-key"

    def test_fireworks_provider_from_env(self, monkeypatch: pytest.MonkeyPatch) -> None:
        from graphs.llm import get_api_key_for_model

        monkeypatch.setenv("FIREWORKS_API_KEY", "fw-key")
        key = get_api_key_for_model("fireworks:llama-v3", {})
        assert key == "fw-key"

    def test_provider_without_colon(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Bare provider name (no :model suffix) should still resolve."""
        from graphs.llm import get_api_key_for_model

        monkeypatch.setenv("OPENAI_API_KEY", "bare-key")
        key = get_api_key_for_model("openai", {})
        assert key == "bare-key"

    def test_unknown_provider_returns_none(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from graphs.llm import get_api_key_for_model

        for env_var in ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_API_KEY"]:
            monkeypatch.delenv(env_var, raising=False)
        key = get_api_key_for_model("unknownprovider:model", {})
        assert key is None

    # --- Case insensitivity ------------------------------------------------

    def test_model_name_case_insensitive(self, monkeypatch: pytest.MonkeyPatch) -> None:
        from graphs.llm import get_api_key_for_model

        monkeypatch.setenv("OPENAI_API_KEY", "case-key")
        key = get_api_key_for_model("OpenAI:GPT-4o", {})
        assert key == "case-key"

    # --- Custom endpoints --------------------------------------------------

    def test_custom_from_configurable(self) -> None:
        """custom_api_key in configurable takes highest priority."""
        from graphs.llm import get_api_key_for_model

        config = {"configurable": {"custom_api_key": "my-custom-key"}}
        key = get_api_key_for_model("custom:my-model", config)
        assert key == "my-custom-key"

    def test_custom_falls_back_to_custom_api_key_env(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """CUSTOM_API_KEY env var is the second fallback for custom endpoints."""
        from graphs.llm import get_api_key_for_model

        monkeypatch.setenv("CUSTOM_API_KEY", "env-custom-key")
        monkeypatch.delenv("OPENAI_API_KEY", raising=False)
        key = get_api_key_for_model("custom:vllm-model", {"configurable": {}})
        assert key == "env-custom-key"

    def test_custom_falls_back_to_openai_api_key_env(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """OPENAI_API_KEY is the last fallback for custom (OpenAI-compat) endpoints."""
        from graphs.llm import get_api_key_for_model

        monkeypatch.delenv("CUSTOM_API_KEY", raising=False)
        monkeypatch.setenv("OPENAI_API_KEY", "openai-fallback")
        key = get_api_key_for_model("custom:my-model", {"configurable": {}})
        assert key == "openai-fallback"

    def test_custom_prefers_custom_api_key_over_openai(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """CUSTOM_API_KEY takes precedence over OPENAI_API_KEY for custom endpoints."""
        from graphs.llm import get_api_key_for_model

        monkeypatch.setenv("CUSTOM_API_KEY", "preferred")
        monkeypatch.setenv("OPENAI_API_KEY", "fallback")
        key = get_api_key_for_model("custom:model", {"configurable": {}})
        assert key == "preferred"

    def test_custom_returns_none_when_no_keys(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from graphs.llm import get_api_key_for_model

        monkeypatch.delenv("CUSTOM_API_KEY", raising=False)
        monkeypatch.delenv("OPENAI_API_KEY", raising=False)
        key = get_api_key_for_model("custom:", {"configurable": {}})
        assert key is None

    # --- Platform-injected apiKeys -----------------------------------------

    def test_api_keys_from_configurable_takes_precedence(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """configurable.apiKeys overrides environment variables."""
        from graphs.llm import get_api_key_for_model

        monkeypatch.setenv("OPENAI_API_KEY", "env-key")
        config = {
            "configurable": {
                "apiKeys": {"OPENAI_API_KEY": "platform-key"},
            }
        }
        key = get_api_key_for_model("openai:gpt-4o", config)
        assert key == "platform-key"

    def test_api_keys_empty_string_falls_through(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Empty string in apiKeys falls through to env var."""
        from graphs.llm import get_api_key_for_model

        monkeypatch.setenv("OPENAI_API_KEY", "env-key")
        config = {
            "configurable": {
                "apiKeys": {"OPENAI_API_KEY": ""},
            }
        }
        key = get_api_key_for_model("openai:gpt-4o", config)
        assert key == "env-key"

    def test_api_keys_non_dict_ignored(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Non-dict apiKeys value is safely ignored."""
        from graphs.llm import get_api_key_for_model

        monkeypatch.setenv("OPENAI_API_KEY", "env-key")
        config = {"configurable": {"apiKeys": "not-a-dict"}}
        key = get_api_key_for_model("openai:gpt-4o", config)
        assert key == "env-key"

    # --- Edge cases --------------------------------------------------------

    def test_none_configurable(self) -> None:
        """Config with None configurable doesn't crash."""
        from graphs.llm import get_api_key_for_model

        key = get_api_key_for_model("unknownprovider:x", {"configurable": None})
        assert key is None

    def test_empty_config(self, monkeypatch: pytest.MonkeyPatch) -> None:
        from graphs.llm import get_api_key_for_model

        monkeypatch.delenv("OPENAI_API_KEY", raising=False)
        key = get_api_key_for_model("openai:gpt-4o", {})
        assert key is None


# ============================================================================
# create_chat_model — custom endpoint path (ChatOpenAI)
# ============================================================================


class TestCreateChatModelCustomEndpoint:
    """Tests for create_chat_model() with base_url set (ChatOpenAI path)."""

    def test_creates_chat_openai_with_base_url(self) -> None:
        """When base_url is set, ChatOpenAI is created with correct kwargs."""
        from graphs.llm import create_chat_model

        mock_model = MagicMock()
        config = {"configurable": {"custom_api_key": "test-key"}}

        with patch("graphs.llm.ChatOpenAI", return_value=mock_model) as mock_cls:
            result = create_chat_model(
                config,
                model_name="custom:",
                temperature=0.5,
                max_tokens=1000,
                base_url="http://localhost:8000/v1",
                custom_model_name="ministral-3b",
            )

            assert result is mock_model
            mock_cls.assert_called_once_with(
                openai_api_base="http://localhost:8000/v1",
                openai_api_key="test-key",
                model="ministral-3b",
                temperature=0.5,
                max_tokens=1000,
            )

    def test_custom_model_name_fallback_to_model_name(self) -> None:
        """When custom_model_name is None, model_name is used."""
        from graphs.llm import create_chat_model

        mock_model = MagicMock()
        config = {"configurable": {"custom_api_key": "key"}}

        with patch("graphs.llm.ChatOpenAI", return_value=mock_model) as mock_cls:
            create_chat_model(
                config,
                model_name="openai:gpt-4o",
                base_url="http://localhost:8000/v1",
                custom_model_name=None,
            )

            call_kwargs = mock_cls.call_args.kwargs
            assert call_kwargs["model"] == "openai:gpt-4o"

    def test_empty_api_key_when_no_key_available(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """When no API key is found, 'EMPTY' is used (vLLM pattern)."""
        from graphs.llm import create_chat_model

        monkeypatch.delenv("CUSTOM_API_KEY", raising=False)
        monkeypatch.delenv("OPENAI_API_KEY", raising=False)

        mock_model = MagicMock()
        config: dict = {"configurable": {}}

        with patch("graphs.llm.ChatOpenAI", return_value=mock_model) as mock_cls:
            create_chat_model(
                config,
                model_name="custom:",
                base_url="http://localhost:8000/v1",
            )

            call_kwargs = mock_cls.call_args.kwargs
            assert call_kwargs["openai_api_key"] == "EMPTY"

    def test_default_temperature_and_max_tokens(self) -> None:
        """Default temperature=0.7 and max_tokens=None are applied."""
        from graphs.llm import create_chat_model

        mock_model = MagicMock()
        config = {"configurable": {"custom_api_key": "k"}}

        with patch("graphs.llm.ChatOpenAI", return_value=mock_model) as mock_cls:
            create_chat_model(
                config,
                model_name="custom:",
                base_url="http://vllm:8000/v1",
            )

            call_kwargs = mock_cls.call_args.kwargs
            assert call_kwargs["temperature"] == 0.7
            assert call_kwargs["max_tokens"] is None


# ============================================================================
# create_chat_model — standard provider path (init_chat_model)
# ============================================================================


class TestCreateChatModelStandardProvider:
    """Tests for create_chat_model() without base_url (init_chat_model path)."""

    def test_creates_via_init_chat_model(self, monkeypatch: pytest.MonkeyPatch) -> None:
        from graphs.llm import create_chat_model

        monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
        mock_model = MagicMock()

        with patch("graphs.llm.init_chat_model", return_value=mock_model) as mock_init:
            result = create_chat_model(
                {},
                model_name="openai:gpt-4o",
                temperature=0.3,
                max_tokens=2000,
            )

            assert result is mock_model
            mock_init.assert_called_once_with(
                "openai:gpt-4o",
                temperature=0.3,
                max_tokens=2000,
                api_key="sk-test",
            )

    def test_no_token_found_fallback(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """When no API key is found, 'No token found' is passed."""
        from graphs.llm import create_chat_model

        monkeypatch.delenv("OPENAI_API_KEY", raising=False)
        mock_model = MagicMock()

        with patch("graphs.llm.init_chat_model", return_value=mock_model) as mock_init:
            create_chat_model({}, model_name="openai:gpt-4o")

            call_kwargs = mock_init.call_args.kwargs
            assert call_kwargs["api_key"] == "No token found"

    def test_base_url_none_uses_standard_path(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Explicitly passing base_url=None uses the standard provider path."""
        from graphs.llm import create_chat_model

        monkeypatch.setenv("ANTHROPIC_API_KEY", "ant-key")
        mock_model = MagicMock()

        with patch("graphs.llm.init_chat_model", return_value=mock_model) as mock_init:
            create_chat_model(
                {},
                model_name="anthropic:claude-sonnet-4-20250514",
                base_url=None,
            )

            mock_init.assert_called_once()
            assert mock_init.call_args[0][0] == "anthropic:claude-sonnet-4-20250514"

    def test_base_url_empty_string_uses_standard_path(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Empty string base_url is treated as falsy → standard provider."""
        from graphs.llm import create_chat_model

        monkeypatch.setenv("OPENAI_API_KEY", "k")
        mock_model = MagicMock()

        with patch("graphs.llm.init_chat_model", return_value=mock_model) as mock_init:
            create_chat_model({}, model_name="openai:gpt-4o", base_url="")

            mock_init.assert_called_once()


# ============================================================================
# create_chat_model — return type
# ============================================================================


class TestCreateChatModelReturnType:
    """Verify the factory returns a BaseChatModel-compatible instance."""

    def test_returns_base_chat_model(self, monkeypatch: pytest.MonkeyPatch) -> None:
        from graphs.llm import create_chat_model

        monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
        mock_model = MagicMock()

        with patch("graphs.llm.init_chat_model", return_value=mock_model):
            result = create_chat_model({}, model_name="openai:gpt-4o")
            assert result is mock_model


# ============================================================================
# Module-level imports and exports
# ============================================================================


class TestModuleStructure:
    """Verify the shared modules are importable and export the right symbols."""

    def test_llm_module_importable(self) -> None:
        from graphs.llm import create_chat_model, get_api_key_for_model

        assert callable(create_chat_model)
        assert callable(get_api_key_for_model)

    def test_configuration_module_importable(self) -> None:
        from graphs.configuration import MCPConfig, MCPServerConfig, RagConfig

        assert MCPConfig is not None
        assert MCPServerConfig is not None
        assert RagConfig is not None

    def test_configuration_reexported_from_research_agent(self) -> None:
        """Research agent configuration re-exports shared models."""
        from graphs.research_agent.configuration import (
            MCPConfig,
            MCPServerConfig,
            RagConfig,
        )

        from graphs.configuration import (
            MCPConfig as SharedMCPConfig,
            MCPServerConfig as SharedMCPServerConfig,
            RagConfig as SharedRagConfig,
        )

        assert MCPConfig is SharedMCPConfig
        assert MCPServerConfig is SharedMCPServerConfig
        assert RagConfig is SharedRagConfig

    def test_react_agent_uses_shared_config_models(self) -> None:
        """React agent's GraphConfigPydantic references shared config models."""
        from graphs.react_agent.agent import GraphConfigPydantic

        from graphs.configuration import MCPConfig as SharedMCPConfig
        from graphs.configuration import RagConfig as SharedRagConfig

        # Verify the type annotations on GraphConfigPydantic reference the
        # shared models (not local duplicates).
        mcp_field = GraphConfigPydantic.model_fields["mcp_config"]
        rag_field = GraphConfigPydantic.model_fields["rag"]
        assert mcp_field.annotation is not None
        assert rag_field.annotation is not None

        # Instantiate and verify the nested models are from the shared module.
        cfg = GraphConfigPydantic(
            mcp_config={"servers": [{"name": "t", "url": "http://x"}]},
            rag={"rag_url": "http://r"},
        )
        assert type(cfg.mcp_config) is SharedMCPConfig
        assert type(cfg.rag) is SharedRagConfig

    def test_react_agent_uses_shared_llm_factory(self) -> None:
        """React agent imports create_chat_model from the shared llm module."""
        from graphs.react_agent.agent import create_chat_model

        from graphs.llm import create_chat_model as shared_fn

        assert create_chat_model is shared_fn


# ============================================================================
# _safe_mask_url (internal helper)
# ============================================================================


class TestSafeMaskUrl:
    """Tests for the LLM module's _safe_mask_url helper."""

    def test_none_returns_none(self) -> None:
        from graphs.llm import _safe_mask_url

        assert _safe_mask_url(None) is None

    def test_empty_returns_empty(self) -> None:
        from graphs.llm import _safe_mask_url

        assert _safe_mask_url("") == ""

    def test_plain_url_unchanged(self) -> None:
        from graphs.llm import _safe_mask_url

        assert _safe_mask_url("https://example.com/v1") == "https://example.com/v1"

    def test_strips_query_string(self) -> None:
        from graphs.llm import _safe_mask_url

        assert _safe_mask_url("https://api.com?token=secret") == "https://api.com"

    def test_strips_fragment(self) -> None:
        from graphs.llm import _safe_mask_url

        assert _safe_mask_url("https://api.com#section") == "https://api.com"

    def test_strips_both_query_and_fragment(self) -> None:
        from graphs.llm import _safe_mask_url

        assert _safe_mask_url("https://api.com/v1?a=b#c") == "https://api.com/v1"


# ============================================================================
# _PROVIDER_ENV_MAP completeness
# ============================================================================


class TestProviderEnvMap:
    """Verify the provider → env var mapping is complete."""

    def test_all_expected_providers_mapped(self) -> None:
        from graphs.llm import _PROVIDER_ENV_MAP

        expected_providers = {
            "openai",
            "anthropic",
            "google",
            "mistral",
            "groq",
            "fireworks",
        }
        assert set(_PROVIDER_ENV_MAP.keys()) == expected_providers

    def test_all_env_var_names_are_uppercase(self) -> None:
        from graphs.llm import _PROVIDER_ENV_MAP

        for env_var in _PROVIDER_ENV_MAP.values():
            assert env_var == env_var.upper(), f"{env_var} should be uppercase"
            assert env_var.endswith("_KEY") or env_var.endswith("_API_KEY"), (
                f"{env_var} should end with _KEY or _API_KEY"
            )


# ============================================================================
# create_chat_model — model_name_override (Task-03)
# ============================================================================


class TestModelNameOverride:
    """Tests for the model_name_override parameter in create_chat_model()."""

    def test_override_takes_precedence_standard_provider(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """model_name_override wins over model_name for standard provider."""
        from graphs.llm import create_chat_model

        monkeypatch.setenv("ANTHROPIC_API_KEY", "ant-key")
        mock_model = MagicMock()

        with patch("graphs.llm.init_chat_model", return_value=mock_model) as mock_init:
            result = create_chat_model(
                {},
                model_name="openai:gpt-4o",
                model_name_override="anthropic:claude-sonnet-4-20250514",
            )

            assert result is mock_model
            # The effective model passed to init_chat_model should be the override
            mock_init.assert_called_once()
            assert mock_init.call_args[0][0] == "anthropic:claude-sonnet-4-20250514"

    def test_override_takes_precedence_over_custom_model_name(self) -> None:
        """model_name_override wins over custom_model_name for custom endpoints."""
        from graphs.llm import create_chat_model

        mock_model = MagicMock()
        config = {"configurable": {"custom_api_key": "k"}}

        with patch("graphs.llm.ChatOpenAI", return_value=mock_model) as mock_cls:
            create_chat_model(
                config,
                model_name="custom:",
                base_url="http://vllm:8000/v1",
                custom_model_name="ministral-3b",
                model_name_override="gpt-4.1",
            )

            call_kwargs = mock_cls.call_args.kwargs
            assert call_kwargs["model"] == "gpt-4.1"

    def test_override_absent_uses_model_name(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """When override is None, falls back to model_name (no regression)."""
        from graphs.llm import create_chat_model

        monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
        mock_model = MagicMock()

        with patch("graphs.llm.init_chat_model", return_value=mock_model) as mock_init:
            create_chat_model(
                {},
                model_name="openai:gpt-4o",
                model_name_override=None,
            )

            assert mock_init.call_args[0][0] == "openai:gpt-4o"

    def test_override_absent_uses_custom_model_name(self) -> None:
        """When override is None but custom_model_name is set, custom wins."""
        from graphs.llm import create_chat_model

        mock_model = MagicMock()
        config = {"configurable": {"custom_api_key": "k"}}

        with patch("graphs.llm.ChatOpenAI", return_value=mock_model) as mock_cls:
            create_chat_model(
                config,
                model_name="custom:",
                base_url="http://vllm:8000/v1",
                custom_model_name="ministral-3b",
                model_name_override=None,
            )

            call_kwargs = mock_cls.call_args.kwargs
            assert call_kwargs["model"] == "ministral-3b"

    def test_override_empty_string_treated_as_none(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Empty string override is treated as absent."""
        from graphs.llm import create_chat_model

        monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
        mock_model = MagicMock()

        with patch("graphs.llm.init_chat_model", return_value=mock_model) as mock_init:
            create_chat_model(
                {},
                model_name="openai:gpt-4o",
                model_name_override="",
            )

            assert mock_init.call_args[0][0] == "openai:gpt-4o"

    def test_override_changes_api_key_provider(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Override that changes provider resolves the correct API key."""
        from graphs.llm import create_chat_model

        monkeypatch.setenv("ANTHROPIC_API_KEY", "ant-key-123")
        monkeypatch.delenv("OPENAI_API_KEY", raising=False)
        mock_model = MagicMock()

        with patch("graphs.llm.init_chat_model", return_value=mock_model) as mock_init:
            create_chat_model(
                {},
                model_name="openai:gpt-4o",
                model_name_override="anthropic:claude-sonnet-4-20250514",
            )

            call_kwargs = mock_init.call_args.kwargs
            assert call_kwargs["api_key"] == "ant-key-123"

    def test_override_logging(
        self, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
    ) -> None:
        """INFO log message appears when override is active."""
        from graphs.llm import create_chat_model

        monkeypatch.setenv("ANTHROPIC_API_KEY", "k")
        mock_model = MagicMock()

        with (
            patch("graphs.llm.init_chat_model", return_value=mock_model),
            caplog.at_level(logging.INFO, logger="graphs.llm"),
        ):
            create_chat_model(
                {},
                model_name="openai:gpt-4o",
                model_name_override="anthropic:claude-sonnet-4-20250514",
            )

        assert any("LLM model override active" in msg for msg in caplog.messages)
        assert any(
            "openai:gpt-4o" in msg and "anthropic:claude-sonnet-4-20250514" in msg
            for msg in caplog.messages
        )

    def test_override_same_as_model_name_no_log(
        self, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
    ) -> None:
        """When override equals model_name, no override log message is emitted."""
        from graphs.llm import create_chat_model

        monkeypatch.setenv("OPENAI_API_KEY", "k")
        mock_model = MagicMock()

        with (
            patch("graphs.llm.init_chat_model", return_value=mock_model),
            caplog.at_level(logging.INFO, logger="graphs.llm"),
        ):
            create_chat_model(
                {},
                model_name="openai:gpt-4o",
                model_name_override="openai:gpt-4o",
            )

        assert not any("LLM model override active" in msg for msg in caplog.messages)


# ============================================================================
# create_chat_model — routing_metadata (Task-04)
# ============================================================================


class TestRoutingMetadata:
    """Tests for the routing_metadata parameter in create_chat_model()."""

    def test_metadata_headers_injected_custom_endpoint(self) -> None:
        """routing_metadata is passed as default_headers to ChatOpenAI."""
        from graphs.llm import create_chat_model

        mock_model = MagicMock()
        config = {"configurable": {"custom_api_key": "k"}}
        metadata = {"x-sr-graph-id": "agent", "x-sr-org-id": "acme"}

        with patch("graphs.llm.ChatOpenAI", return_value=mock_model) as mock_cls:
            create_chat_model(
                config,
                model_name="custom:",
                base_url="http://vllm:8000/v1",
                routing_metadata=metadata,
            )

            call_kwargs = mock_cls.call_args.kwargs
            assert call_kwargs["default_headers"] == {
                "x-sr-graph-id": "agent",
                "x-sr-org-id": "acme",
            }

    def test_metadata_headers_injected_standard_provider(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """routing_metadata is passed as default_headers to init_chat_model."""
        from graphs.llm import create_chat_model

        monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
        mock_model = MagicMock()
        metadata = {"x-sr-graph-id": "research_agent"}

        with patch("graphs.llm.init_chat_model", return_value=mock_model) as mock_init:
            create_chat_model(
                {},
                model_name="openai:gpt-4o",
                routing_metadata=metadata,
            )

            call_kwargs = mock_init.call_args.kwargs
            assert call_kwargs["default_headers"] == {
                "x-sr-graph-id": "research_agent",
            }

    def test_empty_metadata_no_headers(self) -> None:
        """Empty routing_metadata dict → no default_headers kwarg passed."""
        from graphs.llm import create_chat_model

        mock_model = MagicMock()
        config = {"configurable": {"custom_api_key": "k"}}

        with patch("graphs.llm.ChatOpenAI", return_value=mock_model) as mock_cls:
            create_chat_model(
                config,
                model_name="custom:",
                base_url="http://vllm:8000/v1",
                routing_metadata={},
            )

            call_kwargs = mock_cls.call_args.kwargs
            assert "default_headers" not in call_kwargs

    def test_none_metadata_no_headers(self) -> None:
        """None routing_metadata → no default_headers kwarg passed."""
        from graphs.llm import create_chat_model

        mock_model = MagicMock()
        config = {"configurable": {"custom_api_key": "k"}}

        with patch("graphs.llm.ChatOpenAI", return_value=mock_model) as mock_cls:
            create_chat_model(
                config,
                model_name="custom:",
                base_url="http://vllm:8000/v1",
                routing_metadata=None,
            )

            call_kwargs = mock_cls.call_args.kwargs
            assert "default_headers" not in call_kwargs

    def test_metadata_filters_empty_values(self) -> None:
        """Empty string values in routing_metadata are excluded from headers."""
        from graphs.llm import create_chat_model

        mock_model = MagicMock()
        config = {"configurable": {"custom_api_key": "k"}}
        metadata = {
            "x-sr-graph-id": "agent",
            "x-sr-org-id": "",
            "x-sr-user-tier": "premium",
        }

        with patch("graphs.llm.ChatOpenAI", return_value=mock_model) as mock_cls:
            create_chat_model(
                config,
                model_name="custom:",
                base_url="http://vllm:8000/v1",
                routing_metadata=metadata,
            )

            call_kwargs = mock_cls.call_args.kwargs
            assert call_kwargs["default_headers"] == {
                "x-sr-graph-id": "agent",
                "x-sr-user-tier": "premium",
            }

    def test_metadata_filters_non_string_values(self) -> None:
        """Non-string values in routing_metadata are excluded from headers."""
        from graphs.llm import create_chat_model

        mock_model = MagicMock()
        config = {"configurable": {"custom_api_key": "k"}}
        metadata = {
            "x-sr-graph-id": "agent",
            "x-sr-count": 42,  # type: ignore[dict-item]
            "x-sr-flag": True,  # type: ignore[dict-item]
        }

        with patch("graphs.llm.ChatOpenAI", return_value=mock_model) as mock_cls:
            create_chat_model(
                config,
                model_name="custom:",
                base_url="http://vllm:8000/v1",
                routing_metadata=metadata,
            )

            call_kwargs = mock_cls.call_args.kwargs
            assert call_kwargs["default_headers"] == {"x-sr-graph-id": "agent"}

    def test_metadata_all_filtered_no_headers(self) -> None:
        """When all metadata values are filtered out, no default_headers is passed."""
        from graphs.llm import create_chat_model

        mock_model = MagicMock()
        config = {"configurable": {"custom_api_key": "k"}}
        metadata = {"x-sr-org-id": "", "x-sr-count": 42}  # type: ignore[dict-item]

        with patch("graphs.llm.ChatOpenAI", return_value=mock_model) as mock_cls:
            create_chat_model(
                config,
                model_name="custom:",
                base_url="http://vllm:8000/v1",
                routing_metadata=metadata,
            )

            call_kwargs = mock_cls.call_args.kwargs
            assert "default_headers" not in call_kwargs

    def test_metadata_logging_keys_only(
        self, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
    ) -> None:
        """Routing metadata log shows keys but not values."""
        from graphs.llm import create_chat_model

        monkeypatch.setenv("OPENAI_API_KEY", "k")
        mock_model = MagicMock()
        metadata = {"x-sr-org-id": "secret-org-123", "x-sr-graph-id": "agent"}

        with (
            patch("graphs.llm.init_chat_model", return_value=mock_model),
            caplog.at_level(logging.INFO, logger="graphs.llm"),
        ):
            create_chat_model(
                {},
                model_name="openai:gpt-4o",
                routing_metadata=metadata,
            )

        metadata_log = [msg for msg in caplog.messages if "LLM routing metadata" in msg]
        assert len(metadata_log) == 1
        # Keys appear in the log
        assert "x-sr-org-id" in metadata_log[0]
        assert "x-sr-graph-id" in metadata_log[0]
        # Values do NOT appear in the log
        assert "secret-org-123" not in metadata_log[0]


# ============================================================================
# create_chat_model — semantic router env vars (Task-04)
# ============================================================================


class TestSemanticRouterEnvVars:
    """Tests for SEMANTIC_ROUTER_ENABLED/URL/MODEL env var support."""

    def test_router_enabled_overrides_base_url_and_model(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """SEMANTIC_ROUTER_ENABLED=true overrides base_url and model."""
        from graphs.llm import create_chat_model

        monkeypatch.setenv("SEMANTIC_ROUTER_ENABLED", "true")
        monkeypatch.setenv("SEMANTIC_ROUTER_URL", "http://router:8888/v1")
        monkeypatch.setenv("SEMANTIC_ROUTER_MODEL", "MoM")
        monkeypatch.delenv("CUSTOM_API_KEY", raising=False)
        monkeypatch.delenv("OPENAI_API_KEY", raising=False)

        mock_model = MagicMock()

        with patch("graphs.llm.ChatOpenAI", return_value=mock_model) as mock_cls:
            create_chat_model(
                {"configurable": {}},
                model_name="openai:gpt-4o",
            )

            call_kwargs = mock_cls.call_args.kwargs
            assert call_kwargs["openai_api_base"] == "http://router:8888/v1"
            assert call_kwargs["model"] == "MoM"

    def test_router_enabled_default_model_is_mom(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """When SEMANTIC_ROUTER_MODEL is unset, defaults to 'MoM'."""
        from graphs.llm import create_chat_model

        monkeypatch.setenv("SEMANTIC_ROUTER_ENABLED", "true")
        monkeypatch.setenv("SEMANTIC_ROUTER_URL", "http://router:8888/v1")
        monkeypatch.delenv("SEMANTIC_ROUTER_MODEL", raising=False)
        monkeypatch.delenv("CUSTOM_API_KEY", raising=False)
        monkeypatch.delenv("OPENAI_API_KEY", raising=False)

        mock_model = MagicMock()

        with patch("graphs.llm.ChatOpenAI", return_value=mock_model) as mock_cls:
            create_chat_model(
                {"configurable": {}},
                model_name="openai:gpt-4o",
            )

            call_kwargs = mock_cls.call_args.kwargs
            assert call_kwargs["model"] == "MoM"

    def test_router_disabled_no_override(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """SEMANTIC_ROUTER_ENABLED=false → no override, standard path used."""
        from graphs.llm import create_chat_model

        monkeypatch.setenv("SEMANTIC_ROUTER_ENABLED", "false")
        monkeypatch.setenv("SEMANTIC_ROUTER_URL", "http://router:8888/v1")
        monkeypatch.setenv("OPENAI_API_KEY", "sk-test")

        mock_model = MagicMock()

        with patch("graphs.llm.init_chat_model", return_value=mock_model) as mock_init:
            create_chat_model({}, model_name="openai:gpt-4o")

            # Should use standard provider path, NOT the router
            mock_init.assert_called_once()
            assert mock_init.call_args[0][0] == "openai:gpt-4o"

    def test_router_default_is_disabled(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """When SEMANTIC_ROUTER_ENABLED is unset, defaults to disabled."""
        from graphs.llm import create_chat_model

        monkeypatch.delenv("SEMANTIC_ROUTER_ENABLED", raising=False)
        monkeypatch.setenv("OPENAI_API_KEY", "sk-test")

        mock_model = MagicMock()

        with patch("graphs.llm.init_chat_model", return_value=mock_model) as mock_init:
            create_chat_model({}, model_name="openai:gpt-4o")

            mock_init.assert_called_once()
            assert mock_init.call_args[0][0] == "openai:gpt-4o"

    def test_router_enabled_without_url_graceful(
        self, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
    ) -> None:
        """SEMANTIC_ROUTER_ENABLED=true without URL → warning, no crash."""
        from graphs.llm import create_chat_model

        monkeypatch.setenv("SEMANTIC_ROUTER_ENABLED", "true")
        monkeypatch.delenv("SEMANTIC_ROUTER_URL", raising=False)
        monkeypatch.setenv("OPENAI_API_KEY", "sk-test")

        mock_model = MagicMock()

        with (
            patch("graphs.llm.init_chat_model", return_value=mock_model) as mock_init,
            caplog.at_level(logging.WARNING, logger="graphs.llm"),
        ):
            create_chat_model({}, model_name="openai:gpt-4o")

            # Falls through to standard provider
            mock_init.assert_called_once()
            assert mock_init.call_args[0][0] == "openai:gpt-4o"

        assert any("SEMANTIC_ROUTER_URL is not set" in msg for msg in caplog.messages)

    def test_router_explicit_override_takes_precedence(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Caller-set model_name_override is NOT overwritten by router model."""
        from graphs.llm import create_chat_model

        monkeypatch.setenv("SEMANTIC_ROUTER_ENABLED", "true")
        monkeypatch.setenv("SEMANTIC_ROUTER_URL", "http://router:8888/v1")
        monkeypatch.setenv("SEMANTIC_ROUTER_MODEL", "MoM")
        monkeypatch.delenv("CUSTOM_API_KEY", raising=False)
        monkeypatch.delenv("OPENAI_API_KEY", raising=False)

        mock_model = MagicMock()

        with patch("graphs.llm.ChatOpenAI", return_value=mock_model) as mock_cls:
            create_chat_model(
                {"configurable": {}},
                model_name="openai:gpt-4o",
                model_name_override="specific-model-v2",
            )

            call_kwargs = mock_cls.call_args.kwargs
            # base_url should be overridden to router URL
            assert call_kwargs["openai_api_base"] == "http://router:8888/v1"
            # But model should be the caller's explicit override, not MoM
            assert call_kwargs["model"] == "specific-model-v2"

    def test_router_logging(
        self, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
    ) -> None:
        """Router mode emits an INFO log with the router URL and model."""
        from graphs.llm import create_chat_model

        monkeypatch.setenv("SEMANTIC_ROUTER_ENABLED", "true")
        monkeypatch.setenv("SEMANTIC_ROUTER_URL", "http://router:8888/v1")
        monkeypatch.setenv("SEMANTIC_ROUTER_MODEL", "MoM")
        monkeypatch.delenv("CUSTOM_API_KEY", raising=False)
        monkeypatch.delenv("OPENAI_API_KEY", raising=False)

        mock_model = MagicMock()

        with (
            patch("graphs.llm.ChatOpenAI", return_value=mock_model),
            caplog.at_level(logging.INFO, logger="graphs.llm"),
        ):
            create_chat_model(
                {"configurable": {}},
                model_name="openai:gpt-4o",
            )

        assert any(
            "Semantic router: dynamic routing" in msg and "router:8888" in msg
            for msg in caplog.messages
        )

    def test_router_case_insensitive_enabled(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """SEMANTIC_ROUTER_ENABLED is case-insensitive (True, TRUE, etc.)."""
        from graphs.llm import create_chat_model

        monkeypatch.setenv("SEMANTIC_ROUTER_ENABLED", "True")
        monkeypatch.setenv("SEMANTIC_ROUTER_URL", "http://router:8888/v1")
        monkeypatch.delenv("CUSTOM_API_KEY", raising=False)
        monkeypatch.delenv("OPENAI_API_KEY", raising=False)

        mock_model = MagicMock()

        with patch("graphs.llm.ChatOpenAI", return_value=mock_model) as mock_cls:
            create_chat_model(
                {"configurable": {}},
                model_name="openai:gpt-4o",
            )

            call_kwargs = mock_cls.call_args.kwargs
            assert call_kwargs["openai_api_base"] == "http://router:8888/v1"


# ============================================================================
# Combined: model_name_override + routing_metadata + router env vars
# ============================================================================


class TestCombinedOverrideAndMetadata:
    """Tests for combined usage of override, metadata, and router env vars."""

    def test_override_and_metadata_together(self) -> None:
        """Both model_name_override and routing_metadata work simultaneously."""
        from graphs.llm import create_chat_model

        mock_model = MagicMock()
        config = {"configurable": {"custom_api_key": "k"}}
        metadata = {"x-sr-graph-id": "agent", "x-sr-org-id": "acme"}

        with patch("graphs.llm.ChatOpenAI", return_value=mock_model) as mock_cls:
            create_chat_model(
                config,
                model_name="custom:",
                base_url="http://vllm:8000/v1",
                custom_model_name="ministral-3b",
                model_name_override="gpt-4.1",
                routing_metadata=metadata,
            )

            call_kwargs = mock_cls.call_args.kwargs
            assert call_kwargs["model"] == "gpt-4.1"
            assert call_kwargs["default_headers"] == {
                "x-sr-graph-id": "agent",
                "x-sr-org-id": "acme",
            }

    def test_router_env_with_metadata(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Router env vars + routing_metadata both apply correctly."""
        from graphs.llm import create_chat_model

        monkeypatch.setenv("SEMANTIC_ROUTER_ENABLED", "true")
        monkeypatch.setenv("SEMANTIC_ROUTER_URL", "http://router:8888/v1")
        monkeypatch.setenv("SEMANTIC_ROUTER_MODEL", "MoM")
        monkeypatch.delenv("CUSTOM_API_KEY", raising=False)
        monkeypatch.delenv("OPENAI_API_KEY", raising=False)

        mock_model = MagicMock()
        metadata = {"x-sr-graph-id": "agent"}

        with patch("graphs.llm.ChatOpenAI", return_value=mock_model) as mock_cls:
            create_chat_model(
                {"configurable": {}},
                model_name="openai:gpt-4o",
                routing_metadata=metadata,
            )

            call_kwargs = mock_cls.call_args.kwargs
            assert call_kwargs["openai_api_base"] == "http://router:8888/v1"
            assert call_kwargs["model"] == "MoM"
            assert call_kwargs["default_headers"] == {"x-sr-graph-id": "agent"}

    def test_router_skips_when_agent_has_custom_base_url(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Router does NOT override a caller-provided base_url.

        When an agent has ``base_url="http://vllm-ministral:8000/v1"`` pointing
        at its own backend, the router must NOT hijack it.  The agent talks
        directly to its own endpoint and skips the router entirely.
        """
        from graphs.llm import create_chat_model

        monkeypatch.setenv("SEMANTIC_ROUTER_ENABLED", "true")
        monkeypatch.setenv("SEMANTIC_ROUTER_URL", "http://router:8801/v1")
        monkeypatch.setenv("SEMANTIC_ROUTER_MODEL", "MoM")
        monkeypatch.delenv("CUSTOM_API_KEY", raising=False)
        monkeypatch.delenv("OPENAI_API_KEY", raising=False)

        mock_model = MagicMock()

        with patch("graphs.llm.ChatOpenAI", return_value=mock_model) as mock_cls:
            create_chat_model(
                {"configurable": {}},
                model_name="custom:",
                # Agent has its own vLLM endpoint — router must not hijack it
                base_url="http://vllm-ministral:8000/v1",
                custom_model_name="ministral-3b-instruct",
            )

            call_kwargs = mock_cls.call_args.kwargs
            # Agent's base_url is preserved (NOT overridden by router)
            assert call_kwargs["openai_api_base"] == "http://vllm-ministral:8000/v1"
            # Agent's custom_model_name is preserved (NOT overridden by MoM)
            assert call_kwargs["model"] == "ministral-3b-instruct"

    def test_router_respects_agent_pinned_custom_model_name(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Agent-pinned custom_model_name is respected — router does NOT override it with MoM.

        When an agent has ``custom_model_name`` set at creation time, the router
        routes the call through the proxy but uses the pinned model as-is
        (passthrough, no reclassification).
        """
        from graphs.llm import create_chat_model

        monkeypatch.setenv("SEMANTIC_ROUTER_ENABLED", "true")
        monkeypatch.setenv("SEMANTIC_ROUTER_URL", "http://router:8801/v1")
        monkeypatch.setenv("SEMANTIC_ROUTER_MODEL", "MoM")
        monkeypatch.delenv("CUSTOM_API_KEY", raising=False)
        monkeypatch.delenv("OPENAI_API_KEY", raising=False)

        mock_model = MagicMock()

        with patch("graphs.llm.ChatOpenAI", return_value=mock_model) as mock_cls:
            create_chat_model(
                {"configurable": {}},
                model_name="openai:gpt-4o",
                custom_model_name="ministral-3b-instruct",
            )

            call_kwargs = mock_cls.call_args.kwargs
            # Agent's pinned model is preserved (NOT overridden by MoM)
            assert call_kwargs["model"] == "ministral-3b-instruct"
            # Call still goes through the router URL
            assert call_kwargs["openai_api_base"] == "http://router:8801/v1"

    def test_full_integration_agent_with_custom_base_url_skips_router(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Full integration: agent with custom base_url skips router entirely.

        Verifies correct behaviour when ALL parameters interact simultaneously:
        - Agent's base_url is preserved (router does NOT hijack)
        - Agent's custom_model_name is preserved (NOT overridden by MoM)
        - Routing metadata headers are still forwarded (useful for logging)
        - API key from configurable is used (custom endpoint path)
        """
        from graphs.llm import create_chat_model

        monkeypatch.setenv("SEMANTIC_ROUTER_ENABLED", "true")
        monkeypatch.setenv("SEMANTIC_ROUTER_URL", "http://router:8801/v1")
        monkeypatch.setenv("SEMANTIC_ROUTER_MODEL", "MoM")
        monkeypatch.delenv("CUSTOM_API_KEY", raising=False)
        monkeypatch.delenv("OPENAI_API_KEY", raising=False)

        mock_model = MagicMock()
        metadata = {
            "x-sr-graph-id": "react-agent",
            "x-sr-org-id": "org-42",
            "x-sr-task-type": "extraction",
        }

        with patch("graphs.llm.ChatOpenAI", return_value=mock_model) as mock_cls:
            create_chat_model(
                {"configurable": {"custom_api_key": "sk-secret-key"}},
                model_name="custom:",
                base_url="http://vllm:8000/v1",
                custom_model_name="ministral-3b-instruct",
                temperature=0.2,
                max_tokens=4096,
                routing_metadata=metadata,
            )

            call_kwargs = mock_cls.call_args.kwargs
            # Agent's base_url is preserved (router skipped)
            assert call_kwargs["openai_api_base"] == "http://vllm:8000/v1"
            # Agent's custom_model_name is preserved (NOT MoM)
            assert call_kwargs["model"] == "ministral-3b-instruct"
            # API key from configurable flows through
            assert call_kwargs["openai_api_key"] == "sk-secret-key"
            # Temperature and max_tokens preserved
            assert call_kwargs["temperature"] == 0.2
            assert call_kwargs["max_tokens"] == 4096
            # Metadata headers are still forwarded (for logging/tracing)
            assert call_kwargs["default_headers"] == {
                "x-sr-graph-id": "react-agent",
                "x-sr-org-id": "org-42",
                "x-sr-task-type": "extraction",
            }

    def test_full_integration_router_dynamic_no_pins(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Full integration: no agent-level pins → router uses MoM for dynamic routing.

        When no base_url, custom_model_name, or model_name_override is set,
        the router takes full control: base_url is set to the router URL and
        model is set to MoM for dynamic classification.
        """
        from graphs.llm import create_chat_model

        monkeypatch.setenv("SEMANTIC_ROUTER_ENABLED", "true")
        monkeypatch.setenv("SEMANTIC_ROUTER_URL", "http://router:8801/v1")
        monkeypatch.setenv("SEMANTIC_ROUTER_MODEL", "MoM")
        monkeypatch.delenv("CUSTOM_API_KEY", raising=False)
        monkeypatch.delenv("OPENAI_API_KEY", raising=False)

        mock_model = MagicMock()
        metadata = {
            "x-sr-graph-id": "react-agent",
            "x-sr-org-id": "org-42",
        }

        with patch("graphs.llm.ChatOpenAI", return_value=mock_model) as mock_cls:
            create_chat_model(
                {"configurable": {}},
                model_name="openai:gpt-4o",
                temperature=0.2,
                max_tokens=4096,
                routing_metadata=metadata,
            )

            call_kwargs = mock_cls.call_args.kwargs
            # Router URL is used (no agent base_url to preserve)
            assert call_kwargs["openai_api_base"] == "http://router:8801/v1"
            # MoM for dynamic classification (no pins)
            assert call_kwargs["model"] == "MoM"
            assert call_kwargs["temperature"] == 0.2
            assert call_kwargs["max_tokens"] == 4096
            assert call_kwargs["default_headers"] == {
                "x-sr-graph-id": "react-agent",
                "x-sr-org-id": "org-42",
            }
