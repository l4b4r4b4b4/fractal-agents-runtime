# Task-04: Multi-Provider LLM Support

> **Status:** 🟡 In Progress
> **Goal:** [25 — TS Runtime v0.0.2](../scratchpad.md)
> **Created:** 2026-02-15
> **Branch:** `feat/ts-v0.0.2-auth-persistence-store`

---

## Objective

Replace the hardcoded `ChatOpenAI` model creation with a multi-provider factory that supports OpenAI, Anthropic, Google, and custom OpenAI-compatible endpoints — matching the Python runtime's `init_chat_model` + custom endpoint pattern.

---

## Research Findings

### `initChatModel` in LangChain JS

LangChain JS (`langchain` package, which we already depend on) exports `initChatModel`:

```ts
import { initChatModel } from "langchain";

const model = await initChatModel("openai:gpt-4o", {
  temperature: 0.7,
  maxTokens: 4000,
});
```

- Accepts `provider:model` format (same convention as Python)
- Auto-selects the right class: `ChatOpenAI`, `ChatAnthropic`, `ChatGoogleGenerativeAI`
- Requires the provider packages to be installed (`@langchain/anthropic`, `@langchain/google-genai`)
- **Does NOT support custom OpenAI-compatible endpoints** — that still needs `ChatOpenAI` with `configuration.baseURL`

### Python Runtime Pattern

The Python runtime (`graphs/react_agent/agent.py`) uses a two-branch approach:

1. **Custom endpoint** (`cfg.base_url` is set) → `ChatOpenAI(openai_api_base=..., openai_api_key=..., model=...)`
2. **Standard provider** (no `base_url`) → `init_chat_model(cfg.model_name, temperature=..., max_tokens=..., api_key=...)`

We'll mirror this exactly.

### Current TS Agent Code

- `agent.ts` already has `extractModelName()`, `extractProvider()`, `getApiKeyForModel()` — all provider-aware
- `configuration.ts` has `GraphConfigValues` with `model_name`, `temperature`, `max_tokens`, `system_prompt`
- Missing: `base_url`, `custom_model_name`, `custom_api_key` fields
- Missing: `x_oap_ui_config` metadata for OAP UI rendering
- Model creation is hardcoded to `new ChatOpenAI(...)` — needs to use `initChatModel` for standard providers

### New Dependencies Needed

- `@langchain/anthropic` — for `anthropic:*` models
- `@langchain/google-genai` — for `google:*` models

Both are peer deps that `initChatModel` dynamically imports. They must be installed for the respective providers to work.

---

## Implementation Plan

### Files to Create

1. **`src/graphs/react-agent/providers.ts`** — Provider factory module
   - `createChatModel(config, rawConfigurable)` → `BaseChatModel`
   - Two code paths: custom endpoint vs standard provider (via `initChatModel`)
   - API key resolution (moved from `agent.ts`)
   - Provider prefix parsing (moved from `agent.ts`)

### Files to Modify

2. **`src/graphs/react-agent/configuration.ts`** — Extend config
   - Add `base_url`, `custom_model_name`, `custom_api_key` to `GraphConfigValues`
   - Add `x_oap_ui_config` metadata constant (JSON object matching Python's schema)
   - Update `parseGraphConfig()` to extract the new fields

3. **`src/graphs/react-agent/agent.ts`** — Use the new provider factory
   - Replace `new ChatOpenAI(...)` with `createChatModel(parsedConfig, config)`
   - Remove model-creation and API-key logic (moved to `providers.ts`)
   - Keep it focused on graph assembly only

4. **`src/config.ts`** — Add env var declarations
   - `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, `CUSTOM_API_KEY`

### Files to Create (Tests)

5. **`tests/providers.test.ts`** — Provider factory tests
   - Provider prefix parsing
   - API key routing (env vars, config-injected keys)
   - Custom endpoint model creation (mocked)
   - Standard provider model creation (mocked `initChatModel`)
   - Fallback to OpenAI when no prefix
   - Error handling for missing API keys

6. **`tests/configuration.test.ts`** — Extended config tests (add to existing)
   - New fields parse correctly
   - Defaults for new fields
   - `x_oap_ui_config` structure validation

---

## Design Decisions

### Use `initChatModel` for Standard Providers

**Decision:** Use `initChatModel` from `langchain` (already a dependency) instead of manually importing and instantiating each provider class.

**Rationale:**
- Exact parity with Python's `init_chat_model`
- Automatically handles provider resolution from `provider:model` string
- Forward-compatible with new providers without code changes
- `@langchain/anthropic` and `@langchain/google-genai` are peer deps — installed but not statically imported

**Tradeoff:** Dynamic import at runtime (first call may be slightly slower). Acceptable for a server that processes requests over seconds.

### Custom Endpoint Uses `ChatOpenAI` Directly

**Decision:** When `base_url` is set, bypass `initChatModel` and use `ChatOpenAI` with custom `configuration.baseURL`.

**Rationale:** Matches Python pattern exactly. `initChatModel` doesn't support custom base URLs. vLLM/Ollama/LiteLLM all expose OpenAI-compatible APIs.

### Move Provider Logic to `providers.ts`

**Decision:** Extract all model-creation logic from `agent.ts` into a dedicated `providers.ts` module.

**Rationale:** Single responsibility. `agent.ts` should focus on graph assembly. Provider selection is its own concern that's independently testable. Future graphs (research agent port) can reuse `providers.ts`.

### `x_oap_ui_config` as a Static Constant

**Decision:** Define the OAP UI config metadata as a const object in `configuration.ts`, not computed at runtime.

**Rationale:** The UI config is static schema metadata. It describes what the frontend should render. The Python runtime defines it as `json_schema_extra` on Pydantic fields. In TS, we export it as a typed constant that gets included in the OpenAPI spec.

---

## Acceptance Criteria

- [ ] `"openai:gpt-4o"` creates ChatOpenAI with model "gpt-4o"
- [ ] `"anthropic:claude-sonnet-4-0"` creates ChatAnthropic (via initChatModel)
- [ ] `"google:gemini-pro"` creates ChatGoogleGenerativeAI (via initChatModel)
- [ ] `"custom:"` creates ChatOpenAI with custom baseURL from config
- [ ] No prefix defaults to OpenAI
- [ ] API keys routed correctly per provider (env vars + config-injected)
- [ ] Custom endpoint uses `custom_api_key` from config, falls back to `CUSTOM_API_KEY` env, falls back to `"EMPTY"`
- [ ] Temperature and max_tokens applied to all providers
- [ ] Config shape includes `base_url`, `custom_model_name`, `custom_api_key`
- [ ] `x_oap_ui_config` metadata matches Python's `GraphConfigPydantic` schema
- [ ] Existing tests still pass (no behavioral change for default OpenAI path)
- [ ] New tests cover provider parsing, key routing, custom endpoint, standard providers

---

## Progress

- [ ] Install `@langchain/anthropic` and `@langchain/google-genai`
- [ ] Create `src/graphs/react-agent/providers.ts`
- [ ] Extend `src/graphs/react-agent/configuration.ts`
- [ ] Update `src/graphs/react-agent/agent.ts`
- [ ] Update `src/config.ts`
- [ ] Write tests for providers
- [ ] Write tests for extended configuration
- [ ] Run full test suite — all pass
- [ ] Run linter — zero errors