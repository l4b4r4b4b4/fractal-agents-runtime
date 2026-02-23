/**
 * Research Agent tests for the Fractal Agents Runtime — TypeScript/Bun.
 *
 * Tests cover:
 *   - Configuration parsing (parseResearchConfig)
 *   - Prompt registration and names (Langfuse parity with Python)
 *   - Worker output extraction (extractWorkerOutput, internal helpers)
 *   - Graph-level JSON parsing (parseAnalyzerResponse, parseAggregatorResponse)
 *   - Graph registry integration (research_agent is registered)
 *   - Graph factory smoke test (buildResearchGraph with mocked model)
 *
 * Reference: apps/python/src/graphs/research_agent/ (all modules)
 */

import { describe, test, expect, beforeEach } from "bun:test";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

import {
  parseResearchConfig,
  DEFAULT_MODEL_NAME,
  DEFAULT_TEMPERATURE,
  DEFAULT_MAX_WORKER_ITERATIONS,
  type ResearchAgentConfig,
} from "../src/graphs/research-agent/configuration";

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

import {
  PROMPT_NAMES,
  ANALYZER_PHASE1_PROMPT,
  ANALYZER_PHASE2_PROMPT,
  WORKER_PHASE1_PROMPT,
  WORKER_PHASE2_PROMPT,
  AGGREGATOR_PHASE1_PROMPT,
  AGGREGATOR_PHASE2_PROMPT,
} from "../src/graphs/research-agent/prompts";

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

import {
  extractWorkerOutput,
  _internals,
  type ResearchResult,
  type WorkerOutput,
  type TaskDict,
} from "../src/graphs/research-agent/worker";

// ---------------------------------------------------------------------------
// Graph-level parsing helpers
// ---------------------------------------------------------------------------

import {
  parseAnalyzerResponse,
  parseAggregatorResponse,
  extractContent,
  tryParseJson,
  normaliseTasks,
} from "../src/graphs/research-agent/agent";

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

import {
  resolveGraphFactory,
  getAvailableGraphIds,
  isGraphRegistered,
  resetRegistry,
} from "../src/graphs";

// ===================================================================
// Configuration — parseResearchConfig
// ===================================================================

