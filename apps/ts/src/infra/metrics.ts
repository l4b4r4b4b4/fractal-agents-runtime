/**
 * Prometheus metrics collector for Fractal Agents Runtime — TypeScript/Bun.
 *
 * Provides in-process metric storage and Prometheus exposition format output.
 * Since Bun is single-threaded, no locks are needed (unlike Python's threading.Lock).
 *
 * Metric types:
 *   - **Counters**: Monotonically increasing values (requests, errors, invocations)
 *   - **Gauges**: Point-in-time values (active streams, storage counts)
 *   - **Summary**: Request duration percentiles (p50, p90, p99)
 *
 * Metrics naming follows Prometheus conventions:
 *   - Prefix: `agent_runtime_`
 *   - Units in name: `_seconds`, `_total`
 *   - Labels in braces: `{method="GET", endpoint="/health", status="200"}`
 *
 * Usage:
 *   - Import increment/record functions and call them from route handlers,
 *     middleware, stream handlers, and agent execution code.
 *   - Import `formatPrometheusMetrics()` or `getMetricsJson()` for the
 *     `/metrics` and `/metrics/json` endpoints.
 *
 * Reference: apps/python/src/server/routes/metrics.py
 */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Server start time for uptime calculation. */
const startTime: number = Date.now();

/** Request counts keyed by `{method}_{endpoint}_{status}`. */
const requestCounts: Map<string, number> = new Map();

/** Error counts keyed by error type string. */
const requestErrors: Map<string, number> = new Map();

/**
 * Request duration samples: `[endpoint, durationSeconds]`.
 * Capped at `MAX_DURATION_SAMPLES` to prevent unbounded memory growth.
 */
const requestDurations: Array<[string, number]> = [];

/** Maximum number of duration samples to retain. */
const MAX_DURATION_SAMPLES = 1000;

/** Number of currently active SSE streams. */
let activeStreamCount: number = 0;

/** Total agent graph invocations. */
let agentInvocationCount: number = 0;

/** Total agent execution errors. */
let agentErrorCount: number = 0;

// ---------------------------------------------------------------------------
// Counter operations
// ---------------------------------------------------------------------------

/**
 * Increment the request counter for a given endpoint/method/status combination.
 *
 * @param endpoint - The matched route pattern (e.g., "/assistants", "/threads/:thread_id/runs").
 * @param method - HTTP method (e.g., "GET", "POST").
 * @param status - HTTP response status code.
 */
export function incrementRequestCount(
  endpoint: string,
  method: string,
  status: number,
): void {
  const key = `${method}_${endpoint}_${status}`;
  requestCounts.set(key, (requestCounts.get(key) ?? 0) + 1);
}

/**
 * Increment the error counter for a given error type.
 *
 * @param errorType - A short classifier for the error (e.g., "handler_error", "middleware_error", "auth_error").
 */
export function incrementRequestError(errorType: string): void {
  requestErrors.set(errorType, (requestErrors.get(errorType) ?? 0) + 1);
}

/**
 * Record a request duration sample.
 *
 * Samples are stored in a rolling window of {@link MAX_DURATION_SAMPLES}
 * entries. Oldest samples are evicted when the window is full.
 *
 * @param endpoint - The matched route pattern.
 * @param durationSeconds - Request processing time in seconds.
 */
export function recordRequestDuration(
  endpoint: string,
  durationSeconds: number,
): void {
  requestDurations.push([endpoint, durationSeconds]);
  // Evict oldest sample if over capacity
  if (requestDurations.length > MAX_DURATION_SAMPLES) {
    requestDurations.shift();
  }
}

// ---------------------------------------------------------------------------
// Stream gauge
// ---------------------------------------------------------------------------

/**
 * Increment the active SSE stream gauge.
 *
 * Call this when a new SSE stream is opened.
 */
export function incrementStreamCount(): void {
  activeStreamCount += 1;
}

/**
 * Decrement the active SSE stream gauge.
 *
 * Call this when an SSE stream is closed. Clamped to zero.
 */
export function decrementStreamCount(): void {
  activeStreamCount = Math.max(0, activeStreamCount - 1);
}

/**
 * Get the current number of active SSE streams.
 *
 * @returns The active stream count.
 */
export function getActiveStreamCount(): number {
  return activeStreamCount;
}

// ---------------------------------------------------------------------------
// Agent counters
// ---------------------------------------------------------------------------

/**
 * Increment the agent graph invocation counter.
 *
 * Call this at the start of every `graph.invoke()` or `graph.stream()` call.
 */
export function incrementAgentInvocation(): void {
  agentInvocationCount += 1;
}

