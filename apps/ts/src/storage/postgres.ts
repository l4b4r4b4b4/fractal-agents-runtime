/**
 * Postgres-backed storage implementations for the Fractal Agents Runtime — TypeScript/Bun.
 *
 * Provides `PostgresAssistantStore`, `PostgresThreadStore`, and `PostgresRunStore`
 * that implement the same interfaces as the in-memory stores in `memory.ts`.
 * All queries use parameterized SQL via Postgres.js tagged template literals
 * to prevent SQL injection.
 *
 * ## Schema
 *
 * All tables live in the `langgraph_server` schema, matching the Python
 * runtime's `postgres_storage.py` exactly. Both runtimes can share a single
 * Postgres database deployment.
 *
 * ## Owner Isolation
 *
 * Owner scoping uses `metadata->>'owner'` WHERE clauses. When `ownerId` is
 * provided to a method, queries are filtered to only return resources owned
 * by that user. When `ownerId` is `undefined` (auth disabled), no owner
 * filtering is applied — matching v0.0.1 behavior.
 *
 * ## Connection Management
 *
 * Each store receives the Postgres.js `Sql` client from `database.ts`.
 * Postgres.js handles connection pooling internally. Unlike the Python
 * runtime (per-request connections due to multi-event-loop issues), Bun
 * is single-threaded, so a shared pool is correct.
 *
 * Reference: apps/python/src/server/postgres_storage.py
 */

import type { Sql, JSONValue } from "postgres";

import type {
  Assistant,
  AssistantCreate,
  AssistantPatch,
  AssistantSearchRequest,
  AssistantCountRequest,
  Config,
} from "../models/assistant";
import type {
  Thread,
  ThreadCreate,
  ThreadPatch,
  ThreadSearchRequest,
  ThreadCountRequest,
  ThreadState,
  ThreadStatus,
} from "../models/thread";
import type { Run, RunStatus, MultitaskStrategy } from "../models/run";
import type { StoreItem } from "../models/store";
import type {
  AssistantStore,
  ThreadStore,
  RunStore,
  StoreStorage,
  CronStore,
  Storage,
} from "./types";
import { InMemoryCronStore } from "./memory";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Schema name matching Python runtime's `_SCHEMA`. */
const SCHEMA = "langgraph_server";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a UUID (with dashes — matches OpenAPI `format: uuid`). */
function generateId(): string {
  return crypto.randomUUID();
}

/** Current UTC time as ISO 8601 string with Z suffix. */
function utcNow(): string {
  return new Date().toISOString();
}

/**
 * Cast a value to `JSONValue` for Postgres.js `sql.json()`.
 *
 * Postgres.js's `sql.json()` accepts `JSONValue`, but our types use
 * `Record<string, unknown>` which isn't directly assignable. This helper
 * performs a safe cast since all our values are JSON-serializable objects.
 */
function asJson(value: unknown): JSONValue {
  return (value ?? {}) as JSONValue;
}

/**
 * Parse a JSONB value from a Postgres row.
 * Returns an empty object if the value is null/undefined/empty string.
 */
function parseJsonb(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) {
    return {};
  }
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  if (typeof value === "object") {
    return value as Record<string, unknown>;
  }
  return {};
}

/**
 * Format a Postgres timestamp value to ISO 8601 string with Z suffix.
 */
function formatTimestamp(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "string") {
    // If it already ends with Z, return as-is; otherwise parse and format
    if (value.endsWith("Z")) {
      return value;
    }
    try {
      return new Date(value).toISOString();
    } catch {
      return value;
    }
  }
  return new Date().toISOString();
}

// ============================================================================
// Postgres Assistant Store
// ============================================================================

/**
 * Postgres-backed implementation of `AssistantStore`.
 *
 * All queries target `langgraph_server.assistants`. Owner isolation is
 * enforced via `metadata->>'owner'` WHERE clauses when `ownerId` is provided.
 *
 * Reference: apps/python/src/server/postgres_storage.py → PostgresAssistantStore
 */
export class PostgresAssistantStore implements AssistantStore {
  constructor(private readonly sql: Sql) {}

  async create(data: AssistantCreate): Promise<Assistant> {
    const assistantId = data.assistant_id || generateId();
    const now = utcNow();

    // Check for existing assistant
    const existing = await this.sql`
      SELECT id FROM ${this.sql(SCHEMA)}.assistants
      WHERE id = ${assistantId}
    `;

    if (existing.length > 0) {
      const strategy = data.if_exists ?? "raise";
      if (strategy === "do_nothing") {
        return (await this.get(assistantId))!;
      }
      throw new Error(
        `Assistant ${assistantId} already exists. Use if_exists='do_nothing' to return existing.`,
      );
    }

    const configValue = data.config ?? {};
    const parsedConfig: Config = {
      tags: (configValue as Record<string, unknown>).tags as string[] | undefined ?? [],
      recursion_limit:
        (configValue as Record<string, unknown>).recursion_limit as number | undefined ?? 25,
      configurable:
        (configValue as Record<string, unknown>).configurable as Record<string, unknown> | undefined ?? {},
    };

    await this.sql`
      INSERT INTO ${this.sql(SCHEMA)}.assistants
        (id, graph_id, config, context, metadata, name, description, version, created_at, updated_at)
      VALUES (
        ${assistantId},
        ${data.graph_id},
        ${this.sql.json(asJson(parsedConfig))},
        ${this.sql.json(asJson(data.context ?? {}))},
        ${this.sql.json(asJson(data.metadata ?? {}))},
        ${data.name ?? null},
        ${data.description ?? null},
        ${1},
        ${now},
        ${now}
      )
    `;

    return (await this.get(assistantId))!;
  }

