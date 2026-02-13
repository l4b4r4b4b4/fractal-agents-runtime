/**
 * ReAct agent with configurable LLM — portable graph architecture.
 *
 * This package provides a self-contained ReAct agent graph built on LangGraph
 * via LangChain v1's `createAgent`, with OpenAI provider support and
 * configurable system prompts.
 *
 * The graph factory uses dependency injection for persistence — it never
 * imports from any specific runtime.
 *
 * Usage:
 *
 *   import { graph } from "../graphs/react-agent";
 *
 *   // Build the agent — runtime injects persistence
 *   const agent = await graph(config, { checkpointer });
 *
 * Reference: apps/python/src/graphs/react_agent/__init__.py
 */

export { graph } from "./agent";
export {
  parseGraphConfig,
  getEffectiveSystemPrompt,
  DEFAULT_MODEL_NAME,
  DEFAULT_TEMPERATURE,
  DEFAULT_MAX_TOKENS,
  DEFAULT_SYSTEM_PROMPT,
  UNEDITABLE_SYSTEM_PROMPT,
  type GraphConfigValues,
} from "./configuration";
