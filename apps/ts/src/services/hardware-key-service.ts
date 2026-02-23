/**
 * Hardware key service — TypeScript/Bun port of the Python hardware key service.
 *
 * Provides the core business logic for hardware key CRUD, assertion management,
 * asset key policy CRUD, and key-protected access checks.
 *
 * All database access uses Bun's native `Bun.sql` driver via tagged template
 * literals. No npm packages are required.
 *
 * Reference:
 *   - apps/python/src/server/hardware_key_service.py L366–1331
 *   - Task-07 scratchpad § Implementation Reference
 */

import type { SQL } from "bun";

import { isUniqueViolation } from "../lib/db";
import type {
  HardwareKeyRegistration,
  HardwareKeyUpdate,
  AssertionRecord,
  AssetKeyPolicyCreate,
  HardwareKeyResponse,
  AssertionResponse,
  AssetKeyPolicyResponse,
  KeyProtectedAccessResult,
} from "../models/hardware-keys";
import {
  VALID_DEVICE_TYPES,
  VALID_ASSET_TYPES,
  VALID_PROTECTED_ACTIONS,
  HardwareKeyNotFoundError,
  HardwareKeyConflictError,
  HardwareKeyInactiveError,
  AssertionNotFoundError,
  AssertionConsumedError,
  AssertionExpiredError,
  PolicyConflictError,
  InvalidInputError,
} from "../models/hardware-keys";

// ============================================================================
// Row Converters
// ============================================================================

/**
 * Convert a database timestamp value to an ISO 8601 string.
 *
 * Handles `Date` objects (returned by Bun.sql for `timestamptz` columns),
 * string values, and `null`.
 */
function formatTimestamp(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/**
 * Convert a `hardware_keys` database row to a {@link HardwareKeyResponse}.
 */
export function rowToHardwareKeyResponse(
  row: Record<string, unknown>,
): HardwareKeyResponse {
  return {
    id: String(row.id),
    credential_id: String(row.credential_id),
    friendly_name: row.friendly_name != null ? String(row.friendly_name) : null,
    device_type: row.device_type != null ? String(row.device_type) : null,
    transports: (row.transports as string[]) ?? [],
    attestation_format:
      row.attestation_format != null ? String(row.attestation_format) : null,
    aaguid: row.aaguid != null ? String(row.aaguid) : null,
    is_active: Boolean(row.is_active ?? true),
    last_used_at: formatTimestamp(row.last_used_at),
    created_at: formatTimestamp(row.created_at)!,
    updated_at: formatTimestamp(row.updated_at)!,
  };
}

/**
 * Convert a `key_assertions` database row to an {@link AssertionResponse}.
 */
export function rowToAssertionResponse(
  row: Record<string, unknown>,
): AssertionResponse {
  return {
    assertion_id: String(row.id),
    hardware_key_id: String(row.hardware_key_id),
    expires_at: formatTimestamp(row.expires_at)!,
    consumed: Boolean(row.consumed ?? false),
    asset_type: row.asset_type != null ? String(row.asset_type) : null,
    asset_id: row.asset_id != null ? String(row.asset_id) : null,
  };
}

/**
 * Convert an `asset_key_policies` database row to an {@link AssetKeyPolicyResponse}.
 */
export function rowToPolicyResponse(
  row: Record<string, unknown>,
): AssetKeyPolicyResponse {
  const rawKeyIds = row.required_key_ids as string[] | null;
  return {
    id: String(row.id),
    asset_type: String(row.asset_type),
    asset_id: String(row.asset_id),
    protected_action: String(row.protected_action),
    required_key_count: Number(row.required_key_count),
    required_key_ids: rawKeyIds ? rawKeyIds.map(String) : null,
    created_by_user_id:
      row.created_by_user_id != null ? String(row.created_by_user_id) : null,
    created_at: formatTimestamp(row.created_at)!,
    updated_at: formatTimestamp(row.updated_at)!,
  };
}

// ============================================================================
// Validation Helpers
// ============================================================================

/**
 * Validate `device_type` against the allowed enum values.
 *
 * @throws InvalidInputError if the value is not in {@link VALID_DEVICE_TYPES}.
 */
function validateDeviceType(deviceType: string | null | undefined): void {
  if (
    deviceType != null &&
    deviceType !== undefined &&
    !VALID_DEVICE_TYPES.has(deviceType)
  ) {
    throw new InvalidInputError(
      `Invalid device_type '${deviceType}'. Allowed: ${JSON.stringify([...VALID_DEVICE_TYPES].sort())}`,
    );
  }
}

/**
 * Validate `asset_type` against the allowed enum values.
 *
 * @throws InvalidInputError if the value is not in {@link VALID_ASSET_TYPES}.
 */
function validateAssetType(assetType: string): void {
  if (!VALID_ASSET_TYPES.has(assetType)) {
    throw new InvalidInputError(
      `Invalid asset_type '${assetType}'. Allowed: ${JSON.stringify([...VALID_ASSET_TYPES].sort())}`,
    );
  }
}

/**
 * Validate `protected_action` against the allowed enum values.
 *
 * @throws InvalidInputError if the value is not in {@link VALID_PROTECTED_ACTIONS}.
 */
function validateProtectedAction(protectedAction: string): void {
  if (!VALID_PROTECTED_ACTIONS.has(protectedAction)) {
    throw new InvalidInputError(
      `Invalid protected_action '${protectedAction}'. Allowed: ${JSON.stringify([...VALID_PROTECTED_ACTIONS].sort())}`,
    );
  }
}

/**
 * Validate that `asset_type` and `asset_id` are either both set or both null.
 *
 * Mirrors the CHECK constraint on `key_assertions`:
 *   (asset_type IS NULL AND asset_id IS NULL) OR
 *   (asset_type IS NOT NULL AND asset_id IS NOT NULL)
 *
 * @throws InvalidInputError if only one of the pair is set.
 */
function validateAssetScope(
  assetType: string | null | undefined,
  assetId: string | null | undefined,
): void {
  const hasType = assetType != null;
  const hasId = assetId != null;
  if (hasType !== hasId) {
    throw new InvalidInputError(
      "asset_type and asset_id must both be provided or both be null",
    );
  }
  if (hasType) {
    validateAssetType(assetType!);
  }
}

/**
 * Decode a base64url/base64-encoded public key string to a `Buffer` suitable
 * for insertion into a `bytea` column.
 *
 * @throws InvalidInputError if the value is not valid base64.
 */
function decodePublicKey(value: string): Buffer {
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    return Buffer.from(padded, "base64");
  } catch {
    throw new InvalidInputError("Invalid base64url-encoded public_key");
  }
}

