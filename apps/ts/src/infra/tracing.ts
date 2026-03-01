/**
 * Tracing configuration for fractal-agents-runtime — TypeScript/Bun.
 *
 * Handles Langfuse initialization and provides callback handlers for
 * LangChain/LangGraph agent invocations. Disables LangSmith tracing
 * by default.
 *
 * This module should be imported early in the application lifecycle
 * (e.g., from `index.ts`) so that the `LANGCHAIN_TRACING_V2`
 * environment variable is set before any LangChain imports occur.
 *
 * Usage:
 *
 *   import { initializeLangfuse, injectTracing } from "./infra/tracing";
 *
 *   // At startup
 *   initializeLangfuse();
 *
 *   // Per invocation
 *   const tracedConfig = injectTracing(runnableConfig, {
 *     userId: ownerId,
 *     sessionId: threadId,
 *     traceName: "agent-stream",
 *   });
 *   const result = await agent.invoke(agentInput, tracedConfig);
 *
 * Environment variables:
 *   LANGFUSE_SECRET_KEY  — Langfuse secret key (required for tracing).
 *   LANGFUSE_PUBLIC_KEY  — Langfuse public key (required for tracing).
 *   LANGFUSE_BASE_URL    — Langfuse host URL
 *       (default: "https://cloud.langfuse.com").
 *   LANGCHAIN_TRACING_V2 — Set to "true" to re-enable LangSmith
 *       (default: "false").
 */

// ---------------------------------------------------------------------------
// Disable LangSmith tracing by default
// ---------------------------------------------------------------------------
// LangChain checks this env var to decide whether to send traces to
// LangSmith. We default to "false" so LangSmith is never implicitly
// enabled. Users can still set LANGCHAIN_TRACING_V2=true explicitly
// if they want LangSmith alongside or instead of Langfuse.
if (!process.env.LANGCHAIN_TRACING_V2) {
  process.env.LANGCHAIN_TRACING_V2 = "false";
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for per-invocation tracing injection. */
export interface InjectTracingOptions {
  /** Owner / user identity for trace attribution. */
  userId?: string;
  /** Thread ID or session identifier for grouping. */
  sessionId?: string;
  /** Human-readable name shown in the Langfuse UI (e.g., "agent-stream"). */
  traceName?: string;
  /** Freeform tags for filtering in the Langfuse dashboard. */
  tags?: string[];
}

/**
 * A minimal representation of the config object passed to LangChain
 * runnables. We keep this loose so callers don't need to import
 * `@langchain/core` just for the type — any plain object with optional
 * `callbacks`, `metadata`, and `run_name` fields works.
 */
export type RunnableConfig = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/** Whether Langfuse has been successfully initialized. */
let langfuseInitialized = false;

/**
 * Cached reference to the Langfuse `CallbackHandler` class.
 * Populated lazily on first successful `initializeLangfuse()` call so we
 * don't force-import `@langfuse/langchain` when tracing is disabled.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let CallbackHandlerClass: (new (options?: Record<string, unknown>) => any) | null = null;

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/**
 * Return `true` if the required Langfuse env vars are present.
 *
 * Both `LANGFUSE_SECRET_KEY` and `LANGFUSE_PUBLIC_KEY` must be set
 * and non-empty for Langfuse tracing to be enabled.
 */
export function isLangfuseConfigured(): boolean {
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  return Boolean(secretKey && secretKey.length > 0 && publicKey && publicKey.length > 0);
}

/**
 * Return `true` if the Langfuse client has been initialized.
 */
export function isLangfuseEnabled(): boolean {
  return langfuseInitialized;
}

/**
 * Initialize the Langfuse integration.
 *
 * Call this once at application startup (e.g., in the Bun.serve setup).
 * The `CallbackHandler` reads connection details from `LANGFUSE_SECRET_KEY`,
 * `LANGFUSE_PUBLIC_KEY`, and `LANGFUSE_BASE_URL` automatically.
 *
 * If the required env vars are missing or initialization fails, tracing
 * is silently disabled and the application continues to function normally.
 *
 * @returns `true` if Langfuse was initialized, `false` otherwise.
 */
export function initializeLangfuse(): boolean {
  if (langfuseInitialized) {
    return true;
  }

  if (!isLangfuseConfigured()) {
    console.log(
      "[tracing] Langfuse not configured " +
        "(LANGFUSE_SECRET_KEY / LANGFUSE_PUBLIC_KEY not set) " +
        "— tracing disabled",
    );
    return false;
  }

  try {
    // Dynamic import at call time so the module doesn't fail when
    // @langfuse/langchain is not installed (graceful degradation).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const langfuseLangchain = require("@langfuse/langchain");
    CallbackHandlerClass = langfuseLangchain.CallbackHandler;

    langfuseInitialized = true;

    const baseUrl = process.env.LANGFUSE_BASE_URL || "https://cloud.langfuse.com";
    console.log(`[tracing] Langfuse tracing initialized; baseUrl=${baseUrl}`);
    return true;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[tracing] Failed to initialize Langfuse — tracing disabled: ${message}`);
    return false;
  }
}

/**
 * Flush pending events and shut down the Langfuse client.
 *
 * Safe to call even when Langfuse was never initialized (no-op).
 * Should be called in the application shutdown handler.
 */
export async function shutdownLangfuse(): Promise<void> {
  if (!langfuseInitialized) {
    return;
  }

  try {
    // The @langfuse/langchain CallbackHandler manages its own Langfuse
    // client internally. We attempt to flush via the Langfuse core client
    // if available.
    const langfuseCore = require("@langfuse/core");
    if (typeof langfuseCore.Langfuse === "function") {
      // Try to access the global/singleton Langfuse instance for flushing
      // In @langfuse/langchain v4+, each CallbackHandler creates its own
      // client, so there may not be a singleton. Best-effort flush.
      try {
        const { Langfuse } = langfuseCore;
        const client = new Langfuse();
        await client.flushAsync();
        client.shutdown();
      } catch {
        // No singleton to flush — that's fine, handlers flush on their own
      }
    }
    console.log("[tracing] Langfuse client shut down");
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[tracing] Error shutting down Langfuse: ${message}`);
  } finally {
    langfuseInitialized = false;
    CallbackHandlerClass = null;
  }
}

