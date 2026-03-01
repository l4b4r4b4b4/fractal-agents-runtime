"""Unit tests for encryption service pure functions (server.encryption_service).

Covers all non-async, non-database code:
- Exception classes and their attributes (message, status_code, custom fields)
- ``_validate_encryption_algorithm()`` — enum validation
- ``_validate_key_derivation_method()`` — enum validation
- ``_decode_base64_field()`` — base64/base64url decoding with padding
- ``_encode_bytes_to_base64()`` — bytes → base64 string
- ``_row_to_encrypted_asset_response()`` — dict → EncryptedAssetResponse
- ``_row_to_encrypted_asset_metadata()`` — dict → EncryptedAssetMetadata
- Pydantic request/response models — instantiation and defaults
- Constants — VALID_ENCRYPTION_ALGORITHMS, VALID_KEY_DERIVATION_METHODS

These are pure functions with no external dependencies — all tests run
without database, network, or service mocks.
"""

from __future__ import annotations

import base64
from datetime import datetime, timezone
from uuid import uuid4

import pytest

from server.encryption_service import (
    VALID_ENCRYPTION_ALGORITHMS,
    VALID_KEY_DERIVATION_METHODS,
    EncryptedAssetKeyUpdate,
    EncryptedAssetMetadata,
    EncryptedAssetNotFoundError,
    EncryptedAssetResponse,
    EncryptedAssetStore,
    InsufficientKeyAssertions,
    InvalidAuthorizedKeys,
    KeyAssertionRequired,
    KeyGatedRetrievalResult,
    _decode_base64_field,
    _encode_bytes_to_base64,
    _row_to_encrypted_asset_metadata,
    _row_to_encrypted_asset_response,
    _validate_encryption_algorithm,
    _validate_key_derivation_method,
)
from server.hardware_key_service import (
    HardwareKeyError,
    InvalidInputError,
    KeyProtectedAccessResult,
)


# ============================================================================
# Fixtures
# ============================================================================

NOW = datetime(2026, 3, 2, 12, 0, 0, tzinfo=timezone.utc)
LATER = datetime(2026, 3, 2, 12, 5, 0, tzinfo=timezone.utc)


def _make_encrypted_asset_row(**overrides: object) -> dict:
    """Build a minimal encrypted_asset_data row dict with bytea fields."""
    payload_bytes = b"encrypted-payload-bytes-here"
    iv_bytes = b"iv-nonce-bytes"
    row = {
        "id": uuid4(),
        "asset_type": "document",
        "asset_id": uuid4(),
        "encrypted_payload": payload_bytes,
        "encryption_algorithm": "AES-GCM-256",
        "key_derivation_method": "webauthn-prf-hkdf",
        "initialization_vector": iv_bytes,
        "authorized_key_ids": [uuid4(), uuid4()],
        "encrypted_by_user_id": uuid4(),
        "created_at": NOW,
        "updated_at": NOW,
    }
    row.update(overrides)
    return row


# ============================================================================
# Constants
# ============================================================================


class TestConstants:
    """Verify the constant sets contain expected values."""

    def test_valid_encryption_algorithms(self) -> None:
        expected = {"AES-GCM-256", "AES-CBC-256", "ChaCha20-Poly1305"}
        assert VALID_ENCRYPTION_ALGORITHMS == expected

    def test_valid_key_derivation_methods(self) -> None:
        expected = {
            "webauthn-prf-hkdf",
            "webauthn-hmac-secret-hkdf",
            "passphrase-pbkdf2",
            "shamir-recombine",
        }
        assert VALID_KEY_DERIVATION_METHODS == expected

    def test_constants_are_sets(self) -> None:
        assert isinstance(VALID_ENCRYPTION_ALGORITHMS, set)
        assert isinstance(VALID_KEY_DERIVATION_METHODS, set)


# ============================================================================
# Exception Classes
# ============================================================================


