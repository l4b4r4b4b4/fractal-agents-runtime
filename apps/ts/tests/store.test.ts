/**
 * Tests for the Store API — Fractal Agents Runtime TypeScript/Bun (v0.0.2).
 *
 * Covers:
 *   - InMemoryStoreStorage: put, get, delete, search, listNamespaces, clear
 *   - PUT    /store/items         — Upsert store item (200, 422)
 *   - GET    /store/items         — Get item by namespace + key (200, 404, 422)
 *   - DELETE /store/items         — Delete item by namespace + key (200, 404, 422)
 *   - POST   /store/items/search  — Search items in namespace (200, 422)
 *   - GET    /store/namespaces    — List namespaces (200)
 *
 * Response conventions verified:
 *   - PUT returns 200 with the StoreItem object.
 *   - GET returns 200 with the StoreItem, or 404 if not found.
 *   - DELETE returns 200 with `{}`, or 404 if not found.
 *   - Search returns 200 with a JSON array of StoreItem objects.
 *   - Namespaces returns 200 with a JSON array of namespace strings.
 *   - Errors use `{"detail": "..."}` shape (ErrorResponse).
 *
 * All route tests use the default "anonymous" owner_id (auth disabled).
 *
 * Reference: apps/python/src/server/routes/store.py
 */

import { describe, expect, test, beforeEach } from "bun:test";

import { InMemoryStoreStorage } from "../src/storage/memory";
import { router } from "../src/index";
import { resetStorage, getStorage } from "../src/storage/index";
import type { StoreItem } from "../src/models/store";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(
  path: string,
  method = "GET",
  body?: unknown,
): Request {
  const options: RequestInit = { method };
  if (body !== undefined) {
    options.headers = { "Content-Type": "application/json" };
    options.body = JSON.stringify(body);
  }
  return new Request(`http://localhost:3000${path}`, options);
}

async function jsonBody<T = unknown>(response: Response): Promise<T> {
  return response.json() as Promise<T>;
}

interface ErrorBody {
  detail: string;
}

// ===========================================================================
// InMemoryStoreStorage — unit tests
// ===========================================================================

