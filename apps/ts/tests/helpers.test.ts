/**
 * Tests for shared request/response helpers — Fractal Agents Runtime TypeScript/Bun.
 *
 * Covers:
 *   - jsonResponse: status codes, content type, body serialization, custom headers
 *   - errorResponse: ErrorResponse shape { detail: string }, status codes
 *   - notFound: 404 with correct detail message
 *   - methodNotAllowed: 405 with correct detail message
 *   - conflictResponse: 409 with correct detail message
 *   - validationError: 422 with detail and optional field errors
 *   - parseBody: valid JSON, empty body, invalid JSON
 *   - requireBody: content-type validation, missing body, valid body
 */

import { describe, expect, test } from "bun:test";
import {
  jsonResponse,
  errorResponse,
  notFound,
  methodNotAllowed,
  conflictResponse,
  validationError,
  parseBody,
  requireBody,
} from "../src/routes/helpers";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function jsonBody<T = Record<string, unknown>>(
  response: Response,
): Promise<T> {
  return response.json() as Promise<T>;
}

function makeJsonRequest(
  body: string,
  contentType = "application/json",
): Request {
  return new Request("http://localhost:3000/test", {
    method: "POST",
    headers: { "Content-Type": contentType },
    body,
  });
}

function makeEmptyRequest(): Request {
  return new Request("http://localhost:3000/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// jsonResponse
// ---------------------------------------------------------------------------

describe("jsonResponse", () => {
  test("returns 200 by default", () => {
    const response = jsonResponse({ hello: "world" });
    expect(response.status).toBe(200);
  });

  test("returns custom status code", () => {
    const response = jsonResponse({ created: true }, 201);
    expect(response.status).toBe(201);
  });

  test("sets Content-Type to application/json", () => {
    const response = jsonResponse({ key: "value" });
    expect(response.headers.get("Content-Type")).toBe("application/json");
  });

  test("serializes object body correctly", async () => {
    const response = jsonResponse({ status: "ok", count: 42 });
    const body = await jsonBody(response);
    expect(body).toEqual({ status: "ok", count: 42 });
  });

  test("serializes array body correctly", async () => {
    const response = jsonResponse([1, 2, 3]);
    const body = await jsonBody<number[]>(response);
    expect(body).toEqual([1, 2, 3]);
  });

  test("serializes null body", async () => {
    const response = jsonResponse(null);
    const text = await response.text();
    expect(text).toBe("null");
  });

  test("serializes string body as JSON string", async () => {
    const response = jsonResponse("hello");
    const text = await response.text();
    expect(text).toBe('"hello"');
  });

  test("serializes boolean body", async () => {
    const response = jsonResponse(true);
    const text = await response.text();
    expect(text).toBe("true");
  });

  test("serializes number body", async () => {
    const response = jsonResponse(42);
    const text = await response.text();
    expect(text).toBe("42");
  });

  test("merges custom headers", () => {
    const response = jsonResponse({ ok: true }, 200, {
      "X-Custom-Header": "test-value",
    });
    expect(response.headers.get("Content-Type")).toBe("application/json");
    expect(response.headers.get("X-Custom-Header")).toBe("test-value");
  });

  test("custom headers do not override Content-Type when not specified", () => {
    const response = jsonResponse({ ok: true }, 200, {
      "X-Other": "value",
    });
    expect(response.headers.get("Content-Type")).toBe("application/json");
  });

  test("handles nested objects", async () => {
    const data = {
      outer: { inner: { deep: "value" } },
      list: [{ id: 1 }, { id: 2 }],
    };
    const response = jsonResponse(data);
    const body = await jsonBody(response);
    expect(body).toEqual(data);
  });
});

// ---------------------------------------------------------------------------
// errorResponse
// ---------------------------------------------------------------------------

describe("errorResponse", () => {
  test("returns 500 by default", () => {
    const response = errorResponse("Something went wrong");
    expect(response.status).toBe(500);
  });

  test("returns custom status code", () => {
    const response = errorResponse("Bad request", 400);
    expect(response.status).toBe(400);
  });

  test("sets Content-Type to application/json", () => {
    const response = errorResponse("Error");
    expect(response.headers.get("Content-Type")).toBe("application/json");
  });

  test("body matches ErrorResponse shape: { detail: string }", async () => {
    const response = errorResponse("Something went wrong", 500);
    const body = await jsonBody(response);
    expect(body).toEqual({ detail: "Something went wrong" });
  });

  test("detail field contains the provided message", async () => {
    const response = errorResponse("Custom error message", 503);
    const body = await jsonBody(response);
    expect(body.detail).toBe("Custom error message");
  });

  test("body has only the detail field (no extra properties)", async () => {
    const response = errorResponse("Error");
    const body = await jsonBody(response);
    expect(Object.keys(body)).toEqual(["detail"]);
  });
});

// ---------------------------------------------------------------------------
// notFound
// ---------------------------------------------------------------------------

describe("notFound", () => {
  test("returns 404 status", () => {
    const response = notFound();
    expect(response.status).toBe(404);
  });

  test("default detail is 'Not found'", async () => {
    const response = notFound();
    const body = await jsonBody(response);
    expect(body.detail).toBe("Not found");
  });

  test("accepts custom detail message", async () => {
    const response = notFound("Thread not found");
    const body = await jsonBody(response);
    expect(body.detail).toBe("Thread not found");
  });

  test("response has JSON content type", () => {
    const response = notFound();
    expect(response.headers.get("Content-Type")).toBe("application/json");
  });

  test("body matches ErrorResponse shape", async () => {
    const response = notFound();
    const body = await jsonBody(response);
    expect(body).toHaveProperty("detail");
    expect(typeof body.detail).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// methodNotAllowed
// ---------------------------------------------------------------------------

describe("methodNotAllowed", () => {
  test("returns 405 status", () => {
    const response = methodNotAllowed();
    expect(response.status).toBe(405);
  });

  test("default detail is 'Method not allowed'", async () => {
    const response = methodNotAllowed();
    const body = await jsonBody(response);
    expect(body.detail).toBe("Method not allowed");
  });

  test("accepts custom detail message", async () => {
    const response = methodNotAllowed("Only GET is supported");
    const body = await jsonBody(response);
    expect(body.detail).toBe("Only GET is supported");
  });

  test("response has JSON content type", () => {
    const response = methodNotAllowed();
    expect(response.headers.get("Content-Type")).toBe("application/json");
  });
});

// ---------------------------------------------------------------------------
// conflictResponse
// ---------------------------------------------------------------------------

describe("conflictResponse", () => {
  test("returns 409 status", () => {
    const response = conflictResponse("Already exists");
    expect(response.status).toBe(409);
  });

  test("body matches ErrorResponse shape with detail", async () => {
    const response = conflictResponse("Assistant already exists");
    const body = await jsonBody(response);
    expect(body).toEqual({ detail: "Assistant already exists" });
  });

  test("response has JSON content type", () => {
    const response = conflictResponse("Conflict");
    expect(response.headers.get("Content-Type")).toBe("application/json");
  });
});

// ---------------------------------------------------------------------------
// validationError
// ---------------------------------------------------------------------------

describe("validationError", () => {
  test("returns 422 status", () => {
    const response = validationError("Invalid input");
    expect(response.status).toBe(422);
  });

  test("body has detail field", async () => {
    const response = validationError("Validation failed");
    const body = await jsonBody(response);
    expect(body.detail).toBe("Validation failed");
  });

  test("body has no errors field when none provided", async () => {
    const response = validationError("Missing field");
    const body = await jsonBody(response);
    expect(body).toEqual({ detail: "Missing field" });
    expect(body).not.toHaveProperty("errors");
  });

  test("body has no errors field when empty array provided", async () => {
    const response = validationError("Missing field", []);
    const body = await jsonBody(response);
    expect(body).not.toHaveProperty("errors");
  });

  test("body includes errors array when field errors provided", async () => {
    const fieldErrors = [
      { field: "body.assistant_id", message: "Must be a valid UUID" },
      { field: "body.graph_id", message: "Required field" },
    ];
    const response = validationError("Validation failed", fieldErrors);
    const body = await jsonBody(response);

    expect(body.detail).toBe("Validation failed");
    expect(body.errors).toEqual(fieldErrors);
  });

  test("response has JSON content type", () => {
    const response = validationError("Error");
    expect(response.headers.get("Content-Type")).toBe("application/json");
  });
});

// ---------------------------------------------------------------------------
// parseBody
// ---------------------------------------------------------------------------

describe("parseBody", () => {
  test("parses valid JSON body", async () => {
    const request = makeJsonRequest('{"name": "test", "value": 42}');
    const body = await parseBody(request);
    expect(body).toEqual({ name: "test", value: 42 });
  });

  test("parses JSON array body", async () => {
    const request = makeJsonRequest("[1, 2, 3]");
    const body = await parseBody(request);
    expect(body).toEqual([1, 2, 3]);
  });

  test("returns null for empty body", async () => {
    const request = makeJsonRequest("");
    const body = await parseBody(request);
    expect(body).toBeNull();
  });

  test("returns null for invalid JSON", async () => {
    const request = makeJsonRequest("not valid json {{{");
    const body = await parseBody(request);
    expect(body).toBeNull();
  });

  test("returns null for request with no body", async () => {
    const request = makeEmptyRequest();
    const body = await parseBody(request);
    expect(body).toBeNull();
  });

  test("parses nested objects", async () => {
    const data = { outer: { inner: "value" }, list: [1, 2] };
    const request = makeJsonRequest(JSON.stringify(data));
    const body = await parseBody(request);
    expect(body).toEqual(data);
  });

  test("supports generic type parameter", async () => {
    interface TestType {
      name: string;
      count: number;
    }
    const request = makeJsonRequest('{"name": "test", "count": 5}');
    const body = await parseBody<TestType>(request);
    expect(body).not.toBeNull();
    expect(body!.name).toBe("test");
    expect(body!.count).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// requireBody
// ---------------------------------------------------------------------------

describe("requireBody", () => {
  test("returns parsed body and null error for valid JSON request", async () => {
    const request = makeJsonRequest('{"name": "test"}');
    const [body, error] = await requireBody(request);

    expect(body).toEqual({ name: "test" });
    expect(error).toBeNull();
  });

  test("returns null body and 422 error for wrong Content-Type", async () => {
    const request = new Request("http://localhost:3000/test", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: '{"name": "test"}',
    });
    const [body, error] = await requireBody(request);

    expect(body).toBeNull();
    expect(error).not.toBeNull();
    expect(error!.status).toBe(422);

    const errorBody = await jsonBody(error!);
    expect(errorBody.detail).toBe("Content-Type must be application/json");
  });

  test("returns null body and 422 error for missing Content-Type", async () => {
    const request = new Request("http://localhost:3000/test", {
      method: "POST",
      body: '{"name": "test"}',
    });
    const [body, error] = await requireBody(request);

    expect(body).toBeNull();
    expect(error).not.toBeNull();
    expect(error!.status).toBe(422);
  });

  test("returns null body and 422 error for invalid JSON", async () => {
    const request = makeJsonRequest("not json");
    const [body, error] = await requireBody(request);

    expect(body).toBeNull();
    expect(error).not.toBeNull();
    expect(error!.status).toBe(422);

    const errorBody = await jsonBody(error!);
    expect(errorBody.detail).toBe("Request body must be valid JSON");
  });

  test("returns null body and 422 error for empty body", async () => {
    const request = makeJsonRequest("");
    const [body, error] = await requireBody(request);

    expect(body).toBeNull();
    expect(error).not.toBeNull();
    expect(error!.status).toBe(422);
  });

  test("accepts application/json with charset", async () => {
    const request = new Request("http://localhost:3000/test", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: '{"name": "test"}',
    });
    const [body, error] = await requireBody(request);

    expect(body).toEqual({ name: "test" });
    expect(error).toBeNull();
  });

  test("supports generic type parameter", async () => {
    interface CreateRequest {
      name: string;
      graph_id: string;
    }
    const request = makeJsonRequest(
      '{"name": "assistant", "graph_id": "react-agent"}',
    );
    const [body, error] = await requireBody<CreateRequest>(request);

    expect(error).toBeNull();
    expect(body).not.toBeNull();
    expect(body!.name).toBe("assistant");
    expect(body!.graph_id).toBe("react-agent");
  });
});
