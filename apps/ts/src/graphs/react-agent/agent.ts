/**
 * ReAct agent graph factory — portable graph architecture.
 *
 * This module provides a self-contained ReAct agent graph built on LangGraph
 * via LangChain v1's `createAgent`. The graph factory uses dependency injection
 * for persistence — it never imports from any specific runtime.
 *
 * v0.0.2 changes:
 *   - Model creation delegated to `providers.ts` via `createChatModel()`
 *   - Supports OpenAI, Anthropic, Google, and custom OpenAI-compatible endpoints
 *   - Provider prefix parsing and API key resolution moved to `providers.ts`
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
import type { BaseCheckpointSaver } from "@langchain/langgraph";

import type { GraphFactory, GraphFactoryOptions } from "../types";
import {
  parseGraphConfig,
  getEffectiveSystemPrompt,
} from "./configuration";
import { createChatModel } from "./providers";

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
 * 2. Creates a chat model via the multi-provider factory (`createChatModel`).
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
 *   // OpenAI (default)
 *   const agent = await graph(
 *     { model_name: "openai:gpt-4o", temperature: 0.5 },
 *     { checkpointer: new MemorySaver() },
 *   );
 *
 *   // Anthropic
 *   const agent = await graph(
 *     { model_name: "anthropic:claude-sonnet-4-0" },
 *   );
 *
 *   // Custom vLLM endpoint
 *   const agent = await graph(
 *     { model_name: "custom:", base_url: "http://localhost:7374/v1" },
 *   );
 */
export const graph: GraphFactory = async function graph(
  config: Record<string, unknown>,
  options?: GraphFactoryOptions,
): Promise<unknown> {
  const parsedConfig = parseGraphConfig(config);

  // Create the chat model using the multi-provider factory.
  // Supports openai:*, anthropic:*, google:*, custom: prefixes.
  const model = await createChatModel(parsedConfig, config);

  const effectiveSystemPrompt = getEffectiveSystemPrompt(parsedConfig);

  // Build the agent using LangChain v1's createAgent.
  // No tools in v0.0.2 — MCP and RAG are deferred to later goals.
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
