/**
 * Core sync orchestration for Agent Sync.
 *
 * Provides:
 *   - `writeBackLanggraphAssistantId()` — Write assistant ID back to Supabase
 *   - `syncSingleAgent()` — Create or update a single assistant from agent config
 *   - `startupAgentSync()` — Bulk sync at startup for configured scope
 *   - `lazySyncAgent()` — On-demand sync with cache TTL
 *
 * Design goals:
 *   - Idempotent: safe to run at startup and on-demand.
 *   - Non-sensitive logging: never logs secrets or tokenised URLs.
 *   - Deterministic assistant IDs: assistant_id === Supabase agent UUID string.
 *   - Non-fatal: individual agent failures don't abort bulk sync.
 *
 * Reference: apps/python/src/server/agent_sync.py
 */

import type { Sql } from "postgres";
import type {
  AgentSyncData,
  AgentSyncResult,
  AgentSyncScope,
  AgentSyncSummary,
} from "./types";
import type { AssistantStore } from "../storage/types";
import {
  assistantPayloadForAgent,
  extractAssistantConfigurable,
} from "./config-mapping";
import { fetchActiveAgents, fetchActiveAgentById } from "./queries";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default cache TTL for lazy sync (5 minutes), in milliseconds.
 *
 * If an assistant was synced within this window, `lazySyncAgent()` skips
 * re-fetching from the database.
 */
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Write-back
// ---------------------------------------------------------------------------

/**
 * Write back `langgraph_assistant_id` to `public.agents` when needed.
 *
 * This is best-effort: if the column/table isn't available or the update
 * fails, we return `false` and let callers continue.
 *
 * The UPDATE only fires when the stored value differs from the desired
 * one (`IS DISTINCT FROM`), so repeated calls are no-ops.
 *
 * @param sql - Postgres.js SQL client.
 * @param agentId - The Supabase agent UUID.
 * @param assistantId - The LangGraph assistant ID to write back.
 * @returns `true` if a row was actually updated, `false` otherwise.
 */
