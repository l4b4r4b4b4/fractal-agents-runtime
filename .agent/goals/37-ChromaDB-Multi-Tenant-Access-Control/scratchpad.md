# Goal 37: ChromaDB Multi-Tenant Access Control with Supabase JWT

> **Status:** ⚪ Not Started
> **Priority:** P2 (security hardening — not blocking release, but required before production)
> **Branch:** TBD
> **Created:** 2026-02-20
> **Depends on:** Goal 34 (Python RAG — ✅ Complete), Goal 35 (TS RAG — ⚪ Not Started)
> **Reference:** `.agent/rag-feature.md`, `docs/rag-archive-retrieval.md`

---

## Objectives

Currently the runtime queries ChromaDB collections without any authentication
or authorization. Any process on the Docker network can read any collection if
it knows the name. The security model relies entirely on the platform sending
the correct `rag_config` — the runtime trusts it blindly.

This goal adds defense-in-depth by:

1. Using ChromaDB v2's native **tenant** and **database** namespaces to isolate
   data per organization and repository
2. Validating the Supabase JWT's organization/repository claims against the
   requested collections before querying
3. Ensuring a compromised or misconfigured agent cannot access collections
   belonging to other organizations

### Success Criteria

- [ ] ChromaDB collections are organized under tenant/database namespaces
  (e.g. tenant=`org_{organization_id}`, database=`repo_{repository_id}`)
- [ ] Runtime extracts organization/repository identity from Supabase JWT or
  thread-level configurable
- [ ] Runtime validates that the requested `rag_config.archives` are authorized
  for the authenticated user's organization
- [ ] Unauthorized collection access returns a clear error (not silent empty results)
- [ ] DocProc pipeline creates collections under the correct tenant/database namespace
- [ ] Existing test data and seed scripts updated for namespaced collections
- [ ] Python runtime implements access control
- [ ] TypeScript runtime implements access control
- [ ] Unit tests for authorization logic
- [ ] Integration test: user A cannot access user B's collections

---

## Architecture Decisions

### 1. ChromaDB v2 tenant/database mapping

ChromaDB v2 API uses a three-level hierarchy:

```
tenant → database → collection
```

Natural mapping to our domain:

| ChromaDB level | Maps to | Example |
|---------------|---------|---------|
| `tenant` | Organization | `org_a1b2c3d4-e5f6-7890-abcd-ef1234567890` |
| `database` | Repository | `repo_f9e8d7c6-b5a4-3210-fedc-ba0987654321` |
| `collection` | Document layer | `chunks`, `pages`, `sections`, `documents` |

This means:
- Each organization gets its own tenant (full isolation at the storage level)
- Each repository is a database within the tenant
- Layer types become collections within the database

**Alternative considered:** Keep flat `default_tenant/default_database` and
filter by metadata `organization_id`. Rejected because it provides no storage-
level isolation — a query bug or misconfiguration could leak data across orgs.

### 2. Authorization flow

```
Request arrives with Supabase JWT
  ↓
Extract user identity: sub, email, org memberships
  ↓
Query Supabase for user's repository access
  (which repositories does this user's org own?)
  ↓
For each archive in rag_config:
  - Parse org_id from collection naming convention or rag_config metadata
  - Validate user's org has access to that org_id's tenant
  - If unauthorized → skip archive with warning (or error)
  ↓
Query only authorized collections
```

### 3. JWT claims vs. Supabase RPC lookup

**Option A: JWT custom claims** — Encode `organization_id` and authorized
`repository_ids` into the JWT via Supabase custom claims hook. Fast (no extra
network call), but JWT size grows with many repositories.

**Option B: Supabase RPC at runtime** — Call a Supabase RPC function that
returns the user's authorized repositories. More flexible, always up-to-date,
but adds latency per request.

**Recommendation:** Start with Option B (RPC lookup) for correctness and
simplicity. Cache the result per session/thread to avoid repeated calls.
Consider Option A as a performance optimization later.

### 4. ChromaDB authentication

ChromaDB itself supports server-side auth via:
- **Token-based auth** (`CHROMA_SERVER_AUTHN_PROVIDER=token`)
- **RBAC** (`CHROMA_SERVER_AUTHZ_PROVIDER=local`)

For Phase 1, we implement authorization **in the runtime** (validate before
querying). For Phase 2, we could add ChromaDB-native auth so that even direct
ChromaDB access requires a valid token.

### 5. Backward compatibility

During migration:
- Collections in `default_tenant/default_database` continue to work
- New collections created under namespaced tenants
- Runtime falls back to default tenant if no org context available
- Migration script to move existing collections to namespaced tenants