class TestKeyAssertionRequired:
    """Tests for KeyAssertionRequired exception."""

    def test_attributes(self) -> None:
        error = KeyAssertionRequired(
            asset_type="document",
            asset_id="doc-1",
            action="decrypt",
            required_count=2,
            assertions_present=1,
        )
        assert error.asset_type == "document"
        assert error.asset_id == "doc-1"
        assert error.action == "decrypt"
        assert error.required_count == 2
        assert error.assertions_present == 1
        assert error.status_code == 428

    def test_default_counts(self) -> None:
        error = KeyAssertionRequired(
            asset_type="project",
            asset_id="p-1",
            action="export",
        )
        assert error.required_count == 1
        assert error.assertions_present == 0

    def test_message_includes_details(self) -> None:
        error = KeyAssertionRequired(
            asset_type="document",
            asset_id="doc-42",
            action="decrypt",
            required_count=3,
            assertions_present=1,
        )
        assert "decrypt" in error.message
        assert "document" in error.message
        assert "doc-42" in error.message
        assert "3" in error.message
        assert "1 present" in error.message

    def test_inherits_from_hardware_key_error(self) -> None:
        error = KeyAssertionRequired("t", "i", "a")
        assert isinstance(error, HardwareKeyError)


class TestInsufficientKeyAssertions:
    """Tests for InsufficientKeyAssertions exception."""

    def test_attributes(self) -> None:
        error = InsufficientKeyAssertions(
            required=3,
            present=1,
            asset_type="chat_session",
            asset_id="cs-1",
        )
        assert error.required == 3
        assert error.present == 1
        assert error.asset_type == "chat_session"
        assert error.asset_id == "cs-1"
        assert error.status_code == 428

    def test_message_includes_counts(self) -> None:
        error = InsufficientKeyAssertions(
            required=5,
            present=2,
            asset_type="repository",
            asset_id="repo-1",
        )
        assert "2" in error.message
        assert "5" in error.message
        assert "repository" in error.message

    def test_inherits_from_hardware_key_error(self) -> None:
        error = InsufficientKeyAssertions(2, 0, "document", "d")
        assert isinstance(error, HardwareKeyError)


class TestInvalidAuthorizedKeys:
    """Tests for InvalidAuthorizedKeys exception."""

    def test_attributes(self) -> None:
        bad_ids = ["key-bad-1", "key-bad-2"]
        error = InvalidAuthorizedKeys(bad_ids)
        assert error.invalid_key_ids == bad_ids
        assert error.status_code == 400

    def test_message_includes_ids(self) -> None:
        error = InvalidAuthorizedKeys(["k-missing"])
        assert "k-missing" in error.message

    def test_inherits_from_hardware_key_error(self) -> None:
        error = InvalidAuthorizedKeys(["k"])
        assert isinstance(error, HardwareKeyError)


class TestEncryptedAssetNotFoundError:
    """Tests for EncryptedAssetNotFoundError exception."""

    def test_attributes(self) -> None:
        error = EncryptedAssetNotFoundError("document", "doc-42")
        assert error.asset_type == "document"
        assert error.asset_id == "doc-42"
        assert error.status_code == 404

    def test_message_includes_asset_info(self) -> None:
        error = EncryptedAssetNotFoundError("project", "proj-7")
        assert "project" in error.message
        assert "proj-7" in error.message

    def test_inherits_from_hardware_key_error(self) -> None:
        error = EncryptedAssetNotFoundError("t", "i")
        assert isinstance(error, HardwareKeyError)


# ============================================================================
# _validate_encryption_algorithm
# ============================================================================


class TestValidateEncryptionAlgorithm:
    """Tests for ``_validate_encryption_algorithm()``."""

    def test_all_valid_algorithms(self) -> None:
        for algorithm in VALID_ENCRYPTION_ALGORITHMS:
            _validate_encryption_algorithm(algorithm)  # Should not raise

    def test_invalid_algorithm_raises(self) -> None:
        with pytest.raises(InvalidInputError, match="Invalid encryption_algorithm"):
            _validate_encryption_algorithm("ROT13")

    def test_error_message_lists_allowed(self) -> None:
        with pytest.raises(InvalidInputError, match="Allowed:"):
            _validate_encryption_algorithm("DES-56")

    def test_case_sensitive(self) -> None:
        with pytest.raises(InvalidInputError):
            _validate_encryption_algorithm("aes-gcm-256")


