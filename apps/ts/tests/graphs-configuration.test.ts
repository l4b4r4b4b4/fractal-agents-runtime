/**
 * Graph configuration parsing tests for the Fractal Agents Runtime — TypeScript/Bun.
 *
 * Tests the pure configuration parsing functions: parseGraphConfig(),
 * getEffectiveSystemPrompt(), default constants, and edge cases.
 *
 * Reference: apps/python/src/graphs/react_agent/agent.py → GraphConfigPydantic
 */

import { describe, test, expect } from "bun:test";
import {
  parseGraphConfig,
  getEffectiveSystemPrompt,
  DEFAULT_MODEL_NAME,
  DEFAULT_TEMPERATURE,
  DEFAULT_MAX_TOKENS,
  DEFAULT_SYSTEM_PROMPT,
  UNEDITABLE_SYSTEM_PROMPT,
  type GraphConfigValues,
} from "../src/graphs/react-agent/configuration";

// ---------------------------------------------------------------------------
// Constants — verify they match Python runtime
// ---------------------------------------------------------------------------

describe("Graph Configuration — constants", () => {
  test('DEFAULT_MODEL_NAME is "openai:gpt-4o"', () => {
    expect(DEFAULT_MODEL_NAME).toBe("openai:gpt-4o");
  });

  test("DEFAULT_TEMPERATURE is 0.7", () => {
    expect(DEFAULT_TEMPERATURE).toBe(0.7);
  });

  test("DEFAULT_MAX_TOKENS is 4000", () => {
    expect(DEFAULT_MAX_TOKENS).toBe(4000);
  });

  test("DEFAULT_SYSTEM_PROMPT starts with 'You are a helpful assistant'", () => {
    expect(DEFAULT_SYSTEM_PROMPT).toStartWith("You are a helpful assistant");
  });

  test("DEFAULT_SYSTEM_PROMPT mentions tool limitations", () => {
    expect(DEFAULT_SYSTEM_PROMPT).toContain("ONLY to the tools explicitly");
    expect(DEFAULT_SYSTEM_PROMPT).toContain(
      "Do NOT claim to have access to any tools",
    );
  });

  test("UNEDITABLE_SYSTEM_PROMPT contains auth instruction", () => {
    expect(UNEDITABLE_SYSTEM_PROMPT).toContain("authentication");
    expect(UNEDITABLE_SYSTEM_PROMPT).toContain("Markdown link");
  });
});

// ---------------------------------------------------------------------------
// parseGraphConfig — defaults
// ---------------------------------------------------------------------------

describe("Graph Configuration — parseGraphConfig defaults", () => {
  test("undefined input returns all defaults", () => {
    const config = parseGraphConfig(undefined);
    expect(config.model_name).toBe(DEFAULT_MODEL_NAME);
    expect(config.temperature).toBe(DEFAULT_TEMPERATURE);
    expect(config.max_tokens).toBe(DEFAULT_MAX_TOKENS);
    expect(config.system_prompt).toBe(DEFAULT_SYSTEM_PROMPT);
  });

  test("null input returns all defaults", () => {
    const config = parseGraphConfig(null);
    expect(config.model_name).toBe(DEFAULT_MODEL_NAME);
    expect(config.temperature).toBe(DEFAULT_TEMPERATURE);
    expect(config.max_tokens).toBe(DEFAULT_MAX_TOKENS);
    expect(config.system_prompt).toBe(DEFAULT_SYSTEM_PROMPT);
  });

  test("empty object returns all defaults", () => {
    const config = parseGraphConfig({});
    expect(config.model_name).toBe(DEFAULT_MODEL_NAME);
    expect(config.temperature).toBe(DEFAULT_TEMPERATURE);
    expect(config.max_tokens).toBe(DEFAULT_MAX_TOKENS);
    expect(config.system_prompt).toBe(DEFAULT_SYSTEM_PROMPT);
  });
});

// ---------------------------------------------------------------------------
// parseGraphConfig — individual overrides
// ---------------------------------------------------------------------------

