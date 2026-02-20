/**
 * Tests for the graph cache module.
 *
 * Validates:
 *   - Cache key computation (deterministic, field-sensitive)
 *   - Cache hit/miss behaviour
 *   - TTL eviction (lazy + proactive)
 *   - Cache statistics tracking
 *   - clearGraphCache resets everything
 *   - getOrBuildGraph integration (build function only called on miss)
 *
 * Reference: apps/ts/src/graphs/graph-cache.ts
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  computeCacheKey,
  getCachedGraph,
  setCachedGraph,
  clearGraphCache,
  getGraphCacheStats,
  getOrBuildGraph,
  evictExpiredEntries,
} from "../src/graphs/graph-cache";

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

// Save and restore GRAPH_CACHE_TTL_MS env var around tests
let savedCacheTtl: string | undefined;

beforeEach(() => {
  savedCacheTtl = process.env.GRAPH_CACHE_TTL_MS;
  delete process.env.GRAPH_CACHE_TTL_MS;
  clearGraphCache();
});

afterEach(() => {
  clearGraphCache();
  if (savedCacheTtl !== undefined) {
    process.env.GRAPH_CACHE_TTL_MS = savedCacheTtl;
  } else {
    delete process.env.GRAPH_CACHE_TTL_MS;
  }
});

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const BASIC_CONFIG: Record<string, unknown> = {
  model_name: "openai:gpt-4o",
  temperature: 0.7,
  max_tokens: 4000,
  system_prompt: "You are a helpful assistant.",
};

const CUSTOM_ENDPOINT_CONFIG: Record<string, unknown> = {
  model_name: "custom:",
  temperature: 0.5,
  max_tokens: 2000,
  system_prompt: "Custom agent.",
  base_url: "http://localhost:7374/v1",
  custom_model_name: "ministral-3b",
};

const CONFIG_WITH_MCP: Record<string, unknown> = {
  ...BASIC_CONFIG,
  mcp_config: {
    servers: [
      { name: "test-server", url: "http://mcp.example.com", tools: null, auth_required: false },
    ],
  },
};

const CONFIG_WITH_RAG: Record<string, unknown> = {
  ...BASIC_CONFIG,
  rag: {
    rag_url: "http://rag.example.com",
    collections: ["col-1", "col-2"],
  },
};

/** A fake compiled graph object for testing. */
const FAKE_GRAPH = {
  invoke: async () => ({ messages: [] }),
  getState: async () => ({ values: {} }),
};

const ANOTHER_FAKE_GRAPH = {
  invoke: async () => ({ messages: ["different"] }),
  getState: async () => ({ values: { different: true } }),
};

// ---------------------------------------------------------------------------
// computeCacheKey
// ---------------------------------------------------------------------------

