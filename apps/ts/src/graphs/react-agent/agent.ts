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
import { fetchMcpTools } from "./utils/mcp-tools";
import { createRagTools } from "./utils/rag-tools";
import { createArchiveSearchTool } from "./utils/chromadb-rag";

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
 * 4. If `mcp_config` is set, fetches tools from remote MCP servers.
 * 5. Calls `createAgent()` with the model, tools, and system prompt.
 * 6. Returns the compiled graph (supports `.invoke()` and `.stream()`).
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

  // -----------------------------------------------------------------------
  // MCP tool loading — fetch tools from remote MCP servers.
  //
  // When the assistant has `mcp_config.servers` configured, the agent
  // dynamically loads tools from those servers. Auth-required servers
  // receive the Supabase access token via OAuth2 token exchange.
  //
  // Graceful degradation: if any server is unreachable or token exchange
  // fails, the agent continues without those tools (logged as warnings).
  //
  // Reference: apps/python/src/graphs/react_agent/agent.py (MCP section)
  // -----------------------------------------------------------------------

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tools: any[] = [];

  // The Supabase access token is injected into the configurable dict by
  // buildRunnableConfig() in runs.ts (mirroring Python's x-supabase-access-token).
  const supabaseToken =
    typeof config["x-supabase-access-token"] === "string"
      ? (config["x-supabase-access-token"] as string)
      : null;

  // -----------------------------------------------------------------------
  // RAG tool loading — create tools for Supabase vector collections.
  //
  // When the assistant has `rag` configured with a URL and collection IDs,
  // and a Supabase access token is available, the agent creates one tool
  // per collection that searches for semantically similar documents.
  //
  // Graceful degradation: if any collection is unreachable, the agent
  // continues without that tool (logged as warnings).
  //
  // Reference: apps/python/src/graphs/react_agent/agent.py (RAG section)
  // -----------------------------------------------------------------------

  if (
    parsedConfig.rag &&
    parsedConfig.rag.rag_url &&
    parsedConfig.rag.collections &&
    supabaseToken
  ) {
    try {
      const ragTools = await createRagTools(parsedConfig.rag, supabaseToken);
      tools.push(...ragTools);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[agent] RAG tool loading failed: ${message}`);
    }
  }

  // -----------------------------------------------------------------------
  // ChromaDB archive RAG — dynamically register search_archives tool
  // when the platform provides rag_config with archive definitions.
  //
  // This coexists with the LangConnect RAG above — both can be active
  // simultaneously (they use different config keys: `rag` vs `rag_config`).
  //
  // Reference: apps/python/src/graphs/react_agent/agent.py (ChromaDB RAG section)
  // -----------------------------------------------------------------------

  if (
    parsedConfig.rag_config &&
    parsedConfig.rag_config.archives.length > 0
  ) {
    try {
      const archiveTool = await createArchiveSearchTool(parsedConfig.rag_config);
      if (archiveTool) {
        tools.push(archiveTool);
        console.log(
          `[agent] ChromaDB RAG tool registered: archives=${parsedConfig.rag_config.archives.length}`,
        );
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[agent] ChromaDB RAG tool loading failed: ${message}`);
    }
  }

  if (parsedConfig.mcp_config && parsedConfig.mcp_config.servers.length > 0) {
    const mcpTools = await fetchMcpTools(parsedConfig.mcp_config, supabaseToken);
    tools.push(...mcpTools);
  }

  // Build the agent using LangChain v1's createAgent.
  //
  // The checkpointer and store are typed as `unknown` in GraphFactoryOptions
  // to keep the registry decoupled from LangGraph types. We cast here since
  // the agent factory knows the concrete types expected by createAgent.
  const agent = createAgent({
    model,
    tools,
    systemPrompt: effectiveSystemPrompt,
    checkpointer: (options?.checkpointer as BaseCheckpointSaver | undefined),
  });

  return agent;
};
