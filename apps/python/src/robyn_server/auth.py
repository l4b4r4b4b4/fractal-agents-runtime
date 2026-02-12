"""Authentication middleware for Robyn server using Supabase JWT verification.

This module provides:
- Supabase JWT token verification via API call
- Robyn middleware for authenticating requests
- User context extraction for downstream handlers

The authentication flow mirrors `fractal_agent_infra/security/auth.py` but adapted
for Robyn's middleware system.
"""

import asyncio
import json
import logging
import threading
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any

from robyn import Request, Response

from robyn_server.config import get_config

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


def get_supabase_client() -> Any:
    """Get or create the Supabase client instance.

    Returns:
        Supabase client instance, or None if not configured.
    """
    global _supabase_client

    if _supabase_client is not None:
        return _supabase_client

    config = get_config()
    if not config.supabase.is_configured:
        logger.warning("Supabase not configured - auth will fail")
        return None

    try:
        from supabase import create_client

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


async def verify_token(token: str) -> AuthUser:
    """Verify a JWT token with Supabase and return the authenticated user.

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
    2. Extracts and validates the Authorization header
    3. Verifies the JWT token with Supabase
    4. Stores the authenticated user in context for downstream handlers

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
        user = await verify_token(token)
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
