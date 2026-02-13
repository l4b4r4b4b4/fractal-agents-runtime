"""Tests for infra.prompts — Langfuse prompt management integration.

Tests cover:
- Text prompt retrieval with fallback (Langfuse not configured)
- Chat prompt retrieval with fallback (Langfuse not configured)
- Variable substitution on fallback (text and chat)
- Langfuse fetch path (mocked client)
- Langfuse fetch with variable compilation
- Langfuse fallback when fetch fails (exception path)
- Langfuse SDK returns is_fallback=True (prompt not in Langfuse yet)
- Runtime overrides via config.configurable.prompt_overrides
  - label override
  - version override
  - name override
  - combined overrides
- Cache TTL resolution (default, env var, per-call)
- Edge cases: empty variables, malformed overrides, unknown variables
- Prompt registration and auto-seeding
"""

from unittest.mock import MagicMock, patch

import pytest
from langchain_core.runnables import RunnableConfig

from infra.prompts import (
    _apply_fallback,
    _extract_overrides,
    _get_default_cache_ttl,
    _registered_prompts,
    _substitute_variables_chat,
    _substitute_variables_text,
    get_prompt,
    register_default_prompt,
    seed_default_prompts,
)


# ===========================================================================
# Fixtures
# ===========================================================================


@pytest.fixture(autouse=True)
def _reset_prompt_registry():
    """Clear the prompt registry before and after each test."""
    _registered_prompts.clear()
    yield
    _registered_prompts.clear()


@pytest.fixture()
def _langfuse_disabled():
    """Ensure is_langfuse_enabled() returns False."""
    with patch("infra.prompts.is_langfuse_enabled", return_value=False):
        yield


@pytest.fixture()
def _langfuse_enabled():
    """Ensure is_langfuse_enabled() returns True and get_client is patchable."""
    # Ensure `langfuse` module has a `get_client` attribute that can be patched.
    # In the real SDK this exists, but during tests the module may not have
    # been fully initialised.  We inject a sentinel so `patch` can find it.
    import langfuse as _lf_mod

    if not hasattr(_lf_mod, "get_client"):
        _lf_mod.get_client = lambda: None  # type: ignore[attr-defined]
    with patch("infra.prompts.is_langfuse_enabled", return_value=True):
        yield


@pytest.fixture()
def mock_langfuse_client():
    """Return a MagicMock pretending to be a Langfuse client."""
    client = MagicMock()
    return client


@pytest.fixture()
def mock_text_prompt():
    """Return a mock text prompt object."""
    prompt = MagicMock()
    prompt.is_fallback = False
    prompt.version = 3
    prompt.compile.return_value = "Compiled text prompt"
    return prompt


@pytest.fixture()
def mock_chat_prompt():
    """Return a mock chat prompt object that returns message dicts."""
    prompt = MagicMock()
    prompt.is_fallback = False
    prompt.version = 2
    prompt.compile.return_value = [
        {"role": "system", "content": "You are a compiled chat agent."},
        {"role": "user", "content": "Hello compiled."},
    ]
    return prompt


@pytest.fixture()
def mock_fallback_prompt():
    """Return a mock prompt object where is_fallback=True."""
    prompt = MagicMock()
    prompt.is_fallback = True
    prompt.version = None
    prompt.compile.return_value = "Fallback prompt text"
    return prompt


# ===========================================================================
# _substitute_variables_text
# ===========================================================================


class TestSubstituteVariablesText:
    def test_basic_substitution(self):
        result = _substitute_variables_text(
            "Hello {{name}}, welcome to {{city}}!",
            {"name": "Alice", "city": "München"},
        )
        assert result == "Hello Alice, welcome to München!"

    def test_unknown_variable_left_untouched(self):
        result = _substitute_variables_text(
            "Hello {{name}}, your role is {{role}}.",
            {"name": "Bob"},
        )
        assert result == "Hello Bob, your role is {{role}}."

    def test_no_variables_in_template(self):
        result = _substitute_variables_text(
            "No variables here.",
            {"name": "Alice"},
        )
        assert result == "No variables here."

    def test_empty_variables_dict(self):
        result = _substitute_variables_text(
            "Hello {{name}}!",
            {},
        )
        assert result == "Hello {{name}}!"

    def test_repeated_variable(self):
        result = _substitute_variables_text(
            "{{x}} and {{x}} again.",
            {"x": "yes"},
        )
        assert result == "yes and yes again."


