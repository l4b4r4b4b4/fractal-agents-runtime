"""MCP Protocol route handlers.

Implements the MCP (Model Context Protocol) HTTP endpoints according to
the Streamable HTTP Transport specification. The agent is exposed as
an MCP server that external clients can connect to.

Endpoints:
- POST /mcp/ - JSON-RPC 2.0 message handler
- GET /mcp/ - Returns 405 (streaming not supported)
- DELETE /mcp/ - Returns 404 (stateless, no session to terminate)
"""

import json
import logging
from typing import TYPE_CHECKING

from robyn import Response

from server.mcp import (
    JsonRpcErrorCode,
    JsonRpcRequest,
    create_error_response,
    mcp_handler,
)

if TYPE_CHECKING:
    from robyn import Robyn

logger = logging.getLogger(__name__)


def register_mcp_routes(app: "Robyn") -> None:
    """Register MCP protocol routes on the Robyn application.

    Args:
        app: The Robyn application instance.
    """

    @app.post("/mcp/")
    async def post_mcp(request) -> Response:
        """Handle MCP JSON-RPC 2.0 messages.

        Implements the Streamable HTTP Transport specification.
        Accepts JSON-RPC 2.0 requests and returns appropriate responses.

        The Accept header should include 'application/json' and optionally
        'text/event-stream' for streaming responses (not yet implemented).

        Returns:
            - 200: Successful JSON-RPC response
            - 202: Notification accepted (no content)
            - 400: Bad request (invalid JSON or message format)
            - 500: Internal server error
        """
        # Validate Accept header
        accept_header = request.headers.get("accept", "")
        if "application/json" not in accept_header:
            logger.warning(f"Invalid Accept header: {accept_header}")
            # Be lenient - many clients don't set this correctly
            # return Response(
            #     status_code=400,
            #     headers={"Content-Type": "application/json"},
            #     body=json.dumps({"error": "Accept header must include application/json"}),
            # )

        # Parse request body
        try:
            body = request.body
            if isinstance(body, bytes):
                body = body.decode("utf-8")
            data = json.loads(body)
        except json.JSONDecodeError as e:
            logger.error(f"MCP parse error: {e}")
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
            logger.error(f"MCP invalid request: {e}")
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

        # Check if this is a notification (no id)
        is_notification = rpc_request.id is None

        # Handle the request
        try:
            response = await mcp_handler.handle_request(rpc_request)

            # Notifications don't get responses
            if is_notification:
                return Response(
                    status_code=202,
                    headers={"Content-Type": "application/json"},
                    body="",
                )

            return Response(
                status_code=200,
                headers={"Content-Type": "application/json"},
                body=json.dumps(response.model_dump()),
            )

        except Exception as e:
            logger.exception(f"MCP handler error: {e}")
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

    @app.get("/mcp/")
    async def get_mcp(request) -> Response:
        """MCP GET endpoint - returns 405.

        According to the Streamable HTTP Transport specification,
        GET is used for server-to-client streaming which we don't support.

        Returns:
            405 Method Not Allowed
        """
        return Response(
            status_code=405,
            headers={
                "Content-Type": "application/json",
                "Allow": "POST, DELETE",
            },
            body=json.dumps(
                {"error": "GET method not allowed; streaming not supported"}
            ),
        )

    @app.delete("/mcp/")
    async def delete_mcp(request) -> Response:
        """MCP DELETE endpoint - returns 404.

        According to the Streamable HTTP Transport specification,
        DELETE is used to terminate sessions. Since our implementation
        is stateless, there are no sessions to terminate.

        Returns:
            404 Session Not Found
        """
        return Response(
            status_code=404,
            headers={"Content-Type": "application/json"},
            body=json.dumps({"error": "Session not found (server is stateless)"}),
        )

    logger.info("MCP routes registered: POST/GET/DELETE /mcp/")
