"""Shared test harness for capturing and testing Robyn route handler closures.

Robyn registers route handlers as closures inside ``register_*_routes(app)``.
This module provides a lightweight ``RouteCapture`` class that mimics the
Robyn app decorator interface (``@app.get``, ``@app.post``, etc.) so that
tests can:

1. Call ``register_*_routes(capture)`` to collect handler references.
2. Call those handlers directly with a ``MockRequest``.
3. Assert on the ``Response`` objects returned.

Combined with ``unittest.mock.patch`` on ``require_user`` / ``get_storage``
etc., this lets us exercise route handler logic without a running server.

Usage::

    from server.tests.conftest_routes import RouteCapture, MockRequest
    from server.routes.assistants import register_assistant_routes

    capture = RouteCapture()
    register_assistant_routes(capture)

    handler = capture.get_handler("POST", "/assistants")
    request = MockRequest(body={"graph_id": "agent"})
    response = await handler(request)
    assert response.status_code == 200
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Callable, Coroutine
from unittest.mock import MagicMock

from robyn import Response

from server.auth import AuthUser


# ---------------------------------------------------------------------------
# Mock Request
# ---------------------------------------------------------------------------


class MockRequest:
    """Minimal Request-like object accepted by Robyn route handlers.

    Attributes:
        body: Raw request body (bytes, str, or dict — dict is auto-serialised).
        path_params: URL path parameters, e.g. ``{"thread_id": "t-1"}``.
        query_params: URL query parameters.
        headers: HTTP headers dict.
        method: HTTP method string.
        url: Pseudo URL path.
    """

    def __init__(
        self,
        body: Any = "",
        path_params: dict[str, str] | None = None,
        query_params: dict[str, str] | None = None,
        headers: dict[str, str] | None = None,
        method: str = "GET",
        url: str = "/",
    ) -> None:
        if isinstance(body, dict):
            self.body = json.dumps(body).encode()
        elif isinstance(body, str):
            self.body = body.encode() if body else b""
        elif isinstance(body, bytes):
            self.body = body
        else:
            self.body = b""

        self.path_params = path_params or {}
        self.query_params = query_params or {}
        self.headers = headers or {}
        self.method = method
        self.url = MagicMock()
        self.url.path = url
        self.ip_addr = "127.0.0.1"
        self.identity = None


# ---------------------------------------------------------------------------
# Route Capture
# ---------------------------------------------------------------------------


@dataclass
class _CapturedRoute:
    """A single captured route handler."""

    method: str
    path: str
    handler: Callable[..., Coroutine]


class RouteCapture:
    """Drop-in replacement for ``Robyn`` that captures route handlers.

    Provides the same decorator interface (``@app.get``, ``@app.post``,
    ``@app.patch``, ``@app.delete``, ``@app.put``) but instead of
    registering with an HTTP server, stores the handlers for direct
    invocation in tests.

    Also provides no-op versions of ``@app.before_request`` and
    ``@app.startup_handler`` / ``@app.shutdown_handler`` so that
    ``register_*_routes(capture)`` calls don't fail.
    """

    def __init__(self) -> None:
        self._routes: list[_CapturedRoute] = []

    # -- decorators ----------------------------------------------------------

    def get(self, path: str):
        return self._make_decorator("GET", path)

    def post(self, path: str):
        return self._make_decorator("POST", path)

    def patch(self, path: str):
        return self._make_decorator("PATCH", path)

    def put(self, path: str):
        return self._make_decorator("PUT", path)

    def delete(self, path: str):
        return self._make_decorator("DELETE", path)

    def before_request(self, *_args, **_kwargs):
        """No-op middleware decorator."""

        def decorator(func):
            return func

        return decorator

    def startup_handler(self, func):
        """No-op lifecycle decorator."""
        return func

    def shutdown_handler(self, func):
        """No-op lifecycle decorator."""
        return func

    # -- lookup --------------------------------------------------------------

    def get_handler(self, method: str, path: str) -> Callable[..., Coroutine] | None:
        """Look up a captured handler by HTTP method and path.

        Path matching normalises Robyn's ``:param`` syntax so that
        ``/threads/:thread_id/runs`` matches a lookup for the same string.

        Returns:
            The async handler function, or ``None`` if not found.
        """
        method_upper = method.upper()
        for route in self._routes:
            if route.method == method_upper and route.path == path:
                return route.handler
        return None

    def list_routes(self) -> list[tuple[str, str]]:
        """Return ``[(method, path), ...]`` of all captured routes."""
        return [(r.method, r.path) for r in self._routes]

    # -- internals -----------------------------------------------------------

    def _make_decorator(self, method: str, path: str):
        def decorator(func):
            self._routes.append(_CapturedRoute(method=method, path=path, handler=func))
            return func

        return decorator


# ---------------------------------------------------------------------------
# Common test helpers
# ---------------------------------------------------------------------------


def make_auth_user(
    identity: str = "user-123",
    email: str = "test@example.com",
) -> AuthUser:
    """Create a test ``AuthUser``."""
    return AuthUser(identity=identity, email=email)


def response_json(response: Response) -> Any:
    """Parse a Robyn ``Response.description`` as JSON."""
    body = response.description
    if isinstance(body, bytes):
        body = body.decode()
    return json.loads(body)
