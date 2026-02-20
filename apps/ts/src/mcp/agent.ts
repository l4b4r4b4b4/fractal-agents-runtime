/**
 * MCP agent execution — non-streaming agent invocation for MCP tools/call.
 *
 * Port of: apps/python/src/server/agent.py
 *
 * Provides two functions:
 *   - `executeAgentRun(message, options?)` — Invoke the agent with a message
 *     and return the response text. Used by the MCP `tools/call` handler.
 *   - `getAgentToolInfo(assistantId?)` — Introspect the agent's configured
 *     capabilities (MCP sub-tools, model name) for dynamic tool descriptions.
 *
 * These functions are self-contained and reuse existing infrastructure
 * (graph registry, storage, checkpointer) without coupling to any specific
 * route module.
 */

import { getStorage, getCheckpointer } from "../storage/index";
import { resolveGraphFactory } from "../graphs/index";
import { injectTracing } from "../infra/tracing";
import type { Assistant } from "../models/assistant";
import type { Thread } from "../models/thread";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default owner ID for MCP client requests.
 *
 * When the MCP endpoint is called without authentication context, this
 * owner ID is used for storage operations. Matches Python's
 * `DEFAULT_MCP_OWNER = "mcp-client"`.
 */
const DEFAULT_MCP_OWNER = "mcp-client";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build a RunnableConfig for non-streaming agent invocation.
 *
 * Merges assistant-level configurable settings with runtime metadata.
 * Mirrors the Python `_build_mcp_runnable_config()` from `server/agent.py`.
 *
 * @param threadId - Thread ID for conversation continuity.
 * @param assistantId - Assistant identifier.
 * @param assistantConfig - Configuration dict from the assistant record.
 * @param ownerId - Owner/user identity string.
 * @returns A flat configurable dict for the graph factory.
 */
function buildMcpRunnableConfig(
  threadId: string,
  assistantId: string,
  assistantConfig: Record<string, unknown> | null | undefined,
  ownerId: string,
): Record<string, unknown> {
  const runId = crypto.randomUUID();
  const configurable: Record<string, unknown> = {};

  // Layer 1: Assistant-level configuration
  if (assistantConfig && typeof assistantConfig === "object") {
    const assistantConfigurable = (assistantConfig as Record<string, unknown>)
      .configurable;
    if (
      assistantConfigurable &&
      typeof assistantConfigurable === "object"
    ) {
      Object.assign(
        configurable,
        assistantConfigurable as Record<string, unknown>,
      );
    }
  }

  // Layer 2: Runtime metadata
  configurable.run_id = runId;
  configurable.thread_id = threadId;
  configurable.assistant_id = assistantId;
  configurable.owner = ownerId;
  configurable.user_id = ownerId;

  // NOTE: checkpoint_ns intentionally NOT set here.
  //
  // We previously set `checkpoint_ns = "assistant:<id>"` for multi-agent
  // isolation, but LangGraph uses checkpoint_ns internally for subgraph
  // hierarchy (splits on ":" and "|"). Setting it causes getState() to
  // look for a subgraph named "assistant" → ValueError.
  // See docs/MULTI_AGENT_CHECKPOINT_ARCHITECTURE.md for background.

  // Include assistant config reference for graph factory
  if (assistantConfig && typeof assistantConfig === "object") {
    configurable.assistant = assistantConfig;
  }

  return configurable;
}

/**
 * Extract the final AI response text from an agent invocation result.
 *
 * The agent returns `{ messages: [HumanMessage, ..., AIMessage] }`.
 * We walk backward through the message list to find the last AI message
 * and return its content.
 *
 * Mirrors Python's `_extract_response_text()` from `server/agent.py`.
 *
 * @param result - The dict returned by `agent.invoke()`.
 * @returns The text content of the last AI message, or a JSON fallback.
 */
