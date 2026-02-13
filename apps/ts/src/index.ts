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
import { config, VERSION, SERVICE_NAME } from "./config";
import { registerHealthRoutes } from "./routes/health";
import { registerAssistantRoutes } from "./routes/assistants";
import { registerThreadRoutes } from "./routes/threads";
import { registerRunRoutes } from "./routes/runs";
import { registerStreamRoutes } from "./routes/streams";
import { registerStatelessRunRoutes } from "./routes/runs-stateless";

// ---------------------------------------------------------------------------
// Router setup
// ---------------------------------------------------------------------------

const router = new Router();

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
  server = Bun.serve({
    port: config.port,
    fetch: (request: Request) => router.handle(request),
  });

  console.log(
    `🧬 ${SERVICE_NAME} v${VERSION} listening on http://localhost:${server.port}`,
  );
  console.log(
    `   Routes registered: ${router.routeCount}`,
  );

  // -------------------------------------------------------------------------
  // Graceful shutdown
  // -------------------------------------------------------------------------

  function shutdown(signal: string): void {
    console.log(`\n⏹  Received ${signal}, shutting down gracefully...`);
    if (server) {
      server.stop(true); // true = close idle connections immediately
      server = undefined;
    }
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
