/**
 * Database connection management for Postgres persistence.
 *
 * Provides:
 *   - `initializeDatabase()` — Probe connectivity, run DDL migrations
 *   - `shutdownDatabase()` — Close connection pool, reset state
 *   - `getConnection()` — Get the singleton Postgres.js SQL client
 *   - `isDatabaseEnabled()` — Check if DB was successfully initialized
 *   - `getDatabaseUrl()` — Return validated connection string
 *
 * Uses `postgres` (Postgres.js) for custom storage queries. This is separate
 * from the `pg` (node-postgres) client used internally by
 * `@langchain/langgraph-checkpoint-postgres` for checkpointing.
 *
 * ## Connection Management
 *
 * Unlike the Python runtime (which creates per-request connections due to
 * Robyn/Actix multi-event-loop issues), Bun is single-threaded.  A single
 * `postgres` client with built-in connection pooling is correct and
 * efficient.
 *
 * ## Schema Compatibility
 *
 * The DDL matches the Python runtime's `postgres_storage.py` `_DDL` constant
 * exactly, so both runtimes can share a single Postgres database deployment.
 * Schema: `langgraph_server`.
 *
 * Reference: apps/python/src/server/database.py
 * Reference: apps/python/src/server/postgres_storage.py → _DDL
 */

import postgres from "postgres";
import type { Sql } from "postgres";

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

let sql: Sql | null = null;
let databaseUrl: string | null = null;
let initialized = false;

// ---------------------------------------------------------------------------
// DDL — idempotent, safe to run on every startup
// ---------------------------------------------------------------------------

/**
 * DDL statements matching the Python runtime's `_DDL` constant from
 * `apps/python/src/server/postgres_storage.py`.
 *
 * All statements use `IF NOT EXISTS` / `IF EXISTS` for idempotency.
 * The schema `langgraph_server` isolates runtime tables from LangGraph's
 * internal tables (checkpoints, store) which live in `public`.
 */
const DDL_STATEMENTS: readonly string[] = [
  `CREATE SCHEMA IF NOT EXISTS langgraph_server`,

  `CREATE TABLE IF NOT EXISTS langgraph_server.assistants (
    id TEXT PRIMARY KEY,
    graph_id TEXT NOT NULL,
    config JSONB NOT NULL DEFAULT '{}',
    context JSONB NOT NULL DEFAULT '{}',
    metadata JSONB NOT NULL DEFAULT '{}',
    name TEXT,
    description TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,

  `CREATE TABLE IF NOT EXISTS langgraph_server.threads (
    id TEXT PRIMARY KEY,
    metadata JSONB NOT NULL DEFAULT '{}',
    config JSONB NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'idle',
    values JSONB NOT NULL DEFAULT '{}',
    interrupts JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,

  `CREATE TABLE IF NOT EXISTS langgraph_server.thread_states (
    id SERIAL PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES langgraph_server.threads(id) ON DELETE CASCADE,
    values JSONB NOT NULL DEFAULT '{}',
    metadata JSONB NOT NULL DEFAULT '{}',
    next TEXT[] NOT NULL DEFAULT '{}',
    tasks JSONB NOT NULL DEFAULT '[]',
    checkpoint_id TEXT NOT NULL,
    parent_checkpoint JSONB,
    interrupts JSONB NOT NULL DEFAULT '[]',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,

  `CREATE INDEX IF NOT EXISTS idx_thread_states_thread_id
    ON langgraph_server.thread_states(thread_id, created_at DESC)`,

  `CREATE TABLE IF NOT EXISTS langgraph_server.runs (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    assistant_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    metadata JSONB NOT NULL DEFAULT '{}',
    kwargs JSONB NOT NULL DEFAULT '{}',
    multitask_strategy TEXT NOT NULL DEFAULT 'reject',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,

  `CREATE INDEX IF NOT EXISTS idx_runs_thread_id
    ON langgraph_server.runs(thread_id, created_at DESC)`,

  `CREATE TABLE IF NOT EXISTS langgraph_server.store_items (
    namespace TEXT NOT NULL,
    key TEXT NOT NULL,
    value JSONB NOT NULL DEFAULT '{}',
    owner_id TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (namespace, key, owner_id)
  )`,

  `CREATE TABLE IF NOT EXISTS langgraph_server.crons (
    id TEXT PRIMARY KEY,
    assistant_id TEXT,
    thread_id TEXT,
    end_time TIMESTAMPTZ,
    schedule TEXT NOT NULL,
    user_id TEXT,
    payload JSONB NOT NULL DEFAULT '{}',
    next_run_date TIMESTAMPTZ,
    metadata JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
];

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * Initialize the Postgres database: probe connectivity, run DDL migrations.
 *
 * Reads `DATABASE_URL` from the application config. When the URL is empty,
 * the function returns `false` and the server continues with in-memory
 * storage.
 *
 * On success:
 *   - `isDatabaseEnabled()` returns `true`
 *   - `getConnection()` returns the Postgres.js SQL client
 *   - `getDatabaseUrl()` returns the connection string
 *
 * @returns `true` when Postgres is connected and ready, `false` otherwise.
 */
export async function initializeDatabase(): Promise<boolean> {
  const configUrl = process.env.DATABASE_URL;

  if (!configUrl || configUrl.length === 0) {
    console.log("[database] DATABASE_URL not set — using in-memory storage");
    return false;
  }

  // Local Supabase instances don't expose TLS; ensure sslmode is set so
  // postgres.js doesn't try to negotiate SSL with a server that doesn't have it.
  let resolvedUrl = configUrl;
  if (
    !resolvedUrl.includes("sslmode") &&
    (resolvedUrl.includes("127.0.0.1") || resolvedUrl.includes("localhost"))
  ) {
    const separator = resolvedUrl.includes("?") ? "&" : "?";
    resolvedUrl = `${resolvedUrl}${separator}sslmode=disable`;
  }

  try {
    // Parse pool settings from env
    const poolMax = parseInt(process.env.DATABASE_POOL_MAX_SIZE || "10", 10);

    // Create the Postgres.js client with connection pooling
    sql = postgres(resolvedUrl, {
      max: Number.isFinite(poolMax) && poolMax > 0 ? poolMax : 10,
      idle_timeout: 20,
      connect_timeout: 10,
    });

    // Fast-fail connectivity probe
    await probeConnection();

    // Store URL for runtime use
    databaseUrl = resolvedUrl;

    // Run idempotent DDL migrations
    await runMigrations();

    initialized = true;
    console.log(
      "[database] ✅ Postgres persistence initialized (connection pooling via postgres.js)",
    );
    return true;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `[database] ❌ Failed to connect to Postgres — falling back to in-memory storage: ${message}`,
    );

    // Clean up on failure
    if (sql) {
      try {
        await sql.end({ timeout: 2 });
      } catch {
        // Ignore cleanup errors
      }
    }
    sql = null;
    databaseUrl = null;
    initialized = false;
    return false;
  }
}

/**
 * Shut down the database connection pool and reset state.
 *
 * Safe to call even when Postgres was never initialized. Call this
 * during graceful server shutdown (SIGTERM/SIGINT).
 */
export async function shutdownDatabase(): Promise<void> {
  if (sql) {
    try {
      await sql.end({ timeout: 5 });
      console.log("[database] Connection pool closed");
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[database] Error closing connection pool: ${message}`);
    }
  }

  sql = null;
  databaseUrl = null;
  initialized = false;
}

