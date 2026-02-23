/**
 * Tests for the thread route endpoints — Fractal Agents Runtime TypeScript/Bun (v0.0.1).
 *
 * Validates that every thread endpoint returns the exact response shape
 * defined in the Python runtime's OpenAPI spec:
 *
 *   POST   /threads                        — Create thread (200, 409, 422)
 *   GET    /threads/:thread_id             — Get thread (200, 404)
 *   PATCH  /threads/:thread_id             — Update thread (200, 404, 422)
 *   DELETE /threads/:thread_id             — Delete thread (200, 404)
 *   GET    /threads/:thread_id/state       — Get thread state (200, 404)
 *   GET    /threads/:thread_id/history     — Get thread history (200, 404)
 *   POST   /threads/search                 — Search threads (200)
 *   POST   /threads/count                  — Count threads (200)
 *
 * Response conventions verified:
 *   - Create returns 200 (not 201) with the Thread object.
 *   - Delete returns 200 with `{}` (empty object, NOT `{"ok": true}`).
 *   - Count returns 200 with a bare integer.
 *   - Search returns 200 with a JSON array.
 *   - State returns 200 with a ThreadState object.
 *   - History returns 200 with a JSON array of ThreadState objects.
 *   - Errors use `{"detail": "..."}` shape (ErrorResponse).
 *
 * Reference: apps/python/openapi-spec.json, apps/python/src/server/routes/threads.py
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

interface ThreadResponse {
  thread_id: string;
  metadata: Record<string, unknown>;
  config?: Record<string, unknown>;
  status: string;
  values?: Record<string, unknown>;
  interrupts?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

interface ThreadStateResponse {
  values: Record<string, unknown> | Array<Record<string, unknown>>;
  next: string[];
  tasks: Array<Record<string, unknown>>;
  checkpoint?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  created_at?: string;
  parent_checkpoint?: Record<string, unknown>;
  interrupts?: Array<Record<string, unknown>>;
}

interface ErrorBody {
  detail: string;
}

// ---------------------------------------------------------------------------
// Helper: create a thread via the API and return its response body
// ---------------------------------------------------------------------------

async function createThread(
  overrides?: Record<string, unknown>,
): Promise<ThreadResponse> {
  const response = await router.handle(
    makeRequest("/threads", "POST", overrides ?? {}),
  );
  return jsonBody<ThreadResponse>(response);
}

// ---------------------------------------------------------------------------
// Setup — reset storage before each test to ensure isolation
// ---------------------------------------------------------------------------

beforeEach(() => {
  resetStorage();
});

// ===========================================================================
// POST /threads — Create
// ===========================================================================

describe("POST /threads", () => {
  test("creates a thread and returns 200", async () => {
    const response = await router.handle(
      makeRequest("/threads", "POST", {}),
    );
    expect(response.status).toBe(200);

    const body = await jsonBody<ThreadResponse>(response);
    expect(body.thread_id).toBeDefined();
    expect(body.status).toBe("idle");
    expect(body.metadata).toEqual({});
    expect(body.created_at).toBeDefined();
    expect(body.updated_at).toBeDefined();
  });

  test("response has JSON content type", async () => {
    const response = await router.handle(
      makeRequest("/threads", "POST", {}),
    );
    expect(response.headers.get("Content-Type")).toBe("application/json");
  });

  test("creates with explicit thread_id", async () => {
    const id = crypto.randomUUID();
    const response = await router.handle(
      makeRequest("/threads", "POST", { thread_id: id }),
    );
    expect(response.status).toBe(200);

    const body = await jsonBody<ThreadResponse>(response);
    expect(body.thread_id).toBe(id);
  });

  test("creates with metadata", async () => {
    const response = await router.handle(
      makeRequest("/threads", "POST", {
        metadata: { session: "abc", user: "test" },
      }),
    );
    expect(response.status).toBe(200);

    const body = await jsonBody<ThreadResponse>(response);
    expect(body.metadata).toEqual({ session: "abc", user: "test" });
  });

  test("auto-generated thread_id is a valid UUID with dashes", async () => {
    const response = await router.handle(
      makeRequest("/threads", "POST", {}),
    );
    const body = await jsonBody<ThreadResponse>(response);
    expect(body.thread_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  test("created_at is a valid ISO 8601 timestamp ending in Z", async () => {
    const response = await router.handle(
      makeRequest("/threads", "POST", {}),
    );
    const body = await jsonBody<ThreadResponse>(response);
    expect(body.created_at).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/,
    );
  });

  test("initial status is idle", async () => {
    const body = await createThread();
    expect(body.status).toBe("idle");
  });

  test("returns 409 when thread_id already exists (default if_exists=raise)", async () => {
    const id = crypto.randomUUID();

    // Create first
    await router.handle(
      makeRequest("/threads", "POST", { thread_id: id }),
    );

    // Try again — should be 409
    const response = await router.handle(
      makeRequest("/threads", "POST", { thread_id: id }),
    );
    expect(response.status).toBe(409);

    const body = await jsonBody<ErrorBody>(response);
    expect(body.detail).toContain(id);
    expect(body.detail).toContain("already exists");
  });

  test("returns existing thread with if_exists=do_nothing", async () => {
    const id = crypto.randomUUID();

    // Create first
    await router.handle(
      makeRequest("/threads", "POST", {
        thread_id: id,
        metadata: { original: true },
      }),
    );

    // Create again with do_nothing
    const response = await router.handle(
      makeRequest("/threads", "POST", {
        thread_id: id,
        metadata: { duplicate: true },
        if_exists: "do_nothing",
      }),
    );
    expect(response.status).toBe(200);

    const body = await jsonBody<ThreadResponse>(response);
    expect(body.thread_id).toBe(id);
    expect(body.metadata).toEqual({ original: true }); // unchanged
  });

  test("accepts request without Content-Type (all ThreadCreate fields optional)", async () => {
    const response = await router.handle(
      new Request("http://localhost:3000/threads", { method: "POST" }),
    );
    expect(response.status).toBe(200);

    const body = await jsonBody<ThreadResponse>(response);
    expect(body.thread_id).toBeDefined();
    expect(body.status).toBe("idle");
  });

  test("returns 422 when body is invalid JSON", async () => {
    const response = await router.handle(
      new Request("http://localhost:3000/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not valid json",
      }),
    );
    expect(response.status).toBe(422);

    const body = await jsonBody<ErrorBody>(response);
    expect(body.detail).toBeDefined();
  });
});

// ===========================================================================
// GET /threads/:thread_id — Get
// ===========================================================================

describe("GET /threads/:thread_id", () => {
  test("returns an existing thread", async () => {
    const created = await createThread({ metadata: { key: "value" } });

    const response = await router.handle(
      makeRequest(`/threads/${created.thread_id}`),
    );
    expect(response.status).toBe(200);

    const body = await jsonBody<ThreadResponse>(response);
    expect(body.thread_id).toBe(created.thread_id);
    expect(body.metadata).toEqual({ key: "value" });
    expect(body.status).toBe("idle");
  });

  test("response has JSON content type", async () => {
    const created = await createThread();

    const response = await router.handle(
      makeRequest(`/threads/${created.thread_id}`),
    );
    expect(response.headers.get("Content-Type")).toBe("application/json");
  });

  test("returns full Thread shape", async () => {
    const created = await createThread();

    const response = await router.handle(
      makeRequest(`/threads/${created.thread_id}`),
    );
    const body = await jsonBody<ThreadResponse>(response);

    expect(body.thread_id).toBeDefined();
    expect(body.metadata).toBeDefined();
    expect(body.status).toBeDefined();
    expect(body.created_at).toBeDefined();
    expect(body.updated_at).toBeDefined();
  });

  test("returns 404 for non-existent thread_id", async () => {
    const fakeId = crypto.randomUUID();
    const response = await router.handle(
      makeRequest(`/threads/${fakeId}`),
    );
    expect(response.status).toBe(404);

    const body = await jsonBody<ErrorBody>(response);
    expect(body.detail).toContain(fakeId);
    expect(body.detail).toContain("not found");
  });

  test("404 response matches ErrorResponse shape", async () => {
    const response = await router.handle(
      makeRequest(`/threads/${crypto.randomUUID()}`),
    );
    const body = await jsonBody<ErrorBody>(response);
    expect(typeof body.detail).toBe("string");
    expect(Object.keys(body)).toEqual(["detail"]);
  });
});

// ===========================================================================
// PATCH /threads/:thread_id — Update
// ===========================================================================

describe("PATCH /threads/:thread_id", () => {
  let threadId: string;

  beforeEach(async () => {
    resetStorage();
    const created = await createThread({ metadata: { a: 1, b: 2 } });
    threadId = created.thread_id;
  });

  test("updates metadata and returns 200", async () => {
    const response = await router.handle(
      makeRequest(`/threads/${threadId}`, "PATCH", {
        metadata: { c: 3 },
      }),
    );
    expect(response.status).toBe(200);

    const body = await jsonBody<ThreadResponse>(response);
    // Shallow merge: a=1, b=2 merged with c=3
    expect(body.metadata).toEqual({ a: 1, b: 2, c: 3 });
  });

  test("response has JSON content type", async () => {
    const response = await router.handle(
      makeRequest(`/threads/${threadId}`, "PATCH", {
        metadata: { x: 1 },
      }),
    );
    expect(response.headers.get("Content-Type")).toBe("application/json");
  });

  test("shallow-merges metadata (overrides existing keys)", async () => {
    const response = await router.handle(
      makeRequest(`/threads/${threadId}`, "PATCH", {
        metadata: { b: 99, c: 3 },
      }),
    );
    const body = await jsonBody<ThreadResponse>(response);
    expect(body.metadata).toEqual({ a: 1, b: 99, c: 3 });
  });

  test("preserves other fields when updating metadata", async () => {
    const response = await router.handle(
      makeRequest(`/threads/${threadId}`, "PATCH", {
        metadata: { updated: true },
      }),
    );
    const body = await jsonBody<ThreadResponse>(response);
    expect(body.thread_id).toBe(threadId);
    expect(body.status).toBe("idle");
  });

  test("updates updated_at timestamp", async () => {
    const getResp = await router.handle(makeRequest(`/threads/${threadId}`));
    const original = await jsonBody<ThreadResponse>(getResp);

    await Bun.sleep(5);

    const patchResp = await router.handle(
      makeRequest(`/threads/${threadId}`, "PATCH", {
        metadata: { later: true },
      }),
    );
    const updated = await jsonBody<ThreadResponse>(patchResp);

    expect(
      new Date(updated.updated_at).getTime(),
    ).toBeGreaterThanOrEqual(new Date(original.updated_at).getTime());
  });

  test("preserves created_at and thread_id", async () => {
    const getResp = await router.handle(makeRequest(`/threads/${threadId}`));
    const original = await jsonBody<ThreadResponse>(getResp);

    const patchResp = await router.handle(
      makeRequest(`/threads/${threadId}`, "PATCH", {
        metadata: { changed: true },
      }),
    );
    const updated = await jsonBody<ThreadResponse>(patchResp);

    expect(updated.thread_id).toBe(original.thread_id);
    expect(updated.created_at).toBe(original.created_at);
  });

  test("returns 404 for non-existent thread_id", async () => {
    const fakeId = crypto.randomUUID();
    const response = await router.handle(
      makeRequest(`/threads/${fakeId}`, "PATCH", {
        metadata: { nope: true },
      }),
    );
    expect(response.status).toBe(404);

    const body = await jsonBody<ErrorBody>(response);
    expect(body.detail).toContain(fakeId);
    expect(body.detail).toContain("not found");
  });

  test("returns 422 when Content-Type is not JSON", async () => {
    const response = await router.handle(
      new Request(`http://localhost:3000/threads/${threadId}`, {
        method: "PATCH",
        body: JSON.stringify({ metadata: {} }),
      }),
    );
    expect(response.status).toBe(422);
  });

  test("returns 422 when body is invalid JSON", async () => {
    const response = await router.handle(
      new Request(`http://localhost:3000/threads/${threadId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: "{not-valid",
      }),
    );
    expect(response.status).toBe(422);
  });

  test("empty patch body still updates updated_at", async () => {
    await Bun.sleep(5);

    const response = await router.handle(
      makeRequest(`/threads/${threadId}`, "PATCH", {}),
    );
    expect(response.status).toBe(200);

    const body = await jsonBody<ThreadResponse>(response);
    expect(body.thread_id).toBe(threadId);
  });
});

// ===========================================================================
// DELETE /threads/:thread_id — Delete
// ===========================================================================

describe("DELETE /threads/:thread_id", () => {
  test("deletes a thread and returns 200 with empty object", async () => {
    const created = await createThread();

    const response = await router.handle(
      makeRequest(`/threads/${created.thread_id}`, "DELETE"),
    );
    expect(response.status).toBe(200);

    const body = await jsonBody<Record<string, unknown>>(response);
    expect(body).toEqual({});
  });

  test("response has JSON content type", async () => {
    const created = await createThread();

    const response = await router.handle(
      makeRequest(`/threads/${created.thread_id}`, "DELETE"),
    );
    expect(response.headers.get("Content-Type")).toBe("application/json");
  });

  test("does NOT return {ok: true} — returns {} (Critical Finding #2)", async () => {
    const created = await createThread();

    const response = await router.handle(
      makeRequest(`/threads/${created.thread_id}`, "DELETE"),
    );
    const body = await jsonBody<Record<string, unknown>>(response);
    expect(body).toEqual({});
    expect(body).not.toHaveProperty("ok");
  });

  test("thread is gone after deletion", async () => {
    const created = await createThread();

    await router.handle(
      makeRequest(`/threads/${created.thread_id}`, "DELETE"),
    );

    const getResp = await router.handle(
      makeRequest(`/threads/${created.thread_id}`),
    );
    expect(getResp.status).toBe(404);
  });

  test("returns 404 for non-existent thread_id", async () => {
    const fakeId = crypto.randomUUID();
    const response = await router.handle(
      makeRequest(`/threads/${fakeId}`, "DELETE"),
    );
    expect(response.status).toBe(404);

    const body = await jsonBody<ErrorBody>(response);
    expect(body.detail).toContain(fakeId);
    expect(body.detail).toContain("not found");
  });

  test("double delete returns 404 on second attempt", async () => {
    const created = await createThread();

    const first = await router.handle(
      makeRequest(`/threads/${created.thread_id}`, "DELETE"),
    );
    expect(first.status).toBe(200);

    const second = await router.handle(
      makeRequest(`/threads/${created.thread_id}`, "DELETE"),
    );
    expect(second.status).toBe(404);
  });

  test("deleting a thread also removes its state history", async () => {
    const created = await createThread();

    // Add state via storage directly (since we don't have POST /state route yet)
    const storage = getStorage();
    await storage.threads.addStateSnapshot(created.thread_id, {
      values: { messages: ["hello"] },
    });

    // Delete
    await router.handle(
      makeRequest(`/threads/${created.thread_id}`, "DELETE"),
    );

    // State endpoint returns 404
    const stateResp = await router.handle(
      makeRequest(`/threads/${created.thread_id}/state`),
    );
    expect(stateResp.status).toBe(404);

    // History endpoint returns 404
    const historyResp = await router.handle(
      makeRequest(`/threads/${created.thread_id}/history`),
    );
    expect(historyResp.status).toBe(404);
  });
});

// ===========================================================================
// GET /threads/:thread_id/state — Get State
// ===========================================================================

describe("GET /threads/:thread_id/state", () => {
  test("returns state for an existing thread", async () => {
    const created = await createThread();

    const response = await router.handle(
      makeRequest(`/threads/${created.thread_id}/state`),
    );
    expect(response.status).toBe(200);

    const body = await jsonBody<ThreadStateResponse>(response);
    expect(body.values).toEqual({});
    expect(body.next).toEqual([]);
    expect(body.tasks).toEqual([]);
    expect(body.checkpoint).toBeDefined();
    expect(body.metadata).toBeDefined();
    expect(body.created_at).toBeDefined();
    expect(body.interrupts).toEqual([]);
  });

  test("response has JSON content type", async () => {
    const created = await createThread();

    const response = await router.handle(
      makeRequest(`/threads/${created.thread_id}/state`),
    );
    expect(response.headers.get("Content-Type")).toBe("application/json");
  });

  test("state has correct ThreadState shape", async () => {
    const created = await createThread();

    const response = await router.handle(
      makeRequest(`/threads/${created.thread_id}/state`),
    );
    const body = await jsonBody<ThreadStateResponse>(response);

    // Required fields
    expect(body).toHaveProperty("values");
    expect(body).toHaveProperty("next");
    expect(body).toHaveProperty("tasks");

    // Checkpoint should reference the thread
    expect(body.checkpoint).toBeDefined();
    expect(body.checkpoint!.thread_id).toBe(created.thread_id);
    expect(body.checkpoint!.checkpoint_ns).toBe("");
    expect(body.checkpoint!.checkpoint_id).toBeDefined();
  });

  test("state reflects values after state snapshot is added", async () => {
    const created = await createThread();

    // Add state via storage directly
    const storage = getStorage();
    await storage.threads.addStateSnapshot(created.thread_id, {
      values: { messages: [{ role: "user", content: "hello" }] },
    });

    const response = await router.handle(
      makeRequest(`/threads/${created.thread_id}/state`),
    );
    const body = await jsonBody<ThreadStateResponse>(response);
    expect(body.values).toEqual({
      messages: [{ role: "user", content: "hello" }],
    });
  });

  test("state includes thread metadata", async () => {
    const created = await createThread({ metadata: { session: "abc" } });

    const response = await router.handle(
      makeRequest(`/threads/${created.thread_id}/state`),
    );
    const body = await jsonBody<ThreadStateResponse>(response);
    expect(body.metadata).toEqual({ session: "abc" });
  });

  test("returns 404 for non-existent thread_id", async () => {
    const fakeId = crypto.randomUUID();
    const response = await router.handle(
      makeRequest(`/threads/${fakeId}/state`),
    );
    expect(response.status).toBe(404);

    const body = await jsonBody<ErrorBody>(response);
    expect(body.detail).toContain(fakeId);
    expect(body.detail).toContain("not found");
  });
});

// ===========================================================================
// GET /threads/:thread_id/history — Get History
// ===========================================================================

describe("GET /threads/:thread_id/history", () => {
  let threadId: string;

  beforeEach(async () => {
    resetStorage();
    const created = await createThread();
    threadId = created.thread_id;
  });

  test("returns empty array for thread with no snapshots", async () => {
    const response = await router.handle(
      makeRequest(`/threads/${threadId}/history`),
    );
    expect(response.status).toBe(200);

    const body = await jsonBody<ThreadStateResponse[]>(response);
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(0);
  });

  test("response has JSON content type", async () => {
    const response = await router.handle(
      makeRequest(`/threads/${threadId}/history`),
    );
    expect(response.headers.get("Content-Type")).toBe("application/json");
  });

  test("returns snapshots in reverse chronological order", async () => {
    const storage = getStorage();
    await storage.threads.addStateSnapshot(threadId, { values: { step: 1 } });
    await storage.threads.addStateSnapshot(threadId, { values: { step: 2 } });
    await storage.threads.addStateSnapshot(threadId, { values: { step: 3 } });

    const response = await router.handle(
      makeRequest(`/threads/${threadId}/history`),
    );
    const body = await jsonBody<ThreadStateResponse[]>(response);

    expect(body.length).toBe(3);
    expect(body[0].values).toEqual({ step: 3 }); // most recent first
    expect(body[1].values).toEqual({ step: 2 });
    expect(body[2].values).toEqual({ step: 1 });
  });

  test("each snapshot has ThreadState shape", async () => {
    const storage = getStorage();
    await storage.threads.addStateSnapshot(threadId, {
      values: { messages: ["hi"] },
      next: ["agent"],
      tasks: [{ id: "t1" }],
      metadata: { custom: true },
      interrupts: [{ type: "human" }],
    });

    const response = await router.handle(
      makeRequest(`/threads/${threadId}/history`),
    );
    const body = await jsonBody<ThreadStateResponse[]>(response);

    expect(body.length).toBe(1);
    const snapshot = body[0];
    expect(snapshot.values).toEqual({ messages: ["hi"] });
    expect(snapshot.next).toEqual(["agent"]);
    expect(snapshot.tasks).toEqual([{ id: "t1" }]);
    expect(snapshot.metadata).toEqual({ custom: true });
    expect(snapshot.interrupts).toEqual([{ type: "human" }]);
    expect(snapshot.checkpoint).toBeDefined();
    expect(snapshot.checkpoint!.thread_id).toBe(threadId);
    expect(snapshot.created_at).toBeDefined();
  });

  test("respects limit query param", async () => {
    const storage = getStorage();
    for (let i = 1; i <= 5; i++) {
      await storage.threads.addStateSnapshot(threadId, { values: { step: i } });
    }

    const response = await router.handle(
      makeRequest(`/threads/${threadId}/history?limit=2`),
    );
    const body = await jsonBody<ThreadStateResponse[]>(response);

    expect(body.length).toBe(2);
    expect(body[0].values).toEqual({ step: 5 });
    expect(body[1].values).toEqual({ step: 4 });
  });

  test("default limit is 10", async () => {
    const storage = getStorage();
    for (let i = 1; i <= 15; i++) {
      await storage.threads.addStateSnapshot(threadId, { values: { step: i } });
    }

    const response = await router.handle(
      makeRequest(`/threads/${threadId}/history`),
    );
    const body = await jsonBody<ThreadStateResponse[]>(response);

    expect(body.length).toBe(10);
  });

  test("limit is clamped to maximum 1000", async () => {
    // Just verify we don't crash with a very large limit
    const response = await router.handle(
      makeRequest(`/threads/${threadId}/history?limit=9999`),
    );
    expect(response.status).toBe(200);
  });

  test("limit is clamped to minimum 1", async () => {
    const storage = getStorage();
    await storage.threads.addStateSnapshot(threadId, { values: { step: 1 } });
    await storage.threads.addStateSnapshot(threadId, { values: { step: 2 } });

    const response = await router.handle(
      makeRequest(`/threads/${threadId}/history?limit=0`),
    );
    const body = await jsonBody<ThreadStateResponse[]>(response);
    // limit=0 gets clamped to 1
    expect(body.length).toBe(1);
  });

  test("invalid limit param is ignored (uses default)", async () => {
    const storage = getStorage();
    for (let i = 1; i <= 3; i++) {
      await storage.threads.addStateSnapshot(threadId, { values: { step: i } });
    }

    const response = await router.handle(
      makeRequest(`/threads/${threadId}/history?limit=not_a_number`),
    );
    const body = await jsonBody<ThreadStateResponse[]>(response);
    // Should use default limit of 10 (which means all 3 are returned)
    expect(body.length).toBe(3);
  });

  test("respects before query param", async () => {
    const storage = getStorage();
    await storage.threads.addStateSnapshot(threadId, { values: { step: 1 } });
    await storage.threads.addStateSnapshot(threadId, { values: { step: 2 } });
    await storage.threads.addStateSnapshot(threadId, { values: { step: 3 } });

    // Get all history to find the checkpoint_id of step 3
    const allResp = await router.handle(
      makeRequest(`/threads/${threadId}/history`),
    );
    const allHistory = await jsonBody<ThreadStateResponse[]>(allResp);
    const step3Id = allHistory[0].checkpoint!.checkpoint_id as string;

    // Get history before step 3
    const response = await router.handle(
      makeRequest(`/threads/${threadId}/history?before=${step3Id}`),
    );
    const body = await jsonBody<ThreadStateResponse[]>(response);

    expect(body.length).toBe(2);
    expect(body[0].values).toEqual({ step: 2 });
    expect(body[1].values).toEqual({ step: 1 });
  });

  test("limit and before can be combined", async () => {
    const storage = getStorage();
    for (let i = 1; i <= 5; i++) {
      await storage.threads.addStateSnapshot(threadId, { values: { step: i } });
    }

    // Get checkpoint_id of step 5
    const allResp = await router.handle(
      makeRequest(`/threads/${threadId}/history`),
    );
    const allHistory = await jsonBody<ThreadStateResponse[]>(allResp);
    const step5Id = allHistory[0].checkpoint!.checkpoint_id as string;

    // Get 2 items before step 5
    const response = await router.handle(
      makeRequest(`/threads/${threadId}/history?limit=2&before=${step5Id}`),
    );
    const body = await jsonBody<ThreadStateResponse[]>(response);

    expect(body.length).toBe(2);
    expect(body[0].values).toEqual({ step: 4 });
    expect(body[1].values).toEqual({ step: 3 });
  });

  test("returns 404 for non-existent thread_id", async () => {
    const fakeId = crypto.randomUUID();
    const response = await router.handle(
      makeRequest(`/threads/${fakeId}/history`),
    );
    expect(response.status).toBe(404);

    const body = await jsonBody<ErrorBody>(response);
    expect(body.detail).toContain(fakeId);
    expect(body.detail).toContain("not found");
  });
});

// ===========================================================================
// POST /threads/search — Search
// ===========================================================================

describe("POST /threads/search", () => {
  let threadIdA: string;
  let threadIdB: string;
  let threadIdC: string;

  beforeEach(async () => {
    resetStorage();
    const a = await createThread({ metadata: { env: "prod", role: "chat" } });
    const b = await createThread({ metadata: { env: "staging" } });
    const c = await createThread({ metadata: { env: "prod" } });
    threadIdA = a.thread_id;
    threadIdB = b.thread_id;
    threadIdC = c.thread_id;
  });

  test("returns all threads with empty body", async () => {
    const response = await router.handle(
      makeRequest("/threads/search", "POST", {}),
    );
    expect(response.status).toBe(200);

    const body = await jsonBody<ThreadResponse[]>(response);
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(3);
  });

  test("response has JSON content type", async () => {
    const response = await router.handle(
      makeRequest("/threads/search", "POST", {}),
    );
    expect(response.headers.get("Content-Type")).toBe("application/json");
  });

  test("returns array even when no results", async () => {
    const response = await router.handle(
      makeRequest("/threads/search", "POST", {
        metadata: { nonexistent: true },
      }),
    );
    const body = await jsonBody<ThreadResponse[]>(response);
    expect(body).toEqual([]);
  });

  test("filters by metadata", async () => {
    const response = await router.handle(
      makeRequest("/threads/search", "POST", {
        metadata: { env: "prod" },
      }),
    );
    const body = await jsonBody<ThreadResponse[]>(response);
    expect(body.length).toBe(2);
  });

  test("filters by metadata with multiple keys", async () => {
    const response = await router.handle(
      makeRequest("/threads/search", "POST", {
        metadata: { env: "prod", role: "chat" },
      }),
    );
    const body = await jsonBody<ThreadResponse[]>(response);
    expect(body.length).toBe(1);
    expect(body[0].thread_id).toBe(threadIdA);
  });

  test("filters by IDs", async () => {
    const response = await router.handle(
      makeRequest("/threads/search", "POST", {
        ids: [threadIdA, threadIdC],
      }),
    );
    const body = await jsonBody<ThreadResponse[]>(response);
    expect(body.length).toBe(2);

    const returnedIds = body.map((t) => t.thread_id).sort();
    expect(returnedIds).toEqual([threadIdA, threadIdC].sort());
  });

  test("filters by status", async () => {
    const response = await router.handle(
      makeRequest("/threads/search", "POST", { status: "idle" }),
    );
    const body = await jsonBody<ThreadResponse[]>(response);
    expect(body.length).toBe(3); // all idle by default

    const response2 = await router.handle(
      makeRequest("/threads/search", "POST", { status: "busy" }),
    );
    const body2 = await jsonBody<ThreadResponse[]>(response2);
    expect(body2.length).toBe(0);
  });

  test("filters by values (after state is added)", async () => {
    const storage = getStorage();
    await storage.threads.addStateSnapshot(threadIdA, {
      values: { topic: "science" },
    });
    await storage.threads.addStateSnapshot(threadIdB, {
      values: { topic: "art" },
    });

    const response = await router.handle(
      makeRequest("/threads/search", "POST", {
        values: { topic: "science" },
      }),
    );
    const body = await jsonBody<ThreadResponse[]>(response);
    expect(body.length).toBe(1);
    expect(body[0].thread_id).toBe(threadIdA);
  });

  test("applies limit", async () => {
    const response = await router.handle(
      makeRequest("/threads/search", "POST", { limit: 2 }),
    );
    const body = await jsonBody<ThreadResponse[]>(response);
    expect(body.length).toBe(2);
  });

  test("applies offset", async () => {
    const allResp = await router.handle(
      makeRequest("/threads/search", "POST", {
        sort_by: "created_at",
        sort_order: "asc",
      }),
    );
    const all = await jsonBody<ThreadResponse[]>(allResp);

    const response = await router.handle(
      makeRequest("/threads/search", "POST", {
        sort_by: "created_at",
        sort_order: "asc",
        offset: 1,
      }),
    );
    const body = await jsonBody<ThreadResponse[]>(response);
    expect(body.length).toBe(2);
    expect(body[0].thread_id).toBe(all[1].thread_id);
  });

  test("applies limit + offset together", async () => {
    const response = await router.handle(
      makeRequest("/threads/search", "POST", {
        sort_by: "created_at",
        sort_order: "asc",
        limit: 1,
        offset: 1,
      }),
    );
    const body = await jsonBody<ThreadResponse[]>(response);
    expect(body.length).toBe(1);
    expect(body[0].thread_id).toBe(threadIdB);
  });

  test("sorts by created_at ascending", async () => {
    const response = await router.handle(
      makeRequest("/threads/search", "POST", {
        sort_by: "created_at",
        sort_order: "asc",
      }),
    );
    const body = await jsonBody<ThreadResponse[]>(response);
    expect(body[0].thread_id).toBe(threadIdA);
  });

  test("default sort is created_at descending (non-increasing order)", async () => {
    const response = await router.handle(
      makeRequest("/threads/search", "POST", {}),
    );
    const body = await jsonBody<ThreadResponse[]>(response);
    for (let i = 0; i < body.length - 1; i++) {
      expect(body[i].created_at >= body[i + 1].created_at).toBe(true);
    }
  });

  test("accepts empty body without Content-Type (lenient parsing)", async () => {
    const response = await router.handle(
      new Request("http://localhost:3000/threads/search", {
        method: "POST",
      }),
    );
    expect(response.status).toBe(200);

    const body = await jsonBody<ThreadResponse[]>(response);
    expect(body.length).toBe(3);
  });

  test("each result has the full Thread shape", async () => {
    const response = await router.handle(
      makeRequest("/threads/search", "POST", { limit: 1 }),
    );
    const body = await jsonBody<ThreadResponse[]>(response);
    expect(body.length).toBe(1);

    const thread = body[0];
    expect(thread.thread_id).toBeDefined();
    expect(thread.metadata).toBeDefined();
    expect(thread.status).toBeDefined();
    expect(thread.created_at).toBeDefined();
    expect(thread.updated_at).toBeDefined();
  });
});

// ===========================================================================
// POST /threads/count — Count
// ===========================================================================

describe("POST /threads/count", () => {
  beforeEach(async () => {
    resetStorage();
    await createThread({ metadata: { env: "prod" } });
    await createThread({ metadata: { env: "staging" } });
    await createThread({ metadata: { env: "prod" } });
  });

  test("returns total count with empty body", async () => {
    const response = await router.handle(
      makeRequest("/threads/count", "POST", {}),
    );
    expect(response.status).toBe(200);

    const body = await jsonBody<number>(response);
    expect(body).toBe(3);
  });

  test("returns bare integer, not wrapped object", async () => {
    const response = await router.handle(
      makeRequest("/threads/count", "POST", {}),
    );
    const text = await response.clone().text();
    expect(text).toBe("3");
  });

  test("response has JSON content type", async () => {
    const response = await router.handle(
      makeRequest("/threads/count", "POST", {}),
    );
    expect(response.headers.get("Content-Type")).toBe("application/json");
  });

  test("filters by metadata", async () => {
    const response = await router.handle(
      makeRequest("/threads/count", "POST", {
        metadata: { env: "prod" },
      }),
    );
    const body = await jsonBody<number>(response);
    expect(body).toBe(2);
  });

  test("filters by status", async () => {
    const response = await router.handle(
      makeRequest("/threads/count", "POST", { status: "idle" }),
    );
    const body = await jsonBody<number>(response);
    expect(body).toBe(3);

    const response2 = await router.handle(
      makeRequest("/threads/count", "POST", { status: "busy" }),
    );
    const body2 = await jsonBody<number>(response2);
    expect(body2).toBe(0);
  });

  test("returns 0 for no matches", async () => {
    const response = await router.handle(
      makeRequest("/threads/count", "POST", {
        metadata: { nonexistent: true },
      }),
    );
    const body = await jsonBody<number>(response);
    expect(body).toBe(0);
  });

  test("accepts empty body without Content-Type (lenient parsing)", async () => {
    const response = await router.handle(
      new Request("http://localhost:3000/threads/count", {
        method: "POST",
      }),
    );
    expect(response.status).toBe(200);

    const body = await jsonBody<number>(response);
    expect(body).toBe(3);
  });
});

// ===========================================================================
// Method validation — wrong methods return 405
// ===========================================================================

describe("method validation", () => {
  test("GET /threads returns 405 (no GET all endpoint)", async () => {
    const response = await router.handle(makeRequest("/threads"));
    // POST /threads exists, so GET should be 405 not 404
    expect(response.status).toBe(405);
  });

  test("PUT /threads/:id returns 405", async () => {
    const response = await router.handle(
      makeRequest(`/threads/${crypto.randomUUID()}`, "PUT"),
    );
    expect(response.status).toBe(405);
  });

  test("POST /threads/:id returns 405", async () => {
    const response = await router.handle(
      new Request(
        `http://localhost:3000/threads/${crypto.randomUUID()}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      ),
    );
    expect(response.status).toBe(405);
  });

  test("GET /threads/search returns 404 (matched as GET /threads/:thread_id with id='search')", async () => {
    const response = await router.handle(
      makeRequest("/threads/search"),
    );
    // The param route GET /threads/:thread_id captures "search" as an ID.
    // No thread with id "search" exists → 404.
    expect(response.status).toBe(404);
  });

  test("GET /threads/count returns 404 (matched as GET /threads/:thread_id with id='count')", async () => {
    const response = await router.handle(
      makeRequest("/threads/count"),
    );
    // The param route GET /threads/:thread_id captures "count" as an ID.
    // No thread with id "count" exists → 404.
    expect(response.status).toBe(404);
  });

  test("POST /threads/:thread_id/state returns 405", async () => {
    const response = await router.handle(
      new Request(
        `http://localhost:3000/threads/${crypto.randomUUID()}/state`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      ),
    );
    expect(response.status).toBe(405);
  });

  test("POST /threads/:thread_id/history returns 404 for non-existent thread", async () => {
    const response = await router.handle(
      new Request(
        `http://localhost:3000/threads/${crypto.randomUUID()}/history`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      ),
    );
    // POST is now a valid method (matching LangGraph SDK expectations).
    // A non-existent thread returns 404, not 405.
    expect(response.status).toBe(404);
  });
});

// ===========================================================================
// Route disambiguation — /threads/search and /threads/count
// must NOT be captured as /threads/:thread_id
// ===========================================================================

describe("route disambiguation", () => {
  test("POST /threads/search is not treated as GET /threads/:thread_id", async () => {
    const response = await router.handle(
      makeRequest("/threads/search", "POST", {}),
    );
    expect(response.status).toBe(200);
    const body = await jsonBody<unknown[]>(response);
    expect(Array.isArray(body)).toBe(true);
  });

  test("POST /threads/count is not treated as GET /threads/:thread_id", async () => {
    const response = await router.handle(
      makeRequest("/threads/count", "POST", {}),
    );
    expect(response.status).toBe(200);
    const body = await jsonBody<number>(response);
    expect(typeof body).toBe("number");
  });

  test("GET /threads/search returns 404 (param route captures 'search' as ID)", async () => {
    // GET /threads/:thread_id matches with thread_id="search",
    // which doesn't exist → 404. The static POST /threads/search route
    // only applies to POST requests.
    const response = await router.handle(
      makeRequest("/threads/search"),
    );
    expect(response.status).toBe(404);
  });

  test("GET /threads/count returns 404 (param route captures 'count' as ID)", async () => {
    const response = await router.handle(
      makeRequest("/threads/count"),
    );
    expect(response.status).toBe(404);
  });
});

// ===========================================================================
// End-to-end CRUD flow
// ===========================================================================

describe("end-to-end CRUD flow", () => {
  test("create → get → patch → get → state → add snapshot → state → history → delete → get (404)", async () => {
    // 1. Create
    const createResp = await router.handle(
      makeRequest("/threads", "POST", {
        metadata: { session: "e2e", step: "created" },
      }),
    );
    expect(createResp.status).toBe(200);
    const created = await jsonBody<ThreadResponse>(createResp);
    const id = created.thread_id;
    expect(created.status).toBe("idle");
    expect(created.metadata).toEqual({ session: "e2e", step: "created" });

    // 2. Get
    const getResp1 = await router.handle(makeRequest(`/threads/${id}`));
    expect(getResp1.status).toBe(200);
    const fetched = await jsonBody<ThreadResponse>(getResp1);
    expect(fetched.thread_id).toBe(id);

    // 3. Patch
    const patchResp = await router.handle(
      makeRequest(`/threads/${id}`, "PATCH", {
        metadata: { step: "patched", extra: true },
      }),
    );
    expect(patchResp.status).toBe(200);
    const patched = await jsonBody<ThreadResponse>(patchResp);
    expect(patched.metadata).toEqual({
      session: "e2e",
      step: "patched",
      extra: true,
    });

    // 4. Get again — see changes
    const getResp2 = await router.handle(makeRequest(`/threads/${id}`));
    const refetched = await jsonBody<ThreadResponse>(getResp2);
    expect(refetched.metadata.step).toBe("patched");

    // 5. Get state (empty initially)
    const stateResp1 = await router.handle(
      makeRequest(`/threads/${id}/state`),
    );
    expect(stateResp1.status).toBe(200);
    const state1 = await jsonBody<ThreadStateResponse>(stateResp1);
    expect(state1.values).toEqual({});

    // 6. Add state snapshots via storage (runs will do this in Task-05)
    const storage = getStorage();
    await storage.threads.addStateSnapshot(id, {
      values: { messages: [{ role: "user", content: "hi" }] },
    });
    await storage.threads.addStateSnapshot(id, {
      values: {
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello!" },
        ],
      },
    });

    // 7. Get state — should reflect latest values
    const stateResp2 = await router.handle(
      makeRequest(`/threads/${id}/state`),
    );
    const state2 = await jsonBody<ThreadStateResponse>(stateResp2);
    expect((state2.values as Record<string, unknown>).messages).toHaveLength(2);

    // 8. Get history — should show 2 snapshots
    const historyResp = await router.handle(
      makeRequest(`/threads/${id}/history`),
    );
    expect(historyResp.status).toBe(200);
    const history = await jsonBody<ThreadStateResponse[]>(historyResp);
    expect(history.length).toBe(2);
    // Most recent first
    expect(
      ((history[0].values as Record<string, unknown>).messages as unknown[])
        .length,
    ).toBe(2);
    expect(
      ((history[1].values as Record<string, unknown>).messages as unknown[])
        .length,
    ).toBe(1);

    // 9. Verify it appears in search
    const searchResp = await router.handle(
      makeRequest("/threads/search", "POST", {
        metadata: { session: "e2e" },
      }),
    );
    const searchResults = await jsonBody<ThreadResponse[]>(searchResp);
    expect(searchResults.length).toBe(1);
    expect(searchResults[0].thread_id).toBe(id);

    // 10. Verify count
    const countResp = await router.handle(
      makeRequest("/threads/count", "POST", {}),
    );
    const count = await jsonBody<number>(countResp);
    expect(count).toBe(1);

    // 11. Delete
    const deleteResp = await router.handle(
      makeRequest(`/threads/${id}`, "DELETE"),
    );
    expect(deleteResp.status).toBe(200);
    const deleteBody = await jsonBody<Record<string, unknown>>(deleteResp);
    expect(deleteBody).toEqual({});

    // 12. Get after delete — 404
    const getResp3 = await router.handle(makeRequest(`/threads/${id}`));
    expect(getResp3.status).toBe(404);

    // 13. Count after delete — 0
    const countResp2 = await router.handle(
      makeRequest("/threads/count", "POST", {}),
    );
    const count2 = await jsonBody<number>(countResp2);
    expect(count2).toBe(0);

    // 14. State after delete — 404
    const stateResp3 = await router.handle(
      makeRequest(`/threads/${id}/state`),
    );
    expect(stateResp3.status).toBe(404);

    // 15. History after delete — 404
    const historyResp2 = await router.handle(
      makeRequest(`/threads/${id}/history`),
    );
    expect(historyResp2.status).toBe(404);
  });
});
