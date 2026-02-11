# Task 07 — SSE Streaming Endpoints

Status: 🟢 Complete  
Created: 2026-02-04  
Updated: 2026-02-04

---

## Objective

Implement LangGraph-compatible SSE (Server-Sent Events) streaming endpoints for the Robyn runtime server. These endpoints are critical for real-time agent execution feedback.

---

## Endpoints to Implement

### Tier 1 (Must-Have)
1. **POST /threads/:thread_id/runs/stream** — Create run and stream output
2. **POST /runs/stream** — Stateless run with streaming

### Tier 2 (Join Existing Stream)
3. **GET /threads/:thread_id/runs/:run_id/stream** — Join existing run stream

---

## SSE Framing Specification

From captured LangGraph output (`.agent/tmp/sse_stateful_runs_stream.txt`):

### Response Headers
```
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-store
x-accel-buffering: no
Transfer-Encoding: chunked
Location: /threads/{thread_id}/runs/{run_id}/stream
Content-Location: /threads/{thread_id}/runs/{run_id}
```

### SSE Event Sequence
1. `event: metadata` — First event, contains `run_id` and `attempt`
2. `event: values` — Initial state with input messages
3. `event: messages/metadata` — Rich metadata about the LLM invocation
4. `event: messages/partial` — Streaming token chunks (multiple events)
5. `event: updates` — Graph node updates
6. `event: values` — Final state with all messages

### Frame Format
```
event: <event_type>
data: <json_payload>

```
Note: Each frame ends with a blank line (two newlines after `data:`).

---

## Implementation Plan

### 1. SSE Response Helper (`robyn_server/routes/sse.py`)
- [x] Create `sse_headers()` for proper SSE headers
- [x] Create `format_sse_event(event_type, data)` helper to format frames
- [x] Create message formatters for all LangGraph event types
- [x] Use Robyn's built-in `SSEResponse` for streaming

### 2. Stream Endpoints (`robyn_server/routes/streams.py`)
- [x] `POST /threads/:thread_id/runs/stream` — Create and stream
- [x] `POST /runs/stream` — Stateless streaming
- [x] `GET /threads/:thread_id/runs/:run_id/stream` — Join stream

### 3. Agent Execution Integration
- [x] Simulated agent execution for now (returns placeholder response)
- [ ] TODO: Full integration with `tools_agent.agent.graph` in future task
- [x] Event sequence matches LangGraph framing
- [x] Thread state updated after stream completion

### 4. Tests (`robyn_server/tests/test_streams.py`)
- [x] Test SSE frame formatting (11 tests)
- [x] Test SSE headers (3 tests)
- [x] Test message creation utilities (4 tests)
- [x] Test storage operations for streams (3 tests)
- [x] Test event sequence ordering (2 tests)
- [x] Test stateless run storage (2 tests)
- [x] Test edge cases (6 tests)

---

## Key Files

**To Create:**
- `robyn_server/routes/sse.py` — SSE utilities
- `robyn_server/routes/streams.py` — Stream endpoints
- `robyn_server/tests/test_streams.py` — Stream tests

**To Modify:**
- `robyn_server/app.py` — Register stream routes
- `robyn_server/routes/__init__.py` — Export stream routes

**References:**
- `.agent/tmp/sse_stateful_runs_stream.txt` — Captured SSE output
- `tools_agent/agent.py` — Agent graph definition
- `robyn_server/routes/runs.py` — Existing run endpoints

---

## Technical Notes

### Robyn Streaming
Robyn supports streaming responses via generators. Need to verify the exact API:
```python
from robyn import Response

async def stream_endpoint(request):
    async def generate():
        yield "event: metadata\n"
        yield f"data: {json.dumps(data)}\n\n"
    
    return Response(
        status_code=200,
        headers={"Content-Type": "text/event-stream"},
        body=generate()  # or use streaming mechanism
    )
```

### LangGraph Agent Streaming
The agent graph supports streaming via:
```python
from tools_agent.agent import graph

async for event in graph.astream_events(input, config):
    # Map to SSE events
    pass
```

### Event Mapping
| LangGraph Event | SSE Event Type |
|-----------------|----------------|
| `on_chain_start` | `metadata` |
| `on_chain_stream` (values) | `values` |
| `on_chat_model_start` | `messages/metadata` |
| `on_chat_model_stream` | `messages/partial` |
| `on_chain_end` | `updates`, `values` |

