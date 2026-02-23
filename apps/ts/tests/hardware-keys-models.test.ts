/**
 * Unit tests for hardware key models, constants, and error hierarchy.
 *
 * Tests cover:
 *   - Validation constant sets (device types, asset types, actions, algorithms, KDFs)
 *   - Error class hierarchy (status codes, names, messages, instanceof chains)
 *
 * NOTE: Row converter tests (rowToHardwareKeyResponse, rowToAssertionResponse,
 * etc.) are intentionally NOT included here. They import from the service
 * modules (hardware-key-service.ts, encryption-service.ts) which are replaced
 * globally by `mock.module()` in hardware-keys.test.ts. Since Bun runs all
 * test files in the same process, the mock poisons the module cache and these
 * tests would receive mock implementations instead of real functions.
 * The row converters are simple pure functions already validated through the
 * 97 route-level tests in hardware-keys.test.ts.
 */

import { describe, test, expect } from "bun:test";

// Models — constants and errors (NOT mocked by any test file)
import {
  VALID_DEVICE_TYPES,
  VALID_ASSET_TYPES,
  VALID_PROTECTED_ACTIONS,
  VALID_ENCRYPTION_ALGORITHMS,
  VALID_KEY_DERIVATION_METHODS,
  HardwareKeyError,
  HardwareKeyNotFoundError,
  HardwareKeyConflictError,
  HardwareKeyInactiveError,
  AssertionNotFoundError,
  AssertionConsumedError,
  AssertionExpiredError,
  PolicyConflictError,
  InvalidInputError,
  KeyAssertionRequired,
  InvalidAuthorizedKeys,
  EncryptedAssetNotFoundError,
} from "../src/models/hardware-keys";

// ============================================================================
// Validation Constant Sets
// ============================================================================

describe("VALID_DEVICE_TYPES", () => {
  const expectedTypes = [
    "solokey",
    "yubikey",
    "titan",
    "nitrokey",
    "onlykey",
    "trezor",
    "ledger",
    "platform",
    "other",
  ];

  test("contains all expected device types", () => {
    for (const deviceType of expectedTypes) {
      expect(VALID_DEVICE_TYPES.has(deviceType)).toBe(true);
    }
  });

  test("has exactly the expected number of entries", () => {
    expect(VALID_DEVICE_TYPES.size).toBe(expectedTypes.length);
  });

  test("rejects unknown device types", () => {
    expect(VALID_DEVICE_TYPES.has("iphone")).toBe(false);
    expect(VALID_DEVICE_TYPES.has("")).toBe(false);
    expect(VALID_DEVICE_TYPES.has("YUBIKEY")).toBe(false);
  });
});

describe("VALID_ASSET_TYPES", () => {
  const expectedTypes = [
    "repository",
    "project",
    "document",
    "document_artifact",
    "chat_session",
    "agent",
    "ontology",
    "processing_profile",
    "ai_engine",
  ];

  test("contains all expected asset types", () => {
    for (const assetType of expectedTypes) {
      expect(VALID_ASSET_TYPES.has(assetType)).toBe(true);
    }
  });

  test("has exactly the expected number of entries", () => {
    expect(VALID_ASSET_TYPES.size).toBe(expectedTypes.length);
  });

  test("rejects unknown asset types", () => {
    expect(VALID_ASSET_TYPES.has("file")).toBe(false);
    expect(VALID_ASSET_TYPES.has("user")).toBe(false);
  });
});

describe("VALID_PROTECTED_ACTIONS", () => {
  const expectedActions = [
    "decrypt",
    "delete",
    "export",
    "share",
    "sign",
    "all_writes",
    "admin",
  ];

  test("contains all expected protected actions", () => {
    for (const action of expectedActions) {
      expect(VALID_PROTECTED_ACTIONS.has(action)).toBe(true);
    }
  });

  test("has exactly the expected number of entries", () => {
    expect(VALID_PROTECTED_ACTIONS.size).toBe(expectedActions.length);
  });

  test("rejects unknown actions", () => {
    expect(VALID_PROTECTED_ACTIONS.has("read")).toBe(false);
    expect(VALID_PROTECTED_ACTIONS.has("write")).toBe(false);
  });
});

describe("VALID_ENCRYPTION_ALGORITHMS", () => {
  const expectedAlgorithms = [
    "AES-GCM-256",
    "AES-CBC-256",
    "ChaCha20-Poly1305",
  ];

  test("contains all expected encryption algorithms", () => {
    for (const algorithm of expectedAlgorithms) {
      expect(VALID_ENCRYPTION_ALGORITHMS.has(algorithm)).toBe(true);
    }
  });

  test("has exactly the expected number of entries", () => {
    expect(VALID_ENCRYPTION_ALGORITHMS.size).toBe(expectedAlgorithms.length);
  });

  test("rejects unknown algorithms", () => {
    expect(VALID_ENCRYPTION_ALGORITHMS.has("AES-128")).toBe(false);
    expect(VALID_ENCRYPTION_ALGORITHMS.has("RSA")).toBe(false);
    expect(VALID_ENCRYPTION_ALGORITHMS.has("aes-gcm-256")).toBe(false);
  });
});

