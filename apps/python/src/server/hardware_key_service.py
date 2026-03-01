"""Hardware key service for WebAuthn/FIDO2 key management and assertion verification.

This module provides the server-side service layer for hardware key operations:
- Hardware key registration, listing, and deactivation
- Key assertion recording and consumption
- Key-protected access checks against asset policies

The service operates on the following Supabase tables (created by migration
``20260625100000_add_hardware_key_encryption``):
- ``hardware_keys`` — WebAuthn credential registrations
- ``key_assertions`` — Ephemeral proof-of-presence records (5-min TTL)
- ``asset_key_policies`` — Per-asset key requirements

**Design decisions:**

- The service uses per-request database connections via ``get_connection()``
  following the established pattern in ``database.py`` (no shared pool).
- WebAuthn assertion *cryptographic verification* (signature check against
  stored public key) is expected to happen in the Supabase Edge Function.
  This service records verified assertions and manages their lifecycle.
- For development/testing, ``record_assertion()`` can be called directly
  to simulate Edge Function behavior.
- Raw ``public_key`` bytes are never exposed in API responses.

See also:
    - ``encryption_service.py`` — Encrypted asset data management
    - ``routes/hardware_keys.py`` — HTTP API endpoints
    - ``Task-04-Python-Key-Service/scratchpad.md`` — Design rationale
"""

from __future__ import annotations

import base64
import logging
from datetime import datetime
from typing import TYPE_CHECKING, Any

from pydantic import BaseModel, Field

if TYPE_CHECKING:
    from psycopg import AsyncConnection

logger = logging.getLogger(__name__)


# ============================================================================
# Constants
# ============================================================================

VALID_DEVICE_TYPES: set[str] = {
    "solokey",
    "yubikey",
    "titan",
    "nitrokey",
    "onlykey",
    "trezor",
    "ledger",
    "platform",
    "other",
}

VALID_ASSET_TYPES: set[str] = {
    "repository",
    "project",
    "document",
    "document_artifact",
    "chat_session",
    "agent",
    "ontology",
    "processing_profile",
    "ai_engine",
}

VALID_PROTECTED_ACTIONS: set[str] = {
    "decrypt",
    "delete",
    "export",
    "share",
    "sign",
    "all_writes",
    "admin",
}


# ============================================================================
# Pydantic Models — Request
# ============================================================================


class HardwareKeyRegistration(BaseModel):
    """Request payload for registering a new hardware key.

    Attributes:
        credential_id: WebAuthn credential ID (base64url-encoded).
            Globally unique per the WebAuthn specification.
        public_key: COSE-encoded public key (base64url-encoded).
            Used server-side for assertion signature verification.
        counter: Initial signature counter from the authenticator.
        transports: Supported transport hints (usb, ble, nfc, internal, hybrid).
        friendly_name: Optional user-defined name for the key.
        device_type: Optional hardware key brand/type.
        attestation_format: WebAuthn attestation statement format.
        aaguid: Authenticator Attestation GUID identifying the model.
    """

    credential_id: str
    public_key: str
    counter: int = 0
    transports: list[str] = Field(default_factory=list)
    friendly_name: str | None = None
    device_type: str | None = None
    attestation_format: str | None = None
    aaguid: str | None = None


class HardwareKeyUpdate(BaseModel):
    """Request payload for updating hardware key metadata.

    Only mutable display fields are updatable. Cryptographic fields
    (credential_id, public_key) are immutable after registration.

    Attributes:
        friendly_name: Updated user-defined name.
        device_type: Updated device type classification.
    """

    friendly_name: str | None = None
    device_type: str | None = None


class AssertionRecord(BaseModel):
    """Request payload for recording a verified key assertion.

    In production, the Edge Function verifies the WebAuthn assertion
    cryptographically and then calls this service to record it. For
    development/testing, assertions can be recorded directly.

    Attributes:
        hardware_key_id: UUID of the hardware key that was used.
        challenge: The WebAuthn challenge that was signed (for replay prevention).
        asset_type: Target asset type for scoped assertions. None for general auth.
        asset_id: Target asset UUID for scoped assertions. None for general auth.
    """

    hardware_key_id: str
    challenge: str
    asset_type: str | None = None
    asset_id: str | None = None


class AssetKeyPolicyCreate(BaseModel):
    """Request payload for creating an asset key policy.

    Attributes:
        asset_type: Type of protected asset (must match resource_permissions enum).
        asset_id: UUID of the protected asset.
        protected_action: Action requiring key touch (decrypt, delete, export, etc.).
        required_key_count: Number of distinct key touches required (default 1).
        required_key_ids: If set, only these specific hardware keys are accepted.
    """

    asset_type: str
    asset_id: str
    protected_action: str
    required_key_count: int = 1
    required_key_ids: list[str] | None = None


