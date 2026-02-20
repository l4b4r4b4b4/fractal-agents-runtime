# RAG Archive-Backed Retrieval — Webapp Integration Guide

> **Status:** Working on Python runtime (`feat/rag-chromadb-retriever` branch)
> **Runtime version:** `fractal-agents-runtime-python:local-dev` (v0.0.3)
> **Date:** 2026-02-20

---

## Overview

Agents can now search document archives stored in ChromaDB using semantic
similarity. When you attach archives to an agent, the runtime dynamically
registers a `search_archives` tool that the LLM can invoke to answer
document-related questions.

**The flow:**

```
User asks a question
  → LLM decides to call search_archives tool
    → Runtime embeds the query via TEI
    → Runtime queries ChromaDB collections (vector similarity)
    → Formatted results returned to LLM
  → LLM synthesises answer citing the documents
```

---

## 1. Prerequisites — Docker Services

Three services must be running on the same Docker network:

| Service | Image | Port (host) | Port (internal) | Purpose |
|---------|-------|-------------|-----------------|---------|
| `python-runtime` | `fractal-agents-runtime-python:local-dev` | 9091 | 8081 | Agent runtime |
| `chromadb` | `chromadb/chroma:latest` | 8100 | 8000 | Vector database |
| `embeddings` | `ghcr.io/huggingface/text-embeddings-inference:86-1.9` | 8011 | 8080 | Query embedding (GPU) |

### Starting the services

ChromaDB and TEI are defined in `docker-compose.yml` with `replicas: 0` (off
by default). Scale them up:

```bash
# Start ChromaDB + TEI (one-time)
docker compose up -d chromadb embeddings --scale chromadb=1 --scale embeddings=1

# Verify they're up
docker compose ps chromadb embeddings
```

The runtime container automatically connects to them via Docker DNS:
- `chromadb:8000` — ChromaDB
- `embeddings:8080` — TEI (but env var says `tei-embeddings:8080`, see below)

### Environment variables (in `.env`)

```bash
# TEI URL — the runtime uses this to embed queries
DOCPROC_TEI_EMBEDDINGS_URL=http://embeddings:8080

# Optional overrides (defaults shown)
DOCPROC_CHROMADB_URL=http://chromadb:8000
RAG_DEFAULT_TOP_K=5
RAG_DEFAULT_LAYER=chunk
RAG_QUERY_TIMEOUT_SECONDS=5
RAG_EMBED_TIMEOUT_SECONDS=10
```

> **Important:** If your `.env` has `OPENAI_BASE_URL` pointing at a local
> vLLM instance that isn't running, override it in `docker-compose.yml`:
> ```yaml
> environment:
>   - OPENAI_BASE_URL=
> ```
> This clears the variable so the runtime routes to `api.openai.com`.

---

## 2. Seeding a Test Collection

A seed script is provided to populate ChromaDB with 8 German real-estate
test documents:

```bash
# Run from the repo root (uses host-mapped ports)
CHROMADB_URL=http://localhost:8100 TEI_URL=http://localhost:8011 \
  python scripts/seed_chromadb_test.py
```

This creates collection `repo_test-rag-archive` with documents about:
- Wartungsbericht Heizung 2025 (heating maintenance)
- Heizkostenabrechnung 2024 (heating cost statement)
- Brandschutzordnung (fire safety)
- Mietvertrag (lease agreement)
- Nebenkostenabrechnung (utility costs)
- Dachsanierung 2023 (roof renovation)
- Aufzugprüfbericht (elevator inspection)
- Parkplatzordnung (parking rules)

Each document has metadata: `layer`, `page_number`, `section_heading`,
`document_id`, `repository_id`, `organization_id`.

---

## 3. Configuring an Agent with RAG Archives

### 3.1 The `rag_config` payload

When creating or updating an assistant, include `rag_config` in the
configurable:

```json
{
  "graph_id": "agent",
  "name": "Dokumenten-Assistent",
  "config": {
    "configurable": {
      "model_name": "openai:gpt-4o-mini",
      "system_prompt": "Du bist ein hilfreicher Assistent für Immobiliendokumente. Verwende das Tool search_archives, wenn der Benutzer Fragen zu Dokumenten, Berichten, Wartung oder Gebäudeinformationen stellt.",
      "rag_config": {
        "archives": [
          {
            "name": "Test RAG Archive",
            "collection_name": "repo_test-rag-archive",
            "chromadb_url": "http://chromadb:8000",
            "embedding_model": "jinaai/jina-embeddings-v2-base-de"
          }
        ]
      },
      "temperature": 0.7,
      "max_tokens": 4000
    }
  }
}
```

### 3.2 Archive config fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Human-readable name (shown in tool results) |
| `collection_name` | Yes | ChromaDB collection name (format: `repo_{repository_id}`) |
| `chromadb_url` | No | ChromaDB URL (default: `http://chromadb:8000`) |
| `embedding_model` | No | HuggingFace model ID (default: `jinaai/jina-embeddings-v2-base-de`) |

