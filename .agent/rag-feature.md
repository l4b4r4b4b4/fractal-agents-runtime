# Task-07: Runtime-Side ChromaDB RAG Retriever Tool

> **Repository:** `fractal-agents-runtime-python`
> **Priority:** P1 (blocks end-to-end RAG pipeline)
> **Depends on:** Platform Tasks 01–06 (complete ✅)
> **Branch suggestion:** `feature/rag-retriever-tool`

---

## 1. Summary

The immoFlow platform now passes a `rag_config` object to the LangGraph runtime
via `config.configurable.rag_config`. The runtime needs to read this config,
connect to a ChromaDB instance, embed the user's query, search the specified
collections, and return the results as context the agent can use in its response.

This document specifies **exactly** what the runtime needs to implement and why,
with enough detail that you can carry it into the runtime repo and build it
without referring back to the platform codebase.

---

## 2. What the Platform Sends

### 2.1 Assistant-Level Config (via `syncAgentToLangGraph`)

When an agent is created or updated, the platform `POST`/`PATCH`es the LangGraph
assistant with a config payload. The `rag_config` sits alongside existing keys:

```json
{
  "graph_id": "agent",
  "name": "Dokumenten-Assistent",
  "config": {
    "configurable": {
      "model_name": "openai:gpt-4o-mini",
      "system_prompt": "Du bist ein hilfreicher Assistent für Immobiliendokumente.",
      "mcp_config": {
        "servers": [
          { "name": "document-mcp", "url": "http://document-mcp:8000/sse", "auth_required": true }
        ]
      },
      "rag_config": {
        "archives": [
          {
            "name": "AIS Management Standard",
            "collection_name": "repo_a1b2c3d4-e5f6-7890-abcd-ef1234567890",
            "chromadb_url": "http://chromadb:8000",
            "embedding_model": "jinaai/jina-embeddings-v2-base-de"
          },
          {
            "name": "Wartungsdokumentation",
            "collection_name": "repo_f9e8d7c6-b5a4-3210-fedc-ba0987654321",
            "chromadb_url": "http://chromadb:8000",
            "embedding_model": "jinaai/jina-embeddings-v2-base-de"
          }
        ]
      },
      "temperature": 0.7,
      "max_tokens": 4096
    }
  }
}
```

### 2.2 Thread-Level Override (per message)

When the user toggles archives on/off in the chat sidebar, the platform passes
an updated `rag_config` as a thread-level configurable on each `stream.submit()`.
Thread-level config **merges with** (and overrides) assistant-level config:

```json
{
  "messages": [{ "type": "human", "content": "..." }],
  "config": {
    "configurable": {
      "user_id": "usr_abc123",
      "rag_config": {
        "archives": [
          {
            "name": "AIS Management Standard",
            "collection_name": "repo_a1b2c3d4-e5f6-7890-abcd-ef1234567890",
            "chromadb_url": "http://chromadb:8000",
            "embedding_model": "jinaai/jina-embeddings-v2-base-de"
          }
        ]
      }
    }
  }
}
```