// ============================================================================
// Hardware Key CRUD
// ============================================================================

/**
 * Register a new hardware key for a user.
 *
 * Stores the WebAuthn credential in `hardware_keys`. The `credential_id`
 * must be globally unique (enforced by a UNIQUE constraint).
 *
 * @param sql - Bun.sql database instance.
 * @param userId - UUID of the authenticated user.
 * @param registration - Registration payload with credential data.
 * @returns The newly created hardware key.
 *
 * @throws HardwareKeyConflictError if the credential_id already exists.
 * @throws InvalidInputError if device_type is invalid.
 */
export async function registerHardwareKey(
  sql: InstanceType<typeof SQL>,
  userId: string,
  registration: HardwareKeyRegistration,
): Promise<HardwareKeyResponse> {
  validateDeviceType(registration.device_type);

  const publicKeyBytes = decodePublicKey(registration.public_key);

  try {
    const rows = await sql`
      INSERT INTO public.hardware_keys (
        user_id, credential_id, public_key, counter, transports,
        friendly_name, device_type, attestation_format, aaguid
      )
      VALUES (
        ${userId}, ${registration.credential_id}, ${publicKeyBytes},
        ${registration.counter ?? 0},
        ${registration.transports ?? []},
        ${registration.friendly_name ?? null},
        ${registration.device_type ?? null},
        ${registration.attestation_format ?? null},
        ${registration.aaguid ?? null}
      )
      RETURNING *
    `;
    const row = rows[0];
    return rowToHardwareKeyResponse(row as Record<string, unknown>);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new HardwareKeyConflictError(registration.credential_id);
    }
    throw error;
  }
}

