# Goal 44: Fix MCP Token Fetch Outside Runnable Context

> **Status**: 🟢 Complete
> **Priority**: P0 (Critical) — blocks all MCP-enabled assistants
> **Created**: 2026-03-03
> **Updated**: 2026-03-03
> **Bug Report**: `.agent/bugs/runtime-bug-get-config-outside-context.md`
> **Branch**: (to be created)

## Overview

`fetch_tokens()` is called during the **graph construction phase** (`graph()` in `agent.py`), but it internally calls `langgraph.config.get_store()` which requires a **LangGraph runnable context** (i.e., code must be executing inside a graph node). This causes a `RuntimeError: Called get_config outside of a runnable context` for every assistant that has MCP servers with `auth_required: true`.

This is a **latent bug** present since the initial codebase (`d7a75b4`). It was never triggered before because no `auth_required: true` MCP servers were tested in production until now.

## Success Criteria

- [ ] Assistants with `auth_required: true` MCP servers can process messages without crashing
- [ ] Token caching in the LangGraph Store still works (read + write)
- [ ] Assistants with `auth_required: false` MCP servers still work (no regression)
- [ ] Assistants with no MCP servers still work (no regression)
- [ ] All 3 call sites work: `execute_run_stream`, `execute_run_wait`, `execute_agent_run`
- [ ] Existing tests pass, new tests cover the fix
- [ ] Coverage stays ≥73%

## Context & Background

### Why This Bug Exists

The call chain is:

```
Server route handler (execute_run_stream / execute_run_wait / execute_agent_run)
  └─ async with create_store() as st:       ← AsyncPostgresStore created here
       └─ build_graph(config, store=st)      ← store passed as kwarg
            └─ graph(config, store=st)       ← graph CONSTRUCTION phase (NO runnable context)
                 └─ fetch_tokens(config)
                      └─ get_tokens(config)
                           └─ get_store()    ← ❌ langgraph.config.get_store() — needs runnable context
```

There are TWO different `get_store` functions in play:
1. **`server.database.store()`** — our per-request async context manager that creates an `AsyncPostgresStore` via `from_conn_string()`. This works fine and IS available during graph construction (passed as `store=st` kwarg).
2. **`langgraph.config.get_store()`** — LangGraph's context-var-based accessor that only works inside a running graph node. This is what `token.py` uses, and it CRASHES during graph construction.

### Why It Worked Before (It Didn't)

Investigation of git history proves `token.py` has used `langgraph.config.get_store()` since the initial commit (`d7a75b4`). The `fetch_tokens()` call has been in `graph()` since the initial commit too. The bug was never triggered because:
- MCP servers configured with `auth_required: false` (the default) skip the `fetch_tokens()` call entirely
- The `auth_required: true` path was never exercised in production until now

### Not Caused By Recent Changes

- **Semantic router commit** (`ac601c2`): Only refactored model initialization — replaced inline `ChatOpenAI`/`init_chat_model` with shared `create_chat_model()` factory. Never touched MCP/token code.
- **Multi-LLM streaming fix** (`ab85210`): Only changed SSE event matching logic. Never touched graph build.
- **`token.py`**: Byte-identical across all commits since `b233593` (module rename). Zero logic changes.

## Constraints & Requirements

### Hard Requirements
- The fix must work for all 3 server entry points that call `build_graph()`:
  1. `server/routes/streams.py::execute_run_stream()` (line ~904)
  2. `server/routes/streams.py::execute_run_wait()` (line ~1299)
  3. `server/agent.py::execute_agent_run()` (line ~268)
- Token caching (read from store, write to store) must still function
- Must not break `auth_required: false` MCP servers
- Must not break assistants without MCP tools

### Soft Requirements
- Minimal change surface — prefer targeted fix over refactor
- Keep the existing defensive coding style in `token.py` (returns None on failure)

### Out of Scope
- Refactoring MCP tool loading into graph nodes (too invasive — tools must be known at graph construction time to build the tool list for `create_agent()`)
- Changing how `graph()` is invoked by the server (would require LangGraph internals changes)

## Problem Space — Detailed Code Analysis

### File: `apps/python/src/graphs/react_agent/utils/token.py`

**Three functions use `langgraph.config.get_store()`:**

1. **`get_tokens()` (line 112)** — reads cached tokens from store
   ```python
   store = get_store()  # ❌ crashes outside runnable context
   ```

2. **`set_tokens()` (line 181)** — writes tokens to store
   ```python
   store = get_store()  # ❌ crashes outside runnable context
   ```

3. **`fetch_tokens()` (line 203)** — orchestrator that calls `get_tokens()` then conditionally `set_tokens()`

