"""Tests for ``graphs.react_agent.utils.token``.

Covers the fix for the "get_config outside of a runnable context" bug
(Goal 44): ``get_tokens``, ``set_tokens``, and ``fetch_tokens`` must
accept an explicit ``store`` kwarg so they can be called during the graph
construction phase — before any LangGraph runnable context exists.

Test groups
-----------
TestGetTokens
    - Uses explicit store kwarg (the fixed path)
    - Falls back gracefully when store=None and no runnable context
    - Returns None for missing / expired / malformed token records

TestSetTokens
    - Uses explicit store kwarg to persist tokens
    - Falls back gracefully when store=None and no runnable context
    - No-ops on tokens=None

TestFetchTokens
    - Returns cached tokens from store (no HTTP call)
    - Performs HTTP exchange and caches result when store is fresh
    - Passes store through to get_tokens / set_tokens
    - Returns None when supabase token missing
    - Returns None when no auth-required servers
    - Falls back gracefully when store is None and get_store() raises

TestGetMcpAccessToken
    - Returns token dict on HTTP 200
    - Returns None on non-200 response
    - Returns None on network exception
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

from langchain_core.runnables import RunnableConfig


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_config(
    org_id: str = "org-1",
    user_id: str = "user-1",
    assistant_id: str = "asst-1",
    supabase_token: str | None = "sb-token-abc",
    mcp_config: dict[str, Any] | None = None,
) -> RunnableConfig:
    """Build a minimal RunnableConfig for token tests."""
    configurable: dict[str, Any] = {
        "supabase_organization_id": org_id,
        "owner": user_id,
        "assistant_id": assistant_id,
    }
    if supabase_token is not None:
        configurable["x-supabase-access-token"] = supabase_token
    if mcp_config is not None:
        configurable["mcp_config"] = mcp_config
    return RunnableConfig(configurable=configurable)


def _make_store(token_record: Any = None) -> AsyncMock:
    """Return a mock ``AsyncPostgresStore``."""
    store = AsyncMock()
    store.aget = AsyncMock(return_value=token_record)
    store.aput = AsyncMock(return_value=None)
    store.adelete = AsyncMock(return_value=None)
    return store


def _make_token_record(
    access_token: str = "mcp-access-token",
    expires_in: int = 3600,
    created_at: datetime | None = None,
) -> MagicMock:
    """Return a mock store item shaped like a LangGraph store record."""
    record = MagicMock()
    record.value = {
        "access_token": access_token,
        "token_type": "Bearer",
        "expires_in": expires_in,
    }
    record.created_at = created_at or datetime.now(UTC)
    return record


_MCP_CONFIG_AUTH_REQUIRED = {
    "servers": [
        {
            "name": "supabase-mcp",
            "url": "http://mcp.example.com",
            "auth_required": True,
        }
    ]
}

_MCP_CONFIG_NO_AUTH = {
    "servers": [
        {
            "name": "public-mcp",
            "url": "http://public-mcp.example.com",
            "auth_required": False,
        }
    ]
}


# ---------------------------------------------------------------------------
# TestGetTokens
# ---------------------------------------------------------------------------


class TestGetTokens:
    """Tests for ``get_tokens()``."""

    async def test_returns_valid_token_from_explicit_store(self):
        """Happy path: explicit store with a fresh, valid token record."""
        from graphs.react_agent.utils.token import get_tokens

        record = _make_token_record()
        store = _make_store(token_record=record)
        config = _make_config()

        result = await get_tokens(config, store=store)

        assert isinstance(result, dict)
        assert result["access_token"] == "mcp-access-token"
        store.aget.assert_awaited_once()

    async def test_returns_none_when_no_store_and_no_runnable_context(self):
        """Outside runnable context with store=None → None (no crash)."""
        from graphs.react_agent.utils.token import get_tokens

        config = _make_config()

        with patch(
            "graphs.react_agent.utils.token.get_store",
            side_effect=RuntimeError("Called get_config outside of a runnable context"),
        ):
            result = await get_tokens(config, store=None)

        assert result is None

    async def test_returns_none_when_store_is_none_and_get_store_returns_none(self):
        """get_store() returns None (Postgres disabled) → None."""
        from graphs.react_agent.utils.token import get_tokens

        config = _make_config()

        with patch("graphs.react_agent.utils.token.get_store", return_value=None):
            result = await get_tokens(config, store=None)

        assert result is None

    async def test_returns_none_when_no_token_record_in_store(self):
        """Store exists but no token cached for this namespace."""
        from graphs.react_agent.utils.token import get_tokens

        store = _make_store(token_record=None)
        config = _make_config()

        result = await get_tokens(config, store=store)

        assert result is None

    async def test_returns_none_when_namespace_components_missing(self):
        """Config missing org_id/user_id/assistant_id → None."""
        from graphs.react_agent.utils.token import get_tokens

        store = _make_store()
        config = RunnableConfig(configurable={})

        result = await get_tokens(config, store=store)

        assert result is None
        store.aget.assert_not_awaited()

    async def test_returns_none_and_deletes_when_created_at_missing(self):
        """Token record without created_at → evicted, returns None."""
        from graphs.react_agent.utils.token import get_tokens

        record = MagicMock()
        record.value = {"access_token": "tok", "expires_in": 3600}
        record.created_at = None

        store = _make_store(token_record=record)
        config = _make_config()

        result = await get_tokens(config, store=store)

        assert result is None
        store.adelete.assert_awaited_once()

    async def test_returns_none_and_deletes_when_expires_in_missing(self):
        """Token record without expires_in → evicted, returns None."""
        from graphs.react_agent.utils.token import get_tokens

        record = MagicMock()
        record.value = {"access_token": "tok"}
        record.created_at = datetime.now(UTC)

        store = _make_store(token_record=record)
        config = _make_config()

        result = await get_tokens(config, store=store)

        assert result is None
        store.adelete.assert_awaited_once()

    async def test_returns_none_and_deletes_when_token_expired(self):
        """Expired token → evicted from store, returns None."""
        from graphs.react_agent.utils.token import get_tokens

        old_created_at = datetime.now(UTC) - timedelta(seconds=7200)
        record = _make_token_record(expires_in=3600, created_at=old_created_at)
        store = _make_store(token_record=record)
        config = _make_config()

        result = await get_tokens(config, store=store)

        assert result is None
        store.adelete.assert_awaited_once()

    async def test_returns_token_not_yet_expired(self):
        """Token created recently with long expiry → returned."""
        from graphs.react_agent.utils.token import get_tokens

        record = _make_token_record(expires_in=3600)
        store = _make_store(token_record=record)
        config = _make_config()

        result = await get_tokens(config, store=store)

        assert result is not None
        assert result["access_token"] == "mcp-access-token"

    async def test_returns_none_when_value_not_dict(self):
        """Token record whose value is not a dict → None."""
        from graphs.react_agent.utils.token import get_tokens

        record = MagicMock()
        record.value = "not-a-dict"
        record.created_at = datetime.now(UTC)

        store = _make_store(token_record=record)
        config = _make_config()

        result = await get_tokens(config, store=store)

        assert result is None

    async def test_returns_none_when_store_aget_raises(self):
        """store.aget() raises unexpectedly → returns None defensively."""
        from graphs.react_agent.utils.token import get_tokens

        store = _make_store()
        store.aget = AsyncMock(side_effect=Exception("DB connection lost"))
        config = _make_config()

        result = await get_tokens(config, store=store)

        assert result is None

    async def test_uses_explicit_store_not_get_store(self):
        """When store kwarg is provided, get_store() must NOT be called."""
        from graphs.react_agent.utils.token import get_tokens

        record = _make_token_record()
        store = _make_store(token_record=record)
        config = _make_config()

        with patch("graphs.react_agent.utils.token.get_store") as mock_get_store:
            await get_tokens(config, store=store)

        mock_get_store.assert_not_called()


# ---------------------------------------------------------------------------
# TestSetTokens
# ---------------------------------------------------------------------------


class TestSetTokens:
    """Tests for ``set_tokens()``."""

    async def test_persists_tokens_to_explicit_store(self):
        """Happy path: tokens written to the passed store."""
        from graphs.react_agent.utils.token import set_tokens

        store = _make_store()
        config = _make_config()
        tokens = {"access_token": "tok", "expires_in": 3600}

        await set_tokens(config, tokens, store=store)

        store.aput.assert_awaited_once()
        call_args = store.aput.call_args
        # namespace tuple is first arg, key is second, value is third
        assert call_args.args[2] == tokens

    async def test_noop_when_tokens_is_none(self):
        """tokens=None → no store interaction."""
        from graphs.react_agent.utils.token import set_tokens

        store = _make_store()
        config = _make_config()

        await set_tokens(config, None, store=store)

        store.aput.assert_not_awaited()

    async def test_returns_gracefully_when_no_store_and_no_runnable_context(self):
        """Outside runnable context with store=None → no crash, best-effort."""
        from graphs.react_agent.utils.token import set_tokens

        config = _make_config()
        tokens = {"access_token": "tok", "expires_in": 3600}

        with patch(
            "graphs.react_agent.utils.token.get_store",
            side_effect=RuntimeError("Called get_config outside of a runnable context"),
        ):
            # Must not raise
            await set_tokens(config, tokens, store=None)

    async def test_returns_gracefully_when_store_is_none_and_get_store_returns_none(
        self,
    ):
        """get_store() returns None → silent no-op."""
        from graphs.react_agent.utils.token import set_tokens

        config = _make_config()
        tokens = {"access_token": "tok", "expires_in": 3600}

        with patch("graphs.react_agent.utils.token.get_store", return_value=None):
            await set_tokens(config, tokens, store=None)

    async def test_noop_when_namespace_components_missing(self):
        """Config without org/user/assistant → no write."""
        from graphs.react_agent.utils.token import set_tokens

        store = _make_store()
        config = RunnableConfig(configurable={})
        tokens = {"access_token": "tok", "expires_in": 3600}

        await set_tokens(config, tokens, store=store)

        store.aput.assert_not_awaited()

    async def test_swallows_store_aput_exception(self):
        """store.aput() raising should not propagate — best-effort cache."""
        from graphs.react_agent.utils.token import set_tokens

        store = _make_store()
        store.aput = AsyncMock(side_effect=Exception("write failed"))
        config = _make_config()
        tokens = {"access_token": "tok", "expires_in": 3600}

        # Must not raise
        await set_tokens(config, tokens, store=store)

    async def test_uses_explicit_store_not_get_store(self):
        """When store kwarg is provided, get_store() must NOT be called."""
        from graphs.react_agent.utils.token import set_tokens

        store = _make_store()
        config = _make_config()
        tokens = {"access_token": "tok", "expires_in": 3600}

        with patch("graphs.react_agent.utils.token.get_store") as mock_get_store:
            await set_tokens(config, tokens, store=store)

        mock_get_store.assert_not_called()


# ---------------------------------------------------------------------------
# TestFetchTokens
# ---------------------------------------------------------------------------


class TestFetchTokens:
    """Tests for ``fetch_tokens()``."""

    async def test_returns_cached_token_without_http_call(self):
        """Valid cached token in store → returned, no HTTP exchange."""
        from graphs.react_agent.utils.token import fetch_tokens

        record = _make_token_record()
        store = _make_store(token_record=record)
        config = _make_config(mcp_config=_MCP_CONFIG_AUTH_REQUIRED)

        with patch("graphs.react_agent.utils.token.get_mcp_access_token") as mock_http:
            result = await fetch_tokens(config, store=store)

        assert result is not None
        assert result["access_token"] == "mcp-access-token"
        mock_http.assert_not_called()

    async def test_exchanges_token_and_caches_when_no_cached_token(self):
        """No cached token → HTTP exchange performed, result cached."""
        from graphs.react_agent.utils.token import fetch_tokens

        # Cache miss
        store = _make_store(token_record=None)
        config = _make_config(mcp_config=_MCP_CONFIG_AUTH_REQUIRED)
        fresh_token = {"access_token": "fresh-tok", "expires_in": 3600}

        with patch(
            "graphs.react_agent.utils.token.get_mcp_access_token",
            new=AsyncMock(return_value=fresh_token),
        ):
            result = await fetch_tokens(config, store=store)

        assert result == fresh_token
        # Token should have been written to store
        store.aput.assert_awaited_once()

    async def test_passes_store_to_get_and_set_tokens(self):
        """The store kwarg must be forwarded to get_tokens and set_tokens."""
        from graphs.react_agent.utils.token import fetch_tokens

        store = _make_store(token_record=None)
        config = _make_config(mcp_config=_MCP_CONFIG_AUTH_REQUIRED)
        fresh_token = {"access_token": "tok2", "expires_in": 3600}

        with (
            patch(
                "graphs.react_agent.utils.token.get_tokens",
                new=AsyncMock(return_value=None),
            ) as mock_get,
            patch(
                "graphs.react_agent.utils.token.set_tokens",
                new=AsyncMock(return_value=None),
            ) as mock_set,
            patch(
                "graphs.react_agent.utils.token.get_mcp_access_token",
                new=AsyncMock(return_value=fresh_token),
            ),
        ):
            await fetch_tokens(config, store=store)

        # Both helpers must receive the same store object
        mock_get.assert_awaited_once_with(config, store=store)
        mock_set.assert_awaited_once_with(config, fresh_token, store=store)

    async def test_returns_none_when_no_supabase_token(self):
        """Missing x-supabase-access-token → None (nothing to exchange)."""
        from graphs.react_agent.utils.token import fetch_tokens

        store = _make_store(token_record=None)
        config = _make_config(
            supabase_token=None,
            mcp_config=_MCP_CONFIG_AUTH_REQUIRED,
        )

        result = await fetch_tokens(config, store=store)

        assert result is None

    async def test_returns_none_when_no_mcp_config(self):
        """No mcp_config key → None."""
        from graphs.react_agent.utils.token import fetch_tokens

        store = _make_store(token_record=None)
        config = _make_config(mcp_config=None)

        result = await fetch_tokens(config, store=store)

        assert result is None

    async def test_returns_none_when_no_auth_required_servers(self):
        """All servers have auth_required=False → None (no exchange needed)."""
        from graphs.react_agent.utils.token import fetch_tokens

        store = _make_store(token_record=None)
        config = _make_config(mcp_config=_MCP_CONFIG_NO_AUTH)

        with patch("graphs.react_agent.utils.token.get_mcp_access_token") as mock_http:
            result = await fetch_tokens(config, store=store)

        assert result is None
        mock_http.assert_not_called()

    async def test_returns_none_when_http_exchange_fails(self):
        """get_mcp_access_token returns None → fetch_tokens returns None."""
        from graphs.react_agent.utils.token import fetch_tokens

        store = _make_store(token_record=None)
        config = _make_config(mcp_config=_MCP_CONFIG_AUTH_REQUIRED)

        with patch(
            "graphs.react_agent.utils.token.get_mcp_access_token",
            new=AsyncMock(return_value=None),
        ):
            result = await fetch_tokens(config, store=store)

        assert result is None
        store.aput.assert_not_awaited()

    async def test_works_when_store_none_and_no_runnable_context(self):
        """
        Core regression test for Goal 44 bug.

        store=None + get_store() raises RuntimeError (graph build phase)
        → fetch_tokens must NOT crash, and must still exchange the token
        via HTTP (cache unavailable, but exchange still works).
        """
        from graphs.react_agent.utils.token import fetch_tokens

        config = _make_config(mcp_config=_MCP_CONFIG_AUTH_REQUIRED)
        fresh_token = {"access_token": "build-phase-tok", "expires_in": 3600}

        with (
            patch(
                "graphs.react_agent.utils.token.get_store",
                side_effect=RuntimeError(
                    "Called get_config outside of a runnable context"
                ),
            ),
            patch(
                "graphs.react_agent.utils.token.get_mcp_access_token",
                new=AsyncMock(return_value=fresh_token),
            ),
        ):
            result = await fetch_tokens(config, store=None)

        # Token exchange succeeded despite no store context
        assert result == fresh_token

    async def test_skips_server_without_url(self):
        """Server entry without a URL → skipped, returns None."""
        from graphs.react_agent.utils.token import fetch_tokens

        store = _make_store(token_record=None)
        bad_config = {"servers": [{"name": "no-url", "auth_required": True}]}
        config = _make_config(mcp_config=bad_config)

        result = await fetch_tokens(config, store=store)

        assert result is None

    async def test_skips_non_dict_server_entries(self):
        """Non-dict entries in servers list → skipped gracefully."""
        from graphs.react_agent.utils.token import fetch_tokens

        store = _make_store(token_record=None)
        bad_config = {"servers": ["not-a-dict", 42, None]}
        config = _make_config(mcp_config=bad_config)

        result = await fetch_tokens(config, store=store)

        assert result is None

    async def test_picks_first_auth_required_server_url(self):
        """First auth_required server's URL is used for exchange."""
        from graphs.react_agent.utils.token import fetch_tokens

        store = _make_store(token_record=None)
        multi_config = {
            "servers": [
                {
                    "name": "public",
                    "url": "http://public.example.com",
                    "auth_required": False,
                },
                {
                    "name": "private",
                    "url": "http://private.example.com",
                    "auth_required": True,
                },
                {
                    "name": "other",
                    "url": "http://other.example.com",
                    "auth_required": True,
                },
            ]
        }
        config = _make_config(mcp_config=multi_config)
        fresh_token = {"access_token": "tok", "expires_in": 3600}

        with patch(
            "graphs.react_agent.utils.token.get_mcp_access_token",
            new=AsyncMock(return_value=fresh_token),
        ) as mock_http:
            result = await fetch_tokens(config, store=store)

        assert result == fresh_token
        # Must use the first auth-required server, not the public one
        call_url = mock_http.call_args.args[1]
        assert "private.example.com" in call_url


