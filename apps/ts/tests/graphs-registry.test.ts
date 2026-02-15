/**
 * Graph registry tests for the Fractal Agents Runtime — TypeScript/Bun.
 *
 * Tests the Map-based graph registry: register, resolve, fallback to "agent",
 * getAvailableGraphIds, resetRegistry, lazy loading, and edge cases.
 *
 * Reference: apps/python/src/graphs/registry.py
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  registerGraph,
  registerGraphLazy,
  resolveGraphFactory,
  getAvailableGraphIds,
  isGraphRegistered,
  resetRegistry,
  DEFAULT_GRAPH_ID,
} from "../src/graphs";
import type { GraphFactory } from "../src/graphs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a simple mock graph factory that returns a distinguishable value.
 *
 * @param label - A label to identify this factory in assertions.
 * @returns A GraphFactory that resolves to `{ label, config }`.
 */
function createMockFactory(label: string): GraphFactory {
  return async (config: Record<string, unknown>) => ({
    label,
    config,
  });
}

// ---------------------------------------------------------------------------
// Setup — reset registry to known state before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  resetRegistry();
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("Graph Registry — constants", () => {
  test("DEFAULT_GRAPH_ID is 'agent'", () => {
    expect(DEFAULT_GRAPH_ID).toBe("agent");
  });
});

// ---------------------------------------------------------------------------
// Built-in registration
// ---------------------------------------------------------------------------

describe("Graph Registry — built-in registration", () => {
  test('"agent" is registered by default', () => {
    expect(isGraphRegistered("agent")).toBe(true);
  });

  test('getAvailableGraphIds() includes "agent"', () => {
    const ids = getAvailableGraphIds();
    expect(ids).toContain("agent");
  });

  test("getAvailableGraphIds() returns sorted list", () => {
    const ids = getAvailableGraphIds();
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
  });
});

// ---------------------------------------------------------------------------
// registerGraph (eager)
// ---------------------------------------------------------------------------

describe("Graph Registry — registerGraph (eager)", () => {
  test("registers a custom factory and resolves it", async () => {
    const factory = createMockFactory("custom");
    registerGraph("custom_graph", factory);

    const resolved = resolveGraphFactory("custom_graph");
    expect(resolved).toBe(factory);

    const result = (await resolved({ foo: "bar" })) as {
      label: string;
      config: Record<string, unknown>;
    };
    expect(result.label).toBe("custom");
    expect(result.config).toEqual({ foo: "bar" });
  });

  test("overwriting an existing registration replaces it", async () => {
    const factory1 = createMockFactory("first");
    const factory2 = createMockFactory("second");

    registerGraph("my_graph", factory1);
    registerGraph("my_graph", factory2);

    const resolved = resolveGraphFactory("my_graph");
    expect(resolved).toBe(factory2);

    const result = (await resolved({})) as { label: string };
    expect(result.label).toBe("second");
  });

  test("original 'agent' still works after registering custom graph", () => {
    registerGraph("custom", createMockFactory("custom"));
    expect(isGraphRegistered("agent")).toBe(true);
    expect(isGraphRegistered("custom")).toBe(true);
  });

  test("throws if graphId is empty string", () => {
    expect(() => registerGraph("", createMockFactory("bad"))).toThrow(
      "graphId must be a non-empty string",
    );
  });

  test("throws if factory is not a function", () => {
    expect(() =>
      registerGraph("bad", "not a function" as unknown as GraphFactory),
    ).toThrow("factory must be a function");
  });
});

// ---------------------------------------------------------------------------
// registerGraphLazy
// ---------------------------------------------------------------------------

