# Goal 28: Fix Message History Storage Bug

> **Status**: 🟢 Complete (Python 🟢, TypeScript 🟢)
> **Priority**: Critical
> **Created**: 2025-07-17
> **Updated**: 2025-07-20
> **Discovered**: 2026-02-14 (docproc-platform Goal 43, Sessions 93–94)
> **Runtime version**: Python v0.0.2, TypeScript v0.0.1

## Overview

`execute_run_stream()` and `execute_agent_run()` write only the current run's messages to `threads.values`, discarding the full conversation history that the LangGraph checkpointer correctly accumulates. This breaks `useStream` from `@langchain/langgraph-sdk` — when it resumes a thread, it loads only the last human/AI message pair instead of the full history.

A secondary bug compounds the issue: `add_state_snapshot()` expects `state["values"]` but receives `{"messages": [...]}` (no `"values"` key), so `thread_states.values` is always written as `{}`.

## Success Criteria

- [ ] `GET /threads/{thread_id}/state` returns the **full** accumulated message history across all runs
- [ ] `useStream` from `@langchain/langgraph-sdk` correctly displays full conversation history when resuming a thread
- [ ] Multi-turn conversations preserve all prior messages in the returned state
- [ ] Both streaming (`execute_run_stream`) and non-streaming (`execute_agent_run`) paths are fixed
- [ ] No regression in SSE streaming behavior (deltas, metadata, final values events)
- [ ] Existing tests pass; new tests cover multi-turn state persistence
- [ ] Thread history endpoint (`GET /threads/{id}/history`) returns correct snapshots (not empty `{}`)
- [ ] `thread_states.values` contains meaningful snapshot data (not `{}`)

## Context & Background

### The Two State Systems

The runtime has **two independent state tracking systems** that are out of sync:

1. **LangGraph Checkpointer** (`AsyncPostgresSaver`) — writes to `checkpoints` / `checkpoint_blobs` / `checkpoint_writes` tables. Uses `add_messages` append reducer to **accumulate** full message history across runs. The LLM sees the full history and conversations work correctly from the model's perspective.

2. **Custom PostgresStorage** (`PostgresThreadStore`) — writes to `langgraph_server.threads` and `langgraph_server.thread_states` tables. Manually overwritten each run with only the current turn's messages. This is what `GET /threads/{id}/state` reads from.

### The Bug Flow

```
Run 1: User says "Hi" → AI says "Hello!"
  → threads.values = {"messages": [human("Hi"), ai("Hello!")]}        ← 2 messages ✓

Run 2: User says "What's 2+2?" → AI says "4"
  → Checkpointer state: [human("Hi"), ai("Hello!"), human("2+2?"), ai("4")]  ← 4 messages ✓
  → threads.values = {"messages": [human("2+2?"), ai("4")]}                  ← 2 messages ✗
  → GET /threads/{id}/state returns only 2 messages                           ← BUG

Run 3: User says "And 3+3?" → AI says "6" (LLM sees full history, knows context)
  → threads.values = {"messages": [human("3+3?"), ai("6")]}                  ← 2 messages ✗
  → useStream loads thread, shows only last exchange                          ← BROKEN UX
```

### Why It Matters

