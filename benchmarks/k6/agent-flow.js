/**
 * k6 Benchmark — Full Agent Flow
 *
 * Tests the complete REST lifecycle for both Python and TS runtimes:
 *   1. Create assistant (POST /assistants)
 *   2. Create thread (POST /threads)
 *   3. Create run + wait (POST /threads/:id/runs/wait)
 *   4. Stream run (POST /threads/:id/runs/stream)
 *   5. Get thread state (GET /threads/:id/state)
 *   6. Cleanup (DELETE assistant, thread)
 *
 * Prerequisites:
 *   - Mock LLM server running: bun run benchmarks/mock-llm/server.ts
 *   - Target runtime running with OPENAI_API_KEY=mock and
 *     OPENAI_BASE_URL=http://localhost:11434/v1
 *
 * Usage:
 *   # Against TS runtime (default, port 3000)
 *   k6 run benchmarks/k6/agent-flow.js
 *
 *   # Against Python runtime (port 8081)
 *   k6 run -e RUNTIME_URL=http://localhost:8081 benchmarks/k6/agent-flow.js
 *
 *   # Smoke test (1 VU, 1 iteration)
 *   k6 run -e SMOKE=1 benchmarks/k6/agent-flow.js
 *
 *   # Load test (10 VUs, 60s)
 *   k6 run --vus 10 --duration 60s benchmarks/k6/agent-flow.js
 *
 *   # Compare both runtimes (run sequentially, compare results)
 *   k6 run -e RUNTIME_URL=http://localhost:3000 -e RUNTIME_NAME=ts \
 *     --out json=results-ts.json benchmarks/k6/agent-flow.js
 *   k6 run -e RUNTIME_URL=http://localhost:8081 -e RUNTIME_NAME=python \
 *     --out json=results-python.json benchmarks/k6/agent-flow.js
 *
 * Environment Variables:
 *   RUNTIME_URL   — Base URL of the runtime (default: http://localhost:3000)
 *   RUNTIME_NAME  — Label for results (default: "ts")
 *   SMOKE         — If "1", run a single iteration smoke test
 *   AUTH_TOKEN     — Bearer token for authenticated runtimes (optional)
 *   GRAPH_ID       — Graph ID to use (default: "agent")
 *   MODEL_NAME     — Model name to pass to assistant (default: "mock-gpt-4o")
 */

import http from "k6/http";
import { check, group, sleep, fail } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const RUNTIME_URL = __ENV.RUNTIME_URL || "http://localhost:3000";
const RUNTIME_NAME = __ENV.RUNTIME_NAME || "ts";
const AUTH_TOKEN = __ENV.AUTH_TOKEN || "";
const GRAPH_ID = __ENV.GRAPH_ID || "agent";
const MODEL_NAME = __ENV.MODEL_NAME || "openai:mock-gpt-4o";
const IS_SMOKE = __ENV.SMOKE === "1";

// ---------------------------------------------------------------------------
// k6 options
// ---------------------------------------------------------------------------

export const options = IS_SMOKE
  ? {
      vus: 1,
      iterations: 1,
      thresholds: {
        http_req_failed: ["rate==0"],
      },
    }
  : {
      scenarios: {
        // Ramp-up scenario: tests concurrent agent flows
        ramp_up: {
          executor: "ramping-vus",
          startVUs: 1,
          stages: [
            { duration: "10s", target: 5 },
            { duration: "30s", target: 5 },
            { duration: "10s", target: 10 },
            { duration: "30s", target: 10 },
            { duration: "10s", target: 0 },
          ],
          gracefulRampDown: "10s",
        },
      },
      thresholds: {
        // HTTP request failure rate < 5%
        http_req_failed: ["rate<0.05"],
        // 95th percentile response time for assistant creation < 500ms
        "http_req_duration{operation:create_assistant}": ["p(95)<500"],
        // 95th percentile for thread creation < 500ms
        "http_req_duration{operation:create_thread}": ["p(95)<500"],
        // 95th percentile for run/wait < 5s (includes mock LLM delay)
        "http_req_duration{operation:run_wait}": ["p(95)<5000"],
        // Custom metrics
        agent_flow_duration: ["p(95)<8000"],
        agent_flow_success_rate: ["rate>0.95"],
      },
    };

// ---------------------------------------------------------------------------
// Custom metrics
// ---------------------------------------------------------------------------

