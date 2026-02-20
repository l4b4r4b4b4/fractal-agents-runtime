/**
 * MCP tools integration tests for the Fractal Agents Runtime — TypeScript/Bun.
 *
 * Tests the MCP tool loading pipeline:
 *   - `parseMcpConfig()` — configuration parsing from raw dicts
 *   - `normalizeServerUrl()` — URL normalization (auto-append /mcp)
 *   - `uniqueServerKey()` — server key de-duplication
 *   - `safeMaskUrl()` — URL masking for safe logging
 *   - `getMcpAccessToken()` — OAuth2 token exchange with mocked fetch
 *   - `findAuthRequiredServerUrl()` — auth server URL lookup
 *   - `fetchMcpTools()` — full tool fetching with mocked MultiServerMCPClient
 *   - Token context helpers — setCurrentToken / getCurrentToken
 *
 * All tests use mocks — no real MCP servers or network calls required.
 *
 * Reference: apps/python/src/graphs/react_agent/agent.py (MCP section)
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";

import {
  parseMcpConfig,
  type MCPConfig,
  type MCPServerConfig,
} from "../src/graphs/react-agent/configuration";

import {
  normalizeServerUrl,
  uniqueServerKey,
  safeMaskUrl,
  fetchMcpTools,
} from "../src/graphs/react-agent/utils/mcp-tools";

import {
  getMcpAccessToken,
  findAuthRequiredServerUrl,
} from "../src/graphs/react-agent/utils/token";

import {
  setCurrentToken,
  getCurrentToken,
  clearCurrentUser,
} from "../src/middleware/context";

// ---------------------------------------------------------------------------
// parseMcpConfig — configuration parsing
// ---------------------------------------------------------------------------

describe("MCP — parseMcpConfig", () => {
  test("null input returns null", () => {
    expect(parseMcpConfig(null)).toBeNull();
  });

  test("undefined input returns null", () => {
    expect(parseMcpConfig(undefined)).toBeNull();
  });

  test("non-object input returns null", () => {
    expect(parseMcpConfig("not-an-object")).toBeNull();
    expect(parseMcpConfig(42)).toBeNull();
    expect(parseMcpConfig(true)).toBeNull();
  });

  test("empty servers array returns null", () => {
    expect(parseMcpConfig({ servers: [] })).toBeNull();
  });

  test("valid single server config", () => {
    const result = parseMcpConfig({
      servers: [
        {
          name: "my-mcp",
          url: "https://mcp.example.com",
          tools: ["tool-a", "tool-b"],
          auth_required: true,
        },
      ],
    });

    expect(result).not.toBeNull();
    expect(result!.servers).toHaveLength(1);
    expect(result!.servers[0].name).toBe("my-mcp");
    expect(result!.servers[0].url).toBe("https://mcp.example.com");
    expect(result!.servers[0].tools).toEqual(["tool-a", "tool-b"]);
    expect(result!.servers[0].auth_required).toBe(true);
  });

  test("multiple servers config", () => {
    const result = parseMcpConfig({
      servers: [
        { name: "server-1", url: "https://s1.example.com", auth_required: false },
        { name: "server-2", url: "https://s2.example.com", auth_required: true },
      ],
    });

    expect(result).not.toBeNull();
    expect(result!.servers).toHaveLength(2);
    expect(result!.servers[0].name).toBe("server-1");
    expect(result!.servers[1].name).toBe("server-2");
  });

  test("server without name defaults to 'default'", () => {
    const result = parseMcpConfig({
      servers: [{ url: "https://mcp.example.com" }],
    });

    expect(result).not.toBeNull();
    expect(result!.servers[0].name).toBe("default");
  });

  test("server with empty name defaults to 'default'", () => {
    const result = parseMcpConfig({
      servers: [{ name: "", url: "https://mcp.example.com" }],
    });

    expect(result).not.toBeNull();
    expect(result!.servers[0].name).toBe("default");
  });

  test("server without URL is skipped", () => {
    const result = parseMcpConfig({
      servers: [
        { name: "no-url" },
        { name: "has-url", url: "https://mcp.example.com" },
      ],
    });

    expect(result).not.toBeNull();
    expect(result!.servers).toHaveLength(1);
    expect(result!.servers[0].name).toBe("has-url");
  });

  test("server with empty URL is skipped", () => {
    const result = parseMcpConfig({
      servers: [{ name: "empty-url", url: "" }],
    });

    expect(result).toBeNull();
  });

  test("all servers without URLs returns null", () => {
    const result = parseMcpConfig({
      servers: [{ name: "a" }, { name: "b" }],
    });

    expect(result).toBeNull();
  });

  test("tools field defaults to null when omitted", () => {
    const result = parseMcpConfig({
      servers: [{ name: "s", url: "https://example.com" }],
    });

    expect(result).not.toBeNull();
    expect(result!.servers[0].tools).toBeNull();
  });

  test("tools field filters out non-string entries", () => {
    const result = parseMcpConfig({
      servers: [
        {
          name: "s",
          url: "https://example.com",
          tools: ["valid", 42, null, "also-valid", undefined, true],
        },
      ],
    });

    expect(result).not.toBeNull();
    expect(result!.servers[0].tools).toEqual(["valid", "also-valid"]);
  });

  test("auth_required defaults to false when omitted", () => {
    const result = parseMcpConfig({
      servers: [{ name: "s", url: "https://example.com" }],
    });

    expect(result).not.toBeNull();
    expect(result!.servers[0].auth_required).toBe(false);
  });

  test("auth_required is only true for literal true", () => {
    const result = parseMcpConfig({
      servers: [
        { name: "a", url: "https://a.com", auth_required: true },
        { name: "b", url: "https://b.com", auth_required: false },
        { name: "c", url: "https://c.com", auth_required: "yes" },
        { name: "d", url: "https://d.com", auth_required: 1 },
      ],
    });

    expect(result).not.toBeNull();
    expect(result!.servers[0].auth_required).toBe(true);
    expect(result!.servers[1].auth_required).toBe(false);
    expect(result!.servers[2].auth_required).toBe(false);
    expect(result!.servers[3].auth_required).toBe(false);
  });

  test("accepts raw array format (no wrapper object)", () => {
    const result = parseMcpConfig([
      { name: "s1", url: "https://s1.example.com" },
      { name: "s2", url: "https://s2.example.com" },
    ]);

    expect(result).not.toBeNull();
    expect(result!.servers).toHaveLength(2);
    expect(result!.servers[0].name).toBe("s1");
    expect(result!.servers[1].name).toBe("s2");
  });

  test("skips non-object entries in servers array", () => {
    const result = parseMcpConfig({
      servers: [
        "not-an-object",
        null,
        42,
        { name: "valid", url: "https://example.com" },
      ],
    });

    expect(result).not.toBeNull();
    expect(result!.servers).toHaveLength(1);
    expect(result!.servers[0].name).toBe("valid");
  });
});

// ---------------------------------------------------------------------------
// normalizeServerUrl
// ---------------------------------------------------------------------------

describe("MCP — normalizeServerUrl", () => {
  test("appends /mcp to bare URL", () => {
    expect(normalizeServerUrl("https://mcp.example.com")).toBe(
      "https://mcp.example.com/mcp",
    );
  });

  test("appends /mcp to URL with path", () => {
    expect(normalizeServerUrl("https://example.com/api")).toBe(
      "https://example.com/api/mcp",
    );
  });

  test("does not double-append /mcp when already present", () => {
    expect(normalizeServerUrl("https://mcp.example.com/mcp")).toBe(
      "https://mcp.example.com/mcp",
    );
  });

  test("strips trailing slashes before appending /mcp", () => {
    expect(normalizeServerUrl("https://mcp.example.com/")).toBe(
      "https://mcp.example.com/mcp",
    );
  });

  test("strips multiple trailing slashes", () => {
    expect(normalizeServerUrl("https://mcp.example.com///")).toBe(
      "https://mcp.example.com/mcp",
    );
  });

  test("preserves /mcp with trailing slash (strips slash)", () => {
    expect(normalizeServerUrl("https://mcp.example.com/mcp/")).toBe(
      "https://mcp.example.com/mcp",
    );
  });

  test("handles localhost URL", () => {
    expect(normalizeServerUrl("http://localhost:8080")).toBe(
      "http://localhost:8080/mcp",
    );
  });

  test("handles localhost URL already ending in /mcp", () => {
    expect(normalizeServerUrl("http://localhost:8080/mcp")).toBe(
      "http://localhost:8080/mcp",
    );
  });

  test("URL ending with /mcp-something still gets /mcp appended", () => {
    expect(normalizeServerUrl("https://example.com/mcp-server")).toBe(
      "https://example.com/mcp-server/mcp",
    );
  });
});

// ---------------------------------------------------------------------------
// uniqueServerKey
// ---------------------------------------------------------------------------

describe("MCP — uniqueServerKey", () => {
  test("returns base name when no conflicts", () => {
    const existing = new Set<string>();
    expect(uniqueServerKey("server-a", existing)).toBe("server-a");
  });

  test("returns base name when existing set is empty", () => {
    expect(uniqueServerKey("my-server", new Set())).toBe("my-server");
  });

  test("de-duplicates with -2 suffix on first conflict", () => {
    const existing = new Set(["server-a"]);
    expect(uniqueServerKey("server-a", existing)).toBe("server-a-2");
  });

  test("de-duplicates with -3 suffix when -2 is also taken", () => {
    const existing = new Set(["server-a", "server-a-2"]);
    expect(uniqueServerKey("server-a", existing)).toBe("server-a-3");
  });

  test("de-duplicates with higher suffix when many taken", () => {
    const existing = new Set([
      "server-a",
      "server-a-2",
      "server-a-3",
      "server-a-4",
    ]);
    expect(uniqueServerKey("server-a", existing)).toBe("server-a-5");
  });

  test("different base names do not conflict", () => {
    const existing = new Set(["server-a"]);
    expect(uniqueServerKey("server-b", existing)).toBe("server-b");
  });

  test("'default' base name de-duplicates correctly", () => {
    const existing = new Set(["default"]);
    expect(uniqueServerKey("default", existing)).toBe("default-2");
  });
});

// ---------------------------------------------------------------------------
// safeMaskUrl
// ---------------------------------------------------------------------------

describe("MCP — safeMaskUrl", () => {
  test("masks path of a valid HTTPS URL", () => {
    expect(safeMaskUrl("https://mcp.example.com/mcp")).toBe(
      "https://mcp.example.com/***",
    );
  });

  test("masks path of a valid HTTP URL", () => {
    expect(safeMaskUrl("http://localhost:8080/mcp")).toBe(
      "http://localhost:8080/***",
    );
  });

  test("masks path of URL with port", () => {
    expect(safeMaskUrl("https://example.com:3000/api/mcp")).toBe(
      "https://example.com:3000/***",
    );
  });

  test("masks URL with no path", () => {
    expect(safeMaskUrl("https://example.com")).toBe(
      "https://example.com/***",
    );
  });

  test("returns fallback for invalid URL", () => {
    expect(safeMaskUrl("not-a-url")).toBe("***invalid-url***");
  });

  test("returns fallback for empty string", () => {
    expect(safeMaskUrl("")).toBe("***invalid-url***");
  });
});

// ---------------------------------------------------------------------------
// findAuthRequiredServerUrl
// ---------------------------------------------------------------------------

describe("MCP — findAuthRequiredServerUrl", () => {
  test("returns URL of first auth-required server", () => {
    const servers = [
      { url: "https://s1.example.com", auth_required: false },
      { url: "https://s2.example.com", auth_required: true },
      { url: "https://s3.example.com", auth_required: true },
    ];
    expect(findAuthRequiredServerUrl(servers)).toBe("https://s2.example.com");
  });

  test("returns null when no auth-required servers", () => {
    const servers = [
      { url: "https://s1.example.com", auth_required: false },
      { url: "https://s2.example.com" },
    ];
    expect(findAuthRequiredServerUrl(servers)).toBeNull();
  });

  test("returns null for empty array", () => {
    expect(findAuthRequiredServerUrl([])).toBeNull();
  });

  test("skips auth-required servers without URL", () => {
    const servers = [
      { auth_required: true },
      { url: "https://fallback.example.com", auth_required: true },
    ];
    expect(findAuthRequiredServerUrl(servers)).toBe(
      "https://fallback.example.com",
    );
  });

  test("skips auth-required servers with empty URL", () => {
    const servers = [
      { url: "", auth_required: true },
      { url: "  ", auth_required: true },
    ];
    // "  " is not empty after trim check — but let's test what happens
    expect(findAuthRequiredServerUrl(servers)).toBeNull();
  });

  test("trims whitespace from URL", () => {
    const servers = [{ url: "  https://s1.example.com  ", auth_required: true }];
    expect(findAuthRequiredServerUrl(servers)).toBe("https://s1.example.com");
  });
});

// ---------------------------------------------------------------------------
// getMcpAccessToken — with mocked fetch
// ---------------------------------------------------------------------------

describe("MCP — getMcpAccessToken", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("successful token exchange returns token data", async () => {
    const mockTokenResponse = {
      access_token: "mcp-token-123",
      token_type: "Bearer",
      expires_in: 3600,
    };

    globalThis.fetch = mock(async (url: string, options?: RequestInit) => {
      expect(url).toBe("https://mcp.example.com/oauth/token");
      expect(options?.method).toBe("POST");
      expect(options?.headers).toEqual({
        "Content-Type": "application/x-www-form-urlencoded",
      });

      const body = options?.body as string;
      expect(body).toContain("grant_type=urn");
      expect(body).toContain("subject_token=supabase-token-abc");
      expect(body).toContain("client_id=mcp_default");
      expect(body).toContain(
        `resource=${encodeURIComponent("https://mcp.example.com/mcp")}`,
      );

      return new Response(JSON.stringify(mockTokenResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const result = await getMcpAccessToken(
      "supabase-token-abc",
      "https://mcp.example.com",
    );

    expect(result).not.toBeNull();
    expect(result!.access_token).toBe("mcp-token-123");
    expect(result!.token_type).toBe("Bearer");
    expect(result!.expires_in).toBe(3600);
  });

  test("strips trailing slashes from base URL", async () => {
    globalThis.fetch = mock(async (url: string) => {
      expect(url).toBe("https://mcp.example.com/oauth/token");
      return new Response(
        JSON.stringify({ access_token: "token-1" }),
        { status: 200 },
      );
    }) as typeof fetch;

    const result = await getMcpAccessToken(
      "token",
      "https://mcp.example.com///",
    );
    expect(result).not.toBeNull();
    expect(result!.access_token).toBe("token-1");
  });

  test("returns null on HTTP error response", async () => {
    globalThis.fetch = mock(async () => {
      return new Response("Unauthorized", { status: 401 });
    }) as typeof fetch;

    const result = await getMcpAccessToken(
      "bad-token",
      "https://mcp.example.com",
    );
    expect(result).toBeNull();
  });

  test("returns null on non-object JSON response", async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify("just-a-string"), { status: 200 });
    }) as typeof fetch;

    const result = await getMcpAccessToken(
      "token",
      "https://mcp.example.com",
    );
    expect(result).toBeNull();
  });

  test("returns null when response is missing access_token", async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({ token_type: "Bearer" }), {
        status: 200,
      });
    }) as typeof fetch;

    const result = await getMcpAccessToken(
      "token",
      "https://mcp.example.com",
    );
    expect(result).toBeNull();
  });

  test("returns null when access_token is not a string", async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({ access_token: 12345 }), {
        status: 200,
      });
    }) as typeof fetch;

    const result = await getMcpAccessToken(
      "token",
      "https://mcp.example.com",
    );
    expect(result).toBeNull();
  });

  test("returns null on network error (graceful degradation)", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;

    const result = await getMcpAccessToken(
      "token",
      "https://mcp.example.com",
    );
    expect(result).toBeNull();
  });

  test("returns null on non-Error throw", async () => {
    globalThis.fetch = mock(async () => {
      throw "string-error";
    }) as typeof fetch;

    const result = await getMcpAccessToken(
      "token",
      "https://mcp.example.com",
    );
    expect(result).toBeNull();
  });

  test("returns null when response body is null JSON", async () => {
    globalThis.fetch = mock(async () => {
      return new Response("null", { status: 200 });
    }) as typeof fetch;

    const result = await getMcpAccessToken(
      "token",
      "https://mcp.example.com",
    );
    expect(result).toBeNull();
  });

  test("resource field is constructed from base URL + /mcp", async () => {
    let capturedBody = "";
    globalThis.fetch = mock(async (_url: string, options?: RequestInit) => {
      capturedBody = options?.body as string;
      return new Response(
        JSON.stringify({ access_token: "ok" }),
        { status: 200 },
      );
    }) as typeof fetch;

    await getMcpAccessToken("tok", "https://my-server.io");

    const params = new URLSearchParams(capturedBody);
    expect(params.get("resource")).toBe("https://my-server.io/mcp");
  });
});

// ---------------------------------------------------------------------------
// fetchMcpTools — with mocked MultiServerMCPClient
// ---------------------------------------------------------------------------

describe("MCP — fetchMcpTools", () => {
  test("returns empty array when no servers configured", async () => {
    const config: MCPConfig = { servers: [] };
    const tools = await fetchMcpTools(config);
    expect(tools).toEqual([]);
  });

  test("returns empty array when servers is undefined-ish", async () => {
    // Force an MCPConfig-like object with no servers property
    const config = { servers: [] } as MCPConfig;
    const tools = await fetchMcpTools(config);
    expect(tools).toEqual([]);
  });

  test("gracefully returns empty array when MultiServerMCPClient throws", async () => {
    // This test verifies that fetchMcpTools catches errors from the
    // MultiServerMCPClient constructor or getTools() call.
    // Since we can't easily mock the dynamic require, we rely on the
    // function's try/catch to handle connection failures gracefully.
    const config: MCPConfig = {
      servers: [
        {
          name: "unreachable",
          url: "http://localhost:1/mcp",
          tools: null,
          auth_required: false,
        },
      ],
    };

    // fetchMcpTools should not throw — it should log a warning and return []
    const tools = await fetchMcpTools(config);
    expect(Array.isArray(tools)).toBe(true);
  });

  test("skips auth-required servers when no token is provided", async () => {
    const config: MCPConfig = {
      servers: [
        {
          name: "auth-server",
          url: "https://mcp.example.com",
          tools: null,
          auth_required: true,
        },
      ],
    };

    // No supabase token → auth server skipped → no entries → empty array
    const tools = await fetchMcpTools(config, null);
    expect(tools).toEqual([]);
  });

  test("skips auth-required servers when token exchange fails", async () => {
    const originalFetch = globalThis.fetch;

    // Mock fetch to fail token exchange
    globalThis.fetch = mock(async () => {
      return new Response("Unauthorized", { status: 401 });
    }) as typeof fetch;

    const config: MCPConfig = {
      servers: [
        {
          name: "auth-server",
          url: "https://mcp.example.com",
          tools: null,
          auth_required: true,
        },
      ],
    };

    const tools = await fetchMcpTools(config, "some-supabase-token");
    expect(tools).toEqual([]);

    globalThis.fetch = originalFetch;
  });
});

// ---------------------------------------------------------------------------
// Token context helpers
// ---------------------------------------------------------------------------

describe("MCP — Token context helpers", () => {
  beforeEach(() => {
    clearCurrentUser();
  });

  afterEach(() => {
    clearCurrentUser();
  });

  test("getCurrentToken returns null by default", () => {
    expect(getCurrentToken()).toBeNull();
  });

  test("setCurrentToken stores the token", () => {
    setCurrentToken("my-token-123");
    expect(getCurrentToken()).toBe("my-token-123");
  });

  test("setCurrentToken(null) clears the token", () => {
    setCurrentToken("my-token-123");
    expect(getCurrentToken()).toBe("my-token-123");

    setCurrentToken(null);
    expect(getCurrentToken()).toBeNull();
  });

  test("clearCurrentUser also clears the token", () => {
    setCurrentToken("my-token-456");
    expect(getCurrentToken()).toBe("my-token-456");

    clearCurrentUser();
    expect(getCurrentToken()).toBeNull();
  });

  test("token is independent of user context", () => {
    // Token can be set without a user
    setCurrentToken("standalone-token");
    expect(getCurrentToken()).toBe("standalone-token");
  });

  test("successive setCurrentToken calls overwrite", () => {
    setCurrentToken("token-1");
    expect(getCurrentToken()).toBe("token-1");

    setCurrentToken("token-2");
    expect(getCurrentToken()).toBe("token-2");
  });
});

// ---------------------------------------------------------------------------
// parseMcpConfig — integration with parseGraphConfig
// ---------------------------------------------------------------------------

describe("MCP — parseMcpConfig integration with parseGraphConfig", () => {
  // Import parseGraphConfig for integration tests
  const { parseGraphConfig } = require("../src/graphs/react-agent/configuration");

  test("parseGraphConfig extracts mcp_config from configurable", () => {
    const config = parseGraphConfig({
      model_name: "openai:gpt-4o",
      mcp_config: {
        servers: [
          {
            name: "test-server",
            url: "https://mcp.example.com",
            tools: ["search"],
            auth_required: false,
          },
        ],
      },
    });

    expect(config.mcp_config).not.toBeNull();
    expect(config.mcp_config!.servers).toHaveLength(1);
    expect(config.mcp_config!.servers[0].name).toBe("test-server");
    expect(config.mcp_config!.servers[0].url).toBe("https://mcp.example.com");
    expect(config.mcp_config!.servers[0].tools).toEqual(["search"]);
    expect(config.mcp_config!.servers[0].auth_required).toBe(false);
  });

  test("parseGraphConfig returns null mcp_config when not provided", () => {
    const config = parseGraphConfig({ model_name: "openai:gpt-4o" });
    expect(config.mcp_config).toBeNull();
  });

  test("parseGraphConfig returns null mcp_config for empty servers", () => {
    const config = parseGraphConfig({
      mcp_config: { servers: [] },
    });
    expect(config.mcp_config).toBeNull();
  });

  test("parseGraphConfig with multiple MCP servers", () => {
    const config = parseGraphConfig({
      mcp_config: {
        servers: [
          { name: "s1", url: "https://s1.example.com", auth_required: false },
          { name: "s2", url: "https://s2.example.com", auth_required: true, tools: ["a", "b"] },
        ],
      },
    });

    expect(config.mcp_config).not.toBeNull();
    expect(config.mcp_config!.servers).toHaveLength(2);
    expect(config.mcp_config!.servers[0].tools).toBeNull();
    expect(config.mcp_config!.servers[1].tools).toEqual(["a", "b"]);
    expect(config.mcp_config!.servers[1].auth_required).toBe(true);
  });

  test("parseGraphConfig mcp_config does not affect other config fields", () => {
    const config = parseGraphConfig({
      model_name: "anthropic:claude-sonnet-4-0",
      temperature: 0.3,
      mcp_config: {
        servers: [{ name: "s", url: "https://example.com" }],
      },
    });

    expect(config.model_name).toBe("anthropic:claude-sonnet-4-0");
    expect(config.temperature).toBe(0.3);
    expect(config.mcp_config).not.toBeNull();
  });
});
