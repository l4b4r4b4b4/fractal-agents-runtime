# Task 06 — Runs Endpoints & Agent Execution

Status: 🟢 Complete  
Started: 2026-02-04  
Completed: 2026-02-04

---

## Objective

Implement LangGraph-compatible Runs API endpoints for the Robyn runtime server, including background run creation and run management.

---

## Endpoints Implemented

### Tier 1 (Must Have)
| Endpoint | Method | Description | Status |
|----------|--------|-------------|--------|
| `/threads/:thread_id/runs` | POST | Create a background run | 🟢 Complete |
| `/threads/:thread_id/runs` | GET | List runs for a thread | 🟢 Complete |
| `/threads/:thread_id/runs/:run_id` | GET | Get a run by ID | 🟢 Complete |
| `/threads/:thread_id/runs/:run_id` | DELETE | Delete a run | 🟢 Complete |
| `/threads/:thread_id/runs/wait` | POST | Create run, wait for output | 🟢 Complete |
| `/threads/:thread_id/runs/:run_id/cancel` | POST | Cancel a running run | 🟢 Complete |

### Tier 2 (Task 07 - SSE Streaming)
| Endpoint | Method | Description | Status |
|----------|--------|-------------|--------|
| `/threads/:thread_id/runs/stream` | POST | Create run, stream output (SSE) | ⚪ Task 07 |
| `/threads/:thread_id/runs/:run_id/stream` | GET | Join run stream (SSE) | ⚪ Task 07 |
| `/runs/stream` | POST | Stateless run with streaming (SSE) | ⚪ Task 07 |

---

## OpenAPI Contract Reference

### Run Schema (required fields)
```json
{
  "run_id": "uuid",
  "thread_id": "uuid",
  "assistant_id": "uuid",
  "created_at": "datetime",
  "updated_at": "datetime",
  "status": "pending|running|error|success|timeout|interrupted",
  "metadata": {},
  "kwargs": {},
  "multitask_strategy": "reject|rollback|interrupt|enqueue"
}
```

### RunCreateStateful (request body)
```json
{
  "assistant_id": "required - uuid or graph name",
  "input": "optional - object, array, string, number, boolean, null",
  "command": "optional - Command object",
  "checkpoint": "optional - checkpoint to resume from",
  "metadata": {},
  "config": {"tags": [], "recursion_limit": 25, "configurable": {}},
  "context": {},
  "webhook": "optional url",
  "interrupt_before": ["node_names"] or "*",
  "interrupt_after": ["node_names"] or "*",
  "stream_mode": ["values", "messages", "updates", ...],
  "stream_subgraphs": false,
  "stream_resumable": false,
  "on_disconnect": "cancel|continue",
  "multitask_strategy": "reject|rollback|interrupt|enqueue",
  "if_not_exists": "create|reject",
  "after_seconds": "optional number",
  "checkpoint_during": false,
  "durability": "sync|async|exit"
}
```

---

## Implementation Completed

### Step 1: Updated Models ✅
- [x] Updated RunCreate model with all RunCreateStateful fields
- [x] Added `if_not_exists` field for thread creation behavior
- [x] Added `checkpoint` field for resume support
- [x] Added `stream_resumable`, `durability` fields
- [x] Fixed defaults to match LangGraph spec (multitask_strategy="enqueue", etc.)

### Step 2: Updated Storage ✅
- [x] Added `list_by_thread()` with pagination and status filter
- [x] Added `get_by_thread()` for thread-scoped retrieval
- [x] Added `delete_by_thread()` for thread-scoped deletion
- [x] Added `get_active_run()` for multitask conflict detection
- [x] Added `count_by_thread()` for counting runs
- [x] All methods enforce owner isolation

### Step 3: Created Routes ✅
- [x] Created `robyn_server/routes/runs.py` with 6 endpoints
- [x] Implemented multitask_strategy conflict handling
- [x] Thread validation before run creation
- [x] Assistant lookup by ID or graph name
- [x] `if_not_exists="create"` auto-creates thread
- [x] Registered routes in app.py

