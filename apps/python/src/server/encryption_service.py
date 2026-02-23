"""Encryption service for managing client-side encrypted asset data.

This module provides the server-side service layer for encrypted asset operations:
- Storing client-encrypted payloads with key metadata
- Retrieving encrypted data with base permission checks
- Key-assertion-gated retrieval (requires valid hardware key assertion)
- Encrypted data lifecycle management (list, delete, key rotation)

**Critical design principle: The server never decrypts.**

The ``encrypted_asset_data`` table stores ciphertext that was encrypted
client-side using keys derived from hardware authenticator PRF output.
This service is a *gatekeeper* — it validates permissions and assertions
before releasing ciphertext to authorized clients.

Exception: Server-side decryption for the vLLM inference pipeline is
handled separately (Task-11) and is NOT part of this module.

**Binary data encoding:**

- ``encrypted_payload`` and ``initialization_vector`` are stored as
  ``bytea`` in Postgres but transmitted as base64 strings in the API.
- This service handles the encoding/decoding at the boundary.

See also:
    - ``hardware_key_service.py`` — Hardware key CRUD and assertion management
    - ``routes/hardware_keys.py`` — HTTP API endpoints
    - ``Task-05-Python-Encryption-Service/scratchpad.md`` — Design rationale
"""

from __future__ import annotations

import base64
import logging
from typing import TYPE_CHECKING, Any

from pydantic import BaseModel

from server.hardware_key_service import (
    HardwareKeyError,
    InvalidInputError,
    KeyProtectedAccessResult,
    _format_timestamp,
    _validate_asset_type,
    _validate_protected_action,
    check_key_protected_access,
)

if TYPE_CHECKING:
    from psycopg import AsyncConnection

logger = logging.getLogger(__name__)


# ============================================================================
# Constants
# ============================================================================

VALID_ENCRYPTION_ALGORITHMS: set[str] = {
    "AES-GCM-256",
    "AES-CBC-256",
    "ChaCha20-Poly1305",
}

VALID_KEY_DERIVATION_METHODS: set[str] = {
    "webauthn-prf-hkdf",
    "webauthn-hmac-secret-hkdf",
    "passphrase-pbkdf2",
    "shamir-recombine",
}


# ============================================================================
# Pydantic Models — Request
# ============================================================================


class EncryptedAssetStore(BaseModel):
    """Request payload for storing a client-encrypted asset.

    All binary fields (``encrypted_payload``, ``initialization_vector``)
    are base64-encoded strings. The service decodes them to ``bytea``
    for storage and re-encodes on retrieval.

    Attributes:
        asset_type: Type of the encrypted asset (matches resource_permissions enum).
        asset_id: UUID of the encrypted asset.
        encrypted_payload: Base64-encoded ciphertext.
        encryption_algorithm: Symmetric cipher used (default AES-GCM-256).
        key_derivation_method: How the encryption key was derived (default webauthn-prf-hkdf).
        initialization_vector: Base64-encoded IV/nonce.
        authorized_key_ids: UUIDs of hardware keys whose PRF can derive the decryption key.
    """

    asset_type: str
    asset_id: str
    encrypted_payload: str
    encryption_algorithm: str = "AES-GCM-256"
    key_derivation_method: str = "webauthn-prf-hkdf"
    initialization_vector: str
    authorized_key_ids: list[str]


class EncryptedAssetKeyUpdate(BaseModel):
    """Request payload for updating authorized keys (key rotation).

    During key rotation, the client re-wraps the DEK with a new KEK
    and may re-encrypt the payload. The server stores the new ciphertext
    and updated authorized key list.

    Attributes:
        authorized_key_ids: New list of authorized hardware key UUIDs.
        encrypted_payload: New base64-encoded ciphertext (optional, if re-encrypted).
        initialization_vector: New base64-encoded IV (required if payload changed).
    """

    authorized_key_ids: list[str]
    encrypted_payload: str | None = None
    initialization_vector: str | None = None


# ============================================================================
# Pydantic Models — Response
# ============================================================================


