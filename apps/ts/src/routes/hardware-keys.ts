/**
 * Hardware key management routes — TypeScript/Bun.
 *
 * Registers 18 endpoints under the `/keys/` prefix covering:
 *   - Key CRUD (register, list, get, update, deactivate)
 *   - Assertion management (record, list, status, consume)
 *   - Asset key policies (create, list, get, delete)
 *   - Encrypted asset data (store, get, list, delete, rotate keys)
 *
 * Every handler follows the same pattern:
 *   1. Authenticate via `requireUser()`
 *   2. Parse body (if needed) via `requireBody()`
 *   3. Call the service function
 *   4. Catch domain errors and return the correct HTTP status
 *
 * Reference:
 *   - apps/python/src/server/routes/hardware_keys.py L72–837
 *   - Task-07 scratchpad § Route Handler Error Catching Pattern
 */

import type { Router } from "../router";
import {
  jsonResponse,
  errorResponse,
  requireBody,
} from "./helpers";
import { requireUser, AuthenticationError } from "../lib/auth";
import { getDb } from "../lib/db";
import type {
  HardwareKeyRegistration,
  HardwareKeyUpdate,
  AssertionRecord,
  AssetKeyPolicyCreate,
  EncryptedAssetStore,
  EncryptedAssetKeyUpdate,
} from "../models/hardware-keys";
import {
  HardwareKeyError,
  HardwareKeyNotFoundError,
  HardwareKeyConflictError,
  AssertionNotFoundError,
  AssertionConsumedError,
  AssertionExpiredError,
  PolicyConflictError,
  InvalidInputError,
  InvalidAuthorizedKeys,
  EncryptedAssetNotFoundError,
  KeyAssertionRequired,
} from "../models/hardware-keys";
import {
  registerHardwareKey,
  listUserHardwareKeys,
  getHardwareKey,
  updateHardwareKey,
  deactivateHardwareKey,
  recordAssertion,
  listValidAssertions,
  checkKeyProtectedAccess,
  consumeAssertion,
  createAssetKeyPolicy,
  listAssetKeyPolicies,
  getAssetKeyPolicy,
  deleteAssetKeyPolicy,
} from "../services/hardware-key-service";
import {
  storeEncryptedAsset,
  listEncryptedAssetsForUser,
  getEncryptedAsset,
  getEncryptedAssetWithKeyCheck,
  deleteEncryptedAsset,
  updateAuthorizedKeys,
} from "../services/encryption-service";

// ============================================================================
// Helpers
// ============================================================================

/**
 * Parse a boolean query parameter matching Python's convention.
 *
 * Recognises "true", "1", "yes" (case-insensitive) as truthy. Everything
 * else (including absence / null) falls back to `defaultValue`.
 */
function parseBooleanQuery(
  value: string | null,
  defaultValue: boolean,
): boolean {
  if (value === null) return defaultValue;
  return ["true", "1", "yes"].includes(value.toLowerCase());
}

// ============================================================================
// Route Registration
// ============================================================================

/**
 * Register all 18 hardware-key endpoints on the given router.
 *
 * **Registration order matters** — static paths must come before
 * parameterised paths so the router's first-match strategy picks
 * the correct handler.
 *
 * @param router - The application Router instance.
 */
export function registerHardwareKeyRoutes(router: Router): void {
  // --- Static paths first ---
  router.post("/keys/register", handleRegisterKey);
  router.get("/keys/assertions/status", handleCheckAssertionStatus);
  router.get("/keys/assertions", handleListAssertions);
  router.post("/keys/assertions", handleRecordAssertion);
  router.get("/keys/policies", handleListPolicies);
  router.post("/keys/policies", handleCreatePolicy);
  router.post("/keys/encrypted-data", handleStoreEncryptedAsset);
  router.get("/keys/encrypted-data", handleListEncryptedAssets);

  // --- Parameterised paths ---
  router.post(
    "/keys/assertions/:assertion_id/consume",
    handleConsumeAssertion,
  );
  router.get("/keys/policies/:policy_id", handleGetPolicy);
  router.delete("/keys/policies/:policy_id", handleDeletePolicy);
  router.get(
    "/keys/encrypted-data/:asset_type/:asset_id",
    handleGetEncryptedAsset,
  );
  router.delete(
    "/keys/encrypted-data/:asset_type/:asset_id",
    handleDeleteEncryptedAsset,
  );
  router.patch(
    "/keys/encrypted-data/:asset_type/:asset_id/authorized-keys",
    handleUpdateAuthorizedKeys,
  );
  router.get("/keys/:key_id", handleGetKey);
  router.patch("/keys/:key_id", handleUpdateKey);
  router.delete("/keys/:key_id", handleDeactivateKey);
  router.get("/keys", handleListKeys);
}