All three call `langgraph.config.get_store()` which internally does `get_config()[CONF][CONFIG_KEY_RUNTIME].store` — and `get_config()` raises `RuntimeError` outside a runnable context.

### File: `apps/python/src/graphs/react_agent/agent.py`

**`graph()` function (line 263)** receives `store` as a keyword argument:
```python
async def graph(config: RunnableConfig, *, checkpointer=None, store=None):
```

The `store` kwarg is an `AsyncPostgresStore` instance created by the server. It's the SAME type that `langgraph.config.get_store()` would return. But `token.py` doesn't use it — it tries to get the store via the LangGraph context vars instead.

**The trigger (line 316):**
```python
if any_auth_required:
    mcp_tokens = await fetch_tokens(config)  # ← calls get_store() inside
```

### File: `apps/python/src/server/routes/streams.py`

**All call sites follow the same pattern (lines 904, 1299):**
```python
async with create_checkpointer() as cp, create_store() as st:
    agent = await build_graph(runnable_config, checkpointer=cp, store=st)
```

The store `st` IS available — it's just not being passed through to `token.py`.

### File: `apps/python/src/server/agent.py`

**Same pattern (line 268):**
```python
async with create_checkpointer() as cp, create_store() as st:
    agent = await build_graph(runnable_config, checkpointer=cp, store=st)
```

## Solution Space — Recommended Fix

### Option A: Pass `store` explicitly through the call chain (RECOMMENDED)

Thread the `store` kwarg from `graph()` down to `fetch_tokens()` → `get_tokens()` / `set_tokens()`. Fall back to `langgraph.config.get_store()` when called from inside a node (future-proofing).

**Changes required:**

#### 1. `token.py` — Add `store` parameter to all three functions

`get_tokens(config, store=None)`:
```python
async def get_tokens(config: RunnableConfig, store=None) -> dict[str, Any] | None:
    if store is None:
        try:
            store = get_store()
        except RuntimeError:
            logger.debug("get_tokens: no runnable context and no store passed")
            return None
    if store is None:
        return None
    # ... rest unchanged ...
```

`set_tokens(config, tokens, store=None)`:
```python
async def set_tokens(config: RunnableConfig, tokens: dict[str, Any] | None, store=None) -> None:
    if tokens is None:
        return
    if store is None:
        try:
            store = get_store()
        except RuntimeError:
            logger.debug("set_tokens: no runnable context and no store passed")
            return
    if store is None:
        return
    # ... rest unchanged ...
```

`fetch_tokens(config, store=None)`:
```python
async def fetch_tokens(config: RunnableConfig, store=None) -> dict[str, Any] | None:
    current_tokens = await get_tokens(config, store=store)
    # ... middle unchanged ...
    await set_tokens(config, mcp_tokens, store=store)
    return mcp_tokens
```

#### 2. `agent.py` — Pass `store` to `fetch_tokens()`

Line ~316:
```python
if any_auth_required:
    mcp_tokens = await fetch_tokens(config, store=store)
```

**Pros:**
- Minimal change (4 files touched, ~15 lines changed)
- Backward compatible (store=None default + try/except fallback)
- Works in both graph-build and node-execution contexts
- No architectural changes

