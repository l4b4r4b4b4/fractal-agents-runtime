# Goal 38: Store API Namespace Fix + OpenAPI Alignment

> **Status:** 🟡 In Progress (Tasks 01–03 complete, Task 04 E2E pending)
> **Priority:** P1 (GET and DELETE store endpoints are completely broken on Postgres)
> **Branch:** feat/rag-chromadb-retriever (current working branch)
> **Created:** 2026-02-20
> **Depends on:** None
> **Bug report:** `.agent/bugs/store-get-delete-namespace-mismatch.md`

---

## Objectives

Fix the Store API so that `GET /store/items` and `DELETE /store/items` actually
work on the Postgres backend. Currently they **always return 404** for items
that exist in the database due to a namespace format mismatch between how
PUT/search pass the namespace (Python list → Postgres array text `{preferences}`)
versus how GET/DELETE pass it (plain query param string `preferences`).

Additionally, align the OpenAPI spec with actual endpoint behaviour — three
mismatches were discovered during testing.

### Success Criteria

- [ ] `GET /store/items?namespace=preferences&key=language` returns the item (not 404)
- [ ] `DELETE /store/items?namespace=preferences&key=language` deletes the item (not 404)
- [ ] `PUT` → `GET` → `DELETE` round-trip works end-to-end on Postgres backend
- [ ] `PUT` → `POST /store/items/search` → `GET` → `DELETE` all use consistent namespace format
- [ ] OpenAPI spec matches actual endpoint behaviour (method, field names, params)
- [ ] Python storage layer normalises `str | list` namespace defensively
- [ ] TypeScript runtime verified (may need array namespace acceptance for LangGraph SDK compat)
- [ ] Existing tests updated + new tests for the fixed paths
- [ ] No regression on PUT, search, or namespaces endpoints

---

## Root Cause Analysis

### The mismatch (Python runtime only)

| Endpoint | Source | Python type | Postgres query value | DB stored value | Match? |
|----------|--------|-------------|---------------------|-----------------|--------|
| PUT | JSON body | `list ["preferences"]` | `'{preferences}'` | `'{preferences}'` | ✅ |
| Search | JSON body | `list ["preferences"]` | `'{preferences}'` | `'{preferences}'` | ✅ |
| GET | Query param | `str "preferences"` | `'preferences'` | `'{preferences}'` | ❌ |
| DELETE | Query param | `str "preferences"` | `'preferences'` | `'{preferences}'` | ❌ |

The LangGraph SDK convention is `namespace: list[str]` (tuple). The Python PUT
handler reads `body.get("namespace")` which preserves the JSON array as a Python
list. psycopg serialises this list as a Postgres array literal `{preferences}`.
But GET/DELETE read from query params → always a plain string → mismatch.

### TypeScript runtime: NOT affected

The TS PUT handler explicitly validates `typeof namespace !== "string"` and
**rejects arrays**. It stores plain strings, GET/DELETE query with plain strings
→ consistent. However, this means the TS runtime is **incompatible with
LangGraph SDK clients** that send namespace as an array. This should be
addressed for SDK compatibility.

### Deeper issue: DB column type

The `namespace` column is `TEXT` but stores Postgres array text literals like
`{preferences}`. This is a code smell — either:
- The column should be `TEXT[]` (proper array type), or
- The storage layer should normalise arrays to a canonical string format

For this goal, we normalise at the application layer (Option C from the bug
report). A column type migration is a separate, riskier change.

---

## Architecture Decisions

### 1. Fix in both layers (Option C — belt and suspenders)

**Route handlers** wrap query param strings in a list before calling storage.
**Storage layer** normalises `str | list` internally. This ensures consistency
regardless of which layer calls the storage.

### 2. Canonical namespace format

Adopt a `_normalise_namespace()` helper:
- `str "preferences"` → `["preferences"]`
- `list ["preferences"]` → `["preferences"]` (no-op)
- `list ["org", "user", "agent", "tokens"]` → `["org", "user", "agent", "tokens"]` (no-op)

This helper is used in every storage method and in route handlers for
GET/DELETE.

### 3. OpenAPI spec alignment — match implementation, not vice versa

The running code is the source of truth. Fix the spec to match, not the other
way around. Changing endpoint behaviour would break existing consumers.

---

## Task Breakdown

### Task-01: Python namespace fix (routes + storage)

**Status:** 🟢 Complete

**Files to modify:**

