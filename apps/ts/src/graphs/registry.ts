/**
 * Graph registry — dispatches graph_id to the correct graph factory.
 *
 * This module provides a Map-based registry for resolving graph factory
 * functions from an assistant's `graph_id`. The server layer uses this
 * instead of hard-coding imports to a specific graph package.
 *
 * Built-in graphs register themselves at module load time via lazy imports.
 * The Map-based design is intentionally extensible — a future plugin loader
 * can call `registerGraph()` to add new graph types at startup without
 * modifying this module.
 *
 * Supported built-in graph IDs:
 *
 * - `"agent"` — react-agent factory (ReAct agent, default)
 *
 * Unknown `graph_id` values fall back to the default (`"agent"`).
 *
 * Usage:
 *
 *   import { resolveGraphFactory } from "./registry";
 *
 *   const buildGraph = resolveGraphFactory(assistant.graph_id);
 *   const compiled = await buildGraph(config, { checkpointer });
 *
 * Extending with a custom graph:
 *
 *   import { registerGraph } from "./registry";
 *
 *   registerGraph("my_custom", myCustomGraphFactory);
 *
 * Reference: apps/python/src/graphs/registry.py
 */

import { DEFAULT_GRAPH_ID, type GraphFactory } from "./types";

// ---------------------------------------------------------------------------
// Registry storage
// ---------------------------------------------------------------------------

/**
 * Maps graph_id → factory function.
 *
 * Lazy-loaded factories are wrapped in a closure that imports the module
 * on first invocation, matching the Python `_lazy_import` pattern.
 */
const _GRAPH_REGISTRY = new Map<string, GraphFactory>();

// ---------------------------------------------------------------------------
// Lazy import helper
// ---------------------------------------------------------------------------

/**
 * Create a lazy-loading wrapper around a dynamic import.
 *
 * The actual module is not loaded until the factory is first called.
 * This avoids loading all graph packages at startup — only the graph
 * actually requested by the assistant triggers its import.
 *
 * Mirrors Python's `_lazy_import(module_path, attribute)`.
 *
 * @param modulePath - Path to the module (relative or package path).
 * @param attribute - Name of the exported factory function (default: "graph").
 * @returns A GraphFactory that lazily imports and delegates to the real factory.
 */
