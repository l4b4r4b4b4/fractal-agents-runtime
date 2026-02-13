"""Assistants API routes for Robyn server.

Implements LangGraph-compatible endpoints:
- POST /assistants — Create a new assistant
- GET /assistants/{assistant_id} — Get an assistant by ID
- PATCH /assistants/{assistant_id} — Update an assistant
- DELETE /assistants/{assistant_id} — Delete an assistant
- POST /assistants/search — Search/list assistants (Tier 2)
- POST /assistants/count — Count assistants (Tier 2)
"""

import json
import logging
import os
from typing import Any
from uuid import UUID

from pydantic import ValidationError
from robyn import Request, Response, Robyn

from server.auth import AuthenticationError, require_user
from server.database import get_pool, is_postgres_enabled
from server.models import (
    AssistantCountRequest,
    AssistantCreate,
    AssistantPatch,
    AssistantSearchRequest,
)
from server.routes.helpers import error_response, json_response, parse_json_body
from server.storage import get_storage

logger = logging.getLogger(__name__)


def register_assistant_routes(app: Robyn) -> None:
    """Register assistant routes with the Robyn app.

    Args:
        app: Robyn application instance
    """

    @app.post("/assistants")
    async def create_assistant(request: Request) -> Response:
        """Create a new assistant.

        Request body: AssistantCreate
        Response: Assistant (200) or error (4xx)
        """
        try:
            user = require_user()
        except AuthenticationError as e:
            return error_response(e.message, 401)

        try:
            body = parse_json_body(request)
            create_data = AssistantCreate(**body)
        except json.JSONDecodeError:
            return error_response("Invalid JSON in request body", 422)
        except ValidationError as e:
            return error_response(str(e), 422)

        storage = get_storage()

        # -------------------------------------------------------------------
        # Dev-gated lazy sync (Option B)
        #
        # If the client provides Supabase agent metadata, attempt to sync that
        # agent into assistant storage before doing the normal create flow.
        #
        # Safety:
        # - Gated behind ROBYN_DEV=true to avoid tenant/auth mistakes while the
        #   DB connection may bypass RLS.
        # - Best-effort: failures do not block the assistant create endpoint.
        # -------------------------------------------------------------------
        try:
            if os.getenv("ROBYN_DEV", "false").lower() in ("true", "1", "yes"):
                metadata = create_data.metadata or {}
                supabase_agent_id_value = (
                    metadata.get("supabase_agent_id")
                    if isinstance(metadata, dict)
                    else None
                )
                if isinstance(supabase_agent_id_value, str) and supabase_agent_id_value:
                    pool = get_pool()
                    if is_postgres_enabled() and pool is not None:
                        from server.agent_sync import lazy_sync_agent

                        try:
                            supabase_agent_id = UUID(supabase_agent_id_value)
                            await lazy_sync_agent(
                                pool,
                                storage,
                                agent_id=supabase_agent_id,
                                owner_id=user.identity,
                            )
                        except ValueError:
                            # Invalid UUID in metadata; ignore.
                            pass
        except Exception as sync_error:
            logger.warning("Dev lazy sync skipped due to error: %s", sync_error)

        # Check if assistant_id provided and if_exists handling
        if create_data.assistant_id:
            existing = await storage.assistants.get(
                create_data.assistant_id, user.identity
            )
            if existing:
                if create_data.if_exists == "do_nothing":
                    return json_response(existing)
                else:
                    return error_response(
                        f"Assistant {create_data.assistant_id} already exists", 409
                    )

        # Build assistant data
        assistant_data = {
            "graph_id": create_data.graph_id,
            "config": create_data.config,
            "context": create_data.context,
            "metadata": create_data.metadata,
            "name": create_data.name,
            "description": create_data.description,
        }

        # Use provided assistant_id if given
        if create_data.assistant_id:
            assistant_data["assistant_id"] = create_data.assistant_id

        try:
            assistant = await storage.assistants.create(assistant_data, user.identity)
            return json_response(assistant)
        except ValueError as e:
            return error_response(str(e), 422)

    @app.get("/assistants/:assistant_id")
    async def get_assistant(request: Request) -> Response:
        """Get an assistant by ID.

        Response: Assistant (200) or error (404)
        """
        try:
            user = require_user()
        except AuthenticationError as e:
            return error_response(e.message, 401)

        assistant_id = request.path_params.get("assistant_id")
        if not assistant_id:
            return error_response("assistant_id is required", 422)

        storage = get_storage()
        assistant = await storage.assistants.get(assistant_id, user.identity)

        if assistant is None:
            return error_response(f"Assistant {assistant_id} not found", 404)

        return json_response(assistant)

    @app.patch("/assistants/:assistant_id")
    async def patch_assistant(request: Request) -> Response:
        """Update an assistant.

        Request body: AssistantPatch
        Response: Assistant (200) or error (4xx)
        """
        try:
            user = require_user()
        except AuthenticationError as e:
            return error_response(e.message, 401)

        assistant_id = request.path_params.get("assistant_id")
        if not assistant_id:
            return error_response("assistant_id is required", 422)

        try:
            body = parse_json_body(request)
            patch_data = AssistantPatch(**body)
        except json.JSONDecodeError:
            return error_response("Invalid JSON in request body", 422)
        except ValidationError as e:
            return error_response(str(e), 422)

        storage = get_storage()

        # Check if assistant exists
        existing = await storage.assistants.get(assistant_id, user.identity)
        if existing is None:
            return error_response(f"Assistant {assistant_id} not found", 404)

        # Build update data (only include non-None fields)
        update_data: dict[str, Any] = {}
        if patch_data.graph_id is not None:
            update_data["graph_id"] = patch_data.graph_id
        if patch_data.config is not None:
            update_data["config"] = patch_data.config
        if patch_data.context is not None:
            update_data["context"] = patch_data.context
        if patch_data.metadata is not None:
            update_data["metadata"] = patch_data.metadata
        if patch_data.name is not None:
            update_data["name"] = patch_data.name
        if patch_data.description is not None:
            update_data["description"] = patch_data.description

        assistant = await storage.assistants.update(
            assistant_id, update_data, user.identity
        )

        if assistant is None:
            return error_response(f"Assistant {assistant_id} not found", 404)

        return json_response(assistant)

    @app.delete("/assistants/:assistant_id")
    async def delete_assistant(request: Request) -> Response:
        """Delete an assistant.

        Response: empty object (200) or error (404)
        """
        try:
            user = require_user()
        except AuthenticationError as e:
            return error_response(e.message, 401)

        assistant_id = request.path_params.get("assistant_id")
        if not assistant_id:
            return error_response("assistant_id is required", 422)

        storage = get_storage()
        deleted = await storage.assistants.delete(assistant_id, user.identity)

        if not deleted:
            return error_response(f"Assistant {assistant_id} not found", 404)

        # Return empty object on success (matches LangGraph API)
        return json_response({})

    # ========================================================================
    # Tier 2 Endpoints - Search and Count
    # ========================================================================

    @app.post("/assistants/search")
    async def search_assistants(request: Request) -> Response:
        """Search for assistants.

        Request body: AssistantSearchRequest
        Response: list[Assistant] (200)
        """
        try:
            user = require_user()
        except AuthenticationError as e:
            return error_response(e.message, 401)

        try:
            body = parse_json_body(request)
            search_data = AssistantSearchRequest(**body)
        except json.JSONDecodeError:
            return error_response("Invalid JSON in request body", 422)
        except ValidationError as e:
            return error_response(str(e), 422)

        storage = get_storage()

        # Get all assistants for this user
        assistants = await storage.assistants.list(user.identity)

        # Apply filters
        if search_data.graph_id:
            assistants = [a for a in assistants if a.graph_id == search_data.graph_id]

        if search_data.name:
            assistants = [
                a for a in assistants if a.name and search_data.name in a.name
            ]

        if search_data.metadata:
            assistants = [
                a
                for a in assistants
                if all(a.metadata.get(k) == v for k, v in search_data.metadata.items())
            ]

        # Apply pagination
        total = len(assistants)
        start = search_data.offset
        end = start + search_data.limit
        assistants = assistants[start:end]

        logger.debug(
            f"Search returned {len(assistants)} of {total} assistants for user {user.identity}"
        )

        return json_response(assistants)

    @app.post("/assistants/count")
    async def count_assistants(request: Request) -> Response:
        """Count assistants matching criteria.

        Request body: AssistantCountRequest
        Response: integer (200)
        """
        try:
            user = require_user()
        except AuthenticationError as e:
            return error_response(e.message, 401)

        try:
            body = parse_json_body(request)
            count_data = AssistantCountRequest(**body)
        except json.JSONDecodeError:
            return error_response("Invalid JSON in request body", 422)
        except ValidationError as e:
            return error_response(str(e), 422)

        storage = get_storage()

        # Get all assistants for this user
        assistants = await storage.assistants.list(user.identity)

        # Apply filters
        if count_data.graph_id:
            assistants = [a for a in assistants if a.graph_id == count_data.graph_id]

        if count_data.name:
            assistants = [a for a in assistants if a.name and count_data.name in a.name]

        if count_data.metadata:
            assistants = [
                a
                for a in assistants
                if all(a.metadata.get(k) == v for k, v in count_data.metadata.items())
            ]

        # Return just the count (LangGraph API returns bare integer)
        return json_response(len(assistants))
