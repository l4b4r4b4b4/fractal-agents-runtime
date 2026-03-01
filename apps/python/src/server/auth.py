"""Authentication middleware for Robyn server using Supabase JWT verification.

This module provides:
- Supabase JWT token verification via API call or local HS256
- Robyn middleware for authenticating requests
- User context extraction for downstream handlers
- ``is_auth_enabled()`` — cached check for Supabase configuration
- ``is_local_jwt_enabled()`` — cached check for ``SUPABASE_JWT_SECRET``
- ``verify_token_local()`` — fast local HS256 verification (sub-ms, no I/O)
- ``verify_token_auto()`` — auto-selects local vs HTTP strategy
- ``log_auth_status()`` — one-shot startup logging

Verification Strategies
-----------------------

**HTTP verification** (``verify_token``):
  Calls Supabase GoTrue ``auth.getUser(token)`` via HTTP. Authoritative but
  limited to ~30 req/s against a local GoTrue instance.

**Local verification** (``verify_token_local``):
  Verifies the HS256 JWT signature locally using ``SUPABASE_JWT_SECRET``
  and Python's ``hmac`` module. Sub-millisecond, no network round-trip.
  Opt-in via ``SUPABASE_JWT_SECRET`` env var.

  Tradeoffs (per Supabase docs recommendation):
    - Does NOT check token revocation (logout won't invalidate cached tokens)
    - Does NOT query user metadata from the database
    - Suitable for benchmarks and high-throughput scenarios

The active strategy is selected by ``verify_token_auto()``:
  - If ``SUPABASE_JWT_SECRET`` is set → local verification
  - Otherwise → HTTP verification via GoTrue

The authentication flow mirrors `infra/security/auth.py` but adapted
for Robyn's middleware system.
"""

import asyncio
import base64
import hashlib
import hmac
import json
import logging
import threading
import time
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any

from robyn import Request, Response

from server.config import get_config

logger = logging.getLogger(__name__)

# Context variable to store authenticated user for the current request
_current_user: ContextVar["AuthUser | None"] = ContextVar("current_user", default=None)

# Thread-local storage as fallback for Robyn's Rust/Python boundary
_thread_local = threading.local()

# Lazy-loaded Supabase client
_supabase_client: Any = None


# ============================================================================
# User Model
# ============================================================================