describe("VALID_KEY_DERIVATION_METHODS", () => {
  const expectedMethods = [
    "webauthn-prf-hkdf",
    "webauthn-hmac-secret-hkdf",
    "passphrase-pbkdf2",
    "shamir-recombine",
  ];

  test("contains all expected key derivation methods", () => {
    for (const method of expectedMethods) {
      expect(VALID_KEY_DERIVATION_METHODS.has(method)).toBe(true);
    }
  });

  test("has exactly the expected number of entries", () => {
    expect(VALID_KEY_DERIVATION_METHODS.size).toBe(expectedMethods.length);
  });

  test("rejects unknown methods", () => {
    expect(VALID_KEY_DERIVATION_METHODS.has("argon2")).toBe(false);
    expect(VALID_KEY_DERIVATION_METHODS.has("scrypt")).toBe(false);
  });
});

// ============================================================================
// Error Class Hierarchy
// ============================================================================

describe("HardwareKeyError (base class)", () => {
  test("has default status code 500", () => {
    const error = new HardwareKeyError("generic error");
    expect(error.statusCode).toBe(500);
  });

  test("accepts a custom status code", () => {
    const error = new HardwareKeyError("custom", 422);
    expect(error.statusCode).toBe(422);
  });

  test("has name 'HardwareKeyError'", () => {
    const error = new HardwareKeyError("test");
    expect(error.name).toBe("HardwareKeyError");
  });

  test("is an instance of Error", () => {
    const error = new HardwareKeyError("test");
    expect(error).toBeInstanceOf(Error);
  });

  test("carries the provided message", () => {
    const error = new HardwareKeyError("something broke");
    expect(error.message).toBe("something broke");
  });
});

describe("HardwareKeyNotFoundError", () => {
  test("has status code 404", () => {
    const error = new HardwareKeyNotFoundError("key-abc-123");
    expect(error.statusCode).toBe(404);
  });

  test("includes key ID in message", () => {
    const error = new HardwareKeyNotFoundError("key-abc-123");
    expect(error.message).toContain("key-abc-123");
    expect(error.message).toContain("not found");
  });

  test("is instanceof HardwareKeyError", () => {
    const error = new HardwareKeyNotFoundError("x");
    expect(error).toBeInstanceOf(HardwareKeyError);
  });

  test("has name 'HardwareKeyNotFoundError'", () => {
    const error = new HardwareKeyNotFoundError("x");
    expect(error.name).toBe("HardwareKeyNotFoundError");
  });
});

describe("HardwareKeyConflictError", () => {
  test("has status code 409", () => {
    const error = new HardwareKeyConflictError("cred-xyz");
    expect(error.statusCode).toBe(409);
  });

  test("includes credential ID in message", () => {
    const error = new HardwareKeyConflictError("cred-xyz");
    expect(error.message).toContain("cred-xyz");
    expect(error.message).toContain("already exists");
  });

  test("is instanceof HardwareKeyError", () => {
    const error = new HardwareKeyConflictError("x");
    expect(error).toBeInstanceOf(HardwareKeyError);
  });
});

describe("HardwareKeyInactiveError", () => {
  test("has status code 400", () => {
    const error = new HardwareKeyInactiveError("key-inactive");
    expect(error.statusCode).toBe(400);
  });

  test("includes key ID in message", () => {
    const error = new HardwareKeyInactiveError("key-inactive");
    expect(error.message).toContain("key-inactive");
    expect(error.message).toContain("deactivated");
  });
});

describe("AssertionNotFoundError", () => {
  test("has status code 404", () => {
    const error = new AssertionNotFoundError("assert-001");
    expect(error.statusCode).toBe(404);
  });

  test("includes assertion ID in message", () => {
    const error = new AssertionNotFoundError("assert-001");
    expect(error.message).toContain("assert-001");
  });
});

describe("AssertionConsumedError", () => {
  test("has status code 410 (Gone)", () => {
    const error = new AssertionConsumedError("assert-consumed");
    expect(error.statusCode).toBe(410);
  });

  test("includes assertion ID in message", () => {
    const error = new AssertionConsumedError("assert-consumed");
    expect(error.message).toContain("assert-consumed");
    expect(error.message).toContain("already been consumed");
  });
});

