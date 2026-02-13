"""Unit tests for Robyn auth middleware.

Tests cover:
- Token parsing from Authorization header
- Public path detection
- Error response format
- User context management
"""

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from server.auth import (
    AuthenticationError,
    AuthUser,
    auth_middleware,
    create_error_response,
    get_current_user,
    get_user_identity,
    is_public_path,
    require_user,
    verify_token,
)


# ============================================================================
# AuthUser Tests
# ============================================================================


class TestAuthUser:
    """Tests for AuthUser dataclass."""

    def test_create_basic(self):
        """Test creating AuthUser with minimal fields."""
        user = AuthUser(identity="user-123")
        assert user.identity == "user-123"
        assert user.email is None
        assert user.metadata is None

    def test_create_full(self):
        """Test creating AuthUser with all fields."""
        user = AuthUser(
            identity="user-123",
            email="test@example.com",
            metadata={"role": "admin"},
        )
        assert user.identity == "user-123"
        assert user.email == "test@example.com"
        assert user.metadata == {"role": "admin"}

    def test_to_dict_minimal(self):
        """Test to_dict with minimal fields."""
        user = AuthUser(identity="user-123")
        result = user.to_dict()
        assert result == {
            "identity": "user-123",
            "email": None,
            "metadata": {},
        }

    def test_to_dict_full(self):
        """Test to_dict with all fields."""
        user = AuthUser(
            identity="user-123",
            email="test@example.com",
            metadata={"role": "admin"},
        )
        result = user.to_dict()
        assert result == {
            "identity": "user-123",
            "email": "test@example.com",
            "metadata": {"role": "admin"},
        }


# ============================================================================
# Public Path Detection Tests
# ============================================================================


class TestIsPublicPath:
    """Tests for public path detection."""

    @pytest.mark.parametrize(
        "path",
        [
            "/",
            "/health",
            "/ok",
            "/info",
            "/docs",
            "/openapi.json",
        ],
    )
    def test_public_paths(self, path: str):
        """Test that known public paths are detected."""
        assert is_public_path(path) is True

    @pytest.mark.parametrize(
        "path",
        [
            "/health/",  # trailing slash
            "/ok/",
            "/info/",
        ],
    )
    def test_public_paths_with_trailing_slash(self, path: str):
        """Test that public paths with trailing slash are detected."""
        assert is_public_path(path) is True

    @pytest.mark.parametrize(
        "path",
        [
            "/assistants",
            "/threads",
            "/runs",
            "/threads/123/runs",
            "/api/health",  # nested health is not public
            "/v1/ok",  # prefixed ok is not public
        ],
    )
    def test_protected_paths(self, path: str):
        """Test that protected paths are not public."""
        assert is_public_path(path) is False


# ============================================================================
# Error Response Tests
# ============================================================================


class TestCreateErrorResponse:
    """Tests for error response creation."""

    def test_default_status_code(self):
        """Test error response with default 401 status."""
        response = create_error_response("Unauthorized")
        assert response.status_code == 401
        # Robyn uses 'description' for the body
        body = json.loads(response.description)
        assert body == {"detail": "Unauthorized"}
        assert response.headers["Content-Type"] == "application/json"

    def test_custom_status_code(self):
        """Test error response with custom status code."""
        response = create_error_response("Server error", status_code=500)
        assert response.status_code == 500
        body = json.loads(response.description)
        assert body == {"detail": "Server error"}

    def test_message_in_detail(self):
        """Test that message is in 'detail' field (LangGraph format)."""
        response = create_error_response("Auth header missing")
        body = json.loads(response.description)
        assert "detail" in body
        assert body["detail"] == "Auth header missing"


# ============================================================================
# AuthenticationError Tests
# ============================================================================


class TestAuthenticationError:
    """Tests for AuthenticationError exception."""

    def test_default_status_code(self):
        """Test error with default status code."""
        error = AuthenticationError("Invalid token")
        assert error.message == "Invalid token"
        assert error.status_code == 401
        assert str(error) == "Invalid token"

    def test_custom_status_code(self):
        """Test error with custom status code."""
        error = AuthenticationError("Server error", status_code=500)
        assert error.message == "Server error"
        assert error.status_code == 500


