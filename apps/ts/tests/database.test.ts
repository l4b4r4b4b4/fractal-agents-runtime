/**
 * Tests for database connection management and storage factory —
 * Fractal Agents Runtime TypeScript/Bun.
 *
 * Covers:
 *   - Database initialization lifecycle (isDatabaseEnabled, initializeDatabase)
 *   - Database config reading (DATABASE_URL, pool settings)
 *   - Storage factory routing (Postgres vs in-memory fallback)
 *   - Checkpointer factory routing (PostgresSaver vs MemorySaver)
 *   - Singleton lifecycle (getStorage, resetStorage, getCheckpointer, resetCheckpointer)
 *   - Graceful fallback when DATABASE_URL not set
 *   - isDatabaseConfigured config helper
 *   - Database module accessors (getConnection, getDatabaseUrl)
 *   - Storage lifecycle functions (initializeStorage, shutdownStorage)
 *   - logDatabaseStatus smoke test
 *
 * Note: These tests do NOT connect to a real Postgres database.
 * They verify the fallback/routing logic and singleton lifecycle
 * when DATABASE_URL is not configured.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";

import {
  getStorage,
  resetStorage,
  getCheckpointer,
  resetCheckpointer,
  initializeStorage,
  shutdownStorage,
} from "../src/storage/index";
import {
  initializeDatabase,
  shutdownDatabase,
  getConnection,
  getDatabaseUrl,
  isDatabaseEnabled,
  resetDatabase,
  logDatabaseStatus,
} from "../src/storage/database";
import { isDatabaseConfigured, loadConfig } from "../src/config";
import { InMemoryStorage } from "../src/storage/memory";
import { MemorySaver } from "@langchain/langgraph";

// ---------------------------------------------------------------------------
// Environment helpers — save/restore env vars around tests
// ---------------------------------------------------------------------------

let savedDatabaseUrl: string | undefined;
let savedPoolMin: string | undefined;
let savedPoolMax: string | undefined;
let savedPoolTimeout: string | undefined;

function setDatabaseEnv(url?: string): void {
  if (url !== undefined) {
    process.env.DATABASE_URL = url;
  } else {
    delete process.env.DATABASE_URL;
  }
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  savedDatabaseUrl = process.env.DATABASE_URL;
  savedPoolMin = process.env.DATABASE_POOL_MIN_SIZE;
  savedPoolMax = process.env.DATABASE_POOL_MAX_SIZE;
  savedPoolTimeout = process.env.DATABASE_POOL_TIMEOUT;

  // Reset all singletons before each test
  resetStorage();
  resetCheckpointer();
  resetDatabase();
});

afterEach(() => {
  // Restore original env
  if (savedDatabaseUrl !== undefined) {
    process.env.DATABASE_URL = savedDatabaseUrl;
  } else {
    delete process.env.DATABASE_URL;
  }
  if (savedPoolMin !== undefined) {
    process.env.DATABASE_POOL_MIN_SIZE = savedPoolMin;
  } else {
    delete process.env.DATABASE_POOL_MIN_SIZE;
  }
  if (savedPoolMax !== undefined) {
    process.env.DATABASE_POOL_MAX_SIZE = savedPoolMax;
  } else {
    delete process.env.DATABASE_POOL_MAX_SIZE;
  }
  if (savedPoolTimeout !== undefined) {
    process.env.DATABASE_POOL_TIMEOUT = savedPoolTimeout;
  } else {
    delete process.env.DATABASE_POOL_TIMEOUT;
  }

  // Reset singletons
  resetStorage();
  resetCheckpointer();
  resetDatabase();
});

// ===========================================================================
// isDatabaseConfigured (config.ts)
// ===========================================================================

describe("isDatabaseConfigured", () => {
  test("returns false when DATABASE_URL is not set", () => {
    setDatabaseEnv(undefined);
    // Need to reload config since it's evaluated at import time
    // Use the function's internal check instead
    const config = loadConfig();
    expect(config.databaseUrl).toBeUndefined();
  });

  test("returns false when DATABASE_URL is empty string", () => {
    setDatabaseEnv("");
    const config = loadConfig();
    expect(config.databaseUrl).toBeUndefined();
  });

  test("config includes database pool settings with defaults", () => {
    delete process.env.DATABASE_POOL_MIN_SIZE;
    delete process.env.DATABASE_POOL_MAX_SIZE;
    delete process.env.DATABASE_POOL_TIMEOUT;

    const config = loadConfig();
    expect(config.databasePoolMinSize).toBe(2);
    expect(config.databasePoolMaxSize).toBe(10);
    expect(config.databasePoolTimeout).toBe(30);
  });

  test("config reads custom pool settings from env", () => {
    process.env.DATABASE_POOL_MIN_SIZE = "5";
    process.env.DATABASE_POOL_MAX_SIZE = "20";
    process.env.DATABASE_POOL_TIMEOUT = "60";

    const config = loadConfig();
    expect(config.databasePoolMinSize).toBe(5);
    expect(config.databasePoolMaxSize).toBe(20);
    expect(config.databasePoolTimeout).toBe(60);
  });

  test("config reads DATABASE_URL when set", () => {
    setDatabaseEnv("postgresql://user:pass@localhost:5432/testdb");
    const config = loadConfig();
    expect(config.databaseUrl).toBe("postgresql://user:pass@localhost:5432/testdb");
  });
});

// ===========================================================================
// isDatabaseEnabled (database.ts)
// ===========================================================================

describe("isDatabaseEnabled", () => {
  test("returns false by default (no initialization)", () => {
    setDatabaseEnv(undefined);
    expect(isDatabaseEnabled()).toBe(false);
  });

  test("returns false after resetDatabase()", () => {
    resetDatabase();
    expect(isDatabaseEnabled()).toBe(false);
  });
});

// ===========================================================================
// initializeDatabase (database.ts) — without real Postgres
// ===========================================================================

describe("initializeDatabase — no real Postgres", () => {
  test("returns false when DATABASE_URL is not set", async () => {
    setDatabaseEnv(undefined);
    const result = await initializeDatabase();
    expect(result).toBe(false);
    expect(isDatabaseEnabled()).toBe(false);
  });

  test("returns false when DATABASE_URL is empty", async () => {
    setDatabaseEnv("");
    const result = await initializeDatabase();
    expect(result).toBe(false);
    expect(isDatabaseEnabled()).toBe(false);
  });

  test("returns false when DATABASE_URL points to unreachable host", async () => {
    // Use a clearly unreachable address to trigger a connection failure
    setDatabaseEnv("postgresql://user:pass@192.0.2.1:5432/testdb");
    const result = await initializeDatabase();
    expect(result).toBe(false);
    expect(isDatabaseEnabled()).toBe(false);
  }, 15000); // Allow up to 15s for connection timeout
});

// ===========================================================================
// getConnection / getDatabaseUrl (database.ts)
// ===========================================================================

describe("getConnection", () => {
  test("returns null when database is not initialized", () => {
    setDatabaseEnv(undefined);
    resetDatabase();
    expect(getConnection()).toBeNull();
  });
});

describe("getDatabaseUrl", () => {
  test("returns null when database is not initialized", () => {
    setDatabaseEnv(undefined);
    resetDatabase();
    expect(getDatabaseUrl()).toBeNull();
  });
});

// ===========================================================================
// shutdownDatabase (database.ts)
// ===========================================================================

describe("shutdownDatabase", () => {
  test("is safe to call when not initialized", async () => {
    setDatabaseEnv(undefined);
    resetDatabase();
    // Should not throw
    await shutdownDatabase();
    expect(isDatabaseEnabled()).toBe(false);
  });

  test("resets state after shutdown", async () => {
    await shutdownDatabase();
    expect(isDatabaseEnabled()).toBe(false);
    expect(getConnection()).toBeNull();
    expect(getDatabaseUrl()).toBeNull();
  });
});

// ===========================================================================
// logDatabaseStatus (database.ts) — smoke tests
// ===========================================================================

describe("logDatabaseStatus", () => {
  test("does not throw when database is not initialized", () => {
    setDatabaseEnv(undefined);
    resetDatabase();
    expect(() => logDatabaseStatus()).not.toThrow();
  });
});

// ===========================================================================
// getStorage (storage/index.ts) — fallback to in-memory
// ===========================================================================

describe("getStorage — in-memory fallback", () => {
  test("returns InMemoryStorage when DATABASE_URL is not set", () => {
    setDatabaseEnv(undefined);
    resetDatabase();
    resetStorage();

    const storage = getStorage();
    expect(storage).toBeInstanceOf(InMemoryStorage);
  });

  test("returns same instance on subsequent calls (singleton)", () => {
    setDatabaseEnv(undefined);
    resetDatabase();
    resetStorage();

    const storage1 = getStorage();
    const storage2 = getStorage();
    expect(storage1).toBe(storage2);
  });

  test("resetStorage forces new instance on next call", () => {
    setDatabaseEnv(undefined);
    resetDatabase();
    resetStorage();

    const storage1 = getStorage();
    resetStorage();
    const storage2 = getStorage();
    expect(storage1).not.toBe(storage2);
  });

  test("storage has assistants, threads, and runs stores", () => {
    setDatabaseEnv(undefined);
    resetDatabase();
    resetStorage();

    const storage = getStorage();
    expect(storage.assistants).toBeDefined();
    expect(storage.threads).toBeDefined();
    expect(storage.runs).toBeDefined();
  });

  test("in-memory storage operations work after factory creation", async () => {
    setDatabaseEnv(undefined);
    resetDatabase();
    resetStorage();

    const storage = getStorage();

    // Create an assistant
    const assistant = await storage.assistants.create({
      graph_id: "agent",
      metadata: { test: true },
    });
    expect(assistant.graph_id).toBe("agent");
    expect(assistant.assistant_id).toBeDefined();

    // Retrieve it
    const retrieved = await storage.assistants.get(assistant.assistant_id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.assistant_id).toBe(assistant.assistant_id);

    // Clean up
    await storage.clearAll();
  });
});

// ===========================================================================
// getCheckpointer (storage/index.ts) — fallback to MemorySaver
// ===========================================================================

describe("getCheckpointer — in-memory fallback", () => {
  test("returns MemorySaver when DATABASE_URL is not set", () => {
    setDatabaseEnv(undefined);
    resetDatabase();
    resetCheckpointer();

    const cp = getCheckpointer();
    expect(cp).toBeInstanceOf(MemorySaver);
  });

  test("returns same instance on subsequent calls (singleton)", () => {
    setDatabaseEnv(undefined);
    resetDatabase();
    resetCheckpointer();

    const cp1 = getCheckpointer();
    const cp2 = getCheckpointer();
    expect(cp1).toBe(cp2);
  });

  test("resetCheckpointer forces new instance on next call", () => {
    setDatabaseEnv(undefined);
    resetDatabase();
    resetCheckpointer();

    const cp1 = getCheckpointer();
    resetCheckpointer();
    const cp2 = getCheckpointer();
    expect(cp1).not.toBe(cp2);
  });
});

// ===========================================================================
// initializeStorage (storage/index.ts) — without real Postgres
// ===========================================================================

describe("initializeStorage — no real Postgres", () => {
  test("returns false when DATABASE_URL is not set", async () => {
    setDatabaseEnv(undefined);
    resetStorage();
    resetCheckpointer();
    resetDatabase();

    const result = await initializeStorage();
    expect(result).toBe(false);
  });

  test("storage falls back to in-memory after failed initialization", async () => {
    setDatabaseEnv(undefined);
    resetStorage();
    resetCheckpointer();
    resetDatabase();

    await initializeStorage();
    const storage = getStorage();
    expect(storage).toBeInstanceOf(InMemoryStorage);
  });

  test("checkpointer falls back to MemorySaver after failed initialization", async () => {
    setDatabaseEnv(undefined);
    resetStorage();
    resetCheckpointer();
    resetDatabase();

    await initializeStorage();
    const cp = getCheckpointer();
    expect(cp).toBeInstanceOf(MemorySaver);
  });
});

// ===========================================================================
// shutdownStorage (storage/index.ts)
// ===========================================================================

describe("shutdownStorage", () => {
  test("is safe to call when not initialized", async () => {
    setDatabaseEnv(undefined);
    resetStorage();
    resetCheckpointer();
    resetDatabase();

    // Should not throw
    await shutdownStorage();
  });

  test("resets all singletons after shutdown", async () => {
    setDatabaseEnv(undefined);
    resetDatabase();

    // Create singletons
    const storageBefore = getStorage();
    const cpBefore = getCheckpointer();
    expect(storageBefore).toBeDefined();
    expect(cpBefore).toBeDefined();

    // Shutdown resets singletons
    await shutdownStorage();

    // New singletons should be created on next access
    const storageAfter = getStorage();
    const cpAfter = getCheckpointer();
    expect(storageAfter).not.toBe(storageBefore);
    expect(cpAfter).not.toBe(cpBefore);
  });
});

// ===========================================================================
// Storage factory — type verification
// ===========================================================================

describe("storage factory — type verification", () => {
  test("InMemoryStorage implements clearAll()", async () => {
    setDatabaseEnv(undefined);
    resetDatabase();
    resetStorage();

    const storage = getStorage();
    // clearAll should be a function
    expect(typeof storage.clearAll).toBe("function");
    // Should not throw
    await storage.clearAll();
  });

  test("storage.assistants has all required methods", () => {
    setDatabaseEnv(undefined);
    resetDatabase();
    resetStorage();

    const { assistants } = getStorage();
    expect(typeof assistants.create).toBe("function");
    expect(typeof assistants.get).toBe("function");
    expect(typeof assistants.search).toBe("function");
    expect(typeof assistants.update).toBe("function");
    expect(typeof assistants.delete).toBe("function");
    expect(typeof assistants.count).toBe("function");
    expect(typeof assistants.clear).toBe("function");
  });

  test("storage.threads has all required methods", () => {
    setDatabaseEnv(undefined);
    resetDatabase();
    resetStorage();

    const { threads } = getStorage();
    expect(typeof threads.create).toBe("function");
    expect(typeof threads.get).toBe("function");
    expect(typeof threads.search).toBe("function");
    expect(typeof threads.update).toBe("function");
    expect(typeof threads.delete).toBe("function");
    expect(typeof threads.count).toBe("function");
    expect(typeof threads.getState).toBe("function");
    expect(typeof threads.addStateSnapshot).toBe("function");
    expect(typeof threads.getHistory).toBe("function");
    expect(typeof threads.clear).toBe("function");
  });

  test("storage.runs has all required methods", () => {
    setDatabaseEnv(undefined);
    resetDatabase();
    resetStorage();

    const { runs } = getStorage();
    expect(typeof runs.create).toBe("function");
    expect(typeof runs.get).toBe("function");
    expect(typeof runs.listByThread).toBe("function");
    expect(typeof runs.getByThread).toBe("function");
    expect(typeof runs.deleteByThread).toBe("function");
    expect(typeof runs.getActiveRun).toBe("function");
    expect(typeof runs.updateStatus).toBe("function");
    expect(typeof runs.countByThread).toBe("function");
    expect(typeof runs.clear).toBe("function");
  });
});

// ===========================================================================
// PostgresStorage class — import verification
// ===========================================================================

describe("PostgresStorage class", () => {
  test("PostgresStorage can be imported", async () => {
    const module = await import("../src/storage/postgres");
    expect(module.PostgresStorage).toBeDefined();
    expect(typeof module.PostgresStorage).toBe("function");
  });

  test("PostgresAssistantStore can be imported", async () => {
    const module = await import("../src/storage/postgres");
    expect(module.PostgresAssistantStore).toBeDefined();
    expect(typeof module.PostgresAssistantStore).toBe("function");
  });

  test("PostgresThreadStore can be imported", async () => {
    const module = await import("../src/storage/postgres");
    expect(module.PostgresThreadStore).toBeDefined();
    expect(typeof module.PostgresThreadStore).toBe("function");
  });

  test("PostgresRunStore can be imported", async () => {
    const module = await import("../src/storage/postgres");
    expect(module.PostgresRunStore).toBeDefined();
    expect(typeof module.PostgresRunStore).toBe("function");
  });
});

// ===========================================================================
// DDL constants — import verification
// ===========================================================================

describe("database module exports", () => {
  test("all lifecycle functions are exported", () => {
    expect(typeof initializeDatabase).toBe("function");
    expect(typeof shutdownDatabase).toBe("function");
    expect(typeof resetDatabase).toBe("function");
    expect(typeof getConnection).toBe("function");
    expect(typeof getDatabaseUrl).toBe("function");
    expect(typeof isDatabaseEnabled).toBe("function");
    expect(typeof logDatabaseStatus).toBe("function");
  });
});

// ===========================================================================
// Edge cases
// ===========================================================================

describe("edge cases", () => {
  test("multiple resetStorage calls are idempotent", () => {
    resetStorage();
    resetStorage();
    resetStorage();
    // No error — and getStorage() still works
    const storage = getStorage();
    expect(storage).toBeInstanceOf(InMemoryStorage);
  });

  test("multiple resetCheckpointer calls are idempotent", () => {
    resetCheckpointer();
    resetCheckpointer();
    resetCheckpointer();
    const cp = getCheckpointer();
    expect(cp).toBeInstanceOf(MemorySaver);
  });

  test("getStorage and getCheckpointer work independently", () => {
    setDatabaseEnv(undefined);
    resetDatabase();

    const storage = getStorage();
    resetCheckpointer();
    const cp = getCheckpointer();

    // Both should still be valid
    expect(storage).toBeInstanceOf(InMemoryStorage);
    expect(cp).toBeInstanceOf(MemorySaver);
  });

  test("storage clearAll after singleton creation", async () => {
    setDatabaseEnv(undefined);
    resetDatabase();
    resetStorage();

    const storage = getStorage();
    await storage.assistants.create({ graph_id: "agent" });
    const countBefore = await storage.assistants.count();
    expect(countBefore).toBeGreaterThan(0);

    await storage.clearAll();
    const countAfter = await storage.assistants.count();
    expect(countAfter).toBe(0);
  });
});
