/**
 * ReAct agent graph factory tests for the Fractal Agents Runtime — TypeScript/Bun.
 *
 * Tests the agent factory function: configuration parsing, model creation,
 * graph compilation, and invocation. Uses FakeChatModel from @langchain/core
 * so no OPENAI_API_KEY is required.
 *
 * Reference: apps/python/src/graphs/react_agent/agent.py → graph()
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { MemorySaver } from "@langchain/langgraph";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { createAgent } from "langchain";
import {
  parseGraphConfig,
  getEffectiveSystemPrompt,
  DEFAULT_MODEL_NAME,
  DEFAULT_TEMPERATURE,
  DEFAULT_MAX_TOKENS,
  DEFAULT_SYSTEM_PROMPT,
  UNEDITABLE_SYSTEM_PROMPT,
} from "../src/graphs/react-agent/configuration";
import {
  resolveGraphFactory,
  resetRegistry,
  getAvailableGraphIds,
} from "../src/graphs";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  resetRegistry();
});

// ---------------------------------------------------------------------------
// Agent factory — using createAgent directly with FakeChatModel
// ---------------------------------------------------------------------------

describe("ReAct Agent — createAgent with FakeListChatModel", () => {
  test("createAgent builds a compiled graph from FakeListChatModel", () => {
    const fakeModel = new FakeListChatModel({
      responses: ["Hello from fake model!"],
    });

    const agent = createAgent({
      model: fakeModel,
      tools: [],
      systemPrompt: "You are a test assistant.",
    });

    expect(agent).toBeDefined();
    // createAgent returns a compiled graph (Pregel instance) with invoke/stream
    expect(typeof agent.invoke).toBe("function");
    expect(typeof agent.stream).toBe("function");
  });

  test("createAgent with checkpointer accepts MemorySaver", () => {
    const fakeModel = new FakeListChatModel({
      responses: ["Checkpointed response"],
    });
    const checkpointer = new MemorySaver();

    const agent = createAgent({
      model: fakeModel,
      tools: [],
      systemPrompt: "Test with checkpointer.",
      checkpointer,
    });

    expect(agent).toBeDefined();
    expect(typeof agent.invoke).toBe("function");
  });

  test("createAgent graph can be invoked with messages", async () => {
    const fakeModel = new FakeListChatModel({
      responses: ["The answer is 42."],
    });

    const agent = createAgent({
      model: fakeModel,
      tools: [],
      systemPrompt: "You are a math assistant.",
    });

    const result = await agent.invoke({
      messages: [{ role: "user", content: "What is the meaning of life?" }],
    });

    expect(result).toBeDefined();
    expect(result.messages).toBeDefined();
    expect(Array.isArray(result.messages)).toBe(true);
    expect(result.messages.length).toBeGreaterThan(0);

    // The last message should be from the AI
    const lastMessage = result.messages[result.messages.length - 1];
    expect(lastMessage).toBeDefined();
  });

  test("createAgent with checkpointer persists thread state", async () => {
    const fakeModel = new FakeListChatModel({
      responses: [
        "Nice to meet you, Bob!",
        "Your name is Bob, as you told me earlier.",
      ],
    });
    const checkpointer = new MemorySaver();

    const agent = createAgent({
      model: fakeModel,
      tools: [],
      systemPrompt: "You are a helpful assistant. Remember the user's name.",
      checkpointer,
    });

    const threadConfig = { configurable: { thread_id: "test-thread-1" } };

    // First invocation
    const result1 = await agent.invoke(
      { messages: [{ role: "user", content: "Hi, my name is Bob." }] },
      threadConfig,
    );

    expect(result1).toBeDefined();
    expect(result1.messages.length).toBeGreaterThan(0);

    // Second invocation on the same thread should have context
    const result2 = await agent.invoke(
      { messages: [{ role: "user", content: "What is my name?" }] },
      threadConfig,
    );

    expect(result2).toBeDefined();
    // With checkpointer, messages from previous turn should be accumulated
    // The total messages should include both turns
    expect(result2.messages.length).toBeGreaterThan(result1.messages.length);
  });

  test("different thread_ids have independent state", async () => {
    const fakeModel = new FakeListChatModel({
      responses: ["Response for thread A", "Response for thread B"],
    });
    const checkpointer = new MemorySaver();

    const agent = createAgent({
      model: fakeModel,
      tools: [],
      systemPrompt: "Test independent threads.",
      checkpointer,
    });

    const resultA = await agent.invoke(
      { messages: [{ role: "user", content: "Thread A message" }] },
      { configurable: { thread_id: "thread-a" } },
    );

    const resultB = await agent.invoke(
      { messages: [{ role: "user", content: "Thread B message" }] },
      { configurable: { thread_id: "thread-b" } },
    );

    // Each thread should have its own message history
    // Thread A: 1 user + 1 AI = 2 messages (+ system if included)
    // Thread B: 1 user + 1 AI = 2 messages (+ system if included)
    // They should have the same number of messages (both single-turn)
    expect(resultA.messages.length).toBe(resultB.messages.length);
  });
});

// ---------------------------------------------------------------------------
// Agent factory — configuration integration
// ---------------------------------------------------------------------------

describe("ReAct Agent — configuration integration", () => {
  test("parseGraphConfig produces values suitable for agent construction", () => {
    const config = parseGraphConfig({
      model_name: "openai:gpt-4o-mini",
      temperature: 0.3,
      max_tokens: 1000,
      system_prompt: "You are a test bot.",
    });

    expect(config.model_name).toBe("openai:gpt-4o-mini");
    expect(config.temperature).toBe(0.3);
    expect(config.max_tokens).toBe(1000);
    expect(config.system_prompt).toBe("You are a test bot.");

    // Effective prompt includes uneditable suffix
    const effectivePrompt = getEffectiveSystemPrompt(config);
    expect(effectivePrompt).toContain("You are a test bot.");
    expect(effectivePrompt).toContain("authentication");
  });

  test("default config produces a valid effective system prompt", () => {
    const config = parseGraphConfig({});
    const effectivePrompt = getEffectiveSystemPrompt(config);

    // Must contain both the default prompt and the uneditable suffix
    expect(effectivePrompt).toContain("helpful assistant");
    expect(effectivePrompt).toContain("Markdown link");
    expect(effectivePrompt.length).toBe(
      DEFAULT_SYSTEM_PROMPT.length + UNEDITABLE_SYSTEM_PROMPT.length,
    );
  });

  test("FakeListChatModel can be used with parsed config values", async () => {
    const config = parseGraphConfig({ temperature: 0.5 });
    const effectivePrompt = getEffectiveSystemPrompt(config);

    const fakeModel = new FakeListChatModel({
      responses: ["Config test response"],
    });

    const agent = createAgent({
      model: fakeModel,
      tools: [],
      systemPrompt: effectivePrompt,
    });

    const result = await agent.invoke({
      messages: [{ role: "user", content: "Test" }],
    });

    expect(result).toBeDefined();
    expect(result.messages.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Graph registry — "agent" factory resolution
// ---------------------------------------------------------------------------

describe("ReAct Agent — graph registry integration", () => {
  test('"agent" is registered in the graph registry', () => {
    const ids = getAvailableGraphIds();
    expect(ids).toContain("agent");
  });

  test('resolveGraphFactory("agent") returns a function', () => {
    const factory = resolveGraphFactory("agent");
    expect(typeof factory).toBe("function");
  });

  test("resolved agent factory is callable (lazy-loaded)", () => {
    // The factory is lazy-loaded, so just verify it's a function
    // Actual invocation would require OPENAI_API_KEY for the real ChatOpenAI,
    // but we verify the factory is at least resolvable
    const factory = resolveGraphFactory("agent");
    expect(factory).toBeDefined();
    expect(typeof factory).toBe("function");
  });

  test("null graph_id resolves to agent factory", () => {
    const factoryNull = resolveGraphFactory(null);
    const factoryAgent = resolveGraphFactory("agent");
    expect(factoryNull).toBe(factoryAgent);
  });

  test("undefined graph_id resolves to agent factory", () => {
    const factoryUndefined = resolveGraphFactory(undefined);
    const factoryAgent = resolveGraphFactory("agent");
    expect(factoryUndefined).toBe(factoryAgent);
  });
});

// ---------------------------------------------------------------------------
// Agent invocation — streaming support
// ---------------------------------------------------------------------------

describe("ReAct Agent — streaming", () => {
  test("agent supports stream() method", async () => {
    const fakeModel = new FakeListChatModel({
      responses: ["Streamed response"],
    });

    const agent = createAgent({
      model: fakeModel,
      tools: [],
      systemPrompt: "Stream test.",
    });

    expect(typeof agent.stream).toBe("function");

    // Verify we can start a stream
    const stream = await agent.stream({
      messages: [{ role: "user", content: "Hello" }],
    });

    expect(stream).toBeDefined();

    // Consume at least one chunk from the stream
    let chunkCount = 0;
    for await (const _chunk of stream) {
      chunkCount++;
    }
    expect(chunkCount).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Agent — empty tools list (v0.0.1 baseline)
// ---------------------------------------------------------------------------

describe("ReAct Agent — no tools (v0.0.1)", () => {
  test("agent works with empty tools array", async () => {
    const fakeModel = new FakeListChatModel({
      responses: ["I have no tools available."],
    });

    const agent = createAgent({
      model: fakeModel,
      tools: [],
      systemPrompt: DEFAULT_SYSTEM_PROMPT + UNEDITABLE_SYSTEM_PROMPT,
    });

    const result = await agent.invoke({
      messages: [
        { role: "user", content: "Can you search the web for me?" },
      ],
    });

    expect(result).toBeDefined();
    expect(result.messages).toBeDefined();
    expect(result.messages.length).toBeGreaterThan(0);
  });

  test("agent with full default config and no tools completes normally", async () => {
    const config = parseGraphConfig({});
    const effectivePrompt = getEffectiveSystemPrompt(config);

    const fakeModel = new FakeListChatModel({
      responses: ["Default config response"],
    });

    const agent = createAgent({
      model: fakeModel,
      tools: [],
      systemPrompt: effectivePrompt,
      checkpointer: new MemorySaver(),
    });

    const result = await agent.invoke(
      { messages: [{ role: "user", content: "Hello!" }] },
      { configurable: { thread_id: "default-config-test" } },
    );

    expect(result).toBeDefined();
    expect(result.messages.length).toBeGreaterThanOrEqual(2); // at least user + AI
  });
});
