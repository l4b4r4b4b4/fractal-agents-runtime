# Bug Report: Store GET/DELETE endpoints fail due to namespace format mismatch

**Component:** `server/routes/store.py` + `server/postgres_storage.py`
**Severity:** High — GET and DELETE single-item endpoints are completely broken when using Postgres backend
**Affects:** `GET /store/items`, `DELETE /store/items`
**Works correctly:** `PUT /store/items`, `POST /store/items/search`, `GET /store/namespaces`

---

## Summary

The `GET /store/items` and `DELETE /store/items` endpoints always return 404 "Item not found" for items that demonstrably exist in the database. The root cause is a namespace format mismatch between how PUT/search pass the namespace to Postgres (as a Python list → serialized to Postgres array text `{preferences}`) versus how GET/DELETE pass it (as a plain query param string `preferences`).

---

## Steps to Reproduce

```bash
# 1. Authenticate
TOKEN=$(curl -s -X POST "http://127.0.0.1:54321/auth/v1/token?grant_type=password" \
  -H "apikey: <ANON_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.com","password":"password"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")

# 2. PUT an item (works — namespace is JSON array in body)
curl -s -X PUT http://localhost:8081/store/items \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"namespace": ["preferences"], "key": "language", "value": {"lang": "de"}}'
# → 200 OK, returns item

# 3. Search for it (works — namespace is JSON array in body)
curl -s -X POST http://localhost:8081/store/items/search \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"namespace": ["preferences"], "limit": 100}'
# → 200 OK, returns [{"namespace": "{preferences}", "key": "language", ...}]

# 4. GET single item (FAILS — namespace is query param string)
curl -s "http://localhost:8081/store/items?namespace=preferences&key=language" \
  -H "Authorization: Bearer $TOKEN"
# → 404 {"detail": "Item not found: preferences/language"}

# 5. DELETE single item (FAILS — namespace is query param string)
curl -s -X DELETE "http://localhost:8081/store/items?namespace=preferences&key=language" \
  -H "Authorization: Bearer $TOKEN"
# → 404 {"detail": "Item not found: preferences/language"}
```

---

## Root Cause

### Data flow for PUT and Search (working)

```
JSON body: {"namespace": ["preferences"], ...}
    ↓
Route handler: body.get("namespace") → Python list ["preferences"]
    ↓
PostgresStoreStorage.put(namespace=["preferences"], ...)
    ↓
psycopg parameterizes list as Postgres array literal: INSERT ... VALUES ('{preferences}', ...)
    ↓
DB stores: namespace = '{preferences}'
```

Search follows the same path — JSON body → list → psycopg array → matches DB.

### Data flow for GET and DELETE (broken)

```
Query param: ?namespace=preferences&key=language
    ↓
Route handler: request.query_params.get("namespace") → Python string "preferences"
    ↓
PostgresStoreStorage.get(namespace="preferences", ...)
    ↓
psycopg parameterizes string as text: SELECT ... WHERE namespace = 'preferences'
    ↓
DB has: namespace = '{preferences}'  ← MISMATCH → 0 rows returned → 404
```

### The mismatch

| Endpoint | Source | Python type | Postgres query value | DB stored value | Match? |
|----------|--------|-------------|---------------------|-----------------|--------|
| PUT | JSON body | `list ["preferences"]` | `'{preferences}'` | `'{preferences}'` | ✅ |
| Search | JSON body | `list ["preferences"]` | `'{preferences}'` | `'{preferences}'` | ✅ |
| GET | Query param | `str "preferences"` | `'preferences'` | `'{preferences}'` | ❌ |
| DELETE | Query param | `str "preferences"` | `'preferences'` | `'{preferences}'` | ❌ |

---

## Affected Code

### `server/routes/store.py`

**`get_store_item`** (line ~95-120):
```python
# Current: passes raw query param string
namespace = request.query_params.get("namespace", None)
# ...
item = await storage.store.get(
    namespace=namespace,  # ← string "preferences", should be list ["preferences"]
    key=key,
    owner_id=user.identity,
)
```