// ============================================================================
// Hardware Key CRUD Handlers
// ============================================================================

/**
 * POST /keys/register — Register a new hardware key.
 */
async function handleRegisterKey(
  request: Request,
  _params: Record<string, string>,
  _query: URLSearchParams,
): Promise<Response> {
  let user;
  try {
    user = await requireUser(request);
  } catch (error) {
    if (error instanceof AuthenticationError) {
      return errorResponse(error.message, 401);
    }
    return errorResponse("Authentication failed", 401);
  }

  const [body, bodyError] =
    await requireBody<HardwareKeyRegistration>(request);
  if (bodyError) return bodyError;

  try {
    const sql = getDb();
    const result = await registerHardwareKey(sql, user.identity, body);
    return jsonResponse(result, 201);
  } catch (error) {
    if (error instanceof HardwareKeyConflictError) {
      return errorResponse(error.message, 409);
    }
    if (error instanceof InvalidInputError) {
      return errorResponse(error.message, 400);
    }
    if (error instanceof HardwareKeyError) {
      return errorResponse(error.message, error.statusCode);
    }
    console.error("Unexpected error registering hardware key:", error);
    return errorResponse("Internal server error", 500);
  }
}

/**
 * GET /keys — List hardware keys for the authenticated user.
 *
 * Query params:
 *   include_inactive: "true" to include deactivated keys (default: false)
 */
async function handleListKeys(
  request: Request,
  _params: Record<string, string>,
  query: URLSearchParams,
): Promise<Response> {
  let user;
  try {
    user = await requireUser(request);
  } catch (error) {
    if (error instanceof AuthenticationError) {
      return errorResponse(error.message, 401);
    }
    return errorResponse("Authentication failed", 401);
  }

  const includeInactive = parseBooleanQuery(
    query.get("include_inactive"),
    false,
  );

  try {
    const sql = getDb();
    const keys = await listUserHardwareKeys(
      sql,
      user.identity,
      includeInactive,
    );
    return jsonResponse(keys);
  } catch (error) {
    if (error instanceof HardwareKeyError) {
      return errorResponse(error.message, error.statusCode);
    }
    console.error("Unexpected error listing hardware keys:", error);
    return errorResponse("Internal server error", 500);
  }
}

/**
 * GET /keys/:key_id — Get a specific hardware key by ID.
 */
async function handleGetKey(
  request: Request,
  params: Record<string, string>,
  _query: URLSearchParams,
): Promise<Response> {
  let user;
  try {
    user = await requireUser(request);
  } catch (error) {
    if (error instanceof AuthenticationError) {
      return errorResponse(error.message, 401);
    }
    return errorResponse("Authentication failed", 401);
  }

  const keyId = params.key_id;
  if (!keyId) {
    return errorResponse("key_id is required", 422);
  }

  try {
    const sql = getDb();
    const hardwareKey = await getHardwareKey(sql, user.identity, keyId);
    return jsonResponse(hardwareKey);
  } catch (error) {
    if (error instanceof HardwareKeyNotFoundError) {
      return errorResponse(`Hardware key ${keyId} not found`, 404);
    }
    if (error instanceof HardwareKeyError) {
      return errorResponse(error.message, error.statusCode);
    }
    console.error("Unexpected error getting hardware key:", error);
    return errorResponse("Internal server error", 500);
  }
}

/**
 * PATCH /keys/:key_id — Update mutable metadata on a hardware key.
 */
