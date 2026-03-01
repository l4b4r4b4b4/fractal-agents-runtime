/**
 * ChromaDB archive RAG tool factory — TypeScript/Bun.
 *
 * Creates a `search_archives` LangChain tool that queries ChromaDB
 * collections configured via `rag_config`. Uses direct HTTP via native
 * `fetch()` — no `chromadb` npm dependency needed.
 *
 * The tool is registered dynamically when `rag_config` is present in
 * the agent's configurable and has at least one archive. The agent
 * decides when to invoke the tool based on the user's question.
 *
 * Features:
 *   - TEI embedding via OpenAI-compatible `/v1/embeddings` endpoint
 *   - ChromaDB v2 REST API: GET collection by name → POST query by UUID
 *   - Cross-archive search with distance-based ranking
 *   - German-formatted results identical to the Python runtime
 *   - Graceful degradation: unreachable archives are silently skipped
 *   - No new dependencies — all via native `fetch()`
 *
 * Port of:
 *   - apps/python/src/graphs/react_agent/rag/config.py
 *   - apps/python/src/graphs/react_agent/rag/embeddings.py
 *   - apps/python/src/graphs/react_agent/rag/retriever.py
 *
 * Usage:
 *
 *   import { createArchiveSearchTool, extractRagConfig } from "./utils/chromadb-rag";
 *
 *   const ragConfig = extractRagConfig(config);
 *   if (ragConfig && ragConfig.archives.length > 0) {
 *     const tool = await createArchiveSearchTool(ragConfig);
 *     if (tool) tools.push(tool);
 *   }
 */

import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Constants — match Python runtime exactly
// ---------------------------------------------------------------------------

/** Default number of results per archive. Env: `RAG_DEFAULT_TOP_K`. */
const DEFAULT_TOP_K = 5;

/** Maximum allowed `top_k` to prevent excessive result sets. */
const MAX_TOP_K = 20;

/** Default layer filter for ChromaDB queries. Env: `RAG_DEFAULT_LAYER`. */
const DEFAULT_LAYER = "chunk";

/** Default TEI embedding server URL. Env: `DOCPROC_TEI_EMBEDDINGS_URL`. */
const DEFAULT_TEI_URL = "http://tei-embeddings:8080";

/** Default TEI embedding timeout in seconds. Env: `RAG_EMBED_TIMEOUT_SECONDS`. */
const DEFAULT_EMBED_TIMEOUT_SECONDS = 10;

/** Default ChromaDB query timeout in seconds. Env: `RAG_QUERY_TIMEOUT_SECONDS`. */
const DEFAULT_QUERY_TIMEOUT_SECONDS = 5;

/** Default ChromaDB server URL. Env: `DOCPROC_CHROMADB_URL`. */
const DEFAULT_CHROMADB_URL = "http://chromadb:8000";

/**
 * ChromaDB v2 REST API base path with default tenant and database.
 *
 * Confirmed from Python `chromadb-client` source:
 *   - `chromadb/config.py:APIVersion.V2` → `/api/v2`
 *   - `chromadb/config.py:DEFAULT_TENANT` → `default_tenant`
 *   - `chromadb/config.py:DEFAULT_DATABASE` → `default_database`
 */
const CHROMADB_API_PREFIX =
  "/api/v2/tenants/default_tenant/databases/default_database";

// ---------------------------------------------------------------------------
// Config types — mirror Python rag/config.py
// ---------------------------------------------------------------------------

/**
 * Configuration for a single ChromaDB archive (repository collection).
 *
 * Each archive maps to one ChromaDB collection that was populated by
 * the DocProc pipeline. The `embedding_model` must match the model
 * used when the collection was created so that query embeddings live
 * in the same vector space.
 *
 * Mirrors Python's `RagArchiveConfig(BaseModel)`.
 */
export interface RagArchiveConfig {
  /** Human-readable archive name (shown in tool output). */
  name: string;

  /** ChromaDB collection name (format: `repo_{repository_id}`). */
  collection_name: string;

  /** Full URL of the ChromaDB server for this archive. */
  chromadb_url: string;

  /** HuggingFace model ID used to create the collection vectors. */
  embedding_model: string;
}

/**
 * RAG configuration passed via `config.configurable.rag_config`.
 *
 * Mirrors Python's `ChromaRagConfig(BaseModel)`.
 */