describe("Graph Configuration — parseGraphConfig individual overrides", () => {
  test("override model_name only", () => {
    const config = parseGraphConfig({ model_name: "openai:gpt-4o-mini" });
    expect(config.model_name).toBe("openai:gpt-4o-mini");
    expect(config.temperature).toBe(DEFAULT_TEMPERATURE);
    expect(config.max_tokens).toBe(DEFAULT_MAX_TOKENS);
    expect(config.system_prompt).toBe(DEFAULT_SYSTEM_PROMPT);
  });

  test("override temperature only", () => {
    const config = parseGraphConfig({ temperature: 0.3 });
    expect(config.model_name).toBe(DEFAULT_MODEL_NAME);
    expect(config.temperature).toBe(0.3);
    expect(config.max_tokens).toBe(DEFAULT_MAX_TOKENS);
    expect(config.system_prompt).toBe(DEFAULT_SYSTEM_PROMPT);
  });

  test("override max_tokens only", () => {
    const config = parseGraphConfig({ max_tokens: 8000 });
    expect(config.model_name).toBe(DEFAULT_MODEL_NAME);
    expect(config.temperature).toBe(DEFAULT_TEMPERATURE);
    expect(config.max_tokens).toBe(8000);
    expect(config.system_prompt).toBe(DEFAULT_SYSTEM_PROMPT);
  });

  test("override system_prompt only", () => {
    const config = parseGraphConfig({
      system_prompt: "You are a pirate assistant.",
    });
    expect(config.model_name).toBe(DEFAULT_MODEL_NAME);
    expect(config.temperature).toBe(DEFAULT_TEMPERATURE);
    expect(config.max_tokens).toBe(DEFAULT_MAX_TOKENS);
    expect(config.system_prompt).toBe("You are a pirate assistant.");
  });
});

// ---------------------------------------------------------------------------
// parseGraphConfig — override all fields together
// ---------------------------------------------------------------------------

describe("Graph Configuration — parseGraphConfig all overrides", () => {
  test("override all fields at once", () => {
    const config = parseGraphConfig({
      model_name: "anthropic:claude-3-5-sonnet-latest",
      temperature: 1.5,
      max_tokens: 2048,
      system_prompt: "Custom system prompt.",
    });
    expect(config.model_name).toBe("anthropic:claude-3-5-sonnet-latest");
    expect(config.temperature).toBe(1.5);
    expect(config.max_tokens).toBe(2048);
    expect(config.system_prompt).toBe("Custom system prompt.");
  });
});

// ---------------------------------------------------------------------------
// parseGraphConfig — type coercion and edge cases
// ---------------------------------------------------------------------------

describe("Graph Configuration — parseGraphConfig edge cases", () => {
  test("unknown fields are silently ignored", () => {
    const config = parseGraphConfig({
      model_name: "openai:gpt-4o",
      unknown_field: "should be ignored",
      mcp_config: { servers: [] },
      rag: { rag_url: "http://example.com" },
    });
    expect(config.model_name).toBe("openai:gpt-4o");
    // Only known fields should be in the result
    expect(Object.keys(config)).toEqual([
      "model_name",
      "temperature",
      "max_tokens",
      "system_prompt",
    ]);
  });

  test("string temperature is coerced to number", () => {
    const config = parseGraphConfig({ temperature: "0.5" });
    expect(config.temperature).toBe(0.5);
  });

  test("string max_tokens is coerced to integer", () => {
    const config = parseGraphConfig({ max_tokens: "2048" });
    expect(config.max_tokens).toBe(2048);
  });

  test("float max_tokens is rounded to integer", () => {
    const config = parseGraphConfig({ max_tokens: 2048.7 });
    expect(config.max_tokens).toBe(2049);
  });

  test("string float max_tokens is rounded to integer", () => {
    const config = parseGraphConfig({ max_tokens: "1000.4" });
    expect(config.max_tokens).toBe(1000);
  });

  test("temperature of 0 is valid (not treated as falsy)", () => {
    const config = parseGraphConfig({ temperature: 0 });
    expect(config.temperature).toBe(0);
  });

  test("max_tokens of 1 is valid", () => {
    const config = parseGraphConfig({ max_tokens: 1 });
    expect(config.max_tokens).toBe(1);
  });

  test("temperature of 2 is valid (max creativity)", () => {
    const config = parseGraphConfig({ temperature: 2 });
    expect(config.temperature).toBe(2);
  });

  test("NaN temperature falls back to default", () => {
    const config = parseGraphConfig({ temperature: NaN });
    expect(config.temperature).toBe(DEFAULT_TEMPERATURE);
  });

  test("Infinity temperature falls back to default", () => {
    const config = parseGraphConfig({ temperature: Infinity });
    expect(config.temperature).toBe(DEFAULT_TEMPERATURE);
  });

  test("NaN max_tokens falls back to default", () => {
    const config = parseGraphConfig({ max_tokens: NaN });
    expect(config.max_tokens).toBe(DEFAULT_MAX_TOKENS);
  });

  test("non-numeric string temperature falls back to default", () => {
    const config = parseGraphConfig({ temperature: "not-a-number" });
    expect(config.temperature).toBe(DEFAULT_TEMPERATURE);
  });

  test("non-numeric string max_tokens falls back to default", () => {
    const config = parseGraphConfig({ max_tokens: "not-a-number" });
    expect(config.max_tokens).toBe(DEFAULT_MAX_TOKENS);
  });

  test("boolean temperature falls back to default", () => {
    const config = parseGraphConfig({ temperature: true });
    expect(config.temperature).toBe(DEFAULT_TEMPERATURE);
  });

  test("null model_name falls back to default", () => {
    const config = parseGraphConfig({ model_name: null });
    expect(config.model_name).toBe(DEFAULT_MODEL_NAME);
  });

  test("empty string model_name falls back to default", () => {
    const config = parseGraphConfig({ model_name: "" });
    expect(config.model_name).toBe(DEFAULT_MODEL_NAME);
  });

  test("empty string system_prompt falls back to default", () => {
    const config = parseGraphConfig({ system_prompt: "" });
    expect(config.system_prompt).toBe(DEFAULT_SYSTEM_PROMPT);
  });

  test("numeric model_name falls back to default", () => {
    const config = parseGraphConfig({ model_name: 42 });
    expect(config.model_name).toBe(DEFAULT_MODEL_NAME);
  });

  test("null system_prompt falls back to default", () => {
    const config = parseGraphConfig({ system_prompt: null });
    expect(config.system_prompt).toBe(DEFAULT_SYSTEM_PROMPT);
  });

  test("negative temperature is preserved (no clamping in parser)", () => {
    // The parser does not clamp — validation is the caller's responsibility
    const config = parseGraphConfig({ temperature: -0.5 });
    expect(config.temperature).toBe(-0.5);
  });

  test("negative max_tokens is preserved (no clamping in parser)", () => {
    const config = parseGraphConfig({ max_tokens: -100 });
    expect(config.max_tokens).toBe(-100);
  });
});

