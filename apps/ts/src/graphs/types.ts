/**
 * Shared graph types for the Fractal Agents Runtime — TypeScript/Bun.
 *
 * These types define the contract between the graph registry, graph factories,
 * and the runs system (Task-05). The factory signature mirrors the Python
 * runtime's `async def graph(config, *, checkpointer=None, store=None)`.
 *
 * Reference: apps/python/src/graphs/registry.py → GraphFactory type alias
 */

// ---------------------------------------------------------------------------
// Graph factory options (keyword args in Python)
// ---------------------------------------------------------------------------

/**
 * Options passed to a graph factory alongside the config.
 *
 * Maps to Python's keyword arguments:
 *   `async def graph(config, *, checkpointer=None, store=None)`
 *
 * Both fields are optional — when omitted, the agent runs without
 * persistence (suitable for stateless runs or testing).
 */
export interface GraphFactoryOptions {
  /**
   * Checkpointer for thread state persistence.
   *
   * In v0.0.1: `MemorySaver` from `@langchain/langgraph`.
   * In later goals: `PostgresSaver` for production persistence.
   *
   * Uses `unknown` to avoid coupling the registry to a specific
   * checkpointer implementation. The agent factory knows the concrete type.
   */
  checkpointer?: unknown;

  /**
   * Cross-thread memory store.
   *
   * Not used in v0.0.1 — deferred to Goal 25.
   * Included in the type now so the factory signature doesn't change later.
   */
  store?: unknown;
}

// ---------------------------------------------------------------------------
// Graph factory function
// ---------------------------------------------------------------------------

/**
 * Async function that builds a compiled LangGraph agent from configuration.
 *
 * This is the core abstraction: the graph registry maps `graph_id` strings
 * to these factory functions. The runs system calls the factory to build
 * an agent, then invokes it with user input.
 *
 * Signature mirrors the Python runtime:
 * ```python
 * async def graph(config: RunnableConfig, *, checkpointer=None, store=None):
 *     ...
 *     return compiled_graph
 * ```
 *
 * The `config` parameter is the assistant's configurable dict (flattened).
 * It contains model_name, temperature, system_prompt, etc.
 *
 * Returns a compiled graph object that supports `.invoke()` and `.stream()`.
 * The return type is `unknown` because different graph implementations may
 * return different compiled graph types. The runs system knows how to
 * invoke the specific type returned by each factory.
 *
 * @param config - The assistant's configurable dictionary.
 * @param options - Optional checkpointer and store for persistence.
 * @returns A compiled graph ready for invocation.
 */
export type GraphFactory = (
  config: Record<string, unknown>,
  options?: GraphFactoryOptions,
) => Promise<unknown>;

/**
 * Default graph ID used when the assistant doesn't specify one or the
 * value is not recognised. Matches Python's `DEFAULT_GRAPH_ID = "agent"`.
 */
export const DEFAULT_GRAPH_ID = "agent";