export interface ChromaRagConfig {
  /** List of archive configs to search. Empty means no active archives. */
  archives: RagArchiveConfig[];
}

// ---------------------------------------------------------------------------
// Embedding types — TEI response shape
// ---------------------------------------------------------------------------

/**
 * Shape of the TEI `/v1/embeddings` response (OpenAI-compatible).
 */
interface TeiEmbeddingResponse {
  data: Array<{
    embedding: number[];
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// ChromaDB response types
// ---------------------------------------------------------------------------

/**
 * Shape of a ChromaDB collection object returned by GET collection.
 */
interface ChromaCollection {
  /** Collection UUID — needed for query endpoint. */
  id: string;
  /** Collection name. */
  name: string;
  /** Collection metadata. */
  metadata?: Record<string, unknown> | null;
  /** Vector dimension. */
  dimension?: number | null;
  [key: string]: unknown;
}

/**
 * Shape of ChromaDB query results.
 */
interface ChromaQueryResult {
  ids: string[][];
  documents: (string | null)[][] | null;
  metadatas: (Record<string, unknown> | null)[][] | null;
  distances: number[][] | null;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Internal result type for cross-archive merging
// ---------------------------------------------------------------------------

/**
 * A single search result with archive context and distance for ranking.
 */
interface ArchiveSearchResult {
  /** Human-readable archive name. */
  archive: string;
  /** Document text content. */
  text: string;
  /** Document metadata (layer, page_number, section_heading, etc.). */
  metadata: Record<string, unknown>;
  /** Distance score (lower = more similar for cosine distance). */
  distance: number;
}

/**
 * An initialised archive client: config paired with resolved collection UUID.
 */
interface ArchiveClient {
  /** The archive configuration. */
  config: RagArchiveConfig;
  /** The resolved collection UUID from ChromaDB. */
  collectionId: string;
  /** The resolved ChromaDB base URL (after env fallback). */
  chromadbUrl: string;
}

// ---------------------------------------------------------------------------
// Custom errors
// ---------------------------------------------------------------------------

/**
 * Raised when the TEI embedding request fails.
 *
 * Mirrors Python's `EmbeddingError`.
 */
export class EmbeddingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingError";
  }
}

/**
 * Raised when a ChromaDB request fails.
 */
export class ChromaDbError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChromaDbError";
  }
}

// ---------------------------------------------------------------------------
// Environment helpers — match Python exactly
// ---------------------------------------------------------------------------

/**
 * Resolve the TEI base URL with priority: arg > env > default.
 *
 * @param explicitUrl - Caller-supplied URL (highest priority).
 * @returns TEI base URL without a trailing slash.
 */
export function resolveTeiUrl(explicitUrl?: string | null): string {
  const url =
    explicitUrl ||
    (typeof process !== "undefined"
      ? process.env.DOCPROC_TEI_EMBEDDINGS_URL
      : undefined) ||
    DEFAULT_TEI_URL;
  return url.replace(/\/+$/, "");
}

/**
 * Resolve the TEI embedding timeout in seconds.
 */
function resolveEmbedTimeout(): number {
  const raw =
    typeof process !== "undefined"
      ? process.env.RAG_EMBED_TIMEOUT_SECONDS
      : undefined;
  if (raw !== undefined) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
    console.warn(
      `[chromadb-rag] Invalid RAG_EMBED_TIMEOUT_SECONDS=${raw} — using default ${DEFAULT_EMBED_TIMEOUT_SECONDS}`,
    );
  }
  return DEFAULT_EMBED_TIMEOUT_SECONDS;
}

/**
 * Resolve the ChromaDB query timeout in seconds.
 */
function resolveQueryTimeout(): number {
  const raw =
    typeof process !== "undefined"
      ? process.env.RAG_QUERY_TIMEOUT_SECONDS
      : undefined;
  if (raw !== undefined) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
    console.warn(
      `[chromadb-rag] Invalid RAG_QUERY_TIMEOUT_SECONDS=${raw} — using default ${DEFAULT_QUERY_TIMEOUT_SECONDS}`,
    );
  }
  return DEFAULT_QUERY_TIMEOUT_SECONDS;
}

/**
 * Resolve the default `top_k` from env or built-in default.
 */
