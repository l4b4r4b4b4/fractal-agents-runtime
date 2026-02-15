/**
 * Singleton storage factory for the Fractal Agents Runtime — TypeScript/Bun.
 *
 * Mirrors Python's `get_storage()` / `reset_storage()` pattern from
 * `apps/python/src/server/storage.py`.
 *
 * ## Storage Backend Selection
 *
 * - When `DATABASE_URL` is configured and the database has been
 *   successfully initialized via `initializeStorage()`, returns a
 *   `PostgresStorage` instance backed by Postgres.js.
 * - When `DATABASE_URL` is not set (or initialization failed), falls
 *   back to `InMemoryStorage` — matching v0.0.1 behavior.
 *
 * ## Checkpointer Selection
 *
 * - When `DATABASE_URL` is configured → `PostgresSaver` from
 *   `@langchain/langgraph-checkpoint-postgres` (persistent across restarts)
 * - When `DATABASE_URL` is not set → `MemorySaver` from `@langchain/langgraph`
 *   (in-memory, resets on restart)
 *
 * ## Lifecycle
 *
 * Call `initializeStorage()` at server startup (before `Bun.serve()`).
 * This probes the database, runs DDL migrations, and sets up the
 * checkpointer. Call `shutdownStorage()` during graceful shutdown to
 * close database connections.
 *
 * Reference: apps/python/src/server/storage.py → get_storage()
 * Reference: apps/python/src/server/database.py → initialize_database()
 */

import type { Storage } from "./types";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import { InMemoryStorage } from "./memory";
import { MemorySaver } from "@langchain/langgraph";
import {
  initializeDatabase,
  shutdownDatabase,
  getConnection,
  getDatabaseUrl,
  isDatabaseEnabled,
  logDatabaseStatus,
} from "./database";

// ---------------------------------------------------------------------------
// Module-level singletons
// ---------------------------------------------------------------------------

let storage: Storage | null = null;
let checkpointer: BaseCheckpointSaver | null = null;

// ---------------------------------------------------------------------------
// Storage factory
// ---------------------------------------------------------------------------

/**
 * Get the global storage instance.
 *
 * Returns `PostgresStorage` when the database is initialized, or
 * `InMemoryStorage` as a fallback. Creates the instance on first call
 * (singleton pattern).
 *
 * @returns The global Storage instance with all resource stores.
 */
export function getStorage(): Storage {
  if (storage === null) {
    if (isDatabaseEnabled()) {
      const sql = getConnection();
      if (sql) {
        // Lazy import to avoid loading Postgres modules when not needed
        const { PostgresStorage } = require("./postgres") as {
          PostgresStorage: new (sql: unknown) => Storage;
        };
        storage = new PostgresStorage(sql);
        console.log("[storage] Using Postgres-backed storage");
      } else {
        // Database marked as enabled but connection missing — fall back
        console.warn(
          "[storage] Database enabled but connection unavailable — falling back to in-memory",
        );
        storage = new InMemoryStorage();
      }
    } else {
      storage = new InMemoryStorage();
    }
  }
  return storage;
}

/**
 * Reset the global storage instance.
 *
 * **For testing only.** Forces `getStorage()` to create a fresh instance
 * on its next call. Does NOT clear data in any previously returned instance —
 * callers holding a reference to the old instance will still see stale data.
 */
export function resetStorage(): void {
  storage = null;
}

// ---------------------------------------------------------------------------
// LangGraph checkpointer singleton
// ---------------------------------------------------------------------------

/**
 * Get the shared LangGraph checkpointer instance.
 *
 * The checkpointer is injected into the compiled graph via the graph
 * factory's `options.checkpointer` parameter. It allows LangGraph to
 * accumulate message history across multiple `invoke()` calls on the
 * same `thread_id`, using the `add_messages` reducer.
 *
 * - When `DATABASE_URL` is configured → `PostgresSaver` from
 *   `@langchain/langgraph-checkpoint-postgres` (persistent, survives restarts)
 * - When `DATABASE_URL` is not set → `MemorySaver` (in-memory, same
 *   lifecycle as `InMemoryStorage`)
 *
 * In both cases the checkpointer is a singleton — created once and reused
 * for all graph invocations.
 *
 * @returns The shared checkpointer instance.
 */
export function getCheckpointer(): BaseCheckpointSaver {
  if (checkpointer === null) {
    if (isDatabaseEnabled()) {
      const dbUrl = getDatabaseUrl();
      if (dbUrl) {
        try {
          // Lazy import to avoid loading Postgres modules when not needed
          const { PostgresSaver } = require(
            "@langchain/langgraph-checkpoint-postgres",
          ) as {
            PostgresSaver: {
              fromConnString: (url: string) => BaseCheckpointSaver;
            };
          };
          checkpointer = PostgresSaver.fromConnString(dbUrl);
          console.log("[storage] Using PostgresSaver checkpointer");
        } catch (error: unknown) {
          const message =
            error instanceof Error ? error.message : String(error);
          console.error(
            `[storage] Failed to create PostgresSaver — falling back to MemorySaver: ${message}`,
          );
          checkpointer = new MemorySaver();
        }
      } else {
        checkpointer = new MemorySaver();
      }
    } else {
      checkpointer = new MemorySaver();
    }
  }
  return checkpointer;
}

/**
 * Reset the global checkpointer instance.
 *
 * **For testing only.** Forces `getCheckpointer()` to create a fresh
 * instance on its next call.
 */
export function resetCheckpointer(): void {
  checkpointer = null;
}

// ---------------------------------------------------------------------------
// Storage lifecycle
// ---------------------------------------------------------------------------

/**
 * Initialize the storage subsystem.
 *
 * Call this once at server startup, before `Bun.serve()`. It:
 *
 * 1. Probes Postgres connectivity (if `DATABASE_URL` is set)
 * 2. Runs idempotent DDL migrations (`langgraph_server` schema + tables)
 * 3. Sets up the LangGraph `PostgresSaver` checkpoint tables (if Postgres)
 * 4. Logs the storage backend status
 *
 * If Postgres is not configured or initialization fails, the server
 * continues with in-memory storage.
 *
 * @returns `true` if Postgres was successfully initialized, `false` if
 *   using in-memory fallback.
 */
export async function initializeStorage(): Promise<boolean> {
  // Initialize the database connection and run DDL migrations
  const databaseReady = await initializeDatabase();

  if (databaseReady) {
    // Set up LangGraph PostgresSaver checkpoint tables
    try {
      const cpInstance = getCheckpointer();

      // PostgresSaver has a setup() method that creates checkpoint tables
      if ("setup" in cpInstance && typeof (cpInstance as any).setup === "function") {
        await (cpInstance as any).setup();
        console.log("[storage] LangGraph checkpoint tables ready");
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `[storage] Failed to set up LangGraph checkpoint tables: ${message}`,
      );
      // Non-fatal — checkpointer may still work if tables already exist
    }
  }

  // Log status
  logDatabaseStatus();

  return databaseReady;
}

/**
 * Shut down the storage subsystem.
 *
 * Call this during graceful server shutdown (SIGTERM/SIGINT). Closes
 * database connections and resets all singletons.
 *
 * Safe to call even when Postgres was never initialized.
 */
export async function shutdownStorage(): Promise<void> {
  // Close database connections
  await shutdownDatabase();

  // Reset singletons
  storage = null;
  checkpointer = null;

  console.log("[storage] Storage subsystem shut down");
}