describe("computeCacheKey", () => {
  test("returns a 16-character hex string", () => {
    const key = computeCacheKey("agent", BASIC_CONFIG);
    expect(key).toMatch(/^[0-9a-f]{16}$/);
  });

  test("same inputs produce same key (deterministic)", () => {
    const key1 = computeCacheKey("agent", BASIC_CONFIG);
    const key2 = computeCacheKey("agent", BASIC_CONFIG);
    expect(key1).toBe(key2);
  });

  test("different graph_id produces different key", () => {
    const key1 = computeCacheKey("agent", BASIC_CONFIG);
    const key2 = computeCacheKey("research_agent", BASIC_CONFIG);
    expect(key1).not.toBe(key2);
  });

  test("different model_name produces different key", () => {
    const key1 = computeCacheKey("agent", BASIC_CONFIG);
    const key2 = computeCacheKey("agent", {
      ...BASIC_CONFIG,
      model_name: "anthropic:claude-sonnet-4-0",
    });
    expect(key1).not.toBe(key2);
  });

  test("different temperature produces different key", () => {
    const key1 = computeCacheKey("agent", BASIC_CONFIG);
    const key2 = computeCacheKey("agent", {
      ...BASIC_CONFIG,
      temperature: 0.1,
    });
    expect(key1).not.toBe(key2);
  });

  test("different system_prompt produces different key", () => {
    const key1 = computeCacheKey("agent", BASIC_CONFIG);
    const key2 = computeCacheKey("agent", {
      ...BASIC_CONFIG,
      system_prompt: "You are a pirate.",
    });
    expect(key1).not.toBe(key2);
  });

  test("different mcp_config produces different key", () => {
    const key1 = computeCacheKey("agent", BASIC_CONFIG);
    const key2 = computeCacheKey("agent", CONFIG_WITH_MCP);
    expect(key1).not.toBe(key2);
  });

  test("different rag config produces different key", () => {
    const key1 = computeCacheKey("agent", BASIC_CONFIG);
    const key2 = computeCacheKey("agent", CONFIG_WITH_RAG);
    expect(key1).not.toBe(key2);
  });

  test("custom endpoint config produces different key from standard", () => {
    const key1 = computeCacheKey("agent", BASIC_CONFIG);
    const key2 = computeCacheKey("agent", CUSTOM_ENDPOINT_CONFIG);
    expect(key1).not.toBe(key2);
  });

  test("ignores runtime fields (thread_id, run_id, assistant_id)", () => {
    const baseKey = computeCacheKey("agent", BASIC_CONFIG);
    const withRuntime = computeCacheKey("agent", {
      ...BASIC_CONFIG,
      thread_id: "thread-abc-123",
      run_id: "run-xyz-456",
      assistant_id: "asst-789",
    });
    expect(baseKey).toBe(withRuntime);
  });

  test("ignores x-supabase-access-token", () => {
    const baseKey = computeCacheKey("agent", BASIC_CONFIG);
    const withToken = computeCacheKey("agent", {
      ...BASIC_CONFIG,
      "x-supabase-access-token": "eyJhbGciOi...",
    });
    expect(baseKey).toBe(withToken);
  });

  test("ignores arbitrary unknown fields", () => {
    const baseKey = computeCacheKey("agent", BASIC_CONFIG);
    const withExtra = computeCacheKey("agent", {
      ...BASIC_CONFIG,
      custom_field_1: "value1",
      some_other_setting: 42,
    });
    expect(baseKey).toBe(withExtra);
  });

  test("field order in config does not affect key", () => {
    const config1 = {
      model_name: "openai:gpt-4o",
      temperature: 0.7,
      max_tokens: 4000,
    };
    const config2 = {
      max_tokens: 4000,
      model_name: "openai:gpt-4o",
      temperature: 0.7,
    };
    const key1 = computeCacheKey("agent", config1);
    const key2 = computeCacheKey("agent", config2);
    expect(key1).toBe(key2);
  });

  test("null and undefined config values are equivalent (both omitted)", () => {
    const configWithNull = { ...BASIC_CONFIG, base_url: null };
    const configWithUndefined = { ...BASIC_CONFIG, base_url: undefined };
    const configWithout = { ...BASIC_CONFIG };
    delete (configWithout as Record<string, unknown>).base_url;

    const key1 = computeCacheKey("agent", configWithNull);
    const key2 = computeCacheKey("agent", configWithUndefined);
    const key3 = computeCacheKey("agent", configWithout);
    expect(key1).toBe(key2);
    expect(key2).toBe(key3);
  });
});

// ---------------------------------------------------------------------------
// getCachedGraph / setCachedGraph
// ---------------------------------------------------------------------------