/**
 * List hardware keys registered by a user.
 *
 * @param sql - Bun.sql database instance.
 * @param userId - UUID of the authenticated user.
 * @param includeInactive - If true, include deactivated keys.
 * @returns List of hardware key metadata.
 */
export async function listUserHardwareKeys(
  sql: InstanceType<typeof SQL>,
  userId: string,
  includeInactive = false,
): Promise<HardwareKeyResponse[]> {
  let rows: Record<string, unknown>[];

  if (includeInactive) {
    rows = await sql`
      SELECT * FROM public.hardware_keys
      WHERE user_id = ${userId}
      ORDER BY created_at DESC
    `;
  } else {
    rows = await sql`
      SELECT * FROM public.hardware_keys
      WHERE user_id = ${userId} AND is_active = true
      ORDER BY created_at DESC
    `;
  }

  return rows.map((row) => rowToHardwareKeyResponse(row));
}

/**
 * Get a specific hardware key by ID.
 *
 * @param sql - Bun.sql database instance.
 * @param userId - UUID of the authenticated user (ownership check).
 * @param keyId - UUID of the hardware key.
 * @returns Hardware key metadata.
 *
 * @throws HardwareKeyNotFoundError if not found or not owned by user.
 */
export async function getHardwareKey(
  sql: InstanceType<typeof SQL>,
  userId: string,
  keyId: string,
): Promise<HardwareKeyResponse> {
  const rows = await sql`
    SELECT * FROM public.hardware_keys
    WHERE id = ${keyId} AND user_id = ${userId}
  `;
  const row = rows[0];

  if (!row) {
    throw new HardwareKeyNotFoundError(keyId);
  }

  return rowToHardwareKeyResponse(row as Record<string, unknown>);
}

/**
 * Update mutable metadata fields on a hardware key.
 *
 * Only `friendly_name` and `device_type` can be updated. Cryptographic
 * fields are immutable.
 *
 * Uses separate UPDATE queries per field because Bun.sql tagged templates
 * don't easily compose dynamic SET clauses. When both fields are provided,
 * both are set in a single query using `sql.unsafe()` with parameterised
 * values to keep it safe.
 *
 * @param sql - Bun.sql database instance.
 * @param userId - UUID of the authenticated user (ownership check).
 * @param keyId - UUID of the hardware key to update.
 * @param updates - Fields to update.
 * @returns Updated hardware key metadata.
 *
 * @throws HardwareKeyNotFoundError if not found or not owned by user.
 * @throws InvalidInputError if device_type is invalid.
 */
export async function updateHardwareKey(
  sql: InstanceType<typeof SQL>,
  userId: string,
  keyId: string,
  updates: HardwareKeyUpdate,
): Promise<HardwareKeyResponse> {
  validateDeviceType(updates.device_type);

  // Build dynamic SET clause
  const setClauses: string[] = [];
  const params: unknown[] = [];

  if (updates.friendly_name !== undefined) {
    params.push(updates.friendly_name);
    setClauses.push(`friendly_name = $${params.length}`);
  }

  if (updates.device_type !== undefined) {
    params.push(updates.device_type);
    setClauses.push(`device_type = $${params.length}`);
  }

  if (setClauses.length === 0) {
    // Nothing to update — return current state
    return getHardwareKey(sql, userId, keyId);
  }

  // Add key_id and user_id to params
  params.push(keyId);
  const keyIdParam = `$${params.length}`;
  params.push(userId);
  const userIdParam = `$${params.length}`;

  const query = `
    UPDATE public.hardware_keys
    SET ${setClauses.join(", ")}
    WHERE id = ${keyIdParam} AND user_id = ${userIdParam}
    RETURNING *
  `;

  const rows = await sql.unsafe(query, params);
  const row = rows[0];

  if (!row) {
    throw new HardwareKeyNotFoundError(keyId);
  }

  return rowToHardwareKeyResponse(row as Record<string, unknown>);
}

/**
 * Soft-deactivate a hardware key (set `is_active = false`).
 *
 * Deactivated keys remain in the database for audit purposes but cannot
 * be used for new assertions. Existing unconsumed assertions referencing
 * this key are NOT invalidated — they will naturally expire.
 *
 * @param sql - Bun.sql database instance.
 * @param userId - UUID of the authenticated user (ownership check).
 * @param keyId - UUID of the hardware key to deactivate.
 * @returns Updated hardware key metadata with `is_active = false`.
 *
 * @throws HardwareKeyNotFoundError if not found or not owned by user.
 */
