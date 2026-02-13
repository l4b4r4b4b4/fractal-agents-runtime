/**
 * Pattern-matching HTTP router for Fractal Agents Runtime — TypeScript/Bun.
 *
 * Zero-dependency router built for Bun.serve(). Supports:
 *   - Path parameter extraction (`/threads/:thread_id/runs/:run_id`)
 *   - Method-based dispatch (GET, POST, PUT, PATCH, DELETE)
 *   - Error boundary (uncaught handler exceptions → 500 JSON error)
 *   - Query parameter parsing (passed to handlers)
 *   - Trailing-slash normalization
 *
 * Design: Routes are stored as segment arrays. On each request, the URL
 * path is split into segments and matched against registered routes.
 * Segments starting with `:` are treated as named parameters and their
 * values are captured into a `params` record.
 *
 * This router intentionally avoids regex-based matching for clarity and
 * performance. The segment-array approach is O(routes × segments) which
 * is fast enough for the ~40 routes in the LangGraph API.
 */

import { errorResponse, notFound, methodNotAllowed } from "./routes/helpers";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A route handler receives the original request, extracted path parameters,
 * and parsed query parameters. It may return a Response synchronously or
 * asynchronously.
 */
export type RouteHandler = (
  request: Request,
  params: Record<string, string>,
  query: URLSearchParams,
) => Response | Promise<Response>;

/**
 * HTTP methods supported by the router.
 */
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * Internal route record stored by the router.
 */
interface Route {
  method: HttpMethod;
  pattern: string;
  segments: string[];
  handler: RouteHandler;
}

/**
 * Result of attempting to match a request against registered routes.
 */
interface MatchResult {
  /** The matched route, or null if no pattern matched. */
  route: Route | null;
  /** Extracted path parameters (empty object if no params). */
  params: Record<string, string>;
  /** Whether any route matched the path but not the method. */
  methodNotAllowed: boolean;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/**
 * Pattern-matching HTTP router.
 *
 * Usage:
 * ```ts
 * const router = new Router();
 * router.get("/health", (_req) => jsonResponse({ status: "ok" }));
 * router.post("/threads/:thread_id/runs", handler);
 *
 * Bun.serve({ fetch: (req) => router.handle(req) });
 * ```
 */
export class Router {
  private routes: Route[] = [];

  // -------------------------------------------------------------------------
  // Route registration — convenience methods
  // -------------------------------------------------------------------------

  /** Register a GET route. */
  get(pattern: string, handler: RouteHandler): this {
    return this.addRoute("GET", pattern, handler);
  }

  /** Register a POST route. */
  post(pattern: string, handler: RouteHandler): this {
    return this.addRoute("POST", pattern, handler);
  }

  /** Register a PUT route. */
  put(pattern: string, handler: RouteHandler): this {
    return this.addRoute("PUT", pattern, handler);
  }

  /** Register a PATCH route. */
  patch(pattern: string, handler: RouteHandler): this {
    return this.addRoute("PATCH", pattern, handler);
  }

  /** Register a DELETE route. */
  delete(pattern: string, handler: RouteHandler): this {
    return this.addRoute("DELETE", pattern, handler);
  }

  /**
   * Register a route for a specific HTTP method and path pattern.
   *
   * Path patterns use `:name` segments for parameters:
   *   - `/threads/:thread_id`
   *   - `/threads/:thread_id/runs/:run_id/cancel`
   *
   * @param method - HTTP method (GET, POST, PUT, PATCH, DELETE).
   * @param pattern - URL pattern with optional `:param` segments.
   * @param handler - Function to handle matching requests.
   */
  addRoute(method: HttpMethod, pattern: string, handler: RouteHandler): this {
    const segments = splitPath(pattern);
    this.routes.push({ method, pattern, segments, handler });
    return this;
  }

  // -------------------------------------------------------------------------
  // Request handling
  // -------------------------------------------------------------------------

  /**
   * Handle an incoming HTTP request.
   *
   * 1. Normalize the path (strip trailing slashes).
   * 2. Match against registered routes (path + method).
   * 3. If matched, call the handler inside an error boundary.
   * 4. If path matches but method doesn't → 405.
   * 5. If nothing matches → 404.
   *
   * @param request - The incoming Bun/Fetch API Request.
   * @returns A Response (possibly async).
   */
  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const pathSegments = splitPath(url.pathname);
    const method = request.method.toUpperCase() as HttpMethod;
    const query = url.searchParams;

