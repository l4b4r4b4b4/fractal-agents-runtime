/**
 * Fractal Agents Runtime — TypeScript/Bun HTTP Server (v0.0.1)
 *
 * Entrypoint for the LangGraph-compatible agent runtime. Uses Bun.serve()
 * with a pattern-matching router and graceful shutdown on SIGTERM/SIGINT.
 *
 * This file:
 *   1. Creates a Router instance.
 *   2. Registers all route modules (system routes, and later assistants,
 *      threads, runs, etc.).
 *   3. Starts the Bun HTTP server.
 *   4. Installs signal handlers for graceful shutdown.
 */

import { Router } from "./router";
import { config, VERSION, SERVICE_NAME, isDatabaseConfigured } from "./config";
import { registerHealthRoutes } from "./routes/health";
import { registerAssistantRoutes } from "./routes/assistants";
import { registerThreadRoutes } from "./routes/threads";
import { registerRunRoutes } from "./routes/runs";
import { registerStreamRoutes } from "./routes/streams";
import { registerStatelessRunRoutes } from "./routes/runs-stateless";
import { registerStoreRoutes } from "./routes/store";
import { registerMcpRoutes } from "./routes/mcp";
import { registerCronRoutes } from "./routes/crons";
import { registerA2ARoutes } from "./routes/a2a";
import { authMiddleware, logAuthStatus } from "./middleware/auth";
import { initializeStorage, shutdownStorage, getStorage } from "./storage";
import { getConnection } from "./storage/database";
import { initializeLangfuse, shutdownLangfuse } from "./infra/tracing";
import { registerStorageCountsCallback } from "./infra/metrics";
import { getScheduler } from "./crons/scheduler";
import { getCronHandler } from "./crons/handlers";
import { registerMetricsRoutes } from "./routes/metrics";
import { parseAgentSyncScope, startupAgentSync } from "./agent-sync";
import { SYSTEM_OWNER_ID } from "./storage/types";

// ---------------------------------------------------------------------------
// Router setup
// ---------------------------------------------------------------------------

const router = new Router();

// Authentication middleware — must be registered before any routes.
// Verifies Supabase JWT tokens on protected endpoints.
// When Supabase is not configured, all requests pass through (graceful degradation).
router.use(authMiddleware);

// System routes: GET /, /health, /ok, /info, /openapi.json
registerHealthRoutes(router);

// Assistant routes: POST/GET/PATCH/DELETE /assistants, search, count
registerAssistantRoutes(router);

// Thread routes: POST/GET/PATCH/DELETE /threads, state, history, search, count
registerThreadRoutes(router);

// Run routes: POST/GET/DELETE /threads/:id/runs/*, cancel, join, wait
registerRunRoutes(router);

// Stream routes: POST /threads/:id/runs/stream, GET .../runs/:id/stream
registerStreamRoutes(router);

// Stateless run routes: POST /runs, /runs/stream, /runs/wait
registerStatelessRunRoutes(router);

// Store routes: PUT/GET/DELETE /store/items, POST /store/items/search, GET /store/namespaces
registerStoreRoutes(router);

// MCP protocol routes: POST/GET/DELETE /mcp (JSON-RPC 2.0 MCP server endpoint)
registerMcpRoutes(router);

// Cron routes: POST /runs/crons, POST /runs/crons/search, POST /runs/crons/count, DELETE /runs/crons/:cron_id
registerCronRoutes(router);

// Metrics routes: GET /metrics (Prometheus), GET /metrics/json (JSON)
registerMetricsRoutes(router);

// A2A protocol routes: POST /a2a/:assistantId (JSON-RPC 2.0 A2A endpoint)
// Registered after storage is available — uses getStorage() lazily.
// The route handler accesses storage at request time, so registering early is fine.
registerA2ARoutes(router, {
  assistants: {
    get: (id: string, ownerId: string) => {
      try {
        return getStorage().assistants.get(id, ownerId);
      } catch {
        return null;
      }
    },
    list: (ownerId: string) => {
      try {
        return getStorage().assistants.list(ownerId);
      } catch {
        return [];
      }
    },
  },
  threads: {
    get: (id: string, ownerId: string) => {
      try {
        return getStorage().threads.get(id, ownerId);
      } catch {
        return null;
      }
    },
    create: (metadata: Record<string, unknown>, ownerId: string) => {
      try {
        return getStorage().threads.create(metadata, ownerId);
      } catch {
        return { thread_id: crypto.randomUUID() };
      }
    },
  },
  runs: {
    get: (id: string, ownerId: string) => {
      try {
        return getStorage().runs.get(id, ownerId);
      } catch {
        return null;
      }
    },
    create: (data: Record<string, unknown>, ownerId: string) => {
      try {
        return getStorage().runs.create(data, ownerId);
      } catch {
        return { run_id: crypto.randomUUID() };
      }
    },
  },
});

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

