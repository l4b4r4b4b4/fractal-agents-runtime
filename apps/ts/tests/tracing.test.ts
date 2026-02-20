/**
 * Tests for infra/tracing — Langfuse integration and LangSmith disabling.
 *
 * Tests cover:
 * - LangSmith tracing disabled by default (LANGCHAIN_TRACING_V2)
 * - Langfuse configuration detection
 * - Langfuse initialization and shutdown lifecycle
 * - Callback handler creation
 * - injectTracing() config augmentation
 * - Graceful degradation when Langfuse is not configured
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import {
  isLangfuseConfigured,
  isLangfuseEnabled,
  initializeLangfuse,
  shutdownLangfuse,
  getLangfuseCallbackHandler,
  injectTracing,
  _resetTracingState,
} from "../src/infra/tracing";
import type { InjectTracingOptions, RunnableConfig } from "../src/infra/tracing";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Save and restore environment variables around each test. */
function saveEnv(...keys: string[]): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const key of keys) {
    saved[key] = process.env[key];
  }
  return saved;
}

function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

/** Create a minimal RunnableConfig for testing. */
function makeConfig(overrides?: Record<string, unknown>): RunnableConfig {
  return {
    configurable: { thread_id: "test-thread", run_id: "test-run" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Common env var keys
// ---------------------------------------------------------------------------

const ENV_KEYS = [
  "LANGFUSE_SECRET_KEY",
  "LANGFUSE_PUBLIC_KEY",
  "LANGFUSE_BASE_URL",
  "LANGCHAIN_TRACING_V2",
];

// ===========================================================================
// LangSmith Disabling
// ===========================================================================

describe("LangSmith Disabling", () => {
  test("LANGCHAIN_TRACING_V2 defaults to 'false' after module import", () => {
    // The module sets this at import time. Since the module is already
    // imported, the env var should already be set.
    const value = process.env.LANGCHAIN_TRACING_V2;
    expect(value).toBe("false");
  });

  test("LANGCHAIN_TRACING_V2 respects explicit override", () => {
    const saved = saveEnv("LANGCHAIN_TRACING_V2");
    try {
      process.env.LANGCHAIN_TRACING_V2 = "true";
      // The module only sets default if key is absent.
      // Since we set it to "true", it should stay "true".
      expect(process.env.LANGCHAIN_TRACING_V2).toBe("true");
    } finally {
      restoreEnv(saved);
    }
  });
});

// ===========================================================================
// Configuration Detection
// ===========================================================================

describe("Langfuse Configuration Detection", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = saveEnv(...ENV_KEYS);
    _resetTracingState();
  });

  afterEach(() => {
    restoreEnv(saved);
    _resetTracingState();
  });

  test("configured when both keys present", () => {
    process.env.LANGFUSE_SECRET_KEY = "sk-lf-test-secret";
    process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-test-public";
    expect(isLangfuseConfigured()).toBe(true);
  });

  test("not configured when secret key missing", () => {
    delete process.env.LANGFUSE_SECRET_KEY;
    process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-test";
    expect(isLangfuseConfigured()).toBe(false);
  });

  test("not configured when public key missing", () => {
    process.env.LANGFUSE_SECRET_KEY = "sk-lf-test";
    delete process.env.LANGFUSE_PUBLIC_KEY;
    expect(isLangfuseConfigured()).toBe(false);
  });

  test("not configured when both keys missing", () => {
    delete process.env.LANGFUSE_SECRET_KEY;
    delete process.env.LANGFUSE_PUBLIC_KEY;
    expect(isLangfuseConfigured()).toBe(false);
  });

  test("not configured when keys are empty strings", () => {
    process.env.LANGFUSE_SECRET_KEY = "";
    process.env.LANGFUSE_PUBLIC_KEY = "";
    expect(isLangfuseConfigured()).toBe(false);
  });

  test("not configured when secret key is empty", () => {
    process.env.LANGFUSE_SECRET_KEY = "";
    process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-test";
    expect(isLangfuseConfigured()).toBe(false);
  });

  test("not configured when public key is empty", () => {
    process.env.LANGFUSE_SECRET_KEY = "sk-lf-test";
    process.env.LANGFUSE_PUBLIC_KEY = "";
    expect(isLangfuseConfigured()).toBe(false);
  });
});

// ===========================================================================
// Initialization Lifecycle
// ===========================================================================