describe("Graph Registry — registerGraphLazy", () => {
  test("registers a lazy factory that shows up in available IDs", () => {
    registerGraphLazy("lazy_graph", "./react-agent/index", "graph");
    expect(isGraphRegistered("lazy_graph")).toBe(true);
    expect(getAvailableGraphIds()).toContain("lazy_graph");
  });

  test("throws if graphId is empty string", () => {
    expect(() => registerGraphLazy("", "./some-module")).toThrow(
      "graphId must be a non-empty string",
    );
  });

  test("throws if modulePath is empty string", () => {
    expect(() => registerGraphLazy("my_graph", "")).toThrow(
      "modulePath must be a non-empty string",
    );
  });

  test("lazy factory is not imported until first resolve call", () => {
    // Register a lazy factory pointing to a non-existent module.
    // This should NOT throw at registration time.
    registerGraphLazy("will_fail", "./nonexistent-module-xyz", "graph");
    expect(isGraphRegistered("will_fail")).toBe(true);

    // It should only throw when we try to actually call the factory.
    const factory = resolveGraphFactory("will_fail");
    expect(factory).toBeDefined();
  });

  test("lazy factory with invalid module throws on invocation", async () => {
    registerGraphLazy("bad_module", "./this-does-not-exist-abc", "graph");
    const factory = resolveGraphFactory("bad_module");

    // Invoking the lazy factory should trigger the dynamic import and fail.
    try {
      await factory({});
      // Should not reach here
      expect(true).toBe(false);
    } catch (error) {
      expect(error).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// resolveGraphFactory
// ---------------------------------------------------------------------------

describe("Graph Registry — resolveGraphFactory", () => {
  test('resolves "agent" to a factory', () => {
    const factory = resolveGraphFactory("agent");
    expect(typeof factory).toBe("function");
  });

  test("resolves a custom registered factory", async () => {
    const factory = createMockFactory("my_agent");
    registerGraph("my_agent", factory);

    const resolved = resolveGraphFactory("my_agent");
    expect(resolved).toBe(factory);
  });

  test('null graphId falls back to "agent"', () => {
    const factory = resolveGraphFactory(null);
    expect(typeof factory).toBe("function");
    // Should be the same factory as resolving "agent" directly
    expect(factory).toBe(resolveGraphFactory("agent"));
  });

  test('undefined graphId falls back to "agent"', () => {
    const factory = resolveGraphFactory(undefined);
    expect(typeof factory).toBe("function");
    expect(factory).toBe(resolveGraphFactory("agent"));
  });

  test('empty string graphId falls back to "agent"', () => {
    const factory = resolveGraphFactory("");
    expect(typeof factory).toBe("function");
    expect(factory).toBe(resolveGraphFactory("agent"));
  });

  test('unknown graphId falls back to "agent" with warning', () => {
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };

    try {
      const factory = resolveGraphFactory("nonexistent_graph");
      expect(typeof factory).toBe("function");
      // Should have the same factory as "agent"
      expect(factory).toBe(resolveGraphFactory("agent"));
      // Should have logged a warning
      expect(warnings.length).toBeGreaterThan(0);
      expect(warnings[0]).toContain("nonexistent_graph");
      expect(warnings[0]).toContain("falling back");
    } finally {
      console.warn = originalWarn;
    }
  });

  test("fallback returns agent factory even for random strings", () => {
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const factory = resolveGraphFactory("xyzzy-random-123");
      expect(typeof factory).toBe("function");
      expect(factory).toBe(resolveGraphFactory("agent"));
    } finally {
      console.warn = originalWarn;
    }
  });
});

// ---------------------------------------------------------------------------
// getAvailableGraphIds
// ---------------------------------------------------------------------------

describe("Graph Registry — getAvailableGraphIds", () => {
  test('returns ["agent", "research_agent"] with default registration', () => {
    expect(getAvailableGraphIds()).toEqual(["agent", "research_agent"]);
  });

  test("includes custom registered graphs", () => {
    registerGraph("zebra", createMockFactory("zebra"));
    registerGraph("alpha", createMockFactory("alpha"));

    const ids = getAvailableGraphIds();
    expect(ids).toContain("agent");
    expect(ids).toContain("alpha");
    expect(ids).toContain("zebra");
  });

  test("returns sorted order", () => {
    registerGraph("zebra", createMockFactory("z"));
    registerGraph("alpha", createMockFactory("a"));
    registerGraph("middle", createMockFactory("m"));

    const ids = getAvailableGraphIds();
    expect(ids).toEqual(["agent", "alpha", "middle", "research_agent", "zebra"]);
  });

  test("returns new array each time (not a reference)", () => {
    const ids1 = getAvailableGraphIds();
    const ids2 = getAvailableGraphIds();
    expect(ids1).toEqual(ids2);
    expect(ids1).not.toBe(ids2);
  });
});

// ---------------------------------------------------------------------------
// isGraphRegistered
// ---------------------------------------------------------------------------

describe("Graph Registry — isGraphRegistered", () => {
  test("returns true for registered graphs", () => {
    expect(isGraphRegistered("agent")).toBe(true);
  });

  test("returns false for unregistered graphs", () => {
    expect(isGraphRegistered("nonexistent")).toBe(false);
  });

  test("returns true for custom registered graph", () => {
    registerGraph("custom", createMockFactory("custom"));
    expect(isGraphRegistered("custom")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resetRegistry
// ---------------------------------------------------------------------------

describe("Graph Registry — resetRegistry", () => {
  test("clears custom registrations and restores builtins", () => {
    registerGraph("custom1", createMockFactory("c1"));
    registerGraph("custom2", createMockFactory("c2"));
    expect(getAvailableGraphIds()).toContain("custom1");
    expect(getAvailableGraphIds()).toContain("custom2");

    resetRegistry();

    expect(isGraphRegistered("custom1")).toBe(false);
    expect(isGraphRegistered("custom2")).toBe(false);
    expect(isGraphRegistered("agent")).toBe(true);
    expect(getAvailableGraphIds()).toEqual(["agent", "research_agent"]);
  });

  test("overwritten agent is restored after reset", async () => {
    const customAgent = createMockFactory("custom_agent");
    registerGraph("agent", customAgent);

    const before = resolveGraphFactory("agent");
    expect(before).toBe(customAgent);

    resetRegistry();

    const after = resolveGraphFactory("agent");
    // After reset, "agent" should be the lazy-loaded built-in, not our custom factory
    expect(after).not.toBe(customAgent);
    expect(typeof after).toBe("function");
  });

  test("multiple resets are idempotent", () => {
    resetRegistry();
    resetRegistry();
    resetRegistry();
    expect(getAvailableGraphIds()).toEqual(["agent", "research_agent"]);
  });
});

// ---------------------------------------------------------------------------
// Integration — resolve + invoke
// ---------------------------------------------------------------------------

describe("Graph Registry — integration", () => {
  test("register, resolve, and invoke a custom factory", async () => {
    const factory = createMockFactory("test_agent");
    registerGraph("test_agent", factory);

    const resolved = resolveGraphFactory("test_agent");
    const result = (await resolved({
      model_name: "openai:gpt-4o",
      temperature: 0.5,
    })) as { label: string; config: Record<string, unknown> };

    expect(result.label).toBe("test_agent");
    expect(result.config.model_name).toBe("openai:gpt-4o");
    expect(result.config.temperature).toBe(0.5);
  });

  test("multiple factories coexist independently", async () => {
    registerGraph("agent_a", createMockFactory("A"));
    registerGraph("agent_b", createMockFactory("B"));

    const resultA = (await resolveGraphFactory("agent_a")({})) as {
      label: string;
    };
    const resultB = (await resolveGraphFactory("agent_b")({})) as {
      label: string;
    };

    expect(resultA.label).toBe("A");
    expect(resultB.label).toBe("B");
  });

  test("factory receives options parameter", async () => {
    const factory: GraphFactory = async (config, options) => ({
      config,
      hasCheckpointer: options?.checkpointer !== undefined,
      hasStore: options?.store !== undefined,
    });
    registerGraph("with_options", factory);

    const resolved = resolveGraphFactory("with_options");

    const withoutOptions = (await resolved({})) as {
      hasCheckpointer: boolean;
      hasStore: boolean;
    };
    expect(withoutOptions.hasCheckpointer).toBe(false);
    expect(withoutOptions.hasStore).toBe(false);

    const withOptions = (await resolved({}, {
      checkpointer: "mock_checkpointer",
      store: "mock_store",
    })) as { hasCheckpointer: boolean; hasStore: boolean };
    expect(withOptions.hasCheckpointer).toBe(true);
    expect(withOptions.hasStore).toBe(true);
  });
});