---

## Progress Log

### 2026-02-04
- Created Task 07 scratchpad
- Analyzed SSE framing specification from captured output
- Planned implementation approach
- Implemented `robyn_server/routes/sse.py` with SSE utilities:
  - `sse_headers()` for proper Content-Type and Location headers
  - `format_sse_event()` for LangGraph-compatible framing
  - Event formatters for metadata, values, updates, messages/partial, messages/metadata, error
  - Message creation utilities for human and AI messages
- Implemented `robyn_server/routes/streams.py` with 3 endpoints:
  - `POST /threads/:thread_id/runs/stream` — Create run and stream
  - `GET /threads/:thread_id/runs/:run_id/stream` — Join existing stream
  - `POST /runs/stream` — Stateless streaming
- Implemented `execute_run_stream()` generator that emits events in correct sequence:
  1. metadata (run_id, attempt)
  2. values (initial state)
  3. messages/metadata (LLM invocation info)
  4. messages/partial (token chunks)
  5. updates (graph node updates)
  6. values (final state)
- Created comprehensive test suite (31 tests) covering:
  - SSE frame formatting
  - Headers configuration
  - Message creation
  - Storage operations
  - Event sequencing
  - Edge cases
- All 233 tests passing (202 existing + 31 new)
- Linting and formatting complete
- Server registers 27 routes (24 existing + 3 new streaming)

---

## Acceptance Criteria

- [x] SSE endpoints return proper `Content-Type: text/event-stream` headers
- [x] Events follow LangGraph framing (event/data format)
- [x] Authentication required for all endpoints
- [x] Owner isolation enforced
- [x] Simulated agent execution (full integration deferred to future task)
- [x] Tests cover SSE formatting, auth, and event sequence
- [x] All existing tests still pass (233 total)

---

## Summary

Task 07 implemented SSE streaming endpoints for the Robyn runtime server:

**Files Created:**
- `robyn_server/routes/sse.py` — SSE utilities (215 lines)
- `robyn_server/routes/streams.py` — Stream endpoints (452 lines)
- `robyn_server/tests/test_streams.py` — Tests (526 lines)

**Files Modified:**
- `robyn_server/routes/__init__.py` — Export stream routes
- `robyn_server/app.py` — Register stream routes

**Endpoints Added:**
1. `POST /threads/:thread_id/runs/stream` — Create run, stream output
2. `GET /threads/:thread_id/runs/:run_id/stream` — Join existing stream
3. `POST /runs/stream` — Stateless streaming

**Test Results:**
- 31 new tests added
- 233 total tests passing
- All linting checks pass

**Next Steps:**
- Task 08: Full agent execution integration with `tools_agent.agent.graph`
- Manual integration testing with LangGraph SDK

---

## Handoff Prompt for Next Session

```
Task 08 — Agent Execution Integration

Context: Robyn runtime server for Goal 06. Tasks 01-07 complete with 233 tests passing. SSE streaming endpoints implemented with simulated responses. See `.agent/goals/06-Robyn-Runtime/scratchpad.md` for full context.

What Was Done (Tasks 01-07):
- Task 01-03: Project setup, auth middleware, in-memory storage
- Task 04: Assistants endpoints (6 routes)
- Task 05: Threads endpoints (8 routes) with state/history
- Task 06: Runs endpoints (6 routes) with multitask strategy
- Task 07: SSE streaming (3 routes) with simulated agent execution
- Total: 27 routes registered, 233 tests passing

Current Task (Task 08 — Agent Execution Integration):
Replace simulated responses with real agent execution:
- Import and invoke `tools_agent.agent.graph` in streaming endpoints
- Build proper `RunnableConfig` from assistant config + request
- Map LangGraph streaming events to SSE event types
- Handle errors and cancellation gracefully

Key files:
- robyn_server/routes/streams.py — `execute_run_stream()` function to update
- tools_agent/agent.py — Agent graph definition (uses `graph.astream_events`)
- .agent/goals/06-Robyn-Runtime/scratchpad.md — Full context
- .agent/tmp/sse_stateful_runs_stream.txt — Reference SSE output
```