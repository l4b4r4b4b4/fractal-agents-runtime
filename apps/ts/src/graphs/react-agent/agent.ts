/**
 * ReAct agent graph factory — portable graph architecture.
 *
 * This module provides a self-contained ReAct agent graph built on LangGraph
 * via LangChain v1's `createAgent`. The graph factory uses dependency injection
 * for persistence — it never imports from any specific runtime.
 *
 * v0.0.1 scope:
 *   - OpenAI provider only (ChatOpenAI)
 *   - No MCP tools, no RAG tools
 *   - System prompt from assistant config or default
 *   - MemorySaver checkpointer for thread state persistence
 *   - No multi-provider support (deferred to Goal 25)
 *   - No Langfuse prompt management (deferred to Goal 27)
 *
 * The factory signature mirrors the Python runtime:
 *   `async def graph(config, *, checkpointer=None, store=None)`
 *
 * Usage:
 *
 *   import { graph } from "./react-agent";
 *
 *   const agent = await graph(
 *     { model_name: "openai:gpt-4o", temperature: 0.7 },
 *     { checkpointer: new MemorySaver() },
 *   );
 *
 *   const result = await agent.invoke(
 *     { messages: [{ role: "user", content: "Hello!" }] },
 *     { configurable: { thread_id: "thread-1" } },
 *   );
 *
 * Reference: apps/python/src/graphs/react_agent/agent.py → graph()
 */

import { createAgent } from "langchain";
import { ChatOpenAI } from "@langchain/openai";
import type { BaseCheckpointSaver } from "@langchain/langgraph";

import type { GraphFactory, GraphFactoryOptions } from "../types";
import {
  parseGraphConfig,
  getEffectiveSystemPrompt,
  type GraphConfigValues,
} from "./configuration";

// ---------------------------------------------------------------------------
// Model name parsing
// ---------------------------------------------------------------------------

/**
 * Extract the model name from a `provider:model` string.
 *
 * The Python runtime uses the `provider:model` convention (e.g.,
 * `"openai:gpt-4o"`, `"anthropic:claude-3-5-sonnet-latest"`).
 *
 * In v0.0.1, only OpenAI is supported. The provider prefix is stripped
 * to produce the model name that ChatOpenAI expects.
 *
 * @param modelName - Full model name in `provider:model` format.
 * @returns The model name portion (after the colon), or the full string
 *   if no colon is present.
 */
function extractModelName(modelName: string): string {
  const colonIndex = modelName.indexOf(":");
  if (colonIndex === -1) {
    return modelName;
  }
  return modelName.slice(colonIndex + 1);
}

/**
 * Extract the provider prefix from a `provider:model` string.
 *
 * @param modelName - Full model name in `provider:model` format.
 * @returns The provider portion (before the colon), or "openai" as default.
 */
function extractProvider(modelName: string): string {
  const colonIndex = modelName.indexOf(":");
  if (colonIndex === -1) {
    return "openai";
  }
  return modelName.slice(0, colonIndex).toLowerCase();
}

// ---------------------------------------------------------------------------
// API key resolution
// ---------------------------------------------------------------------------

/**
 * Get the API key for the configured model provider.
 *
 * Resolution order:
 * 1. `apiKeys` dict in the config (runtime-injected keys)
 * 2. Environment variable (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, etc.)
 *
 * Mirrors Python's `get_api_key_for_model()`.
 *
 * @param config - Parsed graph configuration values.
 * @param rawConfig - The raw configurable dict (may contain apiKeys).
 * @returns The API key string, or `undefined` if not found.
 */
function getApiKeyForModel(
  config: GraphConfigValues,
  rawConfig: Record<string, unknown>,
): string | undefined {
  const provider = extractProvider(config.model_name);

  const providerToEnvVar: Record<string, string> = {
    openai: "OPENAI_API_KEY",
    anthropic: "ANTHROPIC_API_KEY",
    google: "GOOGLE_API_KEY",
  };

  const envVarName = providerToEnvVar[provider];

  // Check apiKeys in config (runtime-injected, e.g. from frontend)
  const apiKeys = rawConfig.apiKeys;
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
    return process.env[envVarName] || undefined;
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Graph factory
// ---------------------------------------------------------------------------

/**
 * Build a compiled ReAct agent graph from configuration.
 *
 * This is the main factory function registered in the graph registry
 * under the `"agent"` ID. It:
 *
 * 1. Parses the configurable dict into typed `GraphConfigValues`.
 * 2. Creates a `ChatOpenAI` model with the configured parameters.
 * 3. Resolves the effective system prompt (user config + uneditable suffix).
 * 4. Calls `createAgent()` with the model, empty tools, and system prompt.
 * 5. Returns the compiled graph (supports `.invoke()` and `.stream()`).
 *
 * The `checkpointer` and `store` options are passed through to the
 * compiled graph for thread state persistence.
 *
 * @param config - The assistant's configurable dictionary.
 * @param options - Optional checkpointer and store for persistence.
 * @returns A compiled graph ready for invocation.
 *
 * @example
 *   const agent = await graph(
 *     { model_name: "openai:gpt-4o", temperature: 0.5 },
 *     { checkpointer: new MemorySaver() },
 *   );
 */
export const graph: GraphFactory = async function graph(
  config: Record<string, unknown>,
  options?: GraphFactoryOptions,
): Promise<unknown> {
  const parsedConfig = parseGraphConfig(config);

  const modelName = extractModelName(parsedConfig.model_name);
  const apiKey = getApiKeyForModel(parsedConfig, config);

  // Build the ChatOpenAI model.
  // In v0.0.1, only OpenAI is supported. Multi-provider via init_chat_model
  // is deferred to Goal 25.
  const model = new ChatOpenAI({
    modelName: modelName,
    temperature: parsedConfig.temperature,
    maxTokens: parsedConfig.max_tokens,
    ...(apiKey ? { openAIApiKey: apiKey } : {}),
  });

  const effectiveSystemPrompt = getEffectiveSystemPrompt(parsedConfig);

  // Build the agent using LangChain v1's createAgent.
  // No tools in v0.0.1 — MCP and RAG are deferred to later goals.
  //
  // The checkpointer and store are typed as `unknown` in GraphFactoryOptions
  // to keep the registry decoupled from LangGraph types. We cast here since
  // the agent factory knows the concrete types expected by createAgent.
  const agent = createAgent({
    model,
    tools: [],
    systemPrompt: effectiveSystemPrompt,
    checkpointer: (options?.checkpointer as BaseCheckpointSaver | undefined),
  });

  return agent;
};