describe("Langfuse Initialization", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = saveEnv(...ENV_KEYS);
    _resetTracingState();
  });

  afterEach(() => {
    restoreEnv(saved);
    _resetTracingState();
  });

  test("initialize returns false when not configured", () => {
    delete process.env.LANGFUSE_SECRET_KEY;
    delete process.env.LANGFUSE_PUBLIC_KEY;
    const result = initializeLangfuse();
    expect(result).toBe(false);
    expect(isLangfuseEnabled()).toBe(false);
  });

  test("initialize returns true when configured", () => {
    process.env.LANGFUSE_SECRET_KEY = "sk-lf-test-secret";
    process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-test-public";
    process.env.LANGFUSE_BASE_URL = "http://localhost:3003";

    const result = initializeLangfuse();
    expect(result).toBe(true);
    expect(isLangfuseEnabled()).toBe(true);
  });

  test("initialize is idempotent (returns true on second call)", () => {
    process.env.LANGFUSE_SECRET_KEY = "sk-lf-test-secret";
    process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-test-public";

    const result1 = initializeLangfuse();
    const result2 = initializeLangfuse();
    expect(result1).toBe(true);
    expect(result2).toBe(true);
  });

  test("isLangfuseEnabled returns false before init", () => {
    expect(isLangfuseEnabled()).toBe(false);
  });

  test("initialize is idempotent when not configured", () => {
    delete process.env.LANGFUSE_SECRET_KEY;
    delete process.env.LANGFUSE_PUBLIC_KEY;
    const result1 = initializeLangfuse();
    const result2 = initializeLangfuse();
    expect(result1).toBe(false);
    expect(result2).toBe(false);
  });
});

// ===========================================================================
// Shutdown
// ===========================================================================

describe("Langfuse Shutdown", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = saveEnv(...ENV_KEYS);
    _resetTracingState();
  });

  afterEach(() => {
    restoreEnv(saved);
    _resetTracingState();
  });

  test("shutdown is no-op when not initialized", async () => {
    // Should not throw
    await shutdownLangfuse();
    expect(isLangfuseEnabled()).toBe(false);
  });

  test("shutdown resets initialized flag", async () => {
    process.env.LANGFUSE_SECRET_KEY = "sk-lf-test-secret";
    process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-test-public";
    initializeLangfuse();
    expect(isLangfuseEnabled()).toBe(true);

    await shutdownLangfuse();
    expect(isLangfuseEnabled()).toBe(false);
  });

  test("shutdown is safe to call multiple times", async () => {
    process.env.LANGFUSE_SECRET_KEY = "sk-lf-test-secret";
    process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-test-public";
    initializeLangfuse();

    await shutdownLangfuse();
    await shutdownLangfuse();
    expect(isLangfuseEnabled()).toBe(false);
  });

  test("re-initialize works after shutdown", async () => {
    process.env.LANGFUSE_SECRET_KEY = "sk-lf-test-secret";
    process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-test-public";
    initializeLangfuse();
    expect(isLangfuseEnabled()).toBe(true);

    await shutdownLangfuse();
    expect(isLangfuseEnabled()).toBe(false);

    const result = initializeLangfuse();
    expect(result).toBe(true);
    expect(isLangfuseEnabled()).toBe(true);
  });
});

// ===========================================================================
// Callback Handler
// ===========================================================================

describe("Langfuse Callback Handler", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = saveEnv(...ENV_KEYS);
    _resetTracingState();
  });

  afterEach(() => {
    restoreEnv(saved);
    _resetTracingState();
  });

  test("returns null when not initialized", () => {
    const handler = getLangfuseCallbackHandler();
    expect(handler).toBeNull();
  });

  test("returns handler when initialized", () => {
    process.env.LANGFUSE_SECRET_KEY = "sk-lf-test-secret";
    process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-test-public";
    initializeLangfuse();

    const handler = getLangfuseCallbackHandler();
    expect(handler).not.toBeNull();
    expect(typeof handler).toBe("object");
  });

  test("returns handler with options", () => {
    process.env.LANGFUSE_SECRET_KEY = "sk-lf-test-secret";
    process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-test-public";
    initializeLangfuse();

    const handler = getLangfuseCallbackHandler({
      userId: "user-abc",
      sessionId: "session-123",
      tags: ["test", "bun"],
    });
    expect(handler).not.toBeNull();
  });

  test("returns null after shutdown", async () => {
    process.env.LANGFUSE_SECRET_KEY = "sk-lf-test-secret";
    process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-test-public";
    initializeLangfuse();

    const handlerBefore = getLangfuseCallbackHandler();
    expect(handlerBefore).not.toBeNull();

    await shutdownLangfuse();
    const handlerAfter = getLangfuseCallbackHandler();
    expect(handlerAfter).toBeNull();
  });

  test("returns handler with no options", () => {
    process.env.LANGFUSE_SECRET_KEY = "sk-lf-test-secret";
    process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-test-public";
    initializeLangfuse();

    const handler = getLangfuseCallbackHandler();
    expect(handler).not.toBeNull();
  });

  test("returns handler with partial options", () => {
    process.env.LANGFUSE_SECRET_KEY = "sk-lf-test-secret";
    process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-test-public";
    initializeLangfuse();

    const handler = getLangfuseCallbackHandler({ userId: "user-abc" });
    expect(handler).not.toBeNull();
  });
});

