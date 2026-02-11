/**
 * Fractal Agents Runtime — TypeScript/Bun HTTP Server (v0.0.0)
 *
 * Minimal pipeline-validation stub. Serves health, info, and OpenAPI spec
 * endpoints. Will grow into a full LangGraph-compatible agent runtime.
 */

import { OPENAPI_SPEC } from "./openapi";

const PORT = parseInt(process.env.PORT || "3000", 10);
const VERSION = "0.0.0";
const SERVICE_NAME = "fractal-agents-runtime-ts";

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function handleRequest(request: Request): Response {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (request.method !== "GET") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  switch (path) {
    case "/":
    case "/health":
      return jsonResponse({ status: "ok" });

    case "/info":
      return jsonResponse({
        service: SERVICE_NAME,
        version: VERSION,
        runtime: "bun",
        bun_version: Bun.version,
      });

    case "/openapi.json":
      return jsonResponse(OPENAPI_SPEC);

    default:
      return jsonResponse({ error: "Not found" }, 404);
  }
}

let server: ReturnType<typeof Bun.serve> | undefined;

if (import.meta.main) {
  server = Bun.serve({
    port: PORT,
    fetch: handleRequest,
  });

  console.log(`🧬 ${SERVICE_NAME} v${VERSION} listening on http://localhost:${server.port}`);
}

export { handleRequest, server, PORT, VERSION, SERVICE_NAME };