# ============================================================================
# Pydantic Models — Response
# ============================================================================


class HardwareKeyResponse(BaseModel):
    """Response model for a hardware key.

    Never includes raw ``public_key`` bytes — only metadata safe for
    API exposure.

    Attributes:
        id: Hardware key UUID.
        credential_id: WebAuthn credential ID (base64url).
        friendly_name: User-defined name.
        device_type: Hardware key brand/type.
        transports: Supported transport hints.
        attestation_format: WebAuthn attestation format.
        aaguid: Authenticator Attestation GUID.
        is_active: Whether the key is currently active.
        last_used_at: Timestamp of last successful assertion.
        created_at: Registration timestamp.
        updated_at: Last modification timestamp.
    """

    id: str
    credential_id: str
    friendly_name: str | None = None
    device_type: str | None = None
    transports: list[str] = Field(default_factory=list)
    attestation_format: str | None = None
    aaguid: str | None = None
    is_active: bool = True
    last_used_at: str | None = None
    created_at: str
    updated_at: str


class AssertionResponse(BaseModel):
    """Response model for a recorded key assertion.

    Attributes:
        assertion_id: UUID of the assertion record.
        hardware_key_id: UUID of the hardware key used.
        expires_at: Timestamp when the assertion becomes invalid.
        consumed: Whether the assertion has been used.
        asset_type: Target asset type (None for general assertions).
        asset_id: Target asset UUID (None for general assertions).
    """

    assertion_id: str
    hardware_key_id: str
    expires_at: str
    consumed: bool = False
    asset_type: str | None = None
    asset_id: str | None = None


class AssetKeyPolicyResponse(BaseModel):
    """Response model for an asset key policy.

    Attributes:
        id: Policy UUID.
        asset_type: Protected asset type.
        asset_id: Protected asset UUID.
        protected_action: Action requiring key touch.
        required_key_count: Number of distinct key touches required.
        required_key_ids: Specific accepted hardware key UUIDs, or None for any.
        created_by_user_id: User who created the policy.
        created_at: Creation timestamp.
        updated_at: Last modification timestamp.
    """

    id: str
    asset_type: str
    asset_id: str
    protected_action: str
    required_key_count: int
    required_key_ids: list[str] | None = None
    created_by_user_id: str | None = None
    created_at: str
    updated_at: str


class KeyProtectedAccessResult(BaseModel):
    """Result of a key-protected access check.

    Returned by ``check_key_protected_access()`` so the caller (and
    ultimately the frontend) knows whether a hardware key touch is
    required and how many assertions are still needed.

    Attributes:
        allowed: Whether access is currently granted.
        reason: Human-readable explanation of the result.
        requires_assertion: Whether a key policy exists for this asset+action.
        required_key_count: Number of distinct assertions required (None if no policy).
        assertions_present: Number of valid assertions currently available (None if no policy).
    """

    allowed: bool
    reason: str
    requires_assertion: bool = False
    required_key_count: int | None = None
    assertions_present: int | None = None


# ============================================================================
# Exceptions
# ============================================================================


class HardwareKeyError(Exception):
    """Base exception for hardware key operations."""

    def __init__(self, message: str, status_code: int = 400):
        self.message = message
        self.status_code = status_code
        super().__init__(message)


class HardwareKeyNotFoundError(HardwareKeyError):
    """Raised when a hardware key is not found or not owned by the user."""

    def __init__(self, key_id: str):
        super().__init__(f"Hardware key not found: {key_id}", status_code=404)
        self.key_id = key_id


class HardwareKeyConflictError(HardwareKeyError):
    """Raised when a credential_id is already registered."""

    def __init__(self, credential_id: str):
        super().__init__(
            f"Credential ID already registered: {credential_id}", status_code=409
        )
        self.credential_id = credential_id


class HardwareKeyInactiveError(HardwareKeyError):
    """Raised when an operation targets a deactivated key."""

    def __init__(self, key_id: str):
        super().__init__(f"Hardware key is deactivated: {key_id}", status_code=409)
        self.key_id = key_id


class AssertionNotFoundError(HardwareKeyError):
    """Raised when a key assertion is not found or not owned by the user."""

    def __init__(self, assertion_id: str):
        super().__init__(f"Key assertion not found: {assertion_id}", status_code=404)
        self.assertion_id = assertion_id


class AssertionExpiredError(HardwareKeyError):
    """Raised when a key assertion has expired."""

    def __init__(self, assertion_id: str):
        super().__init__(f"Key assertion has expired: {assertion_id}", status_code=410)
        self.assertion_id = assertion_id


class AssertionConsumedError(HardwareKeyError):
    """Raised when a key assertion has already been consumed."""

    def __init__(self, assertion_id: str):
        super().__init__(
            f"Key assertion already consumed: {assertion_id}", status_code=410
        )
        self.assertion_id = assertion_id


