# Task-05: Testing & Documentation — Docker Compose Stack + Tests + Docs

## Status
- [ ] Not Started
- [ ] In Progress
- [ ] Blocked
- [x] Complete (Session 4 — tests + docs finalized)

## Objective

Create a local development docker-compose stack for the semantic router, write comprehensive tests for all new code (LLM factory, model override, metadata passthrough), and update documentation. This task makes the integration testable end-to-end on a developer's machine.

---

## Context

The semantic router has a **pre-built image on GHCR** (`ghcr.io/vllm-project/semantic-router/vllm-sr:latest`) but **no docker-compose file exists in their repo** — the `vllm-sr` CLI manages containers via raw `docker run` commands. We need to create our own compose stack for local dev/testing, similar to how other services are composed in `docker-compose.yml`.

### Key Research Findings (from Task-01)

#### GHCR Image Details (verified from Dockerfile)

- **Image:** `ghcr.io/vllm-project/semantic-router/vllm-sr:latest`
- **Also available:** SHA-tagged versions (e.g., `502ac1ec62c111aa6c3db4cc00fc8348156b576b`)
- **Architecture:** Multi-stage build — Rust (candle BERT bindings) + Go (router + Envoy) + Python (CLI + ML) + Node (dashboard)
- **Entrypoint:** supervisord managing 4 processes:
  1. **Router** — Go binary, gRPC ExtProc on port 50051, health API on port 8080
  2. **Envoy** — generates config from `config.yaml`, proxies on configurable ports (default 8888)
  3. **Dashboard** — Go backend + React frontend on port 8700
  4. **Log forwarder** — tails logs to stdout/stderr

#### Container Internal Ports (from source code)

| Port | Process | Purpose | Expose? |
|------|---------|---------|---------|
| 50051 | Go router (gRPC ExtProc) | Envoy ↔ Router communication | No (internal) |
| 8080 | Go router (`-api-port=8080`) | Health API + REST classification API | No (healthcheck only) |
| **listener port** | Envoy | OpenAI-compatible proxy — **configured in config.yaml `listeners[].port`**, default 8000 | **YES** |
| 8700 | Dashboard backend | Web UI for routing decisions | Yes (optional) |
| 9190 | Go router (`-enable-api=true`) | Prometheus metrics | Yes (optional) |
| 9901 | Envoy admin | Envoy internal admin | No (debug only) |

⚠️ **Port correction:** The scratchpad previously stated port 8888 for the
Envoy proxy. This is WRONG. The Envoy listener port is configured via
`config.yaml → listeners[].port`. The upstream static `config/envoy.yaml`
uses 8801. If no `listeners` key is present in config.yaml, the
`config_generator.py` defaults to port 8000. We will use **8801** to match
upstream conventions.

⚠️ **Config format correction:** The `latest` GHCR image uses
`parse_user_config()` which validates against the `UserConfig` Pydantic
model. The old/flat format (used by testing configs) is NOT accepted by
the Envoy config generator in the `latest` image. We MUST use the new
format with `version: "v1"`, `providers:`, and `listeners:` keys. See
Session 3 findings below.

#### Container Requirements

| Requirement | Details |
|-------------|---------|
| Config | `config.yaml` volume-mounted to `/app/config.yaml` |
| Models | `models/` volume for HuggingFace BERT classifiers (~1.5GB, auto-downloaded on first start) |
| Backend LLM | Needs at least one LLM endpoint (Ollama, vLLM, or cloud API key) |
| Ports | 8888 (Envoy proxy), 8700 (dashboard), 9190 (Prometheus metrics), 50051 (gRPC), 8080 (health API) |
| Health check | `curl -f http://localhost:8080/health` inside container |
| First-boot time | Up to 30 minutes (model download) — CLI sets `HEALTH_CHECK_TIMEOUT = 1800` |
| Subsequent starts | Fast (models cached in volume) |
| CPU only | Router ML models (BERT classifiers) run on CPU — no GPU needed for the router itself |

#### Supervisord Process Tree (from `src/vllm-sr/supervisord.conf`)

```
supervisord
├── router          — /app/start-router.sh /app/config.yaml /app/.vllm-sr
├── envoy           — generates envoy.yaml from config.yaml, then runs envoy
├── dashboard       — /app/start-dashboard.sh /app/config.yaml
├── tail_access_logs — tails envoy access logs
└── log_forwarder   — forwards all logs to stdout/stderr
```

