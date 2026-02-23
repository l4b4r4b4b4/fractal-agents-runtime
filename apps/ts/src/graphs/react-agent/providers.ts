/**
 * Multi-provider LLM factory for the ReAct agent graph.
 *
 * Provides a `createChatModel()` factory that selects the correct LangChain
 * chat model class based on the `provider:model` naming convention used by
 * both the Python and TypeScript runtimes.
 *
 * Two code paths:
 *   1. **Custom endpoint** (`base_url` is set) → `ChatOpenAI` with custom
 *      `configuration.baseURL`. Supports vLLM, Ollama, LiteLLM, and any
 *      other OpenAI-compatible API.
 *   2. **Standard provider** (no `base_url`) → `initChatModel` from
 *      `langchain`, which dynamically resolves the provider from the
 *      `provider:model` string and instantiates the correct class.
 *
 * Supported providers:
 *   - `openai:*`    → `ChatOpenAI`      (`@langchain/openai`)
 *   - `anthropic:*` → `ChatAnthropic`   (`@langchain/anthropic`)
 *   - `google:*`    → `ChatGoogleGenAI` (`@langchain/google-genai`)
 *   - `custom:`     → `ChatOpenAI` with custom `baseURL`
 *   - No prefix     → defaults to OpenAI
 *
 * Reference: apps/python/src/graphs/react_agent/agent.py → graph()
 */

import { initChatModel } from "langchain";
import { ChatOpenAI } from "@langchain/openai";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

import type { GraphConfigValues } from "./configuration";

// ---------------------------------------------------------------------------
// Provider prefix parsing
// ---------------------------------------------------------------------------

/**
 * Extract the provider prefix from a `provider:model` string.
 *
 * @param modelName - Full model name in `provider:model` format.
 * @returns The provider portion (before the colon), or `"openai"` as default.
 *
 * @example
 *   extractProvider("anthropic:claude-sonnet-4-0") // → "anthropic"
 *   extractProvider("gpt-4o")                      // → "openai"
 *   extractProvider("custom:")                     // → "custom"
 */
export function extractProvider(modelName: string): string {
  const colonIndex = modelName.indexOf(":");
  if (colonIndex === -1) {
    return "openai";
  }
  return modelName.slice(0, colonIndex).toLowerCase();
}

/**
 * Extract the model name from a `provider:model` string.
 *
 * @param modelName - Full model name in `provider:model` format.
 * @returns The model name portion (after the colon), or the full string
 *   if no colon is present.
 *
 * @example
 *   extractModelName("openai:gpt-4o")              // → "gpt-4o"
 *   extractModelName("anthropic:claude-sonnet-4-0") // → "claude-sonnet-4-0"
 *   extractModelName("gpt-4o-mini")                 // → "gpt-4o-mini"
 *   extractModelName("custom:")                     // → ""
 */
export function extractModelName(modelName: string): string {
  const colonIndex = modelName.indexOf(":");
  if (colonIndex === -1) {
    return modelName;
  }
  return modelName.slice(colonIndex + 1);
}

// ---------------------------------------------------------------------------
// API key resolution
// ---------------------------------------------------------------------------

/**
 * Map of provider names to their environment variable names.
 */
const PROVIDER_TO_ENV_VAR: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_API_KEY",
};

/**
 * Resolve the API key for the configured model provider.
 *
 * Resolution order:
 * 1. For `custom:` provider:
 *    a. `custom_api_key` from the configurable dict
 *    b. `CUSTOM_API_KEY` environment variable
 *    c. `"EMPTY"` fallback (for local vLLM without auth)
 * 2. For standard providers:
 *    a. `apiKeys` dict in the raw configurable (runtime-injected keys from frontend)
 *    b. Corresponding environment variable (`OPENAI_API_KEY`, etc.)
 *
 * Mirrors Python's `get_api_key_for_model()`.
 *
 * @param provider - The resolved provider name (e.g., `"openai"`, `"anthropic"`, `"custom"`).
 * @param rawConfigurable - The raw configurable dict (may contain `apiKeys` or `custom_api_key`).
 * @returns The API key string, or `undefined` if not found.
 */