1. `apps/python/src/server/routes/store.py`
   - Route handlers left unchanged — storage layer handles normalisation
   - (Initial attempt to wrap in route handlers caused `TypeError: unhashable type: 'list'`
     in the in-memory `StoreStorage` used by tests — reverted to storage-only approach)

2. `apps/python/src/server/postgres_storage.py`
   - Add `_normalise_namespace()` helper at module level
   - `PostgresStoreStorage.get()`: normalise namespace param
   - `PostgresStoreStorage.delete()`: normalise namespace param
   - `PostgresStoreStorage.put()`: normalise namespace param (defensive)
   - `PostgresStoreStorage.search()`: normalise namespace param (defensive)
   - `PostgresStoreStorage.list_namespaces()`: no change needed (no namespace param)

3. `apps/python/src/server/openapi_spec.py` + `apps/python/openapi-spec.json`
   - Fix 1: `/store/namespaces` — change from `POST` to `GET`, remove request body
   - Fix 2: `/store/items/search` — rename `namespace_prefix` to `namespace` in schema
   - Fix 3: `/store/items` DELETE — change from request body to query parameters

**Implementation detail — `_normalise_namespace()`:**

```python
def _normalise_namespace(namespace: str | list) -> list:
    """Normalise namespace to list for Postgres array serialisation.

    The LangGraph SDK convention is namespace as a list/tuple of strings.
    Query params arrive as plain strings. This function ensures consistent
    format regardless of source.

    Args:
        namespace: Namespace as string or list of strings.

    Returns:
        Namespace as a list of strings.
    """
    if isinstance(namespace, str):
        return [namespace]
    return list(namespace)
```

**Tests added:**

- `tests/test_normalise_namespace.py` — 20 unit tests covering:
  - `TestNormaliseNamespaceStringInput` (5 tests): string wrapping, dotted strings, empty, spaces, curly braces
  - `TestNormaliseNamespaceListInput` (5 tests): single/multi-segment, empty list, edge cases
  - `TestNormaliseNamespaceReturnType` (4 tests): list type, new reference, tuple conversion
  - `TestNormaliseNamespaceConsistency` (6 tests): parametrized str↔list equivalence, real-world scenarios
- `src/server/tests/test_openapi.py` — updated `test_store_schemas_exist` (removed deleted schemas),
  added `test_removed_store_schemas_absent`, fixed POST exclusion for `/store/namespaces`
- All 5 previously-failing tests in `test_postgres_storage_unit.py` and `test_route_handlers.py` now pass

**Implementation notes:**

- Route handlers do NOT wrap namespace in list — normalisation happens only in `PostgresStoreStorage`
- `put()` returns original namespace in `PostgresStoreItem`, not `str(normalised_namespace)`
  (which would give Python repr `"['ns']"` instead of the original value)
- In-memory `StoreStorage` is not modified — it uses plain strings as dict keys and
  is only used in development/tests where namespace comes as a string

### Task-02: TypeScript namespace compatibility check

**Status:** 🟢 Complete — No fix needed

**Investigation results:**
- TS PUT handler validates `typeof namespace !== "string"` → rejects arrays
- TS `StorePutRequest.namespace` is typed as `string`
- TS `PostgresStoreStorage` stores plain strings, GET/DELETE query with plain strings
- TS is **internally consistent** — no namespace mismatch bug
- Outcome #1 confirmed: TS stores plain strings, SDK sends plain strings → no bug

**Note:** TS is incompatible with LangGraph SDK clients that send namespace as
`string[]` (array). This is a **separate compatibility issue** (not a bug in
the current TS runtime). Can be addressed in a future goal if needed.

**Files verified:**
- `apps/ts/src/routes/store.ts` — PUT validates string, GET/DELETE use query params ✅
- `apps/ts/src/storage/postgres.ts` — `PostgresStoreStorage` all methods use plain strings ✅
- `apps/ts/src/models/store.ts` — `StorePutRequest.namespace: string` ✅

### Task-03: OpenAPI spec alignment (Python + TS)

**Status:** 🟢 Complete

**Python OpenAPI mismatches (3 issues):**

| # | Issue | Spec says | Code does | Fix |
|---|-------|-----------|-----------|-----|
| 1 | `GET /store/namespaces` | `POST` with `StoreListNamespacesRequest` body | `GET` with no body | Change spec to `GET`, remove request body schema |
| 2 | `POST /store/items/search` field name | `namespace_prefix` (array) | `body.get("namespace")` | Rename field in spec to `namespace` |
| 3 | `DELETE /store/items` params | Request body (`StoreDeleteRequest`) | Query params `?namespace=...&key=...` | Change spec to query params, remove request body schema |