# ===========================================================================
# _substitute_variables_chat
# ===========================================================================


class TestSubstituteVariablesChat:
    def test_basic_chat_substitution(self):
        messages = [
            {"role": "system", "content": "You help with {{topic}}."},
            {"role": "user", "content": "Tell me about {{topic}}."},
        ]
        result = _substitute_variables_chat(messages, {"topic": "sales"})
        assert result == [
            {"role": "system", "content": "You help with sales."},
            {"role": "user", "content": "Tell me about sales."},
        ]

    def test_original_not_mutated(self):
        messages = [{"role": "system", "content": "{{x}}"}]
        original_content = messages[0]["content"]
        _substitute_variables_chat(messages, {"x": "replaced"})
        assert messages[0]["content"] == original_content

    def test_missing_content_key(self):
        messages = [{"role": "system"}]
        result = _substitute_variables_chat(messages, {"x": "y"})
        assert result == [{"role": "system"}]

    def test_non_string_content_untouched(self):
        """If content is not a string (e.g. multimodal), leave it alone."""
        messages = [{"role": "user", "content": 42}]
        result = _substitute_variables_chat(messages, {"x": "y"})
        assert result == [{"role": "user", "content": 42}]


# ===========================================================================
# _extract_overrides
# ===========================================================================


class TestExtractOverrides:
    def test_no_config(self):
        assert _extract_overrides("my-prompt", None) == {}

    def test_empty_configurable(self):
        config = RunnableConfig(configurable={})
        assert _extract_overrides("my-prompt", config) == {}

    def test_no_prompt_overrides_key(self):
        config = RunnableConfig(configurable={"model_name": "gpt-4o"})
        assert _extract_overrides("my-prompt", config) == {}

    def test_prompt_overrides_not_dict(self):
        config = RunnableConfig(configurable={"prompt_overrides": "invalid"})
        assert _extract_overrides("my-prompt", config) == {}

    def test_prompt_name_not_in_overrides(self):
        config = RunnableConfig(
            configurable={"prompt_overrides": {"other-prompt": {"label": "staging"}}}
        )
        assert _extract_overrides("my-prompt", config) == {}

    def test_prompt_override_entry_not_dict(self):
        config = RunnableConfig(
            configurable={"prompt_overrides": {"my-prompt": "invalid"}}
        )
        assert _extract_overrides("my-prompt", config) == {}

    def test_valid_label_override(self):
        config = RunnableConfig(
            configurable={"prompt_overrides": {"my-prompt": {"label": "staging"}}}
        )
        assert _extract_overrides("my-prompt", config) == {"label": "staging"}

    def test_valid_version_override(self):
        config = RunnableConfig(
            configurable={"prompt_overrides": {"my-prompt": {"version": 5}}}
        )
        assert _extract_overrides("my-prompt", config) == {"version": 5}

    def test_valid_name_override(self):
        config = RunnableConfig(
            configurable={"prompt_overrides": {"my-prompt": {"name": "custom-prompt"}}}
        )
        assert _extract_overrides("my-prompt", config) == {"name": "custom-prompt"}

    def test_combined_overrides(self):
        config = RunnableConfig(
            configurable={
                "prompt_overrides": {
                    "my-prompt": {
                        "name": "other",
                        "label": "experiment-a",
                        "version": 7,
                    }
                }
            }
        )
        overrides = _extract_overrides("my-prompt", config)
        assert overrides == {"name": "other", "label": "experiment-a", "version": 7}


# ===========================================================================
# _get_default_cache_ttl
# ===========================================================================


class TestGetDefaultCacheTtl:
    def test_default_when_env_not_set(self, monkeypatch):
        monkeypatch.delenv("LANGFUSE_PROMPT_CACHE_TTL", raising=False)
        assert _get_default_cache_ttl() == 300

    def test_reads_env_var(self, monkeypatch):
        monkeypatch.setenv("LANGFUSE_PROMPT_CACHE_TTL", "600")
        assert _get_default_cache_ttl() == 600

    def test_zero_disables_caching(self, monkeypatch):
        monkeypatch.setenv("LANGFUSE_PROMPT_CACHE_TTL", "0")
        assert _get_default_cache_ttl() == 0

    def test_invalid_env_var_uses_default(self, monkeypatch):
        monkeypatch.setenv("LANGFUSE_PROMPT_CACHE_TTL", "not-a-number")
        assert _get_default_cache_ttl() == 300


