# Goal 24: Langfuse Prompt Template Integration

> **Status:** 🟡 In Progress
> **Priority:** Medium
> **Created:** 2026-02-13
> **Depends on:** Goal 23 (Vertriebsagent Graph) — benefits from but doesn't block
> **Blocks:** Nothing (additive feature)
> **Branch:** `fix/merge-main-into-development`

---

## Problem Statement

All agent prompts are currently hardcoded as Python string constants (`ANALYZER_PHASE1_PROMPT`, `WORKER_QUERY_PHASE1_PROMPT`, etc.). This means:

- **No runtime editing** — changing a prompt requires a code change, PR, CI, Docker build, and redeploy
- **No version history** — prompt iterations are buried in git commits, not visible to non-engineers
- **No A/B testing** — can't run two prompt versions side-by-side and compare trace quality
- **No collaboration** — domain experts (e.g. the Vertriebsagent colleague) can't iterate on prompts without touching code
- **No metrics link** — no easy way to correlate a specific prompt version with Langfuse trace scores

Langfuse has a [Prompt Management](https://langfuse.com/docs/prompts) feature that solves all of this. Prompts are versioned, editable in the Langfuse UI, and can be fetched at runtime with caching.

---

## Research: Langfuse Prompt Management

### How It Works

```python
from langfuse import Langfuse

langfuse = Langfuse()

# Fetch a prompt by name (cached, with TTL)
prompt = langfuse.get_prompt("analyzer-phase1", type="text")

# Get the compiled string (with variable substitution)
compiled = prompt.compile(stadt="München", asset_klasse="Büro")

# Use in LangChain
from langfuse.langchain import ChatPromptTemplate
lc_prompt = prompt.get_langchain_prompt()
```

### Key Features

- **Versioning** — each prompt has versions (1, 2, 3...), with one marked "active"
- **Labels** — `production`, `staging`, `latest` — fetch by label instead of version number
- **Variables** — `{{variable}}` syntax, compiled at runtime with `.compile(key=value)`
- **Caching** — SDK caches prompts in-memory with configurable TTL (default 60s)
- **Fallback** — if Langfuse is unreachable, returns cached version or raises
- **LangChain integration** — `.get_langchain_prompt()` returns a `ChatPromptTemplate`
- **Metrics** — traces linked to prompt versions show which version produced which results
- **Types** — `text` (plain string) or `chat` (list of messages with roles)

### API

```python
# Fetch active production prompt
prompt = langfuse.get_prompt("my-prompt")

# Fetch specific label
prompt = langfuse.get_prompt("my-prompt", label="staging")

# Fetch specific version
prompt = langfuse.get_prompt("my-prompt", version=3)

# Cache control
prompt = langfuse.get_prompt("my-prompt", cache_ttl_seconds=300)

# Fallback to hardcoded default if Langfuse is down
prompt = langfuse.get_prompt("my-prompt", fallback="You are a helpful assistant...")
```

### What This Means for Our Graphs

Currently in `graphs/react_agent/agent.py` and `graphs/vertriebsagent/prompts/`:
```python
# Hardcoded — change requires deploy
ANALYZER_PHASE1_PROMPT = """Du bist ein Supervisor-Agent..."""
```

With Langfuse prompt management:
```python
# Fetched at runtime — change via Langfuse UI, no deploy needed
prompt = langfuse.get_prompt(
    "vertriebsagent-analyzer-phase1",
    fallback=ANALYZER_PHASE1_PROMPT,  # hardcoded default as fallback
)
compiled = prompt.compile(stadt=state["stadt"])
```

---

## Research: Integration Points in Our Codebase

### Current Prompt Usage

**react_agent** (`graphs/react_agent/agent.py`):
- System prompt is constructed dynamically from assistant config (`configurable.system_prompt`)
- No static prompt constants — already somewhat flexible
- Could benefit from Langfuse for the default system prompt

**vertriebsagent** (Goal 23, `graphs/vertriebsagent/prompts/`):
- 8 static prompt constants across two files:
  - `ANALYZER_PHASE1_PROMPT`
  - `AGGREGATOR_PHASE2_PROMPT`
  - `WORKER_QUERY_PHASE1_PROMPT`, `WORKER_QUERY_PHASE2_PROMPT`
  - `VERIFIER_PHASE1_PROMPT`, `VERIFIER_PHASE2_PROMPT`
  - `WORKER_FINAL_PHASE1_PROMPT`, `WORKER_FINAL_PHASE2_PROMPT`
- These are the primary candidates for Langfuse prompt management

### Where Langfuse Client Lives

`infra/tracing.py` already initialises Langfuse for tracing. We can extend it (or create a sibling `infra/prompts.py`) to provide prompt fetching utilities.

---

## Solution Design

### Approach: Hybrid — Langfuse with Hardcoded Fallbacks

Prompts are always defined in code as the **fallback default**. If Langfuse is configured and reachable, prompts are fetched from Langfuse instead. This means:

- **No Langfuse required** — the runtime works without Langfuse, using hardcoded prompts
- **Graceful degradation** — if Langfuse is down, falls back to hardcoded version
- **Progressive adoption** — teams can start with code prompts and migrate to Langfuse when ready
- **No breaking change** — existing graphs continue to work unchanged

### Implemented Module: `infra/prompts.py`

**Three public functions:**

1. **`get_prompt()`** — Fetch a text or chat prompt from Langfuse with runtime overrides
2. **`register_default_prompt()`** — Register a prompt default for auto-seeding
3. **`seed_default_prompts()`** — Create missing prompts in Langfuse on startup

```python
def get_prompt(
    name: str,
    *,
    fallback: str | list[ChatMessage],
    prompt_type: Literal["text", "chat"] = "text",
    config: RunnableConfig | None = None,   # runtime overrides
    label: str = "production",
    cache_ttl_seconds: int | None = None,
    variables: dict[str, str] | None = None,
) -> str | list[ChatMessage]:
    """Fetch a prompt from Langfuse, falling back to the hardcoded default.

    Resolution order:
    1. config.configurable.prompt_overrides[name] → override name/label/version
    2. Langfuse fetch with resolved name + label + version
    3. Fallback string/messages (with {{variable}} substitution)
    """
```

**Runtime override support** — frontend can pass in `configurable`:
```json
{
  "configurable": {
    "prompt_overrides": {
      "react-agent-system-prompt": { "label": "experiment-a" },
      "some-prompt": { "version": 5 },
      "another-prompt": { "name": "swapped-prompt" }
    }
  }
}
```

Override keys: `name` (swap entire prompt), `label` (A/B testing), `version` (pin exact version).

**Auto-seeding** — graphs register defaults at import time:
```python
from infra.prompts import register_default_prompt
register_default_prompt("react-agent-system-prompt", DEFAULT_SYSTEM_PROMPT)
```

Server startup calls `seed_default_prompts()` after `initialize_langfuse()` — any prompts that don't exist in Langfuse are auto-created with the `production` label. Existing prompts are left untouched.

### Usage in Graphs

```python
from infra.prompts import get_prompt

# Text prompt (returns str) — in react_agent graph()
system_prompt = get_prompt(
    "react-agent-system-prompt",
    fallback=DEFAULT_SYSTEM_PROMPT,
    config=config,  # enables runtime overrides from frontend
)

# Chat prompt (returns list[dict]) — for future graph use
messages = get_prompt(
    "my-chat-prompt",
    prompt_type="chat",
    fallback=[{"role": "system", "content": "You are helpful."}],
    config=config,
    variables={"user_name": "Alice"},
)
```

### Naming Convention for Langfuse Prompts

```
{graph_name}-{node_name}[-{phase}]
```

Examples:
- `vertriebsagent-analyzer-phase1`
- `vertriebsagent-analyzer-phase2` (not an LLM call currently, but could become one)
- `vertriebsagent-aggregator-phase2`
- `vertriebsagent-worker-query-phase1`
- `vertriebsagent-worker-query-phase2`
- `vertriebsagent-worker-verifier-phase1`
- `vertriebsagent-worker-verifier-phase2`
- `vertriebsagent-worker-final-phase1`
- `vertriebsagent-worker-final-phase2`
- `react-agent-system-prompt`

### Configuration

No new env vars needed — uses the existing `LANGFUSE_SECRET_KEY` / `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_BASE_URL` already in our config. If those are empty, Langfuse is not configured and all prompts use hardcoded fallbacks.

Optional new env var:
- `LANGFUSE_PROMPT_CACHE_TTL` — override default cache TTL (default: 300s). Set to `0` to disable caching (useful in development).

Added to `.env.example`.

---

## Task Breakdown

### Task-01: Create `infra/prompts.py` 🟢 Complete

**Implemented (Session 12):**
- `get_prompt()` with text + chat prompt support, Langfuse fetch + fallback
- Runtime override support via `config.configurable.prompt_overrides` (name/label/version)
- `register_default_prompt()` — graph-level prompt registration for auto-seeding
- `seed_default_prompts()` — creates missing prompts in Langfuse on startup (idempotent)
- `_substitute_variables_text()` / `_substitute_variables_chat()` — `{{var}}` substitution on fallbacks
- `_extract_overrides()` — safe extraction from RunnableConfig
- `_get_default_cache_ttl()` — reads `LANGFUSE_PROMPT_CACHE_TTL` env var
- Exported from `infra/__init__.py` (`get_prompt`, `register_default_prompt`, `seed_default_prompts`)
- **65 tests** in `src/server/tests/test_prompts.py` — **98% coverage** on `infra/prompts.py`
- Tests cover: no-Langfuse fallback, Langfuse fetch, Langfuse failure, runtime overrides (label/version/name/combined), cache TTL resolution, variable substitution, registration, seeding (create/skip/multi/failure-resilience)

### Task-02: Integrate with Vertriebsagent Graph ⚪ Not Started

- Update all 8 prompt usages in the vertriebsagent graph to use `get_prompt()`
- Keep hardcoded prompts in `prompts/` as fallback defaults
- Add Langfuse prompt names following the naming convention
- Register defaults via `register_default_prompt()` at import time
- Verify graph still works identically when Langfuse is not configured
- **Blocked by:** Goal 23 (graph doesn't exist yet)

### Task-03: Integrate with React Agent 🟢 Complete

**Implemented (Session 12):**
- `graphs/react_agent/agent.py` — system prompt now resolved via `get_prompt()`
- Priority chain: assistant config override > Langfuse prompt > hardcoded `DEFAULT_SYSTEM_PROMPT`
- `register_default_prompt("react-agent-system-prompt", DEFAULT_SYSTEM_PROMPT)` at module level
- `config` passed through to `get_prompt()` enabling runtime overrides from frontend
- `UNEDITABLE_SYSTEM_PROMPT` still appended after resolution (security constraint preserved)

### Task-04: Documentation + Seed Prompts 🟡 Partially Complete

**Done:**
- `seed_default_prompts()` auto-creates missing prompts in Langfuse (no manual script needed)
- Server startup in `server/app.py` calls seed after `initialize_langfuse()` — imports graph modules to trigger registration
- `LANGFUSE_PROMPT_CACHE_TTL` added to `.env.example`

**Remaining:**
- Document prompt naming convention in graph READMEs
- Update Helm chart `values-testing.yaml` with `LANGFUSE_PROMPT_CACHE_TTL` if needed
- Update scratchpad when Goal 23 integration is done

---

## Acceptance Criteria

- [x] `infra/prompts.py` exists with `get_prompt()` function
- [x] `get_prompt()` returns fallback when Langfuse is not configured
- [x] `get_prompt()` returns fallback when Langfuse is unreachable (with warning log)
- [x] `get_prompt()` returns Langfuse prompt when available
- [x] Variable substitution works (`{{stadt}}` → "München")
- [x] Caching works (no Langfuse API call on every graph invocation)
- [ ] Vertriebsagent graph uses `get_prompt()` for all 8 prompts (blocked by Goal 23)
- [x] React agent uses `get_prompt()` for default system prompt
- [x] All existing tests still pass (932 passed, 35 skipped — no behavioural change)
- [x] New tests cover `get_prompt()` with mocked Langfuse (65 tests, 98% coverage)
- [x] **Bonus:** Chat prompt support (not just text) — `prompt_type="chat"` returns `list[dict]`
- [x] **Bonus:** Runtime override via `config.configurable.prompt_overrides` (name/label/version)
- [x] **Bonus:** Auto-seeding — `seed_default_prompts()` creates missing prompts in Langfuse on startup
- [x] **Bonus:** Registration pattern — `register_default_prompt()` for graph-level defaults

---

## Constraints

- **No Langfuse dependency at runtime** — if Langfuse keys are not set, the feature is completely dormant
- **Fallbacks are mandatory** — every `get_prompt()` call must have a hardcoded fallback
- **No breaking changes** — graphs must work identically when Langfuse is not configured
- **infra/ only** — the prompt fetching logic lives in `infra/prompts.py`, not in individual graphs
- **Dependency rules** — `infra/prompts.py` must not import from `server/` or `graphs/`

---

## Risk Assessment

- **Low risk:** This is additive — all existing behaviour is preserved via fallbacks
- **Low risk:** Langfuse SDK is already a dependency (used for tracing)
- **Low risk:** The prompt management API is stable and well-documented
- **Medium risk:** Cache invalidation — if someone updates a prompt in Langfuse, it takes up to `cache_ttl_seconds` to propagate. This is acceptable and documented.

---

## Open Questions — RESOLVED

1. **Should `get_prompt()` support chat-type prompts (list of messages) or just text?**
   - **Decision: Both from day one.** `prompt_type="chat"` returns `list[dict]`, `"text"` returns `str`. Overloaded signatures provide type safety.

2. **Should we auto-create prompts in Langfuse if they don't exist?**
   - **Decision: Yes — via `seed_default_prompts()` at startup.** Each graph registers defaults via `register_default_prompt()`. On startup, the server seeds any that don't exist with the `production` label. Existing prompts are never touched. Idempotent and safe.

3. **What happens if a Langfuse prompt has different variables than expected?**
   - **Decision:** `compile()` raises on missing variables. The outer try/except catches it, falls back to hardcoded prompt with `_substitute_variables_text/chat()`, and logs a warning.

4. **Should the cache TTL be per-prompt or global?**
   - **Decision:** Global default via `LANGFUSE_PROMPT_CACHE_TTL` env var (default: 300s), with per-call override via `cache_ttl_seconds` parameter.

5. **Should frontend be able to select prompt variant/version at runtime?**
   - **Decision: Yes — via `config.configurable.prompt_overrides`.** Supports `name` (swap entire prompt), `label` (A/B testing), and `version` (pin exact version). Flows through standard LangGraph RunnableConfig — no protocol changes needed.