describe("ResearchAgentConfig — parseResearchConfig", () => {
  test("returns defaults for null input", () => {
    const config = parseResearchConfig(null);
    expect(config.modelName).toBe(DEFAULT_MODEL_NAME);
    expect(config.temperature).toBe(DEFAULT_TEMPERATURE);
    expect(config.maxTokens).toBeNull();
    expect(config.baseUrl).toBeNull();
    expect(config.customModelName).toBeNull();
    expect(config.customApiKey).toBeNull();
    expect(config.systemPrompt).toBeNull();
    expect(config.mcpConfig).toBeNull();
    expect(config.rag).toBeNull();
    expect(config.maxWorkerIterations).toBe(DEFAULT_MAX_WORKER_ITERATIONS);
    expect(config.autoApprovePhase1).toBe(false);
    expect(config.autoApprovePhase2).toBe(false);
  });

  test("returns defaults for undefined input", () => {
    const config = parseResearchConfig(undefined);
    expect(config.modelName).toBe(DEFAULT_MODEL_NAME);
    expect(config.maxWorkerIterations).toBe(DEFAULT_MAX_WORKER_ITERATIONS);
  });

  test("returns defaults for empty object", () => {
    const config = parseResearchConfig({});
    expect(config.modelName).toBe(DEFAULT_MODEL_NAME);
    expect(config.maxWorkerIterations).toBe(DEFAULT_MAX_WORKER_ITERATIONS);
    expect(config.autoApprovePhase1).toBe(false);
    expect(config.autoApprovePhase2).toBe(false);
  });

  test("parses model_name (snake_case)", () => {
    const config = parseResearchConfig({ model_name: "anthropic:claude-sonnet-4-0" });
    expect(config.modelName).toBe("anthropic:claude-sonnet-4-0");
  });

  test("parses modelName (camelCase)", () => {
    const config = parseResearchConfig({ modelName: "openai:gpt-4o" });
    expect(config.modelName).toBe("openai:gpt-4o");
  });

  test("snake_case model_name takes priority over camelCase", () => {
    const config = parseResearchConfig({
      model_name: "snake-model",
      modelName: "camel-model",
    });
    expect(config.modelName).toBe("snake-model");
  });

  test("parses temperature", () => {
    const config = parseResearchConfig({ temperature: 0.7 });
    expect(config.temperature).toBe(0.7);
  });

  test("ignores non-finite temperature", () => {
    const config = parseResearchConfig({ temperature: NaN });
    expect(config.temperature).toBe(DEFAULT_TEMPERATURE);
  });

  test("parses max_tokens", () => {
    const config = parseResearchConfig({ max_tokens: 4096 });
    expect(config.maxTokens).toBe(4096);
  });

  test("parses maxTokens (camelCase)", () => {
    const config = parseResearchConfig({ maxTokens: 2048 });
    expect(config.maxTokens).toBe(2048);
  });

  test("parses base_url", () => {
    const config = parseResearchConfig({ base_url: "http://localhost:8000/v1" });
    expect(config.baseUrl).toBe("http://localhost:8000/v1");
  });

  test("parses baseUrl (camelCase)", () => {
    const config = parseResearchConfig({ baseUrl: "http://localhost:7374/v1" });
    expect(config.baseUrl).toBe("http://localhost:7374/v1");
  });

  test("ignores empty base_url", () => {
    const config = parseResearchConfig({ base_url: "" });
    expect(config.baseUrl).toBeNull();
  });

  test("parses custom_model_name", () => {
    const config = parseResearchConfig({ custom_model_name: "my-model" });
    expect(config.customModelName).toBe("my-model");
  });

  test("parses custom_api_key", () => {
    const config = parseResearchConfig({ custom_api_key: "sk-test" });
    expect(config.customApiKey).toBe("sk-test");
  });

  test("parses system_prompt", () => {
    const config = parseResearchConfig({ system_prompt: "You are a helper." });
    expect(config.systemPrompt).toBe("You are a helper.");
  });

  test("ignores empty system_prompt", () => {
    const config = parseResearchConfig({ system_prompt: "" });
    expect(config.systemPrompt).toBeNull();
  });

  // Research-agent-specific fields

  test("parses max_worker_iterations (snake_case)", () => {
    const config = parseResearchConfig({ max_worker_iterations: 25 });
    expect(config.maxWorkerIterations).toBe(25);
  });

  test("parses maxWorkerIterations (camelCase)", () => {
    const config = parseResearchConfig({ maxWorkerIterations: 30 });
    expect(config.maxWorkerIterations).toBe(30);
  });

  test("clamps max_worker_iterations to minimum 1", () => {
    const config = parseResearchConfig({ max_worker_iterations: -5 });
    expect(config.maxWorkerIterations).toBe(1);
  });

  test("clamps max_worker_iterations to maximum 100", () => {
    const config = parseResearchConfig({ max_worker_iterations: 999 });
    expect(config.maxWorkerIterations).toBe(100);
  });

  test("rounds max_worker_iterations to integer", () => {
    const config = parseResearchConfig({ max_worker_iterations: 7.8 });
    expect(config.maxWorkerIterations).toBe(8);
  });

  test("ignores non-number max_worker_iterations", () => {
    const config = parseResearchConfig({ max_worker_iterations: "ten" });
    expect(config.maxWorkerIterations).toBe(DEFAULT_MAX_WORKER_ITERATIONS);
  });

  test("parses auto_approve_phase1 true", () => {
    const config = parseResearchConfig({ auto_approve_phase1: true });
    expect(config.autoApprovePhase1).toBe(true);
  });

  test("parses autoApprovePhase1 (camelCase)", () => {
    const config = parseResearchConfig({ autoApprovePhase1: true });
    expect(config.autoApprovePhase1).toBe(true);
  });

  test("parses auto_approve_phase2 true", () => {
    const config = parseResearchConfig({ auto_approve_phase2: true });
    expect(config.autoApprovePhase2).toBe(true);
  });

  test("auto_approve defaults to false for falsy values", () => {
    const config = parseResearchConfig({
      auto_approve_phase1: 0,
      auto_approve_phase2: "",
    });
    expect(config.autoApprovePhase1).toBe(false);
    expect(config.autoApprovePhase2).toBe(false);
  });

  // MCP config parsing

  test("parses multi-server MCP config", () => {
    const config = parseResearchConfig({
      mcp_config: {
        servers: [
          { name: "server1", url: "http://s1:8080", auth_required: true },
          { name: "server2", url: "http://s2:9090", auth_required: false, tools: ["tool1"] },
        ],
      },
    });
    expect(config.mcpConfig).not.toBeNull();
    expect(config.mcpConfig!.servers).toHaveLength(2);
    expect(config.mcpConfig!.servers[0].name).toBe("server1");
    expect(config.mcpConfig!.servers[0].url).toBe("http://s1:8080");
    expect(config.mcpConfig!.servers[0].authRequired).toBe(true);
    expect(config.mcpConfig!.servers[0].tools).toBeNull();
    expect(config.mcpConfig!.servers[1].tools).toEqual(["tool1"]);
  });

  test("parses legacy single-server MCP config", () => {
    const config = parseResearchConfig({
      mcp_config: { url: "http://mcp:8080", auth_required: true },
    });
    expect(config.mcpConfig).not.toBeNull();
    expect(config.mcpConfig!.servers).toHaveLength(1);
    expect(config.mcpConfig!.servers[0].url).toBe("http://mcp:8080");
    expect(config.mcpConfig!.servers[0].authRequired).toBe(true);
  });

  test("returns null MCP config for empty servers array", () => {
    const config = parseResearchConfig({
      mcp_config: { servers: [] },
    });
    expect(config.mcpConfig).toBeNull();
  });

  test("returns null MCP config for null input", () => {
    const config = parseResearchConfig({ mcp_config: null });
    expect(config.mcpConfig).toBeNull();
  });

  // RAG config parsing

  test("parses RAG config with rag_url and collections", () => {
    const config = parseResearchConfig({
      rag: {
        rag_url: "http://rag:8080",
        collections: ["col1", "col2"],
      },
    });
    expect(config.rag).not.toBeNull();
    expect(config.rag!.ragUrl).toBe("http://rag:8080");
    expect(config.rag!.collections).toEqual(["col1", "col2"]);
  });

  test("parses RAG config with ragUrl (camelCase)", () => {
    const config = parseResearchConfig({
      rag: { ragUrl: "http://rag:9090", collections: ["c1"] },
    });
    expect(config.rag).not.toBeNull();
    expect(config.rag!.ragUrl).toBe("http://rag:9090");
  });

  test("returns null RAG config for empty rag object", () => {
    const config = parseResearchConfig({ rag: {} });
    expect(config.rag).toBeNull();
  });

  test("returns null RAG config for null input", () => {
    const config = parseResearchConfig({ rag: null });
    expect(config.rag).toBeNull();
  });

  test("filters non-string collections", () => {
    const config = parseResearchConfig({
      rag: { rag_url: "http://r:80", collections: ["valid", 42, null, "also-valid"] },
    });
    expect(config.rag).not.toBeNull();
    expect(config.rag!.collections).toEqual(["valid", "also-valid"]);
  });

  // Full config round-trip

  test("parses a complete configurable dict", () => {
    const config = parseResearchConfig({
      model_name: "openai:gpt-4o",
      temperature: 0.3,
      max_tokens: 8192,
      base_url: "http://vllm:7374/v1",
      custom_model_name: "custom-gpt",
      custom_api_key: "sk-custom",
      system_prompt: "Be thorough.",
      mcp_config: { servers: [{ name: "s", url: "http://s:80", auth_required: false }] },
      rag: { rag_url: "http://rag:80", collections: ["docs"] },
      max_worker_iterations: 20,
      auto_approve_phase1: true,
      auto_approve_phase2: false,
    });

    expect(config.modelName).toBe("openai:gpt-4o");
    expect(config.temperature).toBe(0.3);
    expect(config.maxTokens).toBe(8192);
    expect(config.baseUrl).toBe("http://vllm:7374/v1");
    expect(config.customModelName).toBe("custom-gpt");
    expect(config.customApiKey).toBe("sk-custom");
    expect(config.systemPrompt).toBe("Be thorough.");
    expect(config.mcpConfig!.servers).toHaveLength(1);
    expect(config.rag!.collections).toEqual(["docs"]);
    expect(config.maxWorkerIterations).toBe(20);
    expect(config.autoApprovePhase1).toBe(true);
    expect(config.autoApprovePhase2).toBe(false);
  });

  test("ignores unknown keys", () => {
    const config = parseResearchConfig({
      unknown_key: "ignored",
      model_name: "openai:gpt-4o",
      deeply_nested_nonsense: { foo: { bar: 42 } },
    });
    expect(config.modelName).toBe("openai:gpt-4o");
    // Should not throw or include unknown keys
    expect((config as Record<string, unknown>).unknown_key).toBeUndefined();
  });
});