/**
 * Increment the agent execution error counter.
 *
 * Call this when a graph invocation throws or returns an error state.
 */
export function incrementAgentError(): void {
  agentErrorCount += 1;
}

/**
 * Get the current agent invocation count.
 *
 * @returns Total agent invocations since server start.
 */
export function getAgentInvocationCount(): number {
  return agentInvocationCount;
}

/**
 * Get the current agent error count.
 *
 * @returns Total agent errors since server start.
 */
export function getAgentErrorCount(): number {
  return agentErrorCount;
}

// ---------------------------------------------------------------------------
// Storage gauge helpers
// ---------------------------------------------------------------------------

/**
 * Callback type for fetching storage counts.
 *
 * The metrics module doesn't import storage directly to avoid circular
 * dependencies. Instead, the storage count callback is registered at
 * startup and called when metrics are formatted.
 */
export interface StorageCounts {
  assistants: number;
  threads: number;
  runs: number;
  runsByStatus: Record<string, number>;
}

/** Registered callback for fetching storage counts. */
let storageCountsCallback: (() => StorageCounts) | null = null;

/**
 * Register a callback that returns current storage counts.
 *
 * Called once at server startup after storage initialization. The callback
 * is invoked on each `/metrics` request to fetch point-in-time counts.
 *
 * @param callback - Function returning current storage counts.
 */
export function registerStorageCountsCallback(
  callback: () => StorageCounts,
): void {
  storageCountsCallback = callback;
}

// ---------------------------------------------------------------------------
// Prometheus exposition format
// ---------------------------------------------------------------------------

/**
 * Calculate percentile value from a sorted array of numbers.
 *
 * Uses nearest-rank method.
 *
 * @param sorted - Pre-sorted array of values.
 * @param percentile - Percentile to calculate (0.0–1.0).
 * @returns The value at the given percentile.
 */
function percentile(sorted: number[], percentile: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(
    Math.floor(sorted.length * percentile),
    sorted.length - 1,
  );
  return sorted[index];
}

/**
 * Format all collected metrics in Prometheus exposition format.
 *
 * Output follows the Prometheus text-based exposition format:
 *   - `# HELP` lines describe the metric
 *   - `# TYPE` lines declare the metric type
 *   - Metric lines contain the name, optional labels, and value
 *   - Blank lines separate metric families
 *
 * @returns A string in Prometheus exposition format.
 */
