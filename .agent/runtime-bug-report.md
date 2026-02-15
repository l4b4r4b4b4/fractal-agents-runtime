# Bug Report: SSE `values` Events Contain Partial State + History Endpoint Method Mismatch

**Severity:** High — breaks multi-turn chat display and branching features  
**Runtime:** robyn-runtime  
**SDK:** `@langchain/langgraph-sdk@1.6.0` (`useStream` React hook)  
**Discovered:** 2026-02-14, during E2E testing of chat branching (Task-10)

---

## Summary

Two issues in robyn-runtime's LangGraph Server API compatibility prevent the `useStream` React hook from working correctly for multi-turn conversations and branching:

1. **SSE `values` events contain only the current run's messages**, not the full accumulated thread state
2. **`POST /threads/{thread_id}/history` returns 404** — the endpoint only supports GET, but the SDK sends POST

---

## Bug 1: SSE `values` Events — Partial State During Streaming

### Expected Behavior (Official LangGraph Server)

When streaming a run via `POST /threads/{thread_id}/runs/stream` with `stream_mode: ["messages-tuple"]`, the `event: values` SSE events should contain the **full accumulated graph state**, including all messages from previous turns.

The `messages` key in the graph state uses LangGraph's `add_messages` reducer, which accumulates messages across turns. The `values` event represents the complete current state of the graph at that checkpoint.

For a thread with 3 previous turns (6 messages) and a new human message being processed:

```
event: values
data: {"messages": [H1, A1, H2, A2, H3, A3, H4]}   ← ALL messages (7 total)

event: messages
data: [<AI token chunk>, <metadata>]

event: values
data: {"messages": [H1, A1, H2, A2, H3, A3, H4, A4]}  ← ALL messages (8 total)
```

### Actual Behavior (robyn-runtime)

The first `values` event contains **only the new human message** from the current run input. Previous messages are omitted:

```
event: values
data: {"messages": [H4]}   ← ONLY the current run's input message (1 total) ❌

event: messages
data: [<AI token chunk>, <metadata>]

event: values
data: {"messages": [H1, A1, H2, A2, H3, A3, H4, A4]}  ← Full state after completion ✅
```

### Evidence

Raw SSE capture from `curl` against robyn-runtime with a thread containing 6 existing messages:

**First `values` event (at stream start):**
```json
event: values
data: {"messages":[{"content":"Antworte nur mit: OK","type":"human","id":"fbff1bf1-..."}]}
```
→ Only 1 message (the new input). Missing all 6 previous messages.

**Final `values` event (after completion):**
```json
event: values
data: {"messages":[...all 8 messages...]}
```
→ Correct — all messages present after the run finishes.

### Impact on Frontend

The `useStream` hook uses `stream.messages` (derived from `values` events) as the single source of truth for rendering. When the first `values` event arrives with only 1 message:

1. The optimistic state (all previous messages + new human message) is **replaced** by the server's partial state
2. All previous messages **disappear** from the UI
3. Only the current turn's messages are visible during the entire streaming duration
4. After streaming completes, the final `values` event restores all messages

**Debug log from React component during streaming:**
```
stream.messages=4 display=4 isLoading=false types=human,ai,human,ai   ← idle, 2 turns
stream.messages=5 display=5 isLoading=true  types=human,ai,human,ai,human  ← optimistic add ✅
stream.messages=1 display=1 isLoading=true  types=human                    ← SSE replaces! ❌
stream.messages=2 display=2 isLoading=true  types=human,ai                 ← only current turn
```

### Root Cause (Hypothesis)

The runtime likely emits the first `values` event from the **run input** rather than from the **full checkpoint state**. The input to a run is `{"messages": [<new message>]}`, which is the delta — not the accumulated state. The runtime should resolve the full checkpoint state (which includes all previous messages via the `add_messages` reducer) before emitting the first `values` event.

### Fix

The first `values` event emitted after `event: metadata` must contain the **complete graph state at the current checkpoint**, not just the run input. This means:

1. Load the thread's current checkpoint state
2. Apply the run input (the `add_messages` reducer appends the new message)
3. Emit the resulting full state as the first `values` event

The final `values` event already does this correctly — the same logic should be applied to the initial event.

---

## Bug 2: `POST /threads/{thread_id}/history` Returns 404

### Expected Behavior (Official LangGraph Server API)

The thread history endpoint accepts **POST** requests with an optional JSON body for filtering:

```
POST /threads/{thread_id}/history
Content-Type: application/json

{"limit": 10}
```

Response: Array of `ThreadState` objects representing the checkpoint history tree.

Reference: The `@langchain/langgraph-sdk` client calls `client.threads.getHistory(threadId)` which sends a POST request. The `useStream` hook with `fetchStateHistory: true` also uses POST.

### Actual Behavior (robyn-runtime)

- `GET /threads/{thread_id}/history` → 200 OK ✅ (returns history correctly)
- `POST /threads/{thread_id}/history` → 404 Not Found ❌

### Evidence

```bash
# GET works
curl -X GET http://localhost:8081/threads/{id}/history \
  -H "Authorization: Bearer $TOKEN"
# → 200, returns array of ThreadState objects

# POST fails
curl -X POST http://localhost:8081/threads/{id}/history \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"limit": 5}'
# → 404 Not Found
```

### Impact on Frontend

The `useStream` hook requires `fetchStateHistory: true` to enable branching features (`setBranch()`, `getMessagesMetadata()` with `branch`/`branchOptions`, time-travel). When enabled, the hook sends `POST /threads/{thread_id}/history` on mount and after each run completes.

The 404 causes:
- An unhandled `HTTPError: HTTP 404: Not found` in the browser console
- `stream.getMessagesMetadata(message)` returns no branch information
- `stream.setBranch()` cannot navigate between branches
- The `BranchSwitcher` UI component cannot function

### Current Workaround

We added a method conversion in our Next.js API proxy that converts `POST → GET` for the history endpoint:

```typescript
// In our /api/langgraph/[...path]/route.ts proxy
const useGetForHistory =
  request.method === "POST" && isThreadHistoryPath(pathSegments);
const effectiveMethod = useGetForHistory ? "GET" : request.method;
```

This works but discards the POST body (filter parameters like `limit`, `before`, `checkpoint`), so filtering is not supported.

### Fix

Register a POST handler for `/threads/{thread_id}/history` that accepts the same filter parameters as the GET endpoint. The POST body should support at minimum:

```json
{
  "limit": 10,        // Max number of states to return
  "before": "...",     // Checkpoint ID to paginate before
  "metadata": {},      // Filter by metadata
  "checkpoint": {}     // Filter by specific checkpoint
}
```

---

## Reproduction Steps

### Bug 1 (Partial SSE State)

1. Create a thread and complete 2+ turns of conversation
2. Send a new message via `POST /threads/{id}/runs/stream` with `stream_mode: ["messages-tuple"]`
3. Observe the first `event: values` SSE event
4. **Expected:** All messages (previous turns + new input)
5. **Actual:** Only the new input message

### Bug 2 (History POST 404)

1. Create a thread with at least one completed run
2. Send `POST /threads/{id}/history` with `{"limit": 5}`
3. **Expected:** 200 with array of ThreadState objects
4. **Actual:** 404 Not Found

---

## Environment

- **robyn-runtime:** Running locally via `docker compose`, port 8081
- **SDK:** `@langchain/langgraph-sdk@1.6.0`
- **Frontend:** Next.js 16.1.6 with `useStream` hook
- **LLM:** `gpt-4o-mini` via OpenAI
- **Checkpointer:** PostgreSQL (via robyn-runtime's built-in checkpointer)