/**
 * Graph cache — caches compiled LangGraph agents keyed by config hash.
 *
 * Eliminates per-request graph compilation overhead by caching compiled
 * graphs keyed on the config fields that determine graph structure. The
 * same compiled graph can be safely reused across multiple threads and
 * runs because LangGraph uses `thread_id` (passed at invoke time via
 * `configurable`) to isolate thread state — not at compile time.
 *
 * This is validated by the LangGraph docs pattern:
 *   ```
 *   const graph = builder.compile({ checkpointer });  // once
 *   await graph.invoke(input, { configurable: { thread_id: "1" } });
 *   await graph.invoke(input, { configurable: { thread_id: "2" } });
 *   ```
 *
 * Cache key components (fields that affect graph structure):
 *   - graph_id         — which factory (agent, research_agent)
 *   - model_name       — LLM provider and model
 *   - temperature      — model parameter
 *   - max_tokens       — model parameter
 *   - system_prompt    — agent behavior
 *   - base_url         — custom endpoint URL
 *   - custom_model_name — custom endpoint model override
 *   - mcp_config       — MCP tool server definitions
 *   - rag              — RAG collection definitions
 *
 * Fields NOT in cache key (runtime-per-request):
 *   - thread_id, run_id, assistant_id — passed at invoke() time
 *   - x-supabase-access-token — used during first build for MCP auth,
 *     but tool definitions are the same regardless of which valid token
 *     was used. Cached tools are self-contained after creation.
 *
 * TTL: 5 minutes by default (configurable via GRAPH_CACHE_TTL_MS env var).
 * Protects against stale tool definitions if MCP servers change.
 *
 * Reference:
 *   - LangGraph persistence docs: compile once, invoke with thread_id
 *   - Bun.CryptoHasher docs: native HMAC-SHA256 for fast hashing
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A cached graph entry with metadata for TTL eviction and hit tracking.
 */
interface CachedGraphEntry {
  /** The compiled LangGraph agent (supports .invoke(), .getState(), etc.) */
  graph: unknown;

  /** Timestamp (ms since epoch) when this entry was created. */
  createdAt: number;

  /** Number of cache hits since creation. */
  hitCount: number;

  /** Human-readable description of what config produced this graph. */
  description: string;
}

/**
 * Cache statistics for monitoring and debugging.
 */
export interface GraphCacheStats {
  /** Number of entries currently in the cache. */
  size: number;

  /** Total cache hits across all entries since last reset. */
  totalHits: number;

  /** Total cache misses (builds) since last reset. */
  totalMisses: number;

