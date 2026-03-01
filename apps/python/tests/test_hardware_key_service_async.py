"""Unit tests for hardware key service async DB functions (server.hardware_key_service).

Covers all async functions that interact with the database via psycopg AsyncConnection:
- ``register_hardware_key()`` — INSERT with conflict handling
- ``list_user_hardware_keys()`` — SELECT with active/inactive filter
- ``get_hardware_key()`` — SELECT by id + user_id
- ``update_hardware_key()`` — dynamic UPDATE with field selection
- ``deactivate_hardware_key()`` — UPDATE is_active = false
- ``record_assertion()`` — SELECT key + INSERT assertion + UPDATE key
- ``get_assertion()`` — SELECT by id + user_id
- ``consume_assertion()`` — SELECT + expiry check + UPDATE consumed
- ``list_valid_assertions()`` — SELECT with optional scope filter
- ``create_asset_key_policy()`` — INSERT with unique constraint conflict
- ``list_asset_key_policies()`` — SELECT by asset_type + asset_id
- ``get_asset_key_policy()`` — SELECT by policy_id
- ``delete_asset_key_policy()`` — DELETE RETURNING
- ``check_key_protected_access()`` — policy lookup + assertion count + compare

All tests use ``unittest.mock.AsyncMock`` to simulate psycopg connection and
cursor results. No real database or network required.
"""

from __future__ import annotations

from datetime import datetime, timezone
from unittest.mock import AsyncMock, patch
from uuid import uuid4

import pytest

from server.hardware_key_service import (
    AssertionConsumedError,
    AssertionExpiredError,
    AssertionNotFoundError,
    AssertionRecord,
    AssertionResponse,
    AssetKeyPolicyCreate,
    AssetKeyPolicyResponse,
    HardwareKeyConflictError,
    HardwareKeyInactiveError,
    HardwareKeyNotFoundError,
    HardwareKeyRegistration,
    HardwareKeyResponse,
    HardwareKeyUpdate,
    InvalidInputError,
    KeyProtectedAccessResult,
    PolicyConflictError,
    check_key_protected_access,
    consume_assertion,
    create_asset_key_policy,
    deactivate_hardware_key,
    delete_asset_key_policy,
    get_assertion,
    get_asset_key_policy,
    get_hardware_key,
    list_asset_key_policies,
    list_user_hardware_keys,
    list_valid_assertions,
    record_assertion,
    register_hardware_key,
    update_hardware_key,
)


# ============================================================================
# Constants & Helpers
# ============================================================================

NOW = datetime(2026, 3, 2, 12, 0, 0, tzinfo=timezone.utc)
LATER = datetime(2026, 3, 2, 12, 5, 0, tzinfo=timezone.utc)
USER_ID = str(uuid4())
KEY_ID = str(uuid4())
ASSERTION_ID = str(uuid4())
POLICY_ID = str(uuid4())


def _make_mock_result(
    fetchone_return=None,
    fetchall_return=None,
    rowcount=0,
) -> AsyncMock:
    """Create a mock cursor/result object with fetchone/fetchall/rowcount."""
    mock_result = AsyncMock()
    mock_result.fetchone = AsyncMock(return_value=fetchone_return)
    mock_result.fetchall = AsyncMock(return_value=fetchall_return or [])
    mock_result.rowcount = rowcount
    return mock_result


def _make_connection(*results: AsyncMock) -> AsyncMock:
    """Create a mock AsyncConnection whose execute() returns results in order.

    If a single result is provided, every call returns that result.
    If multiple results are provided, they are returned in sequence.
    """
    connection = AsyncMock()
    if len(results) == 1:
        connection.execute = AsyncMock(return_value=results[0])
    else:
        connection.execute = AsyncMock(side_effect=list(results))
    return connection


