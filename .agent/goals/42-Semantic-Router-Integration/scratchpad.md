# Goal 42: Semantic Router Integration — Dynamic Model Routing (Python)

> **Status**: 🟢 Complete (Phase B merged to main)
> **Priority**: P1 (High)
> **Created**: 2026-03-01
> **Updated**: 2026-03-03
> **PR**: [#56](https://github.com/l4b4r4b4b4/fractal-agents-runtime/pull/56) — squash-merged to `main`
> **Source**: [User Story — Semantic Router Integration](../../user-stories/semantic-router-integration.md)
> **Upstream**: docproc-platform Goal 73 (AI Model Registry & Admin Dashboard)

## Overview

Integrate the [vLLM Semantic Router](https://github.com/vllm-project/semantic-router) (v0.1 "Iris") into the Python agent runtime to enable **dynamic per-request model routing**. Instead of baking a single `model_name` into every assistant at creation time, the runtime will support call-time model overrides and transparent proxying through the semantic router, which selects the optimal model based on query complexity, task type, and cost signals.

**Scope: Python runtime only.** TypeScript port deferred until patterns are proven.

## Success Criteria

- [x] Duplicated LLM initialization code extracted into a shared factory (`graphs/llm.py`)
- [x] Both `react_agent` and `research_agent` use the shared LLM factory
- [x] `model_name_override` accepted at run invocation time, overriding assistant-level default
- [x] Runtime can point `base_url` to semantic router and send `model: "MoM"` for router-managed selection
- [x] Routing metadata headers (`x-sr-org-id`, `x-sr-task-type`, etc.) forwarded to the model endpoint
- [x] Unit tests for LLM factory, model override, and metadata passthrough
- [x] ≥73% code coverage maintained (100% on `graphs/llm.py`)
- [x] All existing tests pass (no regressions) — 1211 passed, 35 skipped
- [x] Docker compose dev stack for local semantic router testing
- [x] Integration guide documentation (`docs/semantic-router.md`)
- [x] README updated with semantic router feature and env vars

## Context & Background

### Problem: Static Model Selection

Currently, model selection is **static** — baked into the assistant config at creation time:

```python
# Model set once at assistant creation, never changes per-request
assistant = await client.assistants.create(
    graph_id="agent",
    config={"configurable": {"model_name": "ministral-3b-instruct"}}
)
```

**Consequences:**
- Simple questions ("Was ist die Grundstücksfläche?") use the same expensive model as complex analysis
- No automatic failover if a model endpoint is unhealthy
- No cost optimization — can't route cheap queries to ministral, complex ones to GPT-4.1
- No semantic caching — identical queries re-run full inference

### Solution: Semantic Router as Transparent Proxy

The [vLLM Semantic Router](https://github.com/vllm-project/semantic-router) is a system-level intelligent router for Mixture-of-Models (MoM). It:
- Runs as an OpenAI-compatible proxy (Go + Rust + Python, port 8888)
- Classifies requests → routes to the best model per-request
- Provides semantic caching (via HNSW + embeddings)
- Detects PII, jailbreaks, hallucinations at the system level
- Supports health-aware failover between backends
- Is Kubernetes-native with an operator for production deployment

**Integration approach: Option A — Router as proxy (recommended by user story).** The runtime always calls `http://semantic-router:8888/v1/chat/completions` with `model: "MoM"`. The router handles model selection and forwarding transparently. The runtime doesn't need to know about multiple models.

### Code Duplication Discovered

Both `react_agent/agent.py` (L422–465) and `research_agent/__init__.py` (L292–322) contain **nearly identical LLM initialization logic** (~40 lines each):
- Same `base_url` check → `ChatOpenAI` vs `init_chat_model` branching
- Same API key resolution pattern
- Same logging structure
- Same `temperature`/`max_tokens` passthrough

Additionally, config models (`RagConfig`, `MCPConfig`, `MCPServerConfig`) are duplicated across both agents. This duplication must be resolved before adding routing features, or the routing logic would need to be duplicated too.

## Constraints & Requirements

### Hard Requirements
- **Backward compatible** — existing assistant configs without routing must work unchanged
- **No new runtime dependencies** — semantic router is an external proxy, not a Python library in the runtime
- **Config-driven** — router URL, routing mode, metadata all via environment variables or assistant config
- **Python-only for now** — TS port is a separate future goal
- **≥73% coverage maintained** — all new code must be tested

### Soft Requirements
- Minimal changes to existing graph factory signatures
- Environment variable fallbacks for all new config (12-factor)
- Clear logging for routing decisions

### Out of Scope
- Semantic router deployment/infrastructure (K8s operator, Helm charts) — that's infra/platform
- Routing rule configuration (categories, decisions) — that's router config, not runtime
- Platform admin dashboard for routing analytics — that's docproc-platform
- TypeScript runtime changes — deferred until Python is proven
- Per-org cost budgets — platform concern, not runtime

## Approach

### Phase 1: Shared LLM Factory (Task-02)
Extract duplicated LLM init into `graphs/llm.py`. This is prerequisite prep work that:
- Reduces duplication from ~80 lines to ~10 lines per agent
- Creates a single point to add routing features
- Makes both agents benefit from any LLM improvements

### Phase 2: Call-Time Model Override (Task-03)
Add `model_name_override` field that can be passed at `runs.create()` time. The merge logic in `_merge_assistant_configurable_into_run_config` already supports run-level keys overriding assistant-level keys, so this is mostly about:
- Adding the field to config models
- Using it in the LLM factory with proper precedence

### Phase 3: Routing Metadata (Task-04)
Forward routing hints as HTTP headers when calling the model endpoint. Both `ChatOpenAI` and `init_chat_model` support `default_headers` kwargs. Headers like:
- `x-sr-org-id` — for per-org cost budgets
- `x-sr-task-type` — extraction/classification/chat/RAG
- `x-sr-complexity` — pre-classified complexity hint
- `x-sr-user-tier` — user subscription tier

### Phase 4: Testing & Docs (Task-05)
- Unit tests for LLM factory
- Integration test with mocked router
- Docker-compose snippet for local semantic router testing
- Updated README

## Tasks

| Task ID | Description | Status | Depends On |
|---------|-------------|--------|------------|
| [Task-01](./Task-01-Research-Architecture/scratchpad.md) | Research & Architecture Decision | 🟢 Complete | — |
| [Task-02](./Task-02-Shared-LLM-Factory/scratchpad.md) | Shared LLM Factory — Extract duplicate model init | 🟢 Complete | Task-01 |
| [Task-03](./Task-03-Call-Time-Model-Override/scratchpad.md) | Call-Time Model Override — Per-invocation model selection | 🟢 Complete | Task-02 |
| [Task-04](./Task-04-Routing-Metadata-Passthrough/scratchpad.md) | Routing Metadata Passthrough — Forward hints via headers | 🟢 Complete | Task-02 |
| [Task-05](./Task-05-Testing-Documentation/scratchpad.md) | Testing & Documentation | 🟢 Complete | Task-03, Task-04 |

**Dependency graph:**
```
Task-01 (research)
   └──► Task-02 (shared factory)
           ├──► Task-03 (model override)
           └──► Task-04 (metadata headers)
                    └──► Task-05 (tests + docs)  ◄── Task-03
```

## Risks & Mitigations

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| LLM factory refactor breaks existing tests | High | Medium | Run full test suite after each change; keep backward-compatible signatures |
| `ChatOpenAI` doesn't forward custom headers to all providers | Medium | Low | Verified: `default_headers` kwarg exists in `ChatOpenAI`; `init_chat_model` passes kwargs through |
| Semantic router adds latency | Low | Low | Router is Go (sub-1ms passthrough); runtime change is just URL routing |
| Config model changes break assistant sync from platform | Medium | Low | All new fields have defaults; existing configs remain valid |
| Coverage drops below 73% with new code | Medium | Medium | Write tests alongside implementation; use mocks for external calls |

## Dependencies

### Upstream (things this goal depends on)
- Platform `ai_models` + `ai_model_endpoints` tables (already exist — Goal 73)
- Semantic router deployment (infrastructure, not this repo — Phase 2 of user story)
- LangChain `ChatOpenAI` header support (verified: exists)

### Downstream (things that depend on this goal)
- TS Runtime semantic router integration (future goal, post-validation)
- Platform admin dashboard routing config (docproc-platform Goal 73 Phase 4)
- Per-org cost budget enforcement (platform concern)

## Notes & Decisions

### Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-03-01 | Python-first, TS deferred | Prove patterns in battle-tested runtime before porting |
| 2026-03-01 | Option A — Router as proxy | Router is designed as transparent proxy; runtime just talks to one endpoint; least coupling |
| 2026-03-01 | Extract shared LLM factory first | ~80 lines duplicated between agents; routing features would double the duplication |
| 2026-03-01 | No new Python dependencies | Semantic router is an external proxy; runtime uses existing `ChatOpenAI` with `base_url` |
| 2026-03-02 | Unified `get_api_key_for_model` | Reconciled two divergent implementations: react_agent (3 providers, `CUSTOM_API_KEY` fallback, `apiKeys` dict) and research_agent (6 providers, `OPENAI_API_KEY` fallback). Unified version supports all 6 providers, both custom fallbacks (`CUSTOM_API_KEY` → `OPENAI_API_KEY`), and `configurable.apiKeys` |
| 2026-03-02 | `custom_api_key` resolved internally | Factory reads it from `config.configurable` via `get_api_key_for_model()` — not passed as a parameter. Eliminates redundancy |
| 2026-03-02 | Security gap identified | `custom_api_key` stored as plaintext in LangGraph configurable JSON blob while `ai_model_endpoints.api_key_encrypted` uses pgcrypto. Separate future task needed (touches web app + agent sync + runtime) |
| 2026-03-02 | Task-03 + Task-04 implemented together | Both features modify the same `create_chat_model()` function. Implemented in one session: `model_name_override` param (resolution: override > custom_model_name > model_name), `routing_metadata` param (builds `default_headers` dict), `SEMANTIC_ROUTER_ENABLED/URL/MODEL` env var support. 26 new tests (8 override + 8 metadata + 8 router + 2 combined). 67 total in test_llm_factory.py, 100% coverage on graphs/llm.py. 1208 tests pass, lint clean. |
| 2026-03-02 | Task-05 complete (Session 4) | Added 3 edge-case integration tests (router overrides existing base_url, router model wins over custom_model_name, full integration with all params). 70 tests in test_llm_factory.py, 100% coverage. Created `docs/semantic-router.md` (514-line integration guide: architecture, quick start, config reference, phases roadmap, troubleshooting). Updated `README.md` with Semantic Router feature, Shared LLM Factory feature, 3 new env vars. 1211 full suite pass, lint clean. **Goal 42 complete.** |
| 2026-03-02 | Config format — `latest` image requires UserConfig | The `latest` GHCR image uses `parse_user_config()` which validates against `UserConfig` Pydantic model. Old/flat config format (used by testing configs) is rejected. Must use: `version: "v1"`, `providers:` (with `models:` list of `{name, endpoints}`), `listeners:`, `decisions:`. |
| 2026-03-02 | Envoy proxy port is configurable | Port is NOT hardcoded. Set via `config.yaml → listeners[].port`. Default 8000. Upstream docs use 8801. We use 8801. |
| 2026-03-02 | Semantic router dev stack validated e2e | `docker-compose.semantic-router.yml` + `config/semantic-router/config.yaml` created. Container boots, downloads 6 BERT models (~1.5GB, ~2 min), health check passes. Full chain validated: Python runtime → `SEMANTIC_ROUTER_ENABLED=true` → `ChatOpenAI(base_url=router)` → Envoy → Go Router → OpenAI API → response. |
| 2026-03-02 | Custom embeddings NOT swappable | Router embedding models (qwen3, gemma, mmbert, bert) are hardwired via Rust FFI (`libcandle_semantic_router.so`). Jina/Vago/custom architectures would require Rust binding changes. Irrelevant for our use case — these are internal to the router, separate from RAG embeddings (TEI container). |
| 2026-03-02 | Language-based routing is first-class | Built-in `whatlanggo` classifier (Go library, 100+ languages, zero model download). Configured via `signals.languages` + `type: "language"` conditions in decisions. Composable with domain/keyword/modality signals via boolean operators. Ideal for German real estate doc processing. Deferred to Phase B. |
| 2026-03-02 | Modality routing possible for OCR | Router has `modality` signal (AR/DIFFUSION/BOTH) using mmBERT classifier + keyword detection. Could route vision LLM requests (OpenAI vision format with `image_url`) to OCR-capable models. Limited to `/v1/chat/completions` API shape — doesn't handle `/v1/audio/*` or `/v1/embeddings`. |
| 2026-03-02 | Router override rules refined | `SEMANTIC_ROUTER_ENABLED` no longer hijacks agent-level custom endpoints. If `base_url` is set, the agent skips the router. If `model_name_override` (call-time) or `custom_model_name` (assistant-level) is set, the router passes through that explicit model (no MoM reclassification). Only when no pin exists does the router inject `MoM`. Tests updated to reflect this behavior. |
| 2026-03-02 | Added DeepSeek OCR + Ministral routing in config | `config/semantic-router/config.yaml` updated to add `ais-ocr` (local vLLM via `vllm-ocr:80`) and `ministral-3b-instruct` (cluster vLLM via host port-forward). Added `ocr` domain signal and `ocr_query` decision (priority 300) and routed extraction + classification to Ministral, analysis to GPT-4o, chat/fallback to GPT-4o-mini. |
| 2026-03-03 | Phase B model restructure — GPT-5.2/4.1 default | Added `gpt-5.2`, `gpt-5.2-mini` (tentative), `gpt-4.1` as default agentic models. Shifted routing: analysis→gpt-5.2, chat/fallback→gpt-4.1. Reserved `gpt-4o`/`gpt-4o-mini` for vision-only (image inputs in chat) — webapp must pin via `model_name_override` since BERT classifier can't auto-detect image_url blocks. |
| 2026-03-03 | Port 8001→9541 | Dev vLLM port-forward changed to avoid conflict with other dev stacks. Updated Helm values-dev, README, DEPLOYMENT.md. |
| 2026-03-03 | Pre-push hooks: parallel→piped (fail-fast) | Changed lefthook pre-push from `parallel: true` to `piped: true` with priority ordering: merge check→lint→type check→OpenAPI→tests. Saves ~40s when lint fails. |
| 2026-03-03 | Fixed TS mock.module() pollution | `hardware-keys.test.ts` mock of `isUniqueViolation` only checked `.code`, not `.errno`. Leaked via Bun's module cache to `db.test.ts`, causing 1 test failure in full suite. Fixed mock to match real implementation. 958→958 TS tests pass. |
| 2026-03-03 | CI permissions fix | Added `permissions: { contents: read, pull-requests: read }` to `ci.yml` for `dorny/paths-filter@v3` to access PR changed files. |
| 2026-03-03 | PR #56 squash-merged to main | All CI checks passed. Branch deleted. Main rebased locally. Goals 40+42 now on main. |

### Open Questions

- [x] Should `model_name_override` be a top-level config field or nested under a `routing` config?
  - **Resolved:** Top-level in `configurable` dict. Read via `configurable.get("model_name_override")`. Simple, flat, compatible with existing `_merge_assistant_configurable_into_run_config()`.
- [x] Do we need a `routing_mode` enum (e.g., `static` / `router_proxy` / `model_override`)?
  - **Resolved:** No. `SEMANTIC_ROUTER_ENABLED` env var is a simple boolean toggle. The mode is implicit: if enabled + URL set → router proxy. If `model_name_override` set → model override. Otherwise → static. No enum needed.
- [x] Should the shared LLM factory also extract the duplicated `RagConfig`/`MCPConfig` models?
  - **Resolved:** Yes, done in Task-02. `graphs/configuration.py` holds `RagConfig`, `MCPServerConfig`, `MCPConfig`.
- [ ] Should we add a health check that verifies the semantic router is reachable at startup?
  - Deferred to future work. Not critical for MVP. Docker compose health check covers dev use case.
- [ ] Should we add language-based routing rules for German document processing?
  - Router supports `whatlanggo` language detection as a first-class signal. Config patterns documented in `docs/semantic-router.md`. Deferred to Phase C.
- [ ] Should we explore modality routing for OCR via vision LLMs?
  - Router has `modality` signal (AR/DIFFUSION/BOTH). Could route OCR requests to vision models. Only works for `/v1/chat/completions` API shape. Documented in integration guide. Explore in Phase C when modality signal is configured.
- [ ] Verify `gpt-5.2-mini` exists at OpenAI API — remove from config if unavailable.
- [ ] Live-test semantic router with all 7 models + 6 decisions on dashboard.
- [ ] Webapp integration testing — hand off `docs/webapp-integration-guide.md` to Next.js team.

## Technical Details

### Current LLM Init Flow (duplicated in both agents)

```python
# In react_agent/agent.py L422-465 AND research_agent/__init__.py L292-322
if cfg.base_url:
    model = ChatOpenAI(
        openai_api_base=cfg.base_url,
        openai_api_key=api_key,
        model=model_name,
        temperature=cfg.temperature,
        max_tokens=cfg.max_tokens,
    )
else:
    model = init_chat_model(
        cfg.model_name,
        temperature=cfg.temperature,
        max_tokens=cfg.max_tokens,
        api_key=api_key or "No token found",
    )
```

### Target LLM Init Flow (shared factory)

```python
# In graphs/llm.py (new shared module)
def create_chat_model(
    config: RunnableConfig,
    *,
    model_name: str,
    temperature: float,
    max_tokens: int | None,
    base_url: str | None = None,
    custom_model_name: str | None = None,
    custom_api_key: str | None = None,
    routing_metadata: dict[str, str] | None = None,
) -> BaseChatModel:
    ...

# In react_agent/agent.py (simplified)
model = create_chat_model(config, **cfg.llm_kwargs())
```

### Semantic Router Config (config.yaml — router side, NOT runtime)

```yaml
# Router sits at http://semantic-router:8888/v1/chat/completions
# Runtime sends: model="MoM", router picks the backend
vllm_endpoints:
  - name: "ministral"
    address: "vllm-ministral"
    port: 8000
  - name: "azure-gpt-4-1"
    address: "api.openai.com"
    port: 443

decisions:
  - name: "simple_query"
    priority: 100
    rules:
      conditions:
        - type: "domain"
          name: "simple"
    modelRefs:
      - model: "ministral-3b"
  - name: "complex_query"
    priority: 50
    modelRefs:
      - model: "gpt-4.1"
```

## References

- [User Story — Semantic Router Integration](../../user-stories/semantic-router-integration.md)
- [vllm-project/semantic-router](https://github.com/vllm-project/semantic-router) — Apache-2.0, 3.3k stars
- [Semantic Router Docs](https://vllm-semantic-router.com)
- [Iris v0.1 Release](https://github.com/vllm-project/semantic-router/releases/tag/v0.1.0)
- Paper: "Signal Driven Decision Routing for Mixture-of-Modality Models" (Feb 2026)
- Paper: "When to Reason: Semantic Router for vLLM" (NeurIPS 2025 MLForSys)
- Current agent code: `apps/python/src/graphs/react_agent/agent.py`
- Current research agent: `apps/python/src/graphs/research_agent/__init__.py`
- Config models: `apps/python/src/graphs/research_agent/configuration.py`
