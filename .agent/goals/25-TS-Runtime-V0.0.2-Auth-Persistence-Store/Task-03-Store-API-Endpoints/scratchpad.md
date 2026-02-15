# Task-03: Store API Endpoints

> **Status:** 🟢 Complete
> **Created:** 2025-07-21
> **Completed:** 2025-07-21
> **Parent Goal:** [Goal 25 — TS Runtime v0.0.2](../scratchpad.md)

---

## Objective

Implement cross-thread long-term memory via the Store API — 5 new HTTP endpoints across 3 paths, matching the Python runtime's store routes exactly.

---

## Deliverables

### Files Created (4 new)

| File | Purpose |
|------|---------|
| `src/models/store.ts` | `StoreItem` type, `StorePutRequest`, `StoreSearchRequest`, `StoreGetDeleteParams`, response types |
| `src/routes/store.ts` | 5 route handlers + `registerStoreRoutes()` |
| `tests/store.test.ts` | 89 tests — unit (storage layer) + integration (HTTP routes) + e2e flow |
| `.agent/goals/25-*/Task-03-*/scratchpad.md` | This file |

### Files Modified (4 existing)

| File | Changes |
|------|---------|
| `src/storage/types.ts` | Added `StoreStorage` interface (6 methods), added `store` property to `Storage` container |
| `src/storage/memory.ts` | Added `InMemoryStoreStorage` class, updated `InMemoryStorage` to include `store` |
| `src/storage/postgres.ts` | Added `PostgresStoreStorage` class with full SQL, updated `PostgresStorage` to include `store` |
| `src/index.ts` | Added `import { registerStoreRoutes }` + `registerStoreRoutes(router)` |

---

## API Endpoints Implemented

| Method | Path | Handler | Description |
|--------|------|---------|-------------|
| `PUT` | `/store/items` | `handlePutStoreItem` | Upsert item (body: namespace, key, value, metadata?) |
| `GET` | `/store/items` | `handleGetStoreItem` | Get item (query: namespace, key) |
| `DELETE` | `/store/items` | `handleDeleteStoreItem` | Delete item (query: namespace, key) |
| `POST` | `/store/items/search` | `handleSearchStoreItems` | Search items (body: namespace, prefix?, limit?, offset?) |
| `GET` | `/store/namespaces` | `handleListNamespaces` | List namespaces for authenticated user |

**Total routes after Task-03:** 36 (31 from v0.0.1 + 5 new store routes)

---

## Architecture Decisions

### 1. Matching Python's Actual Implementation

The goal scratchpad described `namespace: string[]` (array) and `POST /store/namespaces`, but the Python runtime uses:
- `namespace: string` (simple string)
- `GET /store/namespaces` (no request body)

**Decision:** Match Python's actual implementation for runtime parity. The LangGraph spec's array-based namespaces can be added later if needed.

### 2. Owner Scoping via `getUserIdentity()`

All store operations resolve the owner ID via `getUserIdentity()` from the auth middleware context. When auth is disabled (Supabase not configured), `ownerId` defaults to `"anonymous"` — the store is still fully functional in development.

### 3. StoreStorage Interface Design

The `StoreStorage` interface mirrors Python's `StoreStorage` class exactly:
- `put(namespace, key, value, ownerId, metadata?)` → `StoreItem`
- `get(namespace, key, ownerId)` → `StoreItem | null`
- `delete(namespace, key, ownerId)` → `boolean`
- `search(namespace, ownerId, prefix?, limit?, offset?)` → `StoreItem[]`
- `listNamespaces(ownerId)` → `string[]`
- `clear()` → `void` (testing only)

### 4. In-Memory Storage Structure

Nested `Map` structure: `ownerId → namespace → key → StoreRecord`

Matches Python's `{owner_id: {namespace: {key: StoreItem}}}` dict structure.

### 5. Postgres Implementation

- Uses `langgraph_server.store_items` table (DDL already exists from Task-02)
- Composite PK: `(namespace, key, owner_id)`
- Upsert via `INSERT ... ON CONFLICT ... DO UPDATE SET`
- Two SQL paths for metadata handling (with/without) to avoid Postgres.js template literal type issues
- `LIKE` operator for prefix search with `ORDER BY key ASC`
- `SELECT DISTINCT namespace` for `listNamespaces`

---

## Test Coverage

**89 new tests** across 8 describe blocks:

| Block | Tests | Coverage |
|-------|-------|----------|
| `InMemoryStoreStorage > put` | 7 | Create, upsert, metadata handling, owner isolation, namespace isolation |
| `InMemoryStoreStorage > get` | 5 | Existing item, missing key/namespace/owner, no ownerId leakage |
| `InMemoryStoreStorage > delete` | 5 | Delete existing, missing key/namespace/owner, isolation |
| `InMemoryStoreStorage > search` | 10 | All items, prefix filter, sort order, limit, offset, pagination, defaults |
| `InMemoryStoreStorage > listNamespaces` | 4 | Empty, with items, owner isolation, missing owner |
| `InMemoryStoreStorage > clear + shape` | 5 | Clear, field presence, timestamp format, nested objects |
| `Storage container — store` | 2 | Property exists, clearAll includes store |
| HTTP route tests (5 endpoint blocks) | 51 | All status codes, validation, method guards, e2e flow |

**Total project test count:** 987 (898 existing + 89 new)

---

## Acceptance Criteria

- [x] `PUT /store/items` creates/updates item, returns 200 with StoreItem
- [x] `GET /store/items` retrieves item by namespace + key (200 or 404)
- [x] `DELETE /store/items` removes item, returns 200 with `{}` (or 404)
- [x] `POST /store/items/search` filters by namespace, prefix, limit/offset
- [x] `GET /store/namespaces` lists unique namespaces for the authenticated user
- [x] All operations scoped by authenticated user (owner_id)
- [x] Graceful handling when auth disabled (defaults to "anonymous" owner)
- [x] Response shapes match Python runtime exactly
- [x] Wrong HTTP methods return 405 (method guards verified)
- [x] Validation errors return 422 with `{"detail": "..."}` shape
- [x] TypeScript compiles clean (`tsc --noEmit` passes)
- [x] All 987 tests pass (89 new + 898 existing)
- [x] Postgres implementation ready (PostgresStoreStorage using store_items table)
- [x] In-memory implementation complete with full test coverage

---

## Notes

- The `StoreItem` response intentionally excludes `owner_id` — it's implicit from the authenticated user, matching Python's `StoreItem.to_dict()` output.
- Pagination defaults: `limit=10`, `offset=0`. Limit is clamped to `[1, 100]`, offset to `[0, ∞)`.
- The `/store/items/search` route is registered before `/store/items` to ensure "search" is matched as a literal path segment by the router.
- The Postgres `put()` uses two separate SQL queries (metadata provided vs. not) instead of a conditional expression, because Postgres.js's tagged template literal typing doesn't allow mixing `JSONValue` and `PendingQuery` in the same template.