  async get(assistantId: string): Promise<Assistant | null> {
    const rows = await this.sql`
      SELECT * FROM ${this.sql(SCHEMA)}.assistants
      WHERE id = ${assistantId}
    `;

    if (rows.length === 0) {
      return null;
    }

    return this.rowToModel(rows[0]);
  }

  async search(request: AssistantSearchRequest): Promise<Assistant[]> {
    const limit = Math.min(Math.max(request.limit ?? 10, 1), 1000);
    const offset = Math.max(request.offset ?? 0, 0);
    const sortBy = request.sort_by ?? "created_at";
    const sortOrder = request.sort_order ?? "desc";

    // Build dynamic query with conditional WHERE clauses
    // Postgres.js tagged templates handle parameterization safely
    let rows;

    if (request.graph_id && request.metadata && Object.keys(request.metadata).length > 0) {
      rows = await this.sql`
        SELECT * FROM ${this.sql(SCHEMA)}.assistants
        WHERE graph_id = ${request.graph_id}
          AND metadata @> ${this.sql.json(asJson(request.metadata))}
          ${request.name ? this.sql`AND name ILIKE ${"%" + request.name + "%"}` : this.sql``}
        ORDER BY ${this.sql(sortBy)} ${sortOrder === "asc" ? this.sql`ASC` : this.sql`DESC`}
        LIMIT ${limit} OFFSET ${offset}
      `;
    } else if (request.graph_id) {
      rows = await this.sql`
        SELECT * FROM ${this.sql(SCHEMA)}.assistants
        WHERE graph_id = ${request.graph_id}
          ${request.name ? this.sql`AND name ILIKE ${"%" + request.name + "%"}` : this.sql``}
        ORDER BY ${this.sql(sortBy)} ${sortOrder === "asc" ? this.sql`ASC` : this.sql`DESC`}
        LIMIT ${limit} OFFSET ${offset}
      `;
    } else if (request.metadata && Object.keys(request.metadata).length > 0) {
      rows = await this.sql`
        SELECT * FROM ${this.sql(SCHEMA)}.assistants
        WHERE metadata @> ${this.sql.json(asJson(request.metadata))}
          ${request.name ? this.sql`AND name ILIKE ${"%" + request.name + "%"}` : this.sql``}
        ORDER BY ${this.sql(sortBy)} ${sortOrder === "asc" ? this.sql`ASC` : this.sql`DESC`}
        LIMIT ${limit} OFFSET ${offset}
      `;
    } else if (request.name) {
      rows = await this.sql`
        SELECT * FROM ${this.sql(SCHEMA)}.assistants
        WHERE name ILIKE ${"%" + request.name + "%"}
        ORDER BY ${this.sql(sortBy)} ${sortOrder === "asc" ? this.sql`ASC` : this.sql`DESC`}
        LIMIT ${limit} OFFSET ${offset}
      `;
    } else {
      rows = await this.sql`
        SELECT * FROM ${this.sql(SCHEMA)}.assistants
        ORDER BY ${this.sql(sortBy)} ${sortOrder === "asc" ? this.sql`ASC` : this.sql`DESC`}
        LIMIT ${limit} OFFSET ${offset}
      `;
    }

    return rows.map((row) => this.rowToModel(row));
  }

  async update(
    assistantId: string,
    data: AssistantPatch,
  ): Promise<Assistant | null> {
    const existing = await this.get(assistantId);
    if (!existing) {
      return null;
    }

    const now = utcNow();
    const newVersion = (existing.version ?? 1) + 1;

    // Merge metadata (shallow merge — matching Python behavior)
    const mergedMetadata = {
      ...(existing.metadata ?? {}),
      ...(data.metadata ?? {}),
    };

    // Build updated config if provided
    let updatedConfig = existing.config;
    if (data.config !== undefined) {
      const rawConfig = data.config as Record<string, unknown>;
      updatedConfig = {
        tags: (rawConfig.tags as string[] | undefined) ?? existing.config.tags ?? [],
        recursion_limit:
          (rawConfig.recursion_limit as number | undefined) ??
          existing.config.recursion_limit ??
          25,
        configurable:
          (rawConfig.configurable as Record<string, unknown> | undefined) ??
          existing.config.configurable ??
          {},
      };
    }

    await this.sql`
      UPDATE ${this.sql(SCHEMA)}.assistants
      SET
        graph_id = ${data.graph_id ?? existing.graph_id},
        config = ${this.sql.json(asJson(updatedConfig))},
        context = ${this.sql.json(asJson(data.context ?? existing.context ?? {}))},
        metadata = ${this.sql.json(asJson(mergedMetadata))},
        name = ${data.name ?? existing.name ?? null},
        description = ${data.description ?? existing.description ?? null},
        version = ${newVersion},
        updated_at = ${now}
      WHERE id = ${assistantId}
    `;

    return this.get(assistantId);
  }

