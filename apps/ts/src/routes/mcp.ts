/**
 * MCP Protocol route handlers — HTTP endpoints for the MCP server.
 *
 * Port of: apps/python/src/server/routes/mcp.py
 *
 * Implements the MCP (Model Context Protocol) HTTP endpoints according to
 * the Streamable HTTP Transport specification. The agent is exposed as
 * an MCP server that external clients can connect to.
 *
 * Endpoints:
 *   - `POST /mcp/` — JSON-RPC 2.0 message handler
 *   - `GET /mcp/`  — Returns 405 (streaming not supported)
 *   - `DELETE /mcp/` — Returns 404 (stateless, no session to terminate)
 *
 * MCP Specification: https://modelcontextprotocol.io/
 */

import type { Router, RouteHandler } from "../router";
import {
  mcpHandler,
  JsonRpcErrorCode,
  parseJsonRpcRequest,
  createErrorResponse,
  serialiseResponse,
} from "../mcp";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build a JSON response with the given status code.
 *
 * @param body - The response body (will be JSON-serialised).
 * @param status - HTTP status code.
 * @returns A `Response` with `Content-Type: application/json`.
 */
function jsonResponse(
  body: unknown,
  status: number,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/**
 * `POST /mcp/` — Handle MCP JSON-RPC 2.0 messages.
 *
 * Implements the Streamable HTTP Transport specification.
 * Accepts JSON-RPC 2.0 requests and returns appropriate responses.
 *
 * Returns:
 *   - 200: Successful JSON-RPC response
 *   - 202: Notification accepted (no content)
 *   - 400: Bad request (invalid JSON or message format)
 *   - 500: Internal server error
 */
const postMcp: RouteHandler = async (request, _params, _query) => {
  // --- Parse request body ---

  let data: unknown;
  try {
    const rawBody = await request.text();
    data = JSON.parse(rawBody);
  } catch (parseError: unknown) {
    const message =
      parseError instanceof Error ? parseError.message : String(parseError);
    console.error(`[mcp-route] Parse error: ${message}`);

    const errorResponse = createErrorResponse(
      null,
      JsonRpcErrorCode.PARSE_ERROR,
      `Parse error: ${message}`,
    );
    return jsonResponse(serialiseResponse(errorResponse), 400);
  }

  // --- Validate JSON-RPC structure ---

  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    const errorResponse = createErrorResponse(
      null,
      JsonRpcErrorCode.INVALID_REQUEST,
      "Request must be a JSON object",
    );
    return jsonResponse(serialiseResponse(errorResponse), 400);
  }

  // --- Parse as JSON-RPC request ---

  const rpcRequest = parseJsonRpcRequest(data);
  if (rpcRequest === null) {
    const dataObj = data as Record<string, unknown>;
    const errorResponse = createErrorResponse(
      (dataObj.id as string | number | null) ?? null,
      JsonRpcErrorCode.INVALID_REQUEST,
      "Invalid JSON-RPC request: missing or invalid 'method' field",
    );
    return jsonResponse(serialiseResponse(errorResponse), 400);
  }

  // Check if this is a notification (no id)
  const isNotification = rpcRequest.id === null;

  // --- Handle the request ---

  try {
    const response = await mcpHandler.handleRequest(rpcRequest);

    // Notifications don't get responses (return 202 Accepted)
    if (isNotification) {
      return new Response("", {
        status: 202,
        headers: { "Content-Type": "application/json" },
      });
    }

    return jsonResponse(serialiseResponse(response), 200);
  } catch (handlerError: unknown) {
    const message =
      handlerError instanceof Error
        ? handlerError.message
        : String(handlerError);
    console.error(`[mcp-route] Handler error: ${message}`);

    const errorResponse = createErrorResponse(
      rpcRequest.id,
      JsonRpcErrorCode.INTERNAL_ERROR,
      `Internal error: ${message}`,
    );
    return jsonResponse(serialiseResponse(errorResponse), 500);
  }
};

/**
 * `GET /mcp/` — Returns 405 Method Not Allowed.
 *
 * According to the Streamable HTTP Transport specification,
 * GET is used for server-to-client streaming which we don't support.
 */
const getMcp: RouteHandler = async (_request, _params, _query) => {
  return new Response(
    JSON.stringify({
      error: "GET method not allowed; streaming not supported",
    }),
    {
      status: 405,
      headers: {
        "Content-Type": "application/json",
        Allow: "POST, DELETE",
      },
    },
  );
};

/**
 * `DELETE /mcp/` — Returns 404 Session Not Found.
 *
 * According to the Streamable HTTP Transport specification,
 * DELETE is used to terminate sessions. Since our implementation
 * is stateless, there are no sessions to terminate.
 */
const deleteMcp: RouteHandler = async (_request, _params, _query) => {
  return jsonResponse(
    { error: "Session not found (server is stateless)" },
    404,
  );
};

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Register MCP protocol routes on the router.
 *
 * Registers:
 *   - `POST /mcp` — JSON-RPC 2.0 message handler
 *   - `GET /mcp` — 405 Method Not Allowed
 *   - `DELETE /mcp` — 404 Session Not Found
 *
 * @param router - The application router instance.
 */
export function registerMcpRoutes(router: Router): void {
  router.post("/mcp", postMcp);
  router.get("/mcp", getMcp);
  router.delete("/mcp", deleteMcp);

  console.log("[mcp-route] MCP routes registered: POST/GET/DELETE /mcp");
}
