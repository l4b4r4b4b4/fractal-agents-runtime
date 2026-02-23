"""Pydantic models for hardware key encryption operations.

This module defines request/response data structures for:
- Hardware key registration and management (WebAuthn/FIDO2)
- Key assertion verification and status
- Encrypted asset CRUD operations
- Asset key policy management

All models follow the existing patterns in server/models.py.
"""

from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field, field_serializer, field_validator


# ============================================================================
# Hardware Key Models
# ============================================================================


class HardwareKeyInfo(BaseModel):
    """Hardware key registration record returned from the database.

    Represents a registered WebAuthn/FIDO2 hardware key with its
    public metadata. The actual public_key bytes are excluded from
    most responses for brevity — only included when needed for
    assertion verification.
    """

    id: str = Field(description="Hardware key UUID")
    user_id: str = Field(description="Owning user UUID")
    credential_id: str = Field(description="WebAuthn credential ID (base64url-encoded)")
    friendly_name: str | None = Field(
        default=None,
        description='User-defined name (e.g. "Blue SoloKey", "Backup YubiKey")',
    )
    device_type: str | None = Field(
        default=None,
        description="Hardware key brand/type: solokey, yubikey, titan, etc.",
    )
    transports: list[str] = Field(
        default_factory=list,
        description="Supported transports: usb, ble, nfc, internal, hybrid",
    )
    attestation_format: str | None = Field(
        default=None,
        description="WebAuthn attestation statement format (packed, tpm, none, etc.)",
    )
    aaguid: str | None = Field(
        default=None,
        description="Authenticator Attestation GUID — identifies the authenticator model",
    )
    is_active: bool = Field(
        default=True,
        description="Whether this key is active for assertions and decryption",
    )
    last_used_at: datetime | None = Field(
        default=None,
        description="Timestamp of most recent successful assertion",
    )
    created_at: datetime
    updated_at: datetime

    @field_serializer("created_at", "updated_at", "last_used_at")
    @classmethod
    def serialize_datetime(cls, value: datetime | None) -> str | None:
        """Serialize datetime to ISO 8601 format with Z suffix."""
        if value is None:
            return None
        return value.isoformat().replace("+00:00", "Z")


class HardwareKeyRegisterBeginRequest(BaseModel):
    """Request to begin hardware key registration (generate challenge).

    The server generates a WebAuthn registration challenge that the
    client passes to ``navigator.credentials.create()``.
    """

    friendly_name: str | None = Field(
        default=None,
        description="Optional user-defined name for the key being registered",
    )


class HardwareKeyRegisterBeginResponse(BaseModel):
    """Response with WebAuthn registration options for the client.

    Contains the PublicKeyCredentialCreationOptions that the client
    passes directly to ``navigator.credentials.create()``.
    """

    challenge: str = Field(description="Base64url-encoded challenge bytes")
    rp: dict[str, str] = Field(description="Relying Party information (name, id)")
    user: dict[str, str] = Field(description="User information (id, name, displayName)")
    pub_key_cred_params: list[dict[str, Any]] = Field(
        description="Acceptable public key algorithms (ES256, RS256)"
    )
    timeout: int = Field(
        default=60000,
        description="Timeout in milliseconds for the ceremony",
    )
    authenticator_selection: dict[str, Any] = Field(
        default_factory=lambda: {
            "authenticatorAttachment": "cross-platform",
            "residentKey": "preferred",
            "userVerification": "preferred",
        },
        description="Authenticator selection criteria",
    )
    attestation: str = Field(
        default="direct",
        description="Attestation conveyance preference",
    )
    extensions: dict[str, Any] = Field(
        default_factory=lambda: {"prf": {}},
        description="WebAuthn extensions — includes PRF for key derivation support detection",
    )
    exclude_credentials: list[dict[str, Any]] = Field(
        default_factory=list,
        description="Credentials to exclude (user's existing keys to prevent re-registration)",
    )