# ---------------------------------------------------------------------------
# TestGetMcpAccessToken
# ---------------------------------------------------------------------------


class TestGetMcpAccessToken:
    """Tests for ``get_mcp_access_token()``."""

    async def test_returns_token_dict_on_success(self):
        """HTTP 200 with JSON → token dict returned."""
        from graphs.react_agent.utils.token import get_mcp_access_token

        mock_response = AsyncMock()
        mock_response.status = 200
        mock_response.json = AsyncMock(
            return_value={"access_token": "tok123", "expires_in": 3600}
        )
        mock_response.__aenter__ = AsyncMock(return_value=mock_response)
        mock_response.__aexit__ = AsyncMock(return_value=False)

        mock_session = AsyncMock()
        mock_session.post = MagicMock(return_value=mock_response)
        mock_session.__aenter__ = AsyncMock(return_value=mock_session)
        mock_session.__aexit__ = AsyncMock(return_value=False)

        with patch(
            "graphs.react_agent.utils.token.aiohttp.ClientSession",
            return_value=mock_session,
        ):
            result = await get_mcp_access_token("sb-token", "http://mcp.example.com")

        assert result == {"access_token": "tok123", "expires_in": 3600}

    async def test_returns_none_on_non_200_response(self):
        """HTTP 4xx/5xx → None."""
        from graphs.react_agent.utils.token import get_mcp_access_token

        mock_response = AsyncMock()
        mock_response.status = 401
        mock_response.text = AsyncMock(return_value="Unauthorized")
        mock_response.__aenter__ = AsyncMock(return_value=mock_response)
        mock_response.__aexit__ = AsyncMock(return_value=False)

        mock_session = AsyncMock()
        mock_session.post = MagicMock(return_value=mock_response)
        mock_session.__aenter__ = AsyncMock(return_value=mock_session)
        mock_session.__aexit__ = AsyncMock(return_value=False)

        with patch(
            "graphs.react_agent.utils.token.aiohttp.ClientSession",
            return_value=mock_session,
        ):
            result = await get_mcp_access_token("sb-token", "http://mcp.example.com")

        assert result is None

    async def test_returns_none_on_network_exception(self):
        """Network error → None (exception swallowed)."""
        from graphs.react_agent.utils.token import get_mcp_access_token

        with patch(
            "graphs.react_agent.utils.token.aiohttp.ClientSession",
            side_effect=Exception("Connection refused"),
        ):
            result = await get_mcp_access_token("sb-token", "http://mcp.example.com")

        assert result is None

    async def test_returns_none_when_json_not_dict(self):
        """200 response but JSON body is not a dict → None."""
        from graphs.react_agent.utils.token import get_mcp_access_token

        mock_response = AsyncMock()
        mock_response.status = 200
        mock_response.json = AsyncMock(return_value=["not", "a", "dict"])
        mock_response.__aenter__ = AsyncMock(return_value=mock_response)
        mock_response.__aexit__ = AsyncMock(return_value=False)

        mock_session = AsyncMock()
        mock_session.post = MagicMock(return_value=mock_response)
        mock_session.__aenter__ = AsyncMock(return_value=mock_session)
        mock_session.__aexit__ = AsyncMock(return_value=False)

        with patch(
            "graphs.react_agent.utils.token.aiohttp.ClientSession",
            return_value=mock_session,
        ):
            result = await get_mcp_access_token("sb-token", "http://mcp.example.com")

        assert result is None

    async def test_url_gets_mcp_suffix_in_resource(self):
        """The ``resource`` form field must end with /mcp."""
        from graphs.react_agent.utils.token import get_mcp_access_token

        captured_data: dict = {}

        mock_response = AsyncMock()
        mock_response.status = 200
        mock_response.json = AsyncMock(return_value={"access_token": "tok"})
        mock_response.__aenter__ = AsyncMock(return_value=mock_response)
        mock_response.__aexit__ = AsyncMock(return_value=False)

        mock_session = AsyncMock()

        def _capture_post(url, **kwargs):
            captured_data.update(kwargs.get("data", {}))
            return mock_response

        mock_session.post = MagicMock(side_effect=_capture_post)
        mock_session.__aenter__ = AsyncMock(return_value=mock_session)
        mock_session.__aexit__ = AsyncMock(return_value=False)

        with patch(
            "graphs.react_agent.utils.token.aiohttp.ClientSession",
            return_value=mock_session,
        ):
            await get_mcp_access_token("sb-token", "http://mcp.example.com")

        assert captured_data.get("resource", "").endswith("/mcp")


