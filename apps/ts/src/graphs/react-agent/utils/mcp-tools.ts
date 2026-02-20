/**
 * MCP tool fetcher for the Fractal Agents Runtime — TypeScript/Bun.
 *
 * Connects to one or more remote MCP servers via `@langchain/mcp-adapters`
 * `MultiServerMCPClient`, fetches available tools, and converts them to
 * LangChain `DynamicStructuredTool` instances ready for the ReAct agent.
 *
 * Features:
 *   - Multi-server support with unique server key de-duplication
 *   - URL normalization (auto-append `/mcp` if not present)
 *   - OAuth2 token exchange for `auth_required` servers
 *   - Per-server tool allowlist filtering
 *   - Graceful degradation (unreachable server → warn + continue)
 *
 * Port of: apps/python/src/graphs/react_agent/agent.py (MCP section)
 *
 * Usage:
 *
 *   import { fetchMcpTools } from "./utils/mcp-tools";
 *
 *   const tools = await fetchMcpTools(mcpConfig, supabaseToken);
 *   // tools is DynamicStructuredTool[] ready for createAgent({ tools })
 */

import type { MCPConfig } from "../configuration";
import { getMcpAccessToken, findAuthRequiredServerUrl } from "./token";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Internal representation of an MCP server entry for MultiServerMCPClient.
 *
 * Matches the HTTP/SSE connection shape expected by
 * `@langchain/mcp-adapters`.
 */
interface McpServerEntry {
  transport: "http";
  url: string;
  headers?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Mask a URL for safe logging (hide path details, keep host).
 *
 * Matches Python's `_safe_mask_url()` from `agent.py`.
 */
export function safeMaskUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}/***`;
  } catch {
    return "***invalid-url***";
  }
}

/**
 * Normalize an MCP server URL — append `/mcp` if not already present.
 *
 * The MCP protocol expects the endpoint at `/mcp`. If the user provides
 * a bare base URL (e.g., `https://mcp.example.com`), we append `/mcp`
 * automatically. If the URL already ends with `/mcp`, we leave it alone.
 *
 * Matches Python's URL normalization logic:
 *   `raw_url.rstrip("/") if raw_url.endswith("/mcp") else raw_url + "/mcp"`
 */
export function normalizeServerUrl(rawUrl: string): string {
  const trimmed = rawUrl.replace(/\/+$/, "");
  if (trimmed.endsWith("/mcp")) {
    return trimmed;
  }
  return `${trimmed}/mcp`;
}

/**
 * Generate a unique server key, de-duplicating if needed.
 *
 * Matches Python's de-duplication logic:
 *   If key exists, suffix with `-2`, `-3`, etc.
 */