**Key behavior:**
- If the user disables all archives → `rag_config` is **omitted** (key absent)
- If the user re-enables some → `rag_config` is present with the enabled subset
- Thread-level `rag_config` **replaces** assistant-level `rag_config` entirely
  (it's not a deep merge — the whole `archives` array is replaced)

---

## 3. What the Runtime Needs to Do

### 3.1 High-Level Flow

```
User message arrives
  ↓
Extract rag_config from config.configurable
  ↓
If rag_config is present and has archives:
  ↓
  1. Embed the user's query text
  2. For each archive: query ChromaDB collection by similarity
  3. Deduplicate and rank results
  4. Inject results into agent context (system message or tool result)
  ↓
Agent generates response using RAG context + other tools
```

### 3.2 Pydantic Models

Add these alongside the existing `MCPConfig` / `MCPServerConfig` models:

```python
from pydantic import BaseModel, Field


class RagArchiveConfig(BaseModel):
    """Configuration for a single ChromaDB archive (repository collection)."""

    name: str = Field(description="Human-readable archive name")
    collection_name: str = Field(
        description="ChromaDB collection name (format: repo_{repository_id})"
    )
    chromadb_url: str = Field(
        default="http://chromadb:8000",
        description="ChromaDB server URL",
    )
    embedding_model: str = Field(
        default="jinaai/jina-embeddings-v2-base-de",
        description="Embedding model used to create the collection vectors",
    )


class RagConfig(BaseModel):
    """RAG configuration passed via config.configurable.rag_config."""

    archives: list[RagArchiveConfig] = Field(default_factory=list)
```

### 3.3 Extracting Config in the Graph

In the graph's node function (or a helper called from it), extract the config:

```python
from langchain_core.runnables import RunnableConfig


def extract_rag_config(config: RunnableConfig) -> RagConfig | None:
    """Extract RAG config from LangGraph configurable, if present."""
    configurable = config.get("configurable", {})
    raw_rag_config = configurable.get("rag_config")
    if not raw_rag_config:
        return None
    return RagConfig.model_validate(raw_rag_config)
```

---

## 4. Implementation Options

There are two reasonable approaches. Choose based on the runtime's current
architecture and your preference.

### Option A: RAG as a LangGraph Tool (Recommended)

Register a `search_archives` tool that the agent can invoke. The agent decides
when to search based on the user's question.

**Pros:**
- Agent controls when to search (not every message triggers retrieval)
- Tool calls are visible in the chat UI (transparency)
- Follows existing MCP tool pattern
- Agent can search multiple times or with refined queries

**Cons:**
- Agent might forget to search (mitigated by system prompt instruction)
- Extra LLM call to decide whether to use the tool

```python
import chromadb
from langchain_core.tools import tool
from langchain_core.runnables import RunnableConfig


def create_archive_search_tool(rag_config: RagConfig):
    """
    Factory that creates a search tool bound to the current session's archives.

    Called once per invocation (not per message) when rag_config is present.
    """

    # Pre-initialize ChromaDB clients for each archive
    archive_clients: list[tuple[RagArchiveConfig, chromadb.Collection]] = []
    for archive in rag_config.archives:
        client = chromadb.HttpClient(
            host=_parse_host(archive.chromadb_url),
            port=_parse_port(archive.chromadb_url),
        )
        try:
            collection = client.get_collection(name=archive.collection_name)
            archive_clients.append((archive, collection))
        except Exception as exc:
            # Collection doesn't exist or ChromaDB unreachable — skip silently
            logger.warning(
                "Skipping archive %s (%s): %s",
                archive.name,
                archive.collection_name,
                exc,
            )

    @tool
    def search_archives(query: str, top_k: int = 5) -> str:
        """Search the user's document archives for relevant content.

        Use this tool when the user asks about documents, policies, reports,
        maintenance records, or any information that might be in their archives.

        Args:
            query: Search query — rephrase the user's question for semantic search.
            top_k: Number of results per archive (default 5, max 20).
        """
        top_k = min(max(top_k, 1), 20)

        if not archive_clients:
            return "Keine Archive verfügbar."

        # Embed the query
        query_embedding = _embed_query(query, rag_config.archives[0])

        all_results: list[dict] = []
        for archive_config, collection in archive_clients:
            try:
                results = collection.query(
                    query_embeddings=[query_embedding],
                    n_results=top_k,
                    include=["documents", "metadatas", "distances"],
                )
                for doc, metadata, distance in zip(
                    results["documents"][0] or [],
                    results["metadatas"][0] or [],
                    results["distances"][0] or [],
                ):
                    all_results.append(
                        {
                            "archive": archive_config.name,
                            "text": doc,
                            "metadata": metadata,
                            "distance": distance,
                        }
                    )
            except Exception as exc:
                logger.warning(
                    "Archive search failed for %s: %s",
                    archive_config.name,
                    exc,
                )

        if not all_results:
            return "Keine relevanten Dokumente gefunden."

        # Sort by distance (lower = more similar for cosine)
        all_results.sort(key=lambda r: r["distance"])

        # Format results for the LLM
        formatted_parts: list[str] = []
        for idx, result in enumerate(all_results[:top_k], 1):
            metadata = result["metadata"]
            source_info = []
            if metadata.get("layer"):
                source_info.append(f"Ebene: {metadata['layer']}")
            if metadata.get("page_number"):
                source_info.append(f"Seite: {metadata['page_number']}")
            if metadata.get("section_heading"):
                source_info.append(f"Abschnitt: {metadata['section_heading']}")

            header = f"[{idx}] Archiv: {result['archive']}"
            if source_info:
                header += f" ({', '.join(source_info)})"

            formatted_parts.append(f"{header}\n{result['text']}")

        return "\n\n---\n\n".join(formatted_parts)

    return search_archives
```

**System prompt addition** — append to the agent's system prompt when archives
are configured:

```
Du hast Zugriff auf Dokumentenarchive. Verwende das Tool "search_archives",
wenn der Benutzer Fragen zu Dokumenten, Berichten, Richtlinien oder archivierten
Informationen stellt. Formuliere die Suchanfrage so um, dass sie für eine
semantische Suche geeignet ist.
```

### Option B: Automatic RAG Context Injection

Automatically embed the user's message and inject search results before the
LLM sees it. Every message triggers retrieval.

**Pros:**
- No extra LLM decision step (faster for purely document-based agents)
- User always gets document context

**Cons:**
- Wastes retrieval calls on greetings, follow-ups, meta-questions
- Adds latency to every message
- Results are invisible to the user (no tool call in UI)

```python
async def inject_rag_context(
    state: AgentState,
    config: RunnableConfig,
) -> AgentState:
    """Graph node that prepends RAG context to messages before the LLM."""
    rag_config = extract_rag_config(config)
    if not rag_config or not rag_config.archives:
        return state

    # Get the last human message
    last_human = None
    for msg in reversed(state["messages"]):
        if msg.type == "human":
            last_human = msg
            break

    if not last_human:
        return state

    query_text = last_human.content if isinstance(last_human.content, str) else str(last_human.content)
    results = _search_all_archives(query_text, rag_config, top_k=5)

    if results:
        context_text = _format_results(results)
        # Inject as a system message right before the LLM call
        from langchain_core.messages import SystemMessage
        rag_message = SystemMessage(
            content=f"Relevante Dokumente aus den Archiven:\n\n{context_text}"
        )
        return {**state, "messages": [*state["messages"], rag_message]}

    return state
```

---

## 5. Query Embedding

The ChromaDB collections were created with `jinaai/jina-embeddings-v2-base-de`
(768 dimensions) via TEI. The runtime must embed search queries with the
**same model** to get meaningful similarity scores.

### 5.1 Embedding Approach Options

**Option 1: Use the TEI service (recommended for Docker)**

The TEI (Text Embeddings Inference) server is already running in the Docker
environment and exposes an OpenAI-compatible `/v1/embeddings` endpoint.

```python
import httpx


def _embed_query(
    text: str,
    archive: RagArchiveConfig,
    tei_url: str | None = None,
    timeout: float = 10.0,
) -> list[float]:
    """Embed a query string using TEI or a compatible embeddings endpoint."""
    # TEI URL: from env or default Docker service name
    url = tei_url or os.environ.get(
        "DOCPROC_TEI_EMBEDDINGS_URL", "http://tei-embeddings:8080"
    )

    response = httpx.post(
        f"{url}/v1/embeddings",
        json={
            "model": archive.embedding_model,
            "input": [text],
        },
        timeout=timeout,
    )
    response.raise_for_status()
    data = response.json()
    return data["data"][0]["embedding"]
```

**Option 2: Use `chromadb`'s built-in embedding functions**

ChromaDB's Python client supports embedding functions. You can use
`SentenceTransformerEmbeddingFunction` or a custom one:

```python
from chromadb.utils.embedding_functions import (
    SentenceTransformerEmbeddingFunction,
)

embedding_function = SentenceTransformerEmbeddingFunction(
    model_name="jinaai/jina-embeddings-v2-base-de",
)

# Then pass to get_collection:
collection = client.get_collection(
    name=archive.collection_name,
    embedding_function=embedding_function,
)

# And query with text directly (ChromaDB handles embedding):
results = collection.query(
    query_texts=["user query here"],
    n_results=5,
)
```

> ⚠️ **Caveat:** This downloads the model into the runtime container (~500MB).
> TEI is preferred because it's already running and GPU-accelerated.

**Option 3: Use LiteLLM's embedding API**

Since the runtime already uses LiteLLM for chat completions, you might be able
to use `litellm.embedding()`:

```python
import litellm

response = litellm.embedding(
    model="huggingface/jinaai/jina-embeddings-v2-base-de",
    input=["user query here"],
    api_base="http://tei-embeddings:8080",
)
embedding = response.data[0]["embedding"]
```

---

## 6. ChromaDB Connection Details

### 6.1 Collection Schema

Each repository has one ChromaDB collection:

| Field | Value |
|-------|-------|
| **Collection name** | `repo_{repository_id}` (UUID) |
| **Distance metric** | `cosine` (set via `hnsw:space` metadata) |
| **Embedding dimension** | 768 |
| **Embedding model** | `jinaai/jina-embeddings-v2-base-de` |

### 6.2 Vector Metadata

Each vector in a collection has this metadata:

| Key | Type | Description |
|-----|------|-------------|
| `document_id` | `str` | UUID of the source document |
| `repository_id` | `str` | UUID of the repository |
| `organization_id` | `str` | UUID of the owning organization |
| `layer` | `str` | One of: `document`, `page`, `section`, `chunk` |
| `char_start` | `int` | Character offset start in source text |
| `char_end` | `int` | Character offset end in source text |
| `token_count` | `int` | Approximate token count of the segment |
| `text_preview` | `str` | First 200 chars of segment (for display) |
| `page_number` | `int` | *(optional)* Page number in source PDF |
| `section_heading` | `str` | *(optional)* Section heading text |
| `chunk_index` | `int` | *(optional)* Index within chunk sequence |

### 6.3 Layer Types

Documents are split into 4 hierarchical layers. For RAG retrieval, **`chunk`**
is the recommended default:

| Layer | Description | Typical size | Use case |
|-------|-------------|-------------|----------|
| `document` | Entire document as one vector | 1 per doc | Coarse similarity (not for RAG) |
| `page` | One vector per PDF page | ~300-800 tokens | Page-level retrieval |
| `section` | One vector per `##` heading section | Variable | Section-level retrieval |
| `chunk` | Sliding window (512 tokens, 64 overlap) | ~512 tokens | **Best for RAG** |

**Recommended query filter:**

```python
results = collection.query(
    query_embeddings=[embedding],
    n_results=5,
    where={"layer": "chunk"},  # Only search chunk-layer vectors
    include=["documents", "metadatas", "distances"],
)
```

The `documents` field in ChromaDB contains the full segment text (not just
the 200-char preview). This is what should be returned to the agent.

### 6.4 Network Topology

```
┌─────────────────────────────┐
│  Docker: my_network         │
│                             │
│  agent-runtime:8081  ──────►│── chromadb:8000
│                             │
│  tei-embeddings:8080        │
│                             │
└─────────────────────────────┘
```

> ⚠️ **docker-compose fix needed:** The `chromadb` service currently does NOT
> have an explicit `networks` key, which means it's only on the default Compose
> network. The `agent-runtime` is on `my_network`. For the runtime to reach
> ChromaDB by hostname, **add `networks: [my_network]` to the `chromadb`
> service in `docker-compose.yml`**, or use `host.docker.internal:8001` as the
> ChromaDB URL.
>
> Similarly, `tei-embeddings` needs to be on `my_network` if you use TEI for
> query embedding from the runtime.

**ChromaDB URL resolution** (in order of priority):
1. `archive.chromadb_url` from `rag_config` (per-archive, set by platform)
2. `DOCPROC_CHROMADB_URL` environment variable
3. Default: `http://chromadb:8000` (Docker service name)

---

## 7. Integration into the Agent Graph

### 7.1 Where to Hook In

The existing graph likely has a pattern like:

```
START → agent_node → [tool calls?] → tool_node → agent_node → END
```

The RAG retriever should be registered as a **tool** available to the agent node.
When `rag_config` is present in the configurable, dynamically add the
`search_archives` tool to the agent's tool list for that invocation.

### 7.2 Dynamic Tool Registration

Somewhere in the graph setup (likely where MCP tools are resolved), add:

```python
def build_tools(config: RunnableConfig) -> list:
    """Build the tool list for this invocation, including dynamic RAG tools."""
    tools = []

    # ... existing MCP tool resolution ...

    # RAG retriever tool (dynamic, based on rag_config)
    rag_config = extract_rag_config(config)
    if rag_config and rag_config.archives:
        search_tool = create_archive_search_tool(rag_config)
        tools.append(search_tool)

    return tools
```

### 7.3 Caching / Lifecycle

- ChromaDB `HttpClient` instances are lightweight — create per-invocation
- Do NOT cache `Collection` objects across invocations (config may change)
- TEI HTTP calls are stateless — no connection pooling needed
- If using `httpx`, consider `httpx.AsyncClient` with connection pooling for
  the TEI embedding endpoint if latency is a concern

---

## 8. Error Handling

| Scenario | Behavior |
|----------|----------|
| ChromaDB unreachable | Log warning, skip archive, continue without RAG |
| Collection doesn't exist | Log warning, skip that archive |
| TEI embedding fails | Log error, return "Archivsuche fehlgeschlagen" from tool |
| Empty results | Return "Keine relevanten Dokumente gefunden." |
| `rag_config` absent | Don't register the tool — agent operates without RAG |
| `rag_config.archives` is empty | Same as absent — no tool registered |
| Query embedding dimension mismatch | ChromaDB will return an error — catch and log |

**Important:** Do NOT log document text, embedding vectors, or `text_preview`
content. Only log collection names, vector counts, distances, and error messages.

---

## 9. Environment Variables

Add these to the runtime's configuration (all optional, with defaults):

| Variable | Default | Description |
|----------|---------|-------------|
| `DOCPROC_CHROMADB_URL` | `http://chromadb:8000` | Fallback ChromaDB URL (overridden by per-archive config) |
| `DOCPROC_TEI_EMBEDDINGS_URL` | `http://tei-embeddings:8080` | TEI server for query embedding |
| `RAG_DEFAULT_TOP_K` | `5` | Default number of results per archive |
| `RAG_DEFAULT_LAYER` | `chunk` | Default layer filter for retrieval |
| `RAG_QUERY_TIMEOUT_SECONDS` | `5` | Timeout for each ChromaDB query |
| `RAG_EMBED_TIMEOUT_SECONDS` | `10` | Timeout for TEI embedding request |

---

## 10. Python Dependencies

Add to `pyproject.toml` / `requirements.txt`:

```
chromadb>=0.5.0      # ChromaDB HTTP client
httpx>=0.27.0        # HTTP client for TEI embedding (if not using chromadb's built-in)
```

`chromadb` is the only hard requirement. If you use Option 2 (built-in
embedding functions), also add:

```
sentence-transformers>=2.7.0   # Only if using local embedding (not TEI)
```

---

## 11. Testing

### 11.1 Unit Test: Config Extraction

```python
def test_extract_rag_config_present():
    config = {
        "configurable": {
            "rag_config": {
                "archives": [
                    {
                        "name": "Test Archive",
                        "collection_name": "repo_test-uuid",
                        "chromadb_url": "http://chromadb:8000",
                        "embedding_model": "jinaai/jina-embeddings-v2-base-de",
                    }
                ]
            }
        }
    }
    result = extract_rag_config(config)
    assert result is not None
    assert len(result.archives) == 1
    assert result.archives[0].collection_name == "repo_test-uuid"


def test_extract_rag_config_absent():
    config = {"configurable": {"model_name": "openai:gpt-4o-mini"}}
    result = extract_rag_config(config)
    assert result is None


def test_extract_rag_config_empty_archives():
    config = {"configurable": {"rag_config": {"archives": []}}}
    result = extract_rag_config(config)
    assert result is not None
    assert len(result.archives) == 0
```

### 11.2 Integration Test: ChromaDB Query

Requires a running ChromaDB instance with test data:

```python
import chromadb


def test_chromadb_query():
    """Verify the runtime can query an existing collection."""
    client = chromadb.HttpClient(host="localhost", port=8001)

    # Create a test collection with known data
    collection = client.get_or_create_collection(
        name="repo_test-integration",
        metadata={"hnsw:space": "cosine"},
    )
    collection.upsert(
        ids=["test:chunk:0"],
        documents=["Dies ist ein Testdokument über Immobilienverwaltung."],
        metadatas=[{
            "document_id": "doc-1",
            "repository_id": "test-integration",
            "organization_id": "org-1",
            "layer": "chunk",
            "char_start": 0,
            "char_end": 52,
            "token_count": 8,
            "text_preview": "Dies ist ein Testdokument",
        }],
        embeddings=[[0.1] * 768],  # Dummy 768d vector
    )

    # Query with a dummy embedding
    results = collection.query(
        query_embeddings=[[0.1] * 768],
        n_results=1,
        where={"layer": "chunk"},
        include=["documents", "metadatas", "distances"],
    )

    assert len(results["documents"][0]) == 1
    assert "Immobilienverwaltung" in results["documents"][0][0]

    # Cleanup
    client.delete_collection("repo_test-integration")
```

### 11.3 End-to-End Test (Task-08)

Once the retriever is implemented, the platform-side E2E test will:

1. Ensure an agent has archives configured (seed data already does this)
2. Send a message that should trigger archive search
3. Verify the agent's response contains information from the archive
4. Verify the tool call appears in the message stream (if using Option A)

---

## 12. File Structure Suggestion

```
fractal-agents-runtime-python/
├── src/
│   └── your_package/
│       ├── graph/
│       │   ├── agent.py          # Main graph — add RAG tool to build_tools()
│       │   └── ...
│       ├── rag/                   # NEW — RAG retriever module
│       │   ├── __init__.py
│       │   ├── config.py          # RagConfig, RagArchiveConfig, extract_rag_config()
│       │   ├── retriever.py       # create_archive_search_tool(), _search_all_archives()
│       │   └── embeddings.py      # _embed_query() — TEI client wrapper
│       └── ...
├── tests/
│   └── rag/
│       ├── test_config.py
│       ├── test_retriever.py
│       └── test_embeddings.py
└── ...
```

---

## 13. Checklist

- [ ] Add `RagConfig` + `RagArchiveConfig` Pydantic models
- [ ] Add `extract_rag_config(config)` helper
- [ ] Implement query embedding via TEI (`_embed_query`)
- [ ] Implement `create_archive_search_tool` (or automatic context injection)
- [ ] Register RAG tool dynamically when `rag_config` is present
- [ ] Add `chromadb` to Python dependencies
- [ ] Fix `docker-compose.yml`: add `networks: [my_network]` to `chromadb` service
- [ ] Add env vars: `DOCPROC_CHROMADB_URL`, `DOCPROC_TEI_EMBEDDINGS_URL`
- [ ] Unit tests for config extraction
- [ ] Integration test with real ChromaDB
- [ ] Verify tool appears in chat UI when agent searches archives
- [ ] Verify no document text or embeddings are logged

---

## Appendix A: Quick Reference — Existing Configurable Keys

These are the keys the runtime already handles in `config.configurable`:

| Key | Type | Description |
|-----|------|-------------|
| `model_name` | `str` | LiteLLM model identifier (e.g., `openai:gpt-4o-mini`) |
| `system_prompt` | `str` | Agent system prompt |
| `mcp_config` | `{ servers: MCPServerConfig[] }` | MCP tool server configuration |
| `agent_tools` | `str[]` | Assistant IDs for agents-as-tools |
| `temperature` | `float` | Sampling temperature |
| `max_tokens` | `int` | Max output tokens |
| `top_p` | `float` | Nucleus sampling |
| `user_id` | `str` | Authenticated user ID (thread-level) |
| **`rag_config`** | **`RagConfig`** | **NEW — archive retrieval config** |

## Appendix B: URL Parsing Helpers

```python
from urllib.parse import urlparse


def _parse_host(url: str) -> str:
    """Extract hostname from a URL string."""
    parsed = urlparse(url)
    return parsed.hostname or "localhost"


def _parse_port(url: str) -> int:
    """Extract port from a URL string, defaulting to 8000."""
    parsed = urlparse(url)
    return parsed.port or 8000
```
