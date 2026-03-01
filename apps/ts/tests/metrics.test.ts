/**
 * Unit tests for the Prometheus metrics module and routes.
 *
 * Covers:
 *   - Counter operations (request counts, error counts)
 *   - Gauge operations (active streams, agent invocations/errors)
 *   - Duration recording and percentile calculation
 *   - Prometheus exposition format output
 *   - JSON metrics output
 *   - Storage counts callback registration
 *   - Metrics reset (for test isolation)
 *   - Route handlers (GET /metrics, GET /metrics/json)
 *
 * Reference: apps/python/src/server/routes/metrics.py
 * Reference: apps/python/src/server/tests/test_route_handlers.py
 */

import { describe, it, expect, beforeEach } from "bun:test";

import {
  incrementRequestCount,
  incrementRequestError,
  recordRequestDuration,
  incrementStreamCount,
  decrementStreamCount,
  getActiveStreamCount,
  incrementAgentInvocation,
  incrementAgentError,
  getAgentInvocationCount,
  getAgentErrorCount,
  registerStorageCountsCallback,
  formatPrometheusMetrics,
  getMetricsJson,
  resetMetrics,
} from "../src/infra/metrics";

import { router } from "../src/index";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Parse a Prometheus exposition format string into a map of metric names
 * to their values (for simple scalar metrics) or to their full line.
 */
