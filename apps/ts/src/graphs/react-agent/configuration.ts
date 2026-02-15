/**
 * Configuration types and parsing for the ReAct agent graph.
 *
 * This module mirrors the Python runtime's `GraphConfigPydantic` class from
 * `graphs/react_agent/agent.py`, providing typed configuration with defaults
 * and a pure parsing function for extracting config from an assistant's
 * `configurable` dictionary.
 *
 * v0.0.2 additions:
 *   - `base_url`, `custom_model_name`, `custom_api_key` for custom endpoints
 *   - `OAP_UI_CONFIG` metadata constant for OAP frontend rendering
 *
 * v0.0.3 additions:
 *   - `rag` config for Supabase RAG tool integration
 *
 * Reference: apps/python/src/graphs/react_agent/agent.py → GraphConfigPydantic
 */

import type { RagConfig } from "./utils/rag-tools";
import { parseRagConfig } from "./utils/rag-tools";

// ---------------------------------------------------------------------------
// Constants — match Python runtime exactly
// ---------------------------------------------------------------------------

/**
 * Default model name. Matches Python's `GraphConfigPydantic.model_name` default.
 *
 * Uses the `provider:model` format convention from the Python runtime.
 * Supported providers: `openai:`, `anthropic:`, `google:`, `custom:`.
 */
export const DEFAULT_MODEL_NAME = "openai:gpt-4o";

/**
 * Default temperature. Matches Python's `GraphConfigPydantic.temperature` default.
 *
 * Controls randomness: 0 = deterministic, 2 = creative.
 */
export const DEFAULT_TEMPERATURE = 0.7;

/**
 * Default max tokens. Matches Python's `GraphConfigPydantic.max_tokens` default.
 */
export const DEFAULT_MAX_TOKENS = 4000;

/**
 * Default system prompt. Matches Python's `DEFAULT_SYSTEM_PROMPT` exactly.
 *
 * Instructs the agent to only use explicitly provided tools and to be
 * honest about its limitations.
 */
export const DEFAULT_SYSTEM_PROMPT =
  "You are a helpful assistant. You have access ONLY to the tools explicitly" +
  " provided to you below. Do NOT claim to have access to any tools, APIs," +
  " or capabilities that are not listed. If the user asks for something that" +
  " requires a tool you do not have, tell them honestly that you cannot do it" +
  " with your current tools.";

/**
 * Uneditable system prompt suffix. Matches Python's `UNEDITABLE_SYSTEM_PROMPT`.
 *
 * This is always appended to the effective system prompt and cannot be
 * overridden by the user. It instructs the agent to provide auth links
 * when tools require authentication.
 */
export const UNEDITABLE_SYSTEM_PROMPT =
  "\nIf the tool throws an error requiring authentication, provide the user" +
  " with a Markdown link to the authentication page and prompt them to" +
  " authenticate.";

// ---------------------------------------------------------------------------
// OAP UI Config metadata — matches Python's json_schema_extra
// ---------------------------------------------------------------------------

/**
 * OAP UI configuration metadata for the ReAct agent.
 *
 * This object describes how the Open Agent Platform frontend should render
 * the assistant configuration form. It matches the Python runtime's
 * `GraphConfigPydantic` field-level `json_schema_extra.x_oap_ui_config`
 * definitions exactly.
 *
 * Exported so the OpenAPI spec generator can include it in the assistant
 * config schema. The frontend reads these to render dropdowns, sliders,
 * text inputs, etc.
 */
export const OAP_UI_CONFIG = {
  model_name: {
    type: "select" as const,
    default: "openai:gpt-4o",
    description: "The model to use in all generations",
    options: [
      { label: "Claude Sonnet 4", value: "anthropic:claude-sonnet-4-0" },
      { label: "Claude 3.7 Sonnet", value: "anthropic:claude-3-7-sonnet-latest" },
      { label: "Claude 3.5 Sonnet", value: "anthropic:claude-3-5-sonnet-latest" },
      { label: "Claude 3.5 Haiku", value: "anthropic:claude-3-5-haiku-latest" },
      { label: "o4 mini", value: "openai:o4-mini" },
      { label: "o3", value: "openai:o3" },
      { label: "o3 mini", value: "openai:o3-mini" },
      { label: "GPT 4o", value: "openai:gpt-4o" },
      { label: "GPT 4o mini", value: "openai:gpt-4o-mini" },
      { label: "GPT 4.1", value: "openai:gpt-4.1" },
      { label: "GPT 4.1 mini", value: "openai:gpt-4.1-mini" },
      { label: "Custom OpenAI-compatible endpoint", value: "custom:" },
    ],
  },
  temperature: {
    type: "slider" as const,
    default: 0.7,
    min: 0,
    max: 2,
    step: 0.1,
    description: "Controls randomness (0 = deterministic, 2 = creative)",
  },
  max_tokens: {
    type: "number" as const,
    default: 4000,
    min: 1,
    description: "The maximum number of tokens to generate",
  },
  system_prompt: {
    type: "textarea" as const,
    placeholder: "Enter a system prompt...",
    description:
      "The system prompt to use in all generations." +
      " The following prompt will always be included" +
      " at the end of the system prompt:\n---" +
      UNEDITABLE_SYSTEM_PROMPT +
      "\n---",
    default: DEFAULT_SYSTEM_PROMPT,
  },
  mcp_config: {
    type: "mcp" as const,
  },
  base_url: {
    type: "text" as const,
    placeholder: "http://localhost:7374/v1",
    description: "Base URL for custom OpenAI-compatible API",
    visible_when: { model_name: "custom:" },
  },
  custom_model_name: {
    type: "text" as const,
    placeholder: "mistralai/ministral-3b-instruct",
    description: "Model name for custom endpoint",
    visible_when: { model_name: "custom:" },
  },
  custom_api_key: {
    type: "password" as const,
    placeholder: "Leave empty for local vLLM",
    description: "API key for custom endpoint (optional)",
    visible_when: { model_name: "custom:" },
  },
} as const;

