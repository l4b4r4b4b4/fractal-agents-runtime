# Task-04: Routing Metadata Passthrough — Forward Hints via Headers

## Status
- [ ] Not Started
- [ ] In Progress
- [ ] Blocked
- [x] Complete

## Objective

Forward routing metadata as HTTP headers when calling the model endpoint, enabling the semantic router (or any OpenAI-compatible proxy) to make better routing decisions. Also add environment variable support for system-level semantic router configuration (`SEMANTIC_ROUTER_ENABLED`, `SEMANTIC_ROUTER_URL`, `SEMANTIC_ROUTER_MODEL`).

---

## Context

The semantic router classifies requests using its own ML models (BERT classifiers for domain, PII, jailbreak), but it can also accept **external hints** via HTTP headers to improve routing quality. For example, the runtime knows things the router doesn't:

- Which organization the request belongs to (cost budgets)
- What type of task is being performed (extraction vs chat vs RAG)
- The user's subscription tier (premium vs free)
- Whether the query was pre-classified as complex

These hints are passed as HTTP headers in the `POST /v1/chat/completions` request. Both `ChatOpenAI` and `init_chat_model` support a `default_headers` kwarg that injects headers into every request to the model endpoint.

### System-Level Router Mode

When `SEMANTIC_ROUTER_ENABLED=true`, the runtime should transparently route all LLM calls through the semantic router, regardless of the assistant's `base_url` or `model_name` configuration:

- `base_url` → overridden to `SEMANTIC_ROUTER_URL`
- `model` → overridden to `SEMANTIC_ROUTER_MODEL` (default `"MoM"`)
- This is a deployment-level concern, not per-assistant

## Acceptance Criteria

- [x] `create_chat_model()` accepts an optional `routing_metadata: dict[str, str]` parameter
- [x] When `routing_metadata` is provided, it is passed as `default_headers` to the model constructor
- [x] Headers are forwarded for both `ChatOpenAI` and `init_chat_model` code paths
- [x] `SEMANTIC_ROUTER_ENABLED` env var toggle: when `true`, overrides `base_url` and `model` for all LLM calls
- [x] `SEMANTIC_ROUTER_URL` env var: the router proxy URL (e.g., `http://semantic-router:8888/v1`)
- [x] `SEMANTIC_ROUTER_MODEL` env var: model name to send (default `"MoM"`)
- [x] When router mode is active, a clear INFO log message shows the override
- [x] When router mode is NOT active, behavior is identical to current (no regression)
- [x] Unit tests cover: metadata headers injected, router env var mode, disabled mode
- [x] All existing tests pass unchanged
- [x] `ruff check . --fix --unsafe-fixes && ruff format .` passes

---

## Approach

### 1. Routing Metadata Headers

Headers the runtime can forward to the semantic router:

| Header | Source | Purpose |
|--------|--------|---------|
| `x-sr-org-id` | Auth context (`x-supabase-access-token` → org claim) | Per-org cost budgets |
| `x-sr-task-type` | Graph type or tool usage hint | Route by task type (extraction/chat/RAG) |
| `x-sr-complexity` | Pre-classified complexity (if known) | Route simple→cheap, complex→expensive |
| `x-sr-user-tier` | Auth context (subscription level) | Premium users get better models |
| `x-sr-graph-id` | `graph_id` from assistant config | Router knows which graph is calling |

These are populated by the agent graph functions (or the server layer), NOT by the end user.

### 2. Implementation in `graphs/llm.py`

