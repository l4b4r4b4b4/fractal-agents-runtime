/**
 * Unit tests for the Agent Sync module.
 *
 * Covers all components of `src/agent-sync/`:
 *   - Types & factory functions (types.ts)
 *   - Scope parsing (scope.ts)
 *   - Row parsing & SQL builders (queries.ts)
 *   - Config mapping (config-mapping.ts)
 *   - Sync orchestration (sync.ts)
 *
 * Test structure mirrors Python's `test_agent_sync_unit.py` (174 symbols).
 * Uses mock storage and mock SQL client — no real database needed.
 *
 * Reference: apps/python/src/server/tests/test_agent_sync_unit.py
 */

import { describe, it, expect, beforeEach } from "bun:test";
import type { Sql } from "postgres";

// Types & factories
import type {
  AgentSyncMcpTool,
  AgentSyncData,
  AgentSyncScope,
  AgentSyncResult,
  AgentSyncSummary,
} from "../src/agent-sync/types";
import { scopeNone, scopeAll, scopeOrgs } from "../src/agent-sync/types";

// Scope parsing
import {
  parseAgentSyncScope,
  isValidUuid,
} from "../src/agent-sync/scope";

// Query helpers
import {
  coerceUuid,
  toBoolOrNull,
  addMcpToolFromRow,
  agentFromRow,
  groupAgentRows,
  buildFetchAgentsSql,
} from "../src/agent-sync/queries";

// Config mapping
import {
  safeMaskUrl,
  buildAssistantConfigurable,
  assistantPayloadForAgent,
  extractAssistantConfigurable,
} from "../src/agent-sync/config-mapping";

// Sync orchestration
import type { AgentSyncStorage } from "../src/agent-sync/sync";
import {
  writeBackLanggraphAssistantId,
  syncSingleAgent,
  startupAgentSync,
  lazySyncAgent,
} from "../src/agent-sync/sync";

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const AGENT_UUID = "a0000000-0000-4000-a000-000000000001";
const ORG_UUID = "00000000-0000-4000-0000-000000000099";

// ---------------------------------------------------------------------------
// Mock infrastructure
// ---------------------------------------------------------------------------

/**
 * Fake assistant storage for sync tests.
 *
 * Tracks create/update calls and allows pre-seeding assistants.
 */
class FakeAssistants {
  _store: Map<string, Record<string, unknown>> = new Map();
  createCalls: Array<[Record<string, unknown>, string | undefined]> = [];
  updateCalls: Array<
    [string, Record<string, unknown>, string | undefined]
  > = [];

  async get(
    assistantId: string,
    _ownerId?: string,
  ): Promise<Record<string, unknown> | null> {
    return this._store.get(assistantId) ?? null;
  }

  async create(
    payload: Record<string, unknown>,
    ownerId?: string,
  ): Promise<Record<string, unknown>> {
    this.createCalls.push([payload, ownerId]);
    const assistantId =
      (payload.assistant_id as string) ?? "generated-id";
    const obj: Record<string, unknown> = {
      assistant_id: assistantId,
      config: payload.config ?? {},
      metadata: payload.metadata ?? {},
    };
    this._store.set(assistantId, obj);
    return obj;
  }

  async update(
    assistantId: string,
    payload: Record<string, unknown>,
    ownerId?: string,
  ): Promise<Record<string, unknown>> {
    this.updateCalls.push([assistantId, payload, ownerId]);
    const obj: Record<string, unknown> = {
      assistant_id: assistantId,
      config: payload.config ?? {},
      metadata: payload.metadata ?? {},
    };
    this._store.set(assistantId, obj);
    return obj;
  }

  /**
   * Pre-populate an assistant in the fake store.
   */
  seed(
    assistantId: string,
    configDict?: Record<string, unknown>,
    metadata?: Record<string, unknown>,
  ): void {
    this._store.set(assistantId, {
      assistant_id: assistantId,
      config: configDict ?? {},
      metadata: metadata ?? {},
    });
  }
}

class FakeStorage implements AgentSyncStorage {
  assistants: FakeAssistants;

  constructor() {
    this.assistants = new FakeAssistants();
  }
}

/**
 * Create a mock Sql client that returns preset rows on `unsafe()` calls.
 *
 * Each call to `sql.unsafe()` returns the next set of rows in the queue.
 * Records all executed queries for assertions.
 */
function createMockSql(
  ...rowSets: Array<Record<string, unknown>[]>
): { sql: Sql; queries: Array<{ query: string; params: unknown[] }> } {
  const queries: Array<{ query: string; params: unknown[] }> = [];
  let callIndex = 0;

  const mockSql = {
    unsafe(query: string, params?: unknown[]) {
      queries.push({ query, params: params ?? [] });
      const rows = callIndex < rowSets.length ? rowSets[callIndex] : [];
      callIndex++;
      // Simulate postgres.js result: array with .count property
      const result = [...rows] as any;
      result.count = rows.length;
      return Promise.resolve(result);
    },
  } as unknown as Sql;

  return { sql: mockSql, queries };
}