export function getApiKeyForProvider(
  provider: string,
  rawConfigurable: Record<string, unknown>,
): string | undefined {
  // Custom endpoint: dedicated resolution chain
  if (provider === "custom") {
    const customKey = rawConfigurable.custom_api_key;
    if (typeof customKey === "string" && customKey.length > 0) {
      return customKey;
    }
    const envKey = process.env.CUSTOM_API_KEY;
    if (envKey && envKey.length > 0) {
      return envKey;
    }
    // Fallback: "EMPTY" for local endpoints without auth (e.g., vLLM)
    return "EMPTY";
  }

  // Standard providers: check apiKeys in config first
  const envVarName = PROVIDER_TO_ENV_VAR[provider];

  const apiKeys = rawConfigurable.apiKeys;
  if (
    apiKeys !== null &&
    apiKeys !== undefined &&
    typeof apiKeys === "object" &&
    envVarName
  ) {
    const keyFromConfig = (apiKeys as Record<string, unknown>)[envVarName];
    if (typeof keyFromConfig === "string" && keyFromConfig.length > 0) {
      return keyFromConfig;
    }
  }

  // Fallback to environment variable
  if (envVarName) {
    const envValue = process.env[envVarName];
    if (envValue && envValue.length > 0) {
      return envValue;
    }
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Chat model factory
// ---------------------------------------------------------------------------

/**
 * Create a chat model instance based on the parsed graph configuration.
 *
 * Uses two code paths mirroring the Python runtime:
 *
 * 1. **Custom endpoint** (`config.base_url` is set):
 *    Creates a `ChatOpenAI` instance with a custom `configuration.baseURL`,
 *    using `custom_model_name` if provided. Supports vLLM, Ollama, LiteLLM,
 *    and any OpenAI-compatible API.
 *
 * 2. **Standard provider** (no `base_url`):
 *    Delegates to `initChatModel` from the `langchain` package, which
 *    dynamically resolves the provider from the `provider:model` string
 *    (e.g., `"anthropic:claude-sonnet-4-0"` → `ChatAnthropic`).
 *
 * @param config - Parsed graph configuration values.
 * @param rawConfigurable - The raw configurable dict for API key extraction.
 * @returns A chat model instance ready for use with the agent.
 *
 * @example
 *   // Standard OpenAI
 *   const model = await createChatModel(
 *     { model_name: "openai:gpt-4o", temperature: 0.7, ... },
 *     {},
 *   );
 *
 *   // Anthropic
 *   const model = await createChatModel(
 *     { model_name: "anthropic:claude-sonnet-4-0", temperature: 0.5, ... },
 *     {},
 *   );
 *
 *   // Custom vLLM endpoint
 *   const model = await createChatModel(
 *     { model_name: "custom:", base_url: "http://localhost:7374/v1", ... },
 *     { custom_api_key: "my-key" },
 *   );
 */
export async function createChatModel(
  config: GraphConfigValues,
  rawConfigurable: Record<string, unknown>,
): Promise<BaseChatModel> {
  const provider = extractProvider(config.model_name);

  // ── Custom endpoint ────────────────────────────────────────────────
  if (config.base_url) {
    const apiKey = getApiKeyForProvider("custom", rawConfigurable);
    const modelName = config.custom_model_name || config.model_name;

    console.log(
      `[providers] Custom endpoint: base_url=${maskUrl(config.base_url)} model=${modelName}`,
    );

    return new ChatOpenAI({
      configuration: {
        baseURL: config.base_url,
      },
      openAIApiKey: apiKey,
      modelName: typeof modelName === "string" ? extractModelName(modelName) : undefined,
      temperature: config.temperature,
      maxTokens: config.max_tokens,
    });
  }

  // ── Standard provider via initChatModel ────────────────────────────
  const apiKey = getApiKeyForProvider(provider, rawConfigurable);

  console.log(
    `[providers] Standard provider: provider=${provider} model=${config.model_name} api_key_present=${Boolean(apiKey)}`,
  );

  const model = await initChatModel(config.model_name, {
    temperature: config.temperature,
    maxTokens: config.max_tokens,
    ...(apiKey ? { apiKey } : {}),
  });

  return model;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Mask a URL for safe logging — shows scheme + host, hides path/query.
 *
 * @param url - The URL string to mask.
 * @returns A masked version safe for logging.
 */
function maskUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}/***`;
  } catch {
    return "***";
  }
}
