# Task-01: Langfuse Tracing Integration

**Status:** 🟢 Complete
**Created:** 2026-02-15
**Completed:** 2026-02-15

---

## Objective

Port Python's `infra/tracing.py` to TypeScript, providing per-invocation Langfuse tracing via LangChain callbacks. When Langfuse is not configured, everything is a no-op — zero overhead, zero breakage.

---

## Implementation Summary

### Dependencies Added

- `@langfuse/core@4.6.1`
- `@langfuse/langchain@4.6.1`

### Files Created

| File | Description |
|------|-------------|
| `apps/ts/src/infra/tracing.ts` | Langfuse tracing module — singleton init, per-invocation handler creation, config injection |
| `apps/ts/tests/tracing.test.ts` | 46 tests covering all public functions, lifecycle, config augmentation, graceful degradation |

### Files Modified

| File | Change |
|------|--------|
| `apps/ts/src/config.ts` | Added `langfuseSecretKey`, `langfusePublicKey`, `langfuseBaseUrl` to `AppConfig`; imported `isLangfuseEnabled` for capabilities; added `tracing` to `getCapabilities()` |
| `apps/ts/src/index.ts` | Wire `initializeLangfuse()` on startup, `shutdownLangfuse()` on shutdown |
| `apps/ts/src/routes/streams.ts` | Call `injectTracing()` on runnableConfig before `agent.invoke()` in `executeRunStream()` |
| `apps/ts/src/routes/runs.ts` | Call `injectTracing()` on runnableConfig before `agent.invoke()` in `executeRunSync()` |
| `apps/ts/package.json` | Added `@langfuse/core` and `@langfuse/langchain` dependencies |

---

## Public API — `src/infra/tracing.ts`

| Function | Signature | Description |
|----------|-----------|-------------|
| `isLangfuseConfigured()` | `() → boolean` | Checks `LANGFUSE_SECRET_KEY` + `LANGFUSE_PUBLIC_KEY` env vars |
| `isLangfuseEnabled()` | `() → boolean` | Returns `true` if `initializeLangfuse()` succeeded |
| `initializeLangfuse()` | `() → boolean` | Lazy-loads `@langfuse/langchain` CallbackHandler class, caches it; idempotent |
| `shutdownLangfuse()` | `() → Promise<void>` | Flushes pending events, resets state; no-op if not initialized |
| `getLangfuseCallbackHandler(opts?)` | `(InjectTracingOptions?) → CallbackHandler \| null` | Creates fresh per-invocation handler with userId/sessionId/tags |
| `injectTracing(config, opts?)` | `(RunnableConfig, InjectTracingOptions?) → RunnableConfig` | Appends handler to callbacks, injects Langfuse metadata, sets runName; returns original config if disabled |
| `_resetTracingState()` | `() → void` | Test-only: resets module state for isolation |

---

## Design Decisions

1. **CallbackHandler approach (not OpenTelemetry)** — Uses `@langfuse/langchain` `CallbackHandler` directly. Simpler, lighter, no `@opentelemetry/sdk-node` dependency. Matches Python's callback-based pattern.

2. **Per-invocation handler** — Fresh `CallbackHandler` per request prevents state leaks between concurrent requests. Each handler captures one trace.

3. **Lazy `require()` at init time** — The `@langfuse/langchain` package is loaded via `require()` inside `initializeLangfuse()`, not at module import time. This means the module loads cleanly even if the package is missing (graceful degradation).

4. **LangSmith disabled by default** — `LANGCHAIN_TRACING_V2` is set to `"false"` at module load time (before any LangChain imports) unless explicitly overridden by the user.

5. **No config mutation** — `injectTracing()` always returns a new object; the original config is never modified.

6. **JS/TS metadata convention** — Uses camelCase keys (`langfuseUserId`, `langfuseSessionId`, `langfuseTags`) in config metadata, matching the `@langfuse/langchain` JS SDK convention.

---

## Tracing Injection Points

| Location | File | Trace Name | Tags |
|----------|------|------------|------|
| Streaming runs | `streams.ts:executeRunStream()` | `"agent-stream"` | `["bun", "streaming"]` |
| Synchronous runs | `runs.ts:executeRunSync()` | `"agent-run"` | `["bun", "sync"]` |

Stateless runs (`runs-stateless.ts`) delegate to `executeRunStream()` and `executeRunSync()`, so they're covered automatically.

---

## Test Coverage

**46 tests, 106 assertions, 0 failures**

| Test Group | Count | Coverage |
|------------|-------|----------|
| LangSmith Disabling | 2 | LANGCHAIN_TRACING_V2 defaults and override |
| Configuration Detection | 7 | Both keys, missing keys, empty strings |
| Initialization Lifecycle | 5 | Not configured, configured, idempotent, enabled state |
| Shutdown | 4 | No-op, reset flag, multiple calls, re-init after shutdown |
| Callback Handler | 6 | Null when disabled, handler creation, options, after shutdown |
| injectTracing() | 12 | Identity when disabled, callbacks, metadata (userId/sessionId/tags), runName, preservation, immutability, combined |
| _resetTracingState | 3 | Reset flag, idempotent, handler null after reset |
| Disabled Integration | 4 | Identity pass-through, null handler, safe shutdown, enable then inject |
| Multiple Handlers | 2 | Distinct handler instances, independent configs |

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `LANGFUSE_SECRET_KEY` | No | — | Langfuse secret key (enables tracing) |
| `LANGFUSE_PUBLIC_KEY` | No | — | Langfuse public key (enables tracing) |
| `LANGFUSE_BASE_URL` | No | `https://cloud.langfuse.com` | Langfuse server URL |
| `LANGCHAIN_TRACING_V2` | No | `false` | Set to `"true"` to enable LangSmith (disabled by default) |

---

## Verification

- **46 new tracing tests pass** (all green)
- **1085 total tests pass** (46 new + 1039 existing, 0 failures)
- **TypeScript diagnostics clean** (`tsc --noEmit` — no errors)
- **Bun compatibility confirmed** — `@langfuse/langchain` loads and creates handlers correctly under Bun 1.3.9
- **`/info` endpoint** reports `tracing: true` when Langfuse is configured, `tracing: false` otherwise

---

## Acceptance Criteria

- [x] Langfuse initialized when env vars set; no-op when not set
- [x] `injectTracing()` adds callback handler + metadata to config
- [x] `injectTracing()` returns config unchanged when Langfuse not initialized
- [x] `shutdownLangfuse()` flushes pending events
- [x] LangSmith disabled by default
- [x] All agent invocations (streaming + non-streaming) pass through tracing injection
- [ ] Traces appear in Langfuse UI with correct user_id, session_id (manual verification — deferred to E2E)