/**
 * Data types for the Agent Sync module.
 *
 * These types represent agent configuration from Supabase/Postgres and
 * the outcome of syncing agents into the LangGraph assistant storage.
 *
 * Mirrors Python's `agent_sync.py` data models (Pydantic → TS interfaces).
 *
 * Reference: apps/python/src/server/agent_sync.py
 */

// ---------------------------------------------------------------------------
// MCP Tool
// ---------------------------------------------------------------------------

/**
 * MCP tool metadata assigned to an agent.
 *
 * Represents a single tool from the `public.mcp_tools` table joined
 * via `public.agent_mcp_tools`.
 */
export interface AgentSyncMcpTool {
  /** MCP tool UUID (if available from query). */
  toolId: string | null;

  /** Human-readable tool name. */
  toolName: string | null;

  /** Base URL for the MCP server. */
  endpointUrl: string | null;

  /** Whether the tool is a built-in tool (vs remote MCP). */
  isBuiltin: boolean | null;

  /** Whether the MCP server requires auth. */
  authRequired: boolean | null;
}

// ---------------------------------------------------------------------------
// Agent Data
// ---------------------------------------------------------------------------

/**
 * Agent configuration materialised from Supabase for sync into assistant storage.
 *
 * This is the canonical shape used downstream to build a LangGraph assistant
 * config (`config.configurable`) for the graph factory.
 */
export interface AgentSyncData {
  /** UUID of the agent in Supabase. */
  agentId: string;

  /** Organization UUID owning the agent. */
  organizationId: string | null;

  /** Display name. */
  name: string | null;

  /** System prompt text. */
  systemPrompt: string | null;

  /** LLM temperature. */
  temperature: number | null;

  /** Max tokens for response. */
  maxTokens: number | null;

  /** Fully qualified provider model, e.g. "openai:gpt-4o". */
  runtimeModelName: string | null;

  /** LangGraph graph id to run (typically "agent"). */
  graphId: string | null;

  /** Existing assistant id stored in Supabase (if any). */
  langgraphAssistantId: string | null;

  /** List of MCP tools assigned to the agent. */
  mcpTools: AgentSyncMcpTool[];
}

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

/**
 * Scope type for agent sync.
 *
 * - "none": no startup sync (lazy only)
 * - "all": sync all active agents
 * - "org": sync active agents for listed organization_ids
 */
export type AgentSyncScopeType = "none" | "all" | "org";

/**
 * Parsed representation of `AGENT_SYNC_SCOPE`.
 *
 * Used to express query intent when fetching agents from Supabase.
 */
export interface AgentSyncScope {
  /** The scope type. */
  type: AgentSyncScopeType;

  /** Organization UUIDs to filter by (only used when type === "org"). */
  organizationIds: string[];
}

// ---------------------------------------------------------------------------
// Scope factory functions
// ---------------------------------------------------------------------------

/**
 * Create a scope that disables startup sync.
 *
 * @returns AgentSyncScope with type "none".
 */
export function scopeNone(): AgentSyncScope {
  return { type: "none", organizationIds: [] };
}

/**
 * Create a scope that syncs all active agents.
 *
 * @returns AgentSyncScope with type "all".
 */
export function scopeAll(): AgentSyncScope {
  return { type: "all", organizationIds: [] };
}

/**
 * Create a scope that syncs agents for the specified organizations.
 *
 * Deduplicates organization IDs while preserving insertion order.
 *
 * @param organizationIds - Organization UUIDs to sync.
 * @returns AgentSyncScope with type "org".
 */
export function scopeOrgs(organizationIds: string[]): AgentSyncScope {
  // Deduplicate while preserving order (like Python's dict.fromkeys)
  const uniqueIds = [...new Map(organizationIds.map((id) => [id, id])).values()];
  return { type: "org", organizationIds: uniqueIds };
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/** Action taken when syncing a single agent. */
export type AgentSyncAction = "created" | "updated" | "skipped";

/**
 * Outcome of syncing a single agent.
 *
 * Returned by `syncSingleAgent()` to describe what happened.
 */
export interface AgentSyncResult {
  /** The assistant ID (same as the Supabase agent UUID string). */
  assistantId: string;

  /** What action was taken. */
  action: AgentSyncAction;

  /** Whether the langgraph_assistant_id was written back to Supabase. */
  wroteBackAssistantId: boolean;
}

// ---------------------------------------------------------------------------
// Startup sync summary
// ---------------------------------------------------------------------------

/**
 * Summary counters from `startupAgentSync()`.
 */
export interface AgentSyncSummary {
  total: number;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
}