class EncryptedAssetResponse(BaseModel):
    """Full response model for an encrypted asset including ciphertext.

    Attributes:
        id: Encrypted asset data UUID.
        asset_type: Type of the encrypted asset.
        asset_id: UUID of the encrypted asset.
        encrypted_payload: Base64-encoded ciphertext.
        encryption_algorithm: Symmetric cipher used.
        key_derivation_method: How the encryption key was derived.
        initialization_vector: Base64-encoded IV/nonce.
        authorized_key_ids: Hardware key UUIDs authorized to derive the decryption key.
        encrypted_by_user_id: User who encrypted the data.
        created_at: Creation timestamp (ISO 8601).
        updated_at: Last modification timestamp (ISO 8601).
    """

    id: str
    asset_type: str
    asset_id: str
    encrypted_payload: str
    encryption_algorithm: str
    key_derivation_method: str
    initialization_vector: str
    authorized_key_ids: list[str]
    encrypted_by_user_id: str | None = None
    created_at: str
    updated_at: str


class EncryptedAssetMetadata(BaseModel):
    """Lightweight metadata response without ciphertext.

    Used for listing encrypted assets without transferring the (potentially
    large) encrypted payloads.

    Attributes:
        id: Encrypted asset data UUID.
        asset_type: Type of the encrypted asset.
        asset_id: UUID of the encrypted asset.
        encryption_algorithm: Symmetric cipher used.
        key_derivation_method: How the encryption key was derived.
        authorized_key_ids: Hardware key UUIDs authorized to derive the decryption key.
        encrypted_by_user_id: User who encrypted the data.
        created_at: Creation timestamp (ISO 8601).
    """

    id: str
    asset_type: str
    asset_id: str
    encryption_algorithm: str
    key_derivation_method: str
    authorized_key_ids: list[str]
    encrypted_by_user_id: str | None = None
    created_at: str


class KeyGatedRetrievalResult(BaseModel):
    """Result of a key-assertion-gated encrypted data retrieval.

    Wraps either the encrypted data (if access was granted) or the
    access check result (if a key assertion is still needed).

    Attributes:
        access: The key-protected access check result.
        data: The encrypted asset data, or None if access was denied.
    """

    access: KeyProtectedAccessResult
    data: EncryptedAssetResponse | None = None


# ============================================================================
# Exceptions
# ============================================================================


class KeyAssertionRequired(HardwareKeyError):
    """Raised when an operation requires a hardware key assertion that hasn't been provided.

    Attributes:
        asset_type: Type of the protected asset.
        asset_id: UUID of the protected asset.
        action: The protected action that was attempted.
        required_count: Number of key touches needed.
        assertions_present: Number of valid assertions currently available.
    """

    def __init__(
        self,
        asset_type: str,
        asset_id: str,
        action: str,
        required_count: int = 1,
        assertions_present: int = 0,
    ):
        self.asset_type = asset_type
        self.asset_id = asset_id
        self.action = action
        self.required_count = required_count
        self.assertions_present = assertions_present
        super().__init__(
            f"Hardware key assertion required: {required_count} key touch(es) "
            f"needed for '{action}' on {asset_type}/{asset_id} "
            f"({assertions_present} present)",
            status_code=428,
        )


class InsufficientKeyAssertions(HardwareKeyError):
    """Raised when multi-key policy requires more assertions than currently available.

    Attributes:
        required: Number of distinct assertions required.
        present: Number of valid assertions currently available.
        asset_type: Type of the protected asset.
        asset_id: UUID of the protected asset.
    """

    def __init__(
        self,
        required: int,
        present: int,
        asset_type: str,
        asset_id: str,
    ):
        self.required = required
        self.present = present
        self.asset_type = asset_type
        self.asset_id = asset_id
        super().__init__(
            f"Insufficient key assertions: {present} of {required} required "
            f"for {asset_type}/{asset_id}",
            status_code=428,
        )