@dataclass
class AuthUser:
    """Authenticated user information extracted from JWT.

    Attributes:
        identity: Supabase user ID (UUID string)
        email: User's email address (optional)
        metadata: Additional user metadata from Supabase
    """

    identity: str
    email: str | None = None
    metadata: dict[str, Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for serialization."""
        return {
            "identity": self.identity,
            "email": self.email,
            "metadata": self.metadata or {},
        }


# ============================================================================
# Supabase Client
# ============================================================================


# ============================================================================
# Auth State — computed once at import time, cached forever
# ============================================================================

# Eagerly evaluate so the middleware never re-reads config on every request.
# Environment variables cannot change at runtime, so this is safe.
_auth_enabled: bool = get_config().supabase.is_configured

# Cached JWT secret bytes for local HS256 verification.
# Computed once at module load from ``SUPABASE_JWT_SECRET``.
_jwt_secret: str = get_config().supabase.jwt_secret
_jwt_secret_bytes: bytes | None = _jwt_secret.encode("utf-8") if _jwt_secret else None


def is_auth_enabled() -> bool:
    """Check whether Supabase authentication is enabled.

    Returns a cached boolean computed once at module load from
    ``SUPABASE_URL`` and ``SUPABASE_KEY`` environment variables.
    When disabled, the auth middleware passes all requests through
    without verification (graceful degradation for development and
    benchmarking).

    Returns:
        ``True`` if Supabase is configured and auth is enabled.
    """
    return _auth_enabled


def is_local_jwt_enabled() -> bool:
    """Check whether local HS256 JWT verification is available.

    Local verification requires ``SUPABASE_JWT_SECRET`` to be set. When
    available, it eliminates the GoTrue HTTP round-trip entirely.

    Returns:
        ``True`` if ``SUPABASE_JWT_SECRET`` is configured.
    """
    return _jwt_secret_bytes is not None


def log_auth_status() -> None:
    """Log the authentication configuration status at startup.

    Call this once during server initialisation (in ``app.py``'s startup
    handler) to inform the operator whether authentication is active or
    disabled. Matches the TS runtime's ``logAuthStatus()`` behaviour.
    """
    if not _auth_enabled:
        logger.warning(
            "Supabase not configured — authentication disabled "
            "(all requests pass through)"
        )
        return

    logger.info("Supabase authentication enabled")

    if is_local_jwt_enabled():
        logger.info(
            "JWT verification strategy: LOCAL "
            "(HMAC-SHA256 via hmac stdlib — no GoTrue HTTP round-trip)"
        )
    else:
        logger.info(
            "JWT verification strategy: HTTP "
            "(GoTrue supabase.auth.getUser — ~30ms per request)"
        )


def get_supabase_client() -> Any:
    """Get or create the Supabase client instance.

    Returns:
        Supabase client instance, or None if not configured.
    """
    global _supabase_client

    if _supabase_client is not None:
        return _supabase_client

    if not _auth_enabled:
        return None

    try:
        from supabase import create_client

        config = get_config()
        _supabase_client = create_client(config.supabase.url, config.supabase.key)
        logger.info("Supabase client initialized")
        return _supabase_client
    except ImportError:
        logger.error("supabase package not installed")
        return None
    except Exception as e:
        logger.error(f"Failed to create Supabase client: {e}")
        return None


# ============================================================================
# Token Verification
# ============================================================================


def _base64url_decode(data: str) -> bytes:
    """Decode a base64url-encoded string (no padding required).

    JWT segments use base64url encoding (RFC 7515) which replaces ``+``
    with ``-`` and ``/`` with ``_``, and omits trailing ``=`` padding.

    Args:
        data: Base64url-encoded string.

    Returns:
        Decoded bytes.
    """
    # Restore standard base64 alphabet and add padding
    data = data.replace("-", "+").replace("_", "/")
    padding = 4 - len(data) % 4
    if padding != 4:
        data += "=" * padding
    return base64.b64decode(data)


async def verify_token(token: str) -> AuthUser:
    """Verify a JWT token with Supabase GoTrue (HTTP round-trip).

    Args:
        token: JWT access token from Authorization header

    Returns:
        AuthUser with verified user information

    Raises:
        AuthenticationError: If token is invalid or verification fails
    """
    supabase = get_supabase_client()
    if not supabase:
        raise AuthenticationError("Supabase client not initialized")

    try:
        # Verify token with Supabase in a thread pool to avoid blocking
        response = await asyncio.to_thread(supabase.auth.get_user, token)
        user = response.user

        if not user:
            raise AuthenticationError("Invalid token or user not found")

        return AuthUser(
            identity=user.id,
            email=user.email,
            metadata=user.user_metadata,
        )
    except AuthenticationError:
        raise
    except Exception as e:
        # Don't leak internal error details
        logger.warning(f"Token verification failed: {e}")
        raise AuthenticationError(f"Authentication error: {e}")


def verify_token_local(token: str) -> AuthUser:
    """Verify a JWT access token locally using HMAC-SHA256.

    Uses Python's ``hmac`` module for constant-time signature verification.
    Sub-millisecond performance, no network I/O.

    Supabase JWT payload structure (from Supabase docs):
      - ``sub``           — User ID (UUID)
      - ``email``         — User email
      - ``user_metadata`` — Custom user metadata object
      - ``exp``           — Expiration timestamp (Unix seconds)
      - ``role``          — Postgres role (e.g. "authenticated")
      - ``iss``           — Issuer URL

    Reference: https://supabase.com/docs/guides/auth/jwts

    Args:
        token: The raw JWT access token (without "Bearer " prefix).

    Returns:
        The verified ``AuthUser`` with identity, email, and metadata.

    Raises:
        AuthenticationError: If the token format is invalid, the
            signature doesn't match, or the token has expired.
    """
    if _jwt_secret_bytes is None:
        raise AuthenticationError(
            "SUPABASE_JWT_SECRET not configured for local verification",
            500,
        )

    # 1. Split JWT into parts
    parts = token.split(".")
    if len(parts) != 3:
        raise AuthenticationError("Invalid JWT format: expected 3 parts")

    header_b64, payload_b64, signature_b64 = parts

    # 2. Verify the algorithm is HS256
    try:
        header_json = _base64url_decode(header_b64).decode("utf-8")
        header = json.loads(header_json)
        if header.get("alg") != "HS256":
            raise AuthenticationError(
                f"Unsupported JWT algorithm: {header.get('alg')} (expected HS256)"
            )
    except AuthenticationError:
        raise
    except Exception:
        raise AuthenticationError("Invalid JWT header")

    # 3. Compute HMAC-SHA256 signature
    signature_input = f"{header_b64}.{payload_b64}".encode("ascii")
    computed_signature = hmac.new(
        _jwt_secret_bytes, signature_input, hashlib.sha256
    ).digest()

    # 4. Compare with provided signature (constant-time)
    provided_signature = _base64url_decode(signature_b64)
    if not hmac.compare_digest(computed_signature, provided_signature):
        raise AuthenticationError("Invalid token signature")

    # 5. Parse and validate payload
    try:
        payload_json = _base64url_decode(payload_b64).decode("utf-8")
        payload = json.loads(payload_json)
    except Exception:
        raise AuthenticationError("Invalid JWT payload")

    # 6. Check expiration
    expiration = payload.get("exp")
    if isinstance(expiration, (int, float)):
        if expiration < time.time():
            raise AuthenticationError("Token expired")

    # 7. Extract user information from JWT claims
    user_id = payload.get("sub")
    if not isinstance(user_id, str) or len(user_id) == 0:
        raise AuthenticationError("Invalid token: missing sub claim")

    email = payload.get("email")
    user_metadata = payload.get("user_metadata")

    return AuthUser(
        identity=user_id,
        email=email if isinstance(email, str) else None,
        metadata=user_metadata if isinstance(user_metadata, dict) else {},
    )


async def verify_token_auto(token: str) -> AuthUser:
    """Verify a JWT access token using the best available strategy.

    Strategy selection (logged once at startup via ``log_auth_status``):
      - If ``SUPABASE_JWT_SECRET`` is set → ``verify_token_local()`` (sub-ms)
      - Otherwise → ``verify_token()`` (HTTP call to GoTrue, ~30ms)

    This is the function that should be called by the auth middleware.

    Args:
        token: The raw JWT access token (without "Bearer " prefix).

    Returns:
        The verified ``AuthUser``.

    Raises:
        AuthenticationError: On any verification failure.
    """
    if is_local_jwt_enabled():
        return verify_token_local(token)
    return await verify_token(token)


# ============================================================================
# Error Handling
# ============================================================================


class AuthenticationError(Exception):
    """Raised when authentication fails."""

    def __init__(self, message: str, status_code: int = 401):
        self.message = message
        self.status_code = status_code
        super().__init__(message)


def create_error_response(message: str, status_code: int = 401) -> Response:
    """Create a JSON error response matching LangGraph API format.

    Args:
        message: Error message to include in response
        status_code: HTTP status code (default 401)

    Returns:
        Robyn Response with JSON error body
    """
    body = json.dumps({"detail": message})
    # Robyn Response signature: (status_code, headers, description)
    # where 'description' is the response body
    return Response(
        status_code,
        {"Content-Type": "application/json"},
        body,
    )


# ============================================================================
# Public Endpoints
# ============================================================================

# Paths that don't require authentication
PUBLIC_PATHS: set[str] = {
    "/",
    "/health",
    "/ok",
    "/info",
    "/docs",
    "/openapi.json",
    "/metrics",
    "/metrics/json",
}


def is_public_path(path: str) -> bool:
    """Check if a path is public (doesn't require authentication).

    Args:
        path: Request path to check

    Returns:
        True if path is public, False otherwise
    """
    # Exact match
    if path in PUBLIC_PATHS:
        return True

    # Strip trailing slash and check again
    if path.rstrip("/") in PUBLIC_PATHS:
        return True

    return False


# ============================================================================
# Middleware
# ============================================================================


async def auth_middleware(request: Request) -> Request | Response:
    """Robyn middleware to authenticate requests using Supabase JWT.

    This middleware:
    1. Skips authentication for public endpoints
    2. Passes all requests through when Supabase is not configured (graceful degradation)
    3. Extracts and validates the Authorization header
    4. Verifies the JWT token with Supabase
    5. Stores the authenticated user in context for downstream handlers

    Args:
        request: Incoming Robyn request

    Returns:
        Request object to continue processing, or Response to short-circuit
    """
    # Skip auth for public endpoints
    path = request.url.path if hasattr(request.url, "path") else str(request.url)

    # Handle Robyn's URL object - it might be a string or have a path attribute
    if hasattr(request, "url"):
        url = request.url
        if hasattr(url, "path"):
            path = url.path
        elif isinstance(url, str):
            # Extract path from URL string
            path = url.split("?")[0]
        else:
            path = str(url).split("?")[0]
    else:
        path = "/"

    if is_public_path(path):
        _current_user.set(None)
        _thread_local.current_user = None
        return request

    # Graceful degradation: pass all requests through when Supabase is not
    # configured, matching the TS runtime's cached ``isAuthEnabled()``
    # pattern. The flag is computed once at module load — zero overhead
    # per request.
    if not _auth_enabled:
        _current_user.set(None)
        _thread_local.current_user = None
        return request

    # Extract Authorization header
    # Try multiple case variations as Robyn may normalize headers differently
    auth_header = (
        request.headers.get("authorization")
        or request.headers.get("Authorization")
        or request.headers.get("AUTHORIZATION")
    )

    if not auth_header:
        return create_error_response("Authorization header missing")

    # Parse "Bearer <token>"
    try:
        parts = auth_header.split()
        if len(parts) != 2:
            raise ValueError("Invalid format")
        scheme, token = parts
        if scheme.lower() != "bearer":
            raise ValueError("Invalid scheme")
    except (ValueError, AttributeError):
        return create_error_response("Invalid authorization header format")

    # Verify token with Supabase
    try:
        user = await verify_token_auto(token)
        _current_user.set(user)
        # Also store in thread-local as ContextVar may not persist across Robyn's Rust/Python boundary
        _thread_local.current_user = user
        return request
    except AuthenticationError as e:
        return create_error_response(e.message, e.status_code)


# ============================================================================
# User Context Access
# ============================================================================


def get_current_user() -> AuthUser | None:
    """Get the authenticated user for the current request.

    Returns:
        AuthUser if authenticated, None otherwise
    """
    # First try ContextVar
    user = _current_user.get()
    if user is not None:
        return user

    # Fallback: check thread-local storage (for Robyn's Rust/Python boundary)
    user = getattr(_thread_local, "current_user", None)
    if user is not None:
        return user

    return None


def require_user() -> AuthUser:
    """Get the authenticated user, raising if not authenticated.

    Returns:
        AuthUser for the current request

    Raises:
        AuthenticationError: If no user is authenticated
    """
    user = get_current_user()
    if user is None:
        raise AuthenticationError("Authentication required")
    return user


def get_user_identity() -> str | None:
    """Get the current user's identity (Supabase user ID).

    Returns:
        User ID string if authenticated, None otherwise
    """
    user = get_current_user()
    return user.identity if user else None
