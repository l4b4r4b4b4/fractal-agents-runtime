# Goal 24: Langfuse Prompt Template Integration

> **Status:** ⚪ Not Started
> **Priority:** Medium
> **Created:** 2026-02-13
> **Depends on:** Goal 23 (Vertriebsagent Graph) — benefits from but doesn't block
> **Blocks:** Nothing (additive feature)
> **Branch:** TBD (off `development`)

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

### New Module: `infra/prompts.py`

```python
"""Langfuse prompt management integration.

Provides a thin wrapper around Langfuse's prompt fetching with:
- Automatic fallback to hardcoded defaults
- Caching with configurable TTL
- No-op behaviour when Langfuse is not configured
"""

from langfuse import Langfuse

_langfuse_client: Langfuse | None = None

def get_langfuse_client() -> Langfuse | None:
    """Return the shared Langfuse client, or None if not configured."""
    ...

def get_prompt(
    name: str,
    *,
    fallback: str,
    label: str = "production",
    cache_ttl_seconds: int = 300,
    variables: dict[str, str] | None = None,
) -> str:
    """Fetch a prompt from Langfuse, falling back to the hardcoded default.

    Args:
        name: Langfuse prompt name (e.g. "vertriebsagent-analyzer-phase1")
        fallback: Hardcoded default prompt string (used if Langfuse unavailable)
        label: Langfuse prompt label (default: "production")
        cache_ttl_seconds: Cache TTL in seconds (default: 300 = 5 min)
        variables: Optional template variables for compilation

    Returns:
        The compiled prompt string.
    """
    ...
```

### Usage in Graphs

```python
from infra.prompts import get_prompt
from graphs.vertriebsagent.prompts.main_prompts import ANALYZER_PHASE1_PROMPT

# In the analyzer node:
prompt_text = get_prompt(
    "vertriebsagent-analyzer-phase1",
    fallback=ANALYZER_PHASE1_PROMPT,
    variables={"stadt": state["stadt"]},
)
messages = [{"role": "system", "content": prompt_text}]
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
- `LANGFUSE_PROMPT_CACHE_TTL` — override default cache TTL (default: 300s)

---

## Task Breakdown

### Task-01: Create `infra/prompts.py`

- Implement `get_prompt()` with Langfuse fetch + fallback logic
- Handle Langfuse not configured (return fallback immediately)
- Handle Langfuse errors (log warning, return fallback)
- Caching via Langfuse SDK's built-in cache
- Export from `infra/__init__.py`
- Unit tests with mocked Langfuse client

### Task-02: Integrate with Vertriebsagent Graph

- Update all 8 prompt usages in the vertriebsagent graph to use `get_prompt()`
- Keep hardcoded prompts in `prompts/` as fallback defaults
- Add Langfuse prompt names following the naming convention
- Verify graph still works identically when Langfuse is not configured

### Task-03: Integrate with React Agent

- Add optional Langfuse prompt fetch for the default system prompt
- Maintain existing `configurable.system_prompt` override behaviour
- Priority: assistant config > Langfuse prompt > hardcoded default

### Task-04: Documentation + Seed Prompts

- Document prompt naming convention in graph READMEs
- Create a script or instructions to seed initial prompts in Langfuse
- Update Helm chart `values-testing.yaml` with Langfuse prompt cache TTL if needed
- Add `LANGFUSE_PROMPT_CACHE_TTL` to `.env.example`

---

## Acceptance Criteria

- [ ] `infra/prompts.py` exists with `get_prompt()` function
- [ ] `get_prompt()` returns fallback when Langfuse is not configured
- [ ] `get_prompt()` returns fallback when Langfuse is unreachable (with warning log)
- [ ] `get_prompt()` returns Langfuse prompt when available
- [ ] Variable substitution works (`{{stadt}}` → "München")
- [ ] Caching works (no Langfuse API call on every graph invocation)
- [ ] Vertriebsagent graph uses `get_prompt()` for all 8 prompts
- [ ] React agent uses `get_prompt()` for default system prompt
- [ ] All existing tests still pass (no behavioural change when Langfuse is absent)
- [ ] New tests cover `get_prompt()` with mocked Langfuse

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

## Open Questions

1. **Should `get_prompt()` support chat-type prompts (list of messages) or just text?**
   - **Tentative decision:** Start with text only. Chat-type prompts can be added later if needed.

2. **Should we auto-create prompts in Langfuse if they don't exist?**
   - **Decision:** No. Prompts are created manually in the Langfuse UI or via a seed script. Auto-creation could cause naming conflicts.

3. **What happens if a Langfuse prompt has different variables than expected?**
   - **Decision:** `compile()` raises on missing variables. Wrap in try/except, fall back to hardcoded prompt, log warning.

4. **Should the cache TTL be per-prompt or global?**
   - **Decision:** Global default via env var, with per-call override via `cache_ttl_seconds` parameter. Per-prompt config is over-engineering for now.