// ===================================================================
// Configuration — default constants
// ===================================================================

describe("ResearchAgentConfig — default constants", () => {
  test("DEFAULT_MODEL_NAME is openai:gpt-4o-mini", () => {
    expect(DEFAULT_MODEL_NAME).toBe("openai:gpt-4o-mini");
  });

  test("DEFAULT_TEMPERATURE is 0.0", () => {
    expect(DEFAULT_TEMPERATURE).toBe(0.0);
  });

  test("DEFAULT_MAX_WORKER_ITERATIONS is 15", () => {
    expect(DEFAULT_MAX_WORKER_ITERATIONS).toBe(15);
  });
});

// ===================================================================
// Prompts — registration and naming parity with Python
// ===================================================================

describe("Research Agent Prompts", () => {
  test("PROMPT_NAMES has exactly 6 entries", () => {
    expect(PROMPT_NAMES).toHaveLength(6);
  });

  test("prompt names match Python runtime exactly", () => {
    // These names MUST be identical to Python's _PROMPT_REGISTRY in
    // apps/python/src/graphs/research_agent/prompts.py
    const expectedNames = [
      "research-agent-analyzer-phase1",
      "research-agent-analyzer-phase2",
      "research-agent-worker-phase1",
      "research-agent-worker-phase2",
      "research-agent-aggregator-phase1",
      "research-agent-aggregator-phase2",
    ];
    expect(PROMPT_NAMES).toEqual(expectedNames);
  });

  test("ANALYZER_PHASE1_PROMPT contains JSON schema instruction", () => {
    expect(ANALYZER_PHASE1_PROMPT).toContain("task_id");
    expect(ANALYZER_PHASE1_PROMPT).toContain("search_focus");
    expect(ANALYZER_PHASE1_PROMPT).toContain("description");
  });

  test("ANALYZER_PHASE1_PROMPT contains review_feedback variable", () => {
    expect(ANALYZER_PHASE1_PROMPT).toContain("{{review_feedback}}");
  });

  test("ANALYZER_PHASE2_PROMPT contains phase1_results variable", () => {
    expect(ANALYZER_PHASE2_PROMPT).toContain("{{phase1_results}}");
    expect(ANALYZER_PHASE2_PROMPT).toContain("{{review_feedback}}");
  });

  test("WORKER_PHASE1_PROMPT mentions tool usage", () => {
    expect(WORKER_PHASE1_PROMPT).toContain("tools");
    expect(WORKER_PHASE1_PROMPT).toContain("source_url");
  });

  test("WORKER_PHASE2_PROMPT focuses on validation", () => {
    expect(WORKER_PHASE2_PROMPT).toContain("validat");
    expect(WORKER_PHASE2_PROMPT).toContain("verify");
  });

  test("AGGREGATOR_PHASE1_PROMPT contains template variables", () => {
    expect(AGGREGATOR_PHASE1_PROMPT).toContain("{{user_input}}");
    expect(AGGREGATOR_PHASE1_PROMPT).toContain("{{worker_results}}");
  });

  test("AGGREGATOR_PHASE2_PROMPT contains all template variables", () => {
    expect(AGGREGATOR_PHASE2_PROMPT).toContain("{{user_input}}");
    expect(AGGREGATOR_PHASE2_PROMPT).toContain("{{phase1_results}}");
    expect(AGGREGATOR_PHASE2_PROMPT).toContain("{{worker_results}}");
  });

  test("all prompts are non-empty strings", () => {
    const prompts = [
      ANALYZER_PHASE1_PROMPT,
      ANALYZER_PHASE2_PROMPT,
      WORKER_PHASE1_PROMPT,
      WORKER_PHASE2_PROMPT,
      AGGREGATOR_PHASE1_PROMPT,
      AGGREGATOR_PHASE2_PROMPT,
    ];
    for (const prompt of prompts) {
      expect(typeof prompt).toBe("string");
      expect(prompt.length).toBeGreaterThan(50);
    }
  });
});

