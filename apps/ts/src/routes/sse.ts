/**
 * SSE (Server-Sent Events) utilities for LangGraph-compatible streaming.
 *
 * This module provides helpers for creating SSE responses that match
 * the LangGraph Runtime API framing specification. Every function here
 * is a pure formatting helper — no storage, no agent, no I/O.
 *
 * SSE wire format:
 *
 *   event: <event_type>
 *   data: <json_payload>
 *
 *   (blank line terminates each event)
 *
 * Reference: apps/python/src/server/routes/sse.py
 */

// ---------------------------------------------------------------------------
// SSE framing
// ---------------------------------------------------------------------------

/**
 * Format data as an SSE event string.
 *
 * Matches the LangGraph API SSE framing:
 *
 *   event: metadata
 *   data: {"run_id":"...","attempt":1}
 *
 * @param eventType - The SSE event type (e.g., "metadata", "values", "updates").
 * @param data - Data to serialize. Strings are used verbatim; everything else
 *   is JSON-serialized with compact separators.
 * @returns SSE-formatted string with event and data lines, terminated by `\n\n`.
 */
export function formatSseEvent(eventType: string, data: unknown): string {
  const jsonData =
    typeof data === "string" ? data : JSON.stringify(data);
  return `event: ${eventType}\ndata: ${jsonData}\n\n`;
}

// ---------------------------------------------------------------------------
// Typed event formatters
// ---------------------------------------------------------------------------

/**
 * Format the initial metadata SSE event.
 *
 * This is always the **first** event emitted in any stream. It tells
 * the client which run is being streamed and how many attempts have
 * been made (for retry logic).
 *
 * @param runId - The run ID.
 * @param attempt - Attempt number (default 1).
 * @returns SSE-formatted metadata event.
 */
export function formatMetadataEvent(runId: string, attempt = 1): string {
  return formatSseEvent("metadata", { run_id: runId, attempt });
}

/**
 * Format a values SSE event.
 *
 * Used to emit the initial state (input messages) and the final state
 * (accumulated messages including the AI response).
 *
 * @param values - The state values, typically `{ messages: [...] }`.
 * @returns SSE-formatted values event.
 */
export function formatValuesEvent(values: Record<string, unknown>): string {
  return formatSseEvent("values", values);
}

/**
 * Format an updates SSE event.
 *
 * Used for graph node updates. The outer key is the node name, and the
 * value is the update payload.
 *
 * @param nodeName - The node that produced the update (e.g., "model", "status").
 * @param updates - The update data.
 * @returns SSE-formatted updates event.
 */
export function formatUpdatesEvent(
  nodeName: string,
  updates: Record<string, unknown>,
): string {
  return formatSseEvent("updates", { [nodeName]: updates });
}

/**
 * Format a messages-tuple SSE event.
 *
 * Emits `event: messages` with a 2-element tuple `[messageDelta, metadata]`
 * matching the protocol expected by `@langchain/langgraph-sdk` >= v1.6.0.
 *
 * The `messageDelta` must contain only **new** content (a delta), not
 * the accumulated text. The SDK's `MessageTupleManager.add()` calls
 * `.concat()` on message chunks, so sending accumulated content would
 * result in duplicated text.
 *
 * @param messageDelta - Message dict whose `content` field holds only the
 *   new token(s) produced since the last event.
 * @param metadata - Flat metadata dict (e.g., `{ langgraph_node: "model", ... }`).
 * @returns SSE-formatted `event: messages` string.
 */
export function formatMessagesTupleEvent(
  messageDelta: Record<string, unknown>,
  metadata: Record<string, unknown>,
): string {
  return formatSseEvent("messages", [messageDelta, metadata]);
}

/**
 * Format an error SSE event.
 *
 * @param error - Human-readable error message.
 * @param code - Optional machine-readable error code.
 * @returns SSE-formatted error event.
 */
export function formatErrorEvent(error: string, code?: string): string {
  const data: Record<string, unknown> = { error };
  if (code) {
    data.code = code;
  }
  return formatSseEvent("error", data);
}

/**
 * Format a stream-end SSE event.
 *
 * This is always the **last** event emitted in any stream. It signals
 * to the client that no more events will follow.
 *
 * @returns SSE-formatted end event.
 */
export function formatEndEvent(): string {
  return formatSseEvent("end", "");
}

// ---------------------------------------------------------------------------
// SSE response headers
// ---------------------------------------------------------------------------