# ============================================================================
# _validate_key_derivation_method
# ============================================================================


class TestValidateKeyDerivationMethod:
    """Tests for ``_validate_key_derivation_method()``."""

    def test_all_valid_methods(self) -> None:
        for method in VALID_KEY_DERIVATION_METHODS:
            _validate_key_derivation_method(method)  # Should not raise

    def test_invalid_method_raises(self) -> None:
        with pytest.raises(InvalidInputError, match="Invalid key_derivation_method"):
            _validate_key_derivation_method("plaintext")

    def test_error_message_lists_allowed(self) -> None:
        with pytest.raises(InvalidInputError, match="Allowed:"):
            _validate_key_derivation_method("bad-method")


# ============================================================================
# _decode_base64_field / _encode_bytes_to_base64
# ============================================================================


class TestDecodeBase64Field:
    """Tests for ``_decode_base64_field()``."""

    def test_standard_base64(self) -> None:
        original = b"hello world"
        encoded = base64.b64encode(original).decode()
        result = _decode_base64_field(encoded, "test_field")
        assert result == original

    def test_base64url(self) -> None:
        # base64url uses - and _ instead of + and /
        original = b"hello+world/test"
        encoded = base64.urlsafe_b64encode(original).decode()
        result = _decode_base64_field(encoded, "test_field")
        assert result == original

    def test_with_padding(self) -> None:
        original = b"test"
        encoded = base64.b64encode(original).decode()
        assert "=" in encoded  # "test" base64 has padding
        result = _decode_base64_field(encoded, "test_field")
        assert result == original

    def test_without_padding(self) -> None:
        original = b"test"
        encoded = base64.b64encode(original).decode().rstrip("=")
        result = _decode_base64_field(encoded, "test_field")
        assert result == original

    def test_empty_string_decodes(self) -> None:
        result = _decode_base64_field("", "test_field")
        assert result == b""

    def test_invalid_base64_raises(self) -> None:
        with pytest.raises(InvalidInputError, match="Invalid base64 encoding"):
            _decode_base64_field("!!!not-base64!!!", "my_field")

    def test_error_message_includes_field_name(self) -> None:
        with pytest.raises(InvalidInputError, match="payload_field"):
            _decode_base64_field(
                "\x00\x01\x02not-valid-at-all\xff\xfe", "payload_field"
            )


class TestEncodeBytes:
    """Tests for ``_encode_bytes_to_base64()``."""

    def test_round_trip(self) -> None:
        original = b"round trip test data"
        encoded = _encode_bytes_to_base64(original)
        decoded = base64.b64decode(encoded)
        assert decoded == original

    def test_returns_string(self) -> None:
        result = _encode_bytes_to_base64(b"test")
        assert isinstance(result, str)

    def test_empty_bytes(self) -> None:
        result = _encode_bytes_to_base64(b"")
        assert result == ""

    def test_standard_base64_encoding(self) -> None:
        # Verify it uses standard base64, not base64url
        data = b"\xfb\xff\xfe"
        result = _encode_bytes_to_base64(data)
        # Standard base64 uses + and /
        expected = base64.b64encode(data).decode("ascii")
        assert result == expected


# ============================================================================
# _row_to_encrypted_asset_response
# ============================================================================


