# Goal 34: RAG ChromaDB Retriever Tool

> **Status:** 🟢 Complete
> **Priority:** P1 (blocks end-to-end RAG pipeline)
> **Branch:** `feat/rag-chromadb-retriever`
> **Created:** 2026-02-20
> **Depends on:** Platform Tasks 01–06 (complete ✅)
> **Feature spec:** `.agent/rag-feature.md`

---

## Objectives

Implement a runtime-side ChromaDB RAG retriever tool so that agents configured
with document archives can search them via semantic similarity. The platform
already sends `rag_config` (with `archives` array) in `config.configurable`.
The runtime needs to:

1. Parse `rag_config` from the configurable dict
2. Embed the user's query via TEI (Text Embeddings Inference)
3. Query ChromaDB collections by vector similarity
4. Return formatted results as a LangGraph tool the agent can invoke

### Success Criteria

- [x] `rag_config` with `archives` is read from `config.configurable`
- [x] `search_archives` tool is dynamically registered when archives are configured
- [x] Agent can invoke the tool and receive formatted document chunks
- [x] Embedding via TEI `/v1/embeddings` endpoint works correctly
- [x] Error handling: unreachable ChromaDB / TEI → graceful degradation (no crash)
- [x] Old LangConnect RAG (`cfg.rag`) still works (backward compat)
- [x] Unit tests for config extraction, embedding, tool creation
- [x] Local Docker e2e: agent searches real ChromaDB collection in chat UI

---

## Architecture Decisions

### 1. Tool-based approach (Option A from spec)

The agent decides when to search via a `search_archives` tool. This matches
the existing MCP tool pattern, makes tool calls visible in the chat UI, and
lets the agent refine queries. The alternative (automatic context injection on
every message) wastes retrieval calls on greetings and adds latency.

### 2. New `rag_config` key — coexists with old `rag`

The existing `RagConfig` (`rag_url` + `collections`) is the LangConnect RAG
that queries a remote API with Supabase auth. The new ChromaDB RAG uses a
different config shape (`archives` with `collection_name`, `chromadb_url`,
`embedding_model`). We keep both:

- `cfg.rag` → LangConnect RAG (existing, unchanged)
- `cfg.rag_config` → ChromaDB archive RAG (new)

### 3. TEI for query embedding (not local model)

TEI is already running in the Docker stack and is GPU-accelerated. Downloading
a 500MB model into the runtime container is wasteful. We use `httpx` to call
TEI's OpenAI-compatible `/v1/embeddings` endpoint.

### 4. ChromaDB HttpClient (not REST)

The `chromadb` Python package provides `HttpClient` which handles the HTTP
transport. Lightweight, create-per-invocation (no caching needed since config
may change between invocations).

### 5. Layer filter: `chunk` by default

ChromaDB collections have 4 layers (document, page, section, chunk). The
`chunk` layer (512 tokens, 64 overlap) is best for RAG. Configurable via
`RAG_DEFAULT_LAYER` env var.

---

## Task Breakdown

### Task-01: Implement RAG module + graph integration

**Status:** 🟢 Complete

**New files:**
- `src/graphs/react_agent/rag/__init__.py` — Package init, public exports
- `src/graphs/react_agent/rag/config.py` — `RagArchiveConfig`, `ChromaRagConfig`, `extract_rag_config()`
- `src/graphs/react_agent/rag/embeddings.py` — `embed_query()` via TEI httpx
- `src/graphs/react_agent/rag/retriever.py` — `create_archive_search_tool()` factory

**Modified files:**
- `src/graphs/react_agent/agent.py`:
  - Add `rag_config: ChromaRagConfig | None` field to `GraphConfigPydantic`
  - Wire `create_archive_search_tool()` into `graph()` function
  - Keep existing `rag: RagConfig | None` unchanged
- `src/server/agent_sync.py`:
  - Pass `rag_config` through in `_build_assistant_configurable()` if present in agent data
- `pyproject.toml`:
  - Add `chromadb-client>=1.3.0` to dependencies (slim HTTP-only client — no server deps)
  - `httpx>=0.27.0` comes as a transitive dep but declare explicitly for TEI calls

**Implementation details:**