// ---------------------------------------------------------------------------
// MCP config types — match Python's MCPServerConfig / MCPConfig exactly
// ---------------------------------------------------------------------------

/**
 * Configuration for a single MCP server.
 *
 * Mirrors Python's `MCPServerConfig(BaseModel)` from
 * `graphs/react_agent/agent.py`.
 */
export interface MCPServerConfig {
  /** Stable identifier for this server entry. Used as the key when
   * creating the MultiServerMCPClient config dict. */
  name: string;

  /** Base URL for the MCP server (may or may not end with /mcp). */
  url: string;

  /** Optional list of tool names to expose from this server.
   * If omitted/null, all tools from the server are exposed. */
  tools: string[] | null;

  /** Whether this server requires auth token exchange. */
  auth_required: boolean;
}

/**
 * Multi-server MCP configuration.
 *
 * Mirrors Python's `MCPConfig(BaseModel)`.
 */
export interface MCPConfig {
  servers: MCPServerConfig[];
}

// ---------------------------------------------------------------------------
// Config type
// ---------------------------------------------------------------------------

/**
 * Parsed configuration values for the ReAct agent graph.
 *
 * All fields have defaults — this type represents the resolved config
 * after parsing from an assistant's configurable dictionary.
 *
 * Mirrors Python's `GraphConfigPydantic`.
 */
export interface GraphConfigValues {
  /** Model identifier in `provider:model` format. */
  model_name: string;

  /** Sampling temperature (0–2). */
  temperature: number;

  /** Maximum number of tokens to generate. */
  max_tokens: number;

  /** System prompt for the agent. */
  system_prompt: string;

  /**
   * Base URL for a custom OpenAI-compatible endpoint (vLLM, Ollama, LiteLLM).
   * When set, bypasses `initChatModel` and uses `ChatOpenAI` with this URL.
   * `null` means use the standard provider determined by the `model_name` prefix.
   */
  base_url: string | null;

  /**
   * Model name override for custom endpoints.
   * Used when the model name at the custom endpoint differs from `model_name`.
   * Only relevant when `base_url` is set.
   */
  custom_model_name: string | null;

  /**
   * API key for the custom endpoint.
   * Only relevant when `base_url` is set. Falls back to `CUSTOM_API_KEY` env
   * var, then to `"EMPTY"` (for local endpoints without auth).
   */
  custom_api_key: string | null;

  /**
   * MCP server configuration — one or more remote tool servers.
   * When set, the agent dynamically loads tools from these servers at
   * construction time. `null` means no MCP tools.
   */
  mcp_config: MCPConfig | null;

  /**
   * RAG (Retrieval-Augmented Generation) configuration.
   * When set, the agent creates tools that query Supabase vector collections
   * for semantically similar documents. `null` means no RAG tools.
   *
   * Mirrors Python's `RagConfig` from `graphs/react_agent/agent.py`.
   */
  rag: RagConfig | null;
}

// ---------------------------------------------------------------------------
// Config parsing
// ---------------------------------------------------------------------------