export async function deactivateHardwareKey(
  sql: InstanceType<typeof SQL>,
  userId: string,
  keyId: string,
): Promise<HardwareKeyResponse> {
  const rows = await sql`
    UPDATE public.hardware_keys
    SET is_active = false
    WHERE id = ${keyId} AND user_id = ${userId}
    RETURNING *
  `;
  const row = rows[0];

  if (!row) {
    throw new HardwareKeyNotFoundError(keyId);
  }

  return rowToHardwareKeyResponse(row as Record<string, unknown>);
}

// ============================================================================
// Assertion Management
// ============================================================================

/**
 * Record a verified key assertion.
 *
 * In production, the Supabase Edge Function verifies the WebAuthn assertion
 * signature against the stored public key and then calls this function.
 * For development/testing, this can be called directly.
 *
 * The assertion has a 5-minute TTL (`expires_at = now() + 5 min`) and is
 * single-use (`consumed` flag).
 *
 * @param sql - Bun.sql database instance.
 * @param userId - UUID of the authenticated user.
 * @param assertion - Assertion details.
 * @returns The created assertion record.
 *
 * @throws HardwareKeyNotFoundError if the hardware key doesn't exist.
 * @throws HardwareKeyInactiveError if the hardware key is deactivated.
 * @throws InvalidInputError if asset_type/asset_id scope is inconsistent.
 */
export async function recordAssertion(
  sql: InstanceType<typeof SQL>,
  userId: string,
  assertion: AssertionRecord,
): Promise<AssertionResponse> {
  validateAssetScope(assertion.asset_type, assertion.asset_id);

  // Verify the hardware key exists, belongs to user, and is active
  const keyRows = await sql`
    SELECT id, is_active, counter FROM public.hardware_keys
    WHERE id = ${assertion.hardware_key_id} AND user_id = ${userId}
  `;
  const keyRow = keyRows[0] as Record<string, unknown> | undefined;

  if (!keyRow) {
    throw new HardwareKeyNotFoundError(assertion.hardware_key_id);
  }

  if (!keyRow.is_active) {
    throw new HardwareKeyInactiveError(assertion.hardware_key_id);
  }

  // Record the assertion
  const rows = await sql`
    INSERT INTO public.key_assertions (
      user_id, hardware_key_id, challenge,
      asset_type, asset_id
    )
    VALUES (
      ${userId}, ${assertion.hardware_key_id}, ${assertion.challenge},
      ${assertion.asset_type ?? null}, ${assertion.asset_id ?? null}
    )
    RETURNING *
  `;
  const row = rows[0] as Record<string, unknown>;

  // Update hardware key usage metadata
  await sql`
    UPDATE public.hardware_keys
    SET last_used_at = now(), counter = counter + 1
    WHERE id = ${assertion.hardware_key_id}
  `;

  return rowToAssertionResponse(row);
}

/**
 * Get a specific key assertion by ID.
 *
 * @param sql - Bun.sql database instance.
 * @param userId - UUID of the authenticated user (ownership check).
 * @param assertionId - UUID of the assertion.
 * @returns Assertion details.
 *
 * @throws AssertionNotFoundError if not found or not owned by user.
 */
export async function getAssertion(
  sql: InstanceType<typeof SQL>,
  userId: string,
  assertionId: string,
): Promise<AssertionResponse> {
  const rows = await sql`
    SELECT * FROM public.key_assertions
    WHERE id = ${assertionId} AND user_id = ${userId}
  `;
  const row = rows[0] as Record<string, unknown> | undefined;

  if (!row) {
    throw new AssertionNotFoundError(assertionId);
  }

  return rowToAssertionResponse(row);
}

