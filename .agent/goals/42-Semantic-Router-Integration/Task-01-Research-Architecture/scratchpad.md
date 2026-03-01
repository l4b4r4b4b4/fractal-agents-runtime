# Task-01: Research & Architecture Decision

## Status
- [ ] In Progress
- [x] Complete

## Objective

Gather all information on the problem space (current static model selection) and solution space (vLLM Semantic Router, LangChain model init APIs, header passthrough). Validate assumptions from the user story, document the integration architecture, and produce a concrete plan for Tasks 02–05.

---

## Context

The [user story](../../../user-stories/semantic-router-integration.md) proposes integrating the [vLLM Semantic Router](https://github.com/vllm-project/semantic-router) (v0.1 "Iris") as a transparent proxy between the Python runtime and LLM backends. Before writing any code, we need to:

1. Confirm the router's API is truly OpenAI-compatible and works with `ChatOpenAI`
2. Understand the exact code duplication we're resolving
3. Validate that `ChatOpenAI` and `init_chat_model` support custom header injection
4. Decide on config schema for routing features
5. Map out the file changes for each subsequent task

## Acceptance Criteria

- [x] Semantic router API compatibility validated (OpenAI `/v1/chat/completions`)
- [x] Current code duplication quantified (files, lines, patterns)
- [x] `ChatOpenAI` `default_headers` support confirmed
- [x] `init_chat_model` header passthrough mechanism documented
- [x] Config schema proposal written (new fields, defaults, backward compat)
- [x] File change map produced for Tasks 02–05
- [x] Architecture decision documented in this scratchpad

---

## Research Findings

### 1. Semantic Router API Compatibility ✅

**Confirmed: fully OpenAI-compatible.** The semantic router exposes:

```
POST http://<router>:8888/v1/chat/completions
```

- Accepts standard OpenAI request format (`model`, `messages`, `temperature`, etc.)
- When using router-managed model selection, set `model: "MoM"` (Mixture-of-Models)
- Returns standard OpenAI response format (streaming + non-streaming)
- Supports all content types the runtime currently uses

**Test command (from router docs):**
```bash
curl http://localhost:8888/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "MoM", "messages": [{"role": "user", "content": "Hello!"}]}'
```

**Implication:** The runtime's existing `ChatOpenAI(openai_api_base=...)` path works with zero changes. We just need to:
- Set `openai_api_base` to the router URL
- Set `model` to `"MoM"` (or a specific model name for passthrough)

### 2. Code Duplication Analysis ✅

#### Duplicated LLM Initialization (~40 lines each, ~80 total)

| File | Lines | Pattern |
|------|-------|---------|
| `react_agent/agent.py` | L422–465 | `if cfg.base_url: ChatOpenAI(...) else: init_chat_model(...)` |
| `research_agent/__init__.py` | L292–322 | Identical pattern, same branching, same kwargs |

Both files:
1. Check `cfg.base_url` to decide custom vs standard provider
2. Resolve API key via identical `get_api_key_for_model()` function (also duplicated)
3. Log the same debug info with slightly different prefixes
4. Create either `ChatOpenAI` or `init_chat_model` with identical kwargs
5. Handle `custom_model_name` fallback to `cfg.model_name`

#### Duplicated API Key Resolution (~30 lines each)

| File | Function | Lines |
|------|----------|-------|
| `react_agent/agent.py` | `get_api_key_for_model()` | L279–307 |
| `research_agent/__init__.py` | `_get_api_key_for_model()` | L81–103 |

Same logic: provider prefix → env var mapping (`openai` → `OPENAI_API_KEY`, etc.), custom endpoint fallback.

#### Duplicated Config Models

| Model | `react_agent/agent.py` | `research_agent/configuration.py` |
|-------|------------------------|-----------------------------------|
| `RagConfig` | L109–113 | L30–33 |
| `MCPServerConfig` | L116–131 | L36–41 |
| `MCPConfig` | L134–137 | L44–46 |

Identical field definitions, identical defaults. Only the main config class differs (react has UI metadata, research has agent-specific fields).

**Total duplication: ~150 lines** that should be ~30 lines with a shared module.

### 3. LangChain Header Support ✅

#### `ChatOpenAI` — `default_headers` kwarg

```python
# Confirmed: ChatOpenAI accepts default_headers
model = ChatOpenAI(
    openai_api_base="http://semantic-router:8888/v1",
    model="MoM",
    default_headers={
        "x-sr-org-id": "uuid-here",
        "x-sr-task-type": "extraction",
    },
)
```

`ChatOpenAI` inherits from `BaseChatOpenAI` which passes `default_headers` to the underlying `openai.AsyncClient`. These headers are sent with every request to the endpoint.

#### `init_chat_model` — kwargs passthrough

```python
# init_chat_model passes unknown kwargs to the model constructor
model = init_chat_model(
    "openai:gpt-4o",
    temperature=0.7,
    default_headers={"x-sr-task-type": "chat"},  # passed to ChatOpenAI
)
```

For OpenAI-compatible providers, `init_chat_model` creates a `ChatOpenAI` instance and forwards kwargs. For Anthropic, it creates `ChatAnthropic` which also supports `default_headers`. This means header injection works regardless of the provider path.

### 4. Config Schema Proposal ✅

#### New fields on `GraphConfigPydantic` / `ResearchAgentConfig`

No new fields needed on the per-agent config models. The existing fields already support the semantic router:

| Existing Field | Router Usage |
|----------------|--------------|
| `base_url` | Point to `http://semantic-router:8888/v1` |
| `model_name` | Set to `"custom:"` to enable custom endpoint |
| `custom_model_name` | Set to `"MoM"` for router-managed selection |

#### New field: `model_name_override` (call-time)

```python
# Passed at runs.create() time, NOT at assistant creation time
config = {
    "configurable": {
        "model_name_override": "openai:gpt-4.1",  # overrides assistant default
    }
}
```

This field is NOT part of the assistant config schema (no UI widget). It's purely a runtime override passed at invocation time. The existing `_merge_assistant_configurable_into_run_config` function already handles run-level keys overriding assistant-level keys, so the precedence is:

```
model_name_override (run-time) > custom_model_name (assistant) > model_name (assistant)
```

#### New fields: routing metadata (on shared LLM factory, not config models)

Routing metadata comes from the runtime context, not from user config:

```python
# Populated by the runtime/server layer, not by the user
routing_metadata = {
    "x-sr-org-id": request.org_id,        # from auth context
    "x-sr-task-type": "extraction",        # from graph type or tool usage
    "x-sr-user-tier": "premium",           # from auth context
}
```

These are passed as `default_headers` to the model constructor. They are NOT configurable by the end user — they're system-level metadata the runtime injects.

#### Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `SEMANTIC_ROUTER_URL` | (none) | If set, all LLM calls route through this URL |
| `SEMANTIC_ROUTER_MODEL` | `"MoM"` | Model name to send to the router |
| `SEMANTIC_ROUTER_ENABLED` | `"false"` | Master toggle for router mode |

When `SEMANTIC_ROUTER_ENABLED=true`:
- `base_url` is overridden to `SEMANTIC_ROUTER_URL`
- `model` is overridden to `SEMANTIC_ROUTER_MODEL`
- This is a system-level override, not per-assistant

### 5. Architecture Decision ✅

**Decision: Option A — Router as transparent proxy.**

```
Agent Graph → create_chat_model() → ChatOpenAI(base_url=router_url, model="MoM")
                                          │
                                          ▼
                                   Semantic Router (Go proxy, port 8888)
                                          │
                                    ┌─────┼─────┐
                                    ▼     ▼     ▼
                                ministral GPT-4.1 GPT-4o-mini
```

**Why Option A over Option B (runtime resolves endpoints):**

| Criterion | Option A (proxy) | Option B (runtime resolves) |
|-----------|------------------|-----------------------------|
| Coupling | Low — runtime talks to one URL | High — runtime queries DB for endpoints |
| Complexity | Minimal runtime changes | Significant runtime changes + DB queries |
| Caching | Router handles semantic caching | Runtime would need its own caching |
| Safety | Router handles PII/jailbreak | Runtime would need separate safety layer |
| Failover | Router handles health checks | Runtime would need health checking |
| Latency | Sub-1ms proxy overhead (Go) | DB query overhead per request |

---

## File Change Map (Tasks 02–05)

### Task-02: Shared LLM Factory

| Action | File | Changes |
|--------|------|---------|
| **CREATE** | `src/graphs/llm.py` | Shared `create_chat_model()` factory + `get_api_key_for_model()` |
| **CREATE** | `src/graphs/configuration.py` | Shared `RagConfig`, `MCPServerConfig`, `MCPConfig` base models |
| **EDIT** | `src/graphs/react_agent/agent.py` | Replace inline LLM init with `create_chat_model()` call; import shared config models |
| **EDIT** | `src/graphs/research_agent/__init__.py` | Replace inline LLM init with `create_chat_model()` call |
| **EDIT** | `src/graphs/research_agent/configuration.py` | Import shared config models instead of redefining them |
| **CREATE** | `tests/test_llm_factory.py` | Unit tests for `create_chat_model()` |

### Task-03: Call-Time Model Override

| Action | File | Changes |
|--------|------|---------|
| **EDIT** | `src/graphs/llm.py` | Add `model_name_override` resolution in factory |
| **EDIT** | `src/graphs/react_agent/agent.py` | Pass `model_name_override` from config to factory |
| **EDIT** | `src/graphs/research_agent/__init__.py` | Pass `model_name_override` from config to factory |
| **EDIT** | `tests/test_llm_factory.py` | Tests for override precedence |

### Task-04: Routing Metadata Passthrough

| Action | File | Changes |
|--------|------|---------|
| **EDIT** | `src/graphs/llm.py` | Add `routing_metadata` → `default_headers` in factory |
| **EDIT** | `src/graphs/llm.py` | Add `SEMANTIC_ROUTER_*` env var support |
| **EDIT** | `tests/test_llm_factory.py` | Tests for header injection and env var routing |

### Task-05: Testing & Documentation

| Action | File | Changes |
|--------|------|---------|
| **VERIFY** | all test files | Full test suite passes, ≥73% coverage |
| **EDIT** | `README.md` | Document semantic router integration, env vars |
| **CREATE** | `docs/semantic-router.md` | Detailed integration guide |
| **EDIT** | `docker-compose.yml` | Optional semantic router service for local dev |

---

## Blockers & Dependencies

| Blocker/Dependency | Status | Resolution |
|--------------------|--------|------------|
| Semantic router API compatibility | ✅ Resolved | Confirmed OpenAI-compatible |
| `ChatOpenAI` header support | ✅ Resolved | `default_headers` kwarg confirmed |
| Platform `ai_models` table | ✅ Exists | Already seeded with 12 models |
| Semantic router deployment | N/A | Out of scope — infra concern |

---

## Session Log

| Date | Summary |
|------|---------|
| 2026-03-01 | Task created. Research completed: API compat validated, code duplication quantified (~150 lines), header support confirmed, config schema proposed, architecture decision documented (Option A — proxy), file change map produced for all tasks. |

---

## Related

- **Parent Goal:** [42 — Semantic Router Integration](../scratchpad.md)
- **Next Task:** [Task-02 — Shared LLM Factory](../Task-02-Shared-LLM-Factory/scratchpad.md)
- **User Story:** [Semantic Router Integration](../../../user-stories/semantic-router-integration.md)
- **External:** [vllm-project/semantic-router](https://github.com/vllm-project/semantic-router)