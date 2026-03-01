# Benchmarks — Fractal Agents Runtime

Comparative benchmarks for the **TypeScript/Bun** and **Python/Robyn** runtimes.

## Architecture

```
benchmarks/
├── README.md              # This file
├── mock-llm/
│   └── server.ts          # Fake OpenAI /v1/chat/completions (Bun)
├── k6/
│   └── agent-flow.js      # Full agent lifecycle benchmark (k6)
├── scripts/
│   ├── create-mock-jwt.sh # HS256 JWT generator (no Supabase dependency)
│   └── get-benchmark-token.sh  # Real Supabase JWT for integration benchmarks
└── results/
    ├── ts-v0.1.0-mock-5vu.json      # k6 raw JSON output
    └── python-v0.1.0-mock-5vu.json
```

### Tier 1: Mock LLM (Runtime Overhead)

Measures pure **runtime overhead** — HTTP routing, serialization, auth,
storage, streaming — by pointing both runtimes at a mock LLM server that
responds with configurable 10ms delay. This isolates the runtime from LLM
inference variance.

### Authentication Tiers

| Tier | Auth Method | Latency Impact | Use Case |
|------|------------|----------------|----------|
| **Mock/Local** | HS256 JWT via `SUPABASE_JWT_SECRET` | ~0ms (in-process) | Fast benchmarks, CI |
| **Integration** | Supabase GoTrue HTTP verification | ~5-50ms per request | Real-world auth testing |

The `create-mock-jwt.sh` script generates HS256 tokens for Tier 1 benchmarks.
The `get-benchmark-token.sh` script authenticates against a real Supabase instance for integration tests.

### Tier 2: Real LLM (End-to-End) — Future

Will measure end-to-end latency with a real LLM provider. Not yet implemented.

---

## Test Hardware

Results in this repository were collected on:

| Component | Specification |
|-----------|--------------|
| **CPU** | AMD Threadripper 3970X (64 threads) |
| **RAM** | 64 GB |
| **GPU** | RTX 3080 Ti (not used by benchmarks) |
| **OS** | NixOS 26.05, kernel 6.18.12 |
| **Bun** | 1.3.9 |
| **Python** | 3.12.12 |
| **k6** | 1.6.0 |

> Results will vary on different hardware. Always run both runtimes on the same machine for fair comparison.