### Step 4: Created Tests ✅
- [x] Created `robyn_server/tests/test_runs.py` with 36 tests
- [x] Tests cover CRUD operations
- [x] Tests cover owner isolation
- [x] Tests cover list with pagination and filtering
- [x] Tests cover active run detection
- [x] Tests cover status updates
- [x] Tests cover serialization

---

## Files Modified/Created

| File | Action | Description |
|------|--------|-------------|
| `robyn_server/models.py` | Modified | Enhanced RunCreate with all RunCreateStateful fields |
| `robyn_server/storage.py` | Modified | Added 5 new RunStore methods for thread-scoped operations |
| `robyn_server/routes/runs.py` | Created | 6 run endpoints (440 lines) |
| `robyn_server/routes/__init__.py` | Modified | Export run routes |
| `robyn_server/app.py` | Modified | Register run routes |
| `robyn_server/tests/test_runs.py` | Created | 36 comprehensive tests (779 lines) |

---

## Test Results

```
============================= 202 passed in 0.26s ==============================
```

- **36 new run tests** — All passing
- **166 existing tests** — All still passing
- **Total: 202 tests passing**

---

## Success Criteria — All Met ✅

- [x] All 6 Tier 1 endpoints implemented
- [x] Owner isolation enforced on all endpoints
- [x] Thread existence validated before creating runs
- [x] Assistant existence validated before creating runs
- [x] Multitask strategy conflicts handled correctly (reject returns 409)
- [x] Error responses match LangGraph format
- [x] All tests passing (202 total)
- [x] Linting passes

---

## Registered Routes (24 total)

```
POST   /assistants
GET    /assistants/:assistant_id
PATCH  /assistants/:assistant_id
DELETE /assistants/:assistant_id
POST   /assistants/search
POST   /assistants/count
POST   /threads
GET    /threads/:thread_id
PATCH  /threads/:thread_id
DELETE /threads/:thread_id
GET    /threads/:thread_id/state
GET    /threads/:thread_id/history
POST   /threads/search
POST   /threads/count
POST   /threads/:thread_id/runs           <- NEW
GET    /threads/:thread_id/runs           <- NEW
GET    /threads/:thread_id/runs/:run_id   <- NEW
DELETE /threads/:thread_id/runs/:run_id   <- NEW
POST   /threads/:thread_id/runs/wait      <- NEW
POST   /threads/:thread_id/runs/:run_id/cancel <- NEW
GET    /health
GET    /ok
GET    /
GET    /info
```

---

## Notes

### Multitask Strategy Handling
- `reject` — Returns 409 if thread has active run
- `enqueue` — Creates run anyway (will queue behind active)
- `interrupt` — Marks active run as "interrupted", creates new one
- `rollback` — Marks active run as "error", creates new one

### Agent Execution (Simplified for Now)
The `/runs/wait` endpoint currently:
1. Creates the run in "running" status
2. Stores input as thread state
3. Marks run as "success"
4. Returns thread state

Full agent graph execution will be added in Task 07 with SSE streaming.

### Thread Auto-Creation
When `if_not_exists="create"` is passed:
- If thread doesn't exist, a new thread is created
- The new thread_id is used for the run
- Default is `"reject"` which returns 404 if thread not found

---

## Progress Log

### 2026-02-04
- Created task scratchpad
- Reviewed OpenAPI spec for run endpoints (L1420-2000, L3886-4200)
- Identified Run and RunCreateStateful schemas
- Updated models.py with enhanced RunCreate
- Updated storage.py with thread-scoped run operations
- Created routes/runs.py with 6 endpoints
- Updated app.py to register run routes
- Created tests/test_runs.py with 36 tests
- All 202 tests passing
- Linting passes
- **Task complete!**