# ===========================================================================
# _apply_fallback
# ===========================================================================


class TestApplyFallback:
    def test_text_no_variables(self):
        result = _apply_fallback("Hello world", "text", None)
        assert result == "Hello world"

    def test_text_with_variables(self):
        result = _apply_fallback("Hello {{name}}", "text", {"name": "Bob"})
        assert result == "Hello Bob"

    def test_chat_no_variables(self):
        messages = [{"role": "system", "content": "Hi"}]
        result = _apply_fallback(messages, "chat", None)
        assert result == messages

    def test_chat_with_variables(self):
        messages = [{"role": "system", "content": "Hello {{name}}"}]
        result = _apply_fallback(messages, "chat", {"name": "Eve"})
        assert result == [{"role": "system", "content": "Hello Eve"}]

    def test_empty_variables_dict_returns_unchanged(self):
        result = _apply_fallback("Hello {{name}}", "text", {})
        assert result == "Hello {{name}}"


# ===========================================================================
# get_prompt — Langfuse NOT configured (fallback path)
# ===========================================================================


@pytest.mark.usefixtures("_langfuse_disabled")
class TestGetPromptNoLangfuse:
    """When Langfuse is not initialised, get_prompt returns fallback directly."""

    def test_text_fallback(self):
        result = get_prompt("my-prompt", fallback="Default text")
        assert result == "Default text"

    def test_text_fallback_with_variables(self):
        result = get_prompt(
            "my-prompt",
            fallback="Hello {{name}}!",
            variables={"name": "World"},
        )
        assert result == "Hello World!"

    def test_chat_fallback(self):
        fallback_messages = [{"role": "system", "content": "Default chat"}]
        result = get_prompt(
            "my-prompt",
            prompt_type="chat",
            fallback=fallback_messages,
        )
        assert result == fallback_messages

    def test_chat_fallback_with_variables(self):
        result = get_prompt(
            "my-prompt",
            prompt_type="chat",
            fallback=[{"role": "system", "content": "Hello {{user}}"}],
            variables={"user": "Tester"},
        )
        assert result == [{"role": "system", "content": "Hello Tester"}]

    def test_config_overrides_ignored_when_langfuse_disabled(self):
        """Overrides have no effect when Langfuse is off — just return fallback."""
        config = RunnableConfig(
            configurable={"prompt_overrides": {"my-prompt": {"label": "staging"}}}
        )
        result = get_prompt(
            "my-prompt",
            fallback="Default",
            config=config,
        )
        assert result == "Default"


# ===========================================================================
# get_prompt — Langfuse configured (mock client)
# ===========================================================================