---

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| [Bun](https://bun.sh) | ≥1.3.9 | `curl -fsSL https://bun.sh/install \| bash` |
| [k6](https://grafana.com/docs/k6/) | ≥1.6.0 | `brew install k6` / [other](https://grafana.com/docs/k6/latest/set-up/install-k6/) |
| [jq](https://jqlang.github.io/jq/) | any | For JWT script — `brew install jq` / `nix-env -i jq` |
| openssl | any | For JWT script — usually pre-installed |

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

### 2. Generate a Mock JWT

```bash
# Creates an HS256 JWT valid for 1 hour (no Supabase dependency)
AUTH_TOKEN=$(./benchmarks/scripts/create-mock-jwt.sh)
MOCK_SECRET="benchmark-jwt-secret-that-is-at-least-32-characters-long"
```

### 3. Start a Runtime

**TypeScript runtime** (port 9001):

```bash
PORT=9001 SUPABASE_URL=http://localhost:54321 SUPABASE_KEY=mock \
  SUPABASE_JWT_SECRET="$MOCK_SECRET" OPENAI_API_KEY=mock \
  OPENAI_BASE_URL=http://localhost:11434/v1 MODEL_NAME=openai:mock-gpt-4o \
  bun run apps/ts/src/index.ts
```

**Python runtime** (port 9002):

```bash
PORT=9002 SUPABASE_URL=http://localhost:54321 SUPABASE_KEY=mock \
  SUPABASE_JWT_SECRET="$MOCK_SECRET" OPENAI_API_KEY=mock \
  OPENAI_BASE_URL=http://localhost:11434/v1 MODEL_NAME=openai:mock-gpt-4o \
  LANGFUSE_SECRET_KEY= DATABASE_URL= \
  cd apps/python && uv run python -m server
```

### 4. Run Benchmarks

**Smoke test** (1 VU, 1 iteration — verify everything works):

```bash
k6 run -e SMOKE=1 -e AUTH_TOKEN="$AUTH_TOKEN" benchmarks/k6/agent-flow.js
```

**Against TS runtime:**

```bash
k6 run \
  -e RUNTIME_URL=http://localhost:9001 \
  -e RUNTIME_NAME=ts \
  -e AUTH_TOKEN="$AUTH_TOKEN" \
  --out json=benchmarks/results/ts-v0.1.0-mock-5vu.json \
  benchmarks/k6/agent-flow.js
```

**Against Python runtime:**

```bash
k6 run \
  -e RUNTIME_URL=http://localhost:9002 \
  -e RUNTIME_NAME=python \
  -e AUTH_TOKEN="$AUTH_TOKEN" \
  --out json=benchmarks/results/python-v0.1.0-mock-5vu.json \
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

Tests the full REST lifecycle that the LangGraph SDK exercises:

1. **Create assistant** — `POST /assistants`
2. **Create thread** — `POST /threads`
3. **Run + wait** — `POST /threads/:id/runs/wait`
4. **Run + stream** — `POST /threads/:id/runs/stream`
5. **Get thread state** — `GET /threads/:id/state`
6. **Stateless run** — `POST /runs/wait` (no thread, ephemeral)
7. **Store ops** — `PUT /store/items` → `GET /store/items` → `POST /store/items/search`
8. **Cleanup** — `DELETE` store item, thread, and assistant

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
| Warm up | 10s | 0 → 1 |
| Ramp up | 20s | 1 → 3 |
| Sustain | 30s | 3 → 5 |
| Ramp down | 20s | 5 → 3 |
| Cool down | 10s | 3 → 1 |

Total duration: ~90 seconds. For longer characterization runs, see [Goal 39](../.agent/goals/39-Benchmark-Methodology-Long-Duration/scratchpad.md).

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

## Result File Naming Convention

```
results/{runtime}-v{version}-{llm}-{vus}vu.json
```

Examples:
- `ts-v0.1.0-mock-5vu.json` — TypeScript, v0.1.0, mock LLM, 5 VU ramp
- `python-v0.1.0-mock-5vu.json` — Python, v0.1.0, mock LLM, 5 VU ramp

---

## Extracting Summary Stats from k6 JSON

The k6 `--out json` format is line-delimited JSON (one metric point per line). Use `jq` to extract summaries:

```bash
# Total iterations
grep '"agent_flow_duration"' results/ts-v0.1.0-mock-5vu.json | grep '"Point"' | wc -l

# Flow duration stats (ms)
grep '"agent_flow_duration"' results/ts-v0.1.0-mock-5vu.json | grep '"Point"' | \
  jq -s '[.[].data.value] | {count: length, min: min, max: max, avg: (add/length),
    p50: sort[length/2|floor], p95: sort[(length*0.95)|floor], p99: sort[(length*0.99)|floor]}'

# Per-operation latency
grep '"http_req_duration"' results/ts-v0.1.0-mock-5vu.json | grep '"Point"' | \
  grep '"operation":"run_wait"' | \
  jq -s '[.[].data.value] | {count: length, avg: (add/length),
    p50: sort[length/2|floor], p95: sort[(length*0.95)|floor]}'
```

---

## Tips

- Run benchmarks on the **same machine** to eliminate hardware variance.
- Close other applications to reduce noise.
- Run each benchmark **3+ times** and compare medians, not single runs.
- Use `--out json=results/<name>.json` to save raw results for analysis.
- Check `http://localhost:11434/stats` after runs to verify the mock LLM received expected traffic.
- For Postgres persistence benchmarks, set `DATABASE_URL` and start both runtimes with a shared database.
- Use `create-mock-jwt.sh` for fast, dependency-free benchmarks; `get-benchmark-token.sh` for integration testing with real Supabase auth.