export function formatPrometheusMetrics(): string {
  const lines: string[] = [];

  // -- Uptime --
  const uptimeSeconds = (Date.now() - startTime) / 1000;
  lines.push("# HELP agent_runtime_uptime_seconds Time since server start");
  lines.push("# TYPE agent_runtime_uptime_seconds gauge");
  lines.push(`agent_runtime_uptime_seconds ${uptimeSeconds.toFixed(2)}`);
  lines.push("");

  // -- Request counts --
  lines.push("# HELP agent_runtime_requests_total Total number of requests");
  lines.push("# TYPE agent_runtime_requests_total counter");
  if (requestCounts.size === 0) {
    lines.push('agent_runtime_requests_total{method="none",endpoint="none",status="0"} 0');
  } else {
    for (const [key, count] of requestCounts.entries()) {
      // Key format: METHOD_endpoint_STATUS
      // We need to split from the right to handle endpoints with underscores
      const lastUnderscore = key.lastIndexOf("_");
      const status = key.slice(lastUnderscore + 1);
      const rest = key.slice(0, lastUnderscore);
      const firstUnderscore = rest.indexOf("_");
      const method = rest.slice(0, firstUnderscore);
      const endpoint = rest.slice(firstUnderscore + 1);
      lines.push(
        `agent_runtime_requests_total{method="${method}",endpoint="${endpoint}",status="${status}"} ${count}`,
      );
    }
  }
  lines.push("");

  // -- Error counts --
  lines.push("# HELP agent_runtime_errors_total Total number of errors");
  lines.push("# TYPE agent_runtime_errors_total counter");
  if (requestErrors.size === 0) {
    lines.push('agent_runtime_errors_total{type="none"} 0');
  } else {
    for (const [errorType, count] of requestErrors.entries()) {
      lines.push(`agent_runtime_errors_total{type="${errorType}"} ${count}`);
    }
  }
  lines.push("");

  // -- Active streams --
  lines.push(
    "# HELP agent_runtime_active_streams Number of active SSE streams",
  );
  lines.push("# TYPE agent_runtime_active_streams gauge");
  lines.push(`agent_runtime_active_streams ${activeStreamCount}`);
  lines.push("");

  // -- Agent invocations --
  lines.push(
    "# HELP agent_runtime_agent_invocations_total Total agent graph invocations",
  );
  lines.push("# TYPE agent_runtime_agent_invocations_total counter");
  lines.push(`agent_runtime_agent_invocations_total ${agentInvocationCount}`);
  lines.push("");

  // -- Agent errors --
  lines.push(
    "# HELP agent_runtime_agent_errors_total Total agent execution errors",
  );
  lines.push("# TYPE agent_runtime_agent_errors_total counter");
  lines.push(`agent_runtime_agent_errors_total ${agentErrorCount}`);
  lines.push("");

  // -- Storage gauges --
  if (storageCountsCallback) {
    try {
      const counts = storageCountsCallback();

      lines.push(
        "# HELP agent_runtime_assistants_total Total number of assistants",
      );
      lines.push("# TYPE agent_runtime_assistants_total gauge");
      lines.push(`agent_runtime_assistants_total ${counts.assistants}`);
      lines.push("");

      lines.push(
        "# HELP agent_runtime_threads_total Total number of threads",
      );
      lines.push("# TYPE agent_runtime_threads_total gauge");
      lines.push(`agent_runtime_threads_total ${counts.threads}`);
      lines.push("");

      lines.push("# HELP agent_runtime_runs_total Total number of runs");
      lines.push("# TYPE agent_runtime_runs_total gauge");
      lines.push(`agent_runtime_runs_total ${counts.runs}`);
      lines.push("");

      lines.push(
        "# HELP agent_runtime_runs_by_status Number of runs by status",
      );
      lines.push("# TYPE agent_runtime_runs_by_status gauge");
      for (const status of [
        "pending",
        "running",
        "success",
        "error",
        "interrupted",
      ]) {
        lines.push(
          `agent_runtime_runs_by_status{status="${status}"} ${counts.runsByStatus[status] ?? 0}`,
        );
      }
      lines.push("");
    } catch {
      // Storage not available — skip storage metrics
    }
  }

  // -- Request duration summary (percentiles) --
  if (requestDurations.length > 0) {
    const durations = requestDurations.map(([, d]) => d).sort((a, b) => a - b);

    lines.push(
      "# HELP agent_runtime_request_duration_seconds Request duration in seconds",
    );
    lines.push("# TYPE agent_runtime_request_duration_seconds summary");
    lines.push(
      `agent_runtime_request_duration_seconds{quantile="0.5"} ${percentile(durations, 0.5).toFixed(6)}`,
    );
    lines.push(
      `agent_runtime_request_duration_seconds{quantile="0.9"} ${percentile(durations, 0.9).toFixed(6)}`,
    );
    lines.push(
      `agent_runtime_request_duration_seconds{quantile="0.99"} ${percentile(durations, 0.99).toFixed(6)}`,
    );
    lines.push(
      `agent_runtime_request_duration_seconds_sum ${durations.reduce((a, b) => a + b, 0).toFixed(6)}`,
    );
    lines.push(
      `agent_runtime_request_duration_seconds_count ${durations.length}`,
    );
    lines.push("");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// JSON format
// ---------------------------------------------------------------------------

/**
 * Get all metrics as a JSON-serializable object.
 *
 * Used by the `/metrics/json` endpoint for debugging and programmatic access.
 *
 * @returns An object containing all current metrics.
 */
export function getMetricsJson(): Record<string, unknown> {
  const storageCounts = storageCountsCallback
    ? (() => {
        try {
          return storageCountsCallback();
        } catch {
          return null;
        }
      })()
    : null;

  return {
    uptime_seconds: (Date.now() - startTime) / 1000,
    requests: Object.fromEntries(requestCounts),
    errors: Object.fromEntries(requestErrors),
    active_streams: activeStreamCount,
    agent: {
      invocations: agentInvocationCount,
      errors: agentErrorCount,
    },
    storage: storageCounts
      ? {
          assistants: storageCounts.assistants,
          threads: storageCounts.threads,
          runs: storageCounts.runs,
          runs_by_status: storageCounts.runsByStatus,
        }
      : null,
    duration_samples: requestDurations.length,
  };
}

// ---------------------------------------------------------------------------
// Reset (testing only)
// ---------------------------------------------------------------------------

/**
 * Reset all metrics to their initial state.
 *
 * **For testing only.** Clears all counters, gauges, and samples.
 */
export function resetMetrics(): void {
  requestCounts.clear();
  requestErrors.clear();
  requestDurations.length = 0;
  activeStreamCount = 0;
  agentInvocationCount = 0;
  agentErrorCount = 0;
  storageCountsCallback = null;
}
