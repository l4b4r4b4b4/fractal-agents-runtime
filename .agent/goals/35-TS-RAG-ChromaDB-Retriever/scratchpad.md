# Goal 35: TypeScript RAG ChromaDB Retriever

> **Status:** 🟡 In Progress (research complete, implementation starting)
> **Priority:** P1 (blocks full RAG feature parity)
> **Branch:** `feat/rag-chromadb-retriever` (current working branch)
> **Created:** 2026-02-20
> **Depends on:** Goal 34 (Python RAG — ✅ Complete)
> **Reference:** `.agent/rag-feature.md`, `docs/rag-archive-retrieval.md`

---

## Objectives

Port the Python runtime's ChromaDB RAG retriever to the TypeScript runtime so
both runtimes have feature parity for archive-backed document retrieval. The
TypeScript runtime must handle the same `rag_config` contract that the platform
sends.

### Success Criteria

- [ ] `rag_config` with `archives` is read from `config.configurable` in TS runtime
- [ ] `search_archives` tool is dynamically registered when archives are configured
- [ ] Agent can invoke the tool and receive formatted document chunks
- [ ] Query embedding via TEI `/v1/embeddings` endpoint works correctly
- [ ] Error handling: unreachable ChromaDB / TEI → graceful degradation (no crash)
- [ ] Old LangConnect RAG (`rag.rag_url` + `rag.collections`) still works (backward compat)
- [ ] Unit tests for config extraction, embedding, ChromaDB query, tool creation
- [ ] Local Docker E2E: TS runtime agent searches real ChromaDB collection

---

## Key Finding: No New Dependencies Needed

The ChromaDB v2 REST API is simple enough to call via native `fetch()` (Bun
built-in). The TEI `/v1/embeddings` endpoint is OpenAI-compatible, also via
`fetch()`. **No `chromadb` npm package needed** — avoids dependency bloat and
potential Bun compatibility issues.

### ChromaDB v2 REST API (confirmed from Python `chromadb-client` source)

Default API version: `/api/v2` (from `chromadb/config.py:APIVersion.V2`)
Default tenant: `default_tenant` (from `chromadb/config.py:DEFAULT_TENANT`)
Default database: `default_database` (from `chromadb/config.py:DEFAULT_DATABASE`)

Path template from `chromadb/api/fastapi.py`:
`/tenants/{tenant}/databases/{database}/collections/{name_or_id}/...`

```
# Get collection by name (L311 in fastapi.py)
GET {base}/api/v2/tenants/default_tenant/databases/default_database/collections/{collection_name}

# Query collection by ID (L710 in fastapi.py — NOTE: uses collection ID, not name!)
POST {base}/api/v2/tenants/default_tenant/databases/default_database/collections/{collection_id}/query
{
  "query_embeddings": [[0.1, 0.2, ...]],
  "n_results": 5,
  "include": ["documents", "metadatas", "distances"],
  "where": {"layer": "chunk"}
}
```

**Important:** The `get_collection` endpoint takes the collection **name** and
returns the collection object including its **id**. The `query` endpoint takes
the collection **id** (UUID), not the name. So the flow is:
1. `GET .../collections/{name}` → get collection object with `id` field
2. `POST .../collections/{id}/query` → query using the UUID

### TEI `/v1/embeddings` (OpenAI-compatible)

```
POST {tei_base}/v1/embeddings
{
  "model": "jinaai/jina-embeddings-v2-base-de",
  "input": ["search query text"]
}
→ { "data": [{ "embedding": [0.1, 0.2, ...] }] }
```

---

## Architecture Decisions

### 1. Same `rag_config` contract as Python

The platform sends identical JSON regardless of runtime:

```json
{
  "rag_config": {
    "archives": [
      {
        "name": "Archive Name",
        "collection_name": "repo_{repository_id}",
        "chromadb_url": "http://chromadb:8000",
        "embedding_model": "jinaai/jina-embeddings-v2-base-de"
      }
    ]
  }
}
```

### 2. Direct HTTP via `fetch()` — no `chromadb` npm package

**Rationale:**
- ChromaDB v2 REST API has exactly 2 endpoints we need (get collection, query)
- `fetch()` is Bun-native — zero overhead, zero compatibility risk
- Avoids `chromadb` npm package (large, node-specific deps, Bun compat unknown)
- Python uses `chromadb-client` (HTTP-only) which is just a thin wrapper over HTTP anyway

