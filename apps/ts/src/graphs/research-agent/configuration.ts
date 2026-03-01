/**
 * Configuration for the research agent graph.
 *
 * Mirrors the configuration patterns established in
 * `graphs/react-agent/configuration.ts` (`GraphConfigValues`) so that the
 * server can treat both graphs identically when resolving LLM, MCP tools,
 * and RAG collections from the assistant's `configurable` dict.
 *
 * The research-agent-specific additions are:
 *
 * - `maxWorkerIterations` — how many ReAct steps each parallel worker
 *   may take before it must return whatever it has.
 * - `autoApprovePhase1` / `autoApprovePhase2` — skip the
 *   human-in-the-loop review interrupt for the respective phase. Useful
 *   for automated testing and CI pipelines.
 *
 * Reference: apps/python/src/graphs/research_agent/configuration.py
 */

// ---------------------------------------------------------------------------
// Nested config types (same shapes as react-agent)
// ---------------------------------------------------------------------------

/** RAG (Retrieval-Augmented Generation) tool configuration. */
export interface RagConfig {
  ragUrl: string | null;
  collections: string[];
}

/** A single MCP server connection. */
export interface McpServerConfig {
  name: string;
  url: string;
  authRequired: boolean;
  tools: string[] | null;
}

/** MCP tool configuration — one or more remote servers. */
export interface McpConfig {
  servers: McpServerConfig[];
}

// ---------------------------------------------------------------------------
// Main configuration
// ---------------------------------------------------------------------------

/**
 * Full configuration for a research-agent assistant.
 *
 * All fields mirror the `configurable` dict that the server injects
 * into `RunnableConfig` when invoking the graph. Unknown keys are
 * silently ignored.
 */
export interface ResearchAgentConfig {
  // LLM
  /** Fully-qualified `provider:model` string (e.g. `"openai:gpt-4o-mini"`). */
  modelName: string;
  /** Sampling temperature for all LLM calls in the graph. */
  temperature: number;
  /** Optional hard token limit per LLM call. */
  maxTokens: number | null;
  /** If set, routes LLM calls to this OpenAI-compatible endpoint. */
  baseUrl: string | null;
  /** Model name override when `baseUrl` is used (e.g. a vLLM deployment). */
  customModelName: string | null;
  /** API key for the custom endpoint. */
  customApiKey: string | null;

  /** Optional top-level system prompt override. */
  systemPrompt: string | null;

  /** MCP server definitions — resolved at build time. */
  mcpConfig: McpConfig | null;

  /** RAG tool definitions — collections to expose as tools. */
  rag: RagConfig | null;

  // Research-agent-specific
  /** Maximum ReAct reasoning steps each parallel worker may perform. */
  maxWorkerIterations: number;
  /** When `true`, the phase-1 review interrupt is skipped. For testing/CI. */
  autoApprovePhase1: boolean;
  /** When `true`, the phase-2 review interrupt is skipped. For testing/CI. */
  autoApprovePhase2: boolean;
}

// ---------------------------------------------------------------------------
// Default values
// ---------------------------------------------------------------------------

export const DEFAULT_MODEL_NAME = "openai:gpt-4o-mini";
export const DEFAULT_TEMPERATURE = 0.0;
export const DEFAULT_MAX_WORKER_ITERATIONS = 15;

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse MCP server configuration from the raw configurable dict.
 *
 * Handles both the multi-server shape (`{ servers: [...] }`) and the
 * legacy single-server shape (`{ url: "...", auth_required: true }`).
 */
function parseMcpConfig(raw: unknown): McpConfig | null {
  if (!raw || typeof raw !== "object") return null;

  const rawObj = raw as Record<string, unknown>;

  // Multi-server shape: { servers: [...] }
  if (Array.isArray(rawObj.servers) && rawObj.servers.length > 0) {
    const servers: McpServerConfig[] = [];
    for (const entry of rawObj.servers) {
      if (!entry || typeof entry !== "object") continue;
      const serverObj = entry as Record<string, unknown>;
      servers.push({
        name: typeof serverObj.name === "string" ? serverObj.name : "default",
        url: typeof serverObj.url === "string" ? serverObj.url : "",
        authRequired: Boolean(serverObj.auth_required ?? serverObj.authRequired ?? false),
        tools: Array.isArray(serverObj.tools) ? (serverObj.tools as string[]) : null,
      });
    }
    return servers.length > 0 ? { servers } : null;
  }

  // Legacy single-server shape: { url: "...", auth_required: true }
  if (typeof rawObj.url === "string" && rawObj.url) {
    return {
      servers: [
        {
          name: typeof rawObj.name === "string" ? rawObj.name : "default",
          url: rawObj.url,
          authRequired: Boolean(rawObj.auth_required ?? rawObj.authRequired ?? false),
          tools: Array.isArray(rawObj.tools) ? (rawObj.tools as string[]) : null,
        },
      ],
    };
  }

  return null;
}

