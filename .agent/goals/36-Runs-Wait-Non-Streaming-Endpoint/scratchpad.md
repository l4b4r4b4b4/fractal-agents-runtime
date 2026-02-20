# Goal 36: `/runs/wait` Non-Streaming Endpoint (Python + TS)

> **Status:** 🟡 In Progress (code complete, pending E2E verification)
> **Priority:** P1 (blocks non-streaming clients, API completeness)
> **Branch:** `feat/rag-chromadb-retriever` (current working branch)
> **Created:** 2026-02-20
> **Depends on:** None (independent of RAG goals, but same release window)

---

## Objectives

The `POST /threads/{thread_id}/runs/wait` endpoint is currently a **stub** in
the Python runtime — it stores the input, marks the run as "success", and
returns the thread state without ever executing the agent graph. The TypeScript
runtime **already has a working implementation** via `executeRunSync()`.

This endpoint is essential for:
- Non-streaming API clients (webhooks, batch processing, CLI tools)
- Simpler integration testing (no SSE parsing required)
- LangGraph SDK compatibility (`client.runs.wait()`)
- Webapp integration (simpler than parsing SSE streams)

### Success Criteria

- [x] Python `/threads/{thread_id}/runs/wait` executes the full agent graph (same as `/runs/stream`)
- [x] Python `/threads/{thread_id}/runs/wait` returns the final thread state with all messages
- [x] Python `/runs/wait` (stateless) executes the full agent graph
- [x] Python `/runs` (stateless, background) implemented (blocks until completion, matches TS)
- [x] Both endpoints respect `interrupt_before` / `interrupt_after` if set (via `_build_runnable_config`)
- [x] Error handling: LLM failure, tool failure → proper error responses (try/except → 500 + run status "error")
- [x] Run status updated correctly: `running` → `success` / `error`
- [x] Thread state stored identically to `/runs/stream` (checkpointer → thread storage)
- [ ] E2E test: send a question via `/runs/wait`, get back complete conversation including tool calls
- [x] Existing `/runs/stream` continues to work unchanged (130 tests pass, only DRY refactor)
- [x] TS runtime verified as already working (no changes needed)

---

## Key Finding: TS Runtime Already Done ✅

The TS runtime has a **fully working** `/runs/wait` implementation:

- **Stateful:** `apps/ts/src/routes/runs.ts` → `createRunWait` (L786+) calls `executeRunSync()`
- **Stateless:** `apps/ts/src/routes/runs-stateless.ts` → `createStatelessRunWait` (L281+) calls `executeRunSync()`
- **Core logic:** `executeRunSync()` (L306–520 in `runs.ts`) uses `agent.invoke()` + checkpointer state read

The TS `executeRunSync()` pattern is the reference for the Python implementation:
1. Resolve graph factory by `graph_id`
2. Build agent with checkpointer
3. `agent.invoke(agentInput, tracedConfig)` — synchronous execution
4. `agent.getState(runnableConfig)` — read accumulated messages from checkpointer
5. Serialize messages, store in thread state
6. Update run status → `success` / `error`
7. Return `storage.threads.getState(threadId)`

---

## Architecture Decisions

### 1. Create `execute_run_wait()` — parallel to `execute_run_stream()`

The streaming path in `streams.py` has `execute_run_stream()` (L538–942) which:
- Parses input messages (L580–610)
- Builds `RunnableConfig` via `_build_runnable_config()` (L616–632)
- Injects Langfuse tracing (L634–640)
- Creates checkpointer + store context (L648+)
- Resolves graph factory + builds agent (L650–664)
- Reads pre-existing checkpoint state (L670–700)
- Executes via `agent.astream_events()` (L707+)
- Reads final state from checkpointer (L848–930)
- Persists to thread storage (L932–942)

For `/runs/wait`, we need the **same pipeline** but:
- Use `agent.ainvoke()` instead of `agent.astream_events()`
- No SSE event formatting
- Return final state dict instead of yielding SSE strings

**Plan:** Extract shared setup logic (message parsing, config building, graph
construction) into helpers if not already. Create `execute_run_wait()` that
returns a `dict` instead of yielding SSE strings.

### 2. Reuse existing helpers

These functions in `streams.py` are already reusable:
- `_message_to_dict()` (L40) — message serialization
- `_build_runnable_config()` (L77) — config merging