/**
 * Reset database state without closing connections.
 *
 * **For testing only.** Forces `isDatabaseEnabled()` to return `false`
 * and `getConnection()` to return `null`.
 */
export function resetDatabase(): void {
  sql = null;
  databaseUrl = null;
  initialized = false;
}

// ---------------------------------------------------------------------------
// Accessors
// ---------------------------------------------------------------------------

/**
 * Get the singleton Postgres.js SQL client.
 *
 * Returns `null` when the database has not been initialized or
 * `DATABASE_URL` is not configured. Callers should check
 * `isDatabaseEnabled()` before calling this, or handle `null`.
 *
 * @returns The Postgres.js SQL tagged template function, or `null`.
 */
export function getConnection(): Sql | null {
  return sql;
}

/**
 * Get the validated database URL.
 *
 * Returns `null` when Postgres is not configured or not initialized.
 *
 * @returns The database connection string, or `null`.
 */
export function getDatabaseUrl(): string | null {
  return databaseUrl;
}

/**
 * Check whether the database has been successfully initialized.
 *
 * @returns `true` when Postgres is connected, migrated, and ready.
 */
export function isDatabaseEnabled(): boolean {
  return initialized;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Probe database connectivity with a simple `SELECT 1` query.
 *
 * Fails fast if the database is unreachable, allowing the server to
 * fall back to in-memory storage.
 *
 * @throws Error if the database is unreachable.
 */
async function probeConnection(): Promise<void> {
  if (!sql) {
    throw new Error("SQL client not created");
  }

  const result = await sql`SELECT 1 AS probe`;

  if (!result || result.length === 0) {
    throw new Error("Probe query returned no results");
  }

  console.log("[database] Connectivity probe successful");
}

/**
 * Run idempotent DDL migrations to create the `langgraph_server` schema
 * and all runtime tables.
 *
 * All statements use `CREATE ... IF NOT EXISTS`, so this is safe to call
 * on every startup. Matches the Python runtime's migration strategy.
 */
async function runMigrations(): Promise<void> {
  if (!sql) {
    throw new Error("SQL client not created");
  }

  for (const statement of DDL_STATEMENTS) {
    await sql.unsafe(statement);
  }

  console.log("[database] DDL migrations complete (langgraph_server schema ready)");
}

/**
 * Log the database configuration status at startup.
 *
 * Call this once during server initialization to inform the operator
 * whether Postgres persistence is active or disabled.
 */
export function logDatabaseStatus(): void {
  if (initialized) {
    console.log("[database] ✅ Postgres persistence enabled");
  } else {
    console.log(
      "[database] ⚠️  DATABASE_URL not set — using in-memory storage (data lost on restart)",
    );
  }
}
