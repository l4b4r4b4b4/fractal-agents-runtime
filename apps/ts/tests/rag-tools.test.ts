/**
 * Unit tests for the RAG tool factory module.
 *
 * Covers:
 *   - Tool name sanitization (sanitizeToolName)
 *   - Tool description building (buildToolDescription)
 *   - Document formatting (formatDocuments)
 *   - RAG config parsing (parseRagConfig)
 *   - createRagTool error handling (network failures)
 *   - createRagTools batch creation and graceful degradation
 *
 * Reference: apps/python/src/graphs/react_agent/utils/tools.py
 */

import { describe, it, expect } from "bun:test";

import {
  sanitizeToolName,
  buildToolDescription,
  formatDocuments,
  parseRagConfig,
  createRagTool,
  createRagTools,
} from "../src/graphs/react-agent/utils/rag-tools";
import type { RagConfig } from "../src/graphs/react-agent/utils/rag-tools";

// ===========================================================================
// sanitizeToolName
// ===========================================================================

describe("sanitizeToolName", () => {
  it("returns a clean name unchanged", () => {
    expect(sanitizeToolName("my_collection", "uuid-1")).toBe("my_collection");
  });

  it("replaces spaces with underscores", () => {
    expect(sanitizeToolName("my collection", "uuid-1")).toBe("my_collection");
  });

  it("replaces special characters with underscores", () => {
    expect(sanitizeToolName("coll@#$%name!", "uuid-1")).toBe("coll____name_");
  });

  it("preserves hyphens", () => {
    expect(sanitizeToolName("my-collection-v2", "uuid-1")).toBe(
      "my-collection-v2",
    );
  });

  it("preserves alphanumeric characters", () => {
    expect(sanitizeToolName("Collection123", "uuid-1")).toBe("Collection123");
  });

  it("truncates to 64 characters", () => {
    const longName = "a".repeat(100);
    const result = sanitizeToolName(longName, "uuid-1");
    expect(result.length).toBe(64);
    expect(result).toBe("a".repeat(64));
  });

  it("uses fallback when name sanitizes to empty string", () => {
    // Name consists entirely of disallowed characters... except underscores
    // are allowed so let's use characters that ALL get replaced
    // Actually, the replacement produces underscores which are valid.
    // To get an empty result, we need an empty input string.
    expect(sanitizeToolName("", "abc-123")).toBe("collection_abc-123");
  });

  it("uses collectionId in fallback name", () => {
    const result = sanitizeToolName("", "550e8400");
    expect(result).toBe("collection_550e8400");
  });

  it("truncates fallback name to 64 characters", () => {
    const longId = "x".repeat(100);
    const result = sanitizeToolName("", longId);
    expect(result.length).toBe(64);
    expect(result.startsWith("collection_")).toBe(true);
  });

  it("handles unicode characters by replacing them", () => {
    expect(sanitizeToolName("München Daten", "uuid-1")).toBe("M_nchen_Daten");
  });

  it("handles dots and slashes", () => {
    expect(sanitizeToolName("file.name/path", "uuid-1")).toBe("file_name_path");
  });
});

// ===========================================================================
// buildToolDescription
// ===========================================================================

describe("buildToolDescription", () => {
  it("returns base description when no raw description provided", () => {
    const result = buildToolDescription(null);
    expect(result).toBe(
      "Search your collection of documents for results" +
        " semantically similar to the input query",
    );
  });

  it("returns base description for undefined", () => {
    const result = buildToolDescription(undefined);
    expect(result).toBe(
      "Search your collection of documents for results" +
        " semantically similar to the input query",
    );
  });

  it("returns base description for empty string", () => {
    const result = buildToolDescription("");
    expect(result).toBe(
      "Search your collection of documents for results" +
        " semantically similar to the input query",
    );
  });

  it("appends collection description when provided", () => {
    const result = buildToolDescription("Financial reports for Q4 2024");
    expect(result).toBe(
      "Search your collection of documents for results" +
        " semantically similar to the input query." +
        " Collection description: Financial reports for Q4 2024",
    );
  });

  it("appends short description", () => {
    const result = buildToolDescription("Sales data");
    expect(result).toContain("Collection description: Sales data");
  });
});

// ===========================================================================
// formatDocuments
// ===========================================================================

