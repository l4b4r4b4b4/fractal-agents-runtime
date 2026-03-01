/**
 * SQL query builders and database fetch functions for Agent Sync.
 *
 * Provides:
 *   - Row parsing helpers: `coerceUuid()`, `toBoolOrNull()`, `agentFromRow()`,
 *     `addMcpToolFromRow()`, `groupAgentRows()`
 *   - SQL builder: `buildFetchAgentsSql()` → SQL + params
 *   - Fetch functions: `fetchActiveAgents()`, `fetchActiveAgentById()`
 *
 * All SQL targets Supabase's `public` schema (agents, agent_mcp_tools,
 * mcp_tools, global_ai_engines, ai_models).
 *
 * Uses Postgres.js (`sql.unsafe()`) with positional parameters ($1, $2, ...)
 * instead of Python's psycopg named parameters (%(key)s).
 *
 * Reference: apps/python/src/server/agent_sync.py
 */

import type { Sql } from "postgres";
import type { AgentSyncScope, AgentSyncData, AgentSyncMcpTool } from "./types";

// ---------------------------------------------------------------------------
// UUID validation
// ---------------------------------------------------------------------------

/**
 * Regex for validating UUID format.
 *
 * Accepts standard 8-4-4-4-12 hex format (case-insensitive).
 */
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Coercion helpers
// ---------------------------------------------------------------------------

/**
 * Best-effort conversion from DB-returned values to a UUID string.
 *
 * Supabase/Postgres drivers may return UUIDs as strings or objects.
 * Returns `null` for `null`, `undefined`, or invalid values.
 *
 * @param value - The value to coerce.
 * @returns A valid UUID string, or `null`.
 */