> **Critical:** The `embedding_model` must match the model used when the
> collection was created. Mismatched models = garbage search results.

### 3.3 Multiple archives

An agent can search across multiple archives simultaneously:

```json
"rag_config": {
  "archives": [
    {
      "name": "Wartungsdokumentation",
      "collection_name": "repo_a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "chromadb_url": "http://chromadb:8000",
      "embedding_model": "jinaai/jina-embeddings-v2-base-de"
    },
    {
      "name": "Mietverträge",
      "collection_name": "repo_f9e8d7c6-b5a4-3210-fedc-ba0987654321",
      "chromadb_url": "http://chromadb:8000",
      "embedding_model": "jinaai/jina-embeddings-v2-base-de"
    }
  ]
}
```

Results from all archives are merged, deduplicated, and sorted by similarity.

### 3.4 Thread-level overrides

The webapp can override archives per-message (e.g. user toggles archives
on/off in a sidebar). Pass `rag_config` in the thread-level config:

```json
{
  "messages": [{ "role": "user", "content": "..." }],
  "config": {
    "configurable": {
      "rag_config": {
        "archives": [
          {
            "name": "Wartungsdokumentation",
            "collection_name": "repo_a1b2c3d4",
            "chromadb_url": "http://chromadb:8000",
            "embedding_model": "jinaai/jina-embeddings-v2-base-de"
          }
        ]
      }
    }
  }
}
```

**Merge behaviour:**
- Thread-level `rag_config` **replaces** assistant-level entirely (not deep-merged)
- Omitting `rag_config` at thread level → assistant-level config is used
- Sending `rag_config` with empty `archives: []` → RAG is disabled for that message

---

## 4. Creating the Test Agent via API

```bash
# 1. Get a JWT
TOKEN=$(curl -s -X POST 'http://127.0.0.1:54321/auth/v1/token?grant_type=password' \
  -H 'Content-Type: application/json' \
  -H 'apikey: <SUPABASE_ANON_KEY>' \
  -d '{"email":"your-user@example.com","password":"YourPassword"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")

# 2. Create the assistant
curl -s -X POST http://localhost:9091/assistants \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "graph_id": "agent",
    "name": "RAG Test Agent",
    "config": {
      "configurable": {
        "model_name": "openai:gpt-4o-mini",
        "system_prompt": "Du bist ein hilfreicher Assistent für Immobiliendokumente. Verwende das Tool search_archives, wenn der Benutzer Fragen zu Dokumenten, Berichten, Wartung oder Gebäudeinformationen stellt.",
        "rag_config": {
          "archives": [{
            "name": "Test RAG Archive",
            "collection_name": "repo_test-rag-archive",
            "chromadb_url": "http://chromadb:8000",
            "embedding_model": "jinaai/jina-embeddings-v2-base-de"
          }]
        }
      }
    }
  }'

# 3. Create a thread
THREAD_ID=$(curl -s -X POST http://localhost:9091/threads \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}' | python3 -c "import sys,json; print(json.load(sys.stdin)['thread_id'])")

# 4. Stream a question (SSE)
curl -N -X POST "http://localhost:9091/threads/${THREAD_ID}/runs/stream" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"assistant_id\": \"<ASSISTANT_ID_FROM_STEP_2>\",
    \"input\": {
      \"messages\": [{
        \"role\": \"user\",
        \"content\": \"Wann wurde die Heizungsanlage zuletzt gewartet?\"
      }]
    },
    \"stream_mode\": [\"messages\"]
  }"
```

> **Note:** Only streaming (`/runs/stream`) works. The `/runs/wait` endpoint
> is a stub and does not execute the agent graph yet.

---

## 5. What to Expect

### Successful RAG response

When the agent receives a document-related question, you'll see in the SSE
stream:

1. **Tool call event** — The LLM decides to call `search_archives`:
   ```json
   {"name": "search_archives", "args": {"query": "Heizungsanlage Wartung", "top_k": 5}}
   ```

2. **Tool result event** — Formatted search results from ChromaDB:
   ```
   [1] Archiv: Test RAG Archive (Ebene: chunk, Seite: 1, Abschnitt: Wartungsbericht Heizung 2025)
   Die jährliche Wartung der Heizungsanlage im Erdgeschoss wurde am 15. Januar 2025 durchgeführt...
   ```

3. **AI response** — The LLM synthesises an answer citing the documents:
   ```
   Die Heizungsanlage wurde zuletzt am **15. Januar 2025** gewartet.
   Der Wartungsbericht bestätigt, dass der Brenner gereinigt wurde und
   die Abgaswerte einwandfrei waren. Es wurde empfohlen, das
   Ausdehnungsgefäß innerhalb der nächsten 12 Monate auszutauschen.
   ```

### Good test questions for the seed data

