/**
 * Hardware key models, interfaces, constants, and error hierarchy.
 *
 * TypeScript port of the Python hardware key service models and encryption
 * service models. All interfaces use snake_case field names for parity with
 * the Python API and database columns.
 *
 * Reference:
 *   - apps/python/src/server/hardware_key_service.py L90–272 (models)
 *   - apps/python/src/server/hardware_key_service.py L280–358 (errors)
 *   - apps/python/src/server/encryption_service.py L78–196 (models)
 *   - apps/python/src/server/encryption_service.py L204–288 (errors)
 */

// ============================================================================
// Constants — mirror Python exactly
// ============================================================================

export const VALID_DEVICE_TYPES = new Set([
  "solokey",
  "yubikey",
  "titan",
  "nitrokey",
  "onlykey",
  "trezor",
  "ledger",
  "platform",
  "other",
]);

export const VALID_ASSET_TYPES = new Set([
  "repository",
  "project",
  "document",
  "document_artifact",
  "chat_session",
  "agent",
  "ontology",
  "processing_profile",
  "ai_engine",
]);

export const VALID_PROTECTED_ACTIONS = new Set([
  "decrypt",
  "delete",
  "export",
  "share",
  "sign",
  "all_writes",
  "admin",
]);

export const VALID_ENCRYPTION_ALGORITHMS = new Set([
  "AES-GCM-256",
  "AES-CBC-256",
  "ChaCha20-Poly1305",
]);

export const VALID_KEY_DERIVATION_METHODS = new Set([
  "webauthn-prf-hkdf",
  "webauthn-hmac-secret-hkdf",
  "passphrase-pbkdf2",
  "shamir-recombine",
]);

// ============================================================================
// Error Class Hierarchy
// ============================================================================

/**
 * Base error for all hardware-key-related operations.
 *
 * Every subclass carries a `statusCode` so route handlers can return the
 * correct HTTP status without a long instanceof chain.
 */
export class HardwareKeyError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 500) {
    super(message);
    this.name = "HardwareKeyError";
    this.statusCode = statusCode;
  }
}

export class HardwareKeyNotFoundError extends HardwareKeyError {
  constructor(keyId: string) {
    super(`Hardware key ${keyId} not found`, 404);
    this.name = "HardwareKeyNotFoundError";
  }
}

export class HardwareKeyConflictError extends HardwareKeyError {
  constructor(credentialId: string) {
    super(
      `Hardware key with credential_id '${credentialId}' already exists`,
      409,
    );
    this.name = "HardwareKeyConflictError";
  }
}

export class HardwareKeyInactiveError extends HardwareKeyError {
  constructor(keyId: string) {
    super(`Hardware key ${keyId} is deactivated`, 400);
    this.name = "HardwareKeyInactiveError";
  }
}

export class AssertionNotFoundError extends HardwareKeyError {
  constructor(assertionId: string) {
    super(`Assertion ${assertionId} not found`, 404);
    this.name = "AssertionNotFoundError";
  }
}

export class AssertionConsumedError extends HardwareKeyError {
  constructor(assertionId: string) {
    super(`Assertion ${assertionId} has already been consumed`, 410);
    this.name = "AssertionConsumedError";
  }
}

export class AssertionExpiredError extends HardwareKeyError {
  constructor(assertionId: string) {
    super(`Assertion ${assertionId} has expired`, 410);
    this.name = "AssertionExpiredError";
  }
}

export class PolicyConflictError extends HardwareKeyError {
  constructor(assetType: string, assetId: string, action: string) {
    super(
      `Policy already exists for ${assetType}/${assetId} action '${action}'`,
      409,
    );
    this.name = "PolicyConflictError";
  }
}

export class InvalidInputError extends HardwareKeyError {
  constructor(message: string) {
    super(message, 400);
    this.name = "InvalidInputError";
  }
}

/**
 * Thrown when a key-gated operation requires hardware key assertion(s)
 * that the user has not yet provided.
 */
