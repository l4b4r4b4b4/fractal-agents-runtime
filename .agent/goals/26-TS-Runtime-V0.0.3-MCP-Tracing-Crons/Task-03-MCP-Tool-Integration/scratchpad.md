# Task-03: MCP Tool Integration in Agent

**Goal:** 26 — TS Runtime v0.0.3  
**Status:** 🟢 Complete  
**Sessions:** 25 (partial), 26 (completed)

---

## Objective

Dynamic tool loading from remote MCP servers at agent construction time, with OAuth2 token exchange for auth-required servers. Port of the Python runtime's MCP tool integration (`apps/python/src/graphs/react_agent/agent.py` lines 339–416).

---

## Implementation Summary

### Files Created
- `src/graphs/react-agent/utils/token.ts` — OAuth2 token exchange (RFC 8693)
  - `getMcpAccessToken(supabaseToken, baseMcpUrl)` → `McpTokenData | null`
  - `findAuthRequiredServerUrl(servers)` → `string | null`
- `src/graphs/react-agent/utils/mcp-tools.ts` — MCP tool fetcher
  - `fetchMcpTools(mcpConfig, supabaseToken?)` → `DynamicStructuredTool[]`
  - `normalizeServerUrl(rawUrl)` — auto-append `/mcp`
  - `uniqueServerKey(baseName, existingKeys)` — de-duplication
  - `safeMaskUrl(url)` — safe logging
- `tests/mcp-tools.test.ts` — 71 tests covering all MCP utilities

### Files Modified
- `src/graphs/react-agent/configuration.ts`
  - Added `MCPServerConfig`, `MCPConfig` types
  - Added `mcp_config: MCPConfig | null` to `GraphConfigValues`
  - Exported `parseMcpConfig()` for testing
- `src/graphs/react-agent/agent.ts`
  - Imports `fetchMcpTools` from `./utils/mcp-tools`
  - Extracts `x-supabase-access-token` from config dict
  - Calls `fetchMcpTools()` when `mcp_config` is set
  - Passes returned tools to `createAgent({ model, tools, ... })`
- `src/middleware/context.ts`
  - Added `setCurrentToken()` / `getCurrentToken()` / `clearCurrentToken()`
  - `clearCurrentUser()` now also clears token
- `src/middleware/auth.ts`
  - Calls `setCurrentToken(token)` after successful JWT verification
- `src/routes/runs.ts`
  - `buildRunnableConfig()` injects `x-supabase-access-token` from context
  - Imported `getCurrentToken` from context module
- `tests/graphs-configuration.test.ts`
  - Updated field count assertions from 7 → 8 (added `mcp_config`)
  - Added `mcp_config` to expected keys and nullable field checks

### Dependencies Added (Session 25)
- `@langchain/mcp-adapters@^1.1.3`

---

## Architecture: Token Plumbing

```
Request → auth middleware → setCurrentToken(bearerToken)
                          → setCurrentUser(verifiedUser)
                              ↓
Route handler → buildRunnableConfig() → getCurrentToken()
                                      → configurable["x-supabase-access-token"] = token
                                          ↓
Graph factory → config["x-supabase-access-token"]
              → fetchMcpTools(mcpConfig, supabaseToken)
                  → getMcpAccessToken() (OAuth2 exchange)
                  → MultiServerMCPClient({ headers: { Authorization } })
                  → client.getTools() → filter by allowlist
                      ↓
              → createAgent({ model, tools, systemPrompt })
```

---

## Test Coverage

**71 new tests** in `tests/mcp-tools.test.ts`:

| Category | Count | Description |
|----------|-------|-------------|
| `parseMcpConfig` | 17 | null, undefined, non-object, empty, valid, defaults, filtering |
| `normalizeServerUrl` | 9 | bare URL, /mcp suffix, trailing slashes, localhost |
| `uniqueServerKey` | 7 | no conflict, -2/-3/-5 suffix, different bases, "default" |
| `safeMaskUrl` | 6 | HTTPS, HTTP, port, no path, invalid, empty |
| `findAuthRequiredServerUrl` | 6 | first auth, no auth, empty, no URL, empty URL, trim |
| `getMcpAccessToken` | 10 | success, trailing slash, HTTP error, non-object, missing/invalid token, network error, null, resource field |
| `fetchMcpTools` | 5 | empty servers, undefined-ish, connection failure, no token, failed exchange |
| Token context helpers | 6 | get/set/clear, clearCurrentUser clears token, overwrite |
| parseGraphConfig integration | 5 | extract mcp_config, null, empty, multiple servers, no side effects |

**Total test suite: 1156 tests, 0 failures** (up from 1085).

---

## Acceptance Criteria

- [x] Agent loads tools from configured MCP servers at construction time
- [x] MCP tool definitions converted to LangChain tool format correctly (via `@langchain/mcp-adapters`)
- [x] `auth_required` servers receive OAuth token in connection headers
- [x] `tools` allowlist filters which tools are exposed from each server
- [x] Unreachable MCP server logs warning and agent continues without those tools
- [x] Multiple MCP servers supported simultaneously (unique key de-duplication)
- [x] Supabase access token flows from auth middleware → configurable → graph factory
- [x] Tests pass with mocked MCP server (no real server needed)
- [x] Existing test suite (1085 tests) unaffected — all pass
- [x] TypeScript diagnostics clean (no new errors)

---

## Notes

- The `@langchain/mcp-adapters` `MultiServerMCPClient` is imported dynamically via `require()` to avoid hard failure if the package is missing. This matches the graceful degradation pattern.
- Per-server tool filtering relies on the `server_name` / `serverName` / `metadata.serverName` property on returned tools. If origin is unknown, tools are included (conservative default).
- Token exchange uses the first auth-required server's URL to determine the `/oauth/token` endpoint. All auth-required servers share the same MCP access token (matching Python behavior).
- The `parseMcpConfig` function accepts both `{ servers: [...] }` and raw array `[...]` formats for flexibility.