describe("getCachedGraph / setCachedGraph", () => {
  test("returns null for unknown key", () => {
    const result = getCachedGraph("nonexistent-key");
    expect(result).toBeNull();
  });

  test("returns cached graph after set", () => {
    const key = computeCacheKey("agent", BASIC_CONFIG);
    setCachedGraph(key, FAKE_GRAPH, "agent", BASIC_CONFIG);

    const result = getCachedGraph(key);
    expect(result).toBe(FAKE_GRAPH);
  });

  test("returns exact same object reference (no cloning)", () => {
    const key = computeCacheKey("agent", BASIC_CONFIG);
    setCachedGraph(key, FAKE_GRAPH, "agent", BASIC_CONFIG);

    const result = getCachedGraph(key);
    expect(result).toBe(FAKE_GRAPH);
  });

  test("overwrites existing entry with same key", () => {
    const key = computeCacheKey("agent", BASIC_CONFIG);
    setCachedGraph(key, FAKE_GRAPH, "agent", BASIC_CONFIG);
    setCachedGraph(key, ANOTHER_FAKE_GRAPH, "agent", BASIC_CONFIG);

    const result = getCachedGraph(key);
    expect(result).toBe(ANOTHER_FAKE_GRAPH);
  });

  test("different keys store different graphs", () => {
    const key1 = computeCacheKey("agent", BASIC_CONFIG);
    const key2 = computeCacheKey("agent", CUSTOM_ENDPOINT_CONFIG);

    setCachedGraph(key1, FAKE_GRAPH, "agent", BASIC_CONFIG);
    setCachedGraph(key2, ANOTHER_FAKE_GRAPH, "agent", CUSTOM_ENDPOINT_CONFIG);

    expect(getCachedGraph(key1)).toBe(FAKE_GRAPH);
    expect(getCachedGraph(key2)).toBe(ANOTHER_FAKE_GRAPH);
  });
});

// ---------------------------------------------------------------------------
// TTL eviction
// ---------------------------------------------------------------------------

describe("TTL eviction", () => {
  test("evicts expired entry on access (lazy eviction)", () => {
    // Set very short TTL
    process.env.GRAPH_CACHE_TTL_MS = "1";

    const key = computeCacheKey("agent", BASIC_CONFIG);
    setCachedGraph(key, FAKE_GRAPH, "agent", BASIC_CONFIG);

    // Wait for TTL to expire
    const start = Date.now();
    while (Date.now() - start < 5) {
      // busy-wait 5ms
    }

    const result = getCachedGraph(key);
    expect(result).toBeNull();
  });

  test("does not evict entry within TTL", () => {
    process.env.GRAPH_CACHE_TTL_MS = "60000"; // 60 seconds

    const key = computeCacheKey("agent", BASIC_CONFIG);
    setCachedGraph(key, FAKE_GRAPH, "agent", BASIC_CONFIG);

    const result = getCachedGraph(key);
    expect(result).toBe(FAKE_GRAPH);
  });

  test("evictExpiredEntries removes all expired entries", () => {
    process.env.GRAPH_CACHE_TTL_MS = "1";

    const key1 = computeCacheKey("agent", BASIC_CONFIG);
    const key2 = computeCacheKey("agent", CUSTOM_ENDPOINT_CONFIG);
    setCachedGraph(key1, FAKE_GRAPH, "agent", BASIC_CONFIG);
    setCachedGraph(key2, ANOTHER_FAKE_GRAPH, "agent", CUSTOM_ENDPOINT_CONFIG);

    // Wait for TTL to expire
    const start = Date.now();
    while (Date.now() - start < 5) {
      // busy-wait 5ms
    }

    const evictedCount = evictExpiredEntries();
    expect(evictedCount).toBe(2);

    // Verify cache is empty
    const stats = getGraphCacheStats();
    expect(stats.size).toBe(0);
  });

  test("evictExpiredEntries returns 0 when nothing expired", () => {
    process.env.GRAPH_CACHE_TTL_MS = "60000";

    const key = computeCacheKey("agent", BASIC_CONFIG);
    setCachedGraph(key, FAKE_GRAPH, "agent", BASIC_CONFIG);

    const evictedCount = evictExpiredEntries();
    expect(evictedCount).toBe(0);

    // Entry should still be there
    expect(getCachedGraph(key)).toBe(FAKE_GRAPH);
  });

  test("respects GRAPH_CACHE_TTL_MS environment variable", () => {
    process.env.GRAPH_CACHE_TTL_MS = "100"; // 100ms

    const key = computeCacheKey("agent", BASIC_CONFIG);
    setCachedGraph(key, FAKE_GRAPH, "agent", BASIC_CONFIG);

    // Immediately — should be cached
    expect(getCachedGraph(key)).toBe(FAKE_GRAPH);

    // Wait for expiry
    const start = Date.now();
    while (Date.now() - start < 110) {
      // busy-wait
    }

    // Should be evicted
    expect(getCachedGraph(key)).toBeNull();
  });

  test("uses default 5-minute TTL when env var not set", () => {
    delete process.env.GRAPH_CACHE_TTL_MS;

    const key = computeCacheKey("agent", BASIC_CONFIG);
    setCachedGraph(key, FAKE_GRAPH, "agent", BASIC_CONFIG);

    // Should be cached (well within 5 minutes)
    expect(getCachedGraph(key)).toBe(FAKE_GRAPH);
  });

  test("ignores invalid GRAPH_CACHE_TTL_MS values (negative)", () => {
    process.env.GRAPH_CACHE_TTL_MS = "-100";

    const key = computeCacheKey("agent", BASIC_CONFIG);
    setCachedGraph(key, FAKE_GRAPH, "agent", BASIC_CONFIG);

    // Should use default TTL and be cached
    expect(getCachedGraph(key)).toBe(FAKE_GRAPH);
  });

  test("ignores invalid GRAPH_CACHE_TTL_MS values (NaN)", () => {
    process.env.GRAPH_CACHE_TTL_MS = "not-a-number";

    const key = computeCacheKey("agent", BASIC_CONFIG);
    setCachedGraph(key, FAKE_GRAPH, "agent", BASIC_CONFIG);

    // Should use default TTL and be cached
    expect(getCachedGraph(key)).toBe(FAKE_GRAPH);
  });
});