# ============================================================================
# Token Verification Tests
# ============================================================================


class TestVerifyToken:
    """Tests for token verification."""

    @pytest.mark.asyncio
    async def test_verify_token_success(self):
        """Test successful token verification."""
        mock_user = MagicMock()
        mock_user.id = "user-123"
        mock_user.email = "test@example.com"
        mock_user.user_metadata = {"role": "user"}

        mock_response = MagicMock()
        mock_response.user = mock_user

        mock_supabase = MagicMock()
        mock_supabase.auth.get_user.return_value = mock_response

        with patch("server.auth.get_supabase_client", return_value=mock_supabase):
            user = await verify_token("valid-token")

        assert user.identity == "user-123"
        assert user.email == "test@example.com"
        assert user.metadata == {"role": "user"}
        mock_supabase.auth.get_user.assert_called_once_with("valid-token")

    @pytest.mark.asyncio
    async def test_verify_token_no_supabase_client(self):
        """Test token verification when Supabase client is not initialized."""
        with patch("server.auth.get_supabase_client", return_value=None):
            with pytest.raises(AuthenticationError) as exc_info:
                await verify_token("any-token")
            assert "Supabase client not initialized" in str(exc_info.value)

    @pytest.mark.asyncio
    async def test_verify_token_invalid_token(self):
        """Test token verification with invalid token."""
        mock_response = MagicMock()
        mock_response.user = None

        mock_supabase = MagicMock()
        mock_supabase.auth.get_user.return_value = mock_response

        with patch("server.auth.get_supabase_client", return_value=mock_supabase):
            with pytest.raises(AuthenticationError) as exc_info:
                await verify_token("invalid-token")
            assert "Invalid token or user not found" in str(exc_info.value)

    @pytest.mark.asyncio
    async def test_verify_token_supabase_error(self):
        """Test token verification when Supabase raises an error."""
        mock_supabase = MagicMock()
        mock_supabase.auth.get_user.side_effect = Exception("Connection failed")

        with patch("server.auth.get_supabase_client", return_value=mock_supabase):
            with pytest.raises(AuthenticationError) as exc_info:
                await verify_token("any-token")
            assert "Authentication error" in str(exc_info.value)


# ============================================================================
# Middleware Tests
# ============================================================================


