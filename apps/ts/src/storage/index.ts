/**
 * Singleton storage factory for the Fractal Agents Runtime — TypeScript/Bun.
 *
 * Mirrors Python's `get_storage()` / `reset_storage()` pattern from
 * `apps/python/src/server/storage.py`.
 *
 * In v0.0.1 only the in-memory backend is available. A future Postgres
 * backend will be selected here based on environment configuration
 * (e.g. `DATABASE_URL`), matching the Python runtime's behaviour.
 */

import type { Storage } from "./types";
import { InMemoryStorage } from "./memory";

// ---------------------------------------------------------------------------
// Module-level singleton
// ---------------------------------------------------------------------------

let storage: Storage | null = null;

/**
 * Get the global storage instance.
 *
 * Creates an `InMemoryStorage` on first call. Subsequent calls return the
 * same instance (singleton pattern).
 *
 * In a future version this will check for a `DATABASE_URL` environment
 * variable and return a Postgres-backed storage instead.
 *
 * @returns The global Storage instance with all resource stores.
 */
export function getStorage(): Storage {
  if (storage === null) {
    // TODO (Goal 25+): Check config for DATABASE_URL and return
    // PostgresStorage when available, matching Python's behaviour:
    //
    //   if (config.databaseUrl) {
    //     storage = new PostgresStorage(config.databaseUrl);
    //   } else {
    //     storage = new InMemoryStorage();
    //   }
    storage = new InMemoryStorage();
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
