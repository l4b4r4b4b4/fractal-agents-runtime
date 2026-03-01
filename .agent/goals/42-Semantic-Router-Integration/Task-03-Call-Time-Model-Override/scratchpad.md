# Task-03: Call-Time Model Override — Per-Invocation Model Selection

## Status
- [ ] Not Started
- [ ] In Progress
- [ ] Blocked
- [x] Complete

## Objective

Add `model_name_override` support so that model selection can be overridden at **run invocation time** (per-request), rather than being permanently baked into the assistant config at creation time. This is the core runtime mechanism that enables the semantic router: the router (or the platform) can specify which model to use for each individual request without modifying the assistant.

---

## Context

Currently, every assistant has a fixed `model_name` set at creation time via `config.configurable.model_name`. Every invocation of that assistant uses the same model, regardless of query complexity, cost constraints, or model health.

The existing `_merge_assistant_configurable_into_run_config()` function in `react_agent/agent.py` already implements the precedence rule: **run-level keys override assistant-level keys**. However, there is no explicit `model_name_override` field, and the current code always reads `cfg.model_name` directly from the parsed config without checking for a runtime override.

### Why a separate field?

Using the same `model_name` field at both assistant and run level would work (because of the merge logic), but it's semantically ambiguous — you can't tell whether a `model_name` in the run config was intentionally set or just inherited. A dedicated `model_name_override` field:

1. Makes intent explicit ("I want to override the assistant's model for this run")
2. Doesn't conflict with the assistant's stored `model_name`
3. Is easy to detect and log ("model override active: X → Y")
4. Can be set by the platform, semantic router integration layer, or API caller

### Target usage

```python
# At assistant creation — sets the default model
assistant = await client.assistants.create(
    graph_id="agent",
    config={"configurable": {"model_name": "openai:gpt-4o"}}
)

# At invocation — overrides the default for this specific run
response = await client.runs.create(
    thread_id=thread_id,
    assistant_id=assistant_id,
    config={"configurable": {"model_name_override": "openai:gpt-4.1"}},
)
```

## Acceptance Criteria

- [x] `model_name_override` field accepted in `configurable` dict at run invocation time
- [x] Override precedence: `model_name_override` > `custom_model_name` > `model_name`
- [x] When override is active, a clear INFO log message shows the original and overridden model
- [x] When override is absent or `None`, behavior is identical to current (no regression)
- [x] Works with both standard providers (`init_chat_model`) and custom endpoints (`ChatOpenAI`)
- [x] Works for both `react_agent` and `research_agent` graphs (via shared LLM factory)
- [x] Override does NOT persist — it only applies to the current run invocation
- [x] Unit tests cover: override present, override absent, override with custom endpoint, override with standard provider
- [x] All existing tests pass unchanged (backward compatible)
- [x] `ruff check . --fix --unsafe-fixes && ruff format .` passes

---

## Approach

### Implementation in `graphs/llm.py` (shared factory from Task-02)

The `create_chat_model()` factory function gains one new parameter: `model_name_override`.

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
    model_name_override: str | None = None,   # ← NEW
) -> BaseChatModel:
    """Create a chat model instance from configuration.

    Model resolution order:
    1. model_name_override (run-time, per-invocation)
    2. custom_model_name (assistant-level, for custom endpoints)
    3. model_name (assistant-level default)
    """
    effective_model = model_name_override or custom_model_name or model_name

    if model_name_override:
        logger.info(
            "LLM model override active: %s → %s",
            model_name,
            model_name_override,
        )

    # ... rest of factory logic uses effective_model ...
```

### Reading the override from config

In both agent graph functions, the override is read from the `configurable` dict (which already has run-level keys merged via `_merge_assistant_configurable_into_run_config`):

```python
# In react_agent/agent.py and research_agent/__init__.py
configurable = config.get("configurable", {}) or {}
model_name_override = configurable.get("model_name_override")

