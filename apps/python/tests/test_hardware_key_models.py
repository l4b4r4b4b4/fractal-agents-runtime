"""Unit tests for hardware key Pydantic models (server.hardware_key_models).

Covers all model classes with:
- Default instantiation and required fields
- Field validators (device_type, asset_type, encryption_algorithm, etc.)
- Datetime field serializers (ISO 8601 with Z suffix)
- Edge cases (None values, empty lists, boundary values)
- Frozenset constants (ALLOWED_ASSET_TYPES, etc.)

These are pure data models with no external dependencies — all tests
run without database, network, or service mocks.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest
from pydantic import ValidationError

from server.hardware_key_models import (
    ALLOWED_ASSET_TYPES,
    ALLOWED_ENCRYPTION_ALGORITHMS,
    ALLOWED_KEY_DERIVATION_METHODS,
    ALLOWED_PROTECTED_ACTIONS,
    AssertionBeginRequest,
    AssertionBeginResponse,
    AssertionCompleteRequest,
    AssertionStatusResponse,
    EncryptedAssetCreateRequest,
    EncryptedAssetRecord,
    HardwareKeyInfo,
    HardwareKeyRegisterBeginRequest,
    HardwareKeyRegisterBeginResponse,
    HardwareKeyRegisterCompleteRequest,
    HardwareKeyUpdateRequest,
    KeyAssertionRecord,
    KeyPolicyCreateRequest,
    KeyPolicyRecord,
    KeyProtectedAccessCheck,
    KeyProtectedAccessResponse,
)


# ============================================================================
# Fixtures
# ============================================================================

NOW = datetime(2026, 3, 2, 12, 0, 0, tzinfo=timezone.utc)
LATER = datetime(2026, 3, 2, 12, 5, 0, tzinfo=timezone.utc)


# ============================================================================
# Constants
# ============================================================================


class TestAllowedConstants:
    """Verify the frozenset constants contain expected values."""

    def test_allowed_asset_types_contains_expected(self) -> None:
        expected = {
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
        assert ALLOWED_ASSET_TYPES == expected

    def test_allowed_encryption_algorithms(self) -> None:
        expected = {"AES-GCM-256", "AES-CBC-256", "ChaCha20-Poly1305"}
        assert ALLOWED_ENCRYPTION_ALGORITHMS == expected

    def test_allowed_key_derivation_methods(self) -> None:
        expected = {
            "webauthn-prf-hkdf",
            "webauthn-hmac-secret-hkdf",
            "passphrase-pbkdf2",
            "shamir-recombine",
        }
        assert ALLOWED_KEY_DERIVATION_METHODS == expected

    def test_allowed_protected_actions(self) -> None:
        expected = {
            "decrypt",
            "delete",
            "export",
            "share",
            "sign",
            "all_writes",
            "admin",
        }
        assert ALLOWED_PROTECTED_ACTIONS == expected

    def test_constants_are_frozensets(self) -> None:
        assert isinstance(ALLOWED_ASSET_TYPES, frozenset)
        assert isinstance(ALLOWED_ENCRYPTION_ALGORITHMS, frozenset)
        assert isinstance(ALLOWED_KEY_DERIVATION_METHODS, frozenset)
        assert isinstance(ALLOWED_PROTECTED_ACTIONS, frozenset)


# ============================================================================
# HardwareKeyInfo
# ============================================================================


class TestHardwareKeyInfo:
    """Tests for HardwareKeyInfo model."""

    def test_minimal_required_fields(self) -> None:
        info = HardwareKeyInfo(
            id="key-1",
            user_id="user-1",
            credential_id="cred-abc",
            created_at=NOW,
            updated_at=NOW,
        )
        assert info.id == "key-1"
        assert info.user_id == "user-1"
        assert info.credential_id == "cred-abc"
        assert info.friendly_name is None
        assert info.device_type is None
        assert info.transports == []
        assert info.attestation_format is None
        assert info.aaguid is None
        assert info.is_active is True
        assert info.last_used_at is None

    def test_all_fields(self) -> None:
        info = HardwareKeyInfo(
            id="key-2",
            user_id="user-2",
            credential_id="cred-xyz",
            friendly_name="Blue SoloKey",
            device_type="solokey",
            transports=["usb", "nfc"],
            attestation_format="packed",
            aaguid="aaguid-123",
            is_active=False,
            last_used_at=LATER,
            created_at=NOW,
            updated_at=NOW,
        )
        assert info.friendly_name == "Blue SoloKey"
        assert info.device_type == "solokey"
        assert info.transports == ["usb", "nfc"]
        assert info.attestation_format == "packed"
        assert info.is_active is False
        assert info.last_used_at == LATER

    def test_datetime_serializer_utc(self) -> None:
        info = HardwareKeyInfo(
            id="k",
            user_id="u",
            credential_id="c",
            created_at=NOW,
            updated_at=NOW,
            last_used_at=NOW,
        )
        data = info.model_dump()
        assert data["created_at"].endswith("Z")
        assert data["updated_at"].endswith("Z")
        assert data["last_used_at"].endswith("Z")
        assert "+00:00" not in data["created_at"]

    def test_datetime_serializer_none(self) -> None:
        info = HardwareKeyInfo(
            id="k",
            user_id="u",
            credential_id="c",
            created_at=NOW,
            updated_at=NOW,
            last_used_at=None,
        )
        data = info.model_dump()
        assert data["last_used_at"] is None


# ============================================================================
# HardwareKeyRegisterBeginRequest
# ============================================================================


class TestHardwareKeyRegisterBeginRequest:
    """Tests for HardwareKeyRegisterBeginRequest model."""

    def test_default_friendly_name_none(self) -> None:
        req = HardwareKeyRegisterBeginRequest()
        assert req.friendly_name is None

    def test_with_friendly_name(self) -> None:
        req = HardwareKeyRegisterBeginRequest(friendly_name="My YubiKey")
        assert req.friendly_name == "My YubiKey"


# ============================================================================
# HardwareKeyRegisterBeginResponse
# ============================================================================


class TestHardwareKeyRegisterBeginResponse:
    """Tests for HardwareKeyRegisterBeginResponse model."""

    def test_required_fields(self) -> None:
        resp = HardwareKeyRegisterBeginResponse(
            challenge="Y2hhbGxlbmdl",
            rp={"name": "MyApp", "id": "myapp.com"},
            user={"id": "dXNlci0x", "name": "alice", "displayName": "Alice"},
            pub_key_cred_params=[{"type": "public-key", "alg": -7}],
        )
        assert resp.challenge == "Y2hhbGxlbmdl"
        assert resp.rp["id"] == "myapp.com"
        assert resp.timeout == 60000

    def test_defaults(self) -> None:
        resp = HardwareKeyRegisterBeginResponse(
            challenge="c",
            rp={"name": "R", "id": "r.com"},
            user={"id": "u", "name": "a", "displayName": "A"},
            pub_key_cred_params=[],
        )
        assert resp.attestation == "direct"
        assert (
            resp.authenticator_selection["authenticatorAttachment"] == "cross-platform"
        )
        assert resp.authenticator_selection["residentKey"] == "preferred"
        assert resp.authenticator_selection["userVerification"] == "preferred"
        assert "prf" in resp.extensions
        assert resp.exclude_credentials == []

    def test_custom_values(self) -> None:
        resp = HardwareKeyRegisterBeginResponse(
            challenge="c",
            rp={"name": "R", "id": "r.com"},
            user={"id": "u", "name": "a", "displayName": "A"},
            pub_key_cred_params=[{"type": "public-key", "alg": -7}],
            timeout=120000,
            attestation="none",
            exclude_credentials=[{"type": "public-key", "id": "existing-cred"}],
        )
        assert resp.timeout == 120000
        assert resp.attestation == "none"
        assert len(resp.exclude_credentials) == 1


# ============================================================================
# HardwareKeyRegisterCompleteRequest
# ============================================================================


class TestHardwareKeyRegisterCompleteRequest:
    """Tests for HardwareKeyRegisterCompleteRequest + device_type validator."""

    def test_required_fields(self) -> None:
        req = HardwareKeyRegisterCompleteRequest(
            credential_id="cred-abc",
            attestation_object="att-obj",
            client_data_json="cdj",
        )
        assert req.credential_id == "cred-abc"
        assert req.transports == []
        assert req.friendly_name is None
        assert req.device_type is None
        assert req.prf_supported is False

    def test_valid_device_types(self) -> None:
        valid_types = [
            "solokey",
            "yubikey",
            "titan",
            "nitrokey",
            "onlykey",
            "trezor",
            "ledger",
            "platform",
            "other",
        ]
        for device_type in valid_types:
            req = HardwareKeyRegisterCompleteRequest(
                credential_id="c",
                attestation_object="a",
                client_data_json="d",
                device_type=device_type,
            )
            assert req.device_type == device_type

    def test_invalid_device_type_rejected(self) -> None:
        with pytest.raises(ValidationError, match="device_type must be one of"):
            HardwareKeyRegisterCompleteRequest(
                credential_id="c",
                attestation_object="a",
                client_data_json="d",
                device_type="invalid-key-type",
            )

    def test_none_device_type_accepted(self) -> None:
        req = HardwareKeyRegisterCompleteRequest(
            credential_id="c",
            attestation_object="a",
            client_data_json="d",
            device_type=None,
        )
        assert req.device_type is None

    def test_prf_supported_flag(self) -> None:
        req = HardwareKeyRegisterCompleteRequest(
            credential_id="c",
            attestation_object="a",
            client_data_json="d",
            prf_supported=True,
        )
        assert req.prf_supported is True


# ============================================================================
# HardwareKeyUpdateRequest
# ============================================================================


class TestHardwareKeyUpdateRequest:
    """Tests for HardwareKeyUpdateRequest model."""

    def test_default_none(self) -> None:
        req = HardwareKeyUpdateRequest()
        assert req.friendly_name is None

    def test_with_name(self) -> None:
        req = HardwareKeyUpdateRequest(friendly_name="Renamed Key")
        assert req.friendly_name == "Renamed Key"


# ============================================================================
# AssertionBeginRequest
# ============================================================================


class TestAssertionBeginRequest:
    """Tests for AssertionBeginRequest + asset_type validator."""

    def test_defaults_are_none(self) -> None:
        req = AssertionBeginRequest()
        assert req.asset_type is None
        assert req.asset_id is None

    def test_valid_asset_types(self) -> None:
        for asset_type in ALLOWED_ASSET_TYPES:
            req = AssertionBeginRequest(asset_type=asset_type, asset_id="id-1")
            assert req.asset_type == asset_type

    def test_invalid_asset_type_rejected(self) -> None:
        with pytest.raises(ValidationError, match="asset_type must be one of"):
            AssertionBeginRequest(asset_type="unknown_type")

    def test_none_asset_type_accepted(self) -> None:
        req = AssertionBeginRequest(asset_type=None)
        assert req.asset_type is None


# ============================================================================
# AssertionBeginResponse
# ============================================================================


class TestAssertionBeginResponse:
    """Tests for AssertionBeginResponse model."""

    def test_required_fields(self) -> None:
        resp = AssertionBeginResponse(
            challenge="Y2hhbGxlbmdl",
            rp_id="myapp.com",
        )
        assert resp.challenge == "Y2hhbGxlbmdl"
        assert resp.rp_id == "myapp.com"
        assert resp.timeout == 60000
        assert resp.allow_credentials == []
        assert resp.user_verification == "preferred"
        assert resp.asset_type is None
        assert resp.asset_id is None

    def test_extensions_default_has_prf(self) -> None:
        resp = AssertionBeginResponse(challenge="c", rp_id="r")
        assert "prf" in resp.extensions
        assert "eval" in resp.extensions["prf"]

    def test_with_asset_scope(self) -> None:
        resp = AssertionBeginResponse(
            challenge="c",
            rp_id="r",
            asset_type="document",
            asset_id="doc-42",
        )
        assert resp.asset_type == "document"
        assert resp.asset_id == "doc-42"


# ============================================================================
# AssertionCompleteRequest
# ============================================================================


class TestAssertionCompleteRequest:
    """Tests for AssertionCompleteRequest + asset_type validator."""

    def test_required_fields(self) -> None:
        req = AssertionCompleteRequest(
            credential_id="cred-1",
            authenticator_data="auth-data",
            client_data_json="cdj",
            signature="sig-xyz",
            challenge="challenge-abc",
        )
        assert req.credential_id == "cred-1"
        assert req.signature == "sig-xyz"
        assert req.asset_type is None
        assert req.asset_id is None

    def test_valid_asset_type(self) -> None:
        req = AssertionCompleteRequest(
            credential_id="c",
            authenticator_data="a",
            client_data_json="d",
            signature="s",
            challenge="ch",
            asset_type="chat_session",
            asset_id="sess-1",
        )
        assert req.asset_type == "chat_session"

    def test_invalid_asset_type_rejected(self) -> None:
        with pytest.raises(ValidationError, match="asset_type must be one of"):
            AssertionCompleteRequest(
                credential_id="c",
                authenticator_data="a",
                client_data_json="d",
                signature="s",
                challenge="ch",
                asset_type="bad_type",
            )


# ============================================================================
# KeyAssertionRecord
# ============================================================================


class TestKeyAssertionRecord:
    """Tests for KeyAssertionRecord model + datetime serializer."""

    def test_required_fields(self) -> None:
        record = KeyAssertionRecord(
            id="assertion-1",
            user_id="user-1",
            hardware_key_id="key-1",
            challenge="ch",
            verified_at=NOW,
            expires_at=LATER,
        )
        assert record.id == "assertion-1"
        assert record.asset_type is None
        assert record.asset_id is None
        assert record.consumed is False
        assert record.consumed_at is None

    def test_datetime_serializer(self) -> None:
        record = KeyAssertionRecord(
            id="a",
            user_id="u",
            hardware_key_id="k",
            challenge="c",
            verified_at=NOW,
            expires_at=LATER,
            consumed=True,
            consumed_at=NOW,
        )
        data = record.model_dump()
        assert data["verified_at"].endswith("Z")
        assert data["expires_at"].endswith("Z")
        assert data["consumed_at"].endswith("Z")

    def test_datetime_serializer_none_consumed_at(self) -> None:
        record = KeyAssertionRecord(
            id="a",
            user_id="u",
            hardware_key_id="k",
            challenge="c",
            verified_at=NOW,
            expires_at=LATER,
        )
        data = record.model_dump()
        assert data["consumed_at"] is None

    def test_with_asset_scope(self) -> None:
        record = KeyAssertionRecord(
            id="a",
            user_id="u",
            hardware_key_id="k",
            challenge="c",
            verified_at=NOW,
            expires_at=LATER,
            asset_type="document",
            asset_id="doc-1",
        )
        assert record.asset_type == "document"
        assert record.asset_id == "doc-1"


# ============================================================================
# AssertionStatusResponse
# ============================================================================


class TestAssertionStatusResponse:
    """Tests for AssertionStatusResponse model + datetime serializer."""

    def test_minimal(self) -> None:
        resp = AssertionStatusResponse(
            has_valid_assertion=False,
            is_satisfied=False,
        )
        assert resp.has_valid_assertion is False
        assert resp.assertion_id is None
        assert resp.expires_at is None
        assert resp.required_key_count == 1
        assert resp.current_assertion_count == 0
        assert resp.is_satisfied is False

    def test_with_valid_assertion(self) -> None:
        resp = AssertionStatusResponse(
            has_valid_assertion=True,
            assertion_id="a-1",
            expires_at=LATER,
            required_key_count=2,
            current_assertion_count=2,
            is_satisfied=True,
        )
        assert resp.has_valid_assertion is True
        assert resp.assertion_id == "a-1"
        assert resp.required_key_count == 2
        assert resp.is_satisfied is True

    def test_datetime_serializer(self) -> None:
        resp = AssertionStatusResponse(
            has_valid_assertion=True,
            expires_at=NOW,
            is_satisfied=True,
        )
        data = resp.model_dump()
        assert data["expires_at"].endswith("Z")
        assert "+00:00" not in data["expires_at"]

    def test_datetime_serializer_none(self) -> None:
        resp = AssertionStatusResponse(
            has_valid_assertion=False,
            expires_at=None,
            is_satisfied=False,
        )
        data = resp.model_dump()
        assert data["expires_at"] is None


# ============================================================================
# EncryptedAssetCreateRequest
# ============================================================================


class TestEncryptedAssetCreateRequest:
    """Tests for EncryptedAssetCreateRequest + all 3 validators."""

    def _valid_request(self, **overrides: object) -> EncryptedAssetCreateRequest:
        defaults = {
            "asset_type": "document",
            "asset_id": "doc-1",
            "encrypted_payload": "base64-ciphertext",
            "initialization_vector": "base64-iv",
            "authorized_key_ids": ["key-1"],
        }
        defaults.update(overrides)
        return EncryptedAssetCreateRequest(**defaults)

    def test_defaults(self) -> None:
        req = self._valid_request()
        assert req.encryption_algorithm == "AES-GCM-256"
        assert req.key_derivation_method == "webauthn-prf-hkdf"

    def test_all_valid_asset_types(self) -> None:
        for asset_type in ALLOWED_ASSET_TYPES:
            req = self._valid_request(asset_type=asset_type)
            assert req.asset_type == asset_type

    def test_invalid_asset_type(self) -> None:
        with pytest.raises(ValidationError, match="asset_type must be one of"):
            self._valid_request(asset_type="invalid")

    def test_all_valid_encryption_algorithms(self) -> None:
        for algorithm in ALLOWED_ENCRYPTION_ALGORITHMS:
            req = self._valid_request(encryption_algorithm=algorithm)
            assert req.encryption_algorithm == algorithm

    def test_invalid_encryption_algorithm(self) -> None:
        with pytest.raises(
            ValidationError, match="encryption_algorithm must be one of"
        ):
            self._valid_request(encryption_algorithm="ROT13")

    def test_all_valid_key_derivation_methods(self) -> None:
        for method in ALLOWED_KEY_DERIVATION_METHODS:
            req = self._valid_request(key_derivation_method=method)
            assert req.key_derivation_method == method

    def test_invalid_key_derivation_method(self) -> None:
        with pytest.raises(
            ValidationError, match="key_derivation_method must be one of"
        ):
            self._valid_request(key_derivation_method="plaintext")

    def test_authorized_key_ids_min_length(self) -> None:
        with pytest.raises(ValidationError):
            self._valid_request(authorized_key_ids=[])

    def test_multiple_authorized_keys(self) -> None:
        req = self._valid_request(authorized_key_ids=["k1", "k2", "k3"])
        assert len(req.authorized_key_ids) == 3


# ============================================================================
# EncryptedAssetRecord
# ============================================================================


class TestEncryptedAssetRecord:
    """Tests for EncryptedAssetRecord model + datetime serializer."""

    def test_all_fields(self) -> None:
        record = EncryptedAssetRecord(
            id="ea-1",
            asset_type="document",
            asset_id="doc-1",
            encrypted_payload="ciphertext",
            encryption_algorithm="AES-GCM-256",
            key_derivation_method="webauthn-prf-hkdf",
            initialization_vector="iv-data",
            authorized_key_ids=["key-1", "key-2"],
            encrypted_by_user_id="user-1",
            created_at=NOW,
            updated_at=NOW,
        )
        assert record.id == "ea-1"
        assert record.encrypted_by_user_id == "user-1"
        assert len(record.authorized_key_ids) == 2

    def test_encrypted_by_user_id_optional(self) -> None:
        record = EncryptedAssetRecord(
            id="ea-2",
            asset_type="project",
            asset_id="p-1",
            encrypted_payload="ct",
            encryption_algorithm="AES-CBC-256",
            key_derivation_method="shamir-recombine",
            initialization_vector="iv",
            authorized_key_ids=["k1"],
            created_at=NOW,
            updated_at=NOW,
        )
        assert record.encrypted_by_user_id is None

    def test_datetime_serializer(self) -> None:
        record = EncryptedAssetRecord(
            id="ea-3",
            asset_type="agent",
            asset_id="a-1",
            encrypted_payload="ct",
            encryption_algorithm="ChaCha20-Poly1305",
            key_derivation_method="passphrase-pbkdf2",
            initialization_vector="iv",
            authorized_key_ids=["k1"],
            created_at=NOW,
            updated_at=LATER,
        )
        data = record.model_dump()
        assert data["created_at"].endswith("Z")
        assert data["updated_at"].endswith("Z")
        assert "+00:00" not in data["created_at"]


# ============================================================================
# KeyPolicyCreateRequest
# ============================================================================


class TestKeyPolicyCreateRequest:
    """Tests for KeyPolicyCreateRequest + asset_type and protected_action validators."""

    def _valid_request(self, **overrides: object) -> KeyPolicyCreateRequest:
        defaults = {
            "asset_type": "document",
            "asset_id": "doc-1",
            "protected_action": "decrypt",
        }
        defaults.update(overrides)
        return KeyPolicyCreateRequest(**defaults)

    def test_defaults(self) -> None:
        req = self._valid_request()
        assert req.required_key_count == 1
        assert req.required_key_ids is None

    def test_all_valid_asset_types(self) -> None:
        for asset_type in ALLOWED_ASSET_TYPES:
            req = self._valid_request(asset_type=asset_type)
            assert req.asset_type == asset_type

    def test_invalid_asset_type(self) -> None:
        with pytest.raises(ValidationError, match="asset_type must be one of"):
            self._valid_request(asset_type="invalid_type")

    def test_all_valid_protected_actions(self) -> None:
        for action in ALLOWED_PROTECTED_ACTIONS:
            req = self._valid_request(protected_action=action)
            assert req.protected_action == action

    def test_invalid_protected_action(self) -> None:
        with pytest.raises(ValidationError, match="protected_action must be one of"):
            self._valid_request(protected_action="hack")

    def test_multi_key_requirement(self) -> None:
        req = self._valid_request(required_key_count=3)
        assert req.required_key_count == 3

    def test_required_key_count_minimum_1(self) -> None:
        with pytest.raises(ValidationError):
            self._valid_request(required_key_count=0)

    def test_specific_required_key_ids(self) -> None:
        req = self._valid_request(required_key_ids=["key-a", "key-b"])
        assert req.required_key_ids == ["key-a", "key-b"]


# ============================================================================
# KeyPolicyRecord
# ============================================================================


class TestKeyPolicyRecord:
    """Tests for KeyPolicyRecord model + datetime serializer."""

    def test_all_fields(self) -> None:
        record = KeyPolicyRecord(
            id="pol-1",
            asset_type="chat_session",
            asset_id="cs-1",
            protected_action="decrypt",
            required_key_count=2,
            required_key_ids=["k1", "k2"],
            created_by_user_id="user-1",
            created_at=NOW,
            updated_at=NOW,
        )
        assert record.id == "pol-1"
        assert record.required_key_count == 2
        assert record.created_by_user_id == "user-1"

    def test_optional_fields_default_none(self) -> None:
        record = KeyPolicyRecord(
            id="pol-2",
            asset_type="document",
            asset_id="d-1",
            protected_action="delete",
            required_key_count=1,
            created_at=NOW,
            updated_at=NOW,
        )
        assert record.required_key_ids is None
        assert record.created_by_user_id is None

    def test_datetime_serializer(self) -> None:
        record = KeyPolicyRecord(
            id="pol-3",
            asset_type="project",
            asset_id="p-1",
            protected_action="export",
            required_key_count=1,
            created_at=NOW,
            updated_at=LATER,
        )
        data = record.model_dump()
        assert data["created_at"].endswith("Z")
        assert data["updated_at"].endswith("Z")


# ============================================================================
# KeyProtectedAccessCheck
# ============================================================================


class TestKeyProtectedAccessCheck:
    """Tests for KeyProtectedAccessCheck + both validators."""

    def test_default_action(self) -> None:
        check = KeyProtectedAccessCheck(
            asset_type="document",
            asset_id="doc-1",
        )
        assert check.action == "decrypt"

    def test_all_valid_asset_types(self) -> None:
        for asset_type in ALLOWED_ASSET_TYPES:
            check = KeyProtectedAccessCheck(
                asset_type=asset_type,
                asset_id="id-1",
            )
            assert check.asset_type == asset_type

    def test_invalid_asset_type(self) -> None:
        with pytest.raises(ValidationError, match="asset_type must be one of"):
            KeyProtectedAccessCheck(
                asset_type="bad",
                asset_id="id-1",
            )

    def test_all_valid_actions(self) -> None:
        for action in ALLOWED_PROTECTED_ACTIONS:
            check = KeyProtectedAccessCheck(
                asset_type="document",
                asset_id="id-1",
                action=action,
            )
            assert check.action == action

    def test_invalid_action(self) -> None:
        with pytest.raises(ValidationError, match="action must be one of"):
            KeyProtectedAccessCheck(
                asset_type="document",
                asset_id="id-1",
                action="destroy",
            )


# ============================================================================
# KeyProtectedAccessResponse
# ============================================================================


class TestKeyProtectedAccessResponse:
    """Tests for KeyProtectedAccessResponse model."""

    def test_minimal(self) -> None:
        resp = KeyProtectedAccessResponse(
            has_access=False,
            requires_key=True,
        )
        assert resp.has_access is False
        assert resp.requires_key is True
        assert resp.policy is None
        assert resp.assertion_status is None

    def test_with_nested_models(self) -> None:
        policy = KeyPolicyRecord(
            id="pol-1",
            asset_type="document",
            asset_id="doc-1",
            protected_action="decrypt",
            required_key_count=1,
            created_at=NOW,
            updated_at=NOW,
        )
        assertion_status = AssertionStatusResponse(
            has_valid_assertion=True,
            assertion_id="a-1",
            expires_at=LATER,
            is_satisfied=True,
        )
        resp = KeyProtectedAccessResponse(
            has_access=True,
            requires_key=True,
            policy=policy,
            assertion_status=assertion_status,
        )
        assert resp.policy is not None
        assert resp.policy.id == "pol-1"
        assert resp.assertion_status is not None
        assert resp.assertion_status.is_satisfied is True

    def test_no_key_required(self) -> None:
        resp = KeyProtectedAccessResponse(
            has_access=True,
            requires_key=False,
        )
        assert resp.has_access is True
        assert resp.requires_key is False
        assert resp.policy is None
        assert resp.assertion_status is None


# ============================================================================
# Serialization round-trip
# ============================================================================


class TestModelSerialization:
    """Test model_dump / model_validate round-trips."""

    def test_hardware_key_info_round_trip(self) -> None:
        info = HardwareKeyInfo(
            id="k",
            user_id="u",
            credential_id="c",
            friendly_name="Test",
            device_type="yubikey",
            transports=["usb"],
            attestation_format="packed",
            aaguid="aag",
            is_active=True,
            last_used_at=NOW,
            created_at=NOW,
            updated_at=NOW,
        )
        data = info.model_dump()
        assert isinstance(data, dict)
        assert data["id"] == "k"
        assert data["transports"] == ["usb"]

    def test_encrypted_asset_create_round_trip(self) -> None:
        req = EncryptedAssetCreateRequest(
            asset_type="repository",
            asset_id="repo-1",
            encrypted_payload="payload",
            initialization_vector="iv",
            authorized_key_ids=["k1"],
            encryption_algorithm="ChaCha20-Poly1305",
            key_derivation_method="shamir-recombine",
        )
        data = req.model_dump()
        assert data["encryption_algorithm"] == "ChaCha20-Poly1305"
        assert data["key_derivation_method"] == "shamir-recombine"

    def test_access_response_with_nested_serialization(self) -> None:
        policy = KeyPolicyRecord(
            id="p",
            asset_type="agent",
            asset_id="a",
            protected_action="admin",
            required_key_count=2,
            required_key_ids=["k1", "k2"],
            created_by_user_id="u",
            created_at=NOW,
            updated_at=NOW,
        )
        status = AssertionStatusResponse(
            has_valid_assertion=True,
            assertion_id="as-1",
            expires_at=LATER,
            required_key_count=2,
            current_assertion_count=1,
            is_satisfied=False,
        )
        resp = KeyProtectedAccessResponse(
            has_access=False,
            requires_key=True,
            policy=policy,
            assertion_status=status,
        )
        data = resp.model_dump()
        assert data["policy"]["required_key_count"] == 2
        assert data["assertion_status"]["current_assertion_count"] == 1
        assert data["assertion_status"]["is_satisfied"] is False
