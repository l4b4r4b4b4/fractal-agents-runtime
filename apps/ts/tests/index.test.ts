/**
 * Tests for the Fractal Agents Runtime — TypeScript/Bun HTTP Server (v0.0.0)
 */

import { describe, expect, test } from "bun:test";
import { handleRequest } from "../src/index";

function makeRequest(path: string, method = "GET"): Request {
  return new Request(`http://localhost:3000${path}`, { method });
}

describe("GET /health", () => {
  test("returns status ok", async () => {
    const response = handleRequest(makeRequest("/health"));
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body).toEqual({ status: "ok" });
  });

  test("root path also returns health", async () => {
    const response = handleRequest(makeRequest("/"));
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body).toEqual({ status: "ok" });
  });

  test("trailing slash is normalized", async () => {
    const response = handleRequest(makeRequest("/health/"));
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body).toEqual({ status: "ok" });
  });
});

describe("GET /info", () => {
  test("returns service metadata", async () => {
    const response = handleRequest(makeRequest("/info"));
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.service).toBe("fractal-agents-runtime-ts");
    expect(body.version).toBe("0.0.0");
    expect(body.runtime).toBe("bun");
    expect(body.bun_version).toBeString();
  });
});

describe("GET /openapi.json", () => {
  test("returns valid OpenAPI 3.1 spec", async () => {
    const response = handleRequest(makeRequest("/openapi.json"));
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.openapi).toBe("3.1.0");
    expect(body.info.title).toContain("Fractal Agents Runtime");
    expect(body.info.version).toBe("0.0.0");
    expect(body.paths).toHaveProperty(["/health"]);
    expect(body.paths).toHaveProperty(["/info"]);
    expect(body.paths).toHaveProperty(["/openapi.json"]);
  });

  test("response has json content type", async () => {
    const response = handleRequest(makeRequest("/openapi.json"));
    expect(response.headers.get("Content-Type")).toBe("application/json");
  });
});

describe("404 handling", () => {
  test("unknown path returns 404", async () => {
    const response = handleRequest(makeRequest("/nonexistent"));
    expect(response.status).toBe(404);

    const body = await response.json();
    expect(body.error).toBe("Not found");
  });
});

describe("method not allowed", () => {
  test("POST returns 405", async () => {
    const response = handleRequest(makeRequest("/health", "POST"));
    expect(response.status).toBe(405);

    const body = await response.json();
    expect(body.error).toBe("Method not allowed");
  });

  test("PUT returns 405", async () => {
    const response = handleRequest(makeRequest("/info", "PUT"));
    expect(response.status).toBe(405);

    const body = await response.json();
    expect(body.error).toBe("Method not allowed");
  });

  test("DELETE returns 405", async () => {
    const response = handleRequest(makeRequest("/openapi.json", "DELETE"));
    expect(response.status).toBe(405);

    const body = await response.json();
    expect(body.error).toBe("Method not allowed");
  });
});
