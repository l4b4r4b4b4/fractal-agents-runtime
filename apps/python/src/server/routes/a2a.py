"""A2A Protocol route handlers.

Implements the Agent-to-Agent (A2A) Protocol HTTP endpoint according to
the Google A2A specification using JSON-RPC 2.0 over HTTP.

The A2A protocol enables external agents to communicate with our LangGraph
agent using a standardized interface.

Endpoints:
- POST /a2a/{assistant_id} - JSON-RPC 2.0 message handler
"""

from __future__ import annotations

import json
import logging
from typing import TYPE_CHECKING, AsyncGenerator

from robyn import Response
from robyn.responses import SSEResponse

from server.a2a import (
    JsonRpcErrorCode,
    JsonRpcRequest,
    a2a_handler,
    create_error_response,
)
from server.auth import AuthenticationError, require_user
from server.storage import get_storage

if TYPE_CHECKING:
    from robyn import Robyn

logger = logging.getLogger(__name__)


def register_a2a_routes(app: "Robyn") -> None:
    """Register A2A protocol routes on the Robyn application.

    Args:
        app: The Robyn application instance.
    """

    @app.post("/a2a/:assistant_id")
    async def post_a2a(request) -> Response | SSEResponse:
        """Handle A2A JSON-RPC 2.0 messages.

        Implements the A2A protocol specification with support for:
        - message/send: Synchronous message handling
        - message/stream: SSE streaming responses
        - tasks/get: Task status retrieval
        - tasks/cancel: Task cancellation (not supported)

        The Accept header determines response format:
        - application/json: Standard JSON-RPC response
        - text/event-stream: SSE stream for message/stream method

        Args:
            request: The Robyn request object.

        Returns:
            - 200: Successful JSON-RPC response or SSE stream
            - 400: Bad request (invalid JSON or message format)
            - 401: Unauthorized
            - 404: Assistant not found
            - 500: Internal server error
        """
        # Authenticate
        try:
            user = require_user()
            owner_id = user.identity
        except AuthenticationError as e:
            error_response = create_error_response(
                None,
                JsonRpcErrorCode.INTERNAL_ERROR,
                f"Authentication required: {e.message}",
            )
            return Response(
                status_code=401,
                headers={"Content-Type": "application/json"},
                body=json.dumps(error_response.model_dump()),
            )

        # Get assistant_id from path
        assistant_id = request.path_params.get("assistant_id")
        if not assistant_id:
            error_response = create_error_response(
                None,
                JsonRpcErrorCode.INVALID_PARAMS,
                "assistant_id is required in path",
            )
            return Response(
                status_code=400,
                headers={"Content-Type": "application/json"},
                body=json.dumps(error_response.model_dump()),
            )

        # Verify assistant exists
        storage = get_storage()
        assistant = storage.assistants.get(assistant_id, owner_id)
        if assistant is None:
            # Try by graph_id
            assistants = storage.assistants.list(owner_id)
            assistant = next(
                (a for a in assistants if a.graph_id == assistant_id),
                None,
            )
            if assistant is None:
                error_response = create_error_response(
                    None,
                    JsonRpcErrorCode.INVALID_PARAMS,
                    f"Assistant not found: {assistant_id}",
                )
                return Response(
                    status_code=404,
                    headers={"Content-Type": "application/json"},
                    body=json.dumps(error_response.model_dump()),
                )

        # Check Accept header for streaming
        accept_header = request.headers.get("accept", "application/json")
        wants_stream = "text/event-stream" in accept_header

        # Parse request body
        try:
            body = request.body
            if isinstance(body, bytes):
                body = body.decode("utf-8")
            data = json.loads(body)
        except json.JSONDecodeError as e:
            logger.error(f"A2A parse error: {e}")
            error_response = create_error_response(
                None,
                JsonRpcErrorCode.PARSE_ERROR,
                f"Parse error: {str(e)}",
            )
            return Response(
                status_code=400,
                headers={"Content-Type": "application/json"},
                body=json.dumps(error_response.model_dump()),
            )

        # Validate JSON-RPC structure
        if not isinstance(data, dict):
            error_response = create_error_response(
                None,
                JsonRpcErrorCode.INVALID_REQUEST,
                "Request must be a JSON object",
            )
            return Response(
                status_code=400,
                headers={"Content-Type": "application/json"},
                body=json.dumps(error_response.model_dump()),
            )

        # Parse as JSON-RPC request
        try:
            rpc_request = JsonRpcRequest.model_validate(data)
        except Exception as e:
            logger.error(f"A2A invalid request: {e}")
            error_response = create_error_response(
                data.get("id"),
                JsonRpcErrorCode.INVALID_REQUEST,
                f"Invalid request: {str(e)}",
            )
            return Response(
                status_code=400,
                headers={"Content-Type": "application/json"},
                body=json.dumps(error_response.model_dump()),
            )

        # Handle message/stream with SSE
        if rpc_request.method == "message/stream":
            if not wants_stream:
                error_response = create_error_response(
                    rpc_request.id,
                    JsonRpcErrorCode.INVALID_REQUEST,
                    "message/stream requires Accept: text/event-stream header",
                )
                return Response(
                    status_code=400,
                    headers={"Content-Type": "application/json"},
                    body=json.dumps(error_response.model_dump()),
                )

            # Return SSE stream
            async def stream_generator() -> AsyncGenerator[str, None]:
                async for event in a2a_handler.handle_message_stream(
                    params=rpc_request.params or {},
                    assistant_id=assistant_id,
                    owner_id=owner_id,
                    request_id=rpc_request.id,
                ):
                    yield event

            return SSEResponse(
                request=request,
                generator=stream_generator(),
                headers={
                    "Content-Type": "text/event-stream",
                    "Cache-Control": "no-cache",
                    "Connection": "keep-alive",
                    "X-Accel-Buffering": "no",
                },
            )

        # Handle other methods (message/send, tasks/get, tasks/cancel)
        try:
            response = await a2a_handler.handle_request(
                request=rpc_request,
                assistant_id=assistant_id,
                owner_id=owner_id,
            )

            return Response(
                status_code=200,
                headers={"Content-Type": "application/json"},
                body=json.dumps(response.model_dump()),
            )

        except Exception as e:
            logger.exception(f"A2A handler error: {e}")
            error_response = create_error_response(
                rpc_request.id,
                JsonRpcErrorCode.INTERNAL_ERROR,
                f"Internal error: {str(e)}",
            )
            return Response(
                status_code=500,
                headers={"Content-Type": "application/json"},
                body=json.dumps(error_response.model_dump()),
            )

    logger.info("A2A routes registered: POST /a2a/{assistant_id}")