/**
 * Create SSE response headers matching the LangGraph API.
 *
 * Sets the required headers for SSE streaming:
 * - `Content-Type: text/event-stream; charset=utf-8`
 * - `Cache-Control: no-store`
 * - `X-Accel-Buffering: no` (disables Nginx buffering)
 * - `Access-Control-Allow-Origin: *`
 * - `Location` / `Content-Location` headers for run identification
 *
 * @param options - Header options.
 * @param options.threadId - Thread ID for Location headers (optional).
 * @param options.runId - Run ID for Location headers (optional).
 * @param options.stateless - If true, use stateless URL pattern `/runs/...`.
 * @returns A plain headers object suitable for `new Response(body, { headers })`.
 */
export function sseHeaders(options?: {
  threadId?: string;
  runId?: string;
  stateless?: boolean;
}): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Accel-Buffering": "no",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Cache-Control",
  };

  const runId = options?.runId;
  const threadId = options?.threadId;
  const stateless = options?.stateless ?? false;

  if (runId) {
    if (stateless) {
      headers["Location"] = `/runs/${runId}/stream`;
      headers["Content-Location"] = `/runs/${runId}`;
    } else if (threadId) {
      headers["Location"] = `/threads/${threadId}/runs/${runId}/stream`;
      headers["Content-Location"] = `/threads/${threadId}/runs/${runId}`;
    }
  }

  return headers;
}

// ---------------------------------------------------------------------------
// Message builders
// ---------------------------------------------------------------------------

/**
 * Create a human message in LangChain format.
 *
 * Matches the Python runtime's `create_human_message()`.
 *
 * @param content - Message content.
 * @param messageId - Optional message ID.
 * @returns Human message dict compatible with LangChain serialization.
 */
export function createHumanMessage(
  content: string,
  messageId?: string | null,
): Record<string, unknown> {
  return {
    content,
    additional_kwargs: {},
    response_metadata: {},
    type: "human",
    name: null,
    id: messageId ?? null,
  };
}

/**
 * Create an AI message in LangChain format.
 *
 * Matches the Python runtime's `create_ai_message()`.
 *
 * @param content - Message content (may be empty string for deltas).
 * @param messageId - Optional message ID.
 * @param options - Optional finish_reason, model_name, model_provider.
 * @returns AI message dict compatible with LangChain serialization.
 */
export function createAiMessage(
  content: string,
  messageId?: string | null,
  options?: {
    finishReason?: string;
    modelName?: string;
    modelProvider?: string;
  },
): Record<string, unknown> {
  const modelProvider = options?.modelProvider ?? "openai";

  const responseMetadata: Record<string, unknown> = {
    model_provider: modelProvider,
  };
  if (options?.finishReason) {
    responseMetadata.finish_reason = options.finishReason;
  }
  if (options?.modelName) {
    responseMetadata.model_name = options.modelName;
  }

  return {
    content,
    additional_kwargs: {},
    response_metadata: responseMetadata,
    type: "ai",
    name: null,
    id: messageId ?? null,
    tool_calls: [],
    invalid_tool_calls: [],
    usage_metadata: null,
  };
}

// ---------------------------------------------------------------------------
// Async generator → ReadableStream adapter
// ---------------------------------------------------------------------------

/**
 * Convert an async generator of SSE event strings into a `ReadableStream`.
 *
 * This is the bridge between our async-generator streaming pattern and
 * Bun's `new Response(readableStream)`. Each yielded string is encoded
 * to UTF-8 and enqueued into the readable stream.
 *
 * @param generator - An async generator that yields SSE-formatted strings.
 * @returns A `ReadableStream<Uint8Array>` suitable for `new Response(stream)`.
 */
export function asyncGeneratorToReadableStream(
  generator: AsyncGenerator<string, void, unknown>,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await generator.next();
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(value));
      } catch (error: unknown) {
        controller.error(error);
      }
    },

    cancel() {
      // Signal the generator to clean up when the client disconnects.
      generator.return(undefined as unknown as void);
    },
  });
}

/**
 * Create a full SSE `Response` from an async generator of event strings.
 *
 * Combines `asyncGeneratorToReadableStream` with the appropriate SSE headers.
 *
 * @param generator - Async generator yielding SSE-formatted strings.
 * @param options - Header options passed to `sseHeaders`.
 * @param statusCode - HTTP status code (default 200).
 * @returns A Bun/Fetch API `Response` with SSE streaming body.
 */
export function sseResponse(
  generator: AsyncGenerator<string, void, unknown>,
  options?: {
    threadId?: string;
    runId?: string;
    stateless?: boolean;
  },
  statusCode = 200,
): Response {
  const stream = asyncGeneratorToReadableStream(generator);
  const headers = sseHeaders(options);

  return new Response(stream, {
    status: statusCode,
    headers,
  });
}