#### Config File Format (TWO formats exist — but `latest` image requires new format)

There are TWO config formats in the source code:

1. **Old/flat format** (used by testing configs in the repo): `vllm_endpoints`,
   `model_config`, `categories`, `decisions`, `bert_model`, etc. at the
   top level. The Go router can parse this directly.

2. **New/UserConfig format** (used by `latest` GHCR image): Has `version`,
   `listeners`, `providers.models`, `providers.external_models`, `decisions`.
   Parsed by the `UserConfig` Pydantic model in `cli/models.py`.

The config generator (`python -m cli.config_generator`) is invoked by
supervisord before starting Envoy. It reads the config file and generates
`/etc/envoy/envoy.yaml` from the Jinja2 template.

⚠️ **Validated in Session 3:** The `latest` image calls `parse_user_config()`
which validates against `UserConfig`. When we tried the old/flat format,
it failed with:
```
Configuration validation failed:
  • version: Field required
  • providers: Field required
```

**For our stack:** We MUST use the **new/UserConfig format** because the
`latest` image enforces it. The `UserConfig` model requires:
- `version: "v1"` (string, must start with "v")
- `listeners:` (list of `{name, address, port, timeout}`)
- `providers:` → `models:` (list of `{name, endpoints: [{name, weight, endpoint, protocol}]}`)
- `decisions:` (list of routing decisions)


The router config (`config.yaml`) defines:
- `vllm_endpoints` — backend LLM addresses (e.g., ministral on port 80)
- `categories` — domain categories for classification
- `decisions` — routing rules (domain → model mapping + plugins)
- `semantic_cache` — caching config (in-memory, Milvus, or hybrid)
- `prompt_guard` — jailbreak/PII detection settings
- `classifier` — category/PII model settings
- `default_model` — fallback model
- `observability` — tracing/metrics config
- `tools` — MCP tool routing config
- `embedding_models` — for semantic cache similarity

See full reference: `.agent/research/semantic-router/config/config.yaml`

## Acceptance Criteria

### Docker Compose Stack (Phase A — partially complete)
- [ ] `docker-compose.semantic-router.yml` (or profile in existing compose) with semantic router service
- [ ] Config file `config/semantic-router/config.yaml` tailored for our setup (ministral + cloud APIs)
- [ ] Named volume for model cache (survives `docker compose down`)
- [ ] Health check configured (with extended timeout for first boot)
- [ ] Router points to existing `ministral` service as primary backend
- [ ] Optional cloud API backends (OpenAI, Azure) via env vars
- [ ] Documentation in compose file comments for first-time setup

### Tests
- [ ] Unit tests for `graphs/llm.py` — `create_chat_model()` factory
- [ ] Unit tests for `graphs/configuration.py` — shared config models
- [ ] Unit tests for model override precedence
- [ ] Unit tests for routing metadata header injection
- [ ] Unit tests for `SEMANTIC_ROUTER_*` env var handling
- [ ] All existing tests pass (no regressions from Task-02/03/04 refactors)
- [ ] ≥73% code coverage maintained
- [ ] New code coverage ≥80% (diff-cover requirement)

### Documentation
- [ ] `docs/semantic-router.md` — integration guide
- [ ] README updated with semantic router section
- [ ] Env var reference table in docs
- [ ] Docker compose quick-start instructions

---

## Approach

### 1. Docker Compose Stack

#### Phased Approach

**Phase A (this session): Cloud-only smoke test**
- Route through the semantic router to the OpenAI API
- NO local vLLM dependency (ministral not required)
- Fastest path to verify the integration works end-to-end
- Config: single `gpt-4o` model via OpenAI API endpoint

**Phase B (future): Local vLLM + cloud failover**
- Add ministral as a local endpoint
- Route simple queries → ministral, complex → GPT-4o
- Requires GPU and ministral service running

#### Architecture (Phase A)

