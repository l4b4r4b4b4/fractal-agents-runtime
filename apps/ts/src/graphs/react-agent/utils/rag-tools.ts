/**
 * RAG (Retrieval-Augmented Generation) tool factory — TypeScript/Bun.
 *
 * Creates LangChain tools that query a Supabase-hosted RAG API for
 * semantically similar documents in named collections. Each collection
 * gets its own tool with a sanitized name and description fetched from
 * the RAG server.
 *
 * Features:
 *   - Per-collection tool creation with metadata-driven descriptions
 *   - Name sanitization to match LangChain tool name requirements
 *   - Bearer token authentication via Supabase access token
 *   - XML-formatted document results (matching Python output)
 *   - Graceful error handling (returns error XML, never throws)
 *
 * Port of: apps/python/src/graphs/react_agent/utils/tools.py
 *
 * Usage:
 *
 *   import { createRagTool, createRagTools } from "./utils/rag-tools";
 *
 *   const tool = await createRagTool(ragUrl, collectionId, accessToken);
 *   // tool is a DynamicStructuredTool ready for createAgent({ tools: [tool] })
 *
 *   // Or create tools for all collections at once:
 *   const tools = await createRagTools(ragConfig, accessToken);
 */

import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum length for a sanitized tool name. */
const MAX_TOOL_NAME_LENGTH = 64;

/** Default number of documents to retrieve per search query. */
const DEFAULT_SEARCH_LIMIT = 10;

/** Regex to strip characters not allowed in LangChain tool names. */
const TOOL_NAME_SANITIZE_PATTERN = /[^a-zA-Z0-9_-]/g;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * RAG configuration — mirrors Python's `RagConfig(BaseModel)`.
 *
 * When present in the assistant's configurable dict, the agent creates
 * RAG tools for each collection.
 */
export interface RagConfig {
  /** Base URL of the RAG API server (e.g., "https://rag.example.com"). */
  rag_url: string | null;

  /** List of collection UUIDs to create tools for. */
  collections: string[] | null;
}

/**
 * Shape of a collection metadata response from the RAG API.
 */
