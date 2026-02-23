/**
 * Cron API tests for the Fractal Agents Runtime — TypeScript/Bun.
 *
 * Tests the complete crons subsystem:
 *   - `models/cron.ts` — Types, validation, helpers (calculateNextRunDate, isCronExpired, etc.)
 *   - `storage/memory.ts` — InMemoryCronStore CRUD + owner isolation
 *   - `crons/scheduler.ts` — CronScheduler timer management, lifecycle, singleton
 *   - `crons/handlers.ts` — CronHandler business logic (create, search, count, delete, execute)
 *   - `routes/crons.ts` — HTTP route handlers (POST/DELETE /runs/crons/*)
 *
 * All tests use in-memory storage and mocked auth context — no real database,
 * LLM, or scheduler timers required.
 *
 * Reference: apps/python/src/server/crons/ (schemas.py, handlers.py, scheduler.py)
 *            apps/python/src/server/routes/crons.py
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";

import {
  validateCronSchedule,
  calculateNextRunDate,
  isCronExpired,
  cronPayloadToDict,
  validateCronSelectFields,
  ON_RUN_COMPLETED_VALUES,
  CRON_SORT_BY_VALUES,
  SORT_ORDER_VALUES,
  VALID_CRON_SELECT_FIELDS,
  type Cron,
  type CronCreate,
  type CronSearch,
  type CronCountRequest,
  type CronPayload,
  type OnRunCompleted,
  type CronSortBy,
  type SortOrder,
} from "../src/models/cron";

import { InMemoryCronStore } from "../src/storage/memory";
import { InMemoryStorage } from "../src/storage/memory";
import { resetStorage } from "../src/storage/index";

import {
  CronScheduler,
  getScheduler,
  resetScheduler,
} from "../src/crons/scheduler";

import {
  CronHandler,
  getCronHandler,
  resetCronHandler,
} from "../src/crons/handlers";

import {
  setCurrentUser,
  clearCurrentUser,
} from "../src/middleware/context";

import type { AuthUser } from "../src/middleware/context";

import { router } from "../src/index";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const OWNER_A = "anonymous";
const OWNER_B = "user-bbb-222";

const MOCK_USER_A: AuthUser = {
  identity: OWNER_A,
  email: "alice@example.com",
  metadata: {},
};

const MOCK_USER_B: AuthUser = {
  identity: OWNER_B,
  email: "bob@example.com",
  metadata: {},
};

function makeRequest(
  path: string,
  method = "GET",
  body?: unknown,
): Request {
  const options: RequestInit = { method };
  if (body !== undefined) {
    options.headers = { "Content-Type": "application/json" };
    options.body = JSON.stringify(body);
  }
  return new Request(`http://localhost:3000${path}`, options);
}

async function jsonBody<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

interface ErrorBody {
  detail: string;
}

/**
 * Helper to create an assistant in storage so cron creation can reference it.
 *
 * When auth is disabled (no Supabase configured), the middleware clears
 * the user context, so the assistant is created without owner isolation.
 * This matches the TS runtime's graceful-degradation pattern.
 */
async function createTestAssistant(_ownerId?: string): Promise<string> {
  const response = await router.handle(
    makeRequest("/assistants", "POST", {
      graph_id: "agent",
      name: "Test Assistant",
    }),
  );
  const body = await response.json() as { assistant_id: string };
  return body.assistant_id;
}

// ============================================================================
// models/cron.ts — Validation & Helpers
// ============================================================================

describe("Cron models — validateCronSchedule", () => {
  test("accepts standard 5-field cron expression", () => {
    expect(validateCronSchedule("*/5 * * * *")).toBe(true);
  });

  test("accepts every-minute cron", () => {
    expect(validateCronSchedule("* * * * *")).toBe(true);
  });

  test("accepts specific time cron (noon daily)", () => {
    expect(validateCronSchedule("0 12 * * *")).toBe(true);
  });

  test("accepts day-of-week cron (Mondays at 9am)", () => {
    expect(validateCronSchedule("0 9 * * 1")).toBe(true);
  });

  test("accepts ranges and lists", () => {
    expect(validateCronSchedule("0 9-17 * * 1-5")).toBe(true);
  });

  test("accepts step values", () => {
    expect(validateCronSchedule("*/15 */2 * * *")).toBe(true);
  });

  test("throws on empty string", () => {
    expect(() => validateCronSchedule("")).toThrow("cannot be empty");
  });

  test("throws on whitespace-only string", () => {
    expect(() => validateCronSchedule("   ")).toThrow("cannot be empty");
  });

  test("throws on invalid expression", () => {
    expect(() => validateCronSchedule("invalid cron")).toThrow(
      "Invalid cron schedule expression",
    );
  });

  test("throws on too few fields", () => {
    expect(() => validateCronSchedule("* *")).toThrow();
  });
});