/**
 * Parse RAG configuration from the raw configurable dict.
 */
function parseRagConfig(raw: unknown): RagConfig | null {
  if (!raw || typeof raw !== "object") return null;

  const rawObj = raw as Record<string, unknown>;
  const ragUrl =
    typeof rawObj.rag_url === "string"
      ? rawObj.rag_url
      : typeof rawObj.ragUrl === "string"
        ? rawObj.ragUrl
        : null;

  const collections = Array.isArray(rawObj.collections)
    ? (rawObj.collections.filter((c) => typeof c === "string") as string[])
    : [];

  if (!ragUrl && collections.length === 0) return null;

  return { ragUrl, collections };
}

/**
 * Parse a `configurable` dict into a validated config object.
 *
 * Unknown keys are silently dropped.
 *
 * @param configurable - The `config["configurable"]` dict from a
 *   `RunnableConfig`, or `null`/`undefined`.
 * @returns A validated {@link ResearchAgentConfig} instance.
 *
 * @example
 *   const config = parseResearchConfig(configurable);
 *   const model = createChatModel(config);
 */
export function parseResearchConfig(
  configurable?: Record<string, unknown> | null,
): ResearchAgentConfig {
  const raw = configurable ?? {};

  // Parse max_worker_iterations with clamping (1–100)
  let maxWorkerIterations = DEFAULT_MAX_WORKER_ITERATIONS;
  const rawIterations =
    raw.max_worker_iterations ?? raw.maxWorkerIterations;
  if (typeof rawIterations === "number" && Number.isFinite(rawIterations)) {
    maxWorkerIterations = Math.max(1, Math.min(100, Math.round(rawIterations)));
  }

  return {
    // LLM
    modelName:
      typeof raw.model_name === "string" && raw.model_name
        ? raw.model_name
        : typeof raw.modelName === "string" && raw.modelName
          ? raw.modelName
          : DEFAULT_MODEL_NAME,
    temperature:
      typeof raw.temperature === "number" && Number.isFinite(raw.temperature)
        ? raw.temperature
        : DEFAULT_TEMPERATURE,
    maxTokens:
      typeof raw.max_tokens === "number" && Number.isFinite(raw.max_tokens)
        ? raw.max_tokens
        : typeof raw.maxTokens === "number" && Number.isFinite(raw.maxTokens)
          ? raw.maxTokens
          : null,
    baseUrl:
      typeof raw.base_url === "string" && raw.base_url
        ? raw.base_url
        : typeof raw.baseUrl === "string" && raw.baseUrl
          ? raw.baseUrl
          : null,
    customModelName:
      typeof raw.custom_model_name === "string"
        ? raw.custom_model_name
        : typeof raw.customModelName === "string"
          ? raw.customModelName
          : null,
    customApiKey:
      typeof raw.custom_api_key === "string"
        ? raw.custom_api_key
        : typeof raw.customApiKey === "string"
          ? raw.customApiKey
          : null,

    // System prompt
    systemPrompt:
      typeof raw.system_prompt === "string" && raw.system_prompt
        ? raw.system_prompt
        : typeof raw.systemPrompt === "string" && raw.systemPrompt
          ? raw.systemPrompt
          : null,

    // MCP
    mcpConfig: parseMcpConfig(raw.mcp_config ?? raw.mcpConfig),

    // RAG
    rag: parseRagConfig(raw.rag),

    // Research-agent-specific
    maxWorkerIterations,
    autoApprovePhase1: Boolean(
      raw.auto_approve_phase1 ?? raw.autoApprovePhase1 ?? false,
    ),
    autoApprovePhase2: Boolean(
      raw.auto_approve_phase2 ?? raw.autoApprovePhase2 ?? false,
    ),
  };
}