  async delete(assistantId: string): Promise<boolean> {
    const result = await this.sql`
      DELETE FROM ${this.sql(SCHEMA)}.assistants
      WHERE id = ${assistantId}
    `;
    return result.count > 0;
  }

  async count(request?: AssistantCountRequest): Promise<number> {
    let rows;

    if (request?.graph_id && request?.metadata && Object.keys(request.metadata).length > 0) {
      rows = await this.sql`
        SELECT COUNT(*)::int AS count FROM ${this.sql(SCHEMA)}.assistants
        WHERE graph_id = ${request.graph_id}
          AND metadata @> ${this.sql.json(asJson(request.metadata))}
          ${request.name ? this.sql`AND name ILIKE ${"%" + request.name + "%"}` : this.sql``}
      `;
    } else if (request?.graph_id) {
      rows = await this.sql`
        SELECT COUNT(*)::int AS count FROM ${this.sql(SCHEMA)}.assistants
        WHERE graph_id = ${request.graph_id}
          ${request?.name ? this.sql`AND name ILIKE ${"%" + request.name + "%"}` : this.sql``}
      `;
    } else if (request?.metadata && Object.keys(request.metadata).length > 0) {
      rows = await this.sql`
        SELECT COUNT(*)::int AS count FROM ${this.sql(SCHEMA)}.assistants
        WHERE metadata @> ${this.sql.json(asJson(request.metadata))}
          ${request?.name ? this.sql`AND name ILIKE ${"%" + request.name + "%"}` : this.sql``}
      `;
    } else if (request?.name) {
      rows = await this.sql`
        SELECT COUNT(*)::int AS count FROM ${this.sql(SCHEMA)}.assistants
        WHERE name ILIKE ${"%" + request.name + "%"}
      `;
    } else {
      rows = await this.sql`
        SELECT COUNT(*)::int AS count FROM ${this.sql(SCHEMA)}.assistants
      `;
    }

    return rows[0]?.count ?? 0;
  }

  async clear(): Promise<void> {
    await this.sql`DELETE FROM ${this.sql(SCHEMA)}.assistants`;
  }

  /**
   * Convert a Postgres row to an `Assistant` model object.
   */
  private rowToModel(row: Record<string, unknown>): Assistant {
    const configData = parseJsonb(row.config);
    const config: Config = {
      tags: (configData.tags as string[] | undefined) ?? [],
      recursion_limit: (configData.recursion_limit as number | undefined) ?? 25,
      configurable:
        (configData.configurable as Record<string, unknown> | undefined) ?? {},
    };

    return {
      assistant_id: row.id as string,
      graph_id: row.graph_id as string,
      config,
      context: parseJsonb(row.context),
      metadata: parseJsonb(row.metadata),
      name: (row.name as string | undefined) ?? undefined,
      description: (row.description as string | null) ?? null,
      version: (row.version as number | undefined) ?? 1,
      created_at: formatTimestamp(row.created_at),
      updated_at: formatTimestamp(row.updated_at),
    };
  }
}

// ============================================================================
// Postgres Thread Store
// ============================================================================

/**
 * Postgres-backed implementation of `ThreadStore`.
 *
 * Thread data is stored in `langgraph_server.threads`. State history
 * snapshots are stored in `langgraph_server.thread_states` with a
 * foreign key cascade delete.
 *
 * Reference: apps/python/src/server/postgres_storage.py → PostgresThreadStore
 */
export class PostgresThreadStore implements ThreadStore {
  constructor(private readonly sql: Sql) {}

  async create(data: ThreadCreate, ownerId?: string): Promise<Thread> {
    const threadId = data.thread_id || generateId();
    const now = utcNow();

    // Check for existing thread
    const existing = await this.sql`
      SELECT id FROM ${this.sql(SCHEMA)}.threads
      WHERE id = ${threadId}
    `;

    if (existing.length > 0) {
      const strategy = data.if_exists ?? "raise";
      if (strategy === "do_nothing") {
        return (await this.get(threadId))!;
      }
      throw new Error(
        `Thread ${threadId} already exists. Use if_exists='do_nothing' to return existing.`,
      );
    }

    // Inject metadata.owner when ownerId is provided (matching Python runtime)
    const metadata = { ...(data.metadata ?? {}) };
    if (ownerId !== undefined) {
      metadata.owner = ownerId;
    }

    await this.sql`
      INSERT INTO ${this.sql(SCHEMA)}.threads
        (id, metadata, config, status, values, interrupts, created_at, updated_at)
      VALUES (
        ${threadId},
        ${this.sql.json(asJson(metadata))},
        ${this.sql.json(asJson({}))},
        ${"idle"},
        ${this.sql.json(asJson({}))},
        ${this.sql.json(asJson({}))},
        ${now},
        ${now}
      )
    `;

    return (await this.get(threadId))!;
  }

