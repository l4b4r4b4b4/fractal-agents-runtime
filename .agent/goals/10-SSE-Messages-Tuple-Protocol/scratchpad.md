# Goal 10: SSE Messages-Tuple Protocol Compatibility

> Fix SSE streaming protocol to emit `messages-tuple` format expected by `@langchain/langgraph-sdk` v1.6.0

---

## Status: 🟡 In Progress

**Branch:** `fix/sse-messages-tuple-protocol`
**Priority:** Critical — blocks real-time chat streaming in docproc-platform
**Created:** 2026-02-20

---

## Problem Statement

The robyn-runtime SSE streaming uses the **old LangGraph Server protocol** for message events, but `@langchain/langgraph-sdk` v1.6.0 expects the **new `messages-tuple` format**. This causes the SDK's `StreamManager.matchEventType()` to silently drop all message events, resulting in chat responses appearing "all at once" instead of streaming token-by-token.

### Root Cause (confirmed in docproc-platform Session 44d)

The SDK's event matching logic:

```python
# SDK v1.6.0 — StreamManager.matchEventType()
matchEventType = (expected, actual) =>
    expected === actual || actual.startsWith(`${expected}|`)
```

- `matchEventType("messages", "messages/partial")` → **false** (uses `/` not `|`)
- `matchEventType("messages", "messages")` → **true** ✅
- Only `values` event (exact match) gets processed → "all at once" delivery

### What We Send (OLD format)

```
event: messages/metadata
data: {"lc_run--xxx": {"metadata": {"langgraph_node": "agent", ...}}}

event: messages/partial
data: [{"content": "Hello world", "type": "ai", "id": "lc_run--xxx", ...}]

event: messages/complete
data: [{"content": "Hello world!", "type": "ai", "id": "lc_run--xxx", ...}]
```

**Two problems:**
1. Event type names use `/` separator (`messages/partial`) — SDK only matches `messages` or `messages|subgraph`
2. Content is **accumulated** (full text so far) — SDK expects **deltas** (new tokens only) and calls `.concat()` on message chunks

### What the SDK Expects (NEW `messages-tuple` format)

```
event: messages
data: [{"content": "Hello", "type": "ai", "id": "lc_run--xxx", ...}, {"langgraph_node": "agent", ...}]

event: messages
data: [{"content": " world", "type": "ai", "id": "lc_run--xxx", ...}, {"langgraph_node": "agent", ...}]

event: messages
data: [{"content": "!", "type": "ai", "id": "lc_run--xxx", ...}, {"langgraph_node": "agent", ...}]
```

Each event is a **2-element tuple**: `[message_chunk_delta, metadata_dict]`
- `message_chunk_delta.content` = only the **new token(s)**, not accumulated
- `metadata_dict` = flat dict with `langgraph_node`, `langgraph_checkpoint_ns`, etc.
- Event type is always `messages` (not `messages/partial` or `messages/complete`)

---

## Success Criteria

- [ ] SSE events use `event: messages` (not `messages/partial`, `messages/metadata`, `messages/complete`)
- [ ] Each `messages` event contains a `[message_delta, metadata]` tuple
- [ ] Message content is a **delta** (new token only), not accumulated
- [ ] Metadata dict is included inline (not in a separate event)
- [ ] `values`, `updates`, `metadata`, `error` events unchanged
- [ ] Existing tests pass (update as needed)
- [ ] New tests verify tuple format and delta content
- [ ] docproc-platform chat streams token-by-token in browser
- [ ] Docker image built and tested

---

## Files to Modify

### Primary Changes

| File | Change |
|------|--------|
| `robyn_server/routes/sse.py` | Replace `format_messages_partial_event` and `format_messages_metadata_event` with `format_messages_tuple_event` |
| `robyn_server/routes/streams.py` | Rewrite `execute_run_stream()` to emit delta-based `messages` tuple events with inline metadata |

### Secondary Changes

| File | Change |
|------|--------|
| `tests/` | Update SSE-related tests for new event format |

---

## Implementation Plan

### Step 1: Update `sse.py` — New event formatter

- Add `format_messages_tuple_event(message_delta, metadata)` that emits `event: messages` with `[delta, metadata]` tuple
- Keep old formatters temporarily (for backward compat reference) but mark as deprecated
- Remove `format_messages_partial_event` and `format_messages_metadata_event` (no longer needed)

### Step 2: Update `streams.py` — Delta-based streaming

In `execute_run_stream()`:

1. **On `on_chat_model_start`:**
   - Build metadata dict (flat, not nested under `metadata` key)
   - Store as `current_metadata` for reuse with each chunk
   - Emit initial empty-content delta: `event: messages` → `[{content: "", ...}, metadata]`