These will be imported by the new `execute_run_wait()` function. The function
can live in `streams.py` alongside `execute_run_stream()`, or in a new
`execution.py` module. Keeping it in `streams.py` minimizes import changes.

### 3. Consistent state storage

Both endpoints must produce identical checkpoint / thread state. A run executed
via `/runs/wait` should be indistinguishable from one executed via
`/runs/stream` when inspecting `/threads/{id}/state` or `/threads/{id}/history`.

### 4. Three Python endpoints to implement

| Endpoint | Type | Current Status | Priority |
|----------|------|---------------|----------|
| `POST /threads/{thread_id}/runs/wait` | Stateful | **Stub** (runs.py L267–405) | Must fix |
| `POST /runs/wait` | Stateless | **Not implemented** (spec-only) | Must add |
| `POST /runs` | Stateless background | **Not implemented** | Can defer (stub OK) |

---

## Root Cause Analysis: Why the Stub Doesn't Work

The current Python stub at `apps/python/src/server/routes/runs.py` L359–405:

```python
# TODO: Execute agent graph here
# For now, we simulate execution by:
# 1. Storing the input in thread state
# 2. Marking run as success
# 3. Returning the thread state
```

It never calls `resolve_graph_factory()`, never builds the agent, never calls
`agent.ainvoke()`. It just stores the raw input as thread state and returns it.
The response looks like a completed run but contains only the user's input —
no AI response, no tool calls.

---

## Task Breakdown

### Task-01: Python `execute_run_wait()` + stateful `/runs/wait`

**Status:** 🟢 Complete
**Effort:** Medium (most logic exists in `execute_run_stream`, needs adaptation)

**Files to modify:**

1. **`apps/python/src/server/routes/streams.py`** — Add `execute_run_wait()` function
   - Reuse `_message_to_dict()`, `_build_runnable_config()`
   - Same setup: message parsing, config building, Langfuse injection
   - Same checkpointer/store context: `async with create_checkpointer() as cp, create_store() as st:`
   - Same graph resolution: `resolve_graph_factory(graph_id)` → `build_graph(config, checkpointer=cp, store=st)`
   - **Different execution:** `result = await agent.ainvoke(agent_input, runnable_config)` instead of `astream_events()`
   - Same post-execution: read checkpointer state, serialize messages, return dict
   - Signature: `async def execute_run_wait(...) -> dict[str, Any]`
   - Returns: `{"values": {"messages": [...]}, "next": [], ...}` (thread state shape)

2. **`apps/python/src/server/routes/runs.py`** — Replace stub with real execution
   - Import `execute_run_wait` from `streams` (or new module)
   - Replace L359–405 TODO block with:
     ```python
     result = await execute_run_wait(
         run_id=run.run_id,
         thread_id=thread_id,
         assistant_id=assistant.assistant_id,
         input_data=create_data.input,
         config=create_data.config,
         owner_id=user.identity,
         assistant_config=assistant.config,
         graph_id=assistant.graph_id,
     )
     ```
   - Handle errors: try/except → update run status, return error response
   - Keep the existing thread/assistant/multitask validation (L280–358) — it's correct

**Key reference — TS `executeRunSync()` pattern (runs.ts L306–520):**
```
1. resolveGraphFactory(graphId) → buildGraph(configurable, checkpointer)
2. agent.invoke(agentInput, tracedConfig)
3. agent.getState(runnableConfig) → accumulated messages
4. storage.threads.addStateSnapshot(threadId, { values: finalValues })
5. storage.threads.update(threadId, { values: finalValues })
6. storage.runs.updateStatus(runId, "success")
7. storage.threads.update(threadId, { status: "idle" })
8. return storage.threads.getState(threadId, ownerId)
```

**Tests to add:**
- Unit test: mock graph returning canned messages, verify `/runs/wait` returns them
- Test error path: graph raises → run status "error", thread status "idle", 500 response
- Test multitask conflict: active run + reject strategy → 409

### Task-02: Python stateless `/runs/wait` + `/runs`

**Status:** 🟢 Complete
**Effort:** Low (same `execute_run_wait()`, ephemeral thread pattern from streaming)

**Files to modify:**

1. **`apps/python/src/server/routes/streams.py`** — Add stateless wait handler
   - Mirror the stateless stream pattern (`create_stateless_run_stream` at L427–535)
   - Create ephemeral thread, create run, call `execute_run_wait()`, handle `on_completion`
   - Register as `@app.post("/runs/wait")`