class PolicyConflictError(HardwareKeyError):
    """Raised when a duplicate policy already exists for an asset+action."""

    def __init__(self, asset_type: str, asset_id: str, protected_action: str):
        super().__init__(
            f"Policy already exists for {asset_type}/{asset_id} action={protected_action}",
            status_code=409,
        )
        self.asset_type = asset_type
        self.asset_id = asset_id
        self.protected_action = protected_action


class InvalidInputError(HardwareKeyError):
    """Raised for validation errors on input data."""

    def __init__(self, message: str):
        super().__init__(message, status_code=400)


# ============================================================================
# Helper — Row Conversion
# ============================================================================


def _format_timestamp(value: Any) -> str | None:
    """Convert a database timestamp value to ISO 8601 string.

    Args:
        value: A datetime object, string, or None from the database.

    Returns:
        ISO 8601 formatted string with Z suffix, or None.
    """
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.isoformat().replace("+00:00", "Z")
    return str(value)


def _row_to_hardware_key_response(row: dict[str, Any]) -> HardwareKeyResponse:
    """Convert a database row dict to a ``HardwareKeyResponse``.

    Args:
        row: Dict-like row from ``hardware_keys`` table.

    Returns:
        Populated ``HardwareKeyResponse`` model.
    """
    return HardwareKeyResponse(
        id=str(row["id"]),
        credential_id=row["credential_id"],
        friendly_name=row.get("friendly_name"),
        device_type=row.get("device_type"),
        transports=row.get("transports") or [],
        attestation_format=row.get("attestation_format"),
        aaguid=row.get("aaguid"),
        is_active=row.get("is_active", True),
        last_used_at=_format_timestamp(row.get("last_used_at")),
        created_at=_format_timestamp(row["created_at"]),
        updated_at=_format_timestamp(row["updated_at"]),
    )


def _row_to_assertion_response(row: dict[str, Any]) -> AssertionResponse:
    """Convert a database row dict to an ``AssertionResponse``.

    Args:
        row: Dict-like row from ``key_assertions`` table.

    Returns:
        Populated ``AssertionResponse`` model.
    """
    return AssertionResponse(
        assertion_id=str(row["id"]),
        hardware_key_id=str(row["hardware_key_id"]),
        expires_at=_format_timestamp(row["expires_at"]),
        consumed=row.get("consumed", False),
        asset_type=row.get("asset_type"),
        asset_id=str(row["asset_id"]) if row.get("asset_id") else None,
    )


def _row_to_policy_response(row: dict[str, Any]) -> AssetKeyPolicyResponse:
    """Convert a database row dict to an ``AssetKeyPolicyResponse``.

    Args:
        row: Dict-like row from ``asset_key_policies`` table.

    Returns:
        Populated ``AssetKeyPolicyResponse`` model.
    """
    raw_key_ids = row.get("required_key_ids")
    required_key_ids = [str(kid) for kid in raw_key_ids] if raw_key_ids else None
    return AssetKeyPolicyResponse(
        id=str(row["id"]),
        asset_type=row["asset_type"],
        asset_id=str(row["asset_id"]),
        protected_action=row["protected_action"],
        required_key_count=row["required_key_count"],
        required_key_ids=required_key_ids,
        created_by_user_id=(
            str(row["created_by_user_id"]) if row.get("created_by_user_id") else None
        ),
        created_at=_format_timestamp(row["created_at"]),
        updated_at=_format_timestamp(row["updated_at"]),
    )


# ============================================================================
# Validation Helpers
# ============================================================================


def _validate_device_type(device_type: str | None) -> None:
    """Validate device_type against allowed enum values.

    Args:
        device_type: Device type string to validate, or None.

    Raises:
        InvalidInputError: If device_type is not in the allowed set.
    """
    if device_type is not None and device_type not in VALID_DEVICE_TYPES:
        raise InvalidInputError(
            f"Invalid device_type '{device_type}'. "
            f"Allowed: {sorted(VALID_DEVICE_TYPES)}"
        )


def _validate_asset_type(asset_type: str) -> None:
    """Validate asset_type against allowed enum values.

    Args:
        asset_type: Asset type string to validate.

    Raises:
        InvalidInputError: If asset_type is not in the allowed set.
    """
    if asset_type not in VALID_ASSET_TYPES:
        raise InvalidInputError(
            f"Invalid asset_type '{asset_type}'. Allowed: {sorted(VALID_ASSET_TYPES)}"
        )


