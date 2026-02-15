# Bug Investigation: Message History Storage

**Date:** 2025-07-17  
**Status:** 🔴 Confirmed  
**Severity:** High — breaks `useStream` thread resumption in `@langchain/langgraph-sdk`

---

## Summary

`execute_run_stream()` builds `all_messages` from **only the current run's input messages**, then writes `{"messages": [human, ai]}` (just the latest pair) to `threads.values`. The LangGraph checkpointer correctly accumulates all messages across runs (the LLM remembers context), but `GET /threads/{id}/state` returns the manually-written `threads.values` with only 2 messages instead of the full checkpointer state.

This breaks `useStream` from `@langchain/langgraph-sdk` — when it loads an existing thread, it gets only the last message pair instead of the full history.

---

## 1. `execute_run_stream()` in `server/routes/streams.py`

### `all_messages` initialization (line 643)

`all_messages` is seeded from `initial_values["messages"]`, which contains **only the input messages of the current run** (typically a single `HumanMessage`):

```python
# streams.py L598-601 — initial_values built from current run's input only
initial_values = {"messages": [_message_to_dict(m) for m in input_messages]}
yield format_values_event(initial_values)
```

```python
# streams.py L643 — all_messages starts with ONLY current run's inputs
all_messages: list[dict[str, Any]] = list(initial_values["messages"])
```

### `final_values` construction (lines 779-793)

After streaming completes, the single AI response is appended:

```python
# streams.py L779-793
if final_ai_message_dict:
    all_messages.append(final_ai_message_dict)
elif accumulated_content and current_ai_message_id:
    # Fallback: create AI message from accumulated content
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

### Storage writes (lines 795-798)

```python
# streams.py L795-798
# Store the final state in the thread (outside the checkpointer/store
# context — uses PostgresStorage which has its own connections).
await storage.threads.add_state_snapshot(thread_id, final_values, owner_id)
await storage.threads.update(thread_id, {"values": final_values}, owner_id)
```

This overwrites `threads.values` with only the latest 2-message pair **every run**.

### Key observation

The checkpointer (`cp`) is used inside the `async with` block (lines 620-793) and the agent's `astream_events` correctly accumulates messages in the checkpoint. But `final_values` is built **independently** from `all_messages` which never reads from the checkpointer. After the `async with` block exits, the checkpointer connection is closed, and then the manually-built `final_values` (with only 2 messages) is written to `threads.values`.

---

## 2. `PostgresThreadStore` in `server/postgres_storage.py`

### `update()` (lines 531-592)

Directly overwrites the `values` column in the `threads` table:

```python
# postgres_storage.py L531-592
async def update(
    self, resource_id: str, data: dict[str, Any], owner_id: str
) -> Thread | None:
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

### `get_state()` (lines 606-645)

Reads **only** from `langgraph_server.threads` table — does **NOT** query the LangGraph checkpointer:

```python
# postgres_storage.py L606-645
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

    if thread_row is None:
        return None

    thread_values = thread_row.get("values", {})
    if isinstance(thread_values, str):
        thread_values = json.loads(thread_values)

    # ...
    return ThreadState(
        values=thread_values,    # <-- reads from threads.values column
        next=[],
        tasks=[],
        checkpoint={
            "thread_id": thread_id,
            "checkpoint_ns": "",
            "checkpoint_id": _generate_id(),  # <-- generates a FAKE checkpoint_id
        },
        # ...
    )
```

**Critical:** `get_state()` returns `threads.values` (manually written, only 2 messages) and fabricates a new `checkpoint_id` on every call. It never touches the `checkpoints` / `checkpoint_blobs` / `checkpoint_writes` tables managed by `AsyncPostgresSaver`.

### `add_state_snapshot()` (lines 647-694)

Writes to a custom `thread_states` table (not the LangGraph checkpointer tables) and also overwrites `threads.values`:

```python
# postgres_storage.py L647-694
async def add_state_snapshot(
    self, thread_id: str, state: dict[str, Any], owner_id: str
) -> bool:
    # ...
    snapshot_values = state.get("values", {})

    # Insert into custom thread_states table
    await connection.execute(
        f"""
        INSERT INTO {_SCHEMA}.thread_states
            (thread_id, values, metadata, next, tasks, checkpoint_id,
             parent_checkpoint, interrupts)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
        """,
        # ...
    )

    # Also overwrite threads.values
    await connection.execute(
        f"""
        UPDATE {_SCHEMA}.threads
        SET values = %s, updated_at = %s
        WHERE id = %s
        """,
        (_json_dumps(snapshot_values), now, thread_id),
    )
```

This is a **parallel** state tracking system that is disconnected from the LangGraph checkpointer.

---

## 3. `GET /threads/{thread_id}/state` route in `server/routes/threads.py`

```python
# threads.py L153-172
@app.get("/threads/:thread_id/state")
async def get_thread_state(request: Request) -> Response:
    # ...
    storage = get_storage()
    state = await storage.threads.get_state(thread_id, user.identity)

    if state is None:
        return error_response(f"Thread {thread_id} not found", 404)

    return json_response(state)
```

Calls `storage.threads.get_state()` which reads from the `threads.values` column (see §2 above). **Does NOT query the checkpointer.** Returns only the last 2-message pair.

---

## 4. Checkpointer Integration in `server/database.py`

### `checkpointer()` context manager (lines 183-207)