class InvalidAuthorizedKeys(HardwareKeyError):
    """Raised when authorized_key_ids reference non-existent hardware keys.

    Attributes:
        invalid_key_ids: List of key UUIDs that were not found.
    """

    def __init__(self, invalid_key_ids: list[str]):
        self.invalid_key_ids = invalid_key_ids
        super().__init__(
            f"Invalid authorized key IDs (not found): {invalid_key_ids}",
            status_code=400,
        )


class EncryptedAssetNotFoundError(HardwareKeyError):
    """Raised when no encrypted data exists for an asset."""

    def __init__(self, asset_type: str, asset_id: str):
        self.asset_type = asset_type
        self.asset_id = asset_id
        super().__init__(
            f"No encrypted data found for {asset_type}/{asset_id}",
            status_code=404,
        )


# ============================================================================
# Validation Helpers
# ============================================================================


def _validate_encryption_algorithm(algorithm: str) -> None:
    """Validate encryption algorithm against allowed enum values.

    Args:
        algorithm: Algorithm string to validate.

    Raises:
        InvalidInputError: If algorithm is not in the allowed set.
    """
    if algorithm not in VALID_ENCRYPTION_ALGORITHMS:
        raise InvalidInputError(
            f"Invalid encryption_algorithm '{algorithm}'. "
            f"Allowed: {sorted(VALID_ENCRYPTION_ALGORITHMS)}"
        )


def _validate_key_derivation_method(method: str) -> None:
    """Validate key derivation method against allowed enum values.

    Args:
        method: Key derivation method string to validate.

    Raises:
        InvalidInputError: If method is not in the allowed set.
    """
    if method not in VALID_KEY_DERIVATION_METHODS:
        raise InvalidInputError(
            f"Invalid key_derivation_method '{method}'. "
            f"Allowed: {sorted(VALID_KEY_DERIVATION_METHODS)}"
        )


def _decode_base64_field(value: str, field_name: str) -> bytes:
    """Decode a base64-encoded string to bytes.

    Accepts both standard base64 and base64url encoding (with or without
    padding). This flexibility accommodates clients that may use either
    encoding variant.

    Args:
        value: Base64-encoded string.
        field_name: Name of the field (for error messages).

    Returns:
        Decoded bytes.

    Raises:
        InvalidInputError: If the value is not valid base64.
    """
    try:
        # Try standard base64 first, then base64url
        # Add padding if missing (common with base64url)
        padded = value + "=" * (4 - len(value) % 4) if len(value) % 4 else value
        try:
            return base64.b64decode(padded)
        except Exception:
            return base64.urlsafe_b64decode(padded)
    except Exception as decode_error:
        raise InvalidInputError(
            f"Invalid base64 encoding for {field_name}: {decode_error}"
        ) from decode_error


def _encode_bytes_to_base64(value: bytes) -> str:
    """Encode bytes to standard base64 string.

    Args:
        value: Raw bytes.

    Returns:
        Base64-encoded string (standard encoding, no padding stripped).
    """
    return base64.b64encode(value).decode("ascii")


async def _validate_authorized_key_ids(
    connection: "AsyncConnection",
    authorized_key_ids: list[str],
) -> None:
    """Validate that all authorized_key_ids reference existing hardware keys.

    Args:
        connection: Active async database connection.
        authorized_key_ids: List of hardware key UUIDs to validate.

    Raises:
        InvalidInputError: If the list is empty.
        InvalidAuthorizedKeys: If any key IDs don't exist in hardware_keys.
    """
    if not authorized_key_ids:
        raise InvalidInputError("authorized_key_ids must contain at least one key ID")

    result = await connection.execute(
        """
        SELECT id FROM public.hardware_keys
        WHERE id = ANY(%(key_ids)s)
        """,
        {"key_ids": authorized_key_ids},
    )
    found_rows = await result.fetchall()
    found_ids = {str(row["id"]) for row in found_rows}
    requested_ids = set(authorized_key_ids)

    missing_ids = requested_ids - found_ids
    if missing_ids:
        raise InvalidAuthorizedKeys(sorted(missing_ids))


