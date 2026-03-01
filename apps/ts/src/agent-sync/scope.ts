/**
 * Agent sync scope parsing.
 *
 * Parses the `AGENT_SYNC_SCOPE` environment variable into a structured
 * {@link AgentSyncScope} object that determines which agents to sync
 * at startup.
 *
 * Supported formats:
 *   - `"none"` (default) → no startup sync
 *   - `"all"` → sync all active agents
 *   - `"org:<uuid>"` → sync agents for a single organization
 *   - `"org:<uuid>,org:<uuid>"` → sync agents for multiple organizations
 *
 * Reference: apps/python/src/server/agent_sync.py → parse_agent_sync_scope()
 */

import type { AgentSyncScope } from "./types";
import { scopeNone, scopeAll, scopeOrgs } from "./types";

// ---------------------------------------------------------------------------
// UUID validation
// ---------------------------------------------------------------------------

/**
 * Regex for validating UUID v4 (or any standard UUID format).
 *
 * Accepts both lowercase and uppercase hex digits.
 * Format: 8-4-4-4-12 hex characters.
 */
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validate whether a string is a valid UUID.
 *
 * @param value - The string to validate.
 * @returns `true` if the string matches UUID format.
 */
export function isValidUuid(value: string): boolean {
  return UUID_REGEX.test(value.trim());
}

// ---------------------------------------------------------------------------
// Scope parsing
// ---------------------------------------------------------------------------

/**
 * Parse `AGENT_SYNC_SCOPE` into a structured scope.
 *
 * The env var defines which agents to sync at startup:
 *
 * - `"none"` (default when undefined/empty) → no startup sync
 * - `"all"` → all active agents
 * - `"org:<uuid>"` → a single organization
 * - `"org:<uuid>,org:<uuid>"` → multiple organizations
 *
 * @param rawScope - Raw env var value (may be undefined/null/empty).
 * @returns Parsed AgentSyncScope.
 * @throws Error if the scope string is malformed or contains non-UUID org ids.
 *
 * @example
 * ```
 * parseAgentSyncScope(undefined)     // { type: "none", organizationIds: [] }
 * parseAgentSyncScope("all")         // { type: "all", organizationIds: [] }
 * parseAgentSyncScope("org:abc-...")  // { type: "org", organizationIds: ["abc-..."] }
 * ```
 */
export function parseAgentSyncScope(
  rawScope: string | undefined | null,
): AgentSyncScope {
  const normalized = (rawScope ?? "none").trim();

  // Empty or "none" → no sync
  if (!normalized || normalized.toLowerCase() === "none") {
    return scopeNone();
  }

  // "all" → sync everything
  if (normalized.toLowerCase() === "all") {
    return scopeAll();
  }

  // Parse comma-separated "org:<uuid>" entries
  const parts = normalized
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  const organizationIds: string[] = [];

  for (const part of parts) {
    if (!part.toLowerCase().startsWith("org:")) {
      throw new Error(
        `Invalid AGENT_SYNC_SCOPE entry: '${part}'. Expected 'org:<uuid>'.`,
      );
    }

    const organizationIdText = part.slice(4).trim(); // Remove "org:" prefix

    if (!isValidUuid(organizationIdText)) {
      throw new Error(
        `Invalid organization UUID in AGENT_SYNC_SCOPE: '${organizationIdText}'`,
      );
    }

    organizationIds.push(organizationIdText);
  }

  // If all entries were invalid or empty after parsing, fall back to none
  if (organizationIds.length === 0) {
    return scopeNone();
  }

  return scopeOrgs(organizationIds);
}