export class KeyAssertionRequired extends HardwareKeyError {
  constructor(
    public readonly assetType: string,
    public readonly assetId: string,
    public readonly action: string,
    public readonly requiredCount: number = 1,
    public readonly assertionsPresent: number = 0,
  ) {
    super(
      `Hardware key assertion required: ${requiredCount} key touch(es) needed`,
      428,
    );
    this.name = "KeyAssertionRequired";
  }
}

export class InvalidAuthorizedKeys extends HardwareKeyError {
  constructor(public readonly invalidKeyIds: string[]) {
    super(
      `Invalid authorized key IDs (not found): ${JSON.stringify(invalidKeyIds)}`,
      400,
    );
    this.name = "InvalidAuthorizedKeys";
  }
}

export class EncryptedAssetNotFoundError extends HardwareKeyError {
  constructor(assetType: string, assetId: string) {
    super(`No encrypted data found for ${assetType}/${assetId}`, 404);
    this.name = "EncryptedAssetNotFoundError";
  }
}

// ============================================================================
// Request Interfaces
// ============================================================================

/** Body for POST /keys/register */
export interface HardwareKeyRegistration {
  credential_id: string;
  public_key: string;
  counter?: number;
  transports?: string[];
  friendly_name?: string | null;
  device_type?: string | null;
  attestation_format?: string | null;
  aaguid?: string | null;
}

/** Body for PATCH /keys/:key_id */
export interface HardwareKeyUpdate {
  friendly_name?: string | null;
  device_type?: string | null;
}

/** Body for POST /keys/assertions */
export interface AssertionRecord {
  hardware_key_id: string;
  challenge: string;
  asset_type?: string | null;
  asset_id?: string | null;
}

/** Body for POST /keys/policies */
export interface AssetKeyPolicyCreate {
  asset_type: string;
  asset_id: string;
  protected_action: string;
  required_key_count?: number;
  required_key_ids?: string[] | null;
}

/** Body for POST /keys/encrypted-data */
export interface EncryptedAssetStore {
  asset_type: string;
  asset_id: string;
  encrypted_payload: string;
  encryption_algorithm?: string;
  key_derivation_method?: string;
  initialization_vector: string;
  authorized_key_ids: string[];
}

/** Body for PATCH /keys/encrypted-data/:asset_type/:asset_id/authorized-keys */
export interface EncryptedAssetKeyUpdate {
  authorized_key_ids: string[];
  encrypted_payload?: string | null;
  initialization_vector?: string | null;
}

// ============================================================================
// Response Interfaces
// ============================================================================

export interface HardwareKeyResponse {
  id: string;
  credential_id: string;
  friendly_name: string | null;
  device_type: string | null;
  transports: string[];
  attestation_format: string | null;
  aaguid: string | null;
  is_active: boolean;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AssertionResponse {
  assertion_id: string;
  hardware_key_id: string;
  expires_at: string;
  consumed: boolean;
  asset_type: string | null;
  asset_id: string | null;
}

export interface AssetKeyPolicyResponse {
  id: string;
  asset_type: string;
  asset_id: string;
  protected_action: string;
  required_key_count: number;
  required_key_ids: string[] | null;
  created_by_user_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface KeyProtectedAccessResult {
  allowed: boolean;
  reason: string;
  requires_assertion: boolean;
  required_key_count: number | null;
  assertions_present: number | null;
}

export interface EncryptedAssetResponse {
  id: string;
  asset_type: string;
  asset_id: string;
  encrypted_payload: string;
  encryption_algorithm: string;
  key_derivation_method: string;
  initialization_vector: string;
  authorized_key_ids: string[];
  encrypted_by_user_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface EncryptedAssetMetadata {
  id: string;
  asset_type: string;
  asset_id: string;
  encryption_algorithm: string;
  key_derivation_method: string;
  authorized_key_ids: string[];
  encrypted_by_user_id: string | null;
  created_at: string;
}

export interface KeyGatedRetrievalResult {
  access: KeyProtectedAccessResult;
  data: EncryptedAssetResponse | null;
}
