/**
 * Config mapping utilities for Agent Sync.
 *
 * Translates agent configuration from Supabase format (AgentSyncData) into
 * LangGraph assistant payloads (config.configurable + metadata).
 *
 * Provides:
 *   - `safeMaskUrl()` — Strip query/fragment from URLs for safe logging
 *   - `buildAssistantConfigurable()` — Build `config.configurable` for the graph
 *   - `assistantPayloadForAgent()` — Build full assistant create/update payload
 *   - `extractAssistantConfigurable()` — Extract existing configurable from an assistant
 *
 * MCP tools are grouped by endpoint URL into `mcp_config.servers[]`, where
 * each server entry contains a name, URL, list of tool names, and an
 * auth_required flag. This enables agents to use multiple MCP servers.
 *
 * Reference: apps/python/src/server/agent_sync.py
 */

import type { AgentSyncData } from "./types";

// ---------------------------------------------------------------------------
// URL masking
// ---------------------------------------------------------------------------

/**
 * Mask potentially sensitive URL parts for logging (drop query/fragment).
 *
 * Returns `null` for null/undefined/empty inputs (passthrough).
 *
 * @param url - The URL to mask.
 * @returns The URL without query string or fragment, or `null`.
 *
 * @example
 * ```
 * safeMaskUrl("https://api.example.com/mcp?token=secret#ref")
 * // => "https://api.example.com/mcp"
 * ```
 */
export function safeMaskUrl(url: string | null | undefined): string | null {
  if (!url) {
    return null;
  }

  return url.split("?", 2)[0].split("#", 2)[0];
}

// ---------------------------------------------------------------------------
// Configurable builder
// ---------------------------------------------------------------------------

/**
 * MCP server entry in the `mcp_config.servers[]` array.
 *
 * Each server groups tools by endpoint URL, with an auto-generated name.
 */
interface McpServerEntry {
  name: string;
  url: string;
  tools: string[];
  auth_required: boolean;
}

/**
 * Build `config.configurable` for the LangGraph graph factory.
 *
 * Emits multi-server MCP configuration:
 *
 * ```json
 * {
 *   "model_name": "openai:gpt-4o",
 *   "system_prompt": "...",
 *   "temperature": 0.7,
 *   "max_tokens": 1024,
 *   "supabase_organization_id": "...",
 *   "mcp_config": {
 *     "servers": [
 *       { "name": "server-1", "url": "...", "tools": [...], "auth_required": false }
 *     ]
 *   }
 * }
 * ```
 *
 * Servers are grouped by MCP endpoint URL, tool filters are applied per
 * server entry, and server names are auto-generated as `server-{index}`.
 *
 * @param agent - The agent configuration from Supabase.
 * @returns The configurable dict for the assistant's config.
 */
export function buildAssistantConfigurable(
  agent: AgentSyncData,
): Record<string, unknown> {
  const configurable: Record<string, unknown> = {};

  // Org ID is required for store namespace scoping:
  // (org_id, user_id, assistant_id, category)
  if (agent.organizationId) {
    configurable.supabase_organization_id = agent.organizationId;
  }

  if (agent.runtimeModelName) {
    configurable.model_name = agent.runtimeModelName;
  }

  if (agent.systemPrompt !== null && agent.systemPrompt !== undefined) {
    configurable.system_prompt = agent.systemPrompt;
  }

  if (agent.temperature !== null && agent.temperature !== undefined) {
    configurable.temperature = agent.temperature;
  }

  if (agent.maxTokens !== null && agent.maxTokens !== undefined) {
    configurable.max_tokens = agent.maxTokens;
  }

  if (agent.mcpTools && agent.mcpTools.length > 0) {
    // Group tool names by endpoint URL
    const toolsByEndpointUrl = new Map<string, string[]>();
    const authRequiredByEndpointUrl = new Map<string, boolean>();

    for (const mcpTool of agent.mcpTools) {
      const endpointUrl = mcpTool.endpointUrl;
      const toolName = mcpTool.toolName;

      if (!endpointUrl || !toolName) {
        continue;
      }

      if (!toolsByEndpointUrl.has(endpointUrl)) {
        toolsByEndpointUrl.set(endpointUrl, []);
      }
      toolsByEndpointUrl.get(endpointUrl)!.push(String(toolName));

      // OR together auth_required across tools on the same endpoint
      const currentAuth = authRequiredByEndpointUrl.get(endpointUrl) ?? false;
      authRequiredByEndpointUrl.set(
        endpointUrl,
        currentAuth || Boolean(mcpTool.authRequired),
      );
    }

    const servers: McpServerEntry[] = [];
    const sortedEndpoints = [...toolsByEndpointUrl.keys()].sort();

    for (let index = 0; index < sortedEndpoints.length; index++) {
      const endpointUrl = sortedEndpoints[index];
      // Deduplicate and sort tool names within each server
      const toolNames = [...new Set(toolsByEndpointUrl.get(endpointUrl)!)].sort();

      servers.push({
        name: `server-${index + 1}`,
        url: endpointUrl,
        tools: toolNames,
        auth_required: authRequiredByEndpointUrl.get(endpointUrl) ?? false,
      });
    }

    if (servers.length > 0) {
      configurable.mcp_config = { servers };
    }
  }

  return configurable;
}