// ===================================================================
// Worker — extractWorkerOutput
// ===================================================================

describe("extractWorkerOutput", () => {
  test("extracts JSON array from last AI message", () => {
    const result = extractWorkerOutput({
      messages: [
        { role: "user", content: "Search for X" },
        {
          role: "assistant",
          type: "ai",
          content: JSON.stringify([
            {
              title: "Finding 1",
              summary: "Summary of finding 1",
              source_url: "https://example.com",
              relevance_score: 0.9,
              metadata: {},
            },
          ]),
        },
      ],
    });

    expect(result.results).toHaveLength(1);
    expect(result.results[0].title).toBe("Finding 1");
    expect(result.results[0].summary).toBe("Summary of finding 1");
    expect(result.results[0].sourceUrl).toBe("https://example.com");
    expect(result.results[0].relevanceScore).toBe(0.9);
  });

  test("extracts JSON from code block", () => {
    const jsonContent = JSON.stringify([
      { title: "T", summary: "S", source_url: null, relevance_score: 0.5 },
    ]);
    const result = extractWorkerOutput({
      messages: [
        {
          type: "ai",
          content: `Here are my findings:\n\n\`\`\`json\n${jsonContent}\n\`\`\``,
        },
      ],
    });

    expect(result.results).toHaveLength(1);
    expect(result.results[0].title).toBe("T");
  });

  test("extracts from { results: [...] } wrapper", () => {
    const result = extractWorkerOutput({
      messages: [
        {
          type: "ai",
          content: JSON.stringify({
            results: [
              { title: "R1", summary: "S1" },
              { title: "R2", summary: "S2" },
            ],
          }),
        },
      ],
    });

    expect(result.results).toHaveLength(2);
    expect(result.results[0].title).toBe("R1");
    expect(result.results[1].title).toBe("R2");
  });

  test("falls back to plain text when JSON extraction fails", () => {
    const result = extractWorkerOutput(
      {
        messages: [
          { type: "ai", content: "I found some interesting things about logistics." },
        ],
      },
      { description: "Research logistics", task_id: "t1" },
    );

    expect(result.results).toHaveLength(1);
    expect(result.results[0].title).toBe("Research logistics");
    expect(result.results[0].summary).toContain("interesting things about logistics");
    expect(result.results[0].metadata.extraction_method).toBe("plain_text_fallback");
  });

  test("returns fallback for empty messages array", () => {
    const result = extractWorkerOutput({ messages: [] });
    expect(result.results).toHaveLength(1);
    expect(result.results[0].summary).toContain("No output from worker");
  });

  test("returns fallback when messages is missing", () => {
    const result = extractWorkerOutput({});
    expect(result.results).toHaveLength(1);
  });

  test("uses task search_focus for fallback title", () => {
    const result = extractWorkerOutput(
      { messages: [{ type: "ai", content: "No structured data." }] },
      { search_focus: "Find logistics parks in Munich" },
    );
    expect(result.results[0].title).toBe("Find logistics parks in Munich");
  });

  test("truncates very long fallback summaries to 2000 chars", () => {
    const longContent = "A".repeat(5000);
    const result = extractWorkerOutput({
      messages: [{ type: "ai", content: longContent }],
    });
    expect(result.results[0].summary.length).toBeLessThanOrEqual(2000);
  });

  test("handles multimodal content (list of blocks)", () => {
    const result = extractWorkerOutput({
      messages: [
        {
          type: "ai",
          content: [
            { type: "text", text: JSON.stringify([{ title: "Multi", summary: "Modal" }]) },
          ],
        },
      ],
    });

    expect(result.results).toHaveLength(1);
    expect(result.results[0].title).toBe("Multi");
  });

  test("handles single result object (not array)", () => {
    const result = extractWorkerOutput({
      messages: [
        {
          type: "ai",
          content: JSON.stringify({
            title: "Single",
            summary: "Just one result",
            source_url: "https://single.com",
          }),
        },
      ],
    });

    expect(result.results).toHaveLength(1);
    expect(result.results[0].title).toBe("Single");
    expect(result.results[0].sourceUrl).toBe("https://single.com");
  });

  test("normalises missing fields with defaults", () => {
    const result = extractWorkerOutput({
      messages: [
        {
          type: "ai",
          content: JSON.stringify([{ foo: "bar" }]),
        },
      ],
    });

    expect(result.results).toHaveLength(1);
    expect(result.results[0].title).toBe("Untitled");
    expect(result.results[0].summary).toBe("");
    expect(result.results[0].sourceUrl).toBeNull();
    expect(result.results[0].relevanceScore).toBeNull();
  });

  test("handles description field as summary fallback", () => {
    const result = extractWorkerOutput({
      messages: [
        {
          type: "ai",
          content: JSON.stringify([{ title: "T", description: "Using description" }]),
        },
      ],
    });

    expect(result.results[0].summary).toBe("Using description");
  });

  test("handles url field as sourceUrl fallback", () => {
    const result = extractWorkerOutput({
      messages: [
        {
          type: "ai",
          content: JSON.stringify([{ title: "T", summary: "S", url: "https://alt.com" }]),
        },
      ],
    });

    expect(result.results[0].sourceUrl).toBe("https://alt.com");
  });

  test("handles score field as relevanceScore fallback", () => {
    const result = extractWorkerOutput({
      messages: [
        {
          type: "ai",
          content: JSON.stringify([{ title: "T", summary: "S", score: 0.75 }]),
        },
      ],
    });

    expect(result.results[0].relevanceScore).toBe(0.75);
  });
});

