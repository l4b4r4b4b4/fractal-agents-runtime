/**
 * Graphs — LangGraph agent definitions and registry.
 *
 * This module is the main entry point for the graph subsystem. It
 * re-exports the graph registry API and ensures built-in graphs are
 * registered at import time (via the registry module's auto-registration).
 *
 * Usage:
 *
 *   import { resolveGraphFactory, getAvailableGraphIds } from "../graphs";
 *
 *   const factory = resolveGraphFactory(assistant.graph_id);
 *   const agent = await factory(config, { checkpointer });
 *
 *   const graphIds = getAvailableGraphIds(); // ["agent"]
 *
 * Reference: apps/python/src/graphs/__init__.py
 */

export {
  registerGraph,
  registerGraphLazy,
  resolveGraphFactory,
  getAvailableGraphIds,
  isGraphRegistered,
  resetRegistry,
} from "./registry";

export { DEFAULT_GRAPH_ID, type GraphFactory, type GraphFactoryOptions } from "./types";