export function resolveDefaultTopK(): number {
  const raw =
    typeof process !== "undefined"
      ? process.env.RAG_DEFAULT_TOP_K
      : undefined;
  if (raw !== undefined) {
    const parsed = parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.max(1, Math.min(parsed, MAX_TOP_K));
    }
    console.warn(
      `[chromadb-rag] Invalid RAG_DEFAULT_TOP_K=${raw} — using default ${DEFAULT_TOP_K}`,
    );
  }
  return DEFAULT_TOP_K;
}

/**
 * Resolve the default layer filter from env or built-in default.
 */
export function resolveDefaultLayer(): string {
  return (
    (typeof process !== "undefined"
      ? process.env.RAG_DEFAULT_LAYER
      : undefined) || DEFAULT_LAYER
  );
}

/**
 * Resolve ChromaDB URL with priority: archive config > env > default.
 *
 * @param archiveUrl - Per-archive URL from the `rag_config` payload.
 * @returns ChromaDB base URL without a trailing slash.
 */
export function resolveChromaDbUrl(archiveUrl?: string | null): string {
  const url =
    archiveUrl ||
    (typeof process !== "undefined"
      ? process.env.DOCPROC_CHROMADB_URL
      : undefined) ||
    DEFAULT_CHROMADB_URL;
  return url.replace(/\/+$/, "");
}

// ---------------------------------------------------------------------------
// Config extraction — mirror Python extract_rag_config()
// ---------------------------------------------------------------------------

/**
 * Extract ChromaDB RAG config from an assistant's configurable dictionary.
 *
 * Looks for the `rag_config` key inside the configurable dict.
 * Returns `null` when the key is absent, falsy, or has no valid archives.
 *
 * Mirrors Python's `extract_rag_config()` from `rag/config.py`.
 *
 * @param configurable - The assistant's configurable dictionary.
 * @returns A validated `ChromaRagConfig`, or `null` if RAG is not configured.
 *
 * @example
 *   const ragConfig = extractRagConfig({
 *     rag_config: {
 *       archives: [
 *         { name: "Test", collection_name: "repo_abc", chromadb_url: "http://chromadb:8000", embedding_model: "jinaai/jina-embeddings-v2-base-de" }
 *       ]
 *     }
 *   });
 */
export function extractRagConfig(
  configurable: Record<string, unknown>,
): ChromaRagConfig | null {
  const rawRagConfig = configurable.rag_config;

  if (!rawRagConfig || typeof rawRagConfig !== "object") {
    return null;
  }

  const candidate = rawRagConfig as Record<string, unknown>;
  const rawArchives = candidate.archives;

  if (!Array.isArray(rawArchives) || rawArchives.length === 0) {
    return null;
  }

  const archives: RagArchiveConfig[] = [];

  for (const rawArchive of rawArchives) {
    if (!rawArchive || typeof rawArchive !== "object") {
      continue;
    }

    const archiveCandidate = rawArchive as Record<string, unknown>;

    const name =
      typeof archiveCandidate.name === "string" &&
      archiveCandidate.name.length > 0
        ? archiveCandidate.name
        : null;

    const collectionName =
      typeof archiveCandidate.collection_name === "string" &&
      archiveCandidate.collection_name.length > 0
        ? archiveCandidate.collection_name
        : null;

    // name and collection_name are required
    if (!name || !collectionName) {
      console.warn(
        `[chromadb-rag] Skipping archive with missing name or collection_name: ${JSON.stringify(rawArchive)}`,
      );
      continue;
    }

    archives.push({
      name,
      collection_name: collectionName,
      chromadb_url:
        typeof archiveCandidate.chromadb_url === "string" &&
        archiveCandidate.chromadb_url.length > 0
          ? archiveCandidate.chromadb_url
          : DEFAULT_CHROMADB_URL,
      embedding_model:
        typeof archiveCandidate.embedding_model === "string" &&
        archiveCandidate.embedding_model.length > 0
          ? archiveCandidate.embedding_model
          : "jinaai/jina-embeddings-v2-base-de",
    });
  }

  if (archives.length === 0) {
    return null;
  }

  return { archives };
}

// ---------------------------------------------------------------------------
// TEI embedding client — mirror Python rag/embeddings.py
// ---------------------------------------------------------------------------