// ===================================================================
// Worker — internal helpers
// ===================================================================

describe("Worker internals — getMessageContent", () => {
  const { getMessageContent } = _internals;

  test("extracts string content from dict-style message", () => {
    expect(getMessageContent({ content: "Hello" })).toBe("Hello");
  });

  test("returns null for empty string content", () => {
    expect(getMessageContent({ content: "" })).toBeNull();
  });

  test("returns null for whitespace-only content", () => {
    expect(getMessageContent({ content: "   " })).toBeNull();
  });

  test("returns null for null input", () => {
    expect(getMessageContent(null)).toBeNull();
  });

  test("returns null for undefined input", () => {
    expect(getMessageContent(undefined)).toBeNull();
  });

  test("extracts text from multimodal blocks", () => {
    const message = {
      content: [
        "plain text",
        { type: "text", text: "block text" },
        { type: "image", url: "ignore" },
      ],
    };
    const result = getMessageContent(message);
    expect(result).toContain("plain text");
    expect(result).toContain("block text");
  });

  test("returns null for empty multimodal content", () => {
    expect(getMessageContent({ content: [] })).toBeNull();
  });
});

describe("Worker internals — isAiMessage", () => {
  const { isAiMessage } = _internals;

  test("detects role=assistant", () => {
    expect(isAiMessage({ role: "assistant", content: "Hi" })).toBe(true);
  });

  test("detects role=ai", () => {
    expect(isAiMessage({ role: "ai", content: "Hi" })).toBe(true);
  });

  test("detects type=ai", () => {
    expect(isAiMessage({ type: "ai", content: "Hi" })).toBe(true);
  });

  test("detects type=AIMessage", () => {
    expect(isAiMessage({ type: "AIMessage", content: "Hi" })).toBe(true);
  });

  test("rejects role=user", () => {
    expect(isAiMessage({ role: "user", content: "Hi" })).toBe(false);
  });

  test("rejects type=human", () => {
    expect(isAiMessage({ type: "human", content: "Hi" })).toBe(false);
  });

  test("rejects null", () => {
    expect(isAiMessage(null)).toBe(false);
  });

  test("rejects undefined", () => {
    expect(isAiMessage(undefined)).toBe(false);
  });

  test("rejects number", () => {
    expect(isAiMessage(42)).toBe(false);
  });
});

