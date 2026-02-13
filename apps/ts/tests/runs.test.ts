/**
 * Tests for stateful run route endpoints — Fractal Agents Runtime TypeScript/Bun (v0.0.1).
 *
 * Validates that every stateful run endpoint returns the exact response shape
 * defined in the Python runtime's OpenAPI spec:
 *
 *   POST   /threads/:thread_id/runs                — Create run (200, 404, 409, 422)
 *   GET    /threads/:thread_id/runs                — List runs (200, 404)
 *   GET    /threads/:thread_id/runs/:run_id        — Get run (200, 404)
 *   DELETE /threads/:thread_id/runs/:run_id        — Delete run (200, 404)
 *   POST   /threads/:thread_id/runs/:run_id/cancel — Cancel run (200, 404, 409)
 *   GET    /threads/:thread_id/runs/:run_id/join   — Join run (200, 404)
 *   POST   /threads/:thread_id/runs/wait           — Wait for run (200, 404, 422)
 *
 * Response conventions verified:
 *   - Create returns 200 with the Run object and Content-Location header.
 *   - Delete returns 200 with `{}` (empty object).
 *   - Cancel returns 200 with `{}` (empty object).
 *   - List returns 200 with a JSON array.
 *   - Errors use `{"detail": "..."}` shape (ErrorResponse).
 *
 * Reference: apps/python/openapi-spec.json, apps/python/src/server/routes/runs.py
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

interface RunResponse {
  run_id: string;
  thread_id: string;
  assistant_id: string;
  created_at: string;
  updated_at: string;
  status: string;
  metadata: Record<string, unknown>;
  kwargs?: Record<string, unknown>;
  multitask_strategy?: string;
}

interface ErrorBody {
  detail: string;
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
): Promise<{ assistant_id: string }> {
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
// POST /threads/:thread_id/runs — Create run
// ===========================================================================

describe("POST /threads/:thread_id/runs — create run", () => {
  test("creates a run with status 'pending'", async () => {
    const thread = await createThread();
    const assistant = await createAssistant();
    const response = await router.handle(
      makeRequest(`/threads/${thread.thread_id}/runs`, "POST", {
        assistant_id: assistant.assistant_id,
      }),
    );

    expect(response.status).toBe(200);
    const run = await jsonBody<RunResponse>(response);
    expect(run.run_id).toBeString();
    expect(run.thread_id).toBe(thread.thread_id);
    expect(run.assistant_id).toBe(assistant.assistant_id);
    expect(run.status).toBe("pending");
    expect(run.metadata).toEqual({});
    expect(run.created_at).toBeString();
    expect(run.updated_at).toBeString();
  });

  test("returns Content-Location header", async () => {
    const thread = await createThread();
    const assistant = await createAssistant();
    const response = await router.handle(
      makeRequest(`/threads/${thread.thread_id}/runs`, "POST", {
        assistant_id: assistant.assistant_id,
      }),
    );

    expect(response.status).toBe(200);
    const run = await jsonBody<RunResponse>(response);
    const location = response.headers.get("Content-Location");
    expect(location).toBe(`/threads/${thread.thread_id}/runs/${run.run_id}`);
  });

  test("stores custom metadata", async () => {
    const thread = await createThread();
    const assistant = await createAssistant();
    const response = await router.handle(
      makeRequest(`/threads/${thread.thread_id}/runs`, "POST", {
        assistant_id: assistant.assistant_id,
        metadata: { key: "value" },
      }),
    );

    const run = await jsonBody<RunResponse>(response);
    expect(run.metadata).toEqual({ key: "value" });
  });

  test("stores kwargs from input, config, stream_mode", async () => {
    const thread = await createThread();
    const assistant = await createAssistant();
    const response = await router.handle(
      makeRequest(`/threads/${thread.thread_id}/runs`, "POST", {
        assistant_id: assistant.assistant_id,
        input: { messages: [{ content: "hi", type: "human" }] },
        config: { configurable: { temperature: 0.5 } },
        stream_mode: ["values", "messages"],
      }),
    );

    const run = await jsonBody<RunResponse>(response);
    expect(run.kwargs).toBeDefined();
    const kwargs = run.kwargs as Record<string, unknown>;
    expect(kwargs.input).toEqual({ messages: [{ content: "hi", type: "human" }] });
    expect(kwargs.stream_mode).toEqual(["values", "messages"]);
  });

  test("stores multitask_strategy", async () => {
    const thread = await createThread();
    const assistant = await createAssistant();
    const response = await router.handle(
      makeRequest(`/threads/${thread.thread_id}/runs`, "POST", {
        assistant_id: assistant.assistant_id,
        multitask_strategy: "interrupt",
      }),
    );

    const run = await jsonBody<RunResponse>(response);
    expect(run.multitask_strategy).toBe("interrupt");
  });

  test("returns 404 for non-existent thread", async () => {
    const assistant = await createAssistant();
    const response = await router.handle(
      makeRequest("/threads/nonexistent-id/runs", "POST", {
        assistant_id: assistant.assistant_id,
      }),
    );

    expect(response.status).toBe(404);
    const body = await jsonBody<ErrorBody>(response);
    expect(body.detail).toContain("Thread");
  });

  test("returns 404 for non-existent assistant", async () => {
    const thread = await createThread();
    const response = await router.handle(
      makeRequest(`/threads/${thread.thread_id}/runs`, "POST", {
        assistant_id: "nonexistent-assistant",
      }),
    );

    expect(response.status).toBe(404);
    const body = await jsonBody<ErrorBody>(response);
    expect(body.detail).toContain("Assistant");
  });

  test("returns 422 when assistant_id is missing", async () => {
    const thread = await createThread();
    const response = await router.handle(
      makeRequest(`/threads/${thread.thread_id}/runs`, "POST", {}),
    );

    expect(response.status).toBe(422);
  });

  test("returns 422 for invalid JSON body", async () => {
    const thread = await createThread();
    const response = await router.handle(
      new Request(`http://localhost:3000/threads/${thread.thread_id}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      }),
    );

    expect(response.status).toBe(422);
  });

  test("resolves assistant by graph_id fallback", async () => {
    const thread = await createThread();
    const assistant = await createAssistant("my_graph", "Graph Assistant");

    const response = await router.handle(
      makeRequest(`/threads/${thread.thread_id}/runs`, "POST", {
        assistant_id: "my_graph",
      }),
    );

    expect(response.status).toBe(200);
    const run = await jsonBody<RunResponse>(response);
    expect(run.assistant_id).toBe(assistant.assistant_id);
  });

  test("updates thread status to busy", async () => {
    const thread = await createThread();
    const assistant = await createAssistant();

    await router.handle(
      makeRequest(`/threads/${thread.thread_id}/runs`, "POST", {
        assistant_id: assistant.assistant_id,
      }),
    );

    const storage = getStorage();
    const updatedThread = await storage.threads.get(thread.thread_id);
    expect(updatedThread).not.toBeNull();
    expect(updatedThread!.status).toBe("busy");
  });
});

// ===========================================================================
// Multitask conflict handling
// ===========================================================================

describe("Multitask conflict handling", () => {
  test("reject strategy returns 409 when active run exists", async () => {
    const thread = await createThread();
    const assistant = await createAssistant();

    // Create first run (pending)
    await createRun(thread.thread_id, assistant.assistant_id);

    // Try to create second run with reject strategy
    const response = await router.handle(
      makeRequest(`/threads/${thread.thread_id}/runs`, "POST", {
        assistant_id: assistant.assistant_id,
        multitask_strategy: "reject",
      }),
    );

    expect(response.status).toBe(409);
    const body = await jsonBody<ErrorBody>(response);
    expect(body.detail).toContain("active run");
  });

  test("interrupt strategy marks active run as interrupted", async () => {
    const thread = await createThread();
    const assistant = await createAssistant();

    // Create first run
    const firstRun = await createRun(thread.thread_id, assistant.assistant_id);

    // Create second run with interrupt strategy
    const response = await router.handle(
      makeRequest(`/threads/${thread.thread_id}/runs`, "POST", {
        assistant_id: assistant.assistant_id,
        multitask_strategy: "interrupt",
      }),
    );

    expect(response.status).toBe(200);

    // Check first run is now interrupted
    const storage = getStorage();
    const firstRunUpdated = await storage.runs.get(firstRun.run_id);
    expect(firstRunUpdated).not.toBeNull();
    expect(firstRunUpdated!.status).toBe("interrupted");
  });

  test("rollback strategy marks active run as error", async () => {
    const thread = await createThread();
    const assistant = await createAssistant();

    const firstRun = await createRun(thread.thread_id, assistant.assistant_id);

    const response = await router.handle(
      makeRequest(`/threads/${thread.thread_id}/runs`, "POST", {
        assistant_id: assistant.assistant_id,
        multitask_strategy: "rollback",
      }),
    );

    expect(response.status).toBe(200);

    const storage = getStorage();
    const firstRunUpdated = await storage.runs.get(firstRun.run_id);
    expect(firstRunUpdated).not.toBeNull();
    expect(firstRunUpdated!.status).toBe("error");
  });

  test("enqueue strategy (default) allows concurrent runs", async () => {
    const thread = await createThread();
    const assistant = await createAssistant();

    const firstRun = await createRun(thread.thread_id, assistant.assistant_id);

    // Default strategy is enqueue — should succeed
    const response = await router.handle(
      makeRequest(`/threads/${thread.thread_id}/runs`, "POST", {
        assistant_id: assistant.assistant_id,
      }),
    );

    expect(response.status).toBe(200);
    const secondRun = await jsonBody<RunResponse>(response);
    expect(secondRun.run_id).not.toBe(firstRun.run_id);
  });
});

// ===========================================================================
// GET /threads/:thread_id/runs — List runs
// ===========================================================================

describe("GET /threads/:thread_id/runs — list runs", () => {
  test("lists runs for a thread", async () => {
    const thread = await createThread();
    const assistant = await createAssistant();

    await createRun(thread.thread_id, assistant.assistant_id);
    await createRun(thread.thread_id, assistant.assistant_id);

    const response = await router.handle(
      makeRequest(`/threads/${thread.thread_id}/runs`),
    );

    expect(response.status).toBe(200);
    const runs = await jsonBody<RunResponse[]>(response);
    expect(runs).toBeArray();
    expect(runs.length).toBe(2);
  });

  test("returns empty array when no runs exist", async () => {
    const thread = await createThread();

    const response = await router.handle(
      makeRequest(`/threads/${thread.thread_id}/runs`),
    );

    expect(response.status).toBe(200);
    const runs = await jsonBody<RunResponse[]>(response);
    expect(runs).toEqual([]);
  });

  test("returns 404 for non-existent thread", async () => {
    const response = await router.handle(
      makeRequest("/threads/nonexistent/runs"),
    );

    expect(response.status).toBe(404);
  });

  test("supports limit query parameter", async () => {
    const thread = await createThread();
    const assistant = await createAssistant();

    await createRun(thread.thread_id, assistant.assistant_id);
    await createRun(thread.thread_id, assistant.assistant_id);
    await createRun(thread.thread_id, assistant.assistant_id);

    const response = await router.handle(
      makeRequest(`/threads/${thread.thread_id}/runs?limit=2`),
    );

    const runs = await jsonBody<RunResponse[]>(response);
    expect(runs.length).toBe(2);
  });

  test("supports offset query parameter", async () => {
    const thread = await createThread();
    const assistant = await createAssistant();

    await createRun(thread.thread_id, assistant.assistant_id);
    await createRun(thread.thread_id, assistant.assistant_id);
    await createRun(thread.thread_id, assistant.assistant_id);

    const response = await router.handle(
      makeRequest(`/threads/${thread.thread_id}/runs?offset=1`),
    );

    const runs = await jsonBody<RunResponse[]>(response);
    // Should return 2 runs (3 total - 1 offset)
    expect(runs.length).toBe(2);
  });

  test("supports status filter", async () => {
    const thread = await createThread();
    const assistant = await createAssistant();

    const run1 = await createRun(thread.thread_id, assistant.assistant_id);

    // Manually update one run's status
    const storage = getStorage();
    await storage.runs.updateStatus(run1.run_id, "success");

    await createRun(thread.thread_id, assistant.assistant_id);

    const response = await router.handle(
      makeRequest(`/threads/${thread.thread_id}/runs?status=success`),
    );

    const runs = await jsonBody<RunResponse[]>(response);
    expect(runs.length).toBe(1);
    expect(runs[0].status).toBe("success");
  });
});

// ===========================================================================
// GET /threads/:thread_id/runs/:run_id — Get run
// ===========================================================================

describe("GET /threads/:thread_id/runs/:run_id — get run", () => {
  test("returns a specific run", async () => {
    const thread = await createThread();
    const assistant = await createAssistant();
    const run = await createRun(thread.thread_id, assistant.assistant_id);

    const response = await router.handle(
      makeRequest(`/threads/${thread.thread_id}/runs/${run.run_id}`),
    );

    expect(response.status).toBe(200);
    const result = await jsonBody<RunResponse>(response);
    expect(result.run_id).toBe(run.run_id);
    expect(result.thread_id).toBe(thread.thread_id);
    expect(result.assistant_id).toBe(assistant.assistant_id);
    expect(result.status).toBe("pending");
  });

  test("returns 404 for non-existent run", async () => {
    const thread = await createThread();

    const response = await router.handle(
      makeRequest(`/threads/${thread.thread_id}/runs/nonexistent`),
    );

    expect(response.status).toBe(404);
    const body = await jsonBody<ErrorBody>(response);
    expect(body.detail).toContain("Run");
  });

  test("returns 404 for non-existent thread", async () => {
    const response = await router.handle(
      makeRequest("/threads/nonexistent/runs/some-run"),
    );

    expect(response.status).toBe(404);
    const body = await jsonBody<ErrorBody>(response);
    expect(body.detail).toContain("Thread");
  });

  test("returns 404 when run belongs to different thread", async () => {
    const thread1 = await createThread();
    const thread2 = await createThread();
    const assistant = await createAssistant();
    const run = await createRun(thread1.thread_id, assistant.assistant_id);

    const response = await router.handle(
      makeRequest(`/threads/${thread2.thread_id}/runs/${run.run_id}`),
    );

    expect(response.status).toBe(404);
  });
});

// ===========================================================================
// DELETE /threads/:thread_id/runs/:run_id — Delete run
// ===========================================================================

describe("DELETE /threads/:thread_id/runs/:run_id — delete run", () => {
  test("deletes a run and returns empty object", async () => {
    const thread = await createThread();
    const assistant = await createAssistant();
    const run = await createRun(thread.thread_id, assistant.assistant_id);

    const response = await router.handle(
      makeRequest(`/threads/${thread.thread_id}/runs/${run.run_id}`, "DELETE"),
    );

    expect(response.status).toBe(200);
    const body = await jsonBody(response);
    expect(body).toEqual({});

    // Verify run is actually deleted
    const getResponse = await router.handle(
      makeRequest(`/threads/${thread.thread_id}/runs/${run.run_id}`),
    );
    expect(getResponse.status).toBe(404);
  });

  test("returns 404 for non-existent run", async () => {
    const thread = await createThread();

    const response = await router.handle(
      makeRequest(`/threads/${thread.thread_id}/runs/nonexistent`, "DELETE"),
    );

    expect(response.status).toBe(404);
  });

  test("returns 404 for non-existent thread", async () => {
    const response = await router.handle(
      makeRequest("/threads/nonexistent/runs/some-run", "DELETE"),
    );

    expect(response.status).toBe(404);
  });
});

// ===========================================================================
// POST /threads/:thread_id/runs/:run_id/cancel — Cancel run
// ===========================================================================

describe("POST /threads/:thread_id/runs/:run_id/cancel — cancel run", () => {
  test("cancels a pending run and returns empty object", async () => {
    const thread = await createThread();
    const assistant = await createAssistant();
    const run = await createRun(thread.thread_id, assistant.assistant_id);

    const response = await router.handle(
      makeRequest(
        `/threads/${thread.thread_id}/runs/${run.run_id}/cancel`,
        "POST",
        {},
      ),
    );

    expect(response.status).toBe(200);
    const body = await jsonBody(response);
    expect(body).toEqual({});

    // Verify run status is interrupted
    const storage = getStorage();
    const updated = await storage.runs.get(run.run_id);
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe("interrupted");
  });

  test("updates thread status to idle after cancel", async () => {
    const thread = await createThread();
    const assistant = await createAssistant();
    const run = await createRun(thread.thread_id, assistant.assistant_id);

    await router.handle(
      makeRequest(
        `/threads/${thread.thread_id}/runs/${run.run_id}/cancel`,
        "POST",
        {},
      ),
    );

    const storage = getStorage();
    const updatedThread = await storage.threads.get(thread.thread_id);
    expect(updatedThread!.status).toBe("idle");
  });

  test("returns 409 for already completed run", async () => {
    const thread = await createThread();
    const assistant = await createAssistant();
    const run = await createRun(thread.thread_id, assistant.assistant_id);

    // Manually mark as success
    const storage = getStorage();
    await storage.runs.updateStatus(run.run_id, "success");

    const response = await router.handle(
      makeRequest(
        `/threads/${thread.thread_id}/runs/${run.run_id}/cancel`,
        "POST",
        {},
      ),
    );

    expect(response.status).toBe(409);
    const body = await jsonBody<ErrorBody>(response);
    expect(body.detail).toContain("Cannot cancel");
  });

  test("returns 409 for errored run", async () => {
    const thread = await createThread();
    const assistant = await createAssistant();
    const run = await createRun(thread.thread_id, assistant.assistant_id);

    const storage = getStorage();
    await storage.runs.updateStatus(run.run_id, "error");

    const response = await router.handle(
      makeRequest(
        `/threads/${thread.thread_id}/runs/${run.run_id}/cancel`,
        "POST",
        {},
      ),
    );

    expect(response.status).toBe(409);
  });

  test("returns 404 for non-existent run", async () => {
    const thread = await createThread();

    const response = await router.handle(
      makeRequest(
        `/threads/${thread.thread_id}/runs/nonexistent/cancel`,
        "POST",
        {},
      ),
    );

    expect(response.status).toBe(404);
  });

  test("returns 404 for non-existent thread", async () => {
    const response = await router.handle(
      makeRequest("/threads/nonexistent/runs/some-run/cancel", "POST", {}),
    );

    expect(response.status).toBe(404);
  });
});

// ===========================================================================
// GET /threads/:thread_id/runs/:run_id/join — Join run
// ===========================================================================

describe("GET /threads/:thread_id/runs/:run_id/join — join run", () => {
  test("returns immediately for completed run", async () => {
    const thread = await createThread();
    const assistant = await createAssistant();
    const run = await createRun(thread.thread_id, assistant.assistant_id);

    // Mark run as success
    const storage = getStorage();
    await storage.runs.updateStatus(run.run_id, "success");

    const response = await router.handle(
      makeRequest(`/threads/${thread.thread_id}/runs/${run.run_id}/join`),
    );

    expect(response.status).toBe(200);
    const body = await jsonBody<Record<string, unknown>>(response);
    // Should return thread state
    expect(body).toBeDefined();
    expect(body.values).toBeDefined();
    expect(body.next).toBeDefined();
  });

  test("returns thread state for errored run", async () => {
    const thread = await createThread();
    const assistant = await createAssistant();
    const run = await createRun(thread.thread_id, assistant.assistant_id);

    const storage = getStorage();
    await storage.runs.updateStatus(run.run_id, "error");

    const response = await router.handle(
      makeRequest(`/threads/${thread.thread_id}/runs/${run.run_id}/join`),
    );

    expect(response.status).toBe(200);
    const body = await jsonBody<Record<string, unknown>>(response);
    expect(body.values).toBeDefined();
  });

  test("returns 404 for non-existent run", async () => {
    const thread = await createThread();

    const response = await router.handle(
      makeRequest(`/threads/${thread.thread_id}/runs/nonexistent/join`),
    );

    expect(response.status).toBe(404);
  });

  test("returns 404 for non-existent thread", async () => {
    const response = await router.handle(
      makeRequest("/threads/nonexistent/runs/some-run/join"),
    );

    expect(response.status).toBe(404);
  });
});

// ===========================================================================
// POST /threads/:thread_id/runs/wait — Wait for run
// ===========================================================================

describe("POST /threads/:thread_id/runs/wait — wait for run", () => {
  test("returns 404 for non-existent thread", async () => {
    const assistant = await createAssistant();
    const response = await router.handle(
      makeRequest("/threads/nonexistent/runs/wait", "POST", {
        assistant_id: assistant.assistant_id,
      }),
    );

    expect(response.status).toBe(404);
  });

  test("returns 404 for non-existent assistant", async () => {
    const thread = await createThread();
    const response = await router.handle(
      makeRequest(`/threads/${thread.thread_id}/runs/wait`, "POST", {
        assistant_id: "nonexistent",
      }),
    );

    expect(response.status).toBe(404);
  });

  test("returns 422 when assistant_id is missing", async () => {
    const thread = await createThread();
    const response = await router.handle(
      makeRequest(`/threads/${thread.thread_id}/runs/wait`, "POST", {}),
    );

    expect(response.status).toBe(422);
  });

  test("returns 422 for invalid JSON body", async () => {
    const thread = await createThread();
    const response = await router.handle(
      new Request(
        `http://localhost:3000/threads/${thread.thread_id}/runs/wait`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "not json",
        },
      ),
    );

    expect(response.status).toBe(422);
  });

  test("returns 409 for active run with reject strategy", async () => {
    const thread = await createThread();
    const assistant = await createAssistant();

    // Create an active run
    await createRun(thread.thread_id, assistant.assistant_id);

    // Wait with reject strategy (default for wait)
    const response = await router.handle(
      makeRequest(`/threads/${thread.thread_id}/runs/wait`, "POST", {
        assistant_id: assistant.assistant_id,
        multitask_strategy: "reject",
      }),
    );

    expect(response.status).toBe(409);
  });
});

// ===========================================================================
// Run response shape validation
// ===========================================================================

describe("Run response shape", () => {
  test("has all required fields per OpenAPI spec", async () => {
    const thread = await createThread();
    const assistant = await createAssistant();
    const response = await router.handle(
      makeRequest(`/threads/${thread.thread_id}/runs`, "POST", {
        assistant_id: assistant.assistant_id,
      }),
    );

    const run = await jsonBody<RunResponse>(response);

    // Required fields per spec
    expect(run.run_id).toBeString();
    expect(run.run_id.length).toBeGreaterThan(0);
    expect(run.thread_id).toBeString();
    expect(run.assistant_id).toBeString();
    expect(run.created_at).toBeString();
    expect(run.updated_at).toBeString();
    expect(run.status).toBeString();
    expect(typeof run.metadata).toBe("object");
  });

  test("run_id is a UUID-like string", async () => {
    const thread = await createThread();
    const assistant = await createAssistant();
    const run = await createRun(thread.thread_id, assistant.assistant_id);

    // UUID v4 pattern
    const uuidPattern =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    expect(run.run_id).toMatch(uuidPattern);
  });

  test("created_at and updated_at are ISO 8601 strings", async () => {
    const thread = await createThread();
    const assistant = await createAssistant();
    const run = await createRun(thread.thread_id, assistant.assistant_id);

    // Should not throw
    const created = new Date(run.created_at);
    const updated = new Date(run.updated_at);
    expect(created.toISOString()).toBe(run.created_at);
    expect(updated.toISOString()).toBe(run.updated_at);
  });

  test("status is a valid RunStatus value", async () => {
    const thread = await createThread();
    const assistant = await createAssistant();
    const run = await createRun(thread.thread_id, assistant.assistant_id);

    const validStatuses = [
      "pending",
      "running",
      "success",
      "error",
      "timeout",
      "interrupted",
    ];
    expect(validStatuses).toContain(run.status);
  });
});

// ===========================================================================
// Route registration
// ===========================================================================

describe("Run route registration", () => {
  test("POST /threads/:thread_id/runs is registered", async () => {
    const response = await router.handle(
      makeRequest("/threads/t/runs", "POST", { assistant_id: "a" }),
    );
    // Should not be 405 (Method Not Allowed) — route is registered
    expect(response.status).not.toBe(405);
  });

  test("GET /threads/:thread_id/runs is registered", async () => {
    const response = await router.handle(
      makeRequest("/threads/t/runs"),
    );
    expect(response.status).not.toBe(405);
  });

  test("GET /threads/:thread_id/runs/:run_id is registered", async () => {
    const response = await router.handle(
      makeRequest("/threads/t/runs/r"),
    );
    expect(response.status).not.toBe(405);
  });

  test("DELETE /threads/:thread_id/runs/:run_id is registered", async () => {
    const response = await router.handle(
      makeRequest("/threads/t/runs/r", "DELETE"),
    );
    expect(response.status).not.toBe(405);
  });

  test("POST /threads/:thread_id/runs/:run_id/cancel is registered", async () => {
    const response = await router.handle(
      makeRequest("/threads/t/runs/r/cancel", "POST", {}),
    );
    expect(response.status).not.toBe(405);
  });

  test("GET /threads/:thread_id/runs/:run_id/join is registered", async () => {
    const response = await router.handle(
      makeRequest("/threads/t/runs/r/join"),
    );
    expect(response.status).not.toBe(405);
  });

  test("POST /threads/:thread_id/runs/wait is registered", async () => {
    const response = await router.handle(
      makeRequest("/threads/t/runs/wait", "POST", { assistant_id: "a" }),
    );
    expect(response.status).not.toBe(405);
  });
});

// ===========================================================================
// Multiple runs lifecycle
// ===========================================================================

describe("Multiple runs lifecycle", () => {
  test("creating multiple runs on same thread", async () => {
    const thread = await createThread();
    const assistant = await createAssistant();

    const run1 = await createRun(thread.thread_id, assistant.assistant_id);
    const run2 = await createRun(thread.thread_id, assistant.assistant_id);
    const run3 = await createRun(thread.thread_id, assistant.assistant_id);

    expect(run1.run_id).not.toBe(run2.run_id);
    expect(run2.run_id).not.toBe(run3.run_id);

    // All should be listable
    const response = await router.handle(
      makeRequest(`/threads/${thread.thread_id}/runs`),
    );
    const runs = await jsonBody<RunResponse[]>(response);
    expect(runs.length).toBe(3);
  });

  test("deleting one run does not affect others", async () => {
    const thread = await createThread();
    const assistant = await createAssistant();

    const run1 = await createRun(thread.thread_id, assistant.assistant_id);
    const run2 = await createRun(thread.thread_id, assistant.assistant_id);

    // Delete run1
    await router.handle(
      makeRequest(`/threads/${thread.thread_id}/runs/${run1.run_id}`, "DELETE"),
    );

    // run2 still exists
    const response = await router.handle(
      makeRequest(`/threads/${thread.thread_id}/runs/${run2.run_id}`),
    );
    expect(response.status).toBe(200);

    // List should show only run2
    const listResponse = await router.handle(
      makeRequest(`/threads/${thread.thread_id}/runs`),
    );
    const runs = await jsonBody<RunResponse[]>(listResponse);
    expect(runs.length).toBe(1);
    expect(runs[0].run_id).toBe(run2.run_id);
  });
});
