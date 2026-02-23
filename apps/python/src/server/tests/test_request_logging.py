"""Unit tests for the DEBUG request logging middleware and helpers.

Tests cover:
- _PATH_ID_PATTERN: UUID extraction from request paths
- _is_sensitive_key: sensitive key name detection (substring match)
- _mask_sensitive: recursive in-place masking of sensitive dict values
- request_logging_middleware: request logging at DEBUG level
"""

import json
import logging
from copy import deepcopy
from unittest.mock import MagicMock

import pytest

from server.app import (
    _PATH_ID_PATTERN,
    _is_sensitive_key,
    _mask_sensitive,
    log_request,
)


# ============================================================================
# _PATH_ID_PATTERN tests
# ============================================================================


class TestPathIdPattern:
    """Tests for UUID extraction regex from request paths."""

    def test_extracts_thread_id(self):
        path = "/threads/550e8400-e29b-41d4-a716-446655440000/state"
        ids = {
            m.group("resource"): m.group("id") for m in _PATH_ID_PATTERN.finditer(path)
        }
        assert ids == {"threads": "550e8400-e29b-41d4-a716-446655440000"}

    def test_extracts_assistant_id(self):
        path = "/assistants/abcdef12-3456-7890-abcd-ef1234567890"
        ids = {
            m.group("resource"): m.group("id") for m in _PATH_ID_PATTERN.finditer(path)
        }
        assert ids == {"assistants": "abcdef12-3456-7890-abcd-ef1234567890"}

    def test_extracts_multiple_ids(self):
        path = "/threads/aaaabbbb-cccc-dddd-eeee-ffffffffffff/runs/11112222-3333-4444-5555-666677778888/stream"
        ids = {
            m.group("resource"): m.group("id") for m in _PATH_ID_PATTERN.finditer(path)
        }
        assert "threads" in ids
        assert "runs" in ids
        assert ids["threads"] == "aaaabbbb-cccc-dddd-eeee-ffffffffffff"
        assert ids["runs"] == "11112222-3333-4444-5555-666677778888"

    def test_no_match_for_short_ids(self):
        """IDs shorter than 8 chars should not match (not UUIDs)."""
        path = "/threads/abc/runs"
        ids = {
            m.group("resource"): m.group("id") for m in _PATH_ID_PATTERN.finditer(path)
        }
        assert ids == {}

    def test_no_match_for_non_hex_ids(self):
        path = "/threads/search"
        ids = {
            m.group("resource"): m.group("id") for m in _PATH_ID_PATTERN.finditer(path)
        }
        assert ids == {}

    def test_matches_uuid_without_dashes(self):
        path = "/assistants/550e8400e29b41d4a716446655440000"
        ids = {
            m.group("resource"): m.group("id") for m in _PATH_ID_PATTERN.finditer(path)
        }
        assert "assistants" in ids

    def test_root_path_no_match(self):
        path = "/"
        ids = list(_PATH_ID_PATTERN.finditer(path))
        assert ids == []

    def test_health_path_no_match(self):
        path = "/health"
        ids = list(_PATH_ID_PATTERN.finditer(path))
        assert ids == []


# ============================================================================
# _is_sensitive_key tests
# ============================================================================


class TestIsSensitiveKey:
    """Tests for sensitive key detection via substring matching."""

    @pytest.mark.parametrize(
        "key",
        [
            "authorization",
            "Authorization",
            "AUTHORIZATION",
            "api_key",
            "API_KEY",
            "apikey",
            "ApiKey",
            "api-key",
            "token",
            "TOKEN",
            "secret",
            "SECRET",
            "password",
            "Password",
            "credential",
        ],
    )
    def test_exact_sensitive_keys(self, key: str):
        assert _is_sensitive_key(key) is True

    @pytest.mark.parametrize(
        "key",
        [
            "OPENAI_API_KEY",
            "ANTHROPIC_API_KEY",
            "GOOGLE_API_KEY",
            "custom_api_key",
            "x-auth-token",
            "X-Api-Key",
            "jwt_secret",
            "db_password",
            "service_credential",
            "my_authorization_header",
        ],
    )
    def test_compound_sensitive_keys(self, key: str):
        """Keys containing sensitive substrings should be detected."""
        assert _is_sensitive_key(key) is True

    @pytest.mark.parametrize(
        "key",
        [
            "model_name",
            "temperature",
            "input",
            "metadata",
            "graph_id",
            "thread_id",
            "content",
            "status",
            "name",
            "description",
        ],
    )
    def test_safe_keys(self, key: str):
        assert _is_sensitive_key(key) is False


# ============================================================================
# _mask_sensitive tests
# ============================================================================