/**
 * Embed a single query string via the TEI `/v1/embeddings` endpoint.
 *
 * Uses the OpenAI-compatible embedding API exposed by TEI (Text
 * Embeddings Inference). The TEI service is GPU-accelerated and
 * already running in the Docker stack.
 *
 * Mirrors Python's `embed_query()` from `rag/embeddings.py`.
 *
 * @param text - The query text to embed.
 * @param embeddingModel - HuggingFace model identifier (e.g., `jinaai/jina-embeddings-v2-base-de`).
 * @param teiUrl - Explicit TEI base URL. Falls back to `DOCPROC_TEI_EMBEDDINGS_URL` env var, then default.
 * @returns The embedding vector as an array of numbers.
 * @throws {EmbeddingError} If the TEI server is unreachable, returns a non-200 status, or the response is malformed.
 *
 * @example
 *   const vector = await embedQuery(
 *     "Wartungsplan für Heizungsanlage",
 *     "jinaai/jina-embeddings-v2-base-de",
 *     "http://localhost:8080",
 *   );
 *   console.log(vector.length); // 768 for jina-v2-base-de
 */
export async function embedQuery(
  text: string,
  embeddingModel: string,
  teiUrl?: string | null,
): Promise<number[]> {
  const baseUrl = resolveTeiUrl(teiUrl);
  const endpoint = `${baseUrl}/v1/embeddings`;
  const timeoutSeconds = resolveEmbedTimeout();

  const requestBody = {
    model: embeddingModel,
    input: [text],
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    timeoutSeconds * 1000,
  );

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
  } catch (error: unknown) {
    clearTimeout(timeoutId);
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new EmbeddingError(
        `TEI embedding request timed out after ${timeoutSeconds}s: ` +
          `url=${endpoint} model=${embeddingModel}`,
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new EmbeddingError(
      `TEI server unreachable: url=${endpoint} model=${embeddingModel} error=${message}`,
    );
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    let body = "";
    try {
      body = await response.text();
    } catch {
      // Ignore body read failures
    }
    throw new EmbeddingError(
      `TEI embedding request failed with status ${response.status}: ` +
        `url=${endpoint} model=${embeddingModel} body=${body.slice(0, 500)}`,
    );
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new EmbeddingError(
      `TEI response is not valid JSON: url=${endpoint} model=${embeddingModel} error=${message}`,
    );
  }

  // Extract embedding: data.data[0].embedding
  try {
    const teiResponse = data as TeiEmbeddingResponse;
    const embedding = teiResponse.data[0].embedding;
    if (!Array.isArray(embedding)) {
      throw new TypeError("embedding is not an array");
    }
    return embedding;
  } catch (error: unknown) {
    const responseShape =
      data !== null && typeof data === "object"
        ? `response_keys=${Object.keys(data as Record<string, unknown>).join(",")}`
        : `response_type=${typeof data}`;
    throw new EmbeddingError(
      `Malformed TEI response — expected data[0].embedding: ` +
        `url=${endpoint} model=${embeddingModel} ${responseShape}`,
    );
  }
}

// ---------------------------------------------------------------------------
// ChromaDB HTTP client — replaces Python's chromadb.HttpClient
// ---------------------------------------------------------------------------

/**
 * Build the ChromaDB v2 collections base path.
 *
 * @param baseUrl - ChromaDB server URL (e.g., `http://chromadb:8000`).
 * @returns Full URL prefix for collection endpoints.
 */
