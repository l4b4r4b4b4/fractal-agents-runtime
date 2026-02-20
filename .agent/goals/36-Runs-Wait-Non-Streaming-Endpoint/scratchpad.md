# Goal 36: `/runs/wait` Non-Streaming Endpoint (Python + TS)

> **Status:** ⚪ Not Started
> **Priority:** P1 (blocks non-streaming clients, API completeness)
> **Branch:** TBD
> **Created:** 2026-02-20
> **Depends on:** None (independent of RAG goals, but same release window)
> **Reference:** `apps/python/src/server/routes/runs.py` L267–405 (current stub)

---

## Objectives

The `POST /threads/{thread_id}/runs/wait` endpoint is currently a **stub** in
the Python runtime — it stores the input, marks the run as "success", and
returns the thread state without ever executing the agent graph. The TypeScript
runtime likely has the same gap. Both must be updated to actually invoke the
agent graph, wait for completion, and return the final state.

This endpoint is essential for:
- Non-streaming API clients (webhooks, batch processing, CLI tools)
- Simpler integration testing (no SSE parsing required)
- LangGraph SDK compatibility (`client.runs.wait()`)

### Success Criteria

- [ ] Python `/runs/wait` executes the full agent graph (same as `/runs/stream`)
- [ ] Python `/runs/wait` returns the final thread state with all messages (human + AI + tool calls)
- [ ] Python `/runs/wait` respects `interrupt_before` / `interrupt_after` if set
- [ ] Python `/runs/wait` handles errors gracefully (timeout, LLM failure, tool failure)
- [ ] Python `/runs/wait` updates run status correctly (`running` → `success` / `error`)
- [ ] TypeScript `/runs/wait` has equivalent implementation
- [ ] E2E test: send a question via `/runs/wait`, get back complete conversation including tool calls
- [ ] Existing `/runs/stream` continues to work unchanged

---

## Architecture Decisions

### 1. Reuse `execute_run_stream` logic, collect final state

The streaming endpoint already has the full agent execution pipeline in
`execute_run_stream()`. Rather than duplicating that logic, the `/runs/wait`
handler should:

1. Call the same graph invocation path
2. Collect all events (instead of yielding them as SSE)
3. Return the final thread state snapshot

Alternatively, LangGraph's compiled graph has both `.astream()` and
`.ainvoke()` — we could use `.ainvoke()` directly for the wait endpoint,
which naturally returns the final state without streaming overhead.

### 2. Timeout handling

`/runs/wait` should support an optional `timeout` parameter (seconds). If the
graph doesn't complete within the timeout, return a `408 Request Timeout` or
partial state. Default: no timeout (wait indefinitely, relying on HTTP-level
timeouts).

### 3. Consistent state storage

Both endpoints must produce identical checkpoint / thread state. A run executed
via `/runs/wait` should be indistinguishable from one executed via
`/runs/stream` when inspecting `/threads/{id}/state` or `/threads/{id}/history`.

---

## Task Breakdown

### Task-01: Python `/runs/wait` implementation

**Status:** ⚪ Not Started

**Files to modify:**
- `apps/python/src/server/routes/runs.py` — Replace stub with real graph execution

**Implementation plan:**
1. Extract the graph invocation logic from `streams.py`'s `execute_run_stream()`
   into a shared helper (or create a parallel `execute_run_wait()`)
2. Use `compiled_graph.ainvoke()` instead of `.astream_events()`
3. Store checkpoints and thread state identically to the stream path
4. Return the final thread state as JSON response
5. Handle run status updates: `running` → `success` / `error`

**Key code to reference:**
- `apps/python/src/server/routes/streams.py` L538+ — `execute_run_stream()`
- `apps/python/src/graphs/react_agent/agent.py` — `graph()` returns compiled agent

**Tests:**
- Unit test: mock graph, verify `/runs/wait` returns final state
- Integration test: real agent with mock LLM, verify message flow
- E2E test: real agent + ChromaDB, verify tool calls appear in response

### Task-02: TypeScript `/runs/wait` implementation

**Status:** ⚪ Not Started

**Files to modify:**
- Equivalent TS route handler for `/runs/wait`

**Implementation plan:**
- Mirror the Python approach
- Use LangGraph JS `invoke()` instead of `streamEvents()`
- Same state storage and response format

### Task-03: Shared test coverage

- Verify `/runs/wait` and `/runs/stream` produce identical thread states
- Test timeout behaviour
- Test error propagation (LLM errors, tool errors)

---

## Current Stub (Python)

The existing code at `apps/python/src/server/routes/runs.py` L370–405:

```python
# TODO: Execute agent graph here
# For now, we simulate execution by:
# 1. Storing the input in thread state
# 2. Marking run as success
# 3. Returning the thread state
```

This needs to be replaced with actual graph invocation.

---

## API Contract

### Request

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

### Response (200 OK)

```json
{
  "values": {
    "messages": [
      { "role": "user", "content": "Wann wurde die Heizungsanlage gewartet?" },
      { "role": "ai", "content": "", "tool_calls": [{"name": "search_archives", "args": {"query": "..."}}] },
      { "role": "tool", "name": "search_archives", "content": "[1] Archiv: ..." },
      { "role": "ai", "content": "Die Heizungsanlage wurde zuletzt am **15. Januar 2025** gewartet..." }
    ]
  },
  "next": [],
  "tasks": [],
  "checkpoint": { "thread_id": "...", "checkpoint_ns": "", "checkpoint_id": "..." },
  "metadata": { "owner": "..." },
  "created_at": "...",
  "parent_checkpoint": null,
  "interrupts": []
}
```

---

## Risks & Mitigations

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Long-running graphs hit HTTP timeouts | Medium | Add optional `timeout` param; document proxy/gateway timeout config |
| Memory pressure from buffering full graph output | Low | Graph output is text — small relative to streaming buffer |
| Divergent behaviour between stream and wait | Medium | Share core execution logic; comparison tests |
| Checkpoint inconsistency | Low | Same checkpointer path for both endpoints |

---

## Completion Log

| Date | What | Notes |
|------|------|-------|
| 2026-02-20 | Goal created | Identified during E2E test — `/runs/wait` is a stub |