export async function writeBackLanggraphAssistantId(
  sql: Sql,
  agentId: string,
  assistantId: string,
): Promise<boolean> {
  const query = `
UPDATE public.agents
SET langgraph_assistant_id = $1
WHERE id = $2
  AND (langgraph_assistant_id IS DISTINCT FROM $1)
`.trim();

  try {
    const result = await sql.unsafe(query, [assistantId, agentId]);
    // Postgres.js returns the result set; .count holds the number of affected rows
    const rowCount =
      typeof (result as any).count === "number"
        ? (result as any).count
        : result.length;
    return rowCount > 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Single agent sync
// ---------------------------------------------------------------------------

/**
 * Minimal storage protocol required for sync.
 *
 * Intentionally avoids importing the full Storage type to prevent circular
 * dependencies and keep `agent_sync` independently testable.
 *
 * Implementations should match the `AssistantStore` interface from
 * `../storage/types.ts`.
 */
export interface AgentSyncStorage {
  assistants: {
    get(assistantId: string, ownerId?: string): Promise<unknown>;
    create(payload: Record<string, unknown>, ownerId?: string): Promise<unknown>;
    update(
      assistantId: string,
      payload: Record<string, unknown>,
      ownerId?: string,
    ): Promise<unknown>;
  };
}

/**
 * Create or update the LangGraph assistant for a single Supabase agent.
 *
 * Logic:
 *   1. Build the desired assistant payload from agent config.
 *   2. Check if an assistant with the same ID already exists.
 *   3. If not found → create it.
 *   4. If found → compare `config.configurable`. Skip if unchanged, update if different.
 *   5. Optionally write back the `langgraph_assistant_id` to Supabase.
 *
 * @param sql - Postgres.js SQL client.
 * @param storage - Assistant storage implementation.
 * @param agent - AgentSyncData from `fetchActiveAgents()` / `fetchActiveAgentById()`.
 * @param ownerId - Owner ID for assistant storage operations.
 * @param writeBack - If `true`, attempts to update `public.agents.langgraph_assistant_id`.
 * @returns AgentSyncResult describing what happened.
 * @throws Error if storage operations fail (callers can catch and aggregate).
 */
export async function syncSingleAgent(
  sql: Sql,
  storage: AgentSyncStorage,
  agent: AgentSyncData,
  ownerId: string,
  writeBack: boolean = true,
): Promise<AgentSyncResult> {
  const assistantId = agent.agentId;
  const payload = assistantPayloadForAgent(agent);

  const existingAssistant = await storage.assistants.get(assistantId, ownerId);

  if (existingAssistant === null || existingAssistant === undefined) {
    // Create new assistant
    await storage.assistants.create(payload, ownerId);

    let wroteBack = false;
    if (writeBack) {
      try {
        wroteBack = await writeBackLanggraphAssistantId(
          sql,
          agent.agentId,
          assistantId,
        );
      } catch (writeBackError: unknown) {
        const message =
          writeBackError instanceof Error
            ? writeBackError.message
            : String(writeBackError);
        console.warn(
          `[agent-sync] Failed to write back langgraph_assistant_id for agent ${agent.agentId}: ${message}`,
        );
      }
    }

    return {
      assistantId,
      action: "created",
      wroteBackAssistantId: wroteBack,
    };
  }

  // Compare existing config with desired config
  const existingConfigurable = extractAssistantConfigurable(existingAssistant);
  const desiredConfigurable = (payload.config as Record<string, unknown>)
    .configurable as Record<string, unknown>;

  // Shallow JSON comparison (matching Python's == on dicts)
  if (
    JSON.stringify(existingConfigurable) === JSON.stringify(desiredConfigurable)
  ) {
    return {
      assistantId,
      action: "skipped",
      wroteBackAssistantId: false,
    };
  }

  // Update existing assistant
  await storage.assistants.update(assistantId, payload, ownerId);

  let wroteBack = false;
  if (writeBack) {
    try {
      wroteBack = await writeBackLanggraphAssistantId(
        sql,
        agent.agentId,
        assistantId,
      );
    } catch (writeBackError: unknown) {
      const message =
        writeBackError instanceof Error
          ? writeBackError.message
          : String(writeBackError);
      console.warn(
        `[agent-sync] Failed to write back langgraph_assistant_id for agent ${agent.agentId}: ${message}`,
      );
    }
  }

  return {
    assistantId,
    action: "updated",
    wroteBackAssistantId: wroteBack,
  };
}

// ---------------------------------------------------------------------------
// Startup sync
// ---------------------------------------------------------------------------

/**
 * Sync agents at startup for the configured scope.
 *
 * This is intended to *warm* assistant storage in dev/single-tenant
 * scenarios. In production multi-tenant environments, `scope` should
 * usually be "none" and lazy sync should be used instead.
 *
 * Each agent is synced independently — a failure on one agent does not
 * abort processing of the remaining agents.
 *
 * @param sql - Postgres.js SQL client.
 * @param storage - Assistant storage implementation.
 * @param scope - Parsed sync scope from `AGENT_SYNC_SCOPE`.
 * @param ownerId - Owner ID for assistant storage operations.
 * @returns Summary counters: total, created, updated, skipped, failed.
 */
export async function startupAgentSync(
  sql: Sql,
  storage: AgentSyncStorage,
  scope: AgentSyncScope,
  ownerId: string,
): Promise<AgentSyncSummary> {
  if (scope.type === "none") {
    return { total: 0, created: 0, updated: 0, skipped: 0, failed: 0 };
  }

  const agents = await fetchActiveAgents(sql, scope);
  const summary: AgentSyncSummary = {
    total: agents.length,
    created: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
  };

  for (const agent of agents) {
    try {
      const result = await syncSingleAgent(
        sql,
        storage,
        agent,
        ownerId,
        true, // writeBack
      );
      summary[result.action] += 1;
    } catch (syncError: unknown) {
      summary.failed += 1;
      const message =
        syncError instanceof Error ? syncError.message : String(syncError);
      console.error(
        `[agent-sync] Startup agent sync failed for agent ${agent.agentId}: ${message}`,
      );
    }
  }

  console.info(
    `[agent-sync] Startup sync summary: total=${summary.total} created=${summary.created} updated=${summary.updated} skipped=${summary.skipped} failed=${summary.failed}`,
  );

  return summary;
}

// ---------------------------------------------------------------------------
// Lazy (on-demand) sync
// ---------------------------------------------------------------------------

/**
 * Sync a single agent on-demand and return the assistant_id.
 *
 * Behavior:
 *   - If the assistant exists and was recently synced (within `cacheTtlMs`),
 *     returns immediately without re-fetching from the database.
 *   - Otherwise, fetches the agent config from Supabase and creates/updates
 *     the assistant.
 *
 * The TTL is checked via `metadata.synced_at` on the existing assistant.
 *
 * @param sql - Postgres.js SQL client.
 * @param storage - Assistant storage implementation.
 * @param agentId - The Supabase agent UUID to sync.
 * @param ownerId - Owner ID for assistant storage operations.
 * @param cacheTtlMs - Cache TTL in milliseconds (default: 5 minutes).
 * @returns The assistant_id on success, or `null` if the agent is not found/active.
 */
export async function lazySyncAgent(
  sql: Sql,
  storage: AgentSyncStorage,
  agentId: string,
  ownerId: string,
  cacheTtlMs: number = DEFAULT_CACHE_TTL_MS,
): Promise<string | null> {
  const assistantId = agentId;

  const existingAssistant = await storage.assistants.get(assistantId, ownerId);

  if (existingAssistant !== null && existingAssistant !== undefined) {
    // Best-effort TTL check using assistant metadata.synced_at
    let syncedAtText: string | null = null;

    if (
      typeof existingAssistant === "object" &&
      existingAssistant !== null
    ) {
      const metadata = (existingAssistant as Record<string, unknown>).metadata;
      if (typeof metadata === "object" && metadata !== null) {
        const rawSyncedAt = (metadata as Record<string, unknown>).synced_at;
        if (typeof rawSyncedAt === "string") {
          syncedAtText = rawSyncedAt;
        }
      }
    }

    if (syncedAtText) {
      try {
        // Handle "Z" suffix by replacing with "+00:00" for consistent parsing
        const normalizedTimestamp = syncedAtText.replace("Z", "+00:00");
        const syncedAt = new Date(normalizedTimestamp);

        if (!Number.isNaN(syncedAt.getTime())) {
          const elapsed = Date.now() - syncedAt.getTime();
          if (elapsed < cacheTtlMs) {
            return assistantId;
          }
        }
      } catch {
        // Ignore parse errors; we'll resync
      }
    }
  }

  // Fetch from database and sync
  const agent = await fetchActiveAgentById(sql, agentId);
  if (agent === null) {
    return null;
  }

  await syncSingleAgent(sql, storage, agent, ownerId, true);
  return assistantId;
}