async function handleUpdateKey(
  request: Request,
  params: Record<string, string>,
  _query: URLSearchParams,
): Promise<Response> {
  let user;
  try {
    user = await requireUser(request);
  } catch (error) {
    if (error instanceof AuthenticationError) {
      return errorResponse(error.message, 401);
    }
    return errorResponse("Authentication failed", 401);
  }

  const keyId = params.key_id;
  if (!keyId) {
    return errorResponse("key_id is required", 422);
  }

  const [body, bodyError] = await requireBody<HardwareKeyUpdate>(request);
  if (bodyError) return bodyError;

  try {
    const sql = getDb();
    const hardwareKey = await updateHardwareKey(
      sql,
      user.identity,
      keyId,
      body,
    );
    return jsonResponse(hardwareKey);
  } catch (error) {
    if (error instanceof HardwareKeyNotFoundError) {
      return errorResponse(`Hardware key ${keyId} not found`, 404);
    }
    if (error instanceof InvalidInputError) {
      return errorResponse(error.message, 400);
    }
    if (error instanceof HardwareKeyError) {
      return errorResponse(error.message, error.statusCode);
    }
    console.error("Unexpected error updating hardware key:", error);
    return errorResponse("Internal server error", 500);
  }
}

/**
 * DELETE /keys/:key_id — Soft-deactivate a hardware key.
 *
 * Returns `{ "deactivated": true, "key": <HardwareKeyResponse> }`.
 */
async function handleDeactivateKey(
  request: Request,
  params: Record<string, string>,
  _query: URLSearchParams,
): Promise<Response> {
  let user;
  try {
    user = await requireUser(request);
  } catch (error) {
    if (error instanceof AuthenticationError) {
      return errorResponse(error.message, 401);
    }
    return errorResponse("Authentication failed", 401);
  }

  const keyId = params.key_id;
  if (!keyId) {
    return errorResponse("key_id is required", 422);
  }

  try {
    const sql = getDb();
    const hardwareKey = await deactivateHardwareKey(
      sql,
      user.identity,
      keyId,
    );
    return jsonResponse({ deactivated: true, key: hardwareKey });
  } catch (error) {
    if (error instanceof HardwareKeyNotFoundError) {
      return errorResponse(`Hardware key ${keyId} not found`, 404);
    }
    if (error instanceof HardwareKeyError) {
      return errorResponse(error.message, error.statusCode);
    }
    console.error("Unexpected error deactivating hardware key:", error);
    return errorResponse("Internal server error", 500);
  }
}

// ============================================================================
// Assertion Management Handlers
// ============================================================================

/**
 * POST /keys/assertions — Record a verified key assertion.
 */
async function handleRecordAssertion(
  request: Request,
  _params: Record<string, string>,
  _query: URLSearchParams,
): Promise<Response> {
  let user;
  try {
    user = await requireUser(request);
  } catch (error) {
    if (error instanceof AuthenticationError) {
      return errorResponse(error.message, 401);
    }
    return errorResponse("Authentication failed", 401);
  }

  const [body, bodyError] = await requireBody<AssertionRecord>(request);
  if (bodyError) return bodyError;

  try {
    const sql = getDb();
    const assertion = await recordAssertion(sql, user.identity, body);
    return jsonResponse(assertion, 201);
  } catch (error) {
    if (error instanceof HardwareKeyNotFoundError) {
      return errorResponse(error.message, 404);
    }
    if (error instanceof InvalidInputError) {
      return errorResponse(error.message, 400);
    }
    if (error instanceof HardwareKeyError) {
      return errorResponse(error.message, error.statusCode);
    }
    console.error("Unexpected error recording assertion:", error);
    return errorResponse("Internal server error", 500);
  }
}

/**
 * GET /keys/assertions — List valid (unexpired, unconsumed) assertions.
 *
 * Query params:
 *   asset_type: Optional filter
 *   asset_id: Optional filter
 */
async function handleListAssertions(
  request: Request,
  _params: Record<string, string>,
  query: URLSearchParams,
): Promise<Response> {
  let user;
  try {
    user = await requireUser(request);
  } catch (error) {
    if (error instanceof AuthenticationError) {
      return errorResponse(error.message, 401);
    }
    return errorResponse("Authentication failed", 401);
  }

  const assetType = query.get("asset_type") || undefined;
  const assetId = query.get("asset_id") || undefined;

  try {
    const sql = getDb();
    const assertions = await listValidAssertions(
      sql,
      user.identity,
      assetType,
      assetId,
    );
    return jsonResponse(assertions);
  } catch (error) {
    if (error instanceof HardwareKeyError) {
      return errorResponse(error.message, error.statusCode);
    }
    console.error("Unexpected error listing assertions:", error);
    return errorResponse("Internal server error", 500);
  }
}

