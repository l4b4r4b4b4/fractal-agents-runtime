/**
 * Metrics routes for the Fractal Agents Runtime — TypeScript/Bun.
 *
 * Implements Prometheus-format and JSON metrics endpoints for monitoring
 * and observability:
 *
 *   GET /metrics      — Prometheus exposition format (text/plain)
 *   GET /metrics/json — JSON-format metrics for debugging
 *
 * Both endpoints are intentionally public (no auth required) to allow
 * Prometheus scrapers and monitoring tools to collect metrics without
 * needing a JWT token.
 *
 * Reference: apps/python/src/server/routes/metrics.py
 */

import type { Router } from "../router";
import {
  formatPrometheusMetrics,
  getMetricsJson,
} from "../infra/metrics";

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Register metrics routes on the given router.
 *
 * @param router - The application Router instance.
 */
export function registerMetricsRoutes(router: Router): void {
  router.get("/metrics", handleGetMetrics);
  router.get("/metrics/json", handleGetMetricsJson);
}

// ---------------------------------------------------------------------------
// GET /metrics — Prometheus exposition format
// ---------------------------------------------------------------------------

/**
 * Return all collected metrics in Prometheus exposition format.
 *
 * Response: `text/plain; charset=utf-8` with Prometheus metric families.
 *
 * The `format` query parameter is accepted for compatibility with the
 * Python runtime's OpenAPI spec but currently only `prometheus` (default)
 * is supported. The JSON format is served at `/metrics/json` instead.
 *
 * This endpoint is intentionally unauthenticated so that Prometheus
 * scrapers can collect metrics without needing credentials.
 */
async function handleGetMetrics(
  _request: Request,
  _params: Record<string, string>,
  query: URLSearchParams,
): Promise<Response> {
  const format = query.get("format") ?? "prometheus";

  // If JSON format is explicitly requested via query param, serve JSON
  if (format === "json") {
    return new Response(JSON.stringify(getMetricsJson()), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
      },
    });
  }

  // Default: Prometheus exposition format
  const metricsText = formatPrometheusMetrics();

  return new Response(metricsText, {
    status: 200,
    headers: {
      // Prometheus expects text/plain with version parameter
      "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
    },
  });
}

// ---------------------------------------------------------------------------
// GET /metrics/json — JSON format
// ---------------------------------------------------------------------------

/**
 * Return all collected metrics as a JSON object.
 *
 * Response: `application/json` with all metrics in a structured format.
 *
 * This endpoint is primarily for debugging and programmatic access.
 * For production monitoring, use `/metrics` with Prometheus.
 */
async function handleGetMetricsJson(
  _request: Request,
): Promise<Response> {
  const metrics = getMetricsJson();

  return new Response(JSON.stringify(metrics), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}
