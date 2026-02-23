/**
 * Encryption service — TypeScript/Bun port of the Python encryption service.
 *
 * Provides business logic for storing, retrieving, listing, and deleting
 * client-side encrypted asset data. The server never sees plaintext — it
 * stores ciphertext, IV, algorithm metadata, and authorized key lists.
 *
 * Key-gated retrieval checks hardware key assertion policies before
 * releasing ciphertext, optionally auto-consuming assertions.
 *
 * All database access uses Bun's native `Bun.sql` driver via tagged template
 * literals. No npm packages are required.
 *
 * Reference:
 *   - apps/python/src/server/encryption_service.py L296–915
 *   - Task-07 scratchpad § Implementation Reference
 */

import type { SQL } from "bun";

import type {
  EncryptedAssetStore,
  EncryptedAssetKeyUpdate,
  EncryptedAssetResponse,
  EncryptedAssetMetadata,
  KeyGatedRetrievalResult,
} from "../models/hardware-keys";
import {
  VALID_ASSET_TYPES,
  VALID_ENCRYPTION_ALGORITHMS,
  VALID_KEY_DERIVATION_METHODS,
  VALID_PROTECTED_ACTIONS,
  InvalidInputError,
  InvalidAuthorizedKeys,
  EncryptedAssetNotFoundError,
} from "../models/hardware-keys";
import {
  checkKeyProtectedAccess,
  consumeMatchingAssertions,
} from "./hardware-key-service";

// ============================================================================
// Validation Helpers
// ============================================================================

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
 * Validate `encryption_algorithm` against the allowed enum values.
 *
 * @throws InvalidInputError if the value is not in {@link VALID_ENCRYPTION_ALGORITHMS}.
 */
function validateEncryptionAlgorithm(algorithm: string): void {
  if (!VALID_ENCRYPTION_ALGORITHMS.has(algorithm)) {
    throw new InvalidInputError(
      `Invalid encryption_algorithm '${algorithm}'. Allowed: ${JSON.stringify([...VALID_ENCRYPTION_ALGORITHMS].sort())}`,
    );
  }
}

/**
 * Validate `key_derivation_method` against the allowed enum values.
 *
 * @throws InvalidInputError if the value is not in {@link VALID_KEY_DERIVATION_METHODS}.
 */
function validateKeyDerivationMethod(method: string): void {
  if (!VALID_KEY_DERIVATION_METHODS.has(method)) {
    throw new InvalidInputError(
      `Invalid key_derivation_method '${method}'. Allowed: ${JSON.stringify([...VALID_KEY_DERIVATION_METHODS].sort())}`,
    );
  }
}

/**
 * Validate `protected_action` against the allowed enum values.
 *
 * @throws InvalidInputError if the value is not in {@link VALID_PROTECTED_ACTIONS}.
 */
function validateProtectedAction(action: string): void {
  if (!VALID_PROTECTED_ACTIONS.has(action)) {
    throw new InvalidInputError(
      `Invalid protected_action '${action}'. Allowed: ${JSON.stringify([...VALID_PROTECTED_ACTIONS].sort())}`,
    );
  }
}

// ============================================================================
// Base64 ↔ Bytea Conversion
// ============================================================================

/**
 * Decode a base64/base64url-encoded string to a `Buffer` suitable for
 * insertion into a PostgreSQL `bytea` column.
 *
 * Accepts both standard base64 and base64url encoding (with or without
 * padding).
 *
 * @param value - Base64-encoded string.
 * @param fieldName - Name of the field (for error messages).
 * @returns Decoded bytes as a Buffer.
 *
 * @throws InvalidInputError if the value is not valid base64.
 */
function decodeBase64Field(value: string, fieldName: string): Buffer {
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded =
      normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    return Buffer.from(padded, "base64");
  } catch {
    throw new InvalidInputError(`Invalid base64 encoding for ${fieldName}`);
  }
}

/**
 * Encode a Buffer/Uint8Array (from a PostgreSQL `bytea` column) to a
 * standard base64 string for API responses.
 */
function encodeBytesToBase64(value: Buffer | Uint8Array): string {
  return Buffer.from(value).toString("base64");
}

// ============================================================================
// Row Converters
// ============================================================================

/**
 * Convert a database timestamp value to an ISO 8601 string.
 */
