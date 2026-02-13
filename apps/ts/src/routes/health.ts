/**
 * System routes for the Fractal Agents Runtime — TypeScript/Bun.
 *
 * These endpoints match the Python runtime's OpenAPI spec exactly:
 *
 *   GET /          → { service, runtime, version }
 *   GET /health    → { status: "ok" }
 *   GET /ok        → { ok: true }
 *   GET /info      → Full service metadata (build, capabilities, graphs, config, tiers)
 *   GET /openapi.json → OpenAPI 3.1 specification document
 *
 * See: apps/python/openapi-spec.json → paths./, /health, /ok, /info
 */

import type { Router } from "../router";
import {
  VERSION,
  SERVICE_NAME,
  RUNTIME,
  config,
  isLlmConfigured,
  isSupabaseConfigured,
  getCapabilities,
  getTiers,
} from "../config";
import { jsonResponse } from "./helpers";
import { OPENAPI_SPEC } from "../openapi";
import { getAvailableGraphIds } from "../graphs";

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Register all system routes on the given router.
 *
 * @param router - The application Router instance.
 */
export function registerHealthRoutes(router: Router): void {
  router.get("/", handleRoot);
  router.get("/health", handleHealth);
  router.get("/ok", handleOk);
  router.get("/info", handleInfo);
  router.get("/openapi.json", handleOpenApiSpec);
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * GET / — Root endpoint.
 *
 * Returns basic service identification matching the Python spec:
 *   { "service": string, "runtime": string, "version": string }
 */
function handleRoot(): Response {
  return jsonResponse({
    service: SERVICE_NAME,
    runtime: RUNTIME,
    version: VERSION,
  });
}

/**
 * GET /health — Health check.
 *
 * Returns: { "status": "ok" }
 * Matches: components.schemas.HealthResponse
 */
function handleHealth(): Response {
  return jsonResponse({ status: "ok" });
}

/**
 * GET /ok — Simple OK check.
 *
 * Returns: { "ok": true }
 * Matches: components.schemas.OkResponse (ok is const true)
 */
function handleOk(): Response {
  return jsonResponse({ ok: true });
}

/**
 * GET /info — Detailed service information.
 *
 * Returns the full metadata object matching the Python spec's /info response:
 *   - service, runtime, version (same as root)
 *   - build: { commit, date, bun } (bun replaces python for TS runtime)
 *   - capabilities: { streaming, store, crons, a2a, mcp, metrics }
 *   - graphs: string[] of registered graph IDs
 *   - config: { supabase_configured, llm_configured }
 *   - tiers: { tier1, tier2, tier3 }
 */
function handleInfo(): Response {
  return jsonResponse({
    service: SERVICE_NAME,
    runtime: RUNTIME,
    version: VERSION,
    build: {
      commit: config.buildCommit,
      date: config.buildDate,
      bun: typeof Bun !== "undefined" ? Bun.version : "unknown",
    },
    capabilities: getCapabilities(),
    graphs: getAvailableGraphIds(),
    config: {
      supabase_configured: isSupabaseConfigured(),
      llm_configured: isLlmConfigured(),
    },
    tiers: getTiers(),
  });
}

/**
 * GET /openapi.json — OpenAPI 3.1 specification document.
 *
 * Returns the full OpenAPI spec for the runtime. The spec is defined in
 * `src/openapi.ts` and grows as endpoints are added across tasks.
 */
function handleOpenApiSpec(): Response {
  return jsonResponse(OPENAPI_SPEC);
}