# ---------------------------------------------------------------------------
# Integration-style: graph() build phase simulation
# ---------------------------------------------------------------------------


class TestGraphBuildPhaseSimulation:
    """
    Simulate the exact failure scenario from the bug report.

    These tests verify that the full call chain used during graph construction
    does not raise ``RuntimeError: Called get_config outside of a runnable
    context``.
    """

    async def test_fetch_tokens_does_not_raise_outside_runnable_context(self):
        """
        Regression test: fetch_tokens(config, store=store) must not raise
        RuntimeError when called during graph build (no runnable context).
        """
        from graphs.react_agent.utils.token import fetch_tokens

        # Simulate the server passing a real store during graph build
        store = _make_store(token_record=None)
        config = _make_config(mcp_config=_MCP_CONFIG_AUTH_REQUIRED)
        fresh_token = {"access_token": "build-tok", "expires_in": 3600}

        # get_store() would raise — but we pass store explicitly, so it won't be called
        with (
            patch(
                "graphs.react_agent.utils.token.get_store",
                side_effect=RuntimeError(
                    "Called get_config outside of a runnable context"
                ),
            ),
            patch(
                "graphs.react_agent.utils.token.get_mcp_access_token",
                new=AsyncMock(return_value=fresh_token),
            ),
        ):
            # Must NOT raise
            result = await fetch_tokens(config, store=store)

        assert result == fresh_token

    async def test_get_store_never_called_when_store_provided(self):
        """
        When store is provided, langgraph.config.get_store must never be
        called — even transitively through get_tokens / set_tokens.
        """
        from graphs.react_agent.utils.token import fetch_tokens

        store = _make_store(token_record=None)
        config = _make_config(mcp_config=_MCP_CONFIG_AUTH_REQUIRED)
        fresh_token = {"access_token": "tok", "expires_in": 3600}

        with (
            patch("graphs.react_agent.utils.token.get_store") as mock_get_store,
            patch(
                "graphs.react_agent.utils.token.get_mcp_access_token",
                new=AsyncMock(return_value=fresh_token),
            ),
        ):
            await fetch_tokens(config, store=store)

        mock_get_store.assert_not_called()

    async def test_auth_required_false_never_calls_fetch_tokens(self):
        """
        Sanity check: when no server requires auth, fetch_tokens is not
        called at all and the code path never touches get_store.
        """
        from graphs.react_agent.utils.token import fetch_tokens

        store = _make_store(token_record=None)
        config = _make_config(mcp_config=_MCP_CONFIG_NO_AUTH)

        with patch(
            "graphs.react_agent.utils.token.get_store",
            side_effect=RuntimeError("should not be called"),
        ):
            # No auth-required server → fetch_tokens returns None without
            # touching the store at all
            result = await fetch_tokens(config, store=store)

        assert result is None
