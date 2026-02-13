/**
 * Tests for the assistant route endpoints — Fractal Agents Runtime TypeScript/Bun (v0.0.1).
 *
 * Validates that every assistant endpoint returns the exact response shape
 * defined in the Python runtime's OpenAPI spec:
 *
 *   POST   /assistants                — Create assistant (200, 409, 422)
 *   GET    /assistants/:assistant_id  — Get assistant (200, 404)
 *   PATCH  /assistants/:assistant_id  — Update assistant (200, 404, 422)
 *   DELETE /assistants/:assistant_id  — Delete assistant (200, 404)
 *   POST   /assistants/search         — Search assistants (200)
 *   POST   /assistants/count          — Count assistants (200)
 *
 * Response conventions verified:
 *   - Create returns 200 (not 201) with the Assistant object.
 *   - Delete returns 200 with `{}` (empty object, NOT `{"ok": true}`).
 *   - Count returns 200 with a bare integer.
 *   - Search returns 200 with a JSON array.
 *   - Errors use `{"detail": "..."}` shape (ErrorResponse).
 *
 * Reference: apps/python/openapi-spec.json, apps/python/src/server/routes/assistants.py
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

interface AssistantResponse {
  assistant_id: string;
  graph_id: string;
  config: Record<string, unknown>;
  metadata: Record<string, unknown>;
  version?: number;
  name?: string;
  description?: string | null;
  context?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

interface ErrorBody {
  detail: string;
}

// ---------------------------------------------------------------------------
// Setup — reset storage before each test to ensure isolation
// ---------------------------------------------------------------------------

beforeEach(() => {
  resetStorage();
});

// ===========================================================================
// POST /assistants — Create
// ===========================================================================

describe("POST /assistants", () => {
  test("creates an assistant and returns 200", async () => {
    const response = await router.handle(
      makeRequest("/assistants", "POST", { graph_id: "agent" }),
    );
    expect(response.status).toBe(200);

    const body = await jsonBody<AssistantResponse>(response);
    expect(body.assistant_id).toBeDefined();
    expect(body.graph_id).toBe("agent");
    expect(body.config).toBeDefined();
    expect(body.metadata).toEqual({});
    expect(body.version).toBe(1);
    expect(body.created_at).toBeDefined();
    expect(body.updated_at).toBeDefined();
  });

  test("response has JSON content type", async () => {
    const response = await router.handle(
      makeRequest("/assistants", "POST", { graph_id: "agent" }),
    );
    expect(response.headers.get("Content-Type")).toBe("application/json");
  });

  test("creates with explicit assistant_id", async () => {
    const id = crypto.randomUUID();
    const response = await router.handle(
      makeRequest("/assistants", "POST", {
        graph_id: "agent",
        assistant_id: id,
      }),
    );
    expect(response.status).toBe(200);

    const body = await jsonBody<AssistantResponse>(response);
    expect(body.assistant_id).toBe(id);
  });

  test("creates with all optional fields", async () => {
    const response = await router.handle(
      makeRequest("/assistants", "POST", {
        graph_id: "agent",
        config: { tags: ["test"], recursion_limit: 50 },
        context: { system: "prompt" },
        metadata: { env: "test" },
        name: "My Assistant",
        description: "A test assistant",
      }),
    );
    expect(response.status).toBe(200);

    const body = await jsonBody<AssistantResponse>(response);
    expect(body.graph_id).toBe("agent");
    expect(body.config).toEqual({ tags: ["test"], recursion_limit: 50 });
    expect(body.context).toEqual({ system: "prompt" });
    expect(body.metadata).toEqual({ env: "test" });
    expect(body.name).toBe("My Assistant");
    expect(body.description).toBe("A test assistant");
  });

  test("returns 422 when graph_id is missing", async () => {
    const response = await router.handle(
      makeRequest("/assistants", "POST", {}),
    );
    expect(response.status).toBe(422);

    const body = await jsonBody<ErrorBody>(response);
    expect(body.detail).toBeDefined();
    expect(typeof body.detail).toBe("string");
  });

  test("returns 422 when body is invalid JSON", async () => {
    const response = await router.handle(
      new Request("http://localhost:3000/assistants", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      }),
    );
    expect(response.status).toBe(422);

    const body = await jsonBody<ErrorBody>(response);
    expect(body.detail).toBeDefined();
  });

  test("returns 422 when Content-Type is missing", async () => {
    const response = await router.handle(
      new Request("http://localhost:3000/assistants", {
        method: "POST",
        body: JSON.stringify({ graph_id: "agent" }),
      }),
    );
    expect(response.status).toBe(422);
  });

  test("returns 409 when assistant_id already exists (default if_exists=raise)", async () => {
    const id = crypto.randomUUID();

    // Create first
    await router.handle(
      makeRequest("/assistants", "POST", {
        graph_id: "agent",
        assistant_id: id,
      }),
    );

    // Try to create again — should be 409
    const response = await router.handle(
      makeRequest("/assistants", "POST", {
        graph_id: "agent",
        assistant_id: id,
      }),
    );
    expect(response.status).toBe(409);

    const body = await jsonBody<ErrorBody>(response);
    expect(body.detail).toContain(id);
    expect(body.detail).toContain("already exists");
  });

  test("returns existing assistant with if_exists=do_nothing", async () => {
    const id = crypto.randomUUID();

    // Create first
    const createResponse = await router.handle(
      makeRequest("/assistants", "POST", {
        graph_id: "agent",
        assistant_id: id,
        name: "Original",
      }),
    );
    const original = await jsonBody<AssistantResponse>(createResponse);

    // Create again with if_exists=do_nothing
    const response = await router.handle(
      makeRequest("/assistants", "POST", {
        graph_id: "agent",
        assistant_id: id,
        name: "Duplicate",
        if_exists: "do_nothing",
      }),
    );
    expect(response.status).toBe(200);

    const body = await jsonBody<AssistantResponse>(response);
    expect(body.assistant_id).toBe(id);
    expect(body.name).toBe("Original"); // unchanged
  });

  test("auto-generated IDs are valid UUIDs with dashes", async () => {
    const response = await router.handle(
      makeRequest("/assistants", "POST", { graph_id: "agent" }),
    );
    const body = await jsonBody<AssistantResponse>(response);
    expect(body.assistant_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  test("created_at is a valid ISO 8601 timestamp ending in Z", async () => {
    const response = await router.handle(
      makeRequest("/assistants", "POST", { graph_id: "agent" }),
    );
    const body = await jsonBody<AssistantResponse>(response);
    expect(body.created_at).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/,
    );
  });

  test("version starts at 1", async () => {
    const response = await router.handle(
      makeRequest("/assistants", "POST", { graph_id: "agent" }),
    );
    const body = await jsonBody<AssistantResponse>(response);
    expect(body.version).toBe(1);
  });
});

// ===========================================================================
// GET /assistants/:assistant_id — Get
// ===========================================================================

describe("GET /assistants/:assistant_id", () => {
  test("returns an existing assistant", async () => {
    // Create one first
    const createResp = await router.handle(
      makeRequest("/assistants", "POST", {
        graph_id: "agent",
        name: "Findable",
      }),
    );
    const created = await jsonBody<AssistantResponse>(createResp);

    // Fetch it
    const response = await router.handle(
      makeRequest(`/assistants/${created.assistant_id}`),
    );
    expect(response.status).toBe(200);

    const body = await jsonBody<AssistantResponse>(response);
    expect(body.assistant_id).toBe(created.assistant_id);
    expect(body.name).toBe("Findable");
    expect(body.graph_id).toBe("agent");
  });

  test("response has JSON content type", async () => {
    const createResp = await router.handle(
      makeRequest("/assistants", "POST", { graph_id: "agent" }),
    );
    const created = await jsonBody<AssistantResponse>(createResp);

    const response = await router.handle(
      makeRequest(`/assistants/${created.assistant_id}`),
    );
    expect(response.headers.get("Content-Type")).toBe("application/json");
  });

  test("returns 404 for non-existent assistant_id", async () => {
    const fakeId = crypto.randomUUID();
    const response = await router.handle(
      makeRequest(`/assistants/${fakeId}`),
    );
    expect(response.status).toBe(404);

    const body = await jsonBody<ErrorBody>(response);
    expect(body.detail).toContain(fakeId);
    expect(body.detail).toContain("not found");
  });

  test("404 response matches ErrorResponse shape", async () => {
    const response = await router.handle(
      makeRequest(`/assistants/${crypto.randomUUID()}`),
    );
    const body = await jsonBody<ErrorBody>(response);
    expect(typeof body.detail).toBe("string");
    expect(Object.keys(body)).toEqual(["detail"]);
  });
});

// ===========================================================================
// PATCH /assistants/:assistant_id — Update
// ===========================================================================

describe("PATCH /assistants/:assistant_id", () => {
  let assistantId: string;

  beforeEach(async () => {
    resetStorage();
    const resp = await router.handle(
      makeRequest("/assistants", "POST", {
        graph_id: "agent",
        name: "Patchable",
        metadata: { a: 1 },
        description: "Original description",
      }),
    );
    const body = await jsonBody<AssistantResponse>(resp);
    assistantId = body.assistant_id;
  });

  test("updates name and returns 200", async () => {
    const response = await router.handle(
      makeRequest(`/assistants/${assistantId}`, "PATCH", {
        name: "Updated Name",
      }),
    );
    expect(response.status).toBe(200);

    const body = await jsonBody<AssistantResponse>(response);
    expect(body.name).toBe("Updated Name");
    expect(body.assistant_id).toBe(assistantId);
  });

  test("response has JSON content type", async () => {
    const response = await router.handle(
      makeRequest(`/assistants/${assistantId}`, "PATCH", {
        name: "Test",
      }),
    );
    expect(response.headers.get("Content-Type")).toBe("application/json");
  });

  test("increments version on each update", async () => {
    const resp1 = await router.handle(
      makeRequest(`/assistants/${assistantId}`, "PATCH", { name: "v2" }),
    );
    const body1 = await jsonBody<AssistantResponse>(resp1);
    expect(body1.version).toBe(2);

    const resp2 = await router.handle(
      makeRequest(`/assistants/${assistantId}`, "PATCH", { name: "v3" }),
    );
    const body2 = await jsonBody<AssistantResponse>(resp2);
    expect(body2.version).toBe(3);
  });

  test("shallow-merges metadata", async () => {
    const response = await router.handle(
      makeRequest(`/assistants/${assistantId}`, "PATCH", {
        metadata: { b: 2 },
      }),
    );
    const body = await jsonBody<AssistantResponse>(response);
    expect(body.metadata).toEqual({ a: 1, b: 2 });
  });

  test("does not overwrite unset fields", async () => {
    const response = await router.handle(
      makeRequest(`/assistants/${assistantId}`, "PATCH", {
        name: "New Name Only",
      }),
    );
    const body = await jsonBody<AssistantResponse>(response);
    expect(body.description).toBe("Original description");
    expect(body.graph_id).toBe("agent");
  });

  test("updates graph_id", async () => {
    const response = await router.handle(
      makeRequest(`/assistants/${assistantId}`, "PATCH", {
        graph_id: "research_agent",
      }),
    );
    const body = await jsonBody<AssistantResponse>(response);
    expect(body.graph_id).toBe("research_agent");
  });

  test("updates updated_at timestamp", async () => {
    // Get original
    const getResp = await router.handle(
      makeRequest(`/assistants/${assistantId}`),
    );
    const original = await jsonBody<AssistantResponse>(getResp);

    await Bun.sleep(5);

    const patchResp = await router.handle(
      makeRequest(`/assistants/${assistantId}`, "PATCH", { name: "Later" }),
    );
    const updated = await jsonBody<AssistantResponse>(patchResp);

    expect(
      new Date(updated.updated_at).getTime(),
    ).toBeGreaterThanOrEqual(new Date(original.updated_at).getTime());
  });

  test("preserves created_at and assistant_id", async () => {
    const getResp = await router.handle(
      makeRequest(`/assistants/${assistantId}`),
    );
    const original = await jsonBody<AssistantResponse>(getResp);

    const patchResp = await router.handle(
      makeRequest(`/assistants/${assistantId}`, "PATCH", {
        name: "Changed",
      }),
    );
    const updated = await jsonBody<AssistantResponse>(patchResp);

    expect(updated.assistant_id).toBe(original.assistant_id);
    expect(updated.created_at).toBe(original.created_at);
  });

  test("returns 404 for non-existent assistant_id", async () => {
    const fakeId = crypto.randomUUID();
    const response = await router.handle(
      makeRequest(`/assistants/${fakeId}`, "PATCH", { name: "Nope" }),
    );
    expect(response.status).toBe(404);

    const body = await jsonBody<ErrorBody>(response);
    expect(body.detail).toContain(fakeId);
    expect(body.detail).toContain("not found");
  });

  test("returns 422 when Content-Type is not JSON", async () => {
    const response = await router.handle(
      new Request(`http://localhost:3000/assistants/${assistantId}`, {
        method: "PATCH",
        body: JSON.stringify({ name: "test" }),
      }),
    );
    expect(response.status).toBe(422);
  });

  test("returns 422 when body is invalid JSON", async () => {
    const response = await router.handle(
      new Request(`http://localhost:3000/assistants/${assistantId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: "{invalid",
      }),
    );
    expect(response.status).toBe(422);
  });
});

// ===========================================================================
// DELETE /assistants/:assistant_id — Delete
// ===========================================================================

describe("DELETE /assistants/:assistant_id", () => {
  test("deletes an assistant and returns 200 with empty object", async () => {
    // Create one
    const createResp = await router.handle(
      makeRequest("/assistants", "POST", { graph_id: "agent" }),
    );
    const created = await jsonBody<AssistantResponse>(createResp);

    // Delete it
    const response = await router.handle(
      makeRequest(`/assistants/${created.assistant_id}`, "DELETE"),
    );
    expect(response.status).toBe(200);

    const body = await jsonBody<Record<string, unknown>>(response);
    expect(body).toEqual({});
  });

  test("response has JSON content type", async () => {
    const createResp = await router.handle(
      makeRequest("/assistants", "POST", { graph_id: "agent" }),
    );
    const created = await jsonBody<AssistantResponse>(createResp);

    const response = await router.handle(
      makeRequest(`/assistants/${created.assistant_id}`, "DELETE"),
    );
    expect(response.headers.get("Content-Type")).toBe("application/json");
  });

  test("does NOT return {ok: true} — returns {} (Critical Finding #2)", async () => {
    const createResp = await router.handle(
      makeRequest("/assistants", "POST", { graph_id: "agent" }),
    );
    const created = await jsonBody<AssistantResponse>(createResp);

    const response = await router.handle(
      makeRequest(`/assistants/${created.assistant_id}`, "DELETE"),
    );
    const body = await jsonBody<Record<string, unknown>>(response);
    expect(body).toEqual({});
    expect(body).not.toHaveProperty("ok");
  });

  test("assistant is gone after deletion", async () => {
    const createResp = await router.handle(
      makeRequest("/assistants", "POST", { graph_id: "agent" }),
    );
    const created = await jsonBody<AssistantResponse>(createResp);

    await router.handle(
      makeRequest(`/assistants/${created.assistant_id}`, "DELETE"),
    );

    // GET should return 404
    const getResp = await router.handle(
      makeRequest(`/assistants/${created.assistant_id}`),
    );
    expect(getResp.status).toBe(404);
  });

  test("returns 404 for non-existent assistant_id", async () => {
    const fakeId = crypto.randomUUID();
    const response = await router.handle(
      makeRequest(`/assistants/${fakeId}`, "DELETE"),
    );
    expect(response.status).toBe(404);

    const body = await jsonBody<ErrorBody>(response);
    expect(body.detail).toContain(fakeId);
    expect(body.detail).toContain("not found");
  });

  test("double delete returns 404 on second attempt", async () => {
    const createResp = await router.handle(
      makeRequest("/assistants", "POST", { graph_id: "agent" }),
    );
    const created = await jsonBody<AssistantResponse>(createResp);

    const first = await router.handle(
      makeRequest(`/assistants/${created.assistant_id}`, "DELETE"),
    );
    expect(first.status).toBe(200);

    const second = await router.handle(
      makeRequest(`/assistants/${created.assistant_id}`, "DELETE"),
    );
    expect(second.status).toBe(404);
  });
});

// ===========================================================================
// POST /assistants/search — Search
// ===========================================================================

describe("POST /assistants/search", () => {
  beforeEach(async () => {
    resetStorage();
    // Seed 3 assistants
    await router.handle(
      makeRequest("/assistants", "POST", {
        graph_id: "agent",
        name: "Alpha",
        metadata: { env: "prod", tier: "premium" },
      }),
    );
    await router.handle(
      makeRequest("/assistants", "POST", {
        graph_id: "agent",
        name: "Beta",
        metadata: { env: "staging" },
      }),
    );
    await router.handle(
      makeRequest("/assistants", "POST", {
        graph_id: "research_agent",
        name: "Gamma Research",
        metadata: { env: "prod" },
      }),
    );
  });

  test("returns all assistants with empty body", async () => {
    const response = await router.handle(
      makeRequest("/assistants/search", "POST", {}),
    );
    expect(response.status).toBe(200);

    const body = await jsonBody<AssistantResponse[]>(response);
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(3);
  });

  test("response has JSON content type", async () => {
    const response = await router.handle(
      makeRequest("/assistants/search", "POST", {}),
    );
    expect(response.headers.get("Content-Type")).toBe("application/json");
  });

  test("returns array even when no results", async () => {
    const response = await router.handle(
      makeRequest("/assistants/search", "POST", {
        graph_id: "nonexistent",
      }),
    );
    const body = await jsonBody<AssistantResponse[]>(response);
    expect(body).toEqual([]);
  });

  test("filters by graph_id", async () => {
    const response = await router.handle(
      makeRequest("/assistants/search", "POST", {
        graph_id: "research_agent",
      }),
    );
    const body = await jsonBody<AssistantResponse[]>(response);
    expect(body.length).toBe(1);
    expect(body[0].name).toBe("Gamma Research");
  });

  test("filters by metadata", async () => {
    const response = await router.handle(
      makeRequest("/assistants/search", "POST", {
        metadata: { env: "prod" },
      }),
    );
    const body = await jsonBody<AssistantResponse[]>(response);
    expect(body.length).toBe(2);
  });

  test("filters by metadata with multiple keys", async () => {
    const response = await router.handle(
      makeRequest("/assistants/search", "POST", {
        metadata: { env: "prod", tier: "premium" },
      }),
    );
    const body = await jsonBody<AssistantResponse[]>(response);
    expect(body.length).toBe(1);
    expect(body[0].name).toBe("Alpha");
  });

  test("filters by name (case-insensitive partial match)", async () => {
    const response = await router.handle(
      makeRequest("/assistants/search", "POST", { name: "alpha" }),
    );
    const body = await jsonBody<AssistantResponse[]>(response);
    expect(body.length).toBe(1);
    expect(body[0].name).toBe("Alpha");
  });

  test("filters by name partial match", async () => {
    const response = await router.handle(
      makeRequest("/assistants/search", "POST", { name: "Research" }),
    );
    const body = await jsonBody<AssistantResponse[]>(response);
    expect(body.length).toBe(1);
  });

  test("combines graph_id and metadata filters", async () => {
    const response = await router.handle(
      makeRequest("/assistants/search", "POST", {
        graph_id: "agent",
        metadata: { env: "prod" },
      }),
    );
    const body = await jsonBody<AssistantResponse[]>(response);
    expect(body.length).toBe(1);
    expect(body[0].name).toBe("Alpha");
  });

  test("applies limit", async () => {
    const response = await router.handle(
      makeRequest("/assistants/search", "POST", { limit: 2 }),
    );
    const body = await jsonBody<AssistantResponse[]>(response);
    expect(body.length).toBe(2);
  });

  test("applies offset", async () => {
    const response = await router.handle(
      makeRequest("/assistants/search", "POST", {
        limit: 10,
        offset: 2,
        sort_by: "name",
        sort_order: "asc",
      }),
    );
    const body = await jsonBody<AssistantResponse[]>(response);
    expect(body.length).toBe(1);
    expect(body[0].name).toBe("Gamma Research");
  });

  test("applies limit + offset together", async () => {
    const response = await router.handle(
      makeRequest("/assistants/search", "POST", {
        limit: 1,
        offset: 1,
        sort_by: "name",
        sort_order: "asc",
      }),
    );
    const body = await jsonBody<AssistantResponse[]>(response);
    expect(body.length).toBe(1);
    expect(body[0].name).toBe("Beta");
  });

  test("sorts by name ascending", async () => {
    const response = await router.handle(
      makeRequest("/assistants/search", "POST", {
        sort_by: "name",
        sort_order: "asc",
      }),
    );
    const body = await jsonBody<AssistantResponse[]>(response);
    expect(body[0].name).toBe("Alpha");
    expect(body[1].name).toBe("Beta");
    expect(body[2].name).toBe("Gamma Research");
  });

  test("sorts by name descending", async () => {
    const response = await router.handle(
      makeRequest("/assistants/search", "POST", {
        sort_by: "name",
        sort_order: "desc",
      }),
    );
    const body = await jsonBody<AssistantResponse[]>(response);
    expect(body[0].name).toBe("Gamma Research");
    expect(body[1].name).toBe("Beta");
    expect(body[2].name).toBe("Alpha");
  });

  test("default sort order is created_at descending (non-increasing)", async () => {
    const response = await router.handle(
      makeRequest("/assistants/search", "POST", {}),
    );
    const body = await jsonBody<AssistantResponse[]>(response);
    for (let i = 0; i < body.length - 1; i++) {
      expect(body[i].created_at >= body[i + 1].created_at).toBe(true);
    }
  });

  test("accepts empty body without Content-Type (lenient parsing)", async () => {
    const response = await router.handle(
      new Request("http://localhost:3000/assistants/search", {
        method: "POST",
      }),
    );
    expect(response.status).toBe(200);

    const body = await jsonBody<AssistantResponse[]>(response);
    expect(body.length).toBe(3);
  });

  test("each result has the full Assistant shape", async () => {
    const response = await router.handle(
      makeRequest("/assistants/search", "POST", { limit: 1 }),
    );
    const body = await jsonBody<AssistantResponse[]>(response);
    expect(body.length).toBe(1);

    const assistant = body[0];
    expect(assistant.assistant_id).toBeDefined();
    expect(assistant.graph_id).toBeDefined();
    expect(assistant.config).toBeDefined();
    expect(assistant.metadata).toBeDefined();
    expect(assistant.created_at).toBeDefined();
    expect(assistant.updated_at).toBeDefined();
  });
});

// ===========================================================================
// POST /assistants/count — Count
// ===========================================================================

describe("POST /assistants/count", () => {
  beforeEach(async () => {
    resetStorage();
    await router.handle(
      makeRequest("/assistants", "POST", {
        graph_id: "agent",
        name: "One",
        metadata: { env: "prod" },
      }),
    );
    await router.handle(
      makeRequest("/assistants", "POST", {
        graph_id: "agent",
        name: "Two",
        metadata: { env: "staging" },
      }),
    );
    await router.handle(
      makeRequest("/assistants", "POST", {
        graph_id: "research_agent",
        name: "Three",
        metadata: { env: "prod" },
      }),
    );
  });

  test("returns total count with empty body", async () => {
    const response = await router.handle(
      makeRequest("/assistants/count", "POST", {}),
    );
    expect(response.status).toBe(200);

    const body = await jsonBody<number>(response);
    expect(body).toBe(3);
  });

  test("returns bare integer, not wrapped object", async () => {
    const response = await router.handle(
      makeRequest("/assistants/count", "POST", {}),
    );
    const text = await response.clone().text();
    expect(text).toBe("3");
  });

  test("response has JSON content type", async () => {
    const response = await router.handle(
      makeRequest("/assistants/count", "POST", {}),
    );
    expect(response.headers.get("Content-Type")).toBe("application/json");
  });

  test("filters by graph_id", async () => {
    const response = await router.handle(
      makeRequest("/assistants/count", "POST", {
        graph_id: "agent",
      }),
    );
    const body = await jsonBody<number>(response);
    expect(body).toBe(2);
  });

  test("filters by metadata", async () => {
    const response = await router.handle(
      makeRequest("/assistants/count", "POST", {
        metadata: { env: "prod" },
      }),
    );
    const body = await jsonBody<number>(response);
    expect(body).toBe(2);
  });

  test("filters by name", async () => {
    const response = await router.handle(
      makeRequest("/assistants/count", "POST", { name: "Two" }),
    );
    const body = await jsonBody<number>(response);
    expect(body).toBe(1);
  });

  test("returns 0 for no matches", async () => {
    const response = await router.handle(
      makeRequest("/assistants/count", "POST", {
        graph_id: "nonexistent",
      }),
    );
    const body = await jsonBody<number>(response);
    expect(body).toBe(0);
  });

  test("accepts empty body without Content-Type (lenient parsing)", async () => {
    const response = await router.handle(
      new Request("http://localhost:3000/assistants/count", {
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
  test("GET /assistants returns 405 (no GET all endpoint)", async () => {
    const response = await router.handle(makeRequest("/assistants"));
    // The router doesn't have GET /assistants registered, only POST
    // This should be 405 because POST /assistants exists at that path
    expect(response.status).toBe(405);
  });

  test("PUT /assistants/:id returns 405", async () => {
    const response = await router.handle(
      makeRequest(`/assistants/${crypto.randomUUID()}`, "PUT"),
    );
    expect(response.status).toBe(405);
  });

  test("POST /assistants/:id returns 405", async () => {
    const response = await router.handle(
      new Request(
        `http://localhost:3000/assistants/${crypto.randomUUID()}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      ),
    );
    expect(response.status).toBe(405);
  });

  test("GET /assistants/search returns 404 (matched as GET /assistants/:assistant_id with id='search')", async () => {
    const response = await router.handle(
      makeRequest("/assistants/search"),
    );
    // The param route GET /assistants/:assistant_id captures "search" as an ID.
    // No assistant with id "search" exists → 404.
    expect(response.status).toBe(404);
  });

  test("GET /assistants/count returns 404 (matched as GET /assistants/:assistant_id with id='count')", async () => {
    const response = await router.handle(
      makeRequest("/assistants/count"),
    );
    // The param route GET /assistants/:assistant_id captures "count" as an ID.
    // No assistant with id "count" exists → 404.
    expect(response.status).toBe(404);
  });
});

// ===========================================================================
// End-to-end CRUD flow
// ===========================================================================

describe("end-to-end CRUD flow", () => {
  test("create → get → patch → get → delete → get (404)", async () => {
    // 1. Create
    const createResp = await router.handle(
      makeRequest("/assistants", "POST", {
        graph_id: "agent",
        name: "E2E Assistant",
        metadata: { step: "created" },
      }),
    );
    expect(createResp.status).toBe(200);
    const created = await jsonBody<AssistantResponse>(createResp);
    const id = created.assistant_id;
    expect(created.name).toBe("E2E Assistant");
    expect(created.version).toBe(1);

    // 2. Get
    const getResp1 = await router.handle(makeRequest(`/assistants/${id}`));
    expect(getResp1.status).toBe(200);
    const fetched = await jsonBody<AssistantResponse>(getResp1);
    expect(fetched.name).toBe("E2E Assistant");

    // 3. Patch
    const patchResp = await router.handle(
      makeRequest(`/assistants/${id}`, "PATCH", {
        name: "Updated E2E",
        metadata: { step: "patched" },
      }),
    );
    expect(patchResp.status).toBe(200);
    const patched = await jsonBody<AssistantResponse>(patchResp);
    expect(patched.name).toBe("Updated E2E");
    expect(patched.version).toBe(2);
    expect(patched.metadata).toEqual({ step: "patched" });

    // 4. Get again — see changes
    const getResp2 = await router.handle(makeRequest(`/assistants/${id}`));
    const refetched = await jsonBody<AssistantResponse>(getResp2);
    expect(refetched.name).toBe("Updated E2E");
    expect(refetched.version).toBe(2);

    // 5. Verify it appears in search
    const searchResp = await router.handle(
      makeRequest("/assistants/search", "POST", { name: "Updated" }),
    );
    const searchResults = await jsonBody<AssistantResponse[]>(searchResp);
    expect(searchResults.length).toBe(1);
    expect(searchResults[0].assistant_id).toBe(id);

    // 6. Verify count
    const countResp = await router.handle(
      makeRequest("/assistants/count", "POST", {}),
    );
    const count = await jsonBody<number>(countResp);
    expect(count).toBe(1);

    // 7. Delete
    const deleteResp = await router.handle(
      makeRequest(`/assistants/${id}`, "DELETE"),
    );
    expect(deleteResp.status).toBe(200);
    const deleteBody = await jsonBody<Record<string, unknown>>(deleteResp);
    expect(deleteBody).toEqual({});

    // 8. Get after delete — 404
    const getResp3 = await router.handle(makeRequest(`/assistants/${id}`));
    expect(getResp3.status).toBe(404);

    // 9. Count after delete — 0
    const countResp2 = await router.handle(
      makeRequest("/assistants/count", "POST", {}),
    );
    const count2 = await jsonBody<number>(countResp2);
    expect(count2).toBe(0);
  });
});

// ===========================================================================
// Route disambiguation — /assistants/search and /assistants/count
// must NOT be captured as /assistants/:assistant_id
// ===========================================================================

describe("route disambiguation", () => {
  test("POST /assistants/search is not treated as GET /assistants/:assistant_id", async () => {
    const response = await router.handle(
      makeRequest("/assistants/search", "POST", {}),
    );
    // Should be 200 (search results), not 405 or some other error
    expect(response.status).toBe(200);
    const body = await jsonBody<unknown[]>(response);
    expect(Array.isArray(body)).toBe(true);
  });

  test("POST /assistants/count is not treated as GET /assistants/:assistant_id", async () => {
    const response = await router.handle(
      makeRequest("/assistants/count", "POST", {}),
    );
    expect(response.status).toBe(200);
    const body = await jsonBody<number>(response);
    expect(typeof body).toBe("number");
  });

  test("GET /assistants/search returns 404 (param route captures 'search' as ID)", async () => {
    // GET /assistants/:assistant_id matches with assistant_id="search",
    // which doesn't exist → 404. The static POST /assistants/search route
    // only applies to POST requests.
    const response = await router.handle(
      makeRequest("/assistants/search"),
    );
    expect(response.status).toBe(404);
  });

  test("GET /assistants/count returns 404 (param route captures 'count' as ID)", async () => {
    const response = await router.handle(
      makeRequest("/assistants/count"),
    );
    expect(response.status).toBe(404);
  });
});