class TestRowToEncryptedAssetResponse:
    """Tests for ``_row_to_encrypted_asset_response()``."""

    def test_full_row_with_bytes(self) -> None:
        row = _make_encrypted_asset_row()
        response = _row_to_encrypted_asset_response(row)
        assert isinstance(response, EncryptedAssetResponse)
        assert response.id == str(row["id"])
        assert response.asset_type == "document"
        assert response.asset_id == str(row["asset_id"])
        assert response.encryption_algorithm == "AES-GCM-256"
        assert response.key_derivation_method == "webauthn-prf-hkdf"
        # bytea → base64 encoding
        assert isinstance(response.encrypted_payload, str)
        assert isinstance(response.initialization_vector, str)

    def test_bytea_payload_base64_encoded(self) -> None:
        payload = b"secret-data"
        row = _make_encrypted_asset_row(encrypted_payload=payload)
        response = _row_to_encrypted_asset_response(row)
        decoded = base64.b64decode(response.encrypted_payload)
        assert decoded == payload

    def test_bytea_iv_base64_encoded(self) -> None:
        iv = b"nonce-12-bytes"
        row = _make_encrypted_asset_row(initialization_vector=iv)
        response = _row_to_encrypted_asset_response(row)
        decoded = base64.b64decode(response.initialization_vector)
        assert decoded == iv

    def test_memoryview_payload(self) -> None:
        payload = b"memoryview-test"
        row = _make_encrypted_asset_row(encrypted_payload=memoryview(payload))
        response = _row_to_encrypted_asset_response(row)
        decoded = base64.b64decode(response.encrypted_payload)
        assert decoded == payload

    def test_bytearray_iv(self) -> None:
        iv = bytearray(b"bytearray-iv")
        row = _make_encrypted_asset_row(initialization_vector=iv)
        response = _row_to_encrypted_asset_response(row)
        decoded = base64.b64decode(response.initialization_vector)
        assert decoded == bytes(iv)

    def test_string_payload_passthrough(self) -> None:
        """When payload is already a string (not bytes), pass through as-is."""
        row = _make_encrypted_asset_row(encrypted_payload="already-base64-string")
        response = _row_to_encrypted_asset_response(row)
        assert response.encrypted_payload == "already-base64-string"

    def test_string_iv_passthrough(self) -> None:
        """When IV is already a string (not bytes), pass through as-is."""
        row = _make_encrypted_asset_row(initialization_vector="already-base64")
        response = _row_to_encrypted_asset_response(row)
        assert response.initialization_vector == "already-base64"

    def test_authorized_key_ids_converted_to_strings(self) -> None:
        kid1 = uuid4()
        kid2 = uuid4()
        row = _make_encrypted_asset_row(authorized_key_ids=[kid1, kid2])
        response = _row_to_encrypted_asset_response(row)
        assert response.authorized_key_ids == [str(kid1), str(kid2)]

    def test_null_authorized_key_ids(self) -> None:
        row = _make_encrypted_asset_row(authorized_key_ids=None)
        response = _row_to_encrypted_asset_response(row)
        assert response.authorized_key_ids == []

    def test_empty_authorized_key_ids(self) -> None:
        row = _make_encrypted_asset_row(authorized_key_ids=[])
        response = _row_to_encrypted_asset_response(row)
        assert response.authorized_key_ids == []

    def test_encrypted_by_user_id_present(self) -> None:
        user_id = uuid4()
        row = _make_encrypted_asset_row(encrypted_by_user_id=user_id)
        response = _row_to_encrypted_asset_response(row)
        assert response.encrypted_by_user_id == str(user_id)

    def test_encrypted_by_user_id_none(self) -> None:
        row = _make_encrypted_asset_row(encrypted_by_user_id=None)
        response = _row_to_encrypted_asset_response(row)
        assert response.encrypted_by_user_id is None

    def test_missing_encrypted_by_user_id(self) -> None:
        row = _make_encrypted_asset_row()
        del row["encrypted_by_user_id"]
        response = _row_to_encrypted_asset_response(row)
        assert response.encrypted_by_user_id is None

    def test_timestamps_formatted(self) -> None:
        row = _make_encrypted_asset_row()
        response = _row_to_encrypted_asset_response(row)
        assert "Z" in response.created_at
        assert "Z" in response.updated_at
        assert "+00:00" not in response.created_at


# ============================================================================
# _row_to_encrypted_asset_metadata
# ============================================================================