class HardwareKeyRegisterCompleteRequest(BaseModel):
    """Request to complete hardware key registration.

    Contains the WebAuthn attestation response from
    ``navigator.credentials.create()``.
    """

    credential_id: str = Field(
        description="Base64url-encoded credential ID from the authenticator"
    )
    attestation_object: str = Field(description="Base64url-encoded attestation object")
    client_data_json: str = Field(description="Base64url-encoded client data JSON")
    transports: list[str] = Field(
        default_factory=list,
        description="Transports reported by the authenticator",
    )
    friendly_name: str | None = Field(
        default=None,
        description="User-defined name for this key",
    )
    device_type: str | None = Field(
        default=None,
        description="Hardware key brand/type hint from the client",
    )
    prf_supported: bool = Field(
        default=False,
        description="Whether the authenticator reported PRF extension support",
    )

    @field_validator("device_type")
    @classmethod
    def validate_device_type(cls, value: str | None) -> str | None:
        """Validate device_type against allowed values."""
        allowed_device_types = {
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
        if value is not None and value not in allowed_device_types:
            msg = f"device_type must be one of {sorted(allowed_device_types)}"
            raise ValueError(msg)
        return value


class HardwareKeyUpdateRequest(BaseModel):
    """Request to update a hardware key's metadata."""

    friendly_name: str | None = Field(
        default=None,
        description="New user-defined name for the key",
    )


# ============================================================================
# Assertion Models
# ============================================================================


class AssertionBeginRequest(BaseModel):
    """Request to begin a key assertion (generate challenge).

    Optionally scoped to a specific asset for targeted assertions.
    """

    asset_type: str | None = Field(
        default=None,
        description="Target asset type for scoped assertion (e.g. chat_session, document). NULL for general.",
    )
    asset_id: str | None = Field(
        default=None,
        description="Target asset UUID for scoped assertion. NULL for general.",
    )

    @field_validator("asset_type")
    @classmethod
    def validate_asset_type(cls, value: str | None) -> str | None:
        """Validate asset_type against allowed values."""
        allowed_asset_types = {
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
        if value is not None and value not in allowed_asset_types:
            msg = f"asset_type must be one of {sorted(allowed_asset_types)}"
            raise ValueError(msg)
        return value


class AssertionBeginResponse(BaseModel):
    """Response with WebAuthn assertion options for the client.

    Contains the PublicKeyCredentialRequestOptions that the client
    passes to ``navigator.credentials.get()``.
    """

    challenge: str = Field(description="Base64url-encoded challenge bytes")
    rp_id: str = Field(description="Relying Party ID for assertion")
    timeout: int = Field(
        default=60000,
        description="Timeout in milliseconds for the ceremony",
    )
    allow_credentials: list[dict[str, Any]] = Field(
        default_factory=list,
        description="List of allowed credentials (user's active keys)",
    )
    user_verification: str = Field(
        default="preferred",
        description="User verification requirement",
    )
    extensions: dict[str, Any] = Field(
        default_factory=lambda: {
            "prf": {
                "eval": {
                    "first": None,
                }
            }
        },
        description="WebAuthn extensions — PRF eval with salt set by client",
    )
    asset_type: str | None = Field(
        default=None,
        description="Echo back the asset scope for client convenience",
    )
    asset_id: str | None = Field(
        default=None,
        description="Echo back the asset scope for client convenience",
    )


class AssertionCompleteRequest(BaseModel):
    """Request to complete a key assertion verification.

    Contains the WebAuthn assertion response from
    ``navigator.credentials.get()``.
    """

    credential_id: str = Field(
        description="Base64url-encoded credential ID used for this assertion"
    )
    authenticator_data: str = Field(description="Base64url-encoded authenticator data")
    client_data_json: str = Field(description="Base64url-encoded client data JSON")
    signature: str = Field(description="Base64url-encoded assertion signature")
    challenge: str = Field(
        description="The challenge that was signed (base64url-encoded)"
    )
    asset_type: str | None = Field(
        default=None,
        description="Asset scope for this assertion (must match begin request)",
    )
    asset_id: str | None = Field(
        default=None,
        description="Asset scope UUID (must match begin request)",
    )

    @field_validator("asset_type")
    @classmethod
    def validate_asset_type(cls, value: str | None) -> str | None:
        """Validate asset_type against allowed values."""
        allowed_asset_types = {
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
        if value is not None and value not in allowed_asset_types:
            msg = f"asset_type must be one of {sorted(allowed_asset_types)}"
            raise ValueError(msg)
        return value


class KeyAssertionRecord(BaseModel):
    """A verified key assertion record from the database.

    Ephemeral proof-of-presence with a short TTL (default 5 minutes).
    """

    id: str = Field(description="Assertion UUID")
    user_id: str = Field(description="User who performed the assertion")
    hardware_key_id: str = Field(description="Hardware key used")
    asset_type: str | None = Field(
        default=None,
        description="Scoped asset type (NULL for general assertion)",
    )
    asset_id: str | None = Field(
        default=None,
        description="Scoped asset UUID (NULL for general assertion)",
    )
    challenge: str = Field(description="The signed challenge (for audit)")
    verified_at: datetime
    expires_at: datetime
    consumed: bool = Field(default=False)
    consumed_at: datetime | None = Field(default=None)

    @field_serializer("verified_at", "expires_at", "consumed_at")
    @classmethod
    def serialize_datetime(cls, value: datetime | None) -> str | None:
        """Serialize datetime to ISO 8601 format with Z suffix."""
        if value is None:
            return None
        return value.isoformat().replace("+00:00", "Z")


class AssertionStatusResponse(BaseModel):
    """Response indicating whether the user has a valid assertion for an asset."""

    has_valid_assertion: bool = Field(
        description="Whether a valid (unexpired, unconsumed) assertion exists"
    )
    assertion_id: str | None = Field(
        default=None,
        description="ID of the valid assertion, if one exists",
    )
    expires_at: datetime | None = Field(
        default=None,
        description="When the assertion expires",
    )
    required_key_count: int = Field(
        default=1,
        description="How many distinct key touches are required by the policy",
    )
    current_assertion_count: int = Field(
        default=0,
        description="How many distinct users have provided valid assertions",
    )
    is_satisfied: bool = Field(
        description="Whether the threshold requirement is fully met"
    )

    @field_serializer("expires_at")
    @classmethod
    def serialize_datetime(cls, value: datetime | None) -> str | None:
        """Serialize datetime to ISO 8601 format with Z suffix."""
        if value is None:
            return None
        return value.isoformat().replace("+00:00", "Z")


# ============================================================================
# Encrypted Asset Models
# ============================================================================


ALLOWED_ASSET_TYPES = frozenset(
    {
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
)

ALLOWED_ENCRYPTION_ALGORITHMS = frozenset(
    {
        "AES-GCM-256",
        "AES-CBC-256",
        "ChaCha20-Poly1305",
    }
)

ALLOWED_KEY_DERIVATION_METHODS = frozenset(
    {
        "webauthn-prf-hkdf",
        "webauthn-hmac-secret-hkdf",
        "passphrase-pbkdf2",
        "shamir-recombine",
    }
)


class EncryptedAssetCreateRequest(BaseModel):
    """Request to store a client-side encrypted asset payload.

    The server stores the ciphertext and metadata but NEVER sees the
    plaintext or the encryption key. Decryption happens client-side
    using hardware key PRF-derived key material.
    """

    asset_type: str = Field(description="Type of the protected asset")
    asset_id: str = Field(description="UUID of the protected asset")
    encrypted_payload: str = Field(description="Base64-encoded ciphertext")
    encryption_algorithm: str = Field(
        default="AES-GCM-256",
        description="Symmetric encryption algorithm used",
    )
    key_derivation_method: str = Field(
        default="webauthn-prf-hkdf",
        description="How the encryption key was derived from hardware key material",
    )
    initialization_vector: str = Field(
        description="Base64-encoded IV/nonce for the symmetric cipher"
    )
    authorized_key_ids: list[str] = Field(
        min_length=1,
        description="UUIDs of hardware keys whose PRF output can derive the decryption key",
    )

    @field_validator("asset_type")
    @classmethod
    def validate_asset_type(cls, value: str) -> str:
        """Validate asset_type against allowed values."""
        if value not in ALLOWED_ASSET_TYPES:
            msg = f"asset_type must be one of {sorted(ALLOWED_ASSET_TYPES)}"
            raise ValueError(msg)
        return value

    @field_validator("encryption_algorithm")
    @classmethod
    def validate_encryption_algorithm(cls, value: str) -> str:
        """Validate encryption_algorithm against allowed values."""
        if value not in ALLOWED_ENCRYPTION_ALGORITHMS:
            msg = f"encryption_algorithm must be one of {sorted(ALLOWED_ENCRYPTION_ALGORITHMS)}"
            raise ValueError(msg)
        return value

    @field_validator("key_derivation_method")
    @classmethod
    def validate_key_derivation_method(cls, value: str) -> str:
        """Validate key_derivation_method against allowed values."""
        if value not in ALLOWED_KEY_DERIVATION_METHODS:
            msg = f"key_derivation_method must be one of {sorted(ALLOWED_KEY_DERIVATION_METHODS)}"
            raise ValueError(msg)
        return value


class EncryptedAssetRecord(BaseModel):
    """An encrypted asset record from the database.

    Contains the ciphertext and all metadata needed for the client to
    derive the decryption key and decrypt the payload.
    """

    id: str = Field(description="Record UUID")
    asset_type: str
    asset_id: str
    encrypted_payload: str = Field(description="Base64-encoded ciphertext")
    encryption_algorithm: str
    key_derivation_method: str
    initialization_vector: str = Field(description="Base64-encoded IV/nonce")
    authorized_key_ids: list[str] = Field(
        description="Hardware key UUIDs that can decrypt"
    )
    encrypted_by_user_id: str | None = Field(
        default=None,
        description="User who encrypted this data",
    )
    created_at: datetime
    updated_at: datetime

    @field_serializer("created_at", "updated_at")
    @classmethod
    def serialize_datetime(cls, value: datetime) -> str:
        """Serialize datetime to ISO 8601 format with Z suffix."""
        return value.isoformat().replace("+00:00", "Z")


# ============================================================================
# Key Policy Models
# ============================================================================


ALLOWED_PROTECTED_ACTIONS = frozenset(
    {
        "decrypt",
        "delete",
        "export",
        "share",
        "sign",
        "all_writes",
        "admin",
    }
)


class KeyPolicyCreateRequest(BaseModel):
    """Request to create or update an asset key policy.

    Declares that a specific action on a specific asset requires
    hardware key touch(es) before the operation is allowed.
    """

    asset_type: str = Field(description="Type of the protected asset")
    asset_id: str = Field(description="UUID of the protected asset")
    protected_action: str = Field(
        description="Action that requires key touch: decrypt, delete, export, share, sign, all_writes, admin",
    )
    required_key_count: int = Field(
        default=1,
        ge=1,
        description="Number of distinct key touches required (1=standard, 2+=multi-key)",
    )
    required_key_ids: list[str] | None = Field(
        default=None,
        description="If set, only these specific hardware keys are accepted. NULL means any active key.",
    )

    @field_validator("asset_type")
    @classmethod
    def validate_asset_type(cls, value: str) -> str:
        """Validate asset_type against allowed values."""
        if value not in ALLOWED_ASSET_TYPES:
            msg = f"asset_type must be one of {sorted(ALLOWED_ASSET_TYPES)}"
            raise ValueError(msg)
        return value

    @field_validator("protected_action")
    @classmethod
    def validate_protected_action(cls, value: str) -> str:
        """Validate protected_action against allowed values."""
        if value not in ALLOWED_PROTECTED_ACTIONS:
            msg = f"protected_action must be one of {sorted(ALLOWED_PROTECTED_ACTIONS)}"
            raise ValueError(msg)
        return value


class KeyPolicyRecord(BaseModel):
    """A key policy record from the database."""

    id: str = Field(description="Policy UUID")
    asset_type: str
    asset_id: str
    protected_action: str
    required_key_count: int
    required_key_ids: list[str] | None = Field(default=None)
    created_by_user_id: str | None = Field(default=None)
    created_at: datetime
    updated_at: datetime

    @field_serializer("created_at", "updated_at")
    @classmethod
    def serialize_datetime(cls, value: datetime) -> str:
        """Serialize datetime to ISO 8601 format with Z suffix."""
        return value.isoformat().replace("+00:00", "Z")


# ============================================================================
# Access Check Models
# ============================================================================


class KeyProtectedAccessCheck(BaseModel):
    """Request to check if a user has key-protected access to an asset."""

    asset_type: str
    asset_id: str
    action: str = Field(
        default="decrypt",
        description="The protected action to check",
    )

    @field_validator("asset_type")
    @classmethod
    def validate_asset_type(cls, value: str) -> str:
        """Validate asset_type against allowed values."""
        if value not in ALLOWED_ASSET_TYPES:
            msg = f"asset_type must be one of {sorted(ALLOWED_ASSET_TYPES)}"
            raise ValueError(msg)
        return value

    @field_validator("action")
    @classmethod
    def validate_action(cls, value: str) -> str:
        """Validate action against allowed values."""
        if value not in ALLOWED_PROTECTED_ACTIONS:
            msg = f"action must be one of {sorted(ALLOWED_PROTECTED_ACTIONS)}"
            raise ValueError(msg)
        return value


class KeyProtectedAccessResponse(BaseModel):
    """Response from a key-protected access check."""

    has_access: bool = Field(
        description="Whether the user has access (base permission + key assertion if required)"
    )
    requires_key: bool = Field(
        description="Whether a hardware key touch is required for this operation"
    )
    policy: KeyPolicyRecord | None = Field(
        default=None,
        description="The applicable key policy, if one exists",
    )
    assertion_status: AssertionStatusResponse | None = Field(
        default=None,
        description="Current assertion status if a key is required",
    )