export function coerceUuid(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "string") {
    return UUID_REGEX.test(value.trim()) ? value.trim() : null;
  }

  // Attempt toString() for objects that stringify to UUID format
  if (typeof value === "object" && value !== null) {
    try {
      const stringified = String(value);
      return UUID_REGEX.test(stringified) ? stringified : null;
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Convert a DB value to `boolean | null`.
 *
 * Handles booleans, integers (0/1), and string representations
 * ("true"/"false"/"t"/"f"/"yes"/"no"/"y"/"n"/"1"/"0").
 *
 * @param value - The value to convert.
 * @returns `true`, `false`, or `null` if unrecognized.
 */
export function toBoolOrNull(value: unknown): boolean | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return Boolean(value);
  }

  if (typeof value === "string") {
    const lowered = value.trim().toLowerCase();
    if (["true", "t", "1", "yes", "y"].includes(lowered)) {
      return true;
    }
    if (["false", "f", "0", "no", "n"].includes(lowered)) {
      return false;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Row parsing
// ---------------------------------------------------------------------------

/**
 * Append an MCP tool derived from a JOIN row to an agent, if present.
 *
 * When the LEFT JOIN produces nulls for all tool columns, this is a no-op.
 *
 * @param agent - The agent to append the tool to.
 * @param row - A database row (dict) from the agents+tools JOIN query.
 */
export function addMcpToolFromRow(
  agent: AgentSyncData,
  row: Record<string, unknown>,
): void {
  const toolId = coerceUuid(row.mcp_tool_id);
  const toolName = row.mcp_tool_name;
  const endpointUrl = row.mcp_endpoint_url;
  const isBuiltin = toBoolOrNull(row.mcp_is_builtin);
  const authRequired = toBoolOrNull(row.mcp_auth_required);

  // If the LEFT JOIN produced nulls for the tool, skip
  if (toolId === null && toolName == null && endpointUrl == null) {
    return;
  }

  const tool: AgentSyncMcpTool = {
    toolId,
    toolName: toolName != null ? String(toolName) : null,
    endpointUrl: endpointUrl != null ? String(endpointUrl) : null,
    isBuiltin,
    authRequired,
  };

  agent.mcpTools.push(tool);
}

/**
 * Create an {@link AgentSyncData} from a single DB row (one tool join).
 *
 * The row must contain `agent_id` (or `id`) as a valid UUID. All other
 * fields are optional and will be coerced to the correct types.
 *
 * @param row - A database row (dict) from the agents+tools JOIN query.
 * @returns An AgentSyncData with the first MCP tool (if present) appended.
 * @throws Error if the row is missing `agent_id` / `id`.
 */
export function agentFromRow(row: Record<string, unknown>): AgentSyncData {
  const agentId = coerceUuid(row.agent_id ?? row.id);
  if (agentId === null) {
    throw new Error("Agent query row missing agent_id/id");
  }

  const organizationId = coerceUuid(row.organization_id);

  // Temperature: coerce to number or null
  let temperature: number | null = null;
  if (row.temperature !== null && row.temperature !== undefined) {
    temperature = Number(row.temperature);
    if (Number.isNaN(temperature)) {
      temperature = null;
    }
  }

  // Max tokens: coerce to integer or null
  let maxTokens: number | null = null;
  if (row.max_tokens !== null && row.max_tokens !== undefined) {
    maxTokens = Math.trunc(Number(row.max_tokens));
    if (Number.isNaN(maxTokens)) {
      maxTokens = null;
    }
  }

  const runtimeModelName =
    row.runtime_model_name != null ? String(row.runtime_model_name) : null;

  const agent: AgentSyncData = {
    agentId,
    organizationId,
    name: row.name != null ? String(row.name) : null,
    systemPrompt: row.system_prompt != null ? String(row.system_prompt) : null,
    temperature,
    maxTokens,
    runtimeModelName,
    graphId: row.graph_id != null ? String(row.graph_id) : null,
    langgraphAssistantId:
      row.langgraph_assistant_id != null
        ? String(row.langgraph_assistant_id)
        : null,
    mcpTools: [],
  };

  addMcpToolFromRow(agent, row);
  return agent;
}

/**
 * Group query rows into a per-agent list.
 *
 * The SQL uses LEFT JOINs to bring in MCP tool assignments, producing
 * 0..N rows per agent. This function collapses those into one
 * {@link AgentSyncData} per agent with `mcpTools` aggregated.
 *
 * Results are sorted by (organizationId, name, agentId) for stability.
 *
 * @param rows - Raw database rows from the JOIN query.
 * @returns Deduplicated, sorted list of AgentSyncData.
 */
export function groupAgentRows(
  rows: Record<string, unknown>[],
): AgentSyncData[] {
  const agentsById = new Map<string, AgentSyncData>();

  for (const row of rows) {
    const agentId = coerceUuid(row.agent_id ?? row.id);
    if (agentId === null) {
      continue;
    }

    if (!agentsById.has(agentId)) {
      try {
        agentsById.set(agentId, agentFromRow(row));
      } catch {
        // Skip rows that can't be parsed
        continue;
      }
    } else {
      addMcpToolFromRow(agentsById.get(agentId)!, row);
    }
  }

  // Stable ordering: organizationId, name (lowercase), agentId
  return [...agentsById.values()].sort((a, b) => {
    const orgCompare = (a.organizationId ?? "").localeCompare(
      b.organizationId ?? "",
    );
    if (orgCompare !== 0) return orgCompare;

    const nameCompare = (a.name ?? "")
      .toLowerCase()
      .localeCompare((b.name ?? "").toLowerCase());
    if (nameCompare !== 0) return nameCompare;

    return a.agentId.localeCompare(b.agentId);
  });
}

// ---------------------------------------------------------------------------
// SQL query builders
// ---------------------------------------------------------------------------

/**
 * The base SELECT for fetching agents with their MCP tools.
 *
 * Joins across:
 *   - `public.agents` (a)
 *   - `public.agent_mcp_tools` (amt)
 *   - `public.mcp_tools` (mt)
 *   - `public.global_ai_engines` (gae)
 *   - `public.ai_models` (am)
 *
 * Produces N rows per agent (one per MCP tool, via LEFT JOIN).
 */
const BASE_SELECT = `
SELECT
  a.id AS agent_id,
  a.organization_id,
  a.name,
  a.system_prompt,
  a.temperature,
  a.max_tokens,
  a.langgraph_assistant_id,
  a.graph_id,
  mt.id AS mcp_tool_id,
  mt.endpoint_url AS mcp_endpoint_url,
  mt.tool_name AS mcp_tool_name,
  mt.is_builtin AS mcp_is_builtin,
  mt.auth_required AS mcp_auth_required,
  COALESCE(am.runtime_model_name, 'openai:gpt-4o') AS runtime_model_name
FROM public.agents a
LEFT JOIN public.agent_mcp_tools amt ON amt.agent_id = a.id
LEFT JOIN public.mcp_tools mt ON mt.id = amt.mcp_tool_id
LEFT JOIN public.global_ai_engines gae ON gae.id = a.engine_id
LEFT JOIN public.ai_models am ON am.id = gae.language_model_id
`.trim();

/**
 * Build SQL and positional parameters for fetching active agents.
 *
 * @param scope - The parsed agent sync scope.
 * @returns Tuple of [sqlString, params[]] for use with `sql.unsafe()`.
 * @throws Error if scope type is "none" (callers should skip sync).
 */
export function buildFetchAgentsSql(
  scope: AgentSyncScope,
): [string, unknown[]] {
  if (scope.type === "none") {
    throw new Error("buildFetchAgentsSql called with scope=none");
  }

  const params: unknown[] = [];
  let scopeFilter = "";

  if (scope.type === "org") {
    scopeFilter = `AND a.organization_id = ANY($1::uuid[])`;
    params.push(scope.organizationIds);
  }

  const query = `
${BASE_SELECT}
WHERE a.status = 'active'
  AND a.deleted_at IS NULL
  ${scopeFilter}
ORDER BY a.organization_id, a.name
`.trim();

  return [query, params];
}

// ---------------------------------------------------------------------------
// Database fetch functions
// ---------------------------------------------------------------------------

/**
 * Normalize raw database rows into `Record<string, unknown>[]`.
 *
 * Postgres.js returns rows as objects by default. This function handles
 * edge cases where rows might not be plain objects.
 *
 * @param rows - Raw rows from a database query.
 * @returns Normalized array of row objects.
 */
function normalizeRows(rows: unknown[]): Record<string, unknown>[] {
  const normalized: Record<string, unknown>[] = [];

  for (const row of rows) {
    if (row !== null && typeof row === "object" && !Array.isArray(row)) {
      normalized.push(row as Record<string, unknown>);
    } else {
      // Attempt best-effort conversion
      try {
        normalized.push(Object(row) as Record<string, unknown>);
      } catch {
        // Skip unconvertible rows
        continue;
      }
    }
  }

  return normalized;
}

/**
 * Fetch active agents from Supabase/Postgres for sync.
 *
 * @param sql - Postgres.js SQL client (from `getConnection()`).
 * @param scope - Parsed scope determining which agents to return.
 * @returns List of AgentSyncData records aggregated by agent id.
 * @throws Error if scope type is "none" or if a DB error occurs.
 */
export async function fetchActiveAgents(
  sql: Sql,
  scope: AgentSyncScope,
): Promise<AgentSyncData[]> {
  if (scope.type === "none") {
    throw new Error("fetchActiveAgents called with scope=none");
  }

  const [query, params] = buildFetchAgentsSql(scope);
  const rows = await sql.unsafe(query, params as any[]);

  if (!rows || rows.length === 0) {
    return [];
  }

  const normalizedRows = normalizeRows(rows as unknown[]);
  return groupAgentRows(normalizedRows);
}

/**
 * Fetch a single active agent by id (includes MCP tools).
 *
 * @param sql - Postgres.js SQL client.
 * @param agentId - Agent UUID string.
 * @returns AgentSyncData if found and active, `null` otherwise.
 */
export async function fetchActiveAgentById(
  sql: Sql,
  agentId: string,
): Promise<AgentSyncData | null> {
  const query = `
${BASE_SELECT}
WHERE a.id = $1
  AND a.status = 'active'
  AND a.deleted_at IS NULL
ORDER BY a.organization_id, a.name
`.trim();

  const rows = await sql.unsafe(query, [agentId]);

  if (!rows || rows.length === 0) {
    return null;
  }

  const normalizedRows = normalizeRows(rows as unknown[]);
  const agents = groupAgentRows(normalizedRows);

  if (agents.length === 0) {
    return null;
  }

  return agents[0];
}
