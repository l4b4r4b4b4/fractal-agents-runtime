/**
 * Tests for SSE formatting utilities — Fractal Agents Runtime TypeScript/Bun (v0.0.1).
 *
 * Validates that every SSE helper produces wire-format strings matching
 * the Python runtime's `sse.py` exactly:
 *
 *   event: <type>\n
 *   data: <json>\n
 *   \n
 *
 * Also tests the message builders, header generators, and the async
 * generator → ReadableStream adapter.
 *
 * Reference: apps/python/src/server/routes/sse.py
 */

import { describe, expect, test } from "bun:test";
import {
  formatSseEvent,
  formatMetadataEvent,
  formatValuesEvent,
  formatUpdatesEvent,
  formatMessagesTupleEvent,
  formatErrorEvent,
  formatEndEvent,
  sseHeaders,
  createHumanMessage,
  createAiMessage,
  asyncGeneratorToReadableStream,
  sseResponse,
} from "../src/routes/sse";

// ---------------------------------------------------------------------------
// formatSseEvent
// ---------------------------------------------------------------------------

describe("formatSseEvent", () => {
  test("formats object data as JSON", () => {
    const result = formatSseEvent("metadata", { run_id: "abc", attempt: 1 });
    expect(result).toBe('event: metadata\ndata: {"run_id":"abc","attempt":1}\n\n');
  });

  test("formats string data verbatim", () => {
    const result = formatSseEvent("end", "");
    expect(result).toBe("event: end\ndata: \n\n");
  });

  test("formats array data as JSON", () => {
    const result = formatSseEvent("messages", [{ content: "hi" }, { node: "model" }]);
    expect(result).toBe('event: messages\ndata: [{"content":"hi"},{"node":"model"}]\n\n');
  });

  test("formats number data as JSON", () => {
    const result = formatSseEvent("count", 42);
    expect(result).toBe("event: count\ndata: 42\n\n");
  });

  test("formats null data as JSON", () => {
    const result = formatSseEvent("empty", null);
    expect(result).toBe("event: empty\ndata: null\n\n");
  });

  test("formats boolean data as JSON", () => {
    const result = formatSseEvent("flag", true);
    expect(result).toBe("event: flag\ndata: true\n\n");
  });

  test("event string terminates with double newline", () => {
    const result = formatSseEvent("test", {});
    expect(result.endsWith("\n\n")).toBe(true);
  });

  test("event string starts with 'event: '", () => {
    const result = formatSseEvent("myevent", {});
    expect(result.startsWith("event: myevent\n")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// formatMetadataEvent
// ---------------------------------------------------------------------------

describe("formatMetadataEvent", () => {
  test("includes run_id and default attempt=1", () => {
    const result = formatMetadataEvent("run-123");
    expect(result).toBe('event: metadata\ndata: {"run_id":"run-123","attempt":1}\n\n');
  });

  test("includes custom attempt number", () => {
    const result = formatMetadataEvent("run-456", 3);
    expect(result).toBe('event: metadata\ndata: {"run_id":"run-456","attempt":3}\n\n');
  });

  test("event type is 'metadata'", () => {
    const result = formatMetadataEvent("x");
    expect(result).toContain("event: metadata\n");
  });
});

// ---------------------------------------------------------------------------
// formatValuesEvent
// ---------------------------------------------------------------------------

describe("formatValuesEvent", () => {
  test("formats state values as 'values' event", () => {
    const values = { messages: [{ content: "hello", type: "human" }] };
    const result = formatValuesEvent(values);
    expect(result).toContain("event: values\n");
    const parsed = JSON.parse(result.split("data: ")[1].trim());
    expect(parsed.messages).toBeArray();
    expect(parsed.messages[0].content).toBe("hello");
  });

  test("handles empty values", () => {
    const result = formatValuesEvent({});
    expect(result).toBe("event: values\ndata: {}\n\n");
  });

  test("handles nested objects", () => {
    const values = { messages: [], metadata: { key: "value" } };
    const result = formatValuesEvent(values);
    const parsed = JSON.parse(result.split("data: ")[1].trim());
    expect(parsed.metadata.key).toBe("value");
  });
});

// ---------------------------------------------------------------------------
// formatUpdatesEvent
// ---------------------------------------------------------------------------

describe("formatUpdatesEvent", () => {
  test("wraps updates under node name key", () => {
    const result = formatUpdatesEvent("model", { messages: [{ type: "ai" }] });
    expect(result).toContain("event: updates\n");
    const parsed = JSON.parse(result.split("data: ")[1].trim());
    expect(parsed.model).toBeDefined();
    expect(parsed.model.messages).toBeArray();
  });

  test("uses 'status' as node name", () => {
    const result = formatUpdatesEvent("status", { status: "success", message: "Done" });
    const parsed = JSON.parse(result.split("data: ")[1].trim());
    expect(parsed.status.status).toBe("success");
    expect(parsed.status.message).toBe("Done");
  });
});

// ---------------------------------------------------------------------------
// formatMessagesTupleEvent
// ---------------------------------------------------------------------------

describe("formatMessagesTupleEvent", () => {
  test("emits 'messages' event with [delta, metadata] tuple", () => {
    const delta = { content: "Hello", type: "ai", id: "msg-1" };
    const metadata = { langgraph_node: "model", run_id: "run-1" };
    const result = formatMessagesTupleEvent(delta, metadata);

    expect(result).toContain("event: messages\n");
    const parsed = JSON.parse(result.split("data: ")[1].trim());
    expect(parsed).toBeArray();
    expect(parsed).toHaveLength(2);
    expect(parsed[0].content).toBe("Hello");
    expect(parsed[1].langgraph_node).toBe("model");
  });

  test("delta can have empty content (initial empty delta)", () => {
    const delta = { content: "", type: "ai", id: "msg-1" };
    const metadata = { run_id: "r" };
    const result = formatMessagesTupleEvent(delta, metadata);
    const parsed = JSON.parse(result.split("data: ")[1].trim());
    expect(parsed[0].content).toBe("");
  });
});

// ---------------------------------------------------------------------------
// formatErrorEvent
// ---------------------------------------------------------------------------

describe("formatErrorEvent", () => {
  test("formats error message", () => {
    const result = formatErrorEvent("Something went wrong");
    expect(result).toContain("event: error\n");
    const parsed = JSON.parse(result.split("data: ")[1].trim());
    expect(parsed.error).toBe("Something went wrong");
  });

  test("includes error code when provided", () => {
    const result = formatErrorEvent("Init failed", "AGENT_INIT_ERROR");
    const parsed = JSON.parse(result.split("data: ")[1].trim());
    expect(parsed.error).toBe("Init failed");
    expect(parsed.code).toBe("AGENT_INIT_ERROR");
  });

  test("omits code key when not provided", () => {
    const result = formatErrorEvent("Oops");
    const parsed = JSON.parse(result.split("data: ")[1].trim());
    expect(parsed.code).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// formatEndEvent
// ---------------------------------------------------------------------------

describe("formatEndEvent", () => {
  test("emits end event with empty data", () => {
    const result = formatEndEvent();
    expect(result).toBe("event: end\ndata: \n\n");
  });

  test("event type is 'end'", () => {
    const result = formatEndEvent();
    expect(result).toContain("event: end\n");
  });
});

// ---------------------------------------------------------------------------
// sseHeaders
// ---------------------------------------------------------------------------

describe("sseHeaders", () => {
  test("includes required SSE headers with no options", () => {
    const headers = sseHeaders();
    expect(headers["Content-Type"]).toBe("text/event-stream; charset=utf-8");
    expect(headers["Cache-Control"]).toBe("no-store");
    expect(headers["X-Accel-Buffering"]).toBe("no");
    expect(headers["Access-Control-Allow-Origin"]).toBe("*");
  });

  test("sets Location and Content-Location for stateful run", () => {
    const headers = sseHeaders({ threadId: "t1", runId: "r1" });
    expect(headers["Location"]).toBe("/threads/t1/runs/r1/stream");
    expect(headers["Content-Location"]).toBe("/threads/t1/runs/r1");
  });

  test("sets stateless Location pattern", () => {
    const headers = sseHeaders({ runId: "r2", stateless: true });
    expect(headers["Location"]).toBe("/runs/r2/stream");
    expect(headers["Content-Location"]).toBe("/runs/r2");
  });

  test("omits Location when no runId", () => {
    const headers = sseHeaders({ threadId: "t1" });
    expect(headers["Location"]).toBeUndefined();
    expect(headers["Content-Location"]).toBeUndefined();
  });

  test("omits Location when runId present but no threadId and not stateless", () => {
    const headers = sseHeaders({ runId: "r1" });
    expect(headers["Location"]).toBeUndefined();
    expect(headers["Content-Location"]).toBeUndefined();
  });

  test("includes Access-Control-Allow-Headers", () => {
    const headers = sseHeaders();
    expect(headers["Access-Control-Allow-Headers"]).toBe("Cache-Control");
  });
});

// ---------------------------------------------------------------------------
// createHumanMessage
// ---------------------------------------------------------------------------

describe("createHumanMessage", () => {
  test("creates a human message with required fields", () => {
    const msg = createHumanMessage("Hello there");
    expect(msg.content).toBe("Hello there");
    expect(msg.type).toBe("human");
    expect(msg.additional_kwargs).toEqual({});
    expect(msg.response_metadata).toEqual({});
    expect(msg.name).toBeNull();
  });

  test("includes message ID when provided", () => {
    const msg = createHumanMessage("Hi", "msg-abc");
    expect(msg.id).toBe("msg-abc");
  });

  test("id is null when not provided", () => {
    const msg = createHumanMessage("Hi");
    expect(msg.id).toBeNull();
  });

  test("id is null when explicitly passed null", () => {
    const msg = createHumanMessage("Hi", null);
    expect(msg.id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// createAiMessage
// ---------------------------------------------------------------------------

describe("createAiMessage", () => {
  test("creates an AI message with required fields", () => {
    const msg = createAiMessage("I am an AI");
    expect(msg.content).toBe("I am an AI");
    expect(msg.type).toBe("ai");
    expect(msg.additional_kwargs).toEqual({});
    expect(msg.tool_calls).toEqual([]);
    expect(msg.invalid_tool_calls).toEqual([]);
    expect(msg.usage_metadata).toBeNull();
    expect(msg.name).toBeNull();
  });

  test("includes default model_provider in response_metadata", () => {
    const msg = createAiMessage("Hi");
    const meta = msg.response_metadata as Record<string, unknown>;
    expect(meta.model_provider).toBe("openai");
  });

  test("includes finish_reason when provided", () => {
    const msg = createAiMessage("Done", "msg-1", { finishReason: "stop" });
    const meta = msg.response_metadata as Record<string, unknown>;
    expect(meta.finish_reason).toBe("stop");
  });

  test("includes model_name when provided", () => {
    const msg = createAiMessage("Hi", "msg-1", { modelName: "gpt-4o" });
    const meta = msg.response_metadata as Record<string, unknown>;
    expect(meta.model_name).toBe("gpt-4o");
  });

  test("uses custom model_provider", () => {
    const msg = createAiMessage("Hi", null, { modelProvider: "anthropic" });
    const meta = msg.response_metadata as Record<string, unknown>;
    expect(meta.model_provider).toBe("anthropic");
  });

  test("omits finish_reason and model_name when not provided", () => {
    const msg = createAiMessage("Hi");
    const meta = msg.response_metadata as Record<string, unknown>;
    expect(meta.finish_reason).toBeUndefined();
    expect(meta.model_name).toBeUndefined();
  });

  test("id is null when not provided", () => {
    const msg = createAiMessage("Hi");
    expect(msg.id).toBeNull();
  });

  test("includes all options together", () => {
    const msg = createAiMessage("Full response", "msg-full", {
      finishReason: "stop",
      modelName: "gpt-4o-mini",
      modelProvider: "openai",
    });
    expect(msg.content).toBe("Full response");
    expect(msg.id).toBe("msg-full");
    const meta = msg.response_metadata as Record<string, unknown>;
    expect(meta.finish_reason).toBe("stop");
    expect(meta.model_name).toBe("gpt-4o-mini");
    expect(meta.model_provider).toBe("openai");
  });
});

// ---------------------------------------------------------------------------
// asyncGeneratorToReadableStream
// ---------------------------------------------------------------------------

describe("asyncGeneratorToReadableStream", () => {
  test("converts async generator to readable stream", async () => {
    async function* gen(): AsyncGenerator<string, void, unknown> {
      yield "event: metadata\ndata: {}\n\n";
      yield "event: end\ndata: \n\n";
    }

    const stream = asyncGeneratorToReadableStream(gen());
    const reader = stream.getReader();
    const decoder = new TextDecoder();

    const chunk1 = await reader.read();
    expect(chunk1.done).toBe(false);
    expect(decoder.decode(chunk1.value)).toBe("event: metadata\ndata: {}\n\n");

    const chunk2 = await reader.read();
    expect(chunk2.done).toBe(false);
    expect(decoder.decode(chunk2.value)).toBe("event: end\ndata: \n\n");

    const chunk3 = await reader.read();
    expect(chunk3.done).toBe(true);
  });

  test("handles empty generator", async () => {
    async function* gen(): AsyncGenerator<string, void, unknown> {
      // yields nothing
    }

    const stream = asyncGeneratorToReadableStream(gen());
    const reader = stream.getReader();

    const result = await reader.read();
    expect(result.done).toBe(true);
  });

  test("handles single event", async () => {
    async function* gen(): AsyncGenerator<string, void, unknown> {
      yield "event: test\ndata: 1\n\n";
    }

    const stream = asyncGeneratorToReadableStream(gen());
    const reader = stream.getReader();
    const decoder = new TextDecoder();

    const chunk = await reader.read();
    expect(chunk.done).toBe(false);
    expect(decoder.decode(chunk.value)).toBe("event: test\ndata: 1\n\n");

    const end = await reader.read();
    expect(end.done).toBe(true);
  });

  test("collects all chunks into full SSE text", async () => {
    async function* gen(): AsyncGenerator<string, void, unknown> {
      yield formatMetadataEvent("r1");
      yield formatValuesEvent({ messages: [] });
      yield formatEndEvent();
    }

    const stream = asyncGeneratorToReadableStream(gen());
    const response = new Response(stream);
    const text = await response.text();

    expect(text).toContain("event: metadata");
    expect(text).toContain("event: values");
    expect(text).toContain("event: end");
  });
});

// ---------------------------------------------------------------------------
// sseResponse
// ---------------------------------------------------------------------------

describe("sseResponse", () => {
  test("creates a Response with SSE content type", async () => {
    async function* gen(): AsyncGenerator<string, void, unknown> {
      yield formatEndEvent();
    }

    const response = sseResponse(gen());
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(
      "text/event-stream; charset=utf-8",
    );
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  test("includes Location headers for stateful run", async () => {
    async function* gen(): AsyncGenerator<string, void, unknown> {
      yield formatEndEvent();
    }

    const response = sseResponse(gen(), { threadId: "t1", runId: "r1" });
    expect(response.headers.get("Location")).toBe("/threads/t1/runs/r1/stream");
    expect(response.headers.get("Content-Location")).toBe("/threads/t1/runs/r1");
  });

  test("includes stateless Location headers", async () => {
    async function* gen(): AsyncGenerator<string, void, unknown> {
      yield formatEndEvent();
    }

    const response = sseResponse(gen(), { runId: "r2", stateless: true });
    expect(response.headers.get("Location")).toBe("/runs/r2/stream");
  });

  test("body contains streamed events", async () => {
    async function* gen(): AsyncGenerator<string, void, unknown> {
      yield formatMetadataEvent("run-x");
      yield formatValuesEvent({ count: 0 });
      yield formatEndEvent();
    }

    const response = sseResponse(gen());
    const text = await response.text();

    expect(text).toContain("event: metadata");
    expect(text).toContain('"run_id":"run-x"');
    expect(text).toContain("event: values");
    expect(text).toContain("event: end");
  });

  test("supports custom status code", async () => {
    async function* gen(): AsyncGenerator<string, void, unknown> {
      yield formatEndEvent();
    }

    const response = sseResponse(gen(), undefined, 201);
    expect(response.status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// SSE wire format parity with Python
// ---------------------------------------------------------------------------

describe("SSE wire format — Python parity", () => {
  test("metadata event matches Python format exactly", () => {
    const result = formatMetadataEvent("abc-123", 1);
    expect(result).toBe('event: metadata\ndata: {"run_id":"abc-123","attempt":1}\n\n');
  });

  test("values event matches Python format", () => {
    const result = formatValuesEvent({ messages: [] });
    expect(result).toBe('event: values\ndata: {"messages":[]}\n\n');
  });

  test("updates event wraps under node name", () => {
    const result = formatUpdatesEvent("model", { messages: [] });
    expect(result).toBe('event: updates\ndata: {"model":{"messages":[]}}\n\n');
  });

  test("messages event is a 2-element array", () => {
    const delta = { content: "hi", type: "ai" };
    const meta = { run_id: "r" };
    const result = formatMessagesTupleEvent(delta, meta);
    const parsed = JSON.parse(result.split("data: ")[1].trim());
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(2);
  });

  test("error event includes error field", () => {
    const result = formatErrorEvent("fail", "CODE");
    const parsed = JSON.parse(result.split("data: ")[1].trim());
    expect(parsed.error).toBe("fail");
    expect(parsed.code).toBe("CODE");
  });

  test("end event has empty string data", () => {
    const result = formatEndEvent();
    expect(result).toBe("event: end\ndata: \n\n");
  });

  test("complete stream sequence follows metadata → values → messages → values → end", () => {
    const events = [
      formatMetadataEvent("r1"),
      formatValuesEvent({ messages: [{ content: "hi", type: "human" }] }),
      formatMessagesTupleEvent(
        { content: "Hello!", type: "ai" },
        { run_id: "r1", langgraph_node: "model" },
      ),
      formatValuesEvent({
        messages: [
          { content: "hi", type: "human" },
          { content: "Hello!", type: "ai" },
        ],
      }),
      formatEndEvent(),
    ];

    const full = events.join("");

    // Verify event order
    const eventTypes = [...full.matchAll(/event: (\w+)/g)].map((m) => m[1]);
    expect(eventTypes).toEqual(["metadata", "values", "messages", "values", "end"]);

    // Verify each event is separated by double newline
    for (const event of events) {
      expect(event.endsWith("\n\n")).toBe(true);
    }
  });
});