`useStream` from `@langchain/langgraph-sdk` calls `GET /threads/{thread_id}/state` to hydrate the conversation when resuming a thread. It expects the full message history ("All messages in the current thread, including both human and AI messages" — [LangChain docs](https://docs.langchain.com/oss/javascript/langchain/streaming/frontend)). Getting only 2 messages means the UI shows a blank conversation with just the last exchange.

- **During an active session** (no page reload): messages display correctly because `useStream` manages state client-side during streaming
- **On page reload or navigation back**: `useStream` calls `GET /threads/{id}/state` and receives only the last 2 messages — full conversation history is lost from the UI perspective

## Two Bugs

### Bug 1 (Primary): `all_messages` only contains current run

`execute_run_stream()` builds `all_messages` from only the current run's input, appends the AI response, and overwrites `threads.values` with this 2-message pair. The checkpointer has the full history but is never read from.

### Bug 2 (Secondary): `add_state_snapshot()` writes empty values

The call chain:
1. `final_values = {"messages": all_messages}` — shape: `{"messages": [...]}`
2. `await storage.threads.add_state_snapshot(thread_id, final_values, owner_id)`
3. Inside `add_state_snapshot()`: `snapshot_values = state.get("values", {})`
4. Since `final_values` has key `"messages"` but NOT key `"values"`, `snapshot_values = {}`
5. `thread_states.values` is written as `{}` — every snapshot is empty

This means `GET /threads/{id}/history` returns snapshots with `values: {}` — completely useless.

## Constraints & Requirements

- **Hard Requirements**:
  - Must not break SSE streaming protocol (messages/tuple events, deltas, final values)
  - Must work with per-request checkpointer pattern (no shared pool)
  - Must maintain owner-based access control (RLS)
  - Fix must cover both `execute_run_stream()` (streaming) and `execute_agent_run()` (non-streaming/MCP)
- **Soft Requirements**:
  - Prefer reading from checkpointer (single source of truth) over manual accumulation
  - Minimize changes to `PostgresThreadStore` API surface
  - Keep `thread_states` snapshots working for history endpoint
- **Out of Scope**:
  - Rewriting the entire storage layer to use only checkpointer
  - TypeScript runtime (separate codebase, separate goal)
  - Performance optimization of checkpoint reads

## Live Testing Evidence

### Test scenario: 4 message exchanges in one thread

1. Send: "Mein Name ist Luke" → AI responds with greeting
2. Send: "Ich arbeite bei AIS Management in München" → AI acknowledges
3. Send: "Wie ist mein Name?" → AI responds: "Dein Name ist Luke" ✅
4. Send: "Fasse zusammen was du über mich weißt" → AI responds: "Dein Name ist Luke, du arbeitest bei AIS Management in München" ✅

Agent **correctly remembers** all context across all 4 runs (checkpointer works).

### Proxy logs confirm same thread, 4 runs

```
POST /threads                                              ← creates thread a8973814...
POST /threads/a8973814.../runs/stream  | message_count=1   ← run 1
POST /threads/a8973814.../runs/stream  | message_count=1   ← run 2 (same thread)
POST /threads/a8973814.../runs/stream  | message_count=1   ← run 3
POST /threads/a8973814.../runs/stream  | message_count=1   ← run 4
```

### Database state after 4 exchanges

```sql
-- threads.values only has 2 messages (the LAST pair)
SELECT id, jsonb_pretty(values) FROM langgraph_server.threads
WHERE id = 'a897381493de4902b9ad26c43f51f94e';

-- Result:
-- {
--   "messages": [
--     { "type": "human",  "content": [{"text": "Fasse zusammen...", "type": "text"}] },
--     { "type": "ai",     "content": "Bis jetzt weiß ich, dass dein Name Luke ist..." }
--   ]
-- }
-- Expected: 8 messages (4 human + 4 AI)
```

```sql
-- 4 thread_states rows exist (one per run) — but values is empty {}!
SELECT count(*) FROM langgraph_server.thread_states
WHERE thread_id = 'a897381493de4902b9ad26c43f51f94e';
-- Result: 4

SELECT values FROM langgraph_server.thread_states
WHERE thread_id = 'a897381493de4902b9ad26c43f51f94e'
ORDER BY created_at DESC LIMIT 1;
-- Result: {}   ← Bug 2: add_state_snapshot writes empty values
```

## How to Reproduce

1. Start the runtime with Postgres persistence (`PERSISTENCE=postgres`)
2. Create a thread: `POST /threads`
3. Send message 1: `POST /threads/{id}/runs/stream` with `{"input": {"messages": [{"type": "human", "content": "My name is Luke"}]}}`
4. Wait for completion
5. Send message 2: `POST /threads/{id}/runs/stream` with `{"input": {"messages": [{"type": "human", "content": "What is my name?"}]}}`
6. Wait for completion — agent correctly responds "Your name is Luke" (checkpointer works)
7. Check state: `GET /threads/{id}/state`
8. **Bug 1**: `values.messages` contains only 2 messages (message 2 + response), not all 4
9. Reload the page — `useStream` shows only the last pair, full history lost

## Investigation Reports

- Full code-level investigation: [`.agent/bug-investigation-message-history-storage.md`](../bug-investigation-message-history-storage.md)
- Full bug report with live evidence: [`.agent/bug-report-thread-values-overwrite.md`](../bug-report-thread-values-overwrite.md)

### Key Findings

| Finding | File | Lines | Detail |
|---------|------|-------|--------|
| `all_messages` seeded from current run only | `server/routes/streams.py` | 598, 643 | `list(initial_values["messages"])` — only current input |
| `final_values` overwrites `threads.values` | `server/routes/streams.py` | 795-798 | `storage.threads.update(thread_id, {"values": final_values}, ...)` |
| `get_state()` reads `threads.values` only | `server/postgres_storage.py` | 606-645 | Never queries checkpointer tables |
| `get_state()` fabricates checkpoint_id | `server/postgres_storage.py` | 638 | `_generate_id()` — not a real checkpoint reference |
| `update()` is a plain overwrite | `server/postgres_storage.py` | 531-592 | No merging/accumulation logic |
| Same bug in non-streaming path | `server/agent.py` | 230-247 | `execute_agent_run()` does identical overwrite |
| `create_agent` uses append reducer | `graphs/react_agent/agent.py` | 488-496 | `add_messages` reducer — checkpointer is correct |
| Checkpointer never read from | `server/database.py` | 183-207 | `checkpointer()` CM used for writes only |
| `add_state_snapshot()` key mismatch | `server/postgres_storage.py` | 661 | `state.get("values", {})` but caller passes `{"messages": [...]}` — no `"values"` key → `{}` |
| `thread_states.values` always empty | database evidence | — | All 4 snapshots have `values: {}` |

## Approach

### Recommended: Option A — Read from checkpointer after run

After `astream_events` / `ainvoke` completes but **before** exiting the `async with create_checkpointer()` block, read the accumulated state back from the agent/checkpointer:

```python
# After streaming completes, inside the async with block:
try:
    checkpoint_state = await agent.aget_state(runnable_config)
    if checkpoint_state and checkpoint_state.values:
        accumulated_messages = checkpoint_state.values.get("messages", [])
        final_values = {
            "messages": [_message_to_dict(m) for m in accumulated_messages]
        }
    else:
        # Fallback to current behavior
        final_values = {"messages": all_messages}
except Exception as state_read_error:
    logger.warning("Failed to read accumulated state from checkpointer: %s", state_read_error)
    final_values = {"messages": all_messages}

yield format_values_event(final_values)
```

Then write `final_values` (now containing the full history) to storage. Also fix `add_state_snapshot()` call to pass the correct shape, or fix the method to not expect a nested `"values"` key.

**Why this is best:**
- Checkpointer is already the source of truth — just read from it
- `add_messages` reducer handles deduplication, ordering, tool messages, etc.
- Minimal code change (add ~5-10 lines, adjust position of existing writes)
- Works for both streaming and non-streaming paths
- Graceful fallback on failure

### Alternatives Considered

| Option | Approach | Pros | Cons |
|--------|----------|------|------|
| **A (recommended)** | Read from checkpointer after run | Single source of truth, minimal change | Must stay inside `async with` block |
| B | Query checkpointer in `get_state()` | No double-write | Complex; needs checkpointer in read path, RLS concerns |
| C | Accumulate manually (read existing + append) | No checkpointer dependency in read | Fragile, duplicates reducer logic, race conditions |

## Tasks

### Python Runtime (🟢 Complete)

| Task ID | Description | Status | Depends On |
|---------|-------------|--------|------------|
| Task-01 | Fix `execute_run_stream()` — read full state from checkpointer | 🟢 | - |
| Task-02 | Fix `execute_agent_run()` — same fix for non-streaming path | 🟢 | - |
| Task-03 | Fix `add_state_snapshot()` key mismatch (Bug 2) | 🟢 | - |
| Task-04 | Verify `GET /threads/{id}/state` returns full history | 🟢 | Task-01 |
| Task-05 | Verify `GET /threads/{id}/history` snapshots have data (not `{}`) | 🟢 | Task-01, Task-03 |
| Task-06 | Test with `useStream` / `@langchain/langgraph-sdk` integration | ⚪ | Task-01, Task-02 |
| Task-07 | Add multi-turn persistence tests | ⚪ | Task-01, Task-02, Task-03 |

### TypeScript Runtime (🟢 Complete)

| Task ID | Description | Status | Depends On |
|---------|-------------|--------|------------|
| Task-08 | Add shared `MemorySaver` checkpointer + pass to graph factory | 🟢 | - |
| Task-09 | Fix `executeRunStream()` — read accumulated state from checkpointer after invoke | 🟢 | Task-08 |
| Task-10 | Fix `executeRunSync()` — same fix in `runs.ts` non-streaming path | 🟢 | Task-08 |
| Task-11 | Fix `addStateSnapshot()` caller key mismatch (Bug 2 in TS) | 🟢 | - |
| Task-12 | Verify with Docker build + multi-turn test | 🟢 | Task-09, Task-10, Task-11 |

### Task-01: Fix `execute_run_stream()` (streaming path) — Python 🟢

**Files to modify:** `apps/python/src/server/routes/streams.py`

**Changes:**
1. After the `astream_events` loop (around line 778), but **inside** the `async with create_checkpointer() as cp` block (before line 795), call `agent.aget_state(runnable_config)` to get the full accumulated state
2. Build `final_values` from the checkpointer state instead of `all_messages`
3. Move the `storage.threads.update()` and `add_state_snapshot()` calls to **inside** the `async with` block, or capture the full state in a variable before exiting the block
4. Keep emitting `format_values_event(final_values)` for SSE clients — but now `final_values` contains the full history

**Key structural concern:** The `yield format_values_event(final_values)` on line 793 and the storage writes on lines 797-798 are currently separated by the `async with` block boundary. The storage writes are **outside** the block. We need to either:
- Move the storage writes inside the block, or
- Capture the checkpoint state in a variable before exiting the block and use it for storage writes after

**Suggested approach:** Capture checkpoint state inside the block, emit the final values event inside the block, then do storage writes outside (they use their own connections via `PostgresStorage`):

```python
    # Inside async with block, after streaming loop:

    # 6. Read full accumulated state from checkpointer
    try:
        checkpoint_state = await agent.aget_state(runnable_config)
        if checkpoint_state and checkpoint_state.values:
            accumulated_messages = checkpoint_state.values.get("messages", [])
            final_values = {
                "messages": [_message_to_dict(m) for m in accumulated_messages]
            }
        else:
            final_values = {"messages": all_messages}
    except Exception as state_error:
        logger.warning("Failed to read checkpoint state: %s", state_error)
        final_values = {"messages": all_messages}

    yield format_values_event(final_values)

# Outside async with block:
await storage.threads.add_state_snapshot(thread_id, {"values": final_values}, owner_id)
await storage.threads.update(thread_id, {"values": final_values}, owner_id)
```

### Task-02: Fix `execute_agent_run()` (non-streaming/MCP path) — Python 🟢

**Files to modify:** `apps/python/src/server/agent.py`

**Changes:**
1. After `result = await agent.ainvoke(agent_input, runnable_config)` (line 226), but **inside** the `async with create_checkpointer() as cp, create_store() as st` block, call `agent.aget_state(runnable_config)` to get full state
2. Build `final_values` from checkpoint state instead of `result.get("messages", [])`
3. Currently the `async with` block ends at line 228 and persist logic is on lines 230-247 (outside). Need to restructure: read checkpoint state inside the block, capture it in a variable, then persist after.

### Task-03: Fix `add_state_snapshot()` key mismatch (Bug 2) — Python 🟢

**Files to modify:** `apps/python/src/server/postgres_storage.py` (line 661) and/or callers

**The problem:**
- Caller passes: `add_state_snapshot(thread_id, {"messages": [...]}, owner_id)`
- Method does: `snapshot_values = state.get("values", {})` → resolves to `{}`
- `thread_states.values` is written as `{}`

**Fix options:**
1. **Fix callers** — wrap in `{"values": final_values}` at the call site: `add_state_snapshot(thread_id, {"values": final_values}, owner_id)`
2. **Fix method** — change `state.get("values", {})` to just use `state` directly as the values (since the caller IS passing the values)
3. **Both** — standardize the interface: method expects `state` to be the values dict directly

**Recommendation:** Fix the callers to pass the correct shape: `{"values": final_values, "metadata": {...}}`. This matches the `ThreadState`-like interface the method was designed for. Also adds a log warning if `"values"` key is missing.

### Task-08: Add shared `MemorySaver` checkpointer — TypeScript 🟢

**Files to modify:** `apps/ts/src/storage/index.ts`

**Problem:** The TS runtime builds the agent WITHOUT a checkpointer:
```typescript
// streams.ts L217
const buildGraph = resolveGraphFactory(graphId ?? undefined);
agent = (await buildGraph(configurable)) as typeof agent;  // No { checkpointer } passed!
```

Without a checkpointer, each `agent.invoke()` is stateless — the LLM gets NO conversation
history from previous runs, and there's no accumulated state to read back.

**Fix:**
1. Add a module-level `MemorySaver` singleton in `apps/ts/src/storage/index.ts`
2. Export `getCheckpointer()` function — returns the shared `MemorySaver` instance
3. Both `streams.ts` and `runs.ts` import `getCheckpointer()` and pass to `buildGraph()`
4. This is semantically correct: `MemorySaver` persists for process lifetime, same as `InMemoryStorage`
5. When Goal 25 adds Postgres, swap `MemorySaver` → `PostgresSaver` here

**Why module-level singleton:**
- `MemorySaver` stores state keyed by `(thread_id, checkpoint_ns)` — same thread across requests gets accumulated state
- Matches `InMemoryStorage` lifecycle — resets on process restart
- `@langchain/langgraph` `MemorySaver` is already in `package.json` dependencies

### Task-09: Fix `executeRunStream()` — TypeScript 🟢

**Files to modify:** `apps/ts/src/routes/streams.ts`

**Current bugs:**
- L217: `buildGraph(configurable)` — no checkpointer passed
- L233: `allMessages = [...inputMessages]` — seeded from current run only
- L347: `finalValues = { messages: allMessages }` — only current run's messages
- L351: `addStateSnapshot(threadId, finalValues)` — `finalValues.values` is `undefined` → snapshot.values = `{}`
- L353: `update(threadId, { values: finalValues })` — overwrites with current run only

**Fix:**
1. Import `getCheckpointer` from storage
2. Pass `{ checkpointer: getCheckpointer() }` to `buildGraph()`
3. Expand agent type to include `getState(config)` method
4. After `agent.invoke()`, call `agent.getState(runnableConfig)` to read accumulated state
5. Serialize accumulated messages for `finalValues` (with graceful fallback to current behavior)
6. Fix `addStateSnapshot` call: pass `{ values: finalValues }` not raw `finalValues`

**Key difference from Python:** Python's checkpointer is `AsyncPostgresSaver` (persistent across
restarts). TS uses `MemorySaver` (in-memory only). This is fine — the TS runtime's `InMemoryStorage`
has the same lifecycle. Both reset on process restart.

### Task-10: Fix `executeRunSync()` — TypeScript 🟢

**Files to modify:** `apps/ts/src/routes/runs.ts`

**Current bugs (identical pattern):**
- L240: `buildGraph(configurable)` — no checkpointer
- L298-306: `finalValues = { messages: serializedMessages }` — only current run
- L309: `addStateSnapshot(threadId, finalValues)` — key mismatch → empty snapshot
- L310: `update(threadId, { values: finalValues })` — overwrites

**Fix:** Mirror the `streams.ts` fix. Import shared checkpointer, pass to graph, read state after invoke.

### Task-11: Fix `addStateSnapshot()` caller key mismatch — TypeScript 🟢

**Files to modify:** `apps/ts/src/storage/memory.ts` (method) and callers in `streams.ts`, `runs.ts`

**The problem (identical to Python Bug 2):**
- Caller: `addStateSnapshot(threadId, { messages: [...] })` — no `"values"` key
- Method: `values: (state.values as Record<string, unknown>) ?? {}` → `state.values` is `undefined` → `{}`
- `record.values = snapshot.values` → overwrites thread with `{}`

**Fix options (same as Python):**
1. Fix callers to pass `{ values: finalValues }` — matches the `ThreadState`-like interface
2. Fix method to handle both shapes with a warning (like Python fix did)
3. Both — belt and suspenders

**Recommendation:** Fix callers to pass `{ values: finalValues }` AND add defensive handling in the
method (log warning if `values` key missing, fall back to using `state` directly as values).

### Task-12: Verify with Docker build + multi-turn test — 🟢

**Steps:**
1. `docker compose build ts-runtime` (rebuilds `fractal-agents-runtime-ts:local-dev`)
2. `docker compose up ts-runtime` on port 8082
3. Create thread → send 3 messages on same thread
4. Verify `GET /threads/{id}/state` returns 2/4/6 messages across runs
5. Verify `GET /threads/{id}/history` snapshots have non-empty values

**Results (verified live):**

| Run | Input | State message count | Agent recall |
|-----|-------|---------------------|--------------|
| 1 | "My name is Luke." | 2 ✅ | Greeted by name |
| 2 | "I live in Munich and work at AIS." | 4 ✅ | Acknowledged |
| 3 | "What do you know about me? List everything." | 6 ✅ | "name is Luke, you live in Munich, and you work at AIS" ✅ |

**History endpoint:** `[6, 4, 2]` (newest first) — all snapshots contain real message data ✅

**SSE fix:** Also fixed a secondary issue where `result.messages` from `agent.invoke()` contained
ALL accumulated messages (since checkpointer is active), causing old AI messages to be re-emitted
as SSE `messages` events. Added `previousMessageCount` tracking before invoke and sliced
`resultMessages` to only process NEW messages for SSE emission. Verified: Run 3 emits exactly
1 `messages` event (only the new AI response) ✅.

**Container logs confirmed:**
```
[streams] Read 2 accumulated messages from checkpointer for thread ...
[streams] Read 4 accumulated messages from checkpointer for thread ...
[streams] Read 6 accumulated messages from checkpointer for thread ...
```

**Docker Compose fix:** Updated `ts-runtime` `env_file` from `apps/ts/.env` → `.env` (root).

## Risks & Mitigations

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| `aget_state()` might fail or return incomplete state | Medium | Low | Fallback to current behavior (current run's messages only) with warning log |
| Message serialization differences (checkpointer vs manual) | Medium | Medium | Test serialization round-trip; `_message_to_dict()` handles `BaseMessage` |
| `aget_state()` returns tool call + tool response messages | Low | High | This is correct behavior — verify `_message_to_dict()` serializes all message types |
| Large conversation histories slow down state writes | Low | Low | Accept for now; optimize later if needed |
| SSE `format_values_event` expects specific message format | High | Medium | Verify message dict format matches what SDK expects |
| Moving storage writes inside `async with` block changes error semantics | Low | Low | Keep try/except around persist logic |
| Changing `add_state_snapshot()` interface breaks other callers | Medium | Low | Grep for all callers; only 2 exist (streams.py, agent.py) |

## Affected Files

### Python Runtime (🟢 Fixed)

| File | Lines | Issue |
|------|-------|-------|
| `src/server/routes/streams.py` | 598, 643, 795-798 | Bug 1: `all_messages` only contains current run's messages |
| `src/server/agent.py` | 230-247 | Bug 1: Same overwrite in non-streaming `execute_agent_run()` |
| `src/server/postgres_storage.py` | 661 | Bug 2: `state.get("values", {})` key mismatch → empty `{}` |
| `src/server/postgres_storage.py` | 606-645 | `get_state()` reads from `threads.values`, not checkpointer |
| `src/server/postgres_storage.py` | 531-592 | `update()` plain overwrite of `values` column |
| `src/server/postgres_storage.py` | 647-694 | `add_state_snapshot()` writes empty values + overwrites thread |
| `src/server/routes/threads.py` | 153-172 | Route handler reads stale `get_state()` |
| `src/server/database.py` | 183-207 | `checkpointer()` CM — correct, but never read from |
| `src/graphs/react_agent/agent.py` | 488-496 | `create_agent` uses `add_messages` reducer — correct |

### TypeScript Runtime (🟢 Fixed)

| File | Lines | Issue |
|------|-------|-------|
| `apps/ts/src/routes/streams.ts` | 217, 233, 347, 351-353 | Bug 1: `allMessages` only current run; no checkpointer; `addStateSnapshot` key mismatch |
| `apps/ts/src/routes/runs.ts` | 240, 298-310 | Bug 1: Same pattern in `executeRunSync()` — no checkpointer, overwrites with current run |
| `apps/ts/src/storage/memory.ts` | 454 | Bug 2: `(state.values as Record<string, unknown>) ?? {}` key mismatch → empty `{}` |
| `apps/ts/src/storage/memory.ts` | 466 | `record.values = snapshot.values` overwrites thread values with `{}` from Bug 2 |
| `apps/ts/src/storage/index.ts` | — | Needs `getCheckpointer()` export for shared `MemorySaver` singleton |
| `apps/ts/src/graphs/react-agent/agent.ts` | 101-106 | `createAgent` correctly accepts `checkpointer` option — just not passed by callers ✅ |

## Dependencies & Versions

From `pyproject.toml`:

| Package | Version |
|---------|---------|
| `fractal-agents-runtime` | 0.0.2 |
| `langgraph` | >=1.0.8 |
| `langgraph-checkpoint-postgres` | >=3.0.4 |
| `langchain` | >=1.2.10 |
| `langchain-core` | >=1.2.11 |
| `psycopg[binary,pool]` | >=3.2.0 |

## Dependencies (Goal-level)

- **Upstream**: None — this is a standalone bugfix
- **Downstream**: `useStream` integration, any frontend consuming `GET /threads/{id}/state`, docproc-platform Goal 43

## Notes & Decisions

### Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2025-07-17 | Choose Option A (read from checkpointer) | Single source of truth, minimal code change, leverages existing infrastructure |
| 2025-07-17 | Fix both streaming and non-streaming paths | Both have the same bug; partial fix would leave MCP path broken |
| 2025-07-17 | Added Task-03 for Bug 2 (add_state_snapshot key mismatch) | Live testing showed `thread_states.values = {}` — separate root cause from Bug 1 |
| 2025-07-17 | Tasks 01-03 implemented | `streams.py`: reads checkpoint state via `agent.aget_state()` with graceful fallback; `agent.py`: same fix, moved checkpoint read inside `async with` block; `postgres_storage.py`: `add_state_snapshot()` handles both `{"values": ...}` and raw state shapes with warning log. All callers updated to pass `{"values": final_values}`. Linting clean, all 6 tests pass. |
| 2025-07-17 | Tasks 04-05 verified live | Rebuilt Docker image (`--no-cache`), ran 3-run multi-turn test against local Supabase. Results: Run 1 → 2 msgs, Run 2 → 4 msgs, Run 3 → 6 msgs. `GET /threads/{id}/state` returns full accumulated history ✅. `GET /threads/{id}/history` returns 3 snapshots with 6/4/2 messages (newest first) — no more empty `{}` ✅. Container logs confirm `"Read N accumulated messages from checkpointer"` for each run. Also fixed `docker-compose.yml`: pointed `env_file` to `apps/python/.env`, removed duplicated env overrides, added `ts-runtime` service on port 8082. |
| 2025-07-18 | TS runtime: Use shared `MemorySaver` singleton as checkpointer | Mirrors Python's approach (read from checkpointer after invoke). `MemorySaver` has same lifecycle as `InMemoryStorage` — persists for process lifetime, resets on restart. `@langchain/langgraph` already in deps. Agent factory already accepts `checkpointer` option — just never passed by callers. |
| 2025-07-18 | TS runtime: Add `getCheckpointer()` to storage module | Centralizes checkpointer access; easy to swap for `PostgresSaver` in Goal 25. Both `streams.ts` and `runs.ts` import from same place. |
| 2025-07-19 | Tasks 08-11 implemented | `storage/index.ts`: Added `getCheckpointer()` / `resetCheckpointer()` singleton returning `MemorySaver`. `streams.ts`: Passes checkpointer to `buildGraph()`, reads accumulated state via `agent.getState()` after invoke with graceful fallback, fixes `addStateSnapshot` call to `{ values: finalValues }`. `runs.ts`: Same pattern — passes checkpointer, reads accumulated state, fixes snapshot call. `memory.ts`: `addStateSnapshot()` now handles both `{ values: {...} }` and raw state shapes defensively with warning log. All 761 tests pass, `tsc --noEmit` clean. Logs confirm `"Read N accumulated messages from checkpointer"`. |
| 2025-07-20 | Task-12 verified live | Docker build (`--no-cache`), 3-run multi-turn test on port 8082. Results: Run 1 → 2 msgs, Run 2 → 4 msgs, Run 3 → 6 msgs. Agent correctly recalls name/city/employer across runs. History endpoint returns `[6, 4, 2]` snapshots with real data. Also fixed SSE replay bug (old AI messages re-emitted) by tracking `previousMessageCount` before invoke and slicing `resultMessages`. Fixed `docker-compose.yml` `env_file` for ts-runtime → root `.env`. 761 tests pass after all changes. |

### Open Questions

- [ ] Does `agent.aget_state()` return tool call messages and tool response messages, or just human/AI? Need to verify the full message types are preserved and `_message_to_dict()` handles them.
- [ ] What does `useStream` expect in the `values.messages` array — full LangChain message dicts or simplified format? Need to check the integration example.
- [ ] Should `thread_states` snapshots (history) contain the full accumulated state or just the delta for that run? Full state is more useful for `useStream` but uses more storage.
- [ ] Are there any other consumers of `threads.values` that might break if it suddenly contains the full history instead of just the last turn?
- [ ] TS runtime: Does `agent.getState(config)` return LangChain message objects or plain dicts? Need to verify serialization — `toJSON()` / `_getType()` patterns may differ from Python's `_message_to_dict()`.
- [ ] TS runtime: `MemorySaver` memory growth — for long-running processes with many threads, the checkpointer accumulates state indefinitely. Acceptable for in-memory runtime (same as `InMemoryStorage`), but worth noting for production.

## References

- [Bug Investigation Report](../bug-investigation-message-history-storage.md)
- [Full Bug Report with Live Evidence](../bug-report-thread-values-overwrite.md)
- `apps/python/src/server/routes/streams.py` — streaming execution
- `apps/python/src/server/agent.py` — non-streaming execution
- `apps/python/src/server/postgres_storage.py` — thread storage
- `apps/python/src/server/routes/threads.py` — thread state endpoint
- `apps/python/src/server/database.py` — checkpointer/store context managers
- `apps/python/src/graphs/react_agent/agent.py` — `create_agent` call site
- [LangChain `create_agent` docs](https://docs.langchain.com/oss/python/langchain/agents)
- [LangGraph `add_messages` reducer](https://docs.langchain.com/oss/python/langgraph/graph-api)
- [LangChain `useStream` frontend docs](https://docs.langchain.com/oss/javascript/langchain/streaming/frontend)
- [`@langchain/langgraph-sdk` `useStream`](https://github.com/langchain-ai/langgraph-sdk)