function buildCollectionsBasePath(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${CHROMADB_API_PREFIX}/collections`;
}

/**
 * Get a ChromaDB collection by name, resolving to its UUID.
 *
 * Uses the ChromaDB v2 REST API:
 *   `GET {base}/api/v2/tenants/default_tenant/databases/default_database/collections/{name}`
 *
 * The response includes the collection's `id` (UUID) which is required
 * for the query endpoint.
 *
 * @param baseUrl - ChromaDB server URL (e.g., `http://chromadb:8000`).
 * @param collectionName - The collection name (e.g., `repo_abc123`).
 * @returns The collection object with `id` and `name`, or `null` if not found.
 * @throws {ChromaDbError} If the server is unreachable or returns an unexpected error.
 *
 * @example
 *   const collection = await getCollection("http://chromadb:8000", "repo_abc123");
 *   if (collection) {
 *     console.log(collection.id); // UUID for query endpoint
 *   }
 */
export async function getCollection(
  baseUrl: string,
  collectionName: string,
): Promise<ChromaCollection | null> {
  const collectionsPath = buildCollectionsBasePath(baseUrl);
  const endpoint = `${collectionsPath}/${encodeURIComponent(collectionName)}`;
  const timeoutSeconds = resolveQueryTimeout();

  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    timeoutSeconds * 1000,
  );

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
  } catch (error: unknown) {
    clearTimeout(timeoutId);
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new ChromaDbError(
        `ChromaDB request timed out after ${timeoutSeconds}s: ` +
          `url=${endpoint} collection=${collectionName}`,
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new ChromaDbError(
      `ChromaDB server unreachable: url=${endpoint} collection=${collectionName} error=${message}`,
    );
  } finally {
    clearTimeout(timeoutId);
  }

  // Collection not found is not an error — return null for graceful degradation
  if (response.status === 404 || response.status === 500) {
    // ChromaDB returns 500 for "collection not found" in some versions
    return null;
  }

  if (!response.ok) {
    let body = "";
    try {
      body = await response.text();
    } catch {
      // Ignore
    }
    throw new ChromaDbError(
      `ChromaDB get_collection failed with status ${response.status}: ` +
        `url=${endpoint} collection=${collectionName} body=${body.slice(0, 500)}`,
    );
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    return null;
  }

  if (
    !data ||
    typeof data !== "object" ||
    typeof (data as ChromaCollection).id !== "string"
  ) {
    return null;
  }

  return data as ChromaCollection;
}

/**
 * Query a ChromaDB collection by UUID.
 *
 * Uses the ChromaDB v2 REST API:
 *   `POST {base}/api/v2/tenants/default_tenant/databases/default_database/collections/{id}/query`
 *
 * **Important:** The query endpoint takes the collection **UUID** (not name).
 * Use `getCollection()` first to resolve name → UUID.
 *
 * @param baseUrl - ChromaDB server URL.
 * @param collectionId - The collection UUID (from `getCollection().id`).
 * @param queryEmbeddings - The query embedding vector.
 * @param nResults - Number of results to return.
 * @param where - Optional metadata filter (e.g., `{"layer": "chunk"}`).
 * @returns ChromaDB query results, or `null` on failure.
 *
 * @example
 *   const results = await queryCollection(
 *     "http://chromadb:8000",
 *     "550e8400-e29b-41d4-a716-446655440000",
 *     [0.1, 0.2, 0.3],
 *     5,
 *     { layer: "chunk" },
 *   );
 */
export async function queryCollection(
  baseUrl: string,
  collectionId: string,
  queryEmbeddings: number[],
  nResults: number,
  where?: Record<string, unknown> | null,
): Promise<ChromaQueryResult | null> {
  const collectionsPath = buildCollectionsBasePath(baseUrl);
  const endpoint = `${collectionsPath}/${encodeURIComponent(collectionId)}/query`;
  const timeoutSeconds = resolveQueryTimeout();

  const requestBody: Record<string, unknown> = {
    query_embeddings: [queryEmbeddings],
    n_results: nResults,
    include: ["documents", "metadatas", "distances"],
  };

  if (where && Object.keys(where).length > 0) {
    requestBody.where = where;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    timeoutSeconds * 1000,
  );

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
  } catch (error: unknown) {
    clearTimeout(timeoutId);
    if (error instanceof DOMException && error.name === "AbortError") {
      console.warn(
        `[chromadb-rag] ChromaDB query timed out after ${timeoutSeconds}s: ` +
          `url=${endpoint} collection=${collectionId}`,
      );
      return null;
    }
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `[chromadb-rag] ChromaDB query failed: url=${endpoint} collection=${collectionId} error=${message}`,
    );
    return null;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    let body = "";
    try {
      body = await response.text();
    } catch {
      // Ignore
    }
    console.warn(
      `[chromadb-rag] ChromaDB query returned status ${response.status}: ` +
        `url=${endpoint} collection=${collectionId} body=${body.slice(0, 500)}`,
    );
    return null;
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    console.warn(
      `[chromadb-rag] ChromaDB query response is not valid JSON: ` +
        `url=${endpoint} collection=${collectionId}`,
    );
    return null;
  }

  return data as ChromaQueryResult;
}