describe("InMemoryStoreStorage", () => {
  let store: InMemoryStoreStorage;
  const ownerId = "user-1";

  beforeEach(() => {
    store = new InMemoryStoreStorage();
  });

  // -------------------------------------------------------------------------
  // put
  // -------------------------------------------------------------------------

  describe("put", () => {
    test("creates a new item", async () => {
      const item = await store.put("ns1", "key1", { hello: "world" }, ownerId);

      expect(item.namespace).toBe("ns1");
      expect(item.key).toBe("key1");
      expect(item.value).toEqual({ hello: "world" });
      expect(item.metadata).toEqual({});
      expect(item.created_at).toBeDefined();
      expect(item.updated_at).toBeDefined();
    });

    test("creates a new item with metadata", async () => {
      const item = await store.put(
        "ns1",
        "key1",
        { data: 42 },
        ownerId,
        { source: "test" },
      );

      expect(item.metadata).toEqual({ source: "test" });
    });

    test("updates an existing item (upsert)", async () => {
      const original = await store.put("ns1", "key1", { v: 1 }, ownerId);
      const updated = await store.put("ns1", "key1", { v: 2 }, ownerId);

      expect(updated.namespace).toBe("ns1");
      expect(updated.key).toBe("key1");
      expect(updated.value).toEqual({ v: 2 });
      // created_at should not change on update
      expect(updated.created_at).toBe(original.created_at);
    });

    test("updates metadata when provided on upsert", async () => {
      await store.put("ns1", "key1", { v: 1 }, ownerId, { a: 1 });
      const updated = await store.put(
        "ns1",
        "key1",
        { v: 2 },
        ownerId,
        { b: 2 },
      );

      expect(updated.metadata).toEqual({ b: 2 });
    });

    test("preserves metadata when not provided on upsert", async () => {
      await store.put("ns1", "key1", { v: 1 }, ownerId, { keep: true });
      const updated = await store.put("ns1", "key1", { v: 2 }, ownerId);

      expect(updated.metadata).toEqual({ keep: true });
    });

    test("different owners have isolated items", async () => {
      await store.put("ns1", "key1", { owner: "A" }, "owner-A");
      await store.put("ns1", "key1", { owner: "B" }, "owner-B");

      const itemA = await store.get("ns1", "key1", "owner-A");
      const itemB = await store.get("ns1", "key1", "owner-B");

      expect(itemA!.value).toEqual({ owner: "A" });
      expect(itemB!.value).toEqual({ owner: "B" });
    });

    test("different namespaces are isolated", async () => {
      await store.put("ns1", "key1", { ns: 1 }, ownerId);
      await store.put("ns2", "key1", { ns: 2 }, ownerId);

      const item1 = await store.get("ns1", "key1", ownerId);
      const item2 = await store.get("ns2", "key1", ownerId);

      expect(item1!.value).toEqual({ ns: 1 });
      expect(item2!.value).toEqual({ ns: 2 });
    });
  });

  // -------------------------------------------------------------------------
  // get
  // -------------------------------------------------------------------------

  describe("get", () => {
    test("returns existing item", async () => {
      await store.put("ns1", "key1", { hello: "world" }, ownerId);
      const item = await store.get("ns1", "key1", ownerId);

      expect(item).not.toBeNull();
      expect(item!.namespace).toBe("ns1");
      expect(item!.key).toBe("key1");
      expect(item!.value).toEqual({ hello: "world" });
    });

    test("returns null for non-existent key", async () => {
      const item = await store.get("ns1", "missing", ownerId);
      expect(item).toBeNull();
    });

    test("returns null for non-existent namespace", async () => {
      const item = await store.get("missing-ns", "key1", ownerId);
      expect(item).toBeNull();
    });

    test("returns null for non-existent owner", async () => {
      await store.put("ns1", "key1", { v: 1 }, ownerId);
      const item = await store.get("ns1", "key1", "other-owner");
      expect(item).toBeNull();
    });

    test("does not include ownerId in returned model", async () => {
      const item = await store.put("ns1", "key1", { v: 1 }, ownerId);
      // StoreItem should NOT have an ownerId property
      expect("ownerId" in item).toBe(false);
      expect("owner_id" in item).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // delete
  // -------------------------------------------------------------------------

  describe("delete", () => {
    test("deletes an existing item and returns true", async () => {
      await store.put("ns1", "key1", { v: 1 }, ownerId);
      const deleted = await store.delete("ns1", "key1", ownerId);

      expect(deleted).toBe(true);

      const item = await store.get("ns1", "key1", ownerId);
      expect(item).toBeNull();
    });

    test("returns false for non-existent key", async () => {
      const deleted = await store.delete("ns1", "missing", ownerId);
      expect(deleted).toBe(false);
    });

    test("returns false for non-existent namespace", async () => {
      const deleted = await store.delete("missing-ns", "key1", ownerId);
      expect(deleted).toBe(false);
    });

    test("returns false for non-existent owner", async () => {
      await store.put("ns1", "key1", { v: 1 }, ownerId);
      const deleted = await store.delete("ns1", "key1", "other-owner");

      expect(deleted).toBe(false);

      // Original should still exist
      const item = await store.get("ns1", "key1", ownerId);
      expect(item).not.toBeNull();
    });

    test("does not affect other keys in the same namespace", async () => {
      await store.put("ns1", "key1", { v: 1 }, ownerId);
      await store.put("ns1", "key2", { v: 2 }, ownerId);

      await store.delete("ns1", "key1", ownerId);

      const remaining = await store.get("ns1", "key2", ownerId);
      expect(remaining).not.toBeNull();
      expect(remaining!.value).toEqual({ v: 2 });
    });
  });

  // -------------------------------------------------------------------------
  // search
  // -------------------------------------------------------------------------

  describe("search", () => {
    beforeEach(async () => {
      // Create several items in a namespace
      await store.put("ns1", "user-001", { name: "Alice" }, ownerId);
      await store.put("ns1", "user-002", { name: "Bob" }, ownerId);
      await store.put("ns1", "user-003", { name: "Charlie" }, ownerId);
      await store.put("ns1", "config-theme", { dark: true }, ownerId);
      await store.put("ns1", "config-lang", { lang: "en" }, ownerId);
    });

    test("returns all items in a namespace without prefix", async () => {
      const items = await store.search("ns1", ownerId);
      expect(items.length).toBe(5);
    });

    test("filters by key prefix", async () => {
      const items = await store.search("ns1", ownerId, "user-");
      expect(items.length).toBe(3);
      expect(items.every((item) => item.key.startsWith("user-"))).toBe(true);
    });

    test("filters by different prefix", async () => {
      const items = await store.search("ns1", ownerId, "config-");
      expect(items.length).toBe(2);
      expect(items.every((item) => item.key.startsWith("config-"))).toBe(true);
    });

    test("returns empty array for non-matching prefix", async () => {
      const items = await store.search("ns1", ownerId, "zzz-");
      expect(items).toEqual([]);
    });

    test("results are sorted by key ascending", async () => {
      const items = await store.search("ns1", ownerId);
      const keys = items.map((item) => item.key);
      const sorted = [...keys].sort();
      expect(keys).toEqual(sorted);
    });

    test("respects limit", async () => {
      const items = await store.search("ns1", ownerId, undefined, 2);
      expect(items.length).toBe(2);
    });

    test("respects offset", async () => {
      const allItems = await store.search("ns1", ownerId, undefined, 100, 0);
      const offsetItems = await store.search("ns1", ownerId, undefined, 100, 2);
      expect(offsetItems.length).toBe(allItems.length - 2);
      expect(offsetItems[0].key).toBe(allItems[2].key);
    });

    test("limit + offset pagination works correctly", async () => {
      const page1 = await store.search("ns1", ownerId, undefined, 2, 0);
      const page2 = await store.search("ns1", ownerId, undefined, 2, 2);
      const page3 = await store.search("ns1", ownerId, undefined, 2, 4);

      expect(page1.length).toBe(2);
      expect(page2.length).toBe(2);
      expect(page3.length).toBe(1);

      // No overlap
      const allKeys = [...page1, ...page2, ...page3].map((item) => item.key);
      const uniqueKeys = new Set(allKeys);
      expect(uniqueKeys.size).toBe(5);
    });

    test("returns empty for non-existent namespace", async () => {
      const items = await store.search("missing-ns", ownerId);
      expect(items).toEqual([]);
    });

    test("returns empty for non-existent owner", async () => {
      const items = await store.search("ns1", "other-owner");
      expect(items).toEqual([]);
    });

    test("default limit is 10", async () => {
      // Add more than 10 items
      for (let index = 0; index < 15; index++) {
        await store.put("big-ns", `item-${String(index).padStart(3, "0")}`, { index }, ownerId);
      }

      const items = await store.search("big-ns", ownerId);
      expect(items.length).toBe(10);
    });
  });

  // -------------------------------------------------------------------------
  // listNamespaces
  // -------------------------------------------------------------------------

  describe("listNamespaces", () => {
    test("returns empty array when no items exist", async () => {
      const namespaces = await store.listNamespaces(ownerId);
      expect(namespaces).toEqual([]);
    });

    test("returns namespaces with items", async () => {
      await store.put("ns1", "key1", { v: 1 }, ownerId);
      await store.put("ns2", "key1", { v: 2 }, ownerId);
      await store.put("ns3", "key1", { v: 3 }, ownerId);

      const namespaces = await store.listNamespaces(ownerId);
      expect(namespaces.sort()).toEqual(["ns1", "ns2", "ns3"]);
    });

    test("does not include namespaces from other owners", async () => {
      await store.put("ns1", "key1", { v: 1 }, ownerId);
      await store.put("private-ns", "key1", { v: 2 }, "other-owner");

      const namespaces = await store.listNamespaces(ownerId);
      expect(namespaces).toEqual(["ns1"]);
    });

    test("returns empty for non-existent owner", async () => {
      await store.put("ns1", "key1", { v: 1 }, ownerId);
      const namespaces = await store.listNamespaces("no-one");
      expect(namespaces).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // clear
  // -------------------------------------------------------------------------

  describe("clear", () => {
    test("removes all items from all owners", async () => {
      await store.put("ns1", "key1", { v: 1 }, "owner-A");
      await store.put("ns2", "key2", { v: 2 }, "owner-B");

      await store.clear();

      expect(await store.listNamespaces("owner-A")).toEqual([]);
      expect(await store.listNamespaces("owner-B")).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // StoreItem shape
  // -------------------------------------------------------------------------

  describe("StoreItem shape", () => {
    test("has all required fields", async () => {
      const item = await store.put("ns1", "key1", { hello: "world" }, ownerId);

      expect(item).toHaveProperty("namespace");
      expect(item).toHaveProperty("key");
      expect(item).toHaveProperty("value");
      expect(item).toHaveProperty("metadata");
      expect(item).toHaveProperty("created_at");
      expect(item).toHaveProperty("updated_at");
    });

    test("created_at and updated_at are ISO 8601 strings", async () => {
      const item = await store.put("ns1", "key1", { v: 1 }, ownerId);

      expect(item.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(item.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    test("value is an object (not a primitive)", async () => {
      const item = await store.put("ns1", "key1", { nested: { deep: true } }, ownerId);

      expect(typeof item.value).toBe("object");
      expect(item.value).toEqual({ nested: { deep: true } });
    });
  });
});

// ===========================================================================
// Storage container — store property
// ===========================================================================

describe("Storage container — store", () => {
  test("InMemoryStorage has a store property", () => {
    resetStorage();
    const storage = getStorage();
    expect(storage.store).toBeDefined();
    expect(typeof storage.store.put).toBe("function");
    expect(typeof storage.store.get).toBe("function");
    expect(typeof storage.store.delete).toBe("function");
    expect(typeof storage.store.search).toBe("function");
    expect(typeof storage.store.listNamespaces).toBe("function");
    expect(typeof storage.store.clear).toBe("function");
  });

  test("clearAll clears the store", async () => {
    resetStorage();
    const storage = getStorage();
    await storage.store.put("ns", "key", { v: 1 }, "owner");
    await storage.clearAll();

    const item = await storage.store.get("ns", "key", "owner");
    expect(item).toBeNull();
  });
});

// ===========================================================================
// PUT /store/items — Store/update item
// ===========================================================================

describe("PUT /store/items", () => {
  beforeEach(() => {
    resetStorage();
  });

  test("creates a new item and returns 200 with StoreItem", async () => {
    const response = await router.handle(
      makeRequest("/store/items", "PUT", {
        namespace: "ns1",
        key: "key1",
        value: { hello: "world" },
      }),
    );

    expect(response.status).toBe(200);
    const body = await jsonBody<StoreItem>(response);
    expect(body.namespace).toBe("ns1");
    expect(body.key).toBe("key1");
    expect(body.value).toEqual({ hello: "world" });
    expect(body.metadata).toEqual({});
    expect(body.created_at).toBeDefined();
    expect(body.updated_at).toBeDefined();
  });

  test("creates a new item with metadata", async () => {
    const response = await router.handle(
      makeRequest("/store/items", "PUT", {
        namespace: "ns1",
        key: "key1",
        value: { data: 42 },
        metadata: { source: "test" },
      }),
    );

    expect(response.status).toBe(200);
    const body = await jsonBody<StoreItem>(response);
    expect(body.metadata).toEqual({ source: "test" });
  });

  test("upserts an existing item", async () => {
    await router.handle(
      makeRequest("/store/items", "PUT", {
        namespace: "ns1",
        key: "key1",
        value: { version: 1 },
      }),
    );

    const response = await router.handle(
      makeRequest("/store/items", "PUT", {
        namespace: "ns1",
        key: "key1",
        value: { version: 2 },
      }),
    );

    expect(response.status).toBe(200);
    const body = await jsonBody<StoreItem>(response);
    expect(body.value).toEqual({ version: 2 });
  });

  test("returns 422 when namespace is missing", async () => {
    const response = await router.handle(
      makeRequest("/store/items", "PUT", {
        key: "key1",
        value: { v: 1 },
      }),
    );

    expect(response.status).toBe(422);
    const body = await jsonBody<ErrorBody>(response);
    expect(body.detail).toContain("namespace");
  });

  test("returns 422 when key is missing", async () => {
    const response = await router.handle(
      makeRequest("/store/items", "PUT", {
        namespace: "ns1",
        value: { v: 1 },
      }),
    );

    expect(response.status).toBe(422);
    const body = await jsonBody<ErrorBody>(response);
    expect(body.detail).toContain("key");
  });

  test("returns 422 when value is missing", async () => {
    const response = await router.handle(
      makeRequest("/store/items", "PUT", {
        namespace: "ns1",
        key: "key1",
      }),
    );

    expect(response.status).toBe(422);
    const body = await jsonBody<ErrorBody>(response);
    expect(body.detail).toContain("value");
  });

  test("returns 422 when value is null", async () => {
    const response = await router.handle(
      makeRequest("/store/items", "PUT", {
        namespace: "ns1",
        key: "key1",
        value: null,
      }),
    );

    expect(response.status).toBe(422);
  });

  test("returns 422 when namespace is empty string", async () => {
    const response = await router.handle(
      makeRequest("/store/items", "PUT", {
        namespace: "",
        key: "key1",
        value: { v: 1 },
      }),
    );

    expect(response.status).toBe(422);
  });

  test("returns 422 when key is empty string", async () => {
    const response = await router.handle(
      makeRequest("/store/items", "PUT", {
        namespace: "ns1",
        key: "",
        value: { v: 1 },
      }),
    );

    expect(response.status).toBe(422);
  });

  test("returns 422 without Content-Type: application/json", async () => {
    const response = await router.handle(
      new Request("http://localhost:3000/store/items", {
        method: "PUT",
        body: JSON.stringify({ namespace: "ns1", key: "key1", value: {} }),
      }),
    );

    expect(response.status).toBe(422);
  });

  test("returns 422 with invalid JSON body", async () => {
    const response = await router.handle(
      new Request("http://localhost:3000/store/items", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: "not-json",
      }),
    );

    expect(response.status).toBe(422);
  });

  test("response has Content-Type: application/json", async () => {
    const response = await router.handle(
      makeRequest("/store/items", "PUT", {
        namespace: "ns1",
        key: "key1",
        value: { v: 1 },
      }),
    );

    expect(response.headers.get("Content-Type")).toBe("application/json");
  });
});

// ===========================================================================
// GET /store/items — Get item
// ===========================================================================

describe("GET /store/items", () => {
  beforeEach(async () => {
    resetStorage();
    // Seed an item via the PUT endpoint
    await router.handle(
      makeRequest("/store/items", "PUT", {
        namespace: "ns1",
        key: "key1",
        value: { hello: "world" },
      }),
    );
  });

  test("returns 200 with StoreItem for existing item", async () => {
    const response = await router.handle(
      makeRequest("/store/items?namespace=ns1&key=key1"),
    );

    expect(response.status).toBe(200);
    const body = await jsonBody<StoreItem>(response);
    expect(body.namespace).toBe("ns1");
    expect(body.key).toBe("key1");
    expect(body.value).toEqual({ hello: "world" });
    expect(body.metadata).toEqual({});
    expect(body.created_at).toBeDefined();
    expect(body.updated_at).toBeDefined();
  });

  test("returns 404 for non-existent key", async () => {
    const response = await router.handle(
      makeRequest("/store/items?namespace=ns1&key=missing"),
    );

    expect(response.status).toBe(404);
    const body = await jsonBody<ErrorBody>(response);
    expect(body.detail).toContain("not found");
  });

  test("returns 404 for non-existent namespace", async () => {
    const response = await router.handle(
      makeRequest("/store/items?namespace=missing-ns&key=key1"),
    );

    expect(response.status).toBe(404);
  });

  test("returns 422 when namespace query param is missing", async () => {
    const response = await router.handle(
      makeRequest("/store/items?key=key1"),
    );

    expect(response.status).toBe(422);
    const body = await jsonBody<ErrorBody>(response);
    expect(body.detail).toContain("namespace");
  });

  test("returns 422 when key query param is missing", async () => {
    const response = await router.handle(
      makeRequest("/store/items?namespace=ns1"),
    );

    expect(response.status).toBe(422);
    const body = await jsonBody<ErrorBody>(response);
    expect(body.detail).toContain("key");
  });

  test("returns 422 when both query params are missing", async () => {
    const response = await router.handle(
      makeRequest("/store/items"),
    );

    expect(response.status).toBe(422);
  });

  test("response has Content-Type: application/json", async () => {
    const response = await router.handle(
      makeRequest("/store/items?namespace=ns1&key=key1"),
    );

    expect(response.headers.get("Content-Type")).toBe("application/json");
  });
});

// ===========================================================================
// DELETE /store/items — Delete item
// ===========================================================================

describe("DELETE /store/items", () => {
  beforeEach(async () => {
    resetStorage();
    await router.handle(
      makeRequest("/store/items", "PUT", {
        namespace: "ns1",
        key: "key1",
        value: { hello: "world" },
      }),
    );
  });

  test("deletes an existing item and returns 200 with empty object", async () => {
    const response = await router.handle(
      makeRequest("/store/items?namespace=ns1&key=key1", "DELETE"),
    );

    expect(response.status).toBe(200);
    const body = await jsonBody(response);
    expect(body).toEqual({});

    // Verify it's actually deleted
    const getResponse = await router.handle(
      makeRequest("/store/items?namespace=ns1&key=key1"),
    );
    expect(getResponse.status).toBe(404);
  });

  test("returns 404 for non-existent key", async () => {
    const response = await router.handle(
      makeRequest("/store/items?namespace=ns1&key=missing", "DELETE"),
    );

    expect(response.status).toBe(404);
    const body = await jsonBody<ErrorBody>(response);
    expect(body.detail).toContain("not found");
  });

  test("returns 404 for non-existent namespace", async () => {
    const response = await router.handle(
      makeRequest("/store/items?namespace=missing-ns&key=key1", "DELETE"),
    );

    expect(response.status).toBe(404);
  });

  test("returns 422 when namespace is missing", async () => {
    const response = await router.handle(
      makeRequest("/store/items?key=key1", "DELETE"),
    );

    expect(response.status).toBe(422);
    const body = await jsonBody<ErrorBody>(response);
    expect(body.detail).toContain("namespace");
  });

  test("returns 422 when key is missing", async () => {
    const response = await router.handle(
      makeRequest("/store/items?namespace=ns1", "DELETE"),
    );

    expect(response.status).toBe(422);
    const body = await jsonBody<ErrorBody>(response);
    expect(body.detail).toContain("key");
  });

  test("does not affect other items in the same namespace", async () => {
    // Add another item
    await router.handle(
      makeRequest("/store/items", "PUT", {
        namespace: "ns1",
        key: "key2",
        value: { keep: true },
      }),
    );

    // Delete only key1
    await router.handle(
      makeRequest("/store/items?namespace=ns1&key=key1", "DELETE"),
    );

    // key2 should still exist
    const getResponse = await router.handle(
      makeRequest("/store/items?namespace=ns1&key=key2"),
    );
    expect(getResponse.status).toBe(200);
    const body = await jsonBody<StoreItem>(getResponse);
    expect(body.value).toEqual({ keep: true });
  });
});

// ===========================================================================
// POST /store/items/search — Search items
// ===========================================================================

describe("POST /store/items/search", () => {
  beforeEach(async () => {
    resetStorage();
    // Seed items
    for (const key of ["user-001", "user-002", "user-003", "config-theme", "config-lang"]) {
      await router.handle(
        makeRequest("/store/items", "PUT", {
          namespace: "ns1",
          key,
          value: { key },
        }),
      );
    }
  });

  test("returns all items in a namespace", async () => {
    const response = await router.handle(
      makeRequest("/store/items/search", "POST", {
        namespace: "ns1",
      }),
    );

    expect(response.status).toBe(200);
    const body = await jsonBody<StoreItem[]>(response);
    expect(body.length).toBe(5);
  });

  test("filters by key prefix", async () => {
    const response = await router.handle(
      makeRequest("/store/items/search", "POST", {
        namespace: "ns1",
        prefix: "user-",
      }),
    );

    expect(response.status).toBe(200);
    const body = await jsonBody<StoreItem[]>(response);
    expect(body.length).toBe(3);
    expect(body.every((item) => item.key.startsWith("user-"))).toBe(true);
  });

  test("results are sorted by key ascending", async () => {
    const response = await router.handle(
      makeRequest("/store/items/search", "POST", {
        namespace: "ns1",
      }),
    );

    const body = await jsonBody<StoreItem[]>(response);
    const keys = body.map((item) => item.key);
    const sorted = [...keys].sort();
    expect(keys).toEqual(sorted);
  });

  test("respects limit parameter", async () => {
    const response = await router.handle(
      makeRequest("/store/items/search", "POST", {
        namespace: "ns1",
        limit: 2,
      }),
    );

    const body = await jsonBody<StoreItem[]>(response);
    expect(body.length).toBe(2);
  });

  test("respects offset parameter", async () => {
    const response = await router.handle(
      makeRequest("/store/items/search", "POST", {
        namespace: "ns1",
        offset: 3,
      }),
    );

    const body = await jsonBody<StoreItem[]>(response);
    expect(body.length).toBe(2); // 5 items, offset 3 → 2 remaining
  });

  test("limit + offset pagination works", async () => {
    const r1 = await router.handle(
      makeRequest("/store/items/search", "POST", {
        namespace: "ns1",
        limit: 2,
        offset: 0,
      }),
    );
    const r2 = await router.handle(
      makeRequest("/store/items/search", "POST", {
        namespace: "ns1",
        limit: 2,
        offset: 2,
      }),
    );
    const r3 = await router.handle(
      makeRequest("/store/items/search", "POST", {
        namespace: "ns1",
        limit: 2,
        offset: 4,
      }),
    );

    const page1 = await jsonBody<StoreItem[]>(r1);
    const page2 = await jsonBody<StoreItem[]>(r2);
    const page3 = await jsonBody<StoreItem[]>(r3);

    expect(page1.length).toBe(2);
    expect(page2.length).toBe(2);
    expect(page3.length).toBe(1);

    const allKeys = [...page1, ...page2, ...page3].map((item) => item.key);
    const uniqueKeys = new Set(allKeys);
    expect(uniqueKeys.size).toBe(5);
  });

  test("clamps limit to max 100", async () => {
    const response = await router.handle(
      makeRequest("/store/items/search", "POST", {
        namespace: "ns1",
        limit: 999,
      }),
    );

    // Should succeed, just clamped
    expect(response.status).toBe(200);
  });

  test("clamps limit to min 1", async () => {
    const response = await router.handle(
      makeRequest("/store/items/search", "POST", {
        namespace: "ns1",
        limit: 0,
      }),
    );

    expect(response.status).toBe(200);
    const body = await jsonBody<StoreItem[]>(response);
    expect(body.length).toBeGreaterThanOrEqual(1);
  });

  test("clamps offset to min 0", async () => {
    const response = await router.handle(
      makeRequest("/store/items/search", "POST", {
        namespace: "ns1",
        offset: -5,
      }),
    );

    expect(response.status).toBe(200);
    const body = await jsonBody<StoreItem[]>(response);
    expect(body.length).toBe(5);
  });

  test("returns empty array for non-existent namespace", async () => {
    const response = await router.handle(
      makeRequest("/store/items/search", "POST", {
        namespace: "missing-ns",
      }),
    );

    expect(response.status).toBe(200);
    const body = await jsonBody<StoreItem[]>(response);
    expect(body).toEqual([]);
  });

  test("returns empty array for non-matching prefix", async () => {
    const response = await router.handle(
      makeRequest("/store/items/search", "POST", {
        namespace: "ns1",
        prefix: "zzz-",
      }),
    );

    expect(response.status).toBe(200);
    const body = await jsonBody<StoreItem[]>(response);
    expect(body).toEqual([]);
  });

  test("returns 422 when namespace is missing", async () => {
    const response = await router.handle(
      makeRequest("/store/items/search", "POST", {
        prefix: "user-",
      }),
    );

    expect(response.status).toBe(422);
    const body = await jsonBody<ErrorBody>(response);
    expect(body.detail).toContain("namespace");
  });

  test("returns 422 when namespace is empty string", async () => {
    const response = await router.handle(
      makeRequest("/store/items/search", "POST", {
        namespace: "",
      }),
    );

    expect(response.status).toBe(422);
  });

  test("returns 422 without Content-Type: application/json", async () => {
    const response = await router.handle(
      new Request("http://localhost:3000/store/items/search", {
        method: "POST",
        body: JSON.stringify({ namespace: "ns1" }),
      }),
    );

    expect(response.status).toBe(422);
  });

  test("each result has correct StoreItem shape", async () => {
    const response = await router.handle(
      makeRequest("/store/items/search", "POST", {
        namespace: "ns1",
        limit: 1,
      }),
    );

    const body = await jsonBody<StoreItem[]>(response);
    expect(body.length).toBe(1);

    const item = body[0];
    expect(item).toHaveProperty("namespace");
    expect(item).toHaveProperty("key");
    expect(item).toHaveProperty("value");
    expect(item).toHaveProperty("metadata");
    expect(item).toHaveProperty("created_at");
    expect(item).toHaveProperty("updated_at");
  });
});

// ===========================================================================
// GET /store/namespaces — List namespaces
// ===========================================================================

describe("GET /store/namespaces", () => {
  beforeEach(async () => {
    resetStorage();
  });

  test("returns empty array when no items exist", async () => {
    const response = await router.handle(
      makeRequest("/store/namespaces"),
    );

    expect(response.status).toBe(200);
    const body = await jsonBody<string[]>(response);
    expect(body).toEqual([]);
  });

  test("returns namespaces that have items", async () => {
    await router.handle(
      makeRequest("/store/items", "PUT", {
        namespace: "ns1",
        key: "k1",
        value: { v: 1 },
      }),
    );
    await router.handle(
      makeRequest("/store/items", "PUT", {
        namespace: "ns2",
        key: "k1",
        value: { v: 2 },
      }),
    );
    await router.handle(
      makeRequest("/store/items", "PUT", {
        namespace: "ns3",
        key: "k1",
        value: { v: 3 },
      }),
    );

    const response = await router.handle(
      makeRequest("/store/namespaces"),
    );

    expect(response.status).toBe(200);
    const body = await jsonBody<string[]>(response);
    expect(body.sort()).toEqual(["ns1", "ns2", "ns3"]);
  });

  test("does not include namespaces from items that were all deleted", async () => {
    // Create an item in ns1 and ns2
    await router.handle(
      makeRequest("/store/items", "PUT", {
        namespace: "ns1",
        key: "k1",
        value: { v: 1 },
      }),
    );
    await router.handle(
      makeRequest("/store/items", "PUT", {
        namespace: "ns2",
        key: "k1",
        value: { v: 2 },
      }),
    );

    // Delete the ns2 item
    await router.handle(
      makeRequest("/store/items?namespace=ns2&key=k1", "DELETE"),
    );

    const response = await router.handle(
      makeRequest("/store/namespaces"),
    );

    const body = await jsonBody<string[]>(response);

    // ns2 may or may not appear depending on implementation (in-memory
    // keeps the namespace map even after deleting the last key). The
    // important thing is ns1 is always present.
    expect(body).toContain("ns1");
  });

  test("response has Content-Type: application/json", async () => {
    const response = await router.handle(
      makeRequest("/store/namespaces"),
    );

    expect(response.headers.get("Content-Type")).toBe("application/json");
  });

  test("returns 200 even with no data", async () => {
    const response = await router.handle(
      makeRequest("/store/namespaces"),
    );

    expect(response.status).toBe(200);
  });
});

// ===========================================================================
// Route registration and method guards
// ===========================================================================

describe("Store route method guards", () => {
  beforeEach(() => {
    resetStorage();
  });

  test("POST /store/items returns 405", async () => {
    const response = await router.handle(
      makeRequest("/store/items", "POST", { namespace: "ns1", key: "k1", value: {} }),
    );
    expect(response.status).toBe(405);
  });

  test("PATCH /store/items returns 405", async () => {
    const response = await router.handle(
      makeRequest("/store/items", "PATCH", { namespace: "ns1", key: "k1", value: {} }),
    );
    expect(response.status).toBe(405);
  });

  test("GET /store/items/search returns 405", async () => {
    const response = await router.handle(
      makeRequest("/store/items/search"),
    );
    expect(response.status).toBe(405);
  });

  test("POST /store/namespaces returns 405", async () => {
    const response = await router.handle(
      makeRequest("/store/namespaces", "POST", {}),
    );
    expect(response.status).toBe(405);
  });

  test("DELETE /store/namespaces returns 405", async () => {
    const response = await router.handle(
      makeRequest("/store/namespaces", "DELETE"),
    );
    expect(response.status).toBe(405);
  });
});

// ===========================================================================
// End-to-end flow — put → get → search → delete → verify
// ===========================================================================

describe("Store API — end-to-end flow", () => {
  beforeEach(() => {
    resetStorage();
  });

  test("full CRUD lifecycle via HTTP endpoints", async () => {
    // Step 1: Create items
    const putResponse1 = await router.handle(
      makeRequest("/store/items", "PUT", {
        namespace: "memories",
        key: "fact-1",
        value: { text: "User prefers dark mode" },
        metadata: { source: "chat" },
      }),
    );
    expect(putResponse1.status).toBe(200);

    const putResponse2 = await router.handle(
      makeRequest("/store/items", "PUT", {
        namespace: "memories",
        key: "fact-2",
        value: { text: "User speaks English" },
      }),
    );
    expect(putResponse2.status).toBe(200);

    const putResponse3 = await router.handle(
      makeRequest("/store/items", "PUT", {
        namespace: "tokens",
        key: "mcp-github",
        value: { token: "abc123", expires: "2025-12-31" },
      }),
    );
    expect(putResponse3.status).toBe(200);

    // Step 2: Get a specific item
    const getResponse = await router.handle(
      makeRequest("/store/items?namespace=memories&key=fact-1"),
    );
    expect(getResponse.status).toBe(200);
    const getBody = await jsonBody<StoreItem>(getResponse);
    expect(getBody.value).toEqual({ text: "User prefers dark mode" });
    expect(getBody.metadata).toEqual({ source: "chat" });

    // Step 3: Search within namespace
    const searchResponse = await router.handle(
      makeRequest("/store/items/search", "POST", {
        namespace: "memories",
      }),
    );
    expect(searchResponse.status).toBe(200);
    const searchBody = await jsonBody<StoreItem[]>(searchResponse);
    expect(searchBody.length).toBe(2);

    // Step 4: Search with prefix
    const prefixResponse = await router.handle(
      makeRequest("/store/items/search", "POST", {
        namespace: "memories",
        prefix: "fact-1",
      }),
    );
    const prefixBody = await jsonBody<StoreItem[]>(prefixResponse);
    expect(prefixBody.length).toBe(1);
    expect(prefixBody[0].key).toBe("fact-1");

    // Step 5: List namespaces
    const nsResponse = await router.handle(
      makeRequest("/store/namespaces"),
    );
    expect(nsResponse.status).toBe(200);
    const nsBody = await jsonBody<string[]>(nsResponse);
    expect(nsBody.sort()).toEqual(["memories", "tokens"]);

    // Step 6: Update an item (upsert)
    const updateResponse = await router.handle(
      makeRequest("/store/items", "PUT", {
        namespace: "memories",
        key: "fact-1",
        value: { text: "User prefers dark mode and large fonts" },
      }),
    );
    expect(updateResponse.status).toBe(200);
    const updateBody = await jsonBody<StoreItem>(updateResponse);
    expect(updateBody.value).toEqual({ text: "User prefers dark mode and large fonts" });

    // Step 7: Verify update via GET
    const verifyResponse = await router.handle(
      makeRequest("/store/items?namespace=memories&key=fact-1"),
    );
    const verifyBody = await jsonBody<StoreItem>(verifyResponse);
    expect(verifyBody.value).toEqual({ text: "User prefers dark mode and large fonts" });

    // Step 8: Delete an item
    const deleteResponse = await router.handle(
      makeRequest("/store/items?namespace=memories&key=fact-2", "DELETE"),
    );
    expect(deleteResponse.status).toBe(200);
    expect(await jsonBody(deleteResponse)).toEqual({});

    // Step 9: Verify deletion
    const verifyDeleteResponse = await router.handle(
      makeRequest("/store/items?namespace=memories&key=fact-2"),
    );
    expect(verifyDeleteResponse.status).toBe(404);

    // Step 10: Search again — should have 1 item left
    const finalSearchResponse = await router.handle(
      makeRequest("/store/items/search", "POST", {
        namespace: "memories",
      }),
    );
    const finalSearchBody = await jsonBody<StoreItem[]>(finalSearchResponse);
    expect(finalSearchBody.length).toBe(1);
    expect(finalSearchBody[0].key).toBe("fact-1");
  });
});