function lazyImport(modulePath: string, attribute: string = "graph"): GraphFactory {
  let cached: GraphFactory | null = null;

  const wrapper: GraphFactory = async (
    config: Record<string, unknown>,
    options?,
  ) => {
    if (cached === null) {
      // Dynamic import — resolved relative to this module at runtime.
      const module = await import(modulePath);
      const factory = module[attribute];
      if (typeof factory !== "function") {
        throw new Error(
          `lazyImport: ${modulePath}.${attribute} is not a function (got ${typeof factory})`,
        );
      }
      cached = factory as GraphFactory;
    }
    return cached(config, options);
  };

  // Preserve a human-readable name for debugging (mirrors Python's __qualname__).
  Object.defineProperty(wrapper, "name", {
    value: `lazy(${modulePath}.${attribute})`,
  });

  return wrapper;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Register a graph factory under a given `graph_id`.
 *
 * Calling this with an ID that is already registered will overwrite
 * the existing factory. Use `resetRegistry()` in tests to restore
 * the built-in registrations.
 *
 * @param graphId - Unique identifier (e.g. `"agent"`, `"research_agent"`).
 * @param factory - An async callable matching the `GraphFactory` signature.
 * @throws Error if `graphId` is empty or `factory` is not a function.
 *
 * @example
 *   registerGraph("my_graph", myGraphFactory);
 */
export function registerGraph(graphId: string, factory: GraphFactory): void {
  if (!graphId) {
    throw new Error("registerGraph: graphId must be a non-empty string");
  }
  if (typeof factory !== "function") {
    throw new Error(
      `registerGraph(${JSON.stringify(graphId)}): factory must be a function`,
    );
  }
  _GRAPH_REGISTRY.set(graphId, factory);
}

/**
 * Register a graph factory with lazy loading (imported on first use).
 *
 * This is the recommended approach for built-in graphs to keep startup fast.
 * The module is only imported when the factory is first called.
 *
 * @param graphId - Unique identifier (e.g. `"agent"`).
 * @param modulePath - Path for dynamic `import()` (e.g. `"./react-agent"`).
 * @param attribute - Name of the factory export (default: `"graph"`).
 * @throws Error if `graphId` is empty.
 *
 * @example
 *   registerGraphLazy("agent", "./react-agent", "graph");
 */
export function registerGraphLazy(
  graphId: string,
  modulePath: string,
  attribute: string = "graph",
): void {
  if (!graphId) {
    throw new Error("registerGraphLazy: graphId must be a non-empty string");
  }
  if (!modulePath) {
    throw new Error(
      `registerGraphLazy(${JSON.stringify(graphId)}): modulePath must be a non-empty string`,
    );
  }
  _GRAPH_REGISTRY.set(graphId, lazyImport(modulePath, attribute));
}

/**
 * Resolve a graph factory function from a `graph_id` string.
 *
 * Resolution order:
 * 1. Exact match in registry → return it.
 * 2. Unknown ID → log warning, fall back to `"agent"` (DEFAULT_GRAPH_ID).
 * 3. Null/undefined → fall back to `"agent"`.
 *
 * @param graphId - The assistant's `graph_id` field. Null/undefined and
 *   unrecognised values fall back to `"agent"`.
 * @returns A GraphFactory ready to be called with config.
 * @throws Error if the registry has no `"agent"` entry (should never happen
 *   in normal operation since built-ins are registered at module load).
 *
 * @example
 *   const factory = resolveGraphFactory("agent");
 *   const agent = await factory(config, { checkpointer });
 */
export function resolveGraphFactory(graphId?: string | null): GraphFactory {
  const effectiveId = graphId || DEFAULT_GRAPH_ID;

  const factory = _GRAPH_REGISTRY.get(effectiveId);
  if (factory !== undefined) {
    return factory;
  }

  // Unknown graph_id — fall back to default with warning.
  if (effectiveId !== DEFAULT_GRAPH_ID) {
    console.warn(
      `[graph-registry] Unknown graph_id="${effectiveId}" — falling back to "${DEFAULT_GRAPH_ID}"`,
    );
    const defaultFactory = _GRAPH_REGISTRY.get(DEFAULT_GRAPH_ID);
    if (defaultFactory !== undefined) {
      return defaultFactory;
    }
  }

  // Last resort: registry has no default entry.
  throw new Error(
    `[graph-registry] No factory registered for "${DEFAULT_GRAPH_ID}". ` +
      "Ensure the built-in graphs are registered at startup.",
  );
}

/**
 * Return the list of all registered graph IDs.
 *
 * Useful for the `/info` endpoint, assistant validation, and debugging.
 *
 * @returns Sorted list of graph ID strings.
 */
export function getAvailableGraphIds(): string[] {
  return Array.from(_GRAPH_REGISTRY.keys()).sort();
}

/**
 * Check whether a graph ID is registered.
 *
 * @param graphId - The graph ID to check.
 * @returns `true` if registered, `false` otherwise.
 */
export function isGraphRegistered(graphId: string): boolean {
  return _GRAPH_REGISTRY.has(graphId);
}

/**
 * Clear the registry and re-register built-in graphs.
 *
 * **For testing only.** Restores the registry to its initial state
 * (only built-in graphs registered via lazy import).
 */
export function resetRegistry(): void {
  _GRAPH_REGISTRY.clear();
  _registerBuiltins();
}

// ---------------------------------------------------------------------------
// Built-in graph registration (lazy imports — no packages loaded at startup)
// ---------------------------------------------------------------------------

/**
 * Register the built-in graphs. Called at module load and by `resetRegistry()`.
 *
 * Each built-in is registered lazily so the actual graph module is only
 * imported when first requested. This keeps server startup fast.
 */
function _registerBuiltins(): void {
  registerGraphLazy("agent", "./react-agent/index", "graph");
}

// Auto-register built-ins at module load time.
_registerBuiltins();