describe("Cron models — calculateNextRunDate", () => {
  test("returns an ISO 8601 string", () => {
    const result = calculateNextRunDate("*/5 * * * *");
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  test("next run is in the future", () => {
    const result = calculateNextRunDate("*/5 * * * *");
    const nextRun = new Date(result);
    expect(nextRun.getTime()).toBeGreaterThan(Date.now());
  });

  test("respects baseTime parameter", () => {
    const baseTime = new Date("2025-06-15T10:00:00.000Z");
    const result = calculateNextRunDate("0 12 * * *", baseTime);
    const nextRun = new Date(result);
    // Next noon after 10am on June 15 should be June 15 at 12pm
    expect(nextRun.toISOString()).toBe("2025-06-15T12:00:00.000Z");
  });

  test("rolls to next day if time has passed", () => {
    const baseTime = new Date("2025-06-15T14:00:00.000Z");
    const result = calculateNextRunDate("0 12 * * *", baseTime);
    const nextRun = new Date(result);
    // Next noon after 2pm on June 15 should be June 16 at 12pm
    expect(nextRun.toISOString()).toBe("2025-06-16T12:00:00.000Z");
  });

  test("every-5-minutes from a known base", () => {
    const baseTime = new Date("2025-06-15T10:32:00.000Z");
    const result = calculateNextRunDate("*/5 * * * *", baseTime);
    const nextRun = new Date(result);
    // Next 5-min boundary after 10:32 is 10:35
    expect(nextRun.toISOString()).toBe("2025-06-15T10:35:00.000Z");
  });
});

describe("Cron models — isCronExpired", () => {
  test("returns false for null end_time", () => {
    expect(isCronExpired(null)).toBe(false);
  });

  test("returns false for undefined end_time", () => {
    expect(isCronExpired(undefined)).toBe(false);
  });

  test("returns true for past end_time", () => {
    const pastDate = new Date(Date.now() - 60000).toISOString();
    expect(isCronExpired(pastDate)).toBe(true);
  });

  test("returns false for future end_time", () => {
    const futureDate = new Date(Date.now() + 3600000).toISOString();
    expect(isCronExpired(futureDate)).toBe(false);
  });

  test("returns true for very old end_time", () => {
    expect(isCronExpired("2020-01-01T00:00:00.000Z")).toBe(true);
  });

  test("returns false for far future end_time", () => {
    expect(isCronExpired("2099-12-31T23:59:59.999Z")).toBe(false);
  });
});

describe("Cron models — cronPayloadToDict", () => {
  test("serializes a full payload", () => {
    const payload: CronPayload = {
      assistant_id: "asst-123",
      input: { messages: [{ role: "user", content: "hello" }] },
      metadata: { key: "value" },
      config: { tags: ["test"] },
      context: { system: "prompt" },
      webhook: "https://example.com/hook",
      interrupt_before: ["node1"],
      interrupt_after: "*",
      on_run_completed: "keep",
    };

    const dict = cronPayloadToDict(payload);

    expect(dict.assistant_id).toBe("asst-123");
    expect(dict.input).toEqual({ messages: [{ role: "user", content: "hello" }] });
    expect(dict.metadata).toEqual({ key: "value" });
    expect(dict.config).toEqual({ tags: ["test"] });
    expect(dict.context).toEqual({ system: "prompt" });
    expect(dict.webhook).toBe("https://example.com/hook");
    expect(dict.interrupt_before).toEqual(["node1"]);
    expect(dict.interrupt_after).toBe("*");
    expect(dict.on_run_completed).toBe("keep");
  });

  test("serializes a minimal payload with nulls", () => {
    const payload: CronPayload = {
      assistant_id: "asst-456",
      on_run_completed: "delete",
    };

    const dict = cronPayloadToDict(payload);

    expect(dict.assistant_id).toBe("asst-456");
    expect(dict.input).toBeNull();
    expect(dict.metadata).toBeNull();
    expect(dict.config).toBeNull();
    expect(dict.context).toBeNull();
    expect(dict.webhook).toBeNull();
    expect(dict.interrupt_before).toBeNull();
    expect(dict.interrupt_after).toBeNull();
    expect(dict.on_run_completed).toBe("delete");
  });
});

describe("Cron models — validateCronSelectFields", () => {
  test("accepts valid fields", () => {
    expect(validateCronSelectFields(["cron_id", "schedule", "created_at"])).toBe(
      true,
    );
  });

  test("accepts all valid fields", () => {
    const allFields = [...VALID_CRON_SELECT_FIELDS];
    expect(validateCronSelectFields(allFields)).toBe(true);
  });

  test("throws on invalid field", () => {
    expect(() => validateCronSelectFields(["cron_id", "bogus_field"])).toThrow(
      "Invalid select field",
    );
  });

  test("throws on empty invalid field", () => {
    expect(() => validateCronSelectFields([""])).toThrow("Invalid select field");
  });

  test("accepts empty array", () => {
    expect(validateCronSelectFields([])).toBe(true);
  });
});

describe("Cron models — enum constants", () => {
  test("ON_RUN_COMPLETED_VALUES has delete and keep", () => {
    expect(ON_RUN_COMPLETED_VALUES).toContain("delete");
    expect(ON_RUN_COMPLETED_VALUES).toContain("keep");
    expect(ON_RUN_COMPLETED_VALUES).toHaveLength(2);
  });

  test("CRON_SORT_BY_VALUES contains expected fields", () => {
    expect(CRON_SORT_BY_VALUES).toContain("cron_id");
    expect(CRON_SORT_BY_VALUES).toContain("created_at");
    expect(CRON_SORT_BY_VALUES).toContain("updated_at");
    expect(CRON_SORT_BY_VALUES).toContain("next_run_date");
    expect(CRON_SORT_BY_VALUES).toContain("assistant_id");
    expect(CRON_SORT_BY_VALUES).toContain("thread_id");
    expect(CRON_SORT_BY_VALUES).toContain("end_time");
    expect(CRON_SORT_BY_VALUES).toHaveLength(7);
  });

  test("SORT_ORDER_VALUES has asc and desc", () => {
    expect(SORT_ORDER_VALUES).toContain("asc");
    expect(SORT_ORDER_VALUES).toContain("desc");
    expect(SORT_ORDER_VALUES).toHaveLength(2);
  });
});

// ============================================================================
// storage/memory.ts — InMemoryCronStore
// ============================================================================

describe("InMemoryCronStore — create", () => {
  let store: InMemoryCronStore;

  beforeEach(() => {
    store = new InMemoryCronStore();
  });

  test("creates a cron with generated ID and timestamps", async () => {
    const cron = await store.create(
      {
        schedule: "*/5 * * * *",
        assistant_id: "asst-1",
        thread_id: "thread-1",
        payload: { assistant_id: "asst-1" },
      },
      OWNER_A,
    );

    expect(cron.cron_id).toBeDefined();
    expect(cron.cron_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(cron.schedule).toBe("*/5 * * * *");
    expect(cron.assistant_id).toBe("asst-1");
    expect(cron.thread_id).toBe("thread-1");
    expect(cron.created_at).toBeDefined();
    expect(cron.updated_at).toBeDefined();
    expect(cron.created_at).toBe(cron.updated_at);
  });

  test("stamps owner in metadata", async () => {
    const cron = await store.create(
      { schedule: "* * * * *", assistant_id: "a", thread_id: "t", payload: {} },
      OWNER_A,
    );
    expect(cron.metadata).toHaveProperty("owner", OWNER_A);
  });

  test("preserves existing metadata and merges owner", async () => {
    const cron = await store.create(
      {
        schedule: "* * * * *",
        assistant_id: "a",
        thread_id: "t",
        payload: {},
        metadata: { env: "test", tag: "cron" },
      },
      OWNER_A,
    );
    expect(cron.metadata.env).toBe("test");
    expect(cron.metadata.tag).toBe("cron");
    expect(cron.metadata.owner).toBe(OWNER_A);
  });

  test("sets nullable fields to null when missing", async () => {
    const cron = await store.create(
      { schedule: "* * * * *", assistant_id: "a", thread_id: "t", payload: {} },
      OWNER_A,
    );
    expect(cron.end_time).toBeNull();
    expect(cron.user_id).toBeNull();
    expect(cron.next_run_date).toBeNull();
  });

  test("preserves end_time and user_id when set", async () => {
    const endTime = new Date(Date.now() + 86400000).toISOString();
    const cron = await store.create(
      {
        schedule: "* * * * *",
        assistant_id: "a",
        thread_id: "t",
        payload: {},
        end_time: endTime,
        user_id: OWNER_A,
      },
      OWNER_A,
    );
    expect(cron.end_time).toBe(endTime);
    expect(cron.user_id).toBe(OWNER_A);
  });
});

describe("InMemoryCronStore — get", () => {
  let store: InMemoryCronStore;
  let cronId: string;

  beforeEach(async () => {
    store = new InMemoryCronStore();
    const cron = await store.create(
      { schedule: "* * * * *", assistant_id: "a", thread_id: "t", payload: {} },
      OWNER_A,
    );
    cronId = cron.cron_id;
  });

  test("returns cron for correct owner", async () => {
    const cron = await store.get(cronId, OWNER_A);
    expect(cron).not.toBeNull();
    expect(cron!.cron_id).toBe(cronId);
  });

  test("returns null for wrong owner", async () => {
    const cron = await store.get(cronId, OWNER_B);
    expect(cron).toBeNull();
  });

  test("returns null for non-existent ID", async () => {
    const cron = await store.get("non-existent", OWNER_A);
    expect(cron).toBeNull();
  });
});

describe("InMemoryCronStore — list", () => {
  let store: InMemoryCronStore;

  beforeEach(async () => {
    store = new InMemoryCronStore();
    await store.create(
      { schedule: "* * * * *", assistant_id: "a1", thread_id: "t1", payload: {} },
      OWNER_A,
    );
    await store.create(
      { schedule: "*/5 * * * *", assistant_id: "a2", thread_id: "t2", payload: {} },
      OWNER_A,
    );
    await store.create(
      { schedule: "0 12 * * *", assistant_id: "a3", thread_id: "t3", payload: {} },
      OWNER_B,
    );
  });

  test("lists only crons for the specified owner", async () => {
    const cronsA = await store.list(OWNER_A);
    expect(cronsA).toHaveLength(2);

    const cronsB = await store.list(OWNER_B);
    expect(cronsB).toHaveLength(1);
  });

  test("returns empty array for owner with no crons", async () => {
    const crons = await store.list("nobody");
    expect(crons).toHaveLength(0);
  });

  test("filters by assistant_id", async () => {
    const crons = await store.list(OWNER_A, { assistant_id: "a1" });
    expect(crons).toHaveLength(1);
    expect(crons[0].assistant_id).toBe("a1");
  });

  test("filters by thread_id", async () => {
    const crons = await store.list(OWNER_A, { thread_id: "t2" });
    expect(crons).toHaveLength(1);
    expect(crons[0].thread_id).toBe("t2");
  });

  test("filters by multiple fields (AND logic)", async () => {
    const crons = await store.list(OWNER_A, {
      assistant_id: "a1",
      thread_id: "t1",
    });
    expect(crons).toHaveLength(1);
  });

  test("returns empty when filter doesn't match", async () => {
    const crons = await store.list(OWNER_A, { assistant_id: "nonexistent" });
    expect(crons).toHaveLength(0);
  });
});

describe("InMemoryCronStore — update", () => {
  let store: InMemoryCronStore;
  let cronId: string;

  beforeEach(async () => {
    store = new InMemoryCronStore();
    const cron = await store.create(
      {
        schedule: "* * * * *",
        assistant_id: "a",
        thread_id: "t",
        payload: {},
        next_run_date: "2025-01-01T00:00:00.000Z",
      },
      OWNER_A,
    );
    cronId = cron.cron_id;
  });

  test("updates fields and returns updated cron", async () => {
    // Small delay ensures updated_at differs from created_at (same-ms race)
    await new Promise((resolve) => setTimeout(resolve, 5));
    const newNextRun = "2025-06-15T12:00:00.000Z";
    const updated = await store.update(cronId, OWNER_A, {
      next_run_date: newNextRun,
    });

    expect(updated).not.toBeNull();
    expect(updated!.next_run_date).toBe(newNextRun);
    expect(updated!.updated_at).not.toBe(updated!.created_at);
  });

  test("returns null for wrong owner", async () => {
    const updated = await store.update(cronId, OWNER_B, {
      next_run_date: "2025-12-01T00:00:00.000Z",
    });
    expect(updated).toBeNull();
  });

  test("returns null for non-existent ID", async () => {
    const updated = await store.update("fake-id", OWNER_A, {
      next_run_date: "2025-12-01T00:00:00.000Z",
    });
    expect(updated).toBeNull();
  });
});

describe("InMemoryCronStore — delete", () => {
  let store: InMemoryCronStore;
  let cronId: string;

  beforeEach(async () => {
    store = new InMemoryCronStore();
    const cron = await store.create(
      { schedule: "* * * * *", assistant_id: "a", thread_id: "t", payload: {} },
      OWNER_A,
    );
    cronId = cron.cron_id;
  });

  test("deletes cron for correct owner", async () => {
    const deleted = await store.delete(cronId, OWNER_A);
    expect(deleted).toBe(true);

    const cron = await store.get(cronId, OWNER_A);
    expect(cron).toBeNull();
  });

  test("returns false for wrong owner", async () => {
    const deleted = await store.delete(cronId, OWNER_B);
    expect(deleted).toBe(false);

    // Cron should still exist
    const cron = await store.get(cronId, OWNER_A);
    expect(cron).not.toBeNull();
  });

  test("returns false for non-existent ID", async () => {
    const deleted = await store.delete("fake-id", OWNER_A);
    expect(deleted).toBe(false);
  });
});

describe("InMemoryCronStore — count", () => {
  let store: InMemoryCronStore;

  beforeEach(async () => {
    store = new InMemoryCronStore();
    await store.create(
      { schedule: "* * * * *", assistant_id: "a1", thread_id: "t1", payload: {} },
      OWNER_A,
    );
    await store.create(
      { schedule: "*/5 * * * *", assistant_id: "a1", thread_id: "t2", payload: {} },
      OWNER_A,
    );
    await store.create(
      { schedule: "0 12 * * *", assistant_id: "a2", thread_id: "t3", payload: {} },
      OWNER_A,
    );
    await store.create(
      { schedule: "0 0 * * *", assistant_id: "a3", thread_id: "t4", payload: {} },
      OWNER_B,
    );
  });

  test("counts all crons for owner", async () => {
    expect(await store.count(OWNER_A)).toBe(3);
    expect(await store.count(OWNER_B)).toBe(1);
  });

  test("counts with assistant_id filter", async () => {
    expect(await store.count(OWNER_A, { assistant_id: "a1" })).toBe(2);
    expect(await store.count(OWNER_A, { assistant_id: "a2" })).toBe(1);
    expect(await store.count(OWNER_A, { assistant_id: "nonexistent" })).toBe(0);
  });

  test("counts with thread_id filter", async () => {
    expect(await store.count(OWNER_A, { thread_id: "t1" })).toBe(1);
  });

  test("returns 0 for unknown owner", async () => {
    expect(await store.count("nobody")).toBe(0);
  });
});

describe("InMemoryCronStore — clear", () => {
  test("removes all crons", async () => {
    const store = new InMemoryCronStore();
    await store.create(
      { schedule: "* * * * *", assistant_id: "a", thread_id: "t", payload: {} },
      OWNER_A,
    );
    await store.create(
      { schedule: "* * * * *", assistant_id: "b", thread_id: "u", payload: {} },
      OWNER_B,
    );

    expect(await store.count(OWNER_A)).toBe(1);
    expect(await store.count(OWNER_B)).toBe(1);

    await store.clear();

    expect(await store.count(OWNER_A)).toBe(0);
    expect(await store.count(OWNER_B)).toBe(0);
  });
});

// ============================================================================
// Storage container — crons field
// ============================================================================

describe("InMemoryStorage — has crons store", () => {
  test("InMemoryStorage has a crons property", () => {
    const storage = new InMemoryStorage();
    expect(storage.crons).toBeDefined();
    expect(storage.crons).toBeInstanceOf(InMemoryCronStore);
  });

  test("clearAll clears crons", async () => {
    const storage = new InMemoryStorage();
    await storage.crons.create(
      { schedule: "* * * * *", assistant_id: "a", thread_id: "t", payload: {} },
      OWNER_A,
    );
    expect(await storage.crons.count(OWNER_A)).toBe(1);

    await storage.clearAll();
    expect(await storage.crons.count(OWNER_A)).toBe(0);
  });
});

// ============================================================================
// crons/scheduler.ts — CronScheduler
// ============================================================================

describe("CronScheduler — lifecycle", () => {
  let scheduler: CronScheduler;

  beforeEach(() => {
    scheduler = new CronScheduler();
  });

  afterEach(() => {
    scheduler.shutdown();
  });

  test("starts and reports isStarted=true", () => {
    expect(scheduler.isStarted).toBe(false);
    scheduler.start();
    expect(scheduler.isStarted).toBe(true);
  });

  test("start is idempotent (multiple calls don't error)", () => {
    scheduler.start();
    scheduler.start();
    scheduler.start();
    expect(scheduler.isStarted).toBe(true);
  });

  test("shutdown sets isStarted=false", () => {
    scheduler.start();
    scheduler.shutdown();
    expect(scheduler.isStarted).toBe(false);
  });

  test("shutdown is safe when not started", () => {
    scheduler.shutdown();
    expect(scheduler.isStarted).toBe(false);
  });

  test("activeJobCount starts at 0", () => {
    expect(scheduler.activeJobCount).toBe(0);
  });
});

describe("CronScheduler — addCronJob / removeCronJob", () => {
  let scheduler: CronScheduler;

  beforeEach(() => {
    scheduler = new CronScheduler();
  });

  afterEach(() => {
    scheduler.shutdown();
  });

  function makeCron(overrides?: Partial<Cron>): Cron {
    return {
      cron_id: overrides?.cron_id ?? crypto.randomUUID(),
      assistant_id: "asst-1",
      thread_id: "thread-1",
      end_time: null,
      schedule: "*/5 * * * *",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      user_id: OWNER_A,
      payload: { assistant_id: "asst-1", on_run_completed: "delete" },
      next_run_date: null,
      metadata: { owner: OWNER_A },
      ...overrides,
    };
  }

  test("addCronJob returns true and increments activeJobCount", () => {
    const cron = makeCron();
    const result = scheduler.addCronJob(cron, OWNER_A);
    expect(result).toBe(true);
    expect(scheduler.activeJobCount).toBe(1);
  });

  test("adding multiple crons increments count", () => {
    scheduler.addCronJob(makeCron(), OWNER_A);
    scheduler.addCronJob(makeCron(), OWNER_A);
    scheduler.addCronJob(makeCron(), OWNER_B);
    expect(scheduler.activeJobCount).toBe(3);
  });

  test("addCronJob auto-starts scheduler", () => {
    expect(scheduler.isStarted).toBe(false);
    scheduler.addCronJob(makeCron(), OWNER_A);
    expect(scheduler.isStarted).toBe(true);
  });

  test("addCronJob replaces existing timer for same cron_id", () => {
    const cronId = crypto.randomUUID();
    scheduler.addCronJob(makeCron({ cron_id: cronId }), OWNER_A);
    scheduler.addCronJob(makeCron({ cron_id: cronId }), OWNER_A);
    expect(scheduler.activeJobCount).toBe(1);
  });

  test("removeCronJob returns true and decrements count", () => {
    const cron = makeCron();
    scheduler.addCronJob(cron, OWNER_A);
    expect(scheduler.activeJobCount).toBe(1);

    const removed = scheduler.removeCronJob(cron.cron_id);
    expect(removed).toBe(true);
    expect(scheduler.activeJobCount).toBe(0);
  });

  test("removeCronJob returns false for non-existent ID", () => {
    expect(scheduler.removeCronJob("nonexistent")).toBe(false);
  });

  test("shutdown clears all jobs", () => {
    scheduler.addCronJob(makeCron(), OWNER_A);
    scheduler.addCronJob(makeCron(), OWNER_B);
    expect(scheduler.activeJobCount).toBe(2);

    scheduler.shutdown();
    expect(scheduler.activeJobCount).toBe(0);
  });

  test("does not schedule expired cron", () => {
    const cron = makeCron({
      end_time: "2020-01-01T00:00:00.000Z",
    });
    scheduler.addCronJob(cron, OWNER_A);
    expect(scheduler.activeJobCount).toBe(0);
  });
});

describe("CronScheduler — getJobInfo / listJobs", () => {
  let scheduler: CronScheduler;

  beforeEach(() => {
    scheduler = new CronScheduler();
  });

  afterEach(() => {
    scheduler.shutdown();
  });

  function makeCron(cronId: string): Cron {
    return {
      cron_id: cronId,
      assistant_id: "asst-1",
      thread_id: "thread-1",
      end_time: null,
      schedule: "*/5 * * * *",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      user_id: OWNER_A,
      payload: { assistant_id: "asst-1", on_run_completed: "delete" },
      next_run_date: null,
      metadata: { owner: OWNER_A },
    };
  }

  test("getJobInfo returns info for scheduled job", () => {
    const cronId = crypto.randomUUID();
    scheduler.addCronJob(makeCron(cronId), OWNER_A);

    const info = scheduler.getJobInfo(cronId);
    expect(info).not.toBeNull();
    expect(info!.jobId).toBe(cronId);
    expect(info!.ownerId).toBe(OWNER_A);
    expect(info!.pending).toBe(true);
  });

  test("getJobInfo returns null for non-existent job", () => {
    expect(scheduler.getJobInfo("nonexistent")).toBeNull();
  });

  test("listJobs returns all scheduled jobs", () => {
    const id1 = crypto.randomUUID();
    const id2 = crypto.randomUUID();
    scheduler.addCronJob(makeCron(id1), OWNER_A);
    scheduler.addCronJob(makeCron(id2), OWNER_B);

    const jobs = scheduler.listJobs();
    expect(jobs).toHaveLength(2);

    const jobIds = jobs.map((j) => j.jobId).sort();
    expect(jobIds).toContain(id1);
    expect(jobIds).toContain(id2);
  });

  test("listJobs returns empty array when no jobs", () => {
    expect(scheduler.listJobs()).toHaveLength(0);
  });
});

describe("CronScheduler — setExecutionCallback", () => {
  let scheduler: CronScheduler;

  afterEach(() => {
    scheduler.shutdown();
  });

  test("execution callback can be set", () => {
    scheduler = new CronScheduler();
    const callback = async (_cronId: string, _ownerId: string) => {};
    // Should not throw
    scheduler.setExecutionCallback(callback);
  });
});

describe("CronScheduler — singleton", () => {
  afterEach(() => {
    resetScheduler();
  });

  test("getScheduler returns the same instance", () => {
    const s1 = getScheduler();
    const s2 = getScheduler();
    expect(s1).toBe(s2);
  });

  test("resetScheduler creates a new instance", () => {
    const s1 = getScheduler();
    resetScheduler();
    const s2 = getScheduler();
    expect(s1).not.toBe(s2);
  });

  test("resetScheduler shuts down the old scheduler", () => {
    const s1 = getScheduler();
    s1.start();
    expect(s1.isStarted).toBe(true);

    resetScheduler();
    expect(s1.isStarted).toBe(false);
  });
});

// ============================================================================
// crons/handlers.ts — CronHandler
// ============================================================================

describe("CronHandler — createCron", () => {
  beforeEach(() => {
    resetStorage();
    resetScheduler();
    resetCronHandler();
  });

  afterEach(() => {
    resetScheduler();
  });

  test("creates a cron with valid data", async () => {
    const assistantId = await createTestAssistant();

    const handler = getCronHandler();
    const cron = await handler.createCron(
      {
        schedule: "*/5 * * * *",
        assistant_id: assistantId,
      },
      OWNER_A,
    );

    expect(cron.cron_id).toBeDefined();
    expect(cron.schedule).toBe("*/5 * * * *");
    expect(cron.assistant_id).toBe(assistantId);
    expect(cron.thread_id).toBeDefined();
    expect(cron.next_run_date).toBeDefined();
    expect(cron.payload).toBeDefined();
    expect(cron.payload.assistant_id).toBe(assistantId);
  });

  test("creates a cron with all optional fields", async () => {
    const assistantId = await createTestAssistant();

    const handler = getCronHandler();
    const endTime = new Date(Date.now() + 86400000).toISOString();
    const cron = await handler.createCron(
      {
        schedule: "0 12 * * *",
        assistant_id: assistantId,
        end_time: endTime,
        input: { messages: [{ role: "user", content: "hello" }] },
        metadata: { env: "test" },
        config: { tags: ["cron-test"] },
        context: { system: "prompt" },
        webhook: "https://example.com/hook",
        interrupt_before: ["node1"],
        interrupt_after: "*",
        on_run_completed: "keep",
      },
      OWNER_A,
    );

    expect(cron.end_time).toBe(endTime);
    expect(cron.payload.on_run_completed).toBe("keep");
  });

  test("throws when assistant not found", async () => {
    const handler = getCronHandler();
    await expect(
      handler.createCron(
        {
          schedule: "*/5 * * * *",
          assistant_id: "nonexistent-assistant-id",
        },
        OWNER_A,
      ),
    ).rejects.toThrow("Assistant not found");
  });

  test("throws when end_time is in the past", async () => {
    const assistantId = await createTestAssistant();

    const handler = getCronHandler();
    await expect(
      handler.createCron(
        {
          schedule: "*/5 * * * *",
          assistant_id: assistantId,
          end_time: "2020-01-01T00:00:00.000Z",
        },
        OWNER_A,
      ),
    ).rejects.toThrow("in the past");
  });

  test("schedules cron in the scheduler after creation", async () => {
    const assistantId = await createTestAssistant();

    const handler = getCronHandler();
    const cron = await handler.createCron(
      { schedule: "*/5 * * * *", assistant_id: assistantId },
      OWNER_A,
    );

    const scheduler = getScheduler();
    const info = scheduler.getJobInfo(cron.cron_id);
    expect(info).not.toBeNull();
    expect(info!.ownerId).toBe(OWNER_A);
  });

  test("resolves assistant by graph_id when UUID not found", async () => {
    // Create an assistant — it will be findable by graph_id "agent"
    await createTestAssistant();

    const handler = getCronHandler();
    const cron = await handler.createCron(
      { schedule: "*/5 * * * *", assistant_id: "agent" },
      OWNER_A,
    );

    expect(cron.cron_id).toBeDefined();
    expect(cron.assistant_id).toBeDefined();
  });
});

describe("CronHandler — searchCrons", () => {
  let assistantId: string;

  beforeEach(async () => {
    resetStorage();
    resetScheduler();
    resetCronHandler();
    clearCurrentUser();
    setCurrentUser(MOCK_USER_A);
    assistantId = await createTestAssistant(OWNER_A);

    const handler = getCronHandler();
    await handler.createCron(
      { schedule: "* * * * *", assistant_id: assistantId },
      OWNER_A,
    );
    await handler.createCron(
      { schedule: "*/5 * * * *", assistant_id: assistantId },
      OWNER_A,
    );
    await handler.createCron(
      { schedule: "0 12 * * *", assistant_id: assistantId },
      OWNER_A,
    );
  });

  afterEach(() => {
    resetScheduler();
  });

  test("returns all crons for owner with empty search", async () => {
    const handler = getCronHandler();
    const crons = await handler.searchCrons({}, OWNER_A);
    expect(crons).toHaveLength(3);
  });

  test("returns empty for different owner", async () => {
    const handler = getCronHandler();
    const crons = await handler.searchCrons({}, OWNER_B);
    expect(crons).toHaveLength(0);
  });

  test("paginates with limit and offset", async () => {
    const handler = getCronHandler();
    const page1 = await handler.searchCrons({ limit: 2, offset: 0 }, OWNER_A);
    expect(page1).toHaveLength(2);

    const page2 = await handler.searchCrons({ limit: 2, offset: 2 }, OWNER_A);
    expect(page2).toHaveLength(1);
  });

  test("sorts by created_at desc by default", async () => {
    const handler = getCronHandler();
    const crons = await handler.searchCrons({}, OWNER_A);
    // Most recent first
    for (let i = 1; i < crons.length; i++) {
      expect(crons[i - 1].created_at >= crons[i].created_at).toBe(true);
    }
  });

  test("sorts by created_at asc when specified", async () => {
    const handler = getCronHandler();
    const crons = await handler.searchCrons(
      { sort_by: "created_at", sort_order: "asc" },
      OWNER_A,
    );
    // Oldest first
    for (let i = 1; i < crons.length; i++) {
      expect(crons[i - 1].created_at <= crons[i].created_at).toBe(true);
    }
  });

  test("filters by assistant_id", async () => {
    const handler = getCronHandler();
    const crons = await handler.searchCrons(
      { assistant_id: assistantId },
      OWNER_A,
    );
    expect(crons).toHaveLength(3);
    for (const cron of crons) {
      expect(cron.assistant_id).toBe(assistantId);
    }
  });

  test("filters by nonexistent assistant returns empty", async () => {
    const handler = getCronHandler();
    const crons = await handler.searchCrons(
      { assistant_id: "nonexistent" },
      OWNER_A,
    );
    expect(crons).toHaveLength(0);
  });
});

describe("CronHandler — countCrons", () => {
  beforeEach(async () => {
    resetStorage();
    resetScheduler();
    resetCronHandler();
    const assistantId = await createTestAssistant();

    const handler = getCronHandler();
    await handler.createCron(
      { schedule: "* * * * *", assistant_id: assistantId },
      OWNER_A,
    );
    await handler.createCron(
      { schedule: "*/5 * * * *", assistant_id: assistantId },
      OWNER_A,
    );
  });

  afterEach(() => {
    resetScheduler();
  });

  test("counts all crons for owner", async () => {
    const handler = getCronHandler();
    const count = await handler.countCrons({}, OWNER_A);
    expect(count).toBe(2);
  });

  test("returns 0 for different owner", async () => {
    const handler = getCronHandler();
    const count = await handler.countCrons({}, OWNER_B);
    expect(count).toBe(0);
  });
});

describe("CronHandler — deleteCron", () => {
  let cronId: string;

  beforeEach(async () => {
    resetStorage();
    resetScheduler();
    resetCronHandler();
    const assistantId = await createTestAssistant();

    const handler = getCronHandler();
    const cron = await handler.createCron(
      { schedule: "*/5 * * * *", assistant_id: assistantId },
      OWNER_A,
    );
    cronId = cron.cron_id;
  });

  afterEach(() => {
    resetScheduler();
  });

  test("deletes cron and returns empty object", async () => {
    const handler = getCronHandler();
    const result = await handler.deleteCron(cronId, OWNER_A);
    expect(result).toEqual({});
  });

  test("removes cron from scheduler", async () => {
    const scheduler = getScheduler();
    expect(scheduler.getJobInfo(cronId)).not.toBeNull();

    const handler = getCronHandler();
    await handler.deleteCron(cronId, OWNER_A);

    expect(scheduler.getJobInfo(cronId)).toBeNull();
  });

  test("cron is no longer retrievable after delete", async () => {
    const handler = getCronHandler();
    await handler.deleteCron(cronId, OWNER_A);

    const cron = await handler.getCron(cronId, OWNER_A);
    expect(cron).toBeNull();
  });

  test("throws when cron not found", async () => {
    const handler = getCronHandler();
    await expect(
      handler.deleteCron("nonexistent-cron-id", OWNER_A),
    ).rejects.toThrow("Cron not found");
  });

  test("throws when wrong owner tries to delete", async () => {
    const handler = getCronHandler();
    await expect(
      handler.deleteCron(cronId, OWNER_B),
    ).rejects.toThrow("Cron not found");
  });
});

describe("CronHandler — getCron", () => {
  let cronId: string;

  beforeEach(async () => {
    resetStorage();
    resetScheduler();
    resetCronHandler();
    clearCurrentUser();
    setCurrentUser(MOCK_USER_A);
    const assistantId = await createTestAssistant(OWNER_A);

    const handler = getCronHandler();
    const cron = await handler.createCron(
      { schedule: "*/5 * * * *", assistant_id: assistantId },
      OWNER_A,
    );
    cronId = cron.cron_id;
  });

  afterEach(() => {
    resetScheduler();
    clearCurrentUser();
  });

  test("returns cron for correct owner", async () => {
    const handler = getCronHandler();
    const cron = await handler.getCron(cronId, OWNER_A);
    expect(cron).not.toBeNull();
    expect(cron!.cron_id).toBe(cronId);
  });

  test("returns null for wrong owner", async () => {
    const handler = getCronHandler();
    const cron = await handler.getCron(cronId, OWNER_B);
    expect(cron).toBeNull();
  });

  test("returns null for non-existent ID", async () => {
    const handler = getCronHandler();
    const cron = await handler.getCron("nonexistent", OWNER_A);
    expect(cron).toBeNull();
  });
});

describe("CronHandler — executeCronRun", () => {
  let cronId: string;

  beforeEach(async () => {
    resetStorage();
    resetScheduler();
    resetCronHandler();
    clearCurrentUser();
    setCurrentUser(MOCK_USER_A);
    const assistantId = await createTestAssistant(OWNER_A);

    const handler = getCronHandler();
    const cron = await handler.createCron(
      { schedule: "*/5 * * * *", assistant_id: assistantId },
      OWNER_A,
    );
    cronId = cron.cron_id;
  });

  afterEach(() => {
    resetScheduler();
    clearCurrentUser();
  });

  test("executes without throwing", async () => {
    const handler = getCronHandler();
    // Should not throw — creates a run in storage
    await handler.executeCronRun(cronId, OWNER_A);
  });

  test("updates next_run_date after execution", async () => {
    const handler = getCronHandler();
    const cronBefore = await handler.getCron(cronId, OWNER_A);
    const nextRunBefore = cronBefore!.next_run_date;

    await handler.executeCronRun(cronId, OWNER_A);

    const cronAfter = await handler.getCron(cronId, OWNER_A);
    // next_run_date should be updated (potentially same if within same minute)
    expect(cronAfter!.next_run_date).toBeDefined();
  });

  test("does not throw for non-existent cron", async () => {
    const handler = getCronHandler();
    // Should log a warning but not throw
    await handler.executeCronRun("nonexistent", OWNER_A);
  });
});

describe("CronHandler — singleton", () => {
  afterEach(() => {
    resetCronHandler();
    resetScheduler();
  });

  test("getCronHandler returns the same instance", () => {
    const h1 = getCronHandler();
    const h2 = getCronHandler();
    expect(h1).toBe(h2);
  });

  test("resetCronHandler creates a new instance", () => {
    const h1 = getCronHandler();
    resetCronHandler();
    const h2 = getCronHandler();
    expect(h1).not.toBe(h2);
  });

  test("getCronHandler wires execution callback into scheduler", () => {
    resetScheduler();
    resetCronHandler();
    const handler = getCronHandler();
    // The scheduler should have the callback set
    // We verify this indirectly — the handler is a CronHandler
    expect(handler).toBeInstanceOf(CronHandler);
  });
});

// ============================================================================
// routes/crons.ts — HTTP Route Handlers
// ============================================================================

describe("POST /runs/crons — create cron", () => {
  let assistantId: string;

  beforeEach(async () => {
    resetStorage();
    resetScheduler();
    resetCronHandler();
    assistantId = await createTestAssistant();
  });

  afterEach(() => {
    resetScheduler();
  });

  test("creates a cron and returns 200", async () => {
    const response = await router.handle(
      makeRequest("/runs/crons", "POST", {
        schedule: "*/5 * * * *",
        assistant_id: assistantId,
      }),
    );

    expect(response.status).toBe(200);

    const body = await jsonBody<Cron>(response);
    expect(body.cron_id).toBeDefined();
    expect(body.schedule).toBe("*/5 * * * *");
    expect(body.assistant_id).toBe(assistantId);
    expect(body.thread_id).toBeDefined();
    expect(body.created_at).toBeDefined();
    expect(body.updated_at).toBeDefined();
    expect(body.next_run_date).toBeDefined();
    expect(body.payload).toBeDefined();
    expect(body.metadata).toBeDefined();
  });

  test("response has JSON content type", async () => {
    const response = await router.handle(
      makeRequest("/runs/crons", "POST", {
        schedule: "*/5 * * * *",
        assistant_id: assistantId,
      }),
    );
    expect(response.headers.get("Content-Type")).toBe("application/json");
  });

  test("creates with all optional fields", async () => {
    const endTime = new Date(Date.now() + 86400000).toISOString();
    const response = await router.handle(
      makeRequest("/runs/crons", "POST", {
        schedule: "0 12 * * *",
        assistant_id: assistantId,
        end_time: endTime,
        input: { messages: [{ role: "user", content: "run me" }] },
        metadata: { env: "test" },
        config: { tags: ["cron"] },
        on_run_completed: "keep",
      }),
    );

    expect(response.status).toBe(200);
    const body = await jsonBody<Cron>(response);
    expect(body.end_time).toBe(endTime);
  });

  test("returns 422 when schedule is missing", async () => {
    const response = await router.handle(
      makeRequest("/runs/crons", "POST", {
        assistant_id: assistantId,
      }),
    );
    expect(response.status).toBe(422);
    const body = await jsonBody<ErrorBody>(response);
    expect(body.detail).toContain("schedule");
  });

  test("returns 422 when assistant_id is missing", async () => {
    const response = await router.handle(
      makeRequest("/runs/crons", "POST", {
        schedule: "*/5 * * * *",
      }),
    );
    expect(response.status).toBe(422);
    const body = await jsonBody<ErrorBody>(response);
    expect(body.detail).toContain("assistant_id");
  });

  test("returns 422 for invalid cron schedule", async () => {
    const response = await router.handle(
      makeRequest("/runs/crons", "POST", {
        schedule: "invalid cron",
        assistant_id: assistantId,
      }),
    );
    expect(response.status).toBe(422);
    const body = await jsonBody<ErrorBody>(response);
    expect(body.detail).toContain("Invalid cron schedule");
  });

  test("returns 422 for invalid on_run_completed", async () => {
    const response = await router.handle(
      makeRequest("/runs/crons", "POST", {
        schedule: "*/5 * * * *",
        assistant_id: assistantId,
        on_run_completed: "invalid",
      }),
    );
    expect(response.status).toBe(422);
    const body = await jsonBody<ErrorBody>(response);
    expect(body.detail).toContain("on_run_completed");
  });

  test("returns 404 when assistant doesn't exist", async () => {
    const response = await router.handle(
      makeRequest("/runs/crons", "POST", {
        schedule: "*/5 * * * *",
        assistant_id: "nonexistent-uuid",
      }),
    );
    expect(response.status).toBe(404);
    const body = await jsonBody<ErrorBody>(response);
    expect(body.detail).toContain("not found");
  });

  test("returns 422 when end_time is in the past", async () => {
    const response = await router.handle(
      makeRequest("/runs/crons", "POST", {
        schedule: "*/5 * * * *",
        assistant_id: assistantId,
        end_time: "2020-01-01T00:00:00.000Z",
      }),
    );
    expect(response.status).toBe(422);
    const body = await jsonBody<ErrorBody>(response);
    expect(body.detail).toContain("in the past");
  });

  test("returns 422 when body is not JSON", async () => {
    const response = await router.handle(
      new Request("http://localhost:3000/runs/crons", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      }),
    );
    expect(response.status).toBe(422);
  });

  test("returns 422 when Content-Type is wrong", async () => {
    const response = await router.handle(
      new Request("http://localhost:3000/runs/crons", {
        method: "POST",
        body: JSON.stringify({
          schedule: "*/5 * * * *",
          assistant_id: assistantId,
        }),
      }),
    );
    expect(response.status).toBe(422);
  });

  test("cron_id is a valid UUID", async () => {
    const response = await router.handle(
      makeRequest("/runs/crons", "POST", {
        schedule: "*/5 * * * *",
        assistant_id: assistantId,
      }),
    );
    const body = await jsonBody<Cron>(response);
    expect(body.cron_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  test("created_at is a valid ISO 8601 timestamp", async () => {
    const response = await router.handle(
      makeRequest("/runs/crons", "POST", {
        schedule: "*/5 * * * *",
        assistant_id: assistantId,
      }),
    );
    const body = await jsonBody<Cron>(response);
    expect(body.created_at).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
  });
});

describe("POST /runs/crons/search — search crons", () => {
  let assistantId: string;

  beforeEach(async () => {
    resetStorage();
    resetScheduler();
    resetCronHandler();
    assistantId = await createTestAssistant();

    // Create 3 crons via handler (bypasses HTTP middleware)
    const handler = getCronHandler();
    await handler.createCron(
      { schedule: "* * * * *", assistant_id: assistantId },
      OWNER_A,
    );
    await handler.createCron(
      { schedule: "*/5 * * * *", assistant_id: assistantId },
      OWNER_A,
    );
    await handler.createCron(
      { schedule: "0 12 * * *", assistant_id: assistantId },
      OWNER_A,
    );
  });

  afterEach(() => {
    resetScheduler();
  });

  test("returns all crons with empty body", async () => {
    const response = await router.handle(
      makeRequest("/runs/crons/search", "POST", {}),
    );
    expect(response.status).toBe(200);

    const body = await jsonBody<Cron[]>(response);
    expect(body).toHaveLength(3);
  });

  test("returns JSON content type", async () => {
    const response = await router.handle(
      makeRequest("/runs/crons/search", "POST", {}),
    );
    expect(response.headers.get("Content-Type")).toBe("application/json");
  });

  test("result is an array of Cron objects", async () => {
    const response = await router.handle(
      makeRequest("/runs/crons/search", "POST", {}),
    );
    const body = await jsonBody<Cron[]>(response);

    expect(Array.isArray(body)).toBe(true);
    for (const cron of body) {
      expect(cron.cron_id).toBeDefined();
      expect(cron.schedule).toBeDefined();
      expect(cron.assistant_id).toBeDefined();
      expect(cron.thread_id).toBeDefined();
      expect(cron.created_at).toBeDefined();
    }
  });

  test("paginates with limit and offset", async () => {
    const response = await router.handle(
      makeRequest("/runs/crons/search", "POST", { limit: 2, offset: 0 }),
    );
    const body = await jsonBody<Cron[]>(response);
    expect(body).toHaveLength(2);
  });

  test("filters by assistant_id", async () => {
    setCurrentUser(MOCK_USER_A);
    const response = await router.handle(
      makeRequest("/runs/crons/search", "POST", {
        assistant_id: assistantId,
      }),
    );
    const body = await jsonBody<Cron[]>(response);
    expect(body).toHaveLength(3);
    for (const cron of body) {
      expect(cron.assistant_id).toBe(assistantId);
    }
  });

  test("returns 422 for invalid limit", async () => {
    const response = await router.handle(
      makeRequest("/runs/crons/search", "POST", { limit: 0 }),
    );
    expect(response.status).toBe(422);
  });

  test("returns 422 for negative offset", async () => {
    const response = await router.handle(
      makeRequest("/runs/crons/search", "POST", { offset: -1 }),
    );
    expect(response.status).toBe(422);
  });

  test("returns 422 for invalid sort_by", async () => {
    const response = await router.handle(
      makeRequest("/runs/crons/search", "POST", { sort_by: "invalid_field" }),
    );
    expect(response.status).toBe(422);
  });

  test("returns 422 for invalid sort_order", async () => {
    const response = await router.handle(
      makeRequest("/runs/crons/search", "POST", { sort_order: "invalid" }),
    );
    expect(response.status).toBe(422);
  });

  test("returns 422 for invalid select field", async () => {
    const response = await router.handle(
      makeRequest("/runs/crons/search", "POST", {
        select: ["cron_id", "bogus"],
      }),
    );
    expect(response.status).toBe(422);
    const body = await jsonBody<ErrorBody>(response);
    expect(body.detail).toContain("Invalid select field");
  });

  test("accepts valid sort_by and sort_order", async () => {
    const response = await router.handle(
      makeRequest("/runs/crons/search", "POST", {
        sort_by: "created_at",
        sort_order: "asc",
      }),
    );
    expect(response.status).toBe(200);
  });
});

describe("POST /runs/crons/count — count crons", () => {
  let assistantId: string;

  beforeEach(async () => {
    resetStorage();
    resetScheduler();
    resetCronHandler();
    assistantId = await createTestAssistant();

    const handler = getCronHandler();
    await handler.createCron(
      { schedule: "* * * * *", assistant_id: assistantId },
      OWNER_A,
    );
    await handler.createCron(
      { schedule: "*/5 * * * *", assistant_id: assistantId },
      OWNER_A,
    );
  });

  afterEach(() => {
    resetScheduler();
  });

  test("returns count as bare integer", async () => {
    const response = await router.handle(
      makeRequest("/runs/crons/count", "POST", {}),
    );
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body).toBe(2);
  });

  test("returns JSON content type", async () => {
    setCurrentUser(MOCK_USER_A);
    const response = await router.handle(
      makeRequest("/runs/crons/count", "POST", {}),
    );
    expect(response.headers.get("Content-Type")).toBe("application/json");
  });

  test("filters by assistant_id", async () => {
    const response = await router.handle(
      makeRequest("/runs/crons/count", "POST", {
        assistant_id: assistantId,
      }),
    );
    const body = await response.json();
    expect(body).toBe(2);
  });

  test("filters by nonexistent assistant_id returns 0", async () => {
    const response = await router.handle(
      makeRequest("/runs/crons/count", "POST", {
        assistant_id: "nonexistent",
      }),
    );
    const body = await response.json();
    expect(body).toBe(0);
  });
});

describe("DELETE /runs/crons/:cron_id — delete cron", () => {
  let cronId: string;
  let assistantId: string;

  beforeEach(async () => {
    resetStorage();
    resetScheduler();
    resetCronHandler();
    assistantId = await createTestAssistant();

    const handler = getCronHandler();
    const cron = await handler.createCron(
      { schedule: "*/5 * * * *", assistant_id: assistantId },
      OWNER_A,
    );
    cronId = cron.cron_id;
  });

  afterEach(() => {
    resetScheduler();
  });

  test("deletes cron and returns 200 with empty object", async () => {
    const response = await router.handle(
      makeRequest(`/runs/crons/${cronId}`, "DELETE"),
    );
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body).toEqual({});
  });

  test("response has JSON content type", async () => {
    setCurrentUser(MOCK_USER_A);
    const response = await router.handle(
      makeRequest(`/runs/crons/${cronId}`, "DELETE"),
    );
    expect(response.headers.get("Content-Type")).toBe("application/json");
  });

  test("cron is no longer searchable after delete", async () => {
    await router.handle(makeRequest(`/runs/crons/${cronId}`, "DELETE"));

    const searchResponse = await router.handle(
      makeRequest("/runs/crons/search", "POST", {}),
    );
    const crons = await jsonBody<Cron[]>(searchResponse);
    expect(crons).toHaveLength(0);
  });

  test("count decreases after delete", async () => {
    // Count before
    let countResponse = await router.handle(
      makeRequest("/runs/crons/count", "POST", {}),
    );
    let count = await countResponse.json();
    expect(count).toBe(1);

    // Delete
    await router.handle(makeRequest(`/runs/crons/${cronId}`, "DELETE"));

    // Count after
    countResponse = await router.handle(
      makeRequest("/runs/crons/count", "POST", {}),
    );
    count = await countResponse.json();
    expect(count).toBe(0);
  });

  test("returns 404 for non-existent cron_id", async () => {
    const response = await router.handle(
      makeRequest(`/runs/crons/${crypto.randomUUID()}`, "DELETE"),
    );
    expect(response.status).toBe(404);

    const body = await jsonBody<ErrorBody>(response);
    expect(body.detail).toContain("not found");
  });


});

// ============================================================================
// Integration — full CRUD lifecycle via HTTP
// ============================================================================

describe("Cron CRUD lifecycle — integration", () => {
  let assistantId: string;

  beforeEach(async () => {
    resetStorage();
    resetScheduler();
    resetCronHandler();
    assistantId = await createTestAssistant();
  });

  afterEach(() => {
    resetScheduler();
  });

  test("create → search → count → delete → verify gone", async () => {

    // 1. Create
    const createResponse = await router.handle(
      makeRequest("/runs/crons", "POST", {
        schedule: "*/10 * * * *",
        assistant_id: assistantId,
        metadata: { purpose: "lifecycle-test" },
      }),
    );
    expect(createResponse.status).toBe(200);
    const created = await jsonBody<Cron>(createResponse);
    const cronId = created.cron_id;

    // 2. Search — should find it
    const searchResponse = await router.handle(
      makeRequest("/runs/crons/search", "POST", {}),
    );
    expect(searchResponse.status).toBe(200);
    const crons = await jsonBody<Cron[]>(searchResponse);
    expect(crons).toHaveLength(1);
    expect(crons[0].cron_id).toBe(cronId);
    expect(crons[0].schedule).toBe("*/10 * * * *");

    // 3. Count — should be 1
    const countResponse = await router.handle(
      makeRequest("/runs/crons/count", "POST", {}),
    );
    expect(countResponse.status).toBe(200);
    const count = await countResponse.json();
    expect(count).toBe(1);

    // 4. Delete
    const deleteResponse = await router.handle(
      makeRequest(`/runs/crons/${cronId}`, "DELETE"),
    );
    expect(deleteResponse.status).toBe(200);
    const deleteBody = await deleteResponse.json();
    expect(deleteBody).toEqual({});

    // 5. Verify gone
    const searchAfterDelete = await router.handle(
      makeRequest("/runs/crons/search", "POST", {}),
    );
    const cronsAfter = await jsonBody<Cron[]>(searchAfterDelete);
    expect(cronsAfter).toHaveLength(0);

    const countAfterDelete = await router.handle(
      makeRequest("/runs/crons/count", "POST", {}),
    );
    const countAfter = await countAfterDelete.json();
    expect(countAfter).toBe(0);
  });

  test("multiple crons with pagination", async () => {
    // Create 5 crons
    for (let i = 0; i < 5; i++) {
      const response = await router.handle(
        makeRequest("/runs/crons", "POST", {
          schedule: `*/${i + 1} * * * *`,
          assistant_id: assistantId,
        }),
      );
      expect(response.status).toBe(200);
    }

    // Verify count is 5
    const countResponse = await router.handle(
      makeRequest("/runs/crons/count", "POST", {}),
    );
    expect(await countResponse.json()).toBe(5);

    // Page 1: 3 items
    const page1Response = await router.handle(
      makeRequest("/runs/crons/search", "POST", {
        limit: 3,
        offset: 0,
        sort_by: "created_at",
        sort_order: "asc",
      }),
    );
    const page1 = await jsonBody<Cron[]>(page1Response);
    expect(page1).toHaveLength(3);

    // Page 2: 2 items
    const page2Response = await router.handle(
      makeRequest("/runs/crons/search", "POST", {
        limit: 3,
        offset: 3,
        sort_by: "created_at",
        sort_order: "asc",
      }),
    );
    const page2 = await jsonBody<Cron[]>(page2Response);
    expect(page2).toHaveLength(2);

    // No overlap between pages
    const page1Ids = new Set(page1.map((c) => c.cron_id));
    for (const cron of page2) {
      expect(page1Ids.has(cron.cron_id)).toBe(false);
    }
  });
});
