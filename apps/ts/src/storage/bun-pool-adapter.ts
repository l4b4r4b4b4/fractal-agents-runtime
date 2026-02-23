/**
 * Adapter that wraps Bun's native SQL driver to satisfy the `pg.Pool`
 * interface consumed by `@langchain/langgraph-checkpoint-postgres`.
 *
 * ## Why
 *
 * `PostgresSaver` from `@langchain/langgraph-checkpoint-postgres` expects a
 * `pg.Pool` instance. Rather than keeping the pure-JS `pg` (node-postgres)
 * driver as a dependency, this adapter delegates all queries to Bun's native
 * C/Zig Postgres bindings (`Bun.sql`) while presenting the same surface:
 *
 *   - `pool.query(text, params?)` → `{ rows }` (direct queries)
 *   - `pool.connect()` → reserved client with `query()` + `release()`
 *   - `pool.end()` → close all connections
 *
 * ## Transaction Safety
 *
 * `PostgresSaver` manages transactions manually (`BEGIN` / `COMMIT` /
 * `ROLLBACK`) on a client obtained via `pool.connect()`. To ensure all
 * statements within a transaction share the same underlying connection,
 * `connect()` uses `Bun.sql.reserve()` which pins a single connection
 * from the pool.
 *
 * ## Parameter Format
 *
 * `PostgresSaver` uses `$1, $2, …` positional parameters (PostgreSQL
 * wire protocol format). `Bun.sql.unsafe(text, params)` supports this
 * natively.
 *
 * Reference: Goal 33, Task-02
 * Reference: apps/ts/node_modules/@langchain/langgraph-checkpoint-postgres/dist/index.js
 */

import { SQL } from "bun";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Shape of query results expected by PostgresSaver. */
interface QueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
}

/** Shape of a reserved client expected by PostgresSaver. */
interface PoolClient {
  query(text: string, params?: unknown[]): Promise<QueryResult>;
  release(): void;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/**
 * Wraps a `Bun.sql` (native Postgres driver) instance behind the subset
 * of the `pg.Pool` interface that `PostgresSaver` actually uses.
 *
 * Inject this into `new PostgresSaver(pool)` instead of `pg.Pool`:
 *
 * ```ts
 * const pool = new BunPoolAdapter(databaseUrl, { max: 20 });
 * const checkpointer = new PostgresSaver(pool as any);
 * ```
 */
export class BunPoolAdapter {
  private readonly sql: InstanceType<typeof SQL>;

  /**
   * Create a new adapter backed by Bun's native Postgres driver.
   *
   * @param connectionString - Postgres connection URL.
   * @param options - Optional pool configuration.
   * @param options.max - Maximum number of connections in the pool (default: 20).
   * @param options.idleTimeout - Close idle connections after this many seconds (default: 30).
   * @param options.connectionTimeout - Connection establishment timeout in seconds (default: 10).
   */
  constructor(
    connectionString: string,
    options?: {
      max?: number;
      idleTimeout?: number;
      connectionTimeout?: number;
    },
  ) {
    this.sql = new SQL({
      url: connectionString,
      max: options?.max ?? 20,
      idleTimeout: options?.idleTimeout ?? 30,
      connectionTimeout: options?.connectionTimeout ?? 10,
    });
  }

  /**
   * Execute a query directly on the pool (no reserved connection).
   *
   * Used by `PostgresSaver` for read-only SELECT queries that don't
   * require transaction isolation.
   *
   * @param text - SQL string with `$1, $2, …` positional parameters.
   * @param params - Parameter values corresponding to `$1, $2, …`.
   * @returns Query result with `rows` array and `rowCount`.
   */
  async query(text: string, params?: unknown[]): Promise<QueryResult> {
    const result = await this.sql.unsafe(text, params ?? []);
    // Bun.sql returns a special array-like object; spread into a plain
    // Array so downstream code (destructuring, .length, .map) works
    // identically to pg's result.rows.
    const rows = Array.from(result) as Record<string, unknown>[];
    return { rows, rowCount: rows.length };
  }

  /**
   * Reserve an exclusive connection from the pool.
   *
   * Returns a client object whose `query()` calls all go through the
   * same underlying connection — required for transaction isolation
   * (`BEGIN` / `COMMIT` / `ROLLBACK`).
   *
   * Call `client.release()` when done (typically in a `finally` block).
   *
   * @returns A client with `query()` and `release()` methods.
   */
  async connect(): Promise<PoolClient> {
    const reserved = await this.sql.reserve();

    return {
      async query(text: string, params?: unknown[]): Promise<QueryResult> {
        const result = await reserved.unsafe(text, params ?? []);
        const rows = Array.from(result) as Record<string, unknown>[];
        return { rows, rowCount: rows.length };
      },

      release(): void {
        reserved.release();
      },
    };
  }

  /**
   * Close all connections in the pool.
   *
   * Called by `PostgresSaver.end()` during graceful shutdown.
   */
  async end(): Promise<void> {
    await this.sql.close();
  }
}