/**
 * Create a Langfuse `CallbackHandler` for a single invocation.
 *
 * Each handler captures one trace. Per-invocation attributes (userId,
 * sessionId, tags) are passed via the constructor so they appear on the
 * trace in the Langfuse UI.
 *
 * @param options - Optional per-invocation attributes.
 * @returns A `CallbackHandler` instance, or `null` if Langfuse is not initialized.
 */
export function getLangfuseCallbackHandler(
  options?: InjectTracingOptions,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any | null {
  if (!langfuseInitialized || !CallbackHandlerClass) {
    return null;
  }

  try {
    const handlerOptions: Record<string, unknown> = {};

    if (options?.userId) {
      handlerOptions.userId = options.userId;
    }
    if (options?.sessionId) {
      handlerOptions.sessionId = options.sessionId;
    }
    if (options?.tags) {
      handlerOptions.tags = options.tags;
    }

    return new CallbackHandlerClass(handlerOptions);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[tracing] Failed to create Langfuse callback handler: ${message}`);
    return null;
  }
}

/**
 * Augment a config object with Langfuse tracing.
 *
 * If Langfuse is not initialized the config is returned unchanged,
 * making this safe to call unconditionally at every invocation point.
 *
 * The function:
 *
 * 1. Creates a fresh `CallbackHandler` and appends it to the config's
 *    `callbacks` array.
 * 2. Injects `langfuseUserId`, `langfuseSessionId`, and `langfuseTags`
 *    into the config `metadata` dict so that Langfuse can attribute
 *    traces correctly (JS/TS convention — camelCase keys).
 * 3. Optionally sets `runName` for human-readable trace naming.
 *
 * @param config - The base runnable config (not mutated).
 * @param options - Per-invocation tracing attributes.
 * @returns A **new** config with tracing injected, or the original
 *   config if Langfuse is disabled.
 *
 * @example
 *   const tracedConfig = injectTracing(runnableConfig, {
 *     userId: ownerId,
 *     sessionId: threadId,
 *     traceName: "agent-stream",
 *     tags: ["bun", "streaming"],
 *   });
 *   const result = await agent.invoke(agentInput, tracedConfig);
 */
export function injectTracing(
  config: RunnableConfig,
  options?: InjectTracingOptions,
): RunnableConfig {
  const handler = getLangfuseCallbackHandler(options);
  if (handler === null) {
    return config;
  }

  // --- Merge callback handler -------------------------------------------
  const existingCallbacks: unknown[] = Array.isArray(config.callbacks)
    ? [...(config.callbacks as unknown[])]
    : [];
  existingCallbacks.push(handler);

  const augmented: RunnableConfig = {
    ...config,
    callbacks: existingCallbacks,
  };

  // --- Merge Langfuse metadata ------------------------------------------
  // The @langfuse/langchain CallbackHandler reads trace attributes from
  // the config's metadata dict. JS/TS convention uses camelCase keys:
  //   langfuseUserId, langfuseSessionId, langfuseTags
  const langfuseMetadata: Record<string, unknown> = {};

  if (options?.userId) {
    langfuseMetadata.langfuseUserId = options.userId;
  }
  if (options?.sessionId) {
    langfuseMetadata.langfuseSessionId = options.sessionId;
  }
  if (options?.tags) {
    langfuseMetadata.langfuseTags = options.tags;
  }

  if (Object.keys(langfuseMetadata).length > 0) {
    const existingMetadata: Record<string, unknown> =
      typeof config.metadata === "object" && config.metadata !== null
        ? { ...(config.metadata as Record<string, unknown>) }
        : {};
    Object.assign(existingMetadata, langfuseMetadata);
    augmented.metadata = existingMetadata;
  }

  // --- Trace name -------------------------------------------------------
  if (options?.traceName) {
    augmented.runName = options.traceName;
  }

  return augmented;
}

// ---------------------------------------------------------------------------
// Reset helper (testing only)
// ---------------------------------------------------------------------------

/**
 * Reset module-level state for test isolation.
 *
 * **Warning:** This is intended for tests only. Do not call in
 * production code.
 */
export function _resetTracingState(): void {
  langfuseInitialized = false;
  CallbackHandlerClass = null;
}
