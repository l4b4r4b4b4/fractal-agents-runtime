# Goal 35: TypeScript RAG ChromaDB Retriever

> **Status:** ⚪ Not Started
> **Priority:** P1 (blocks full RAG feature parity)
> **Branch:** TBD (from `feat/rag-chromadb-retriever` or `development`)
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
- [ ] Old LangConnect RAG (if any in TS) still works (backward compat)
- [ ] Unit tests for config extraction, embedding, tool creation
- [ ] Local Docker E2E: TS runtime agent searches real ChromaDB collection

---

## Architecture Decisions

### 1. Same `rag_config` contract as Python

The platform sends the same JSON payload regardless of runtime. The TS
implementation must parse the identical shape:

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

### 2. ChromaDB client for TypeScript

Options to evaluate:
- **`chromadb` npm package** — Official JS/TS client. Check if a slim HTTP-only
  variant exists (like Python's `chromadb-client`).
- **Direct HTTP via `fetch`** — ChromaDB v2 REST API is straightforward. Could
  avoid a dependency entirely. Evaluate complexity vs. benefit.

### 3. TEI embedding via `fetch`

No special library needed — TEI exposes an OpenAI-compatible `/v1/embeddings`
endpoint. Use native `fetch` (Bun has it built in).

### 4. Tool registration pattern

Mirror the Python pattern: factory function that takes `ChromaRagConfig` and
returns a LangChain/LangGraph-compatible tool (or `null` if no archives are
reachable).

---

## Task Breakdown

### Task-01: Config models + extraction

- Zod schemas for `RagArchiveConfig`, `ChromaRagConfig`
- `extractRagConfig(config)` helper
- Unit tests

### Task-02: TEI embedding client

- `embedQuery(text, embeddingModel, teiUrl)` function
- Error handling (timeout, unreachable)
- Unit tests with mocked fetch

### Task-03: ChromaDB retriever + tool factory

- `createArchiveSearchTool(ragConfig)` factory
- ChromaDB collection query (via npm package or direct HTTP)
- Result formatting (German, same format as Python)
- Layer filter (`where: { layer: "chunk" }`)
- Unit tests with mocked ChromaDB

### Task-04: Graph wiring + E2E test

- Wire into TS agent graph (same pattern as Python `agent.py`)
- Build Docker image
- E2E test against seeded ChromaDB collection

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

## Risks & Mitigations

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| `chromadb` npm package size/compatibility | Medium | Evaluate direct HTTP as alternative |
| Bun compatibility with chromadb package | Medium | Test early; fall back to fetch-based client |
| TEI response format differences | Low | Same OpenAI-compatible endpoint; shared test fixtures |
| TS runtime graph wiring differs from Python | Medium | Study existing TS agent graph structure first |

---

## Completion Log

| Date | What | Notes |
|------|------|-------|
| 2026-02-20 | Goal created | Depends on Goal 34 (Python RAG — complete) |