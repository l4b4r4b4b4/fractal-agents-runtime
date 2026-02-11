# Task 05 — Threads Endpoints

Status: 🟢 Complete  
Started: 2026-02-04  
Completed: 2026-02-04

---

## Objective

Implement LangGraph-compatible Threads API endpoints for the Robyn runtime server.

---

## Endpoints Implemented

### Tier 1 (Must Have)
| Endpoint | Method | Description | Status |
|----------|--------|-------------|--------|
| `/threads` | POST | Create a thread | 🟢 Complete |
| `/threads/:thread_id` | GET | Get a thread by ID | 🟢 Complete |
| `/threads/:thread_id` | PATCH | Update a thread | 🟢 Complete |
| `/threads/:thread_id` | DELETE | Delete a thread | 🟢 Complete |
| `/threads/:thread_id/state` | GET | Get thread state | 🟢 Complete |
| `/threads/:thread_id/history` | GET | Get thread history | 🟢 Complete |

### Tier 2 (Should Have)
| Endpoint | Method | Description | Status |
|----------|--------|-------------|--------|
| `/threads/search` | POST | Search/list threads | 🟢 Complete |
| `/threads/count` | POST | Count threads | 🟢 Complete |

---

## OpenAPI Contract Reference

### Thread Schema (required fields)
```json
{
  "thread_id": "uuid",
  "created_at": "datetime",
  "updated_at": "datetime",
  "metadata": {},
  "config": {},
  "status": "idle|busy|interrupted|error",
  "values": {},
  "interrupts": {}
}
```

### ThreadCreate
```json
{
  "thread_id": "optional uuid",
  "metadata": {},
  "if_exists": "raise|do_nothing"
}
```

### ThreadPatch
```json
{
  "metadata": {}
}
```

### ThreadState
```json
{
  "values": {},
  "next": ["string"],
  "tasks": [],
  "checkpoint": {},
  "metadata": {},
  "created_at": "string",
  "parent_checkpoint": {},
  "interrupts": []
}
```

### ThreadSearchRequest
```json
{
  "ids": ["uuid"],
  "metadata": {},
  "values": {},
  "status": "idle|busy|interrupted|error",
  "limit": 10,
  "offset": 0,
  "sort_by": "thread_id|status|created_at|updated_at",
  "sort_order": "asc|desc"
}
```

---

## Implementation Completed

### Step 1: Updated Models ✅
- [x] Added `config` field to Thread model
- [x] Added `interrupts` field to Thread model
- [x] Added `interrupts` field to ThreadState model
- [x] Updated ThreadSearchRequest with full spec fields (ids, values, sort_by, sort_order)
- [x] Updated ThreadCountRequest with full spec fields (values)

### Step 2: Updated Storage ✅
- [x] ThreadStore now tracks state history (list of ThreadState snapshots)
- [x] Added `get_state()` method for current thread state
- [x] Added `add_state_snapshot()` method for history tracking
- [x] Added `get_history()` method with limit and before pagination
- [x] Delete cleans up associated history

### Step 3: Created Routes ✅
- [x] Created `robyn_server/routes/helpers.py` (shared helpers to avoid duplication)
- [x] Created `robyn_server/routes/threads.py` with all 8 endpoints
- [x] Updated `robyn_server/routes/__init__.py` to export new modules
- [x] Registered thread routes in `robyn_server/app.py`

### Step 4: Created Tests ✅
- [x] Created `robyn_server/tests/test_threads.py` with 46 tests
- [x] Tests cover CRUD operations
- [x] Tests cover owner isolation
- [x] Tests cover state and history endpoints
- [x] Tests cover search and count
- [x] Tests cover edge cases and serialization

---

## Files Modified/Created

| File | Action | Description |
|------|--------|-------------|
| `robyn_server/models.py` | Modified | Added config, interrupts to Thread; enhanced search/count models |
| `robyn_server/storage.py` | Modified | Added state history tracking, get_state, get_history methods |
| `robyn_server/routes/helpers.py` | Created | Shared route helpers (json_response, error_response, parse_json_body) |
| `robyn_server/routes/threads.py` | Created | Thread endpoint handlers (8 endpoints) |
| `robyn_server/routes/__init__.py` | Modified | Export thread routes and helpers |
| `robyn_server/routes/assistants.py` | Modified | Import helpers from shared module |
| `robyn_server/app.py` | Modified | Register thread routes |
| `robyn_server/tests/test_threads.py` | Created | 46 comprehensive tests |
| `robyn_server/tests/test_assistants.py` | Modified | Import helpers from shared module |

---

## Test Results

```
============================= 166 passed in 0.27s ==============================
```

- **46 new thread tests** — All passing
- **120 existing tests** — All still passing
- **Total: 166 tests passing**

---

## Success Criteria — All Met ✅

- [x] All 8 endpoints implemented and returning correct response shapes
- [x] Owner isolation enforced on all endpoints
- [x] Error responses match LangGraph format (`{"detail": "..."}`)
- [x] All tests passing (166 total)
- [x] Linting passes (`ruff check . --fix && ruff format .`)

---

## Notes

### State and History (In-Memory Implementation)
For the in-memory implementation:
- Thread `values` field stores current state
- History is a list of state snapshots stored with the thread
- Checkpoints are simplified — thread_id + checkpoint_id + timestamp
- Full checkpoint semantics will come with Postgres persistence layer

### Pattern Followed
- Followed `robyn_server/routes/assistants.py` for route structure
- Followed `robyn_server/tests/test_assistants.py` for test patterns
- Extracted shared helpers to `robyn_server/routes/helpers.py` to avoid duplication

### Key Implementation Details
- `if_exists: "do_nothing"` returns existing thread instead of error (409)
- State endpoint returns ThreadState with checkpoint info
- History endpoint returns most recent first, respects limit parameter
- Search supports filtering by ids, status, metadata, values
- Search supports sorting by thread_id, status, created_at, updated_at
- Count endpoint returns bare integer (matches LangGraph API)

---

## Progress Log

### 2026-02-04
- Created task scratchpad
- Reviewed OpenAPI spec for thread endpoints (L672-1358)
- Identified all required endpoints and schemas
- Planned implementation steps
- Updated models.py with config, interrupts, enhanced search/count
- Updated storage.py with state history tracking
- Created routes/helpers.py with shared helpers
- Created routes/threads.py with all 8 endpoints
- Updated app.py to register thread routes
- Created tests/test_threads.py with 46 tests
- All 166 tests passing
- Linting passes
- **Task complete!**