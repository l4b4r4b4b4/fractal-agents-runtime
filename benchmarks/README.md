# Benchmarks — Fractal Agents Runtime

Comparative benchmarks for the **TypeScript/Bun** and **Python/Robyn** runtimes.

## Architecture

```
benchmarks/
├── README.md              # This file
├── mock-llm/
│   └── server.ts          # Fake OpenAI /v1/chat/completions (Bun)
└── k6/
    └── agent-flow.js      # Full agent lifecycle benchmark (k6)
```

### Tier 1: Mock LLM (Runtime Overhead)

Measures pure **runtime overhead** — HTTP routing, serialization, storage,
streaming — by pointing both runtimes at a mock LLM server that responds
instantly (configurable 10ms delay). This isolates the runtime from LLM
inference variance.

### Tier 2: Real LLM (End-to-End) — Future

Will measure end-to-end latency with a real LLM provider. Not yet implemented.

---

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| [Bun](https://bun.sh) | ≥1.3.9 | `curl -fsSL https://bun.sh/install \| bash` |
| [k6](https://grafana.com/docs/k6/) | ≥0.50 | `brew install k6` / [other](https://grafana.com/docs/k6/latest/set-up/install-k6/) |

---

## Quick Start

### 1. Start the Mock LLM Server

```bash
bun run benchmarks/mock-llm/server.ts
```

The server listens on `http://localhost:11434` by default. Verify:

```bash
curl http://localhost:11434/health
# {"status":"ok"}
```

### 2. Start a Runtime

**TypeScript runtime** (port 3000):

```bash
cd apps/ts
OPENAI_API_KEY=mock \
OPENAI_BASE_URL=http://localhost:11434/v1 \
MODEL_NAME=openai:mock-gpt-4o \
bun run src/index.ts
```

**Python runtime** (port 8081):

```bash
cd apps/python
OPENAI_API_KEY=mock \
OPENAI_BASE_URL=http://localhost:11434/v1 \
MODEL_NAME=openai:mock-gpt-4o \
python -m server
```

### 3. Run Benchmarks

**Smoke test** (1 VU, 1 iteration — verify everything works):

```bash
k6 run -e SMOKE=1 benchmarks/k6/agent-flow.js
```

**Against TS runtime:**

```bash
k6 run \
  -e RUNTIME_URL=http://localhost:3000 \
  -e RUNTIME_NAME=ts \
  --out json=benchmarks/results-ts.json \
  benchmarks/k6/agent-flow.js
```

**Against Python runtime:**

```bash
k6 run \
  -e RUNTIME_URL=http://localhost:8081 \
  -e RUNTIME_NAME=python \
  --out json=benchmarks/results-python.json \
  benchmarks/k6/agent-flow.js
```

---

## Mock LLM Server

A ~100-line Bun HTTP server that implements the OpenAI Chat Completions API
with configurable latency.

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/chat/completions` | Chat completions (streaming + non-streaming) |
| `GET`  | `/v1/models` | Model list (for LangChain provider init) |
| `GET`  | `/stats` | Request count, token totals, uptime |
| `GET`  | `/health` | Health check |

### Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `MOCK_LLM_PORT` | `11434` | Server port |
| `MOCK_LLM_DELAY_MS` | `10` | Base delay before first response (ms) |
| `MOCK_LLM_STREAM_DELAY_MS` | `5` | Delay between SSE chunks (ms) |
| `MOCK_LLM_RESPONSE` | *(42-word sentence)* | Static response text |
| `MOCK_LLM_MODEL` | `mock-gpt-4o` | Model name echoed in responses |

### Zero-Delay Mode

For measuring pure runtime overhead with no artificial latency:

```bash
MOCK_LLM_DELAY_MS=0 MOCK_LLM_STREAM_DELAY_MS=0 bun run benchmarks/mock-llm/server.ts
```

---

## k6 Agent Flow Benchmark

Tests the full REST lifecycle that the OAP frontend exercises:

1. **Create assistant** — `POST /assistants`
2. **Create thread** — `POST /threads`
3. **Run + wait** — `POST /threads/:id/runs/wait`
4. **Run + stream** — `POST /threads/:id/runs/stream`
5. **Get thread state** — `GET /threads/:id/state`
6. **Cleanup** — `DELETE` assistant and thread

### k6 Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `RUNTIME_URL` | `http://localhost:3000` | Base URL of the target runtime |
| `RUNTIME_NAME` | `ts` | Label for metrics and logs |
| `SMOKE` | *(unset)* | Set to `1` for single-iteration smoke test |
| `AUTH_TOKEN` | *(unset)* | Bearer token for authenticated runtimes |
| `GRAPH_ID` | `agent` | Graph ID for assistant creation |
| `MODEL_NAME` | `openai:mock-gpt-4o` | Model name passed in assistant config (must include provider prefix) |

### Default Scenario (ramp-up)

| Phase | Duration | Target VUs |
|-------|----------|------------|
| Ramp up | 10s | 1 → 5 |
| Sustain | 30s | 5 |
| Ramp up | 10s | 5 → 10 |
| Sustain | 30s | 10 |
| Ramp down | 10s | 10 → 0 |

### Thresholds

| Metric | Threshold | Description |
|--------|-----------|-------------|
| `http_req_failed` | < 5% | Overall HTTP error rate |
| `create_assistant p95` | < 500ms | Assistant creation latency |
| `create_thread p95` | < 500ms | Thread creation latency |
| `run_wait p95` | < 5000ms | Run completion latency (includes mock LLM) |
| `agent_flow_duration p95` | < 8000ms | Full flow end-to-end |
| `agent_flow_success_rate` | > 95% | Full flow success rate |

---

## Interpreting Results

### What Tier 1 Measures

- **HTTP routing overhead** — How fast the runtime can parse, route, and respond
- **Serialization cost** — JSON parsing/encoding for requests and responses
- **Storage operations** — In-memory CRUD for assistants, threads, runs
- **Streaming infrastructure** — SSE formatting, async generators, backpressure
- **Middleware cost** — Auth middleware (passthrough when unconfigured)

### What Tier 1 Does NOT Measure

- LLM inference latency (mocked out)
- Database persistence latency (uses in-memory storage by default)
- Network latency to external services
- MCP tool execution time

### Key Metrics to Compare

When comparing TS vs Python results, focus on:

1. **`http_req_duration` p50/p95/p99** — Per-operation latency
2. **`agent_flow_duration` p50/p95** — End-to-end flow time
3. **`http_req_failed` rate** — Error rates under load
4. **`http_reqs` count** — Total throughput
5. **`data_received` / `data_sent`** — Network efficiency

---

## Tips

- Run benchmarks on the **same machine** to eliminate hardware variance.
- Close other applications to reduce noise.
- Run each benchmark **3+ times** and compare medians, not single runs.
- Use `--out json=results.json` to save raw results for analysis.
- Check `http://localhost:11434/stats` after runs to verify the mock LLM received expected traffic.
- For Postgres persistence benchmarks, set `DATABASE_URL` and start both runtimes with a shared database.