interface CollectionMetadata {
  name?: string;
  metadata?: {
    description?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * Shape of a single document returned by the RAG search endpoint.
 */
interface RagDocument {
  id?: string;
  page_content?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Sanitize a raw collection name for use as a LangChain tool name.
 *
 * Replaces disallowed characters with underscores, truncates to
 * `MAX_TOOL_NAME_LENGTH`, and provides a fallback if the result is empty.
 *
 * Matches the Python implementation exactly:
 *   `re.sub(r"[^a-zA-Z0-9_-]", "_", raw_collection_name)[:64]`
 *
 * @param rawName - The raw collection name from the RAG API.
 * @param collectionId - Fallback identifier if the name sanitizes to empty.
 * @returns A safe tool name string.
 */
export function sanitizeToolName(
  rawName: string,
  collectionId: string,
): string {
  const sanitized = rawName.replace(TOOL_NAME_SANITIZE_PATTERN, "_");

  if (!sanitized || sanitized.length === 0) {
    return `collection_${collectionId}`.slice(0, MAX_TOOL_NAME_LENGTH);
  }

  return sanitized.slice(0, MAX_TOOL_NAME_LENGTH);
}

/**
 * Build the tool description from the collection's metadata.
 *
 * If the collection has a description in its metadata, it is appended
 * to the base description. Otherwise, only the base description is used.
 *
 * Matches the Python implementation exactly.
 *
 * @param rawDescription - The description from collection metadata (may be null/undefined).
 * @returns The full tool description string.
 */
export function buildToolDescription(
  rawDescription: string | null | undefined,
): string {
  const baseDescription =
    "Search your collection of documents for results" +
    " semantically similar to the input query";

  if (!rawDescription || rawDescription.length === 0) {
    return baseDescription;
  }

  return `${baseDescription}. Collection description: ${rawDescription}`;
}

/**
 * Format an array of RAG documents into the XML-like output format.
 *
 * Matches the Python implementation's `<all-documents>` format exactly.
 *
 * @param documents - Array of document objects from the RAG search API.
 * @returns Formatted string with XML-like document wrappers.
 */
export function formatDocuments(documents: RagDocument[]): string {
  let formatted = "<all-documents>\n";

  for (const document of documents) {
    const documentId = document.id ?? "unknown";
    const content = document.page_content ?? "";
    formatted += `  <document id="${documentId}">\n    ${content}\n  </document>\n`;
  }

  formatted += "</all-documents>";
  return formatted;
}

/**
 * Format an error as the XML-like error output.
 *
 * @param error - The error to format.
 * @returns Error string wrapped in the `<all-documents>` XML format.
 */
function formatError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `<all-documents>\n  <error>${message}</error>\n</all-documents>`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a RAG tool for a specific collection.
 *
 * Fetches collection metadata from the RAG API to determine the tool's
 * name and description, then returns a `DynamicStructuredTool` that
 * searches the collection for semantically similar documents.
 *
 * Port of: `apps/python/src/graphs/react_agent/utils/tools.py → create_rag_tool()`
 *
 * @param ragUrl - The base URL for the RAG API server.
 * @param collectionId - The UUID of the collection to query.
 * @param accessToken - The Supabase access token for authentication.
 * @returns A DynamicStructuredTool that searches the collection.
 * @throws {Error} If the collection metadata cannot be fetched.
 *
 * @example
 *   const tool = await createRagTool(
 *     "https://rag.example.com",
 *     "550e8400-e29b-41d4-a716-446655440000",
 *     "eyJhbGciOiJI...",
 *   );
 *   const result = await tool.invoke({ query: "quarterly revenue" });
 */
export async function createRagTool(
  ragUrl: string,
  collectionId: string,
  accessToken: string,
): Promise<DynamicStructuredTool> {
  const baseUrl = ragUrl.replace(/\/+$/, "");
  const collectionEndpoint = `${baseUrl}/collections/${collectionId}`;

  // Fetch collection metadata to get name and description.
  let collectionData: CollectionMetadata;
  try {
    const response = await fetch(collectionEndpoint, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status}: ${response.statusText}`,
      );
    }

    collectionData = (await response.json()) as CollectionMetadata;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to create RAG tool: ${message}`);
  }

  // Derive tool name from collection metadata.
  const rawCollectionName =
    collectionData.name ?? `collection_${collectionId}`;
  const collectionName = sanitizeToolName(rawCollectionName, collectionId);

  // Derive tool description from collection metadata.
  const rawDescription = collectionData.metadata?.description ?? null;
  const collectionDescription = buildToolDescription(
    typeof rawDescription === "string" ? rawDescription : null,
  );

  // Build the search tool.
  const searchEndpoint = `${baseUrl}/collections/${collectionId}/documents/search`;

  return new DynamicStructuredTool({
    name: collectionName,
    description: collectionDescription,
    schema: z.object({
      query: z
        .string()
        .describe("The search query to find relevant documents"),
    }),
    func: async ({ query }: { query: string }): Promise<string> => {
      try {
        const searchResponse = await fetch(searchEndpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({
            query,
            limit: DEFAULT_SEARCH_LIMIT,
          }),
        });

        if (!searchResponse.ok) {
          throw new Error(
            `HTTP ${searchResponse.status}: ${searchResponse.statusText}`,
          );
        }

        const documents = (await searchResponse.json()) as RagDocument[];
        return formatDocuments(documents);
      } catch (error: unknown) {
        return formatError(error);
      }
    },
  });
}

/**
 * Create RAG tools for all collections in a RAG configuration.
 *
 * Convenience wrapper around `createRagTool()` that creates tools for
 * every collection in the config. Failures for individual collections
 * are logged as warnings and skipped (non-fatal).
 *
 * @param ragConfig - The RAG configuration with URL and collection IDs.
 * @param accessToken - The Supabase access token for authentication.
 * @returns Array of DynamicStructuredTool instances (one per successful collection).
 *
 * @example
 *   const tools = await createRagTools(
 *     { rag_url: "https://rag.example.com", collections: ["uuid-1", "uuid-2"] },
 *     "eyJhbGciOiJI...",
 *   );
 */
export async function createRagTools(
  ragConfig: RagConfig,
  accessToken: string,
): Promise<DynamicStructuredTool[]> {
  if (
    !ragConfig.rag_url ||
    !ragConfig.collections ||
    ragConfig.collections.length === 0
  ) {
    return [];
  }

  const tools: DynamicStructuredTool[] = [];

  for (const collectionId of ragConfig.collections) {
    try {
      const tool = await createRagTool(
        ragConfig.rag_url,
        collectionId,
        accessToken,
      );
      tools.push(tool);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `[rag] Failed to create RAG tool for collection '${collectionId}': ${message}`,
      );
    }
  }

  return tools;
}

/**
 * Parse a RAG config from the assistant's configurable dictionary.
 *
 * Accepts either a full `RagConfig` object or raw fields, and normalizes
 * them into a typed `RagConfig`. Returns `null` if the config is missing,
 * empty, or invalid.
 *
 * @param value - The raw `rag` value from the configurable dict.
 * @returns Parsed `RagConfig` or `null` if not configured.
 */
export function parseRagConfig(value: unknown): RagConfig | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value !== "object") {
    return null;
  }

  const candidate = value as Record<string, unknown>;

  const ragUrl =
    typeof candidate.rag_url === "string" && candidate.rag_url.length > 0
      ? candidate.rag_url
      : null;

  const collections = Array.isArray(candidate.collections)
    ? (candidate.collections as unknown[]).filter(
        (item): item is string => typeof item === "string" && item.length > 0,
      )
    : null;

  // Return null if neither URL nor collections are provided.
  if (!ragUrl && (!collections || collections.length === 0)) {
    return null;
  }

  return {
    rag_url: ragUrl,
    collections: collections && collections.length > 0 ? collections : null,
  };
}
