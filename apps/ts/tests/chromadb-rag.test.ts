/**
 * Unit tests for the ChromaDB RAG tool factory module.
 *
 * Covers:
 *   - Config extraction (extractRagConfig)
 *   - TEI embedding client (embedQuery)
 *   - ChromaDB collection lookup (getCollection)
 *   - ChromaDB collection query (queryCollection)
 *   - Result formatting (formatResults)
 *   - Archive client initialisation (initArchiveClients)
 *   - Tool factory (createArchiveSearchTool)
 *   - Environment variable resolution helpers
 *
 * All HTTP calls are mocked via globalThis.fetch override.
 *
 * Reference: apps/python/src/graphs/react_agent/rag/
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";

import {
  extractRagConfig,
  embedQuery,
  getCollection,
  queryCollection,
  formatResults,
  initArchiveClients,
  createArchiveSearchTool,
  resolveDefaultTopK,
  resolveDefaultLayer,
  resolveChromaDbUrl,
  resolveTeiUrl,
  EmbeddingError,
  ChromaDbError,
} from "../src/graphs/react-agent/utils/chromadb-rag";
import type {
  RagArchiveConfig,
  ChromaRagConfig,
} from "../src/graphs/react-agent/utils/chromadb-rag";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Save the original fetch so we can restore it after each test. */
const originalFetch = globalThis.fetch;

/**
 * Create a mock fetch that returns a successful JSON response.
 */
function mockFetchJson(data: unknown, status = 200): typeof fetch {
  return mock(async () =>
    new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  ) as unknown as typeof fetch;
}

/**
 * Create a mock fetch that rejects with an error.
 */
function mockFetchReject(errorMessage: string): typeof fetch {
  return mock(async () => {
    throw new Error(errorMessage);
  }) as unknown as typeof fetch;
}

/**
 * Create a mock fetch that returns a non-OK status with text body.
 */
function mockFetchError(status: number, body: string): typeof fetch {
  return mock(async () =>
    new Response(body, {
      status,
      headers: { "Content-Type": "text/plain" },
    }),
  ) as unknown as typeof fetch;
}

/**
 * Create a valid archive config for testing.
 */