/**
 * Mark a key assertion as consumed (single-use).
 *
 * A consumed assertion cannot be reused. This validates that the assertion:
 * - Exists and belongs to the user
 * - Has not already been consumed
 * - Has not expired
 *
 * @param sql - Bun.sql database instance.
 * @param userId - UUID of the authenticated user (ownership check).
 * @param assertionId - UUID of the assertion to consume.
 * @returns Updated assertion with `consumed = true`.
 *
 * @throws AssertionNotFoundError if not found or not owned by user.
 * @throws AssertionConsumedError if already consumed.
 * @throws AssertionExpiredError if past expiry time.
 */
export async function consumeAssertion(
  sql: InstanceType<typeof SQL>,
  userId: string,
  assertionId: string,
): Promise<AssertionResponse> {
  // Fetch current state
  const rows = await sql`
    SELECT * FROM public.key_assertions
    WHERE id = ${assertionId} AND user_id = ${userId}
  `;
  const row = rows[0] as Record<string, unknown> | undefined;

  if (!row) {
    throw new AssertionNotFoundError(assertionId);
  }

  if (row.consumed) {
    throw new AssertionConsumedError(assertionId);
  }

  // Check expiry using database time to avoid clock skew
  const expiryRows = await sql`
    SELECT (expires_at < now()) AS is_expired
    FROM public.key_assertions
    WHERE id = ${assertionId}
  `;
  const expiryRow = expiryRows[0] as Record<string, unknown> | undefined;
  if (expiryRow && expiryRow.is_expired) {
    throw new AssertionExpiredError(assertionId);
  }

  // Mark as consumed
  const updateRows = await sql`
    UPDATE public.key_assertions
    SET consumed = true, consumed_at = now()
    WHERE id = ${assertionId} AND user_id = ${userId}
    RETURNING *
  `;
  const updatedRow = updateRows[0] as Record<string, unknown>;

  return rowToAssertionResponse(updatedRow);
}

/**
 * List valid (unexpired, unconsumed) assertions for a user.
 *
 * Optionally filtered by asset scope. Returns both scoped and general
 * (unscoped) assertions when a specific asset is queried — matching
 * the same logic used by `check_key_protected_access()`.
 *
 * @param sql - Bun.sql database instance.
 * @param userId - UUID of the authenticated user.
 * @param assetType - Optional asset type filter.
 * @param assetId - Optional asset UUID filter.
 * @returns List of valid assertion records.
 */
export async function listValidAssertions(
  sql: InstanceType<typeof SQL>,
  userId: string,
  assetType?: string | null,
  assetId?: string | null,
): Promise<AssertionResponse[]> {
  let rows: Record<string, unknown>[];

  if (assetType && assetId) {
    rows = await sql`
      SELECT * FROM public.key_assertions
      WHERE user_id = ${userId}
        AND consumed = false
        AND expires_at > now()
        AND (
          (asset_type = ${assetType} AND asset_id = ${assetId})
          OR asset_type IS NULL
        )
      ORDER BY verified_at DESC
    `;
  } else {
    rows = await sql`
      SELECT * FROM public.key_assertions
      WHERE user_id = ${userId}
        AND consumed = false
        AND expires_at > now()
      ORDER BY verified_at DESC
    `;
  }

  return rows.map((row) => rowToAssertionResponse(row));
}

// ============================================================================
// Asset Key Policies
// ============================================================================

/**
 * Create a key policy requiring hardware key touch for an asset operation.
 *
 * @param sql - Bun.sql database instance.
 * @param userId - UUID of the authenticated user (recorded as creator).
 * @param policy - Policy definition.
 * @returns The created policy record.
 *
 * @throws PolicyConflictError if a policy already exists for this asset+action.
 * @throws InvalidInputError if asset_type or protected_action is invalid.
 */
export async function createAssetKeyPolicy(
  sql: InstanceType<typeof SQL>,
  userId: string,
  policy: AssetKeyPolicyCreate,
): Promise<AssetKeyPolicyResponse> {
  validateAssetType(policy.asset_type);
  validateProtectedAction(policy.protected_action);

  const requiredKeyCount = policy.required_key_count ?? 1;
  if (requiredKeyCount < 1) {
    throw new InvalidInputError("required_key_count must be >= 1");
  }

  try {
    const rows = await sql`
      INSERT INTO public.asset_key_policies (
        asset_type, asset_id, protected_action,
        required_key_count, required_key_ids, created_by_user_id
      )
      VALUES (
        ${policy.asset_type}, ${policy.asset_id}, ${policy.protected_action},
        ${requiredKeyCount}, ${policy.required_key_ids ?? null},
        ${userId}
      )
      RETURNING *
    `;
    const row = rows[0] as Record<string, unknown>;
    return rowToPolicyResponse(row);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new PolicyConflictError(
        policy.asset_type,
        policy.asset_id,
        policy.protected_action,
      );
    }
    throw error;
  }
}