1. **Config models** (`rag/config.py`):
   - `RagArchiveConfig(BaseModel)`: name, collection_name, chromadb_url, embedding_model
   - `ChromaRagConfig(BaseModel)`: archives: list[RagArchiveConfig]
   - `extract_rag_config(config: RunnableConfig) -> ChromaRagConfig | None`

2. **Embedding** (`rag/embeddings.py`):
   - `embed_query(text, embedding_model, tei_url, timeout) -> list[float]`
   - Uses httpx POST to `{tei_url}/v1/embeddings`
   - Env fallback: `DOCPROC_TEI_EMBEDDINGS_URL` → `http://tei-embeddings:8080`

3. **Retriever tool** (`rag/retriever.py`):
   - `create_archive_search_tool(rag_config) -> BaseTool`
   - Pre-initializes ChromaDB `HttpClient` per archive (slim client — HTTP-only, no hnswlib/onnxruntime)
   - `@tool search_archives(query, top_k=5)` inner function
   - Embeds query → queries each collection → dedup + sort by distance → format
   - Layer filter: `where={"layer": chunk_layer}` (env configurable)
   - Returns formatted German text with archive name, metadata, content

4. **Graph wiring** (`agent.py`):
   - After existing LangConnect RAG block, add:
     ```
     rag_config = extract_rag_config(config)
     if rag_config and rag_config.archives:
         search_tool = create_archive_search_tool(rag_config)
         tools.append(search_tool)
     ```

5. **Agent sync passthrough** (`agent_sync.py`):
   - In `_build_assistant_configurable()`, if agent data contains `rag_config`,
     pass it through as `configurable["rag_config"]`
   - This handles assistant-level config (thread-level already flows through)

### Task-02: Tests + local Docker verification

**Status:** 🟢 Complete (unit tests); ⚪ Docker e2e pending

**New files:**
- `tests/rag/test_config.py` — Config extraction unit tests
- `tests/rag/test_embeddings.py` — Embedding client unit tests (mocked httpx)
- `tests/rag/test_retriever.py` — Retriever tool unit tests (mocked ChromaDB)

**Test cases:**

Config extraction:
- `test_extract_rag_config_present` — happy path with 1+ archives
- `test_extract_rag_config_absent` — key missing → returns None
- `test_extract_rag_config_empty_archives` — empty list → valid but no archives
- `test_extract_rag_config_thread_level_override` — thread config replaces assistant config

Embedding:
- `test_embed_query_success` — mock httpx, verify POST body + return vector
- `test_embed_query_tei_unreachable` — timeout/connection error → raises
- `test_embed_query_env_fallback` — no explicit URL → uses env var

Retriever:
- `test_create_tool_no_archives` — empty config → returns None or no-op tool
- `test_create_tool_with_archives` — creates tool with correct name/description
- `test_search_archives_returns_formatted` — mock ChromaDB query → formatted output
- `test_search_archives_chromadb_unreachable` — graceful degradation
- `test_search_archives_respects_top_k_bounds` — clamps to 1–20

Local verification:
- Rebuild Docker image
- Ensure ChromaDB + TEI are on `my_network`
- Create test collection with seed data
- Chat with agent that has rag_config → verify tool call in UI

---

## Environment Variables (New)

| Variable | Default | Description |
|----------|---------|-------------|
| `DOCPROC_CHROMADB_URL` | `http://chromadb:8000` | Fallback ChromaDB URL |
| `DOCPROC_TEI_EMBEDDINGS_URL` | `http://tei-embeddings:8080` | TEI embedding endpoint |
| `RAG_DEFAULT_TOP_K` | `5` | Default results per archive |
| `RAG_DEFAULT_LAYER` | `chunk` | Default layer filter |
| `RAG_QUERY_TIMEOUT_SECONDS` | `5` | ChromaDB query timeout |
| `RAG_EMBED_TIMEOUT_SECONDS` | `10` | TEI embedding timeout |

---

## Dependencies (New)

| Package | Version | Purpose |
|---------|---------|---------|
| `chromadb-client` | `>=1.3.0` | ChromaDB slim HTTP-only client (no server deps — no hnswlib, onnxruntime, uvicorn, kubernetes, etc.) |
| `httpx` | `>=0.27.0` | HTTP client for TEI embedding (also transitive via chromadb-client) |