def _validate_protected_action(protected_action: str) -> None:
    """Validate protected_action against allowed enum values.

    Args:
        protected_action: Action string to validate.

    Raises:
        InvalidInputError: If protected_action is not in the allowed set.
    """
    if protected_action not in VALID_PROTECTED_ACTIONS:
        raise InvalidInputError(
            f"Invalid protected_action '{protected_action}'. "
            f"Allowed: {sorted(VALID_PROTECTED_ACTIONS)}"
        )


def _validate_asset_scope(asset_type: str | None, asset_id: str | None) -> None:
    """Validate that asset_type and asset_id are either both set or both None.

    This matches the CHECK constraint on ``key_assertions``:
    ``(asset_type IS NULL AND asset_id IS NULL) OR
     (asset_type IS NOT NULL AND asset_id IS NOT NULL)``

    Args:
        asset_type: Asset type, or None for general assertions.
        asset_id: Asset UUID, or None for general assertions.

    Raises:
        InvalidInputError: If only one of the pair is set.
    """
    if (asset_type is None) != (asset_id is None):
        raise InvalidInputError(
            "asset_type and asset_id must both be provided or both be null"
        )
    if asset_type is not None:
        _validate_asset_type(asset_type)


# ============================================================================
# Hardware Key CRUD
# ============================================================================


async def register_hardware_key(
    connection: "AsyncConnection",
    user_id: str,
    registration: HardwareKeyRegistration,
) -> HardwareKeyResponse:
    """Register a new hardware key for a user.

    Stores the WebAuthn credential in ``hardware_keys``. The credential_id
    must be globally unique (enforced by a UNIQUE constraint).

    Args:
        connection: Active async database connection.
        user_id: UUID of the authenticated user.
        registration: Registration payload with credential data.

    Returns:
        The newly created hardware key (without raw public_key).

    Raises:
        HardwareKeyConflictError: If the credential_id is already registered.
        InvalidInputError: If device_type is invalid.
    """
    _validate_device_type(registration.device_type)

    # Decode base64url public key to bytes for bytea storage
    try:
        public_key_bytes = base64.urlsafe_b64decode(
            registration.public_key + "=="  # pad for base64url
        )
    except Exception as decode_error:
        raise InvalidInputError(
            f"Invalid base64url-encoded public_key: {decode_error}"
        ) from decode_error

    try:
        result = await connection.execute(
            """
            INSERT INTO public.hardware_keys (
                user_id, credential_id, public_key, counter, transports,
                friendly_name, device_type, attestation_format, aaguid
            )
            VALUES (
                %(user_id)s, %(credential_id)s, %(public_key)s, %(counter)s,
                %(transports)s, %(friendly_name)s, %(device_type)s,
                %(attestation_format)s, %(aaguid)s
            )
            RETURNING *
            """,
            {
                "user_id": user_id,
                "credential_id": registration.credential_id,
                "public_key": public_key_bytes,
                "counter": registration.counter,
                "transports": registration.transports,
                "friendly_name": registration.friendly_name,
                "device_type": registration.device_type,
                "attestation_format": registration.attestation_format,
                "aaguid": registration.aaguid,
            },
        )
        row = await result.fetchone()
    except Exception as database_error:
        error_message = str(database_error)
        if "hardware_keys_credential_id_unique" in error_message:
            raise HardwareKeyConflictError(
                registration.credential_id
            ) from database_error
        raise

    logger.info(
        "Hardware key registered: user_id=%s credential_id=%s key_id=%s",
        user_id,
        registration.credential_id,
        row["id"],
    )
    return _row_to_hardware_key_response(row)


async def list_user_hardware_keys(
    connection: "AsyncConnection",
    user_id: str,
    include_inactive: bool = False,
) -> list[HardwareKeyResponse]:
    """List hardware keys registered by a user.

    Args:
        connection: Active async database connection.
        user_id: UUID of the authenticated user.
        include_inactive: If True, include deactivated keys. Default False.

    Returns:
        List of hardware key metadata (never includes raw public_key).
    """
    if include_inactive:
        result = await connection.execute(
            """
            SELECT * FROM public.hardware_keys
            WHERE user_id = %(user_id)s
            ORDER BY created_at DESC
            """,
            {"user_id": user_id},
        )
    else:
        result = await connection.execute(
            """
            SELECT * FROM public.hardware_keys
            WHERE user_id = %(user_id)s AND is_active = true
            ORDER BY created_at DESC
            """,
            {"user_id": user_id},
        )

    rows = await result.fetchall()
    return [_row_to_hardware_key_response(row) for row in rows]