# ============================================================================
# Row Conversion
# ============================================================================


def _row_to_encrypted_asset_response(row: dict[str, Any]) -> EncryptedAssetResponse:
    """Convert a database row to an ``EncryptedAssetResponse``.

    Encodes ``bytea`` columns (encrypted_payload, initialization_vector)
    to base64 strings for API transport.

    Args:
        row: Dict-like row from ``encrypted_asset_data`` table.

    Returns:
        Populated ``EncryptedAssetResponse`` model.
    """
    # Encode bytea fields to base64
    encrypted_payload = row["encrypted_payload"]
    if isinstance(encrypted_payload, (bytes, bytearray, memoryview)):
        encrypted_payload = _encode_bytes_to_base64(bytes(encrypted_payload))
    else:
        encrypted_payload = str(encrypted_payload)

    initialization_vector = row["initialization_vector"]
    if isinstance(initialization_vector, (bytes, bytearray, memoryview)):
        initialization_vector = _encode_bytes_to_base64(bytes(initialization_vector))
    else:
        initialization_vector = str(initialization_vector)

    raw_key_ids = row.get("authorized_key_ids") or []
    authorized_key_ids = [str(kid) for kid in raw_key_ids]

    return EncryptedAssetResponse(
        id=str(row["id"]),
        asset_type=row["asset_type"],
        asset_id=str(row["asset_id"]),
        encrypted_payload=encrypted_payload,
        encryption_algorithm=row["encryption_algorithm"],
        key_derivation_method=row["key_derivation_method"],
        initialization_vector=initialization_vector,
        authorized_key_ids=authorized_key_ids,
        encrypted_by_user_id=(
            str(row["encrypted_by_user_id"])
            if row.get("encrypted_by_user_id")
            else None
        ),
        created_at=_format_timestamp(row["created_at"]),
        updated_at=_format_timestamp(row["updated_at"]),
    )


def _row_to_encrypted_asset_metadata(row: dict[str, Any]) -> EncryptedAssetMetadata:
    """Convert a database row to an ``EncryptedAssetMetadata`` (no ciphertext).

    Args:
        row: Dict-like row from ``encrypted_asset_data`` table.

    Returns:
        Populated ``EncryptedAssetMetadata`` model (lightweight, no payload).
    """
    raw_key_ids = row.get("authorized_key_ids") or []
    authorized_key_ids = [str(kid) for kid in raw_key_ids]

    return EncryptedAssetMetadata(
        id=str(row["id"]),
        asset_type=row["asset_type"],
        asset_id=str(row["asset_id"]),
        encryption_algorithm=row["encryption_algorithm"],
        key_derivation_method=row["key_derivation_method"],
        authorized_key_ids=authorized_key_ids,
        encrypted_by_user_id=(
            str(row["encrypted_by_user_id"])
            if row.get("encrypted_by_user_id")
            else None
        ),
        created_at=_format_timestamp(row["created_at"]),
    )


# ============================================================================
# Encrypted Asset CRUD
# ============================================================================