export function uniqueServerKey(
  baseName: string,
  existingKeys: Set<string>,
): string {
  let key = baseName;
  if (!existingKeys.has(key)) {
    return key;
  }
  let index = 2;
  while (existingKeys.has(`${baseName}-${index}`)) {
    index += 1;
  }
  key = `${baseName}-${index}`;
  return key;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch tools from remote MCP servers and return them as LangChain tools.
 *
 * This is the main entry point for MCP tool integration. It:
 *
 * 1. Iterates over the configured MCP servers.
 * 2. For `auth_required` servers, exchanges the Supabase token for an
 *    MCP access token (OAuth2 token exchange).
 * 3. Builds a `MultiServerMCPClient` config with transport/url/headers.
 * 4. Fetches tools from all servers via `client.getTools()`.
 * 5. Filters tools by per-server `tools` allowlist.
 * 6. Returns the filtered tools as a flat array.
 *
 * If a server is unreachable or tool fetching fails, a warning is logged
 * and the agent continues without those tools (graceful degradation).
 *
 * @param mcpConfig - The MCP configuration with server definitions.
 * @param supabaseToken - Optional Supabase access token for auth-required servers.
 * @returns Array of LangChain `DynamicStructuredTool` instances.
 */
export async function fetchMcpTools(
  mcpConfig: MCPConfig,
  supabaseToken?: string | null,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any[]> {
  if (!mcpConfig.servers || mcpConfig.servers.length === 0) {
    return [];
  }

  // -----------------------------------------------------------------------
  // 1. Resolve MCP access token if any server requires auth
  // -----------------------------------------------------------------------

  const anyAuthRequired = mcpConfig.servers.some(
    (server) => server.auth_required,
  );

  let mcpAccessToken: string | null = null;

  if (anyAuthRequired && supabaseToken) {
    const authServerUrl = findAuthRequiredServerUrl(mcpConfig.servers);
    if (authServerUrl) {
      const tokenData = await getMcpAccessToken(supabaseToken, authServerUrl);
      if (tokenData) {
        mcpAccessToken = tokenData.access_token;
      } else {
        console.warn(
          "[mcp-tools] Token exchange failed — auth-required servers will be skipped",
        );
      }
    }
  }

  // -----------------------------------------------------------------------
  // 2. Build MultiServerMCPClient config
  // -----------------------------------------------------------------------

  const serverEntries: Record<string, McpServerEntry> = {};
  const serverToolFilters: Record<string, Set<string> | null> = {};
  const existingKeys = new Set<string>();

  for (const server of mcpConfig.servers) {
    const serverUrl = normalizeServerUrl(server.url);

    // Build headers
    const headers: Record<string, string> = {};
    if (server.auth_required) {
      if (!mcpAccessToken) {
        // Auth required but token exchange failed / not available.
        // Skip connecting to this server.
        console.warn(
          `[mcp-tools] MCP server skipped (auth required but no token): name=${server.name} url=${safeMaskUrl(serverUrl)}`,
        );
        continue;
      }
      headers["Authorization"] = `Bearer ${mcpAccessToken}`;
    }

    // Unique key for the server
    const serverKey = uniqueServerKey(server.name || "default", existingKeys);
    existingKeys.add(serverKey);

    serverEntries[serverKey] = {
      transport: "http",
      url: serverUrl,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    };

    // Track per-server tool filter
    serverToolFilters[serverKey] = server.tools
      ? new Set(server.tools)
      : null;
  }

  if (Object.keys(serverEntries).length === 0) {
    return [];
  }

  // -----------------------------------------------------------------------
  // 3. Connect and fetch tools
  // -----------------------------------------------------------------------

  try {
    // Dynamic import to avoid failing if the package is not installed.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { MultiServerMCPClient } = require("@langchain/mcp-adapters");

    const mcpClient = new MultiServerMCPClient(serverEntries);
    const allTools = await mcpClient.getTools();

    // -----------------------------------------------------------------
    // 4. Apply per-server filtering
    // -----------------------------------------------------------------
    //
    // Each tool returned by the client has a `server_name` or `serverName`
    // property indicating which server it came from. We filter by the
    // per-server `tools` allowlist if one was specified.

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const filteredTools: any[] = [];

    for (const tool of allTools) {
      // The adapter may expose the server origin as `serverName` or
      // via the tool's metadata. Try multiple access patterns.
      const toolAny = tool as Record<string, unknown>;
      const toolOrigin =
        (toolAny.server_name as string | undefined) ??
        (toolAny.serverName as string | undefined) ??
        ((toolAny.metadata as Record<string, unknown> | undefined)
          ?.serverName as string | undefined) ??
        null;

      if (toolOrigin && toolOrigin in serverToolFilters) {
        const allowedTools = serverToolFilters[toolOrigin];
        if (allowedTools === null || allowedTools.has(tool.name)) {
          filteredTools.push(tool);
        }
        // else: tool is not in the allowlist, skip it
      } else {
        // If origin is unknown, include the tool (conservative default).
        filteredTools.push(tool);
      }
    }

    console.log(
      `[mcp-tools] MCP tools loaded: count=${filteredTools.length} servers=${JSON.stringify(
        Object.values(serverEntries).map((entry) => safeMaskUrl(entry.url)),
      )}`,
    );

    // Clean up client connections (best-effort)
    try {
      await mcpClient.close();
    } catch {
      // Ignore cleanup errors
    }

    return filteredTools;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[mcp-tools] Failed to fetch MCP tools: ${message}`);
    return [];
  }
}