let server: ReturnType<typeof Bun.serve> | undefined;

/**
 * Start the Bun HTTP server.
 *
 * Only starts when this module is the main entry point (not when imported
 * by tests). Tests can import `router` and call `router.handle()` directly.
 */
if (import.meta.main) {
  // -------------------------------------------------------------------------
  // Storage initialization (must run before serving requests)
  // -------------------------------------------------------------------------
  // Probes Postgres, runs DDL migrations, sets up LangGraph checkpoint tables.
  // Falls back to in-memory storage if DATABASE_URL is not configured.
  await initializeStorage();

  // -------------------------------------------------------------------------
  // Agent sync from Supabase (must run after storage + database init)
  // -------------------------------------------------------------------------
  if (isDatabaseConfigured()) {
    const sqlConnection = getConnection();
    if (sqlConnection) {
      try {
        const scope = parseAgentSyncScope(config.agentSyncScope);
        if (scope.type !== "none") {
          const storage = getStorage();
          const summary = await startupAgentSync(
            sqlConnection,
            storage,
            scope,
            SYSTEM_OWNER_ID,
          );
          console.log(
            `   Agent sync:        ${summary.total} agents (${summary.created} created, ${summary.updated} updated, ${summary.skipped} skipped, ${summary.failed} failed)`,
          );
        } else {
          console.log("   Agent sync:        disabled (scope=none)");
        }
      } catch (syncError: unknown) {
        const message =
          syncError instanceof Error ? syncError.message : String(syncError);
        console.warn(
          `   Agent sync:        ⚠️  failed — ${message}`,
        );
        // Non-fatal: server continues without agent sync
      }
    }
  }

  // Initialize Langfuse tracing (no-op if env vars not set)
  if (initializeLangfuse()) {
    console.log("   Langfuse tracing:  enabled");
  }

  // Register storage counts callback for Prometheus metrics
  try {
    const metricsStorage = getStorage();
    registerStorageCountsCallback(() => {
      // Access internal data for counts — works for both in-memory and Postgres
      const assistantsStore = metricsStorage.assistants as any;
      const threadsStore = metricsStorage.threads as any;
      const runsStore = metricsStorage.runs as any;

      const assistantCount =
        typeof assistantsStore.count === "function"
          ? 0 // Will be filled by actual count calls — use _data if available
          : 0;
      const threadCount = 0;
      const runCount = 0;

      // Best-effort: try to access internal _data maps for in-memory storage
      const assistants = assistantsStore._data?.size ?? assistantCount;
      const threads = threadsStore._data?.size ?? threadCount;
      const runs = runsStore._data?.size ?? runCount;

      const runsByStatus: Record<string, number> = {};
      if (runsStore._data instanceof Map) {
        for (const runData of runsStore._data.values()) {
          const status = (runData as Record<string, unknown>).status ?? "unknown";
          runsByStatus[status as string] = (runsByStatus[status as string] ?? 0) + 1;
        }
      }

      return { assistants, threads, runs, runsByStatus };
    });
  } catch {
    // Storage metrics will be unavailable — non-fatal
  }

  // Initialize cron scheduler and handler (wires execution callback)
  const cronHandler = getCronHandler();
  const cronScheduler = getScheduler();
  cronScheduler.start();
  console.log("   Cron scheduler:    started");

  server = Bun.serve({
    port: config.port,
    fetch: (request: Request) => router.handle(request),
  });

  console.log(
    `🧬 ${SERVICE_NAME} v${VERSION} listening on http://localhost:${server.port}`,
  );
  console.log(
    `   Bun runtime:       ${Bun.version}`,
  );
  console.log(
    `   Routes registered: ${router.routeCount}`,
  );

  // Log auth configuration status
  logAuthStatus();

  // -------------------------------------------------------------------------
  // Graceful shutdown
  // -------------------------------------------------------------------------

  async function shutdown(signal: string): Promise<void> {
    console.log(`\n⏹  Received ${signal}, shutting down gracefully...`);
    if (server) {
      server.stop(true); // true = close idle connections immediately
      server = undefined;
    }

    // Stop the cron scheduler (cancel all pending timers)
    const scheduler = getScheduler();
    scheduler.shutdown();

    // Flush Langfuse traces and shut down client
    await shutdownLangfuse();

    // Close database connections and reset storage singletons
    await shutdownStorage();

    console.log("👋 Server stopped.");
    process.exit(0);
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

// ---------------------------------------------------------------------------
// Exports (for tests and programmatic use)
// ---------------------------------------------------------------------------

export { router, server, config };