// ---------------------------------------------------------------------------
// Archive client initialisation — mirror Python _init_archive_clients()
// ---------------------------------------------------------------------------

/**
 * Pre-initialise ChromaDB connections for each archive.
 *
 * Resolves each archive's collection name to a UUID by calling
 * `getCollection()`. Archives whose ChromaDB server is unreachable or
 * whose collection does not exist are **skipped** with a warning
 * (graceful degradation).
 *
 * Mirrors Python's `_init_archive_clients()`.
 *
 * @param archives - List of archive configurations from `rag_config`.
 * @returns List of initialised archive clients for reachable archives.
 */
export async function initArchiveClients(
  archives: RagArchiveConfig[],
): Promise<ArchiveClient[]> {
  const archiveClients: ArchiveClient[] = [];

  for (const archive of archives) {
    const chromadbUrl = resolveChromaDbUrl(archive.chromadb_url);

    try {
      const collection = await getCollection(
        chromadbUrl,
        archive.collection_name,
      );

      if (!collection) {
        console.warn(
          `[chromadb-rag] Skipping archive ${archive.name} (collection=${archive.collection_name}, url=${chromadbUrl}): collection not found`,
        );
        continue;
      }

      archiveClients.push({
        config: archive,
        collectionId: collection.id,
        chromadbUrl,
      });

      console.log(
        `[chromadb-rag] ChromaDB archive connected: name=${archive.name} collection=${archive.collection_name} id=${collection.id} url=${chromadbUrl}`,
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `[chromadb-rag] Skipping archive ${archive.name} (collection=${archive.collection_name}, url=${chromadbUrl}): ${message}`,
      );
    }
  }

  return archiveClients;
}

// ---------------------------------------------------------------------------
// Result formatting — mirror Python _format_results()
// ---------------------------------------------------------------------------

/**
 * Format search results into a human-readable German string for the LLM.
 *
 * Produces output identical to the Python runtime:
 *
 * ```
 * [1] Archiv: Wartungsprotokoll (Ebene: chunk, Seite: 3)
 * Die Heizungsanlage wurde am 15. Januar 2025 gewartet...
 *
 * ---
 *
 * [2] Archiv: Betriebskostenabrechnung (Ebene: chunk, Seite: 12)
 * Die Kosten für die Heizungswartung betrugen...
 * ```
 *
 * Mirrors Python's `_format_results()` from `rag/retriever.py`.
 *
 * @param results - List of result dicts sorted by distance (ascending).
 * @param topK - Maximum number of results to include.
 * @returns Formatted string with archive name, metadata, and document text.
 */
export function formatResults(
  results: ArchiveSearchResult[],
  topK: number,
): string {
  if (results.length === 0) {
    return "Keine relevanten Dokumente gefunden.";
  }

  const formattedParts: string[] = [];

  const limitedResults = results.slice(0, topK);

  for (let index = 0; index < limitedResults.length; index++) {
    const result = limitedResults[index];
    const metadata = result.metadata || {};
    const sourceInfo: string[] = [];

    if (metadata.layer) {
      sourceInfo.push(`Ebene: ${metadata.layer}`);
    }
    if (metadata.page_number) {
      sourceInfo.push(`Seite: ${metadata.page_number}`);
    }
    if (metadata.section_heading) {
      sourceInfo.push(`Abschnitt: ${metadata.section_heading}`);
    }

    let header = `[${index + 1}] Archiv: ${result.archive}`;
    if (sourceInfo.length > 0) {
      header += ` (${sourceInfo.join(", ")})`;
    }

    formattedParts.push(`${header}\n${result.text}`);
  }

  return formattedParts.join("\n\n---\n\n");
}

// ---------------------------------------------------------------------------
// Tool factory — mirror Python create_archive_search_tool()
// ---------------------------------------------------------------------------