@pytest.mark.usefixtures("_langfuse_enabled")
class TestGetPromptWithLangfuse:
    """When Langfuse is initialised, get_prompt fetches from Langfuse."""

    def test_text_prompt_fetched(self, mock_langfuse_client, mock_text_prompt):
        mock_langfuse_client.get_prompt.return_value = mock_text_prompt

        with patch("langfuse.get_client", return_value=mock_langfuse_client):
            result = get_prompt("my-prompt", fallback="fallback text")

        assert result == "Compiled text prompt"
        mock_langfuse_client.get_prompt.assert_called_once_with(
            "my-prompt",
            cache_ttl_seconds=300,
            fallback="fallback text",
            type="text",
            label="production",
        )
        mock_text_prompt.compile.assert_called_once_with()

    def test_chat_prompt_fetched(self, mock_langfuse_client, mock_chat_prompt):
        mock_langfuse_client.get_prompt.return_value = mock_chat_prompt
        fallback_messages = [{"role": "system", "content": "fallback"}]

        with patch("langfuse.get_client", return_value=mock_langfuse_client):
            result = get_prompt(
                "my-chat",
                prompt_type="chat",
                fallback=fallback_messages,
            )

        assert result == [
            {"role": "system", "content": "You are a compiled chat agent."},
            {"role": "user", "content": "Hello compiled."},
        ]
        mock_langfuse_client.get_prompt.assert_called_once_with(
            "my-chat",
            cache_ttl_seconds=300,
            fallback=fallback_messages,
            type="chat",
            label="production",
        )

    def test_variables_passed_to_compile(self, mock_langfuse_client, mock_text_prompt):
        mock_langfuse_client.get_prompt.return_value = mock_text_prompt

        with patch("langfuse.get_client", return_value=mock_langfuse_client):
            get_prompt(
                "my-prompt",
                fallback="fallback",
                variables={"city": "Berlin", "year": "2026"},
            )

        mock_text_prompt.compile.assert_called_once_with(city="Berlin", year="2026")

    def test_custom_label(self, mock_langfuse_client, mock_text_prompt):
        mock_langfuse_client.get_prompt.return_value = mock_text_prompt

        with patch("langfuse.get_client", return_value=mock_langfuse_client):
            get_prompt("my-prompt", fallback="fb", label="staging")

        call_kwargs = mock_langfuse_client.get_prompt.call_args
        assert call_kwargs.kwargs["label"] == "staging"
        assert "version" not in call_kwargs.kwargs

    def test_custom_cache_ttl(self, mock_langfuse_client, mock_text_prompt):
        mock_langfuse_client.get_prompt.return_value = mock_text_prompt

        with patch("langfuse.get_client", return_value=mock_langfuse_client):
            get_prompt("my-prompt", fallback="fb", cache_ttl_seconds=0)

        call_kwargs = mock_langfuse_client.get_prompt.call_args
        assert call_kwargs.kwargs["cache_ttl_seconds"] == 0

    def test_is_fallback_logged(self, mock_langfuse_client, mock_fallback_prompt):
        """When Langfuse returns a fallback prompt, we still get the compiled text."""
        mock_langfuse_client.get_prompt.return_value = mock_fallback_prompt

        with patch("langfuse.get_client", return_value=mock_langfuse_client):
            result = get_prompt("nonexistent-prompt", fallback="hardcoded")

        assert result == "Fallback prompt text"
        mock_fallback_prompt.compile.assert_called_once()


# ===========================================================================
# get_prompt — Langfuse configured but fetch fails (exception path)
# ===========================================================================


@pytest.mark.usefixtures("_langfuse_enabled")
class TestGetPromptLangfuseFailure:
    """When Langfuse raises an exception, get_prompt returns the fallback."""

    def test_text_fallback_on_exception(self, mock_langfuse_client):
        mock_langfuse_client.get_prompt.side_effect = RuntimeError("Connection refused")

        with patch("langfuse.get_client", return_value=mock_langfuse_client):
            result = get_prompt("my-prompt", fallback="safe default")

        assert result == "safe default"

    def test_chat_fallback_on_exception(self, mock_langfuse_client):
        mock_langfuse_client.get_prompt.side_effect = TimeoutError("timeout")
        fallback_messages = [{"role": "system", "content": "safe chat"}]

        with patch("langfuse.get_client", return_value=mock_langfuse_client):
            result = get_prompt(
                "my-prompt",
                prompt_type="chat",
                fallback=fallback_messages,
            )

        assert result == fallback_messages

    def test_fallback_with_variables_on_exception(self, mock_langfuse_client):
        mock_langfuse_client.get_prompt.side_effect = RuntimeError("boom")

        with patch("langfuse.get_client", return_value=mock_langfuse_client):
            result = get_prompt(
                "my-prompt",
                fallback="Hello {{name}}!",
                variables={"name": "Fallback"},
            )

        assert result == "Hello Fallback!"

    def test_get_client_import_fails(self):
        """If get_client itself fails (e.g. Langfuse not importable), fallback."""
        with patch(
            "langfuse.get_client",
            side_effect=ImportError("no langfuse"),
        ):
            result = get_prompt("my-prompt", fallback="import fallback")

        assert result == "import fallback"


# ===========================================================================
# get_prompt — Runtime overrides via config
# ===========================================================================