| Question (German) | Expected source |
|--------------------|----------------|
| Wann wurde die Heizungsanlage zuletzt gewartet? | Wartungsbericht Heizung 2025 |
| Was kostet die Miete im 2. OG? | Mietvertrag Einheit 2.01 |
| Wann war die letzte Brandschutzbegehung? | Brandschutzordnung Teil B |
| Wann wurde das Dach saniert und was hat es gekostet? | Dachsanierung 2023 |
| Wann ist die nächste Aufzugprüfung? | Aufzugprüfbericht |
| Wo kann ich mein E-Auto laden? | Parkplatzordnung Tiefgarage |
| Wie hoch sind die Nebenkosten pro m²? | Nebenkostenabrechnung 2024 |
| Wie viel Energie wurde 2024 verbraucht? | Heizkostenabrechnung 2024 |

---

## 6. Webapp Integration Checklist

For the platform / webapp to support archive-backed agents:

- [ ] **Agent creation UI:** Allow attaching archives (repositories) to an agent
  - Each repository maps to a ChromaDB collection: `repo_{repository_id}`
  - Store as `rag_config.archives[]` in the assistant configurable
- [ ] **Chat sidebar:** Toggle archives on/off per conversation
  - Pass updated `rag_config` as thread-level configurable with each message
  - Omit `rag_config` entirely when all archives are disabled
- [ ] **Agent sync (`syncAgentToLangGraph`):** Pass `rag_config` through to the
  runtime when creating/updating the LangGraph assistant
- [ ] **Collection naming convention:** DocProc pipeline creates collections as
  `repo_{repository_id}` — the platform must use this same format
- [ ] **Embedding model consistency:** The platform must pass the same
  `embedding_model` that DocProc used when indexing the repository

---

## 7. Architecture Diagram

```
┌─────────────┐     rag_config in      ┌──────────────────┐
│   Webapp     │ ──configurable──────── │  Python Runtime   │
│  (Platform)  │                        │  (LangGraph)      │
└─────────────┘                        │                    │
                                       │  1. extract config │
                                       │  2. register tool  │
                                       │                    │
                                       │  Agent calls       │
                                       │  search_archives   │
                                       │       │            │
                                       └───────┼────────────┘
                                               │
                              ┌────────────────┼────────────────┐
                              │                │                │
                              ▼                ▼                │
                     ┌──────────────┐  ┌──────────────┐        │
                     │ TEI Embeddings│  │   ChromaDB    │        │
                     │ (GPU)        │  │ (Vector DB)   │        │
                     │              │  │               │        │
                     │ embed query  │  │ similarity    │        │
                     │ → 768-dim    │──│ search        │        │
                     │   vector     │  │ → top_k docs  │        │
                     └──────────────┘  └──────────────┘        │
                                               │                │
                                               ▼                │
                                       formatted results ───────┘
                                       back to LLM
```

---

## 8. Known Limitations

| Limitation | Impact | Future fix |
|------------|--------|------------|
| **No access control on ChromaDB** | Any agent can query any collection if it knows the name. Security relies on the platform sending the correct `rag_config`. | Goal 37: Multi-tenant access control using ChromaDB v2 tenants + Supabase JWT |
| **`/runs/wait` is a stub** | Non-streaming callers get no agent execution. Only `/runs/stream` works. | Goal 36: Implement non-streaming endpoint |
| **Python runtime only** | TypeScript runtime does not have RAG yet. | Goal 35: Port RAG to TypeScript |
| **Single embedding model assumed** | All archives in one `rag_config` must use the same embedding model. | Could be extended per-archive if needed |
| **ChromaDB server v1.0.0 vs client v1.5.1** | Works (both use v2 API) but version drift risk. | Pin/align versions |

---

## 9. Troubleshooting

### Tool not appearing / agent doesn't search

Check the runtime logs:
```bash
docker logs fractal-agents-runtime-python-runtime-1 2>&1 | grep -E 'ChromaDB|RAG|archive'
```

You should see:
```
ChromaDB archive connected: name=Test RAG Archive collection=repo_test-rag-archive url=http://chromadb:8000
ChromaDB RAG tool registered: archives=1
```

If you see `Skipping archive ...` — ChromaDB is unreachable or the collection
doesn't exist.

### "Archivsuche fehlgeschlagen — Embedding-Service nicht erreichbar"

TEI is down or unreachable. Check:
```bash
curl http://localhost:8011/health
docker logs fractal-agents-runtime-embeddings-1 --tail 10
```

### Agent responds without using the tool

The system prompt must instruct the LLM to use `search_archives`. Include
something like:
```
Verwende das Tool search_archives, wenn der Benutzer Fragen zu Dokumenten,
Berichten, Wartung oder Gebäudeinformationen stellt.
```

### Collection is empty

```bash
curl -s 'http://localhost:8100/api/v2/tenants/default_tenant/databases/default_database/collections' \
  | python3 -m json.tool
```

Re-run the seed script if needed:
```bash
CHROMADB_URL=http://localhost:8100 TEI_URL=http://localhost:8011 \
  python scripts/seed_chromadb_test.py
```