describe("Worker internals — safeFloat", () => {
  const { safeFloat } = _internals;

  test("converts number to float", () => {
    expect(safeFloat(0.85)).toBe(0.85);
  });

  test("converts string number to float", () => {
    expect(safeFloat("0.75")).toBe(0.75);
  });

  test("returns null for null", () => {
    expect(safeFloat(null)).toBeNull();
  });

  test("returns null for undefined", () => {
    expect(safeFloat(undefined)).toBeNull();
  });

  test("returns null for non-numeric string", () => {
    expect(safeFloat("not-a-number")).toBeNull();
  });

  test("returns null for NaN", () => {
    expect(safeFloat(NaN)).toBeNull();
  });

  test("returns null for Infinity", () => {
    expect(safeFloat(Infinity)).toBeNull();
  });
});

describe("Worker internals — normaliseResultList", () => {
  const { normaliseResultList } = _internals;

  test("normalises well-formed results", () => {
    const results = normaliseResultList([
      { title: "T1", summary: "S1", source_url: "http://x.com", relevance_score: 0.9 },
    ]);
    expect(results).toHaveLength(1);
    expect(results![0].title).toBe("T1");
    expect(results![0].sourceUrl).toBe("http://x.com");
  });

  test("returns null for empty array", () => {
    expect(normaliseResultList([])).toBeNull();
  });

  test("skips non-object items", () => {
    const results = normaliseResultList(["string", 42, null, { title: "Valid" }]);
    expect(results).toHaveLength(1);
    expect(results![0].title).toBe("Valid");
  });

  test("defaults missing title to 'Untitled'", () => {
    const results = normaliseResultList([{ summary: "Just a summary" }]);
    expect(results![0].title).toBe("Untitled");
  });

  test("returns null when all items are non-objects", () => {
    expect(normaliseResultList(["a", "b", 42])).toBeNull();
  });
});

// ===================================================================
// Graph-level — extractContent
// ===================================================================

describe("Graph parsing — extractContent", () => {
  test("returns string input directly", () => {
    expect(extractContent("hello")).toBe("hello");
  });

  test("extracts .content from message object", () => {
    expect(extractContent({ content: "from object" })).toBe("from object");
  });

  test("joins list content", () => {
    const message = {
      content: ["part1", { type: "text", text: "part2" }],
    };
    const result = extractContent(message);
    expect(result).toContain("part1");
    expect(result).toContain("part2");
  });

  test("stringifies non-message objects", () => {
    const result = extractContent(42);
    expect(result).toBe("42");
  });
});

// ===================================================================
// Graph-level — tryParseJson
// ===================================================================

describe("Graph parsing — tryParseJson", () => {
  test("parses valid JSON object", () => {
    const result = tryParseJson('{"key": "value"}');
    expect(result).toEqual({ key: "value" });
  });

  test("parses valid JSON array", () => {
    const result = tryParseJson('[1, 2, 3]');
    expect(result).toEqual([1, 2, 3]);
  });

  test("returns null for empty string", () => {
    expect(tryParseJson("")).toBeNull();
  });

  test("returns null for plain text", () => {
    expect(tryParseJson("This is not JSON")).toBeNull();
  });

  test("extracts JSON from code block", () => {
    const text = 'Some text\n```json\n{"tasks": []}\n```\nMore text';
    const result = tryParseJson(text);
    expect(result).toEqual({ tasks: [] });
  });

  test("extracts JSON object embedded in text", () => {
    const text = 'Here is the result: {"key": "value"} and more text';
    const result = tryParseJson(text);
    expect(result).toEqual({ key: "value" });
  });
});

// ===================================================================
// Graph-level — normaliseTasks
// ===================================================================

describe("Graph parsing — normaliseTasks", () => {
  test("normalises well-formed tasks", () => {
    const tasks = normaliseTasks([
      { task_id: "t1", description: "Do X", search_focus: "X query" },
    ]);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].task_id).toBe("t1");
    expect(tasks[0].description).toBe("Do X");
    expect(tasks[0].search_focus).toBe("X query");
    expect(tasks[0].constraints).toEqual({});
  });

  test("generates task_id if missing", () => {
    const tasks = normaliseTasks([
      { description: "First" },
      { description: "Second" },
    ]);
    expect(tasks[0].task_id).toBe("task-1");
    expect(tasks[1].task_id).toBe("task-2");
  });

  test("uses description as search_focus fallback", () => {
    const tasks = normaliseTasks([{ description: "Research topic" }]);
    expect(tasks[0].search_focus).toBe("Research topic");
  });

  test("preserves constraints", () => {
    const tasks = normaliseTasks([
      { task_id: "t1", description: "D", constraints: { region: "Munich" } },
    ]);
    expect(tasks[0].constraints).toEqual({ region: "Munich" });
  });

  test("returns fallback task for empty array", () => {
    const tasks = normaliseTasks([]);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].task_id).toBe("task-fallback");
  });

  test("skips non-object items", () => {
    const tasks = normaliseTasks(["string", null, { task_id: "t1", description: "OK" }]);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].task_id).toBe("t1");
  });

  test("returns fallback when all items are non-objects", () => {
    const tasks = normaliseTasks([42, "hello", null]);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].task_id).toBe("task-fallback");
  });
});