    const match = this.matchRoute(method, pathSegments);

    if (match.route) {
      // Error boundary: catch any exception thrown by the handler and
      // return a clean 500 JSON error instead of crashing the server.
      try {
        const response = match.route.handler(request, match.params, query);
        // Support both sync and async handlers.
        return response instanceof Promise ? await response : response;
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : "Internal server error";
        console.error(
          `[router] Handler error for ${request.method} ${url.pathname}:`,
          error,
        );
        return errorResponse(message, 500);
      }
    }

    if (match.methodNotAllowed) {
      return methodNotAllowed();
    }

    return notFound();
  }

  // -------------------------------------------------------------------------
  // Route matching
  // -------------------------------------------------------------------------

  /**
   * Attempt to match a request method + path segments against all registered
   * routes. Returns the first match found.
   *
   * Matching rules:
   * - The number of segments must be equal.
   * - Static segments must match exactly (case-sensitive).
   * - Parameter segments (`:name`) match any non-empty value.
   * - If the path matches a route pattern but the method differs,
   *   `methodNotAllowed` is set to true.
   */
  private matchRoute(
    method: HttpMethod,
    pathSegments: string[],
  ): MatchResult {
    let foundPathMatch = false;

    for (const route of this.routes) {
      const params = matchSegments(route.segments, pathSegments);
      if (params === null) {
        continue;
      }

      // Path matched — check method.
      if (route.method === method) {
        return { route, params, methodNotAllowed: false };
      }

      // Path matched but method didn't.
      foundPathMatch = true;
    }

    return {
      route: null,
      params: {},
      methodNotAllowed: foundPathMatch,
    };
  }

  // -------------------------------------------------------------------------
  // Introspection (useful for tests and debugging)
  // -------------------------------------------------------------------------

  /**
   * Return a list of all registered route patterns with their methods.
   * Useful for debugging and the OpenAPI spec generator.
   */
  listRoutes(): Array<{ method: HttpMethod; pattern: string }> {
    return this.routes.map((route) => ({
      method: route.method,
      pattern: route.pattern,
    }));
  }

  /**
   * Return the number of registered routes.
   */
  get routeCount(): number {
    return this.routes.length;
  }
}

// ---------------------------------------------------------------------------
// Path utilities (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Split a URL path into non-empty segments.
 *
 * Normalizes by:
 * - Stripping leading and trailing slashes.
 * - Filtering out empty segments (from double-slashes).
 *
 * Special case: the root path `/` returns an empty array `[]`.
 *
 * @example
 * splitPath("/threads/abc/runs/") → ["threads", "abc", "runs"]
 * splitPath("/")                  → []
 * splitPath("")                   → []
 */
export function splitPath(path: string): string[] {
  return path.split("/").filter((segment) => segment.length > 0);
}

/**
 * Match a route's segment pattern against a request's path segments.
 *
 * Returns a params object on match, or `null` on mismatch.
 *
 * @param routeSegments - The route's segments (may contain `:param` entries).
 * @param pathSegments - The actual URL path segments.
 * @returns Extracted params or null.
 *
 * @example
 * matchSegments(["threads", ":thread_id"], ["threads", "abc"])
 * // → { thread_id: "abc" }
 *
 * matchSegments(["threads", ":id"], ["threads"])
 * // → null (length mismatch)
 */
export function matchSegments(
  routeSegments: string[],
  pathSegments: string[],
): Record<string, string> | null {
  if (routeSegments.length !== pathSegments.length) {
    return null;
  }

  const params: Record<string, string> = {};

  for (let index = 0; index < routeSegments.length; index++) {
    const routeSegment = routeSegments[index];
    const pathSegment = pathSegments[index];

    if (routeSegment.startsWith(":")) {
      // Parameter segment — capture the value.
      const paramName = routeSegment.slice(1);
      params[paramName] = decodeURIComponent(pathSegment);
    } else if (routeSegment !== pathSegment) {
      // Static segment — must match exactly.
      return null;
    }
  }

  return params;
}