@pytest.mark.usefixtures("_langfuse_enabled")
class TestGetPromptOverrides:
    """Test that config.configurable.prompt_overrides are honoured."""

    def test_label_override(self, mock_langfuse_client, mock_text_prompt):
        mock_langfuse_client.get_prompt.return_value = mock_text_prompt

        config = RunnableConfig(
            configurable={"prompt_overrides": {"my-prompt": {"label": "experiment-a"}}}
        )

        with patch("langfuse.get_client", return_value=mock_langfuse_client):
            get_prompt("my-prompt", fallback="fb", config=config)

        call_kwargs = mock_langfuse_client.get_prompt.call_args
        assert call_kwargs.kwargs["label"] == "experiment-a"
        assert "version" not in call_kwargs.kwargs

    def test_version_override(self, mock_langfuse_client, mock_text_prompt):
        mock_langfuse_client.get_prompt.return_value = mock_text_prompt

        config = RunnableConfig(
            configurable={"prompt_overrides": {"my-prompt": {"version": 7}}}
        )

        with patch("langfuse.get_client", return_value=mock_langfuse_client):
            get_prompt("my-prompt", fallback="fb", config=config)

        call_kwargs = mock_langfuse_client.get_prompt.call_args
        assert call_kwargs.kwargs["version"] == 7
        # When version is set, label should NOT be passed
        assert "label" not in call_kwargs.kwargs

    def test_name_override(self, mock_langfuse_client, mock_text_prompt):
        mock_langfuse_client.get_prompt.return_value = mock_text_prompt

        config = RunnableConfig(
            configurable={
                "prompt_overrides": {"my-prompt": {"name": "custom-prompt-v2"}}
            }
        )

        with patch("langfuse.get_client", return_value=mock_langfuse_client):
            get_prompt("my-prompt", fallback="fb", config=config)

        # First positional arg should be the overridden name
        call_args = mock_langfuse_client.get_prompt.call_args
        assert call_args.args[0] == "custom-prompt-v2"

    def test_combined_name_and_label_override(
        self, mock_langfuse_client, mock_text_prompt
    ):
        mock_langfuse_client.get_prompt.return_value = mock_text_prompt

        config = RunnableConfig(
            configurable={
                "prompt_overrides": {
                    "my-prompt": {"name": "other-prompt", "label": "staging"}
                }
            }
        )

        with patch("langfuse.get_client", return_value=mock_langfuse_client):
            get_prompt("my-prompt", fallback="fb", config=config)

        call_args = mock_langfuse_client.get_prompt.call_args
        assert call_args.args[0] == "other-prompt"
        assert call_args.kwargs["label"] == "staging"

    def test_override_for_different_prompt_ignored(
        self, mock_langfuse_client, mock_text_prompt
    ):
        """Overrides for a different prompt name should not affect this one."""
        mock_langfuse_client.get_prompt.return_value = mock_text_prompt

        config = RunnableConfig(
            configurable={
                "prompt_overrides": {
                    "other-prompt": {"label": "staging", "version": 99}
                }
            }
        )

        with patch("langfuse.get_client", return_value=mock_langfuse_client):
            get_prompt("my-prompt", fallback="fb", config=config)

        call_kwargs = mock_langfuse_client.get_prompt.call_args
        # Should use defaults, not the other prompt's overrides
        assert call_kwargs.kwargs["label"] == "production"
        assert "version" not in call_kwargs.kwargs


# ===========================================================================
# get_prompt — Cache TTL from environment
# ===========================================================================


@pytest.mark.usefixtures("_langfuse_enabled")
class TestGetPromptCacheTtlFromEnv:
    def test_env_ttl_used_when_no_per_call_ttl(
        self, mock_langfuse_client, mock_text_prompt, monkeypatch
    ):
        monkeypatch.setenv("LANGFUSE_PROMPT_CACHE_TTL", "120")
        mock_langfuse_client.get_prompt.return_value = mock_text_prompt

        with patch("langfuse.get_client", return_value=mock_langfuse_client):
            get_prompt("my-prompt", fallback="fb")

        call_kwargs = mock_langfuse_client.get_prompt.call_args
        assert call_kwargs.kwargs["cache_ttl_seconds"] == 120

    def test_per_call_ttl_overrides_env(
        self, mock_langfuse_client, mock_text_prompt, monkeypatch
    ):
        monkeypatch.setenv("LANGFUSE_PROMPT_CACHE_TTL", "120")
        mock_langfuse_client.get_prompt.return_value = mock_text_prompt

        with patch("langfuse.get_client", return_value=mock_langfuse_client):
            get_prompt("my-prompt", fallback="fb", cache_ttl_seconds=0)

        call_kwargs = mock_langfuse_client.get_prompt.call_args
        assert call_kwargs.kwargs["cache_ttl_seconds"] == 0