model = create_chat_model(
    config,
    model_name=cfg.model_name,
    temperature=cfg.temperature,
    max_tokens=cfg.max_tokens,
    base_url=cfg.base_url,
    custom_model_name=cfg.custom_model_name,
    custom_api_key=cfg.custom_api_key,
    model_name_override=model_name_override,
)
```

### Override with custom endpoints

When `base_url` is set AND `model_name_override` is provided:
- The override takes precedence over `custom_model_name`
- `base_url` is still used (the override changes WHICH model, not WHERE to send it)
- This supports the semantic router use case: `base_url` → router URL, `model_name_override` → specific model or `"MoM"`

When `base_url` is NOT set AND `model_name_override` is provided:
- The override replaces `model_name` in the `init_chat_model()` call
- The override must be a valid `provider:model` string (e.g., `"openai:gpt-4.1"`)
- API key resolution uses the override's provider prefix

### Override with semantic router

The semantic router integration (Task-04) will use this mechanism:

```python
# When SEMANTIC_ROUTER_ENABLED=true, the factory injects:
# - base_url → SEMANTIC_ROUTER_URL
# - model_name_override → SEMANTIC_ROUTER_MODEL (default "MoM")
# This happens transparently — the agent graph doesn't need to know
```

### Steps

1. **Edit `src/graphs/llm.py`**
   - Add `model_name_override` parameter to `create_chat_model()`
   - Implement resolution order: override > custom_model_name > model_name
   - Update API key resolution to use the effective model's provider
   - Add INFO logging when override is active
   - Update docstring

2. **Edit `src/graphs/react_agent/agent.py`**
   - Read `model_name_override` from `configurable` dict
   - Pass it to `create_chat_model()`

3. **Edit `src/graphs/research_agent/__init__.py`**
   - Read `model_name_override` from `configurable` dict
   - Pass it to `create_chat_model()`

4. **Edit `tests/test_llm_factory.py`**
   - Test: override present → uses override model
   - Test: override absent → uses model_name (current behavior)
   - Test: override with custom endpoint → override takes precedence over custom_model_name
   - Test: override changes provider → correct API key resolved
   - Test: override logging message appears

5. **Run full test suite + linting**

---

## Model Resolution Matrix

| `model_name` | `custom_model_name` | `model_name_override` | `base_url` | Effective Model | Provider Path |
|--------------|--------------------|-----------------------|------------|-----------------|---------------|
| `openai:gpt-4o` | `None` | `None` | `None` | `openai:gpt-4o` | `init_chat_model` |
| `openai:gpt-4o` | `None` | `openai:gpt-4.1` | `None` | `openai:gpt-4.1` | `init_chat_model` |
| `custom:` | `ministral-3b` | `None` | `http://vllm:8000/v1` | `ministral-3b` | `ChatOpenAI` |
| `custom:` | `ministral-3b` | `gpt-4.1` | `http://vllm:8000/v1` | `gpt-4.1` | `ChatOpenAI` |
| `openai:gpt-4o` | `None` | `MoM` | `http://router:8888/v1` | `MoM` | `ChatOpenAI` |
| `openai:gpt-4o` | `None` | `anthropic:claude-sonnet-4-0` | `None` | `anthropic:claude-sonnet-4-0` | `init_chat_model` |

## Edge Cases

1. **Override is empty string** → treated as `None` (no override)
2. **Override is same as model_name** → no-op, no log message needed
3. **Override with invalid provider** → `init_chat_model` will raise; let it propagate (no silent fallback)
4. **Override changes provider but base_url is set** → base_url wins for endpoint, override wins for model name
5. **Override at assistant creation time** → technically possible but not intended; no UI widget for it

---

## Notes & Discoveries

### Session Log

| Date | Summary |
|------|---------|
| 2026-03-01 | Task created. Resolution matrix, edge cases, and implementation plan documented. |
| 2026-03-02 | **Implemented.** Added `model_name_override` param to `create_chat_model()` in `graphs/llm.py`. Resolution: `effective_override or custom_model_name or model_name`. Empty strings treated as None. Both agents read from `configurable.get("model_name_override")` and pass to factory. 8 new tests in `TestModelNameOverride` class (precedence, empty string, provider change, logging, no-log-when-same). All 1208 tests pass, 100% coverage on `graphs/llm.py`, lint clean. |

---

## Blockers & Dependencies

| Blocker/Dependency | Status | Resolution |
|--------------------|--------|------------|
| Task-02 (Shared LLM Factory) | 🟢 Complete | Factory exists in `graphs/llm.py` |
| Existing `_merge_assistant_configurable_into_run_config` | ✅ Exists | Run-level keys already override assistant-level keys |

---

## Verification

```bash
# Unit tests for model override
cd apps/python && uv run pytest tests/test_llm_factory.py -v -k "override"

# Full test suite
cd apps/python && uv run pytest -x -v

# Coverage
cd apps/python && uv run pytest --cov --cov-report=term-missing

# Lint
cd apps/python && uv run ruff check . --fix --unsafe-fixes && uv run ruff format .

# Manual smoke test: verify override is logged
cd apps/python && OPENAI_API_KEY=test uv run python -c "
from langchain_core.runnables import RunnableConfig
from graphs.llm import create_chat_model

config: RunnableConfig = {'configurable': {}}
# This should log: 'LLM model override active: openai:gpt-4o → openai:gpt-4.1'
model = create_chat_model(
    config,
    model_name='openai:gpt-4o',
    model_name_override='openai:gpt-4.1',
)
print(f'Model created: {model.model_name}')
"
```

---

## Related

- **Parent Goal:** [42 — Semantic Router Integration](../scratchpad.md)
- **Depends On:** [Task-02 — Shared LLM Factory](../Task-02-Shared-LLM-Factory/scratchpad.md)
- **Enables:** [Task-04 — Routing Metadata Passthrough](../Task-04-Routing-Metadata-Passthrough/scratchpad.md)
### Implementation Details

- `create_chat_model()` gained `model_name_override: str | None = None` parameter
- Resolution: `effective_override = model_name_override if model_name_override else None` (empty string → None)
- `effective_model = effective_override or custom_model_name or model_name`
- INFO log: `"LLM model override active: %s -> %s"` (only when override differs from model_name)
- API key resolution uses `effective_model`'s provider, so changing provider via override resolves the correct key
- Both agents read `configurable.get("model_name_override")` and pass it through
- Semantic router env vars (Task-04) also inject into `model_name_override` when `SEMANTIC_ROUTER_ENABLED=true`

- **Key Files:**
  - `src/graphs/llm.py` (override parameter added)
  - `src/graphs/react_agent/agent.py` (reads override from config)
  - `src/graphs/research_agent/__init__.py` (reads override from config)
  - `tests/test_llm_factory.py` (8 override tests in `TestModelNameOverride`)