# Task 04 — Assistants Endpoints

Status: 🟢 Complete  
Parent Goal: Goal 06 — Robyn Runtime  
Created: 2026-02-04  
Completed: 2026-02-04

---

## Objective

Implement LangGraph-compatible Assistants API endpoints for the Robyn server. These are Tier 1 endpoints required for basic agent functionality.

---

## Endpoints to Implement

Based on the OpenAPI spec, we need these Tier 1 endpoints:

| Method | Path | Description |
|--------|------|-------------|
| POST | `/assistants` | Create a new assistant |
| GET | `/assistants/{assistant_id}` | Get an assistant by ID |
| PATCH | `/assistants/{assistant_id}` | Update an assistant |
| DELETE | `/assistants/{assistant_id}` | Delete an assistant |

Tier 2 endpoints (later):
- POST `/assistants/search` — Search/list assistants
- POST `/assistants/count` — Count assistants

---

## API Contract (from OpenAPI spec)

### Assistant Response Schema
```json
{
  "assistant_id": "uuid",
  "graph_id": "agent",
  "config": {
    "tags": [],
    "recursion_limit": 25,
    "configurable": {}
  },
  "metadata": {},
  "name": "string | null",
  "description": "string | null",
  "version": 1,
  "created_at": "2026-02-04T12:00:00Z",
  "updated_at": "2026-02-04T12:00:00Z"
}
```

### AssistantCreate Request
```json
{
  "graph_id": "agent",  // required
  "config": {},         // optional
  "metadata": {},       // optional
  "name": "string",     // optional
  "description": "string" // optional
}
```

### AssistantPatch Request
```json
{
  "graph_id": "agent",  // optional
  "config": {},         // optional
  "metadata": {},       // optional (merges with existing)
  "name": "string",     // optional
  "description": "string" // optional
}
```

---

## Implementation Plan

### 1. Update Models (`robyn_server/models.py`)
- Add `version` field to Assistant model
- Add `description` field to Assistant model
- Add `context` field (optional, for static context)
- Ensure datetime serialization is ISO 8601

### 2. Create Routes Module (`robyn_server/routes/assistants.py`)
- Keep routes separate from app.py for organization
- Each endpoint function:
  1. Parse and validate request body (Pydantic)
  2. Get authenticated user via `require_user()`
  3. Call storage layer with owner_id
  4. Return JSON response with correct shape

### 3. Register Routes in `app.py`
- Import and wire up assistant routes

### 4. Error Handling
- 404 for assistant not found
- 422 for validation errors
- Error response format: `{"detail": "message"}`

---

## Files to Create/Modify

| File | Action |
|------|--------|
| `robyn_server/models.py` | Update Assistant model |
| `robyn_server/routes/__init__.py` | Create |
| `robyn_server/routes/assistants.py` | Create |
| `robyn_server/app.py` | Register routes |
| `robyn_server/tests/test_assistants.py` | Create |

---

## Progress

- [x] Update Assistant model with version, description fields
- [x] Create routes directory structure
- [x] Implement POST /assistants
- [x] Implement GET /assistants/{assistant_id}
- [x] Implement PATCH /assistants/{assistant_id}
- [x] Implement DELETE /assistants/{assistant_id}
- [x] Register routes in app.py
- [x] Create unit tests
- [ ] Manual testing with curl (deferred - server needs full wiring)
- [x] Update scratchpad with completion notes

---

## Notes

- The OpenAPI spec shows `graph_id` enum is `["agent"]` — hardcoded to our single graph
- `version` field: We'll start at 1 and increment on updates (simplified versioning)
- `context` field: Static context for the assistant (optional, can be empty object)
- All responses must match LangGraph API shape exactly for SDK compatibility

---

## Completion Summary

### What Was Implemented

**File: `robyn_server/models.py`** (Updated)
- `AssistantConfig` — Added `tags`, `recursion_limit` fields
- `AssistantCreate` — Added `assistant_id`, `context`, `description`, `if_exists`
- `AssistantPatch` — Renamed from `AssistantUpdate`, added `context`, `description`
- `Assistant` — Added `context`, `description`, `version` fields
- Added Pydantic v2 `field_serializer` for datetime → ISO 8601 with Z suffix
- Added `Thread`, `Run` model updates for consistency
- Added `AssistantSearchRequest`, `AssistantCountRequest` for Tier 2

**File: `robyn_server/storage.py`** (Updated)
- `AssistantStore._to_model()` — Updated to handle new fields
- `AssistantStore.update()` — Auto-increments version on changes
- `ThreadStore._to_model()` — Added `status`, `values` fields
- `RunStore._to_model()` — Added `kwargs`, `multitask_strategy` fields

**File: `robyn_server/routes/assistants.py`** (Created, 353 lines)
- `register_assistant_routes(app)` — Registers all assistant routes
- `POST /assistants` — Create with owner stamping, if_exists handling
- `GET /assistants/:assistant_id` — Get with owner filtering
- `PATCH /assistants/:assistant_id` — Partial update with version increment
- `DELETE /assistants/:assistant_id` — Delete with owner check
- `POST /assistants/search` — Search/list with filtering (Tier 2)
- `POST /assistants/count` — Count with filtering (Tier 2)
- Helper functions: `json_response()`, `error_response()`, `parse_json_body()`

**File: `robyn_server/routes/__init__.py`** (Updated)
- Exports `register_assistant_routes`

**File: `robyn_server/app.py`** (Updated)
- Imports and calls `register_assistant_routes(app)`

**File: `robyn_server/tests/test_assistants.py`** (Created, 494 lines)
- 32 unit tests covering:
  - Helper functions (json_response, error_response, parse_json_body)
  - Pydantic model validation
  - Storage integration (CRUD, owner isolation)
  - Search and filter functionality
  - Config handling
  - Edge cases

### Test Results

\`\`\`
120 passed in 0.18s
\`\`\`

- 41 auth tests (Task 02)
- 47 storage tests (Task 03)
- 32 assistants tests (Task 04)

### API Endpoints Implemented

| Method | Path | Status |
|--------|------|--------|
| POST | `/assistants` | ✅ Implemented |
| GET | `/assistants/:assistant_id` | ✅ Implemented |
| PATCH | `/assistants/:assistant_id` | ✅ Implemented |
| DELETE | `/assistants/:assistant_id` | ✅ Implemented |
| POST | `/assistants/search` | ✅ Implemented (Tier 2) |
| POST | `/assistants/count` | ✅ Implemented (Tier 2) |

### Ready for Task 05

The assistants endpoints are complete. Next task (Task 05) will implement Threads endpoints following the same pattern:
- POST `/threads`
- GET `/threads/:thread_id`
- PATCH `/threads/:thread_id`
- DELETE `/threads/:thread_id`
- GET `/threads/:thread_id/state`
- GET `/threads/:thread_id/history`