**TS OpenAPI:**
- `/store/namespaces` is already `GET` ✅
- TS has no OpenAPI spec mismatches — already correct

**Files modified:**
- `apps/python/src/server/openapi_spec.py` — all 3 fixes applied + removed orphaned schemas
- `apps/python/openapi-spec.json` — regenerated (114,868 bytes, 34 paths, 44 ops, 26 schemas)
- `apps/python/src/server/tests/test_openapi.py` — updated schema assertions

**Schemas removed:**
- `StoreDeleteRequest` — replaced by query parameters on DELETE endpoint
- `StoreListNamespacesRequest` — no longer referenced after GET change

**Additional fixes in OpenAPI:**
- DELETE `/store/items` response changed from `204` to `200` (matches actual implementation)
- `StoreSearchRequest` now has `"required": ["namespace"]` (was missing)

### Task-04: E2E verification

**Status:** ⚪ Not Started (requires Docker rebuild)

- Rebuild Python Docker image
- PUT an item with namespace `["preferences"]`
- GET with `?namespace=preferences&key=...` → must return 200
- DELETE with `?namespace=preferences&key=...` → must return 200
- Verify search still works
- Verify namespaces listing still works
- Test multi-segment namespace: `["org", "user", "agent", "tokens"]`

**Pre-E2E verification (unit tests):**
- ✅ All 1261 tests pass (0 failures, 35 skipped)
- ✅ All 20 new normalisation tests pass
- ✅ All 29 OpenAPI tests pass
- ✅ Ruff check + format clean

---

## Affected Files Summary

### Python (must fix)

| File | Change |
|------|--------|
| `apps/python/src/server/routes/store.py` | Wrap namespace in list for GET/DELETE |
| `apps/python/src/server/postgres_storage.py` | Add `_normalise_namespace()`, use in all methods |
| `apps/python/src/server/openapi_spec.py` | Fix 3 spec mismatches |
| `apps/python/openapi-spec.json` | Regenerate from spec source |
| `apps/python/tests/` | Add round-trip tests, namespace normalisation tests |

### TypeScript (investigate, may need fix)

| File | Change |
|------|--------|
| `apps/ts/src/routes/store.ts` | May need to accept array namespace in PUT |
| `apps/ts/src/storage/postgres.ts` | May need normalisation if accepting arrays |
| `apps/ts/openapi-spec.json` | Verify alignment |

---

## Risks & Mitigations

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Normalisation changes break existing stored data | Low | Normalisation is additive — existing `{preferences}` data still works, GET/DELETE now also match |
| Multi-segment namespaces (4-component tuples) behave differently | Medium | Test with `["org", "user", "agent", "tokens"]` explicitly |
| OpenAPI spec changes break frontend consumers | Low | Changes align spec with existing behaviour — consumers already use the working endpoints |
| TS SDK compatibility unknown | Medium | Research LangGraph JS SDK namespace format before changing TS code |

---

## Database Schema Context

```sql
-- Current schema (namespace is TEXT, stores Postgres array text literals)
CREATE TABLE langgraph_server.store_items (
    namespace  TEXT NOT NULL,       -- stored as '{preferences}' or '{org,user,agent,tokens}'
    key        TEXT NOT NULL,
    value      JSONB NOT NULL DEFAULT '{}',
    owner_id   TEXT NOT NULL,
    metadata   JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (namespace, key, owner_id)
);
```

No schema migration needed for this fix — the normalisation happens at the
application layer.

---

## Completion Log

| Date | What | Notes |
|------|------|-------|
| 2026-02-20 | Goal created | Bug report in `.agent/bugs/store-get-delete-namespace-mismatch.md` |
| 2026-02-20 | Task-02 complete | TS runtime verified — internally consistent, no fix needed. Plain string namespace throughout. |
| 2026-02-20 | Task-01 started | Implementing `_normalise_namespace()` in postgres_storage.py + route handler wrapping |
| 2026-02-20 | Task-01 complete | Added `_normalise_namespace()` to postgres_storage.py, normalises in `put/get/delete/search`. Route handlers NOT modified (storage-only approach). 20 new tests added. 1261 tests pass. |
| 2026-02-20 | Task-03 complete | Fixed 3 OpenAPI mismatches: namespaces POST→GET, search namespace_prefix→namespace, delete body→query params. Removed 2 orphaned schemas. Regenerated openapi-spec.json. 29 OpenAPI tests pass. |
| 2026-02-20 | Task-04 pending | Docker rebuild + E2E round-trip test needed to fully close goal |