function makeArchive(overrides?: Partial<RagArchiveConfig>): RagArchiveConfig {
  return {
    name: "Test Archive",
    collection_name: "repo_abc123",
    chromadb_url: "http://chromadb:8000",
    embedding_model: "jinaai/jina-embeddings-v2-base-de",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

afterEach(() => {
  // Restore original fetch after every test
  globalThis.fetch = originalFetch;

  // Clean up env vars we may have set
  delete process.env.DOCPROC_TEI_EMBEDDINGS_URL;
  delete process.env.RAG_EMBED_TIMEOUT_SECONDS;
  delete process.env.RAG_QUERY_TIMEOUT_SECONDS;
  delete process.env.RAG_DEFAULT_TOP_K;
  delete process.env.RAG_DEFAULT_LAYER;
  delete process.env.DOCPROC_CHROMADB_URL;
});

// ===========================================================================
// extractRagConfig
// ===========================================================================

describe("extractRagConfig", () => {
  it("returns null when rag_config is absent", () => {
    expect(extractRagConfig({})).toBeNull();
  });

  it("returns null when rag_config is null", () => {
    expect(extractRagConfig({ rag_config: null })).toBeNull();
  });

  it("returns null when rag_config is undefined", () => {
    expect(extractRagConfig({ rag_config: undefined })).toBeNull();
  });

  it("returns null when rag_config is not an object", () => {
    expect(extractRagConfig({ rag_config: "invalid" })).toBeNull();
    expect(extractRagConfig({ rag_config: 42 })).toBeNull();
    expect(extractRagConfig({ rag_config: true })).toBeNull();
  });

  it("returns null when archives is missing", () => {
    expect(extractRagConfig({ rag_config: {} })).toBeNull();
  });

  it("returns null when archives is empty array", () => {
    expect(extractRagConfig({ rag_config: { archives: [] } })).toBeNull();
  });

  it("returns null when archives is not an array", () => {
    expect(
      extractRagConfig({ rag_config: { archives: "not-an-array" } }),
    ).toBeNull();
  });

  it("parses a valid archive config", () => {
    const result = extractRagConfig({
      rag_config: {
        archives: [
          {
            name: "My Archive",
            collection_name: "repo_abc",
            chromadb_url: "http://chromadb:8000",
            embedding_model: "jinaai/jina-embeddings-v2-base-de",
          },
        ],
      },
    });

    expect(result).not.toBeNull();
    expect(result!.archives).toHaveLength(1);
    expect(result!.archives[0].name).toBe("My Archive");
    expect(result!.archives[0].collection_name).toBe("repo_abc");
    expect(result!.archives[0].chromadb_url).toBe("http://chromadb:8000");
    expect(result!.archives[0].embedding_model).toBe(
      "jinaai/jina-embeddings-v2-base-de",
    );
  });

  it("parses multiple archives", () => {
    const result = extractRagConfig({
      rag_config: {
        archives: [
          { name: "Archive 1", collection_name: "repo_1" },
          { name: "Archive 2", collection_name: "repo_2" },
        ],
      },
    });

    expect(result).not.toBeNull();
    expect(result!.archives).toHaveLength(2);
    expect(result!.archives[0].name).toBe("Archive 1");
    expect(result!.archives[1].name).toBe("Archive 2");
  });

  it("applies default chromadb_url when missing", () => {
    const result = extractRagConfig({
      rag_config: {
        archives: [{ name: "Test", collection_name: "repo_abc" }],
      },
    });

    expect(result).not.toBeNull();
    expect(result!.archives[0].chromadb_url).toBe("http://chromadb:8000");
  });

  it("applies default embedding_model when missing", () => {
    const result = extractRagConfig({
      rag_config: {
        archives: [{ name: "Test", collection_name: "repo_abc" }],
      },
    });

    expect(result).not.toBeNull();
    expect(result!.archives[0].embedding_model).toBe(
      "jinaai/jina-embeddings-v2-base-de",
    );
  });

  it("skips archives with missing name", () => {
    const result = extractRagConfig({
      rag_config: {
        archives: [
          { collection_name: "repo_abc" }, // no name
          { name: "Valid", collection_name: "repo_def" },
        ],
      },
    });

    expect(result).not.toBeNull();
    expect(result!.archives).toHaveLength(1);
    expect(result!.archives[0].name).toBe("Valid");
  });

  it("skips archives with missing collection_name", () => {
    const result = extractRagConfig({
      rag_config: {
        archives: [
          { name: "No Collection" }, // no collection_name
          { name: "Valid", collection_name: "repo_def" },
        ],
      },
    });

    expect(result).not.toBeNull();
    expect(result!.archives).toHaveLength(1);
    expect(result!.archives[0].collection_name).toBe("repo_def");
  });

  it("skips archives with empty name", () => {
    const result = extractRagConfig({
      rag_config: {
        archives: [
          { name: "", collection_name: "repo_abc" },
          { name: "Valid", collection_name: "repo_def" },
        ],
      },
    });

    expect(result).not.toBeNull();
    expect(result!.archives).toHaveLength(1);
  });

  it("skips non-object archive entries", () => {
    const result = extractRagConfig({
      rag_config: {
        archives: [
          null,
          42,
          "invalid",
          { name: "Valid", collection_name: "repo_abc" },
        ],
      },
    });

    expect(result).not.toBeNull();
    expect(result!.archives).toHaveLength(1);
  });

  it("returns null when all archives are invalid", () => {
    const result = extractRagConfig({
      rag_config: {
        archives: [{ invalid: true }, { also: "invalid" }],
      },
    });

    expect(result).toBeNull();
  });

  it("ignores extra fields in configurable", () => {
    const result = extractRagConfig({
      rag_config: {
        archives: [{ name: "Test", collection_name: "repo_abc" }],
      },
      other_field: "should be ignored",
    });

    expect(result).not.toBeNull();
    expect(result!.archives).toHaveLength(1);
  });
});

// ===========================================================================
// embedQuery
// ===========================================================================

describe("embedQuery", () => {
  it("returns embedding vector from TEI response", async () => {
    const mockEmbedding = [0.1, 0.2, 0.3, 0.4, 0.5];
    globalThis.fetch = mockFetchJson({
      data: [{ embedding: mockEmbedding }],
    });

    const result = await embedQuery(
      "test query",
      "jinaai/jina-embeddings-v2-base-de",
      "http://localhost:8080",
    );

    expect(result).toEqual(mockEmbedding);
  });

  it("sends correct request body to TEI", async () => {
    const capturedRequests: { url: string; body: string }[] = [];

    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      capturedRequests.push({
        url,
        body: init?.body as string,
      });
      return new Response(
        JSON.stringify({ data: [{ embedding: [0.1] }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    await embedQuery(
      "Wartungsplan für Heizungsanlage",
      "jinaai/jina-embeddings-v2-base-de",
      "http://localhost:8080",
    );

    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0].url).toBe(
      "http://localhost:8080/v1/embeddings",
    );

    const body = JSON.parse(capturedRequests[0].body);
    expect(body.model).toBe("jinaai/jina-embeddings-v2-base-de");
    expect(body.input).toEqual(["Wartungsplan für Heizungsanlage"]);
  });

  it("uses default TEI URL when none provided", async () => {
    const capturedUrls: string[] = [];

    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      capturedUrls.push(typeof input === "string" ? input : input.toString());
      return new Response(
        JSON.stringify({ data: [{ embedding: [0.1] }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    await embedQuery("test", "model-name");

    expect(capturedUrls[0]).toBe(
      "http://tei-embeddings:8080/v1/embeddings",
    );
  });

  it("uses DOCPROC_TEI_EMBEDDINGS_URL env var when set", async () => {
    process.env.DOCPROC_TEI_EMBEDDINGS_URL = "http://custom-tei:9090";

    const capturedUrls: string[] = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      capturedUrls.push(typeof input === "string" ? input : input.toString());
      return new Response(
        JSON.stringify({ data: [{ embedding: [0.1] }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    await embedQuery("test", "model-name");

    expect(capturedUrls[0]).toBe("http://custom-tei:9090/v1/embeddings");
  });

  it("throws EmbeddingError when server is unreachable", async () => {
    globalThis.fetch = mockFetchReject("Connection refused");

    await expect(
      embedQuery("test", "model-name", "http://localhost:1"),
    ).rejects.toThrow(EmbeddingError);
  });

  it("throws EmbeddingError with descriptive message on network error", async () => {
    globalThis.fetch = mockFetchReject("Connection refused");

    try {
      await embedQuery("test", "model-name", "http://localhost:1");
      expect(true).toBe(false); // Should not reach here
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(EmbeddingError);
      expect((error as Error).message).toContain("TEI server unreachable");
      expect((error as Error).message).toContain("model-name");
    }
  });

  it("throws EmbeddingError on non-200 response", async () => {
    globalThis.fetch = mockFetchError(500, "Internal Server Error");

    await expect(
      embedQuery("test", "model-name", "http://localhost:8080"),
    ).rejects.toThrow(EmbeddingError);
  });

  it("throws EmbeddingError with status code in message", async () => {
    globalThis.fetch = mockFetchError(503, "Service Unavailable");

    try {
      await embedQuery("test", "model-name", "http://localhost:8080");
      expect(true).toBe(false);
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(EmbeddingError);
      expect((error as Error).message).toContain("status 503");
    }
  });

  it("throws EmbeddingError when response is malformed (no data field)", async () => {
    globalThis.fetch = mockFetchJson({ result: "unexpected" });

    await expect(
      embedQuery("test", "model-name", "http://localhost:8080"),
    ).rejects.toThrow(EmbeddingError);
  });

  it("throws EmbeddingError when data[0].embedding is missing", async () => {
    globalThis.fetch = mockFetchJson({ data: [{ no_embedding: true }] });

    try {
      await embedQuery("test", "model-name", "http://localhost:8080");
      expect(true).toBe(false);
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(EmbeddingError);
      expect((error as Error).message).toContain("Malformed TEI response");
    }
  });

  it("throws EmbeddingError when data array is empty", async () => {
    globalThis.fetch = mockFetchJson({ data: [] });

    await expect(
      embedQuery("test", "model-name", "http://localhost:8080"),
    ).rejects.toThrow(EmbeddingError);
  });

  it("strips trailing slashes from TEI URL", async () => {
    const capturedUrls: string[] = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      capturedUrls.push(typeof input === "string" ? input : input.toString());
      return new Response(
        JSON.stringify({ data: [{ embedding: [0.1] }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    await embedQuery("test", "model-name", "http://localhost:8080///");

    expect(capturedUrls[0]).toBe("http://localhost:8080/v1/embeddings");
  });
});

// ===========================================================================
// getCollection
// ===========================================================================

describe("getCollection", () => {
  it("returns collection object with id and name", async () => {
    globalThis.fetch = mockFetchJson({
      id: "550e8400-e29b-41d4-a716-446655440000",
      name: "repo_abc123",
      metadata: {},
      dimension: 768,
    });

    const result = await getCollection("http://chromadb:8000", "repo_abc123");

    expect(result).not.toBeNull();
    expect(result!.id).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(result!.name).toBe("repo_abc123");
  });

  it("calls correct ChromaDB v2 API path", async () => {
    const capturedUrls: string[] = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      capturedUrls.push(typeof input === "string" ? input : input.toString());
      return new Response(
        JSON.stringify({ id: "test-uuid", name: "repo_abc" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    await getCollection("http://chromadb:8000", "repo_abc");

    expect(capturedUrls[0]).toBe(
      "http://chromadb:8000/api/v2/tenants/default_tenant/databases/default_database/collections/repo_abc",
    );
  });

  it("returns null for 404 response (collection not found)", async () => {
    globalThis.fetch = mockFetchError(404, "Not Found");

    const result = await getCollection("http://chromadb:8000", "nonexistent");

    expect(result).toBeNull();
  });

  it("returns null for 500 response (some versions return 500 for not found)", async () => {
    globalThis.fetch = mockFetchError(500, "Internal Server Error");

    const result = await getCollection("http://chromadb:8000", "nonexistent");

    expect(result).toBeNull();
  });

  it("throws ChromaDbError when server is unreachable", async () => {
    globalThis.fetch = mockFetchReject("Connection refused");

    await expect(
      getCollection("http://localhost:1", "repo_abc"),
    ).rejects.toThrow(ChromaDbError);
  });

  it("throws ChromaDbError with descriptive message on network error", async () => {
    globalThis.fetch = mockFetchReject("ECONNREFUSED");

    try {
      await getCollection("http://localhost:1", "repo_abc");
      expect(true).toBe(false);
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ChromaDbError);
      expect((error as Error).message).toContain("ChromaDB server unreachable");
      expect((error as Error).message).toContain("repo_abc");
    }
  });

  it("throws ChromaDbError for unexpected HTTP errors (e.g. 403)", async () => {
    globalThis.fetch = mockFetchError(403, "Forbidden");

    await expect(
      getCollection("http://chromadb:8000", "repo_abc"),
    ).rejects.toThrow(ChromaDbError);
  });

  it("returns null for malformed JSON response (missing id)", async () => {
    globalThis.fetch = mockFetchJson({ name: "repo_abc" }); // no id field

    const result = await getCollection("http://chromadb:8000", "repo_abc");

    expect(result).toBeNull();
  });

  it("encodes collection name in URL", async () => {
    const capturedUrls: string[] = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      capturedUrls.push(typeof input === "string" ? input : input.toString());
      return new Response(
        JSON.stringify({ id: "test-uuid", name: "name with spaces" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    await getCollection("http://chromadb:8000", "name with spaces");

    expect(capturedUrls[0]).toContain("name%20with%20spaces");
  });

  it("strips trailing slashes from base URL", async () => {
    const capturedUrls: string[] = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      capturedUrls.push(typeof input === "string" ? input : input.toString());
      return new Response(
        JSON.stringify({ id: "test-uuid", name: "repo_abc" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    await getCollection("http://chromadb:8000///", "repo_abc");

    expect(capturedUrls[0]).toStartWith(
      "http://chromadb:8000/api/v2/",
    );
    // Should NOT have double slashes
    expect(capturedUrls[0]).not.toContain("///");
  });
});

// ===========================================================================
// queryCollection
// ===========================================================================

describe("queryCollection", () => {
  it("returns query results with documents, metadatas, and distances", async () => {
    const mockResults = {
      ids: [["doc1", "doc2"]],
      documents: [["Document text 1", "Document text 2"]],
      metadatas: [[{ layer: "chunk", page_number: 3 }, { layer: "chunk" }]],
      distances: [[0.12, 0.34]],
    };

    globalThis.fetch = mockFetchJson(mockResults);

    const result = await queryCollection(
      "http://chromadb:8000",
      "test-uuid",
      [0.1, 0.2, 0.3],
      5,
      { layer: "chunk" },
    );

    expect(result).not.toBeNull();
    expect(result!.documents![0]).toEqual([
      "Document text 1",
      "Document text 2",
    ]);
    expect(result!.distances![0]).toEqual([0.12, 0.34]);
  });

  it("sends correct request body", async () => {
    const capturedBodies: string[] = [];
    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBodies.push(init?.body as string);
      return new Response(
        JSON.stringify({
          ids: [[]],
          documents: [[]],
          metadatas: [[]],
          distances: [[]],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    await queryCollection(
      "http://chromadb:8000",
      "test-uuid",
      [0.1, 0.2],
      3,
      { layer: "chunk" },
    );

    expect(capturedBodies).toHaveLength(1);
    const body = JSON.parse(capturedBodies[0]);
    expect(body.query_embeddings).toEqual([[0.1, 0.2]]);
    expect(body.n_results).toBe(3);
    expect(body.include).toEqual(["documents", "metadatas", "distances"]);
    expect(body.where).toEqual({ layer: "chunk" });
  });

  it("calls correct ChromaDB v2 query endpoint using UUID", async () => {
    const capturedUrls: string[] = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      capturedUrls.push(typeof input === "string" ? input : input.toString());
      return new Response(
        JSON.stringify({ ids: [[]], documents: [[]], metadatas: [[]], distances: [[]] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    await queryCollection(
      "http://chromadb:8000",
      "550e8400-e29b-41d4-a716-446655440000",
      [0.1],
      5,
    );

    expect(capturedUrls[0]).toBe(
      "http://chromadb:8000/api/v2/tenants/default_tenant/databases/default_database/collections/550e8400-e29b-41d4-a716-446655440000/query",
    );
  });

  it("omits where filter when null", async () => {
    const capturedBodies: string[] = [];
    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBodies.push(init?.body as string);
      return new Response(
        JSON.stringify({ ids: [[]], documents: [[]], metadatas: [[]], distances: [[]] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    await queryCollection(
      "http://chromadb:8000",
      "test-uuid",
      [0.1],
      5,
      null,
    );

    const body = JSON.parse(capturedBodies[0]);
    expect(body.where).toBeUndefined();
  });

  it("returns null when server is unreachable (graceful degradation)", async () => {
    globalThis.fetch = mockFetchReject("Connection refused");

    const result = await queryCollection(
      "http://localhost:1",
      "test-uuid",
      [0.1],
      5,
    );

    expect(result).toBeNull();
  });

  it("returns null on non-200 response (graceful degradation)", async () => {
    globalThis.fetch = mockFetchError(500, "Internal Server Error");

    const result = await queryCollection(
      "http://chromadb:8000",
      "test-uuid",
      [0.1],
      5,
    );

    expect(result).toBeNull();
  });

  it("returns null on malformed JSON response", async () => {
    globalThis.fetch = mock(async () =>
      new Response("not json", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      }),
    ) as unknown as typeof fetch;

    const result = await queryCollection(
      "http://chromadb:8000",
      "test-uuid",
      [0.1],
      5,
    );

    expect(result).toBeNull();
  });
});

// ===========================================================================
// formatResults
// ===========================================================================

describe("formatResults", () => {
  it("returns German 'no results' message for empty array", () => {
    const result = formatResults([], 5);
    expect(result).toBe("Keine relevanten Dokumente gefunden.");
  });

  it("formats a single result with metadata", () => {
    const result = formatResults(
      [
        {
          archive: "Wartungsprotokoll",
          text: "Die Heizungsanlage wurde am 15. Januar 2025 gewartet.",
          metadata: { layer: "chunk", page_number: 3 },
          distance: 0.12,
        },
      ],
      5,
    );

    expect(result).toBe(
      "[1] Archiv: Wartungsprotokoll (Ebene: chunk, Seite: 3)\n" +
        "Die Heizungsanlage wurde am 15. Januar 2025 gewartet.",
    );
  });

  it("formats multiple results separated by dividers", () => {
    const result = formatResults(
      [
        {
          archive: "Archive A",
          text: "Text one",
          metadata: { layer: "chunk" },
          distance: 0.1,
        },
        {
          archive: "Archive B",
          text: "Text two",
          metadata: { layer: "chunk", page_number: 5 },
          distance: 0.2,
        },
      ],
      5,
    );

    expect(result).toContain("[1] Archiv: Archive A (Ebene: chunk)");
    expect(result).toContain("Text one");
    expect(result).toContain("\n\n---\n\n");
    expect(result).toContain("[2] Archiv: Archive B (Ebene: chunk, Seite: 5)");
    expect(result).toContain("Text two");
  });

  it("includes section_heading in metadata when present", () => {
    const result = formatResults(
      [
        {
          archive: "Test",
          text: "Content here",
          metadata: {
            layer: "chunk",
            page_number: 1,
            section_heading: "Einleitung",
          },
          distance: 0.1,
        },
      ],
      5,
    );

    expect(result).toContain("Ebene: chunk");
    expect(result).toContain("Seite: 1");
    expect(result).toContain("Abschnitt: Einleitung");
  });

  it("omits metadata markers when metadata is empty", () => {
    const result = formatResults(
      [
        {
          archive: "Plain",
          text: "No metadata",
          metadata: {},
          distance: 0.5,
        },
      ],
      5,
    );

    expect(result).toBe("[1] Archiv: Plain\nNo metadata");
    // No parentheses when no metadata
    expect(result).not.toContain("(");
  });

  it("respects topK limit", () => {
    const results = Array.from({ length: 10 }, (_, index) => ({
      archive: `Archive ${index + 1}`,
      text: `Text ${index + 1}`,
      metadata: {},
      distance: index * 0.1,
    }));

    const result = formatResults(results, 3);

    expect(result).toContain("[1] Archiv: Archive 1");
    expect(result).toContain("[2] Archiv: Archive 2");
    expect(result).toContain("[3] Archiv: Archive 3");
    expect(result).not.toContain("[4]");
  });

  it("handles topK larger than results array", () => {
    const result = formatResults(
      [
        {
          archive: "Only One",
          text: "Single result",
          metadata: {},
          distance: 0.1,
        },
      ],
      100,
    );

    expect(result).toContain("[1] Archiv: Only One");
    expect(result).not.toContain("[2]");
  });

  it("handles metadata with only layer", () => {
    const result = formatResults(
      [
        {
          archive: "Test",
          text: "Content",
          metadata: { layer: "paragraph" },
          distance: 0.1,
        },
      ],
      5,
    );

    expect(result).toBe("[1] Archiv: Test (Ebene: paragraph)\nContent");
  });

  it("handles metadata with only page_number", () => {
    const result = formatResults(
      [
        {
          archive: "Test",
          text: "Content",
          metadata: { page_number: 42 },
          distance: 0.1,
        },
      ],
      5,
    );

    expect(result).toBe("[1] Archiv: Test (Seite: 42)\nContent");
  });
});

// ===========================================================================
// initArchiveClients
// ===========================================================================

describe("initArchiveClients", () => {
  it("returns archive clients for reachable archives", async () => {
    globalThis.fetch = mockFetchJson({
      id: "uuid-123",
      name: "repo_abc123",
    });

    const clients = await initArchiveClients([makeArchive()]);

    expect(clients).toHaveLength(1);
    expect(clients[0].collectionId).toBe("uuid-123");
    expect(clients[0].config.name).toBe("Test Archive");
  });

  it("skips unreachable archives gracefully", async () => {
    globalThis.fetch = mockFetchReject("Connection refused");

    const clients = await initArchiveClients([makeArchive()]);

    expect(clients).toHaveLength(0);
  });

  it("skips archives with non-existent collections (404)", async () => {
    globalThis.fetch = mockFetchError(404, "Not Found");

    const clients = await initArchiveClients([makeArchive()]);

    expect(clients).toHaveLength(0);
  });

  it("handles mixed reachable and unreachable archives", async () => {
    let callCount = 0;
    globalThis.fetch = mock(async () => {
      callCount++;
      if (callCount === 1) {
        // First archive: success
        return new Response(
          JSON.stringify({ id: "uuid-1", name: "repo_1" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      // Second archive: failure
      throw new Error("Connection refused");
    }) as unknown as typeof fetch;

    const clients = await initArchiveClients([
      makeArchive({ name: "Good Archive", collection_name: "repo_1" }),
      makeArchive({ name: "Bad Archive", collection_name: "repo_2" }),
    ]);

    expect(clients).toHaveLength(1);
    expect(clients[0].config.name).toBe("Good Archive");
  });

  it("returns empty array for empty input", async () => {
    const clients = await initArchiveClients([]);

    expect(clients).toHaveLength(0);
  });
});

// ===========================================================================
// createArchiveSearchTool
// ===========================================================================

describe("createArchiveSearchTool", () => {
  it("returns null when archives list is empty", async () => {
    const result = await createArchiveSearchTool({ archives: [] });

    expect(result).toBeNull();
  });

  it("returns null when all archives fail to initialise", async () => {
    globalThis.fetch = mockFetchReject("Connection refused");

    const result = await createArchiveSearchTool({
      archives: [makeArchive()],
    });

    expect(result).toBeNull();
  });

  it("returns a DynamicStructuredTool when archives are reachable", async () => {
    // Mock getCollection for init
    globalThis.fetch = mockFetchJson({
      id: "uuid-123",
      name: "repo_abc123",
    });

    const result = await createArchiveSearchTool({
      archives: [makeArchive()],
    });

    expect(result).not.toBeNull();
    expect(result!.name).toBe("search_archives");
  });

  it("tool has correct name and description", async () => {
    globalThis.fetch = mockFetchJson({
      id: "uuid-123",
      name: "repo_abc123",
    });

    const tool = await createArchiveSearchTool({
      archives: [makeArchive()],
    });

    expect(tool).not.toBeNull();
    expect(tool!.name).toBe("search_archives");
    expect(tool!.description).toContain("Search the user's document archives");
    expect(tool!.description).toContain("semantic search query");
  });

  it("tool returns German error message when embedding fails", async () => {
    // First call: getCollection (success during init)
    // Subsequent calls: embedQuery (failure during search)
    let callCount = 0;
    globalThis.fetch = mock(async () => {
      callCount++;
      if (callCount === 1) {
        // getCollection during init
        return new Response(
          JSON.stringify({ id: "uuid-123", name: "repo_abc123" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      // embedQuery during search — fail
      throw new Error("Connection refused");
    }) as unknown as typeof fetch;

    const tool = await createArchiveSearchTool({
      archives: [makeArchive()],
    });

    expect(tool).not.toBeNull();

    const result = await tool!.invoke({ query: "test query" });

    expect(result).toBe(
      "Archivsuche fehlgeschlagen — Embedding-Service nicht erreichbar.",
    );
  });

  it("tool returns German 'no results' when query returns empty", async () => {
    let callCount = 0;
    globalThis.fetch = mock(async () => {
      callCount++;
      if (callCount === 1) {
        // getCollection during init
        return new Response(
          JSON.stringify({ id: "uuid-123", name: "repo_abc123" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (callCount === 2) {
        // embedQuery during search
        return new Response(
          JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      // queryCollection — empty results
      return new Response(
        JSON.stringify({
          ids: [[]],
          documents: [[]],
          metadatas: [[]],
          distances: [[]],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const tool = await createArchiveSearchTool({
      archives: [makeArchive()],
    });

    expect(tool).not.toBeNull();

    const result = await tool!.invoke({ query: "test query" });

    expect(result).toBe("Keine relevanten Dokumente gefunden.");
  });

  it("tool returns formatted results when documents are found", async () => {
    let callCount = 0;
    globalThis.fetch = mock(async () => {
      callCount++;
      if (callCount === 1) {
        // getCollection during init
        return new Response(
          JSON.stringify({ id: "uuid-123", name: "repo_abc123" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (callCount === 2) {
        // embedQuery during search
        return new Response(
          JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      // queryCollection — return results
      return new Response(
        JSON.stringify({
          ids: [["doc1", "doc2"]],
          documents: [["Erster Text", "Zweiter Text"]],
          metadatas: [
            [{ layer: "chunk", page_number: 1 }, { layer: "chunk", page_number: 5 }],
          ],
          distances: [[0.12, 0.34]],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const tool = await createArchiveSearchTool({
      archives: [makeArchive({ name: "Wartungsprotokoll" })],
    });

    expect(tool).not.toBeNull();

    const result = await tool!.invoke({ query: "Heizung" });

    expect(result).toContain("[1] Archiv: Wartungsprotokoll");
    expect(result).toContain("Ebene: chunk");
    expect(result).toContain("Seite: 1");
    expect(result).toContain("Erster Text");
    expect(result).toContain("[2] Archiv: Wartungsprotokoll");
    expect(result).toContain("Zweiter Text");
  });

  it("tool skips null documents in results", async () => {
    let callCount = 0;
    globalThis.fetch = mock(async () => {
      callCount++;
      if (callCount === 1) {
        return new Response(
          JSON.stringify({ id: "uuid-123", name: "repo_abc123" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (callCount === 2) {
        return new Response(
          JSON.stringify({ data: [{ embedding: [0.1] }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          ids: [["doc1", "doc2"]],
          documents: [[null, "Valid text"]],
          metadatas: [[null, { layer: "chunk" }]],
          distances: [[0.1, 0.2]],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const tool = await createArchiveSearchTool({
      archives: [makeArchive()],
    });

    const result = await tool!.invoke({ query: "test" });

    // Only the non-null document should appear
    expect(result).toContain("[1] Archiv: Test Archive");
    expect(result).toContain("Valid text");
    expect(result).not.toContain("[2]");
  });

  it("tool sorts results by distance across multiple archives", async () => {
    let callCount = 0;
    globalThis.fetch = mock(async () => {
      callCount++;
      // Two archives init: calls 1 and 2
      if (callCount <= 2) {
        return new Response(
          JSON.stringify({
            id: callCount === 1 ? "uuid-1" : "uuid-2",
            name: callCount === 1 ? "repo_1" : "repo_2",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      // embedQuery: call 3
      if (callCount === 3) {
        return new Response(
          JSON.stringify({ data: [{ embedding: [0.1] }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      // queryCollection for archive 1: call 4
      if (callCount === 4) {
        return new Response(
          JSON.stringify({
            ids: [["a1"]],
            documents: [["Text from archive 1"]],
            metadatas: [[{ layer: "chunk" }]],
            distances: [[0.5]], // Higher distance (less similar)
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      // queryCollection for archive 2: call 5
      return new Response(
        JSON.stringify({
          ids: [["b1"]],
          documents: [["Text from archive 2"]],
          metadatas: [[{ layer: "chunk" }]],
          distances: [[0.1]], // Lower distance (more similar)
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const tool = await createArchiveSearchTool({
      archives: [
        makeArchive({ name: "Archive 1", collection_name: "repo_1" }),
        makeArchive({ name: "Archive 2", collection_name: "repo_2" }),
      ],
    });

    expect(tool).not.toBeNull();

    const result = await tool!.invoke({ query: "test" });

    // Archive 2 should come first (lower distance)
    const archive2Position = result.indexOf("Archive 2");
    const archive1Position = result.indexOf("Archive 1");
    expect(archive2Position).toBeLessThan(archive1Position);
    expect(result).toContain("[1] Archiv: Archive 2");
    expect(result).toContain("[2] Archiv: Archive 1");
  });
});

// ===========================================================================
// Environment variable resolution helpers
// ===========================================================================

describe("resolveTeiUrl", () => {
  it("returns explicit URL when provided", () => {
    expect(resolveTeiUrl("http://custom:9090")).toBe("http://custom:9090");
  });

  it("strips trailing slashes from explicit URL", () => {
    expect(resolveTeiUrl("http://custom:9090///")).toBe("http://custom:9090");
  });

  it("returns env var when no explicit URL", () => {
    process.env.DOCPROC_TEI_EMBEDDINGS_URL = "http://env-tei:8080";
    expect(resolveTeiUrl()).toBe("http://env-tei:8080");
  });

  it("returns default when no explicit URL and no env var", () => {
    expect(resolveTeiUrl()).toBe("http://tei-embeddings:8080");
  });

  it("prefers explicit URL over env var", () => {
    process.env.DOCPROC_TEI_EMBEDDINGS_URL = "http://env-tei:8080";
    expect(resolveTeiUrl("http://explicit:9090")).toBe("http://explicit:9090");
  });
});

describe("resolveDefaultTopK", () => {
  it("returns default (5) when env var is not set", () => {
    expect(resolveDefaultTopK()).toBe(5);
  });

  it("returns env var value when set", () => {
    process.env.RAG_DEFAULT_TOP_K = "10";
    expect(resolveDefaultTopK()).toBe(10);
  });

  it("clamps to max 20", () => {
    process.env.RAG_DEFAULT_TOP_K = "100";
    expect(resolveDefaultTopK()).toBe(20);
  });

  it("clamps to min 1", () => {
    process.env.RAG_DEFAULT_TOP_K = "0";
    // 0 is not > 0, so falls through to default
    expect(resolveDefaultTopK()).toBe(5);
  });

  it("returns default for invalid env var", () => {
    process.env.RAG_DEFAULT_TOP_K = "not-a-number";
    expect(resolveDefaultTopK()).toBe(5);
  });
});

describe("resolveDefaultLayer", () => {
  it("returns default ('chunk') when env var is not set", () => {
    expect(resolveDefaultLayer()).toBe("chunk");
  });

  it("returns env var value when set", () => {
    process.env.RAG_DEFAULT_LAYER = "paragraph";
    expect(resolveDefaultLayer()).toBe("paragraph");
  });
});

describe("resolveChromaDbUrl", () => {
  it("returns archive URL when provided", () => {
    expect(resolveChromaDbUrl("http://custom:9000")).toBe("http://custom:9000");
  });

  it("strips trailing slashes", () => {
    expect(resolveChromaDbUrl("http://custom:9000///")).toBe(
      "http://custom:9000",
    );
  });

  it("returns env var when no archive URL", () => {
    process.env.DOCPROC_CHROMADB_URL = "http://env-chromadb:8000";
    expect(resolveChromaDbUrl()).toBe("http://env-chromadb:8000");
  });

  it("returns default when no archive URL and no env var", () => {
    expect(resolveChromaDbUrl()).toBe("http://chromadb:8000");
  });

  it("prefers archive URL over env var", () => {
    process.env.DOCPROC_CHROMADB_URL = "http://env-chromadb:8000";
    expect(resolveChromaDbUrl("http://explicit:9000")).toBe(
      "http://explicit:9000",
    );
  });
});

// ===========================================================================
// Configuration integration — parseGraphConfig should include rag_config
// ===========================================================================

describe("parseGraphConfig — rag_config integration", () => {
  // Import parseGraphConfig dynamically to test the integration
  const { parseGraphConfig } = require("../src/graphs/react-agent/configuration");

  it("includes rag_config: null when not provided", () => {
    const config = parseGraphConfig({});
    expect(config.rag_config).toBeNull();
  });

  it("parses rag_config when provided in configurable", () => {
    const config = parseGraphConfig({
      rag_config: {
        archives: [
          {
            name: "Test Archive",
            collection_name: "repo_abc",
            chromadb_url: "http://chromadb:8000",
            embedding_model: "jinaai/jina-embeddings-v2-base-de",
          },
        ],
      },
    });

    expect(config.rag_config).not.toBeNull();
    expect(config.rag_config.archives).toHaveLength(1);
    expect(config.rag_config.archives[0].name).toBe("Test Archive");
  });

  it("rag_config is null when archives is empty", () => {
    const config = parseGraphConfig({
      rag_config: { archives: [] },
    });
    expect(config.rag_config).toBeNull();
  });

  it("both rag and rag_config can coexist", () => {
    const config = parseGraphConfig({
      rag: {
        rag_url: "https://rag.example.com",
        collections: ["uuid-1"],
      },
      rag_config: {
        archives: [
          { name: "Archive", collection_name: "repo_1" },
        ],
      },
    });

    expect(config.rag).not.toBeNull();
    expect(config.rag.rag_url).toBe("https://rag.example.com");
    expect(config.rag_config).not.toBeNull();
    expect(config.rag_config.archives).toHaveLength(1);
  });
});

// ===========================================================================
// Type compliance
// ===========================================================================

describe("RagArchiveConfig type", () => {
  it("accepts valid config shape", () => {
    const config: RagArchiveConfig = {
      name: "Test Archive",
      collection_name: "repo_abc",
      chromadb_url: "http://chromadb:8000",
      embedding_model: "jinaai/jina-embeddings-v2-base-de",
    };
    expect(config.name).toBe("Test Archive");
    expect(config.collection_name).toBe("repo_abc");
    expect(config.chromadb_url).toBe("http://chromadb:8000");
    expect(config.embedding_model).toBe(
      "jinaai/jina-embeddings-v2-base-de",
    );
  });
});

describe("ChromaRagConfig type", () => {
  it("accepts valid config shape", () => {
    const config: ChromaRagConfig = {
      archives: [
        {
          name: "Archive 1",
          collection_name: "repo_1",
          chromadb_url: "http://chromadb:8000",
          embedding_model: "jinaai/jina-embeddings-v2-base-de",
        },
      ],
    };
    expect(config.archives).toHaveLength(1);
  });

  it("accepts empty archives array", () => {
    const config: ChromaRagConfig = { archives: [] };
    expect(config.archives).toHaveLength(0);
  });

  it("extractRagConfig output matches ChromaRagConfig type", () => {
    const parsed = extractRagConfig({
      rag_config: {
        archives: [
          { name: "Test", collection_name: "repo_abc" },
        ],
      },
    });
    expect(parsed).not.toBeNull();
    const config: ChromaRagConfig = parsed!;
    expect(config.archives).toHaveLength(1);
  });
});