class TestRowToEncryptedAssetMetadata:
    """Tests for ``_row_to_encrypted_asset_metadata()``."""

    def test_full_row(self) -> None:
        row = _make_encrypted_asset_row()
        metadata = _row_to_encrypted_asset_metadata(row)
        assert isinstance(metadata, EncryptedAssetMetadata)
        assert metadata.id == str(row["id"])
        assert metadata.asset_type == "document"
        assert metadata.asset_id == str(row["asset_id"])
        assert metadata.encryption_algorithm == "AES-GCM-256"
        assert metadata.key_derivation_method == "webauthn-prf-hkdf"

    def test_no_payload_or_iv_in_metadata(self) -> None:
        row = _make_encrypted_asset_row()
        metadata = _row_to_encrypted_asset_metadata(row)
        # Metadata model does not have encrypted_payload or initialization_vector
        assert (
            not hasattr(metadata, "encrypted_payload")
            or "encrypted_payload" not in metadata.model_fields
        )
        assert (
            not hasattr(metadata, "initialization_vector")
            or "initialization_vector" not in metadata.model_fields
        )

    def test_authorized_key_ids_converted(self) -> None:
        kid = uuid4()
        row = _make_encrypted_asset_row(authorized_key_ids=[kid])
        metadata = _row_to_encrypted_asset_metadata(row)
        assert metadata.authorized_key_ids == [str(kid)]

    def test_null_authorized_key_ids(self) -> None:
        row = _make_encrypted_asset_row(authorized_key_ids=None)
        metadata = _row_to_encrypted_asset_metadata(row)
        assert metadata.authorized_key_ids == []

    def test_encrypted_by_user_id_present(self) -> None:
        user_id = uuid4()
        row = _make_encrypted_asset_row(encrypted_by_user_id=user_id)
        metadata = _row_to_encrypted_asset_metadata(row)
        assert metadata.encrypted_by_user_id == str(user_id)

    def test_encrypted_by_user_id_none(self) -> None:
        row = _make_encrypted_asset_row(encrypted_by_user_id=None)
        metadata = _row_to_encrypted_asset_metadata(row)
        assert metadata.encrypted_by_user_id is None

    def test_missing_encrypted_by_user_id(self) -> None:
        row = _make_encrypted_asset_row()
        del row["encrypted_by_user_id"]
        metadata = _row_to_encrypted_asset_metadata(row)
        assert metadata.encrypted_by_user_id is None

    def test_timestamp_formatted(self) -> None:
        row = _make_encrypted_asset_row()
        metadata = _row_to_encrypted_asset_metadata(row)
        assert "Z" in metadata.created_at


# ============================================================================
# Pydantic Request Models
# ============================================================================


class TestEncryptedAssetStore:
    """Tests for EncryptedAssetStore Pydantic model."""

    def test_required_fields(self) -> None:
        store = EncryptedAssetStore(
            asset_type="document",
            asset_id="doc-1",
            encrypted_payload="base64-payload",
            initialization_vector="base64-iv",
            authorized_key_ids=["key-1"],
        )
        assert store.asset_type == "document"
        assert store.encryption_algorithm == "AES-GCM-256"
        assert store.key_derivation_method == "webauthn-prf-hkdf"

    def test_custom_algorithm_and_method(self) -> None:
        store = EncryptedAssetStore(
            asset_type="project",
            asset_id="p-1",
            encrypted_payload="ct",
            initialization_vector="iv",
            authorized_key_ids=["k1", "k2"],
            encryption_algorithm="ChaCha20-Poly1305",
            key_derivation_method="shamir-recombine",
        )
        assert store.encryption_algorithm == "ChaCha20-Poly1305"
        assert store.key_derivation_method == "shamir-recombine"

    def test_multiple_authorized_keys(self) -> None:
        store = EncryptedAssetStore(
            asset_type="agent",
            asset_id="a-1",
            encrypted_payload="ct",
            initialization_vector="iv",
            authorized_key_ids=["k1", "k2", "k3"],
        )
        assert len(store.authorized_key_ids) == 3


