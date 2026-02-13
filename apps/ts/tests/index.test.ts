/**
 * Tests for the system endpoints — Fractal Agents Runtime TypeScript/Bun (v0.0.1).
 *
 * Validates that every system route returns the exact response shape
 * defined in the Python runtime's OpenAPI spec:
 *
 *   GET /            → { service, runtime, version }
 *   GET /health      → { status: "ok" }
 *   GET /ok          → { ok: true }
 *   GET /info        → { service, runtime, version, build, capabilities, graphs, config, tiers }
 *   GET /openapi.json → OpenAPI 3.1 spec document
 *
 * Also tests 404/405 error shapes match ErrorResponse: { detail: string }
 *
 * Reference: apps/python/openapi-spec.json
 */

import { describe, expect, test } from "bun:test";
import { router } from "../src/index";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(path: string, method = "GET"): Request {
  return new Request(`http://localhost:3000${path}`, { method });
}

async function jsonBody<T = Record<string, unknown>>(
  response: Response,
): Promise<T> {
  return response.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// GET / — Root endpoint
// ---------------------------------------------------------------------------

describe("GET /", () => {
  test("returns 200", async () => {
    const response = await router.handle(makeRequest("/"));
    expect(response.status).toBe(200);
  });

  test("returns JSON content type", async () => {
    const response = await router.handle(makeRequest("/"));
    expect(response.headers.get("Content-Type")).toBe("application/json");
  });

  test("response matches Python spec shape: { service, runtime, version }", async () => {
    const response = await router.handle(makeRequest("/"));
    const body = await jsonBody(response);

    expect(body).toHaveProperty("service");
    expect(body).toHaveProperty("runtime");
    expect(body).toHaveProperty("version");
  });

  test("service is fractal-agents-runtime-ts", async () => {
    const response = await router.handle(makeRequest("/"));
    const body = await jsonBody(response);
    expect(body.service).toBe("fractal-agents-runtime-ts");
  });

  test("runtime is bun", async () => {
    const response = await router.handle(makeRequest("/"));
    const body = await jsonBody(response);
    expect(body.runtime).toBe("bun");
  });

  test("version is 0.0.1", async () => {
    const response = await router.handle(makeRequest("/"));
    const body = await jsonBody(response);
    expect(body.version).toBe("0.0.1");
  });

  test("trailing slash is normalized", async () => {
    const response = await router.handle(makeRequest("//"));
    // Root path with double slash still resolves to empty segments → root
    expect(response.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// GET /health — Health check
// ---------------------------------------------------------------------------

describe("GET /health", () => {
  test("returns 200", async () => {
    const response = await router.handle(makeRequest("/health"));
    expect(response.status).toBe(200);
  });

  test("returns { status: 'ok' } matching HealthResponse schema", async () => {
    const response = await router.handle(makeRequest("/health"));
    const body = await jsonBody(response);
    expect(body).toEqual({ status: "ok" });
  });

  test("trailing slash is normalized", async () => {
    const response = await router.handle(makeRequest("/health/"));
    expect(response.status).toBe(200);
    const body = await jsonBody(response);
    expect(body).toEqual({ status: "ok" });
  });

  test("response has JSON content type", async () => {
    const response = await router.handle(makeRequest("/health"));
    expect(response.headers.get("Content-Type")).toBe("application/json");
  });
});

// ---------------------------------------------------------------------------
// GET /ok — Simple OK check
// ---------------------------------------------------------------------------

describe("GET /ok", () => {
  test("returns 200", async () => {
    const response = await router.handle(makeRequest("/ok"));
    expect(response.status).toBe(200);
  });

  test("returns { ok: true } matching OkResponse schema (ok is const true)", async () => {
    const response = await router.handle(makeRequest("/ok"));
    const body = await jsonBody(response);
    expect(body).toEqual({ ok: true });
  });

  test("ok field is boolean true, not truthy string", async () => {
    const response = await router.handle(makeRequest("/ok"));
    const body = await jsonBody(response);
    expect(body.ok).toBeTrue();
    expect(typeof body.ok).toBe("boolean");
  });

  test("response has JSON content type", async () => {
    const response = await router.handle(makeRequest("/ok"));
    expect(response.headers.get("Content-Type")).toBe("application/json");
  });
});

// ---------------------------------------------------------------------------
// GET /info — Detailed service information
// ---------------------------------------------------------------------------

describe("GET /info", () => {
  test("returns 200", async () => {
    const response = await router.handle(makeRequest("/info"));
    expect(response.status).toBe(200);
  });

  test("response has JSON content type", async () => {
    const response = await router.handle(makeRequest("/info"));
    expect(response.headers.get("Content-Type")).toBe("application/json");
  });

  test("contains top-level fields matching Python spec", async () => {
    const response = await router.handle(makeRequest("/info"));
    const body = await jsonBody(response);

    expect(body).toHaveProperty("service");
    expect(body).toHaveProperty("runtime");
    expect(body).toHaveProperty("version");
    expect(body).toHaveProperty("build");
    expect(body).toHaveProperty("capabilities");
    expect(body).toHaveProperty("graphs");
    expect(body).toHaveProperty("config");
    expect(body).toHaveProperty("tiers");
  });

  test("service, runtime, version match root endpoint", async () => {
    const response = await router.handle(makeRequest("/info"));
    const body = await jsonBody(response);

    expect(body.service).toBe("fractal-agents-runtime-ts");
    expect(body.runtime).toBe("bun");
    expect(body.version).toBe("0.0.1");
  });

  // --- build ---

  test("build object has commit, date, bun fields", async () => {
    const response = await router.handle(makeRequest("/info"));
    const body = await jsonBody(response);
    const build = body.build as Record<string, string>;

    expect(build).toHaveProperty("commit");
    expect(build).toHaveProperty("date");
    expect(build).toHaveProperty("bun");
    expect(typeof build.commit).toBe("string");
    expect(typeof build.date).toBe("string");
    expect(typeof build.bun).toBe("string");
  });

  test("build.bun reports a version string", async () => {
    const response = await router.handle(makeRequest("/info"));
    const body = await jsonBody(response);
    const build = body.build as Record<string, string>;

    // Bun version should look like a semver (e.g., "1.2.3")
    expect(build.bun).toMatch(/^\d+\.\d+/);
  });

  // --- capabilities ---

  test("capabilities object has all required boolean fields", async () => {
    const response = await router.handle(makeRequest("/info"));
    const body = await jsonBody(response);
    const capabilities = body.capabilities as Record<string, boolean>;

    expect(typeof capabilities.streaming).toBe("boolean");
    expect(typeof capabilities.store).toBe("boolean");
    expect(typeof capabilities.crons).toBe("boolean");
    expect(typeof capabilities.a2a).toBe("boolean");
    expect(typeof capabilities.mcp).toBe("boolean");
    expect(typeof capabilities.metrics).toBe("boolean");
  });

  test("v0.0.1 capabilities: streaming=true, all others false", async () => {
    const response = await router.handle(makeRequest("/info"));
    const body = await jsonBody(response);
    const capabilities = body.capabilities as Record<string, boolean>;

    expect(capabilities.streaming).toBeTrue();
    expect(capabilities.store).toBeFalse();
    expect(capabilities.crons).toBeFalse();
    expect(capabilities.a2a).toBeFalse();
    expect(capabilities.mcp).toBeFalse();
    expect(capabilities.metrics).toBeFalse();
  });

  // --- graphs ---

  test("graphs is an array of strings", async () => {
    const response = await router.handle(makeRequest("/info"));
    const body = await jsonBody(response);
    const graphs = body.graphs as string[];

    expect(Array.isArray(graphs)).toBeTrue();
    for (const graphId of graphs) {
      expect(typeof graphId).toBe("string");
    }
  });

  test("graphs contains agent in v0.0.1", async () => {
    const response = await router.handle(makeRequest("/info"));
    const body = await jsonBody(response);
    const graphs = body.graphs as string[];

    expect(graphs).toContain("agent");
  });

  // --- config ---

  test("config object has supabase_configured and llm_configured booleans", async () => {
    const response = await router.handle(makeRequest("/info"));
    const body = await jsonBody(response);
    const configStatus = body.config as Record<string, boolean>;

    expect(typeof configStatus.supabase_configured).toBe("boolean");
    expect(typeof configStatus.llm_configured).toBe("boolean");
  });

  test("supabase_configured is false in v0.0.1 (no auth)", async () => {
    const response = await router.handle(makeRequest("/info"));
    const body = await jsonBody(response);
    const configStatus = body.config as Record<string, boolean>;

    expect(configStatus.supabase_configured).toBeFalse();
  });

  // --- tiers ---

  test("tiers object has tier1 (bool), tier2 (bool), tier3 (string)", async () => {
    const response = await router.handle(makeRequest("/info"));
    const body = await jsonBody(response);
    const tiers = body.tiers as Record<string, unknown>;

    expect(typeof tiers.tier1).toBe("boolean");
    expect(typeof tiers.tier2).toBe("boolean");
    expect(typeof tiers.tier3).toBe("string");
  });

  test("v0.0.1 tiers: tier1=true (core API), tier2=false, tier3=not_started", async () => {
    const response = await router.handle(makeRequest("/info"));
    const body = await jsonBody(response);
    const tiers = body.tiers as { tier1: boolean; tier2: boolean; tier3: string };

    expect(tiers.tier1).toBeTrue();
    expect(tiers.tier2).toBeFalse();
    expect(tiers.tier3).toBe("not_started");
  });
});

// ---------------------------------------------------------------------------
// GET /openapi.json — OpenAPI specification
// ---------------------------------------------------------------------------

describe("GET /openapi.json", () => {
  test("returns 200", async () => {
    const response = await router.handle(makeRequest("/openapi.json"));
    expect(response.status).toBe(200);
  });

  test("response has JSON content type", async () => {
    const response = await router.handle(makeRequest("/openapi.json"));
    expect(response.headers.get("Content-Type")).toBe("application/json");
  });

  test("returns valid OpenAPI 3.1 spec", async () => {
    const response = await router.handle(makeRequest("/openapi.json"));
    const body = await jsonBody(response);

    expect(body.openapi).toBe("3.1.0");
  });

  test("spec info has correct title and version", async () => {
    const response = await router.handle(makeRequest("/openapi.json"));
    const body = await jsonBody(response);
    const info = body.info as Record<string, string>;

    expect(info.title).toContain("Fractal Agents Runtime");
    expect(info.version).toBe("0.0.1");
  });

  test("spec contains system endpoint paths", async () => {
    const response = await router.handle(makeRequest("/openapi.json"));
    const body = await jsonBody(response);
    const paths = body.paths as Record<string, unknown>;

    expect(paths).toHaveProperty("/");
    expect(paths).toHaveProperty("/health");
    expect(paths).toHaveProperty("/ok");
    expect(paths).toHaveProperty("/info");
    expect(paths).toHaveProperty(["/openapi.json"]);
  });

  test("spec has components.schemas with ErrorResponse, HealthResponse, OkResponse", async () => {
    const response = await router.handle(makeRequest("/openapi.json"));
    const body = await jsonBody(response);
    const components = body.components as { schemas: Record<string, unknown> };

    expect(components).toHaveProperty("schemas");
    expect(components.schemas).toHaveProperty("ErrorResponse");
    expect(components.schemas).toHaveProperty("HealthResponse");
    expect(components.schemas).toHaveProperty("OkResponse");
  });

  test("ErrorResponse schema matches Python spec: required detail string", async () => {
    const response = await router.handle(makeRequest("/openapi.json"));
    const body = await jsonBody(response);
    const components = body.components as {
      schemas: Record<string, Record<string, unknown>>;
    };
    const errorSchema = components.schemas.ErrorResponse as {
      type: string;
      required: string[];
      properties: Record<string, { type: string }>;
    };

    expect(errorSchema.type).toBe("object");
    expect(errorSchema.required).toContain("detail");
    expect(errorSchema.properties.detail.type).toBe("string");
  });

  test("spec has tags array", async () => {
    const response = await router.handle(makeRequest("/openapi.json"));
    const body = await jsonBody(response);
    const tags = body.tags as Array<{ name: string }>;

    expect(Array.isArray(tags)).toBeTrue();
    expect(tags.length).toBeGreaterThan(0);
    expect(tags.some((tag) => tag.name === "System")).toBeTrue();
  });
});

// ---------------------------------------------------------------------------
// 404 Not Found — ErrorResponse shape
// ---------------------------------------------------------------------------

describe("404 handling", () => {
  test("unknown path returns 404", async () => {
    const response = await router.handle(makeRequest("/nonexistent"));
    expect(response.status).toBe(404);
  });

  test("404 response matches ErrorResponse: { detail: string }", async () => {
    const response = await router.handle(makeRequest("/nonexistent"));
    const body = await jsonBody(response);

    expect(body).toHaveProperty("detail");
    expect(body.detail).toBe("Not found");
  });

  test("404 response has JSON content type", async () => {
    const response = await router.handle(makeRequest("/nonexistent"));
    expect(response.headers.get("Content-Type")).toBe("application/json");
  });

  test("deeply nested unknown path returns 404", async () => {
    const response = await router.handle(
      makeRequest("/some/deeply/nested/unknown/path"),
    );
    expect(response.status).toBe(404);
    const body = await jsonBody(response);
    expect(body.detail).toBe("Not found");
  });
});

// ---------------------------------------------------------------------------
// 405 Method Not Allowed — ErrorResponse shape
// ---------------------------------------------------------------------------

describe("405 handling", () => {
  test("POST to GET-only system route returns 405", async () => {
    const response = await router.handle(makeRequest("/health", "POST"));
    expect(response.status).toBe(405);
  });

  test("405 response matches ErrorResponse: { detail: string }", async () => {
    const response = await router.handle(makeRequest("/health", "POST"));
    const body = await jsonBody(response);

    expect(body).toHaveProperty("detail");
    expect(body.detail).toBe("Method not allowed");
  });

  test("405 response has JSON content type", async () => {
    const response = await router.handle(makeRequest("/health", "POST"));
    expect(response.headers.get("Content-Type")).toBe("application/json");
  });

  test("PUT to /info returns 405", async () => {
    const response = await router.handle(makeRequest("/info", "PUT"));
    expect(response.status).toBe(405);
  });

  test("DELETE to /ok returns 405", async () => {
    const response = await router.handle(makeRequest("/ok", "DELETE"));
    expect(response.status).toBe(405);
  });

  test("PATCH to / returns 405", async () => {
    const response = await router.handle(makeRequest("/", "PATCH"));
    expect(response.status).toBe(405);
  });

  test("DELETE to /openapi.json returns 405", async () => {
    const response = await router.handle(
      makeRequest("/openapi.json", "DELETE"),
    );
    expect(response.status).toBe(405);
  });
});

// ---------------------------------------------------------------------------
// Consistency checks across system endpoints
// ---------------------------------------------------------------------------

describe("Cross-endpoint consistency", () => {
  test("root and info return the same service name", async () => {
    const rootResponse = await router.handle(makeRequest("/"));
    const infoResponse = await router.handle(makeRequest("/info"));

    const rootBody = await jsonBody(rootResponse);
    const infoBody = await jsonBody(infoResponse);

    expect(rootBody.service).toBe(infoBody.service);
  });

  test("root and info return the same runtime", async () => {
    const rootResponse = await router.handle(makeRequest("/"));
    const infoResponse = await router.handle(makeRequest("/info"));

    const rootBody = await jsonBody(rootResponse);
    const infoBody = await jsonBody(infoResponse);

    expect(rootBody.runtime).toBe(infoBody.runtime);
  });

  test("root and info return the same version", async () => {
    const rootResponse = await router.handle(makeRequest("/"));
    const infoResponse = await router.handle(makeRequest("/info"));

    const rootBody = await jsonBody(rootResponse);
    const infoBody = await jsonBody(infoResponse);

    expect(rootBody.version).toBe(infoBody.version);
  });

  test("info version matches openapi spec version", async () => {
    const infoResponse = await router.handle(makeRequest("/info"));
    const specResponse = await router.handle(makeRequest("/openapi.json"));

    const infoBody = await jsonBody(infoResponse);
    const specBody = await jsonBody(specResponse);
    const specInfo = specBody.info as Record<string, string>;

    expect(infoBody.version).toBe(specInfo.version);
  });

  test("all system endpoints return JSON content type", async () => {
    const systemPaths = ["/", "/health", "/ok", "/info", "/openapi.json"];

    for (const path of systemPaths) {
      const response = await router.handle(makeRequest(path));
      expect(response.headers.get("Content-Type")).toBe("application/json");
    }
  });

  test("all system endpoints return 200 for GET", async () => {
    const systemPaths = ["/", "/health", "/ok", "/info", "/openapi.json"];

    for (const path of systemPaths) {
      const response = await router.handle(makeRequest(path));
      expect(response.status).toBe(200);
    }
  });
});