async def get_hardware_key(
    connection: "AsyncConnection",
    user_id: str,
    key_id: str,
) -> HardwareKeyResponse:
    """Get a specific hardware key by ID.

    Args:
        connection: Active async database connection.
        user_id: UUID of the authenticated user (ownership check).
        key_id: UUID of the hardware key.

    Returns:
        Hardware key metadata.

    Raises:
        HardwareKeyNotFoundError: If the key doesn't exist or isn't owned by user.
    """
    result = await connection.execute(
        """
        SELECT * FROM public.hardware_keys
        WHERE id = %(key_id)s AND user_id = %(user_id)s
        """,
        {"key_id": key_id, "user_id": user_id},
    )
    row = await result.fetchone()

    if row is None:
        raise HardwareKeyNotFoundError(key_id)

    return _row_to_hardware_key_response(row)


async def update_hardware_key(
    connection: "AsyncConnection",
    user_id: str,
    key_id: str,
    updates: HardwareKeyUpdate,
) -> HardwareKeyResponse:
    """Update mutable metadata fields on a hardware key.

    Only ``friendly_name`` and ``device_type`` can be updated.
    Cryptographic fields are immutable.

    Args:
        connection: Active async database connection.
        user_id: UUID of the authenticated user (ownership check).
        key_id: UUID of the hardware key to update.
        updates: Fields to update (None values are skipped).

    Returns:
        Updated hardware key metadata.

    Raises:
        HardwareKeyNotFoundError: If the key doesn't exist or isn't owned by user.
        InvalidInputError: If device_type is invalid.
    """
    _validate_device_type(updates.device_type)

    # Build SET clause dynamically from provided fields
    set_clauses: list[str] = []
    params: dict[str, Any] = {"key_id": key_id, "user_id": user_id}

    if updates.friendly_name is not None:
        set_clauses.append("friendly_name = %(friendly_name)s")
        params["friendly_name"] = updates.friendly_name

    if updates.device_type is not None:
        set_clauses.append("device_type = %(device_type)s")
        params["device_type"] = updates.device_type

    if not set_clauses:
        # Nothing to update — just return current state
        return await get_hardware_key(connection, user_id, key_id)

    set_clause = ", ".join(set_clauses)
    result = await connection.execute(
        f"""
        UPDATE public.hardware_keys
        SET {set_clause}
        WHERE id = %(key_id)s AND user_id = %(user_id)s
        RETURNING *
        """,  # noqa: S608
        params,
    )
    row = await result.fetchone()

    if row is None:
        raise HardwareKeyNotFoundError(key_id)

    logger.info(
        "Hardware key updated: user_id=%s key_id=%s fields=%s",
        user_id,
        key_id,
        list(set_clauses),
    )
    return _row_to_hardware_key_response(row)


async def deactivate_hardware_key(
    connection: "AsyncConnection",
    user_id: str,
    key_id: str,
) -> HardwareKeyResponse:
    """Soft-deactivate a hardware key (set ``is_active = false``).

    Deactivated keys cannot be used for new assertions but remain in
    the database for audit purposes. Existing unconsumed assertions
    referencing this key are NOT invalidated — they will naturally expire.

    Args:
        connection: Active async database connection.
        user_id: UUID of the authenticated user (ownership check).
        key_id: UUID of the hardware key to deactivate.

    Returns:
        Updated hardware key metadata showing ``is_active = false``.

    Raises:
        HardwareKeyNotFoundError: If the key doesn't exist or isn't owned by user.
    """
    result = await connection.execute(
        """
        UPDATE public.hardware_keys
        SET is_active = false
        WHERE id = %(key_id)s AND user_id = %(user_id)s
        RETURNING *
        """,
        {"key_id": key_id, "user_id": user_id},
    )
    row = await result.fetchone()

    if row is None:
        raise HardwareKeyNotFoundError(key_id)

    logger.info("Hardware key deactivated: user_id=%s key_id=%s", user_id, key_id)
    return _row_to_hardware_key_response(row)


# ============================================================================
# Assertion Management
# ============================================================================