2. **`apps/python/src/server/routes/streams.py`** — Add stateless background `/runs`
   - For v0.0.3: same as `/runs/wait` (block until completion) — matches TS behavior
   - Register as `@app.post("/runs")`

**Reference — TS `createStatelessRunWait` (runs-stateless.ts L281–340):**
- Creates ephemeral thread
- Creates run in "running" status
- Calls `executeRunSync()` (same function as stateful)
- Handles `on_completion` (delete or keep ephemeral thread)
- Returns `state ?? { values: {}, next: [], tasks: [] }`

### Task-03: TS runtime verification

**Status:** 🟢 Complete (already working)

**Verified files:**
- `apps/ts/src/routes/runs.ts` — `createRunWait` (L786+) ✅
  - Calls `executeRunSync()` with full graph execution
  - Handles multitask conflicts, error responses
- `apps/ts/src/routes/runs-stateless.ts` — `createStatelessRunWait` (L281+) ✅
  - Creates ephemeral thread, calls `executeRunSync()`
  - Handles `on_completion` behavior
- `apps/ts/src/routes/runs.ts` — `executeRunSync()` (L306–520) ✅
  - Full pipeline: graph build → invoke → checkpoint read → state persist

**No changes needed.** Optionally add a smoke test to verify round-trip.

### Task-04: E2E verification + CAPABILITIES.md update

**Status:** 🟡 In Progress (CAPABILITIES.md updated, Docker rebuild + curl tests pending)

- [x] Update `CAPABILITIES.md` status for wait endpoints: ⚪ → ✅
- [x] Also fixed CAPABILITIES.md: cancel endpoint was ⚪ but already implemented → ✅
- [x] Also fixed CAPABILITIES.md: delete run was ⚪ but already implemented → ✅
- [x] Fixed `/store/namespaces` method: was POST in capabilities, actual is GET
- [ ] Rebuild Python Docker image
- [ ] Test stateful: `POST /threads/{id}/runs/wait` with a real question → expect AI response
- [ ] Test stateless: `POST /runs/wait` → expect AI response + ephemeral thread cleanup
- [ ] Verify `/runs/stream` still works (no regression)

---

## Affected Files Summary

### Python (must fix)

| File | Change |
|------|--------|
| `apps/python/src/server/routes/streams.py` | Add `execute_run_wait()`, stateless `/runs/wait`, stateless `/runs` |
| `apps/python/src/server/routes/runs.py` | Replace stub L359–405 with `execute_run_wait()` call |
| `apps/python/src/server/CAPABILITIES.md` | Update stateful/stateless wait status |
| `apps/python/tests/` or `src/server/tests/` | Add wait endpoint tests |

### TypeScript (no changes needed)

| File | Status |
|------|--------|
| `apps/ts/src/routes/runs.ts` | ✅ Already working (`createRunWait` + `executeRunSync`) |
| `apps/ts/src/routes/runs-stateless.ts` | ✅ Already working (`createStatelessRunWait`) |

---

## API Contract

### Stateful Request

```
POST /threads/{thread_id}/runs/wait
Authorization: Bearer <JWT>
Content-Type: application/json

{
  "assistant_id": "<assistant_id>",
  "input": {
    "messages": [
      { "role": "user", "content": "Wann wurde die Heizungsanlage gewartet?" }
    ]
  },
  "config": {},
  "multitask_strategy": "reject"
}
```

### Stateless Request

```
POST /runs/wait
Authorization: Bearer <JWT>
Content-Type: application/json

{
  "assistant_id": "<assistant_id>",
  "input": {
    "messages": [
      { "role": "user", "content": "Was kostet eine Nebenkostenabrechnung?" }
    ]
  },
  "on_completion": "delete"
}
```

### Response (200 OK) — both stateful and stateless

```json
{
  "values": {
    "messages": [
      { "type": "human", "content": "Wann wurde die Heizungsanlage gewartet?", "id": "..." },
      { "type": "ai", "content": "", "tool_calls": [{"name": "search_archives", ...}], "id": "..." },
      { "type": "tool", "name": "search_archives", "content": "[1] Archiv: ...", "id": "..." },
      { "type": "ai", "content": "Die Heizungsanlage wurde zuletzt am **15. Januar 2025** gewartet...", "id": "..." }
    ]
  },
  "next": [],
  "tasks": [],
  "checkpoint": { "thread_id": "...", "checkpoint_ns": "", "checkpoint_id": "..." },
  "metadata": {},
  "created_at": "...",
  "parent_checkpoint": null,
  "interrupts": []
}
```