function extractResponseText(result: Record<string, unknown>): string {
  const messages = result.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return JSON.stringify(result);
  }

  // Walk backward to find the last AI message
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message === null || message === undefined) {
      continue;
    }

    // LangChain message object — check for _getType or type field
    const messageType =
      typeof message._getType === "function"
        ? message._getType()
        : typeof message.type === "string"
          ? message.type
          : null;

    if (messageType === "ai") {
      const content = message.content;

      if (typeof content === "string") {
        return content;
      }

      // Handle list-of-dicts content (multimodal)
      if (Array.isArray(content)) {
        const textParts: string[] = [];
        for (const part of content) {
          if (typeof part === "object" && part !== null && part.type === "text") {
            textParts.push(String(part.text ?? ""));
          } else if (typeof part === "string") {
            textParts.push(part);
          }
        }
        return textParts.length > 0 ? textParts.join("\n") : String(content);
      }

      return String(content);
    }
  }

  // Fallback: no AI message found
  console.warn("[mcp-agent] No AI message found in agent result; returning raw JSON");
  return JSON.stringify(result);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Options for `executeAgentRun()`.
 */
export interface ExecuteAgentRunOptions {
  /** Optional thread ID for conversation continuity. If omitted, a new thread is created. */
  threadId?: string | null;

  /** Assistant ID to use. Defaults to `"agent"`. */
  assistantId?: string;

  /** Owner/user identity. Defaults to `"mcp-client"`. */
  ownerId?: string;
}

/**
 * Execute the LangGraph agent with a message and return the response text.
 *
 * This is the non-streaming counterpart to `executeRunStream` in
 * `routes/streams.ts`. It is used by the MCP `tools/call` handler and can
 * be reused by any integration that needs a simple request → response
 * interface.
 *
 * The function:
 *   1. Looks up the assistant config from storage (falls back to defaults).
 *   2. Creates or reuses a thread.
 *   3. Builds a configurable dict with merged assistant + runtime settings.
 *   4. Calls the graph factory to build the LangGraph agent.
 *   5. Invokes the agent with `.invoke()` (non-streaming).
 *   6. Extracts the last AI message content from the result.
 *
 * Mirrors Python's `execute_agent_run()` from `server/agent.py`.
 *
 * @param message - The user message to send to the agent.
 * @param options - Optional thread ID, assistant ID, and owner ID.
 * @returns The agent's text response.
 * @throws Error if agent construction or invocation fails.
 */