async def record_assertion(
    connection: "AsyncConnection",
    user_id: str,
    assertion: AssertionRecord,
) -> AssertionResponse:
    """Record a verified key assertion.

    In production, the Supabase Edge Function:
    1. Verifies the WebAuthn assertion signature against the stored public key
    2. Checks counter monotonicity
    3. Calls this function (or directly INSERTs via SECURITY DEFINER)

    For development/testing, this function can be called directly to simulate
    the Edge Function flow.

    The assertion record has a 5-minute TTL (``expires_at = now() + 5 min``)
    and is single-use (``consumed`` flag).

    Args:
        connection: Active async database connection.
        user_id: UUID of the authenticated user.
        assertion: Assertion details including hardware_key_id and challenge.

    Returns:
        The created assertion record with expiry timestamp.

    Raises:
        HardwareKeyNotFoundError: If the hardware key doesn't exist.
        HardwareKeyInactiveError: If the hardware key is deactivated.
        InvalidInputError: If asset_type/asset_id scope is inconsistent.
    """
    _validate_asset_scope(assertion.asset_type, assertion.asset_id)

    # Verify the hardware key exists, belongs to user, and is active
    key_result = await connection.execute(
        """
        SELECT id, is_active, counter FROM public.hardware_keys
        WHERE id = %(key_id)s AND user_id = %(user_id)s
        """,
        {"key_id": assertion.hardware_key_id, "user_id": user_id},
    )
    key_row = await key_result.fetchone()

    if key_row is None:
        raise HardwareKeyNotFoundError(assertion.hardware_key_id)

    if not key_row["is_active"]:
        raise HardwareKeyInactiveError(assertion.hardware_key_id)

    # Record the assertion
    result = await connection.execute(
        """
        INSERT INTO public.key_assertions (
            user_id, hardware_key_id, challenge,
            asset_type, asset_id
        )
        VALUES (
            %(user_id)s, %(hardware_key_id)s, %(challenge)s,
            %(asset_type)s, %(asset_id)s
        )
        RETURNING *
        """,
        {
            "user_id": user_id,
            "hardware_key_id": assertion.hardware_key_id,
            "challenge": assertion.challenge,
            "asset_type": assertion.asset_type,
            "asset_id": assertion.asset_id,
        },
    )
    row = await result.fetchone()

    # Update hardware key usage metadata
    await connection.execute(
        """
        UPDATE public.hardware_keys
        SET last_used_at = now(), counter = counter + 1
        WHERE id = %(key_id)s
        """,
        {"key_id": assertion.hardware_key_id},
    )

    logger.info(
        "Key assertion recorded: user_id=%s key_id=%s assertion_id=%s scope=%s/%s",
        user_id,
        assertion.hardware_key_id,
        row["id"],
        assertion.asset_type or "general",
        assertion.asset_id or "—",
    )
    return _row_to_assertion_response(row)


async def get_assertion(
    connection: "AsyncConnection",
    user_id: str,
    assertion_id: str,
) -> AssertionResponse:
    """Get a specific key assertion by ID.

    Args:
        connection: Active async database connection.
        user_id: UUID of the authenticated user (ownership check).
        assertion_id: UUID of the assertion.

    Returns:
        Assertion details.

    Raises:
        AssertionNotFoundError: If the assertion doesn't exist or isn't owned by user.
    """
    result = await connection.execute(
        """
        SELECT * FROM public.key_assertions
        WHERE id = %(assertion_id)s AND user_id = %(user_id)s
        """,
        {"assertion_id": assertion_id, "user_id": user_id},
    )
    row = await result.fetchone()

    if row is None:
        raise AssertionNotFoundError(assertion_id)

    return _row_to_assertion_response(row)


async def consume_assertion(
    connection: "AsyncConnection",
    user_id: str,
    assertion_id: str,
) -> AssertionResponse:
    """Mark a key assertion as consumed (single-use).

    A consumed assertion cannot be reused for subsequent protected operations.
    This function validates that the assertion:
    - Exists and belongs to the user
    - Has not already been consumed
    - Has not expired

    Args:
        connection: Active async database connection.
        user_id: UUID of the authenticated user (ownership check).
        assertion_id: UUID of the assertion to consume.

    Returns:
        Updated assertion with ``consumed = true`` and ``consumed_at`` set.

    Raises:
        AssertionNotFoundError: If not found or not owned by user.
        AssertionConsumedError: If already consumed.
        AssertionExpiredError: If past expiry time.
    """
    # Fetch current state
    result = await connection.execute(
        """
        SELECT * FROM public.key_assertions
        WHERE id = %(assertion_id)s AND user_id = %(user_id)s
        """,
        {"assertion_id": assertion_id, "user_id": user_id},
    )
    row = await result.fetchone()

    if row is None:
        raise AssertionNotFoundError(assertion_id)

    if row["consumed"]:
        raise AssertionConsumedError(assertion_id)

    # Check expiry — compare with database time to avoid clock skew
    expiry_result = await connection.execute(
        """
        SELECT (expires_at < now()) AS is_expired
        FROM public.key_assertions
        WHERE id = %(assertion_id)s
        """,
        {"assertion_id": assertion_id},
    )
    expiry_row = await expiry_result.fetchone()
    if expiry_row and expiry_row["is_expired"]:
        raise AssertionExpiredError(assertion_id)

    # Mark as consumed
    update_result = await connection.execute(
        """
        UPDATE public.key_assertions
        SET consumed = true, consumed_at = now()
        WHERE id = %(assertion_id)s AND user_id = %(user_id)s
        RETURNING *
        """,
        {"assertion_id": assertion_id, "user_id": user_id},
    )
    updated_row = await update_result.fetchone()

    logger.info(
        "Key assertion consumed: user_id=%s assertion_id=%s",
        user_id,
        assertion_id,
    )
    return _row_to_assertion_response(updated_row)