```python
def create_chat_model(
    config: RunnableConfig,
    *,
    model_name: str,
    temperature: float = 0.7,
    max_tokens: int | None = None,
    base_url: str | None = None,
    custom_model_name: str | None = None,
    custom_api_key: str | None = None,
    model_name_override: str | None = None,
    routing_metadata: dict[str, str] | None = None,   # ← NEW
) -> BaseChatModel:
    """Create a chat model with optional routing metadata headers."""

    # --- Semantic router env var override ---
    router_enabled = os.getenv("SEMANTIC_ROUTER_ENABLED", "false").lower() == "true"
    if router_enabled:
        router_url = os.getenv("SEMANTIC_ROUTER_URL")
        router_model = os.getenv("SEMANTIC_ROUTER_MODEL", "MoM")
        if router_url:
            logger.info(
                "Semantic router mode: routing all LLM calls through %s (model=%s)",
                _safe_mask_url(router_url),
                router_model,
            )
            base_url = router_url
            model_name_override = router_model

    # --- Build default_headers from routing_metadata ---
    default_headers = {}
    if routing_metadata:
        # Only include non-empty string values
        default_headers = {
            key: value
            for key, value in routing_metadata.items()
            if isinstance(value, str) and value
        }
        if default_headers:
            logger.info(
                "LLM routing metadata: %s",
                list(default_headers.keys()),  # log keys only, not values
            )

    # ... rest of factory logic passes default_headers to constructors ...

    if base_url:
        model = ChatOpenAI(
            openai_api_base=base_url,
            openai_api_key=api_key,
            model=effective_model,
            temperature=temperature,
            max_tokens=max_tokens,
            **({"default_headers": default_headers} if default_headers else {}),
        )
    else:
        model = init_chat_model(
            effective_model,
            temperature=temperature,
            max_tokens=max_tokens,
            api_key=api_key or "No token found",
            **({"default_headers": default_headers} if default_headers else {}),
        )
```

### 3. Populating Metadata in Agent Graphs

```python
# In react_agent/agent.py and research_agent/__init__.py
configurable = config.get("configurable", {}) or {}

routing_metadata = {
    "x-sr-graph-id": "agent",  # or "research_agent"
}

# Add org/user context if available from auth
org_id = configurable.get("x-org-id")
if org_id:
    routing_metadata["x-sr-org-id"] = org_id

user_tier = configurable.get("x-user-tier")
if user_tier:
    routing_metadata["x-sr-user-tier"] = user_tier

model = create_chat_model(
    config,
    model_name=cfg.model_name,
    # ... other params ...
    routing_metadata=routing_metadata,
)
```

### Steps

1. **Edit `src/graphs/llm.py`**
   - Add `routing_metadata` parameter to `create_chat_model()`
   - Build `default_headers` dict from metadata
   - Pass `default_headers` to both `ChatOpenAI` and `init_chat_model`
   - Add `SEMANTIC_ROUTER_ENABLED/URL/MODEL` env var support
   - Add logging for router mode and metadata keys

2. **Edit `src/graphs/react_agent/agent.py`**
   - Build `routing_metadata` dict from available context
   - Pass it to `create_chat_model()`

3. **Edit `src/graphs/research_agent/__init__.py`**
   - Build `routing_metadata` dict from available context
   - Pass it to `create_chat_model()`

4. **Edit `tests/test_llm_factory.py`**
   - Test: metadata headers injected into ChatOpenAI constructor
   - Test: metadata headers injected into init_chat_model kwargs
   - Test: empty metadata → no default_headers passed
   - Test: SEMANTIC_ROUTER_ENABLED=true → base_url and model overridden
   - Test: SEMANTIC_ROUTER_ENABLED=false → no override (default)
   - Test: SEMANTIC_ROUTER_ENABLED without URL → no override (graceful)

5. **Run full test suite + linting**

---

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `SEMANTIC_ROUTER_ENABLED` | `"false"` | Master toggle — when `true`, all LLM calls route through the router |
| `SEMANTIC_ROUTER_URL` | (none) | Router proxy URL, e.g., `http://semantic-router:8888/v1` |
| `SEMANTIC_ROUTER_MODEL` | `"MoM"` | Model name sent to the router (Mixture-of-Models) |

### Precedence when router mode is active

```
SEMANTIC_ROUTER_URL     → overrides base_url (any assistant config)
SEMANTIC_ROUTER_MODEL   → overrides model_name_override → custom_model_name → model_name
```

This is a **system-level override** — it applies to ALL assistants regardless of their individual config. This is intentional: when you deploy with a semantic router, you want ALL traffic to go through it.

---

## Notes & Discoveries

### Session Log