class TestMaskSensitive:
    """Tests for recursive in-place masking of sensitive values."""

    def test_masks_top_level_key(self):
        data = {"authorization": "Bearer sk-secret", "input": "hello"}
        _mask_sensitive(data)
        assert data["authorization"] == "***"
        assert data["input"] == "hello"

    def test_masks_nested_key(self):
        data = {"config": {"api_key": "sk-123", "model": "gpt-4o"}}
        _mask_sensitive(data)
        assert data["config"]["api_key"] == "***"
        assert data["config"]["model"] == "gpt-4o"

    def test_masks_compound_key_names(self):
        data = {
            "OPENAI_API_KEY": "sk-openai",
            "custom_api_key": "custom-val",
            "safe_field": "visible",
        }
        _mask_sensitive(data)
        assert data["OPENAI_API_KEY"] == "***"
        assert data["custom_api_key"] == "***"
        assert data["safe_field"] == "visible"

    def test_masks_in_list_of_dicts(self):
        data = [
            {"token": "tok-1", "name": "a"},
            {"password": "pw", "name": "b"},
        ]
        _mask_sensitive(data)
        assert data[0]["token"] == "***"
        assert data[0]["name"] == "a"
        assert data[1]["password"] == "***"
        assert data[1]["name"] == "b"

    def test_deeply_nested(self):
        data = {
            "level1": {
                "level2": {
                    "level3": {
                        "secret": "deep-secret",
                        "value": "visible",
                    }
                }
            }
        }
        _mask_sensitive(data)
        assert data["level1"]["level2"]["level3"]["secret"] == "***"
        assert data["level1"]["level2"]["level3"]["value"] == "visible"

    def test_stops_at_depth_limit(self):
        """Masking should stop recursing at depth 5 to avoid pathological payloads."""
        # Build a structure deeper than 5 levels with a secret at the bottom
        data: dict = {}
        current = data
        for i in range(7):
            child: dict = {}
            current[f"level{i}"] = child
            current = child
        current["secret"] = "should-survive"

        _mask_sensitive(data)
        # At depth > 5, the secret should NOT be masked (recursion stopped)
        assert current["secret"] == "should-survive"

    def test_empty_dict(self):
        data: dict = {}
        _mask_sensitive(data)
        assert data == {}

    def test_empty_list(self):
        data: list = []
        _mask_sensitive(data)
        assert data == []

    def test_non_dict_non_list_is_noop(self):
        """Passing a string or int should not raise."""
        _mask_sensitive("just a string")
        _mask_sensitive(42)
        _mask_sensitive(None)

    def test_preserves_non_string_keys(self):
        """Non-string keys should be left alone (no crash)."""
        data = {123: "numeric-key", "safe": "value"}
        _mask_sensitive(data)
        assert data[123] == "numeric-key"
        assert data["safe"] == "value"

    def test_apikeys_dict_masked(self):
        """The apiKeys dict from frontend contains sensitive keys — should be masked."""
        data = {
            "config": {
                "apiKeys": {
                    "OPENAI_API_KEY": "sk-secret",
                    "ANTHROPIC_API_KEY": "sk-ant-xxx",
                }
            },
            "input": "visible",
        }
        _mask_sensitive(data)
        # "apiKeys" contains "apikey" substring, so the whole value is masked
        assert data["config"]["apiKeys"] == "***"
        assert data["input"] == "visible"

    def test_does_not_modify_original_when_using_deepcopy(self):
        """Verify masking is in-place — a deepcopy remains unmasked."""
        original = {"secret": "my-password", "name": "test"}
        copy = deepcopy(original)
        _mask_sensitive(copy)
        assert original["secret"] == "my-password"
        assert copy["secret"] == "***"


# ============================================================================
# request_logging_middleware tests
# ============================================================================


def _make_mock_request(
    method: str = "GET",
    path: str = "/health",
    headers: dict | None = None,
    body: str | bytes | None = None,
) -> MagicMock:
    """Create a mock Robyn request for middleware testing."""
    request = MagicMock()
    request.method = method
    request.url = path
    request.headers = headers or {}
    if body is not None:
        request.body = body if isinstance(body, bytes) else body.encode("utf-8")
    else:
        request.body = None
    return request


