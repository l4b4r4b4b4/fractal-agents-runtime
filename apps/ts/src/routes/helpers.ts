/**
 * Shared request/response helpers for the Fractal Agents Runtime — TypeScript/Bun.
 *
 * Every HTTP response from the runtime flows through these helpers to ensure
 * consistent Content-Type headers, status codes, and error shapes.
 *
 * Error responses match the Python runtime's ErrorResponse schema:
 *   { "detail": "Error message describing what went wrong." }
 *
 * See: apps/python/openapi-spec.json → components.schemas.ErrorResponse
 */

import type { ErrorResponse, ValidationErrorResponse, FieldError } from "../models/errors";

// ---------------------------------------------------------------------------
// Success responses
// ---------------------------------------------------------------------------

/**
 * Create a JSON response with the given data and status code.
 *
 * @param data - Serializable value to send as JSON.
 * @param status - HTTP status code (default 200).
 * @param headers - Additional headers to merge into the response.
 */
export function jsonResponse(
  data: unknown,
  status = 200,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
  });
}

// ---------------------------------------------------------------------------
// Error responses
// ---------------------------------------------------------------------------

/**
 * Create a JSON error response matching the Python runtime's ErrorResponse shape.
 *
 * @param detail - Human-readable error message.
 * @param status - HTTP status code (default 500).
 */
export function errorResponse(detail: string, status = 500): Response {
  const body: ErrorResponse = { detail };
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * 404 Not Found response.
 *
 * @param detail - Optional custom message (default "Not found").
 */
export function notFound(detail = "Not found"): Response {
  return errorResponse(detail, 404);
}

/**
 * 405 Method Not Allowed response.
 *
 * @param detail - Optional custom message (default "Method not allowed").
 */
export function methodNotAllowed(detail = "Method not allowed"): Response {
  return errorResponse(detail, 405);
}

/**
 * 409 Conflict response.
 *
 * @param detail - Human-readable conflict description.
 */
export function conflictResponse(detail: string): Response {
  return errorResponse(detail, 409);
}

/**
 * 422 Validation Error response.
 *
 * Returns the standard ErrorResponse shape. When field-level errors are
 * provided, they are included as an `errors` array for client debugging.
 *
 * @param detail - Top-level validation error message.
 * @param errors - Optional per-field validation errors.
 */
export function validationError(
  detail: string,
  errors?: FieldError[],
): Response {
  const body: ValidationErrorResponse = { detail };
  if (errors && errors.length > 0) {
    body.errors = errors;
  }
  return new Response(JSON.stringify(body), {
    status: 422,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Request parsing
// ---------------------------------------------------------------------------

/**
 * Parse the JSON body of a request.
 *
 * Returns the parsed object on success, or `null` if the body is empty,
 * missing, or contains invalid JSON.
 *
 * @param request - The incoming HTTP request.
 * @returns Parsed JSON body or null.
 */
export async function parseBody<T = Record<string, unknown>>(
  request: Request,
): Promise<T | null> {
  try {
    const text = await request.text();
    if (text.length === 0) {
      return null;
    }
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/**
 * Parse the JSON body of a request, returning a validation error response
 * if the body is missing or malformed.
 *
 * Use this when the endpoint *requires* a JSON body (e.g., POST create
 * endpoints). For endpoints where the body is optional, use `parseBody`
 * directly.
 *
 * @param request - The incoming HTTP request.
 * @returns A tuple of [parsedBody, null] on success, or [null, Response] on failure.
 */
export async function requireBody<T = Record<string, unknown>>(
  request: Request,
): Promise<[T, null] | [null, Response]> {
  const contentType = request.headers.get("Content-Type") || "";
  if (!contentType.includes("application/json")) {
    return [
      null,
      validationError("Content-Type must be application/json"),
    ];
  }

  const body = await parseBody<T>(request);
  if (body === null) {
    return [null, validationError("Request body must be valid JSON")];
  }

  return [body, null];
}