  /** Per-entry details. */
  entries: Array<{
    key: string;
    description: string;
    hitCount: number;
    ageMs: number;
  }>;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Default TTL for cached graphs: 5 minutes.
 *
 * Override via GRAPH_CACHE_TTL_MS environment variable.
 */
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Get the configured cache TTL in milliseconds.
 */
function getCacheTtlMs(): number {
  const envValue = process.env.GRAPH_CACHE_TTL_MS;
  if (envValue) {
    const parsed = Number(envValue);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_CACHE_TTL_MS;
}

// ---------------------------------------------------------------------------
// Cache storage
// ---------------------------------------------------------------------------

const graphCache = new Map<string, CachedGraphEntry>();
let totalHits = 0;
let totalMisses = 0;

// ---------------------------------------------------------------------------
// Cache key computation
// ---------------------------------------------------------------------------

/**
 * Fields from the configurable dict that affect graph structure.
 *
 * These are the ONLY fields used for the cache key. Everything else
 * (thread_id, run_id, assistant_id, tokens) is runtime-specific and
 * passed at invoke() time.
 */
const CACHE_KEY_FIELDS = [
  "model_name",
  "temperature",
  "max_tokens",
  "system_prompt",
  "base_url",
  "custom_model_name",
  "mcp_config",
  "rag",
] as const;

/**
 * Compute a deterministic cache key from graph_id and configurable dict.
 *
 * Uses Bun.CryptoHasher (native SHA-256) for fast, collision-resistant
 * hashing. The key is a 16-character hex prefix of the SHA-256 digest —
 * sufficient for cache deduplication (64 bits of entropy).
 *
 * @param graphId - The graph factory identifier (e.g. "agent").
 * @param configurable - The assistant's configurable dictionary.
 * @returns A 16-character hex string cache key.
 */
export function computeCacheKey(
  graphId: string,
  configurable: Record<string, unknown>,
): string {
  // Build a deterministic object with only structure-affecting fields.
  // Sort keys to ensure consistent serialization regardless of insertion order.
  const keyFields: Record<string, unknown> = { graphId };

  for (const field of CACHE_KEY_FIELDS) {
    const value = configurable[field];
    if (value !== undefined && value !== null) {
      keyFields[field] = value;
    }
  }

  // JSON.stringify with sorted keys for deterministic output
  const serialized = JSON.stringify(keyFields, Object.keys(keyFields).sort());

  // Use Bun.CryptoHasher for native-speed SHA-256 hashing.
  // Reference: https://bun.com/docs/runtime/hashing
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(serialized);
  return hasher.digest("hex").slice(0, 16);
}

/**
 * Build a human-readable description for a cache entry.
 *
 * Used in logs and stats output. Shows the graph_id and model_name
 * for quick identification.
 */
function buildDescription(
  graphId: string,
  configurable: Record<string, unknown>,
): string {
  const modelName =
    typeof configurable.model_name === "string"
      ? configurable.model_name
      : "default";
  return `${graphId}/${modelName}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Look up a compiled graph in the cache.
 *
 * Returns the cached graph if found and not expired, or `null` on miss.
 * Expired entries are evicted on access (lazy TTL).
 *
 * @param cacheKey - The key from `computeCacheKey()`.
 * @returns The cached compiled graph, or `null` if not found / expired.
 */
export function getCachedGraph(cacheKey: string): unknown | null {
  const entry = graphCache.get(cacheKey);
  if (!entry) {
    return null;
  }

  // Lazy TTL eviction
  const ttlMs = getCacheTtlMs();
  if (Date.now() - entry.createdAt > ttlMs) {
    graphCache.delete(cacheKey);
    console.log(
      `[graph-cache] TTL expired, evicted: key=${cacheKey} desc=${entry.description} age=${Math.round((Date.now() - entry.createdAt) / 1000)}s hits=${entry.hitCount}`,
    );
    return null;
  }

  entry.hitCount += 1;
  totalHits += 1;
  return entry.graph;
}

/**
 * Store a compiled graph in the cache.
 *
 * Overwrites any existing entry with the same key.
 *
 * @param cacheKey - The key from `computeCacheKey()`.
 * @param graph - The compiled LangGraph agent.
 * @param graphId - Graph factory ID (for description).
 * @param configurable - The configurable dict (for description).
 */
export function setCachedGraph(
  cacheKey: string,
  graph: unknown,
  graphId: string,
  configurable: Record<string, unknown>,
): void {
  const description = buildDescription(graphId, configurable);

  graphCache.set(cacheKey, {
    graph,
    createdAt: Date.now(),
    hitCount: 0,
    description,
  });

  totalMisses += 1;

  console.log(
    `[graph-cache] Cached new graph: key=${cacheKey} desc=${description} cacheSize=${graphCache.size}`,
  );
}

/**
 * Get or build a compiled graph, using the cache transparently.
 *
 * This is the main entry point for the route handlers. It:
 * 1. Computes the cache key from graph_id + configurable.
 * 2. Returns a cached graph on hit (with timing log).
 * 3. On miss, calls the provided `buildFunction` to compile a new graph,
 *    stores it in the cache, and returns it.
 *
 * @param graphId - The graph factory identifier (e.g. "agent").
 * @param configurable - The assistant's configurable dictionary.
 * @param buildFunction - Async function that compiles the graph (called on cache miss).
 * @returns The compiled graph (cached or freshly built).
 */
export async function getOrBuildGraph(
  graphId: string,
  configurable: Record<string, unknown>,
  buildFunction: () => Promise<unknown>,
): Promise<unknown> {
  const cacheKey = computeCacheKey(graphId, configurable);

  // Check cache first
  const cached = getCachedGraph(cacheKey);
  if (cached !== null) {
    const startNanoseconds = Bun.nanoseconds();
    // Cache hit — no build needed. Log the (near-zero) lookup time.
    const elapsedMs = (Bun.nanoseconds() - startNanoseconds) / 1_000_000;
    console.log(
      `[perf] Graph cache HIT: key=${cacheKey} lookupMs=${elapsedMs.toFixed(3)}`,
    );
    return cached;
  }

  // Cache miss — build the graph
  const buildStartNanoseconds = Bun.nanoseconds();
  const graph = await buildFunction();
  const buildElapsedMs =
    (Bun.nanoseconds() - buildStartNanoseconds) / 1_000_000;

  console.log(
    `[perf] Graph cache MISS — built new graph: key=${cacheKey} buildMs=${buildElapsedMs.toFixed(1)}`,
  );

  // Store in cache for future requests
  setCachedGraph(cacheKey, graph, graphId, configurable);

  return graph;
}

/**
 * Clear the entire graph cache.
 *
 * Useful for:
 *   - Testing (reset between test cases)
 *   - Manual cache invalidation (e.g. after assistant config change)
 *   - Graceful shutdown
 */
export function clearGraphCache(): void {
  const previousSize = graphCache.size;
  graphCache.clear();
  totalHits = 0;
  totalMisses = 0;

  if (previousSize > 0) {
    console.log(
      `[graph-cache] Cache cleared: evicted=${previousSize} entries`,
    );
  }
}

/**
 * Get cache statistics for monitoring and debugging.
 *
 * Returns current cache size, hit/miss counters, and per-entry details.
 * Useful for the `/info` endpoint or debug logging.
 *
 * @returns Cache statistics snapshot.
 */
export function getGraphCacheStats(): GraphCacheStats {
  const now = Date.now();
  const entries = Array.from(graphCache.entries()).map(([key, entry]) => ({
    key,
    description: entry.description,
    hitCount: entry.hitCount,
    ageMs: now - entry.createdAt,
  }));

  return {
    size: graphCache.size,
    totalHits,
    totalMisses,
    entries,
  };
}

/**
 * Evict all expired entries from the cache.
 *
 * Normally, expired entries are evicted lazily on access (in
 * `getCachedGraph`). Call this periodically if you want proactive
 * cleanup (e.g. on a timer).
 *
 * @returns Number of entries evicted.
 */
export function evictExpiredEntries(): number {
  const ttlMs = getCacheTtlMs();
  const now = Date.now();
  let evictedCount = 0;

  for (const [key, entry] of graphCache) {
    if (now - entry.createdAt > ttlMs) {
      graphCache.delete(key);
      evictedCount += 1;
      console.log(
        `[graph-cache] Proactive eviction: key=${key} desc=${entry.description} age=${Math.round((now - entry.createdAt) / 1000)}s`,
      );
    }
  }

  return evictedCount;
}