/**
 * GET /keys/assertions/status — Check assertion status for a protected action.
 *
 * Query params (required):
 *   asset_type: Asset type to check
 *   asset_id: Asset UUID to check
 * Query params (optional):
 *   action: Protected action (default: "decrypt")
 */
async function handleCheckAssertionStatus(
  request: Request,
  _params: Record<string, string>,
  query: URLSearchParams,
): Promise<Response> {
  let user;
  try {
    user = await requireUser(request);
  } catch (error) {
    if (error instanceof AuthenticationError) {
      return errorResponse(error.message, 401);
    }
    return errorResponse("Authentication failed", 401);
  }

  const assetType = query.get("asset_type");
  const assetId = query.get("asset_id");
  const action = query.get("action") ?? "decrypt";

  if (!assetType) {
    return errorResponse("asset_type query parameter is required", 422);
  }
  if (!assetId) {
    return errorResponse("asset_id query parameter is required", 422);
  }

  try {
    const sql = getDb();
    const accessResult = await checkKeyProtectedAccess(
      sql,
      user.identity,
      assetType,
      assetId,
      action,
    );
    return jsonResponse(accessResult);
  } catch (error) {
    if (error instanceof InvalidInputError) {
      return errorResponse(error.message, 400);
    }
    if (error instanceof HardwareKeyError) {
      return errorResponse(error.message, error.statusCode);
    }
    console.error("Unexpected error checking assertion status:", error);
    return errorResponse("Internal server error", 500);
  }
}

/**
 * POST /keys/assertions/:assertion_id/consume — Mark an assertion as consumed.
 */
async function handleConsumeAssertion(
  request: Request,
  params: Record<string, string>,
  _query: URLSearchParams,
): Promise<Response> {
  let user;
  try {
    user = await requireUser(request);
  } catch (error) {
    if (error instanceof AuthenticationError) {
      return errorResponse(error.message, 401);
    }
    return errorResponse("Authentication failed", 401);
  }

  const assertionId = params.assertion_id;
  if (!assertionId) {
    return errorResponse("assertion_id is required", 422);
  }

  try {
    const sql = getDb();
    const assertion = await consumeAssertion(
      sql,
      user.identity,
      assertionId,
    );
    return jsonResponse(assertion);
  } catch (error) {
    if (error instanceof AssertionNotFoundError) {
      return errorResponse(`Assertion ${assertionId} not found`, 404);
    }
    if (error instanceof AssertionConsumedError) {
      return errorResponse(
        `Assertion ${assertionId} has already been consumed`,
        410,
      );
    }
    if (error instanceof AssertionExpiredError) {
      return errorResponse(
        `Assertion ${assertionId} has expired`,
        410,
      );
    }
    if (error instanceof HardwareKeyError) {
      return errorResponse(error.message, error.statusCode);
    }
    console.error("Unexpected error consuming assertion:", error);
    return errorResponse("Internal server error", 500);
  }
}

// ============================================================================
// Asset Key Policy Handlers
// ============================================================================

/**
 * POST /keys/policies — Create a key policy for an asset operation.
 */
async function handleCreatePolicy(
  request: Request,
  _params: Record<string, string>,
  _query: URLSearchParams,
): Promise<Response> {
  let user;
  try {
    user = await requireUser(request);
  } catch (error) {
    if (error instanceof AuthenticationError) {
      return errorResponse(error.message, 401);
    }
    return errorResponse("Authentication failed", 401);
  }

  const [body, bodyError] =
    await requireBody<AssetKeyPolicyCreate>(request);
  if (bodyError) return bodyError;

  try {
    const sql = getDb();
    const policy = await createAssetKeyPolicy(sql, user.identity, body);
    return jsonResponse(policy, 201);
  } catch (error) {
    if (error instanceof PolicyConflictError) {
      return errorResponse(error.message, 409);
    }
    if (error instanceof InvalidInputError) {
      return errorResponse(error.message, 400);
    }
    if (error instanceof HardwareKeyError) {
      return errorResponse(error.message, error.statusCode);
    }
    console.error("Unexpected error creating key policy:", error);
    return errorResponse("Internal server error", 500);
  }
}

