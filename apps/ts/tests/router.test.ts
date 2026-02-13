/**
 * Tests for the pattern-matching Router — Fractal Agents Runtime TypeScript/Bun.
 *
 * Covers:
 *   - Static route matching
 *   - Path parameter extraction
 *   - Method-based dispatch (GET, POST, PATCH, DELETE)
 *   - Trailing-slash normalization
 *   - 404 for unknown paths
 *   - 405 when path matches but method doesn't
 *   - Error boundary (handler exceptions → 500 JSON)
 *   - Query parameter forwarding
 *   - Route introspection (listRoutes, routeCount)
 *   - splitPath and matchSegments utilities
 */

import { describe, expect, test } from "bun:test";
import { Router, splitPath, matchSegments } from "../src/router";
import { jsonResponse } from "../src/routes/helpers";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(
  path: string,
  method = "GET",
  body?: string,
): Request {
  const options: RequestInit = { method };
  if (body !== undefined) {
    options.body = body;
    options.headers = { "Content-Type": "application/json" };
  }
  return new Request(`http://localhost:3000${path}`, options);
}

async function jsonBody(response: Response): Promise<unknown> {
  return response.json();
}

// ---------------------------------------------------------------------------
// splitPath utility
// ---------------------------------------------------------------------------

describe("splitPath", () => {
  test("root path returns empty array", () => {
    expect(splitPath("/")).toEqual([]);
  });

  test("empty string returns empty array", () => {
    expect(splitPath("")).toEqual([]);
  });

  test("single segment", () => {
    expect(splitPath("/health")).toEqual(["health"]);
  });

  test("multiple segments", () => {
    expect(splitPath("/threads/abc/runs")).toEqual(["threads", "abc", "runs"]);
  });

  test("strips trailing slash", () => {
    expect(splitPath("/health/")).toEqual(["health"]);
  });

  test("handles double slashes", () => {
    expect(splitPath("/threads//abc")).toEqual(["threads", "abc"]);
  });

  test("parameterized pattern", () => {
    expect(splitPath("/threads/:thread_id/runs/:run_id")).toEqual([
      "threads",
      ":thread_id",
      "runs",
      ":run_id",
    ]);
  });
});

// ---------------------------------------------------------------------------
// matchSegments utility
// ---------------------------------------------------------------------------