async def list_valid_assertions(
    connection: "AsyncConnection",
    user_id: str,
    asset_type: str | None = None,
    asset_id: str | None = None,
) -> list[AssertionResponse]:
    """List valid (unexpired, unconsumed) assertions for a user.

    Optionally filtered by asset scope. Returns both scoped and general
    (unscoped) assertions when a specific asset is queried — matching
    the same logic used by ``has_key_protected_access()``.

    Args:
        connection: Active async database connection.
        user_id: UUID of the authenticated user.
        asset_type: Optional asset type filter.
        asset_id: Optional asset UUID filter.

    Returns:
        List of valid assertion records.
    """
    if asset_type and asset_id:
        result = await connection.execute(
            """
            SELECT * FROM public.key_assertions
            WHERE user_id = %(user_id)s
              AND consumed = false
              AND expires_at > now()
              AND (
                (asset_type = %(asset_type)s AND asset_id = %(asset_id)s)
                OR asset_type IS NULL
              )
            ORDER BY verified_at DESC
            """,
            {
                "user_id": user_id,
                "asset_type": asset_type,
                "asset_id": asset_id,
            },
        )
    else:
        result = await connection.execute(
            """
            SELECT * FROM public.key_assertions
            WHERE user_id = %(user_id)s
              AND consumed = false
              AND expires_at > now()
            ORDER BY verified_at DESC
            """,
            {"user_id": user_id},
        )

    rows = await result.fetchall()
    return [_row_to_assertion_response(row) for row in rows]


# ============================================================================
# Asset Key Policies
# ============================================================================


async def create_asset_key_policy(
    connection: "AsyncConnection",
    user_id: str,
    policy: AssetKeyPolicyCreate,
) -> AssetKeyPolicyResponse:
    """Create a key policy requiring hardware key touch for an asset operation.

    The caller must have ``admin`` permission on the asset (enforced by RLS
    in production; validated by the route layer in the runtime).

    Args:
        connection: Active async database connection.
        user_id: UUID of the authenticated user (recorded as creator).
        policy: Policy definition.

    Returns:
        The created policy record.

    Raises:
        PolicyConflictError: If a policy already exists for this asset+action.
        InvalidInputError: If asset_type or protected_action is invalid.
    """
    _validate_asset_type(policy.asset_type)
    _validate_protected_action(policy.protected_action)

    if policy.required_key_count < 1:
        raise InvalidInputError("required_key_count must be >= 1")

    try:
        result = await connection.execute(
            """
            INSERT INTO public.asset_key_policies (
                asset_type, asset_id, protected_action,
                required_key_count, required_key_ids, created_by_user_id
            )
            VALUES (
                %(asset_type)s, %(asset_id)s, %(protected_action)s,
                %(required_key_count)s, %(required_key_ids)s, %(created_by_user_id)s
            )
            RETURNING *
            """,
            {
                "asset_type": policy.asset_type,
                "asset_id": policy.asset_id,
                "protected_action": policy.protected_action,
                "required_key_count": policy.required_key_count,
                "required_key_ids": policy.required_key_ids,
                "created_by_user_id": user_id,
            },
        )
        row = await result.fetchone()
    except Exception as database_error:
        error_message = str(database_error)
        if "asset_key_policies_asset_action_unique" in error_message:
            raise PolicyConflictError(
                policy.asset_type, policy.asset_id, policy.protected_action
            ) from database_error
        raise

    logger.info(
        "Asset key policy created: asset=%s/%s action=%s required_keys=%d policy_id=%s",
        policy.asset_type,
        policy.asset_id,
        policy.protected_action,
        policy.required_key_count,
        row["id"],
    )
    return _row_to_policy_response(row)


async def list_asset_key_policies(
    connection: "AsyncConnection",
    asset_type: str,
    asset_id: str,
) -> list[AssetKeyPolicyResponse]:
    """List all key policies for a specific asset.

    Args:
        connection: Active async database connection.
        asset_type: Asset type to query.
        asset_id: Asset UUID to query.

    Returns:
        List of policy records for the asset.
    """
    _validate_asset_type(asset_type)

    result = await connection.execute(
        """
        SELECT * FROM public.asset_key_policies
        WHERE asset_type = %(asset_type)s AND asset_id = %(asset_id)s
        ORDER BY protected_action
        """,
        {"asset_type": asset_type, "asset_id": asset_id},
    )
    rows = await result.fetchall()
    return [_row_to_policy_response(row) for row in rows]


async def get_asset_key_policy(
    connection: "AsyncConnection",
    policy_id: str,
) -> AssetKeyPolicyResponse | None:
    """Get a specific asset key policy by ID.

    Args:
        connection: Active async database connection.
        policy_id: UUID of the policy.

    Returns:
        Policy record, or None if not found.
    """
    result = await connection.execute(
        """
        SELECT * FROM public.asset_key_policies
        WHERE id = %(policy_id)s
        """,
        {"policy_id": policy_id},
    )
    row = await result.fetchone()
    return _row_to_policy_response(row) if row else None


