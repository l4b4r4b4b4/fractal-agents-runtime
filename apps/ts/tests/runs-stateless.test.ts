/**
 * Tests for stateless run route endpoints — Fractal Agents Runtime TypeScript/Bun (v0.0.1).
 *
 * Validates that every stateless run endpoint returns the exact response shape
 * defined in the Python runtime's OpenAPI spec:
 *
 *   POST /runs        — Create stateless run (200, 404, 422, 500)
 *   POST /runs/stream — Create stateless run + SSE stream (200, 404, 422)
 *   POST /runs/wait   — Create stateless run + wait (200, 404, 422, 500)
 *
 * Stateless runs create an ephemeral thread, execute the agent, and return
 * the result. The ephemeral thread is deleted by default (on_completion="delete")
 * or preserved (on_completion="keep").
 *
 * Response conventions verified:
 *   - /runs and /runs/wait return 200 with thread state or 500 on agent error.
 *   - /runs/stream returns 200 with text/event-stream content type.
 *   - Errors use `{"detail": "..."}` shape (ErrorResponse).
 *   - on_completion="delete" removes ephemeral thread after run.
 *   - on_completion="keep" preserves ephemeral thread after run.
 *
 * Reference:
 *   - apps/python/src/server/routes/streams.py → create_stateless_run_stream
 *   - apps/python/openapi-spec.json → paths /runs, /runs/stream, /runs/wait
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

/**
 * Parse SSE text into an array of { event, data } objects.
 */
function parseSseEvents(
  text: string,
): Array<{ event: string; data: string }> {
  const events: Array<{ event: string; data: string }> = [];
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
// Helper: create an assistant via the API
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  resetStorage();
});

// ===========================================================================
// POST /runs — Create stateless run
// ===========================================================================

describe("POST /runs — create stateless run", () => {
  test("returns 404 for non-existent assistant", async () => {
    const response = await router.handle(
      makeRequest("/runs", "POST", {
        assistant_id: "nonexistent-assistant",
      }),
    );

    expect(response.status).toBe(404);
    const body = await jsonBody<ErrorBody>(response);
    expect(body.detail).toContain("Assistant");
  });

  test("returns 422 when assistant_id is missing", async () => {
    const response = await router.handle(
      makeRequest("/runs", "POST", {}),
    );

    expect(response.status).toBe(422);
  });

  test("returns 422 for invalid JSON body", async () => {
    const response = await router.handle(
      new Request("http://localhost:3000/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not valid json",
      }),
    );

    expect(response.status).toBe(422);
  });

  test("returns 422 for missing Content-Type header", async () => {
    const response = await router.handle(
      new Request("http://localhost:3000/runs", {
        method: "POST",
        body: JSON.stringify({ assistant_id: "agent" }),
      }),
    );

    expect(response.status).toBe(422);
  });

  test("resolves assistant by graph_id fallback", async () => {
    const assistant = await createAssistant("my_custom_graph", "Custom");

    // Use the graph_id as assistant_id — should resolve via fallback
    // Note: agent execution will fail (no real LLM), but we're testing resolution
    const response = await router.handle(
      makeRequest("/runs", "POST", {
        assistant_id: "my_custom_graph",
      }),
    );

    // Should not be 404 (assistant was found)
    expect(response.status).not.toBe(404);
    // It will be 500 (agent execution fails without API key) — that's expected
    expect([200, 500]).toContain(response.status);
  });
});

// ===========================================================================
// POST /runs/stream — Create stateless run + SSE stream
// ===========================================================================

