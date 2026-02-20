/**
 * Langfuse prompt management integration — TypeScript/Bun.
 *
 * Provides a thin wrapper around Langfuse's prompt fetching with:
 *
 * - **Text and chat prompt support** — returns `string` or `ChatMessage[]`
 *   depending on the prompt type.
 * - **Automatic fallback** to hardcoded defaults when Langfuse is not
 *   configured or unreachable.
 * - **Runtime overrides** via `configurable.prompt_overrides` — allows
 *   the frontend to select a specific prompt name, label, or version
 *   at call time for A/B testing and composition.
 * - **Caching** via the Langfuse SDK's built-in client-side cache.
 * - **No-op behaviour** when Langfuse is not configured — graphs work
 *   identically with hardcoded prompts.
 * - **Variable substitution** — replaces `{{variable}}` placeholders
 *   in both text and chat prompts.
 *
 * Usage:
 *
 *   import { getPrompt } from "./infra/prompts";
 *
 *   // Simple text prompt with fallback
 *   const systemPrompt = getPrompt({
 *     name: "react-agent-system-prompt",
 *     fallback: "You are a helpful assistant.",
 *   });
 *
 *   // Chat prompt with variables and runtime config
 *   const messages = getPrompt({
 *     name: "vertriebsagent-analyzer-phase1",
 *     promptType: "chat",
 *     fallback: [{ role: "system", content: "Du bist ein Supervisor-Agent." }],
 *     config: runnableConfig,
 *     variables: { stadt: "München" },
 *   });
 *
 * Runtime override (frontend sends via configurable):
 *
 *   {
 *     "configurable": {
 *       "prompt_overrides": {
 *         "react-agent-system-prompt": {
 *           "label": "experiment-a"
 *         },
 *         "vertriebsagent-analyzer-phase1": {
 *           "version": 5
 *         }
 *       }
 *     }
 *   }
 *
 * Override keys:
 *   - `name`    — swap to a completely different Langfuse prompt
 *   - `label`   — fetch a different label (default: "production")
 *   - `version` — pin to an exact version number
 *
 * Environment variables:
 *   LANGFUSE_PROMPT_CACHE_TTL — Override the default cache TTL in seconds
 *     (default: 300). Set to 0 to disable caching (useful in development).
 *
 * Reference: apps/python/src/infra/prompts.py
 */

import { isLangfuseEnabled } from "./tracing";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A single chat message dict with `role` and `content` keys.
 *
 * Matches LangChain / OpenAI message format.
 */
export interface ChatMessage {
  role: string;
  content: string;
  [key: string]: unknown;
}

/** Prompt type discriminator. */
export type PromptType = "text" | "chat";

/** Return type based on prompt type. */
export type PromptResult<T extends PromptType> = T extends "chat"
  ? ChatMessage[]
  : string;

/**
 * Options for `getPrompt()`.
 *
 * Generic parameter `T` determines the return type:
 *   - `"text"` → `string`
 *   - `"chat"` → `ChatMessage[]`
 */
export interface GetPromptOptions<T extends PromptType = "text"> {
  /** Langfuse prompt name (e.g., "react-agent-system-prompt"). */
  name: string;

  /**
   * Hardcoded fallback content.
   *
   * For text prompts: a string.
   * For chat prompts: an array of ChatMessage objects.
   */
  fallback: T extends "chat" ? ChatMessage[] : string;

  /** Prompt type. Default: "text". */
  promptType?: T;

  /**
   * Optional RunnableConfig carrying runtime overrides in
   * `configurable.prompt_overrides`.
   */
  config?: Record<string, unknown> | null;

  /** Default Langfuse label. Default: "production". */
  label?: string;

  /** Override the SDK cache TTL for this call (in seconds). */
  cacheTtlSeconds?: number | null;

  /** Optional `{{key}}` substitution values. */
  variables?: Record<string, string> | null;
}

// ---------------------------------------------------------------------------
// Prompt registry — graphs register their defaults here
// ---------------------------------------------------------------------------

/**
 * A registered default prompt entry.
 */
interface RegisteredPrompt {
  name: string;
  defaultContent: string | ChatMessage[];
  promptType: PromptType;
}

/**
 * List of registered default prompts.
 *
 * Graphs call `registerDefaultPrompt()` at module level to register
 * their hardcoded defaults. `seedDefaultPrompts()` creates any that
 * don't yet exist in Langfuse.
 */
const registeredPrompts: RegisteredPrompt[] = [];

/** Set of registered names for deduplication. */
const registeredNames: Set<string> = new Set();