class TestEncryptedAssetKeyUpdate:
    """Tests for EncryptedAssetKeyUpdate Pydantic model."""

    def test_keys_only(self) -> None:
        update = EncryptedAssetKeyUpdate(
            authorized_key_ids=["k1", "k2"],
        )
        assert len(update.authorized_key_ids) == 2
        assert update.encrypted_payload is None
        assert update.initialization_vector is None

    def test_with_new_payload(self) -> None:
        update = EncryptedAssetKeyUpdate(
            authorized_key_ids=["k1"],
            encrypted_payload="new-ciphertext",
            initialization_vector="new-iv",
        )
        assert update.encrypted_payload == "new-ciphertext"
        assert update.initialization_vector == "new-iv"


# ============================================================================
# Pydantic Response Models
# ============================================================================


class TestEncryptedAssetResponseModel:
    """Tests for EncryptedAssetResponse Pydantic model direct instantiation."""

    def test_all_fields(self) -> None:
        resp = EncryptedAssetResponse(
            id="ea-1",
            asset_type="document",
            asset_id="doc-1",
            encrypted_payload="base64-ct",
            encryption_algorithm="AES-GCM-256",
            key_derivation_method="webauthn-prf-hkdf",
            initialization_vector="base64-iv",
            authorized_key_ids=["k1"],
            encrypted_by_user_id="user-1",
            created_at="2026-03-02T12:00:00Z",
            updated_at="2026-03-02T12:00:00Z",
        )
        assert resp.id == "ea-1"
        assert resp.encrypted_by_user_id == "user-1"

    def test_encrypted_by_user_id_optional(self) -> None:
        resp = EncryptedAssetResponse(
            id="ea-2",
            asset_type="project",
            asset_id="p-1",
            encrypted_payload="ct",
            encryption_algorithm="AES-CBC-256",
            key_derivation_method="passphrase-pbkdf2",
            initialization_vector="iv",
            authorized_key_ids=["k1"],
            created_at="2026-03-02T12:00:00Z",
            updated_at="2026-03-02T12:00:00Z",
        )
        assert resp.encrypted_by_user_id is None


class TestEncryptedAssetMetadataModel:
    """Tests for EncryptedAssetMetadata Pydantic model direct instantiation."""

    def test_all_fields(self) -> None:
        meta = EncryptedAssetMetadata(
            id="ea-1",
            asset_type="repository",
            asset_id="repo-1",
            encryption_algorithm="ChaCha20-Poly1305",
            key_derivation_method="shamir-recombine",
            authorized_key_ids=["k1", "k2"],
            encrypted_by_user_id="user-1",
            created_at="2026-03-02T12:00:00Z",
        )
        assert meta.id == "ea-1"
        assert len(meta.authorized_key_ids) == 2

    def test_encrypted_by_user_id_optional(self) -> None:
        meta = EncryptedAssetMetadata(
            id="ea-2",
            asset_type="agent",
            asset_id="a-1",
            encryption_algorithm="AES-GCM-256",
            key_derivation_method="webauthn-prf-hkdf",
            authorized_key_ids=[],
            created_at="2026-03-02T12:00:00Z",
        )
        assert meta.encrypted_by_user_id is None


class TestKeyGatedRetrievalResult:
    """Tests for KeyGatedRetrievalResult Pydantic model."""

    def test_access_denied_no_data(self) -> None:
        access = KeyProtectedAccessResult(
            allowed=False,
            reason="Key assertion required",
            requires_assertion=True,
        )
        result = KeyGatedRetrievalResult(access=access)
        assert result.data is None
        assert result.access.allowed is False

    def test_access_granted_with_data(self) -> None:
        access = KeyProtectedAccessResult(
            allowed=True,
            reason="No key policy exists",
        )
        data = EncryptedAssetResponse(
            id="ea-1",
            asset_type="document",
            asset_id="doc-1",
            encrypted_payload="ct",
            encryption_algorithm="AES-GCM-256",
            key_derivation_method="webauthn-prf-hkdf",
            initialization_vector="iv",
            authorized_key_ids=["k1"],
            created_at="2026-03-02T12:00:00Z",
            updated_at="2026-03-02T12:00:00Z",
        )
        result = KeyGatedRetrievalResult(access=access, data=data)
        assert result.data is not None
        assert result.data.id == "ea-1"
        assert result.access.allowed is True
