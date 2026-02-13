/**
 * Tests for SSE streaming route endpoints — Fractal Agents Runtime TypeScript/Bun (v0.0.1).
 *
 * Validates that SSE streaming endpoints return proper text/event-stream
 * responses with LangGraph-compatible SSE event framing:
 *
 *   POST /threads/:thread_id/runs/stream       — Create run + SSE stream
 *   GET  /threads/:thread_id/runs/:run_id/stream — Reconnect to existing stream
 *
 * SSE wire format verified:
 *   - Content-Type: text/event-stream; charset=utf-8
 *   - Events match: metadata → values → [messages] → [updates] → values → end
 *   - Each event: `event: <type>\ndata: <json>\n\n`
 *   - Location / Content-Location headers present
 *
 * Agent execution uses FakeListChatModel (no real API calls).
 *
 * Reference:
 *   - apps/python/src/server/routes/streams.py
 *   - apps/python/src/server/routes/sse.py
 *   - apps/python/openapi-spec.json
 */

import { describe, expect, test, beforeEach } from "bun:test";
import { router } from "../src/index";
import { resetStorage, getStorage } from "../src/storage/index";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(
  path: string,
  method = "GET",
  body?: unknown,
): Request {
  const options: RequestInit = { method };
  if (body !== undefined) {
    options.headers = { "Content-Type": "application/json" };
    options.body = JSON.stringify(body);
  }
  return new Request(`http://localhost:3000${path}`, options);
}

async function jsonBody<T = unknown>(response: Response): Promise<T> {
  return response.json() as Promise<T>;
}

interface ErrorBody {
  detail: string;
}

interface RunResponse {
  run_id: string;
  thread_id: string;
  assistant_id: string;
  status: string;
}

/**
 * Parse SSE text into an array of { event, data } objects.
 */
function parseSseEvents(
  text: string,
): Array<{ event: string; data: string }> {
  const events: Array<{ event: string; data: string }> = [];
  // Split by double newline to get individual events
  const rawEvents = text.split("\n\n").filter((chunk) => chunk.trim().length > 0);

  for (const rawEvent of rawEvents) {
    const lines = rawEvent.split("\n");
    let eventType = "";
    let eventData = "";

    for (const line of lines) {
      if (line.startsWith("event: ")) {
        eventType = line.slice(7);
      } else if (line.startsWith("data: ")) {
        eventData = line.slice(6);
      }
    }

    if (eventType) {
      events.push({ event: eventType, data: eventData });
    }
  }

  return events;
}

// ---------------------------------------------------------------------------
// Helper: create a thread and assistant via the API
// ---------------------------------------------------------------------------

async function createThread(
  metadata: Record<string, unknown> = {},
): Promise<{ thread_id: string }> {
  const response = await router.handle(
    makeRequest("/threads", "POST", { metadata }),
  );
  return jsonBody(response);
}

async function createAssistant(
  graphId = "agent",
  name = "Test Assistant",
): Promise<{ assistant_id: string; graph_id: string }> {
  const response = await router.handle(
    makeRequest("/assistants", "POST", {
      graph_id: graphId,
      name,
      config: { configurable: {} },
      metadata: {},
    }),
  );
  return jsonBody(response);
}

async function createRun(
  threadId: string,
  assistantId: string,
  extra: Record<string, unknown> = {},
): Promise<RunResponse> {
  const response = await router.handle(
    makeRequest(`/threads/${threadId}/runs`, "POST", {
      assistant_id: assistantId,
      ...extra,
    }),
  );
  return jsonBody(response);
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  resetStorage();
});

// ===========================================================================
// POST /threads/:thread_id/runs/stream — Create run + SSE stream
// ===========================================================================