class TestRequestLoggingMiddleware:
    """Tests for the request_logging_middleware function."""

    @pytest.mark.asyncio
    async def test_returns_request_at_debug_level(self, caplog):
        """Middleware should always return the request object (never block)."""
        request = _make_mock_request("GET", "/health")
        with caplog.at_level(logging.DEBUG, logger="server.app"):
            result = await log_request(request)
        assert result is request

    @pytest.mark.asyncio
    async def test_skips_logging_above_debug(self):
        """When log level is INFO or higher, middleware should short-circuit."""
        request = _make_mock_request("GET", "/assistants")
        logger_instance = logging.getLogger("server.app")
        original_level = logger_instance.level

        try:
            logger_instance.setLevel(logging.INFO)
            result = await log_request(request)
            assert result is request
        finally:
            logger_instance.setLevel(original_level)

    @pytest.mark.asyncio
    async def test_logs_method_and_path(self, caplog):
        """Middleware should log the HTTP method and path."""
        request = _make_mock_request("POST", "/threads")
        with caplog.at_level(logging.DEBUG, logger="server.app"):
            await log_request(request)

        assert any(
            "POST" in record.message and "/threads" in record.message
            for record in caplog.records
        )

    @pytest.mark.asyncio
    async def test_logs_extracted_thread_id(self, caplog):
        """Middleware should extract and log thread_id from path."""
        request = _make_mock_request(
            "GET", "/threads/abcdef12-3456-7890-abcd-ef1234567890"
        )
        with caplog.at_level(logging.DEBUG, logger="server.app"):
            await log_request(request)

        assert any(
            "threads_id=abcdef12-3456-7890-abcd-ef1234567890" in record.message
            for record in caplog.records
        )

    @pytest.mark.asyncio
    async def test_logs_body_for_post(self, caplog):
        """POST requests should have their body logged at DEBUG."""
        body = json.dumps({"input": "hello", "model": "gpt-4o"})
        request = _make_mock_request("POST", "/threads", body=body)
        with caplog.at_level(logging.DEBUG, logger="server.app"):
            await log_request(request)

        body_logs = [r for r in caplog.records if "body:" in r.message]
        assert len(body_logs) >= 1
        assert "hello" in body_logs[0].message

    @pytest.mark.asyncio
    async def test_body_sensitive_values_masked(self, caplog):
        """Sensitive values in request body should be masked before logging."""
        body = json.dumps({"input": "hello", "api_key": "sk-secret-123"})
        request = _make_mock_request("POST", "/assistants", body=body)
        with caplog.at_level(logging.DEBUG, logger="server.app"):
            await log_request(request)

        body_logs = [r for r in caplog.records if "body:" in r.message]
        assert len(body_logs) >= 1
        # Secret should be masked
        assert "sk-secret-123" not in body_logs[0].message
        assert "***" in body_logs[0].message
        # Safe value should remain
        assert "hello" in body_logs[0].message

    @pytest.mark.asyncio
    async def test_no_body_log_for_get(self, caplog):
        """GET requests should not attempt to log a body."""
        request = _make_mock_request("GET", "/health")
        with caplog.at_level(logging.DEBUG, logger="server.app"):
            await log_request(request)

        body_logs = [r for r in caplog.records if "body:" in r.message]
        assert len(body_logs) == 0

    @pytest.mark.asyncio
    async def test_large_body_truncated(self, caplog):
        """Bodies larger than 4096 bytes should show a truncation message."""
        body = json.dumps({"data": "x" * 5000})
        request = _make_mock_request("POST", "/threads", body=body)
        with caplog.at_level(logging.DEBUG, logger="server.app"):
            await log_request(request)

        body_logs = [r for r in caplog.records if "body:" in r.message]
        assert len(body_logs) >= 1
        assert "truncated" in body_logs[0].message

    @pytest.mark.asyncio
    async def test_invalid_json_body_logged_as_raw(self, caplog):
        """Non-JSON bodies should be logged as raw text."""
        request = _make_mock_request("POST", "/threads", body="not-json{{{")
        with caplog.at_level(logging.DEBUG, logger="server.app"):
            await log_request(request)

        body_logs = [r for r in caplog.records if "body" in r.message]
        assert len(body_logs) >= 1
        assert "not-json" in body_logs[0].message

    @pytest.mark.asyncio
    async def test_content_length_logged(self, caplog):
        """Content-Length header should appear in log output."""
        request = _make_mock_request(
            "POST", "/threads", headers={"content-length": "42"}
        )
        with caplog.at_level(logging.DEBUG, logger="server.app"):
            await log_request(request)

        assert any("content_length=42" in record.message for record in caplog.records)

    @pytest.mark.asyncio
    async def test_missing_content_length_shows_dash(self, caplog):
        """Missing Content-Length should show '-' in log output."""
        request = _make_mock_request("GET", "/health", headers={})
        with caplog.at_level(logging.DEBUG, logger="server.app"):
            await log_request(request)

        assert any("content_length=-" in record.message for record in caplog.records)

    @pytest.mark.asyncio
    async def test_null_body_no_crash(self, caplog):
        """Request with None body should not crash."""
        request = _make_mock_request("POST", "/threads", body=None)
        with caplog.at_level(logging.DEBUG, logger="server.app"):
            result = await log_request(request)
        assert result is request

    @pytest.mark.asyncio
    async def test_path_without_url_attribute(self, caplog):
        """Request without url attribute should default to '/'."""
        request = MagicMock(spec=[])
        request.method = "GET"
        request.headers = {}
        request.body = None

        with caplog.at_level(logging.DEBUG, logger="server.app"):
            result = await log_request(request)
        assert result is request