/**
 * Create a mock Sql client where `unsafe()` throws an error.
 */
function createFailingSql(errorMessage: string = "DB down"): Sql {
  return {
    unsafe() {
      throw new Error(errorMessage);
    },
  } as unknown as Sql;
}

// ---------------------------------------------------------------------------
// Helpers for building test data
// ---------------------------------------------------------------------------

function makeAgent(overrides: Partial<AgentSyncData> = {}): AgentSyncData {
  return {
    agentId: AGENT_UUID,
    organizationId: ORG_UUID,
    name: "Test Agent",
    systemPrompt: "You are a test agent.",
    temperature: null,
    maxTokens: null,
    runtimeModelName: "openai:gpt-4o-mini",
    graphId: "agent",
    langgraphAssistantId: null,
    mcpTools: [],
    ...overrides,
  };
}

function makeAgentRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    agent_id: AGENT_UUID,
    organization_id: ORG_UUID,
    name: "Test Agent",
    system_prompt: "You are a test agent.",
    temperature: null,
    max_tokens: null,
    langgraph_assistant_id: null,
    graph_id: "agent",
    runtime_model_name: "openai:gpt-4o-mini",
    mcp_tool_id: null,
    mcp_tool_name: null,
    mcp_endpoint_url: null,
    mcp_is_builtin: null,
    mcp_auth_required: null,
    ...overrides,
  };
}

function randomUuid(): string {
  return crypto.randomUUID();
}

// ============================================================================
// Data model tests
// ============================================================================

describe("AgentSyncMcpTool", () => {
  it("has null defaults", () => {
    const tool: AgentSyncMcpTool = {
      toolId: null,
      toolName: null,
      endpointUrl: null,
      isBuiltin: null,
      authRequired: null,
    };
    expect(tool.toolId).toBeNull();
    expect(tool.toolName).toBeNull();
    expect(tool.endpointUrl).toBeNull();
    expect(tool.isBuiltin).toBeNull();
    expect(tool.authRequired).toBeNull();
  });

  it("accepts values", () => {
    const toolId = randomUuid();
    const tool: AgentSyncMcpTool = {
      toolId,
      toolName: "search",
      endpointUrl: "https://mcp.example.com",
      isBuiltin: false,
      authRequired: true,
    };
    expect(tool.toolId).toBe(toolId);
    expect(tool.toolName).toBe("search");
    expect(tool.authRequired).toBe(true);
  });
});

describe("AgentSyncData", () => {
  it("minimal agent", () => {
    const agent: AgentSyncData = {
      agentId: AGENT_UUID,
      organizationId: null,
      name: null,
      systemPrompt: null,
      temperature: null,
      maxTokens: null,
      runtimeModelName: null,
      graphId: null,
      langgraphAssistantId: null,
      mcpTools: [],
    };
    expect(agent.agentId).toBe(AGENT_UUID);
    expect(agent.organizationId).toBeNull();
    expect(agent.mcpTools).toEqual([]);
    expect(agent.name).toBeNull();
  });

  it("full agent", () => {
    const agent = makeAgent({
      temperature: 0.7,
      maxTokens: 1024,
      graphId: "custom",
    });
    expect(agent.temperature).toBe(0.7);
    expect(agent.maxTokens).toBe(1024);
    expect(agent.graphId).toBe("custom");
  });
});

describe("AgentSyncResult", () => {
  it("created result", () => {
    const result: AgentSyncResult = {
      assistantId: "abc",
      action: "created",
      wroteBackAssistantId: false,
    };
    expect(result.assistantId).toBe("abc");
    expect(result.action).toBe("created");
    expect(result.wroteBackAssistantId).toBe(false);
  });

  it("with write-back", () => {
    const result: AgentSyncResult = {
      assistantId: "abc",
      action: "updated",
      wroteBackAssistantId: true,
    };
    expect(result.wroteBackAssistantId).toBe(true);
  });
});

// ============================================================================
// AgentSyncScope + parseAgentSyncScope
// ============================================================================

describe("AgentSyncScope factories", () => {
  it("scopeNone", () => {
    const scope = scopeNone();
    expect(scope.type).toBe("none");
    expect(scope.organizationIds).toEqual([]);
  });

  it("scopeAll", () => {
    const scope = scopeAll();
    expect(scope.type).toBe("all");
    expect(scope.organizationIds).toEqual([]);
  });

  it("scopeOrgs", () => {
    const org1 = randomUuid();
    const org2 = randomUuid();
    const scope = scopeOrgs([org1, org2]);
    expect(scope.type).toBe("org");
    expect(scope.organizationIds).toEqual([org1, org2]);
  });

  it("scopeOrgs deduplicates", () => {
    const org = randomUuid();
    const scope = scopeOrgs([org, org, org]);
    expect(scope.organizationIds).toHaveLength(1);
  });
});

