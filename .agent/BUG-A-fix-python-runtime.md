# BUG-A Fix: `GET /threads/{id}/history` Returns 404 for Persisted Threads

**Fix applied to:** `fractal-agents-runtime` Python runtime (Robyn)
**Date:** 2026-02-15
**Affects:** `apps/python/src/server/postgres_storage.py`
**Also fixes:** BUG-C (`POST /threads/{id}/history` returning 404)
**Verified against:** Docker-composed Python + TS runtimes with live Supabase Postgres

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Bug Description](#bug-description)
3. [Root Cause Analysis](#root-cause-analysis)
4. [Fix Details](#fix-details)
5. [Diff](#diff)
6. [Access Model After Fix](#access-model-after-fix)
7. [Verification Results](#verification-results)
8. [Frontend Proxy Workaround Removal](#frontend-proxy-workaround-removal)
9. [Migration Notes](#migration-notes)

---

## Executive Summary

Three methods in `PostgresThreadStore` (`get_state`, `get_history`, `add_state_snapshot`) were using an owner-scoped SQL query to verify thread existence before returning data:

```sql
SELECT id FROM langgraph_server.threads
WHERE id = %s AND metadata->>'owner' = %s
```

This caused **HTTP 404** for any user whose `user.identity` didn't match the thread's `metadata.owner` — including:

- **Multi-user chat:** User B opens a chat created by User A → 404
- **Single-user page refresh:** Any mismatch in identity encoding → 404
- **Navigation away and back:** Component re-mount triggers fresh history fetch → 404

The fix removes the `AND metadata->>'owner' = %s` clause from these three read-only / internal-write methods. Write operations (`update`, `delete`) retain owner isolation — only the thread creator can mutate or delete.

BUG-C (`POST /threads/{id}/history` returning 404) is automatically fixed because both the GET and POST history handlers call the same `get_history()` storage method.

---

## Bug Description

### Symptoms

When `useStream` (from `@langchain/langgraph-sdk`) mounts with an existing `threadId`, it calls the thread history endpoint to load state. The runtime returned **HTTP 404** with `{"detail": "Thread {id} not found"}`, even though the thread and all its data were fully persisted in Postgres.

### Who was affected

| Scenario | Affected? | Reason |
|----------|-----------|--------|
| Thread creator, component alive since creation | ❌ No | State in client memory, never calls history endpoint |
| Thread creator, page refresh (F5) | ✅ Yes | `useStream` re-mounts, calls history → 404 |
| Thread creator, navigate away + back | ✅ Yes | Component re-mount → 404 |
| Thread creator, second browser tab | ✅ Yes | Fresh mount → 404 |
| Second user in multi-user chat | ✅ Yes | Different `user.identity` → 404 |

### Evidence from bug report

- Thread `ef4610b831e54f8c882cb5746d3cc82c` existed in `langgraph_server.threads` with `metadata: {"owner": "a1b2c3d4-e5f6-7890-abcd-ef1234567890"}`
- 3 checkpoints existed in `public.checkpoints`
- Stream handler **could** read the thread (logged "Read 2 accumulated messages from checkpointer")
- History endpoint returned 404 for the same thread

---

## Root Cause Analysis

### Initial hypothesis (INCORRECT)

The bug report hypothesized an "in-memory thread registry" that wasn't falling back to Postgres. This was **wrong** — there is no in-memory cache. All methods query Postgres directly.

### Actual root cause

The `get_history()`, `get_state()`, and `add_state_snapshot()` methods in `PostgresThreadStore` all verified thread existence with an **owner-scoped query**:

```python
# BEFORE (broken) — apps/python/src/server/postgres_storage.py

async def get_history(self, thread_id, owner_id, limit=10, before=None):
    async with self._get_connection() as connection:
        result = await connection.execute(
            f"SELECT id FROM {_SCHEMA}.threads "
            f"WHERE id = %s AND metadata->>'owner' = %s",  # ← PROBLEM
            (thread_id, owner_id),
        )
        if await result.fetchone() is None:
            return None  # ← triggers 404 in the route handler
```

When `owner_id` (from `user.identity` via JWT) didn't match the thread's `metadata->>'owner'`, the query returned zero rows → `None` → 404.

### Why the stream handler worked

The stream handler uses the LangGraph checkpointer (`AsyncPostgresSaver`), which reads from `public.checkpoints` — a completely different table with **no owner filtering**. The runtime storage layer (`langgraph_server.threads`) and the LangGraph checkpointer (`public.checkpoints`) are independent persistence paths.

---

## Fix Details

### What changed

Three methods in `PostgresThreadStore` had their existence-check query simplified to remove the owner filter:

| Method | Purpose | Change |
|--------|---------|--------|
| `get_state()` | `GET /threads/{id}/state` | `WHERE id = %s AND metadata->>'owner' = %s` → `WHERE id = %s` |
| `get_history()` | `GET/POST /threads/{id}/history` | Same |
| `add_state_snapshot()` | Internal: stream handler writes state | Same |

### What was NOT changed

| Method | Purpose | Owner filter |
|--------|---------|:---:|
| `get()` | `GET /threads/{id}` | ✅ Kept |
| `update()` | `PATCH /threads/{id}` | ✅ Kept |
| `delete()` | `DELETE /threads/{id}` | ✅ Kept |
| `list()` | `POST /threads/search` | ✅ Kept |
| `count()` | `POST /threads/count` | ✅ Kept |
| `create()` | `POST /threads` | ✅ Kept (injects `metadata.owner`) |

### Why `add_state_snapshot()` was also changed

The stream handler calls `add_state_snapshot()` after the agent finishes to persist the final state. It passes `owner_id` from the authenticated user who started the stream. While this should normally match (same user who created the thread), removing the owner check here:

1. Eliminates a potential failure mode if the identity format drifts
2. Is safe because the stream handler already verified thread access at stream creation time
3. Matches the principle that internal writes during an authenticated session shouldn't re-verify ownership

### `owner_id` parameter kept for interface compatibility

All three methods still accept `owner_id` as a parameter. The parameter is intentionally unused for the existence check. This avoids breaking any callers.

---

## Diff

```diff
--- a/apps/python/src/server/postgres_storage.py
+++ b/apps/python/src/server/postgres_storage.py

# ── get_state() ──────────────────────────────────────────────────────

     async def get_state(self, thread_id: str, owner_id: str) -> ThreadState | None:
-        """Get the current state of a thread."""
+        """Get the current state of a thread.
+
+        BUG-A fix: Read-only access — check thread existence by ID only,
+        no owner filter.  Any authenticated user who knows the thread ID
+        can read its state.
+        """
         async with self._get_connection() as connection:
-            # Verify thread exists and is owned
+            # Verify thread exists (no owner filter — read-only access by ID)
             result = await connection.execute(
                 f"""
                 SELECT id, metadata, values
                 FROM {_SCHEMA}.threads
-                WHERE id = %s AND metadata->>'owner' = %s
+                WHERE id = %s
                 """,
-                (thread_id, owner_id),
+                (thread_id,),
             )

# ── add_state_snapshot() ─────────────────────────────────────────────

         async with self._get_connection() as connection:
-            # Verify ownership
+            # Verify thread exists (no owner filter — the stream handler
+            # already authenticated the user)
             result = await connection.execute(
-                f"SELECT id FROM {_SCHEMA}.threads WHERE id = %s AND metadata->>'owner' = %s",
-                (thread_id, owner_id),
+                f"SELECT id FROM {_SCHEMA}.threads WHERE id = %s",
+                (thread_id,),
             )

# ── get_history() ────────────────────────────────────────────────────

     async def get_history(
         self, thread_id: str, owner_id: str, limit: int = 10, before: str | None = None
     ) -> list[ThreadState] | None:
-        """Get state history for a thread."""
+        """Get state history for a thread.
+
+        BUG-A fix: Read-only access — check thread existence by ID only,
+        no owner filter.  Any authenticated user who knows the thread ID
+        can read its history.
+        """
         async with self._get_connection() as connection:
-            # Verify ownership
+            # Verify thread exists (no owner filter — read-only access by ID)
             result = await connection.execute(
-                f"SELECT id FROM {_SCHEMA}.threads WHERE id = %s AND metadata->>'owner' = %s",
-                (thread_id, owner_id),
+                f"SELECT id FROM {_SCHEMA}.threads WHERE id = %s",
+                (thread_id,),
             )
```

---

## Access Model After Fix

The fix establishes a clear access model for thread operations:

```
┌─────────────────────────────────────────────────────────┐
│                  Thread Access Model                     │
├──────────────────┬──────────────────────────────────────┤
│  READ by ID      │  Any authenticated user who knows    │
│  (state, history)│  the thread ID — ID is the secret    │
├──────────────────┼──────────────────────────────────────┤
│  WRITE           │  Only the thread owner               │
│  (update, delete)│  (metadata.owner == user.identity)   │
├──────────────────┼──────────────────────────────────────┤
│  LIST            │  Only the user's own threads         │
│  (search, count) │  (metadata.owner == user.identity)   │
├──────────────────┼──────────────────────────────────────┤
│  CREATE          │  Any authenticated user              │
│                  │  (sets metadata.owner automatically) │
└──────────────────┴──────────────────────────────────────┘
```

This matches the standard access model for shared resources: the thread ID serves as an opaque access token for read operations. Users can only discover their own threads via search/list, but if they have the ID (e.g., from a shared chat session), they can read the state and history.

---

## Verification Results

Tested with Docker-composed runtimes against live Supabase Postgres. Two test users created:

- **User A** (`7638af4f-4f81-4724-bb9d-17215ad130d5`) — thread creator
- **User B** (`f43f1652-9831-460f-9e83-b0b3b4a7b860`) — different user

### New thread created by User A

| Test | HTTP | Expected | Result |
|------|:----:|:--------:|:------:|
| User A `GET /history` (page refresh) | `200` | `200` | ✅ |
| User A `POST /history` (SDK method) | `200` | `200` | ✅ |
| User B `GET /history` (multi-user) | `200` | `200` | ✅ |
| User B `POST /history` (multi-user) | `200` | `200` | ✅ |
| User B `GET /state` (multi-user) | `200` | `200` | ✅ |
| User B `DELETE /thread` (write isolation) | `404` | `404` | ✅ |

### Original bug-report thread (`ef4610b831e54f8c882cb5746d3cc82c`)

| Test | Before Fix | After Fix |
|------|:----------:|:---------:|
| User B `GET /history` | **404** ❌ | **200** ✅ |
| User B `POST /history` | **404** ❌ | **200** ✅ |

The response body contains the full message history (human + AI messages from prior conversation).

---

## Frontend Proxy Workaround Removal

### What the workaround does

The Next.js proxy at `apps/web/app/api/langgraph/[...path]/route.ts` currently converts `POST /threads/{id}/history` → `GET /threads/{id}/history` because the runtime's POST handler was returning 404:

```typescript
// apps/web/app/api/langgraph/[...path]/route.ts

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

// Body is dropped for GET:
let body: BodyInit | null = null;
if (effectiveMethod !== "GET" && effectiveMethod !== "HEAD") {
  body = await request.arrayBuffer();
}
```

### Why it should be removed

1. Both `GET` and `POST` handlers for `/threads/{id}/history` now work correctly
2. The `POST → GET` conversion **drops the request body**, losing `{limit, before}` pagination params from the SDK
3. The SDK (`@langchain/langgraph-sdk` v1.6.0+) sends `POST` with filter/pagination — the proxy should pass it through

### How to remove it

```diff
 // apps/web/app/api/langgraph/[...path]/route.ts

-function isThreadHistoryPath(pathSegments: string[]): boolean {
-  return (
-    pathSegments.length === 3 &&
-    pathSegments[0] === "threads" &&
-    pathSegments[2] === "history"
-  );
-}

-const useGetForHistory =
-  request.method === "POST" && isThreadHistoryPath(pathSegments);
-const effectiveMethod = useGetForHistory ? "GET" : request.method;
+const effectiveMethod = request.method;

 // Body handling — no longer needs the GET exception:
 let body: BodyInit | null = null;
 if (effectiveMethod !== "GET" && effectiveMethod !== "HEAD") {
   body = await request.arrayBuffer();
 }
```

After removing the workaround, verify:
1. Page refresh loads existing chat history ✅
2. Multi-user chat loads thread for second participant ✅
3. `useStream` with `fetchStateHistory: true` works without errors ✅

---

## Migration Notes

### Database schema

No database schema changes required. The fix only changes application-level SQL query logic.

### Backward compatibility

- The `owner_id` parameter is kept on all three methods — no interface changes
- Callers don't need to change
- Route handlers don't need to change
- Threads created before the fix work correctly (they already have `metadata.owner` set)

### Security considerations

- **Thread IDs are UUIDs** — opaque 128-bit values that cannot be guessed
- The thread ID serves as the de facto access token for read operations
- Users cannot **discover** other users' threads (search/list are still owner-scoped)
- Users cannot **modify** or **delete** other users' threads (write operations are still owner-scoped)
- This is the same access model used by the official LangGraph Platform API (which has no per-user ownership at all)

### Testing

After applying the fix, test these scenarios:

```bash
# Create a thread as User A
THREAD=$(curl -s -X POST http://localhost:8081/threads \
  -H "Authorization: Bearer $TOKEN_A" \
  -H "Content-Type: application/json" \
  -d '{}' | jq -r '.thread_id')

# User A can read history (page refresh scenario)
curl -s http://localhost:8081/threads/$THREAD/history \
  -H "Authorization: Bearer $TOKEN_A"
# → 200 []

# User A can POST to history (SDK scenario)
curl -s -X POST http://localhost:8081/threads/$THREAD/history \
  -H "Authorization: Bearer $TOKEN_A" \
  -H "Content-Type: application/json" -d '{}'
# → 200 []

# User B can read history (multi-user scenario)
curl -s http://localhost:8081/threads/$THREAD/history \
  -H "Authorization: Bearer $TOKEN_B"
# → 200 []  (was 404 before fix)

# User B CANNOT delete (write isolation)
curl -s -X DELETE http://localhost:8081/threads/$THREAD \
  -H "Authorization: Bearer $TOKEN_B"
# → 404 (correct — not the owner)
```
