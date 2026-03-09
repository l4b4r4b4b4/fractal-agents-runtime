"""Minimal tests for graphs.react_agent.utils.token.fetch_tokens (Goal 46).

These tests validate the direct JWT pass-through behavior:
- Prefer `configurable["langgraph_auth_user"]["token"]`
- Fallback to `configurable["x-supabase-access-token"]`
- Return `None` when no token available
- Keep `store` parameter for call-site compatibility (ignored)
"""

from __future__ import annotations

from typing import Any

import pytest
from langchain_core.runnables import RunnableConfig
from unittest.mock import MagicMock

from graphs.react_agent.utils.token import fetch_tokens


@pytest.mark.asyncio
async def test_returns_jwt_from_langgraph_auth_user() -> None:
    """fetch_tokens returns the JWT from langgraph_auth_user['token']."""
    config = RunnableConfig(
        configurable={"langgraph_auth_user": {"token": "eyJlanggraph"}}
    )

    result = await fetch_tokens(config)

    assert isinstance(result, dict)
    assert result == {"access_token": "eyJlanggraph"}


@pytest.mark.asyncio
async def test_falls_back_to_x_supabase_access_token() -> None:
    """fetch_tokens falls back to x-supabase-access-token when langgraph_auth_user absent."""
    config = RunnableConfig(configurable={"x-supabase-access-token": "eyJlegacy"})

    result = await fetch_tokens(config)

    assert isinstance(result, dict)
    assert result == {"access_token": "eyJlegacy"}


@pytest.mark.asyncio
async def test_prefers_langgraph_auth_user_over_legacy_key() -> None:
    """When both keys present, langgraph_auth_user.token takes precedence."""
    config = RunnableConfig(
        configurable={
            "langgraph_auth_user": {"token": "eyJnew"},
            "x-supabase-access-token": "eyJold",
        }
    )

    result = await fetch_tokens(config)

    assert result == {"access_token": "eyJnew"}


@pytest.mark.asyncio
async def test_returns_none_when_no_token() -> None:
    """fetch_tokens returns None when no token is available in configurable."""
    config = RunnableConfig(configurable={})

    result = await fetch_tokens(config)

    assert result is None


@pytest.mark.asyncio
async def test_store_param_accepted_but_ignored() -> None:
    """The optional store parameter is accepted for compatibility but ignored."""
    config = RunnableConfig(configurable={"langgraph_auth_user": {"token": "eyJstore"}})
    fake_store: Any = MagicMock()

    result = await fetch_tokens(config, store=fake_store)

    assert result == {"access_token": "eyJstore"}