/**
 * GET /keys/policies — List key policies for a specific asset.
 *
 * Query params (required):
 *   asset_type: Asset type to query
 *   asset_id: Asset UUID to query
 */
async function handleListPolicies(
  request: Request,
  _params: Record<string, string>,
  query: URLSearchParams,
): Promise<Response> {
  try {
    await requireUser(request);
  } catch (error) {
    if (error instanceof AuthenticationError) {
      return errorResponse(error.message, 401);
    }
    return errorResponse("Authentication failed", 401);
  }

  const assetType = query.get("asset_type");
  const assetId = query.get("asset_id");

  if (!assetType) {
    return errorResponse("asset_type query parameter is required", 422);
  }
  if (!assetId) {
    return errorResponse("asset_id query parameter is required", 422);
  }

  try {
    const sql = getDb();
    const policies = await listAssetKeyPolicies(sql, assetType, assetId);
    return jsonResponse(policies);
  } catch (error) {
    if (error instanceof InvalidInputError) {
      return errorResponse(error.message, 400);
    }
    if (error instanceof HardwareKeyError) {
      return errorResponse(error.message, error.statusCode);
    }
    console.error("Unexpected error listing key policies:", error);
    return errorResponse("Internal server error", 500);
  }
}

/**
 * GET /keys/policies/:policy_id — Get a specific policy by ID.
 */
async function handleGetPolicy(
  request: Request,
  params: Record<string, string>,
  _query: URLSearchParams,
): Promise<Response> {
  try {
    await requireUser(request);
  } catch (error) {
    if (error instanceof AuthenticationError) {
      return errorResponse(error.message, 401);
    }
    return errorResponse("Authentication failed", 401);
  }

  const policyId = params.policy_id;
  if (!policyId) {
    return errorResponse("policy_id is required", 422);
  }

  try {
    const sql = getDb();
    const policy = await getAssetKeyPolicy(sql, policyId);
    if (policy === null) {
      return errorResponse(`Policy ${policyId} not found`, 404);
    }
    return jsonResponse(policy);
  } catch (error) {
    if (error instanceof HardwareKeyError) {
      return errorResponse(error.message, error.statusCode);
    }
    console.error("Unexpected error getting key policy:", error);
    return errorResponse("Internal server error", 500);
  }
}

/**
 * DELETE /keys/policies/:policy_id — Delete a key policy.
 */
async function handleDeletePolicy(
  request: Request,
  params: Record<string, string>,
  _query: URLSearchParams,
): Promise<Response> {
  try {
    await requireUser(request);
  } catch (error) {
    if (error instanceof AuthenticationError) {
      return errorResponse(error.message, 401);
    }
    return errorResponse("Authentication failed", 401);
  }

  const policyId = params.policy_id;
  if (!policyId) {
    return errorResponse("policy_id is required", 422);
  }

  try {
    const sql = getDb();
    const deleted = await deleteAssetKeyPolicy(sql, policyId);
    if (!deleted) {
      return errorResponse(`Policy ${policyId} not found`, 404);
    }
    return jsonResponse({ deleted: true });
  } catch (error) {
    if (error instanceof HardwareKeyError) {
      return errorResponse(error.message, error.statusCode);
    }
    console.error("Unexpected error deleting key policy:", error);
    return errorResponse("Internal server error", 500);
  }
}

// ============================================================================
// Encrypted Asset Data Handlers
// ============================================================================

/**
 * POST /keys/encrypted-data — Store a client-side encrypted asset payload.
 */