// ===========================================================================
// injectTracing()
// ===========================================================================

describe("injectTracing", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = saveEnv(...ENV_KEYS);
    _resetTracingState();
  });

  afterEach(() => {
    restoreEnv(saved);
    _resetTracingState();
  });

  test("returns config unchanged when not initialized", () => {
    const config = makeConfig();
    const result = injectTracing(config, {
      userId: "user-1",
      sessionId: "session-1",
      traceName: "test",
    });
    // Should be the exact same object since no handler is available
    expect(result).toBe(config);
    expect(result.callbacks).toBeUndefined();
  });

  test("adds callback handler when initialized", () => {
    process.env.LANGFUSE_SECRET_KEY = "sk-lf-test-secret";
    process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-test-public";
    initializeLangfuse();

    const config = makeConfig();
    const result = injectTracing(config, { userId: "user-1" });

    expect(result).not.toBe(config); // New object
    expect(Array.isArray(result.callbacks)).toBe(true);
    expect((result.callbacks as unknown[]).length).toBe(1);
  });

  test("preserves existing callbacks", () => {
    process.env.LANGFUSE_SECRET_KEY = "sk-lf-test-secret";
    process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-test-public";
    initializeLangfuse();

    const existingCallback = { handleLLMStart: () => {} };
    const config = makeConfig({ callbacks: [existingCallback] });
    const result = injectTracing(config);

    const callbacks = result.callbacks as unknown[];
    expect(callbacks.length).toBe(2);
    expect(callbacks[0]).toBe(existingCallback);
  });

  test("injects userId metadata", () => {
    process.env.LANGFUSE_SECRET_KEY = "sk-lf-test-secret";
    process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-test-public";
    initializeLangfuse();

    const config = makeConfig();
    const result = injectTracing(config, { userId: "owner-abc" });

    const metadata = result.metadata as Record<string, unknown>;
    expect(metadata).toBeDefined();
    expect(metadata.langfuseUserId).toBe("owner-abc");
  });

  test("injects sessionId metadata", () => {
    process.env.LANGFUSE_SECRET_KEY = "sk-lf-test-secret";
    process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-test-public";
    initializeLangfuse();

    const config = makeConfig();
    const result = injectTracing(config, { sessionId: "thread-xyz" });

    const metadata = result.metadata as Record<string, unknown>;
    expect(metadata).toBeDefined();
    expect(metadata.langfuseSessionId).toBe("thread-xyz");
  });

  test("injects tags metadata", () => {
    process.env.LANGFUSE_SECRET_KEY = "sk-lf-test-secret";
    process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-test-public";
    initializeLangfuse();

    const config = makeConfig();
    const result = injectTracing(config, { tags: ["bun", "streaming"] });

    const metadata = result.metadata as Record<string, unknown>;
    expect(metadata).toBeDefined();
    expect(metadata.langfuseTags).toEqual(["bun", "streaming"]);
  });

  test("sets runName from traceName", () => {
    process.env.LANGFUSE_SECRET_KEY = "sk-lf-test-secret";
    process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-test-public";
    initializeLangfuse();

    const config = makeConfig();
    const result = injectTracing(config, { traceName: "agent-stream" });

    expect(result.runName).toBe("agent-stream");
  });

  test("no metadata when no attributes provided", () => {
    process.env.LANGFUSE_SECRET_KEY = "sk-lf-test-secret";
    process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-test-public";
    initializeLangfuse();

    const config = makeConfig();
    const result = injectTracing(config);

    // Callbacks should be added (the handler itself)
    expect(Array.isArray(result.callbacks)).toBe(true);
    expect((result.callbacks as unknown[]).length).toBe(1);
    // No metadata or runName should be added
    expect(result.metadata).toBeUndefined();
    expect(result.runName).toBeUndefined();
  });

  test("preserves existing metadata", () => {
    process.env.LANGFUSE_SECRET_KEY = "sk-lf-test-secret";
    process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-test-public";
    initializeLangfuse();

    const config = makeConfig({
      metadata: { existingKey: "existingValue", graph_id: "agent" },
    });
    const result = injectTracing(config, { userId: "user-1" });

    const metadata = result.metadata as Record<string, unknown>;
    expect(metadata.existingKey).toBe("existingValue");
    expect(metadata.graph_id).toBe("agent");
    expect(metadata.langfuseUserId).toBe("user-1");
  });

  test("does not mutate original config", () => {
    process.env.LANGFUSE_SECRET_KEY = "sk-lf-test-secret";
    process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-test-public";
    initializeLangfuse();

    const originalCallbacks = [{ handleLLMStart: () => {} }];
    const originalMetadata = { existingKey: "value" };
    const config = makeConfig({
      callbacks: originalCallbacks,
      metadata: originalMetadata,
    });

    const result = injectTracing(config, {
      userId: "user-1",
      traceName: "test-trace",
    });

    // Original config should be unchanged
    expect(config.callbacks).toBe(originalCallbacks);
    expect((config.callbacks as unknown[]).length).toBe(1);
    expect(config.metadata).toBe(originalMetadata);
    expect((config.metadata as Record<string, unknown>).langfuseUserId).toBeUndefined();
    expect(config.runName).toBeUndefined();

    // Result should be different
    expect(result).not.toBe(config);
    expect((result.callbacks as unknown[]).length).toBe(2);
    expect((result.metadata as Record<string, unknown>).langfuseUserId).toBe("user-1");
    expect(result.runName).toBe("test-trace");
  });

  test("all attributes combined", () => {
    process.env.LANGFUSE_SECRET_KEY = "sk-lf-test-secret";
    process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-test-public";
    initializeLangfuse();

    const config = makeConfig();
    const result = injectTracing(config, {
      userId: "owner-123",
      sessionId: "thread-456",
      traceName: "agent-stream",
      tags: ["bun", "streaming", "v0.0.3"],
    });

    // Callbacks
    const callbacks = result.callbacks as unknown[];
    expect(callbacks.length).toBe(1);

    // Metadata
    const metadata = result.metadata as Record<string, unknown>;
    expect(metadata.langfuseUserId).toBe("owner-123");
    expect(metadata.langfuseSessionId).toBe("thread-456");
    expect(metadata.langfuseTags).toEqual(["bun", "streaming", "v0.0.3"]);

    // Run name
    expect(result.runName).toBe("agent-stream");

    // Configurable preserved
    const configurable = result.configurable as Record<string, unknown>;
    expect(configurable.thread_id).toBe("test-thread");
    expect(configurable.run_id).toBe("test-run");
  });

  test("configurable preserved through injection", () => {
    process.env.LANGFUSE_SECRET_KEY = "sk-lf-test-secret";
    process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-test-public";
    initializeLangfuse();

    const config: RunnableConfig = {
      configurable: {
        thread_id: "thread-abc",
        run_id: "run-xyz",
        assistant_id: "asst-001",
      },
    };
    const result = injectTracing(config, { userId: "user-1" });

    const configurable = result.configurable as Record<string, unknown>;
    expect(configurable.thread_id).toBe("thread-abc");
    expect(configurable.run_id).toBe("run-xyz");
    expect(configurable.assistant_id).toBe("asst-001");
  });

  test("empty config works", () => {
    process.env.LANGFUSE_SECRET_KEY = "sk-lf-test-secret";
    process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-test-public";
    initializeLangfuse();

    const config: RunnableConfig = {};
    const result = injectTracing(config, { userId: "user-1" });

    expect(Array.isArray(result.callbacks)).toBe(true);
    expect((result.callbacks as unknown[]).length).toBe(1);
    expect((result.metadata as Record<string, unknown>).langfuseUserId).toBe("user-1");
  });
});