const agentFlowDuration = new Trend("agent_flow_duration", true);
const agentFlowSuccessRate = new Rate("agent_flow_success_rate");
const assistantsCreated = new Counter("assistants_created");
const threadsCreated = new Counter("threads_created");
const runsCompleted = new Counter("runs_completed");
const streamsCompleted = new Counter("streams_completed");
const cleanupErrors = new Counter("cleanup_errors");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function headers() {
  const headerMap = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (AUTH_TOKEN) {
    headerMap["Authorization"] = `Bearer ${AUTH_TOKEN}`;
  }
  return headerMap;
}

function jsonBody(payload) {
  return JSON.stringify(payload);
}

function parseJsonResponse(response, label) {
  try {
    return JSON.parse(response.body);
  } catch (parseError) {
    console.error(
      `[${RUNTIME_NAME}] Failed to parse ${label} response: ${response.status} ${response.body}`,
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// API operations
// ---------------------------------------------------------------------------

function createAssistant() {
  const payload = {
    graph_id: GRAPH_ID,
    config: {
      configurable: {
        model_name: MODEL_NAME,
      },
    },
    metadata: {
      benchmark: true,
      runtime: RUNTIME_NAME,
      vu: __VU,
      iter: __ITER,
    },
    name: `bench-${RUNTIME_NAME}-vu${__VU}-iter${__ITER}`,
  };

  const response = http.post(`${RUNTIME_URL}/assistants`, jsonBody(payload), {
    headers: headers(),
    tags: { operation: "create_assistant" },
  });

  const body = parseJsonResponse(response, "create_assistant");
  const success =
    check(response, {
      "create assistant: status 200": (r) => r.status === 200,
      "create assistant: has assistant_id": () =>
        body && body.assistant_id !== undefined,
    }) && body !== null;

  if (success) {
    assistantsCreated.add(1);
  }

  return success ? body : null;
}

function createThread() {
  const payload = {
    metadata: {
      benchmark: true,
      runtime: RUNTIME_NAME,
    },
  };

  const response = http.post(`${RUNTIME_URL}/threads`, jsonBody(payload), {
    headers: headers(),
    tags: { operation: "create_thread" },
  });

  const body = parseJsonResponse(response, "create_thread");
  const success =
    check(response, {
      "create thread: status 200": (r) => r.status === 200,
      "create thread: has thread_id": () =>
        body && body.thread_id !== undefined,
    }) && body !== null;

  if (success) {
    threadsCreated.add(1);
  }

  return success ? body : null;
}

function runAndWait(threadId, assistantId) {
  const payload = {
    assistant_id: assistantId,
    input: {
      messages: [
        {
          role: "user",
          content: `Benchmark test message from VU ${__VU}, iteration ${__ITER}`,
        },
      ],
    },
    config: {
      configurable: {
        model_name: MODEL_NAME,
      },
    },
  };

  const response = http.post(
    `${RUNTIME_URL}/threads/${threadId}/runs/wait`,
    jsonBody(payload),
    {
      headers: headers(),
      tags: { operation: "run_wait" },
      timeout: "30s",
    },
  );

  const body = parseJsonResponse(response, "run_wait");
  const success = check(response, {
    "run/wait: status 200": (r) => r.status === 200,
    "run/wait: has response body": () => body !== null,
  });

  if (success) {
    runsCompleted.add(1);
  }

  return success ? body : null;
}

function runStream(threadId, assistantId) {
  const payload = {
    assistant_id: assistantId,
    input: {
      messages: [
        {
          role: "user",
          content: `Streaming benchmark from VU ${__VU}, iteration ${__ITER}`,
        },
      ],
    },
    config: {
      configurable: {
        model_name: MODEL_NAME,
      },
    },
  };

  const response = http.post(
    `${RUNTIME_URL}/threads/${threadId}/runs/stream`,
    jsonBody(payload),
    {
      headers: headers(),
      tags: { operation: "run_stream" },
      timeout: "30s",
    },
  );

  // SSE streams return 200 with text/event-stream content type.
  // k6 receives the full response body after the stream ends.
  const success = check(response, {
    "run/stream: status 200": (r) => r.status === 200,
    "run/stream: has body": (r) => r.body && r.body.length > 0,
    "run/stream: contains event data": (r) =>
      r.body && r.body.includes("data:"),
  });

  if (success) {
    streamsCompleted.add(1);
  }

  return success;
}

function getThreadState(threadId) {
  const response = http.get(`${RUNTIME_URL}/threads/${threadId}/state`, {
    headers: headers(),
    tags: { operation: "get_state" },
  });

  check(response, {
    "get state: status 200": (r) => r.status === 200,
  });

  return parseJsonResponse(response, "get_state");
}

function deleteAssistant(assistantId) {
  const response = http.del(`${RUNTIME_URL}/assistants/${assistantId}`, null, {
    headers: headers(),
    tags: { operation: "delete_assistant" },
  });

  if (response.status !== 200 && response.status !== 204) {
    cleanupErrors.add(1);
  }
}

function deleteThread(threadId) {
  const response = http.del(`${RUNTIME_URL}/threads/${threadId}`, null, {
    headers: headers(),
    tags: { operation: "delete_thread" },
  });

  if (response.status !== 200 && response.status !== 204) {
    cleanupErrors.add(1);
  }
}

// ---------------------------------------------------------------------------
// Health check (setup)
// ---------------------------------------------------------------------------

export function setup() {
  console.log(`[${RUNTIME_NAME}] Benchmark target: ${RUNTIME_URL}`);
  console.log(`[${RUNTIME_NAME}] Graph ID: ${GRAPH_ID}, Model: ${MODEL_NAME}`);

  const healthResponse = http.get(`${RUNTIME_URL}/health`, {
    headers: headers(),
    timeout: "5s",
  });

  if (healthResponse.status !== 200) {
    fail(
      `Runtime not reachable at ${RUNTIME_URL}/health — got status ${healthResponse.status}. ` +
        `Make sure the runtime is running.`,
    );
  }

  const infoResponse = http.get(`${RUNTIME_URL}/info`, {
    headers: headers(),
    timeout: "5s",
  });

  let runtimeInfo = null;
  if (infoResponse.status === 200) {
    runtimeInfo = parseJsonResponse(infoResponse, "info");
  }

  console.log(
    `[${RUNTIME_NAME}] Runtime healthy. Version: ${runtimeInfo ? runtimeInfo.version : "unknown"}`,
  );

  return { runtimeInfo: runtimeInfo };
}

// ---------------------------------------------------------------------------
// Main test flow
// ---------------------------------------------------------------------------

export default function (_setupData) {
  const flowStart = Date.now();
  let flowSuccess = true;
  let assistantId = null;
  let threadId = null;

  // Step 1: Create assistant
  group("01_create_assistant", function () {
    const assistant = createAssistant();
    if (!assistant) {
      flowSuccess = false;
      return;
    }
    assistantId = assistant.assistant_id;
  });

  if (!assistantId) {
    agentFlowDuration.add(Date.now() - flowStart);
    agentFlowSuccessRate.add(false);
    return;
  }

  // Step 2: Create thread
  group("02_create_thread", function () {
    const thread = createThread();
    if (!thread) {
      flowSuccess = false;
      return;
    }
    threadId = thread.thread_id;
  });

  if (!threadId) {
    // Cleanup assistant
    deleteAssistant(assistantId);
    agentFlowDuration.add(Date.now() - flowStart);
    agentFlowSuccessRate.add(false);
    return;
  }

  // Step 3: Run and wait for completion
  group("03_run_wait", function () {
    const result = runAndWait(threadId, assistantId);
    if (!result) {
      flowSuccess = false;
    }
  });

  // Step 4: Stream a follow-up message
  group("04_run_stream", function () {
    const streamSuccess = runStream(threadId, assistantId);
    if (!streamSuccess) {
      flowSuccess = false;
    }
  });

  // Step 5: Get final thread state
  group("05_get_state", function () {
    getThreadState(threadId);
  });

  // Step 6: Cleanup
  group("06_cleanup", function () {
    if (threadId) {
      deleteThread(threadId);
    }
    if (assistantId) {
      deleteAssistant(assistantId);
    }
  });

  // Record flow metrics
  agentFlowDuration.add(Date.now() - flowStart);
  agentFlowSuccessRate.add(flowSuccess);

  // Brief pause between iterations to avoid overwhelming the runtime
  sleep(0.5);
}

// ---------------------------------------------------------------------------
// Teardown — print summary
// ---------------------------------------------------------------------------

export function teardown(_setupData) {
  console.log(`[${RUNTIME_NAME}] Benchmark complete against ${RUNTIME_URL}`);
}