// ---------------------------------------------------------------------------
// getEffectiveSystemPrompt
// ---------------------------------------------------------------------------

describe("Graph Configuration — getEffectiveSystemPrompt", () => {
  test("appends UNEDITABLE_SYSTEM_PROMPT to default", () => {
    const config = parseGraphConfig({});
    const effective = getEffectiveSystemPrompt(config);

    expect(effective).toStartWith(DEFAULT_SYSTEM_PROMPT);
    expect(effective).toEndWith(UNEDITABLE_SYSTEM_PROMPT);
    expect(effective).toBe(DEFAULT_SYSTEM_PROMPT + UNEDITABLE_SYSTEM_PROMPT);
  });

  test("appends UNEDITABLE_SYSTEM_PROMPT to custom prompt", () => {
    const config = parseGraphConfig({
      system_prompt: "You are a code reviewer.",
    });
    const effective = getEffectiveSystemPrompt(config);

    expect(effective).toStartWith("You are a code reviewer.");
    expect(effective).toEndWith(UNEDITABLE_SYSTEM_PROMPT);
    expect(effective).toBe("You are a code reviewer." + UNEDITABLE_SYSTEM_PROMPT);
  });

  test("uneditable suffix is always present regardless of prompt", () => {
    const config = parseGraphConfig({ system_prompt: "" });
    // Empty string falls back to default, so suffix is after default
    const effective = getEffectiveSystemPrompt(config);
    expect(effective).toContain("authentication");
    expect(effective).toContain("Markdown link");
  });

  test("effective prompt matches Python pattern exactly", () => {
    // Python: effective_system_prompt + UNEDITABLE_SYSTEM_PROMPT
    // The uneditable prompt starts with "\n" so there's a newline separator
    const config = parseGraphConfig({});
    const effective = getEffectiveSystemPrompt(config);

    // Should contain the newline from UNEDITABLE_SYSTEM_PROMPT
    expect(effective).toContain(
      "your current tools.\nIf the tool throws",
    );
  });

  test("returns a new string (not a reference to the constant)", () => {
    const config = parseGraphConfig({});
    const effective1 = getEffectiveSystemPrompt(config);
    const effective2 = getEffectiveSystemPrompt(config);
    expect(effective1).toBe(effective2);
    // They are equal strings but should be consistent
    expect(effective1.length).toBeGreaterThan(DEFAULT_SYSTEM_PROMPT.length);
  });
});

// ---------------------------------------------------------------------------
// Return type structure
// ---------------------------------------------------------------------------

describe("Graph Configuration — return type", () => {
  test("parseGraphConfig returns exactly 4 fields", () => {
    const config = parseGraphConfig({});
    const keys = Object.keys(config);
    expect(keys.length).toBe(4);
    expect(keys).toContain("model_name");
    expect(keys).toContain("temperature");
    expect(keys).toContain("max_tokens");
    expect(keys).toContain("system_prompt");
  });

  test("all fields have correct types", () => {
    const config = parseGraphConfig({});
    expect(typeof config.model_name).toBe("string");
    expect(typeof config.temperature).toBe("number");
    expect(typeof config.max_tokens).toBe("number");
    expect(typeof config.system_prompt).toBe("string");
  });

  test("no undefined fields in returned config", () => {
    const config = parseGraphConfig({});
    expect(config.model_name).toBeDefined();
    expect(config.temperature).toBeDefined();
    expect(config.max_tokens).toBeDefined();
    expect(config.system_prompt).toBeDefined();
  });
});