describe("matchSegments", () => {
  test("static segments match exactly", () => {
    const result = matchSegments(["health"], ["health"]);
    expect(result).toEqual({});
  });

  test("static segments mismatch returns null", () => {
    const result = matchSegments(["health"], ["info"]);
    expect(result).toBeNull();
  });

  test("length mismatch returns null", () => {
    const result = matchSegments(["threads", ":id"], ["threads"]);
    expect(result).toBeNull();
  });

  test("empty segments match (root path)", () => {
    const result = matchSegments([], []);
    expect(result).toEqual({});
  });

  test("single param extraction", () => {
    const result = matchSegments(["threads", ":thread_id"], ["threads", "abc-123"]);
    expect(result).toEqual({ thread_id: "abc-123" });
  });

  test("multiple param extraction", () => {
    const result = matchSegments(
      ["threads", ":thread_id", "runs", ":run_id"],
      ["threads", "t-1", "runs", "r-2"],
    );
    expect(result).toEqual({ thread_id: "t-1", run_id: "r-2" });
  });

  test("decodes URI-encoded param values", () => {
    const result = matchSegments(
      ["items", ":item_id"],
      ["items", "hello%20world"],
    );
    expect(result).toEqual({ item_id: "hello world" });
  });

  test("mixed static and param segments", () => {
    const result = matchSegments(
      ["threads", ":thread_id", "runs", ":run_id", "cancel"],
      ["threads", "t-1", "runs", "r-2", "cancel"],
    );
    expect(result).toEqual({ thread_id: "t-1", run_id: "r-2" });
  });

  test("static mismatch in middle returns null", () => {
    const result = matchSegments(
      ["threads", ":thread_id", "runs"],
      ["threads", "t-1", "state"],
    );
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Router — static route matching
// ---------------------------------------------------------------------------

describe("Router — static routes", () => {
  test("GET /health returns 200", async () => {
    const router = new Router();
    router.get("/health", () => jsonResponse({ status: "ok" }));

    const response = await router.handle(makeRequest("/health"));
    expect(response.status).toBe(200);
    expect(await jsonBody(response)).toEqual({ status: "ok" });
  });

  test("root path / matches", async () => {
    const router = new Router();
    router.get("/", () => jsonResponse({ root: true }));

    const response = await router.handle(makeRequest("/"));
    expect(response.status).toBe(200);
    expect(await jsonBody(response)).toEqual({ root: true });
  });

  test("trailing slash is normalized", async () => {
    const router = new Router();
    router.get("/health", () => jsonResponse({ status: "ok" }));

    const response = await router.handle(makeRequest("/health/"));
    expect(response.status).toBe(200);
    expect(await jsonBody(response)).toEqual({ status: "ok" });
  });

  test("multiple static routes are distinguished", async () => {
    const router = new Router();
    router.get("/health", () => jsonResponse({ endpoint: "health" }));
    router.get("/info", () => jsonResponse({ endpoint: "info" }));
    router.get("/ok", () => jsonResponse({ endpoint: "ok" }));

    const healthResponse = await router.handle(makeRequest("/health"));
    expect(await jsonBody(healthResponse)).toEqual({ endpoint: "health" });

    const infoResponse = await router.handle(makeRequest("/info"));
    expect(await jsonBody(infoResponse)).toEqual({ endpoint: "info" });

    const okResponse = await router.handle(makeRequest("/ok"));
    expect(await jsonBody(okResponse)).toEqual({ endpoint: "ok" });
  });
});

// ---------------------------------------------------------------------------
// Router — path parameter extraction
// ---------------------------------------------------------------------------

describe("Router — path parameters", () => {
  test("extracts single path param", async () => {
    const router = new Router();
    router.get("/threads/:thread_id", (_req, params) =>
      jsonResponse({ thread_id: params.thread_id }),
    );

    const response = await router.handle(makeRequest("/threads/abc-123"));
    expect(response.status).toBe(200);
    expect(await jsonBody(response)).toEqual({ thread_id: "abc-123" });
  });

  test("extracts multiple path params", async () => {
    const router = new Router();
    router.get("/threads/:thread_id/runs/:run_id", (_req, params) =>
      jsonResponse({ thread_id: params.thread_id, run_id: params.run_id }),
    );

    const response = await router.handle(
      makeRequest("/threads/t-1/runs/r-2"),
    );
    expect(response.status).toBe(200);
    expect(await jsonBody(response)).toEqual({
      thread_id: "t-1",
      run_id: "r-2",
    });
  });

  test("nested param route with trailing static segment", async () => {
    const router = new Router();
    router.post(
      "/threads/:thread_id/runs/:run_id/cancel",
      (_req, params) =>
        jsonResponse({
          action: "cancel",
          thread_id: params.thread_id,
          run_id: params.run_id,
        }),
    );

    const response = await router.handle(
      makeRequest("/threads/t-1/runs/r-2/cancel", "POST"),
    );
    expect(response.status).toBe(200);
    expect(await jsonBody(response)).toEqual({
      action: "cancel",
      thread_id: "t-1",
      run_id: "r-2",
    });
  });

  test("params are URI-decoded", async () => {
    const router = new Router();
    router.get("/items/:item_id", (_req, params) =>
      jsonResponse({ item_id: params.item_id }),
    );

    const response = await router.handle(
      makeRequest("/items/hello%20world"),
    );
    expect(await jsonBody(response)).toEqual({ item_id: "hello world" });
  });
});

// ---------------------------------------------------------------------------
// Router — method dispatch
// ---------------------------------------------------------------------------

describe("Router — method dispatch", () => {
  test("same path, different methods dispatch correctly", async () => {
    const router = new Router();
    router.get("/threads/:id", () => jsonResponse({ action: "get" }));
    router.patch("/threads/:id", () => jsonResponse({ action: "patch" }));
    router.delete("/threads/:id", () => jsonResponse({ action: "delete" }));

    const getResponse = await router.handle(makeRequest("/threads/123", "GET"));
    expect(await jsonBody(getResponse)).toEqual({ action: "get" });

    const patchResponse = await router.handle(
      makeRequest("/threads/123", "PATCH"),
    );
    expect(await jsonBody(patchResponse)).toEqual({ action: "patch" });

    const deleteResponse = await router.handle(
      makeRequest("/threads/123", "DELETE"),
    );
    expect(await jsonBody(deleteResponse)).toEqual({ action: "delete" });
  });

  test("POST method works", async () => {
    const router = new Router();
    router.post("/assistants", () => jsonResponse({ created: true }, 200));

    const response = await router.handle(
      makeRequest("/assistants", "POST", '{"name": "test"}'),
    );
    expect(response.status).toBe(200);
    expect(await jsonBody(response)).toEqual({ created: true });
  });

  test("PUT method works", async () => {
    const router = new Router();
    router.put("/items/:id", () => jsonResponse({ updated: true }));

    const response = await router.handle(makeRequest("/items/1", "PUT"));
    expect(response.status).toBe(200);
    expect(await jsonBody(response)).toEqual({ updated: true });
  });
});

// ---------------------------------------------------------------------------
// Router — 404 Not Found
// ---------------------------------------------------------------------------

describe("Router — 404 handling", () => {
  test("unknown path returns 404", async () => {
    const router = new Router();
    router.get("/health", () => jsonResponse({ status: "ok" }));

    const response = await router.handle(makeRequest("/nonexistent"));
    expect(response.status).toBe(404);

    const body = await jsonBody(response) as { detail: string };
    expect(body.detail).toBe("Not found");
  });

  test("partial path match returns 404", async () => {
    const router = new Router();
    router.get("/threads/:thread_id/runs/:run_id", () =>
      jsonResponse({ ok: true }),
    );

    // Only two segments instead of four.
    const response = await router.handle(makeRequest("/threads/t-1"));
    expect(response.status).toBe(404);
  });

  test("extra segments beyond pattern returns 404", async () => {
    const router = new Router();
    router.get("/health", () => jsonResponse({ status: "ok" }));

    const response = await router.handle(makeRequest("/health/extra"));
    expect(response.status).toBe(404);
  });

  test("empty router returns 404 for any path", async () => {
    const router = new Router();

    const response = await router.handle(makeRequest("/anything"));
    expect(response.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Router — 405 Method Not Allowed
// ---------------------------------------------------------------------------

describe("Router — 405 handling", () => {
  test("correct path but wrong method returns 405", async () => {
    const router = new Router();
    router.get("/health", () => jsonResponse({ status: "ok" }));

    const response = await router.handle(makeRequest("/health", "POST"));
    expect(response.status).toBe(405);

    const body = await jsonBody(response) as { detail: string };
    expect(body.detail).toBe("Method not allowed");
  });

  test("DELETE on GET-only route returns 405", async () => {
    const router = new Router();
    router.get("/info", () => jsonResponse({ info: true }));

    const response = await router.handle(makeRequest("/info", "DELETE"));
    expect(response.status).toBe(405);
  });

  test("GET on POST-only route returns 405", async () => {
    const router = new Router();
    router.post("/assistants", () => jsonResponse({ created: true }));

    const response = await router.handle(makeRequest("/assistants", "GET"));
    expect(response.status).toBe(405);
  });

  test("405 on parameterized route", async () => {
    const router = new Router();
    router.get("/threads/:thread_id", () => jsonResponse({ ok: true }));

    const response = await router.handle(
      makeRequest("/threads/abc", "DELETE"),
    );
    expect(response.status).toBe(405);
  });
});

// ---------------------------------------------------------------------------
// Router — error boundary
// ---------------------------------------------------------------------------

describe("Router — error boundary", () => {
  test("sync handler exception returns 500 JSON error", async () => {
    const router = new Router();
    router.get("/boom", () => {
      throw new Error("Something broke");
    });

    const response = await router.handle(makeRequest("/boom"));
    expect(response.status).toBe(500);

    const body = await jsonBody(response) as { detail: string };
    expect(body.detail).toBe("Something broke");
  });

  test("async handler rejection returns 500 JSON error", async () => {
    const router = new Router();
    router.get("/async-boom", async () => {
      throw new Error("Async failure");
    });

    const response = await router.handle(makeRequest("/async-boom"));
    expect(response.status).toBe(500);

    const body = await jsonBody(response) as { detail: string };
    expect(body.detail).toBe("Async failure");
  });

  test("non-Error throw returns generic 500 message", async () => {
    const router = new Router();
    router.get("/throw-string", () => {
      throw "not an Error object";
    });

    const response = await router.handle(makeRequest("/throw-string"));
    expect(response.status).toBe(500);

    const body = await jsonBody(response) as { detail: string };
    expect(body.detail).toBe("Internal server error");
  });

  test("error boundary returns JSON content type", async () => {
    const router = new Router();
    router.get("/error-content-type", () => {
      throw new Error("check headers");
    });

    const response = await router.handle(makeRequest("/error-content-type"));
    expect(response.headers.get("Content-Type")).toBe("application/json");
  });
});

// ---------------------------------------------------------------------------
// Router — query parameter forwarding
// ---------------------------------------------------------------------------

describe("Router — query parameters", () => {
  test("query params are passed to handler", async () => {
    const router = new Router();
    router.get("/search", (_req, _params, query) =>
      jsonResponse({
        query_param: query.get("q"),
        limit: query.get("limit"),
      }),
    );

    const response = await router.handle(
      makeRequest("/search?q=hello&limit=10"),
    );
    expect(response.status).toBe(200);
    expect(await jsonBody(response)).toEqual({
      query_param: "hello",
      limit: "10",
    });
  });

  test("query params don't affect path matching", async () => {
    const router = new Router();
    router.get("/health", () => jsonResponse({ status: "ok" }));

    const response = await router.handle(
      makeRequest("/health?verbose=true"),
    );
    expect(response.status).toBe(200);
    expect(await jsonBody(response)).toEqual({ status: "ok" });
  });

  test("missing query params return null", async () => {
    const router = new Router();
    router.get("/search", (_req, _params, query) =>
      jsonResponse({ q: query.get("q") }),
    );

    const response = await router.handle(makeRequest("/search"));
    expect(await jsonBody(response)).toEqual({ q: null });
  });
});

// ---------------------------------------------------------------------------
// Router — async handlers
// ---------------------------------------------------------------------------

describe("Router — async handlers", () => {
  test("async handler is awaited", async () => {
    const router = new Router();
    router.get("/async", async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return jsonResponse({ async: true });
    });

    const response = await router.handle(makeRequest("/async"));
    expect(response.status).toBe(200);
    expect(await jsonBody(response)).toEqual({ async: true });
  });
});

// ---------------------------------------------------------------------------
// Router — introspection
// ---------------------------------------------------------------------------

describe("Router — introspection", () => {
  test("routeCount reports number of registered routes", () => {
    const router = new Router();
    expect(router.routeCount).toBe(0);

    router.get("/a", () => jsonResponse({}));
    router.post("/b", () => jsonResponse({}));
    router.delete("/c", () => jsonResponse({}));
    expect(router.routeCount).toBe(3);
  });

  test("listRoutes returns method and pattern for all routes", () => {
    const router = new Router();
    router.get("/health", () => jsonResponse({}));
    router.post("/assistants", () => jsonResponse({}));
    router.patch("/threads/:thread_id", () => jsonResponse({}));

    const routes = router.listRoutes();
    expect(routes).toEqual([
      { method: "GET", pattern: "/health" },
      { method: "POST", pattern: "/assistants" },
      { method: "PATCH", pattern: "/threads/:thread_id" },
    ]);
  });

  test("addRoute chaining works", () => {
    const router = new Router();
    const result = router
      .get("/a", () => jsonResponse({}))
      .post("/b", () => jsonResponse({}))
      .delete("/c", () => jsonResponse({}));

    expect(result).toBe(router);
    expect(router.routeCount).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Router — response content type
// ---------------------------------------------------------------------------

describe("Router — response headers", () => {
  test("404 response has JSON content type", async () => {
    const router = new Router();
    const response = await router.handle(makeRequest("/missing"));
    expect(response.headers.get("Content-Type")).toBe("application/json");
  });

  test("405 response has JSON content type", async () => {
    const router = new Router();
    router.get("/only-get", () => jsonResponse({}));
    const response = await router.handle(makeRequest("/only-get", "POST"));
    expect(response.headers.get("Content-Type")).toBe("application/json");
  });
});

// ---------------------------------------------------------------------------
// Router — first match wins
// ---------------------------------------------------------------------------

describe("Router — match ordering", () => {
  test("first registered route wins when multiple match", async () => {
    const router = new Router();
    router.get("/items/:id", () => jsonResponse({ handler: "first" }));
    router.get("/items/:item_id", () => jsonResponse({ handler: "second" }));

    const response = await router.handle(makeRequest("/items/123"));
    expect(await jsonBody(response)).toEqual({ handler: "first" });
  });
});