  async get(threadId: string, ownerId?: string): Promise<Thread | null> {
    let rows;

    if (ownerId !== undefined) {
      // Owner-scoped lookup: only return thread if owned by this user
      rows = await this.sql`
        SELECT * FROM ${this.sql(SCHEMA)}.threads
        WHERE id = ${threadId}
          AND metadata->>'owner' = ${ownerId}
      `;
    } else {
      // No owner filter (auth disabled or internal call)
      rows = await this.sql`
        SELECT * FROM ${this.sql(SCHEMA)}.threads
        WHERE id = ${threadId}
      `;
    }

    if (rows.length === 0) {
      return null;
    }

    return this.rowToModel(rows[0]);
  }

  async search(request: ThreadSearchRequest, ownerId?: string): Promise<Thread[]> {
    const limit = Math.min(Math.max(request.limit ?? 10, 1), 1000);
    const offset = Math.max(request.offset ?? 0, 0);
    const sortBy = request.sort_by ?? "created_at";
    const sortOrder = request.sort_order ?? "desc";

    // Build owner-scoped metadata filter.
    // When ownerId is provided, merge {"owner": ownerId} into the metadata
    // filter so the SQL WHERE clause includes the owner constraint.
    let effectiveMetadata: Record<string, unknown> | undefined = request.metadata;
    if (ownerId !== undefined) {
      effectiveMetadata = { ...(effectiveMetadata ?? {}), owner: ownerId };
    }
    const hasMetadata = effectiveMetadata && Object.keys(effectiveMetadata).length > 0;

    let rows;

    if (request.status && hasMetadata) {
      rows = await this.sql`
        SELECT * FROM ${this.sql(SCHEMA)}.threads
        WHERE status = ${request.status}
          AND metadata @> ${this.sql.json(asJson(effectiveMetadata!))}
        ORDER BY ${this.sql(sortBy)} ${sortOrder === "asc" ? this.sql`ASC` : this.sql`DESC`}
        LIMIT ${limit} OFFSET ${offset}
      `;
    } else if (request.status) {
      rows = await this.sql`
        SELECT * FROM ${this.sql(SCHEMA)}.threads
        WHERE status = ${request.status}
        ORDER BY ${this.sql(sortBy)} ${sortOrder === "asc" ? this.sql`ASC` : this.sql`DESC`}
        LIMIT ${limit} OFFSET ${offset}
      `;
    } else if (hasMetadata) {
      rows = await this.sql`
        SELECT * FROM ${this.sql(SCHEMA)}.threads
        WHERE metadata @> ${this.sql.json(asJson(effectiveMetadata!))}
        ORDER BY ${this.sql(sortBy)} ${sortOrder === "asc" ? this.sql`ASC` : this.sql`DESC`}
        LIMIT ${limit} OFFSET ${offset}
      `;
    } else {
      rows = await this.sql`
        SELECT * FROM ${this.sql(SCHEMA)}.threads
        ORDER BY ${this.sql(sortBy)} ${sortOrder === "asc" ? this.sql`ASC` : this.sql`DESC`}
        LIMIT ${limit} OFFSET ${offset}
      `;
    }

    let results = rows.map((row) => this.rowToModel(row));

    // Apply ID filter in JS (Postgres.js doesn't support dynamic IN easily)
    if (request.ids && request.ids.length > 0) {
      const idSet = new Set(request.ids);
      results = results.filter((thread) => idSet.has(thread.thread_id));
    }

    // Apply values filter in JS
    if (request.values && typeof request.values === "object") {
      const filterEntries = Object.entries(request.values);
      results = results.filter((thread) => {
        const threadValues = thread.values as Record<string, unknown> | undefined;
        if (!threadValues) return false;
        return filterEntries.every(
          ([key, value]) => threadValues[key] === value,
        );
      });
    }

    return results;
  }

  async update(
    threadId: string,
    data: ThreadPatch,
    ownerId?: string,
  ): Promise<Thread | null> {
    // When ownerId is provided, verify the caller owns the thread (write access).
    // When ownerId is undefined (auth disabled / internal call), allow any thread.
    const existing = await this.get(threadId, ownerId);
    if (!existing) {
      return null;
    }

    const now = utcNow();

    // Merge metadata (shallow merge — matching Python behavior & InMemoryThreadStore)
    const mergedMetadata = {
      ...(existing.metadata ?? {}),
      ...(data.metadata ?? {}),
    };

    // Preserve the owner field — users cannot change ownership via metadata merge
    const existingOwner = (existing.metadata as Record<string, unknown>)?.owner;
    if (existingOwner !== undefined) {
      mergedMetadata.owner = existingOwner;
    }

    // Resolve status and values (matching InMemoryThreadStore behavior)
    const effectiveStatus = data.status ?? existing.status;
    const effectiveValues = data.values ?? existing.values;

    await this.sql`
      UPDATE ${this.sql(SCHEMA)}.threads
      SET
        metadata = ${this.sql.json(asJson(mergedMetadata))},
        status = ${effectiveStatus},
        values = ${this.sql.json(asJson(effectiveValues ?? {}))},
        updated_at = ${now}
      WHERE id = ${threadId}
    `;

    return this.get(threadId);
  }