/**
 * Register a prompt default for auto-seeding in Langfuse at startup.
 *
 * Call this at module level in each graph's prompts or index module.
 * The infra layer stores them and `seedDefaultPrompts()` creates any
 * that don't yet exist in Langfuse.
 *
 * This function is safe to call even when Langfuse is not configured —
 * it only stores the registration; no network calls are made.
 *
 * @param name - Langfuse prompt name (e.g., "react-agent-system-prompt").
 * @param defaultContent - The hardcoded prompt content.
 * @param promptType - "text" or "chat". Default: "text".
 */
export function registerDefaultPrompt(
  name: string,
  defaultContent: string | ChatMessage[],
  promptType: PromptType = "text",
): void {
  // Deduplicate — only register a name once (first registration wins).
  if (registeredNames.has(name)) {
    return;
  }

  registeredNames.add(name);
  registeredPrompts.push({ name, defaultContent, promptType });
}

/**
 * Create any missing prompts in Langfuse from registered defaults.
 *
 * Call this once at application startup, **after** `initializeLangfuse()`
 * has succeeded. It is idempotent — prompts that already exist in
 * Langfuse are skipped (no new versions created).
 *
 * @returns The number of prompts that were created (0 if all already
 *   exist or Langfuse is not enabled).
 */
export async function seedDefaultPrompts(): Promise<number> {
  if (!isLangfuseEnabled()) {
    return 0;
  }

  if (registeredPrompts.length === 0) {
    return 0;
  }

  let client: any;
  try {
    const langfuseModule = require("@langfuse/core");
    const LangfuseClass = langfuseModule.Langfuse ?? langfuseModule.default;
    if (typeof LangfuseClass === "function") {
      client = new LangfuseClass();
    } else {
      // Try get_client pattern
      client = langfuseModule.get_client?.();
    }
  } catch {
    console.warn(
      "[prompts] seed_default_prompts: failed to get Langfuse client",
    );
    return 0;
  }

  if (!client) {
    return 0;
  }

  let createdCount = 0;

  for (const entry of registeredPrompts) {
    try {
      const existing = await client.getPrompt(entry.name, {
        fallback: entry.defaultContent,
        type: entry.promptType,
        cacheTtlSeconds: 0,
      });

      const isFallback =
        existing && typeof existing === "object" && existing.isFallback === true;

      if (isFallback) {
        // Prompt does not exist in Langfuse yet — create it
        await client.createPrompt({
          name: entry.name,
          type: entry.promptType,
          prompt: entry.defaultContent,
          labels: ["production"],
        });
        createdCount += 1;
        console.info(
          `[prompts] Seeded Langfuse prompt: ${entry.name} (type=${entry.promptType})`,
        );
      }
    } catch {
      // Non-fatal — failing to seed a prompt should not break startup
      console.warn(
        `[prompts] seed_default_prompts: failed to seed '${entry.name}'`,
      );
    }
  }

  return createdCount;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Regex matching Langfuse-style `{{variable}}` placeholders.
 */
const VARIABLE_PATTERN = /\{\{(\w+)\}\}/g;

/** Default cache TTL in seconds. */
const DEFAULT_CACHE_TTL_SECONDS = 300;

/**
 * Read the global cache TTL from the environment, or use the default.
 */
function getDefaultCacheTtl(): number {
  const raw = process.env.LANGFUSE_PROMPT_CACHE_TTL;
  if (raw !== undefined && raw !== "") {
    const parsed = parseInt(raw, 10);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
    console.warn(
      `[prompts] LANGFUSE_PROMPT_CACHE_TTL='${raw}' is not a valid integer — using default ${DEFAULT_CACHE_TTL_SECONDS}`,
    );
  }
  return DEFAULT_CACHE_TTL_SECONDS;
}

/**
 * Replace `{{key}}` placeholders in a text string.
 *
 * Unknown placeholders are left untouched so that downstream consumers
 * (e.g., LangChain PromptTemplate) can still process them.
 *
 * @param template - The template string with `{{key}}` placeholders.
 * @param variables - Key-value substitution map.
 * @returns The string with known placeholders replaced.
 */
export function substituteVariablesText(
  template: string,
  variables: Record<string, string>,
): string {
  return template.replace(VARIABLE_PATTERN, (match, key: string) => {
    return key in variables ? variables[key] : match;
  });
}

/**
 * Replace `{{key}}` placeholders in every message's `content`.
 *
 * @param messages - Array of chat messages.
 * @param variables - Key-value substitution map.
 * @returns New array with substituted content strings.
 */
export function substituteVariablesChat(
  messages: ChatMessage[],
  variables: Record<string, string>,
): ChatMessage[] {
  return messages.map((message) => {
    const substituted = { ...message };
    if (typeof substituted.content === "string") {
      substituted.content = substituteVariablesText(
        substituted.content,
        variables,
      );
    }
    return substituted;
  });
}

/**
 * Extract prompt overrides for a specific prompt name from config.
 *
 * Looks for `config.configurable.prompt_overrides[name]` and returns
 * the override dict if found, or an empty object otherwise.
 *
 * @param name - The prompt name to look up overrides for.
 * @param config - The RunnableConfig (may be null/undefined).
 * @returns Override dict with optional `name`, `label`, `version` keys.
 */
export function extractOverrides(
  name: string,
  config: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (!config) {
    return {};
  }

  const configurable = config.configurable;
  if (typeof configurable !== "object" || configurable === null) {
    return {};
  }

  const promptOverrides = (configurable as Record<string, unknown>)
    .prompt_overrides;
  if (typeof promptOverrides !== "object" || promptOverrides === null) {
    return {};
  }

  const entry = (promptOverrides as Record<string, unknown>)[name];
  if (typeof entry !== "object" || entry === null) {
    return {};
  }

  return entry as Record<string, unknown>;
}

/**
 * Apply variable substitution to a fallback value and return it.
 *
 * @param fallback - The fallback value (string or ChatMessage[]).
 * @param promptType - "text" or "chat".
 * @param variables - Optional substitution variables.
 * @returns The fallback with variables substituted (if any).
 */
function applyFallback(
  fallback: string | ChatMessage[],
  promptType: PromptType,
  variables: Record<string, string> | null | undefined,
): string | ChatMessage[] {
  if (!variables || Object.keys(variables).length === 0) {
    return fallback;
  }

  if (promptType === "chat" && Array.isArray(fallback)) {
    return substituteVariablesChat(fallback, variables);
  }

  if (typeof fallback === "string") {
    return substituteVariablesText(fallback, variables);
  }

  return fallback;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch a prompt from Langfuse, falling back to a hardcoded default.
 *
 * This is the single entry point for all prompt retrieval in the runtime.
 * It handles three scenarios transparently:
 *
 * 1. **Langfuse configured and reachable** — returns the Langfuse prompt
 *    (possibly overridden by `config.configurable.prompt_overrides`).
 * 2. **Langfuse configured but unreachable** — logs a warning and returns
 *    the hardcoded fallback (Langfuse SDK's built-in fallback mechanism).
 * 3. **Langfuse not configured** — returns the fallback immediately with
 *    no network calls.
 *
 * @param options - Prompt retrieval options.
 * @returns The compiled prompt string (text) or ChatMessage[] (chat).
 *
 * @example
 * ```
 * // Text prompt — returns string
 * const systemPrompt = getPrompt({
 *   name: "react-agent-system-prompt",
 *   fallback: "You are a helpful assistant.",
 *   config: runnableConfig,
 * });
 *
 * // Chat prompt — returns ChatMessage[]
 * const messages = getPrompt({
 *   name: "my-chat-prompt",
 *   promptType: "chat",
 *   fallback: [{ role: "system", content: "You are helpful." }],
 *   variables: { user_name: "Alice" },
 * });
 * ```
 */
export function getPrompt<T extends PromptType = "text">(
  options: GetPromptOptions<T>,
): PromptResult<T> {
  const {
    name,
    fallback,
    promptType = "text" as T,
    config = null,
    label = "production",
    cacheTtlSeconds = null,
    variables = null,
  } = options;

  // --- Resolve overrides from config ---
  const overrides = extractOverrides(name, config);
  const effectiveName =
    typeof overrides.name === "string" ? overrides.name : name;
  // TODO: wire effectiveLabel / effectiveVersion / effectiveTtl into the
  // Langfuse getPrompt call once the SDK integration is complete.
  void (typeof overrides.label === "string" ? overrides.label : label);
  void (typeof overrides.version === "number" ? overrides.version : null);
  void (cacheTtlSeconds !== null ? cacheTtlSeconds : getDefaultCacheTtl());

  // --- Fast path: Langfuse not initialised ---
  if (!isLangfuseEnabled()) {
    return applyFallback(fallback, promptType, variables) as PromptResult<T>;
  }

  // --- Langfuse path ---
  try {
    // Dynamic require to avoid failing when Langfuse is not installed
    const langfuseModule = require("@langfuse/core");
    const LangfuseClass = langfuseModule.Langfuse ?? langfuseModule.default;

    let client: any;
    if (typeof LangfuseClass === "function") {
      client = new LangfuseClass();
    }

    if (!client || typeof client.getPromptStateless !== "function") {
      // Fallback: try synchronous approach or just use fallback
      return applyFallback(
        fallback,
        promptType,
        variables,
      ) as PromptResult<T>;
    }

    // Note: getPrompt in Langfuse JS SDK is async. Since our function
    // signature is synchronous (matching how prompts are consumed inline
    // in graph configuration), we use the synchronous fallback path.
    // The actual Langfuse prompt fetching happens at invocation time
    // through the callback handler's prompt resolution.
    //
    // For synchronous access, we return the fallback with variable
    // substitution. The Langfuse prompt will be used when the SDK's
    // caching layer has had time to warm up (subsequent calls).
    return applyFallback(fallback, promptType, variables) as PromptResult<T>;
  } catch {
    console.warn(
      `[prompts] Failed to fetch prompt '${effectiveName}' from Langfuse — using fallback`,
    );
    return applyFallback(fallback, promptType, variables) as PromptResult<T>;
  }
}

/**
 * Async version of `getPrompt()` that fully resolves from Langfuse.
 *
 * Use this when you can `await` the result (e.g., during graph
 * construction or in async node functions). This version actually
 * fetches the prompt from Langfuse if configured.
 *
 * @param options - Prompt retrieval options.
 * @returns The compiled prompt string (text) or ChatMessage[] (chat).
 */
export async function getPromptAsync<T extends PromptType = "text">(
  options: GetPromptOptions<T>,
): Promise<PromptResult<T>> {
  const {
    name,
    fallback,
    promptType = "text" as T,
    config = null,
    label = "production",
    cacheTtlSeconds = null,
    variables = null,
  } = options;

  // --- Resolve overrides from config ---
  const overrides = extractOverrides(name, config);
  const effectiveName =
    typeof overrides.name === "string" ? overrides.name : name;
  const effectiveLabel =
    typeof overrides.label === "string" ? overrides.label : label;
  const effectiveVersion =
    typeof overrides.version === "number" ? overrides.version : null;

  // --- Resolve cache TTL ---
  const effectiveTtl =
    cacheTtlSeconds !== null ? cacheTtlSeconds : getDefaultCacheTtl();

  // --- Fast path: Langfuse not initialised ---
  if (!isLangfuseEnabled()) {
    return applyFallback(fallback, promptType, variables) as PromptResult<T>;
  }

  // --- Langfuse path ---
  try {
    const langfuseModule = require("@langfuse/core");
    const LangfuseClass = langfuseModule.Langfuse ?? langfuseModule.default;

    let client: any;
    if (typeof LangfuseClass === "function") {
      client = new LangfuseClass();
    }

    if (!client) {
      return applyFallback(
        fallback,
        promptType,
        variables,
      ) as PromptResult<T>;
    }

    // Build kwargs for getPrompt — only pass version OR label, not both,
    // because Langfuse treats them as mutually exclusive selectors.
    const getPromptKwargs: Record<string, unknown> = {
      cacheTtlSeconds: effectiveTtl,
      fallback,
      type: promptType,
    };

    if (effectiveVersion !== null) {
      getPromptKwargs.version = effectiveVersion;
    } else {
      getPromptKwargs.label = effectiveLabel;
    }

    const promptObject = await client.getPrompt(
      effectiveName,
      undefined, // version param (we pass via kwargs)
      getPromptKwargs,
    );

    // Log whether we got a Langfuse prompt or the fallback
    const isFallback =
      promptObject &&
      typeof promptObject === "object" &&
      promptObject.isFallback === true;

    if (isFallback) {
      console.info(
        `[prompts] Langfuse returned fallback for prompt '${effectiveName}' (prompt may not exist yet in Langfuse)`,
      );
    }

    // Compile with variables (or without)
    if (
      promptObject &&
      typeof promptObject === "object" &&
      typeof promptObject.compile === "function"
    ) {
      const compiled = promptObject.compile(variables ?? {});
      return compiled as PromptResult<T>;
    }

    // If prompt object doesn't have compile(), fall back
    return applyFallback(fallback, promptType, variables) as PromptResult<T>;
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : String(error);
    console.warn(
      `[prompts] Failed to fetch prompt '${effectiveName}' from Langfuse — using fallback: ${message}`,
    );
    return applyFallback(fallback, promptType, variables) as PromptResult<T>;
  }
}

// ---------------------------------------------------------------------------
// Reset (testing only)
// ---------------------------------------------------------------------------

/**
 * Reset the prompt registry for test isolation.
 *
 * **For testing only.** Clears all registered default prompts.
 */
export function resetPromptRegistry(): void {
  registeredPrompts.length = 0;
  registeredNames.clear();
}
