# Task-01: Define Namespace Convention & Update Token Cache

> **Status:** 🟢 Complete
> **Parent Goal:** Goal 16 — User × Agent Store Namespacing (Org-Scoped)
> **Branch:** `feature/store-namespace-convention`
> **PR:** [#13](https://github.com/l4b4r4b4b4/oap-langgraph-tools-agent/pull/13)

---

## Objective

Define the canonical `(org_id, user_id, assistant_id, category)` namespace convention and update the token cache (`token.py`) as the first consumer. This establishes the pattern all subsequent tasks will follow.

---

## Research Findings

### Supabase Data Model (Verified via MCP)

- **`organizations`** — `id` (UUID), `name`, `slug`, RLS enabled, 2 rows
- **`organization_members`** — PK `(organization_id, user_id)`, role ∈ {owner, admin, member}
- **`agents`** — `id` (UUID), `organization_id` (FK → organizations), `langgraph_assistant_id` (text, set on sync)
- **`chat_sessions`** — `organization_id`, `agent_id`, `thread_id` (LangGraph thread ref)
- Agents are always org-scoped: `agents.organization_id` is NOT NULL

### How Config Flows at Runtime

1. **Agent sync** (`agent_sync.py:_build_assistant_configurable()`) builds `config.configurable` with:
   - `model_name`, `system_prompt`, `temperature`, `max_tokens`, `mcp_config`
   - ❌ Does NOT include `supabase_organization_id` (only in metadata, not configurable)

2. **Run config** (`robyn_server/agent.py:_build_mcp_runnable_config()` / `routes/streams.py:_build_runnable_config()`) layers:
   - Layer 1: assistant configurable (from sync)
   - Layer 2: runtime overrides — `thread_id`, `assistant_id`, `owner`, `user_id`, `run_id`

3. **`graph()` in `tools_agent/agent.py`** receives merged config via `_merge_assistant_configurable_into_run_config()`

4. **`token.py`** accesses:
   - `config.configurable.owner` → user_id ✅
   - `config.configurable.assistant_id` → assistant UUID ✅
   - `config.configurable.supabase_organization_id` → ❌ NOT PRESENT (needs fix)

### Key Gap

`supabase_organization_id` is stored in assistant **metadata** during sync but NOT in **configurable**. Since `graph()` reads from configurable, we must add it there.

---

## Implementation Plan

### File 1: `tools_agent/utils/store_namespace.py` (NEW)

Namespace helper module — single source of truth for namespace construction.

```python
# Constants
CATEGORY_TOKENS = "tokens"
CATEGORY_CONTEXT = "context"
CATEGORY_MEMORIES = "memories"
CATEGORY_PREFERENCES = "preferences"

def build_namespace(org_id, user_id, assistant_id, category) -> tuple[str, ...]
def extract_namespace_components(config) -> NamespaceComponents | None
```

- `build_namespace()` — constructs `(org_id, user_id, assistant_id, category)` tuple
- `extract_namespace_components()` — extracts org_id/user_id/assistant_id from RunnableConfig
  - `org_id` ← `configurable.supabase_organization_id`
  - `user_id` ← `configurable.owner`
  - `assistant_id` ← `configurable.assistant_id`
- Returns a NamedTuple or None if any component is missing (defensive)

### File 2: `robyn_server/agent_sync.py` (EDIT)

In `_build_assistant_configurable()`, add org_id to configurable:

```python
if agent.organization_id:
    configurable["supabase_organization_id"] = str(agent.organization_id)
```

This ensures org_id is available at `config.configurable.supabase_organization_id` during graph execution.

### File 3: `tools_agent/utils/token.py` (EDIT)

Update `get_tokens()` and `set_tokens()` to use org-scoped namespace:

**Before:**
```python
await store.aget((user_id, "tokens"), "data")
```

**After:**
```python
from tools_agent.utils.store_namespace import build_namespace, extract_namespace_components, CATEGORY_TOKENS

components = extract_namespace_components(config)
if components is None:
    return None
namespace = build_namespace(components.org_id, components.user_id, components.assistant_id, CATEGORY_TOKENS)
await store.aget(namespace, "data")
```

Same pattern for `set_tokens()` and the `adelete()` calls.

### File 4: `robyn_server/tests/test_mcp.py` (EDIT — if needed)

Update `_build_mcp_runnable_config` test assertions if they check configurable keys.

---

## Files Summary

| File | Action | What Changes |
|------|--------|-------------|
| `tools_agent/utils/store_namespace.py` | CREATE | Namespace helper: `build_namespace()`, `extract_namespace_components()`, category constants |
| `robyn_server/agent_sync.py` | EDIT | Add `supabase_organization_id` to `_build_assistant_configurable()` output |
| `tools_agent/utils/token.py` | EDIT | Replace `(user_id, "tokens")` with `(org_id, user_id, assistant_id, "tokens")` |
| `robyn_server/tests/test_mcp.py` | EDIT | Update test assertions for new configurable key |

---

## Design Decisions

### Why add org_id to configurable (not just metadata)?

- **Metadata** is stored on the assistant record but NOT automatically injected into `config.configurable` at runtime
- **Configurable** IS injected — it's the only dict that reaches `graph()` through the merge chain
- Adding to configurable follows the existing pattern (`model_name`, `mcp_config`, etc.)

### Why a separate `store_namespace.py` module?

- Single source of truth for namespace construction
- Avoids duplicating namespace logic in token.py, future memory.py, etc.
- Easy to test in isolation
- Documents the convention via module docstring + constants

### Why NamedTuple for components?

- Descriptive field access (`components.org_id`) vs positional (`components[0]`)
- Immutable — no accidental mutation
- Lightweight, no Pydantic overhead for internal utility

---

## Success Criteria

- [x] `store_namespace.py` defines canonical `(org_id, user_id, assistant_id, category)` convention
- [x] `_build_assistant_configurable()` includes `supabase_organization_id` in configurable
- [x] `get_tokens()` uses `(org_id, user_id, assistant_id, "tokens")` namespace
- [x] `set_tokens()` uses `(org_id, user_id, assistant_id, "tokens")` namespace
- [x] `adelete()` calls in token.py use the same scoped namespace
- [x] All 550 tests pass (or same pass rate as before)
- [x] `ruff check` + `ruff format` clean
- [x] Graceful degradation: missing org_id/assistant_id → returns None (no crash)

---

## Session Log

### Session 75 — Task-01 Research, Planning & Implementation

**Research completed:**
- Verified Supabase schema via MCP: `organizations`, `organization_members`, `agents` all confirmed
- Traced config flow: agent_sync → run config builder → graph() → token.py
- Identified gap: `supabase_organization_id` in metadata but not configurable
- Confirmed `assistant_id` and `owner` are already in configurable at runtime

**Implementation completed:**
- Created `tools_agent/utils/store_namespace.py` (179 lines):
  - `build_namespace()` — constructs canonical 4-tuple with validation
  - `extract_namespace_components()` — pulls components from RunnableConfig
  - `NamespaceComponents` NamedTuple for type-safe access
  - Category constants + special pseudo-IDs (`SHARED_USER_ID`, `GLOBAL_AGENT_ID`)
- Edited `robyn_server/agent_sync.py` (+4 lines):
  - Added `supabase_organization_id` to `_build_assistant_configurable()` output
  - Bridges the gap: org_id now flows from sync → configurable → graph()
- Edited `tools_agent/utils/token.py`:
  - Replaced `(user_id, "tokens")` → `(org_id, user_id, assistant_id, "tokens")` in all 5 store operations
  - New `_build_token_namespace()` internal helper
  - Removed `thread_id` dependency (namespace components are sufficient)
  - Improved logging with `logger.debug()` on failures
- **550/550 tests pass**, `ruff check` + `ruff format` clean
- PR #13 created and pushed