describe("AssertionExpiredError", () => {
  test("has status code 410 (Gone)", () => {
    const error = new AssertionExpiredError("assert-expired");
    expect(error.statusCode).toBe(410);
  });

  test("includes assertion ID in message", () => {
    const error = new AssertionExpiredError("assert-expired");
    expect(error.message).toContain("assert-expired");
    expect(error.message).toContain("expired");
  });
});

describe("PolicyConflictError", () => {
  test("has status code 409", () => {
    const error = new PolicyConflictError("repository", "repo-1", "decrypt");
    expect(error.statusCode).toBe(409);
  });

  test("includes asset type, asset ID, and action in message", () => {
    const error = new PolicyConflictError("document", "doc-42", "sign");
    expect(error.message).toContain("document");
    expect(error.message).toContain("doc-42");
    expect(error.message).toContain("sign");
  });
});

describe("InvalidInputError", () => {
  test("has status code 400", () => {
    const error = new InvalidInputError("bad input");
    expect(error.statusCode).toBe(400);
  });

  test("carries the exact message", () => {
    const error = new InvalidInputError("field X is required");
    expect(error.message).toBe("field X is required");
  });
});

describe("KeyAssertionRequired", () => {
  test("has status code 428 (Precondition Required)", () => {
    const error = new KeyAssertionRequired("repository", "repo-1", "decrypt");
    expect(error.statusCode).toBe(428);
  });

  test("has default requiredCount of 1 and assertionsPresent of 0", () => {
    const error = new KeyAssertionRequired("repository", "repo-1", "decrypt");
    expect(error.requiredCount).toBe(1);
    expect(error.assertionsPresent).toBe(0);
  });

  test("accepts custom requiredCount and assertionsPresent", () => {
    const error = new KeyAssertionRequired(
      "document",
      "doc-1",
      "decrypt",
      3,
      1,
    );
    expect(error.requiredCount).toBe(3);
    expect(error.assertionsPresent).toBe(1);
  });

  test("stores assetType, assetId, and action as properties", () => {
    const error = new KeyAssertionRequired("project", "proj-9", "admin", 2, 0);
    expect(error.assetType).toBe("project");
    expect(error.assetId).toBe("proj-9");
    expect(error.action).toBe("admin");
  });

  test("is instanceof HardwareKeyError", () => {
    const error = new KeyAssertionRequired("repository", "r", "decrypt");
    expect(error).toBeInstanceOf(HardwareKeyError);
  });
});

describe("InvalidAuthorizedKeys", () => {
  test("has status code 400", () => {
    const error = new InvalidAuthorizedKeys(["key-1", "key-2"]);
    expect(error.statusCode).toBe(400);
  });

  test("stores invalid key IDs as a property", () => {
    const error = new InvalidAuthorizedKeys(["key-a", "key-b", "key-c"]);
    expect(error.invalidKeyIds).toEqual(["key-a", "key-b", "key-c"]);
  });

  test("includes key IDs in message", () => {
    const error = new InvalidAuthorizedKeys(["missing-key"]);
    expect(error.message).toContain("missing-key");
  });
});

describe("EncryptedAssetNotFoundError", () => {
  test("has status code 404", () => {
    const error = new EncryptedAssetNotFoundError("document", "doc-99");
    expect(error.statusCode).toBe(404);
  });

  test("includes asset type and ID in message", () => {
    const error = new EncryptedAssetNotFoundError("repository", "repo-42");
    expect(error.message).toContain("repository");
    expect(error.message).toContain("repo-42");
  });
});

describe("Error hierarchy — all subclasses are instanceof HardwareKeyError and Error", () => {
  const errorInstances = [
    new HardwareKeyNotFoundError("k"),
    new HardwareKeyConflictError("c"),
    new HardwareKeyInactiveError("i"),
    new AssertionNotFoundError("a"),
    new AssertionConsumedError("a"),
    new AssertionExpiredError("a"),
    new PolicyConflictError("t", "i", "a"),
    new InvalidInputError("m"),
    new KeyAssertionRequired("t", "i", "a"),
    new InvalidAuthorizedKeys(["k"]),
    new EncryptedAssetNotFoundError("t", "i"),
  ];

  for (const error of errorInstances) {
    test(`${error.name} is instanceof HardwareKeyError`, () => {
      expect(error).toBeInstanceOf(HardwareKeyError);
    });

    test(`${error.name} is instanceof Error`, () => {
      expect(error).toBeInstanceOf(Error);
    });

    test(`${error.name} has a numeric statusCode`, () => {
      expect(typeof error.statusCode).toBe("number");
      expect(error.statusCode).toBeGreaterThanOrEqual(400);
      expect(error.statusCode).toBeLessThan(600);
    });
  }
});