// ===================================================================
// Graph-level — parseAnalyzerResponse
// ===================================================================

describe("Graph parsing — parseAnalyzerResponse", () => {
  test("parses { tasks: [...] } response", () => {
    const response = {
      content: JSON.stringify({
        reasoning: "Split by topic",
        tasks: [
          { task_id: "t1", description: "D1", search_focus: "Q1" },
          { task_id: "t2", description: "D2", search_focus: "Q2" },
        ],
      }),
    };
    const tasks = parseAnalyzerResponse(response);
    expect(tasks).toHaveLength(2);
    expect(tasks[0].task_id).toBe("t1");
    expect(tasks[1].task_id).toBe("t2");
  });

  test("parses bare array response", () => {
    const response = {
      content: JSON.stringify([
        { task_id: "a", description: "DA", search_focus: "QA" },
      ]),
    };
    const tasks = parseAnalyzerResponse(response);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].task_id).toBe("a");
  });

  test("parses JSON from code block in response", () => {
    const json = JSON.stringify({
      tasks: [{ task_id: "cb", description: "Code block", search_focus: "CB" }],
    });
    const response = {
      content: `Here are the tasks:\n\`\`\`json\n${json}\n\`\`\``,
    };
    const tasks = parseAnalyzerResponse(response);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].task_id).toBe("cb");
  });

  test("creates fallback task for non-JSON response", () => {
    const response = { content: "I think we should research logistics." };
    const tasks = parseAnalyzerResponse(response);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].task_id).toBe("task-fallback");
    expect(tasks[0].description).toContain("logistics");
  });

  test("creates fallback task for empty content", () => {
    const tasks = parseAnalyzerResponse({ content: "" });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].task_id).toBe("task-fallback");
    expect(tasks[0].description).toBe("General research");
  });

  test("handles string response directly", () => {
    const tasks = parseAnalyzerResponse(
      JSON.stringify({
        tasks: [{ task_id: "str", description: "String", search_focus: "S" }],
      }),
    );
    expect(tasks).toHaveLength(1);
    expect(tasks[0].task_id).toBe("str");
  });
});

// ===================================================================
// Graph-level — parseAggregatorResponse
// ===================================================================

describe("Graph parsing — parseAggregatorResponse", () => {
  test("parses { results: [...], summary: ... } response", () => {
    const response = {
      content: JSON.stringify({
        summary: "Comprehensive findings",
        total_sources_reviewed: 15,
        results: [
          { title: "R1", summary: "S1", source_url: "http://r1.com", relevance_score: 0.95 },
          { title: "R2", summary: "S2" },
        ],
      }),
    };
    const aggregated = parseAggregatorResponse(response, []);
    expect(aggregated.results).toHaveLength(2);
    expect(aggregated.summary).toBe("Comprehensive findings");
    expect(aggregated.total_sources_reviewed).toBe(15);
  });

  test("falls back to flattening worker results on non-JSON response", () => {
    const workerResults = [
      { results: [{ title: "W1" }, { title: "W2" }] },
      { results: [{ title: "W3" }] },
    ];
    const aggregated = parseAggregatorResponse(
      { content: "Could not produce JSON." },
      workerResults,
    );
    expect((aggregated.results as unknown[]).length).toBe(3);
  });

  test("falls back when results array is empty", () => {
    const response = {
      content: JSON.stringify({ summary: "Empty", results: [] }),
    };
    const workerResults = [{ results: [{ title: "Fallback" }] }];
    const aggregated = parseAggregatorResponse(response, workerResults);
    // Empty results → fallback to flattening
    expect((aggregated.results as unknown[]).length).toBe(1);
  });

  test("handles empty worker results in fallback", () => {
    const aggregated = parseAggregatorResponse(
      { content: "Not JSON" },
      [],
    );
    expect((aggregated.results as unknown[]).length).toBe(0);
    expect(typeof aggregated.summary).toBe("string");
  });

  test("parses JSON from code block", () => {
    const json = JSON.stringify({
      summary: "From code block",
      results: [{ title: "CB1", summary: "S" }],
    });
    const response = {
      content: `Results:\n\`\`\`json\n${json}\n\`\`\``,
    };
    const aggregated = parseAggregatorResponse(response, []);
    expect((aggregated.results as unknown[]).length).toBe(1);
    expect(aggregated.summary).toBe("From code block");
  });
});