**`delete_store_item`** (line ~130-160):
```python
# Current: passes raw query param string
namespace = request.query_params.get("namespace", None)
# ...
deleted = await storage.store.delete(
    namespace=namespace,  # ← string "preferences", should be list ["preferences"]
    key=key,
    owner_id=user.identity,
)
```

---

## Suggested Fix

The simplest fix is to normalize the namespace in the route handlers, wrapping the query param string in a list before passing to storage. This makes GET/DELETE consistent with PUT/search.

### Option A: Fix in route handlers (minimal change)

In `server/routes/store.py`, for both `get_store_item` and `delete_store_item`:

```python
# Before storage call, wrap namespace string in list to match PUT/search format:
namespace = request.query_params.get("namespace", None)
if namespace:
    namespace = [namespace]  # normalize to list for Postgres array compatibility
```

### Option B: Fix in Postgres storage layer (more robust)

In `server/postgres_storage.py`, normalize namespace in `get()` and `delete()`:

```python
async def get(self, namespace: str | list, key: str, owner_id: str) -> PostgresStoreItem | None:
    # Normalize namespace to list for consistent Postgres array serialization
    if isinstance(namespace, str):
        namespace = [namespace]
    # ... rest of method
```

### Option C: Fix both (belt and suspenders)

Apply normalization in both layers. The storage layer accepts `str | list` and normalizes internally, while the route handler also wraps for clarity.

**Recommendation:** Option A is the smallest, safest change. Option B is more defensive if other callers might pass strings.

---

## Additional Finding: OpenAPI Spec Mismatches

While testing, two other discrepancies were found between the OpenAPI spec and actual behavior:

### 1. `GET /store/namespaces` registered as GET, documented as POST

The route is registered as `@app.get("/store/namespaces")` but the OpenAPI spec declares it as `POST /store/namespaces` with a `StoreListNamespacesRequest` body. The GET works; POST returns 404.

**Impact:** Low — GET is fine for listing, but consumers reading the OpenAPI spec will use the wrong method.

### 2. `POST /store/items/search` — field name mismatch

The OpenAPI schema (`StoreSearchRequest`) documents the field as `namespace_prefix`, but the route handler reads `body.get("namespace")`. Requests using `namespace_prefix` get "namespace is required".

**Impact:** Medium — API consumers following the spec will use the wrong field name.

### 3. `DELETE /store/items` — OpenAPI says body, implementation uses query params

The OpenAPI spec defines `StoreDeleteRequest` with a JSON body (`namespace` array + `key` string), but the route handler reads query params. Sending a body returns "namespace query parameter is required".

**Impact:** High — directly related to this bug. Consumers following the spec will send a body and fail.

---

## Database Schema Reference

```sql
-- Table: langgraph_server.store_items
CREATE TABLE langgraph_server.store_items (
    namespace TEXT NOT NULL,       -- stored as Postgres array text: '{preferences}'
    key       TEXT NOT NULL,
    value     JSONB NOT NULL DEFAULT '{}',
    owner_id  TEXT NOT NULL,       -- JWT sub claim
    metadata  JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (namespace, key, owner_id)
);
```

Actual data in DB after PUT:

```
   namespace   |         key         |               owner_id               |        value
---------------+---------------------+--------------------------------------+---------------------
 {preferences} | language            | a1b2c3d4-e5f6-7890-abcd-ef1234567890 | {"lang": "de", ...}
 {context}     | assigned_property   | a1b2c3d4-e5f6-7890-abcd-ef1234567890 | {"name": "...", ...}
 {facts}       | maintenance_contact | a1b2c3d4-e5f6-7890-abcd-ef1234567890 | {"name": "...", ...}
```

---

## Environment

- **Runtime image:** `fractal-agents-runtime-python:local-dev`
- **Runtime version:** OAP LangGraph Runtime v0.0.3
- **Backend:** Postgres (Supabase local, PostgreSQL 17)
- **Python:** 3.12
- **Web framework:** Robyn