async def store_encrypted_asset(
    connection: "AsyncConnection",
    user_id: str,
    data: EncryptedAssetStore,
) -> EncryptedAssetResponse:
    """Store a client-encrypted asset payload.

    The server stores the ciphertext, IV, algorithm metadata, and
    authorized key list. The server never sees plaintext.

    Args:
        connection: Active async database connection.
        user_id: UUID of the authenticated user (recorded as encryptor).
        data: Encrypted asset payload and metadata.

    Returns:
        The stored encrypted asset record.

    Raises:
        InvalidInputError: If asset_type, algorithm, or KDF method is invalid.
        InvalidAuthorizedKeys: If any authorized_key_ids don't exist.
    """
    _validate_asset_type(data.asset_type)
    _validate_encryption_algorithm(data.encryption_algorithm)
    _validate_key_derivation_method(data.key_derivation_method)

    # Validate authorized keys exist
    await _validate_authorized_key_ids(connection, data.authorized_key_ids)

    # Decode base64 fields to bytes for bytea storage
    encrypted_payload_bytes = _decode_base64_field(
        data.encrypted_payload, "encrypted_payload"
    )
    initialization_vector_bytes = _decode_base64_field(
        data.initialization_vector, "initialization_vector"
    )

    result = await connection.execute(
        """
        INSERT INTO public.encrypted_asset_data (
            asset_type, asset_id, encrypted_payload,
            encryption_algorithm, key_derivation_method,
            initialization_vector, authorized_key_ids,
            encrypted_by_user_id
        )
        VALUES (
            %(asset_type)s, %(asset_id)s, %(encrypted_payload)s,
            %(encryption_algorithm)s, %(key_derivation_method)s,
            %(initialization_vector)s, %(authorized_key_ids)s,
            %(encrypted_by_user_id)s
        )
        RETURNING *
        """,
        {
            "asset_type": data.asset_type,
            "asset_id": data.asset_id,
            "encrypted_payload": encrypted_payload_bytes,
            "encryption_algorithm": data.encryption_algorithm,
            "key_derivation_method": data.key_derivation_method,
            "initialization_vector": initialization_vector_bytes,
            "authorized_key_ids": data.authorized_key_ids,
            "encrypted_by_user_id": user_id,
        },
    )
    row = await result.fetchone()

    logger.info(
        "Encrypted asset stored: user_id=%s asset=%s/%s algorithm=%s record_id=%s",
        user_id,
        data.asset_type,
        data.asset_id,
        data.encryption_algorithm,
        row["id"],
    )
    return _row_to_encrypted_asset_response(row)


async def get_encrypted_asset(
    connection: "AsyncConnection",
    asset_type: str,
    asset_id: str,
) -> EncryptedAssetResponse | None:
    """Retrieve encrypted asset data with base permission check only.

    This does NOT check key assertions — it returns ciphertext to anyone
    with base read permission. Use ``get_encrypted_asset_with_key_check()``
    for key-assertion-gated retrieval.

    Args:
        connection: Active async database connection.
        asset_type: Asset type to query.
        asset_id: Asset UUID to query.

    Returns:
        Encrypted asset data, or None if not found.
    """
    _validate_asset_type(asset_type)

    result = await connection.execute(
        """
        SELECT * FROM public.encrypted_asset_data
        WHERE asset_type = %(asset_type)s AND asset_id = %(asset_id)s
        ORDER BY created_at DESC
        LIMIT 1
        """,
        {"asset_type": asset_type, "asset_id": asset_id},
    )
    row = await result.fetchone()

    if row is None:
        return None

    return _row_to_encrypted_asset_response(row)


async def get_encrypted_asset_with_key_check(
    connection: "AsyncConnection",
    user_id: str,
    asset_type: str,
    asset_id: str,
    action: str = "decrypt",
    auto_consume: bool = True,
) -> KeyGatedRetrievalResult:
    """Retrieve encrypted asset data with key-assertion gating.

    This is the primary retrieval method for key-protected assets:

    1. Look up key policy for ``(asset_type, asset_id, action)``
    2. If no policy → return data with base permission check only
    3. If policy exists → verify valid assertion(s) from the user
    4. If assertions are sufficient → return data (and optionally consume assertions)
    5. If assertions are insufficient → return access result with details

    Args:
        connection: Active async database connection.
        user_id: UUID of the authenticated user.
        asset_type: Asset type to query.
        asset_id: Asset UUID to query.
        action: Protected action to check (default "decrypt").
        auto_consume: If True, automatically consume the matching assertion(s)
            when access is granted. Default True.

    Returns:
        ``KeyGatedRetrievalResult`` containing the access check result and
        optionally the encrypted data if access was granted.

    Raises:
        EncryptedAssetNotFoundError: If no encrypted data exists for the asset.
    """
    _validate_asset_type(asset_type)
    _validate_protected_action(action)

    # Check if encrypted data exists at all
    data_result = await connection.execute(
        """
        SELECT * FROM public.encrypted_asset_data
        WHERE asset_type = %(asset_type)s AND asset_id = %(asset_id)s
        ORDER BY created_at DESC
        LIMIT 1
        """,
        {"asset_type": asset_type, "asset_id": asset_id},
    )
    data_row = await data_result.fetchone()

    if data_row is None:
        raise EncryptedAssetNotFoundError(asset_type, asset_id)

    # Check key-protected access
    access_result = await check_key_protected_access(
        connection, user_id, asset_type, asset_id, action
    )

    if not access_result.allowed:
        # Access denied — return the check result without data
        return KeyGatedRetrievalResult(access=access_result, data=None)

    # Access granted — optionally consume assertions
    if auto_consume and access_result.requires_assertion:
        await _consume_matching_assertions(connection, user_id, asset_type, asset_id)

    encrypted_data = _row_to_encrypted_asset_response(data_row)

    logger.info(
        "Encrypted asset retrieved (key-gated): user_id=%s asset=%s/%s action=%s",
        user_id,
        asset_type,
        asset_id,
        action,
    )

    return KeyGatedRetrievalResult(access=access_result, data=encrypted_data)