async function handleStoreEncryptedAsset(
  request: Request,
  _params: Record<string, string>,
  _query: URLSearchParams,
): Promise<Response> {
  let user;
  try {
    user = await requireUser(request);
  } catch (error) {
    if (error instanceof AuthenticationError) {
      return errorResponse(error.message, 401);
    }
    return errorResponse("Authentication failed", 401);
  }

  const [body, bodyError] =
    await requireBody<EncryptedAssetStore>(request);
  if (bodyError) return bodyError;

  try {
    const sql = getDb();
    const encryptedAsset = await storeEncryptedAsset(
      sql,
      user.identity,
      body,
    );
    return jsonResponse(encryptedAsset, 201);
  } catch (error) {
    if (error instanceof InvalidAuthorizedKeys) {
      return errorResponse(error.message, 400);
    }
    if (error instanceof InvalidInputError) {
      return errorResponse(error.message, 400);
    }
    if (error instanceof HardwareKeyError) {
      return errorResponse(error.message, error.statusCode);
    }
    console.error("Unexpected error storing encrypted asset:", error);
    return errorResponse("Internal server error", 500);
  }
}

/**
 * GET /keys/encrypted-data — List encrypted asset metadata for the user.
 *
 * Query params (optional):
 *   asset_type: Filter by asset type
 */
async function handleListEncryptedAssets(
  request: Request,
  _params: Record<string, string>,
  query: URLSearchParams,
): Promise<Response> {
  let user;
  try {
    user = await requireUser(request);
  } catch (error) {
    if (error instanceof AuthenticationError) {
      return errorResponse(error.message, 401);
    }
    return errorResponse("Authentication failed", 401);
  }

  const assetType = query.get("asset_type") || undefined;

  try {
    const sql = getDb();
    const assets = await listEncryptedAssetsForUser(
      sql,
      user.identity,
      assetType,
    );
    return jsonResponse(assets);
  } catch (error) {
    if (error instanceof InvalidInputError) {
      return errorResponse(error.message, 400);
    }
    if (error instanceof HardwareKeyError) {
      return errorResponse(error.message, error.statusCode);
    }
    console.error("Unexpected error listing encrypted assets:", error);
    return errorResponse("Internal server error", 500);
  }
}

/**
 * GET /keys/encrypted-data/:asset_type/:asset_id — Retrieve encrypted data.
 *
 * The most complex handler — supports key-assertion gating with 3 query params:
 *   require_key_check: "true" (default) or "false"
 *   action: Protected action (default: "decrypt")
 *   auto_consume: "true" (default) or "false"
 *
 * When `require_key_check=true` and the user lacks assertions → 428 with details.
 */
