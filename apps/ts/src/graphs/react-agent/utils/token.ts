/**
 * MCP token exchange utilities for the Fractal Agents Runtime — TypeScript/Bun.
 *
 * Handles OAuth2 token exchange with MCP servers. When an MCP server requires
 * authentication (`auth_required: true`), the runtime exchanges the user's
 * Supabase access token for an MCP-scoped access token via the standard
 * `urn:ietf:params:oauth:grant-type:token-exchange` grant type.
 *
 * Port of: apps/python/src/graphs/react_agent/utils/token.py
 *
 * Usage:
 *
 *   import { getMcpAccessToken } from "./utils/token";
 *
 *   const tokenData = await getMcpAccessToken(supabaseToken, baseMcpUrl);
 *   if (tokenData) {
 *     headers["Authorization"] = `Bearer ${tokenData.access_token}`;
 *   }
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Token data returned by the MCP OAuth2 token exchange endpoint.
 *
 * Follows the standard OAuth2 token response shape.
 */
export interface McpTokenData {
  /** The access token for authenticating with MCP servers. */
  access_token: string;

  /** Token type — typically "Bearer". */
  token_type?: string;

  /** Token lifetime in seconds (used for caching/expiry checks). */
  expires_in?: number;

  /** Optional refresh token. */
  refresh_token?: string;

  /** Additional fields from the token response. */
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Exchange a Supabase token for an MCP access token.
 *
 * Performs an OAuth2 token exchange (RFC 8693) against the MCP server's
 * `/oauth/token` endpoint. The Supabase access token is used as the
 * `subject_token` and the MCP server's `/mcp` endpoint is the `resource`.
 *
 * @param supabaseToken - The Supabase access token to exchange.
 * @param baseMcpUrl - The base URL for the MCP server (e.g., "https://mcp.example.com").
 * @returns The token data if successful, `null` otherwise.
 */
export async function getMcpAccessToken(
  supabaseToken: string,
  baseMcpUrl: string,
): Promise<McpTokenData | null> {
  try {
    const normalizedBaseUrl = baseMcpUrl.replace(/\/+$/, "");
    const tokenEndpoint = `${normalizedBaseUrl}/oauth/token`;
    const mcpResource = `${normalizedBaseUrl}/mcp`;

    const formData = new URLSearchParams({
      client_id: "mcp_default",
      subject_token: supabaseToken,
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      resource: mcpResource,
      subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
    });

    const response = await fetch(tokenEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: formData.toString(),
    });

    if (!response.ok) {
      const responseText = await response.text();
      console.warn(
        `[mcp-token] Token exchange failed: status=${response.status} body=${responseText}`,
      );
      return null;
    }

    const tokenData = await response.json();

    if (typeof tokenData !== "object" || tokenData === null) {
      console.warn("[mcp-token] Token exchange returned non-object response");
      return null;
    }

    const result = tokenData as McpTokenData;

    if (!result.access_token || typeof result.access_token !== "string") {
      console.warn("[mcp-token] Token exchange response missing access_token");
      return null;
    }

    return result;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[mcp-token] Error during token exchange: ${message}`);
    return null;
  }
}

/**
 * Find the first auth-required MCP server URL from a list of server configs.
 *
 * Used to determine which server's `/oauth/token` endpoint to call for
 * token exchange. Returns `null` if no auth-required servers are found.
 *
 * @param servers - Array of MCP server configuration objects.
 * @returns The base URL of the first auth-required server, or `null`.
 */
export function findAuthRequiredServerUrl(
  servers: Array<{ url?: string; auth_required?: boolean }>,
): string | null {
  for (const server of servers) {
    if (!server.auth_required) {
      continue;
    }
    if (typeof server.url === "string" && server.url.trim().length > 0) {
      return server.url.trim();
    }
  }
  return null;
}