# ===========================================================================
# Integration-style: get_prompt call sequence
# ===========================================================================


@pytest.mark.usefixtures("_langfuse_enabled")
class TestGetPromptIntegration:
    """Test realistic call sequences combining multiple features."""

    def test_chat_prompt_with_override_and_variables(
        self, mock_langfuse_client, mock_chat_prompt
    ):
        mock_langfuse_client.get_prompt.return_value = mock_chat_prompt

        config = RunnableConfig(
            configurable={
                "prompt_overrides": {
                    "agent-system": {"label": "experiment-b", "name": "agent-v2"}
                }
            }
        )

        with patch("langfuse.get_client", return_value=mock_langfuse_client):
            result = get_prompt(
                "agent-system",
                prompt_type="chat",
                fallback=[{"role": "system", "content": "fallback"}],
                config=config,
                variables={"topic": "sales"},
            )

        # Should have fetched from Langfuse with overrides
        call_args = mock_langfuse_client.get_prompt.call_args
        assert call_args.args[0] == "agent-v2"
        assert call_args.kwargs["label"] == "experiment-b"
        assert call_args.kwargs["type"] == "chat"

        # Variables passed to compile
        mock_chat_prompt.compile.assert_called_once_with(topic="sales")

        # Result is the compiled chat messages
        assert isinstance(result, list)
        assert len(result) == 2

    def test_no_variables_calls_compile_without_kwargs(
        self, mock_langfuse_client, mock_text_prompt
    ):
        mock_langfuse_client.get_prompt.return_value = mock_text_prompt

        with patch("langfuse.get_client", return_value=mock_langfuse_client):
            get_prompt("my-prompt", fallback="fb")

        # compile() should be called with no kwargs
        mock_text_prompt.compile.assert_called_once_with()


# ===========================================================================
# register_default_prompt
# ===========================================================================


class TestRegisterDefaultPrompt:
    def test_register_text_prompt(self):
        register_default_prompt("my-prompt", "Hello world")
        assert len(_registered_prompts) == 1
        assert _registered_prompts[0] == ("my-prompt", "Hello world", "text")

    def test_register_chat_prompt(self):
        messages = [{"role": "system", "content": "Hi"}]
        register_default_prompt("my-chat", messages, prompt_type="chat")
        assert len(_registered_prompts) == 1
        assert _registered_prompts[0] == ("my-chat", messages, "chat")

    def test_duplicate_name_ignored(self):
        register_default_prompt("my-prompt", "First")
        register_default_prompt("my-prompt", "Second")
        assert len(_registered_prompts) == 1
        # First registration wins
        assert _registered_prompts[0][1] == "First"

    def test_different_names_both_registered(self):
        register_default_prompt("prompt-a", "A")
        register_default_prompt("prompt-b", "B")
        assert len(_registered_prompts) == 2


# ===========================================================================
# seed_default_prompts — Langfuse NOT configured
# ===========================================================================


class TestSeedDefaultPromptsNoLangfuse:
    @pytest.mark.usefixtures("_langfuse_disabled")
    def test_returns_zero_when_langfuse_disabled(self):
        register_default_prompt("my-prompt", "Hello")
        assert seed_default_prompts() == 0

    @pytest.mark.usefixtures("_langfuse_enabled")
    def test_returns_zero_when_no_prompts_registered(self):
        assert seed_default_prompts() == 0

    @pytest.mark.usefixtures("_langfuse_enabled")
    def test_returns_zero_when_get_client_fails(self):
        register_default_prompt("my-prompt", "Hello")
        with patch("langfuse.get_client", side_effect=RuntimeError("no client")):
            assert seed_default_prompts() == 0


# ===========================================================================
# seed_default_prompts — Langfuse configured (mock client)
# ===========================================================================