function formatTimestamp(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/**
 * Convert an `encrypted_asset_data` database row to an
 * {@link EncryptedAssetResponse}.
 *
 * Encodes `bytea` columns (`encrypted_payload`, `initialization_vector`)
 * to base64 strings for API transport.
 */
export function rowToEncryptedAssetResponse(
  row: Record<string, unknown>,
): EncryptedAssetResponse {
  const payload = row.encrypted_payload;
  const initializationVector = row.initialization_vector;
  const rawKeyIds = (row.authorized_key_ids as string[]) ?? [];

  return {
    id: String(row.id),
    asset_type: String(row.asset_type),
    asset_id: String(row.asset_id),
    encrypted_payload: Buffer.isBuffer(payload)
      ? encodeBytesToBase64(payload)
      : payload instanceof Uint8Array
        ? encodeBytesToBase64(payload)
        : String(payload),
    encryption_algorithm: String(row.encryption_algorithm),
    key_derivation_method: String(row.key_derivation_method),
    initialization_vector: Buffer.isBuffer(initializationVector)
      ? encodeBytesToBase64(initializationVector)
      : initializationVector instanceof Uint8Array
        ? encodeBytesToBase64(initializationVector)
        : String(initializationVector),
    authorized_key_ids: rawKeyIds.map(String),
    encrypted_by_user_id:
      row.encrypted_by_user_id != null
        ? String(row.encrypted_by_user_id)
        : null,
    created_at: formatTimestamp(row.created_at)!,
    updated_at: formatTimestamp(row.updated_at)!,
  };
}

/**
 * Convert an `encrypted_asset_data` database row to an
 * {@link EncryptedAssetMetadata} (lightweight — no ciphertext).
 */
export function rowToEncryptedAssetMetadata(
  row: Record<string, unknown>,
): EncryptedAssetMetadata {
  const rawKeyIds = (row.authorized_key_ids as string[]) ?? [];

  return {
    id: String(row.id),
    asset_type: String(row.asset_type),
    asset_id: String(row.asset_id),
    encryption_algorithm: String(row.encryption_algorithm),
    key_derivation_method: String(row.key_derivation_method),
    authorized_key_ids: rawKeyIds.map(String),
    encrypted_by_user_id:
      row.encrypted_by_user_id != null
        ? String(row.encrypted_by_user_id)
        : null,
    created_at: formatTimestamp(row.created_at)!,
  };
}

// ============================================================================
// Internal Helpers
// ============================================================================

/**
 * Validate that all `authorized_key_ids` reference existing hardware keys.
 *
 * @param sql - Bun.sql database instance.
 * @param authorizedKeyIds - List of hardware key UUIDs to validate.
 *
 * @throws InvalidInputError if the list is empty.
 * @throws InvalidAuthorizedKeys if any key IDs don't exist.
 */
async function validateAuthorizedKeyIds(
  sql: InstanceType<typeof SQL>,
  authorizedKeyIds: string[],
): Promise<void> {
  if (!authorizedKeyIds || authorizedKeyIds.length === 0) {
    throw new InvalidInputError(
      "authorized_key_ids must contain at least one key ID",
    );
  }

  const foundRows: Record<string, unknown>[] = await sql`
    SELECT id FROM public.hardware_keys
    WHERE id = ANY(${authorizedKeyIds})
  `;

  const foundIds = new Set(foundRows.map((row) => String(row.id)));
  const missingIds = authorizedKeyIds.filter((keyId) => !foundIds.has(keyId));

  if (missingIds.length > 0) {
    throw new InvalidAuthorizedKeys(missingIds.sort());
  }
}

// ============================================================================
// Encrypted Asset CRUD
// ============================================================================

/**
 * Store a client-encrypted asset payload.
 *
 * The server stores the ciphertext, IV, algorithm metadata, and authorized
 * key list. The server never sees plaintext.
 *
 * @param sql - Bun.sql database instance.
 * @param userId - UUID of the authenticated user (recorded as encryptor).
 * @param data - Encrypted asset payload and metadata.
 * @returns The stored encrypted asset record.
 *
 * @throws InvalidInputError if asset_type, algorithm, or KDF method is invalid.
 * @throws InvalidAuthorizedKeys if any authorized_key_ids don't exist.
 */
export async function storeEncryptedAsset(
  sql: InstanceType<typeof SQL>,
  userId: string,
  data: EncryptedAssetStore,
): Promise<EncryptedAssetResponse> {
  validateAssetType(data.asset_type);

  const encryptionAlgorithm = data.encryption_algorithm ?? "AES-GCM-256";
  const keyDerivationMethod =
    data.key_derivation_method ?? "webauthn-prf-hkdf";

  validateEncryptionAlgorithm(encryptionAlgorithm);
  validateKeyDerivationMethod(keyDerivationMethod);

  // Validate authorized keys exist
  await validateAuthorizedKeyIds(sql, data.authorized_key_ids);

  // Decode base64 fields to bytes for bytea storage
  const encryptedPayloadBytes = decodeBase64Field(
    data.encrypted_payload,
    "encrypted_payload",
  );
  const initializationVectorBytes = decodeBase64Field(
    data.initialization_vector,
    "initialization_vector",
  );

  const rows = await sql`
    INSERT INTO public.encrypted_asset_data (
      asset_type, asset_id, encrypted_payload,
      encryption_algorithm, key_derivation_method,
      initialization_vector, authorized_key_ids,
      encrypted_by_user_id
    )
    VALUES (
      ${data.asset_type}, ${data.asset_id}, ${encryptedPayloadBytes},
      ${encryptionAlgorithm}, ${keyDerivationMethod},
      ${initializationVectorBytes}, ${data.authorized_key_ids},
      ${userId}
    )
    RETURNING *
  `;
  const row = rows[0] as Record<string, unknown>;

  return rowToEncryptedAssetResponse(row);
}

/**
 * Retrieve encrypted asset data with base permission check only.
 *
 * This does NOT check key assertions — it returns ciphertext to anyone with
 * base read permission. Use {@link getEncryptedAssetWithKeyCheck} for
 * key-assertion-gated retrieval.
 *
 * @param sql - Bun.sql database instance.
 * @param assetType - Asset type to query.
 * @param assetId - Asset UUID to query.
 * @returns Encrypted asset data, or null if not found.
 */
export async function getEncryptedAsset(
  sql: InstanceType<typeof SQL>,
  assetType: string,
  assetId: string,
): Promise<EncryptedAssetResponse | null> {
  validateAssetType(assetType);

  const rows = await sql`
    SELECT * FROM public.encrypted_asset_data
    WHERE asset_type = ${assetType} AND asset_id = ${assetId}
    ORDER BY created_at DESC
    LIMIT 1
  `;
  const row = rows[0] as Record<string, unknown> | undefined;

  if (!row) {
    return null;
  }

  return rowToEncryptedAssetResponse(row);
}

/**
 * Retrieve encrypted asset data with key-assertion gating.
 *
 * This is the primary retrieval method for key-protected assets:
 *
 * 1. Look up key policy for `(asset_type, asset_id, action)`
 * 2. If no policy → return data with base permission check only
 * 3. If policy exists → verify valid assertion(s) from the user
 * 4. If assertions are sufficient → return data (and optionally consume assertions)
 * 5. If assertions are insufficient → return access result with details
 *
 * @param sql - Bun.sql database instance.
 * @param userId - UUID of the authenticated user.
 * @param assetType - Asset type to query.
 * @param assetId - Asset UUID to query.
 * @param action - Protected action to check (default "decrypt").
 * @param autoConsume - If true, auto-consume matching assertions on access grant.
 * @returns `KeyGatedRetrievalResult` with access status and optionally encrypted data.
 *
 * @throws EncryptedAssetNotFoundError if no encrypted data exists for the asset.
 */
export async function getEncryptedAssetWithKeyCheck(
  sql: InstanceType<typeof SQL>,
  userId: string,
  assetType: string,
  assetId: string,
  action = "decrypt",
  autoConsume = true,
): Promise<KeyGatedRetrievalResult> {
  validateAssetType(assetType);
  validateProtectedAction(action);

  // Check if encrypted data exists at all
  const dataRows = await sql`
    SELECT * FROM public.encrypted_asset_data
    WHERE asset_type = ${assetType} AND asset_id = ${assetId}
    ORDER BY created_at DESC
    LIMIT 1
  `;
  const dataRow = dataRows[0] as Record<string, unknown> | undefined;

  if (!dataRow) {
    throw new EncryptedAssetNotFoundError(assetType, assetId);
  }

  // Check key-protected access
  const accessResult = await checkKeyProtectedAccess(
    sql,
    userId,
    assetType,
    assetId,
    action,
  );

  if (!accessResult.allowed) {
    // Access denied — return the check result without data
    return { access: accessResult, data: null };
  }

  // Access granted — optionally consume assertions
  if (autoConsume && accessResult.requires_assertion) {
    await consumeMatchingAssertions(sql, userId, assetType, assetId);
  }

  const encryptedData = rowToEncryptedAssetResponse(dataRow);

  return { access: accessResult, data: encryptedData };
}

/**
 * List encrypted asset metadata for assets encrypted by a user.
 *
 * Returns lightweight metadata (no ciphertext) for listing and discovery.
 * Optionally filtered by asset type.
 *
 * @param sql - Bun.sql database instance.
 * @param userId - UUID of the user who encrypted the assets.
 * @param assetType - Optional asset type filter.
 * @returns List of encrypted asset metadata records (no ciphertext).
 */
export async function listEncryptedAssetsForUser(
  sql: InstanceType<typeof SQL>,
  userId: string,
  assetType?: string | null,
): Promise<EncryptedAssetMetadata[]> {
  let rows: Record<string, unknown>[];

  if (assetType) {
    validateAssetType(assetType);
    rows = await sql`
      SELECT id, asset_type, asset_id, encryption_algorithm,
             key_derivation_method, authorized_key_ids,
             encrypted_by_user_id, created_at
      FROM public.encrypted_asset_data
      WHERE encrypted_by_user_id = ${userId}
        AND asset_type = ${assetType}
      ORDER BY created_at DESC
    `;
  } else {
    rows = await sql`
      SELECT id, asset_type, asset_id, encryption_algorithm,
             key_derivation_method, authorized_key_ids,
             encrypted_by_user_id, created_at
      FROM public.encrypted_asset_data
      WHERE encrypted_by_user_id = ${userId}
      ORDER BY created_at DESC
    `;
  }

  return rows.map((row) => rowToEncryptedAssetMetadata(row));
}

/**
 * Delete encrypted asset data.
 *
 * @param sql - Bun.sql database instance.
 * @param assetType - Asset type of the data to delete.
 * @param assetId - Asset UUID of the data to delete.
 * @returns True if data was deleted, false if not found.
 */
export async function deleteEncryptedAsset(
  sql: InstanceType<typeof SQL>,
  assetType: string,
  assetId: string,
): Promise<boolean> {
  validateAssetType(assetType);

  const rows = await sql`
    DELETE FROM public.encrypted_asset_data
    WHERE asset_type = ${assetType} AND asset_id = ${assetId}
    RETURNING id
  `;

  return rows.length > 0;
}

/**
 * Update authorized keys and optionally the re-encrypted payload.
 *
 * Used during key rotation:
 * 1. Client re-wraps DEK with new KEK (from new hardware key PRF)
 * 2. Client optionally re-encrypts payload with new DEK
 * 3. Client sends updated authorized_key_ids + new ciphertext to server
 *
 * @param sql - Bun.sql database instance.
 * @param userId - UUID of the authenticated user.
 * @param assetType - Asset type to update.
 * @param assetId - Asset UUID to update.
 * @param update - New authorized key IDs and optional new ciphertext.
 * @returns Updated encrypted asset record.
 *
 * @throws EncryptedAssetNotFoundError if no encrypted data exists.
 * @throws InvalidAuthorizedKeys if any new key IDs don't exist.
 * @throws InvalidInputError if payload is provided without IV or vice versa.
 */
export async function updateAuthorizedKeys(
  sql: InstanceType<typeof SQL>,
  _userId: string,
  assetType: string,
  assetId: string,
  update: EncryptedAssetKeyUpdate,
): Promise<EncryptedAssetResponse> {
  validateAssetType(assetType);

  // Validate new authorized keys exist
  await validateAuthorizedKeyIds(sql, update.authorized_key_ids);

  // Validate payload/IV consistency
  const hasNewPayload = update.encrypted_payload != null;
  const hasNewIv = update.initialization_vector != null;
  if (hasNewPayload !== hasNewIv) {
    throw new InvalidInputError(
      "encrypted_payload and initialization_vector must both be provided " +
        "or both be omitted during key rotation",
    );
  }

  // Build dynamic SET clause using sql.unsafe() with positional params
  const setClauses: string[] = ["authorized_key_ids = $1"];
  const params: unknown[] = [update.authorized_key_ids];

  if (hasNewPayload) {
    const payloadBytes = decodeBase64Field(
      update.encrypted_payload!,
      "encrypted_payload",
    );
    const ivBytes = decodeBase64Field(
      update.initialization_vector!,
      "initialization_vector",
    );
    params.push(payloadBytes);
    setClauses.push(`encrypted_payload = $${params.length}`);
    params.push(ivBytes);
    setClauses.push(`initialization_vector = $${params.length}`);
  }

  // Add asset_type and asset_id to params
  params.push(assetType);
  const assetTypeParam = `$${params.length}`;
  params.push(assetId);
  const assetIdParam = `$${params.length}`;

  const query = `
    UPDATE public.encrypted_asset_data
    SET ${setClauses.join(", ")}
    WHERE asset_type = ${assetTypeParam} AND asset_id = ${assetIdParam}
    RETURNING *
  `;

  const rows = await sql.unsafe(query, params);
  const row = rows[0] as Record<string, unknown> | undefined;

  if (!row) {
    throw new EncryptedAssetNotFoundError(assetType, assetId);
  }

  return rowToEncryptedAssetResponse(row);
}
