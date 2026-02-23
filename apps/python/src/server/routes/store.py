"""Store API routes for Robyn server.

Implements LangGraph-compatible key-value storage endpoints:
- PUT /store/items — Store/update items
- GET /store/items — Retrieve items by namespace/key
- DELETE /store/items — Delete items
- POST /store/items/search — Search items by prefix
- GET /store/namespaces — List namespaces
"""

from __future__ import annotations

import json
import logging
from urllib.parse import unquote

from robyn import Request, Response, Robyn

from server.auth import AuthenticationError, require_user
from server.routes.helpers import error_response, json_response, parse_json_body
from server.storage import get_storage

logger = logging.getLogger(__name__)


def _normalise_namespace(namespace: str | list[str] | None) -> str | None:
    """Normalise a namespace value to a dot-joined string.

    The LangGraph SDK convention sends namespaces as ``list[str]`` (tuple of
    path segments) in JSON bodies (PUT, search).  Query parameters (GET,
    DELETE) arrive as plain strings — or as JSON-encoded arrays when sent
    by k6 / SDK clients.

    This helper accepts both forms and returns a canonical dot-joined
    string, matching the TS runtime's ``normaliseNamespace()`` from
    ``routes/store.ts``.

    Args:
        namespace: A string, list of strings, or ``None`` from the request.

    Returns:
        The canonical dot-joined string, or ``None`` if the value is
        empty / invalid.
    """
    if isinstance(namespace, list):
        segments = [s for s in namespace if isinstance(s, str) and len(s) > 0]
        return ".".join(segments) if segments else None
    if isinstance(namespace, str) and len(namespace) > 0:
        # Robyn does NOT URL-decode query parameter values, so a k6/SDK
        # request like ``namespace=%5B%22a%22%2C%22b%22%5D`` arrives as
        # the raw percent-encoded string.  URL-decode first, then try
        # JSON-parse in case it's a JSON-encoded array (e.g. '["a","b"]').
        url_decoded = unquote(namespace)
        try:
            decoded = json.loads(url_decoded)
            if isinstance(decoded, list):
                return _normalise_namespace(decoded)
        except (json.JSONDecodeError, TypeError):
            pass
        return url_decoded
    return None


def register_store_routes(app: Robyn) -> None:
    """Register store routes with the Robyn app.

    Args:
        app: Robyn application instance
    """

    # ========================================================================
    # Store Items - CRUD Operations
    # ========================================================================

    @app.put("/store/items")
    async def put_store_item(request: Request) -> Response:
        """Store or update an item.

        Request body:
        {
            "namespace": "string",
            "key": "string",
            "value": any,
            "metadata": {"key": "value"}  // optional
        }

        Response: StoreItem (200) or error (4xx)
        """
        try:
            user = require_user()
        except AuthenticationError as e:
            return error_response(e.message, 401)

        try:
            body = parse_json_body(request)
        except json.JSONDecodeError:
            return error_response("Invalid JSON in request body", 422)

        # Validate required fields
        namespace = _normalise_namespace(body.get("namespace"))
        key = body.get("key")
        value = body.get("value")

        if not namespace:
            return error_response("namespace is required", 422)
        if not key:
            return error_response("key is required", 422)
        if value is None:
            return error_response("value is required", 422)

        metadata = body.get("metadata")

        storage = get_storage()
        item = await storage.store.put(
            namespace=namespace,
            key=key,
            value=value,
            owner_id=user.identity,
            metadata=metadata,
        )

        return json_response(item.to_dict())

    @app.get("/store/items")
    async def get_store_item(request: Request) -> Response:
        """Get an item by namespace and key.

        Query params:
        - namespace: Namespace (required)
        - key: Key within namespace (required)

        Response: StoreItem (200) or error (404)
        """
        try:
            user = require_user()
        except AuthenticationError as e:
            return error_response(e.message, 401)

        # Parse query params — namespace may be a plain string or a
        # JSON-encoded array (e.g. '["benchmark","ts"]' from k6/SDK).
        raw_namespace = None
        key = None

        if request.query_params:
            raw_namespace = request.query_params.get("namespace", None)
            key = request.query_params.get("key", None)

        namespace = _normalise_namespace(raw_namespace)
        if not namespace:
            return error_response("namespace query parameter is required", 422)
        if not key:
            return error_response("key query parameter is required", 422)

        storage = get_storage()
        item = await storage.store.get(
            namespace=namespace,
            key=key,
            owner_id=user.identity,
        )

        if item is None:
            return error_response(f"Item not found: {namespace}/{key}", 404)

        return json_response(item.to_dict())

    @app.delete("/store/items")
    async def delete_store_item(request: Request) -> Response:
        """Delete an item by namespace and key.

        Query params:
        - namespace: Namespace (required)
        - key: Key within namespace (required)

        Response: empty object (200) or error (404)
        """
        try:
            user = require_user()
        except AuthenticationError as e:
            return error_response(e.message, 401)

        # Parse query params — same normalisation as GET.
        raw_namespace = None
        key = None

        if request.query_params:
            raw_namespace = request.query_params.get("namespace", None)
            key = request.query_params.get("key", None)

        namespace = _normalise_namespace(raw_namespace)
        if not namespace:
            return error_response("namespace query parameter is required", 422)
        if not key:
            return error_response("key query parameter is required", 422)

        storage = get_storage()
        deleted = await storage.store.delete(
            namespace=namespace,
            key=key,
            owner_id=user.identity,
        )

        if not deleted:
            return error_response(f"Item not found: {namespace}/{key}", 404)

        return json_response({})

    # ========================================================================
    # Store Items - Search
    # ========================================================================

    @app.post("/store/items/search")
    async def search_store_items(request: Request) -> Response:
        """Search items in a namespace.

        Request body:
        {
            "namespace": "string",
            "prefix": "string",  // optional key prefix filter
            "limit": 10,         // optional, default 10
            "offset": 0          // optional, default 0
        }

        Response: list[StoreItem] (200)
        """
        try:
            user = require_user()
        except AuthenticationError as e:
            return error_response(e.message, 401)

        try:
            body = parse_json_body(request)
        except json.JSONDecodeError:
            return error_response("Invalid JSON in request body", 422)

        namespace = _normalise_namespace(body.get("namespace"))
        if not namespace:
            return error_response("namespace is required", 422)

        prefix = body.get("prefix")
        limit = body.get("limit", 10)
        offset = body.get("offset", 0)

        # Validate pagination
        try:
            limit = max(1, min(int(limit), 100))
            offset = max(0, int(offset))
        except (TypeError, ValueError):
            return error_response("limit and offset must be integers", 422)

        storage = get_storage()
        items = await storage.store.search(
            namespace=namespace,
            owner_id=user.identity,
            prefix=prefix,
            limit=limit,
            offset=offset,
        )

        return json_response([item.to_dict() for item in items])

    # ========================================================================
    # Store Namespaces
    # ========================================================================

    @app.get("/store/namespaces")
    async def list_namespaces(request: Request) -> Response:
        """List all namespaces for the current user.

        Response: list[string] (200)
        """
        try:
            user = require_user()
        except AuthenticationError as e:
            return error_response(e.message, 401)

        storage = get_storage()
        namespaces = await storage.store.list_namespaces(user.identity)

        return json_response(namespaces)