```
                    ┌──────────────────────────────┐
                    │     robyn-server (runtime)    │
                    │     localhost:8081             │
                    └──────────┬───────────────────┘
                               │ POST /v1/chat/completions
                               │ model="MoM"
                               │ Headers: x-sr-graph-id, x-sr-org-id
                               ▼
                    ┌──────────────────────────────┐
                    │     semantic-router           │
                    │     ghcr.io/vllm-project/     │
                    │       semantic-router/        │
                    │       vllm-sr:latest          │
                    │     Port 8801 (Envoy proxy)   │
                    │     Port 8700 (Dashboard)     │
                    │     Port 9190 (Metrics)       │
                    └──────────┬───────────────────┘
                               │
                               ▼
                    ┌──────────────────────────────┐
                    │     OpenAI API (cloud)        │
                    │     api.openai.com:443        │
                    └──────────────────────────────┘
```

#### Proposed Compose Service

```yaml
# docker-compose.semantic-router.yml
services:
  semantic-router:
    image: ghcr.io/vllm-project/semantic-router/vllm-sr:latest
    container_name: semantic-router
    volumes:
      - ./config/semantic-router/config.yaml:/app/config.yaml:ro
      - sr_models:/app/models
    ports:
      - "8801:8801"   # Envoy proxy (OpenAI-compatible API) — matches upstream docs
      - "8700:8700"   # Dashboard UI
      - "9190:9190"   # Prometheus metrics
    environment:
      - OPENAI_API_KEY=${OPENAI_API_KEY:-}
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-}
    restart: unless-stopped
    healthcheck:
      # Health endpoint is on the Go router's API port (8080), NOT Envoy
      test: ["CMD", "curl", "-f", "http://localhost:8080/health"]
      interval: 30s
      timeout: 10s
      retries: 60        # 60 retries × 30s = 30 min max for first-boot model download
      start_period: 120s  # Give 2 min before first check
    networks:
      - default
    ulimits:
      nofile:
        soft: 65536
        hard: 65536

volumes:
  sr_models:
    name: semantic-router-models
```

⚠️ **Key changes from original plan:**
- Port 8801 (not 8888) — matches upstream `config/envoy.yaml` and docs
- Removed `depends_on: ministral` — Phase A uses cloud APIs only
- Health check on port 8080 (Go router API), confirmed from `start-router.sh`

#### Router Config — Phase A (`config/semantic-router/config.yaml`)

Cloud-only config using the **old/flat format** (same as upstream testing
configs). Routes everything through OpenAI API. Uses the `listeners` key
to set the Envoy port to 8801.

```yaml
# Semantic Router — Phase A: Cloud-only (OpenAI API)
# Format: old/flat (matches upstream testing configs)

# Listener — Envoy proxy port (the port our runtime calls)
listeners:
  - name: "openai_listener"
    address: "0.0.0.0"
    port: 8801
    timeout: "300s"

# BERT classifiers for domain/PII/jailbreak (CPU-only, auto-downloaded)
bert_model:
  model_id: models/mom-embedding-light
  threshold: 0.6
  use_cpu: true

# Semantic cache (in-memory, no external deps)
semantic_cache:
  enabled: true
  backend_type: "memory"
  similarity_threshold: 0.8
  max_entries: 1000
  ttl_seconds: 3600

# Prompt guard (CPU-only BERT classifiers)
prompt_guard:
  enabled: true
  use_modernbert: false
  model_id: "models/mom-jailbreak-classifier"
  threshold: 0.7
  use_cpu: true
  jailbreak_mapping_path: "models/mom-jailbreak-classifier/jailbreak_type_mapping.json"

# Cloud API endpoints — OpenAI (no local vLLM for Phase A)
vllm_endpoints:
  - name: "openai"
    provider_profile: "openai-prod"
    type: "openai"

provider_profiles:
  openai-prod:
    type: "openai"
    base_url: "https://api.openai.com/v1"

# Model config — which endpoint serves which model
model_config:
  "gpt-4o":
    preferred_endpoints: ["openai"]
  "gpt-4o-mini":
    preferred_endpoints: ["openai"]

# Categories for document processing
categories:
  - name: extraction
    description: "Document data extraction tasks"
  - name: classification
    description: "Document classification and categorization"
  - name: chat
    description: "Conversational queries"
  - name: analysis
    description: "Complex document analysis"
  - name: other
    description: "General queries"

# Routing decisions
strategy: "priority"

decisions:
  - name: "simple_query"
    description: "Simple chat queries → gpt-4o-mini (cheaper)"
    priority: 100
    rules:
      operator: "AND"
      conditions:
        - type: "domain"
          name: "chat"
    modelRefs:
      - model: "gpt-4o-mini"
        use_reasoning: false

  - name: "extraction_query"
    description: "Data extraction → gpt-4o (more capable)"
    priority: 100
    rules:
      operator: "AND"
      conditions:
        - type: "domain"
          name: "extraction"
    modelRefs:
      - model: "gpt-4o"
        use_reasoning: false

  - name: "analysis_query"
    description: "Complex analysis → gpt-4o"
    priority: 100
    rules:
      operator: "AND"
      conditions:
        - type: "domain"
          name: "analysis"
    modelRefs:
      - model: "gpt-4o"
        use_reasoning: false

  - name: "general_fallback"
    description: "Everything else → gpt-4o-mini"
    priority: 50
    rules:
      operator: "AND"
      conditions:
        - type: "domain"
          name: "other"
    modelRefs:
      - model: "gpt-4o-mini"
        use_reasoning: false

default_model: "gpt-4o-mini"

# Reasoning families (for models that support structured reasoning)
reasoning_families:
  gpt:
    type: "reasoning_effort"
    parameter: "reasoning_effort"
```