```python
# database.py L183-207
@asynccontextmanager
async def checkpointer() -> AsyncGenerator["AsyncPostgresSaver | None", None]:
    if not _database_url:
        yield None
        return

    from langgraph.checkpoint.postgres.aio import (
        AsyncPostgresSaver as _AsyncPostgresSaver,
    )

    async with _AsyncPostgresSaver.from_conn_string(_database_url) as saver:
        yield saver
```

Creates a per-request `AsyncPostgresSaver` with its own connection. The checkpointer is injected into the agent at build time and used during `astream_events`, but the accumulated state is **never read back** after the run.

### Does the runtime read from the checkpointer after a run?

**No.** After `execute_run_stream()` exits the `async with create_checkpointer() as cp` block (line 620), the checkpointer connection is closed. The `final_values` written to storage are built from the manually-tracked `all_messages` list, not from the checkpointer.

### Is there code that reconstructs full message history from checkpoints?

**No.** There is no code anywhere in the codebase that calls `cp.aget()`, `cp.alist()`, or similar to read back accumulated state from the LangGraph checkpoint tables. The checkpointer is write-only from the runtime's perspective.

---

## 5. `create_agent` State Annotation

### Import and call site

```python
# graphs/react_agent/agent.py L4
from langchain.agents import create_agent
```

```python
# graphs/react_agent/agent.py L488-496
return create_agent(
    model=model,
    tools=tools,
    system_prompt=effective_system_prompt + UNEDITABLE_SYSTEM_PROMPT,
    checkpointer=checkpointer,
    store=store,
)
```

### State annotation

Per the LangChain v1 docs, `create_agent` uses a `TypedDict` state with `messages: Annotated[list[AnyMessage], add_messages]` — an **append reducer**. This means:

- When the agent is invoked with `{"messages": [HumanMessage]}`, the checkpointer loads prior messages from the checkpoint, and `add_messages` appends the new one.
- The checkpointer accumulates the **full conversation history** across runs.
- The LLM sees all prior messages — which is why multi-turn conversations work correctly from the model's perspective.

The disconnect is that the runtime **never reads this accumulated state back** from the checkpointer. It manually tracks `all_messages` from scratch each run.

---

## Root Cause Diagram

```
Run N arrives with: {"messages": [HumanMessage("hello again")]}
                            │
                            ▼
            ┌───────────────────────────────┐
            │  Checkpointer (AsyncPostgres) │
            │  Loads Run 1..N-1 messages    │
            │  + appends Run N messages     │
            │  = FULL HISTORY (correct)     │
            └───────────────────────────────┘
                            │
                 LLM sees full history ✅
                            │
                            ▼
            ┌───────────────────────────────┐
            │  execute_run_stream()         │
            │  all_messages = [human, ai]   │
            │  = ONLY RUN N (2 messages)    │
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

## Fix Strategy (Not Yet Implemented)

The fix should do one of the following:

### Option A: Read from checkpointer after run (recommended)

After `astream_events` completes but **before** exiting the `async with create_checkpointer()` block, read the accumulated state from the checkpointer:

```python
# Inside the async with block, after streaming:
checkpoint_state = await agent.aget_state(runnable_config)
full_messages = checkpoint_state.values.get("messages", [])
# Serialize full_messages to dicts
final_values = {"messages": [serialize(m) for m in full_messages]}
```

Then write `final_values` to storage. This ensures `threads.values` contains the full accumulated history.

### Option B: Read from checkpointer in `get_state()`

Modify `PostgresThreadStore.get_state()` to query the LangGraph checkpointer tables (`checkpoints`, `checkpoint_blobs`) instead of `threads.values`. This is more complex but avoids double-writing.

### Option C: Accumulate manually

In `execute_run_stream()`, before building `all_messages`, read the existing `threads.values` from storage and prepend those messages. This is fragile and duplicates the checkpointer's job.

**Recommendation:** Option A is cleanest. It leverages the checkpointer that's already doing the right thing and just reads from it.

---

## Affected Files

| File | Lines | Issue |
|------|-------|-------|
| `apps/python/src/server/routes/streams.py` | 598, 643, 795-798 | `all_messages` only contains current run's messages |
| `apps/python/src/server/postgres_storage.py` | 606-645 | `get_state()` reads from `threads.values`, not checkpointer |
| `apps/python/src/server/postgres_storage.py` | 531-592 | `update()` overwrites `values` column |
| `apps/python/src/server/postgres_storage.py` | 647-694 | `add_state_snapshot()` writes only current run's messages |
| `apps/python/src/server/routes/threads.py` | 153-172 | Route handler uses `get_state()` (reads stale values) |
| `apps/python/src/server/agent.py` | 230-247 | Same bug in non-streaming `execute_agent_run()` |
| `apps/python/src/server/database.py` | 183-207 | `checkpointer()` CM — correct, but never read from |
| `apps/python/src/graphs/react_agent/agent.py` | 488-496 | `create_agent` uses `add_messages` reducer — correct |

---

## Same Bug in Non-Streaming Path (`server/agent.py`)

The `execute_agent_run()` function has the identical bug:

```python
# server/agent.py L230-247
final_messages: list[dict[str, Any]] = []
for msg in result.get("messages", []):
    # ... serialize messages from result ...

final_values = {"messages": final_messages}
await storage.threads.add_state_snapshot(thread_id, final_values, owner_id)
await storage.threads.update(thread_id, {"values": final_values}, owner_id)
```

Here `result.get("messages", [])` comes from `agent.ainvoke()` which returns only the messages from the **current invocation input + output**, not the full accumulated checkpoint state. Same overwrite behavior.