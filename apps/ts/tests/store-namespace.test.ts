/**
 * Tests for store namespace conventions — Fractal Agents Runtime TypeScript/Bun (v0.0.2).
 *
 * Covers:
 *   - Category constants (CATEGORY_TOKENS, CATEGORY_CONTEXT, etc.)
 *   - Special pseudo-IDs (SHARED_USER_ID, GLOBAL_AGENT_ID)
 *   - buildNamespace() — success cases, validation, trimming
 *   - extractNamespaceComponents() — success cases, missing/invalid fields
 *
 * Reference: apps/python/src/infra/store_namespace.py
 */

import { describe, expect, test } from "bun:test";

import {
  CATEGORY_TOKENS,
  CATEGORY_CONTEXT,
  CATEGORY_MEMORIES,
  CATEGORY_PREFERENCES,
  SHARED_USER_ID,
  GLOBAL_AGENT_ID,
  buildNamespace,
  extractNamespaceComponents,
} from "../src/infra/store-namespace";
import type { NamespaceComponents } from "../src/infra/store-namespace";

// ===========================================================================
// Constants
// ===========================================================================

describe("Store namespace constants", () => {
  test("CATEGORY_TOKENS is 'tokens'", () => {
    expect(CATEGORY_TOKENS).toBe("tokens");
  });

  test("CATEGORY_CONTEXT is 'context'", () => {
    expect(CATEGORY_CONTEXT).toBe("context");
  });

  test("CATEGORY_MEMORIES is 'memories'", () => {
    expect(CATEGORY_MEMORIES).toBe("memories");
  });

  test("CATEGORY_PREFERENCES is 'preferences'", () => {
    expect(CATEGORY_PREFERENCES).toBe("preferences");
  });

  test("SHARED_USER_ID is 'shared'", () => {
    expect(SHARED_USER_ID).toBe("shared");
  });

  test("GLOBAL_AGENT_ID is 'global'", () => {
    expect(GLOBAL_AGENT_ID).toBe("global");
  });
});

// ===========================================================================
// buildNamespace
// ===========================================================================

describe("buildNamespace", () => {
  // -------------------------------------------------------------------------
  // Success cases
  // -------------------------------------------------------------------------

  test("builds a standard 4-component namespace tuple", () => {
    const result = buildNamespace("org-123", "user-456", "agent-789", CATEGORY_TOKENS);
    expect(result).toEqual(["org-123", "user-456", "agent-789", "tokens"]);
  });

  test("builds namespace with CATEGORY_CONTEXT", () => {
    const result = buildNamespace("org-1", "user-1", "agent-1", CATEGORY_CONTEXT);
    expect(result).toEqual(["org-1", "user-1", "agent-1", "context"]);
  });

  test("builds namespace with CATEGORY_MEMORIES", () => {
    const result = buildNamespace("org-1", "user-1", "agent-1", CATEGORY_MEMORIES);
    expect(result).toEqual(["org-1", "user-1", "agent-1", "memories"]);
  });

  test("builds namespace with CATEGORY_PREFERENCES", () => {
    const result = buildNamespace("org-1", "user-1", "agent-1", CATEGORY_PREFERENCES);
    expect(result).toEqual(["org-1", "user-1", "agent-1", "preferences"]);
  });

  test("builds namespace with SHARED_USER_ID for org-wide data", () => {
    const result = buildNamespace("org-123", SHARED_USER_ID, "agent-789", CATEGORY_CONTEXT);
    expect(result).toEqual(["org-123", "shared", "agent-789", "context"]);
  });

  test("builds namespace with GLOBAL_AGENT_ID for user-global data", () => {
    const result = buildNamespace("org-123", "user-456", GLOBAL_AGENT_ID, CATEGORY_MEMORIES);
    expect(result).toEqual(["org-123", "user-456", "global", "memories"]);
  });

  test("builds namespace with both SHARED_USER_ID and GLOBAL_AGENT_ID", () => {
    const result = buildNamespace("org-123", SHARED_USER_ID, GLOBAL_AGENT_ID, CATEGORY_TOKENS);
    expect(result).toEqual(["org-123", "shared", "global", "tokens"]);
  });

  test("result is a 4-element array", () => {
    const result = buildNamespace("a", "b", "c", "d");
    expect(result.length).toBe(4);
    expect(Array.isArray(result)).toBe(true);
  });

  test("trims whitespace from all components", () => {
    const result = buildNamespace("  org-1  ", " user-1 ", " agent-1 ", " tokens ");
    expect(result).toEqual(["org-1", "user-1", "agent-1", "tokens"]);
  });

  test("accepts UUID-formatted strings", () => {
    const result = buildNamespace(
      "550e8400-e29b-41d4-a716-446655440000",
      "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
      "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      CATEGORY_TOKENS,
    );
    expect(result[0]).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(result[1]).toBe("6ba7b810-9dad-11d1-80b4-00c04fd430c8");
    expect(result[2]).toBe("f47ac10b-58cc-4372-a567-0e02b2c3d479");
    expect(result[3]).toBe("tokens");
  });

  test("accepts custom category strings", () => {
    const result = buildNamespace("org-1", "user-1", "agent-1", "custom-category");
    expect(result[3]).toBe("custom-category");
  });

  // -------------------------------------------------------------------------
  // Validation — empty or whitespace-only components
  // -------------------------------------------------------------------------

  test("throws when orgId is empty string", () => {
    expect(() => buildNamespace("", "user-1", "agent-1", "tokens")).toThrow(
      "orgId must be a non-empty string",
    );
  });

  test("throws when userId is empty string", () => {
    expect(() => buildNamespace("org-1", "", "agent-1", "tokens")).toThrow(
      "userId must be a non-empty string",
    );
  });

  test("throws when assistantId is empty string", () => {
    expect(() => buildNamespace("org-1", "user-1", "", "tokens")).toThrow(
      "assistantId must be a non-empty string",
    );
  });

  test("throws when category is empty string", () => {
    expect(() => buildNamespace("org-1", "user-1", "agent-1", "")).toThrow(
      "category must be a non-empty string",
    );
  });

  test("throws when orgId is whitespace only", () => {
    expect(() => buildNamespace("   ", "user-1", "agent-1", "tokens")).toThrow(
      "orgId",
    );
  });

  test("throws when userId is whitespace only", () => {
    expect(() => buildNamespace("org-1", "   ", "agent-1", "tokens")).toThrow(
      "userId",
    );
  });

  test("throws when assistantId is whitespace only", () => {
    expect(() => buildNamespace("org-1", "user-1", "   ", "tokens")).toThrow(
      "assistantId",
    );
  });

  test("throws when category is whitespace only", () => {
    expect(() => buildNamespace("org-1", "user-1", "agent-1", "   ")).toThrow(
      "category",
    );
  });

  test("error message includes the component name and value", () => {
    try {
      buildNamespace("", "user-1", "agent-1", "tokens");
      // Should not reach here
      expect(true).toBe(false);
    } catch (error: unknown) {
      const message = (error as Error).message;
      expect(message).toContain("orgId");
      expect(message).toContain("non-empty string");
    }
  });
});