def _make_key_row(**overrides: object) -> dict:
    """Build a minimal hardware_keys row dict."""
    row = {
        "id": uuid4(),
        "credential_id": "cred-abc123",
        "public_key": b"\x04abc",
        "counter": 0,
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
        "challenge": "challenge-abc",
        "verified_at": NOW,
        "expires_at": LATER,
        "consumed": False,
        "consumed_at": None,
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


def _make_registration(**overrides: object) -> HardwareKeyRegistration:
    """Build a valid HardwareKeyRegistration."""
    import base64

    defaults = {
        "credential_id": "cred-abc123",
        "public_key": base64.urlsafe_b64encode(b"\x04abcdef").decode().rstrip("="),
        "counter": 0,
        "friendly_name": "My SoloKey",
        "device_type": "solokey",
        "transports": ["usb", "nfc"],
        "attestation_format": "packed",
        "aaguid": "aaguid-xyz",
    }
    defaults.update(overrides)
    return HardwareKeyRegistration(**defaults)


# ============================================================================
# register_hardware_key
# ============================================================================


class TestRegisterHardwareKey:
    """Tests for ``register_hardware_key()``."""

    async def test_successful_registration(self) -> None:
        """Happy path: key inserted, response returned."""
        row = _make_key_row()
        result = _make_mock_result(fetchone_return=row)
        connection = _make_connection(result)
        registration = _make_registration()

        response = await register_hardware_key(connection, USER_ID, registration)

        assert isinstance(response, HardwareKeyResponse)
        assert response.credential_id == row["credential_id"]
        assert response.friendly_name == row["friendly_name"]
        assert connection.execute.call_count == 1

    async def test_conflict_raises_hardware_key_conflict_error(self) -> None:
        """Duplicate credential_id triggers HardwareKeyConflictError."""
        connection = AsyncMock()
        connection.execute = AsyncMock(
            side_effect=Exception(
                "duplicate key value violates unique constraint "
                '"hardware_keys_credential_id_unique"'
            )
        )
        registration = _make_registration()

        with pytest.raises(HardwareKeyConflictError) as exc_info:
            await register_hardware_key(connection, USER_ID, registration)

        assert "cred-abc123" in str(exc_info.value)

    async def test_unknown_db_error_reraised(self) -> None:
        """Non-conflict DB errors propagate as-is."""
        connection = AsyncMock()
        connection.execute = AsyncMock(side_effect=RuntimeError("connection lost"))
        registration = _make_registration()

        with pytest.raises(RuntimeError, match="connection lost"):
            await register_hardware_key(connection, USER_ID, registration)

    async def test_invalid_device_type_raises(self) -> None:
        """Invalid device_type raises InvalidInputError before DB call."""
        connection = AsyncMock()
        registration = _make_registration(device_type="invalid-device")

        with pytest.raises(InvalidInputError):
            await register_hardware_key(connection, USER_ID, registration)

        connection.execute.assert_not_called()

    async def test_invalid_public_key_raises(self) -> None:
        """base64 decode failure raises InvalidInputError."""
        connection = AsyncMock()
        registration = _make_registration(public_key="anything")

        with patch(
            "server.hardware_key_service.base64.urlsafe_b64decode",
            side_effect=ValueError("Invalid base64"),
        ):
            with pytest.raises(InvalidInputError, match="Invalid base64url"):
                await register_hardware_key(connection, USER_ID, registration)

    async def test_none_device_type_accepted(self) -> None:
        """device_type=None is valid and passes validation."""
        row = _make_key_row(device_type=None)
        result = _make_mock_result(fetchone_return=row)
        connection = _make_connection(result)
        registration = _make_registration(device_type=None)

        response = await register_hardware_key(connection, USER_ID, registration)

        assert isinstance(response, HardwareKeyResponse)


# ============================================================================
# list_user_hardware_keys
# ============================================================================


class TestListUserHardwareKeys:
    """Tests for ``list_user_hardware_keys()``."""

    async def test_returns_list_of_responses(self) -> None:
        """Multiple keys returned as HardwareKeyResponse list."""
        rows = [_make_key_row(), _make_key_row()]
        result = _make_mock_result(fetchall_return=rows)
        connection = _make_connection(result)

        keys = await list_user_hardware_keys(connection, USER_ID)

        assert len(keys) == 2
        assert all(isinstance(key, HardwareKeyResponse) for key in keys)

    async def test_empty_list_when_no_keys(self) -> None:
        """User with no keys gets an empty list."""
        result = _make_mock_result(fetchall_return=[])
        connection = _make_connection(result)

        keys = await list_user_hardware_keys(connection, USER_ID)

        assert keys == []

    async def test_include_inactive_false_filters_query(self) -> None:
        """Default (include_inactive=False) includes is_active filter in SQL."""
        result = _make_mock_result(fetchall_return=[])
        connection = _make_connection(result)

        await list_user_hardware_keys(connection, USER_ID, include_inactive=False)

        call_args = connection.execute.call_args
        sql = call_args[0][0]
        assert "is_active = true" in sql

    async def test_include_inactive_true_omits_filter(self) -> None:
        """include_inactive=True does NOT filter by is_active."""
        result = _make_mock_result(fetchall_return=[])
        connection = _make_connection(result)

        await list_user_hardware_keys(connection, USER_ID, include_inactive=True)

        call_args = connection.execute.call_args
        sql = call_args[0][0]
        assert "is_active" not in sql

    async def test_passes_user_id_as_param(self) -> None:
        """User ID passed correctly to SQL params."""
        result = _make_mock_result(fetchall_return=[])
        connection = _make_connection(result)

        await list_user_hardware_keys(connection, USER_ID)

        call_args = connection.execute.call_args
        params = call_args[0][1]
        assert params["user_id"] == USER_ID


# ============================================================================
# get_hardware_key
# ============================================================================


class TestGetHardwareKey:
    """Tests for ``get_hardware_key()``."""

    async def test_found_returns_response(self) -> None:
        """Existing key returns HardwareKeyResponse."""
        row = _make_key_row()
        result = _make_mock_result(fetchone_return=row)
        connection = _make_connection(result)

        response = await get_hardware_key(connection, USER_ID, KEY_ID)

        assert isinstance(response, HardwareKeyResponse)

    async def test_not_found_raises(self) -> None:
        """Missing key raises HardwareKeyNotFoundError."""
        result = _make_mock_result(fetchone_return=None)
        connection = _make_connection(result)

        with pytest.raises(HardwareKeyNotFoundError):
            await get_hardware_key(connection, USER_ID, KEY_ID)

    async def test_passes_both_ids_as_params(self) -> None:
        """Both user_id and key_id passed in SQL params for ownership check."""
        row = _make_key_row()
        result = _make_mock_result(fetchone_return=row)
        connection = _make_connection(result)

        await get_hardware_key(connection, USER_ID, KEY_ID)

        params = connection.execute.call_args[0][1]
        assert params["user_id"] == USER_ID
        assert params["key_id"] == KEY_ID


# ============================================================================
# update_hardware_key
# ============================================================================


class TestUpdateHardwareKey:
    """Tests for ``update_hardware_key()``."""

    async def test_update_friendly_name(self) -> None:
        """Updating friendly_name returns updated response."""
        row = _make_key_row(friendly_name="Updated Name")
        result = _make_mock_result(fetchone_return=row)
        connection = _make_connection(result)
        updates = HardwareKeyUpdate(friendly_name="Updated Name")

        response = await update_hardware_key(connection, USER_ID, KEY_ID, updates)

        assert isinstance(response, HardwareKeyResponse)
        assert response.friendly_name == "Updated Name"

    async def test_update_device_type(self) -> None:
        """Updating device_type with valid value succeeds."""
        row = _make_key_row(device_type="yubikey")
        result = _make_mock_result(fetchone_return=row)
        connection = _make_connection(result)
        updates = HardwareKeyUpdate(device_type="yubikey")

        response = await update_hardware_key(connection, USER_ID, KEY_ID, updates)

        assert isinstance(response, HardwareKeyResponse)

    async def test_update_both_fields(self) -> None:
        """Updating both fields in one call."""
        row = _make_key_row(friendly_name="New", device_type="titan")
        result = _make_mock_result(fetchone_return=row)
        connection = _make_connection(result)
        updates = HardwareKeyUpdate(friendly_name="New", device_type="titan")

        response = await update_hardware_key(connection, USER_ID, KEY_ID, updates)

        assert isinstance(response, HardwareKeyResponse)
        # SQL should contain both SET clauses
        sql = connection.execute.call_args[0][0]
        assert "friendly_name" in sql
        assert "device_type" in sql

    async def test_no_fields_delegates_to_get(self) -> None:
        """No fields to update delegates to get_hardware_key."""
        row = _make_key_row()
        result = _make_mock_result(fetchone_return=row)
        connection = _make_connection(result)
        updates = HardwareKeyUpdate()  # both None

        response = await update_hardware_key(connection, USER_ID, KEY_ID, updates)

        assert isinstance(response, HardwareKeyResponse)
        # Should have called execute once (for get_hardware_key)
        sql = connection.execute.call_args[0][0]
        assert "SELECT" in sql
        assert "UPDATE" not in sql

    async def test_not_found_raises(self) -> None:
        """Updating a non-existent key raises HardwareKeyNotFoundError."""
        result = _make_mock_result(fetchone_return=None)
        connection = _make_connection(result)
        updates = HardwareKeyUpdate(friendly_name="Ghost")

        with pytest.raises(HardwareKeyNotFoundError):
            await update_hardware_key(connection, USER_ID, KEY_ID, updates)

    async def test_invalid_device_type_raises(self) -> None:
        """Invalid device_type caught before DB call."""
        connection = AsyncMock()
        updates = HardwareKeyUpdate(device_type="bad-type")

        with pytest.raises(InvalidInputError):
            await update_hardware_key(connection, USER_ID, KEY_ID, updates)

        connection.execute.assert_not_called()


# ============================================================================
# deactivate_hardware_key
# ============================================================================


class TestDeactivateHardwareKey:
    """Tests for ``deactivate_hardware_key()``."""

    async def test_successful_deactivation(self) -> None:
        """Deactivating an active key sets is_active=false."""
        row = _make_key_row(is_active=False)
        result = _make_mock_result(fetchone_return=row)
        connection = _make_connection(result)

        response = await deactivate_hardware_key(connection, USER_ID, KEY_ID)

        assert isinstance(response, HardwareKeyResponse)
        sql = connection.execute.call_args[0][0]
        assert "is_active = false" in sql

    async def test_not_found_raises(self) -> None:
        """Deactivating a non-existent key raises HardwareKeyNotFoundError."""
        result = _make_mock_result(fetchone_return=None)
        connection = _make_connection(result)

        with pytest.raises(HardwareKeyNotFoundError):
            await deactivate_hardware_key(connection, USER_ID, KEY_ID)

    async def test_passes_user_and_key_id(self) -> None:
        """Both IDs passed for ownership check."""
        row = _make_key_row(is_active=False)
        result = _make_mock_result(fetchone_return=row)
        connection = _make_connection(result)

        await deactivate_hardware_key(connection, USER_ID, KEY_ID)

        params = connection.execute.call_args[0][1]
        assert params["user_id"] == USER_ID
        assert params["key_id"] == KEY_ID


# ============================================================================
# record_assertion
# ============================================================================


class TestRecordAssertion:
    """Tests for ``record_assertion()``."""

    async def test_successful_recording(self) -> None:
        """Happy path: key found, active, assertion inserted."""
        key_row = _make_key_row(is_active=True, counter=5)
        assertion_row = _make_assertion_row()

        key_result = _make_mock_result(fetchone_return=key_row)
        insert_result = _make_mock_result(fetchone_return=assertion_row)
        update_result = _make_mock_result()  # UPDATE counter (no return needed)

        connection = _make_connection(key_result, insert_result, update_result)

        assertion = AssertionRecord(
            hardware_key_id=str(key_row["id"]),
            challenge="test-challenge-123",
        )

        response = await record_assertion(connection, USER_ID, assertion)

        assert isinstance(response, AssertionResponse)
        assert connection.execute.call_count == 3  # SELECT + INSERT + UPDATE

    async def test_key_not_found_raises(self) -> None:
        """Non-existent key raises HardwareKeyNotFoundError."""
        key_result = _make_mock_result(fetchone_return=None)
        connection = _make_connection(key_result)

        assertion = AssertionRecord(
            hardware_key_id=str(uuid4()),
            challenge="challenge",
        )

        with pytest.raises(HardwareKeyNotFoundError):
            await record_assertion(connection, USER_ID, assertion)

    async def test_inactive_key_raises(self) -> None:
        """Inactive key raises HardwareKeyInactiveError."""
        key_row = _make_key_row(is_active=False)
        key_result = _make_mock_result(fetchone_return=key_row)
        connection = _make_connection(key_result)

        assertion = AssertionRecord(
            hardware_key_id=str(key_row["id"]),
            challenge="challenge",
        )

        with pytest.raises(HardwareKeyInactiveError):
            await record_assertion(connection, USER_ID, assertion)

    async def test_invalid_scope_raises_before_db(self) -> None:
        """asset_type without asset_id raises InvalidInputError."""
        connection = AsyncMock()

        assertion = AssertionRecord(
            hardware_key_id=str(uuid4()),
            challenge="challenge",
            asset_type="document",
            asset_id=None,
        )

        with pytest.raises(InvalidInputError):
            await record_assertion(connection, USER_ID, assertion)

        connection.execute.assert_not_called()

    async def test_with_asset_scope(self) -> None:
        """Assertion with asset_type + asset_id passes scope to INSERT."""
        key_row = _make_key_row(is_active=True)
        assertion_row = _make_assertion_row(asset_type="document", asset_id="doc-123")

        key_result = _make_mock_result(fetchone_return=key_row)
        insert_result = _make_mock_result(fetchone_return=assertion_row)
        update_result = _make_mock_result()

        connection = _make_connection(key_result, insert_result, update_result)

        assertion = AssertionRecord(
            hardware_key_id=str(key_row["id"]),
            challenge="challenge",
            asset_type="document",
            asset_id="doc-123",
        )

        response = await record_assertion(connection, USER_ID, assertion)

        assert isinstance(response, AssertionResponse)
        # Verify INSERT params include scope
        insert_params = connection.execute.call_args_list[1][0][1]
        assert insert_params["asset_type"] == "document"
        assert insert_params["asset_id"] == "doc-123"

    async def test_updates_key_counter(self) -> None:
        """After recording, the hardware key's counter is incremented."""
        key_row = _make_key_row(is_active=True)
        assertion_row = _make_assertion_row()

        key_result = _make_mock_result(fetchone_return=key_row)
        insert_result = _make_mock_result(fetchone_return=assertion_row)
        update_result = _make_mock_result()

        connection = _make_connection(key_result, insert_result, update_result)

        assertion = AssertionRecord(
            hardware_key_id=str(key_row["id"]),
            challenge="challenge",
        )

        await record_assertion(connection, USER_ID, assertion)

        # Third call should be the UPDATE counter
        update_sql = connection.execute.call_args_list[2][0][0]
        assert "counter = counter + 1" in update_sql


# ============================================================================
# get_assertion
# ============================================================================


class TestGetAssertion:
    """Tests for ``get_assertion()``."""

    async def test_found_returns_response(self) -> None:
        """Existing assertion returns AssertionResponse."""
        row = _make_assertion_row()
        result = _make_mock_result(fetchone_return=row)
        connection = _make_connection(result)

        response = await get_assertion(connection, USER_ID, ASSERTION_ID)

        assert isinstance(response, AssertionResponse)

    async def test_not_found_raises(self) -> None:
        """Missing assertion raises AssertionNotFoundError."""
        result = _make_mock_result(fetchone_return=None)
        connection = _make_connection(result)

        with pytest.raises(AssertionNotFoundError):
            await get_assertion(connection, USER_ID, ASSERTION_ID)

    async def test_passes_both_ids(self) -> None:
        """Both user_id and assertion_id passed for ownership check."""
        row = _make_assertion_row()
        result = _make_mock_result(fetchone_return=row)
        connection = _make_connection(result)

        await get_assertion(connection, USER_ID, ASSERTION_ID)

        params = connection.execute.call_args[0][1]
        assert params["user_id"] == USER_ID
        assert params["assertion_id"] == ASSERTION_ID


# ============================================================================
# consume_assertion
# ============================================================================


class TestConsumeAssertion:
    """Tests for ``consume_assertion()``."""

    async def test_successful_consumption(self) -> None:
        """Happy path: unconsumed, unexpired assertion gets consumed."""
        fetch_row = _make_assertion_row(consumed=False)
        expiry_row = {"is_expired": False}
        updated_row = _make_assertion_row(consumed=True, consumed_at=NOW)

        fetch_result = _make_mock_result(fetchone_return=fetch_row)
        expiry_result = _make_mock_result(fetchone_return=expiry_row)
        update_result = _make_mock_result(fetchone_return=updated_row)

        connection = _make_connection(fetch_result, expiry_result, update_result)

        response = await consume_assertion(connection, USER_ID, ASSERTION_ID)

        assert isinstance(response, AssertionResponse)
        assert connection.execute.call_count == 3

    async def test_not_found_raises(self) -> None:
        """Non-existent assertion raises AssertionNotFoundError."""
        result = _make_mock_result(fetchone_return=None)
        connection = _make_connection(result)

        with pytest.raises(AssertionNotFoundError):
            await consume_assertion(connection, USER_ID, ASSERTION_ID)

    async def test_already_consumed_raises(self) -> None:
        """Already-consumed assertion raises AssertionConsumedError."""
        fetch_row = _make_assertion_row(consumed=True)
        fetch_result = _make_mock_result(fetchone_return=fetch_row)
        connection = _make_connection(fetch_result)

        with pytest.raises(AssertionConsumedError):
            await consume_assertion(connection, USER_ID, ASSERTION_ID)

    async def test_expired_raises(self) -> None:
        """Expired assertion raises AssertionExpiredError."""
        fetch_row = _make_assertion_row(consumed=False)
        expiry_row = {"is_expired": True}

        fetch_result = _make_mock_result(fetchone_return=fetch_row)
        expiry_result = _make_mock_result(fetchone_return=expiry_row)

        connection = _make_connection(fetch_result, expiry_result)

        with pytest.raises(AssertionExpiredError):
            await consume_assertion(connection, USER_ID, ASSERTION_ID)

    async def test_expiry_row_none_does_not_raise(self) -> None:
        """If expiry query returns None, no expiry error (edge case)."""
        fetch_row = _make_assertion_row(consumed=False)
        updated_row = _make_assertion_row(consumed=True, consumed_at=NOW)

        fetch_result = _make_mock_result(fetchone_return=fetch_row)
        expiry_result = _make_mock_result(fetchone_return=None)
        update_result = _make_mock_result(fetchone_return=updated_row)

        connection = _make_connection(fetch_result, expiry_result, update_result)

        response = await consume_assertion(connection, USER_ID, ASSERTION_ID)

        assert isinstance(response, AssertionResponse)


# ============================================================================
# list_valid_assertions
# ============================================================================


class TestListValidAssertions:
    """Tests for ``list_valid_assertions()``."""

    async def test_returns_list_unscoped(self) -> None:
        """No scope filter returns all valid assertions."""
        rows = [_make_assertion_row(), _make_assertion_row()]
        result = _make_mock_result(fetchall_return=rows)
        connection = _make_connection(result)

        assertions = await list_valid_assertions(connection, USER_ID)

        assert len(assertions) == 2
        assert all(isinstance(assertion, AssertionResponse) for assertion in assertions)

    async def test_empty_list(self) -> None:
        """No valid assertions returns empty list."""
        result = _make_mock_result(fetchall_return=[])
        connection = _make_connection(result)

        assertions = await list_valid_assertions(connection, USER_ID)

        assert assertions == []

    async def test_with_asset_scope(self) -> None:
        """Scoped query includes asset_type and asset_id in SQL."""
        rows = [_make_assertion_row(asset_type="document", asset_id="doc-1")]
        result = _make_mock_result(fetchall_return=rows)
        connection = _make_connection(result)

        assertions = await list_valid_assertions(
            connection, USER_ID, asset_type="document", asset_id="doc-1"
        )

        assert len(assertions) == 1
        params = connection.execute.call_args[0][1]
        assert params["asset_type"] == "document"
        assert params["asset_id"] == "doc-1"

    async def test_scoped_query_includes_null_fallback(self) -> None:
        """Scoped query also matches assertions with NULL asset_type."""
        result = _make_mock_result(fetchall_return=[])
        connection = _make_connection(result)

        await list_valid_assertions(
            connection, USER_ID, asset_type="document", asset_id="doc-1"
        )

        sql = connection.execute.call_args[0][0]
        assert "asset_type IS NULL" in sql

    async def test_unscoped_query_checks_consumed_and_expiry(self) -> None:
        """Unscoped query filters by consumed=false and expires_at > now()."""
        result = _make_mock_result(fetchall_return=[])
        connection = _make_connection(result)

        await list_valid_assertions(connection, USER_ID)

        sql = connection.execute.call_args[0][0]
        assert "consumed = false" in sql
        assert "expires_at > now()" in sql


# ============================================================================
# create_asset_key_policy
# ============================================================================


class TestCreateAssetKeyPolicy:
    """Tests for ``create_asset_key_policy()``."""

    async def test_successful_creation(self) -> None:
        """Happy path: policy inserted and returned."""
        row = _make_policy_row()
        result = _make_mock_result(fetchone_return=row)
        connection = _make_connection(result)

        policy = AssetKeyPolicyCreate(
            asset_type="document",
            asset_id=str(uuid4()),
            protected_action="decrypt",
            required_key_count=1,
        )

        response = await create_asset_key_policy(connection, USER_ID, policy)

        assert isinstance(response, AssetKeyPolicyResponse)

    async def test_conflict_raises_policy_conflict_error(self) -> None:
        """Duplicate asset+action triggers PolicyConflictError."""
        connection = AsyncMock()
        connection.execute = AsyncMock(
            side_effect=Exception(
                "duplicate key value violates unique constraint "
                '"asset_key_policies_asset_action_unique"'
            )
        )

        policy = AssetKeyPolicyCreate(
            asset_type="document",
            asset_id=str(uuid4()),
            protected_action="decrypt",
            required_key_count=1,
        )

        with pytest.raises(PolicyConflictError):
            await create_asset_key_policy(connection, USER_ID, policy)

    async def test_unknown_db_error_reraised(self) -> None:
        """Non-conflict DB errors propagate."""
        connection = AsyncMock()
        connection.execute = AsyncMock(side_effect=RuntimeError("disk full"))

        policy = AssetKeyPolicyCreate(
            asset_type="document",
            asset_id=str(uuid4()),
            protected_action="decrypt",
            required_key_count=1,
        )

        with pytest.raises(RuntimeError, match="disk full"):
            await create_asset_key_policy(connection, USER_ID, policy)

    async def test_invalid_asset_type_raises(self) -> None:
        """Invalid asset_type raises InvalidInputError before DB call."""
        connection = AsyncMock()

        policy = AssetKeyPolicyCreate(
            asset_type="INVALID",
            asset_id=str(uuid4()),
            protected_action="decrypt",
            required_key_count=1,
        )

        with pytest.raises(InvalidInputError):
            await create_asset_key_policy(connection, USER_ID, policy)

        connection.execute.assert_not_called()

    async def test_invalid_action_raises(self) -> None:
        """Invalid protected_action raises InvalidInputError."""
        connection = AsyncMock()

        policy = AssetKeyPolicyCreate(
            asset_type="document",
            asset_id=str(uuid4()),
            protected_action="INVALID",
            required_key_count=1,
        )

        with pytest.raises(InvalidInputError):
            await create_asset_key_policy(connection, USER_ID, policy)

    async def test_zero_required_key_count_raises(self) -> None:
        """required_key_count < 1 raises InvalidInputError."""
        connection = AsyncMock()

        policy = AssetKeyPolicyCreate(
            asset_type="document",
            asset_id=str(uuid4()),
            protected_action="decrypt",
            required_key_count=0,
        )

        with pytest.raises(InvalidInputError, match="required_key_count must be >= 1"):
            await create_asset_key_policy(connection, USER_ID, policy)

    async def test_with_required_key_ids(self) -> None:
        """Policy with specific required_key_ids passes them to SQL."""
        key_ids = [str(uuid4()), str(uuid4())]
        row = _make_policy_row(required_key_ids=key_ids)
        result = _make_mock_result(fetchone_return=row)
        connection = _make_connection(result)

        policy = AssetKeyPolicyCreate(
            asset_type="document",
            asset_id=str(uuid4()),
            protected_action="decrypt",
            required_key_count=2,
            required_key_ids=key_ids,
        )

        response = await create_asset_key_policy(connection, USER_ID, policy)

        assert isinstance(response, AssetKeyPolicyResponse)
        params = connection.execute.call_args[0][1]
        assert params["required_key_ids"] == key_ids

    async def test_user_id_recorded_as_creator(self) -> None:
        """User ID passed as created_by_user_id."""
        row = _make_policy_row(created_by_user_id=USER_ID)
        result = _make_mock_result(fetchone_return=row)
        connection = _make_connection(result)

        policy = AssetKeyPolicyCreate(
            asset_type="document",
            asset_id=str(uuid4()),
            protected_action="decrypt",
            required_key_count=1,
        )

        await create_asset_key_policy(connection, USER_ID, policy)

        params = connection.execute.call_args[0][1]
        assert params["created_by_user_id"] == USER_ID


# ============================================================================
# list_asset_key_policies
# ============================================================================


class TestListAssetKeyPolicies:
    """Tests for ``list_asset_key_policies()``."""

    async def test_returns_list(self) -> None:
        """Multiple policies returned as list."""
        asset_id = str(uuid4())
        rows = [
            _make_policy_row(asset_id=asset_id, protected_action="decrypt"),
            _make_policy_row(asset_id=asset_id, protected_action="delete"),
        ]
        result = _make_mock_result(fetchall_return=rows)
        connection = _make_connection(result)

        policies = await list_asset_key_policies(connection, "document", asset_id)

        assert len(policies) == 2
        assert all(isinstance(policy, AssetKeyPolicyResponse) for policy in policies)

    async def test_empty_list(self) -> None:
        """No policies returns empty list."""
        result = _make_mock_result(fetchall_return=[])
        connection = _make_connection(result)

        policies = await list_asset_key_policies(connection, "document", str(uuid4()))

        assert policies == []

    async def test_invalid_asset_type_raises(self) -> None:
        """Invalid asset_type raises InvalidInputError."""
        connection = AsyncMock()

        with pytest.raises(InvalidInputError):
            await list_asset_key_policies(connection, "INVALID", str(uuid4()))


# ============================================================================
# get_asset_key_policy
# ============================================================================


class TestGetAssetKeyPolicy:
    """Tests for ``get_asset_key_policy()``."""

    async def test_found_returns_response(self) -> None:
        """Existing policy returns AssetKeyPolicyResponse."""
        row = _make_policy_row()
        result = _make_mock_result(fetchone_return=row)
        connection = _make_connection(result)

        response = await get_asset_key_policy(connection, POLICY_ID)

        assert isinstance(response, AssetKeyPolicyResponse)

    async def test_not_found_returns_none(self) -> None:
        """Missing policy returns None (not an error)."""
        result = _make_mock_result(fetchone_return=None)
        connection = _make_connection(result)

        response = await get_asset_key_policy(connection, POLICY_ID)

        assert response is None


# ============================================================================
# delete_asset_key_policy
# ============================================================================


class TestDeleteAssetKeyPolicy:
    """Tests for ``delete_asset_key_policy()``."""

    async def test_deleted_returns_true(self) -> None:
        """Deleting an existing policy returns True."""
        result = _make_mock_result(fetchone_return={"id": POLICY_ID})
        connection = _make_connection(result)

        deleted = await delete_asset_key_policy(connection, POLICY_ID)

        assert deleted is True

    async def test_not_found_returns_false(self) -> None:
        """Deleting a non-existent policy returns False."""
        result = _make_mock_result(fetchone_return=None)
        connection = _make_connection(result)

        deleted = await delete_asset_key_policy(connection, POLICY_ID)

        assert deleted is False

    async def test_passes_policy_id(self) -> None:
        """Policy ID passed correctly to SQL."""
        result = _make_mock_result(fetchone_return={"id": POLICY_ID})
        connection = _make_connection(result)

        await delete_asset_key_policy(connection, POLICY_ID)

        params = connection.execute.call_args[0][1]
        assert params["policy_id"] == POLICY_ID


# ============================================================================
# check_key_protected_access
# ============================================================================


class TestCheckKeyProtectedAccess:
    """Tests for ``check_key_protected_access()``."""

    async def test_no_policy_allows_access(self) -> None:
        """No policy for asset+action → access allowed, no assertion required."""
        policy_result = _make_mock_result(fetchone_return=None)
        connection = _make_connection(policy_result)

        result = await check_key_protected_access(
            connection, USER_ID, "document", str(uuid4()), "decrypt"
        )

        assert isinstance(result, KeyProtectedAccessResult)
        assert result.allowed is True
        assert result.requires_assertion is False

    async def test_single_key_sufficient_assertions(self) -> None:
        """Policy requires 1 key, user has 1 assertion → access granted."""
        policy_row = {"required_key_count": 1, "required_key_ids": None}
        assertion_row = {"assertion_count": 1}

        policy_result = _make_mock_result(fetchone_return=policy_row)
        assertion_result = _make_mock_result(fetchone_return=assertion_row)
        connection = _make_connection(policy_result, assertion_result)

        result = await check_key_protected_access(
            connection, USER_ID, "document", str(uuid4()), "decrypt"
        )

        assert result.allowed is True
        assert result.requires_assertion is True
        assert result.assertions_present == 1

    async def test_single_key_no_assertions(self) -> None:
        """Policy requires 1 key, user has 0 assertions → access denied."""
        policy_row = {"required_key_count": 1, "required_key_ids": None}
        assertion_row = {"assertion_count": 0}

        policy_result = _make_mock_result(fetchone_return=policy_row)
        assertion_result = _make_mock_result(fetchone_return=assertion_row)
        connection = _make_connection(policy_result, assertion_result)

        result = await check_key_protected_access(
            connection, USER_ID, "document", str(uuid4()), "decrypt"
        )

        assert result.allowed is False
        assert result.requires_assertion is True
        assert result.required_key_count == 1
        assert result.assertions_present == 0
        assert "assertion required" in result.reason.lower()

    async def test_multi_key_insufficient(self) -> None:
        """Policy requires 3 keys, only 1 present → access denied."""
        policy_row = {"required_key_count": 3, "required_key_ids": None}
        assertion_row = {"assertion_count": 1}

        policy_result = _make_mock_result(fetchone_return=policy_row)
        assertion_result = _make_mock_result(fetchone_return=assertion_row)
        connection = _make_connection(policy_result, assertion_result)

        result = await check_key_protected_access(
            connection, USER_ID, "document", str(uuid4()), "decrypt"
        )

        assert result.allowed is False
        assert result.required_key_count == 3
        assert result.assertions_present == 1
        assert "insufficient" in result.reason.lower()

    async def test_multi_key_sufficient(self) -> None:
        """Policy requires 2 keys, 3 present → access granted."""
        policy_row = {"required_key_count": 2, "required_key_ids": None}
        assertion_row = {"assertion_count": 3}

        policy_result = _make_mock_result(fetchone_return=policy_row)
        assertion_result = _make_mock_result(fetchone_return=assertion_row)
        connection = _make_connection(policy_result, assertion_result)

        result = await check_key_protected_access(
            connection, USER_ID, "document", str(uuid4()), "decrypt"
        )

        assert result.allowed is True
        assert result.assertions_present == 3

    async def test_with_required_key_ids_filter(self) -> None:
        """When policy has specific key IDs, SQL includes ANY filter."""
        key_ids = [str(uuid4()), str(uuid4())]
        policy_row = {"required_key_count": 1, "required_key_ids": key_ids}
        assertion_row = {"assertion_count": 1}

        policy_result = _make_mock_result(fetchone_return=policy_row)
        assertion_result = _make_mock_result(fetchone_return=assertion_row)
        connection = _make_connection(policy_result, assertion_result)

        result = await check_key_protected_access(
            connection, USER_ID, "document", str(uuid4()), "decrypt"
        )

        assert result.allowed is True
        # Assertion query should include ANY clause
        assertion_sql = connection.execute.call_args_list[1][0][0]
        assert "ANY" in assertion_sql

    async def test_assertion_row_none_treated_as_zero(self) -> None:
        """If assertion query returns None, count treated as 0."""
        policy_row = {"required_key_count": 1, "required_key_ids": None}

        policy_result = _make_mock_result(fetchone_return=policy_row)
        assertion_result = _make_mock_result(fetchone_return=None)
        connection = _make_connection(policy_result, assertion_result)

        result = await check_key_protected_access(
            connection, USER_ID, "document", str(uuid4()), "decrypt"
        )

        assert result.allowed is False
        assert result.assertions_present == 0

    async def test_invalid_asset_type_raises(self) -> None:
        """Invalid asset_type raises InvalidInputError."""
        connection = AsyncMock()

        with pytest.raises(InvalidInputError):
            await check_key_protected_access(
                connection, USER_ID, "INVALID", str(uuid4()), "decrypt"
            )

    async def test_invalid_action_raises(self) -> None:
        """Invalid action raises InvalidInputError."""
        connection = AsyncMock()

        with pytest.raises(InvalidInputError):
            await check_key_protected_access(
                connection, USER_ID, "document", str(uuid4()), "INVALID"
            )

    async def test_single_key_query_filters_by_user(self) -> None:
        """Single-key mode (required_key_count=1) filters by user_id."""
        policy_row = {"required_key_count": 1, "required_key_ids": None}
        assertion_row = {"assertion_count": 0}

        policy_result = _make_mock_result(fetchone_return=policy_row)
        assertion_result = _make_mock_result(fetchone_return=assertion_row)
        connection = _make_connection(policy_result, assertion_result)

        await check_key_protected_access(
            connection, USER_ID, "document", str(uuid4()), "decrypt"
        )

        assertion_sql = connection.execute.call_args_list[1][0][0]
        assert "user_id" in assertion_sql
        assert "COUNT(*)" in assertion_sql

    async def test_multi_key_query_counts_distinct_users(self) -> None:
        """Multi-key mode (required_key_count>1) counts DISTINCT users."""
        policy_row = {"required_key_count": 2, "required_key_ids": None}
        assertion_row = {"assertion_count": 2}

        policy_result = _make_mock_result(fetchone_return=policy_row)
        assertion_result = _make_mock_result(fetchone_return=assertion_row)
        connection = _make_connection(policy_result, assertion_result)

        await check_key_protected_access(
            connection, USER_ID, "document", str(uuid4()), "decrypt"
        )

        assertion_sql = connection.execute.call_args_list[1][0][0]
        assert "DISTINCT" in assertion_sql

    async def test_default_action_is_decrypt(self) -> None:
        """Default action is 'decrypt'."""
        policy_result = _make_mock_result(fetchone_return=None)
        connection = _make_connection(policy_result)

        await check_key_protected_access(connection, USER_ID, "document", str(uuid4()))

        params = connection.execute.call_args[0][1]
        assert params["action"] == "decrypt"

    async def test_various_actions(self) -> None:
        """All valid actions are accepted."""
        for action in (
            "decrypt",
            "delete",
            "export",
            "share",
            "sign",
            "all_writes",
            "admin",
        ):
            policy_result = _make_mock_result(fetchone_return=None)
            connection = _make_connection(policy_result)

            result = await check_key_protected_access(
                connection, USER_ID, "document", str(uuid4()), action
            )

            assert result.allowed is True