async function handleGetEncryptedAsset(
  request: Request,
  params: Record<string, string>,
  query: URLSearchParams,
): Promise<Response> {
  let user;
  try {
    user = await requireUser(request);
  } catch (error) {
    if (error instanceof AuthenticationError) {
      return errorResponse(error.message, 401);
    }
    return errorResponse("Authentication failed", 401);
  }

  const assetType = params.asset_type;
  const assetId = params.asset_id;

  if (!assetType) {
    return errorResponse("asset_type is required", 422);
  }
  if (!assetId) {
    return errorResponse("asset_id is required", 422);
  }

  const requireKeyCheck = parseBooleanQuery(
    query.get("require_key_check"),
    true,
  );
  const action = query.get("action") ?? "decrypt";
  const autoConsume = parseBooleanQuery(query.get("auto_consume"), true);

  try {
    const sql = getDb();

    if (requireKeyCheck) {
      const retrievalResult = await getEncryptedAssetWithKeyCheck(
        sql,
        user.identity,
        assetType,
        assetId,
        action,
        autoConsume,
      );

      if (!retrievalResult.access.allowed) {
        // Return 428 Precondition Required with actionable details
        const errorBody = {
          detail: "Hardware key assertion required",
          asset_type: assetType,
          asset_id: assetId,
          action: action,
          requires_assertion: retrievalResult.access.requires_assertion,
          required_key_count: retrievalResult.access.required_key_count,
          assertions_present: retrievalResult.access.assertions_present,
          reason: retrievalResult.access.reason,
        };
        return new Response(JSON.stringify(errorBody), {
          status: 428,
          headers: { "Content-Type": "application/json" },
        });
      }

      return jsonResponse(retrievalResult);
    } else {
      const encryptedAsset = await getEncryptedAsset(
        sql,
        assetType,
        assetId,
      );
      if (encryptedAsset === null) {
        return errorResponse(
          `No encrypted data found for ${assetType}/${assetId}`,
          404,
        );
      }
      return jsonResponse(encryptedAsset);
    }
  } catch (error) {
    if (error instanceof EncryptedAssetNotFoundError) {
      return errorResponse(
        `No encrypted data found for ${assetType}/${assetId}`,
        404,
      );
    }
    if (error instanceof KeyAssertionRequired) {
      const errorBody = {
        detail: "Hardware key assertion required",
        asset_type: error.assetType,
        asset_id: error.assetId,
        action: error.action,
        required_key_count: error.requiredCount,
        assertions_present: error.assertionsPresent,
      };
      return new Response(JSON.stringify(errorBody), {
        status: 428,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (error instanceof InvalidInputError) {
      return errorResponse(error.message, 400);
    }
    if (error instanceof HardwareKeyError) {
      return errorResponse(error.message, error.statusCode);
    }
    console.error("Unexpected error retrieving encrypted asset:", error);
    return errorResponse("Internal server error", 500);
  }
}

/**
 * DELETE /keys/encrypted-data/:asset_type/:asset_id — Delete encrypted data.
 */
async function handleDeleteEncryptedAsset(
  request: Request,
  params: Record<string, string>,
  _query: URLSearchParams,
): Promise<Response> {
  try {
    await requireUser(request);
  } catch (error) {
    if (error instanceof AuthenticationError) {
      return errorResponse(error.message, 401);
    }
    return errorResponse("Authentication failed", 401);
  }

  const assetType = params.asset_type;
  const assetId = params.asset_id;

  if (!assetType) {
    return errorResponse("asset_type is required", 422);
  }
  if (!assetId) {
    return errorResponse("asset_id is required", 422);
  }

  try {
    const sql = getDb();
    const deleted = await deleteEncryptedAsset(sql, assetType, assetId);
    if (!deleted) {
      return errorResponse(
        `No encrypted data found for ${assetType}/${assetId}`,
        404,
      );
    }
    return jsonResponse({ deleted: true });
  } catch (error) {
    if (error instanceof InvalidInputError) {
      return errorResponse(error.message, 400);
    }
    if (error instanceof HardwareKeyError) {
      return errorResponse(error.message, error.statusCode);
    }
    console.error("Unexpected error deleting encrypted asset:", error);
    return errorResponse("Internal server error", 500);
  }
}

/**
 * PATCH /keys/encrypted-data/:asset_type/:asset_id/authorized-keys
 *
 * Update authorized keys and optionally the re-encrypted payload
 * during key rotation.
 */
async function handleUpdateAuthorizedKeys(
  request: Request,
  params: Record<string, string>,
  _query: URLSearchParams,
): Promise<Response> {
  let user;
  try {
    user = await requireUser(request);
  } catch (error) {
    if (error instanceof AuthenticationError) {
      return errorResponse(error.message, 401);
    }
    return errorResponse("Authentication failed", 401);
  }

  const assetType = params.asset_type;
  const assetId = params.asset_id;

  if (!assetType) {
    return errorResponse("asset_type is required", 422);
  }
  if (!assetId) {
    return errorResponse("asset_id is required", 422);
  }

  const [body, bodyError] =
    await requireBody<EncryptedAssetKeyUpdate>(request);
  if (bodyError) return bodyError;

  try {
    const sql = getDb();
    const updatedAsset = await updateAuthorizedKeys(
      sql,
      user.identity,
      assetType,
      assetId,
      body,
    );
    return jsonResponse(updatedAsset);
  } catch (error) {
    if (error instanceof EncryptedAssetNotFoundError) {
      return errorResponse(
        `No encrypted data found for ${assetType}/${assetId}`,
        404,
      );
    }
    if (error instanceof InvalidAuthorizedKeys) {
      return errorResponse(error.message, 400);
    }
    if (error instanceof InvalidInputError) {
      return errorResponse(error.message, 400);
    }
    if (error instanceof HardwareKeyError) {
      return errorResponse(error.message, error.statusCode);
    }
    console.error("Unexpected error updating authorized keys:", error);
    return errorResponse("Internal server error", 500);
  }
}
