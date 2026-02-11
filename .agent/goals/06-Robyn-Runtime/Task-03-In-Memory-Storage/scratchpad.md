# Task 03 — In-Memory Storage Layer

Status: 🟢 Complete  
Parent Goal: Goal 06 — Robyn Runtime  
Created: 2026-02-04  
Completed: 2026-02-04

---

## Objective

Create an in-memory storage layer for assistants, threads, and runs with owner-scoped isolation. This layer will be used by the API endpoints (Tasks 04-06) and can later be swapped for Postgres/Supabase persistence.

---

## Requirements

### Functional Requirements
1. **CRUD operations** for each resource type:
   - `create(data, owner_id)` → resource with auto-generated ID
   - `get(resource_id, owner_id)` → resource or None
   - `list(owner_id, filters)` → list of resources
   - `update(resource_id, data, owner_id)` → updated resource or None
   - `delete(resource_id, owner_id)` → bool (success)

2. **Owner isolation**:
   - All reads/updates/deletes filter by `metadata.owner == user_id`
   - On create, auto-stamp `metadata.owner` from authenticated user
   - Users cannot access resources they don't own

3. **Resource types** (from `robyn_server/models.py`):
   - `Assistant` — graph_id, config, metadata, name
   - `Thread` — metadata only
   - `Run` — thread_id, assistant_id, status, metadata

### Non-Functional Requirements
- Thread-safe (asyncio-safe) operations
- Type-annotated interfaces
- Easy to swap for database backend later

---

## Implementation Plan

### File: `robyn_server/storage.py`

```python
# Structure:
1. BaseStore[T] — Generic base with common CRUD logic
2. AssistantStore — Typed store for Assistant resources
3. ThreadStore — Typed store for Thread resources  
4. RunStore — Typed store for Run resources (with thread_id filtering)
5. Storage — Container class with all stores
6. get_storage() — Module-level accessor
```

### Key Design Decisions

1. **UUID generation**: Use `uuid4().hex` for IDs (matches LangGraph format)
2. **Timestamp handling**: Use `datetime.now(timezone.utc)` for created_at/updated_at
3. **Owner stamping**: Always stamp `metadata["owner"]` on create
4. **Filtering**: Support basic equality filters for list operations
5. **Thread safety**: Use dict operations which are atomic in CPython

### Interface Design

```python
class BaseStore(Generic[T]):
    def create(self, data: dict, owner_id: str) -> T
    def get(self, resource_id: str, owner_id: str) -> T | None
    def list(self, owner_id: str, **filters) -> list[T]
    def update(self, resource_id: str, data: dict, owner_id: str) -> T | None
    def delete(self, resource_id: str, owner_id: str) -> bool
```

---

## Test Plan

### Unit Tests: `robyn_server/tests/test_storage.py`

1. **AssistantStore tests**:
   - Create assistant with owner stamping
   - Get assistant by owner (success)
   - Get assistant by different owner (returns None)
   - List assistants filters by owner
   - Update assistant preserves owner
   - Delete assistant checks owner

2. **ThreadStore tests**:
   - Same pattern as AssistantStore

3. **RunStore tests**:
   - Same pattern as AssistantStore
   - Additional: filter by thread_id

4. **Cross-owner isolation tests**:
   - User A cannot see User B's resources
   - User A cannot update User B's resources
   - User A cannot delete User B's resources

---

## Files to Create/Modify

| File | Action |
|------|--------|
| `robyn_server/storage.py` | Create |
| `robyn_server/tests/test_storage.py` | Create |
| `robyn_server/__init__.py` | Update (export storage) |

---

## Progress

- [x] Create `storage.py` with BaseStore generic class
- [x] Implement AssistantStore
- [x] Implement ThreadStore
- [x] Implement RunStore
- [x] Add Storage container class
- [x] Create unit tests
- [x] Run tests and fix issues
- [x] Update scratchpad with completion notes

---

## Notes

- The owner pattern matches `tools_agent/security/auth.py` where:
  - `on_thread_create` adds `metadata["owner"] = ctx.user.identity`
  - `on_thread_read` returns filter `{"owner": ctx.user.identity}`
- We use `get_user_identity()` from `robyn_server/auth.py` for the owner ID

---

## Completion Summary

### What Was Implemented

**File: `robyn_server/storage.py`** (444 lines)
- `generate_id()` — UUID hex generation (32 chars, no dashes)
- `utc_now()` — Timezone-aware UTC datetime
- `BaseStore[T]` — Generic base class with:
  - `create(data, owner_id)` — Auto-stamps `metadata.owner`
  - `get(resource_id, owner_id)` — Owner-filtered retrieval
  - `list(owner_id, **filters)` — Owner-filtered listing with equality filters
  - `update(resource_id, data, owner_id)` — Preserves owner, merges metadata
  - `delete(resource_id, owner_id)` — Owner-checked deletion
  - `count(owner_id, **filters)` — Count helper
  - `clear()` — Test helper
- `AssistantStore` — Requires `graph_id` on create
- `ThreadStore` — Minimal requirements
- `RunStore` — Requires `thread_id` and `assistant_id`, default status "pending"
  - `list_by_thread(thread_id, owner_id)` — Thread-scoped listing
  - `update_status(run_id, status, owner_id)` — Status update helper
- `Storage` — Container with all three stores
- `get_storage()` — Global singleton accessor
- `reset_storage()` — Test helper to reset global state

**File: `robyn_server/tests/test_storage.py`** (726 lines, 47 tests)
- `TestHelperFunctions` — ID generation tests
- `TestAssistantStore` — Full CRUD + owner isolation (18 tests)
- `TestThreadStore` — Full CRUD + owner isolation (7 tests)
- `TestRunStore` — Full CRUD + thread filtering + owner isolation (12 tests)
- `TestStorage` — Container tests (2 tests)
- `TestGlobalStorage` — Singleton behavior tests (3 tests)
- `TestCrossOwnerIsolation` — Explicit isolation tests (5 tests)

### Test Results

```
============================= 88 passed in 0.14s ==============================
```
- 41 auth tests (from Task 02)
- 47 storage tests (this task)

### Key Design Decisions

1. **Generic BaseStore** — Reduces code duplication, enforces consistent owner isolation
2. **Owner stamping on create** — Always sets `metadata["owner"]` automatically
3. **Owner preservation on update** — Cannot change owner via metadata update
4. **Metadata merging** — Updates merge metadata instead of replacing
5. **In-memory dict** — Simple dict storage, easy to swap for Postgres later
6. **Global singleton** — `get_storage()` returns same instance, `reset_storage()` for tests

### Ready for Task 04

The storage layer is now ready for use by the Assistants endpoints (Task 04):

```python
from robyn_server.storage import get_storage
from robyn_server.auth import get_user_identity

storage = get_storage()
owner_id = get_user_identity()

# Create assistant
assistant = storage.assistants.create(
    {"graph_id": "agent", "name": "My Assistant"},
    owner_id
)

# Get assistant (returns None if not owned)
assistant = storage.assistants.get(assistant_id, owner_id)

# List user's assistants
assistants = storage.assistants.list(owner_id)
```