export async function executeAgentRun(
  message: string,
  options?: ExecuteAgentRunOptions,
): Promise<string> {
  const assistantId = options?.assistantId ?? "agent";
  const ownerId = options?.ownerId ?? DEFAULT_MCP_OWNER;
  let threadId = options?.threadId ?? null;

  const storage = getStorage();

  // --- Resolve assistant config ---

  let assistantConfig: Record<string, unknown> | null = null;
  let graphId: string | null = null;
  let resolvedAssistant: Assistant | null = null;

  try {
    resolvedAssistant = await storage.assistants.get(assistantId, ownerId);

    if (resolvedAssistant === null) {
      // Try matching by graph_id (common pattern)
      const allAssistants = await storage.assistants.search({}, ownerId);
      resolvedAssistant =
        allAssistants.find(
          (candidate) => candidate.graph_id === assistantId,
        ) ?? null;
    }

    if (resolvedAssistant !== null) {
      const config = resolvedAssistant.config;
      if (config && typeof config === "object") {
        assistantConfig = config as Record<string, unknown>;
      }
      graphId = resolvedAssistant.graph_id;
    }
  } catch (assistantError: unknown) {
    const errorMessage =
      assistantError instanceof Error
        ? assistantError.message
        : String(assistantError);
    console.warn(
      `[mcp-agent] Failed to load assistant ${assistantId}: ${errorMessage} — using defaults`,
    );
  }

  // --- Resolve thread ---

  if (threadId === null) {
    const thread: Thread = await storage.threads.create({}, ownerId);
    threadId = thread.thread_id;
    console.log(`[mcp-agent] Created new thread ${threadId} for MCP run`);
  } else {
    // Verify thread exists; create if missing
    const existingThread = await storage.threads.get(threadId, ownerId);
    if (existingThread === null) {
      const newThread: Thread = await storage.threads.create({}, ownerId);
      threadId = newThread.thread_id;
      console.log(
        `[mcp-agent] Thread not found — created new thread ${threadId}`,
      );
    }
  }

  // --- Build config & agent ---

  const runnableConfig = buildMcpRunnableConfig(
    threadId,
    assistantId,
    assistantConfig,
    ownerId,
  );

  // Inject Langfuse tracing (no-op if not configured)
  const tracedConfig = injectTracing(runnableConfig, {
    userId: ownerId,
    sessionId: threadId,
    traceName: "mcp-invoke",
    tags: ["bun", "mcp"],
  });

  const configToUse =
    tracedConfig !== null && typeof tracedConfig === "object"
      ? (tracedConfig as Record<string, unknown>)
      : runnableConfig;

  console.log(
    `[mcp-agent] Building agent; assistant_id=${assistantId} thread_id=${threadId}`,
  );

  // Resolve the graph factory from the assistant's graph_id.
  const buildGraph = resolveGraphFactory(graphId ?? undefined);

  const agent = (await buildGraph(configToUse, {
    checkpointer: getCheckpointer(),
  })) as {
    invoke: (
      input: Record<string, unknown>,
      config?: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>;
    getState: (
      config: Record<string, unknown>,
    ) => Promise<{ values: Record<string, unknown> }>;
  };

  // --- Invoke ---

  const inputMessage = {
    content: message,
    type: "human",
    id: crypto.randomUUID(),
  };

  const agentInput = { messages: [inputMessage] };
  const invokeConfig = {
    configurable: {
      thread_id: threadId,
      ...configToUse,
    },
  };

  console.log(
    `[mcp-agent] Invoking agent with ${message.length}-char message`,
  );

  const result = await agent.invoke(agentInput, invokeConfig);

  // --- Read full accumulated state from checkpointer ---

  let finalValues: Record<string, unknown> | null = null;
  try {
    const checkpointState = await agent.getState(invokeConfig);
    if (checkpointState && checkpointState.values) {
      const accumulatedMessages = checkpointState.values.messages;
      if (Array.isArray(accumulatedMessages) && accumulatedMessages.length > 0) {
        const finalMessages: Array<Record<string, unknown>> = [];
        for (const message of accumulatedMessages) {
          if (message && typeof message === "object") {
            if (typeof message.model_dump === "function") {
              finalMessages.push(message.model_dump());
            } else if (typeof message.toJSON === "function") {
              finalMessages.push(message.toJSON());
            } else {
              finalMessages.push({
                content: message.content ?? "",
                type: message.type ?? message._getType?.() ?? "unknown",
                id: message.id ?? null,
              });
            }
          }
        }
        finalValues = { messages: finalMessages };
        console.log(
          `[mcp-agent] Read ${accumulatedMessages.length} accumulated messages from checkpointer for thread ${threadId}`,
        );
      }
    }
  } catch (stateReadError: unknown) {
    const errorMessage =
      stateReadError instanceof Error
        ? stateReadError.message
        : String(stateReadError);
    console.warn(
      `[mcp-agent] Failed to read accumulated state from checkpointer for thread ${threadId}: ${errorMessage}`,
    );
  }

  // Fallback: use current run's messages if checkpointer read failed
  if (finalValues === null) {
    const fallbackMessages: Array<Record<string, unknown>> = [];
    const resultMessages = result.messages;
    if (Array.isArray(resultMessages)) {
      for (const message of resultMessages) {
        if (message && typeof message === "object") {
          if (typeof message.toJSON === "function") {
            fallbackMessages.push(message.toJSON());
          } else {
            fallbackMessages.push({
              content: message.content ?? "",
              type: message.type ?? "unknown",
              id: message.id ?? null,
            });
          }
        }
      }
    }
    finalValues = { messages: fallbackMessages };
  }

  // --- Extract response ---

  const responseText = extractResponseText(result);
  console.log(
    `[mcp-agent] Completed; response length=${responseText.length} chars`,
  );

  // --- Persist final state ---

  try {
    await storage.threads.addStateSnapshot(
      threadId,
      { values: finalValues },
      ownerId,
    );
    await storage.threads.update(threadId, { values: finalValues }, ownerId);
  } catch (persistError: unknown) {
    const errorMessage =
      persistError instanceof Error
        ? persistError.message
        : String(persistError);
    // Persistence failure should not prevent returning the response
    console.warn(`[mcp-agent] Failed to persist MCP run state: ${errorMessage}`);
  }

  return responseText;
}

/**
 * Agent tool introspection info returned by `getAgentToolInfo()`.
 */
export interface AgentToolInfo {
  /** Names of MCP sub-tools available to the agent. */
  mcpTools: string[];

  /** First MCP server URL (for display purposes). */
  mcpUrl: string | null;

  /** Model name configured for the agent. */
  modelName: string | null;
}

/**
 * Introspect the agent's configured tools for dynamic MCP tool listing.
 *
 * Queries the assistant config from storage and extracts information
 * about available sub-tools (MCP tools, model name).
 *
 * Mirrors Python's `get_agent_tool_info()` from `server/agent.py`.
 *
 * @param assistantId - Assistant ID to inspect. Defaults to `"agent"`.
 * @param ownerId - Owner identity for storage access. Defaults to `"mcp-client"`.
 * @returns Tool metadata for building dynamic MCP tool descriptions.
 */
export async function getAgentToolInfo(
  assistantId: string = "agent",
  ownerId: string = DEFAULT_MCP_OWNER,
): Promise<AgentToolInfo> {
  const info: AgentToolInfo = {
    mcpTools: [],
    mcpUrl: null,
    modelName: null,
  };

  try {
    const storage = getStorage();
    let foundAssistant: Assistant | null = await storage.assistants.get(assistantId, ownerId);

    if (foundAssistant === null) {
      const allAssistants = await storage.assistants.search({}, ownerId);
      foundAssistant =
        allAssistants.find(
          (candidate) => candidate.graph_id === assistantId,
        ) ?? null;
    }

    if (foundAssistant === null) {
      return info;
    }

    // Extract configurable from assistant config
    const config = foundAssistant.config;
    if (!config || typeof config !== "object") {
      return info;
    }

    const configDict = config as unknown as Record<string, unknown>;
    const configurable = configDict.configurable;
    if (!configurable || typeof configurable !== "object") {
      return info;
    }

    const configurableDict = configurable as Record<string, unknown>;

    // Model name
    if (typeof configurableDict.model_name === "string") {
      info.modelName = configurableDict.model_name;
    }

    // MCP tools (multi-server MCP config)
    const mcpConfig = configurableDict.mcp_config;
    if (mcpConfig && typeof mcpConfig === "object") {
      const mcpConfigDict = mcpConfig as Record<string, unknown>;
      const servers = mcpConfigDict.servers;

      if (Array.isArray(servers)) {
        const mcpUrls: string[] = [];
        const mcpToolNames: string[] = [];

        for (const server of servers) {
          if (!server || typeof server !== "object") {
            continue;
          }

          const serverDict = server as Record<string, unknown>;

          if (typeof serverDict.url === "string" && serverDict.url.length > 0) {
            mcpUrls.push(serverDict.url);
          }

          const toolsValue = serverDict.tools;
          if (Array.isArray(toolsValue)) {
            for (const toolName of toolsValue) {
              if (typeof toolName === "string") {
                mcpToolNames.push(toolName);
              }
            }
          }
        }

        info.mcpUrl = mcpUrls.length > 0 ? mcpUrls[0] : null;
        info.mcpTools = [...new Set(mcpToolNames)].sort();
      }
    }
  } catch (introspectionError: unknown) {
    const errorMessage =
      introspectionError instanceof Error
        ? introspectionError.message
        : String(introspectionError);
    console.warn(
      `[mcp-agent] Failed to introspect agent tools for assistant ${assistantId}: ${errorMessage}`,
    );
  }

  return info;
}
