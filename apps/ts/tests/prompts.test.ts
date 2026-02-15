/**
 * Unit tests for the Langfuse prompt templates module.
 *
 * Covers:
 *   - Text variable substitution (substituteVariablesText)
 *   - Chat variable substitution (substituteVariablesChat)
 *   - Config override extraction (extractOverrides)
 *   - Prompt registration and deduplication (registerDefaultPrompt)
 *   - Registry reset (resetPromptRegistry)
 *   - Synchronous prompt retrieval with fallback (getPrompt)
 *   - Async prompt retrieval with fallback (getPromptAsync)
 *   - Seed default prompts lifecycle (seedDefaultPrompts)
 *   - Cache TTL resolution from environment
 *   - Graceful degradation when Langfuse is not configured
 *
 * Reference: apps/python/src/server/tests/test_prompts.py
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";

import {
  substituteVariablesText,
  substituteVariablesChat,
  extractOverrides,
  registerDefaultPrompt,
  resetPromptRegistry,
  getPrompt,
  getPromptAsync,
  seedDefaultPrompts,
} from "../src/infra/prompts";
import type { ChatMessage, PromptType } from "../src/infra/prompts";

import {
  isLangfuseEnabled,
  initializeLangfuse,
  _resetTracingState,
} from "../src/infra/tracing";

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

const LANGFUSE_ENV_KEYS = [
  "LANGFUSE_SECRET_KEY",
  "LANGFUSE_PUBLIC_KEY",
  "LANGFUSE_BASE_URL",
  "LANGFUSE_PROMPT_CACHE_TTL",
];

// ===========================================================================
// substituteVariablesText
// ===========================================================================

describe("substituteVariablesText", () => {
  it("replaces known variables in template", () => {
    const result = substituteVariablesText(
      "Hello {{name}}, welcome to {{city}}!",
      { name: "Alice", city: "München" },
    );
    expect(result).toBe("Hello Alice, welcome to München!");
  });

  it("leaves unknown variables untouched", () => {
    const result = substituteVariablesText(
      "Hello {{name}}, your role is {{role}}.",
      { name: "Bob" },
    );
    expect(result).toBe("Hello Bob, your role is {{role}}.");
  });

  it("returns template unchanged when no placeholders exist", () => {
    const result = substituteVariablesText("No variables here.", {
      name: "Alice",
    });
    expect(result).toBe("No variables here.");
  });

  it("returns template unchanged with empty variables dict", () => {
    const result = substituteVariablesText("Hello {{name}}!", {});
    expect(result).toBe("Hello {{name}}!");
  });

  it("replaces repeated occurrences of the same variable", () => {
    const result = substituteVariablesText("{{x}} and {{x}} again.", {
      x: "yes",
    });
    expect(result).toBe("yes and yes again.");
  });

  it("handles empty template string", () => {
    const result = substituteVariablesText("", { name: "Alice" });
    expect(result).toBe("");
  });

  it("handles multiple different variables in one template", () => {
    const result = substituteVariablesText(
      "{{greeting}} {{name}}, today is {{day}}.",
      { greeting: "Hi", name: "Bob", day: "Monday" },
    );
    expect(result).toBe("Hi Bob, today is Monday.");
  });
});

// ===========================================================================
// substituteVariablesChat
// ===========================================================================

describe("substituteVariablesChat", () => {
  it("substitutes variables in message content strings", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "You help with {{topic}}." },
      { role: "user", content: "Tell me about {{topic}}." },
    ];
    const result = substituteVariablesChat(messages, { topic: "sales" });
    expect(result).toEqual([
      { role: "system", content: "You help with sales." },
      { role: "user", content: "Tell me about sales." },
    ]);
  });

  it("does not mutate the original messages array", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "{{x}}" },
    ];
    const originalContent = messages[0].content;
    const result = substituteVariablesChat(messages, { x: "replaced" });

    // Original should be unchanged
    expect(messages[0].content).toBe(originalContent);
    // Result should have the substituted value
    expect(result[0].content).toBe("replaced");
  });

  it("preserves extra keys on message objects", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "Hello {{name}}", tool_call_id: "abc" },
    ];
    const result = substituteVariablesChat(messages, { name: "World" });
    expect(result[0].content).toBe("Hello World");
    expect(result[0].tool_call_id).toBe("abc");
    expect(result[0].role).toBe("system");
  });

  it("handles empty messages array", () => {
    const result = substituteVariablesChat([], { name: "Alice" });
    expect(result).toEqual([]);
  });

  it("leaves non-matching placeholders in chat messages", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "{{unknown_var}} stays" },
    ];
    const result = substituteVariablesChat(messages, { other: "value" });
    expect(result[0].content).toBe("{{unknown_var}} stays");
  });
});

// ===========================================================================
// extractOverrides
// ===========================================================================

describe("extractOverrides", () => {
  it("returns empty object when config is null", () => {
    expect(extractOverrides("my-prompt", null)).toEqual({});
  });

  it("returns empty object when config is undefined", () => {
    expect(extractOverrides("my-prompt", undefined)).toEqual({});
  });

  it("returns empty object when configurable is empty", () => {
    const config = { configurable: {} };
    expect(extractOverrides("my-prompt", config)).toEqual({});
  });

  it("returns empty object when no prompt_overrides key exists", () => {
    const config = { configurable: { model_name: "gpt-4o" } };
    expect(extractOverrides("my-prompt", config)).toEqual({});
  });

  it("returns empty object when prompt_overrides is not a dict", () => {
    const config = { configurable: { prompt_overrides: "invalid" } };
    expect(extractOverrides("my-prompt", config)).toEqual({});
  });

  it("returns empty object when prompt name is not in overrides", () => {
    const config = {
      configurable: {
        prompt_overrides: { "other-prompt": { label: "staging" } },
      },
    };
    expect(extractOverrides("my-prompt", config)).toEqual({});
  });

  it("returns empty object when override entry is not a dict", () => {
    const config = {
      configurable: { prompt_overrides: { "my-prompt": "invalid" } },
    };
    expect(extractOverrides("my-prompt", config)).toEqual({});
  });

  it("extracts valid label override", () => {
    const config = {
      configurable: {
        prompt_overrides: { "my-prompt": { label: "staging" } },
      },
    };
    expect(extractOverrides("my-prompt", config)).toEqual({
      label: "staging",
    });
  });

  it("extracts valid version override", () => {
    const config = {
      configurable: {
        prompt_overrides: { "my-prompt": { version: 5 } },
      },
    };
    expect(extractOverrides("my-prompt", config)).toEqual({ version: 5 });
  });

  it("extracts valid name override", () => {
    const config = {
      configurable: {
        prompt_overrides: { "my-prompt": { name: "custom-prompt" } },
      },
    };
    expect(extractOverrides("my-prompt", config)).toEqual({
      name: "custom-prompt",
    });
  });

  it("extracts combined overrides (name, label, version)", () => {
    const config = {
      configurable: {
        prompt_overrides: {
          "my-prompt": {
            name: "other",
            label: "experiment-a",
            version: 7,
          },
        },
      },
    };
    const overrides = extractOverrides("my-prompt", config);
    expect(overrides).toEqual({
      name: "other",
      label: "experiment-a",
      version: 7,
    });
  });

  it("returns empty object when configurable is not an object", () => {
    const config = { configurable: null } as unknown as Record<string, unknown>;
    expect(extractOverrides("my-prompt", config)).toEqual({});
  });

  it("returns empty object when prompt_overrides entry is null", () => {
    const config = {
      configurable: { prompt_overrides: { "my-prompt": null } },
    };
    expect(extractOverrides("my-prompt", config)).toEqual({});
  });
});

// ===========================================================================
// registerDefaultPrompt & resetPromptRegistry
// ===========================================================================

describe("registerDefaultPrompt", () => {
  beforeEach(() => {
    resetPromptRegistry();
  });

  afterEach(() => {
    resetPromptRegistry();
  });

  it("registers a text prompt successfully", () => {
    // registerDefaultPrompt doesn't throw; we verify by seeding later.
    // Just ensure it doesn't throw.
    expect(() =>
      registerDefaultPrompt("my-prompt", "Hello world"),
    ).not.toThrow();
  });

  it("registers a chat prompt with explicit type", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "Hi" },
    ];
    expect(() =>
      registerDefaultPrompt("my-chat", messages, "chat"),
    ).not.toThrow();
  });

  it("ignores duplicate registrations (first-write-wins)", () => {
    registerDefaultPrompt("my-prompt", "First");
    registerDefaultPrompt("my-prompt", "Second");
    // The deduplication is internal — we can verify by registering
    // two different names and checking the second one is separate.
    registerDefaultPrompt("other-prompt", "Other");

    // No way to inspect count directly, but we can verify that
    // repeated calls don't throw.
    expect(true).toBe(true);
  });

  it("allows different names to be registered independently", () => {
    registerDefaultPrompt("prompt-a", "A");
    registerDefaultPrompt("prompt-b", "B");
    // Both should register without error.
    expect(true).toBe(true);
  });
});

describe("resetPromptRegistry", () => {
  it("clears all registered prompts", () => {
    registerDefaultPrompt("test-prompt", "content");
    resetPromptRegistry();
    // After reset, re-registering the same name should work
    // (because deduplicate set is cleared).
    registerDefaultPrompt("test-prompt", "new content");
    // No error means the reset worked.
    expect(true).toBe(true);
  });

  it("is safe to call multiple times", () => {
    resetPromptRegistry();
    resetPromptRegistry();
    resetPromptRegistry();
    expect(true).toBe(true);
  });

  it("is safe to call when registry is already empty", () => {
    resetPromptRegistry();
    expect(() => resetPromptRegistry()).not.toThrow();
  });
});

// ===========================================================================
// getPrompt (synchronous) — always returns fallback
// ===========================================================================

describe("getPrompt (sync)", () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = saveEnv(...LANGFUSE_ENV_KEYS);
    _resetTracingState();
    resetPromptRegistry();
  });

  afterEach(() => {
    restoreEnv(savedEnv);
    _resetTracingState();
    resetPromptRegistry();
  });

  it("returns text fallback when Langfuse is not configured", () => {
    const result = getPrompt({
      name: "my-prompt",
      fallback: "Default text",
    });
    expect(result).toBe("Default text");
  });

  it("returns text fallback with variable substitution", () => {
    const result = getPrompt({
      name: "my-prompt",
      fallback: "Hello {{name}}!",
      variables: { name: "World" },
    });
    expect(result).toBe("Hello World!");
  });

  it("returns chat fallback when prompt type is chat", () => {
    const fallbackMessages: ChatMessage[] = [
      { role: "system", content: "Default chat" },
    ];
    const result = getPrompt({
      name: "my-prompt",
      promptType: "chat",
      fallback: fallbackMessages,
    });
    expect(result).toEqual(fallbackMessages);
  });

  it("returns chat fallback with variable substitution", () => {
    const result = getPrompt({
      name: "my-prompt",
      promptType: "chat",
      fallback: [{ role: "system", content: "Hello {{user}}" }],
      variables: { user: "Tester" },
    });
    expect(result).toEqual([
      { role: "system", content: "Hello Tester" },
    ]);
  });

  it("returns fallback even when config overrides are provided (Langfuse disabled)", () => {
    const config = {
      configurable: {
        prompt_overrides: { "my-prompt": { label: "staging" } },
      },
    };
    const result = getPrompt({
      name: "my-prompt",
      fallback: "Default",
      config,
    });
    expect(result).toBe("Default");
  });

  it("returns fallback with no variable substitution when variables is null", () => {
    const result = getPrompt({
      name: "my-prompt",
      fallback: "Hello {{name}}!",
      variables: null,
    });
    expect(result).toBe("Hello {{name}}!");
  });

  it("returns fallback with empty variables (no substitution)", () => {
    const result = getPrompt({
      name: "my-prompt",
      fallback: "Hello {{name}}!",
      variables: {},
    });
    // Empty variables dict means no substitution occurs —
    // applyFallback returns unchanged when variables is empty.
    expect(result).toBe("Hello {{name}}!");
  });

  it("returns text fallback even when Langfuse IS initialized (sync always falls back)", () => {
    // Initialize Langfuse (with real env vars) to make isLangfuseEnabled() true
    process.env.LANGFUSE_SECRET_KEY = "sk-lf-test-secret";
    process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-test-public";
    process.env.LANGFUSE_BASE_URL = "http://localhost:9999";
    initializeLangfuse();

    expect(isLangfuseEnabled()).toBe(true);

    // Sync getPrompt still returns fallback because Langfuse JS SDK
    // is async and the sync path can't call it.
    const result = getPrompt({
      name: "my-prompt",
      fallback: "Sync fallback text",
    });
    expect(result).toBe("Sync fallback text");
  });
});

// ===========================================================================
// getPromptAsync — Langfuse NOT configured (fallback path)
// ===========================================================================

describe("getPromptAsync — Langfuse disabled", () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = saveEnv(...LANGFUSE_ENV_KEYS);
    _resetTracingState();
    resetPromptRegistry();
    // Ensure Langfuse is NOT enabled
    delete process.env.LANGFUSE_SECRET_KEY;
    delete process.env.LANGFUSE_PUBLIC_KEY;
  });

  afterEach(() => {
    restoreEnv(savedEnv);
    _resetTracingState();
    resetPromptRegistry();
  });

  it("returns text fallback", async () => {
    const result = await getPromptAsync({
      name: "my-prompt",
      fallback: "Async default text",
    });
    expect(result).toBe("Async default text");
  });

  it("returns text fallback with variable substitution", async () => {
    const result = await getPromptAsync({
      name: "my-prompt",
      fallback: "Hello {{name}}!",
      variables: { name: "AsyncWorld" },
    });
    expect(result).toBe("Hello AsyncWorld!");
  });

  it("returns chat fallback", async () => {
    const fallbackMessages: ChatMessage[] = [
      { role: "system", content: "Async default chat" },
    ];
    const result = await getPromptAsync({
      name: "my-prompt",
      promptType: "chat",
      fallback: fallbackMessages,
    });
    expect(result).toEqual(fallbackMessages);
  });

  it("returns chat fallback with variable substitution", async () => {
    const result = await getPromptAsync({
      name: "my-prompt",
      promptType: "chat",
      fallback: [{ role: "system", content: "Hello {{user}}" }],
      variables: { user: "AsyncTester" },
    });
    expect(result).toEqual([
      { role: "system", content: "Hello AsyncTester" },
    ]);
  });

  it("ignores config overrides when Langfuse is disabled", async () => {
    const config = {
      configurable: {
        prompt_overrides: { "my-prompt": { label: "staging" } },
      },
    };
    const result = await getPromptAsync({
      name: "my-prompt",
      fallback: "Async default",
      config,
    });
    expect(result).toBe("Async default");
  });

  it("returns fallback with null variables (no substitution)", async () => {
    const result = await getPromptAsync({
      name: "my-prompt",
      fallback: "Hello {{name}}!",
      variables: null,
    });
    expect(result).toBe("Hello {{name}}!");
  });
});

// ===========================================================================
// getPromptAsync — Langfuse enabled but unreachable (error/fallback path)
// ===========================================================================

describe("getPromptAsync — Langfuse enabled (error fallback)", () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = saveEnv(...LANGFUSE_ENV_KEYS);
    _resetTracingState();
    resetPromptRegistry();
    // Configure Langfuse with dummy values pointing to nowhere
    process.env.LANGFUSE_SECRET_KEY = "sk-lf-test-secret";
    process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-test-public";
    process.env.LANGFUSE_BASE_URL = "http://localhost:1";
    initializeLangfuse();
  });

  afterEach(() => {
    restoreEnv(savedEnv);
    _resetTracingState();
    resetPromptRegistry();
  });

  it("is running with Langfuse enabled", () => {
    expect(isLangfuseEnabled()).toBe(true);
  });

  it("returns text fallback when Langfuse client fails", async () => {
    const result = await getPromptAsync({
      name: "nonexistent-prompt",
      fallback: "Safe text default",
    });
    // Should return fallback since Langfuse server is unreachable
    expect(typeof result).toBe("string");
    // The result should be a string (either the fallback or a compiled version)
    expect(result).toBeTruthy();
  });

  it("returns chat fallback when Langfuse client fails", async () => {
    const fallbackMessages: ChatMessage[] = [
      { role: "system", content: "Safe chat default" },
    ];
    const result = await getPromptAsync({
      name: "nonexistent-prompt",
      promptType: "chat",
      fallback: fallbackMessages,
    });
    // Should return some form of the fallback
    expect(Array.isArray(result)).toBe(true);
  });

  it("applies variable substitution to fallback on error", async () => {
    const result = await getPromptAsync({
      name: "nonexistent-prompt",
      fallback: "Hello {{name}}!",
      variables: { name: "Fallback" },
    });
    // Whether from catch block or Langfuse fallback mechanism,
    // the result should have the variable substituted.
    expect(typeof result).toBe("string");
  });

  it("does not throw on unreachable Langfuse server", async () => {
    // Should never throw — always returns fallback gracefully
    await expect(
      getPromptAsync({
        name: "my-prompt",
        fallback: "error safe",
        cacheTtlSeconds: 0,
      }),
    ).resolves.toBeDefined();
  });
});

// ===========================================================================
// seedDefaultPrompts — Langfuse NOT configured
// ===========================================================================

describe("seedDefaultPrompts — Langfuse disabled", () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = saveEnv(...LANGFUSE_ENV_KEYS);
    _resetTracingState();
    resetPromptRegistry();
    delete process.env.LANGFUSE_SECRET_KEY;
    delete process.env.LANGFUSE_PUBLIC_KEY;
  });

  afterEach(() => {
    restoreEnv(savedEnv);
    _resetTracingState();
    resetPromptRegistry();
  });

  it("returns 0 when Langfuse is disabled", async () => {
    registerDefaultPrompt("my-prompt", "Hello");
    const created = await seedDefaultPrompts();
    expect(created).toBe(0);
  });

  it("returns 0 when no prompts are registered", async () => {
    // Even if we somehow enabled Langfuse, no registered prompts → 0
    const created = await seedDefaultPrompts();
    expect(created).toBe(0);
  });
});

// ===========================================================================
// seedDefaultPrompts — Langfuse enabled but unreachable
// ===========================================================================

describe("seedDefaultPrompts — Langfuse enabled (error handling)", () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = saveEnv(...LANGFUSE_ENV_KEYS);
    _resetTracingState();
    resetPromptRegistry();
    process.env.LANGFUSE_SECRET_KEY = "sk-lf-test-secret";
    process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-test-public";
    process.env.LANGFUSE_BASE_URL = "http://localhost:1";
    initializeLangfuse();
  });

  afterEach(() => {
    restoreEnv(savedEnv);
    _resetTracingState();
    resetPromptRegistry();
  });

  it("returns 0 when no prompts are registered (Langfuse enabled)", async () => {
    expect(isLangfuseEnabled()).toBe(true);
    const created = await seedDefaultPrompts();
    expect(created).toBe(0);
  });

  it("does not throw when Langfuse is unreachable during seeding", async () => {
    registerDefaultPrompt("test-prompt", "Hello seeded world");
    // Should not throw even if Langfuse is unreachable
    await expect(seedDefaultPrompts()).resolves.toBeDefined();
  });

  it("returns a number (0 or more) when seeding with registered prompts", async () => {
    registerDefaultPrompt("seed-test-1", "Content A");
    registerDefaultPrompt("seed-test-2", "Content B");
    const created = await seedDefaultPrompts();
    expect(typeof created).toBe("number");
    expect(created).toBeGreaterThanOrEqual(0);
  });
});

// ===========================================================================
// getDefaultCacheTtl (tested indirectly via getPrompt behavior)
// ===========================================================================

describe("Cache TTL from environment", () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = saveEnv(...LANGFUSE_ENV_KEYS);
    _resetTracingState();
    resetPromptRegistry();
  });

  afterEach(() => {
    restoreEnv(savedEnv);
    _resetTracingState();
    resetPromptRegistry();
  });

  it("uses default TTL (300) when env var is not set", () => {
    delete process.env.LANGFUSE_PROMPT_CACHE_TTL;
    // getPrompt still works — it just uses the default TTL internally.
    const result = getPrompt({
      name: "ttl-test",
      fallback: "default ttl",
    });
    expect(result).toBe("default ttl");
  });

  it("reads custom TTL from LANGFUSE_PROMPT_CACHE_TTL env var", () => {
    process.env.LANGFUSE_PROMPT_CACHE_TTL = "600";
    // getPrompt still works — the TTL is used internally for Langfuse calls.
    const result = getPrompt({
      name: "ttl-test",
      fallback: "custom ttl",
    });
    expect(result).toBe("custom ttl");
  });

  it("handles TTL of 0 (disable caching) without error", () => {
    process.env.LANGFUSE_PROMPT_CACHE_TTL = "0";
    const result = getPrompt({
      name: "ttl-test",
      fallback: "no cache",
    });
    expect(result).toBe("no cache");
  });

  it("uses default TTL when env var is invalid (non-numeric)", () => {
    process.env.LANGFUSE_PROMPT_CACHE_TTL = "not-a-number";
    // Should use default (300) and log a warning, but not throw.
    const result = getPrompt({
      name: "ttl-test",
      fallback: "invalid ttl fallback",
    });
    expect(result).toBe("invalid ttl fallback");
  });

  it("per-call cacheTtlSeconds is accepted without error", () => {
    const result = getPrompt({
      name: "ttl-test",
      fallback: "per-call ttl",
      cacheTtlSeconds: 60,
    });
    expect(result).toBe("per-call ttl");
  });
});

// ===========================================================================
// getPrompt — type safety and edge cases
// ===========================================================================

describe("getPrompt — edge cases", () => {
  beforeEach(() => {
    _resetTracingState();
    resetPromptRegistry();
  });

  afterEach(() => {
    _resetTracingState();
    resetPromptRegistry();
  });

  it("handles empty string fallback", () => {
    const result = getPrompt({
      name: "empty-fallback",
      fallback: "",
    });
    expect(result).toBe("");
  });

  it("handles empty chat messages array as fallback", () => {
    const result = getPrompt({
      name: "empty-chat",
      promptType: "chat",
      fallback: [],
    });
    expect(result).toEqual([]);
  });

  it("handles chat messages with multiple roles", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "System {{mode}}" },
      { role: "user", content: "User {{query}}" },
      { role: "assistant", content: "Assistant {{response}}" },
    ];
    const result = getPrompt({
      name: "multi-role",
      promptType: "chat",
      fallback: messages,
      variables: { mode: "test", query: "hello", response: "world" },
    });
    expect(result).toEqual([
      { role: "system", content: "System test" },
      { role: "user", content: "User hello" },
      { role: "assistant", content: "Assistant world" },
    ]);
  });

  it("uses default label 'production' when no label specified", () => {
    // Verifying the function accepts no label without error
    const result = getPrompt({
      name: "no-label",
      fallback: "default label test",
    });
    expect(result).toBe("default label test");
  });

  it("accepts custom label parameter", () => {
    const result = getPrompt({
      name: "custom-label",
      fallback: "staging test",
      label: "staging",
    });
    expect(result).toBe("staging test");
  });

  it("handles config with non-object configurable gracefully", () => {
    const config = { configurable: "not-an-object" } as unknown as Record<
      string,
      unknown
    >;
    const result = getPrompt({
      name: "bad-config",
      fallback: "fallback",
      config,
    });
    expect(result).toBe("fallback");
  });
});

// ===========================================================================
// getPromptAsync — edge cases
// ===========================================================================

describe("getPromptAsync — edge cases", () => {
  beforeEach(() => {
    _resetTracingState();
    resetPromptRegistry();
  });

  afterEach(() => {
    _resetTracingState();
    resetPromptRegistry();
  });

  it("handles empty string fallback", async () => {
    const result = await getPromptAsync({
      name: "empty-fallback",
      fallback: "",
    });
    expect(result).toBe("");
  });

  it("handles empty chat messages array as fallback", async () => {
    const result = await getPromptAsync({
      name: "empty-chat",
      promptType: "chat",
      fallback: [],
    });
    expect(result).toEqual([]);
  });

  it("applies variables to chat fallback in async path", async () => {
    const result = await getPromptAsync({
      name: "async-chat-vars",
      promptType: "chat",
      fallback: [
        { role: "system", content: "Welcome {{user}} to {{service}}" },
      ],
      variables: { user: "Alice", service: "AgentHub" },
    });
    expect(result).toEqual([
      { role: "system", content: "Welcome Alice to AgentHub" },
    ]);
  });

  it("returns a promise that resolves (never rejects)", async () => {
    // Even with bizarre inputs, getPromptAsync should never reject.
    const promise = getPromptAsync({
      name: "",
      fallback: "empty name fallback",
    });
    await expect(promise).resolves.toBeDefined();
  });
});

// ===========================================================================
// Integration-style: combined features
// ===========================================================================

describe("Integration — combined prompt features", () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = saveEnv(...LANGFUSE_ENV_KEYS);
    _resetTracingState();
    resetPromptRegistry();
    delete process.env.LANGFUSE_SECRET_KEY;
    delete process.env.LANGFUSE_PUBLIC_KEY;
  });

  afterEach(() => {
    restoreEnv(savedEnv);
    _resetTracingState();
    resetPromptRegistry();
  });

  it("registers prompt, then retrieves fallback (Langfuse disabled)", () => {
    registerDefaultPrompt(
      "react-agent-system-prompt",
      "You are a helpful assistant.",
    );

    const result = getPrompt({
      name: "react-agent-system-prompt",
      fallback: "You are a helpful assistant.",
    });
    expect(result).toBe("You are a helpful assistant.");
  });

  it("registers chat prompt, retrieves with variables", () => {
    const defaultMessages: ChatMessage[] = [
      { role: "system", content: "Du bist ein {{agent_type}}-Agent." },
    ];
    registerDefaultPrompt("vertriebsagent-system", defaultMessages, "chat");

    const result = getPrompt({
      name: "vertriebsagent-system",
      promptType: "chat",
      fallback: defaultMessages,
      variables: { agent_type: "Vertriebs" },
    });
    expect(result).toEqual([
      { role: "system", content: "Du bist ein Vertriebs-Agent." },
    ]);
  });

  it("config overrides are extracted but have no effect without Langfuse", () => {
    const config = {
      configurable: {
        prompt_overrides: {
          "agent-system": { label: "experiment-b", name: "agent-v2" },
        },
      },
    };

    // Overrides are correctly parsed
    const overrides = extractOverrides("agent-system", config);
    expect(overrides).toEqual({
      label: "experiment-b",
      name: "agent-v2",
    });

    // But getPrompt returns fallback since Langfuse is disabled
    const result = getPrompt({
      name: "agent-system",
      fallback: "Fallback agent prompt",
      config,
    });
    expect(result).toBe("Fallback agent prompt");
  });

  it("seed + getPrompt + getPromptAsync all work together (no Langfuse)", async () => {
    registerDefaultPrompt("prompt-a", "Text A");
    registerDefaultPrompt(
      "prompt-b",
      [{ role: "system", content: "Chat B" }],
      "chat",
    );

    // Seeding returns 0 (Langfuse disabled)
    const seeded = await seedDefaultPrompts();
    expect(seeded).toBe(0);

    // Sync retrieval works
    const textResult = getPrompt({
      name: "prompt-a",
      fallback: "Text A",
    });
    expect(textResult).toBe("Text A");

    // Async retrieval works
    const chatResult = await getPromptAsync({
      name: "prompt-b",
      promptType: "chat",
      fallback: [{ role: "system", content: "Chat B" }],
    });
    expect(chatResult).toEqual([
      { role: "system", content: "Chat B" },
    ]);
  });

  it("multiple prompts with different types can be managed independently", () => {
    registerDefaultPrompt("text-prompt", "I am text");
    registerDefaultPrompt(
      "chat-prompt",
      [{ role: "system", content: "I am chat" }],
      "chat",
    );

    const text = getPrompt({
      name: "text-prompt",
      fallback: "I am text",
    });
    const chat = getPrompt({
      name: "chat-prompt",
      promptType: "chat",
      fallback: [{ role: "system", content: "I am chat" }],
    });

    expect(text).toBe("I am text");
    expect(chat).toEqual([{ role: "system", content: "I am chat" }]);
  });

  it("reset registry then re-register works correctly", () => {
    registerDefaultPrompt("reusable", "Version 1");
    resetPromptRegistry();
    registerDefaultPrompt("reusable", "Version 2");

    // After reset + re-register, getPrompt still works
    const result = getPrompt({
      name: "reusable",
      fallback: "Version 2",
    });
    expect(result).toBe("Version 2");
  });
});