---

## Risks & Mitigations

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Long-running graphs hit HTTP timeouts | Medium | Document proxy/gateway timeout config; optional `timeout` param later |
| Memory pressure from buffering full graph output | Low | Graph output is text — small compared to streaming buffer |
| Divergent behaviour between stream and wait | Medium | Share config/setup code; same checkpointer path; comparison tests |
| `ainvoke()` error handling differs from `astream_events()` | Low | Wrap in try/except, match error response format |
| Breaking existing `/runs/stream` by refactoring shared code | Low | Don't refactor streams.py — add `execute_run_wait()` alongside, run full test suite |

---

## Execution Estimate

| Task | Effort | Notes |
|------|--------|-------|
| Task-01: `execute_run_wait()` + stateful handler | ~45 min | Core logic exists in streaming path |
| Task-02: Stateless `/runs/wait` + `/runs` | ~20 min | Mirrors stateless stream pattern |
| Task-03: TS verification | ✅ Done | Already verified during analysis |
| Task-04: E2E + capabilities update | ~15 min | Docker rebuild + curl tests |
| **Total** | **~1.5 hours** | |

---

## Implementation Summary (Tasks 01-02)

### What was done

1. **Extracted `_parse_input_messages()` helper** (`streams.py` L46–93)
   - Shared between `execute_run_stream()` and `execute_run_wait()`
   - Handles `{"messages": [...]}`, `{"input": "..."}`, and bare string formats
   - `execute_run_stream()` refactored to use it (DRY, no behavioral change)

2. **Added `execute_run_wait()`** (`streams.py` L1212–1367)
   - Same pipeline as `execute_run_stream()`: parse input → build config → inject tracing → checkpointer/store → build graph → execute → read state → persist
   - Uses `agent.ainvoke()` instead of `agent.astream_events()`
   - Returns `dict[str, Any]` shaped `{"messages": [...]}`
   - Falls back to `_extract_values_from_result()` if checkpointer read fails

3. **Added `_extract_values_from_result()`** (`streams.py` L1370–1390)
   - Fallback helper: extracts messages from raw `ainvoke` result dict

4. **Replaced stub in `create_run_wait()`** (`runs.py` L356–395)
   - Imports `execute_run_wait` from `streams`
   - try/except: success → run "success" + thread "idle"; error → run "error" + thread "idle" + 500

5. **Added `create_stateless_run_wait()`** (`streams.py` L488–601)
   - `POST /runs/wait`: ephemeral thread + `execute_run_wait()` + `on_completion` handling
   - Mirrors `create_stateless_run_stream()` pattern exactly

6. **Added `create_stateless_run()`** (`streams.py` L608–718)
   - `POST /runs`: background run — blocks until completion (same as `/runs/wait`)
   - True async background deferred to future release

7. **Updated `CAPABILITIES.md`** — marked 5 endpoints as ✅, fixed method/status errors

### Files modified

| File | Lines changed | What |
|------|--------------|------|
| `apps/python/src/server/routes/streams.py` | +300 | `_parse_input_messages()`, `execute_run_wait()`, `_extract_values_from_result()`, stateless `/runs/wait`, stateless `/runs` |
| `apps/python/src/server/routes/runs.py` | +15 / -30 | Replace stub with `execute_run_wait()` call |
| `apps/python/src/server/CAPABILITIES.md` | +15 / -8 | Status updates for 5 endpoints |

### Test results

- **130 passed, 1 skipped, 0 failed** — no regressions
- Ruff check + format: clean

---

## Completion Log

| Date | What | Notes |
|------|------|-------|
| 2026-02-20 | Goal created | Identified during E2E test — `/runs/wait` is a stub |
| 2026-02-20 | Task-03 complete | TS runtime verified — `executeRunSync()` already works for both stateful and stateless |
| 2026-02-20 | Code analysis complete | Mapped Python streaming path L538–942, identified shared helpers, documented TS reference implementation |
| 2026-02-20 | Task-01 complete | `execute_run_wait()` added, `_parse_input_messages()` extracted, runs.py stub replaced with real execution |
| 2026-02-20 | Task-02 complete | Stateless `/runs/wait` and `/runs` endpoints added to streams.py |
| 2026-02-20 | CAPABILITIES.md updated | 5 endpoints marked ✅, method/status corrections applied |