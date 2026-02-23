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
 * Parse a PostgreSQL array value returned by Bun.sql.
 *
 * Bun.sql ≤1.3.9 returns `text[]` columns as proper JS arrays but returns
 * `uuid[]` columns as raw Postgres literal strings like
 * `"{a1b2c3d4-...,e5f6-...}"`. This helper normalises both cases into a
 * JS `string[]`.
 *
 * @param value - The raw column value (may be a JS array, a Postgres literal
 *   string, `null`, or `undefined`).
 * @returns A `string[]`, or `null` if the input is nullish.
 */
export function parsePostgresArray(value: unknown): string[] | null {
  if (value == null) {
    return null;
  }
  // Already a JS array (text[] columns in Bun.sql)
  if (Array.isArray(value)) {
    return value.map(String);
  }
  // Raw Postgres literal string: "{uuid1,uuid2}" or "{}"
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "{}" || trimmed === "") {
      return [];
    }
    // Strip surrounding braces and split on commas.
    // Values may be double-quoted: {"val with space","simple"}
    const inner = trimmed.replace(/^\{/, "").replace(/\}$/, "");
    const elements: string[] = [];
    let current = "";
    let inQuotes = false;
    let escaped = false;
    for (const character of inner) {
      if (escaped) {
        current += character;
        escaped = false;
        continue;
      }
      if (character === "\\") {
        escaped = true;
        continue;
      }
      if (character === '"') {
        inQuotes = !inQuotes;
        continue;
      }
      if (character === "," && !inQuotes) {
        elements.push(current);
        current = "";
        continue;
      }
      current += character;
    }
    if (current.length > 0) {
      elements.push(current);
    }
    return elements;
  }
  return null;
}

/**
 * Convert a JavaScript array to a PostgreSQL array literal string.
 *
 * Bun.sql's `sql.array()` has a bug in Bun ≤1.3.9 where string values
 * get double-quoted (e.g. `["usb","nfc"]` becomes `{"\"usb\"","\"nfc\""}` in
 * the database instead of `{"usb","nfc"}`). This helper produces a correct
 * Postgres array literal that can be used in tagged templates with an
 * explicit type cast:
 *
 * ```ts
 * const sql = getDb();
 * await sql`INSERT INTO t (vals) VALUES (${toPostgresArrayLiteral(arr)}::text[])`;
 * ```
 *
 * For empty arrays, returns `"{}"`.
 *
 * Values containing commas, quotes, backslashes, braces, or spaces are
 * properly escaped with double-quote wrapping per PostgreSQL array syntax.
 *
 * @param values - The JavaScript array of strings to convert.
 * @returns A PostgreSQL array literal string (e.g. `"{usb,nfc}"`).
 */
export function toPostgresArrayLiteral(values: string[]): string {
  if (!values || values.length === 0) {
    return "{}";
  }
  return (
    "{" +
    values
      .map((value) => {
        const stringValue = String(value);
        // Values that need quoting: contain special Postgres array chars
        if (
          stringValue.includes(",") ||
          stringValue.includes('"') ||
          stringValue.includes("\\") ||
          stringValue.includes("{") ||
          stringValue.includes("}") ||
          stringValue.includes(" ")
        ) {
          return (
            '"' +
            stringValue
              .replace(/\\/g, "\\\\")
              .replace(/"/g, '\\"') +
            '"'
          );
        }
        return stringValue;
      })
      .join(",") +
    "}"
  );
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
  if (error == null || typeof error !== "object") {
    return false;
  }
  const record = error as Record<string, unknown>;
  // Bun.sql puts the PG error code in `errno` (e.g. "23505") and sets
  // `code` to "ERR_POSTGRES_SERVER_ERROR". Check both properties so
  // the helper works regardless of driver conventions.
  if (record.errno === "23505" || record.code === "23505") {
    return true;
  }
  return false;
}