async def list_encrypted_assets_for_user(
    connection: "AsyncConnection",
    user_id: str,
    asset_type: str | None = None,
) -> list[EncryptedAssetMetadata]:
    """List encrypted asset metadata for assets encrypted by a user.

    Returns lightweight metadata (no ciphertext) for listing and discovery.
    Optionally filtered by asset type.

    Args:
        connection: Active async database connection.
        user_id: UUID of the user who encrypted the assets.
        asset_type: Optional asset type filter.

    Returns:
        List of encrypted asset metadata records (no ciphertext).
    """
    if asset_type:
        _validate_asset_type(asset_type)
        result = await connection.execute(
            """
            SELECT id, asset_type, asset_id, encryption_algorithm,
                   key_derivation_method, authorized_key_ids,
                   encrypted_by_user_id, created_at
            FROM public.encrypted_asset_data
            WHERE encrypted_by_user_id = %(user_id)s
              AND asset_type = %(asset_type)s
            ORDER BY created_at DESC
            """,
            {"user_id": user_id, "asset_type": asset_type},
        )
    else:
        result = await connection.execute(
            """
            SELECT id, asset_type, asset_id, encryption_algorithm,
                   key_derivation_method, authorized_key_ids,
                   encrypted_by_user_id, created_at
            FROM public.encrypted_asset_data
            WHERE encrypted_by_user_id = %(user_id)s
            ORDER BY created_at DESC
            """,
            {"user_id": user_id},
        )

    rows = await result.fetchall()
    return [_row_to_encrypted_asset_metadata(row) for row in rows]


async def delete_encrypted_asset(
    connection: "AsyncConnection",
    asset_type: str,
    asset_id: str,
) -> bool:
    """Delete encrypted asset data.

    The caller must have admin permission on the asset (enforced by
    the route layer or RLS).

    Args:
        connection: Active async database connection.
        asset_type: Asset type of the data to delete.
        asset_id: Asset UUID of the data to delete.

    Returns:
        True if data was deleted, False if not found.
    """
    _validate_asset_type(asset_type)

    result = await connection.execute(
        """
        DELETE FROM public.encrypted_asset_data
        WHERE asset_type = %(asset_type)s AND asset_id = %(asset_id)s
        RETURNING id
        """,
        {"asset_type": asset_type, "asset_id": asset_id},
    )
    row = await result.fetchone()

    if row:
        logger.info(
            "Encrypted asset deleted: asset=%s/%s record_id=%s",
            asset_type,
            asset_id,
            row["id"],
        )
    return row is not None


