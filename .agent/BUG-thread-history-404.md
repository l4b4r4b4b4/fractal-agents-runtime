# Consolidated Bug Report: fractal-agents-runtime (Python + TypeScript)

**Date:** 2026-02-15
**Reporter:** docproc-platform frontend team
**Runtime image:** `fractal-agents-runtime-python:local-dev`
**Robyn version:** `0.76.0`
**Persistence:** Postgres-backed (`DATABASE_URL` pointing to Supabase Postgres)

This report consolidates ALL known bugs and issues observed from the frontend when interacting with the robyn-runtime. Bugs are ordered by severity and impact on multi-user chat functionality.

---

## Table of Contents

1. [BUG-A: `GET /threads/{id}/history` returns 404 for persisted threads](#bug-a-get-threadsidhistory-returns-404-for-persisted-threads)
2. [BUG-B: SSE `values` events contain partial state during streaming](#bug-b-sse-values-events-contain-partial-state-during-streaming)
3. [BUG-C: `POST /threads/{id}/history` not supported (SDK default method)](#bug-c-post-threadsidhistory-not-supported-sdk-default-method)
4. [BUG-D: MCP tools fetch fails on every agent invocation](#bug-d-mcp-tools-fetch-fails-on-every-agent-invocation)
5. [BUG-E: Agent hallucinating tools it doesn't have](#bug-e-agent-hallucinating-tools-it-doesnt-have)
6. [FIXED: `threads.values` only stores last 2 messages](#fixed-threadsvalues-only-stores-last-2-messages)
7. [FIXED: asyncio.Lock bound to different event loop](#fixed-asynciolock-bound-to-different-event-loop)
8. [Proxy Workaround in docproc-platform](#proxy-workaround-in-docproc-platform)
9. [Environment & Schema Reference](#environment--schema-reference)

---

## BUG-A: `GET /threads/{id}/history` returns 404 for persisted threads

**Severity:** 🔴 High — blocks any client that loads an existing thread (single-user AND multi-user)
**Status:** 🟢 Fixed (Python + TypeScript runtimes)
**Discovered:** Session 104 (2026-02-15)
**Fixed:** Session 105 (2026-02-15)

### ⚠️ NOT a multi-user-only bug

This bug is **not specific to multi-user chat**. It affects ANY scenario where `useStream` mounts with an existing `threadId`, including:

- **Single user: page refresh** — User sends a message, refreshes the browser → `useStream` re-mounts with stored `threadId` → 404
- **Single user: navigate away and back** — User goes to `/dashboard`, returns to `/dashboard/chat/{id}` → component re-mounts → 404
- **Single user: second tab** — User opens the same chat URL in a new browser tab → 404
- **Multi-user: second participant** — User B opens a chat that User A created → 404

The reason it was discovered in a multi-user context is that the second user immediately triggers a fresh mount of `useStream` with the existing `threadId`. But the exact same failure would happen for a single user who refreshes their page after sending the first message.

**Why the thread creator doesn't see it (yet):** Their `useStream` React component has been alive since the thread was created — the thread state is still in client-side memory from the original stream. The component never unmounted and re-fetched. The moment they refresh, they'd hit the same 404.

Any fix for this bug will work for both single-user and multi-user cases — it's a core persistence lookup issue, not a concurrency or access control edge case.

### Summary

When any client opens a chat page for an existing thread, `useStream` (from `@langchain/langgraph-sdk`) calls the thread history endpoint to load state. The runtime returns **HTTP 404** with `{"detail": "Thread {id} not found"}`, even though the thread and all its data are fully persisted in Postgres.

The only client that avoids this is one whose `useStream` component has been continuously mounted since the thread was created — because it still has the state in client memory and never calls the history endpoint.

### Impact

- **Any page reload breaks chat** — even for the thread creator (single-user)
- **Multi-user chat is broken** — second participant cannot load the thread at all
- **Navigation breaks chat** — leaving the chat page and returning triggers the bug
- Any client that mounts `useStream` with an existing `threadId` will fail

### Reproduction Steps (single-user — simplest case)

1. **User A** opens a chat and sends a message → agent responds → thread is created. No errors.
2. **User A refreshes the page** (F5 / Ctrl+R).
3. `useStream` re-mounts with the stored `threadId` (from `chat_sessions.thread_id`).
4. `useStream` calls the history endpoint for the thread.
5. Runtime returns **404**: `{"detail": "Thread ef4610b831e54f8c882cb5746d3cc82c not found"}`
6. User A sees error toast — their own thread is inaccessible.

### Reproduction Steps (multi-user — how it was discovered)

1. **User A** opens a chat and sends a message → agent responds → thread is created. No errors.
2. **User B** opens the **same chat** in a different browser session.
3. User B's `useStream` hook initializes with the existing `threadId` (from `chat_sessions.thread_id`).
4. `useStream` calls the history endpoint for the thread.
5. Runtime returns **404**: `{"detail": "Thread ef4610b831e54f8c882cb5746d3cc82c not found"}`
6. User B sees error toast.

### Evidence: Thread Data EXISTS in Postgres

**`langgraph_server.threads` table:**

| Column       | Value                                                    |
| ------------ | -------------------------------------------------------- |
| `id`         | `ef4610b831e54f8c882cb5746d3cc82c`                       |
| `status`     | `idle`                                                   |
| `metadata`   | `{"owner": "a1b2c3d4-e5f6-7890-abcd-ef1234567890"}`     |
| `created_at` | `2026-02-15 14:06:51.212523+00`                          |
| `updated_at` | `2026-02-15 14:06:53.625293+00`                          |

**`langgraph_server.runs` table:**

| Column         | Value                                  |
| -------------- | -------------------------------------- |
| `id`           | `47b12609691b41f59ebe9fa23106fe04`      |
| `thread_id`    | `ef4610b831e54f8c882cb5746d3cc82c`      |
| `assistant_id` | `a0000000-0000-4000-a000-000000000002` |
| `status`       | `success`                              |

**`langgraph_server.thread_states` table:**

| `thread_id`                        | `checkpoint_id`                        |
| ---------------------------------- | -------------------------------------- |
| `ef4610b831e54f8c882cb5746d3cc82c` | `599a6a413f274cce8f201f52c1bde71e`     |

**`public.checkpoints` table (3 entries):**

| `checkpoint_id`                              | `parent_checkpoint_id`  | `step` | `source` |
| -------------------------------------------- | ----------------------- | ------ | -------- |
| `1f10a779-3990-65b1-bfff-ddf7e8bb9fb0`       | `null`                  | `-1`   | `input`  |
| `1f10a779-3994-6d77-8000-40482351af12`       | `1f10a779-3990-...`     | `0`    | `loop`   |
| `1f10a779-4984-6d07-8001-4b522e830fd4`       | `1f10a779-3994-...`     | `1`    | `loop`   |

**Runtime startup log (confirms Postgres persistence is enabled):**

```
2026-02-15T14:03:43 INFO  [server.database] LangGraph checkpointer tables ready
2026-02-15T14:03:43 INFO  [server.database] LangGraph store tables ready
2026-02-15T14:03:43 INFO  [server.postgres_storage] langgraph_server schema and tables ready
2026-02-15T14:03:43 INFO  [server.database] Postgres persistence initialised (per-request connections)
2026-02-15T14:03:45 INFO  [server.storage] Using Postgres-backed storage
```

**Runtime log (confirms stream handler CAN read this thread from Postgres):**

```
2026-02-15T14:06:53 INFO  [server.routes.streams] Read 2 accumulated messages from checkpointer for thread ef4610b831e54f8c882cb5746d3cc82c
```

### Network Trace (from Playwright browser — User B)

```
[POST] /api/langgraph/assistants/search                        => [200] OK        ← works
[POST] /api/langgraph/threads/{id}/history                     => [404] Not Found ← FAILS
[POST] /api/langgraph/threads/{id}/history                     => [404] Not Found ← retry FAILS
[POST] /api/langgraph/assistants                               => [200] OK        ← works
[POST] /api/langgraph/threads/{id}/history                     => [404] Not Found ← still FAILS
```

Note: The Next.js proxy converts `POST /threads/{id}/history` → `GET /threads/{id}/history` (see [Proxy Workaround](#proxy-workaround-in-docproc-platform) section below). So the actual request hitting the runtime is `GET`.

### Root Cause (Confirmed)

The initial hypothesis about an in-memory thread registry was **incorrect**. Both `get_history()` and `get_state()` in `PostgresThreadStore` query Postgres directly — there is no in-memory cache layer.

The actual root cause is **over-restrictive owner isolation on read-only endpoints**. The `get_history()` and `get_state()` methods in the Python runtime's `PostgresThreadStore` verify thread existence with:

```sql
SELECT id FROM langgraph_server.threads
WHERE id = %s AND metadata->>'owner' = %s
```

This owner filter causes 404 in two scenarios:

1. **Multi-user chat:** User B has a different `user.identity` than User A who created the thread. The `metadata->>'owner'` check rejects User B even though the thread exists.
2. **Single-user edge cases:** Any situation where `user.identity` doesn't exactly match the stored `metadata.owner` (encoding differences, token refresh edge cases, etc.).

The **stream handler** (`POST /threads/{id}/runs/stream`) worked because it uses the LangGraph checkpointer (which reads from `public.checkpoints` without owner filtering), not the runtime's `get_history()` method.

The **TypeScript runtime** had a related but different bug: `PostgresThreadStore` completely ignored the `ownerId` parameter on ALL methods — no owner isolation at all (security gap).

### Fix Applied

**Python runtime** (`apps/python/src/server/postgres_storage.py`):

- `get_state()`: Changed existence check from `WHERE id = %s AND metadata->>'owner' = %s` to `WHERE id = %s` — read-only access by thread ID, no owner filter.
- `get_history()`: Same change — read-only access by thread ID, no owner filter.
- `add_state_snapshot()`: Same change — the stream handler already authenticated the user; internal writes check existence by ID only.
- `update()` and `delete()`: **Unchanged** — write operations still require owner match (correct behavior).

**TypeScript runtime** (`apps/ts/src/storage/postgres.ts`):

- Added `ownerId?: string` parameter to ALL `PostgresThreadStore` methods (was completely missing).
- `create()`: Now injects `metadata.owner = ownerId` when provided (matching Python runtime).
- `get()`: Added `AND metadata->>'owner' = ownerId` filter when `ownerId` is provided; no filter when undefined.
- `search()`, `count()`: Added owner scoping via `metadata @> '{"owner": "..."}'` when `ownerId` is provided.
- `update()`: Uses owner-scoped `get()` for write access check. Also fixed missing `status` and `values` handling in the UPDATE SQL (was silently ignoring these fields).
- `delete()`: Added owner-scoped DELETE when `ownerId` is provided.
- `getState()`, `getHistory()`: Accept but intentionally ignore `ownerId` — read-only access by thread ID (BUG-A fix).
- `addStateSnapshot()`: Accept but intentionally ignore `ownerId` — internal writes check existence by ID only.

**Design principle:** Read-only operations (get state, get history) allow access by thread ID alone. Write operations (update, delete) require owner match. List operations (search, count) filter by owner. The thread ID itself serves as the access token for read operations.

### Test Commands

From inside Docker network or via port-forwarded runtime:

```bash
# Test: GET /threads/{id}/history (what the proxy currently sends)
curl -H "Authorization: Bearer $JWT" \
  http://localhost:8081/threads/ef4610b831e54f8c882cb5746d3cc82c/history

# Test: Direct thread lookup
curl -H "Authorization: Bearer $JWT" \
  http://localhost:8081/threads/ef4610b831e54f8c882cb5746d3cc82c

# Test: POST /threads/{id}/history (what the SDK originally sends — see BUG-C)
curl -X POST -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{}' \
  http://localhost:8081/threads/ef4610b831e54f8c882cb5746d3cc82c/history
```

---

## BUG-B: SSE `values` events contain partial state during streaming

**Severity:** 🔴 High — causes message flicker/disappearance during streaming
**Status:** Open
**Discovered:** Session 99 (2026-02-14)

### Summary

During an active SSE stream (`POST /threads/{id}/runs/stream`), the first `event: values` payload only contains the **current run's input message**, not the full accumulated thread history. This causes `useStream` on the client to temporarily replace `stream.messages` with just 1-2 messages, making all previous messages vanish from the UI until the stream completes.

### Observed Behavior

```
stream.messages count: 5 → 1 → 2 (during streaming) → 6 (after completion)
```

- Before stream starts: 5 messages visible
- First `values` event arrives: drops to 1 (only the new human message)
- Agent token streaming: 2 messages (human + partial AI)
- Final `values` event after completion: 6 messages (correct full state)

### Expected Behavior

Every `event: values` payload should contain the **full accumulated thread state**, not just the current run's input. The client's `useStream` hook trusts the `values` event as the authoritative state — if it only has 1 message, the client drops the other 4.

### Root Cause

In `execute_run_stream()` (or equivalent), the initial `values` event is built from only the current run's input messages, not from a full `agent.aget_state()` call against the checkpointer. The checkpointer has the full history, but the stream handler doesn't read it before emitting the first `values` event.

### Impact

- **UI flicker**: All previous messages disappear during streaming, then snap back
- **User confusion**: Users think their message history was lost
- **Workaround attempted**: Frontend uses `initialMessages` from Supabase for display, but `useStream.messages` still flickers

### Suggested Fix

Before emitting the first `event: values` in the SSE stream:

1. Call `checkpointer.aget(thread_id)` or equivalent to load the full accumulated state
2. Merge the new input message into the full state
3. Emit THAT as the first `values` event

Alternatively, don't emit a `values` event at the start — only emit it after the run completes with the final state (which is already correct).

---

## BUG-C: `POST /threads/{id}/history` not supported (SDK default method)

**Severity:** 🟡 Medium — requires proxy workaround, drops request body parameters
**Status:** 🟢 Fixed (same root cause as BUG-A)
**Discovered:** Session 99 (2026-02-14)
**Fixed:** Session 105 (2026-02-15)

### Summary

The `@langchain/langgraph-sdk` (v1.6.0+) sends `POST /threads/{id}/history` with a JSON body containing filter/pagination params (`{limit, before, ...}`) when `fetchStateHistory: true` is set on `useStream`. The runtime logs show both `GET` and `POST` routes are registered:

```
2026-02-15T14:03:43 INFO  Added route HttpMethod.GET /threads/:thread_id/history
2026-02-15T14:03:43 INFO  Added route HttpMethod.POST /threads/:thread_id/history
```

However, the `POST` handler appears to either:
- Not be implemented (returns 404/405)
- Have different thread lookup logic than needed

### Current Workaround

The Next.js proxy converts `POST → GET` before forwarding to the runtime. This works but **drops the request body**, meaning pagination/filter params from the SDK are lost:

```typescript
// apps/web/app/api/langgraph/[...path]/route.ts
const useGetForHistory = request.method === "POST" && isThreadHistoryPath(pathSegments);
const effectiveMethod = useGetForHistory ? "GET" : request.method;

// Body is dropped for GET:
let body: BodyInit | null = null;
if (effectiveMethod !== "GET" && effectiveMethod !== "HEAD") {
  body = await request.arrayBuffer();
}
```

### Fix Applied

BUG-C shared the same root cause as BUG-A. Both `GET` and `POST` handlers for `/threads/{id}/history` call the same `storage.threads.get_history()` method, which had the over-restrictive owner filter. Fixing the owner filter in `get_history()` (BUG-A fix) automatically fixed BUG-C as well.

Both the Python and TypeScript runtimes now have working `POST /threads/{id}/history` endpoints that accept the JSON body with `{limit, before}` parameters. The frontend proxy workaround (`POST → GET` conversion) can now be safely removed.

### Proxy Workaround Removal

The `isThreadHistoryPath()` function and `useGetForHistory` logic in `apps/web/app/api/langgraph/[...path]/route.ts` should be removed now that BUG-C is fixed. The proxy should pass through all methods unchanged.

---

## BUG-D: MCP tools fetch fails on every agent invocation

**Severity:** 🟡 Medium — agent runs without tools, functionality degraded
**Status:** Open
**Discovered:** Session 104 (2026-02-15), also Session 78

### Summary

Every time the agent graph is invoked, the MCP tools fetch fails:

```
2026-02-15T14:06:51 WARNING  [graphs.react_agent.agent] Failed to fetch MCP tools: unhandled errors in a TaskGroup (1 sub-exception)
```

The agent continues to run (it falls back to no tools), but this means configured MCP tools (like `legal-mcp`, `document-mcp`) are never available during agent execution.

### Likely Cause

The `TaskGroup` error suggests an async task within the MCP tool fetching code is throwing an unhandled exception — possibly:

- MCP server endpoint is unreachable (Docker networking issue)
- MCP server not running
- Timeout on MCP tool discovery
- Authentication failure when connecting to MCP servers

### Suggested Investigation

1. Check what MCP servers are configured for the agents (look at `agent_mcp_tools` → `mcp_tools` join)
2. Check if the MCP server endpoints (`mcp_tools.endpoint_url`) are reachable from inside the runtime container
3. Add more granular error logging in the `TaskGroup` to surface which sub-task failed and why
4. Consider making MCP tool fetch failures non-fatal with better error messages (currently it's a generic `TaskGroup` error)

---

## BUG-E: Agent hallucinating tools it doesn't have

**Severity:** 🟡 Medium — misleading agent responses
**Status:** Open
**Discovered:** Session 78 (2026-02-12)

### Summary

The agent claims access to tools it doesn't have: Python execution, SQL databases, Wolfram Alpha, Browser automation, Web Search, etc. The actual configured tools for the agent are only `legal-mcp` (and even those fail to load — see BUG-D).

### Likely Cause

The system prompt or the base agent configuration includes references to tools that don't exist. This could be:

1. A default system prompt in the graph that lists capabilities regardless of configured tools
2. The agent's `system_prompt` field in the database containing tool references
3. A LangGraph agent template that assumes certain tools are available

### Current System Prompt (from checkpoint metadata)

```
Du bist ein Experte für Facility-Management Wartungs- und Serviceberichte. Du analysierst 
technische Dokumentation, extrahierst strukturierte Daten wie Mängel, Maßnahmen, Fristen 
und Prüfergebnisse. Antworte immer auf Deutsch. Sei besonders genau bei technischen 
Details und Datumsangaben.
```

This prompt doesn't mention specific tools, so the hallucination likely comes from the base model's training data or a default prompt template in the graph code that gets prepended.

### Suggested Fix

1. Add explicit negative instructions: "You do NOT have access to any tools unless they are explicitly provided in your tool list"
2. Or conditionally include tool descriptions only when MCP tools are successfully loaded
3. Ensure the `react_agent` graph only binds tools that were actually fetched (if MCP fetch fails, bind zero tools)

---

## FIXED: `threads.values` only stores last 2 messages

**Status:** 🟢 Fixed in runtime (Session 94)
**Included here for reference**

### What Was Wrong

`execute_run_stream()` built `all_messages` from only the current run's input, then overwrote `threads.values` with `{"messages": [human, ai]}` — just 2 messages per run. The `AsyncPostgresSaver` checkpointer correctly accumulated all messages, but `GET /threads/{id}/state` read from the manually-written `threads.values`, not the checkpointer.

### Fix Applied

`execute_run_stream()` and `execute_agent_run()` now call `agent.aget_state()` after run completes to read the full accumulated state from the checkpointer, then write THAT to `threads.values`.

### Verification

- 3 message exchanges, all on same thread
- Navigate away → back: all 6 messages load (was only 2 before fix)
- Hard page reload: all 6 messages persist
- Agent remembers full context across all runs

---

## FIXED: asyncio.Lock bound to different event loop

**Status:** 🟢 Fixed (by using per-request connections, Session 94+)
**Included here for reference**

### What Was Wrong

The `langgraph-checkpoint-postgres` `AsyncPostgresSaver` creates an `asyncio.Lock` on first use. When Robyn handles a second request on a different worker/event loop, the lock was stale. Error: `RuntimeError: <asyncio.locks.Lock object at 0x...> is bound to a different event loop`.

### Fix Applied

Runtime now uses per-request database connections instead of a shared long-lived `AsyncPostgresSaver` instance. Confirmed in startup log:

```
2026-02-15T14:03:43 INFO  [server.database] Postgres persistence initialised (per-request connections)
```

---

## Proxy Workaround in docproc-platform

**Status:** Can be removed now that BUG-A and BUG-C are fixed.

The Next.js frontend has a reverse proxy at `apps/web/app/api/langgraph/[...path]/route.ts` that forwards requests to the runtime. It currently includes a workaround for BUG-C:

```typescript
// Converts POST /threads/{id}/history → GET /threads/{id}/history
// because the runtime's POST handler was returning 404/405
function isThreadHistoryPath(pathSegments: string[]): boolean {
  return (
    pathSegments.length === 3 &&
    pathSegments[0] === "threads" &&
    pathSegments[2] === "history"
  );
}

const useGetForHistory =
  request.method === "POST" && isThreadHistoryPath(pathSegments);
const effectiveMethod = useGetForHistory ? "GET" : request.method;
```

**This workaround should now be removed.** Both BUG-A and BUG-C are fixed — the runtime correctly handles both `GET` and `POST` on `/threads/{id}/history` without owner-filtering read access.

**To remove the workaround:**

1. Delete the `isThreadHistoryPath()` function
2. Delete the `useGetForHistory` logic
3. Set `const effectiveMethod = request.method;` unconditionally

---

## Environment & Schema Reference

### Docker Compose Configuration

```yaml
agent-runtime:
  image: fractal-agents-runtime-python:local-dev
  container_name: agent-runtime
  ports:
    - "${ROBYN_PORT:-8081}:8081"
  environment:
    - DATABASE_URL=postgresql://postgres:postgres@supabase_db_immoflow-platform:5432/postgres
    - SUPABASE_URL=http://supabase_kong_immoflow-platform:8000
    - MODEL_NAME=openai:gpt-4o-mini
    - AZURE_API_VERSION=2024-12-01-preview
    - ROBYN_HOST=0.0.0.0
    - ROBYN_PORT=8081
    - ROBYN_WORKERS=1
```

### Database Schema: `langgraph_server` (managed by runtime)

```
langgraph_server.threads        — id (text PK), metadata (jsonb), config (jsonb), status (text), values (jsonb), interrupts (jsonb), created_at, updated_at
langgraph_server.assistants     — id (text PK), metadata (jsonb), config (jsonb), ...
langgraph_server.runs           — id (text PK), thread_id (text), assistant_id (text), status (text), metadata (jsonb), kwargs (jsonb), ...
langgraph_server.thread_states  — id (int PK), thread_id (text), values (jsonb), metadata (jsonb), next (text[]), tasks (jsonb), checkpoint_id (text), ...
langgraph_server.store_items    — ...
langgraph_server.crons          — ...
```

### Database Schema: `public` (LangGraph checkpointer tables)

```
public.checkpoints              — thread_id (text), checkpoint_ns (text), checkpoint_id (text), parent_checkpoint_id (text), type (text), checkpoint (jsonb), metadata (jsonb)
public.checkpoint_blobs         — thread_id (text), checkpoint_ns (text), channel (text), version (text), type (text), blob (bytea)
public.checkpoint_writes        — thread_id (text), checkpoint_ns (text), checkpoint_id (text), task_id (text), idx (int), channel (text), type (text), blob (bytea), task_path (text)
public.checkpoint_migrations    — v (int PK)
public.store_migrations         — v (int PK)
public.store                    — prefix (text), key (text), value (jsonb), ...
```

### Frontend SDK

| Package                        | Purpose                                |
| ------------------------------ | -------------------------------------- |
| `@langchain/langgraph-sdk`     | `useStream` hook, thread management    |
| `useStream` config             | `fetchStateHistory: true`              |
| Proxy route                    | `apps/web/app/api/langgraph/[...path]` |

---

## Priority for Fixing

| Bug   | Priority | Status | Reason                                                                  |
| ----- | -------- | ------ | ----------------------------------------------------------------------- |
| BUG-A | 1st      | 🟢 Fixed | Owner filter removed from read-only endpoints (get_state, get_history, add_state_snapshot) in both Python and TS runtimes. TS runtime also got full owner isolation added to all other methods. |
| BUG-B | 2nd      | Open | Causes jarring UI flicker during streaming — bad UX                     |
| BUG-C | 3rd      | 🟢 Fixed | Same root cause as BUG-A — both GET and POST history handlers now work. Proxy workaround can be removed. |
| BUG-D | 4th      | Open | Agent works without tools but degraded; needs networking investigation  |
| BUG-E | 5th      | Open | Cosmetic/UX — agent claims wrong capabilities; prompt engineering fix   |