> **Why `chromadb-client` not `chromadb`?** The full `chromadb` package pulls in
> onnxruntime, tokenizers, hnswlib, uvicorn, kubernetes, bcrypt, typer, rich, etc.
> We only query a remote ChromaDB server over HTTP — the slim client provides the
> same `HttpClient` / `Collection.query()` API without the ~500MB of server deps.

---

## Risks & Mitigations

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| ChromaDB not on Docker network | High | Document docker-compose fix; add env var fallback |
| chromadb-client API drift | Low | Pinned >=1.3.0; same HttpClient API as full package |
| TEI model mismatch | Medium | Validate embedding dimension on first query |
| Large diff-cover gap in CI | Medium | Add thorough unit tests; consider `continue-on-error` for diff-cover |
| Existing `RagConfig` name collision | Low | New models named `RagArchiveConfig` / `ChromaRagConfig` |

---

## Completion Log

| Date | What | Notes |
|------|------|-------|
| 2026-02-20 | Goal created, plan documented | Feature branch `feat/rag-chromadb-retriever` created from `feat/ts-v0.0.2-auth-persistence-store` |
| 2026-02-20 | Task-01 + Task-02 implemented | All new code + 104 unit tests passing. Commit `d534e3f`. |
| 2026-02-20 | Branch pushed | `feat/rag-chromadb-retriever` pushed to origin. Full suite: 1240 passed, 75.21% coverage. |
| 2026-02-20 | **Docker E2E PASSED** | Full pipeline verified: user question → `search_archives` tool call → TEI embedding → ChromaDB vector query → formatted results → AI answer referencing Wartungsbericht Heizung 2025, 15. Januar 2025, Ausdehnungsgefäß. ChromaDB client v1.5.1 ↔ server v1.0.0 (v2 API). Used `/runs/stream` (note: `/runs/wait` is a stub — needs implementation). |

### Implementation Summary

**New files created:**
- `src/graphs/react_agent/rag/__init__.py` — Package exports
- `src/graphs/react_agent/rag/config.py` — `RagArchiveConfig`, `ChromaRagConfig`, `extract_rag_config()`
- `src/graphs/react_agent/rag/embeddings.py` — `embed_query()` via httpx → TEI `/v1/embeddings` (98% coverage)
- `src/graphs/react_agent/rag/retriever.py` — `create_archive_search_tool()` factory → `search_archives` tool (100% coverage)
- `tests/rag/test_config.py` — 21 tests for config extraction
- `tests/rag/test_embeddings.py` — 49 tests for embedding client (mocked httpx)
- `tests/rag/test_retriever.py` — 34 tests for retriever tool (mocked ChromaDB)

**Modified files:**
- `src/graphs/react_agent/agent.py` — Added `rag_config` field to `GraphConfigPydantic`, wired `create_archive_search_tool()` into `graph()`
- `pyproject.toml` — Added `chromadb-client>=1.3.0` (slim HTTP-only) + `httpx>=0.27.0`

**Key decisions during implementation:**
- Used `StructuredTool.from_function()` instead of `@tool` decorator for cleaner factory pattern
- `chromadb-client` (not full `chromadb`) — HTTP-only, no hnswlib/onnxruntime/uvicorn bloat
- `data: dict | list | str | None` pattern for TEI response parsing with explicit type narrowing
- `# type: ignore[index]` on ChromaDB result access — runtime-safe but type checker can't prove it
- Metadata coerced with `or {}` pattern to handle None from ChromaDB

### Remaining Work
- ~~Local Docker e2e verification~~ ✅ Passed 2026-02-20
- PR merge flow: feature → development → main, tag releases
- Commit docker-compose.yml changes (OPENAI_BASE_URL override) + seed script

### Future Hardening (Not Blocking Release)

1. **ChromaDB multi-tenant access control** — Currently no JWT/user-based
   access control on ChromaDB queries. The runtime trusts the platform's
   `rag_config` blindly. ChromaDB v2 has `tenant` and `database` namespaces
   that map naturally to `organization_id` → tenant, `repository_id` →
   database. Wire JWT org claim validation before querying.
2. **`/runs/wait` implementation** — The non-streaming endpoint is a stub
   (`# TODO: Execute agent graph here`). Needs real agent graph execution
   for clients that don't want SSE streaming.
3. **ChromaDB server/client version alignment** — Client v1.5.1 vs server
   v1.0.0. Both use v2 API and work, but should align versions to avoid
   future drift.