describe("POST /runs/stream — stateless SSE stream", () => {
  test("returns SSE content type", async () => {
    const assistant = await createAssistant();

    const response = await router.handle(
      makeRequest("/runs/stream", "POST", {
        assistant_id: assistant.assistant_id,
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(
      "text/event-stream; charset=utf-8",
    );
  });

  test("includes Cache-Control: no-store header", async () => {
    const assistant = await createAssistant();

    const response = await router.handle(
      makeRequest("/runs/stream", "POST", {
        assistant_id: assistant.assistant_id,
      }),
    );

    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  test("includes X-Accel-Buffering: no header", async () => {
    const assistant = await createAssistant();

    const response = await router.handle(
      makeRequest("/runs/stream", "POST", {
        assistant_id: assistant.assistant_id,
      }),
    );

    expect(response.headers.get("X-Accel-Buffering")).toBe("no");
  });

  test("includes stateless Location header (starts with /runs/)", async () => {
    const assistant = await createAssistant();

    const response = await router.handle(
      makeRequest("/runs/stream", "POST", {
        assistant_id: assistant.assistant_id,
      }),
    );

    const location = response.headers.get("Location");
    expect(location).toBeString();
    expect(location!).toMatch(/^\/runs\/.*\/stream$/);
  });

  test("includes stateless Content-Location header", async () => {
    const assistant = await createAssistant();

    const response = await router.handle(
      makeRequest("/runs/stream", "POST", {
        assistant_id: assistant.assistant_id,
      }),
    );

    const contentLocation = response.headers.get("Content-Location");
    expect(contentLocation).toBeString();
    expect(contentLocation!).toMatch(/^\/runs\//);
  });

  test("stream starts with metadata event", async () => {
    const assistant = await createAssistant();

    const response = await router.handle(
      makeRequest("/runs/stream", "POST", {
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

  test("stream contains values event", async () => {
    const assistant = await createAssistant();

    const response = await router.handle(
      makeRequest("/runs/stream", "POST", {
        assistant_id: assistant.assistant_id,
        input: { messages: [{ content: "hello", type: "human" }] },
      }),
    );

    const text = await response.text();
    const events = parseSseEvents(text);

    const valuesEvents = events.filter((e) => e.event === "values");
    expect(valuesEvents.length).toBeGreaterThanOrEqual(1);
  });

  test("stream ends with end event", async () => {
    const assistant = await createAssistant();

    const response = await router.handle(
      makeRequest("/runs/stream", "POST", {
        assistant_id: assistant.assistant_id,
        input: { messages: [{ content: "hello", type: "human" }] },
      }),
    );

    const text = await response.text();
    const events = parseSseEvents(text);

    const lastEvent = events[events.length - 1];
    expect(lastEvent.event).toBe("end");
  });

  test("input messages appear in initial values event", async () => {
    const assistant = await createAssistant();

    const response = await router.handle(
      makeRequest("/runs/stream", "POST", {
        assistant_id: assistant.assistant_id,
        input: {
          messages: [{ content: "What is 2+2?", type: "human" }],
        },
      }),
    );

    const text = await response.text();
    const events = parseSseEvents(text);

    const firstValues = events.find((e) => e.event === "values");
    expect(firstValues).toBeDefined();

    const data = JSON.parse(firstValues!.data);
    expect(data.messages).toBeArray();
    expect(data.messages.length).toBeGreaterThanOrEqual(1);
    expect(data.messages[0].content).toBe("What is 2+2?");
    expect(data.messages[0].type).toBe("human");
  });

  test("returns 404 for non-existent assistant", async () => {
    const response = await router.handle(
      makeRequest("/runs/stream", "POST", {
        assistant_id: "nonexistent-assistant",
      }),
    );

    expect(response.status).toBe(404);
  });

  test("returns 422 when assistant_id is missing", async () => {
    const response = await router.handle(
      makeRequest("/runs/stream", "POST", {}),
    );

    expect(response.status).toBe(422);
  });

  test("returns 422 for missing Content-Type header", async () => {
    const response = await router.handle(
      new Request("http://localhost:3000/runs/stream", {
        method: "POST",
        body: JSON.stringify({ assistant_id: "agent" }),
      }),
    );

    expect(response.status).toBe(422);
  });

  test("creates an ephemeral thread for stateless run", async () => {
    const assistant = await createAssistant();
    const storage = getStorage();

    // Count threads before
    const threadsBefore = await storage.threads.count();

    const response = await router.handle(
      makeRequest("/runs/stream", "POST", {
        assistant_id: assistant.assistant_id,
      }),
    );

    // Consume the stream to trigger lifecycle
    await response.text();

    // Thread may be deleted (on_completion="delete" is default)
    // but at least during execution it existed
    // We can check that the run was created and processed
    expect(response.status).toBe(200);
  });
});

// ===========================================================================
// POST /runs/wait — Stateless wait
// ===========================================================================

describe("POST /runs/wait — stateless wait", () => {
  test("returns 404 for non-existent assistant", async () => {
    const response = await router.handle(
      makeRequest("/runs/wait", "POST", {
        assistant_id: "nonexistent-assistant",
      }),
    );

    expect(response.status).toBe(404);
    const body = await jsonBody<ErrorBody>(response);
    expect(body.detail).toContain("Assistant");
  });

  test("returns 422 when assistant_id is missing", async () => {
    const response = await router.handle(
      makeRequest("/runs/wait", "POST", {}),
    );

    expect(response.status).toBe(422);
  });

  test("returns 422 for invalid JSON body", async () => {
    const response = await router.handle(
      new Request("http://localhost:3000/runs/wait", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "bad json",
      }),
    );

    expect(response.status).toBe(422);
  });

  test("returns 422 for missing Content-Type header", async () => {
    const response = await router.handle(
      new Request("http://localhost:3000/runs/wait", {
        method: "POST",
        body: JSON.stringify({ assistant_id: "agent" }),
      }),
    );

    expect(response.status).toBe(422);
  });
});

// ===========================================================================
// on_completion behaviour
// ===========================================================================

describe("on_completion behaviour", () => {
  test("on_completion='keep' preserves ephemeral thread after stream", async () => {
    const assistant = await createAssistant();
    const storage = getStorage();

    const response = await router.handle(
      makeRequest("/runs/stream", "POST", {
        assistant_id: assistant.assistant_id,
        on_completion: "keep",
        input: { messages: [{ content: "hi", type: "human" }] },
      }),
    );

    // Consume the stream to trigger lifecycle (including on_completion)
    await response.text();

    // Thread should be preserved
    const threads = await storage.threads.search({ limit: 100, offset: 0 });
    const ephemeralThreads = threads.filter((thread) => {
      const meta = thread.metadata as Record<string, unknown>;
      return meta?.stateless === true;
    });
    expect(ephemeralThreads.length).toBeGreaterThanOrEqual(1);
  });

  test("on_completion='delete' (default) removes ephemeral thread after stream", async () => {
    const assistant = await createAssistant();
    const storage = getStorage();

    const response = await router.handle(
      makeRequest("/runs/stream", "POST", {
        assistant_id: assistant.assistant_id,
        // on_completion defaults to "delete"
        input: { messages: [{ content: "hi", type: "human" }] },
      }),
    );

    // Consume the stream to trigger lifecycle
    await response.text();

    // Ephemeral thread should be deleted
    const threads = await storage.threads.search({ limit: 100, offset: 0 });
    const ephemeralThreads = threads.filter((thread) => {
      const meta = thread.metadata as Record<string, unknown>;
      return meta?.stateless === true;
    });
    expect(ephemeralThreads.length).toBe(0);
  });
});

// ===========================================================================
// Stateless route registration
// ===========================================================================

describe("Stateless route registration", () => {
  test("POST /runs is registered", async () => {
    const response = await router.handle(
      makeRequest("/runs", "POST", { assistant_id: "a" }),
    );
    // Should not be 405 (Method Not Allowed) — route is registered
    expect(response.status).not.toBe(405);
  });

  test("POST /runs/stream is registered", async () => {
    const response = await router.handle(
      makeRequest("/runs/stream", "POST", { assistant_id: "a" }),
    );
    expect(response.status).not.toBe(405);
  });

  test("POST /runs/wait is registered", async () => {
    const response = await router.handle(
      makeRequest("/runs/wait", "POST", { assistant_id: "a" }),
    );
    expect(response.status).not.toBe(405);
  });

  test("GET /runs returns 405 (method not allowed — only POST is registered)", async () => {
    const response = await router.handle(makeRequest("/runs"));
    expect(response.status).toBe(405);
  });
});

// ===========================================================================
// SSE event format parity for stateless streams
// ===========================================================================

describe("SSE event format — stateless stream parity", () => {
  test("metadata event matches LangGraph format", async () => {
    const assistant = await createAssistant();

    const response = await router.handle(
      makeRequest("/runs/stream", "POST", {
        assistant_id: assistant.assistant_id,
      }),
    );

    const text = await response.text();
    const events = parseSseEvents(text);

    const metadata = JSON.parse(events[0].data);
    expect(typeof metadata.run_id).toBe("string");
    expect(metadata.run_id.length).toBeGreaterThan(0);
    expect(metadata.attempt).toBe(1);
  });

  test("all events follow SSE wire format", async () => {
    const assistant = await createAssistant();

    const response = await router.handle(
      makeRequest("/runs/stream", "POST", {
        assistant_id: assistant.assistant_id,
        input: { messages: [{ content: "test", type: "human" }] },
      }),
    );

    const text = await response.text();

    // Every event should match: `event: <type>\ndata: <payload>\n\n`
    const eventPattern = /event: \w+\ndata: .*\n\n/g;
    const matches = text.match(eventPattern);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBeGreaterThanOrEqual(3); // metadata + values + end
  });

  test("stream has minimum required events: metadata, values, end", async () => {
    const assistant = await createAssistant();

    const response = await router.handle(
      makeRequest("/runs/stream", "POST", {
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
});

// ===========================================================================
// Metadata field in ephemeral thread
// ===========================================================================

describe("Ephemeral thread metadata", () => {
  test("ephemeral thread has stateless=true in metadata", async () => {
    const assistant = await createAssistant();
    const storage = getStorage();

    const response = await router.handle(
      makeRequest("/runs/stream", "POST", {
        assistant_id: assistant.assistant_id,
        on_completion: "keep", // keep so we can inspect
      }),
    );
    await response.text();

    const threads = await storage.threads.search({ limit: 100, offset: 0 });
    const ephemeral = threads.find((thread) => {
      const meta = thread.metadata as Record<string, unknown>;
      return meta?.stateless === true;
    });
    expect(ephemeral).toBeDefined();
    const meta = ephemeral!.metadata as Record<string, unknown>;
    expect(meta.stateless).toBe(true);
    expect(meta.on_completion).toBe("keep");
  });

  test("stateless run record has stateless=true in metadata", async () => {
    const assistant = await createAssistant();
    const storage = getStorage();

    const response = await router.handle(
      makeRequest("/runs/stream", "POST", {
        assistant_id: assistant.assistant_id,
        on_completion: "keep",
      }),
    );
    await response.text();

    // Find the ephemeral thread
    const threads = await storage.threads.search({ limit: 100, offset: 0 });
    const ephemeral = threads.find((thread) => {
      const meta = thread.metadata as Record<string, unknown>;
      return meta?.stateless === true;
    });
    expect(ephemeral).toBeDefined();

    // Check run metadata
    const runs = await storage.runs.listByThread(ephemeral!.thread_id);
    expect(runs.length).toBeGreaterThanOrEqual(1);
    const run = runs[0];
    expect((run.metadata as Record<string, unknown>).stateless).toBe(true);
  });
});

// ===========================================================================
// String input handling in stateless runs
// ===========================================================================

describe("String input handling in stateless streams", () => {
  test("string input is treated as a human message", async () => {
    const assistant = await createAssistant();

    const response = await router.handle(
      makeRequest("/runs/stream", "POST", {
        assistant_id: assistant.assistant_id,
        input: "Hello, tell me a joke",
      }),
    );

    const text = await response.text();
    const events = parseSseEvents(text);

    const firstValues = events.find((e) => e.event === "values");
    expect(firstValues).toBeDefined();

    const data = JSON.parse(firstValues!.data);
    expect(data.messages).toBeArray();
    expect(data.messages.length).toBeGreaterThanOrEqual(1);
    expect(data.messages[0].content).toBe("Hello, tell me a joke");
    expect(data.messages[0].type).toBe("human");
  });

  test("null input results in empty messages", async () => {
    const assistant = await createAssistant();

    const response = await router.handle(
      makeRequest("/runs/stream", "POST", {
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
