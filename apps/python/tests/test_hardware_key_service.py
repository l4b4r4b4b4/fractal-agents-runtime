"""Unit tests for hardware key service pure functions (server.hardware_key_service).

Covers all non-async, non-database code:
- Exception classes and their attributes (message, status_code, custom fields)
- ``_format_timestamp()`` — datetime/string/None conversion
- ``_row_to_hardware_key_response()`` — dict → HardwareKeyResponse
- ``_row_to_assertion_response()`` — dict → AssertionResponse
- ``_row_to_policy_response()`` — dict → AssetKeyPolicyResponse
- ``_validate_device_type()`` — enum validation
- ``_validate_asset_type()`` — enum validation
- ``_validate_protected_action()`` — enum validation
- ``_validate_asset_scope()`` — paired NULL/NOT NULL validation
- Pydantic request/response models — instantiation and defaults
- Constants — VALID_DEVICE_TYPES, VALID_ASSET_TYPES, VALID_PROTECTED_ACTIONS

These are pure functions with no external dependencies — all tests run
without database, network, or service mocks.
"""

from __future__ import annotations

from datetime import datetime, timezone
from uuid import uuid4

import pytest

from server.hardware_key_service import (
    VALID_ASSET_TYPES,
    VALID_DEVICE_TYPES,
    VALID_PROTECTED_ACTIONS,
    AssertionConsumedError,
    AssertionExpiredError,
    AssertionNotFoundError,
    AssertionRecord,
    AssertionResponse,
    AssetKeyPolicyCreate,
    AssetKeyPolicyResponse,
    HardwareKeyConflictError,
    HardwareKeyError,
    HardwareKeyInactiveError,
    HardwareKeyNotFoundError,
    HardwareKeyRegistration,
    HardwareKeyResponse,
    HardwareKeyUpdate,
    InvalidInputError,
    KeyProtectedAccessResult,
    PolicyConflictError,
    _format_timestamp,
    _row_to_assertion_response,
    _row_to_hardware_key_response,
    _row_to_policy_response,
    _validate_asset_scope,
    _validate_asset_type,
    _validate_device_type,
    _validate_protected_action,
)


# ============================================================================
# Fixtures
# ============================================================================

NOW = datetime(2026, 3, 2, 12, 0, 0, tzinfo=timezone.utc)
LATER = datetime(2026, 3, 2, 12, 5, 0, tzinfo=timezone.utc)


def _make_key_row(**overrides: object) -> dict:
    """Build a minimal hardware_keys row dict."""
    row = {
        "id": uuid4(),
        "credential_id": "cred-abc123",
        "friendly_name": "My SoloKey",
        "device_type": "solokey",
        "transports": ["usb", "nfc"],
        "attestation_format": "packed",
        "aaguid": "aaguid-xyz",
        "is_active": True,
        "last_used_at": NOW,
        "created_at": NOW,
        "updated_at": NOW,
    }
    row.update(overrides)
    return row


def _make_assertion_row(**overrides: object) -> dict:
    """Build a minimal key_assertions row dict."""
    row = {
        "id": uuid4(),
        "hardware_key_id": uuid4(),
        "expires_at": LATER,
        "consumed": False,
        "asset_type": None,
        "asset_id": None,
    }
    row.update(overrides)
    return row