/**
 * Parse a graph configuration from an assistant's configurable dictionary.
 *
 * Extracts known fields and applies defaults for any missing values.
 * Unknown fields are silently ignored (forward-compatible with future
 * config additions like MCP, RAG).
 *
 * Mirrors the Python pattern of:
 *   `cfg = GraphConfigPydantic(**(config.get("configurable", {}) or {}))`
 *
 * @param configurable - The assistant's configurable dictionary. May be
 *   `undefined` or `null`, in which case all defaults are returned.
 * @returns Fully resolved `GraphConfigValues` with no undefined fields.
 *
 * @example
 *   // All defaults
 *   parseGraphConfig(undefined)
 *   // → { model_name: "openai:gpt-4o", temperature: 0.7, max_tokens: 4000, ... }
 *
 *   // Override model only
 *   parseGraphConfig({ model_name: "openai:gpt-4o-mini" })
 *   // → { model_name: "openai:gpt-4o-mini", temperature: 0.7, max_tokens: 4000, ... }
 *
 *   // Custom endpoint
 *   parseGraphConfig({ model_name: "custom:", base_url: "http://localhost:7374/v1" })
 *   // → { model_name: "custom:", base_url: "http://localhost:7374/v1", ... }
 */
export function parseGraphConfig(
  configurable?: Record<string, unknown> | null,
): GraphConfigValues {
  const raw = configurable ?? {};

  return {
    model_name: parseString(raw.model_name, DEFAULT_MODEL_NAME),
    temperature: parseNumber(raw.temperature, DEFAULT_TEMPERATURE),
    max_tokens: parseInteger(raw.max_tokens, DEFAULT_MAX_TOKENS),
    system_prompt: parseString(raw.system_prompt, DEFAULT_SYSTEM_PROMPT),
    base_url: parseNullableString(raw.base_url),
    custom_model_name: parseNullableString(raw.custom_model_name),
    custom_api_key: parseNullableString(raw.custom_api_key),
    mcp_config: parseMcpConfig(raw.mcp_config),
    rag: parseRagConfig(raw.rag),
  };
}

/**
 * Get the effective system prompt with the uneditable suffix appended.
 *
 * This mirrors the Python pattern:
 *   `effective_system_prompt + UNEDITABLE_SYSTEM_PROMPT`
 *
 * The uneditable suffix is always appended — it cannot be removed by
 * assistant configuration. This ensures the auth-link instruction is
 * always present.
 *
 * @param config - Parsed graph configuration values.
 * @returns The full system prompt string ready for the model.
 */
export function getEffectiveSystemPrompt(config: GraphConfigValues): string {
  return config.system_prompt + UNEDITABLE_SYSTEM_PROMPT;
}

// ---------------------------------------------------------------------------
// Internal parsing helpers
// ---------------------------------------------------------------------------

/**
 * Parse an optional string value, returning `null` if absent or empty.
 *
 * Used for fields like `base_url`, `custom_model_name`, `custom_api_key`
 * that are genuinely optional (no sensible default).
 */
function parseNullableString(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  return null;
}

/**
 * Parse a string value with a default fallback.
 *
 * Returns the default if the value is not a non-empty string.
 */
function parseString(value: unknown, defaultValue: string): string {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  return defaultValue;
}

/**
 * Parse a numeric value with a default fallback.
 *
 * Handles both number and string inputs (e.g., `"0.5"` from JSON).
 * Returns the default if the value cannot be parsed as a finite number.
 */
function parseNumber(value: unknown, defaultValue: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return defaultValue;
}

/**
 * Parse an MCP config from the configurable dictionary.
 *
 * Accepts either a full `MCPConfig` object `{ servers: [...] }` or
 * a raw array of server objects. Returns `null` if the value is not
 * a valid MCP configuration or has no servers.
 */
export function parseMcpConfig(value: unknown): MCPConfig | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value !== "object") {
    return null;
  }

  // Accept { servers: [...] } shape
  const candidate = value as Record<string, unknown>;
  const rawServers = Array.isArray(candidate.servers)
    ? candidate.servers
    : Array.isArray(value)
      ? (value as unknown[])
      : null;

  if (!rawServers || rawServers.length === 0) {
    return null;
  }

  const servers: MCPServerConfig[] = [];
  for (const raw of rawServers) {
    if (typeof raw !== "object" || raw === null) {
      continue;
    }
    const serverObj = raw as Record<string, unknown>;
    const url = typeof serverObj.url === "string" ? serverObj.url : "";
    if (!url) {
      continue; // Skip servers without a URL
    }
    servers.push({
      name: typeof serverObj.name === "string" && serverObj.name.length > 0
        ? serverObj.name
        : "default",
      url,
      tools: Array.isArray(serverObj.tools)
        ? (serverObj.tools as unknown[]).filter((t): t is string => typeof t === "string")
        : null,
      auth_required: serverObj.auth_required === true,
    });
  }

  if (servers.length === 0) {
    return null;
  }

  return { servers };
}

/**
 * Parse an integer value with a default fallback.
 *
 * Handles both number and string inputs. Rounds to the nearest integer
 * if a float is provided. Returns the default if the value cannot be
 * parsed as a finite integer.
 */
function parseInteger(value: unknown, defaultValue: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.round(value);
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return Math.round(parsed);
    }
  }
  return defaultValue;
}