async def delete_asset_key_policy(
    connection: "AsyncConnection",
    policy_id: str,
) -> bool:
    """Delete an asset key policy.

    Args:
        connection: Active async database connection.
        policy_id: UUID of the policy to delete.

    Returns:
        True if a policy was deleted, False if not found.
    """
    result = await connection.execute(
        """
        DELETE FROM public.asset_key_policies
        WHERE id = %(policy_id)s
        RETURNING id
        """,
        {"policy_id": policy_id},
    )
    row = await result.fetchone()
    if row:
        logger.info("Asset key policy deleted: policy_id=%s", policy_id)
    return row is not None


# ============================================================================
# Access Checks
# ============================================================================


async def check_key_protected_access(
    connection: "AsyncConnection",
    user_id: str,
    asset_type: str,
    asset_id: str,
    action: str = "decrypt",
) -> KeyProtectedAccessResult:
    """Check whether the user has key-protected access to an asset for an action.

    This mirrors the logic in the SQL function ``has_key_protected_access()``
    but returns a rich result with actionable details instead of a boolean.

    Steps:
    1. Look up key policy for ``(asset_type, asset_id, action)``
    2. If no policy → access allowed (no key required)
    3. If policy exists → count valid assertions from this user
    4. Compare against ``required_key_count``

    Args:
        connection: Active async database connection.
        user_id: UUID of the user to check.
        asset_type: Asset type to check.
        asset_id: Asset UUID to check.
        action: Protected action to check (default "decrypt").

    Returns:
        Rich result including whether access is allowed, whether a key
        assertion is required, and how many assertions are present vs required.
    """
    _validate_asset_type(asset_type)
    _validate_protected_action(action)

    # Step 1: Look up key policy
    policy_result = await connection.execute(
        """
        SELECT required_key_count, required_key_ids
        FROM public.asset_key_policies
        WHERE asset_type = %(asset_type)s
          AND asset_id = %(asset_id)s
          AND protected_action = %(action)s
        """,
        {"asset_type": asset_type, "asset_id": asset_id, "action": action},
    )
    policy_row = await policy_result.fetchone()

    # Step 2: No policy → no key required
    if policy_row is None:
        return KeyProtectedAccessResult(
            allowed=True,
            reason="No key policy exists for this asset and action",
            requires_assertion=False,
        )

    required_count = policy_row["required_key_count"]
    required_key_ids = policy_row["required_key_ids"]

    # Step 3: Count valid assertions
    if required_count > 1:
        # Multi-key: count distinct users with valid assertions
        assertion_query = """
            SELECT COUNT(DISTINCT ka.user_id) AS assertion_count
            FROM public.key_assertions ka
            WHERE ka.consumed = false
              AND ka.expires_at > now()
              AND (
                (ka.asset_type = %(asset_type)s AND ka.asset_id = %(asset_id)s)
                OR ka.asset_type IS NULL
              )
        """
    else:
        # Single-key: count assertions from this specific user
        assertion_query = """
            SELECT COUNT(*) AS assertion_count
            FROM public.key_assertions ka
            WHERE ka.user_id = %(user_id)s
              AND ka.consumed = false
              AND ka.expires_at > now()
              AND (
                (ka.asset_type = %(asset_type)s AND ka.asset_id = %(asset_id)s)
                OR ka.asset_type IS NULL
              )
        """

    # Add required_key_ids filter if policy specifies specific keys
    if required_key_ids:
        assertion_query += " AND ka.hardware_key_id = ANY(%(required_key_ids)s)"

    assertion_result = await connection.execute(
        assertion_query,
        {
            "user_id": user_id,
            "asset_type": asset_type,
            "asset_id": asset_id,
            "required_key_ids": required_key_ids,
        },
    )
    assertion_row = await assertion_result.fetchone()
    assertion_count = assertion_row["assertion_count"] if assertion_row else 0

    # Step 4: Compare
    allowed = assertion_count >= required_count

    if allowed:
        reason = (
            f"Access granted: {assertion_count} assertion(s) present, "
            f"{required_count} required"
        )
    elif assertion_count == 0:
        reason = (
            f"Hardware key assertion required: {required_count} key touch(es) "
            f"needed for '{action}' on this {asset_type}"
        )
    else:
        reason = (
            f"Insufficient assertions: {assertion_count} of {required_count} "
            f"required key touches present"
        )

    return KeyProtectedAccessResult(
        allowed=allowed,
        reason=reason,
        requires_assertion=True,
        required_key_count=required_count,
        assertions_present=assertion_count,
    )