describe("isValidUuid", () => {
  it("accepts valid UUID", () => {
    expect(isValidUuid("a0000000-0000-4000-a000-000000000001")).toBe(true);
  });

  it("accepts uppercase UUID", () => {
    expect(isValidUuid("A0000000-0000-4000-A000-000000000001")).toBe(true);
  });

  it("rejects invalid string", () => {
    expect(isValidUuid("not-a-uuid")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isValidUuid("")).toBe(false);
  });
});

describe("parseAgentSyncScope", () => {
  it("none string", () => {
    expect(parseAgentSyncScope("none").type).toBe("none");
  });

  it("none default (undefined)", () => {
    expect(parseAgentSyncScope(undefined).type).toBe("none");
  });

  it("none default (null)", () => {
    expect(parseAgentSyncScope(null).type).toBe("none");
  });

  it("empty string", () => {
    expect(parseAgentSyncScope("").type).toBe("none");
  });

  it("whitespace only", () => {
    expect(parseAgentSyncScope("  ").type).toBe("none");
  });

  it("all", () => {
    const scope = parseAgentSyncScope("all");
    expect(scope.type).toBe("all");
  });

  it("all case insensitive", () => {
    expect(parseAgentSyncScope("ALL").type).toBe("all");
    expect(parseAgentSyncScope("All").type).toBe("all");
  });

  it("single org", () => {
    const orgId = "11111111-1111-1111-1111-111111111111";
    const scope = parseAgentSyncScope(`org:${orgId}`);
    expect(scope.type).toBe("org");
    expect(scope.organizationIds).toHaveLength(1);
    expect(scope.organizationIds[0]).toBe(orgId);
  });

  it("multiple orgs", () => {
    const org1 = "11111111-1111-1111-1111-111111111111";
    const org2 = "22222222-2222-2222-2222-222222222222";
    const scope = parseAgentSyncScope(`org:${org1},org:${org2}`);
    expect(scope.type).toBe("org");
    expect(scope.organizationIds).toHaveLength(2);
  });

  it("invalid entry throws", () => {
    expect(() => parseAgentSyncScope("bad:value")).toThrow(
      "Invalid AGENT_SYNC_SCOPE entry",
    );
  });

  it("invalid UUID throws", () => {
    expect(() => parseAgentSyncScope("org:not-a-uuid")).toThrow(
      "Invalid organization UUID",
    );
  });

  it("org with whitespace", () => {
    const orgId = "11111111-1111-1111-1111-111111111111";
    const scope = parseAgentSyncScope(`  org:${orgId}  `);
    expect(scope.type).toBe("org");
  });

  it("empty orgs after split returns none", () => {
    const scope = parseAgentSyncScope(",,,");
    expect(scope.type).toBe("none");
  });
});

// ============================================================================
// Coercion helpers
// ============================================================================

describe("coerceUuid", () => {
  it("returns null for null", () => {
    expect(coerceUuid(null)).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(coerceUuid(undefined)).toBeNull();
  });

  it("passes through valid UUID string", () => {
    const uid = "a0000000-0000-4000-a000-000000000001";
    expect(coerceUuid(uid)).toBe(uid);
  });

  it("returns null for invalid string", () => {
    expect(coerceUuid("not-a-uuid")).toBeNull();
  });

  it("returns null for number", () => {
    expect(coerceUuid(12345)).toBeNull();
  });
});

describe("toBoolOrNull", () => {
  it("returns null for null", () => {
    expect(toBoolOrNull(null)).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(toBoolOrNull(undefined)).toBeNull();
  });

  it("returns true for true", () => {
    expect(toBoolOrNull(true)).toBe(true);
  });

  it("returns false for false", () => {
    expect(toBoolOrNull(false)).toBe(false);
  });

  it("returns true for truthy int (1)", () => {
    expect(toBoolOrNull(1)).toBe(true);
  });

  it("returns false for falsy int (0)", () => {
    expect(toBoolOrNull(0)).toBe(false);
  });

  it("returns true for truthy strings", () => {
    for (const val of ["true", "True", "TRUE", "t", "1", "yes", "y"]) {
      expect(toBoolOrNull(val)).toBe(true);
    }
  });

  it("returns false for falsy strings", () => {
    for (const val of ["false", "False", "FALSE", "f", "0", "no", "n"]) {
      expect(toBoolOrNull(val)).toBe(false);
    }
  });

  it("returns null for unrecognized string", () => {
    expect(toBoolOrNull("maybe")).toBeNull();
  });

  it("returns null for other types", () => {
    expect(toBoolOrNull([1, 2])).toBeNull();
  });
});

// ============================================================================
// safeMaskUrl
// ============================================================================