// ---------------------------------------------------------------------------
// clearGraphCache
// ---------------------------------------------------------------------------

describe("clearGraphCache", () => {
  test("removes all cached entries", () => {
    const key1 = computeCacheKey("agent", BASIC_CONFIG);
    const key2 = computeCacheKey("agent", CUSTOM_ENDPOINT_CONFIG);
    setCachedGraph(key1, FAKE_GRAPH, "agent", BASIC_CONFIG);
    setCachedGraph(key2, ANOTHER_FAKE_GRAPH, "agent", CUSTOM_ENDPOINT_CONFIG);

    clearGraphCache();

    expect(getCachedGraph(key1)).toBeNull();
    expect(getCachedGraph(key2)).toBeNull();
  });

  test("resets statistics counters", () => {
    const key = computeCacheKey("agent", BASIC_CONFIG);
    setCachedGraph(key, FAKE_GRAPH, "agent", BASIC_CONFIG);
    getCachedGraph(key); // hit
    getCachedGraph(key); // hit

    clearGraphCache();

    const stats = getGraphCacheStats();
    expect(stats.size).toBe(0);
    expect(stats.totalHits).toBe(0);
    expect(stats.totalMisses).toBe(0);
    expect(stats.entries).toHaveLength(0);
  });

  test("is safe to call multiple times", () => {
    clearGraphCache();
    clearGraphCache();
    clearGraphCache();

    const stats = getGraphCacheStats();
    expect(stats.size).toBe(0);
  });

  test("is safe to call on empty cache", () => {
    clearGraphCache();
    const stats = getGraphCacheStats();
    expect(stats.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// getGraphCacheStats
// ---------------------------------------------------------------------------

describe("getGraphCacheStats", () => {
  test("returns empty stats for empty cache", () => {
    const stats = getGraphCacheStats();
    expect(stats.size).toBe(0);
    expect(stats.totalHits).toBe(0);
    expect(stats.totalMisses).toBe(0);
    expect(stats.entries).toHaveLength(0);
  });

  test("tracks cache size correctly", () => {
    const key1 = computeCacheKey("agent", BASIC_CONFIG);
    const key2 = computeCacheKey("agent", CUSTOM_ENDPOINT_CONFIG);
    setCachedGraph(key1, FAKE_GRAPH, "agent", BASIC_CONFIG);
    setCachedGraph(key2, ANOTHER_FAKE_GRAPH, "agent", CUSTOM_ENDPOINT_CONFIG);

    const stats = getGraphCacheStats();
    expect(stats.size).toBe(2);
    expect(stats.entries).toHaveLength(2);
  });

  test("tracks total misses (each setCachedGraph increments)", () => {
    const key1 = computeCacheKey("agent", BASIC_CONFIG);
    const key2 = computeCacheKey("agent", CUSTOM_ENDPOINT_CONFIG);
    setCachedGraph(key1, FAKE_GRAPH, "agent", BASIC_CONFIG);
    setCachedGraph(key2, ANOTHER_FAKE_GRAPH, "agent", CUSTOM_ENDPOINT_CONFIG);

    const stats = getGraphCacheStats();
    expect(stats.totalMisses).toBe(2);
  });

  test("tracks total hits correctly", () => {
    const key = computeCacheKey("agent", BASIC_CONFIG);
    setCachedGraph(key, FAKE_GRAPH, "agent", BASIC_CONFIG);

    getCachedGraph(key); // hit 1
    getCachedGraph(key); // hit 2
    getCachedGraph(key); // hit 3

    const stats = getGraphCacheStats();
    expect(stats.totalHits).toBe(3);
  });

  test("tracks per-entry hit count", () => {
    const key1 = computeCacheKey("agent", BASIC_CONFIG);
    const key2 = computeCacheKey("agent", CUSTOM_ENDPOINT_CONFIG);
    setCachedGraph(key1, FAKE_GRAPH, "agent", BASIC_CONFIG);
    setCachedGraph(key2, ANOTHER_FAKE_GRAPH, "agent", CUSTOM_ENDPOINT_CONFIG);

    getCachedGraph(key1); // hit
    getCachedGraph(key1); // hit
    getCachedGraph(key2); // hit

    const stats = getGraphCacheStats();
    const entry1 = stats.entries.find((entry) => entry.key === key1);
    const entry2 = stats.entries.find((entry) => entry.key === key2);
    expect(entry1?.hitCount).toBe(2);
    expect(entry2?.hitCount).toBe(1);
  });

  test("entry description includes graph_id and model_name", () => {
    const key = computeCacheKey("agent", BASIC_CONFIG);
    setCachedGraph(key, FAKE_GRAPH, "agent", BASIC_CONFIG);

    const stats = getGraphCacheStats();
    expect(stats.entries[0].description).toBe("agent/openai:gpt-4o");
  });

  test("entry description uses 'default' for missing model_name", () => {
    const key = computeCacheKey("agent", {});
    setCachedGraph(key, FAKE_GRAPH, "agent", {});

    const stats = getGraphCacheStats();
    expect(stats.entries[0].description).toBe("agent/default");
  });

  test("entry ageMs is a positive number", () => {
    const key = computeCacheKey("agent", BASIC_CONFIG);
    setCachedGraph(key, FAKE_GRAPH, "agent", BASIC_CONFIG);

    const stats = getGraphCacheStats();
    expect(stats.entries[0].ageMs).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// getOrBuildGraph
// ---------------------------------------------------------------------------

describe("getOrBuildGraph", () => {
  test("calls build function on cache miss", async () => {
    let buildCallCount = 0;
    const result = await getOrBuildGraph("agent", BASIC_CONFIG, async () => {
      buildCallCount += 1;
      return FAKE_GRAPH;
    });

    expect(buildCallCount).toBe(1);
    expect(result).toBe(FAKE_GRAPH);
  });

  test("does NOT call build function on cache hit", async () => {
    let buildCallCount = 0;
    const buildFunction = async () => {
      buildCallCount += 1;
      return FAKE_GRAPH;
    };

    // First call — miss
    await getOrBuildGraph("agent", BASIC_CONFIG, buildFunction);
    expect(buildCallCount).toBe(1);

    // Second call — hit (should not call build again)
    const result = await getOrBuildGraph("agent", BASIC_CONFIG, buildFunction);
    expect(buildCallCount).toBe(1); // still 1
    expect(result).toBe(FAKE_GRAPH);
  });

  test("returns same graph object for same config", async () => {
    const result1 = await getOrBuildGraph("agent", BASIC_CONFIG, async () => FAKE_GRAPH);
    const result2 = await getOrBuildGraph("agent", BASIC_CONFIG, async () => ANOTHER_FAKE_GRAPH);

    // Second call should return cached graph, not the new one
    expect(result1).toBe(FAKE_GRAPH);
    expect(result2).toBe(FAKE_GRAPH);
  });

  test("builds different graphs for different configs", async () => {
    const result1 = await getOrBuildGraph("agent", BASIC_CONFIG, async () => FAKE_GRAPH);
    const result2 = await getOrBuildGraph(
      "agent",
      CUSTOM_ENDPOINT_CONFIG,
      async () => ANOTHER_FAKE_GRAPH,
    );

    expect(result1).toBe(FAKE_GRAPH);
    expect(result2).toBe(ANOTHER_FAKE_GRAPH);
  });

  test("builds different graphs for different graph_ids", async () => {
    const result1 = await getOrBuildGraph("agent", BASIC_CONFIG, async () => FAKE_GRAPH);
    const result2 = await getOrBuildGraph(
      "research_agent",
      BASIC_CONFIG,
      async () => ANOTHER_FAKE_GRAPH,
    );

    expect(result1).toBe(FAKE_GRAPH);
    expect(result2).toBe(ANOTHER_FAKE_GRAPH);
  });

  test("propagates build function errors", async () => {
    const error = new Error("Model initialization failed");
    await expect(
      getOrBuildGraph("agent", BASIC_CONFIG, async () => {
        throw error;
      }),
    ).rejects.toThrow("Model initialization failed");
  });

  test("does not cache failed builds", async () => {
    // First call — fails
    try {
      await getOrBuildGraph("agent", BASIC_CONFIG, async () => {
        throw new Error("Temporary failure");
      });
    } catch {
      // expected
    }

    // Second call — should try building again (not cached)
    let buildCalled = false;
    const result = await getOrBuildGraph("agent", BASIC_CONFIG, async () => {
      buildCalled = true;
      return FAKE_GRAPH;
    });

    expect(buildCalled).toBe(true);
    expect(result).toBe(FAKE_GRAPH);
  });

  test("caches graph after successful build", async () => {
    await getOrBuildGraph("agent", BASIC_CONFIG, async () => FAKE_GRAPH);

    // Verify it's in the cache
    const stats = getGraphCacheStats();
    expect(stats.size).toBe(1);
    expect(stats.totalMisses).toBe(1);
  });

  test("increments hit counter on cache hit", async () => {
    await getOrBuildGraph("agent", BASIC_CONFIG, async () => FAKE_GRAPH);
    await getOrBuildGraph("agent", BASIC_CONFIG, async () => ANOTHER_FAKE_GRAPH);
    await getOrBuildGraph("agent", BASIC_CONFIG, async () => ANOTHER_FAKE_GRAPH);

    const stats = getGraphCacheStats();
    expect(stats.totalHits).toBe(2);
    expect(stats.totalMisses).toBe(1);
  });

  test("runtime fields do not cause cache miss", async () => {
    let buildCallCount = 0;
    const buildFunction = async () => {
      buildCallCount += 1;
      return FAKE_GRAPH;
    };

    // First call with runtime fields
    await getOrBuildGraph("agent", {
      ...BASIC_CONFIG,
      thread_id: "thread-1",
      run_id: "run-1",
      assistant_id: "asst-1",
      "x-supabase-access-token": "token-1",
    }, buildFunction);

    // Second call with different runtime fields but same config
    await getOrBuildGraph("agent", {
      ...BASIC_CONFIG,
      thread_id: "thread-2",
      run_id: "run-2",
      assistant_id: "asst-2",
      "x-supabase-access-token": "token-2",
    }, buildFunction);

    expect(buildCallCount).toBe(1); // should be a cache hit
  });

  test("rebuilds after cache is cleared", async () => {
    let buildCallCount = 0;
    const buildFunction = async () => {
      buildCallCount += 1;
      return FAKE_GRAPH;
    };

    await getOrBuildGraph("agent", BASIC_CONFIG, buildFunction);
    expect(buildCallCount).toBe(1);

    clearGraphCache();

    await getOrBuildGraph("agent", BASIC_CONFIG, buildFunction);
    expect(buildCallCount).toBe(2);
  });

  test("rebuilds after TTL expiry", async () => {
    process.env.GRAPH_CACHE_TTL_MS = "1";

    let buildCallCount = 0;
    const buildFunction = async () => {
      buildCallCount += 1;
      return FAKE_GRAPH;
    };

    await getOrBuildGraph("agent", BASIC_CONFIG, buildFunction);
    expect(buildCallCount).toBe(1);

    // Wait for TTL to expire
    const start = Date.now();
    while (Date.now() - start < 5) {
      // busy-wait
    }

    await getOrBuildGraph("agent", BASIC_CONFIG, buildFunction);
    expect(buildCallCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Concurrent access safety
// ---------------------------------------------------------------------------

describe("concurrent access", () => {
  test("handles multiple concurrent builds for same config", async () => {
    let buildCallCount = 0;
    const buildFunction = async () => {
      buildCallCount += 1;
      // Simulate async delay
      await new Promise((resolve) => setTimeout(resolve, 5));
      return FAKE_GRAPH;
    };

    // Launch multiple concurrent getOrBuildGraph calls
    const results = await Promise.all([
      getOrBuildGraph("agent", BASIC_CONFIG, buildFunction),
      getOrBuildGraph("agent", BASIC_CONFIG, buildFunction),
      getOrBuildGraph("agent", BASIC_CONFIG, buildFunction),
    ]);

    // All should return the same graph
    for (const result of results) {
      expect(result).toBe(FAKE_GRAPH);
    }

    // Build may be called multiple times due to no deduplication lock,
    // but all results should be correct. At minimum 1 call, at most 3.
    expect(buildCallCount).toBeGreaterThanOrEqual(1);
    expect(buildCallCount).toBeLessThanOrEqual(3);
  });

  test("handles concurrent builds for different configs", async () => {
    const buildCount: Record<string, number> = {};
    const buildFunction = (graphId: string) => async () => {
      buildCount[graphId] = (buildCount[graphId] ?? 0) + 1;
      return { graphId };
    };

    const [result1, result2] = await Promise.all([
      getOrBuildGraph("agent", BASIC_CONFIG, buildFunction("agent")),
      getOrBuildGraph(
        "research_agent",
        BASIC_CONFIG,
        buildFunction("research_agent"),
      ),
    ]);

    expect((result1 as Record<string, unknown>).graphId).toBe("agent");
    expect((result2 as Record<string, unknown>).graphId).toBe("research_agent");
    expect(buildCount["agent"]).toBe(1);
    expect(buildCount["research_agent"]).toBe(1);
  });
});