// ===========================================================================
// extractNamespaceComponents
// ===========================================================================

describe("extractNamespaceComponents", () => {
  // -------------------------------------------------------------------------
  // Success cases
  // -------------------------------------------------------------------------

  test("extracts all three components from a valid configurable", () => {
    const result = extractNamespaceComponents({
      supabase_organization_id: "org-123",
      owner: "user-456",
      assistant_id: "agent-789",
    });

    expect(result).not.toBeNull();
    expect(result!.orgId).toBe("org-123");
    expect(result!.userId).toBe("user-456");
    expect(result!.assistantId).toBe("agent-789");
  });

  test("trims whitespace from extracted components", () => {
    const result = extractNamespaceComponents({
      supabase_organization_id: "  org-123  ",
      owner: " user-456 ",
      assistant_id: " agent-789 ",
    });

    expect(result).not.toBeNull();
    expect(result!.orgId).toBe("org-123");
    expect(result!.userId).toBe("user-456");
    expect(result!.assistantId).toBe("agent-789");
  });

  test("ignores extra fields in configurable", () => {
    const result = extractNamespaceComponents({
      supabase_organization_id: "org-1",
      owner: "user-1",
      assistant_id: "agent-1",
      some_other_field: "value",
      thread_id: "thread-abc",
    });

    expect(result).not.toBeNull();
    expect(result!.orgId).toBe("org-1");
  });

  test("works with UUID-formatted values", () => {
    const result = extractNamespaceComponents({
      supabase_organization_id: "550e8400-e29b-41d4-a716-446655440000",
      owner: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
      assistant_id: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    });

    expect(result).not.toBeNull();
    expect(result!.orgId).toBe("550e8400-e29b-41d4-a716-446655440000");
  });

  // -------------------------------------------------------------------------
  // Missing components → null
  // -------------------------------------------------------------------------

  test("returns null when configurable is undefined", () => {
    const result = extractNamespaceComponents(undefined);
    expect(result).toBeNull();
  });

  test("returns null when configurable is null", () => {
    const result = extractNamespaceComponents(null);
    expect(result).toBeNull();
  });

  test("returns null when configurable is empty object", () => {
    const result = extractNamespaceComponents({});
    expect(result).toBeNull();
  });

  test("returns null when supabase_organization_id is missing", () => {
    const result = extractNamespaceComponents({
      owner: "user-1",
      assistant_id: "agent-1",
    });
    expect(result).toBeNull();
  });

  test("returns null when owner is missing", () => {
    const result = extractNamespaceComponents({
      supabase_organization_id: "org-1",
      assistant_id: "agent-1",
    });
    expect(result).toBeNull();
  });

  test("returns null when assistant_id is missing", () => {
    const result = extractNamespaceComponents({
      supabase_organization_id: "org-1",
      owner: "user-1",
    });
    expect(result).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Invalid component values → null
  // -------------------------------------------------------------------------

  test("returns null when supabase_organization_id is empty string", () => {
    const result = extractNamespaceComponents({
      supabase_organization_id: "",
      owner: "user-1",
      assistant_id: "agent-1",
    });
    expect(result).toBeNull();
  });

  test("returns null when owner is empty string", () => {
    const result = extractNamespaceComponents({
      supabase_organization_id: "org-1",
      owner: "",
      assistant_id: "agent-1",
    });
    expect(result).toBeNull();
  });

  test("returns null when assistant_id is empty string", () => {
    const result = extractNamespaceComponents({
      supabase_organization_id: "org-1",
      owner: "user-1",
      assistant_id: "",
    });
    expect(result).toBeNull();
  });

  test("returns null when supabase_organization_id is whitespace only", () => {
    const result = extractNamespaceComponents({
      supabase_organization_id: "   ",
      owner: "user-1",
      assistant_id: "agent-1",
    });
    expect(result).toBeNull();
  });

  test("returns null when owner is whitespace only", () => {
    const result = extractNamespaceComponents({
      supabase_organization_id: "org-1",
      owner: "   ",
      assistant_id: "agent-1",
    });
    expect(result).toBeNull();
  });

  test("returns null when assistant_id is whitespace only", () => {
    const result = extractNamespaceComponents({
      supabase_organization_id: "org-1",
      owner: "user-1",
      assistant_id: "   ",
    });
    expect(result).toBeNull();
  });

  test("returns null when supabase_organization_id is a number", () => {
    const result = extractNamespaceComponents({
      supabase_organization_id: 123,
      owner: "user-1",
      assistant_id: "agent-1",
    });
    expect(result).toBeNull();
  });

  test("returns null when owner is null", () => {
    const result = extractNamespaceComponents({
      supabase_organization_id: "org-1",
      owner: null,
      assistant_id: "agent-1",
    });
    expect(result).toBeNull();
  });

  test("returns null when assistant_id is a boolean", () => {
    const result = extractNamespaceComponents({
      supabase_organization_id: "org-1",
      owner: "user-1",
      assistant_id: true,
    });
    expect(result).toBeNull();
  });

  test("returns null when assistant_id is an object", () => {
    const result = extractNamespaceComponents({
      supabase_organization_id: "org-1",
      owner: "user-1",
      assistant_id: { id: "agent-1" },
    });
    expect(result).toBeNull();
  });

  // -------------------------------------------------------------------------
  // NamespaceComponents shape
  // -------------------------------------------------------------------------

  test("returned object has exactly three properties", () => {
    const result = extractNamespaceComponents({
      supabase_organization_id: "org-1",
      owner: "user-1",
      assistant_id: "agent-1",
    });

    expect(result).not.toBeNull();
    const keys = Object.keys(result!);
    expect(keys.sort()).toEqual(["assistantId", "orgId", "userId"]);
  });
});

// ===========================================================================
// Integration — buildNamespace with extractNamespaceComponents
// ===========================================================================

describe("Namespace integration — extract then build", () => {
  test("full pipeline: extract components then build namespace", () => {
    const configurable = {
      supabase_organization_id: "org-abc",
      owner: "user-xyz",
      assistant_id: "agent-123",
    };

    const components = extractNamespaceComponents(configurable);
    expect(components).not.toBeNull();

    const namespace = buildNamespace(
      components!.orgId,
      components!.userId,
      components!.assistantId,
      CATEGORY_TOKENS,
    );

    expect(namespace).toEqual(["org-abc", "user-xyz", "agent-123", "tokens"]);
  });

  test("shared user namespace via extracted components", () => {
    const components = extractNamespaceComponents({
      supabase_organization_id: "org-1",
      owner: "user-1",
      assistant_id: "agent-1",
    });

    const namespace = buildNamespace(
      components!.orgId,
      SHARED_USER_ID,
      components!.assistantId,
      CATEGORY_CONTEXT,
    );

    expect(namespace).toEqual(["org-1", "shared", "agent-1", "context"]);
  });

  test("global agent namespace via extracted components", () => {
    const components = extractNamespaceComponents({
      supabase_organization_id: "org-1",
      owner: "user-1",
      assistant_id: "agent-1",
    });

    const namespace = buildNamespace(
      components!.orgId,
      components!.userId,
      GLOBAL_AGENT_ID,
      CATEGORY_MEMORIES,
    );

    expect(namespace).toEqual(["org-1", "user-1", "global", "memories"]);
  });

  test("gracefully handles null extraction — no build", () => {
    const components = extractNamespaceComponents({});
    expect(components).toBeNull();

    // Callers should check for null before building
    if (components === null) {
      // This is the expected flow — skip store operation
      expect(true).toBe(true);
    }
  });
});
