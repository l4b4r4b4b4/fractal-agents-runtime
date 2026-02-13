/**
 * Assistant model types for the Fractal Agents Runtime — TypeScript/Bun.
 *
 * Every type here matches the Python runtime's OpenAPI spec field-for-field:
 *   apps/python/openapi-spec.json → components.schemas
 *
 * Type naming convention: PascalCase matching the schema title exactly.
 * Field naming convention: snake_case matching the JSON property names exactly.
 */

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/**
 * Graph ID for assistants.
 *
 * The Python Pydantic model uses `graph_id: str` — any string is accepted.
 * The OpenAPI spec hardcodes `enum: ["agent"]` but that's just documenting
 * what's currently deployed, not a type constraint. Valid graph_ids are
 * determined at runtime by the graph registry.
 *
 * In v0.0.1, the only registered graph is "agent".
 */
export type GraphId = string;

/**
 * Known graph IDs as a readonly array (useful for runtime validation).
 * Updated as new graphs are registered in later goals.
 */
export const KNOWN_GRAPH_IDS: readonly string[] = ["agent"] as const;

/**
 * Strategy for handling duplicate assistant creation.
 *
 * - "raise": Return 409 Conflict if the assistant already exists.
 * - "do_nothing": Return the existing assistant without modification.
 *
 * Matches: components.schemas.AssistantCreate.properties.if_exists.enum
 */
export type IfExistsStrategy = "raise" | "do_nothing";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * Configuration for an assistant's graph execution.
 *
 * Matches: components.schemas.Config
 */
export interface Config {
  /** Tags for categorizing the run. */
  tags?: string[];

  /** Maximum recursion depth for the graph. Default: 25. */
  recursion_limit?: number;

  /** Configurable parameters for the graph. */
  configurable?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Assistant (response model)
// ---------------------------------------------------------------------------

/**
 * An assistant resource as returned by the API.
 *
 * Matches: components.schemas.Assistant
 * Required fields: assistant_id, graph_id, config, created_at, updated_at, metadata
 */
export interface Assistant {
  /** The unique identifier of the assistant (UUID). */
  assistant_id: string;

  /** The ID of the graph the assistant uses (validated by graph registry at runtime). */
  graph_id: string;

  /** Configuration for the assistant. */
  config: Config;

  /** Static context added to the assistant. */
  context?: Record<string, unknown>;

  /** The time the assistant was created (ISO 8601 date-time). */
  created_at: string;

  /** The last time the assistant was updated (ISO 8601 date-time). */
  updated_at: string;

  /** Custom metadata for the assistant. */
  metadata: Record<string, unknown>;

  /** The version number of the assistant. */
  version?: number;

  /** The name of the assistant. */
  name?: string;

  /** A description of the assistant. Nullable. */
  description?: string | null;
}

// ---------------------------------------------------------------------------
// AssistantCreate (request model)
// ---------------------------------------------------------------------------

/**
 * Payload for creating an assistant.
 *
 * Matches: components.schemas.AssistantCreate
 * Required fields: graph_id
 */
export interface AssistantCreate {
  /**
   * The ID of the assistant. If not provided, a random UUID will be generated.
   * Format: UUID.
   */
  assistant_id?: string;

  /** The ID of the graph the assistant should use. Required. */
  graph_id: string;

  /** Configuration to use for the graph. */
  config?: Record<string, unknown>;

  /** Static context added to the assistant. */
  context?: Record<string, unknown>;

  /** Metadata to add to assistant. */
  metadata?: Record<string, unknown>;

  /**
   * How to handle duplicate creation.
   * - "raise": raises error (409 Conflict)
   * - "do_nothing": returns existing assistant
   *
   * Default: "raise"
   */
  if_exists?: IfExistsStrategy;

  /** The name of the assistant. */
  name?: string;

  /** The description of the assistant. Nullable. */
  description?: string | null;
}

// ---------------------------------------------------------------------------
// AssistantPatch (request model)
// ---------------------------------------------------------------------------

/**
 * Payload for updating an assistant (partial update).
 *
 * Matches: components.schemas.AssistantPatch
 * All fields are optional.
 */
export interface AssistantPatch {
  /** The ID of the graph the assistant should use. */
  graph_id?: string;

  /** Configuration to use for the graph. */
  config?: Record<string, unknown>;

  /** Static context added to the assistant. */
  context?: Record<string, unknown>;

  /** Metadata to merge with existing assistant metadata. */
  metadata?: Record<string, unknown>;

  /** The new name for the assistant. */
  name?: string;

  /** The new description for the assistant. */
  description?: string;
}

// ---------------------------------------------------------------------------
// AssistantSearchRequest (request model)
// ---------------------------------------------------------------------------

/**
 * Request body for searching assistants.
 *
 * Matches: components.schemas.AssistantSearchRequest
 * All fields are optional.
 */
export interface AssistantSearchRequest {
  /** Filter by metadata key-value pairs. */
  metadata?: Record<string, unknown>;

  /** Filter by graph ID. */
  graph_id?: string;

  /** Filter by name (partial match). */
  name?: string;

  /**
   * Maximum number of results to return.
   * Default: 10. Minimum: 1. Maximum: 1000.
   */
  limit?: number;

  /**
   * Number of results to skip.
   * Default: 0. Minimum: 0.
   */
  offset?: number;

  /** Field to sort by (e.g., "created_at", "updated_at", "name"). */
  sort_by?: string;

  /** Sort order: "asc" or "desc". */
  sort_order?: "asc" | "desc";
}

// ---------------------------------------------------------------------------
// AssistantCountRequest (request model)
// ---------------------------------------------------------------------------

/**
 * Request body for counting assistants.
 *
 * Matches: components.schemas.AssistantCountRequest
 * All fields are optional.
 */
export interface AssistantCountRequest {
  /** Filter by metadata key-value pairs. */
  metadata?: Record<string, unknown>;

  /** Filter by graph ID. */
  graph_id?: string;

  /** Filter by name (partial match). */
  name?: string;
}
