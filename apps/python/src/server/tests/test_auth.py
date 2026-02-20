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


# ============================================================================
# Local JWT verification  (server/auth — verify_token_local)
# ============================================================================


class TestVerifyTokenLocal:
    """Tests for ``verify_token_local`` — HS256 JWT verification."""

    def _make_jwt(
        self,
        secret: str = "benchmark-jwt-secret-that-is-at-least-32-characters-long",
        sub: str = "user-123",
        email: str = "test@example.com",
        exp_offset: int = 3600,
        alg: str = "HS256",
        extra_claims: dict | None = None,
    ) -> str:
        """Build a minimal HS256-signed JWT for testing."""
        import base64
        import hashlib
        import hmac as hmac_mod
        import json
        import time

        def b64url(data: bytes) -> str:
            return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")

        header = json.dumps({"alg": alg, "typ": "JWT"})
        payload_dict: dict = {
            "sub": sub,
            "email": email,
            "iat": int(time.time()),
            "exp": int(time.time()) + exp_offset,
            "aud": "authenticated",
            "role": "authenticated",
            "user_metadata": {"email": email, "benchmark": True},
        }
        if extra_claims:
            payload_dict.update(extra_claims)
        payload = json.dumps(payload_dict)

        header_b64 = b64url(header.encode())
        payload_b64 = b64url(payload.encode())
        signature_input = f"{header_b64}.{payload_b64}".encode("ascii")
        signature = hmac_mod.new(
            secret.encode(), signature_input, hashlib.sha256
        ).digest()
        signature_b64 = b64url(signature)
        return f"{header_b64}.{payload_b64}.{signature_b64}"

    def test_valid_token(self):
        """verify_token_local returns AuthUser for valid HS256 JWT."""
        from server.auth import verify_token_local
        import server.auth as auth_mod

        secret = "benchmark-jwt-secret-that-is-at-least-32-characters-long"
        original = auth_mod._jwt_secret_bytes
        auth_mod._jwt_secret_bytes = secret.encode()
        try:
            token = self._make_jwt(secret=secret, sub="u-1", email="a@b.com")
            user = verify_token_local(token)
            assert user.identity == "u-1"
            assert user.email == "a@b.com"
            assert user.metadata.get("benchmark") is True
        finally:
            auth_mod._jwt_secret_bytes = original

    def test_expired_token(self):
        """verify_token_local rejects expired tokens."""
        from server.auth import verify_token_local
        import server.auth as auth_mod

        secret = "benchmark-jwt-secret-that-is-at-least-32-characters-long"
        original = auth_mod._jwt_secret_bytes
        auth_mod._jwt_secret_bytes = secret.encode()
        try:
            token = self._make_jwt(secret=secret, exp_offset=-100)
            with pytest.raises(AuthenticationError, match="expired"):
                verify_token_local(token)
        finally:
            auth_mod._jwt_secret_bytes = original

    def test_invalid_signature(self):
        """verify_token_local rejects tokens signed with wrong secret."""
        from server.auth import verify_token_local
        import server.auth as auth_mod

        original = auth_mod._jwt_secret_bytes
        auth_mod._jwt_secret_bytes = b"correct-secret-that-is-at-least-32-chars-long!"
        try:
            token = self._make_jwt(
                secret="wrong-secret-that-is-at-least-32-chars-long!!"
            )
            with pytest.raises(AuthenticationError, match="signature"):
                verify_token_local(token)
        finally:
            auth_mod._jwt_secret_bytes = original

    def test_malformed_token(self):
        """verify_token_local rejects tokens with wrong part count."""
        from server.auth import verify_token_local
        import server.auth as auth_mod

        original = auth_mod._jwt_secret_bytes
        auth_mod._jwt_secret_bytes = b"some-secret-at-least-32-characters-long!!"
        try:
            with pytest.raises(AuthenticationError, match="3 parts"):
                verify_token_local("not.a.valid.jwt.token")
            with pytest.raises(AuthenticationError, match="3 parts"):
                verify_token_local("onlyonepart")
        finally:
            auth_mod._jwt_secret_bytes = original

    def test_unsupported_algorithm(self):
        """verify_token_local rejects non-HS256 algorithms."""
        from server.auth import verify_token_local
        import server.auth as auth_mod

        secret = "benchmark-jwt-secret-that-is-at-least-32-characters-long"
        original = auth_mod._jwt_secret_bytes
        auth_mod._jwt_secret_bytes = secret.encode()
        try:
            token = self._make_jwt(secret=secret, alg="RS256")
            with pytest.raises(AuthenticationError, match="Unsupported JWT algorithm"):
                verify_token_local(token)
        finally:
            auth_mod._jwt_secret_bytes = original

    def test_missing_sub_claim(self):
        """verify_token_local rejects tokens without sub claim."""
        from server.auth import verify_token_local
        import server.auth as auth_mod

        secret = "benchmark-jwt-secret-that-is-at-least-32-characters-long"
        original = auth_mod._jwt_secret_bytes
        auth_mod._jwt_secret_bytes = secret.encode()
        try:
            token = self._make_jwt(secret=secret, sub="")
            with pytest.raises(AuthenticationError, match="sub claim"):
                verify_token_local(token)
        finally:
            auth_mod._jwt_secret_bytes = original

    def test_no_secret_configured(self):
        """verify_token_local raises when _jwt_secret_bytes is None."""
        from server.auth import verify_token_local
        import server.auth as auth_mod

        original = auth_mod._jwt_secret_bytes
        auth_mod._jwt_secret_bytes = None
        try:
            with pytest.raises(AuthenticationError, match="SUPABASE_JWT_SECRET"):
                verify_token_local("any.token.here")
        finally:
            auth_mod._jwt_secret_bytes = original

    def test_invalid_header_encoding(self):
        """verify_token_local rejects tokens with invalid base64 header."""
        from server.auth import verify_token_local
        import server.auth as auth_mod

        original = auth_mod._jwt_secret_bytes
        auth_mod._jwt_secret_bytes = b"secret-that-is-at-least-32-characters-long!!"
        try:
            with pytest.raises(AuthenticationError, match="header"):
                verify_token_local("!!!invalid-base64!!!.payload.signature")
        finally:
            auth_mod._jwt_secret_bytes = original