describe("formatDocuments", () => {
  it("formats an empty array", () => {
    const result = formatDocuments([]);
    expect(result).toBe("<all-documents>\n</all-documents>");
  });

  it("formats a single document", () => {
    const result = formatDocuments([
      { id: "doc-1", page_content: "Hello world" },
    ]);
    expect(result).toBe(
      '<all-documents>\n  <document id="doc-1">\n    Hello world\n  </document>\n</all-documents>',
    );
  });

  it("formats multiple documents", () => {
    const result = formatDocuments([
      { id: "doc-1", page_content: "First doc" },
      { id: "doc-2", page_content: "Second doc" },
    ]);
    expect(result).toContain('<document id="doc-1">');
    expect(result).toContain("First doc");
    expect(result).toContain('<document id="doc-2">');
    expect(result).toContain("Second doc");
    expect(result).toStartWith("<all-documents>\n");
    expect(result).toEndWith("</all-documents>");
  });

  it("uses 'unknown' for missing document id", () => {
    const result = formatDocuments([{ page_content: "No ID doc" }]);
    expect(result).toContain('<document id="unknown">');
    expect(result).toContain("No ID doc");
  });

  it("uses empty string for missing page_content", () => {
    const result = formatDocuments([{ id: "doc-1" }]);
    expect(result).toContain('<document id="doc-1">');
    expect(result).toContain("    \n");
  });

  it("handles document with both fields missing", () => {
    const result = formatDocuments([{}]);
    expect(result).toContain('<document id="unknown">');
    expect(result).toStartWith("<all-documents>");
    expect(result).toEndWith("</all-documents>");
  });

  it("preserves special characters in content", () => {
    const result = formatDocuments([
      { id: "d1", page_content: "Price: $100 & <b>bold</b>" },
    ]);
    expect(result).toContain("Price: $100 & <b>bold</b>");
  });

  it("preserves extra fields on document objects without breaking format", () => {
    const result = formatDocuments([
      {
        id: "doc-1",
        page_content: "Content here",
        metadata: { source: "test" },
      },
    ]);
    expect(result).toContain('<document id="doc-1">');
    expect(result).toContain("Content here");
    // metadata should not appear in output
    expect(result).not.toContain("metadata");
  });
});

// ===========================================================================
// parseRagConfig
// ===========================================================================