| Date | Summary |
|------|---------|
| 2026-03-01 | Task created. Header injection mechanism designed, env var schema defined, implementation plan documented. |
| 2026-03-02 | **Implemented.** Added `routing_metadata: dict[str, str] | None = None` param to `create_chat_model()`. Builds `default_headers` dict filtering empty/non-string values. Passed to both `ChatOpenAI` and `init_chat_model` kwargs. Added `SEMANTIC_ROUTER_ENABLED`/`URL`/`MODEL` env var support: when enabled, overrides `base_url` and injects router model as `model_name_override`. Warning logged when enabled without URL. Both agents build `routing_metadata` with `x-sr-graph-id` plus optional `x-sr-org-id`/`x-sr-user-tier` from configurable. 18 new tests across `TestRoutingMetadata` (8), `TestSemanticRouterEnvVars` (8), `TestCombinedOverrideAndMetadata` (2). All 1208 tests pass, 100% coverage on `graphs/llm.py`, lint clean. |

---

## Blockers & Dependencies

| Blocker/Dependency | Status | Resolution |
|--------------------|--------|------------|
| Task-02 (Shared LLM Factory) | 🟢 Complete | Factory exists in `graphs/llm.py` |
| Task-03 (Call-Time Model Override) | 🟢 Complete | `model_name_override` param implemented, used by router env vars |
| `ChatOpenAI` `default_headers` support | ✅ Confirmed | Kwarg exists, passed to underlying `openai.AsyncClient` |
| `init_chat_model` kwargs passthrough | ✅ Confirmed | Unknown kwargs forwarded to model constructor |

---

## Verification

```bash
# Unit tests for metadata passthrough
cd apps/python && uv run pytest tests/test_llm_factory.py -v -k "metadata or router"

# Full test suite
cd apps/python && uv run pytest -x -v

# Coverage
cd apps/python && uv run pytest --cov --cov-report=term-missing

# Lint
cd apps/python && uv run ruff check . --fix --unsafe-fixes && uv run ruff format .

# Manual smoke test: verify router env vars
cd apps/python && \
  SEMANTIC_ROUTER_ENABLED=true \
  SEMANTIC_ROUTER_URL=http://localhost:8888/v1 \
  OPENAI_API_KEY=test \
  uv run python -c "
from langchain_core.runnables import RunnableConfig
from graphs.llm import create_chat_model

config: RunnableConfig = {'configurable': {}}
# Should log: 'Semantic router mode: routing all LLM calls through http://localhost:8888/v1 (model=MoM)'
model = create_chat_model(
    config,
    model_name='openai:gpt-4o',
    routing_metadata={'x-sr-graph-id': 'agent', 'x-sr-org-id': 'test-org'},
)
print(f'Model: {model.model_name}, Base URL: {model.openai_api_base}')
"
```

---

## Related

- **Parent Goal:** [42 — Semantic Router Integration](../scratchpad.md)
- **Depends On:** [Task-02 — Shared LLM Factory](../Task-02-Shared-LLM-Factory/scratchpad.md)
- **Parallel With:** [Task-03 — Call-Time Model Override](../Task-03-Call-Time-Model-Override/scratchpad.md)
- **Enables:** [Task-05 — Testing & Documentation](../Task-05-Testing-Documentation/scratchpad.md)
### Implementation Details

- `create_chat_model()` gained `routing_metadata: dict[str, str] | None = None` parameter
- `default_headers` built by filtering: only non-empty string values included
- When `default_headers` is non-empty, passed as kwarg to `ChatOpenAI(**kwargs)` and `init_chat_model(model, **kwargs)`
- When empty or None, `default_headers` kwarg is omitted entirely (no empty dict passed)
- Logging: keys only logged (`list(default_headers.keys())`), never values (security)
- `SEMANTIC_ROUTER_ENABLED` checked via `os.getenv(..., "false").lower() == "true"` (case-insensitive)
- When enabled + URL set: `base_url` overridden to `SEMANTIC_ROUTER_URL`, `model_name_override` set to `SEMANTIC_ROUTER_MODEL` (default `"MoM"`) unless caller already set an explicit override
- When enabled but URL missing: warning logged, no crash, falls through to standard path
- Both agents build `routing_metadata = {"x-sr-graph-id": "agent"|"research_agent"}` plus optional `x-sr-org-id` and `x-sr-user-tier` from configurable dict

- **Key Files:**
  - `src/graphs/llm.py` (routing_metadata + env var support added)
  - `src/graphs/react_agent/agent.py` (populates metadata, passes override)
  - `src/graphs/research_agent/__init__.py` (populates metadata, passes override)
  - `tests/test_llm_factory.py` (18 new tests: `TestRoutingMetadata`, `TestSemanticRouterEnvVars`, `TestCombinedOverrideAndMetadata`)