class TestAuthMiddleware:
    """Tests for auth middleware."""

    def _make_request(
        self, path: str = "/assistants", auth_header: str | None = None
    ) -> MagicMock:
        """Create a mock Robyn request."""
        request = MagicMock()
        request.url = path
        request.headers = {}
        if auth_header:
            request.headers["authorization"] = auth_header
        return request

    @pytest.mark.asyncio
    async def test_public_path_skips_auth(self):
        """Test that public paths skip authentication."""
        request = self._make_request(path="/health")
        result = await auth_middleware(request)
        # Should return the request unchanged
        assert result is request

    @pytest.mark.asyncio
    async def test_missing_auth_header(self):
        """Test request without Authorization header."""
        request = self._make_request(path="/assistants", auth_header=None)
        result = await auth_middleware(request)
        # Should return an error response
        assert result.status_code == 401
        body = json.loads(result.description)
        assert body["detail"] == "Authorization header missing"

    @pytest.mark.asyncio
    async def test_invalid_auth_header_format_no_space(self):
        """Test request with invalid Authorization header (no space)."""
        request = self._make_request(path="/assistants", auth_header="Bearer")
        result = await auth_middleware(request)
        assert result.status_code == 401
        body = json.loads(result.description)
        assert "Invalid authorization header format" in body["detail"]

    @pytest.mark.asyncio
    async def test_invalid_auth_header_format_wrong_scheme(self):
        """Test request with wrong auth scheme."""
        request = self._make_request(path="/assistants", auth_header="Basic token123")
        result = await auth_middleware(request)
        assert result.status_code == 401
        body = json.loads(result.description)
        assert "Invalid authorization header format" in body["detail"]

    @pytest.mark.asyncio
    async def test_valid_auth_header_success(self):
        """Test request with valid Authorization header."""
        mock_user = AuthUser(identity="user-123", email="test@example.com")

        request = self._make_request(
            path="/assistants", auth_header="Bearer valid-token"
        )

        with patch("server.auth.verify_token", new_callable=AsyncMock) as mock_verify:
            mock_verify.return_value = mock_user
            result = await auth_middleware(request)

        # Should return the request (continue processing)
        assert result is request
        mock_verify.assert_called_once_with("valid-token")

    @pytest.mark.asyncio
    async def test_valid_auth_header_token_invalid(self):
        """Test request where token verification fails."""
        request = self._make_request(
            path="/assistants", auth_header="Bearer invalid-token"
        )

        with patch("server.auth.verify_token", new_callable=AsyncMock) as mock_verify:
            mock_verify.side_effect = AuthenticationError("Token expired")
            result = await auth_middleware(request)

        assert result.status_code == 401
        body = json.loads(result.description)
        assert body["detail"] == "Token expired"

    @pytest.mark.asyncio
    async def test_case_insensitive_bearer(self):
        """Test that 'bearer' scheme is case-insensitive."""
        mock_user = AuthUser(identity="user-123")
        request = self._make_request(
            path="/assistants", auth_header="bearer valid-token"
        )

        with patch("server.auth.verify_token", new_callable=AsyncMock) as mock_verify:
            mock_verify.return_value = mock_user
            result = await auth_middleware(request)

        assert result is request

    @pytest.mark.asyncio
    async def test_case_insensitive_header_name(self):
        """Test that Authorization header name is case-insensitive."""
        mock_user = AuthUser(identity="user-123")
        request = MagicMock()
        request.url = "/assistants"
        request.headers = {"Authorization": "Bearer valid-token"}

        with patch("server.auth.verify_token", new_callable=AsyncMock) as mock_verify:
            mock_verify.return_value = mock_user
            result = await auth_middleware(request)

        assert result is request


# ============================================================================
# User Context Tests
# ============================================================================


class TestUserContext:
    """Tests for user context management."""

    @pytest.mark.asyncio
    async def test_get_current_user_after_auth(self):
        """Test getting current user after successful authentication."""
        mock_user = AuthUser(identity="user-456", email="user@example.com")
        request = MagicMock()
        request.url = "/assistants"
        request.headers = {"authorization": "Bearer token"}

        with patch("server.auth.verify_token", new_callable=AsyncMock) as mock_verify:
            mock_verify.return_value = mock_user
            await auth_middleware(request)

        user = get_current_user()
        assert user is not None
        assert user.identity == "user-456"

    def test_get_user_identity(self):
        """Test getting user identity shorthand."""
        # Set up a user in context
        from server.auth import _current_user

        _current_user.set(AuthUser(identity="user-789"))

        identity = get_user_identity()
        assert identity == "user-789"

        # Clean up
        _current_user.set(None)

    def test_get_user_identity_no_user(self):
        """Test getting user identity when not authenticated."""
        from server.auth import _current_user, _thread_local

        _current_user.set(None)
        # Also clear thread-local storage (fallback for Robyn's Rust/Python boundary)
        _thread_local.current_user = None

        identity = get_user_identity()
        assert identity is None

    def test_require_user_authenticated(self):
        """Test require_user when authenticated."""
        from server.auth import _current_user

        _current_user.set(AuthUser(identity="user-abc"))

        user = require_user()
        assert user.identity == "user-abc"

        # Clean up
        _current_user.set(None)

    def test_require_user_not_authenticated(self):
        """Test require_user when not authenticated."""
        from server.auth import _current_user, _thread_local

        _current_user.set(None)
        # Also clear thread-local storage (fallback for Robyn's Rust/Python boundary)
        _thread_local.current_user = None

        with pytest.raises(AuthenticationError) as exc_info:
            require_user()
        assert "Authentication required" in str(exc_info.value)
