# Semantic Router Integration Guide

> **Status:** Phase A (cloud-only routing via OpenAI API)
> **Runtime:** Python only (TypeScript deferred)
> **Router:** [vLLM Semantic Router](https://github.com/vllm-project/semantic-router) v0.1 "Iris"

## Overview

The **vLLM Semantic Router** is an intelligent proxy that sits between the
Python agent runtime and LLM providers. Instead of hardcoding a single model
per assistant, the router classifies each request and routes it to the optimal
model based on query complexity, task type, cost signals, and language.

**What it does:**

- **Dynamic model selection** — simple queries → cheap model, complex analysis → capable model
- **Semantic caching** — identical or similar queries return cached responses (HNSW + embeddings)
- **Prompt guard** — PII detection, jailbreak prevention at the system level
- **Health-aware failover** — routes around unhealthy backends automatically
- **Cost optimisation** — per-category routing rules minimise spend without sacrificing quality

**What the runtime does:**

The Python runtime's shared LLM factory (`graphs/llm.py`) transparently
routes all LLM calls through the semantic router when enabled. No per-assistant
changes are needed — it's a deployment-level concern controlled by environment
variables.

## Architecture

```text
┌─────────────────────┐
│   Python Runtime    │
│  (graphs/llm.py)    │
│                     │
│  SEMANTIC_ROUTER_   │
│  ENABLED=true       │
│  model="MoM"        │
└────────┬────────────┘
         │ HTTP POST /v1/chat/completions
         │ Headers: Authorization, x-sr-* metadata
         ▼
┌─────────────────────┐
│   Envoy Proxy       │
│   (port 8801)       │
│                     │
│   Listener config   │
│   from config.yaml  │
└────────┬────────────┘
         │ gRPC ExtProc
         ▼
┌─────────────────────┐
│   Go Router         │
│   (port 50051)      │
│                     │
│   BERT classifier   │  ← Classifies domain, language, modality
│   Signal engine     │  ← Evaluates routing decisions
│   Semantic cache    │  ← HNSW similarity search
│   Prompt guard      │  ← PII + jailbreak detection
└────────┬────────────┘
         │ Selects model based on rules
         ▼
┌─────────────────────┐
│   LLM Provider      │
│   (OpenAI API)      │
│                     │
│   gpt-4o            │  ← Complex: extraction, analysis
│   gpt-4o-mini       │  ← Simple: chat, classification
└─────────────────────┘
```

**Key points:**

- The runtime sends `model: "MoM"` (Mixture of Models) — the router decides the actual model
- API keys flow via the `Authorization: Bearer` header from the client, not container env vars
- The Envoy proxy port is configurable in `config.yaml` (we use 8801)
- Health checks target port 8080 inside the container (Go router API), not the Envoy port
- BERT classifier models (~1.5 GB) are downloaded on first boot and cached in a Docker volume

## Quick Start

### Prerequisites

- Docker Compose v2 (`docker compose`, not `docker-compose`)
- `OPENAI_API_KEY` exported or in `.env` file
- ~2 GB disk space for BERT classifier models (first boot only)
- No GPU required (classifiers run on CPU)

### 1. Start the Semantic Router

```bash
# First boot downloads ~1.5 GB of BERT models (2–5 min on fast network)
docker compose -f docker-compose.semantic-router.yml up -d

# Watch model download progress
docker compose -f docker-compose.semantic-router.yml logs -f semantic-router
```

### 2. Verify Health

```bash
# Health check (Go router API on port 8080 INSIDE the container)
docker compose -f docker-compose.semantic-router.yml exec semantic-router \
  curl -f http://localhost:8080/health
```

### 3. Smoke Test

```bash
# Direct request to the Envoy proxy (port 8801 on host)
curl http://localhost:8801/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -d '{
    "model": "gpt-4o-mini",
    "messages": [{"role": "user", "content": "What is 2+2?"}]
  }'

# Router-managed model selection (MoM)
curl http://localhost:8801/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -d '{
    "model": "MoM",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

### 4. Connect the Python Runtime

```bash
export SEMANTIC_ROUTER_ENABLED=true
export SEMANTIC_ROUTER_URL=http://localhost:8801/v1
export SEMANTIC_ROUTER_MODEL=MoM

cd apps/python && uv run python -m server.main
# All LLM calls now route through the semantic router
```

### 5. Open the Dashboard

Navigate to [http://localhost:8700](http://localhost:8700) to view routing
decisions, request history, and metrics.

### Subsequent Starts

After the first boot, models are cached in the `semantic-router-models`
Docker volume. Subsequent starts take ~30 seconds:

```bash
docker compose -f docker-compose.semantic-router.yml up -d
```

### Stop

```bash
docker compose -f docker-compose.semantic-router.yml down
# Models volume is preserved — next start will be fast

# To delete cached models too:
docker volume rm semantic-router-models
```

## Runtime Integration

### Environment Variables

The shared LLM factory (`graphs/llm.py`) reads three environment variables
to control semantic router integration:

| Variable | Default | Description |
|----------|---------|-------------|
| `SEMANTIC_ROUTER_ENABLED` | `false` | Set to `true` to route all LLM calls through the router |
| `SEMANTIC_ROUTER_URL` | *(none)* | Router's Envoy proxy URL (e.g. `http://localhost:8801/v1`) |
| `SEMANTIC_ROUTER_MODEL` | `MoM` | Model name sent to the router. `MoM` = router-managed selection |

When `SEMANTIC_ROUTER_ENABLED=true`:

1. `base_url` is overridden to `SEMANTIC_ROUTER_URL` (regardless of assistant config)
2. `model` is set to `SEMANTIC_ROUTER_MODEL` (unless an explicit `model_name_override` is set)
3. API key resolution uses the custom endpoint path (reads `custom_api_key` from configurable, falls back to `CUSTOM_API_KEY` or `OPENAI_API_KEY` env vars)

### Model Name Override

The LLM factory supports per-invocation model overrides via `model_name_override`
in the configurable dict. Resolution precedence:

```text
model_name_override > custom_model_name > model_name
```

When the semantic router is enabled:

```text
model_name_override (caller-set) > SEMANTIC_ROUTER_MODEL > custom_model_name > model_name
```

An explicit `model_name_override` from the caller always wins — even over
the router model. This allows pinning specific requests to a known model
while the router handles everything else.

### Routing Metadata

The LLM factory accepts a `routing_metadata` dict that is forwarded as HTTP
headers to the model endpoint. These headers can carry routing hints that
the semantic router (or any downstream proxy) can use:

```python
model = create_chat_model(
    config,
    model_name="openai:gpt-4o",
    routing_metadata={
        "x-sr-graph-id": "react-agent",
        "x-sr-org-id": "org-42",
        "x-sr-task-type": "extraction",
        "x-sr-user-tier": "enterprise",
    },
)
```

- Only non-empty string values are included
- Header keys are logged (not values) for debuggability
- Works with both standard providers and custom endpoints

### How It Works in Code

The shared LLM factory in `graphs/llm.py` is used by both `react_agent`
and `research_agent`. The semantic router integration is transparent:

```python
from graphs.llm import create_chat_model

# This call is identical whether routing is enabled or not.
# When SEMANTIC_ROUTER_ENABLED=true, the factory internally:
#   1. Overrides base_url → SEMANTIC_ROUTER_URL
#   2. Sets model → SEMANTIC_ROUTER_MODEL (default "MoM")
#   3. Logs: "Semantic router mode: routing all LLM calls through ..."
model = create_chat_model(
    config,
    model_name=cfg.model_name,
    temperature=cfg.temperature,
    max_tokens=cfg.max_tokens,
    base_url=cfg.base_url,
    custom_model_name=cfg.custom_model_name,
    model_name_override=configurable.get("model_name_override"),
    routing_metadata={"x-sr-graph-id": "agent"},
)
```

## Router Configuration Reference

The router configuration lives at `config/semantic-router/config.yaml` and
is mounted read-only into the container at `/app/config.yaml`.

### Format

The `latest` GHCR image requires the **UserConfig v1** format:

```yaml
version: "v1"

listeners:
  - name: "openai_listener"
    address: "0.0.0.0"
    port: 8801
    timeout: "300s"

providers:
  models:
    # Agentic models (non-image LangGraph chats)
    - name: "gpt-5.2"
      endpoints:
        - name: "openai-gpt52"
          weight: 1
          endpoint: "api.openai.com:443"
          protocol: "https"
      description: "GPT-5.2 — newest, most capable. Analysis, deep reasoning, multi-step tasks"

    - name: "gpt-5.2-mini"
      endpoints:
        - name: "openai-gpt52-mini"
          weight: 1
          endpoint: "api.openai.com:443"
          protocol: "https"
      description: "GPT-5.2 Mini — fast agentic variant (remove if unavailable at OpenAI API)"

    - name: "gpt-4.1"
      endpoints:
        - name: "openai-gpt41"
          weight: 1
          endpoint: "api.openai.com:443"
          protocol: "https"
      description: "GPT-4.1 — agentic mid-tier. Chat, general Q&A, fallback default"

    # Vision models (image inputs only — NOT in default routing)
    - name: "gpt-4o"
      endpoints:
        - name: "openai-gpt4o"
          weight: 1
          endpoint: "api.openai.com:443"
          protocol: "https"
      description: "GPT-4o — vision-capable, for image inputs (pin via model_name_override)"

    - name: "gpt-4o-mini"
      endpoints:
        - name: "openai-gpt4o-mini"
          weight: 1
          endpoint: "api.openai.com:443"
          protocol: "https"
      description: "GPT-4o Mini — cheaper vision model (pin via model_name_override)"

    # Specialized self-hosted models
    - name: "ais-ocr"
      endpoints:
        - name: "local-vllm-ocr"
          weight: 1
          endpoint: "vllm-ocr:80"
          protocol: "http"
      description: "DeepSeek OCR 2 — local vLLM for document OCR and vision tasks"

    - name: "ministral-3b-instruct"
      endpoints:
        - name: "cluster-ministral"
          weight: 1
          endpoint: "host.docker.internal:7375"
          protocol: "http"
      description: "Ministral 3B Instruct — cluster vLLM for structured extraction and classification"

  default_model: "gpt-4.1"
```

> **Important:** The old flat config format (without `version`, `providers`,
> `listeners` keys) is rejected by the `latest` image. Always use the v1
> format shown above.

### Signals (Domain Categories)

The BERT classifier maps incoming queries to domain categories:

```yaml
signals:
  domains:
    - name: ocr
      description: "OCR and document image-to-text tasks — scanned documents, invoices, receipts, handwritten notes"
    - name: extraction
      description: "Structured data extraction from text — pulling fields, values, dates from digital documents (JSON output)"
    - name: classification
      description: "Document classification and categorization — assigning labels, types, categories"
    - name: chat
      description: "Conversational queries and general Q&A"
    - name: analysis
      description: "Complex multi-step analysis requiring deeper reasoning — summarization, comparison, legal interpretation"
    - name: other
      description: "General knowledge and miscellaneous topics"
```

### Routing Decisions

Priority-based rules map signals to models. Higher priority = checked first.

> **Image inputs:** `gpt-4o` and `gpt-4o-mini` are available as providers but
> are **not** in default routing. The BERT classifier works on text embeddings
> and cannot auto-detect `image_url` blocks. For image inputs, the webapp must
> explicitly set `model_name_override: "gpt-4o"` in the configurable.

```yaml
decisions:
  - name: "ocr_query"
    description: "OCR / document image reading → ais-ocr (local DeepSeek OCR vLLM)"
    priority: 300
    rules:
      operator: "AND"
      conditions:
        - type: "domain"
          name: "ocr"
    modelRefs:
      - model: "ais-ocr"
        use_reasoning: false

  - name: "extraction_query"
    description: "Structured data extraction → ministral-3b (cluster vLLM, fast JSON output)"
    priority: 200
    rules:
      operator: "AND"
      conditions:
        - type: "domain"
          name: "extraction"
    modelRefs:
      - model: "ministral-3b-instruct"
        use_reasoning: false

  - name: "classification_query"
    description: "Document classification/labeling → ministral-3b (cluster vLLM, fast categorization)"
    priority: 200
    rules:
      operator: "AND"
      conditions:
        - type: "domain"
          name: "classification"
    modelRefs:
      - model: "ministral-3b-instruct"
        use_reasoning: false

  - name: "analysis_query"
    description: "Complex analysis requiring deep reasoning → gpt-5.2 (newest, most capable)"
    priority: 150
    rules:
      operator: "AND"
      conditions:
        - type: "domain"
          name: "analysis"
    modelRefs:
      - model: "gpt-5.2"
        use_reasoning: false

  - name: "chat_query"
    description: "Conversational queries → gpt-4.1 (agentic mid-tier)"
    priority: 100
    rules:
      operator: "AND"
      conditions:
        - type: "domain"
          name: "chat"
    modelRefs:
      - model: "gpt-4.1"
        use_reasoning: false

  - name: "general_fallback"
    description: "Everything else → gpt-4.1 (safe agentic default)"
    priority: 50
    rules:
      operator: "AND"
      conditions:
        - type: "domain"
          name: "other"
    modelRefs:
      - model: "gpt-4.1"
        use_reasoning: false
```

### Language-Based Routing (Phase B)

The router supports language detection as a first-class signal via the
built-in `whatlanggo` library (100+ languages, zero model download):

```yaml
signals:
  languages:
    - name: german
      description: "German language queries"
    - name: english
      description: "English language queries"

decisions:
  - name: "german_extraction"
    priority: 300
    rules:
      operator: "AND"
      conditions:
        - type: "language"
          name: "german"
        - type: "domain"
          name: "extraction"
    modelRefs:
      - model: "gpt-4o"
```

Language signals compose with domain/keyword/modality signals via boolean
operators (`AND`, `OR`). This is planned for Phase B when multiple model
backends are available.

## Ports Reference

| Port | Process | Purpose | Exposed |
|------|---------|---------|---------|
| **8801** | Envoy proxy | OpenAI-compatible API (configurable in `config.yaml`) | **Yes** — main entry point |
| 8700 | Dashboard | Web UI for routing decisions and metrics | Yes (optional) |
| 9190 | Go router | Prometheus metrics | Yes (optional) |
| 8080 | Go router | Health API + REST classification | No (health check only) |
| 50051 | Go router | gRPC ExtProc (Envoy ↔ Router) | No (internal) |
| 9901 | Envoy admin | Envoy internal admin interface | No (debug only) |

## Phases

### Phase A — Cloud-Only (Complete)

All models served by OpenAI cloud API. No local GPU or vLLM required.

- **Models:** `gpt-4o`, `gpt-4o-mini`
- **Routing:** Domain-based (extraction/analysis → gpt-4o, chat/classification → gpt-4o-mini)
- **Use case:** Cost optimisation by routing simple queries to cheaper models

### Phase B — Cloud + Local vLLM + Cluster vLLM (Current)

Cloud models plus local and cluster-hosted vLLM backends for specialized
workloads (OCR, structured extraction, classification):

- **Models:** `gpt-5.2`, `gpt-5.2-mini`, `gpt-4.1` (cloud agentic), `gpt-4o`, `gpt-4o-mini` (cloud vision), `ais-ocr` (local vLLM), `ministral-3b-instruct` (cluster vLLM)
- **Routing:** Domain-based — OCR → ais-ocr, extraction/classification → ministral-3b, analysis → gpt-5.2, chat/fallback → gpt-4.1; vision models (gpt-4o/4o-mini) available via explicit `model_name_override` only
- **Use case:** Newest agentic models for reasoning and chat, specialized vision OCR on local GPU, fast structured extraction on cluster GPU, vision models pinned for image inputs
- **Networking:** Docker `docproc-platform_default` network for local vLLM; `host.docker.internal` + kubectl port-forward for cluster vLLM

### Phase C — Multi-Provider Production (Future)

Full production deployment with Kubernetes operator, multiple providers,
per-org cost budgets, and monitoring:

- **Models:** Multiple local + cloud models across providers
- **Routing:** Full signal engine (domain, language, modality, cost, latency)
- **Use case:** Production-grade intelligent routing at scale

## Troubleshooting

### First Boot Takes a Long Time

The container downloads ~1.5 GB of BERT classifier models from HuggingFace
on first boot. This can take 2–30 minutes depending on network speed.

**Watch progress:**
```bash
docker compose -f docker-compose.semantic-router.yml logs -f semantic-router
```

**Slow HuggingFace downloads?** Set a mirror:
```yaml
# In docker-compose.semantic-router.yml, under environment:
- HF_ENDPOINT=https://hf-mirror.com
```

Models are cached in the `semantic-router-models` Docker volume and
persist across container restarts.

### Health Check Fails

The health endpoint is on port **8080 inside the container** (Go router API),
not the Envoy proxy port (8801).

```bash
# Correct — check inside the container
docker compose -f docker-compose.semantic-router.yml exec semantic-router \
  curl -f http://localhost:8080/health

# Wrong — this hits the Envoy proxy, not the health endpoint
curl http://localhost:8080/health
```

If the health check keeps failing during first boot, the BERT models are
still downloading. The compose file allows up to 30 minutes
(60 retries × 30s interval) before marking the container unhealthy.

### "Config validation failed" or Container Crashes on Start

The `latest` GHCR image requires the **UserConfig v1** format. If your
`config.yaml` uses the old flat format, the Envoy config generator will
reject it.

**Required keys:** `version: "v1"`, `providers:` (with `models:` list),
`listeners:` (with port configuration).

Check the current config format:
```bash
head -5 config/semantic-router/config.yaml
# Should start with: version: "v1"
```

### SEMANTIC_ROUTER_ENABLED=true but Requests Go Direct

Check that `SEMANTIC_ROUTER_URL` is also set. If it's missing, the factory
logs a warning and falls through to the standard provider path:

```text
WARNING - SEMANTIC_ROUTER_ENABLED=true but SEMANTIC_ROUTER_URL is not set; ignoring router mode
```

### API Key Errors (401 Unauthorized)

API keys flow from the client via the `Authorization: Bearer` header through
Envoy to the upstream provider. They are **not** injected by the container.

Ensure `OPENAI_API_KEY` is set in `.env` or your shell before starting
either the router or the runtime:

```bash
echo $OPENAI_API_KEY  # Should print your key
```

### Router Embedding Models

The router's internal embedding models (BERT, mmBERT, Qwen3, Gemma) are
hardwired via Rust FFI (`libcandle_semantic_router.so`). They **cannot** be
swapped for custom architectures (Jina, Vago, etc.) without modifying the
Rust bindings.

These embeddings are **internal to the router** for query classification and
semantic caching. They are completely separate from RAG embeddings used by
the platform (which run in a separate TEI container).

## Files Reference

| File | Purpose |
|------|---------|
| `docker-compose.semantic-router.yml` | Standalone compose for the router dev stack |
| `config/semantic-router/config.yaml` | Router configuration (UserConfig v1 format) |
| `apps/python/src/graphs/llm.py` | Shared LLM factory with router env var support |
| `apps/python/tests/test_llm_factory.py` | 71 tests, 100% coverage on `graphs/llm.py` |

## References

- [vLLM Semantic Router](https://github.com/vllm-project/semantic-router) — Apache-2.0
- [Semantic Router Docs](https://vllm-semantic-router.com)
- [Iris v0.1 Release](https://github.com/vllm-project/semantic-router/releases/tag/v0.1.0)
- Paper: "Signal Driven Decision Routing for Mixture-of-Modality Models" (Feb 2026)
- Paper: "When to Reason: Semantic Router for vLLM" (NeurIPS 2025 MLForSys)