#### Router Config — Phase B (future: local vLLM + cloud failover)

```yaml
# Same as Phase A, PLUS:
vllm_endpoints:
  - name: "openai"
    provider_profile: "openai-prod"
    type: "openai"
  - name: "ministral"
    address: "ministral"    # Docker service name
    port: 80
    weight: 1
    health_check_path: "/health"

model_config:
  "gpt-4o":
    preferred_endpoints: ["openai"]
  "gpt-4o-mini":
    preferred_endpoints: ["openai"]
  "ministral-3b-instruct":
    preferred_endpoints: ["ministral"]

# Route simple queries to ministral, complex to GPT-4o
decisions:
  - name: "simple_query"
    modelRefs:
      - model: "ministral-3b-instruct"   # Changed from gpt-4o-mini
  # ... etc.
```

### 2. Implementation Plan — Bringing Up the Stack

#### Step 1: Create compose file and config
- Create `docker-compose.semantic-router.yml` in project root
- Create `config/semantic-router/config.yaml` (Phase A cloud-only config)
- Verify compose file is syntactically valid (`docker compose config`)

#### Step 2: Pull image and start container
- `docker compose -f docker-compose.semantic-router.yml pull`
- `docker compose -f docker-compose.semantic-router.yml up -d`
- Watch logs for model downloads (first boot: ~1.5GB, up to 30 min)
- Wait for health check to pass

#### Step 3: Smoke test the proxy
- `curl http://localhost:8801/v1/chat/completions` with `model: "gpt-4o-mini"`
- Verify response comes back (router forwards to OpenAI API)
- Check dashboard at `http://localhost:8700`

#### Step 4: Test with runtime env vars
- Set `SEMANTIC_ROUTER_ENABLED=true`, `SEMANTIC_ROUTER_URL=http://localhost:8801/v1`
- Run the Python runtime manually or via a quick script
- Verify the runtime routes through the router (check router logs)

#### Step 5: Write integration test (mocked)
- Test that exercises `create_chat_model()` with router env vars + metadata
- Does NOT require running router (mocked at the `ChatOpenAI` constructor level)
- Verifies the correct URL, model, and headers are passed

---

### 3. Test Strategy

#### Existing Test File: `tests/test_llm_factory.py` (already done in Tasks 03+04)

```python
# Test categories:
# 1. create_chat_model() — standard provider path
# 2. create_chat_model() — custom endpoint path
# 3. get_api_key_for_model() — provider → env var mapping
# 4. model_name_override — precedence matrix
# 5. routing_metadata — header injection
# 6. SEMANTIC_ROUTER_* env vars — system-level override
# 7. Backward compatibility — existing configs still work
```

Task-03 and Task-04 already added 26 tests covering model override,
routing metadata headers, and semantic router env vars. 67 total tests
in the file now, 100% coverage on `graphs/llm.py`.

#### Tests for Shared Config Models: `tests/test_configuration.py`

```python
# 1. RagConfig — default values, serialization
# 2. MCPServerConfig — all fields, defaults
# 3. MCPConfig — nested model, empty servers
# 4. Import paths — graphs.configuration exports correctly
```

#### Existing Test Updates