2. **On `on_chat_model_stream`:**
   - Extract `chunk_content` (the new token delta — already a delta from LangChain's `astream_events`)
   - Emit: `event: messages` → `[{content: chunk_content, ...}, metadata]`
   - Still accumulate content locally for final values event

3. **On `on_chat_model_end`:**
   - Emit final delta with `finish_reason` in `response_metadata`
   - Content delta should be empty string (all content already streamed)

4. **Remove** all `format_messages_metadata_event` and `format_messages_partial_event` calls

### Step 3: Update tests

- Verify `event: messages` format in SSE output
- Verify tuple structure `[message, metadata]`
- Verify content is delta, not accumulated
- Verify metadata contains `langgraph_node`

### Step 4: Version bump & release

- Bump version in `pyproject.toml`
- Update CHANGELOG.md
- Build Docker image
- Test against docproc-platform

---

## Key Insight: LangChain `astream_events` Already Yields Deltas

The current code **unnecessarily accumulates** content. Looking at `execute_run_stream()`:

```python
# on_chat_model_stream handler (current — WRONG)
chunk_content = chunk.content or ""
accumulated_content += chunk_content  # accumulates
partial_msg = create_ai_message(accumulated_content, ...)  # sends FULL text
yield format_messages_partial_event([partial_msg])
```

But `astream_events(version="v2")` already yields individual token deltas in `on_chat_model_stream`. The `chunk.content` IS the delta. We just need to stop accumulating and send the delta directly.

```python
# on_chat_model_stream handler (new — CORRECT)
chunk_content = chunk.content or ""
accumulated_content += chunk_content  # still accumulate for final values event
delta_msg = create_ai_message(chunk_content, ...)  # sends DELTA only
yield format_messages_tuple_event(delta_msg, current_metadata)
```

---

## Reference

- SDK source: `@langchain/langgraph-sdk/dist/ui/manager.js` → `StreamManager.matchEventType()`, `enqueue()`
- SDK source: `@langchain/langgraph-sdk/dist/ui/messages.js` → `MessageTupleManager.add()` (calls `.concat()` on chunks)
- docproc-platform session 44d scratchpad: full debugging trace confirming root cause
- LangGraph Protocol: the `|` separator is for subgraph namespacing (e.g., `messages|subgraph_name`), not event subtypes

---

## Completed Work

### 2026-02-20 — Implementation Complete ✅

**Branch:** `fix/sse-messages-tuple-protocol`

#### Changes Made

1. **`robyn_server/routes/sse.py`**
   - Removed `format_messages_partial_event()` (old `event: messages/partial`)
   - Removed `format_messages_metadata_event()` (old `event: messages/metadata`)
   - Added `format_messages_tuple_event(message_delta, metadata)` → emits `event: messages` with `[delta, metadata]` tuple

2. **`robyn_server/routes/streams.py`**
   - `on_chat_model_start`: builds flat metadata dict (not nested), emits initial empty-content delta as `event: messages` tuple
   - `on_chat_model_stream`: emits `chunk.content` directly as delta (was accumulating — `astream_events v2` already yields deltas!), still accumulates locally for final `values` event
   - `on_chat_model_end`: emits final empty-content delta with `finish_reason` in `response_metadata`
   - Removed all `format_messages_metadata_event()` and `format_messages_partial_event()` calls
   - Removed `emitted_metadata` flag (replaced by `current_ai_message_id` guard)

3. **`robyn_server/tests/test_streams.py`**
   - Updated imports and all tests for new `format_messages_tuple_event`
   - `test_format_messages_tuple_event`: verifies `event: messages`, 2-element tuple, content and metadata fields
   - `test_format_messages_tuple_event_empty_content`: verifies initial empty delta
   - `test_event_sequence_order`: updated sequence — no more `messages/metadata` event, uses `event: messages` tuples
   - `test_all_events_end_with_double_newline`: uses new tuple formatter
   - `test_execute_run_stream_streams_tokens`: **key test** — verifies content is DELTA not accumulated, verifies no old-format events, verifies tuple structure `[delta, metadata]`

4. **`pyproject.toml`**: version bump `0.0.1` → `0.0.2`
5. **`CHANGELOG.md`**: added `[0.0.2]` entry documenting the protocol fix

#### Test Results

- **442 passed**, 0 failed, 1 skipped (pre-existing placeholder)
- Linter: `ruff check` + `ruff format` — all clean

#### Verification via curl (against running robyn-runtime on localhost:8081)

**Before (old format):**
```
event: messages/metadata
data: {"lc_run--xxx": {"metadata": {"langgraph_node": "agent", ...}}}

event: messages/partial
data: [{"content": "Hello world", ...}]   ← accumulated, not delta
```

**After (new format):**
```
event: messages
data: [{"content": "", ...}, {"langgraph_node": "agent", ...}]   ← initial empty delta + inline metadata

event: messages
data: [{"content": "Hello", ...}, {"langgraph_node": "agent", ...}]   ← delta only

event: messages
data: [{"content": " world", ...}, {"langgraph_node": "agent", ...}]   ← delta only
```

#### Remaining

- [ ] Build Docker image and push to GHCR
- [ ] Test against docproc-platform chat UI (token-by-token streaming)
- [ ] Remove SSE rewriter TransformStream from docproc-platform proxy (no longer needed)
- [ ] Commit in docproc-platform: `feat(chat): add langgraph sdk chat integration`