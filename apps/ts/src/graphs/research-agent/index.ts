/**
 * Research Agent — two-phase parallel research with human-in-the-loop.
 *
 * This package provides a self-contained research agent graph built on
 * LangGraph with parallel worker fan-out, aggregation, and HIL review.
 *
 * The graph factory uses dependency injection for persistence — it never
 * imports from any specific runtime.
 *
 * Usage:
 *
 *   import { graph } from "../graphs/research-agent";
 *
 *   // Build the agent — runtime injects persistence
 *   const agent = await graph(config, { checkpointer });
 *
 * Reference: apps/python/src/graphs/research_agent/__init__.py
 */

export { graph } from "./agent";
export {
  parseResearchConfig,
  DEFAULT_MODEL_NAME,
  DEFAULT_TEMPERATURE,
  DEFAULT_MAX_WORKER_ITERATIONS,
  type ResearchAgentConfig,
  type RagConfig,
  type McpConfig,
  type McpServerConfig,
} from "./configuration";
export { PROMPT_NAMES } from "./prompts";
export {
  extractWorkerOutput,
  type ResearchResult,
  type WorkerOutput,
  type TaskDict,
} from "./worker";