  async delete(threadId: string, ownerId?: string): Promise<boolean> {
    // When ownerId is provided, only delete if owned by this user (write access)
    if (ownerId !== undefined) {
      const result = await this.sql`
        DELETE FROM ${this.sql(SCHEMA)}.threads
        WHERE id = ${threadId}
          AND metadata->>'owner' = ${ownerId}
      `;
      return result.count > 0;
    }

    // No owner filter (auth disabled or internal call)
    const result = await this.sql`
      DELETE FROM ${this.sql(SCHEMA)}.threads
      WHERE id = ${threadId}
    `;
    return result.count > 0;
  }

  async count(request?: ThreadCountRequest, ownerId?: string): Promise<number> {
    // Build owner-scoped metadata filter (same approach as search)
    let effectiveMetadata: Record<string, unknown> | undefined = request?.metadata;
    if (ownerId !== undefined) {
      effectiveMetadata = { ...(effectiveMetadata ?? {}), owner: ownerId };
    }
    const hasMetadata = effectiveMetadata && Object.keys(effectiveMetadata).length > 0;

    let rows;

    if (request?.status && hasMetadata) {
      rows = await this.sql`
        SELECT COUNT(*)::int AS count FROM ${this.sql(SCHEMA)}.threads
        WHERE status = ${request.status}
          AND metadata @> ${this.sql.json(asJson(effectiveMetadata!))}
      `;
    } else if (request?.status) {
      rows = await this.sql`
        SELECT COUNT(*)::int AS count FROM ${this.sql(SCHEMA)}.threads
        WHERE status = ${request.status}
      `;
    } else if (hasMetadata) {
      rows = await this.sql`
        SELECT COUNT(*)::int AS count FROM ${this.sql(SCHEMA)}.threads
        WHERE metadata @> ${this.sql.json(asJson(effectiveMetadata!))}
      `;
    } else {
      rows = await this.sql`
        SELECT COUNT(*)::int AS count FROM ${this.sql(SCHEMA)}.threads
      `;
    }

    return rows[0]?.count ?? 0;
  }

  async getState(threadId: string, _ownerId?: string): Promise<ThreadState | null> {
    // BUG-A fix: Read-only access — check thread existence by ID only,
    // no owner filter. Any authenticated user who knows the thread ID
    // can read its state (required for multi-user chat and page refresh).
    const thread = await this.get(threadId);
    if (!thread) {
      return null;
    }

    // Get the most recent state snapshot, if any
    const snapshots = await this.sql`
      SELECT * FROM ${this.sql(SCHEMA)}.thread_states
      WHERE thread_id = ${threadId}
      ORDER BY created_at DESC
      LIMIT 1
    `;

    const now = utcNow();

    if (snapshots.length > 0) {
      const snapshot = snapshots[0];
      return {
        values: parseJsonb(snapshot.values),
        next: (snapshot.next as string[] | undefined) ?? [],
        tasks: parseJsonb(snapshot.tasks) as unknown as Record<string, unknown>[],
        checkpoint: {
          thread_id: threadId,
          checkpoint_ns: "",
          checkpoint_id: snapshot.checkpoint_id as string,
        },
        metadata: parseJsonb(snapshot.metadata),
        created_at: formatTimestamp(snapshot.created_at),
        parent_checkpoint: snapshot.parent_checkpoint
          ? parseJsonb(snapshot.parent_checkpoint)
          : undefined,
        interrupts: parseJsonb(snapshot.interrupts) as unknown as Record<string, unknown>[],
      };
    }

    // No snapshots — return default state from thread data
    return {
      values: parseJsonb(thread.values),
      next: [],
      tasks: [],
      checkpoint: {
        thread_id: threadId,
        checkpoint_ns: "",
        checkpoint_id: `checkpoint_${Date.now()}`,
      },
      metadata: thread.metadata ?? {},
      created_at: now,
      parent_checkpoint: undefined,
      interrupts: [],
    };
  }