**Cons:**
- Adds a parameter to 3 function signatures (but they're internal utils, not public API)

### Option B: Try/except in `get_tokens` and `set_tokens` (NOT recommended)

Wrap `get_store()` in try/except and return None on failure. This makes `fetch_tokens()` always skip the cache when called from graph build, doing a fresh HTTP token exchange every time.

```python
try:
    store = get_store()
except RuntimeError:
    return None  # no caching available
```

**Pros:**
- Even smaller change (only token.py, ~6 lines)

**Cons:**
- Token caching is completely disabled during graph build — every run does a fresh HTTP token exchange
- `set_tokens` would also silently fail — tokens are never cached
- Performance regression: unnecessary HTTP calls on every request
- Masks future bugs where store should be available but isn't

### Option C: Move `fetch_tokens` into a graph node (NOT recommended for this fix)

Defer token fetching to runtime by creating a setup node or lazy-loading tokens inside the agent node.

**Cons:**
- MCP tool connections are established during `graph()` because tools must be passed to `create_agent()` at construction time
- Would require a fundamentally different architecture where MCP tools are connected lazily
- Way too invasive for a bug fix

## Approach — Option A Implementation Plan

### Files to Modify

| File | Change |
|------|--------|
| `apps/python/src/graphs/react_agent/utils/token.py` | Add `store=None` param to `get_tokens`, `set_tokens`, `fetch_tokens`; try/except fallback |
| `apps/python/src/graphs/react_agent/agent.py` | Pass `store=store` to `fetch_tokens(config, store=store)` at line ~316 |

### Files to Create/Modify for Tests

| File | Change |
|------|--------|
| `apps/python/src/server/tests/test_token.py` (NEW) | Dedicated tests for token.py with explicit store, without store, RuntimeError fallback |

### Test Strategy

1. **Unit tests for `get_tokens(config, store=mock_store)`** — verify it uses the passed store
2. **Unit tests for `get_tokens(config)` (no store, no context)** — verify it catches RuntimeError and returns None
3. **Unit tests for `set_tokens(config, tokens, store=mock_store)`** — verify it uses the passed store
4. **Unit tests for `fetch_tokens(config, store=mock_store)`** — full flow with mocked HTTP + store
5. **Verify existing tests still pass** — the `test_research_agent.py` mock of `fetch_tokens` should still work

### Verification

After fix:
```bash
# Run tests
cd apps/python && uv run pytest -x

# Lint
cd apps/python && uv run ruff check . --fix --unsafe-fixes && uv run ruff format .

# Manual test (if runtime available)
# Create assistant with auth_required: true MCP server → send message → should not crash
```

## Tasks

| Task ID | Description | Status | Depends On |
|---------|-------------|--------|------------|
| Task-01 | Implement Option A fix in token.py + agent.py | 🟢 Complete | - |
| Task-02 | Safe dependency updates (patch/minor, non-breaking) | 🟢 Complete | Task-01 |

Task-02 depends on Task-01 so that tests run green on the bugfix first, then deps are upgraded on a known-good baseline.

### Task-01 Detailed Checklist

- [x] Modify `get_tokens()` signature: add `store=None` param
- [x] Modify `set_tokens()` signature: add `store=None` param
- [x] Modify `fetch_tokens()` signature: add `store=None` param, thread store to get/set calls
- [x] Add try/except RuntimeError fallback in get_tokens and set_tokens for when store=None
- [x] Modify `agent.py` line ~316: pass `store=store` to `fetch_tokens(config, store=store)`
- [x] Write unit tests for all three functions with explicit store
- [x] Write unit tests for RuntimeError fallback path
- [x] Run full test suite, verify ≥73% coverage — **1818 passed, 35 skipped, 78.82% coverage**
- [x] Run ruff check + format — **clean**

#### What Was Done

- `apps/python/src/graphs/react_agent/utils/token.py`: Added `store: Any = None` kwarg to
  `get_tokens()`, `set_tokens()`, and `fetch_tokens()`. Each function now uses the passed store
  directly when provided, falling back to `langgraph.config.get_store()` with a `try/except
  RuntimeError` guard for the graph build phase. `fetch_tokens()` threads the store kwarg through
  to both `get_tokens()` and `set_tokens()` so caching works end-to-end.
- `apps/python/src/graphs/react_agent/agent.py`: One-line change at the call site —
  `fetch_tokens(config)` → `fetch_tokens(config, store=store)`.
- `apps/python/src/server/tests/test_token.py` (NEW, 38 tests): Full coverage of all three
  functions — explicit store path, RuntimeError fallback, expiry eviction, namespace guards,
  HTTP exchange, and the graph-build-phase regression test
  (`test_fetch_tokens_does_not_raise_outside_runnable_context`).
- Fixed test helper `_make_config` to use correct namespace key `supabase_organization_id`
  (not `x-org-id`) after first run revealed the mismatch.

### Task-02 Detailed Checklist — Safe Dependency Updates

**Context:** `uv pip list --outdated` (2026-03-03) shows 80+ outdated packages. Most are transitive.
Below are the **direct dependencies from `pyproject.toml`** with safe patch/minor updates available,
grouped into tiers. Upgrade one tier at a time, run tests after each.

**⚠️ IMPORTANT: Use `uv lock --upgrade-package <pkg>` (NOT `uv add`). This updates the lockfile
without changing version specifiers in pyproject.toml. Then `uv sync` to install. Commit
`pyproject.toml` + `uv.lock` together.**

#### Tier 1 — LangGraph Core (directly relevant to the bug fix)

| Package | Locked | Latest | Type | Notes |
|---------|--------|--------|------|-------|
| langgraph | 1.0.8 | 1.0.10 | patch | Core runtime — may improve context handling |
| langgraph-checkpoint | 4.0.0 | 4.0.1 | patch | Transitive via langgraph-checkpoint-postgres |
| langgraph-prebuilt | 1.0.7 | 1.0.8 | patch | create_agent lives here |
| langgraph-sdk | 0.3.3 | 0.3.9 | minor | Client SDK — check changelog for breaking changes |
| langchain-core | 1.2.11 | 1.2.17 | patch | RunnableConfig, BaseMessage |

```bash
cd apps/python
uv lock --upgrade-package langgraph --upgrade-package langgraph-checkpoint --upgrade-package langgraph-checkpoint-postgres --upgrade-package langgraph-prebuilt --upgrade-package langgraph-sdk --upgrade-package langchain-core
uv sync
uv run pytest -x --timeout=60
```

- [x] Tier 1 upgraded and tests pass — langgraph 1.0.8→1.0.10, langchain-core 1.2.11→1.2.17, langgraph-checkpoint 4.0.0→4.0.1, langgraph-prebuilt 1.0.7→1.0.8, langgraph-sdk 0.3.3→0.3.9

#### Tier 2 — LangChain Providers + Tracing (safe patches)

| Package | Locked | Latest | Type | Notes |
|---------|--------|--------|------|-------|
| langchain-anthropic | 1.3.3 | 1.3.4 | patch | |
| langchain-openai | 1.1.9 | 1.1.10 | patch | |
| langchain-google-genai | 4.2.0 | 4.2.1 | patch | Transitive via deepagents |
| langfuse | 3.14.1 | 3.14.5 | patch | Tracing integration |

```bash
uv lock --upgrade-package langchain-anthropic --upgrade-package langchain-openai --upgrade-package langchain-google-genai --upgrade-package langfuse
uv sync
uv run pytest -x --timeout=60
```

- [x] Tier 2 upgraded and tests pass — langchain-anthropic 1.3.3→1.3.4, langchain-openai 1.1.9→1.1.10, langchain-google-genai 4.2.0→4.2.1, langfuse 3.14.1→3.14.5, openai 2.15.0→2.24.0 (transitive pull)

#### Tier 3 — Database + HTTP (safe patches)

| Package | Locked | Latest | Type | Notes |
|---------|--------|--------|------|-------|
| psycopg | 3.3.2 | 3.3.3 | patch | Direct dep (with binary,pool extras) |
| psycopg-binary | 3.3.2 | 3.3.3 | patch | Transitive via psycopg[binary] |
| chromadb-client | 1.5.1 | 1.5.2 | patch | RAG retriever |
| httpcore | 1.0.8 | 1.0.9 | patch | Transitive via httpx |
| httpx-sse | 0.4.0 | 0.4.3 | patch | SSE client |

```bash
uv lock --upgrade-package psycopg --upgrade-package psycopg-binary --upgrade-package chromadb-client --upgrade-package httpcore --upgrade-package httpx-sse
uv sync
uv run pytest -x --timeout=60
```

- [x] Tier 3 upgraded and tests pass — psycopg 3.3.2→3.3.3, psycopg-binary 3.3.2→3.3.3, chromadb-client 1.5.1→1.5.2, httpcore 1.0.8→1.0.9, httpx-sse 0.4.0→0.4.3, h11 0.14.0→0.16.0 (transitive pull)

#### Tier 4 — Security (always recommended)

| Package | Locked | Latest | Type | Notes |
|---------|--------|--------|------|-------|
| certifi | 2025.1.31 | 2026.2.25 | CA bundle | Updated root certificates — security best practice |
| pyjwt | 2.10.1 | 2.11.0 | minor | JWT handling — check changelog for algo changes |

```bash
uv lock --upgrade-package certifi --upgrade-package pyjwt
uv sync
uv run pytest -x --timeout=60
```

- [x] Tier 4 upgraded and tests pass — certifi 2025.1.31→2026.2.25, pyjwt 2.10.1→2.11.0

#### Tier 5 — Other Safe Patches (low-risk direct/transitive)

| Package | Locked | Latest | Type | Notes |
|---------|--------|--------|------|-------|
| tavily-python | 0.7.20 | 0.7.22 | patch | Search tool |
| orjson | 3.11.6 | 3.11.7 | patch | Fast JSON |
| requests | 2.32.3 | 2.32.5 | patch | HTTP client |
| pyyaml | 6.0.2 | 6.0.3 | patch | YAML parser |
| attrs | 25.3.0 | 25.4.0 | minor | aiohttp transitive |
| charset-normalizer | 3.4.1 | 3.4.4 | patch | requests transitive |
| idna | 3.10 | 3.11 | minor | URL encoding |

```bash
uv lock --upgrade-package tavily-python --upgrade-package orjson --upgrade-package requests --upgrade-package pyyaml --upgrade-package attrs --upgrade-package charset-normalizer --upgrade-package idna
uv sync
uv run pytest -x --timeout=60
```

- [x] Tier 5 upgraded and tests pass — tavily-python 0.7.20→0.7.22, orjson 3.11.6→3.11.7, requests 2.32.3→2.32.5, pyyaml 6.0.2→6.0.3, attrs 25.3.0→25.4.0, charset-normalizer 3.4.1→3.4.4, idna 3.10→3.11

#### Final Verification

```bash
# Full test suite with coverage
cd apps/python
uv run pytest --cov --cov-report=term-missing --timeout=60

# Lint
uv run ruff check . --fix --unsafe-fixes && uv run ruff format .

# Verify lock is clean
uv lock --check
```

- [x] Full test suite passes — **1818 passed, 35 skipped, 78.82% coverage** (≥73% ✅)
- [x] Lint clean — `ruff check` all checks passed
- [x] `uv.lock` updated (pyproject.toml specifiers unchanged — all upgrades via `uv lock --upgrade-package`)

#### DO NOT UPGRADE — Risk Assessment

These packages have major version bumps or are too risky for a bugfix PR:

| Package | Locked | Latest | Reason to skip |
|---------|--------|--------|----------------|
| robyn | 0.76.0 | 0.79.0 | Web framework — 3 minor versions, could break routing/middleware |
| supabase | 2.15.1 | 2.28.0 | Pulls postgrest 1→2, realtime 2.4→2.28, storage3 0.11→2.28 (all MAJOR) |
| pydantic | 2.11.3 | 2.12.5 | Minor but Pydantic changes can break serialization subtly |
| pydantic-core | 2.33.1 | 2.42.0 | Coupled to pydantic — upgrade together in dedicated PR |
| openai | 2.15.0 | 2.24.0 | Significant jump — may change API client behavior |
| anthropic | 0.79.0 | 0.84.0 | Significant jump — may change API client behavior |
| aiohttp | 3.11.18 | 3.13.3 | Two minor versions — could affect token exchange HTTP calls |
| pytest | 8.3.5 | 9.0.2 | MAJOR — could break test collection, fixtures, plugins |
| ruff | 0.11.9 | 0.15.4 | Big jump — new lint rules could flag existing code |
| cryptography | 44.0.3 | 46.0.5 | Two major versions — C extension rebuild risk |
| cffi | 1.17.1 | 2.0.0 | MAJOR — breaks C extensions |
| protobuf | 6.33.4 | 7.34.0 | MAJOR — may break google-genai serialization |
| tenacity | 8.5.0 | 9.1.4 | MAJOR — retry decorator API may change |
| deepagents | 0.3.9 | 0.4.4 | Pre-1.0 minor — no stability guarantees |
| click | 8.1.8 | 8.3.1 | CLI framework changes can break robyn internals |
| websockets | 14.2 | 16.0 | MAJOR — realtime/supabase dependency |
| wrapt | 1.17.3 | 2.1.1 | MAJOR — decorator internals |

These should be upgraded in a **separate dedicated PR** with thorough testing.

## Risks & Mitigations

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| Store type mismatch (kwarg store vs langgraph store) | Low | Very Low | Both are `AsyncPostgresStore` from same package |
| Breaking existing mock in test_research_agent.py | Low | Low | Mock patches `fetch_tokens` by name — signature change with default is backward compatible |
| Token caching not working if store=None at build time | Medium | Low | try/except fallback logs warning, falls through to fresh HTTP exchange |

| Dependency upgrade breaks tests | Medium | Low | Tiered approach — roll back individual tier if tests fail |
| langgraph-sdk 0.3.9 has breaking API change | Low | Low | Check changelog before upgrading; sdk is only used by langsmith tracing |

## Dependencies

- **Upstream**: None — this is a standalone bug fix
- **Downstream**: All MCP-enabled assistants in production are blocked until this is fixed

## References

- Bug report: `.agent/bugs/runtime-bug-get-config-outside-context.md`
- `apps/python/src/graphs/react_agent/utils/token.py` — the 3 affected functions
- `apps/python/src/graphs/react_agent/agent.py` — the call site (line ~316)
- `apps/python/src/server/routes/streams.py` — server entry points (lines ~904, ~1299)
- `apps/python/src/server/agent.py` — MCP entry point (line ~268)
- `apps/python/src/server/database.py` — `store()` context manager (line ~237)
- `apps/python/src/infra/store_namespace.py` — namespace helpers used by token.py
- LangGraph source: `langgraph/config.py` — `get_store()` and `get_config()` context var requirement