describe("safeMaskUrl", () => {
  it("returns null for null", () => {
    expect(safeMaskUrl(null)).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(safeMaskUrl(undefined)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(safeMaskUrl("")).toBeNull();
  });

  it("preserves plain URL", () => {
    expect(safeMaskUrl("https://example.com/api")).toBe(
      "https://example.com/api",
    );
  });

  it("strips query string", () => {
    expect(safeMaskUrl("https://example.com?token=secret")).toBe(
      "https://example.com",
    );
  });

  it("strips fragment", () => {
    expect(safeMaskUrl("https://example.com#section")).toBe(
      "https://example.com",
    );
  });

  it("strips both query and fragment", () => {
    expect(safeMaskUrl("https://example.com?a=b#c")).toBe(
      "https://example.com",
    );
  });
});

// ============================================================================
// Row parsing and grouping
// ============================================================================

describe("addMcpToolFromRow", () => {
  it("adds tool when present", () => {
    const agent = makeAgent({ mcpTools: [] });
    const toolId = randomUuid();
    const row = {
      mcp_tool_id: toolId,
      mcp_tool_name: "search",
      mcp_endpoint_url: "https://mcp.example.com",
      mcp_is_builtin: false,
      mcp_auth_required: true,
    };

    addMcpToolFromRow(agent, row);

    expect(agent.mcpTools).toHaveLength(1);
    expect(agent.mcpTools[0].toolName).toBe("search");
    expect(agent.mcpTools[0].authRequired).toBe(true);
  });

  it("skips when all null", () => {
    const agent = makeAgent({ mcpTools: [] });
    const row = {
      mcp_tool_id: null,
      mcp_tool_name: null,
      mcp_endpoint_url: null,
    };

    addMcpToolFromRow(agent, row);

    expect(agent.mcpTools).toHaveLength(0);
  });

  it("adds tool with partial fields", () => {
    const agent = makeAgent({ mcpTools: [] });
    const row = {
      mcp_tool_id: null,
      mcp_tool_name: "partial",
      mcp_endpoint_url: null,
      mcp_is_builtin: null,
      mcp_auth_required: null,
    };

    addMcpToolFromRow(agent, row);

    expect(agent.mcpTools).toHaveLength(1);
    expect(agent.mcpTools[0].toolName).toBe("partial");
  });
});

describe("agentFromRow", () => {
  it("basic row", () => {
    const row = makeAgentRow();
    const agent = agentFromRow(row);

    expect(agent.agentId).toBe(AGENT_UUID);
    expect(agent.organizationId).toBe(ORG_UUID);
    expect(agent.name).toBe("Test Agent");
    expect(agent.runtimeModelName).toBe("openai:gpt-4o-mini");
  });

  it("row with id instead of agent_id", () => {
    const row = makeAgentRow();
    row.id = row.agent_id;
    delete row.agent_id;
    const agent = agentFromRow(row);
    expect(agent.agentId).toBe(AGENT_UUID);
  });

  it("missing agent_id raises", () => {
    const row = { organization_id: ORG_UUID };
    expect(() => agentFromRow(row)).toThrow("missing agent_id");
  });

  it("row with temperature and max_tokens", () => {
    const row = makeAgentRow({ temperature: 0.5, max_tokens: 512 });
    const agent = agentFromRow(row);
    expect(agent.temperature).toBe(0.5);
    expect(agent.maxTokens).toBe(512);
  });

  it("row with null temperature and max_tokens", () => {
    const row = makeAgentRow({ temperature: null, max_tokens: null });
    const agent = agentFromRow(row);
    expect(agent.temperature).toBeNull();
    expect(agent.maxTokens).toBeNull();
  });

  it("row with MCP tool", () => {
    const toolId = randomUuid();
    const row = makeAgentRow({
      mcp_tool_id: toolId,
      mcp_tool_name: "search",
      mcp_endpoint_url: "https://mcp.example.com",
    });
    const agent = agentFromRow(row);
    expect(agent.mcpTools).toHaveLength(1);
  });

  it("row with null optional strings", () => {
    const row = makeAgentRow({
      name: null,
      system_prompt: null,
      runtime_model_name: null,
      graph_id: null,
      langgraph_assistant_id: null,
    });
    const agent = agentFromRow(row);
    expect(agent.name).toBeNull();
    expect(agent.systemPrompt).toBeNull();
    expect(agent.runtimeModelName).toBeNull();
    expect(agent.graphId).toBeNull();
    expect(agent.langgraphAssistantId).toBeNull();
  });

  it("row with numeric name (string coercion)", () => {
    const row = makeAgentRow({ name: 123 });
    const agent = agentFromRow(row);
    expect(agent.name).toBe("123");
  });
});

describe("groupAgentRows", () => {
  it("single agent single row", () => {
    const rows = [makeAgentRow()];
    const agents = groupAgentRows(rows);
    expect(agents).toHaveLength(1);
    expect(agents[0].agentId).toBe(AGENT_UUID);
  });

  it("single agent multiple tools", () => {
    const tool1 = randomUuid();
    const tool2 = randomUuid();
    const rows = [
      makeAgentRow({
        mcp_tool_id: tool1,
        mcp_tool_name: "tool-1",
        mcp_endpoint_url: "https://a.com",
      }),
      makeAgentRow({
        mcp_tool_id: tool2,
        mcp_tool_name: "tool-2",
        mcp_endpoint_url: "https://b.com",
      }),
    ];
    const agents = groupAgentRows(rows);
    expect(agents).toHaveLength(1);
    expect(agents[0].mcpTools).toHaveLength(2);
  });

  it("multiple agents", () => {
    const uid1 = randomUuid();
    const uid2 = randomUuid();
    const rows = [
      makeAgentRow({ agent_id: uid1, name: "Agent A" }),
      makeAgentRow({ agent_id: uid2, name: "Agent B" }),
    ];
    const agents = groupAgentRows(rows);
    expect(agents).toHaveLength(2);
  });

  it("sorts by org, name, id", () => {
    const orgA = "00000000-0000-0000-0000-000000000001";
    const orgB = "00000000-0000-0000-0000-000000000002";
    const uid1 = randomUuid();
    const uid2 = randomUuid();
    const rows = [
      makeAgentRow({
        agent_id: uid1,
        organization_id: orgB,
        name: "Z Agent",
      }),
      makeAgentRow({
        agent_id: uid2,
        organization_id: orgA,
        name: "A Agent",
      }),
    ];
    const agents = groupAgentRows(rows);
    expect(agents[0].organizationId).toBe(orgA);
  });

  it("skips rows without agent_id", () => {
    const rows = [{ name: "no id" }];
    const agents = groupAgentRows(rows);
    expect(agents).toHaveLength(0);
  });

  it("empty rows", () => {
    expect(groupAgentRows([])).toEqual([]);
  });
});

// ============================================================================
// SQL builder
// ============================================================================

describe("buildFetchAgentsSql", () => {
  it("all scope produces correct SQL", () => {
    const [query, params] = buildFetchAgentsSql(scopeAll());
    expect(query).toContain("public.agents");
    expect(query).toContain("status = 'active'");
    expect(query).not.toContain("organization_id = ANY");
    expect(params).toEqual([]);
  });

  it("org scope produces correct SQL and params", () => {
    const org = randomUuid();
    const [query, params] = buildFetchAgentsSql(scopeOrgs([org]));
    expect(query).toContain("organization_id = ANY");
    expect(params).toHaveLength(1);
    expect((params[0] as string[])[0]).toBe(org);
  });

  it("none scope throws", () => {
    expect(() => buildFetchAgentsSql(scopeNone())).toThrow("scope=none");
  });
});

// ============================================================================
// buildAssistantConfigurable
// ============================================================================

describe("buildAssistantConfigurable", () => {
  it("basic agent", () => {
    const agent = makeAgent();
    const config = buildAssistantConfigurable(agent);

    expect(config.model_name).toBe("openai:gpt-4o-mini");
    expect(config.system_prompt).toBe("You are a test agent.");
    expect(config.supabase_organization_id).toBe(ORG_UUID);
  });

  it("agent with temperature and max_tokens", () => {
    const agent = makeAgent({ temperature: 0.5, maxTokens: 1024 });
    const config = buildAssistantConfigurable(agent);
    expect(config.temperature).toBe(0.5);
    expect(config.max_tokens).toBe(1024);
  });

  it("agent without optional fields", () => {
    const agent: AgentSyncData = {
      agentId: AGENT_UUID,
      organizationId: null,
      name: null,
      systemPrompt: null,
      temperature: null,
      maxTokens: null,
      runtimeModelName: null,
      graphId: null,
      langgraphAssistantId: null,
      mcpTools: [],
    };
    const config = buildAssistantConfigurable(agent);
    expect(config).not.toHaveProperty("model_name");
    expect(config).not.toHaveProperty("system_prompt");
    expect(config).not.toHaveProperty("supabase_organization_id");
    expect(config).not.toHaveProperty("temperature");
    expect(config).not.toHaveProperty("max_tokens");
  });

  it("agent with MCP tools (same endpoint grouped)", () => {
    const tools: AgentSyncMcpTool[] = [
      {
        toolId: randomUuid(),
        toolName: "search",
        endpointUrl: "https://mcp1.example.com",
        isBuiltin: false,
        authRequired: true,
      },
      {
        toolId: randomUuid(),
        toolName: "embed",
        endpointUrl: "https://mcp1.example.com",
        isBuiltin: false,
        authRequired: false,
      },
    ];
    const agent = makeAgent({ mcpTools: tools });
    const config = buildAssistantConfigurable(agent);

    expect(config).toHaveProperty("mcp_config");
    const mcpConfig = config.mcp_config as {
      servers: Array<{
        name: string;
        url: string;
        tools: string[];
        auth_required: boolean;
      }>;
    };
    expect(mcpConfig.servers).toHaveLength(1);
    expect(mcpConfig.servers[0].tools).toContain("search");
    expect(mcpConfig.servers[0].tools).toContain("embed");
    // auth_required is OR'd: true because at least one tool requires it
    expect(mcpConfig.servers[0].auth_required).toBe(true);
  });

  it("multiple MCP servers", () => {
    const tools: AgentSyncMcpTool[] = [
      {
        toolId: null,
        toolName: "tool-a",
        endpointUrl: "https://a.com",
        isBuiltin: null,
        authRequired: null,
      },
      {
        toolId: null,
        toolName: "tool-b",
        endpointUrl: "https://b.com",
        isBuiltin: null,
        authRequired: null,
      },
    ];
    const agent = makeAgent({ mcpTools: tools });
    const config = buildAssistantConfigurable(agent);

    const servers = (config.mcp_config as any).servers;
    expect(servers).toHaveLength(2);
    // Sorted by endpoint URL
    expect(servers[0].url).toBe("https://a.com");
    expect(servers[1].url).toBe("https://b.com");
  });

  it("MCP tools without url or name skipped", () => {
    const tools: AgentSyncMcpTool[] = [
      {
        toolId: null,
        toolName: null,
        endpointUrl: "https://a.com",
        isBuiltin: null,
        authRequired: null,
      },
      {
        toolId: null,
        toolName: "tool",
        endpointUrl: null,
        isBuiltin: null,
        authRequired: null,
      },
    ];
    const agent = makeAgent({ mcpTools: tools });
    const config = buildAssistantConfigurable(agent);
    expect(config).not.toHaveProperty("mcp_config");
  });

  it("server naming (auto-generated)", () => {
    const tools: AgentSyncMcpTool[] = [
      {
        toolId: null,
        toolName: "t1",
        endpointUrl: "https://z.com",
        isBuiltin: null,
        authRequired: null,
      },
      {
        toolId: null,
        toolName: "t2",
        endpointUrl: "https://a.com",
        isBuiltin: null,
        authRequired: null,
      },
    ];
    const agent = makeAgent({ mcpTools: tools });
    const config = buildAssistantConfigurable(agent);

    const servers = (config.mcp_config as any).servers;
    expect(servers[0].name).toBe("server-1");
    expect(servers[1].name).toBe("server-2");
  });
});

// ============================================================================
// assistantPayloadForAgent
// ============================================================================

describe("assistantPayloadForAgent", () => {
  it("basic payload", () => {
    const agent = makeAgent();
    const payload = assistantPayloadForAgent(agent);

    expect(payload.assistant_id).toBe(AGENT_UUID);
    expect(payload.graph_id).toBe("agent");
    expect((payload.config as any).configurable).toBeDefined();
    expect((payload.metadata as any).supabase_agent_id).toBe(AGENT_UUID);
    expect((payload.metadata as any).supabase_organization_id).toBe(ORG_UUID);
    expect((payload.metadata as any).synced_at).toBeDefined();
  });

  it("custom graph_id", () => {
    const agent = makeAgent({ graphId: "custom-graph" });
    const payload = assistantPayloadForAgent(agent);
    expect(payload.graph_id).toBe("custom-graph");
  });

  it("null graph_id defaults to agent", () => {
    const agent = makeAgent({ graphId: null });
    const payload = assistantPayloadForAgent(agent);
    expect(payload.graph_id).toBe("agent");
  });

  it("null organization_id", () => {
    const agent: AgentSyncData = {
      agentId: AGENT_UUID,
      organizationId: null,
      name: null,
      systemPrompt: null,
      temperature: null,
      maxTokens: null,
      runtimeModelName: null,
      graphId: null,
      langgraphAssistantId: null,
      mcpTools: [],
    };
    const payload = assistantPayloadForAgent(agent);
    expect((payload.metadata as any).supabase_organization_id).toBeNull();
  });
});

// ============================================================================
// extractAssistantConfigurable
// ============================================================================

describe("extractAssistantConfigurable", () => {
  it("with dict config containing configurable", () => {
    const obj = { config: { configurable: { k: "v" } } };
    const result = extractAssistantConfigurable(obj);
    expect(result).toEqual({ k: "v" });
  });

  it("with null config", () => {
    const obj = { config: null };
    const result = extractAssistantConfigurable(obj);
    expect(result).toEqual({});
  });

  it("with no config property", () => {
    const obj = { other: "data" };
    const result = extractAssistantConfigurable(obj);
    expect(result).toEqual({});
  });

  it("with non-dict configurable", () => {
    const obj = { config: { configurable: "not-a-dict" } };
    const result = extractAssistantConfigurable(obj);
    expect(result).toEqual({});
  });

  it("with no configurable key", () => {
    const obj = { config: { other: "data" } };
    const result = extractAssistantConfigurable(obj);
    expect(result).toEqual({});
  });

  it("with null input", () => {
    expect(extractAssistantConfigurable(null)).toEqual({});
  });

  it("with undefined input", () => {
    expect(extractAssistantConfigurable(undefined)).toEqual({});
  });
});

// ============================================================================
// writeBackLanggraphAssistantId
// ============================================================================

describe("writeBackLanggraphAssistantId", () => {
  it("returns true when row updated", async () => {
    const { sql } = createMockSql([{}]); // 1 row returned → count = 1
    const result = await writeBackLanggraphAssistantId(
      sql,
      AGENT_UUID,
      AGENT_UUID,
    );
    expect(result).toBe(true);
  });

  it("returns false when no row changed", async () => {
    const { sql } = createMockSql([]); // 0 rows → count = 0
    const result = await writeBackLanggraphAssistantId(
      sql,
      AGENT_UUID,
      AGENT_UUID,
    );
    expect(result).toBe(false);
  });

  it("returns false on SQL error", async () => {
    const sql = createFailingSql("DB down");
    const result = await writeBackLanggraphAssistantId(
      sql,
      AGENT_UUID,
      AGENT_UUID,
    );
    expect(result).toBe(false);
  });
});

// ============================================================================
// syncSingleAgent
// ============================================================================

describe("syncSingleAgent", () => {
  it("creates new assistant", async () => {
    const { sql } = createMockSql([{}]); // write-back
    const storage = new FakeStorage();
    const agent = makeAgent();

    const result = await syncSingleAgent(
      sql,
      storage,
      agent,
      "system",
    );

    expect(result.action).toBe("created");
    expect(result.assistantId).toBe(AGENT_UUID);
    expect(storage.assistants.createCalls).toHaveLength(1);
  });

  it("creates with write-back", async () => {
    const { sql } = createMockSql([{}]); // 1 row → wrote back
    const storage = new FakeStorage();
    const agent = makeAgent();

    const result = await syncSingleAgent(
      sql,
      storage,
      agent,
      "system",
      true,
    );

    expect(result.wroteBackAssistantId).toBe(true);
  });

  it("creates without write-back", async () => {
    const { sql } = createMockSql();
    const storage = new FakeStorage();
    const agent = makeAgent();

    const result = await syncSingleAgent(
      sql,
      storage,
      agent,
      "system",
      false, // writeBack = false
    );

    expect(result.action).toBe("created");
    expect(result.wroteBackAssistantId).toBe(false);
  });

  it("skips when config unchanged", async () => {
    const { sql } = createMockSql();
    const storage = new FakeStorage();
    const agent = makeAgent();

    // Pre-populate with matching config
    const expectedConfig = buildAssistantConfigurable(agent);
    storage.assistants.seed(AGENT_UUID, {
      configurable: expectedConfig,
    });

    const result = await syncSingleAgent(
      sql,
      storage,
      agent,
      "system",
    );

    expect(result.action).toBe("skipped");
    expect(result.wroteBackAssistantId).toBe(false);
  });

  it("updates when config changed", async () => {
    const { sql } = createMockSql([{}]); // write-back
    const storage = new FakeStorage();
    const agent = makeAgent();

    // Seed with different config
    storage.assistants.seed(AGENT_UUID, {
      configurable: { model_name: "openai:gpt-4o" },
    });

    const result = await syncSingleAgent(
      sql,
      storage,
      agent,
      "system",
    );

    expect(result.action).toBe("updated");
    expect(storage.assistants.updateCalls).toHaveLength(1);
  });

  it("updates with write-back", async () => {
    const { sql } = createMockSql([{}]); // 1 row → wrote back
    const storage = new FakeStorage();
    const agent = makeAgent();

    storage.assistants.seed(AGENT_UUID, {
      configurable: { old: true },
    });

    const result = await syncSingleAgent(
      sql,
      storage,
      agent,
      "system",
      true,
    );

    expect(result.action).toBe("updated");
    expect(result.wroteBackAssistantId).toBe(true);
  });

  it("write-back failure does not crash sync", async () => {
    const sql = createFailingSql("DB down");
    const storage = new FakeStorage();
    const agent = makeAgent();

    const result = await syncSingleAgent(
      sql,
      storage,
      agent,
      "system",
      true, // writeBack
    );

    // create succeeds (mock storage doesn't use sql)
    // but write-back fails silently
    expect(result.action).toBe("created");
    expect(result.wroteBackAssistantId).toBe(false);
  });
});

// ============================================================================
// startupAgentSync
// ============================================================================

describe("startupAgentSync", () => {
  it("none scope returns zeros", async () => {
    const { sql } = createMockSql();
    const storage = new FakeStorage();

    const summary = await startupAgentSync(
      sql,
      storage,
      scopeNone(),
      "system",
    );

    expect(summary).toEqual({
      total: 0,
      created: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
    });
  });

  it("creates agents", async () => {
    const rows = [makeAgentRow()];
    const { sql } = createMockSql(
      rows, // fetchActiveAgents
      [{}], // writeBack
    );
    const storage = new FakeStorage();

    const summary = await startupAgentSync(
      sql,
      storage,
      scopeAll(),
      "system",
    );

    expect(summary.total).toBe(1);
    expect(summary.created).toBe(1);
  });

  it("handles sync failure gracefully", async () => {
    const rows = [makeAgentRow()];
    const { sql } = createMockSql(rows);
    const storage = new FakeStorage();

    // Make storage.assistants.create throw
    storage.assistants.create = async () => {
      throw new Error("boom");
    };

    const summary = await startupAgentSync(
      sql,
      storage,
      scopeAll(),
      "system",
    );

    expect(summary.total).toBe(1);
    expect(summary.failed).toBe(1);
  });

  it("multiple agents mixed results", async () => {
    const uid1 = randomUuid();
    const uid2 = randomUuid();
    const rows = [
      makeAgentRow({ agent_id: uid1, name: "Agent 1" }),
      makeAgentRow({ agent_id: uid2, name: "Agent 2" }),
    ];
    const { sql } = createMockSql(
      rows, // fetchActiveAgents
      [{}], // write-back for agent 1
      [{}], // write-back for agent 2
    );
    const storage = new FakeStorage();

    const summary = await startupAgentSync(
      sql,
      storage,
      scopeAll(),
      "system",
    );

    expect(summary.total).toBe(2);
    expect(summary.created).toBe(2);
  });
});

// ============================================================================
// lazySyncAgent
// ============================================================================

describe("lazySyncAgent", () => {
  it("returns null when agent not found in DB", async () => {
    const { sql } = createMockSql([]); // fetchActiveAgentById returns empty
    const storage = new FakeStorage();

    const result = await lazySyncAgent(
      sql,
      storage,
      AGENT_UUID,
      "system",
    );

    expect(result).toBeNull();
  });

  it("syncs when not cached", async () => {
    const rows = [makeAgentRow()];
    const { sql } = createMockSql(
      rows, // fetchActiveAgentById
      [{}], // writeBack
    );
    const storage = new FakeStorage();

    const result = await lazySyncAgent(
      sql,
      storage,
      AGENT_UUID,
      "system",
    );

    expect(result).toBe(AGENT_UUID);
    expect(storage.assistants.createCalls).toHaveLength(1);
  });

  it("returns cached when recently synced", async () => {
    const { sql } = createMockSql();
    const storage = new FakeStorage();

    const recently = new Date().toISOString();
    storage.assistants.seed(AGENT_UUID, {}, { synced_at: recently });

    const result = await lazySyncAgent(
      sql,
      storage,
      AGENT_UUID,
      "system",
      5 * 60 * 1000, // 5 min TTL
    );

    expect(result).toBe(AGENT_UUID);
    // Should NOT have created or fetched
    expect(storage.assistants.createCalls).toHaveLength(0);
  });

  it("resyncs when expired", async () => {
    const expired = new Date(Date.now() - 3600_000).toISOString(); // 1 hour ago

    const rows = [makeAgentRow()];
    const { sql } = createMockSql(
      rows, // fetchActiveAgentById
      [{}], // writeBack
    );
    const storage = new FakeStorage();
    storage.assistants.seed(AGENT_UUID, {}, { synced_at: expired });

    const result = await lazySyncAgent(
      sql,
      storage,
      AGENT_UUID,
      "system",
      5 * 60 * 1000, // 5 min TTL
    );

    expect(result).toBe(AGENT_UUID);
  });

  it("resyncs when synced_at missing", async () => {
    const rows = [makeAgentRow()];
    const { sql } = createMockSql(
      rows, // fetchActiveAgentById
      [{}], // writeBack
    );
    const storage = new FakeStorage();
    storage.assistants.seed(AGENT_UUID, {}, {}); // no synced_at

    const result = await lazySyncAgent(
      sql,
      storage,
      AGENT_UUID,
      "system",
    );

    expect(result).toBe(AGENT_UUID);
  });

  it("resyncs when synced_at unparseable", async () => {
    const rows = [makeAgentRow()];
    const { sql } = createMockSql(
      rows, // fetchActiveAgentById
      [{}], // writeBack
    );
    const storage = new FakeStorage();
    storage.assistants.seed(
      AGENT_UUID,
      {},
      { synced_at: "not-a-date" },
    );

    const result = await lazySyncAgent(
      sql,
      storage,
      AGENT_UUID,
      "system",
    );

    expect(result).toBe(AGENT_UUID);
  });

  it("handles Z suffix in synced_at", async () => {
    const recent =
      new Date().toISOString().replace(/\.\d{3}Z$/, "Z"); // strip ms, keep Z
    const { sql } = createMockSql();
    const storage = new FakeStorage();
    storage.assistants.seed(AGENT_UUID, {}, { synced_at: recent });

    const result = await lazySyncAgent(
      sql,
      storage,
      AGENT_UUID,
      "system",
      10 * 60 * 1000, // 10 min TTL
    );

    expect(result).toBe(AGENT_UUID);
    expect(storage.assistants.createCalls).toHaveLength(0);
  });

  it("handles metadata that is not an object", async () => {
    const rows = [makeAgentRow()];
    const { sql } = createMockSql(
      rows, // fetchActiveAgentById
      [{}], // writeBack
    );
    const storage = new FakeStorage();
    // Seed with metadata that's a string (not an object)
    storage.assistants._store.set(AGENT_UUID, {
      assistant_id: AGENT_UUID,
      config: {},
      metadata: "not-a-dict" as any,
    });

    const result = await lazySyncAgent(
      sql,
      storage,
      AGENT_UUID,
      "system",
    );

    expect(result).toBe(AGENT_UUID);
  });
});
