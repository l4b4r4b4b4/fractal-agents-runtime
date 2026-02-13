/**
 * Configuration types and parsing for the ReAct agent graph.
 *
 * This module mirrors the Python runtime's `GraphConfigPydantic` class from
 * `graphs/react_agent/agent.py`, providing typed configuration with defaults
 * and a pure parsing function for extracting config from an assistant's
 * `configurable` dictionary.
 *
 * v0.0.1 scope: Only the core config fields are implemented. MCP config,
 * RAG config, and custom endpoint fields are deferred to later goals.
 *
 * Reference: apps/python/src/graphs/react_agent/agent.py → GraphConfigPydantic
 */

// ---------------------------------------------------------------------------
// Constants — match Python runtime exactly
// ---------------------------------------------------------------------------

/**
 * Default model name. Matches Python's `GraphConfigPydantic.model_name` default.
 *
 * Uses the `provider:model` format convention from the Python runtime.
 * In v0.0.1, only OpenAI models are supported. Multi-provider support
 * (Anthropic, Google, custom) is deferred to Goal 25.
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
// Config type
// ---------------------------------------------------------------------------

/**
 * Parsed configuration values for the ReAct agent graph.
 *
 * All fields have defaults — this type represents the resolved config
 * after parsing from an assistant's configurable dictionary.
 *
 * Mirrors Python's `GraphConfigPydantic` (core fields only in v0.0.1).
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
}

// ---------------------------------------------------------------------------
// Config parsing
// ---------------------------------------------------------------------------

/**
 * Parse a graph configuration from an assistant's configurable dictionary.
 *
 * Extracts known fields and applies defaults for any missing values.
 * Unknown fields are silently ignored (forward-compatible with future
 * config additions like MCP, RAG, custom endpoints).
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
 *   // → { model_name: "openai:gpt-4o", temperature: 0.7, max_tokens: 4000, system_prompt: "..." }
 *
 *   // Override model only
 *   parseGraphConfig({ model_name: "openai:gpt-4o-mini" })
 *   // → { model_name: "openai:gpt-4o-mini", temperature: 0.7, max_tokens: 4000, system_prompt: "..." }
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