  async addStateSnapshot(
    threadId: string,
    state: Record<string, unknown>,
    _ownerId?: string,
  ): Promise<boolean> {
    // No owner filter — the stream handler already authenticated the user
    // and the checkpointer needs to write state for any active thread.
    const thread = await this.get(threadId);
    if (!thread) {
      return false;
    }

    // Extract values — callers should pass { values: {...} }
    // but handle the case where they pass the values directly
    let snapshotValues: Record<string, unknown>;
    if (
      "values" in state &&
      typeof state.values === "object" &&
      state.values !== null
    ) {
      snapshotValues = state.values as Record<string, unknown>;
    } else {
      console.warn(
        `[postgres-storage] addStateSnapshot called without "values" key for thread ${threadId}. Using state directly as values. Callers should pass { values: {...} }.`,
      );
      snapshotValues = state;
    }

    const now = utcNow();
    const checkpointId = `checkpoint_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // Get the previous checkpoint for parent_checkpoint reference
    const previousSnapshots = await this.sql`
      SELECT checkpoint_id FROM ${this.sql(SCHEMA)}.thread_states
      WHERE thread_id = ${threadId}
      ORDER BY created_at DESC
      LIMIT 1
    `;

    const parentCheckpoint =
      previousSnapshots.length > 0
        ? {
            thread_id: threadId,
            checkpoint_ns: "",
            checkpoint_id: previousSnapshots[0].checkpoint_id as string,
          }
        : null;

    // Insert the state snapshot
    await this.sql`
      INSERT INTO ${this.sql(SCHEMA)}.thread_states
        (thread_id, values, metadata, next, tasks, checkpoint_id, parent_checkpoint, interrupts, created_at)
      VALUES (
        ${threadId},
        ${this.sql.json(asJson(snapshotValues))},
        ${this.sql.json(asJson(thread.metadata ?? {}))},
        ${this.sql.array([] as string[])},
        ${this.sql.json(asJson([]))},
        ${checkpointId},
        ${parentCheckpoint ? this.sql.json(asJson(parentCheckpoint)) : null},
        ${this.sql.json(asJson([]))},
        ${now}
      )
    `;

    // Update the thread's current values and updated_at
    await this.sql`
      UPDATE ${this.sql(SCHEMA)}.threads
      SET
        values = ${this.sql.json(asJson(snapshotValues))},
        updated_at = ${now}
      WHERE id = ${threadId}
    `;

    return true;
  }

  async getHistory(
    threadId: string,
    limit?: number,
    before?: string,
    _ownerId?: string,
  ): Promise<ThreadState[] | null> {
    // BUG-A fix: Read-only access — check thread existence by ID only,
    // no owner filter. Any authenticated user who knows the thread ID
    // can read its history. This is essential for:
    //   - Single-user page refresh (useStream re-mounts with existing threadId)
    //   - Multi-user chat (second participant loads thread history)
    //   - Navigation away and back (component re-mount)
    const thread = await this.get(threadId);
    if (!thread) {
      return null;
    }

    const effectiveLimit = Math.min(Math.max(limit ?? 10, 1), 1000);

    let rows: Record<string, unknown>[];

    if (before) {
      // Get the created_at of the "before" checkpoint to use as a cursor
      const beforeRows = await this.sql`
        SELECT created_at FROM ${this.sql(SCHEMA)}.thread_states
        WHERE thread_id = ${threadId} AND checkpoint_id = ${before}
      `;

      if (beforeRows.length > 0) {
        rows = await this.sql`
          SELECT * FROM ${this.sql(SCHEMA)}.thread_states
          WHERE thread_id = ${threadId}
            AND created_at < ${beforeRows[0].created_at}
          ORDER BY created_at DESC
          LIMIT ${effectiveLimit}
        `;
      } else {
        // before checkpoint not found — return empty
        rows = [];
      }
    } else {
      rows = await this.sql`
        SELECT * FROM ${this.sql(SCHEMA)}.thread_states
        WHERE thread_id = ${threadId}
        ORDER BY created_at DESC
        LIMIT ${effectiveLimit}
      `;
    }

    return rows.map((snapshot) => ({
      values: parseJsonb(snapshot.values),
      next: (snapshot.next as string[] | undefined) ?? [],
      tasks: parseJsonb(snapshot.tasks) as unknown as Record<string, unknown>[],
      checkpoint: {
        thread_id: threadId,
        checkpoint_ns: "",
        checkpoint_id: snapshot.checkpoint_id as string,
      },
      metadata: parseJsonb(snapshot.metadata),
      created_at: formatTimestamp(snapshot.created_at),
      parent_checkpoint: snapshot.parent_checkpoint
        ? parseJsonb(snapshot.parent_checkpoint)
        : undefined,
      interrupts: parseJsonb(snapshot.interrupts) as unknown as Record<string, unknown>[],
    }));
  }

  async clear(): Promise<void> {
    // thread_states are CASCADE deleted with threads
    await this.sql`DELETE FROM ${this.sql(SCHEMA)}.thread_states`;
    await this.sql`DELETE FROM ${this.sql(SCHEMA)}.threads`;
  }

  /**
   * Convert a Postgres row to a `Thread` model object.
   */
  private rowToModel(row: Record<string, unknown>): Thread {
    return {
      thread_id: row.id as string,
      metadata: parseJsonb(row.metadata),
      config: parseJsonb(row.config),
      status: (row.status as ThreadStatus) ?? "idle",
      values: parseJsonb(row.values),
      interrupts: parseJsonb(row.interrupts),
      created_at: formatTimestamp(row.created_at),
      updated_at: formatTimestamp(row.updated_at),
    };
  }
}

// ============================================================================
// Postgres Run Store
// ============================================================================

/**
 * Postgres-backed implementation of `RunStore`.
 *
 * All queries target `langgraph_server.runs`. Runs are always scoped to a
 * thread, so most operations take `threadId` as a parameter.
 *
 * Reference: apps/python/src/server/postgres_storage.py → PostgresRunStore
 */
export class PostgresRunStore implements RunStore {
  constructor(private readonly sql: Sql) {}

  async create(data: {
    thread_id: string;
    assistant_id: string;
    status?: RunStatus;
    metadata?: Record<string, unknown>;
    kwargs?: Record<string, unknown>;
    multitask_strategy?: string;
  }): Promise<Run> {
    if (!data.thread_id) {
      throw new Error("thread_id is required to create a run");
    }
    if (!data.assistant_id) {
      throw new Error("assistant_id is required to create a run");
    }

    const runId = generateId();
    const now = utcNow();
    const status = data.status ?? "pending";

    await this.sql`
      INSERT INTO ${this.sql(SCHEMA)}.runs
        (id, thread_id, assistant_id, status, metadata, kwargs, multitask_strategy, created_at, updated_at)
      VALUES (
        ${runId},
        ${data.thread_id},
        ${data.assistant_id},
        ${status},
        ${this.sql.json(asJson(data.metadata ?? {}))},
        ${this.sql.json(asJson(data.kwargs ?? {}))},
        ${data.multitask_strategy ?? "reject"},
        ${now},
        ${now}
      )
    `;

    return (await this.get(runId))!;
  }

  async get(runId: string): Promise<Run | null> {
    const rows = await this.sql`
      SELECT * FROM ${this.sql(SCHEMA)}.runs
      WHERE id = ${runId}
    `;

    if (rows.length === 0) {
      return null;
    }

    return this.rowToModel(rows[0]);
  }

  async listByThread(
    threadId: string,
    limit?: number,
    offset?: number,
    status?: RunStatus,
  ): Promise<Run[]> {
    const effectiveLimit = Math.min(Math.max(limit ?? 10, 1), 1000);
    const effectiveOffset = Math.max(offset ?? 0, 0);

    let rows;

    if (status) {
      rows = await this.sql`
        SELECT * FROM ${this.sql(SCHEMA)}.runs
        WHERE thread_id = ${threadId} AND status = ${status}
        ORDER BY created_at DESC
        LIMIT ${effectiveLimit} OFFSET ${effectiveOffset}
      `;
    } else {
      rows = await this.sql`
        SELECT * FROM ${this.sql(SCHEMA)}.runs
        WHERE thread_id = ${threadId}
        ORDER BY created_at DESC
        LIMIT ${effectiveLimit} OFFSET ${effectiveOffset}
      `;
    }

    return rows.map((row) => this.rowToModel(row));
  }

  async getByThread(threadId: string, runId: string): Promise<Run | null> {
    const rows = await this.sql`
      SELECT * FROM ${this.sql(SCHEMA)}.runs
      WHERE id = ${runId} AND thread_id = ${threadId}
    `;

    if (rows.length === 0) {
      return null;
    }

    return this.rowToModel(rows[0]);
  }

  async deleteByThread(threadId: string, runId: string): Promise<boolean> {
    const result = await this.sql`
      DELETE FROM ${this.sql(SCHEMA)}.runs
      WHERE id = ${runId} AND thread_id = ${threadId}
    `;
    return result.count > 0;
  }

  async getActiveRun(threadId: string): Promise<Run | null> {
    const rows = await this.sql`
      SELECT * FROM ${this.sql(SCHEMA)}.runs
      WHERE thread_id = ${threadId}
        AND status IN ('pending', 'running')
      ORDER BY created_at DESC
      LIMIT 1
    `;

    if (rows.length === 0) {
      return null;
    }

    return this.rowToModel(rows[0]);
  }

  async updateStatus(runId: string, status: RunStatus): Promise<Run | null> {
    const now = utcNow();

    const result = await this.sql`
      UPDATE ${this.sql(SCHEMA)}.runs
      SET status = ${status}, updated_at = ${now}
      WHERE id = ${runId}
    `;

    if (result.count === 0) {
      return null;
    }

    return this.get(runId);
  }

  async countByThread(threadId: string): Promise<number> {
    const rows = await this.sql`
      SELECT COUNT(*)::int AS count FROM ${this.sql(SCHEMA)}.runs
      WHERE thread_id = ${threadId}
    `;
    return rows[0]?.count ?? 0;
  }

  async clear(): Promise<void> {
    await this.sql`DELETE FROM ${this.sql(SCHEMA)}.runs`;
  }

  /**
   * Convert a Postgres row to a `Run` model object.
   */
  private rowToModel(row: Record<string, unknown>): Run {
    return {
      run_id: row.id as string,
      thread_id: row.thread_id as string,
      assistant_id: row.assistant_id as string,
      status: (row.status as RunStatus) ?? "pending",
      metadata: parseJsonb(row.metadata),
      kwargs: parseJsonb(row.kwargs),
      multitask_strategy: (row.multitask_strategy as MultitaskStrategy) ?? "reject",
      created_at: formatTimestamp(row.created_at),
      updated_at: formatTimestamp(row.updated_at),
    };
  }
}

// ============================================================================
// Postgres Store Storage (cross-thread key-value memory)
// ============================================================================

/**
 * Postgres-backed implementation of `StoreStorage`.
 *
 * Uses the `langgraph_server.store_items` table with composite primary key
 * `(namespace, key, owner_id)` for per-user isolation. Matches Python's
 * `StoreStorage` class behavior exactly.
 *
 * Reference: apps/python/src/server/storage.py → StoreStorage
 */
export class PostgresStoreStorage implements StoreStorage {
  constructor(private readonly sql: Sql) {}

  async put(
    namespace: string,
    key: string,
    value: Record<string, unknown>,
    ownerId: string,
    metadata?: Record<string, unknown>,
  ): Promise<StoreItem> {
    const now = utcNow();
    const metadataValue = metadata ?? {};

    // Upsert: INSERT or UPDATE on conflict.
    // Two paths to avoid mixing PendingQuery and JSONValue in the same
    // tagged template (Postgres.js overload resolution fails otherwise).
    let rows;

    if (metadata !== undefined) {
      rows = await this.sql`
        INSERT INTO ${this.sql(SCHEMA)}.store_items
          (namespace, key, value, owner_id, metadata, created_at, updated_at)
        VALUES
          (${namespace}, ${key}, ${this.sql.json(asJson(value))}, ${ownerId}, ${this.sql.json(asJson(metadataValue))}, ${now}, ${now})
        ON CONFLICT (namespace, key, owner_id)
        DO UPDATE SET
          value = ${this.sql.json(asJson(value))},
          metadata = ${this.sql.json(asJson(metadataValue))},
          updated_at = ${now}
        RETURNING *
      `;
    } else {
      rows = await this.sql`
        INSERT INTO ${this.sql(SCHEMA)}.store_items
          (namespace, key, value, owner_id, metadata, created_at, updated_at)
        VALUES
          (${namespace}, ${key}, ${this.sql.json(asJson(value))}, ${ownerId}, ${this.sql.json(asJson(metadataValue))}, ${now}, ${now})
        ON CONFLICT (namespace, key, owner_id)
        DO UPDATE SET
          value = ${this.sql.json(asJson(value))},
          updated_at = ${now}
        RETURNING *
      `;
    }

    return this.rowToModel(rows[0]);
  }

  async get(
    namespace: string,
    key: string,
    ownerId: string,
  ): Promise<StoreItem | null> {
    const rows = await this.sql`
      SELECT * FROM ${this.sql(SCHEMA)}.store_items
      WHERE namespace = ${namespace}
        AND key = ${key}
        AND owner_id = ${ownerId}
    `;

    if (rows.length === 0) return null;
    return this.rowToModel(rows[0]);
  }

  async delete(
    namespace: string,
    key: string,
    ownerId: string,
  ): Promise<boolean> {
    const result = await this.sql`
      DELETE FROM ${this.sql(SCHEMA)}.store_items
      WHERE namespace = ${namespace}
        AND key = ${key}
        AND owner_id = ${ownerId}
    `;

    return result.count > 0;
  }

  async search(
    namespace: string,
    ownerId: string,
    prefix?: string,
    limit: number = 10,
    offset: number = 0,
  ): Promise<StoreItem[]> {
    let rows;

    if (prefix) {
      rows = await this.sql`
        SELECT * FROM ${this.sql(SCHEMA)}.store_items
        WHERE namespace = ${namespace}
          AND owner_id = ${ownerId}
          AND key LIKE ${prefix + "%"}
        ORDER BY key ASC
        LIMIT ${limit}
        OFFSET ${offset}
      `;
    } else {
      rows = await this.sql`
        SELECT * FROM ${this.sql(SCHEMA)}.store_items
        WHERE namespace = ${namespace}
          AND owner_id = ${ownerId}
        ORDER BY key ASC
        LIMIT ${limit}
        OFFSET ${offset}
      `;
    }

    return rows.map((row: Record<string, unknown>) => this.rowToModel(row));
  }

  async listNamespaces(ownerId: string): Promise<string[]> {
    const rows = await this.sql`
      SELECT DISTINCT namespace
      FROM ${this.sql(SCHEMA)}.store_items
      WHERE owner_id = ${ownerId}
      ORDER BY namespace ASC
    `;

    return rows.map((row: Record<string, unknown>) => row.namespace as string);
  }

  async clear(): Promise<void> {
    await this.sql`DELETE FROM ${this.sql(SCHEMA)}.store_items`;
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private rowToModel(row: Record<string, unknown>): StoreItem {
    return {
      namespace: row.namespace as string,
      key: row.key as string,
      value: parseJsonb(row.value) as Record<string, unknown>,
      metadata: parseJsonb(row.metadata) as Record<string, unknown>,
      created_at: formatTimestamp(row.created_at),
      updated_at: formatTimestamp(row.updated_at),
    };
  }
}

// ============================================================================
// Postgres Storage Container (updated for v0.0.2)
// ============================================================================

export class PostgresStorage implements Storage {
  readonly assistants: PostgresAssistantStore;
  readonly threads: PostgresThreadStore;
  readonly runs: PostgresRunStore;
  readonly store: PostgresStoreStorage;
  /**
   * Cron store — uses in-memory implementation for now.
   *
   * A full `PostgresCronStore` will be implemented in a future goal.
   * Crons are ephemeral (restart-scoped), so in-memory is acceptable
   * for v0.0.3 since the scheduler itself is also in-memory.
   */
  readonly crons: InMemoryCronStore;

  constructor(sql: Sql) {
    this.assistants = new PostgresAssistantStore(sql);
    this.threads = new PostgresThreadStore(sql);
    this.runs = new PostgresRunStore(sql);
    this.store = new PostgresStoreStorage(sql);
    this.crons = new InMemoryCronStore();
  }

  async clearAll(): Promise<void> {
    // Order matters: runs reference threads (logically), thread_states CASCADE
    await this.runs.clear();
    await this.threads.clear();
    await this.assistants.clear();
    await this.store.clear();
    await this.crons.clear();
  }
}