@pytest.mark.usefixtures("_langfuse_enabled")
class TestSeedDefaultPrompts:
    def test_creates_prompt_when_not_in_langfuse(self, mock_langfuse_client):
        """When get_prompt returns is_fallback=True, seed should create it."""
        fallback_prompt = MagicMock()
        fallback_prompt.is_fallback = True
        mock_langfuse_client.get_prompt.return_value = fallback_prompt

        register_default_prompt("new-prompt", "Default text")

        with patch("langfuse.get_client", return_value=mock_langfuse_client):
            created = seed_default_prompts()

        assert created == 1
        mock_langfuse_client.create_prompt.assert_called_once_with(
            name="new-prompt",
            type="text",
            prompt="Default text",
            labels=["production"],
        )

    def test_skips_prompt_when_already_in_langfuse(self, mock_langfuse_client):
        """When get_prompt returns a real prompt (not fallback), don't create."""
        existing_prompt = MagicMock()
        existing_prompt.is_fallback = False
        existing_prompt.version = 3
        mock_langfuse_client.get_prompt.return_value = existing_prompt

        register_default_prompt("existing-prompt", "Default text")

        with patch("langfuse.get_client", return_value=mock_langfuse_client):
            created = seed_default_prompts()

        assert created == 0
        mock_langfuse_client.create_prompt.assert_not_called()

    def test_seeds_multiple_prompts(self, mock_langfuse_client):
        """Multiple registered prompts — creates only the missing ones."""
        existing = MagicMock(is_fallback=False, version=1)
        missing = MagicMock(is_fallback=True)

        def side_effect(name, **kwargs):
            if name == "existing":
                return existing
            return missing

        mock_langfuse_client.get_prompt.side_effect = side_effect

        register_default_prompt("existing", "Already there")
        register_default_prompt("missing-text", "New text")
        register_default_prompt(
            "missing-chat",
            [{"role": "system", "content": "New chat"}],
            prompt_type="chat",
        )

        with patch("langfuse.get_client", return_value=mock_langfuse_client):
            created = seed_default_prompts()

        assert created == 2
        assert mock_langfuse_client.create_prompt.call_count == 2

        # Verify both create calls
        create_calls = mock_langfuse_client.create_prompt.call_args_list
        created_names = {call.kwargs["name"] for call in create_calls}
        assert created_names == {"missing-text", "missing-chat"}

    def test_seed_chat_prompt(self, mock_langfuse_client):
        """Chat prompts are seeded with the correct type."""
        fallback = MagicMock(is_fallback=True)
        mock_langfuse_client.get_prompt.return_value = fallback

        messages = [{"role": "system", "content": "Hello"}]
        register_default_prompt("chat-prompt", messages, prompt_type="chat")

        with patch("langfuse.get_client", return_value=mock_langfuse_client):
            created = seed_default_prompts()

        assert created == 1
        mock_langfuse_client.create_prompt.assert_called_once_with(
            name="chat-prompt",
            type="chat",
            prompt=messages,
            labels=["production"],
        )

    def test_single_prompt_failure_doesnt_block_others(self, mock_langfuse_client):
        """If seeding one prompt fails, the rest should still be attempted."""
        call_count = 0

        def side_effect(name, **kwargs):
            nonlocal call_count
            call_count += 1
            if name == "bad-prompt":
                raise RuntimeError("Langfuse API error")
            result = MagicMock(is_fallback=True)
            return result

        mock_langfuse_client.get_prompt.side_effect = side_effect

        register_default_prompt("bad-prompt", "Will fail")
        register_default_prompt("good-prompt", "Will succeed")

        with patch("langfuse.get_client", return_value=mock_langfuse_client):
            created = seed_default_prompts()

        # bad-prompt failed, good-prompt succeeded
        assert created == 1
        assert call_count == 2

    def test_uses_cache_ttl_zero_for_fresh_check(self, mock_langfuse_client):
        """Seeding should use cache_ttl_seconds=0 to bypass stale cache."""
        existing = MagicMock(is_fallback=False, version=1)
        mock_langfuse_client.get_prompt.return_value = existing

        register_default_prompt("my-prompt", "Default")

        with patch("langfuse.get_client", return_value=mock_langfuse_client):
            seed_default_prompts()

        call_kwargs = mock_langfuse_client.get_prompt.call_args
        assert call_kwargs.kwargs["cache_ttl_seconds"] == 0