Mock paths change from Task-02 refactor:
- `patch("graphs.react_agent.ChatOpenAI")` → `patch("graphs.llm.ChatOpenAI")`
- `patch("graphs.react_agent.init_chat_model")` → `patch("graphs.llm.init_chat_model")`
- `patch("graphs.research_agent.ChatOpenAI")` → `patch("graphs.llm.ChatOpenAI")`
- `patch("graphs.research_agent.init_chat_model")` → `patch("graphs.llm.init_chat_model")`

### 4. Documentation

#### `docs/semantic-router.md` — Integration Guide

Sections:
1. Overview — what the semantic router does
2. Quick Start — docker compose up
3. Configuration — config.yaml reference
4. Environment Variables — table of all new env vars
5. Runtime Integration — how model override + metadata work
6. Architecture — diagram showing request flow
7. Troubleshooting — common issues (first-boot model download, connectivity)

#### README Update

Add a "Semantic Router" section under Features:
- Brief description
- Link to `docs/semantic-router.md`
- Quick compose command

### Implementation Steps (revised)

1. **Create `config/semantic-router/config.yaml`** — router config tailored for our stack
2. **Create `docker-compose.semantic-router.yml`** — standalone compose file for the router stack
3. **Write `tests/test_llm_factory.py`** — comprehensive unit tests for shared factory
4. **Write `tests/test_configuration.py`** — tests for shared config models
5. **Update existing test mock paths** — fix any broken mocks from Task-02 refactor
6. **Run full test suite** — verify ≥73% coverage, no regressions
7. **Create `docs/semantic-router.md`** — integration guide
8. **Update `README.md`** — add semantic router section
9. **Run linting** — `ruff check . --fix --unsafe-fixes && ruff format .`

---

## Docker Compose Usage Guide (for docs — corrected)

### First-Time Setup

```bash
# 1. Start the semantic router (first boot downloads ~1.5GB of ML models)
#    No ministral/vLLM dependency for Phase A — uses cloud OpenAI API
docker compose -f docker-compose.semantic-router.yml up -d

# 2. Watch logs for model downloads (first boot can take 5-30 min)
docker compose -f docker-compose.semantic-router.yml logs -f semantic-router

# 3. Verify health (Go router API on port 8080 INSIDE container)
docker compose -f docker-compose.semantic-router.yml exec semantic-router \
  curl -f http://localhost:8080/health

# 4. Test the Envoy proxy endpoint (port 8801 on host)
curl http://localhost:8801/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -d '{"model": "gpt-4o-mini", "messages": [{"role": "user", "content": "Hello!"}]}'

# 5. Open the dashboard
open http://localhost:8700
```

### Subsequent Starts (fast — models are cached in named volume)

```bash
docker compose -f docker-compose.semantic-router.yml up -d
# Ready in ~30 seconds (models already in sr_models volume)
```

### Connect the Python Runtime

```bash
# Set env vars to route through semantic router
export SEMANTIC_ROUTER_ENABLED=true
export SEMANTIC_ROUTER_URL=http://localhost:8801/v1
export SEMANTIC_ROUTER_MODEL=MoM

# Start the runtime (all LLM calls now go through the router)
cd apps/python && uv run python -m server.main
```

### Stop Everything

```bash
docker compose -f docker-compose.semantic-router.yml down
# Models volume is preserved — next start will be fast
# To delete models too: docker volume rm semantic-router-models
```

---

## Notes & Discoveries

### Key Insight: No Compose in Upstream Repo

The vllm-project/semantic-router repo has **no docker-compose file**. The `vllm-sr` CLI (`src/vllm-sr/cli/core.py`) manages containers via raw `docker run` commands:

1. Creates a Docker network (`vllm-sr-network`)
2. Starts individual containers (jaeger, prometheus, grafana, vllm-sr)
3. Health-checks via `docker exec curl`

Their docs reference `deploy/docker-compose/docker-compose.yml` but the file **does not exist** — likely planned but not implemented. This is why we need to create our own.

### First-Boot Model Downloads

The container automatically downloads HuggingFace models on first start:
- Category classifier (ModernBERT-base) — from `LLM-Semantic-Router/` org
- PII classifier (ModernBERT-base)
- Jailbreak classifier (ModernBERT-base)
- Embedding model (Qwen3-Embedding-0.6B)

Total: ~1.5GB. Cached in `/app/models` → our `sr_models` named volume.