// ===================================================================
// Graph registry integration
// ===================================================================

describe("Research Agent — Registry integration", () => {
  beforeEach(() => {
    resetRegistry();
  });

  test('"research_agent" is registered as a built-in graph', () => {
    expect(isGraphRegistered("research_agent")).toBe(true);
  });

  test("getAvailableGraphIds includes research_agent", () => {
    const ids = getAvailableGraphIds();
    expect(ids).toContain("research_agent");
  });

  test("resolveGraphFactory resolves research_agent to a factory", () => {
    const factory = resolveGraphFactory("research_agent");
    expect(typeof factory).toBe("function");
  });

  test("research_agent factory is different from agent factory", () => {
    const agentFactory = resolveGraphFactory("agent");
    const researchFactory = resolveGraphFactory("research_agent");
    // They should be different lazy-loaded factories
    expect(agentFactory).not.toBe(researchFactory);
  });

  test("available graph IDs are sorted", () => {
    const ids = getAvailableGraphIds();
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
  });

  test("resetRegistry preserves research_agent registration", () => {
    expect(isGraphRegistered("research_agent")).toBe(true);
    resetRegistry();
    expect(isGraphRegistered("research_agent")).toBe(true);
  });
});

// ===================================================================
// Index re-exports
// ===================================================================

describe("Research Agent — index exports", () => {
  test("exports graph factory", async () => {
    const { graph } = await import("../src/graphs/research-agent");
    expect(typeof graph).toBe("function");
  });

  test("exports parseResearchConfig", async () => {
    const mod = await import("../src/graphs/research-agent");
    expect(typeof mod.parseResearchConfig).toBe("function");
  });

  test("exports PROMPT_NAMES", async () => {
    const mod = await import("../src/graphs/research-agent");
    expect(Array.isArray(mod.PROMPT_NAMES)).toBe(true);
    expect(mod.PROMPT_NAMES.length).toBe(6);
  });

  test("exports extractWorkerOutput", async () => {
    const mod = await import("../src/graphs/research-agent");
    expect(typeof mod.extractWorkerOutput).toBe("function");
  });

  test("exports configuration constants", async () => {
    const mod = await import("../src/graphs/research-agent");
    expect(typeof mod.DEFAULT_MODEL_NAME).toBe("string");
    expect(typeof mod.DEFAULT_TEMPERATURE).toBe("number");
    expect(typeof mod.DEFAULT_MAX_WORKER_ITERATIONS).toBe("number");
  });
});

// ===================================================================
// Prompt name parity cross-check
// ===================================================================

describe("Research Agent — Python parity", () => {
  test("graph_id is 'research_agent' (matches Python registry)", () => {
    // Python registers: register_graph("research_agent", ...)
    expect(isGraphRegistered("research_agent")).toBe(true);
  });

  test("all 6 Langfuse prompt names match Python exactly", () => {
    // These are from apps/python/src/graphs/research_agent/prompts.py
    const pythonPromptNames = [
      "research-agent-analyzer-phase1",
      "research-agent-analyzer-phase2",
      "research-agent-worker-phase1",
      "research-agent-worker-phase2",
      "research-agent-aggregator-phase1",
      "research-agent-aggregator-phase2",
    ];
    expect(PROMPT_NAMES).toEqual(pythonPromptNames);
  });

  test("config keys match Python ResearchAgentConfig fields", () => {
    // Verify we parse the same snake_case keys as Python's Pydantic model
    const config = parseResearchConfig({
      model_name: "openai:gpt-4o",
      temperature: 0.5,
      max_tokens: 4096,
      base_url: "http://vllm:7374/v1",
      custom_model_name: "custom",
      custom_api_key: "key",
      system_prompt: "prompt",
      max_worker_iterations: 20,
      auto_approve_phase1: true,
      auto_approve_phase2: false,
    });

    expect(config.modelName).toBe("openai:gpt-4o");
    expect(config.temperature).toBe(0.5);
    expect(config.maxTokens).toBe(4096);
    expect(config.baseUrl).toBe("http://vllm:7374/v1");
    expect(config.customModelName).toBe("custom");
    expect(config.customApiKey).toBe("key");
    expect(config.systemPrompt).toBe("prompt");
    expect(config.maxWorkerIterations).toBe(20);
    expect(config.autoApprovePhase1).toBe(true);
    expect(config.autoApprovePhase2).toBe(false);
  });

  test("default model_name matches Python default", () => {
    // Python: model_name: str = "openai:gpt-4o-mini"
    expect(DEFAULT_MODEL_NAME).toBe("openai:gpt-4o-mini");
  });

  test("default temperature matches Python default", () => {
    // Python: temperature: float = 0.0
    expect(DEFAULT_TEMPERATURE).toBe(0.0);
  });

  test("default max_worker_iterations matches Python default", () => {
    // Python: max_worker_iterations: int = Field(default=15, ge=1, le=100)
    expect(DEFAULT_MAX_WORKER_ITERATIONS).toBe(15);
  });
});