def _make_policy_row(**overrides: object) -> dict:
    """Build a minimal asset_key_policies row dict."""
    row = {
        "id": uuid4(),
        "asset_type": "document",
        "asset_id": uuid4(),
        "protected_action": "decrypt",
        "required_key_count": 1,
        "required_key_ids": None,
        "created_by_user_id": None,
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

    def test_valid_device_types(self) -> None:
        expected = {
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
        assert VALID_DEVICE_TYPES == expected

    def test_valid_asset_types(self) -> None:
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
        assert VALID_ASSET_TYPES == expected

    def test_valid_protected_actions(self) -> None:
        expected = {
            "decrypt",
            "delete",
            "export",
            "share",
            "sign",
            "all_writes",
            "admin",
        }
        assert VALID_PROTECTED_ACTIONS == expected


# ============================================================================
# Exception Classes
# ============================================================================


class TestHardwareKeyError:
    """Tests for HardwareKeyError base exception."""

    def test_message_and_status_code(self) -> None:
        error = HardwareKeyError("something broke", status_code=500)
        assert error.message == "something broke"
        assert error.status_code == 500
        assert str(error) == "something broke"

    def test_default_status_code_is_400(self) -> None:
        error = HardwareKeyError("bad request")
        assert error.status_code == 400

    def test_is_exception(self) -> None:
        error = HardwareKeyError("test")
        assert isinstance(error, Exception)


class TestHardwareKeyNotFoundError:
    """Tests for HardwareKeyNotFoundError."""

    def test_message_includes_key_id(self) -> None:
        error = HardwareKeyNotFoundError("key-42")
        assert "key-42" in error.message
        assert error.key_id == "key-42"
        assert error.status_code == 404

    def test_inherits_from_base(self) -> None:
        error = HardwareKeyNotFoundError("k")
        assert isinstance(error, HardwareKeyError)


class TestHardwareKeyConflictError:
    """Tests for HardwareKeyConflictError."""

    def test_message_includes_credential_id(self) -> None:
        error = HardwareKeyConflictError("cred-xyz")
        assert "cred-xyz" in error.message
        assert error.credential_id == "cred-xyz"
        assert error.status_code == 409


class TestHardwareKeyInactiveError:
    """Tests for HardwareKeyInactiveError."""

    def test_message_includes_key_id(self) -> None:
        error = HardwareKeyInactiveError("key-99")
        assert "key-99" in error.message
        assert error.status_code == 409


class TestAssertionNotFoundError:
    """Tests for AssertionNotFoundError."""

    def test_message_includes_assertion_id(self) -> None:
        error = AssertionNotFoundError("assert-1")
        assert "assert-1" in error.message
        assert error.assertion_id == "assert-1"
        assert error.status_code == 404


class TestAssertionExpiredError:
    """Tests for AssertionExpiredError."""

    def test_message_includes_assertion_id(self) -> None:
        error = AssertionExpiredError("assert-2")
        assert "assert-2" in error.message
        assert error.assertion_id == "assert-2"
        assert error.status_code == 410


class TestAssertionConsumedError:
    """Tests for AssertionConsumedError."""

    def test_message_includes_assertion_id(self) -> None:
        error = AssertionConsumedError("assert-3")
        assert "assert-3" in error.message
        assert error.assertion_id == "assert-3"
        assert error.status_code == 410

    def test_message_says_already_consumed(self) -> None:
        error = AssertionConsumedError("x")
        assert "already consumed" in error.message


class TestPolicyConflictError:
    """Tests for PolicyConflictError."""

    def test_attributes(self) -> None:
        error = PolicyConflictError("document", "doc-1", "decrypt")
        assert error.asset_type == "document"
        assert error.asset_id == "doc-1"
        assert error.protected_action == "decrypt"
        assert error.status_code == 409

    def test_message_includes_all_fields(self) -> None:
        error = PolicyConflictError("project", "p-2", "export")
        assert "project" in error.message
        assert "p-2" in error.message
        assert "export" in error.message


class TestInvalidInputError:
    """Tests for InvalidInputError."""

    def test_message_and_status_code(self) -> None:
        error = InvalidInputError("field X is invalid")
        assert error.message == "field X is invalid"
        assert error.status_code == 400

    def test_inherits_from_base(self) -> None:
        error = InvalidInputError("bad")
        assert isinstance(error, HardwareKeyError)


# ============================================================================
# _format_timestamp
# ============================================================================


class TestFormatTimestamp:
    """Tests for ``_format_timestamp()``."""

    def test_none_returns_none(self) -> None:
        assert _format_timestamp(None) is None

    def test_datetime_utc_z_suffix(self) -> None:
        result = _format_timestamp(NOW)
        assert result is not None
        assert result.endswith("Z")
        assert "+00:00" not in result

    def test_datetime_with_utc_offset(self) -> None:
        dt_with_offset = datetime(2026, 1, 1, 0, 0, 0, tzinfo=timezone.utc)
        result = _format_timestamp(dt_with_offset)
        assert result is not None
        assert result.endswith("Z")

    def test_string_passthrough(self) -> None:
        result = _format_timestamp("2026-03-02T12:00:00Z")
        assert result == "2026-03-02T12:00:00Z"

    def test_non_datetime_non_string_converted(self) -> None:
        result = _format_timestamp(12345)
        assert result == "12345"

    def test_naive_datetime(self) -> None:
        naive = datetime(2026, 6, 15, 10, 30, 0)
        result = _format_timestamp(naive)
        assert result is not None
        # Naive datetime has no +00:00, so Z replacement is a no-op
        assert "2026-06-15" in result


# ============================================================================
# _row_to_hardware_key_response
# ============================================================================


class TestRowToHardwareKeyResponse:
    """Tests for ``_row_to_hardware_key_response()``."""

    def test_full_row(self) -> None:
        row = _make_key_row()
        response = _row_to_hardware_key_response(row)
        assert isinstance(response, HardwareKeyResponse)
        assert response.id == str(row["id"])
        assert response.credential_id == "cred-abc123"
        assert response.friendly_name == "My SoloKey"
        assert response.device_type == "solokey"
        assert response.transports == ["usb", "nfc"]
        assert response.attestation_format == "packed"
        assert response.aaguid == "aaguid-xyz"
        assert response.is_active is True

    def test_optional_fields_missing(self) -> None:
        row = _make_key_row(
            friendly_name=None,
            device_type=None,
            attestation_format=None,
            aaguid=None,
            last_used_at=None,
        )
        # Remove optional keys to test .get() fallback
        del row["friendly_name"]
        del row["device_type"]
        del row["attestation_format"]
        del row["aaguid"]
        del row["last_used_at"]
        response = _row_to_hardware_key_response(row)
        assert response.friendly_name is None
        assert response.device_type is None
        assert response.attestation_format is None
        assert response.aaguid is None
        assert response.last_used_at is None

    def test_none_transports_becomes_empty_list(self) -> None:
        row = _make_key_row(transports=None)
        del row["transports"]
        response = _row_to_hardware_key_response(row)
        assert response.transports == []

    def test_is_active_default_true(self) -> None:
        row = _make_key_row()
        del row["is_active"]
        response = _row_to_hardware_key_response(row)
        assert response.is_active is True

    def test_timestamp_fields_formatted(self) -> None:
        row = _make_key_row()
        response = _row_to_hardware_key_response(row)
        assert response.created_at is not None
        assert "Z" in response.created_at
        assert response.updated_at is not None
        assert response.last_used_at is not None


# ============================================================================
# _row_to_assertion_response
# ============================================================================


class TestRowToAssertionResponse:
    """Tests for ``_row_to_assertion_response()``."""

    def test_full_row(self) -> None:
        row = _make_assertion_row(
            asset_type="document",
            asset_id=uuid4(),
        )
        response = _row_to_assertion_response(row)
        assert isinstance(response, AssertionResponse)
        assert response.assertion_id == str(row["id"])
        assert response.hardware_key_id == str(row["hardware_key_id"])
        assert response.consumed is False
        assert response.asset_type == "document"
        assert response.asset_id == str(row["asset_id"])

    def test_null_asset_scope(self) -> None:
        row = _make_assertion_row(asset_type=None, asset_id=None)
        response = _row_to_assertion_response(row)
        assert response.asset_type is None
        assert response.asset_id is None

    def test_consumed_true(self) -> None:
        row = _make_assertion_row(consumed=True)
        response = _row_to_assertion_response(row)
        assert response.consumed is True

    def test_consumed_default_false(self) -> None:
        row = _make_assertion_row()
        del row["consumed"]
        response = _row_to_assertion_response(row)
        assert response.consumed is False

    def test_expires_at_formatted(self) -> None:
        row = _make_assertion_row()
        response = _row_to_assertion_response(row)
        assert response.expires_at is not None
        assert "Z" in response.expires_at


# ============================================================================
# _row_to_policy_response
# ============================================================================


class TestRowToPolicyResponse:
    """Tests for ``_row_to_policy_response()``."""

    def test_full_row(self) -> None:
        user_id = uuid4()
        row = _make_policy_row(
            required_key_count=2,
            required_key_ids=[uuid4(), uuid4()],
            created_by_user_id=user_id,
        )
        response = _row_to_policy_response(row)
        assert isinstance(response, AssetKeyPolicyResponse)
        assert response.id == str(row["id"])
        assert response.asset_type == "document"
        assert response.protected_action == "decrypt"
        assert response.required_key_count == 2
        assert len(response.required_key_ids) == 2
        assert response.created_by_user_id == str(user_id)

    def test_null_required_key_ids(self) -> None:
        row = _make_policy_row(required_key_ids=None)
        response = _row_to_policy_response(row)
        assert response.required_key_ids is None

    def test_empty_required_key_ids(self) -> None:
        row = _make_policy_row(required_key_ids=[])
        response = _row_to_policy_response(row)
        # Empty list treated as None (falsy)
        assert response.required_key_ids is None

    def test_null_created_by_user_id(self) -> None:
        row = _make_policy_row(created_by_user_id=None)
        response = _row_to_policy_response(row)
        assert response.created_by_user_id is None

    def test_missing_created_by_user_id(self) -> None:
        row = _make_policy_row()
        del row["created_by_user_id"]
        response = _row_to_policy_response(row)
        assert response.created_by_user_id is None

    def test_timestamps_formatted(self) -> None:
        row = _make_policy_row()
        response = _row_to_policy_response(row)
        assert "Z" in response.created_at
        assert "Z" in response.updated_at

    def test_key_ids_converted_to_strings(self) -> None:
        kid1 = uuid4()
        kid2 = uuid4()
        row = _make_policy_row(required_key_ids=[kid1, kid2])
        response = _row_to_policy_response(row)
        assert response.required_key_ids == [str(kid1), str(kid2)]


# ============================================================================
# Validation Helpers
# ============================================================================


class TestValidateDeviceType:
    """Tests for ``_validate_device_type()``."""

    def test_none_accepted(self) -> None:
        _validate_device_type(None)  # Should not raise

    def test_all_valid_types(self) -> None:
        for device_type in VALID_DEVICE_TYPES:
            _validate_device_type(device_type)  # Should not raise

    def test_invalid_type_raises(self) -> None:
        with pytest.raises(InvalidInputError, match="Invalid device_type"):
            _validate_device_type("fakekey")

    def test_error_message_lists_allowed(self) -> None:
        with pytest.raises(InvalidInputError, match="Allowed:"):
            _validate_device_type("bad")


class TestValidateAssetType:
    """Tests for ``_validate_asset_type()``."""

    def test_all_valid_types(self) -> None:
        for asset_type in VALID_ASSET_TYPES:
            _validate_asset_type(asset_type)  # Should not raise

    def test_invalid_type_raises(self) -> None:
        with pytest.raises(InvalidInputError, match="Invalid asset_type"):
            _validate_asset_type("nonexistent")

    def test_error_message_lists_allowed(self) -> None:
        with pytest.raises(InvalidInputError, match="Allowed:"):
            _validate_asset_type("bad")


class TestValidateProtectedAction:
    """Tests for ``_validate_protected_action()``."""

    def test_all_valid_actions(self) -> None:
        for action in VALID_PROTECTED_ACTIONS:
            _validate_protected_action(action)  # Should not raise

    def test_invalid_action_raises(self) -> None:
        with pytest.raises(InvalidInputError, match="Invalid protected_action"):
            _validate_protected_action("destroy")

    def test_error_message_lists_allowed(self) -> None:
        with pytest.raises(InvalidInputError, match="Allowed:"):
            _validate_protected_action("hack")


class TestValidateAssetScope:
    """Tests for ``_validate_asset_scope()``."""

    def test_both_none_accepted(self) -> None:
        _validate_asset_scope(None, None)  # Should not raise

    def test_both_set_with_valid_type(self) -> None:
        _validate_asset_scope("document", "doc-1")  # Should not raise

    def test_type_set_id_none_raises(self) -> None:
        with pytest.raises(InvalidInputError, match="both be provided or both be null"):
            _validate_asset_scope("document", None)

    def test_type_none_id_set_raises(self) -> None:
        with pytest.raises(InvalidInputError, match="both be provided or both be null"):
            _validate_asset_scope(None, "doc-1")

    def test_both_set_with_invalid_type_raises(self) -> None:
        with pytest.raises(InvalidInputError, match="Invalid asset_type"):
            _validate_asset_scope("invalid_type", "id-1")

    def test_all_valid_asset_types_in_scope(self) -> None:
        for asset_type in VALID_ASSET_TYPES:
            _validate_asset_scope(asset_type, "some-id")  # Should not raise


# ============================================================================
# Pydantic Request Models
# ============================================================================


class TestHardwareKeyRegistration:
    """Tests for HardwareKeyRegistration Pydantic model."""

    def test_required_fields(self) -> None:
        reg = HardwareKeyRegistration(
            credential_id="cred-1",
            public_key="pk-base64",
        )
        assert reg.credential_id == "cred-1"
        assert reg.public_key == "pk-base64"
        assert reg.counter == 0
        assert reg.transports == []
        assert reg.friendly_name is None

    def test_all_fields(self) -> None:
        reg = HardwareKeyRegistration(
            credential_id="cred-2",
            public_key="pk",
            counter=42,
            transports=["usb", "ble"],
            friendly_name="Test Key",
            device_type="yubikey",
            attestation_format="tpm",
            aaguid="aag-1",
        )
        assert reg.counter == 42
        assert reg.transports == ["usb", "ble"]
        assert reg.device_type == "yubikey"


class TestHardwareKeyUpdate:
    """Tests for HardwareKeyUpdate Pydantic model."""

    def test_defaults(self) -> None:
        update = HardwareKeyUpdate()
        assert update.friendly_name is None
        assert update.device_type is None

    def test_with_values(self) -> None:
        update = HardwareKeyUpdate(
            friendly_name="Renamed",
            device_type="yubikey",
        )
        assert update.friendly_name == "Renamed"
        assert update.device_type == "yubikey"


class TestAssertionRecord:
    """Tests for AssertionRecord Pydantic model."""

    def test_required_fields(self) -> None:
        record = AssertionRecord(
            hardware_key_id="key-1",
            challenge="ch-base64",
        )
        assert record.hardware_key_id == "key-1"
        assert record.challenge == "ch-base64"
        assert record.asset_type is None
        assert record.asset_id is None

    def test_with_scope(self) -> None:
        record = AssertionRecord(
            hardware_key_id="key-2",
            challenge="ch",
            asset_type="project",
            asset_id="proj-1",
        )
        assert record.asset_type == "project"
        assert record.asset_id == "proj-1"


class TestAssetKeyPolicyCreate:
    """Tests for AssetKeyPolicyCreate Pydantic model."""

    def test_required_fields(self) -> None:
        policy = AssetKeyPolicyCreate(
            asset_type="document",
            asset_id="doc-1",
            protected_action="decrypt",
        )
        assert policy.required_key_count == 1
        assert policy.required_key_ids is None

    def test_multi_key(self) -> None:
        policy = AssetKeyPolicyCreate(
            asset_type="repository",
            asset_id="repo-1",
            protected_action="admin",
            required_key_count=3,
            required_key_ids=["k1", "k2", "k3"],
        )
        assert policy.required_key_count == 3
        assert len(policy.required_key_ids) == 3


# ============================================================================
# Pydantic Response Models
# ============================================================================


class TestHardwareKeyResponse:
    """Tests for HardwareKeyResponse Pydantic model."""

    def test_required_fields(self) -> None:
        resp = HardwareKeyResponse(
            id="key-1",
            credential_id="cred-1",
            created_at="2026-03-02T12:00:00Z",
            updated_at="2026-03-02T12:00:00Z",
        )
        assert resp.id == "key-1"
        assert resp.is_active is True
        assert resp.transports == []

    def test_all_fields(self) -> None:
        resp = HardwareKeyResponse(
            id="key-2",
            credential_id="cred-2",
            friendly_name="My Key",
            device_type="titan",
            transports=["usb"],
            attestation_format="none",
            aaguid="aag",
            is_active=False,
            last_used_at="2026-03-02T12:05:00Z",
            created_at="2026-03-02T12:00:00Z",
            updated_at="2026-03-02T12:00:00Z",
        )
        assert resp.is_active is False
        assert resp.last_used_at == "2026-03-02T12:05:00Z"


class TestAssertionResponse:
    """Tests for AssertionResponse Pydantic model."""

    def test_required_fields(self) -> None:
        resp = AssertionResponse(
            assertion_id="a-1",
            hardware_key_id="k-1",
            expires_at="2026-03-02T12:05:00Z",
        )
        assert resp.consumed is False
        assert resp.asset_type is None
        assert resp.asset_id is None

    def test_with_scope(self) -> None:
        resp = AssertionResponse(
            assertion_id="a-2",
            hardware_key_id="k-2",
            expires_at="2026-03-02T12:05:00Z",
            consumed=True,
            asset_type="agent",
            asset_id="agent-1",
        )
        assert resp.consumed is True
        assert resp.asset_type == "agent"


class TestAssetKeyPolicyResponse:
    """Tests for AssetKeyPolicyResponse Pydantic model."""

    def test_all_fields(self) -> None:
        resp = AssetKeyPolicyResponse(
            id="pol-1",
            asset_type="document",
            asset_id="doc-1",
            protected_action="decrypt",
            required_key_count=1,
            created_at="2026-03-02T12:00:00Z",
            updated_at="2026-03-02T12:00:00Z",
        )
        assert resp.required_key_ids is None
        assert resp.created_by_user_id is None


class TestKeyProtectedAccessResult:
    """Tests for KeyProtectedAccessResult Pydantic model."""

    def test_access_granted(self) -> None:
        result = KeyProtectedAccessResult(
            allowed=True,
            reason="No key policy exists for this asset",
        )
        assert result.allowed is True
        assert result.reason == "No key policy exists for this asset"
        assert result.requires_assertion is False
        assert result.required_key_count is None
        assert result.assertions_present is None

    def test_access_denied_needs_assertion(self) -> None:
        result = KeyProtectedAccessResult(
            allowed=False,
            reason="Key assertion required: 2 touch(es) needed, 1 present",
            requires_assertion=True,
            required_key_count=2,
            assertions_present=1,
        )
        assert result.allowed is False
        assert result.requires_assertion is True
        assert result.required_key_count == 2
        assert result.assertions_present == 1

    def test_access_granted_with_assertion(self) -> None:
        result = KeyProtectedAccessResult(
            allowed=True,
            reason="Valid assertion found",
            requires_assertion=True,
            required_key_count=1,
            assertions_present=1,
        )
        assert result.allowed is True
        assert result.requires_assertion is True
        assert result.assertions_present == 1
