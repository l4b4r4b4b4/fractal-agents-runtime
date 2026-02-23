/**
 * Mock LLM Server — Fake OpenAI `/v1/chat/completions`
 *
 * A minimal Bun HTTP server that mimics the OpenAI Chat Completions API.
 * Used for benchmarking runtime overhead without real LLM inference costs.
 *
 * Features:
 *   - Non-streaming: returns a complete ChatCompletion response after a delay
 *   - Streaming: returns SSE chunks with configurable inter-token delay
 *   - Configurable via environment variables or query params
 *   - Tracks request count and total tokens for basic stats
 *
 * Environment Variables:
 *   MOCK_LLM_PORT           — Server port (default: 11434)
 *   MOCK_LLM_DELAY_MS       — Base delay before first response (default: 10)
 *   MOCK_LLM_STREAM_DELAY_MS — Delay between SSE chunks (default: 5)
 *   MOCK_LLM_RESPONSE       — Static response text (default: see below)
 *   MOCK_LLM_MODEL          — Model name to echo back (default: "mock-gpt-4o")
 *
 * Usage:
 *   bun run benchmarks/mock-llm/server.ts
 *   curl http://localhost:11434/v1/chat/completions \
 *     -H "Content-Type: application/json" \
 *     -d '{"model":"mock","messages":[{"role":"user","content":"Hi"}]}'
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.MOCK_LLM_PORT ?? "11434", 10);
const BASE_DELAY_MS = parseInt(process.env.MOCK_LLM_DELAY_MS ?? "10", 10);
const STREAM_CHUNK_DELAY_MS = parseInt(process.env.MOCK_LLM_STREAM_DELAY_MS ?? "5", 10);
const MODEL_NAME = process.env.MOCK_LLM_MODEL ?? "mock-gpt-4o";

const DEFAULT_RESPONSE =
  "The answer to your question is 42. This is a mock response from the benchmark LLM server, " +
  "designed to test runtime overhead without real inference. The quick brown fox jumps over the lazy dog.";

const RESPONSE_TEXT = process.env.MOCK_LLM_RESPONSE ?? DEFAULT_RESPONSE;

// Split response into tokens (roughly word-level) for streaming
const RESPONSE_TOKENS = RESPONSE_TEXT.split(/(\s+)/);

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

let requestCount = 0;
let totalPromptTokens = 0;
let totalCompletionTokens = 0;
const startTime = Date.now();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function completionId(): string {
  return `chatcmpl-mock-${crypto.randomUUID().slice(0, 12)}`;
}

function unixTimestamp(): number {
  return Math.floor(Date.now() / 1000);
}

function estimateTokens(text: string): number {
  // Rough approximation: ~4 chars per token
  return Math.max(1, Math.ceil(text.length / 4));
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

// ---------------------------------------------------------------------------
// Non-streaming response
// ---------------------------------------------------------------------------

function buildChatCompletion(
  requestId: string,
  model: string,
  promptTokens: number,
): Record<string, unknown> {
  const completionTokens = estimateTokens(RESPONSE_TEXT);
  totalCompletionTokens += completionTokens;

  return {
    id: requestId,
    object: "chat.completion",
    created: unixTimestamp(),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: RESPONSE_TEXT,
        },
        logprobs: null,
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
    system_fingerprint: "mock_fp",
  };
}

// ---------------------------------------------------------------------------
// Streaming response (SSE)
// ---------------------------------------------------------------------------

function buildStreamChunk(
  requestId: string,
  model: string,
  content: string,
  finishReason: string | null,
): string {
  const chunk = {
    id: requestId,
    object: "chat.completion.chunk",
    created: unixTimestamp(),
    model,
    choices: [
      {
        index: 0,
        delta: finishReason ? {} : { content },
        logprobs: null,
        finish_reason: finishReason,
      },
    ],
  };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

function createStreamingResponse(
  requestId: string,
  model: string,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      // Initial chunk with role
      const roleChunk = {
        id: requestId,
        object: "chat.completion.chunk",
        created: unixTimestamp(),
        model,
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "" },
            logprobs: null,
            finish_reason: null,
          },
        ],
      };
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(roleChunk)}\n\n`));

      // Stream tokens
      for (const token of RESPONSE_TOKENS) {
        if (STREAM_CHUNK_DELAY_MS > 0) {
          await sleep(STREAM_CHUNK_DELAY_MS);
        }
        controller.enqueue(
          encoder.encode(buildStreamChunk(requestId, model, token, null)),
        );
      }

      // Final chunk with finish_reason
      controller.enqueue(
        encoder.encode(buildStreamChunk(requestId, model, "", "stop")),
      );

      // [DONE] sentinel
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));

      totalCompletionTokens += estimateTokens(RESPONSE_TEXT);
      controller.close();
    },
  });
}

// ---------------------------------------------------------------------------
// Request handler
// ---------------------------------------------------------------------------

async function handleChatCompletions(request: Request): Promise<Response> {
  requestCount++;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return new Response(
      JSON.stringify({ error: { message: "Invalid JSON body", type: "invalid_request_error" } }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const model = (body.model as string) ?? MODEL_NAME;
  const stream = body.stream === true;
  const messages = (body.messages as Array<Record<string, string>>) ?? [];

  // Estimate prompt tokens from messages
  const promptText = messages.map((message) => message.content ?? "").join(" ");
  const promptTokens = estimateTokens(promptText);
  totalPromptTokens += promptTokens;

  const requestId = completionId();

  // Apply base delay (simulates minimal processing time)
  if (BASE_DELAY_MS > 0) {
    await sleep(BASE_DELAY_MS);
  }

  if (stream) {
    return new Response(createStreamingResponse(requestId, model), {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Request-Id": requestId,
      },
    });
  }

  const completion = buildChatCompletion(requestId, model, promptTokens);
  return new Response(JSON.stringify(completion), {
    headers: { "Content-Type": "application/json", "X-Request-Id": requestId },
  });
}

// ---------------------------------------------------------------------------
// Models endpoint (needed by some LangChain providers)
// ---------------------------------------------------------------------------

function handleModels(): Response {
  return new Response(
    JSON.stringify({
      object: "list",
      data: [
        {
          id: MODEL_NAME,
          object: "model",
          created: unixTimestamp(),
          owned_by: "mock-benchmark",
        },
      ],
    }),
    { headers: { "Content-Type": "application/json" } },
  );
}

// ---------------------------------------------------------------------------
// Stats endpoint
// ---------------------------------------------------------------------------

function handleStats(): Response {
  const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);
  return new Response(
    JSON.stringify({
      requests: requestCount,
      prompt_tokens: totalPromptTokens,
      completion_tokens: totalCompletionTokens,
      uptime_seconds: uptimeSeconds,
      config: {
        base_delay_ms: BASE_DELAY_MS,
        stream_chunk_delay_ms: STREAM_CHUNK_DELAY_MS,
        model: MODEL_NAME,
        response_tokens: RESPONSE_TOKENS.length,
      },
    }),
    { headers: { "Content-Type": "application/json" } },
  );
}

// ---------------------------------------------------------------------------
// Health endpoint
// ---------------------------------------------------------------------------

function handleHealth(): Response {
  return new Response(JSON.stringify({ status: "ok" }), {
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = Bun.serve({
  port: PORT,
  fetch(request: Request): Response | Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Chat completions — the main endpoint
    if (path === "/v1/chat/completions" && request.method === "POST") {
      return handleChatCompletions(request);
    }

    // Models list
    if (path === "/v1/models" && request.method === "GET") {
      return handleModels();
    }

    // Stats (for benchmark analysis)
    if (path === "/stats" && request.method === "GET") {
      return handleStats();
    }

    // Health check
    if (path === "/health" && request.method === "GET") {
      return handleHealth();
    }

    // Root — info
    if (path === "/" && request.method === "GET") {
      return new Response(
        JSON.stringify({
          service: "mock-llm-server",
          purpose: "Benchmark harness — fake OpenAI API",
          endpoints: [
            "POST /v1/chat/completions",
            "GET  /v1/models",
            "GET  /stats",
            "GET  /health",
          ],
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    return new Response(
      JSON.stringify({ error: { message: "Not found", type: "invalid_request_error" } }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    );
  },
});

console.log(`🤖 Mock LLM Server listening on http://localhost:${server.port}`);
console.log(`   Model:              ${MODEL_NAME}`);
console.log(`   Base delay:         ${BASE_DELAY_MS}ms`);
console.log(`   Stream chunk delay: ${STREAM_CHUNK_DELAY_MS}ms`);
console.log(`   Response tokens:    ${RESPONSE_TOKENS.length}`);
