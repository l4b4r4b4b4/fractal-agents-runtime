# Semantic Router Integration — Agent Runtime Planning Document

> **Source**: docproc-platform, Goal 73, Session 207
> **Target Repo**: robyn-runtime (agent runtime)
> **Status**: Planning — not yet started
> **Priority**: After platform admin dashboard (Phase 5), before llm-d
> **Related**: vllm-project/semantic-router (v0.1 "Iris", 3.3k stars, Apache-2.0)

## 1. What Is the Semantic Router?

[vllm-project/semantic-router](https://github.com/vllm-project/semantic-router) is a system-level intelligent router for Mixture-of-Models (MoM). It sits between clients and model backends, routing requests to the best model based on semantic signals.

**Key capabilities:**
- Request classification → route to cheap vs expensive model
- Semantic caching → skip inference for similar recent queries
- Hallucination detection at token level
- PII detection and jailbreak prevention
- LoRA-based routing for specialized tasks
- Model health-aware failover

**Architecture:** Go (proxy) + Rust (NLP bindings) + Python (ML classification models). Runs as a Kubernetes-native proxy in front of vLLM/TEI instances.

**Paper:** "Signal Driven Decision Routing for Mixture-of-Modality Models" (Feb 2026)

## 2. Why We Need It

### Current Architecture (Static Model Selection)

```
Agent Created → Engine Selected → model_name baked into LangGraph assistant config
                                  ↓
                                  syncAgentToLangGraph() writes:
                                    config.configurable.model_name = "ministral-3b-instruct"
                                  ↓
                                  Every invocation uses the same model, regardless of query
```

**Problems:**
- Simple questions ("Was ist die Grundstücksfläche?") use the same expensive model as complex analysis
- No automatic failover if a model endpoint is unhealthy
- No cost optimization — can't route cheap queries to ministral, complex ones to GPT-4.1
- No caching — identical queries re-run full inference

### Target Architecture (Dynamic Model Routing)

```
User Query → robyn-runtime → Semantic Router → picks model per-request
                                ↓
                                Signal analysis:
                                  - Query complexity → simple/complex
                                  - Query language → de/en/multi
                                  - Task type → extraction/classification/chat/RAG
                                  - Cost budget → per-org limit
                                ↓
                                Routes to:
                                  - ministral-3b (simple, fast, free)
                                  - GPT-4o-mini (medium complexity)
                                  - GPT-4.1 (complex analysis, tool-heavy)
```

## 3. Prerequisites — What Needs to Change in robyn-runtime

### 3.1 Call-Time Model Configuration (REQUIRED)

**Current:** Model is set at assistant creation via `config.configurable.model_name`. Every invocation of that assistant uses the same model.

**Needed:** Accept model override per-invocation. The LangGraph `invoke()` / `stream()` call should accept a `model_name` in the runtime config that overrides the assistant-level default.

```python
# Current: model baked at assistant sync time
assistant = await client.assistants.create(
    graph_id="agent",
    config={"configurable": {"model_name": "ministral-3b-instruct"}}
)

# Target: model overridable at call time
response = await client.runs.create(
    thread_id=thread_id,
    assistant_id=assistant_id,
    config={"configurable": {"model_name": "azure:gpt-4-1"}},  # overrides assistant default
)
```

**Implementation in the graph:**
```python
# In the agent graph node, read model_name from runtime config with fallback
def get_model_name(config: RunnableConfig) -> str:
    configurable = config.get("configurable", {})
    # Call-time override takes precedence over assistant-level default
    return configurable.get("model_name_override", configurable.get("model_name"))
```

### 3.2 Model Endpoint Resolution (REQUIRED)

**Current:** The runtime uses LiteLLM with env vars (OPENAI_API_KEY, AZURE_OPENAI_ENDPOINT, etc.) to resolve model endpoints.

**Needed:** The runtime should be able to resolve endpoints from the platform DB or accept endpoint URLs at call time. Two approaches:

**Option A — Router as proxy (preferred):**
The semantic router runs as a proxy. The runtime always calls `http://semantic-router:8080/v1/chat/completions`. The router handles model selection and forwarding. The runtime doesn't need to know about multiple models — the router is transparent.

**Option B — Runtime resolves endpoints:**
The runtime queries `ai_models` + `ai_model_endpoints` tables to get the URL for a given model_name. More coupling, but more control.

**Recommendation:** Option A. The router is designed to be a transparent proxy. The runtime just talks to one endpoint.

### 3.3 Routing Metadata Passthrough (NICE TO HAVE)

Pass metadata to the router so it can make better decisions:

```python
# Headers or request metadata the runtime should forward to the semantic router
{
    "x-sr-org-id": "uuid",           # For per-org cost budgets
    "x-sr-task-type": "extraction",   # Hint: what kind of task
    "x-sr-complexity": "high",        # Pre-classified complexity (if known)
    "x-sr-user-tier": "premium",      # User's subscription tier
}
```

## 4. Platform-Side Schema (Already Done)

The platform DB already has the foundation:

### `ai_models` table (12 models seeded)
```
model_slug             | model_capabilities                          | api_protocol
-----------------------|---------------------------------------------|---------------------------
ministral-3b-instruct  | {text_generation,function_calling}           | openai_chat_completions
gpt-4o                 | {text_generation,vision,function_calling}    | openai_chat_completions
gpt-4o-mini            | {text_generation,vision,function_calling}    | openai_chat_completions
azure-gpt-4-1          | {text_generation,vision,function_calling}    | openai_chat_completions
openai-gpt-4o          | {text_generation,vision,function_calling}    | openai_chat_completions
openai-gpt-4o-mini     | {text_generation,vision,function_calling}    | openai_chat_completions
whisper-large-v3-turbo | {speech_to_text}                            | openai_audio_transcriptions
deepseek-ocr2          | {ocr,vision}                                | openai_chat_completions
jina-embeddings-v2-*   | {embedding}                                 | tei_embed
jina-reranker-v2-*     | {reranking}                                 | tei_rerank
bge-m3                 | {embedding}                                 | tei_embed
bge-reranker-base      | {reranking}                                 | tei_rerank
```

### `ai_model_endpoints` table
Each model has deployment endpoints with:
- `endpoint_url` — where to send requests
- `auth_type` — none / bearer / api_key_header / azure_ad
- `auth_header_name` — Authorization / api-key
- `api_key_encrypted` — pgcrypto-encrypted API key
- `priority` — for failover ordering

### `api_protocol` column
This is the key enabler. The semantic router (or any consumer) knows HOW to call each model:
- `openai_chat_completions` → POST /v1/chat/completions
- `tei_embed` → POST /embed
- `openai_audio_transcriptions` → POST /v1/audio/transcriptions

All language models share `openai_chat_completions`, which means the router can treat them as interchangeable backends with the same protocol.

## 5. Deployment Architecture

```
                    ┌─────────────────────────────┐
                    │     docproc-platform (web)   │
                    │  Engine resolution → picks   │
                    │  engine bundle (models set)  │
                    └──────────┬──────────────────┘
                               │ invoke/stream
                               ▼
                    ┌──────────────────────────────┐
                    │     robyn-runtime            │
                    │  LangGraph agent execution   │
                    │  Calls LLM via LiteLLM       │
                    └──────────┬───────────────────┘
                               │ POST /v1/chat/completions
                               ▼
                    ┌──────────────────────────────┐
                    │     Semantic Router          │
                    │  vllm-sr (Go + Rust + Py)    │
                    │  - Signal analysis           │
                    │  - Model selection           │
                    │  - Caching                   │
                    │  - Safety (PII, jailbreak)   │
                    └──────┬──────┬──────┬─────────┘
                           │      │      │
                    ┌──────┘      │      └──────┐
                    ▼             ▼              ▼
              ┌──────────┐ ┌──────────┐  ┌──────────────┐
              │ vLLM     │ │ Azure    │  │ OpenAI API   │
              │ Ministral│ │ GPT-4.1  │  │ GPT-4o-mini  │
              │ (cluster)│ │ (cloud)  │  │ (cloud)      │
              └──────────┘ └──────────┘  └──────────────┘
```

### Kubernetes Resources Needed

```yaml
# Semantic router deployment (Go binary, lightweight)
- Deployment: semantic-router (1-2 replicas, ~256Mi RAM)
- Service: semantic-router:8080
- ConfigMap: router-config (model backends, routing rules, cache config)
# Optional: Redis/Valkey for semantic cache (we already have Valkey in cluster)
```

## 6. Integration Phases

### Phase 1: Call-Time Model Override (runtime change)
- Add `model_name_override` support to LangGraph graph config
- Test that per-invocation model selection works
- No semantic router yet — just enable the mechanism

### Phase 2: Semantic Router Deployment (infra)
- Deploy vllm-sr to the cluster
- Configure backends: ministral (cluster), GPT-4.1 (Azure), GPT-4o-mini (OpenAI)
- Point robyn-runtime's LiteLLM base URL to `http://semantic-router:8080/v1`
- Verify transparent proxying works (router passes through without routing logic)

### Phase 3: Routing Rules (config)
- Configure complexity-based routing:
  - Simple queries → ministral-3b (free, fast, ~100ms)
  - Medium queries → GPT-4o-mini (cheap, good quality)
  - Complex queries → GPT-4.1 (expensive, best quality)
- Configure semantic caching with Valkey backend
- Test with real document processing workloads

### Phase 4: Platform Integration (web app)
- Add routing config to admin dashboard
- Per-org cost budget configuration
- Routing analytics / model usage dashboard
- Cache hit rate monitoring

## 7. Key Risks and Considerations

| Risk | Mitigation |
|------|------------|
| Added latency from router proxy | Router is Go, sub-1ms overhead for passthrough |
| Misrouting (complex query → cheap model) | Start conservative, route to expensive model by default, only downgrade with high confidence |
| Semantic cache staleness | TTL-based expiry, cache only for read queries, never for mutations |
| PII in cache | Router has PII detection — strip before caching |
| Azure API key management | Keys already in `ai_model_endpoints.api_key_encrypted` — router reads from DB or ConfigMap |
| CC BY-NC 4.0 license on Jina v5 models | Only affects self-hosted Jina v5, not the router itself (Apache-2.0) |

## 8. Success Metrics

- **Cost reduction**: 30-50% LLM API cost reduction via routing simple queries to ministral
- **Latency improvement**: p50 latency down 40% for simple queries (ministral vs GPT-4.1)
- **Cache hit rate**: 15-25% for RAG queries (similar documents, similar questions)
- **Reliability**: Automatic failover when a model endpoint is unhealthy

## 9. References

- [vllm-project/semantic-router](https://github.com/vllm-project/semantic-router) — main repo
- [vllm-semantic-router.com](https://vllm-semantic-router.com) — documentation
- [Iris v0.1 release](https://github.com/vllm-project/semantic-router/releases/tag/v0.1.0) — first stable release
- Paper: "Signal Driven Decision Routing for Mixture-of-Modality Models" (arXiv, Feb 2026)
- Paper: "When to Reason: Semantic Router for vLLM" (NeurIPS 2025 MLForSys)
- Platform schema: `supabase/migrations/20260210110000_add_ai_engines.sql`
- Platform scratchpad: `.agents/goals/73-AI-Model-Registry-And-Admin-Dashboard/scratchpad.md`