**If HuggingFace is slow:** Set `HF_ENDPOINT=https://hf-mirror.com` env var on the container.

### Nothing Prevents a Compose Stack

The container is self-contained (supervisord manages all internal processes). It:
- Doesn't require any special kernel modules
- Runs on CPU only (BERT models are small)
- Has no external state dependencies (optional Redis/Milvus for cache, but memory backend works)
- Exposes standard HTTP ports
- Has a health endpoint

It's just a normal Docker container. Perfect for compose.

### Session 3 Source Code Findings

Key corrections discovered from reading actual source code:

| Finding | Scratchpad Assumption | Actual (from source) |
|---------|----------------------|---------------------|
| Envoy proxy port | 8888 | Configured in `config.yaml → listeners[].port`, default 8000, upstream uses 8801 |
| Health check port | 8080 (correct) | Confirmed: `start-router.sh` starts router with `-api-port=8080` |
| Config format | Old/flat format | **`latest` image requires new UserConfig format** (`version` + `providers` required). Old format fails validation. |
| Envoy config generation | Assumed static | Dynamic: `python -m cli.config_generator config.yaml envoy.yaml` runs in supervisord before Envoy starts |
| `listeners` key | Not mentioned | Must be in config.yaml to control Envoy port; otherwise defaults to 8000 |
| Dockerfile EXPOSE | Assumed 8888 | Actually: 50051, 9190, 9901, 8700 (no Envoy port — it's dynamic) |
| Cloud-only possible | Assumed vLLM required | Yes: `providers.models[].endpoints` with `api.openai.com:443` + `protocol: "https"` |
| API key forwarding | Assumed env var injection | Client must pass `Authorization: Bearer` header — Envoy forwards it. Router env var `OPENAI_API_KEY` is NOT auto-injected into requests. |

### Session 3 Bring-Up Results

**✅ Stack is running and validated end-to-end.**

#### Files Created
- `config/semantic-router/config.yaml` — UserConfig v1 format, OpenAI cloud endpoints, Envoy on port 8801
- `docker-compose.semantic-router.yml` — standalone compose, health check, named model volume

#### Model Downloads (first boot: ~2 min on fast network)
| # | Model | Purpose |
|---|-------|---------|
| 1 | `mom-embedding-ultra` | Embedding for semantic cache (HNSW similarity) |
| 2 | `mmbert32k-intent-classifier-merged` | Domain/category classifier (routes queries to decisions) |
| 3 | `mmbert32k-pii-detector-merged` | PII detection |
| 4 | `mmbert32k-jailbreak-detector-merged` | Jailbreak/prompt injection detection |
| 5 | `mmbert32k-factcheck-classifier-merged` | Fact-check signal |
| 6 | `mom-halugate-detector` + `mom-halugate-explainer` | Hallucination gate (detector + explainer pair) |

All CPU-only ModernBERT models. Total ~1.5GB. Cached in `semantic-router-models` named volume.

#### Validation Tests Performed
1. **Health check:** `curl http://localhost:8080/health` → `{"status": "healthy", "service": "classification-api"}` ✅
2. **Direct curl with auth header:** `curl http://localhost:8801/v1/chat/completions` with `Authorization: Bearer $OPENAI_API_KEY` → got `gpt-4o-mini` response ✅
3. **MoM model name:** `model: "MoM"` accepted — router classified and routed to `gpt-4o-mini` ✅
4. **Python runtime integration:** `SEMANTIC_ROUTER_ENABLED=true` + `create_chat_model()` → `ChatOpenAI(base_url="http://localhost:8801/v1", model="gpt-4o-mini")` → invoked successfully, response: "Router works!" ✅
5. **Routing metadata headers:** `x-sr-graph-id` and `x-sr-org-id` passed via `default_headers` — no errors ✅
6. **Container status:** `docker compose ps` shows `(healthy)` ✅

#### Known Limitations (Phase A)
- **All queries route to `gpt-4o-mini`** — The default MMLU-based domain classifier doesn't distinguish our custom categories (extraction, analysis, etc.). Most queries fall to "other" → `gpt-4o-mini`. Tuning the classifier for our domain categories is a separate task.
- **API key must come from client** — The `OPENAI_API_KEY` env var on the container is available to the Go router for its own API calls, but Envoy does NOT inject it into proxied requests. The client (`ChatOpenAI`) must send `Authorization: Bearer` header, which it already does via `openai_api_key` kwarg.
- **No `authz` config** — For production, the router supports Authorino-based auth with per-user API keys. Not needed for dev stack.

### Session 3 Research: Custom Embedding Models

**Can we swap in Jina v2 or Vago German embeddings?** No — the router's embedding models are hardwired via Rust FFI (`libcandle_semantic_router.so`). It supports exactly 4 families:

| Config key | Model family | Dim | Purpose |
|---|---|---|---|
| `qwen3_model_path` | Qwen3-Embedding-0.6B | 1024 | Semantic cache + embedding signals |
| `gemma_model_path` | EmbeddingGemma-300M | var | Alternative embedding |
| `mmbert_model_path` | mmBERT 2D Matryoshka | 64-768 | Multi-resolution embedding |
| `bert_model_path` | BERT/MiniLM (sentence-transformers) | 384 | Memory retrieval |

These are specific Rust bindings compiled into the binary. Custom architectures (Jina, Vago) would require changes to the Rust candle binding layer. **This doesn't matter for our use case** — these embeddings are only used inside the router for semantic cache similarity. RAG embeddings go through the separate TEI container.

### Session 3 Research: Language-Based Routing

**First-class signal — fully supported, zero extra config.** The router has a built-in language classifier using `whatlanggo` (Go library, 100+ languages, no model download). It detects query language and outputs ISO codes (`"de"`, `"en"`, etc.).

Configuration example:
```yaml
signals:
  languages:
    - name: "de"
      description: "German language queries"
    - name: "en"
      description: "English language queries"

decisions:
  - name: "german_extraction"
    priority: 300
    rules:
      operator: "AND"
      conditions:
        - type: "language"
          name: "de"
        - type: "domain"
          name: "extraction"
    modelRefs:
      - model: "german-extraction-model"
```

Language detection happens **in parallel** with domain classification and all other signals. Can be composed with boolean operators (AND/OR/NOT). Very relevant for our German real estate doc processing platform.

**Deferred to Phase B** — need multiple model backends to actually route between.

### Session 3 Research: Modality Routing (OCR via Vision Models)

The router has a `modality` signal that can detect whether a prompt requires text (AR), image (DIFFUSION), or both (BOTH). Uses a hybrid approach: mmBERT classifier + keyword matching. Config: `modality_detector.enabled: true, method: "hybrid"`.

This means OCR via vision LLMs (e.g., DeepSeek-VL) could work through the router — if the request uses the standard OpenAI vision format (`image_url` in message content parts), the modality detector can classify it and route to a vision-capable model.

**Limitation:** Only works for `/v1/chat/completions` API shape. Dedicated OCR services, TTS (`/v1/audio/speech`), STT/Whisper (`/v1/audio/transcriptions`), and embeddings (`/v1/embeddings`) use different API shapes that the router doesn't handle. Those are better served as separate services behind a general API gateway.

### Session Log

| Date | Summary |
|------|---------|
| 2026-03-01 | Task created. GHCR image confirmed (`latest` + SHA tags available). Container internals analyzed (supervisord, 4 processes). Config format documented. Compose service designed. First-boot model download documented (~1.5GB, up to 30 min). |
| 2026-03-02 | **Session 3 research.** Read actual source: Dockerfile (multi-stage, Go+Rust+Python), supervisord.conf (5 programs), start-router.sh (health on 8080), config_generator.py (Jinja2 template, two code paths), envoy.template.yaml (listener port from config), cli/models.py (UserConfig Pydantic model). Corrected port assumptions (8801 not 8888). Identified two config formats. Designed Phase A (cloud-only) approach for faster bring-up without vLLM dependency. |
| 2026-03-02 | **Session 3 bring-up.** First attempt failed — old/flat config format rejected by `latest` image (`version` + `providers` required). Rewrote config in UserConfig v1 format. Container started, 6 BERT models downloaded (~2 min). Health check passed. Full end-to-end validated: curl → Envoy → Router → OpenAI API → response. Python runtime integration tested with `SEMANTIC_ROUTER_ENABLED=true`. MoM model routing works. All 67 LLM factory tests + 1208 full suite tests pass. Researched custom embedding models (not swappable — hardwired Rust FFI) and language-based routing (first-class signal via whatlanggo, 100+ languages, zero-config). |
| 2026-03-02 | **Session 4 — TASK COMPLETE.** Added 3 edge-case integration tests (router overrides existing base_url, router model wins over custom_model_name, full integration with all params). 70 tests in test_llm_factory.py, 100% coverage on graphs/llm.py. Created `docs/semantic-router.md` (514-line integration guide: overview, architecture diagram, quick start, config reference, env vars, language routing Phase B, ports reference, phases roadmap, troubleshooting). Updated `README.md` with Semantic Router feature bullet, Shared LLM Factory feature, and 3 new env vars in table. 1211 full suite pass, lint clean. |

---

## Blockers & Dependencies

| Blocker/Dependency | Status | Resolution |
|--------------------|--------|------------|
| Task-02 (Shared LLM Factory) | ✅ Complete | Tests target new module paths (`graphs.llm.*`) |
| Task-03 (Model Override) | ✅ Complete | 8 override tests + 3 integration tests cover precedence |
| Task-04 (Metadata Passthrough) | ✅ Complete | 8 metadata tests + 2 combined tests cover header injection |
| GHCR image availability | ✅ Confirmed | `ghcr.io/vllm-project/semantic-router/vllm-sr:latest` exists with multiple tags |
| Ministral backend running | ✅ Already in compose | Existing `ministral` service on port 80 |

---

## Verification

```bash
# 1. Docker compose stack starts
docker compose -f docker-compose.semantic-router.yml up -d
docker compose -f docker-compose.semantic-router.yml ps  # should show "healthy"

# 2. Router health check (port 8080 INSIDE container)
docker compose -f docker-compose.semantic-router.yml exec semantic-router \
  curl -f http://localhost:8080/health

# 3. Proxy endpoint works (port 8801 on host)
curl http://localhost:8801/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -d '{"model": "MoM", "messages": [{"role": "user", "content": "What is 2+2?"}]}'

# 4. Dashboard accessible
curl -f http://localhost:8700

# 5. All tests pass — 1211 passed, 35 skipped ✅
cd apps/python && uv run pytest -x -v

# 6. Coverage meets threshold — 100% on graphs/llm.py ✅
cd apps/python && uv run pytest tests/test_llm_factory.py --cov=graphs.llm --cov-report=term-missing

# 7. Lint passes ✅
cd apps/python && uv run ruff check . --fix --unsafe-fixes && uv run ruff format .
```

### Session 4 Verification Results

- **70 tests** in `test_llm_factory.py` — all pass (0.84s)
- **100% coverage** on `graphs/llm.py` (76 statements, 0 missing)
- **1211 tests** full suite — all pass (11.15s), 35 skipped
- **Lint clean** — `All checks passed!`, 90 files unchanged
- **Docs created** — `docs/semantic-router.md` (514 lines)
- **README updated** — Semantic Router feature, Shared LLM Factory feature, 3 env vars

---

## Related

- **Parent Goal:** [42 — Semantic Router Integration](../scratchpad.md)
- **Depends On:** [Task-02](../Task-02-Shared-LLM-Factory/scratchpad.md), [Task-03](../Task-03-Call-Time-Model-Override/scratchpad.md), [Task-04](../Task-04-Routing-Metadata-Passthrough/scratchpad.md)
- **Key Files:**
  - `docker-compose.semantic-router.yml` (✅ compose stack — port 8801, health checks, model volume)
  - `config/semantic-router/config.yaml` (✅ UserConfig v1, 5 domains, 5 decisions, cloud-only)
  - `tests/test_llm_factory.py` (✅ 70 tests, 100% coverage on graphs/llm.py)
  - `docs/semantic-router.md` (✅ 514-line integration guide)
  - `README.md` (✅ semantic router feature + env vars added)
- **Research:**
  - `.agent/research/semantic-router/` — cloned repo for reference
  - `.agent/research/semantic-router/config/config.yaml` — full config reference
  - `.agent/research/semantic-router/src/vllm-sr/Dockerfile` — container build details
  - `.agent/research/semantic-router/src/vllm-sr/supervisord.conf` — process management
  - `.agent/research/semantic-router/src/vllm-sr/cli/core.py` — how CLI manages containers
  - `.agent/research/semantic-router/src/vllm-sr/cli/consts.py` — image names, ports, timeouts