describe("parseRagConfig", () => {
  it("returns null for null input", () => {
    expect(parseRagConfig(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(parseRagConfig(undefined)).toBeNull();
  });

  it("returns null for non-object input (string)", () => {
    expect(parseRagConfig("invalid")).toBeNull();
  });

  it("returns null for non-object input (number)", () => {
    expect(parseRagConfig(42)).toBeNull();
  });

  it("returns null for non-object input (boolean)", () => {
    expect(parseRagConfig(true)).toBeNull();
  });

  it("returns null for empty object (no url, no collections)", () => {
    expect(parseRagConfig({})).toBeNull();
  });

  it("returns config with rag_url only", () => {
    const result = parseRagConfig({ rag_url: "https://rag.example.com" });
    expect(result).not.toBeNull();
    expect(result!.rag_url).toBe("https://rag.example.com");
    expect(result!.collections).toBeNull();
  });

  it("returns config with collections only", () => {
    const result = parseRagConfig({ collections: ["uuid-1", "uuid-2"] });
    expect(result).not.toBeNull();
    expect(result!.rag_url).toBeNull();
    expect(result!.collections).toEqual(["uuid-1", "uuid-2"]);
  });

  it("returns full config with both fields", () => {
    const result = parseRagConfig({
      rag_url: "https://rag.example.com",
      collections: ["uuid-1"],
    });
    expect(result).not.toBeNull();
    expect(result!.rag_url).toBe("https://rag.example.com");
    expect(result!.collections).toEqual(["uuid-1"]);
  });

  it("returns null for empty rag_url string", () => {
    const result = parseRagConfig({ rag_url: "" });
    expect(result).toBeNull();
  });

  it("returns null for empty collections array", () => {
    const result = parseRagConfig({ collections: [] });
    expect(result).toBeNull();
  });

  it("filters out non-string collection entries", () => {
    const result = parseRagConfig({
      rag_url: "https://rag.example.com",
      collections: ["uuid-1", 42, null, "uuid-2", "", undefined],
    });
    expect(result).not.toBeNull();
    expect(result!.collections).toEqual(["uuid-1", "uuid-2"]);
  });

  it("returns null when all collection entries are invalid", () => {
    const result = parseRagConfig({
      collections: [42, null, "", undefined],
    });
    expect(result).toBeNull();
  });

  it("returns null for non-string rag_url", () => {
    const result = parseRagConfig({ rag_url: 42 });
    expect(result).toBeNull();
  });

  it("returns null for non-array collections", () => {
    const result = parseRagConfig({
      collections: "not-an-array",
    });
    // collections is not an array, so it's treated as null
    // rag_url is also absent, so both are empty → null
    expect(result).toBeNull();
  });

  it("handles extra fields gracefully (ignores them)", () => {
    const result = parseRagConfig({
      rag_url: "https://rag.example.com",
      collections: ["uuid-1"],
      extra_field: "should be ignored",
    });
    expect(result).not.toBeNull();
    expect(result!.rag_url).toBe("https://rag.example.com");
    expect(result!.collections).toEqual(["uuid-1"]);
    // extra_field should not be in the result
    expect((result as Record<string, unknown>).extra_field).toBeUndefined();
  });
});

// ===========================================================================
// createRagTool — error handling (no real server)
// ===========================================================================

describe("createRagTool — error handling", () => {
  it("throws when RAG server is unreachable", async () => {
    await expect(
      createRagTool("http://localhost:1", "uuid-1", "fake-token"),
    ).rejects.toThrow("Failed to create RAG tool");
  });

  it("throws with descriptive error message", async () => {
    try {
      await createRagTool("http://localhost:1", "uuid-1", "fake-token");
      // Should not reach here
      expect(true).toBe(false);
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("Failed to create RAG tool");
    }
  });

  it("handles trailing slashes in ragUrl", async () => {
    // Should normalize the URL (strip trailing slashes) before failing
    await expect(
      createRagTool("http://localhost:1///", "uuid-1", "fake-token"),
    ).rejects.toThrow("Failed to create RAG tool");
  });
});

// ===========================================================================
// createRagTools — batch creation and graceful degradation
// ===========================================================================

describe("createRagTools — batch creation", () => {
  it("returns empty array when rag_url is null", async () => {
    const result = await createRagTools(
      { rag_url: null, collections: ["uuid-1"] },
      "fake-token",
    );
    expect(result).toEqual([]);
  });

  it("returns empty array when collections is null", async () => {
    const result = await createRagTools(
      { rag_url: "https://rag.example.com", collections: null },
      "fake-token",
    );
    expect(result).toEqual([]);
  });

  it("returns empty array when collections is empty", async () => {
    const result = await createRagTools(
      { rag_url: "https://rag.example.com", collections: [] },
      "fake-token",
    );
    expect(result).toEqual([]);
  });

  it("returns empty array when both fields are null", async () => {
    const result = await createRagTools(
      { rag_url: null, collections: null },
      "fake-token",
    );
    expect(result).toEqual([]);
  });

  it("gracefully handles unreachable server (returns empty array, no throw)", async () => {
    const result = await createRagTools(
      { rag_url: "http://localhost:1", collections: ["uuid-1", "uuid-2"] },
      "fake-token",
    );
    // Should not throw — failed collections are skipped with warnings
    expect(result).toEqual([]);
  });

  it("does not throw even with multiple failing collections", async () => {
    await expect(
      createRagTools(
        {
          rag_url: "http://localhost:1",
          collections: ["a", "b", "c"],
        },
        "fake-token",
      ),
    ).resolves.toEqual([]);
  });
});

// ===========================================================================
// RagConfig type compliance
// ===========================================================================

describe("RagConfig type", () => {
  it("accepts valid config shape", () => {
    const config: RagConfig = {
      rag_url: "https://rag.example.com",
      collections: ["uuid-1", "uuid-2"],
    };
    expect(config.rag_url).toBe("https://rag.example.com");
    expect(config.collections).toEqual(["uuid-1", "uuid-2"]);
  });

  it("accepts null fields", () => {
    const config: RagConfig = {
      rag_url: null,
      collections: null,
    };
    expect(config.rag_url).toBeNull();
    expect(config.collections).toBeNull();
  });

  it("parseRagConfig output matches RagConfig type", () => {
    const parsed = parseRagConfig({
      rag_url: "https://example.com",
      collections: ["c1"],
    });
    expect(parsed).not.toBeNull();
    // TypeScript type check — if this compiles, the type is correct
    const config: RagConfig = parsed!;
    expect(config.rag_url).toBe("https://example.com");
    expect(config.collections).toEqual(["c1"]);
  });
});