### 3. Single new file: `chromadb-rag.ts`

All ChromaDB RAG code lives in one file:
`apps/ts/src/graphs/react-agent/utils/chromadb-rag.ts`

Contains: config types, extraction, embedding client, ChromaDB HTTP client,
result formatting, tool factory. Mirrors the Python `rag/` package (3 files)
but TS can be more compact.

### 4. Coexists with LangConnect RAG

The existing `rag-tools.ts` (Supabase LangConnect) is untouched. Both RAG
systems can be active simultaneously — they use different config keys:
- `rag` → LangConnect (existing)
- `rag_config` → ChromaDB archives (new)

### 5. German output format — identical to Python

```
[1] Archiv: Wartungsprotokoll (Ebene: chunk, Seite: 3)
Die Heizungsanlage wurde am 15. Januar 2025 gewartet...

---

[2] Archiv: Betriebskostenabrechnung (Ebene: chunk, Seite: 12)
Die Kosten für die Heizungswartung betrugen...
```

---

## Task Breakdown

### Task-01: `chromadb-rag.ts` — Config + Embedding + Retriever + Tool Factory

**Status:** ⚪ Not Started
**Effort:** Medium (~45 min)

**Single file to create:**
`apps/ts/src/graphs/react-agent/utils/chromadb-rag.ts`

Contents:

1. **Config types** (mirrors Python `rag/config.py`)
   - `RagArchiveConfig` interface: `name`, `collection_name`, `chromadb_url`, `embedding_model`
   - `ChromaRagConfig` interface: `archives: RagArchiveConfig[]`
   - `extractRagConfig(config)` — reads `config.rag_config`, validates, returns typed config or `null`

2. **TEI embedding client** (mirrors Python `rag/embeddings.py`)
   - `embedQuery(text, embeddingModel, teiUrl?)` → `Promise<number[]>`
   - Uses `fetch()` to hit TEI `/v1/embeddings`
   - Env fallbacks: `DOCPROC_TEI_EMBEDDINGS_URL` → `http://tei-embeddings:8080`
   - Timeout: `RAG_EMBED_TIMEOUT_SECONDS` → `10`
   - Typed error: `EmbeddingError extends Error`