---

## Task Breakdown

### Task-01: Supabase repository access lookup

**Status:** ⚪ Not Started

- RPC function or query to check: "which repository IDs does this user have
  access to?"
- Supabase schema: `repositories` table with `organization_id` foreign key,
  user ↔ org membership
- Cache strategy: per-thread or per-session (TTL-based)
- Python + TypeScript implementations

### Task-02: Authorization middleware for RAG

**Status:** ⚪ Not Started

- `authorize_rag_archives(jwt, rag_config) -> AuthorizedRagConfig`
- Filters `archives` list to only those the user is authorized to access
- Logs warnings for unauthorized access attempts
- Returns filtered config (not an error — graceful degradation)
- Python + TypeScript implementations
- Unit tests with mocked Supabase responses

### Task-03: ChromaDB namespaced tenant/database creation

**Status:** ⚪ Not Started

- Update DocProc pipeline to create collections under
  `tenant=org_{org_id}`, `database=repo_{repo_id}`
- Update `rag_config` contract to include `tenant` and `database` fields
  (or derive them from naming convention)
- Update `chromadb.HttpClient` calls to specify `tenant` and `database`
- Migration script for existing collections
- Update seed script for testing

### Task-04: Runtime integration (Python)

**Status:** ⚪ Not Started

- Wire authorization into `create_archive_search_tool()` or graph-level
  before tool creation
- Pass tenant/database to ChromaDB client
- Integration tests

### Task-05: Runtime integration (TypeScript)

**Status:** ⚪ Not Started

- Mirror Python implementation
- Integration tests

### Task-06: E2E access control test

**Status:** ⚪ Not Started

- Create two test users in different organizations
- Create collections under different tenants
- Verify user A can search their org's collections
- Verify user A cannot search user B's org's collections
- Verify graceful error messaging

---

## ChromaDB v2 API Reference

### Tenant management

```
GET    /api/v2/tenants/{tenant}
POST   /api/v2/tenants
```

### Database management

```
GET    /api/v2/tenants/{tenant}/databases/{database}
POST   /api/v2/tenants/{tenant}/databases
```

### Collection access (namespaced)

```
GET    /api/v2/tenants/{tenant}/databases/{database}/collections
GET    /api/v2/tenants/{tenant}/databases/{database}/collections/{collection_id}
POST   /api/v2/tenants/{tenant}/databases/{database}/collections/{collection_id}/query
```

### Python client usage

```python
import chromadb

client = chromadb.HttpClient(
    host="chromadb",
    port=8000,
    tenant="org_a1b2c3d4",
    database="repo_f9e8d7c6",
)
collection = client.get_collection("chunks")
results = collection.query(query_embeddings=[...], n_results=5)
```

---

## Config Contract Changes

### Current `rag_config`

```json
{
  "archives": [
    {
      "name": "Archive Name",
      "collection_name": "repo_test-rag-archive",
      "chromadb_url": "http://chromadb:8000",
      "embedding_model": "jinaai/jina-embeddings-v2-base-de"
    }
  ]
}
```

### Proposed `rag_config` (with namespace fields)

```json
{
  "archives": [
    {
      "name": "Archive Name",
      "collection_name": "chunks",
      "chromadb_url": "http://chromadb:8000",
      "embedding_model": "jinaai/jina-embeddings-v2-base-de",
      "tenant": "org_a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "database": "repo_f9e8d7c6-b5a4-3210-fedc-ba0987654321",
      "organization_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "repository_id": "f9e8d7c6-b5a4-3210-fedc-ba0987654321"
    }
  ]
}
```

New fields (`tenant`, `database`, `organization_id`, `repository_id`) are
optional for backward compatibility. When absent, the runtime falls back to
`default_tenant` / `default_database` and skips authorization checks.

---

## Risks & Mitigations

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Supabase RPC lookup adds latency | Medium | Cache per session/thread; consider JWT claims later |
| DocProc pipeline changes required | High | Coordinate with DocProc team; migration script for existing data |
| ChromaDB tenant creation requires admin access | Medium | Separate admin client for tenant/database provisioning |
| Breaking change in `rag_config` contract | Medium | New fields are optional; backward compatible with defaults |
| Complex migration for existing collections | Medium | Migration script + parallel operation period |
| ChromaDB v2 tenant API limitations | Low | Test thoroughly; v2 API is stable |

---

## Completion Log

| Date | What | Notes |
|------|------|-------|
| 2026-02-20 | Goal created | Identified during E2E test — no access control on ChromaDB queries |