// ---------------------------------------------------------------------------
// Assistant payload
// ---------------------------------------------------------------------------

/**
 * Build the full assistant create/update payload for storage.
 *
 * Storage expects a dict matching the assistant API shape. This function
 * constructs all fields necessary for correct execution.
 *
 * The `assistant_id` is set to the Supabase agent UUID string, ensuring
 * deterministic IDs (the same agent always maps to the same assistant).
 *
 * @param agent - The agent configuration from Supabase.
 * @returns A payload suitable for `storage.assistants.create()` or `.update()`.
 */
export function assistantPayloadForAgent(
  agent: AgentSyncData,
): Record<string, unknown> {
  const assistantId = agent.agentId;

  return {
    assistant_id: assistantId,
    graph_id: agent.graphId || "agent",
    config: {
      configurable: buildAssistantConfigurable(agent),
    },
    metadata: {
      supabase_agent_id: assistantId,
      supabase_organization_id: agent.organizationId
        ? agent.organizationId
        : null,
      synced_at: new Date().toISOString(),
    },
  };
}

// ---------------------------------------------------------------------------
// Config extraction
// ---------------------------------------------------------------------------

/**
 * Extract `assistant.config.configurable` as a plain dict when present.
 *
 * Handles various shapes of the config property:
 *   - Object with `configurable` key → returns the configurable dict
 *   - `null` or `undefined` → returns `{}`
 *   - Non-dict configurable → returns `{}`
 *
 * This is used to compare existing assistant config with desired config
 * to determine whether an update is needed.
 *
 * @param assistant - An assistant object from storage (may have various shapes).
 * @returns The configurable dict, or `{}` if not extractable.
 */
export function extractAssistantConfigurable(
  assistant: unknown,
): Record<string, unknown> {
  if (assistant === null || assistant === undefined) {
    return {};
  }

  // Try to get .config from the assistant
  let config: unknown;

  if (typeof assistant === "object" && assistant !== null) {
    // Handle objects with a config property
    config = (assistant as Record<string, unknown>).config;
  } else {
    return {};
  }

  if (config === null || config === undefined) {
    return {};
  }

  // If config has a model_dump method (Pydantic-like), call it
  if (
    typeof config === "object" &&
    config !== null &&
    "model_dump" in config &&
    typeof (config as Record<string, unknown>).model_dump === "function"
  ) {
    try {
      const dumped = (config as { model_dump: () => unknown }).model_dump();
      if (typeof dumped === "object" && dumped !== null) {
        const configurable = (dumped as Record<string, unknown>).configurable;
        if (
          typeof configurable === "object" &&
          configurable !== null &&
          !Array.isArray(configurable)
        ) {
          return configurable as Record<string, unknown>;
        }
      }
      return {};
    } catch {
      return {};
    }
  }

  // Handle plain dict config
  if (typeof config === "object" && !Array.isArray(config)) {
    const configurable = (config as Record<string, unknown>).configurable;
    if (
      typeof configurable === "object" &&
      configurable !== null &&
      !Array.isArray(configurable)
    ) {
      return configurable as Record<string, unknown>;
    }
    return {};
  }

  return {};
}