/**
 * Create a `search_archives` tool bound to the session's archives.
 *
 * Connects to each archive's ChromaDB collection at tool-creation time
 * (resolving collection names to UUIDs). Archives that are unreachable
 * or whose collection does not exist are silently skipped. If **no**
 * archives are reachable, returns `null` (the caller should not register
 * a broken tool).
 *
 * Mirrors Python's `create_archive_search_tool()` from `rag/retriever.py`.
 *
 * @param ragConfig - The parsed `ChromaRagConfig` containing the list of archive configurations.
 * @returns A `DynamicStructuredTool` instance, or `null` if no archives could be initialised.
 *
 * @example
 *   const ragConfig = extractRagConfig(config);
 *   if (ragConfig && ragConfig.archives.length > 0) {
 *     const tool = await createArchiveSearchTool(ragConfig);
 *     if (tool) tools.push(tool);
 *   }
 */
export async function createArchiveSearchTool(
  ragConfig: ChromaRagConfig,
): Promise<DynamicStructuredTool | null> {
  if (!ragConfig.archives || ragConfig.archives.length === 0) {
    console.log(
      "[chromadb-rag] createArchiveSearchTool: no archives configured",
    );
    return null;
  }

  const archiveClients = await initArchiveClients(ragConfig.archives);

  if (archiveClients.length === 0) {
    console.warn(
      `[chromadb-rag] createArchiveSearchTool: all ${ragConfig.archives.length} archives failed to initialise`,
    );
    return null;
  }

  const defaultTopK = resolveDefaultTopK();
  const defaultLayer = resolveDefaultLayer();

  // Use the first archive's embedding model as the reference for query
  // embedding. All archives in a single rag_config are expected to use
  // the same embedding model (the platform enforces this).
  const referenceEmbeddingModel = archiveClients[0].config.embedding_model;

  return new DynamicStructuredTool({
    name: "search_archives",
    description:
      "Search the user's document archives for relevant content. " +
      "Use this tool when the user asks about documents, policies, " +
      "reports, maintenance records, or any information that might " +
      "be stored in their document archives. Rephrase the user's " +
      "question into a semantic search query.",
    schema: z.object({
      query: z
        .string()
        .describe(
          "Search query — rephrase the user's question for semantic search",
        ),
      top_k: z
        .number()
        .int()
        .min(1)
        .max(MAX_TOP_K)
        .optional()
        .describe(
          `Number of results per archive (default ${defaultTopK}, max ${MAX_TOP_K})`,
        ),
    }),
    func: async ({
      query,
      top_k,
    }: {
      query: string;
      top_k?: number;
    }): Promise<string> => {
      const effectiveTopK = Math.max(
        1,
        Math.min(top_k ?? defaultTopK, MAX_TOP_K),
      );

      // Embed the query
      let queryEmbedding: number[];
      try {
        queryEmbedding = await embedQuery(query, referenceEmbeddingModel);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(
          `[chromadb-rag] Archive search embedding failed: ${message}`,
        );
        return "Archivsuche fehlgeschlagen — Embedding-Service nicht erreichbar.";
      }

      const allResults: ArchiveSearchResult[] = [];

      // Query each archive
      for (const archiveClient of archiveClients) {
        try {
          const whereFilter: Record<string, unknown> | null = defaultLayer
            ? { layer: defaultLayer }
            : null;

          const results = await queryCollection(
            archiveClient.chromadbUrl,
            archiveClient.collectionId,
            queryEmbedding,
            effectiveTopK,
            whereFilter,
          );

          if (!results) {
            continue;
          }

          // Extract parallel arrays from ChromaDB response
          const documents: (string | null)[] =
            results.documents?.[0] ?? [];
          const metadatas: (Record<string, unknown> | null)[] =
            results.metadatas?.[0] ?? [];
          const distances: number[] = results.distances?.[0] ?? [];

          for (let index = 0; index < documents.length; index++) {
            const document = documents[index];
            if (!document) {
              continue;
            }

            allResults.push({
              archive: archiveClient.config.name,
              text: document,
              metadata: metadatas[index] ?? {},
              distance: distances[index] ?? Infinity,
            });
          }
        } catch (error: unknown) {
          const message =
            error instanceof Error ? error.message : String(error);
          console.warn(
            `[chromadb-rag] Archive search failed for ${archiveClient.config.name} (collection=${archiveClient.config.collection_name}): ${message}`,
          );
        }
      }

      if (allResults.length === 0) {
        return "Keine relevanten Dokumente gefunden.";
      }

      // Sort by distance (lower = more similar for cosine distance)
      allResults.sort(
        (first, second) => first.distance - second.distance,
      );

      return formatResults(allResults, effectiveTopK);
    },
  });
}
