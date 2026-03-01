"""Threads API routes for Robyn server.

Implements LangGraph-compatible endpoints:
- POST /threads — Create a new thread
- GET /threads/{thread_id} — Get a thread by ID
- PATCH /threads/{thread_id} — Update a thread
- DELETE /threads/{thread_id} — Delete a thread
- GET /threads/{thread_id}/state — Get thread state
- GET /threads/{thread_id}/history — Get thread history
- POST /threads/{thread_id}/history — Get thread history (body: limit, before)
- POST /threads/search — Search/list threads (Tier 2)
- POST /threads/count — Count threads (Tier 2)
"""

import json
import logging
from typing import Any

from pydantic import ValidationError
from robyn import Request, Response, Robyn

from server.auth import AuthenticationError, require_user
from server.models import (
    ThreadCountRequest,
    ThreadCreate,
    ThreadPatch,
    ThreadSearchRequest,
)
from server.routes.helpers import error_response, json_response, parse_json_body
from server.storage import get_storage

logger = logging.getLogger(__name__)


def register_thread_routes(app: Robyn) -> None:
    """Register thread routes with the Robyn app.

    Args:
        app: Robyn application instance
    """

    # ========================================================================
    # Tier 1 Endpoints - Core CRUD
    # ========================================================================

    @app.post("/threads")
    async def create_thread(request: Request) -> Response:
        """Create a new thread.

        Request body: ThreadCreate
        Response: Thread (200) or error (4xx)
        """
        try:
            user = require_user()
        except AuthenticationError as e:
            return error_response(e.message, 401)

        try:
            body = parse_json_body(request)
            create_data = ThreadCreate(**body)
        except json.JSONDecodeError:
            return error_response("Invalid JSON in request body", 422)
        except ValidationError as e:
            return error_response(str(e), 422)

        storage = get_storage()

        # Check if thread_id provided and if_exists handling
        if create_data.thread_id:
            existing = await storage.threads.get(create_data.thread_id, user.identity)
            if existing:
                if create_data.if_exists == "do_nothing":
                    return json_response(existing)
                else:
                    return error_response(
                        f"Thread {create_data.thread_id} already exists", 409
                    )

        # Build thread data
        thread_data: dict[str, Any] = {
            "metadata": create_data.metadata,
        }

        # Use provided thread_id if given
        if create_data.thread_id:
            thread_data["thread_id"] = create_data.thread_id

        thread = await storage.threads.create(thread_data, user.identity)
        return json_response(thread)

    @app.get("/threads/:thread_id")
    async def get_thread(request: Request) -> Response:
        """Get a thread by ID.

        Response: Thread (200) or error (404)
        """
        try:
            user = require_user()
        except AuthenticationError as e:
            return error_response(e.message, 401)

        thread_id = request.path_params.get("thread_id")
        if not thread_id:
            return error_response("thread_id is required", 422)

        storage = get_storage()
        thread = await storage.threads.get(thread_id, user.identity)

        if thread is None:
            return error_response(f"Thread {thread_id} not found", 404)

        return json_response(thread)

    @app.patch("/threads/:thread_id")
    async def patch_thread(request: Request) -> Response:
        """Update a thread.

        Request body: ThreadPatch
        Response: Thread (200) or error (4xx)
        """
        try:
            user = require_user()
        except AuthenticationError as e:
            return error_response(e.message, 401)

        thread_id = request.path_params.get("thread_id")
        if not thread_id:
            return error_response("thread_id is required", 422)

        try:
            body = parse_json_body(request)
            patch_data = ThreadPatch(**body)
        except json.JSONDecodeError:
            return error_response("Invalid JSON in request body", 422)
        except ValidationError as e:
            return error_response(str(e), 422)

        storage = get_storage()

        # Check if thread exists
        existing = await storage.threads.get(thread_id, user.identity)
        if existing is None:
            return error_response(f"Thread {thread_id} not found", 404)

        # Build update data (only include non-None fields)
        update_data: dict[str, Any] = {}
        if patch_data.metadata is not None:
            update_data["metadata"] = patch_data.metadata

        thread = await storage.threads.update(thread_id, update_data, user.identity)

        if thread is None:
            return error_response(f"Thread {thread_id} not found", 404)

        return json_response(thread)

    @app.delete("/threads/:thread_id")
    async def delete_thread(request: Request) -> Response:
        """Delete a thread.

        Response: empty object (200) or error (404)
        """
        try:
            user = require_user()
        except AuthenticationError as e:
            return error_response(e.message, 401)

        thread_id = request.path_params.get("thread_id")
        if not thread_id:
            return error_response("thread_id is required", 422)

        storage = get_storage()
        deleted = await storage.threads.delete(thread_id, user.identity)

        if not deleted:
            return error_response(f"Thread {thread_id} not found", 404)

        # Return empty object on success (matches LangGraph API)
        return json_response({})

    # ========================================================================
    # Tier 1 Endpoints - State and History
    # ========================================================================

    @app.get("/threads/:thread_id/state")
    async def get_thread_state(request: Request) -> Response:
        """Get the current state of a thread.

        Response: ThreadState (200) or error (404)
        """
        try:
            user = require_user()
        except AuthenticationError as e:
            return error_response(e.message, 401)

        thread_id = request.path_params.get("thread_id")
        if not thread_id:
            return error_response("thread_id is required", 422)

        storage = get_storage()
        state = await storage.threads.get_state(thread_id, user.identity)

        if state is None:
            return error_response(f"Thread {thread_id} not found", 404)

        return json_response(state)

    @app.get("/threads/:thread_id/history")
    async def get_thread_history(request: Request) -> Response:
        """Get state history for a thread.

        Query params:
        - limit: Maximum number of states to return (default: 10)
        - before: Return states before this checkpoint ID

        Response: list[ThreadState] (200) or error (404)
        """
        try:
            user = require_user()
        except AuthenticationError as e:
            return error_response(e.message, 401)

        thread_id = request.path_params.get("thread_id")
        if not thread_id:
            return error_response("thread_id is required", 422)

        # Parse query params
        limit = 10
        before = None
        if request.query_params:
            limit_param = request.query_params.get("limit", None)
            if limit_param:
                try:
                    limit = int(limit_param)
                    limit = max(1, min(limit, 1000))  # Clamp to 1-1000
                except ValueError:
                    pass
            before = request.query_params.get("before", None)

        storage = get_storage()
        history = await storage.threads.get_history(
            thread_id, user.identity, limit, before
        )

        if history is None:
            return error_response(f"Thread {thread_id} not found", 404)

        return json_response(history)

    @app.post("/threads/:thread_id/history")
    async def post_thread_history(request: Request) -> Response:
        """Get state history for a thread (POST variant).

        The ``@langchain/langgraph-sdk`` client (and the ``useStream`` hook
        with ``fetchStateHistory: true``) sends POST requests to this
        endpoint with an optional JSON body for filtering.  The official
        LangGraph Server API supports POST here — our GET-only registration
        caused 404s for the SDK.

        Request body (all fields optional):
            - limit (int): Maximum number of states to return (default: 10)
            - before (str): Return states before this checkpoint ID
            - metadata (dict): Filter by metadata (reserved for future use)
            - checkpoint (dict): Filter by specific checkpoint (reserved)

        Response: list[ThreadState] (200) or error (4xx)
        """
        try:
            user = require_user()
        except AuthenticationError as e:
            return error_response(e.message, 401)

        thread_id = request.path_params.get("thread_id")
        if not thread_id:
            return error_response("thread_id is required", 422)

        # Parse filter parameters from JSON body
        limit = 10
        before = None
        try:
            body = parse_json_body(request)
        except json.JSONDecodeError:
            body = {}

        if body:
            limit_param = body.get("limit", None)
            if limit_param is not None:
                try:
                    limit = int(limit_param)
                    limit = max(1, min(limit, 1000))  # Clamp to 1-1000
                except (ValueError, TypeError):
                    pass
            before = body.get("before", None)

        storage = get_storage()
        history = await storage.threads.get_history(
            thread_id, user.identity, limit, before
        )

        if history is None:
            return error_response(f"Thread {thread_id} not found", 404)

        return json_response(history)

    # ========================================================================
    # Tier 2 Endpoints - Search and Count
    # ========================================================================

    @app.post("/threads/search")
    async def search_threads(request: Request) -> Response:
        """Search for threads.

        Request body: ThreadSearchRequest
        Response: list[Thread] (200)
        """
        try:
            user = require_user()
        except AuthenticationError as e:
            return error_response(e.message, 401)

        try:
            body = parse_json_body(request)
            search_data = ThreadSearchRequest(**body)
        except json.JSONDecodeError:
            return error_response("Invalid JSON in request body", 422)
        except ValidationError as e:
            return error_response(str(e), 422)

        storage = get_storage()

        # Get all threads for this user
        threads = await storage.threads.list(user.identity)

        # Apply filters
        if search_data.ids:
            threads = [t for t in threads if t.thread_id in search_data.ids]

        if search_data.status:
            threads = [t for t in threads if t.status == search_data.status]

        if search_data.metadata:
            threads = [
                t
                for t in threads
                if all(t.metadata.get(k) == v for k, v in search_data.metadata.items())
            ]

        if search_data.values:
            threads = [
                t
                for t in threads
                if all(t.values.get(k) == v for k, v in search_data.values.items())
            ]

        # Apply sorting
        if search_data.sort_by:
            reverse = search_data.sort_order == "desc"
            if search_data.sort_by == "thread_id":
                threads = sorted(threads, key=lambda t: t.thread_id, reverse=reverse)
            elif search_data.sort_by == "status":
                threads = sorted(threads, key=lambda t: t.status, reverse=reverse)
            elif search_data.sort_by == "created_at":
                threads = sorted(threads, key=lambda t: t.created_at, reverse=reverse)
            elif search_data.sort_by == "updated_at":
                threads = sorted(threads, key=lambda t: t.updated_at, reverse=reverse)

        # Apply pagination
        total = len(threads)
        start = search_data.offset
        end = start + search_data.limit
        threads = threads[start:end]

        logger.debug(
            f"Search returned {len(threads)} of {total} threads for user {user.identity}"
        )

        return json_response(threads)

    @app.post("/threads/count")
    async def count_threads(request: Request) -> Response:
        """Count threads matching criteria.

        Request body: ThreadCountRequest
        Response: integer (200)
        """
        try:
            user = require_user()
        except AuthenticationError as e:
            return error_response(e.message, 401)

        try:
            body = parse_json_body(request)
            count_data = ThreadCountRequest(**body)
        except json.JSONDecodeError:
            return error_response("Invalid JSON in request body", 422)
        except ValidationError as e:
            return error_response(str(e), 422)

        storage = get_storage()

        # Get all threads for this user
        threads = await storage.threads.list(user.identity)

        # Apply filters
        if count_data.status:
            threads = [t for t in threads if t.status == count_data.status]

        if count_data.metadata:
            threads = [
                t
                for t in threads
                if all(t.metadata.get(k) == v for k, v in count_data.metadata.items())
            ]

        if count_data.values:
            threads = [
                t
                for t in threads
                if all(t.values.get(k) == v for k, v in count_data.values.items())
            ]

        # Return just the count (LangGraph API returns bare integer)
        return json_response(len(threads))
