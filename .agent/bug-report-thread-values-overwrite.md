# Bug: `execute_run_stream()` Overwrites Thread Values With Only Current Run Messages

**Component:** `server/routes/streams.py` → `execute_run_stream()`  
**Also affects:** `server/agent.py` → `execute_agent_run()` (non-streaming path)  
**Severity:** High — breaks `useStream` thread history loading for all frontend consumers  
**Runtime version:** `fractal-agents-runtime` v0.0.2  
**Status:** 🔴 Confirmed  
**Discovered:** 2026-02-14 (docproc-platform Goal 43, Sessions 93–94)

---

## Summary

After a run completes, `execute_run_stream()` writes only the **current run's messages** (1 human + 1 AI) to `threads.values`, discarding the full accumulated conversation history. The LangGraph checkpointer (`AsyncPostgresSaver`) correctly maintains the complete history across runs — the LLM remembers everything — but the manually-written `threads.values` contains only the latest pair.

When `useStream` from `@langchain/langgraph-sdk` loads an existing thread via `GET /threads/{id}/state`, it receives only the last 2 messages instead of the full conversation. This breaks chat history display on page reload and navigation.

The same bug exists in the non-streaming path (`execute_agent_run()` in `server/agent.py`).

---

## Expected Behavior

Per LangGraph documentation and the `useStream` hook contract:

- `GET /threads/{id}/state` should return the **full accumulated thread state**, including all messages from all runs
- `useStream({ threadId })` should populate `messages` with "All messages in the current thread, including both human and AI messages" ([LangChain docs](https://docs.langchain.com/oss/javascript/langchain/streaming/frontend))
- `create_agent` from `langchain` uses `messages: Annotated[list[AnyMessage], add_messages]` — an **append reducer** that accumulates messages across runs via the checkpointer
- `threads.values.messages` should grow with each run, not be replaced

## Actual Behavior

- `threads.values.messages` always contains exactly **2 messages** (the latest human + AI pair), regardless of how many runs have been executed
- `GET /threads/{id}/state` returns only these 2 messages
- `useStream` on the frontend shows only the last exchange on page reload, not full history
- The agent **does** remember context across runs (the LLM gets full history via the checkpointer), confirming the checkpointer works correctly

---

## Root Cause: Two Disconnected State Systems

The runtime maintains **two parallel state systems** that are not synchronized:

1. **LangGraph Checkpointer** (`AsyncPostgresSaver`) — writes to `checkpoints` / `checkpoint_blobs` / `checkpoint_writes` tables. Uses `add_messages` append reducer. Contains the **full accumulated history**. Works correctly.

2. **Custom Storage** (`PostgresStorage`) — writes to `langgraph_server.threads.values` and `langgraph_server.thread_states`. Manually built from `all_messages` which only contains the current run. **Overwrites on every run.**

`GET /threads/{id}/state` reads from system #2, not system #1.

### Root Cause Diagram

```
Run N arrives with: {"messages": [HumanMessage("hello again")]}
                            │
                            ▼
            ┌───────────────────────────────┐
            │  Checkpointer (AsyncPostgres) │
            │  Loads Run 1..N-1 messages    │
            │  + appends Run N messages     │
            │  = FULL HISTORY (correct) ✅  │
            └───────────────────────────────┘
                            │
                 LLM sees full history ✅
                            │
                            ▼
            ┌───────────────────────────────┐
            │  execute_run_stream()         │
            │  all_messages = [human, ai]   │
            │  = ONLY RUN N (2 messages) ❌ │
            └───────────────────────────────┘
                            │
                            ▼
            ┌───────────────────────────────┐
            │  storage.threads.update()     │
            │  threads.values = {           │
            │    "messages": [human, ai]    │
            │  }                            │
            │  = OVERWRITES with 2 msgs ❌  │
            └───────────────────────────────┘
                            │
                            ▼
            ┌───────────────────────────────┐
            │  GET /threads/{id}/state      │
            │  Reads threads.values         │
            │  Returns 2 messages ❌        │
            │  (useStream sees broken       │
            │   history on thread resume)   │
            └───────────────────────────────┘
```

---

## Detailed Code Analysis

### 1. `execute_run_stream()` — `server/routes/streams.py`

#### `all_messages` initialization (line ~643)

`all_messages` is seeded from `initial_values["messages"]`, which contains **only the input messages of the current run** (typically one `HumanMessage`):

```python
# streams.py L598-601 — initial_values built from current run's input only
initial_values = {"messages": [_message_to_dict(m) for m in input_messages]}
yield format_values_event(initial_values)
```

```python
# streams.py L643 — all_messages starts with ONLY current run's inputs
all_messages: list[dict[str, Any]] = list(initial_values["messages"])
```

#### `final_values` construction (lines ~779-793)

After streaming, the single AI response is appended:

```python
# streams.py L779-793
if final_ai_message_dict:
    all_messages.append(final_ai_message_dict)
elif accumulated_content and current_ai_message_id:
    final_ai_message_dict = create_ai_message(
        accumulated_content,
        current_ai_message_id,
        finish_reason="stop",
        model_provider="openai",
    )
    all_messages.append(final_ai_message_dict)

final_values = {"messages": all_messages}
yield format_values_event(final_values)
```

**Result:** `final_values` = `{"messages": [human_msg, ai_msg]}` — just the current turn.

#### Storage writes (lines ~795-798)

```python
# streams.py L795-798
await storage.threads.add_state_snapshot(thread_id, final_values, owner_id)
await storage.threads.update(thread_id, {"values": final_values}, owner_id)
```

Overwrites `threads.values` with only the latest 2-message pair **every run**.

#### Key observation

The checkpointer (`cp`) is used inside the `async with` block (lines 620-793) and the agent's `astream_events` correctly accumulates messages. But `final_values` is built **independently** from `all_messages` which never reads from the checkpointer. After the `async with` block exits, the checkpointer connection is closed, and then the manually-built `final_values` (with only 2 messages) is written to `threads.values`.

---

### 2. `PostgresThreadStore` — `server/postgres_storage.py`

#### `update()` (lines 531-592) — plain overwrite

```python
async def update(self, resource_id: str, data: dict[str, Any], owner_id: str) -> Thread | None:
    # ...
    if "values" in data:
        updates["values"] = _json_dumps(data["values"])
    # ...
    await connection.execute(
        f"""
        UPDATE {_SCHEMA}.threads
        SET {", ".join(set_parts)}
        WHERE id = %s AND metadata->>'owner' = %s
        """,
        tuple(values),
    )
```

No merging, no accumulation — a plain overwrite of the JSON column.

#### `get_state()` (lines 606-645) — reads from wrong source

```python
async def get_state(self, thread_id: str, owner_id: str) -> ThreadState | None:
    async with self._get_connection() as connection:
        result = await connection.execute(
            f"""
            SELECT id, metadata, values
            FROM {_SCHEMA}.threads
            WHERE id = %s AND metadata->>'owner' = %s
            """,
            (thread_id, owner_id),
        )
        thread_row = await result.fetchone()
    # ...
    return ThreadState(
        values=thread_values,    # ← reads from threads.values (only 2 messages)
        next=[],
        tasks=[],
        checkpoint={
            "thread_id": thread_id,
            "checkpoint_ns": "",
            "checkpoint_id": _generate_id(),  # ← generates a FAKE checkpoint_id!
        },
    )
```

**Critical:** `get_state()` returns `threads.values` (manually written, only 2 messages) and fabricates a new `checkpoint_id` on every call. It never touches the `checkpoints` / `checkpoint_blobs` / `checkpoint_writes` tables managed by `AsyncPostgresSaver`.

#### `add_state_snapshot()` (lines 647-694) — parallel system

Writes to a custom `thread_states` table (not the LangGraph checkpointer tables) and also overwrites `threads.values`:

```python
async def add_state_snapshot(self, thread_id: str, state: dict[str, Any], owner_id: str) -> bool:
    snapshot_values = state.get("values", {})
    # Insert into custom thread_states table
    await connection.execute(
        f"""INSERT INTO {_SCHEMA}.thread_states (...) VALUES (...)""",
        # ...
    )
    # Also overwrite threads.values
    await connection.execute(
        f"""UPDATE {_SCHEMA}.threads SET values = %s, updated_at = %s WHERE id = %s""",
        (_json_dumps(snapshot_values), now, thread_id),
    )
```

This is a **parallel state tracking system** disconnected from the LangGraph checkpointer.

---

### 3. `GET /threads/{id}/state` — `server/routes/threads.py`

```python
@app.get("/threads/:thread_id/state")
async def get_thread_state(request: Request) -> Response:
    storage = get_storage()
    state = await storage.threads.get_state(thread_id, user.identity)
    return json_response(state)
```

Calls `storage.threads.get_state()` which reads from `threads.values` column. **Does NOT query the checkpointer.** Returns only the last 2-message pair.

---

### 4. Checkpointer — `server/database.py`

```python
@asynccontextmanager
async def checkpointer() -> AsyncGenerator["AsyncPostgresSaver | None", None]:
    if not _database_url:
        yield None
        return
    from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver as _AsyncPostgresSaver
    async with _AsyncPostgresSaver.from_conn_string(_database_url) as saver:
        yield saver
```

Creates a per-request `AsyncPostgresSaver`. The checkpointer is injected into the agent and used during `astream_events`, but the accumulated state is **never read back** after the run completes. There is no code anywhere in the codebase that calls `cp.aget()`, `cp.alist()`, `agent.aget_state()`, or similar to read back from the checkpointer. It is write-only from the runtime's perspective.

---

### 5. Same Bug in Non-Streaming Path — `server/agent.py`

`execute_agent_run()` has the identical bug:

```python
# server/agent.py L230-247
final_messages: list[dict[str, Any]] = []
for msg in result.get("messages", []):
    # ... serialize messages from result ...

final_values = {"messages": final_messages}
await storage.threads.add_state_snapshot(thread_id, final_values, owner_id)
await storage.threads.update(thread_id, {"values": final_values}, owner_id)
```

`result.get("messages", [])` comes from `agent.ainvoke()` which returns only the messages from the **current invocation input + output**, not the full accumulated checkpoint state. Same overwrite behavior.

---

## Evidence from Live Testing

### Test scenario: 4 message exchanges in one thread

1. Send: "Mein Name ist Luke" → AI responds with greeting
2. Send: "Ich arbeite bei AIS Management in München" → AI acknowledges
3. Send: "Wie ist mein Name?" → AI responds: "Dein Name ist Luke"
4. Send: "Fasse zusammen was du über mich weißt" → AI responds: "Dein Name ist Luke, du arbeitest bei AIS Management in München"

Agent **correctly remembers** all context across all 4 runs (checkpointer works ✅).

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
-- 4 checkpoints exist (one per run) — checkpointer is correct
SELECT count(*) FROM langgraph_server.thread_states
WHERE thread_id = 'a897381493de4902b9ad26c43f51f94e';
-- Result: 4

-- But thread_states.values is empty {} — add_state_snapshot writes empty values
SELECT values FROM langgraph_server.thread_states
WHERE thread_id = 'a897381493de4902b9ad26c43f51f94e'
ORDER BY created_at DESC LIMIT 1;
-- Result: {}
```

### Frontend behavior

- During an active session (without page reload), messages display correctly because `useStream` manages state client-side during streaming
- On **page reload** or **navigation back** to the chat, `useStream` calls `GET /threads/{id}/state` and receives only the last 2 messages
- Full conversation history is lost from the UI perspective

---

## Suggested Fix

### Option A: Read from checkpointer after run (recommended)

After `astream_events` completes but **before** exiting the `async with create_checkpointer() as cp` block, read the accumulated state from the checkpointer and use it as `final_values`:

```python
# In execute_run_stream(), inside the `async with create_checkpointer() as cp` block,
# AFTER the astream_events loop completes:

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
# ... then write final_values to storage as before
```

Apply the same fix to `execute_agent_run()` in `server/agent.py`:

```python
# After agent.ainvoke(), read accumulated state:
checkpoint_state = await agent.aget_state(runnable_config)
if checkpoint_state and checkpoint_state.values:
    accumulated_messages = checkpoint_state.values.get("messages", [])
    final_values = {"messages": [_message_to_dict(m) for m in accumulated_messages]}
else:
    final_values = {"messages": final_messages}
```

**Key constraint:** The checkpointer read MUST happen inside the `async with create_checkpointer() as cp` block, before the context manager closes the connection.

### Option B: Read from checkpointer in `get_state()`

Modify `PostgresThreadStore.get_state()` to query the LangGraph checkpointer tables instead of `threads.values`. This avoids double-writing but is more complex — need to instantiate a checkpointer in the read path and handle the `add_messages` reducer deserialization.

### Option C: Accumulate manually

Before building `all_messages` in `execute_run_stream()`, read existing `threads.values` and prepend those messages. This is fragile and duplicates the checkpointer's job.

### Recommendation

**Option A** is cleanest. It leverages the checkpointer that's already doing the right thing and just reads from it. Minimal changes, keeps the existing storage structure, but populates it with the correct accumulated data.

---

## Affected Files

| File | Lines | Issue |
|------|-------|-------|
| `src/server/routes/streams.py` | 598, 643, 795-798 | `all_messages` only contains current run's messages |
| `src/server/postgres_storage.py` | 606-645 | `get_state()` reads from `threads.values`, not checkpointer |
| `src/server/postgres_storage.py` | 531-592 | `update()` overwrites `values` column |
| `src/server/postgres_storage.py` | 647-694 | `add_state_snapshot()` writes only current run's messages |
| `src/server/routes/threads.py` | 153-172 | Route handler uses `get_state()` (reads stale values) |
| `src/server/agent.py` | 230-247 | Same bug in non-streaming `execute_agent_run()` |
| `src/server/database.py` | 183-207 | `checkpointer()` CM — correct, but never read from |
| `src/graphs/react_agent/agent.py` | 488-496 | `create_agent` uses `add_messages` reducer — correct |

---

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

---

## How to Reproduce

1. Start the runtime with Postgres persistence (`PERSISTENCE=postgres`)
2. Create a thread: `POST /threads`
3. Send message 1: `POST /threads/{id}/runs/stream` with `{"input": {"messages": [{"type": "human", "content": "My name is Luke"}]}}`
4. Wait for completion
5. Send message 2: `POST /threads/{id}/runs/stream` with `{"input": {"messages": [{"type": "human", "content": "What is my name?"}]}}`
6. Wait for completion — agent correctly responds "Your name is Luke" (checkpointer works)
7. Check state: `GET /threads/{id}/state`
8. **Bug**: `values.messages` contains only 2 messages (message 2 + response), not all 4
9. Reload the page — `useStream` shows only the last pair, full history lost