/**
 * List all key policies for a specific asset.
 *
 * @param sql - Bun.sql database instance.
 * @param assetType - Asset type to query.
 * @param assetId - Asset UUID to query.
 * @returns List of policy records for the asset.
 */
export async function listAssetKeyPolicies(
  sql: InstanceType<typeof SQL>,
  assetType: string,
  assetId: string,
): Promise<AssetKeyPolicyResponse[]> {
  validateAssetType(assetType);

  const rows: Record<string, unknown>[] = await sql`
    SELECT * FROM public.asset_key_policies
    WHERE asset_type = ${assetType} AND asset_id = ${assetId}
    ORDER BY protected_action
  `;

  return rows.map((row) => rowToPolicyResponse(row));
}

/**
 * Get a specific asset key policy by ID.
 *
 * @param sql - Bun.sql database instance.
 * @param policyId - UUID of the policy.
 * @returns Policy record, or null if not found.
 */
export async function getAssetKeyPolicy(
  sql: InstanceType<typeof SQL>,
  policyId: string,
): Promise<AssetKeyPolicyResponse | null> {
  const rows = await sql`
    SELECT * FROM public.asset_key_policies
    WHERE id = ${policyId}
  `;
  const row = rows[0] as Record<string, unknown> | undefined;

  return row ? rowToPolicyResponse(row) : null;
}

/**
 * Delete an asset key policy.
 *
 * @param sql - Bun.sql database instance.
 * @param policyId - UUID of the policy to delete.
 * @returns True if a policy was deleted, false if not found.
 */
export async function deleteAssetKeyPolicy(
  sql: InstanceType<typeof SQL>,
  policyId: string,
): Promise<boolean> {
  const rows = await sql`
    DELETE FROM public.asset_key_policies
    WHERE id = ${policyId}
    RETURNING id
  `;
  return rows.length > 0;
}

// ============================================================================
// Key-Protected Access Check
// ============================================================================

/**
 * Check whether the user has key-protected access to an asset for an action.
 *
 * Steps:
 * 1. Look up key policy for `(asset_type, asset_id, action)`
 * 2. If no policy → access allowed (no key required)
 * 3. If policy exists → count valid assertions from this user
 * 4. Compare against `required_key_count`
 *
 * @param sql - Bun.sql database instance.
 * @param userId - UUID of the user to check.
 * @param assetType - Asset type to check.
 * @param assetId - Asset UUID to check.
 * @param action - Protected action to check (default "decrypt").
 * @returns Rich result with access status and details.
 */