3. **ChromaDB HTTP client** (replaces Python's `chromadb.HttpClient`)
   - `getCollection(baseUrl, collectionName)` → `Promise<{id: string, name: string} | null>`
     Uses GET `.../collections/{name}` to resolve name → UUID
   - `queryCollection(baseUrl, collectionId, embeddings, nResults, where?)` → results
     Uses POST `.../collections/{id}/query` with UUID (NOT name!)
   - Base path: `/api/v2/tenants/default_tenant/databases/default_database`
   - Uses `fetch()` + `AbortController` for timeouts
   - Timeout: `RAG_QUERY_TIMEOUT_SECONDS` → `5`

4. **Result formatting** (mirrors Python `rag/retriever.py:_format_results`)
   - `formatResults(results, topK)` → German formatted string
   - Same "Archiv: ..." format as Python
   - "Keine relevanten Dokumente gefunden." for empty results

5. **Tool factory** (mirrors Python `rag/retriever.py:create_archive_search_tool`)
   - `createArchiveSearchTool(ragConfig)` → `DynamicStructuredTool | null`
   - Pre-validates all archives at creation time (graceful skip on failure)
   - Returns single `search_archives` tool (cross-archive, sorted by distance)
   - Zod schema: `{ query: string, top_k?: number }`

**Key reference — Python `create_archive_search_tool` pattern:**
```
1. _init_archive_clients(archives) → [(config, collection)] — skip unreachable
   - For each archive: GET .../collections/{name} → get collection object with .id
   - Store (archive_config, collection) tuples — collection has .id for queries
2. If none reachable → return null
3. Create StructuredTool wrapping search_archives(query, top_k):
   a. embed_query(query, model) → vector
   b. For each archive: POST .../collections/{collection.id}/query (uses UUID!)
   c. Merge + sort by distance
   d. _format_results(all_results, top_k)
```

**TS equivalent:** At init time, call `getCollection(url, name)` for each
archive to resolve name → UUID. Store `{config, collectionId}` tuples. At
query time, call `queryCollection(url, collectionId, ...)` using the UUID.

### Task-02: Agent wiring — `configuration.ts` + `agent.ts`

**Status:** ⚪ Not Started
**Effort:** Low (~15 min)

**Files to modify:**

1. **`configuration.ts`** — Add `rag_config` to `GraphConfigValues`
   - New field: `rag_config: ChromaRagConfig | null`
   - New parser: `parseChromaRagConfig(value)` in `parseGraphConfig()`
   - Import types from `chromadb-rag.ts`

2. **`agent.ts`** — Wire ChromaDB RAG alongside LangConnect RAG
   - Import `createArchiveSearchTool`, `extractRagConfig` from `chromadb-rag.ts`
   - After existing LangConnect RAG block, add:
     ```ts
     // ChromaDB archive RAG
     const chromaRagConfig = extractRagConfig(config);
     if (chromaRagConfig && chromaRagConfig.archives.length > 0) {
       const archiveTool = await createArchiveSearchTool(chromaRagConfig);
       if (archiveTool) tools.push(archiveTool);
     }
     ```

### Task-03: Unit tests

**Status:** ⚪ Not Started
**Effort:** Medium (~30 min)

**File to create:**
`apps/ts/tests/chromadb-rag.test.ts`

**Test cases:**
- `extractRagConfig`: valid config → parsed, missing → null, empty archives → null
- `embedQuery`: mocked fetch → returns vector, timeout → throws EmbeddingError
- `getCollection`: mocked fetch → returns collection info, 404 → returns null
- `queryCollection`: mocked fetch → returns documents + distances
- `formatResults`: empty → "Keine relevanten Dokumente gefunden.", single result, multiple results
- `createArchiveSearchTool`: no archives → null, all unreachable → null
- Config parsing in `parseGraphConfig`: `rag_config` field extracted correctly
- Env variable resolution: `DOCPROC_TEI_EMBEDDINGS_URL`, `RAG_DEFAULT_TOP_K`, etc.

### Task-04: E2E verification

**Status:** ⚪ Not Started
**Effort:** Low (~15 min)

- Build TS Docker image
- Test with real ChromaDB + TEI (if available) or mock
- Verify `search_archives` tool appears in agent tools
- Verify LangConnect RAG still works (backward compat)
- Run full TS test suite

---

## File Map

### New files

| File | Purpose |
|------|---------|
| `apps/ts/src/graphs/react-agent/utils/chromadb-rag.ts` | Config types, TEI client, ChromaDB client, tool factory |
| `apps/ts/tests/chromadb-rag.test.ts` | Unit tests |

### Modified files

| File | Change |
|------|--------|
| `apps/ts/src/graphs/react-agent/configuration.ts` | Add `rag_config` field + parser |
| `apps/ts/src/graphs/react-agent/agent.ts` | Wire ChromaDB RAG tool |

### Untouched files (backward compat)

| File | Status |
|------|--------|
| `apps/ts/src/graphs/react-agent/utils/rag-tools.ts` | ✅ No changes (LangConnect RAG) |
| `apps/ts/tests/rag-tools.test.ts` | ✅ No changes |

---

## Environment Variables (Same as Python)

| Variable | Default | Description |
|----------|---------|-------------|
| `DOCPROC_CHROMADB_URL` | `http://chromadb:8000` | Fallback ChromaDB URL |
| `DOCPROC_TEI_EMBEDDINGS_URL` | `http://tei-embeddings:8080` | TEI embedding endpoint |
| `RAG_DEFAULT_TOP_K` | `5` | Default results per archive |
| `RAG_DEFAULT_LAYER` | `chunk` | Default layer filter |
| `RAG_QUERY_TIMEOUT_SECONDS` | `5` | ChromaDB query timeout |
| `RAG_EMBED_TIMEOUT_SECONDS` | `10` | TEI embedding timeout |

---

## Python → TypeScript Mapping

| Python | TypeScript | Notes |
|--------|-----------|-------|
| `rag/config.py` → `RagArchiveConfig` | `chromadb-rag.ts` → `RagArchiveConfig` interface | Same fields |
| `rag/config.py` → `ChromaRagConfig` | `chromadb-rag.ts` → `ChromaRagConfig` interface | Same fields |
| `rag/config.py` → `extract_rag_config()` | `chromadb-rag.ts` → `extractRagConfig()` | Reads `config.rag_config` |
| `rag/embeddings.py` → `embed_query()` | `chromadb-rag.ts` → `embedQuery()` | `httpx.post` → `fetch()` |
| `rag/embeddings.py` → `EmbeddingError` | `chromadb-rag.ts` → `EmbeddingError` | Same semantics |
| `rag/retriever.py` → `_init_archive_clients()` | `chromadb-rag.ts` → `initArchiveClients()` | `chromadb.HttpClient` → `fetch` GET |
| `rag/retriever.py` → `_format_results()` | `chromadb-rag.ts` → `formatResults()` | Same German format |
| `rag/retriever.py` → `create_archive_search_tool()` | `chromadb-rag.ts` → `createArchiveSearchTool()` | `StructuredTool` → `DynamicStructuredTool` |
| `agent.py` → `GraphConfigPydantic.rag_config` | `configuration.ts` → `GraphConfigValues.rag_config` | `dict` → `ChromaRagConfig \| null` |
| `agent.py` → ChromaDB RAG wiring block | `agent.ts` → ChromaDB RAG wiring block | Same pattern |

---

## API Contract — ChromaDB v2 REST

### Get Collection (by name → returns object with UUID)

Source: `chromadb/api/fastapi.py` L311
```
GET {base}/api/v2/tenants/default_tenant/databases/default_database/collections/{name}

Response 200:
{
  "id": "uuid-string",
  "name": "repo_abc123",
  "metadata": {...},
  "dimension": 768,
  "tenant": "default_tenant",
  "database": "default_database"
}

Response error (collection not found):
{ "error": "InvalidCollectionException", "message": "Collection repo_abc123 does not exist." }
```

### Query Collection (by UUID — NOT by name!)

Source: `chromadb/api/fastapi.py` L710
```
POST {base}/api/v2/tenants/default_tenant/databases/default_database/collections/{id}/query
Content-Type: application/json

{
  "query_embeddings": [[0.1, 0.2, ...]],
  "n_results": 5,
  "include": ["documents", "metadatas", "distances"],
  "where": {"layer": "chunk"}
}

Response 200:
{
  "ids": [["doc1", "doc2"]],
  "documents": [["text1", "text2"]],
  "metadatas": [[{...}, {...}]],
  "distances": [[0.12, 0.34]],
  "embeddings": null,
  "uris": null,
  "data": null,
  "included": ["documents", "metadatas", "distances"]
}
```

### Flow: name → id → query

The Python `chromadb-client` does this in two steps:
1. `client.get_collection(name="repo_abc")` → GET by name → stores collection object with `.id`
2. `collection.query(...)` → POST by `collection.id` (UUID)

The TS implementation must replicate this: resolve name to UUID first, then
query using the UUID.

---

## Risks & Mitigations

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| ChromaDB v2 API path differs between versions | Very Low | **Confirmed** from Python source: `/api/v2/tenants/default_tenant/databases/default_database/collections/...` |
| Query endpoint takes UUID not name | Low | **Confirmed**: GET by name → resolve UUID → POST query by UUID. Two-step flow. |
| TEI response format edge cases | Low | Same OpenAI-compatible endpoint as Python; shared fixtures |
| `fetch()` timeout handling in Bun | Low | Use `AbortController` with `setTimeout` |
| Breaking existing LangConnect RAG | Very Low | Untouched — different config key, different file |
| ChromaDB tenant/database path mismatch | Very Low | **Confirmed** defaults from chromadb source: `default_tenant` / `default_database` |

---

## Execution Estimate

| Task | Effort | Notes |
|------|--------|-------|
| Task-01: `chromadb-rag.ts` | ~45 min | Config + embedding + retriever + tool factory |
| Task-02: Agent wiring | ~15 min | `configuration.ts` + `agent.ts` |
| Task-03: Unit tests | ~30 min | Mocked fetch, config parsing, formatting |
| Task-04: E2E verification | ~15 min | Docker rebuild + curl tests |
| **Total** | **~1.75 hours** | |

---

## Completion Log

| Date | What | Notes |
|------|------|-------|
| 2026-02-20 | Goal created | Depends on Goal 34 (Python RAG — complete) |
| 2026-02-20 | Research complete | Decided: direct HTTP via fetch (no chromadb npm), single file, coexist with LangConnect |
| 2026-02-20 | API paths confirmed | Inspected Python `chromadb-client` source: v2 API, default_tenant/default_database, GET by name → POST query by UUID |