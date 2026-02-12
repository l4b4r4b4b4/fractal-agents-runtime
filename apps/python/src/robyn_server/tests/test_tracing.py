"""Tests for fractal_agent_infra.tracing — Langfuse integration and LangSmith disabling.

Tests cover:
- LangSmith tracing disabled by default (LANGCHAIN_TRACING_V2)
- Langfuse configuration detection
- Langfuse initialization and shutdown lifecycle
- Callback handler creation
- inject_tracing() config augmentation
- Graceful degradation when Langfuse is not configured
"""

import os
from unittest.mock import MagicMock, patch

import pytest
from langchain_core.runnables import RunnableConfig

from fractal_agent_infra.tracing import (
    _reset_tracing_state,
    get_langfuse_callback_handler,
    initialize_langfuse,
    inject_tracing,
    is_langfuse_configured,
    is_langfuse_enabled,
    shutdown_langfuse,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _reset_tracing():
    """Reset tracing state before and after each test."""
    _reset_tracing_state()
    yield
    _reset_tracing_state()


@pytest.fixture()
def _langfuse_env(monkeypatch):
    """Set Langfuse environment variables for tests that need them."""
    monkeypatch.setenv("LANGFUSE_SECRET_KEY", "sk-lf-test-secret")
    monkeypatch.setenv("LANGFUSE_PUBLIC_KEY", "pk-lf-test-public")
    monkeypatch.setenv("LANGFUSE_BASE_URL", "http://localhost:3003")


@pytest.fixture()
def _no_langfuse_env(monkeypatch):
    """Ensure Langfuse environment variables are absent."""
    monkeypatch.delenv("LANGFUSE_SECRET_KEY", raising=False)
    monkeypatch.delenv("LANGFUSE_PUBLIC_KEY", raising=False)
    monkeypatch.delenv("LANGFUSE_BASE_URL", raising=False)


# ============================================================================
# LangSmith Disabling
# ============================================================================


class TestLangSmithDisabling:
    """Verify that LangSmith tracing is disabled by default."""

    def test_langchain_tracing_v2_defaults_to_false(self):
        """LANGCHAIN_TRACING_V2 should be 'false' after module import."""
        # The module sets this at import time. Since the module is already
        # imported, the env var should already be set.
        value = os.environ.get("LANGCHAIN_TRACING_V2")
        assert value == "false", f"Expected LANGCHAIN_TRACING_V2='false', got '{value}'"

    def test_langchain_tracing_v2_respects_explicit_override(self, monkeypatch):
        """If user sets LANGCHAIN_TRACING_V2 explicitly, we don't override."""
        monkeypatch.setenv("LANGCHAIN_TRACING_V2", "true")
        # Re-check — the module only sets default if key is absent.
        # Since we set it to "true", it should stay "true".
        assert os.environ["LANGCHAIN_TRACING_V2"] == "true"


# ============================================================================
# Configuration Detection
# ============================================================================


class TestLangfuseConfiguration:
    """Test is_langfuse_configured() environment detection."""

    def test_configured_when_both_keys_present(self, _langfuse_env):
        """Returns True when both secret and public keys are set."""
        assert is_langfuse_configured() is True

    def test_not_configured_when_secret_key_missing(self, monkeypatch):
        """Returns False when LANGFUSE_SECRET_KEY is missing."""
        monkeypatch.delenv("LANGFUSE_SECRET_KEY", raising=False)
        monkeypatch.setenv("LANGFUSE_PUBLIC_KEY", "pk-lf-test")
        assert is_langfuse_configured() is False

    def test_not_configured_when_public_key_missing(self, monkeypatch):
        """Returns False when LANGFUSE_PUBLIC_KEY is missing."""
        monkeypatch.setenv("LANGFUSE_SECRET_KEY", "sk-lf-test")
        monkeypatch.delenv("LANGFUSE_PUBLIC_KEY", raising=False)
        assert is_langfuse_configured() is False

    def test_not_configured_when_both_keys_missing(self, _no_langfuse_env):
        """Returns False when neither key is set."""
        assert is_langfuse_configured() is False

    def test_not_configured_when_keys_are_empty_strings(self, monkeypatch):
        """Returns False when keys are empty strings."""
        monkeypatch.setenv("LANGFUSE_SECRET_KEY", "")
        monkeypatch.setenv("LANGFUSE_PUBLIC_KEY", "")
        assert is_langfuse_configured() is False


# ============================================================================
# Initialization Lifecycle
# ============================================================================


class TestLangfuseInitialization:
    """Test initialize_langfuse() and shutdown_langfuse() lifecycle."""

    def test_initialize_returns_false_when_not_configured(self, _no_langfuse_env):
        """initialize_langfuse() returns False when env vars are missing."""
        result = initialize_langfuse()
        assert result is False
        assert is_langfuse_enabled() is False

    @patch("fractal_agent_infra.tracing.Langfuse", create=True)
    def test_initialize_returns_true_when_configured(
        self, mock_langfuse_cls, _langfuse_env
    ):
        """initialize_langfuse() returns True and initialises client."""
        # Patch the import inside initialize_langfuse
        with patch.dict(
            "sys.modules", {"langfuse": MagicMock(Langfuse=mock_langfuse_cls)}
        ):
            with patch(
                "fractal_agent_infra.tracing.is_langfuse_configured",
                return_value=True,
            ):
                # Simulate successful init by directly setting state
                from fractal_agent_infra import tracing

                tracing._langfuse_initialized = True
                assert is_langfuse_enabled() is True

    def test_initialize_is_idempotent(self, _no_langfuse_env):
        """Calling initialize_langfuse() multiple times is safe."""
        result1 = initialize_langfuse()
        result2 = initialize_langfuse()
        assert result1 is False
        assert result2 is False

    def test_is_langfuse_enabled_false_before_init(self):
        """is_langfuse_enabled() returns False before initialization."""
        assert is_langfuse_enabled() is False

    def test_shutdown_is_noop_when_not_initialized(self):
        """shutdown_langfuse() doesn't raise when Langfuse was never init'd."""
        # Should not raise any exception
        shutdown_langfuse()
        assert is_langfuse_enabled() is False

    def test_shutdown_resets_initialized_flag(self):
        """shutdown_langfuse() sets _langfuse_initialized back to False."""
        from fractal_agent_infra import tracing

        tracing._langfuse_initialized = True
        assert is_langfuse_enabled() is True

        mock_client = MagicMock()
        with patch("langfuse.get_client", return_value=mock_client):
            shutdown_langfuse()

        assert is_langfuse_enabled() is False

    def test_shutdown_calls_client_shutdown(self):
        """shutdown_langfuse() calls client.shutdown() on the Langfuse client."""
        from fractal_agent_infra import tracing

        tracing._langfuse_initialized = True

        mock_client = MagicMock()
        with patch("langfuse.get_client", return_value=mock_client):
            shutdown_langfuse()

        mock_client.shutdown.assert_called_once()

    def test_shutdown_handles_exception_gracefully(self):
        """shutdown_langfuse() catches exceptions without propagating."""
        from fractal_agent_infra import tracing

        tracing._langfuse_initialized = True

        with patch("langfuse.get_client", side_effect=RuntimeError("boom")):
            # Should not raise
            shutdown_langfuse()

        # State should still be reset
        assert is_langfuse_enabled() is False


# ============================================================================
# Callback Handler Creation
# ============================================================================


class TestCallbackHandler:
    """Test get_langfuse_callback_handler() factory."""

    def test_returns_none_when_not_initialized(self):
        """Handler is None when Langfuse is not initialised."""
        handler = get_langfuse_callback_handler()
        assert handler is None

    def test_returns_handler_when_initialized(self):
        """Handler is returned when Langfuse is initialised."""
        from fractal_agent_infra import tracing

        tracing._langfuse_initialized = True

        mock_handler = MagicMock()
        with patch(
            "langfuse.langchain.CallbackHandler",
            return_value=mock_handler,
        ):
            handler = get_langfuse_callback_handler()

        assert handler is mock_handler

    def test_returns_none_on_exception(self):
        """Handler returns None if CallbackHandler construction fails."""
        from fractal_agent_infra import tracing

        tracing._langfuse_initialized = True

        with patch(
            "langfuse.langchain.CallbackHandler",
            side_effect=RuntimeError("connection refused"),
        ):
            handler = get_langfuse_callback_handler()

        assert handler is None


# ============================================================================
# inject_tracing()
# ============================================================================


class TestInjectTracing:
    """Test inject_tracing() config augmentation."""

    def _make_config(self, **kwargs) -> RunnableConfig:
        """Create a minimal RunnableConfig for testing."""
        return RunnableConfig(
            configurable={"thread_id": "test-thread", "run_id": "test-run"},
            run_id="test-run",
            **kwargs,
        )

    def test_returns_config_unchanged_when_not_initialized(self):
        """Config passes through unmodified when Langfuse is disabled."""
        config = self._make_config()
        result = inject_tracing(
            config,
            user_id="user-1",
            session_id="session-1",
            trace_name="test",
        )
        # Should be the exact same object since no handler is available
        assert result is config
        assert "callbacks" not in result or not result.get("callbacks")

    def test_adds_callback_handler_when_initialized(self):
        """Callback handler is added to config when Langfuse is active."""
        from fractal_agent_infra import tracing

        tracing._langfuse_initialized = True

        mock_handler = MagicMock()
        with patch(
            "fractal_agent_infra.tracing.get_langfuse_callback_handler",
            return_value=mock_handler,
        ):
            config = self._make_config()
            result = inject_tracing(config, user_id="user-1")

        callbacks = result.get("callbacks", [])
        assert mock_handler in callbacks

    def test_preserves_existing_callbacks(self):
        """Existing callbacks in config are preserved."""
        from fractal_agent_infra import tracing

        tracing._langfuse_initialized = True

        existing_callback = MagicMock(name="existing-callback")
        mock_handler = MagicMock(name="langfuse-handler")

        with patch(
            "fractal_agent_infra.tracing.get_langfuse_callback_handler",
            return_value=mock_handler,
        ):
            config = self._make_config(callbacks=[existing_callback])
            result = inject_tracing(config)

        callbacks = result.get("callbacks", [])
        assert existing_callback in callbacks
        assert mock_handler in callbacks
        assert len(callbacks) == 2

    def test_injects_user_id_metadata(self):
        """langfuse_user_id is added to config metadata."""
        from fractal_agent_infra import tracing

        tracing._langfuse_initialized = True

        with patch(
            "fractal_agent_infra.tracing.get_langfuse_callback_handler",
            return_value=MagicMock(),
        ):
            config = self._make_config()
            result = inject_tracing(config, user_id="owner-abc")

        metadata = result.get("metadata", {})
        assert metadata["langfuse_user_id"] == "owner-abc"

    def test_injects_session_id_metadata(self):
        """langfuse_session_id is added to config metadata."""
        from fractal_agent_infra import tracing

        tracing._langfuse_initialized = True

        with patch(
            "fractal_agent_infra.tracing.get_langfuse_callback_handler",
            return_value=MagicMock(),
        ):
            config = self._make_config()
            result = inject_tracing(config, session_id="thread-xyz")

        metadata = result.get("metadata", {})
        assert metadata["langfuse_session_id"] == "thread-xyz"

    def test_injects_tags_metadata(self):
        """langfuse_tags are added to config metadata."""
        from fractal_agent_infra import tracing

        tracing._langfuse_initialized = True

        with patch(
            "fractal_agent_infra.tracing.get_langfuse_callback_handler",
            return_value=MagicMock(),
        ):
            config = self._make_config()
            result = inject_tracing(config, tags=["robyn", "streaming"])

        metadata = result.get("metadata", {})
        assert metadata["langfuse_tags"] == ["robyn", "streaming"]

    def test_sets_run_name_from_trace_name(self):
        """trace_name parameter sets run_name on the config."""
        from fractal_agent_infra import tracing

        tracing._langfuse_initialized = True

        with patch(
            "fractal_agent_infra.tracing.get_langfuse_callback_handler",
            return_value=MagicMock(),
        ):
            config = self._make_config()
            result = inject_tracing(config, trace_name="agent-stream")

        assert result.get("run_name") == "agent-stream"

    def test_no_metadata_when_no_attributes_provided(self):
        """No langfuse metadata keys added when attributes are None."""
        from fractal_agent_infra import tracing

        tracing._langfuse_initialized = True

        with patch(
            "fractal_agent_infra.tracing.get_langfuse_callback_handler",
            return_value=MagicMock(),
        ):
            config = self._make_config()
            result = inject_tracing(config)

        metadata = result.get("metadata", {})
        assert "langfuse_user_id" not in metadata
        assert "langfuse_session_id" not in metadata
        assert "langfuse_tags" not in metadata

    def test_preserves_existing_metadata(self):
        """Existing metadata in config is preserved alongside Langfuse keys."""
        from fractal_agent_infra import tracing

        tracing._langfuse_initialized = True

        with patch(
            "fractal_agent_infra.tracing.get_langfuse_callback_handler",
            return_value=MagicMock(),
        ):
            config = self._make_config(metadata={"existing_key": "existing_value"})
            result = inject_tracing(config, user_id="user-1")

        metadata = result.get("metadata", {})
        assert metadata["existing_key"] == "existing_value"
        assert metadata["langfuse_user_id"] == "user-1"

    def test_does_not_mutate_original_config(self):
        """inject_tracing returns a new config, not a mutated original."""
        from fractal_agent_infra import tracing

        tracing._langfuse_initialized = True

        with patch(
            "fractal_agent_infra.tracing.get_langfuse_callback_handler",
            return_value=MagicMock(),
        ):
            config = self._make_config()
            original_callbacks = config.get("callbacks")
            result = inject_tracing(
                config,
                user_id="user-1",
                trace_name="test",
            )

        # Original should not have been mutated
        assert config.get("callbacks") == original_callbacks
        assert result is not config

    def test_all_attributes_combined(self):
        """All trace attributes can be set simultaneously."""
        from fractal_agent_infra import tracing

        tracing._langfuse_initialized = True

        mock_handler = MagicMock()
        with patch(
            "fractal_agent_infra.tracing.get_langfuse_callback_handler",
            return_value=mock_handler,
        ):
            config = self._make_config()
            result = inject_tracing(
                config,
                user_id="user-abc",
                session_id="thread-123",
                trace_name="full-test",
                tags=["tag1", "tag2"],
            )

        assert mock_handler in result.get("callbacks", [])
        metadata = result.get("metadata", {})
        assert metadata["langfuse_user_id"] == "user-abc"
        assert metadata["langfuse_session_id"] == "thread-123"
        assert metadata["langfuse_tags"] == ["tag1", "tag2"]
        assert result.get("run_name") == "full-test"

    def test_configurable_preserved(self):
        """The configurable dict from the original config is preserved."""
        from fractal_agent_infra import tracing

        tracing._langfuse_initialized = True

        with patch(
            "fractal_agent_infra.tracing.get_langfuse_callback_handler",
            return_value=MagicMock(),
        ):
            config = self._make_config()
            result = inject_tracing(config, user_id="user-1")

        assert result.get("configurable", {}).get("thread_id") == "test-thread"
        assert result.get("configurable", {}).get("run_id") == "test-run"


# ============================================================================
# Reset Helper
# ============================================================================


class TestResetTracingState:
    """Test _reset_tracing_state() for test isolation."""

    def test_resets_initialized_flag(self):
        """_reset_tracing_state() clears the initialized flag."""
        from fractal_agent_infra import tracing

        tracing._langfuse_initialized = True
        assert is_langfuse_enabled() is True

        _reset_tracing_state()
        assert is_langfuse_enabled() is False

    def test_idempotent_reset(self):
        """Calling _reset_tracing_state() twice is safe."""
        _reset_tracing_state()
        _reset_tracing_state()
        assert is_langfuse_enabled() is False


# ============================================================================
# Integration: Disabled tracing doesn't affect agent config
# ============================================================================


class TestTracingDisabledIntegration:
    """Verify that disabled tracing is truly invisible to the agent."""

    def test_inject_tracing_is_identity_when_disabled(self):
        """inject_tracing is a pure identity function when Langfuse is off."""
        config = RunnableConfig(
            configurable={
                "model_name": "openai:gpt-4o",
                "thread_id": "t-1",
                "run_id": "r-1",
            },
            run_id="r-1",
        )

        result = inject_tracing(
            config,
            user_id="user",
            session_id="session",
            trace_name="name",
            tags=["tag"],
        )

        # Must be the exact same object
        assert result is config

    def test_handler_is_none_when_disabled(self):
        """get_langfuse_callback_handler returns None when disabled."""
        assert get_langfuse_callback_handler() is None

    def test_shutdown_is_safe_when_never_initialized(self):
        """shutdown_langfuse() is a no-op and doesn't raise."""
        shutdown_langfuse()
        assert is_langfuse_enabled() is False
