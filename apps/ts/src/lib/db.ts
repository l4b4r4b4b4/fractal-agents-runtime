/**
 * Database connection module for Fractal Agents Runtime — TypeScript/Bun.
 *
 * Provides a lazy-initialized singleton PostgreSQL connection using Bun's
 * native `Bun.sql` driver (zero npm dependencies). The connection URL is
 * read from `DATABASE_URL` and SSL is automatically disabled for localhost
 * connections (local Supabase dev server).
 *
 * Usage:
 *   import { getDb } from "../lib/db";
 *   const sql = getDb();
 *   const rows = await sql`SELECT * FROM public.hardware_keys WHERE user_id = ${userId}`;
 *
 * Reference:
 *   - Bun.sql docs: https://bun.sh/docs/api/sql
 *   - apps/python/src/server/database.py (Python equivalent)
 */

import { SQL } from "bun";

/** Module-level singleton — created on first call to `getDb()`. */
let _sql: InstanceType<typeof SQL> | null = null;

/**
 * Get (or lazily create) the shared database connection.
 *
 * On first invocation the function reads `DATABASE_URL` from the environment,
 * appends `sslmode=disable` for localhost URLs (Supabase local dev), and
 * creates a `Bun.SQL` instance with connection pooling.
 *
 * Subsequent calls return the same instance.
 *
 * @returns A `Bun.SQL` tagged-template instance for executing queries.
 * @throws {Error} If `DATABASE_URL` is not set.
 */
export function getDb(): InstanceType<typeof SQL> {
  if (_sql) {
    return _sql;
  }

  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL environment variable is not configured. " +
        "Set it to a PostgreSQL connection string (e.g. postgres://user:pass@localhost:54322/postgres).",
    );
  }

  // Local Supabase: append sslmode=disable when connecting to localhost
  // to avoid TLS handshake errors against the unencrypted local pooler.
  const isLocalhost =
    url.includes("localhost") || url.includes("127.0.0.1");
  const alreadyHasSslMode = url.includes("sslmode");
  const needsSslDisable = isLocalhost && !alreadyHasSslMode;

  const separator = url.includes("?") ? "&" : "?";
  const connectionUrl = needsSslDisable
    ? `${url}${separator}sslmode=disable`
    : url;

  _sql = new SQL(connectionUrl);

  return _sql;
}

/**
 * Close the database connection and reset the singleton.
 *
 * Primarily used in tests or graceful shutdown to release the connection pool.
 */
export async function closeDb(): Promise<void> {
  if (_sql) {
    await _sql.close();
    _sql = null;
  }
}

/**
 * Check whether a database error is a PostgreSQL unique-violation (23505).
 *
 * Bun.sql throws `SQL.PostgresError` on constraint violations. This helper
 * inspects the error's `code` property without requiring callers to import
 * the `SQL` class directly.
 *
 * @param error - The caught error value.
 * @returns `true` if the error is a unique-violation.
 */
export function isUniqueViolation(error: unknown): boolean {
  if (
    error != null &&
    typeof error === "object" &&
    "code" in error &&
    (error as Record<string, unknown>).code === "23505"
  ) {
    return true;
  }
  return false;
}
