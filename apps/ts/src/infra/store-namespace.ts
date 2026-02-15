/**
 * Canonical store namespace convention for org-scoped isolation.
 *
 * Every LangGraph Store operation uses a 4-component tuple namespace:
 *
 *     [org_id, user_id, assistant_id, category]
 *
 * This module is the **single source of truth** for namespace construction.
 * All store consumers (token cache, memories, context, preferences) MUST use
 * these helpers instead of hand-crafting namespace tuples.
 *
 * ## Namespace Components
 *
 * - **org_id**: Organization UUID from Supabase (`supabase_organization_id`).
 *   Top-level isolation; Supabase RLS enforces org membership.
 * - **user_id**: User identity from JWT (`owner` in configurable).
 *   Per-user isolation within org.
 * - **assistant_id**: LangGraph assistant ID = Supabase agent UUID.
 *   Per-agent isolation within user.
 * - **category**: Type of stored data (see `CATEGORY_*` constants below).
 *
 * ## Special Namespace Variants
 *
 * - `[org_id, "shared", assistant_id, category]` — org-wide shared data
 * - `[org_id, user_id, "global", category]` — user-global across all agents
 *
 * Reference: apps/python/src/infra/store_namespace.py
 */

// ---------------------------------------------------------------------------
// Standard categories
// ---------------------------------------------------------------------------

/**
 * MCP token cache (per agent). Written and read by runtime.
 */
export const CATEGORY_TOKENS = "tokens";

/**
 * Webapp-provided agent-specific user context. Written by webapp, read by runtime.
 */
export const CATEGORY_CONTEXT = "context";

/**
 * Runtime-learned facts persisted across threads. Written and read by runtime.
 */
export const CATEGORY_MEMORIES = "memories";

/**
 * User preferences for this agent. Written by webapp or runtime, read by runtime.
 */
export const CATEGORY_PREFERENCES = "preferences";

// ---------------------------------------------------------------------------
// Special pseudo-IDs for namespace variants
// ---------------------------------------------------------------------------

/**
 * Pseudo user_id for org-wide shared data (all org members can read).
 */
export const SHARED_USER_ID = "shared";

/**
 * Pseudo assistant_id for user-global data (shared across all agents for a user).
 */
export const GLOBAL_AGENT_ID = "global";

// ---------------------------------------------------------------------------
// Namespace components type
// ---------------------------------------------------------------------------

/**
 * Extracted namespace components from a RunnableConfig.
 *
 * All three components are required for a valid scoped namespace.
 * If any component is missing or empty, `extractNamespaceComponents`
 * returns `null` instead.
 */
export interface NamespaceComponents {
  /** Organization UUID string. */
  readonly orgId: string;

  /** User identity string. */
  readonly userId: string;

  /** Assistant/agent UUID string. */
  readonly assistantId: string;
}

// ---------------------------------------------------------------------------
// Namespace extraction
// ---------------------------------------------------------------------------

/**
 * Extract org_id, user_id, and assistant_id from a configurable dictionary.
 *
 * Reads from the configurable dict:
 * - `supabase_organization_id` → orgId
 * - `owner` → userId
 * - `assistant_id` → assistantId
 *
 * @param configurable - The configurable dictionary from a RunnableConfig.
 *   May be `undefined`, `null`, or a record with optional keys.
 * @returns A `NamespaceComponents` object, or `null` if any required
 *   component is missing or empty. Callers should treat `null` as
 *   "namespace unavailable — skip store operation gracefully".
 *
 * @example
 *   const components = extractNamespaceComponents({
 *     supabase_organization_id: "org-123",
 *     owner: "user-456",
 *     assistant_id: "agent-789",
 *   });
 *   // → { orgId: "org-123", userId: "user-456", assistantId: "agent-789" }
 *
 * @example
 *   const missing = extractNamespaceComponents({ owner: "user-456" });
 *   // → null (org_id and assistant_id are missing)
 */
export function extractNamespaceComponents(
  configurable?: Record<string, unknown> | null,
): NamespaceComponents | null {
  if (!configurable) {
    return null;
  }

  const orgId = configurable.supabase_organization_id;
  const userId = configurable.owner;
  const assistantId = configurable.assistant_id;

  // All three components are required for a valid scoped namespace.
  if (!orgId || typeof orgId !== "string" || orgId.trim().length === 0) {
    return null;
  }

  if (!userId || typeof userId !== "string" || userId.trim().length === 0) {
    return null;
  }

  if (
    !assistantId ||
    typeof assistantId !== "string" ||
    assistantId.trim().length === 0
  ) {
    return null;
  }

  return {
    orgId: orgId.trim(),
    userId: userId.trim(),
    assistantId: assistantId.trim(),
  };
}

// ---------------------------------------------------------------------------
// Namespace builder
// ---------------------------------------------------------------------------

/**
 * Build a canonical 4-component store namespace tuple.
 *
 * @param orgId - Organization UUID string.
 * @param userId - User identity string (or `SHARED_USER_ID` for org-wide).
 * @param assistantId - Assistant UUID string (or `GLOBAL_AGENT_ID` for user-global).
 * @param category - Data category (use `CATEGORY_*` constants).
 * @returns A 4-element array `[orgId, userId, assistantId, category]`.
 * @throws {Error} If any component is empty or whitespace-only.
 *
 * @example
 *   buildNamespace("org-123", "user-456", "agent-789", CATEGORY_TOKENS)
 *   // → ["org-123", "user-456", "agent-789", "tokens"]
 *
 * @example
 *   buildNamespace("org-123", SHARED_USER_ID, "agent-789", CATEGORY_CONTEXT)
 *   // → ["org-123", "shared", "agent-789", "context"]
 */
export function buildNamespace(
  orgId: string,
  userId: string,
  assistantId: string,
  category: string,
): [string, string, string, string] {
  const components: Record<string, string> = {
    orgId,
    userId,
    assistantId,
    category,
  };

  for (const [name, value] of Object.entries(components)) {
    if (!value || value.trim().length === 0) {
      throw new Error(
        `buildNamespace: ${name} must be a non-empty string, got ${JSON.stringify(value)}`,
      );
    }
  }

  return [
    orgId.trim(),
    userId.trim(),
    assistantId.trim(),
    category.trim(),
  ];
}