function parsePrometheusLines(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

/**
 * Find a metric line by prefix in Prometheus output.
 */
function findMetricLine(text: string, prefix: string): string | undefined {
  return parsePrometheusLines(text).find((line) => line.startsWith(prefix));
}

/**
 * Find all metric lines by prefix in Prometheus output.
 */
function findMetricLines(text: string, prefix: string): string[] {
  return parsePrometheusLines(text).filter((line) => line.startsWith(prefix));
}

/**
 * Extract numeric value from a simple Prometheus metric line.
 * e.g., "agent_runtime_active_streams 3" → 3
 */
function extractValue(line: string | undefined): number | undefined {
  if (!line) return undefined;
  const parts = line.split(" ");
  const value = parseFloat(parts[parts.length - 1]);
  return Number.isNaN(value) ? undefined : value;
}

// ============================================================================
// Counter operations
// ============================================================================

describe("incrementRequestCount", () => {
  beforeEach(() => {
    resetMetrics();
  });

  it("increments a new counter from zero", () => {
    incrementRequestCount("/health", "GET", 200);
    const json = getMetricsJson();
    const requests = json.requests as Record<string, number>;
    expect(requests["GET_/health_200"]).toBe(1);
  });

  it("increments an existing counter", () => {
    incrementRequestCount("/health", "GET", 200);
    incrementRequestCount("/health", "GET", 200);
    incrementRequestCount("/health", "GET", 200);
    const json = getMetricsJson();
    const requests = json.requests as Record<string, number>;
    expect(requests["GET_/health_200"]).toBe(3);
  });

  it("tracks different endpoints separately", () => {
    incrementRequestCount("/health", "GET", 200);
    incrementRequestCount("/info", "GET", 200);
    incrementRequestCount("/assistants", "POST", 201);
    const json = getMetricsJson();
    const requests = json.requests as Record<string, number>;
    expect(requests["GET_/health_200"]).toBe(1);
    expect(requests["GET_/info_200"]).toBe(1);
    expect(requests["POST_/assistants_201"]).toBe(1);
  });

  it("tracks different status codes separately", () => {
    incrementRequestCount("/assistants", "POST", 200);
    incrementRequestCount("/assistants", "POST", 409);
    incrementRequestCount("/assistants", "POST", 422);
    const json = getMetricsJson();
    const requests = json.requests as Record<string, number>;
    expect(requests["POST_/assistants_200"]).toBe(1);
    expect(requests["POST_/assistants_409"]).toBe(1);
    expect(requests["POST_/assistants_422"]).toBe(1);
  });
});

describe("incrementRequestError", () => {
  beforeEach(() => {
    resetMetrics();
  });

  it("increments a new error type from zero", () => {
    incrementRequestError("handler_error");
    const json = getMetricsJson();
    const errors = json.errors as Record<string, number>;
    expect(errors["handler_error"]).toBe(1);
  });

  it("increments existing error type", () => {
    incrementRequestError("auth_error");
    incrementRequestError("auth_error");
    const json = getMetricsJson();
    const errors = json.errors as Record<string, number>;
    expect(errors["auth_error"]).toBe(2);
  });

  it("tracks different error types separately", () => {
    incrementRequestError("handler_error");
    incrementRequestError("middleware_error");
    incrementRequestError("handler_error");
    const json = getMetricsJson();
    const errors = json.errors as Record<string, number>;
    expect(errors["handler_error"]).toBe(2);
    expect(errors["middleware_error"]).toBe(1);
  });
});

// ============================================================================
// Duration recording
// ============================================================================

describe("recordRequestDuration", () => {
  beforeEach(() => {
    resetMetrics();
  });

  it("records a single duration", () => {
    recordRequestDuration("/health", 0.001);
    const json = getMetricsJson();
    expect(json.duration_samples).toBe(1);
  });

  it("records multiple durations", () => {
    recordRequestDuration("/health", 0.001);
    recordRequestDuration("/info", 0.002);
    recordRequestDuration("/assistants", 0.010);
    const json = getMetricsJson();
    expect(json.duration_samples).toBe(3);
  });

  it("evicts old samples when over 1000", () => {
    for (let i = 0; i < 1050; i++) {
      recordRequestDuration("/health", 0.001 * i);
    }
    const json = getMetricsJson();
    expect(json.duration_samples).toBe(1000);
  });

  it("appears in Prometheus output as summary", () => {
    recordRequestDuration("/health", 0.001);
    recordRequestDuration("/health", 0.005);
    recordRequestDuration("/health", 0.010);
    recordRequestDuration("/health", 0.050);

    const text = formatPrometheusMetrics();
    expect(text).toContain("agent_runtime_request_duration_seconds");
    expect(text).toContain('quantile="0.5"');
    expect(text).toContain('quantile="0.9"');
    expect(text).toContain('quantile="0.99"');
    expect(text).toContain("agent_runtime_request_duration_seconds_sum");
    expect(text).toContain("agent_runtime_request_duration_seconds_count 4");
  });
});

// ============================================================================
// Stream gauge
// ============================================================================

describe("stream gauge", () => {
  beforeEach(() => {
    resetMetrics();
  });

  it("starts at zero", () => {
    expect(getActiveStreamCount()).toBe(0);
  });

  it("increments on incrementStreamCount", () => {
    incrementStreamCount();
    expect(getActiveStreamCount()).toBe(1);
    incrementStreamCount();
    expect(getActiveStreamCount()).toBe(2);
  });

  it("decrements on decrementStreamCount", () => {
    incrementStreamCount();
    incrementStreamCount();
    incrementStreamCount();
    decrementStreamCount();
    expect(getActiveStreamCount()).toBe(2);
  });

  it("clamps to zero on excessive decrements", () => {
    incrementStreamCount();
    decrementStreamCount();
    decrementStreamCount();
    decrementStreamCount();
    expect(getActiveStreamCount()).toBe(0);
  });
});

// ============================================================================
// Agent counters
// ============================================================================

describe("agent counters", () => {
  beforeEach(() => {
    resetMetrics();
  });

  it("invocation counter starts at zero", () => {
    expect(getAgentInvocationCount()).toBe(0);
  });

  it("increments invocation counter", () => {
    incrementAgentInvocation();
    incrementAgentInvocation();
    expect(getAgentInvocationCount()).toBe(2);
  });

  it("error counter starts at zero", () => {
    expect(getAgentErrorCount()).toBe(0);
  });

  it("increments error counter", () => {
    incrementAgentError();
    expect(getAgentErrorCount()).toBe(1);
  });

  it("invocation and error counters are independent", () => {
    incrementAgentInvocation();
    incrementAgentInvocation();
    incrementAgentInvocation();
    incrementAgentError();
    expect(getAgentInvocationCount()).toBe(3);
    expect(getAgentErrorCount()).toBe(1);
  });
});

// ============================================================================
// Storage counts callback
// ============================================================================

describe("storage counts callback", () => {
  beforeEach(() => {
    resetMetrics();
  });

  it("metrics JSON returns null storage when no callback registered", () => {
    const json = getMetricsJson();
    expect(json.storage).toBeNull();
  });

  it("metrics JSON includes storage counts when callback registered", () => {
    registerStorageCountsCallback(() => ({
      assistants: 5,
      threads: 10,
      runs: 20,
      runsByStatus: { pending: 3, running: 2, success: 15 },
    }));

    const json = getMetricsJson();
    const storage = json.storage as Record<string, unknown>;
    expect(storage).not.toBeNull();
    expect(storage.assistants).toBe(5);
    expect(storage.threads).toBe(10);
    expect(storage.runs).toBe(20);
  });

  it("Prometheus output includes storage gauges when callback registered", () => {
    registerStorageCountsCallback(() => ({
      assistants: 3,
      threads: 7,
      runs: 12,
      runsByStatus: { success: 10, error: 2 },
    }));

    const text = formatPrometheusMetrics();
    expect(text).toContain("agent_runtime_assistants_total 3");
    expect(text).toContain("agent_runtime_threads_total 7");
    expect(text).toContain("agent_runtime_runs_total 12");
    expect(text).toContain('agent_runtime_runs_by_status{status="success"} 10');
    expect(text).toContain('agent_runtime_runs_by_status{status="error"} 2');
    expect(text).toContain('agent_runtime_runs_by_status{status="pending"} 0');
  });

  it("handles callback errors gracefully", () => {
    registerStorageCountsCallback(() => {
      throw new Error("storage not ready");
    });

    // Should not throw
    const text = formatPrometheusMetrics();
    expect(text).toContain("agent_runtime_uptime_seconds");
    // Storage metrics should be absent
    expect(text).not.toContain("agent_runtime_assistants_total");
  });
});

// ============================================================================
// Prometheus exposition format
// ============================================================================

describe("formatPrometheusMetrics", () => {
  beforeEach(() => {
    resetMetrics();
  });

  it("always includes uptime", () => {
    const text = formatPrometheusMetrics();
    expect(text).toContain("# HELP agent_runtime_uptime_seconds");
    expect(text).toContain("# TYPE agent_runtime_uptime_seconds gauge");
    const line = findMetricLine(text, "agent_runtime_uptime_seconds ");
    expect(line).toBeDefined();
    const value = extractValue(line);
    expect(value).toBeDefined();
    expect(value!).toBeGreaterThanOrEqual(0);
  });

  it("includes request counts with labels", () => {
    incrementRequestCount("/health", "GET", 200);
    incrementRequestCount("/assistants", "POST", 200);

    const text = formatPrometheusMetrics();
    expect(text).toContain("# TYPE agent_runtime_requests_total counter");
    expect(text).toContain(
      'agent_runtime_requests_total{method="GET",endpoint="/health",status="200"} 1',
    );
    expect(text).toContain(
      'agent_runtime_requests_total{method="POST",endpoint="/assistants",status="200"} 1',
    );
  });

  it("includes error counts with labels", () => {
    incrementRequestError("handler_error");

    const text = formatPrometheusMetrics();
    expect(text).toContain("# TYPE agent_runtime_errors_total counter");
    expect(text).toContain(
      'agent_runtime_errors_total{type="handler_error"} 1',
    );
  });

  it("shows zero errors when none recorded", () => {
    const text = formatPrometheusMetrics();
    expect(text).toContain('agent_runtime_errors_total{type="none"} 0');
  });

  it("includes active streams gauge", () => {
    incrementStreamCount();
    incrementStreamCount();
    incrementStreamCount();

    const text = formatPrometheusMetrics();
    expect(text).toContain("# TYPE agent_runtime_active_streams gauge");
    expect(text).toContain("agent_runtime_active_streams 3");
  });

  it("includes agent invocation counter", () => {
    incrementAgentInvocation();
    incrementAgentInvocation();

    const text = formatPrometheusMetrics();
    expect(text).toContain(
      "# TYPE agent_runtime_agent_invocations_total counter",
    );
    expect(text).toContain("agent_runtime_agent_invocations_total 2");
  });

  it("includes agent error counter", () => {
    incrementAgentError();

    const text = formatPrometheusMetrics();
    expect(text).toContain(
      "# TYPE agent_runtime_agent_errors_total counter",
    );
    expect(text).toContain("agent_runtime_agent_errors_total 1");
  });

  it("omits duration summary when no samples", () => {
    const text = formatPrometheusMetrics();
    expect(text).not.toContain("agent_runtime_request_duration_seconds");
  });

  it("includes duration summary with correct percentiles", () => {
    // Add 100 samples: 0.001, 0.002, ..., 0.100
    for (let i = 1; i <= 100; i++) {
      recordRequestDuration("/test", i / 1000);
    }

    const text = formatPrometheusMetrics();
    const p50Line = findMetricLine(
      text,
      'agent_runtime_request_duration_seconds{quantile="0.5"}',
    );
    const p90Line = findMetricLine(
      text,
      'agent_runtime_request_duration_seconds{quantile="0.9"}',
    );
    const p99Line = findMetricLine(
      text,
      'agent_runtime_request_duration_seconds{quantile="0.99"}',
    );
    const countLine = findMetricLine(
      text,
      "agent_runtime_request_duration_seconds_count",
    );

    expect(p50Line).toBeDefined();
    expect(p90Line).toBeDefined();
    expect(p99Line).toBeDefined();
    expect(extractValue(countLine)).toBe(100);

    // p50 should be around 0.050-0.051
    const p50 = extractValue(p50Line)!;
    expect(p50).toBeGreaterThanOrEqual(0.049);
    expect(p50).toBeLessThanOrEqual(0.052);

    // p90 should be around 0.090-0.091
    const p90 = extractValue(p90Line)!;
    expect(p90).toBeGreaterThanOrEqual(0.089);
    expect(p90).toBeLessThanOrEqual(0.092);
  });

  it("includes runs_by_status for all known statuses", () => {
    registerStorageCountsCallback(() => ({
      assistants: 0,
      threads: 0,
      runs: 0,
      runsByStatus: {},
    }));

    const text = formatPrometheusMetrics();
    for (const status of [
      "pending",
      "running",
      "success",
      "error",
      "interrupted",
    ]) {
      expect(text).toContain(
        `agent_runtime_runs_by_status{status="${status}"} 0`,
      );
    }
  });

  it("output is valid Prometheus format (no trailing whitespace on metric lines)", () => {
    incrementRequestCount("/health", "GET", 200);
    incrementAgentInvocation();

    const text = formatPrometheusMetrics();
    const metricLines = parsePrometheusLines(text);
    for (const line of metricLines) {
      // Each metric line should end with a number, not trailing whitespace
      expect(line).toMatch(/\S$/);
    }
  });
});

// ============================================================================
// JSON metrics format
// ============================================================================

describe("getMetricsJson", () => {
  beforeEach(() => {
    resetMetrics();
  });

  it("returns all metric categories", () => {
    const json = getMetricsJson();
    expect(json).toHaveProperty("uptime_seconds");
    expect(json).toHaveProperty("requests");
    expect(json).toHaveProperty("errors");
    expect(json).toHaveProperty("active_streams");
    expect(json).toHaveProperty("agent");
    expect(json).toHaveProperty("storage");
    expect(json).toHaveProperty("duration_samples");
  });

  it("uptime is a positive number", () => {
    const json = getMetricsJson();
    expect(typeof json.uptime_seconds).toBe("number");
    expect(json.uptime_seconds as number).toBeGreaterThanOrEqual(0);
  });

  it("reflects request counts", () => {
    incrementRequestCount("/health", "GET", 200);
    incrementRequestCount("/health", "GET", 200);
    const json = getMetricsJson();
    const requests = json.requests as Record<string, number>;
    expect(requests["GET_/health_200"]).toBe(2);
  });

  it("reflects error counts", () => {
    incrementRequestError("auth_error");
    const json = getMetricsJson();
    const errors = json.errors as Record<string, number>;
    expect(errors["auth_error"]).toBe(1);
  });

  it("reflects active streams", () => {
    incrementStreamCount();
    incrementStreamCount();
    const json = getMetricsJson();
    expect(json.active_streams).toBe(2);
  });

  it("reflects agent counters", () => {
    incrementAgentInvocation();
    incrementAgentInvocation();
    incrementAgentError();
    const json = getMetricsJson();
    const agent = json.agent as Record<string, number>;
    expect(agent.invocations).toBe(2);
    expect(agent.errors).toBe(1);
  });

  it("reflects duration sample count", () => {
    recordRequestDuration("/test", 0.01);
    recordRequestDuration("/test", 0.02);
    const json = getMetricsJson();
    expect(json.duration_samples).toBe(2);
  });

  it("storage is null when no callback", () => {
    const json = getMetricsJson();
    expect(json.storage).toBeNull();
  });

  it("storage is populated when callback registered", () => {
    registerStorageCountsCallback(() => ({
      assistants: 2,
      threads: 5,
      runs: 8,
      runsByStatus: { success: 6, error: 2 },
    }));
    const json = getMetricsJson();
    const storage = json.storage as Record<string, unknown>;
    expect(storage.assistants).toBe(2);
    expect(storage.threads).toBe(5);
    expect(storage.runs).toBe(8);
    const runsByStatus = storage.runs_by_status as Record<string, number>;
    expect(runsByStatus.success).toBe(6);
    expect(runsByStatus.error).toBe(2);
  });

  it("handles storage callback error gracefully", () => {
    registerStorageCountsCallback(() => {
      throw new Error("boom");
    });
    const json = getMetricsJson();
    expect(json.storage).toBeNull();
  });
});

// ============================================================================
// Reset
// ============================================================================

describe("resetMetrics", () => {
  it("clears all counters and gauges", () => {
    incrementRequestCount("/health", "GET", 200);
    incrementRequestError("test_error");
    recordRequestDuration("/health", 0.01);
    incrementStreamCount();
    incrementAgentInvocation();
    incrementAgentError();
    registerStorageCountsCallback(() => ({
      assistants: 1,
      threads: 1,
      runs: 1,
      runsByStatus: {},
    }));

    resetMetrics();

    const json = getMetricsJson();
    expect(Object.keys(json.requests as object)).toHaveLength(0);
    expect(Object.keys(json.errors as object)).toHaveLength(0);
    expect(json.active_streams).toBe(0);
    expect((json.agent as any).invocations).toBe(0);
    expect((json.agent as any).errors).toBe(0);
    expect(json.duration_samples).toBe(0);
    expect(json.storage).toBeNull();
  });
});

// ============================================================================
// Route handler integration (via router.handle)
// ============================================================================

describe("GET /metrics route", () => {
  beforeEach(() => {
    resetMetrics();
  });

  it("returns 200 with text/plain content type", async () => {
    const request = new Request("http://localhost:3000/metrics");
    const response = await router.handle(request);

    expect(response.status).toBe(200);
    const contentType = response.headers.get("Content-Type");
    expect(contentType).toContain("text/plain");
  });

  it("returns valid Prometheus format", async () => {
    const request = new Request("http://localhost:3000/metrics");
    const response = await router.handle(request);
    const text = await response.text();

    expect(text).toContain("# HELP agent_runtime_uptime_seconds");
    expect(text).toContain("# TYPE agent_runtime_uptime_seconds gauge");
    expect(text).toContain("agent_runtime_uptime_seconds");
  });

  it("supports ?format=json query parameter", async () => {
    const request = new Request("http://localhost:3000/metrics?format=json");
    const response = await router.handle(request);

    expect(response.status).toBe(200);
    const contentType = response.headers.get("Content-Type");
    expect(contentType).toContain("application/json");

    const json = await response.json();
    expect(json).toHaveProperty("uptime_seconds");
    expect(json).toHaveProperty("requests");
  });

  it("defaults to prometheus format for unknown format", async () => {
    const request = new Request(
      "http://localhost:3000/metrics?format=unknown",
    );
    const response = await router.handle(request);

    expect(response.status).toBe(200);
    const contentType = response.headers.get("Content-Type");
    expect(contentType).toContain("text/plain");
  });
});

describe("GET /metrics/json route", () => {
  beforeEach(() => {
    resetMetrics();
  });

  it("returns 200 with application/json content type", async () => {
    const request = new Request("http://localhost:3000/metrics/json");
    const response = await router.handle(request);

    expect(response.status).toBe(200);
    const contentType = response.headers.get("Content-Type");
    expect(contentType).toContain("application/json");
  });

  it("returns valid JSON with all metric categories", async () => {
    const request = new Request("http://localhost:3000/metrics/json");
    const response = await router.handle(request);
    const json = await response.json();

    expect(json).toHaveProperty("uptime_seconds");
    expect(json).toHaveProperty("requests");
    expect(json).toHaveProperty("errors");
    expect(json).toHaveProperty("active_streams");
    expect(json).toHaveProperty("agent");
    expect(json).toHaveProperty("duration_samples");
  });
});

// ============================================================================
// Router metrics integration (automatic request counting)
// ============================================================================

describe("router metrics instrumentation", () => {
  beforeEach(() => {
    resetMetrics();
  });

  it("records request count on successful route match", async () => {
    const request = new Request("http://localhost:3000/health");
    await router.handle(request);

    const json = getMetricsJson();
    const requests = json.requests as Record<string, number>;

    // Should have recorded a GET /health 200 (or similar health route)
    const healthKey = Object.keys(requests).find(
      (key) => key.startsWith("GET_/health"),
    );
    expect(healthKey).toBeDefined();
    expect(requests[healthKey!]).toBeGreaterThanOrEqual(1);
  });

  it("records request count on 404", async () => {
    const request = new Request(
      "http://localhost:3000/nonexistent-route-12345",
    );
    await router.handle(request);

    const json = getMetricsJson();
    const requests = json.requests as Record<string, number>;

    const notFoundKey = Object.keys(requests).find((key) =>
      key.includes("404"),
    );
    expect(notFoundKey).toBeDefined();
  });

  it("records request duration", async () => {
    const request = new Request("http://localhost:3000/ok");
    await router.handle(request);

    const json = getMetricsJson();
    // At least one duration sample should exist
    expect(json.duration_samples as number).toBeGreaterThanOrEqual(1);
  });

  it("accumulates metrics across multiple requests", async () => {
    for (let i = 0; i < 5; i++) {
      const request = new Request("http://localhost:3000/health");
      await router.handle(request);
    }

    const json = getMetricsJson();
    const requests = json.requests as Record<string, number>;

    const healthKey = Object.keys(requests).find(
      (key) => key.startsWith("GET_/health"),
    );
    expect(healthKey).toBeDefined();
    expect(requests[healthKey!]).toBeGreaterThanOrEqual(5);
  });
});