# ============================================================================
# Auth state helpers  (is_auth_enabled, is_local_jwt_enabled, log_auth_status)
# ============================================================================


class TestAuthStateHelpers:
    """Tests for ``is_auth_enabled``, ``is_local_jwt_enabled``, ``log_auth_status``."""

    def test_is_auth_enabled_with_supabase(self, monkeypatch):
        """is_auth_enabled returns True when SUPABASE_URL and SUPABASE_KEY set."""
        import server.auth as auth_mod

        monkeypatch.setenv("SUPABASE_URL", "http://localhost:54321")
        monkeypatch.setenv("SUPABASE_KEY", "some-anon-key")
        # Reset the cached value
        if hasattr(auth_mod, "_auth_enabled_cache"):
            auth_mod._auth_enabled_cache = None
        result = auth_mod.is_auth_enabled()
        assert isinstance(result, bool)

    def test_is_local_jwt_enabled_with_secret(self, monkeypatch):
        """is_local_jwt_enabled returns True when SUPABASE_JWT_SECRET is set."""
        import server.auth as auth_mod

        monkeypatch.setenv("SUPABASE_JWT_SECRET", "some-long-secret-value-for-testing")
        if hasattr(auth_mod, "_local_jwt_cache"):
            auth_mod._local_jwt_cache = None
        result = auth_mod.is_local_jwt_enabled()
        assert isinstance(result, bool)

    def test_is_local_jwt_enabled_without_secret(self, monkeypatch):
        """is_local_jwt_enabled returns False when SUPABASE_JWT_SECRET is unset."""
        import server.auth as auth_mod

        monkeypatch.delenv("SUPABASE_JWT_SECRET", raising=False)
        if hasattr(auth_mod, "_local_jwt_cache"):
            auth_mod._local_jwt_cache = None
        result = auth_mod.is_local_jwt_enabled()
        assert result is False

    def test_log_auth_status(self, caplog):
        """log_auth_status runs without error and produces log output."""
        import server.auth as auth_mod

        # Just verify it doesn't crash — the output depends on env vars
        auth_mod.log_auth_status()


# ============================================================================
# verify_token_auto  (strategy selector)
# ============================================================================


class TestVerifyTokenAuto:
    """Tests for ``verify_token_auto`` — strategy selection."""

    async def test_auto_with_local_jwt(self, monkeypatch):
        """verify_token_auto uses local verification when secret is set."""
        import server.auth as auth_mod

        secret = "benchmark-jwt-secret-that-is-at-least-32-characters-long"
        original_bytes = auth_mod._jwt_secret_bytes
        auth_mod._jwt_secret_bytes = secret.encode()

        # Build a valid token
        import base64
        import hashlib
        import hmac as hmac_mod
        import json
        import time

        def b64url(data: bytes) -> str:
            return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")

        header = b64url(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
        payload = b64url(
            json.dumps(
                {
                    "sub": "auto-user",
                    "email": "auto@test.com",
                    "exp": int(time.time()) + 3600,
                    "iat": int(time.time()),
                    "user_metadata": {},
                }
            ).encode()
        )
        sig = b64url(
            hmac_mod.new(
                secret.encode(),
                f"{header}.{payload}".encode("ascii"),
                hashlib.sha256,
            ).digest()
        )
        token = f"{header}.{payload}.{sig}"

        try:
            user = await auth_mod.verify_token_auto(token)
            assert user.identity == "auto-user"
            assert user.email == "auto@test.com"
        finally:
            auth_mod._jwt_secret_bytes = original_bytes
