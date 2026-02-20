/**
 * A2A Protocol route handler — TypeScript/Bun.
 *
 * Implements the Agent-to-Agent (A2A) Protocol HTTP endpoint according to
 * the Google A2A specification using JSON-RPC 2.0 over HTTP.
 *
 * Endpoint:
 *   POST /a2a/:assistantId — JSON-RPC 2.0 message handler
 *
 * Supports:
 *   - `message/send` — Synchronous message handling (JSON response)
 *   - `message/stream` — SSE streaming responses (text/event-stream)
 *   - `tasks/get` — Task status retrieval
 *   - `tasks/cancel` — Task cancellation (returns unsupported error)
 *
 * The Accept header determines the response format for `message/stream`:
 *   - `application/json` — Standard JSON-RPC response
 *   - `text/event-stream` — SSE stream
 *
 * Port of: apps/python/src/server/routes/a2a.py
 */

import type { Router } from "../router";
import {
  A2AMethodHandler,
  JsonRpcErrorCode,
  createErrorResponse,
  parseJsonRpcRequest,
} from "../a2a";
import type { A2AStorage } from "../a2a";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a JSON response from a JSON-RPC response object.
 *
 * @param body - The JSON-RPC response to serialize.
 * @param statusCode - HTTP status code (default: 200).
 * @returns A `Response` with JSON content type.
 */
function jsonRpcResponse(
  body: Record<string, unknown>,
  statusCode: number = 200,
): Response {
  return new Response(JSON.stringify(body), {
    status: statusCode,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Register A2A protocol routes on the router.
 *
 * Registers:
 *   - `POST /a2a/:assistantId` — JSON-RPC 2.0 message handler
 *
 * @param router - The application router instance.
 * @param storage - The storage backend for assistants, threads, and runs.
 */
export function registerA2ARoutes(
  router: Router,
  storage: A2AStorage,
): void {
  const handler = new A2AMethodHandler({ storage });

  router.post("/a2a/:assistantId", async (request, params) => {
    const assistantId = params.assistantId;

    // -----------------------------------------------------------------------
    // Validate assistant_id from path
    // -----------------------------------------------------------------------

    if (!assistantId) {
      const errorResponse = createErrorResponse(
        null,
        JsonRpcErrorCode.INVALID_PARAMS,
        "assistant_id is required in path",
      );
      return jsonRpcResponse(
        errorResponse as unknown as Record<string, unknown>,
        400,
      );
    }

    // -----------------------------------------------------------------------
    // Parse request body
    // -----------------------------------------------------------------------

    let data: Record<string, unknown>;
    try {
      const bodyText = await request.text();
      const parsed: unknown = JSON.parse(bodyText);

      if (
        parsed === null ||
        typeof parsed !== "object" ||
        Array.isArray(parsed)
      ) {
        const errorResponse = createErrorResponse(
          null,
          JsonRpcErrorCode.INVALID_REQUEST,
          "Request must be a JSON object",
        );
        return jsonRpcResponse(
          errorResponse as unknown as Record<string, unknown>,
          400,
        );
      }

      data = parsed as Record<string, unknown>;
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : String(error);
      console.error(`[a2a] parse error: ${message}`);
      const errorResponse = createErrorResponse(
        null,
        JsonRpcErrorCode.PARSE_ERROR,
        `Parse error: ${message}`,
      );
      return jsonRpcResponse(
        errorResponse as unknown as Record<string, unknown>,
        400,
      );
    }

    // -----------------------------------------------------------------------
    // Validate JSON-RPC structure
    // -----------------------------------------------------------------------

    let rpcRequest;
    try {
      rpcRequest = parseJsonRpcRequest(data);
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : String(error);
      console.error(`[a2a] invalid request: ${message}`);
      const errorResponse = createErrorResponse(
        (data.id as string | number | null) ?? null,
        JsonRpcErrorCode.INVALID_REQUEST,
        `Invalid request: ${message}`,
      );
      return jsonRpcResponse(
        errorResponse as unknown as Record<string, unknown>,
        400,
      );
    }

    // -----------------------------------------------------------------------
    // Handle message/stream with SSE (special case)
    // -----------------------------------------------------------------------

    if (rpcRequest.method === "message/stream") {
      const acceptHeader =
        request.headers.get("accept") ?? "application/json";
      const wantsStream = acceptHeader.includes("text/event-stream");

      if (!wantsStream) {
        const errorResponse = createErrorResponse(
          rpcRequest.id,
          JsonRpcErrorCode.INVALID_REQUEST,
          "message/stream requires Accept: text/event-stream header",
        );
        return jsonRpcResponse(
          errorResponse as unknown as Record<string, unknown>,
          400,
        );
      }

      // SSE streaming is not yet fully implemented.
      // Return a stub SSE stream with a status-update event indicating
      // the feature is not yet available, then close.
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          const statusEvent = {
            kind: "status-update",
            taskId: "pending",
            contextId: "pending",
            status: {
              state: "failed",
              message:
                "message/stream is not yet fully implemented in the TS runtime",
              timestamp: new Date().toISOString(),
            },
            final: true,
          };

          const errorResponse = createErrorResponse(
            rpcRequest.id,
            JsonRpcErrorCode.UNSUPPORTED_OPERATION,
            "message/stream is not yet fully implemented",
          );

          controller.enqueue(
            encoder.encode(
              `event: status-update\ndata: ${JSON.stringify(statusEvent)}\n\n`,
            ),
          );
          controller.enqueue(
            encoder.encode(
              `event: error\ndata: ${JSON.stringify(errorResponse)}\n\n`,
            ),
          );
          controller.close();
        },
      });

      return new Response(stream, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        },
      });
    }

    // -----------------------------------------------------------------------
    // Handle standard JSON-RPC methods (message/send, tasks/get, tasks/cancel)
    // -----------------------------------------------------------------------

    // The owner_id would normally come from authentication middleware.
    // For now, we extract it from the request headers or use a default.
    // In production, this is set by the auth middleware in router.handle().
    const ownerId =
      (request.headers.get("x-owner-id") as string) ?? "system";

    try {
      const response = await handler.handleRequest(
        rpcRequest,
        assistantId,
        ownerId,
      );
      return jsonRpcResponse(
        response as unknown as Record<string, unknown>,
        200,
      );
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : String(error);
      console.error(`[a2a] handler error: ${message}`);
      const errorResponse = createErrorResponse(
        rpcRequest.id,
        JsonRpcErrorCode.INTERNAL_ERROR,
        `Internal error: ${message}`,
      );
      return jsonRpcResponse(
        errorResponse as unknown as Record<string, unknown>,
        500,
      );
    }
  });

  console.info("[a2a] routes registered: POST /a2a/:assistantId");
}