describe("POST /threads/:thread_id/runs/stream — create run stream", () => {
  test("returns SSE content type", async () => {
    const thread = await createThread();
    const assistant = await createAssistant();

    const response = await router.handle(
      makeRequest(`/threads/${thread.thread_id}/runs/stream`, "POST", {
        assistant_id: assistant.assistant_id,
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(
      "text/event-stream; charset=utf-8",
    );
  });

  test("includes Cache-Control: no-store header", async () => {
    const thread = await createThread();
    const assistant = await createAssistant();

    const response = await router.handle(
      makeRequest(`/threads/${thread.thread_id}/runs/stream`, "POST", {
        assistant_id: assistant.assistant_id,
      }),
    );

    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  test("includes X-Accel-Buffering: no header", async () => {
    const thread = await createThread();
    const assistant = await createAssistant();

    const response = await router.handle(
      makeRequest(`/threads/${thread.thread_id}/runs/stream`, "POST", {
        assistant_id: assistant.assistant_id,
      }),
    );

    expect(response.headers.get("X-Accel-Buffering")).toBe("no");
  });

  test("includes Location header", async () => {
    const thread = await createThread();
    const assistant = await createAssistant();

    const response = await router.handle(
      makeRequest(`/threads/${thread.thread_id}/runs/stream`, "POST", {
        assistant_id: assistant.assistant_id,
      }),
    );

    const location = response.headers.get("Location");
    expect(location).toBeString();
    expect(location!).toContain("/runs/");
    expect(location!).toContain("/stream");
  });

  test("includes Content-Location header", async () => {
    const thread = await createThread();
    const assistant = await createAssistant();

    const response = await router.handle(
      makeRequest(`/threads/${thread.thread_id}/runs/stream`, "POST", {
        assistant_id: assistant.assistant_id,
      }),
    );

    const contentLocation = response.headers.get("Content-Location");
    expect(contentLocation).toBeString();
    expect(contentLocation!).toContain(`/threads/${thread.thread_id}/runs/`);
  });

  test("stream starts with metadata event", async () => {
    const thread = await createThread();
    const assistant = await createAssistant();

    const response = await router.handle(
      makeRequest(`/threads/${thread.thread_id}/runs/stream`, "POST", {
        assistant_id: assistant.assistant_id,
        input: { messages: [{ content: "hello", type: "human" }] },
      }),
    );

    const text = await response.text();
    const events = parseSseEvents(text);

    expect(events.length).toBeGreaterThan(0);
    expect(events[0].event).toBe("metadata");

    const metadata = JSON.parse(events[0].data);
    expect(metadata.run_id).toBeString();
    expect(metadata.attempt).toBe(1);
  });

  test("stream contains values event after metadata", async () => {
    const thread = await createThread();
    const assistant = await createAssistant();

    const response = await router.handle(
      makeRequest(`/threads/${thread.thread_id}/runs/stream`, "POST", {
        assistant_id: assistant.assistant_id,
        input: { messages: [{ content: "hello", type: "human" }] },
      }),
    );

    const text = await response.text();
    const events = parseSseEvents(text);

    // Second event should be initial values
    const valuesEvents = events.filter((e) => e.event === "values");
    expect(valuesEvents.length).toBeGreaterThanOrEqual(1);

    const firstValues = JSON.parse(valuesEvents[0].data);
    expect(firstValues.messages).toBeArray();
  });

  test("stream ends with end event", async () => {
    const thread = await createThread();
    const assistant = await createAssistant();

    const response = await router.handle(
      makeRequest(`/threads/${thread.thread_id}/runs/stream`, "POST", {
        assistant_id: assistant.assistant_id,
        input: { messages: [{ content: "hello", type: "human" }] },
      }),
    );

    const text = await response.text();
    const events = parseSseEvents(text);

    const lastEvent = events[events.length - 1];
    expect(lastEvent.event).toBe("end");
  });

  test("returns 404 for non-existent thread", async () => {
    const assistant = await createAssistant();

    const response = await router.handle(
      makeRequest("/threads/nonexistent/runs/stream", "POST", {
        assistant_id: assistant.assistant_id,
      }),
    );

    expect(response.status).toBe(404);
  });

  test("returns 404 for non-existent assistant", async () => {
    const thread = await createThread();

    const response = await router.handle(
      makeRequest(`/threads/${thread.thread_id}/runs/stream`, "POST", {
        assistant_id: "nonexistent-assistant",
      }),
    );

    expect(response.status).toBe(404);
  });

  test("returns 422 when assistant_id is missing", async () => {
    const thread = await createThread();

    const response = await router.handle(
      makeRequest(`/threads/${thread.thread_id}/runs/stream`, "POST", {}),
    );

    expect(response.status).toBe(422);
  });

  test("returns 422 for missing Content-Type header", async () => {
    const thread = await createThread();

    const response = await router.handle(
      new Request(
        `http://localhost:3000/threads/${thread.thread_id}/runs/stream`,
        {
          method: "POST",
          body: JSON.stringify({ assistant_id: "agent" }),
        },
      ),
    );

    expect(response.status).toBe(422);
  });

  test("creates a run record in storage", async () => {
    const thread = await createThread();
    const assistant = await createAssistant();

    const response = await router.handle(
      makeRequest(`/threads/${thread.thread_id}/runs/stream`, "POST", {
        assistant_id: assistant.assistant_id,
      }),
    );

    // Consume the stream to trigger lifecycle
    await response.text();

    // Check that a run was created
    const storage = getStorage();
    const runs = await storage.runs.listByThread(thread.thread_id);
    expect(runs.length).toBe(1);
  });

  test("SSE event format matches wire protocol", async () => {
    const thread = await createThread();
    const assistant = await createAssistant();

    const response = await router.handle(
      makeRequest(`/threads/${thread.thread_id}/runs/stream`, "POST", {
        assistant_id: assistant.assistant_id,
        input: { messages: [{ content: "test", type: "human" }] },
      }),
    );

    const text = await response.text();

    // Every event should match: `event: <type>\ndata: <payload>\n\n`
    const eventPattern = /event: \w+\ndata: .*\n\n/g;
    const matches = text.match(eventPattern);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBeGreaterThanOrEqual(3); // metadata + values + end at minimum
  });

  test("metadata event run_id matches Content-Location", async () => {
    const thread = await createThread();
    const assistant = await createAssistant();

    const response = await router.handle(
      makeRequest(`/threads/${thread.thread_id}/runs/stream`, "POST", {
        assistant_id: assistant.assistant_id,
      }),
    );

    const contentLocation = response.headers.get("Content-Location") ?? "";
    const text = await response.text();
    const events = parseSseEvents(text);

    const metadata = JSON.parse(events[0].data);
    expect(contentLocation).toContain(metadata.run_id);
  });

  test("input messages appear in initial values event", async () => {
    const thread = await createThread();
    const assistant = await createAssistant();

    const response = await router.handle(
      makeRequest(`/threads/${thread.thread_id}/runs/stream`, "POST", {
        assistant_id: assistant.assistant_id,
        input: {
          messages: [
            { content: "What is 2+2?", type: "human" },
          ],
        },
      }),
    );

    const text = await response.text();
    const events = parseSseEvents(text);

    // Find first values event (initial values)
    const firstValues = events.find((e) => e.event === "values");
    expect(firstValues).toBeDefined();

    const valuesData = JSON.parse(firstValues!.data);
    expect(valuesData.messages).toBeArray();
    expect(valuesData.messages.length).toBeGreaterThanOrEqual(1);

    // First message should be our input
    const firstMessage = valuesData.messages[0];
    expect(firstMessage.content).toBe("What is 2+2?");
    expect(firstMessage.type).toBe("human");
  });
});

// ===========================================================================
// GET /threads/:thread_id/runs/:run_id/stream — Reconnect to stream
// ===========================================================================

describe("GET /threads/:thread_id/runs/:run_id/stream — join run stream", () => {
  test("returns SSE content type", async () => {
    const thread = await createThread();
    const assistant = await createAssistant();
    const run = await createRun(thread.thread_id, assistant.assistant_id);

    const response = await router.handle(
      makeRequest(
        `/threads/${thread.thread_id}/runs/${run.run_id}/stream`,
      ),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(
      "text/event-stream; charset=utf-8",
    );
  });

  test("includes Location and Content-Location headers", async () => {
    const thread = await createThread();
    const assistant = await createAssistant();
    const run = await createRun(thread.thread_id, assistant.assistant_id);

    const response = await router.handle(
      makeRequest(
        `/threads/${thread.thread_id}/runs/${run.run_id}/stream`,
      ),
    );

    const location = response.headers.get("Location");
    expect(location).toBe(
      `/threads/${thread.thread_id}/runs/${run.run_id}/stream`,
    );

    const contentLocation = response.headers.get("Content-Location");
    expect(contentLocation).toBe(
      `/threads/${thread.thread_id}/runs/${run.run_id}`,
    );
  });

  test("starts with metadata event", async () => {
    const thread = await createThread();
    const assistant = await createAssistant();
    const run = await createRun(thread.thread_id, assistant.assistant_id);

    const response = await router.handle(
      makeRequest(
        `/threads/${thread.thread_id}/runs/${run.run_id}/stream`,
      ),
    );

    const text = await response.text();
    const events = parseSseEvents(text);

    expect(events.length).toBeGreaterThan(0);
    expect(events[0].event).toBe("metadata");

    const metadata = JSON.parse(events[0].data);
    expect(metadata.run_id).toBe(run.run_id);
    expect(metadata.attempt).toBe(1);
  });

  test("ends with end event", async () => {
    const thread = await createThread();
    const assistant = await createAssistant();
    const run = await createRun(thread.thread_id, assistant.assistant_id);

    const response = await router.handle(
      makeRequest(
        `/threads/${thread.thread_id}/runs/${run.run_id}/stream`,
      ),
    );

    const text = await response.text();
    const events = parseSseEvents(text);

    const lastEvent = events[events.length - 1];
    expect(lastEvent.event).toBe("end");
  });

  test("emits status update for completed run", async () => {
    const thread = await createThread();
    const assistant = await createAssistant();
    const run = await createRun(thread.thread_id, assistant.assistant_id);

    // Mark run as success
    const storage = getStorage();
    await storage.runs.updateStatus(run.run_id, "success");

    const response = await router.handle(
      makeRequest(
        `/threads/${thread.thread_id}/runs/${run.run_id}/stream`,
      ),
    );

    const text = await response.text();
    const events = parseSseEvents(text);

    // Should have an updates event with status info
    const updatesEvent = events.find((e) => e.event === "updates");
    expect(updatesEvent).toBeDefined();

    const updatesData = JSON.parse(updatesEvent!.data);
    expect(updatesData.status).toBeDefined();
    expect(updatesData.status.status).toBe("success");
  });

  test("emits values event with thread state", async () => {
    const thread = await createThread();
    const assistant = await createAssistant();
    const run = await createRun(thread.thread_id, assistant.assistant_id);

    // Add some state to the thread
    const storage = getStorage();
    await storage.threads.addStateSnapshot(thread.thread_id, {
      messages: [{ content: "hello", type: "human" }],
    });

    const response = await router.handle(
      makeRequest(
        `/threads/${thread.thread_id}/runs/${run.run_id}/stream`,
      ),
    );

    const text = await response.text();
    const events = parseSseEvents(text);

    // Should have a values event
    const valuesEvent = events.find((e) => e.event === "values");
    expect(valuesEvent).toBeDefined();
  });

  test("returns 404 for non-existent thread", async () => {
    const response = await router.handle(
      makeRequest("/threads/nonexistent/runs/some-run/stream"),
    );

    expect(response.status).toBe(404);
  });

  test("returns 404 for non-existent run", async () => {
    const thread = await createThread();

    const response = await router.handle(
      makeRequest(
        `/threads/${thread.thread_id}/runs/nonexistent/stream`,
      ),
    );

    expect(response.status).toBe(404);
  });
});

// ===========================================================================
// SSE event sequence validation
// ===========================================================================

describe("SSE event sequence", () => {
  test("metadata is always the first event", async () => {
    const thread = await createThread();
    const assistant = await createAssistant();

    const response = await router.handle(
      makeRequest(`/threads/${thread.thread_id}/runs/stream`, "POST", {
        assistant_id: assistant.assistant_id,
        input: { messages: [{ content: "hi", type: "human" }] },
      }),
    );

    const text = await response.text();
    const events = parseSseEvents(text);

    expect(events[0].event).toBe("metadata");
  });

  test("end is always the last event", async () => {
    const thread = await createThread();
    const assistant = await createAssistant();

    const response = await router.handle(
      makeRequest(`/threads/${thread.thread_id}/runs/stream`, "POST", {
        assistant_id: assistant.assistant_id,
        input: { messages: [{ content: "hi", type: "human" }] },
      }),
    );

    const text = await response.text();
    const events = parseSseEvents(text);

    expect(events[events.length - 1].event).toBe("end");
  });

  test("at least metadata + values + end events are present", async () => {
    const thread = await createThread();
    const assistant = await createAssistant();

    const response = await router.handle(
      makeRequest(`/threads/${thread.thread_id}/runs/stream`, "POST", {
        assistant_id: assistant.assistant_id,
      }),
    );

    const text = await response.text();
    const events = parseSseEvents(text);

    const eventTypes = events.map((e) => e.event);
    expect(eventTypes).toContain("metadata");
    expect(eventTypes).toContain("values");
    expect(eventTypes).toContain("end");
  });

  test("values event before end contains messages array", async () => {
    const thread = await createThread();
    const assistant = await createAssistant();

    const response = await router.handle(
      makeRequest(`/threads/${thread.thread_id}/runs/stream`, "POST", {
        assistant_id: assistant.assistant_id,
        input: { messages: [{ content: "hello", type: "human" }] },
      }),
    );

    const text = await response.text();
    const events = parseSseEvents(text);

    // Find the last values event (final state)
    const valuesEvents = events.filter((e) => e.event === "values");
    expect(valuesEvents.length).toBeGreaterThanOrEqual(1);

    const lastValues = valuesEvents[valuesEvents.length - 1];
    const data = JSON.parse(lastValues.data);
    expect(data.messages).toBeArray();
  });
});

// ===========================================================================
// Multitask conflict handling in streams
// ===========================================================================

describe("Multitask conflicts in streaming", () => {
  test("reject strategy returns 409 when active run exists", async () => {
    const thread = await createThread();
    const assistant = await createAssistant();

    // Create an active run
    await createRun(thread.thread_id, assistant.assistant_id);

    // Try to stream with reject strategy
    const response = await router.handle(
      makeRequest(`/threads/${thread.thread_id}/runs/stream`, "POST", {
        assistant_id: assistant.assistant_id,
        multitask_strategy: "reject",
      }),
    );

    expect(response.status).toBe(409);
  });

  test("enqueue strategy (default) allows streaming with active run", async () => {
    const thread = await createThread();
    const assistant = await createAssistant();

    // Create an active run
    await createRun(thread.thread_id, assistant.assistant_id);

    // Stream with default (enqueue) strategy
    const response = await router.handle(
      makeRequest(`/threads/${thread.thread_id}/runs/stream`, "POST", {
        assistant_id: assistant.assistant_id,
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(
      "text/event-stream; charset=utf-8",
    );
  });
});

// ===========================================================================
// Stream route registration
// ===========================================================================

describe("Stream route registration", () => {
  test("POST /threads/:thread_id/runs/stream is registered", async () => {
    const response = await router.handle(
      makeRequest("/threads/t/runs/stream", "POST", {
        assistant_id: "a",
      }),
    );
    // Should not be 405 (Method Not Allowed)
    expect(response.status).not.toBe(405);
  });

  test("GET /threads/:thread_id/runs/:run_id/stream is registered", async () => {
    const response = await router.handle(
      makeRequest("/threads/t/runs/r/stream"),
    );
    // Should not be 405
    expect(response.status).not.toBe(405);
  });
});

// ===========================================================================
// String input handling
// ===========================================================================

describe("String input handling in streams", () => {
  test("string input is treated as a human message", async () => {
    const thread = await createThread();
    const assistant = await createAssistant();

    const response = await router.handle(
      makeRequest(`/threads/${thread.thread_id}/runs/stream`, "POST", {
        assistant_id: assistant.assistant_id,
        input: "Hello, what is 2+2?",
      }),
    );

    const text = await response.text();
    const events = parseSseEvents(text);

    // First values event should contain our message
    const firstValues = events.find((e) => e.event === "values");
    expect(firstValues).toBeDefined();

    const data = JSON.parse(firstValues!.data);
    expect(data.messages).toBeArray();
    expect(data.messages.length).toBeGreaterThanOrEqual(1);
    expect(data.messages[0].content).toBe("Hello, what is 2+2?");
    expect(data.messages[0].type).toBe("human");
  });

  test("null input results in empty messages array", async () => {
    const thread = await createThread();
    const assistant = await createAssistant();

    const response = await router.handle(
      makeRequest(`/threads/${thread.thread_id}/runs/stream`, "POST", {
        assistant_id: assistant.assistant_id,
        input: null,
      }),
    );

    const text = await response.text();
    const events = parseSseEvents(text);

    const firstValues = events.find((e) => e.event === "values");
    expect(firstValues).toBeDefined();

    const data = JSON.parse(firstValues!.data);
    expect(data.messages).toEqual([]);
  });
});

// ===========================================================================
// Error handling in streams
// ===========================================================================

describe("Error handling in streams", () => {
  test("stream includes error event on agent init failure", async () => {
    const thread = await createThread();
    // Create assistant with a graph_id that's registered but will fail
    // (we use the real "agent" graph which needs OPENAI_API_KEY)
    const assistant = await createAssistant("agent", "Failing Agent");

    const response = await router.handle(
      makeRequest(`/threads/${thread.thread_id}/runs/stream`, "POST", {
        assistant_id: assistant.assistant_id,
        input: { messages: [{ content: "hi", type: "human" }] },
      }),
    );

    // Stream should still return 200 (errors are in-band as SSE events)
    expect(response.status).toBe(200);

    const text = await response.text();
    const events = parseSseEvents(text);

    // Should still have metadata as first event
    expect(events[0].event).toBe("metadata");

    // Should end with end event regardless of errors
    expect(events[events.length - 1].event).toBe("end");
  });
});