export async function checkKeyProtectedAccess(
  sql: InstanceType<typeof SQL>,
  userId: string,
  assetType: string,
  assetId: string,
  action = "decrypt",
): Promise<KeyProtectedAccessResult> {
  validateAssetType(assetType);
  validateProtectedAction(action);

  // Step 1: Look up key policy
  const policyRows = await sql`
    SELECT required_key_count, required_key_ids
    FROM public.asset_key_policies
    WHERE asset_type = ${assetType}
      AND asset_id = ${assetId}
      AND protected_action = ${action}
  `;
  const policyRow = policyRows[0] as Record<string, unknown> | undefined;

  // Step 2: No policy → no key required
  if (!policyRow) {
    return {
      allowed: true,
      reason: "No key policy exists for this asset and action",
      requires_assertion: false,
      required_key_count: null,
      assertions_present: null,
    };
  }

  const requiredCount = Number(policyRow.required_key_count);
  const requiredKeyIds = policyRow.required_key_ids as string[] | null;

  // Step 3: Count valid assertions
  // For multi-key: count distinct users. For single-key: count this user's assertions.
  let assertionCount: number;

  if (requiredCount > 1) {
    // Multi-key: count distinct users with valid assertions
    if (requiredKeyIds && requiredKeyIds.length > 0) {
      const assertionRows = await sql`
        SELECT COUNT(DISTINCT ka.user_id) AS assertion_count
        FROM public.key_assertions ka
        WHERE ka.consumed = false
          AND ka.expires_at > now()
          AND (
            (ka.asset_type = ${assetType} AND ka.asset_id = ${assetId})
            OR ka.asset_type IS NULL
          )
          AND ka.hardware_key_id = ANY(${requiredKeyIds})
      `;
      assertionCount = Number(
        (assertionRows[0] as Record<string, unknown>)?.assertion_count ?? 0,
      );
    } else {
      const assertionRows = await sql`
        SELECT COUNT(DISTINCT ka.user_id) AS assertion_count
        FROM public.key_assertions ka
        WHERE ka.consumed = false
          AND ka.expires_at > now()
          AND (
            (ka.asset_type = ${assetType} AND ka.asset_id = ${assetId})
            OR ka.asset_type IS NULL
          )
      `;
      assertionCount = Number(
        (assertionRows[0] as Record<string, unknown>)?.assertion_count ?? 0,
      );
    }
  } else {
    // Single-key: count assertions from this specific user
    if (requiredKeyIds && requiredKeyIds.length > 0) {
      const assertionRows = await sql`
        SELECT COUNT(*) AS assertion_count
        FROM public.key_assertions ka
        WHERE ka.user_id = ${userId}
          AND ka.consumed = false
          AND ka.expires_at > now()
          AND (
            (ka.asset_type = ${assetType} AND ka.asset_id = ${assetId})
            OR ka.asset_type IS NULL
          )
          AND ka.hardware_key_id = ANY(${requiredKeyIds})
      `;
      assertionCount = Number(
        (assertionRows[0] as Record<string, unknown>)?.assertion_count ?? 0,
      );
    } else {
      const assertionRows = await sql`
        SELECT COUNT(*) AS assertion_count
        FROM public.key_assertions ka
        WHERE ka.user_id = ${userId}
          AND ka.consumed = false
          AND ka.expires_at > now()
          AND (
            (ka.asset_type = ${assetType} AND ka.asset_id = ${assetId})
            OR ka.asset_type IS NULL
          )
      `;
      assertionCount = Number(
        (assertionRows[0] as Record<string, unknown>)?.assertion_count ?? 0,
      );
    }
  }

  // Step 4: Compare
  const allowed = assertionCount >= requiredCount;

  let reason: string;
  if (allowed) {
    reason =
      `Access granted: ${assertionCount} assertion(s) present, ` +
      `${requiredCount} required`;
  } else if (assertionCount === 0) {
    reason =
      `Hardware key assertion required: ${requiredCount} key touch(es) ` +
      `needed for '${action}' on this ${assetType}`;
  } else {
    reason =
      `Insufficient assertions: ${assertionCount} of ${requiredCount} ` +
      `required key touches present`;
  }

  return {
    allowed,
    reason,
    requires_assertion: true,
    required_key_count: requiredCount,
    assertions_present: assertionCount,
  };
}

// ============================================================================
// Internal Helpers (exported for use by encryption-service)
// ============================================================================

/**
 * Consume all matching valid assertions for a user and asset.
 *
 * Called after a key-gated operation succeeds to mark assertions as used
 * (single-use). Consumes both scoped assertions (matching the specific
 * asset) and general (unscoped) assertions.
 *
 * @param sql - Bun.sql database instance.
 * @param userId - UUID of the user.
 * @param assetType - Asset type that was accessed.
 * @param assetId - Asset UUID that was accessed.
 * @returns Number of assertions consumed.
 */
export async function consumeMatchingAssertions(
  sql: InstanceType<typeof SQL>,
  userId: string,
  assetType: string,
  assetId: string,
): Promise<number> {
  const result = await sql`
    UPDATE public.key_assertions
    SET consumed = true, consumed_at = now()
    WHERE user_id = ${userId}
      AND consumed = false
      AND expires_at > now()
      AND (
        (asset_type = ${assetType} AND asset_id = ${assetId})
        OR asset_type IS NULL
      )
  `;

  return (result as unknown as { count: number }).count ?? 0;
}