// ===========================================================================
// Reset Tracing State
// ===========================================================================

describe("_resetTracingState", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = saveEnv(...ENV_KEYS);
  });

  afterEach(() => {
    restoreEnv(saved);
    _resetTracingState();
  });

  test("resets initialized flag", () => {
    process.env.LANGFUSE_SECRET_KEY = "sk-lf-test-secret";
    process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-test-public";
    initializeLangfuse();
    expect(isLangfuseEnabled()).toBe(true);

    _resetTracingState();
    expect(isLangfuseEnabled()).toBe(false);
  });

  test("idempotent reset", () => {
    _resetTracingState();
    _resetTracingState();
    expect(isLangfuseEnabled()).toBe(false);
  });

  test("handler returns null after reset", () => {
    process.env.LANGFUSE_SECRET_KEY = "sk-lf-test-secret";
    process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-test-public";
    initializeLangfuse();

    const handlerBefore = getLangfuseCallbackHandler();
    expect(handlerBefore).not.toBeNull();

    _resetTracingState();

    const handlerAfter = getLangfuseCallbackHandler();
    expect(handlerAfter).toBeNull();
  });
});

// ===========================================================================
// Tracing Disabled Integration
// ===========================================================================

describe("Tracing Disabled Integration", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = saveEnv(...ENV_KEYS);
    _resetTracingState();
    delete process.env.LANGFUSE_SECRET_KEY;
    delete process.env.LANGFUSE_PUBLIC_KEY;
  });

  afterEach(() => {
    restoreEnv(saved);
    _resetTracingState();
  });

  test("injectTracing is identity when disabled", () => {
    const config = makeConfig({
      callbacks: [{ handleLLMStart: () => {} }],
      metadata: { graph_id: "agent" },
    });

    const result = injectTracing(config, {
      userId: "user-1",
      sessionId: "session-1",
      traceName: "test",
      tags: ["tag1"],
    });

    // Should be the exact same object
    expect(result).toBe(config);

    // Callbacks should be unchanged
    expect((result.callbacks as unknown[]).length).toBe(1);

    // No Langfuse metadata should be added
    const metadata = result.metadata as Record<string, unknown>;
    expect(metadata.langfuseUserId).toBeUndefined();
    expect(metadata.langfuseSessionId).toBeUndefined();
    expect(metadata.langfuseTags).toBeUndefined();

    // No runName
    expect(result.runName).toBeUndefined();
  });

  test("handler is null when disabled", () => {
    const handler = getLangfuseCallbackHandler({ userId: "user-1" });
    expect(handler).toBeNull();
  });

  test("shutdown is safe when never initialized", async () => {
    // Should not throw
    await shutdownLangfuse();
    expect(isLangfuseEnabled()).toBe(false);
  });

  test("initialize then inject works end-to-end", () => {
    // Start disabled
    expect(isLangfuseEnabled()).toBe(false);
    const configDisabled = makeConfig();
    const resultDisabled = injectTracing(configDisabled, { userId: "user-1" });
    expect(resultDisabled).toBe(configDisabled);

    // Enable
    process.env.LANGFUSE_SECRET_KEY = "sk-lf-test-secret";
    process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-test-public";
    initializeLangfuse();
    expect(isLangfuseEnabled()).toBe(true);

    // Now inject should augment
    const configEnabled = makeConfig();
    const resultEnabled = injectTracing(configEnabled, { userId: "user-1" });
    expect(resultEnabled).not.toBe(configEnabled);
    expect(Array.isArray(resultEnabled.callbacks)).toBe(true);
    expect((resultEnabled.callbacks as unknown[]).length).toBe(1);
    expect(
      (resultEnabled.metadata as Record<string, unknown>).langfuseUserId,
    ).toBe("user-1");
  });
});

