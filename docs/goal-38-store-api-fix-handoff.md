# Goal 38 — Store API Namespace Fix + OpenAPI Alignment

**Branch:** `feat/rag-chromadb-retriever`
**Status:** Tasks 01–03 complete, Task 04 (E2E) ready to run
**Images:** `fractal-agents-runtime-python:local-dev`, `fractal-agents-runtime-ts:local-dev` — both rebuilt

---

## What Was Broken

`GET` and `DELETE /store/items` always returned **404** on Postgres, even for items that exist.

**Root cause:** PUT/search receive namespace from JSON body as a Python list (`["preferences"]`), which psycopg serialises as Postgres array text `{preferences}`. GET/DELETE receive namespace from query params as a plain string (`preferences`), which doesn't match `{preferences}` in the DB.

## What Was Fixed

### 1. Namespace normalisation in Postgres storage layer

Added `_normalise_namespace()` helper to `postgres_storage.py`. All four storage methods (`put`, `get`, `delete`, `search`) now accept `str | list[str]` and normalise to `list[str]` before the SQL query. Route handlers are untouched — they pass whatever they receive; the storage layer handles the difference.

### 2. OpenAPI spec alignment (3 mismatches)

| # | Endpoint | Was | Now |
|---|----------|-----|-----|
| 1 | `GET /store/namespaces` | Spec said `POST` with request body | Spec says `GET`, no body |
| 2 | `POST /store/items/search` | Spec field `namespace_prefix` | Spec field `namespace` |
| 3 | `DELETE /store/items` | Spec said JSON body | Spec says query params `?namespace=…&key=…` |

Removed orphaned schemas `StoreDeleteRequest` and `StoreListNamespacesRequest`. Regenerated `openapi-spec.json`.

### 3. TS runtime — no fix needed

TS stores plain strings consistently. GET/DELETE match PUT. No bug. (Separate issue: TS rejects array namespaces from LangGraph SDK — future work if needed.)

## Files Changed

| File | Change |
|------|--------|
| `apps/python/src/server/postgres_storage.py` | Added `_normalise_namespace()`, updated `put/get/delete/search` signatures to `str \| list[str]` |
| `apps/python/src/server/openapi_spec.py` | Fixed 3 endpoint specs, removed 2 orphaned schemas |
| `apps/python/openapi-spec.json` | Regenerated |
| `apps/python/src/server/tests/test_openapi.py` | Updated schema assertions |
| `apps/python/tests/test_normalise_namespace.py` | **New** — 20 unit tests for normalisation helper |

## Test Results

```
1261 passed, 0 failed, 35 skipped
Ruff: All checks passed, 92 files unchanged
```

## E2E Verification (Task-04 — do this now)

Both Docker images are rebuilt. Run against your local Supabase:

```bash
# Start the Python runtime
docker compose up python-runtime -d

# 1. PUT an item
curl -s -X PUT http://localhost:9091/store/items \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"namespace": ["preferences"], "key": "language", "value": {"lang": "de"}}'
# → 200

# 2. GET it back (this was the broken path)
curl -s "http://localhost:9091/store/items?namespace=preferences&key=language" \
  -H "Authorization: Bearer $TOKEN"
# → 200 with item (was 404 before fix)

# 3. DELETE it (this was also broken)
curl -s -X DELETE "http://localhost:9091/store/items?namespace=preferences&key=language" \
  -H "Authorization: Bearer $TOKEN"
# → 200 {} (was 404 before fix)

# 4. Confirm deletion
curl -s "http://localhost:9091/store/items?namespace=preferences&key=language" \
  -H "Authorization: Bearer $TOKEN"
# → 404 (correctly gone now)
```

## Webapp Integration Notes

- **Store API is now fully functional** — PUT → GET → DELETE round-trip works
- **OpenAPI spec is accurate** — regenerate any SDK clients from the updated spec
- **Namespace format in responses** stays as stored in DB (Postgres array text like `{preferences}`) — the webapp should treat this as an opaque string
- **No breaking changes** for existing PUT/search consumers — they already send lists