async def update_authorized_keys(
    connection: "AsyncConnection",
    user_id: str,
    asset_type: str,
    asset_id: str,
    update: EncryptedAssetKeyUpdate,
) -> EncryptedAssetResponse:
    """Update authorized keys and optionally re-encrypted payload.

    Used during key rotation:
    1. Client re-wraps DEK with new KEK (from new hardware key PRF)
    2. Client optionally re-encrypts payload with new DEK
    3. Client sends updated authorized_key_ids + new ciphertext to server

    Args:
        connection: Active async database connection.
        user_id: UUID of the authenticated user (must be the original encryptor or admin).
        asset_type: Asset type to update.
        asset_id: Asset UUID to update.
        update: New authorized key IDs and optional new ciphertext.

    Returns:
        Updated encrypted asset record.

    Raises:
        EncryptedAssetNotFoundError: If no encrypted data exists for the asset.
        InvalidAuthorizedKeys: If any new key IDs don't exist.
        InvalidInputError: If payload is provided without IV or vice versa.
    """
    _validate_asset_type(asset_type)

    # Validate new authorized keys exist
    await _validate_authorized_key_ids(connection, update.authorized_key_ids)

    # Validate payload/IV consistency
    has_new_payload = update.encrypted_payload is not None
    has_new_iv = update.initialization_vector is not None
    if has_new_payload != has_new_iv:
        raise InvalidInputError(
            "encrypted_payload and initialization_vector must both be provided "
            "or both be omitted during key rotation"
        )

    # Build update query
    set_clauses = ["authorized_key_ids = %(authorized_key_ids)s"]
    params: dict[str, Any] = {
        "asset_type": asset_type,
        "asset_id": asset_id,
        "authorized_key_ids": update.authorized_key_ids,
    }

    if has_new_payload:
        payload_bytes = _decode_base64_field(
            update.encrypted_payload, "encrypted_payload"
        )
        iv_bytes = _decode_base64_field(
            update.initialization_vector, "initialization_vector"
        )
        set_clauses.append("encrypted_payload = %(encrypted_payload)s")
        set_clauses.append("initialization_vector = %(initialization_vector)s")
        params["encrypted_payload"] = payload_bytes
        params["initialization_vector"] = iv_bytes

    set_clause = ", ".join(set_clauses)

    result = await connection.execute(
        f"""
        UPDATE public.encrypted_asset_data
        SET {set_clause}
        WHERE asset_type = %(asset_type)s AND asset_id = %(asset_id)s
        RETURNING *
        """,  # noqa: S608
        params,
    )
    row = await result.fetchone()

    if row is None:
        raise EncryptedAssetNotFoundError(asset_type, asset_id)

    logger.info(
        "Encrypted asset keys updated: user_id=%s asset=%s/%s new_key_count=%d payload_updated=%s",
        user_id,
        asset_type,
        asset_id,
        len(update.authorized_key_ids),
        has_new_payload,
    )
    return _row_to_encrypted_asset_response(row)


# ============================================================================
# Internal Helpers
# ============================================================================


async def _consume_matching_assertions(
    connection: "AsyncConnection",
    user_id: str,
    asset_type: str,
    asset_id: str,
) -> int:
    """Consume all matching valid assertions for a user and asset.

    Called after a key-gated operation succeeds to mark the assertions
    as used (single-use). Consumes both scoped assertions (matching the
    specific asset) and general (unscoped) assertions.

    Args:
        connection: Active async database connection.
        user_id: UUID of the user whose assertions to consume.
        asset_type: Asset type that was accessed.
        asset_id: Asset UUID that was accessed.

    Returns:
        Number of assertions consumed.
    """
    result = await connection.execute(
        """
        UPDATE public.key_assertions
        SET consumed = true, consumed_at = now()
        WHERE user_id = %(user_id)s
          AND consumed = false
          AND expires_at > now()
          AND (
            (asset_type = %(asset_type)s AND asset_id = %(asset_id)s)
            OR asset_type IS NULL
          )
        """,
        {
            "user_id": user_id,
            "asset_type": asset_type,
            "asset_id": asset_id,
        },
    )

    consumed_count = result.rowcount
    if consumed_count > 0:
        logger.info(
            "Assertions consumed: user_id=%s asset=%s/%s count=%d",
            user_id,
            asset_type,
            asset_id,
            consumed_count,
        )
    return consumed_count