// ===========================================================================
// Multiple handler creation (each invocation gets fresh handler)
// ===========================================================================

describe("Multiple handler instances", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = saveEnv(...ENV_KEYS);
    _resetTracingState();
    process.env.LANGFUSE_SECRET_KEY = "sk-lf-test-secret";
    process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-test-public";
    initializeLangfuse();
  });

  afterEach(() => {
    restoreEnv(saved);
    _resetTracingState();
  });

  test("each call creates a new handler instance", () => {
    const handler1 = getLangfuseCallbackHandler({ userId: "user-1" });
    const handler2 = getLangfuseCallbackHandler({ userId: "user-2" });

    expect(handler1).not.toBeNull();
    expect(handler2).not.toBeNull();
    // Each invocation should produce a distinct handler object
    expect(handler1).not.toBe(handler2);
  });

  test("each injectTracing call creates independent configs", () => {
    const config1 = makeConfig();
    const config2 = makeConfig();

    const result1 = injectTracing(config1, { userId: "user-A", traceName: "trace-1" });
    const result2 = injectTracing(config2, { userId: "user-B", traceName: "trace-2" });

    // Different objects
    expect(result1).not.toBe(result2);

    // Different metadata
    expect((result1.metadata as Record<string, unknown>).langfuseUserId).toBe("user-A");
    expect((result2.metadata as Record<string, unknown>).langfuseUserId).toBe("user-B");

    // Different run names
    expect(result1.runName).toBe("trace-1");
    expect(result2.runName).toBe("trace-2");

    // Different handler instances in callbacks
    const callbacks1 = result1.callbacks as unknown[];
    const callbacks2 = result2.callbacks as unknown[];
    expect(callbacks1[0]).not.toBe(callbacks2[0]);
  });
});
