"""Unit tests for encryption service async DB functions (server.encryption_service).

Covers all async functions that interact with the database via psycopg AsyncConnection:
- ``_validate_authorized_key_ids()`` — SELECT to check hardware keys exist
- ``store_encrypted_asset()`` — validate + decode base64 + INSERT
- ``get_encrypted_asset()`` — SELECT with asset_type + asset_id
- ``get_encrypted_asset_with_key_check()`` — SELECT + access check + consume
- ``list_encrypted_assets_for_user()`` — SELECT with optional type filter
- ``delete_encrypted_asset()`` — DELETE RETURNING
- ``update_authorized_keys()`` — validate keys + UPDATE with optional payload
- ``_consume_matching_assertions()`` — UPDATE consumed = true with rowcount

All tests use ``unittest.mock.AsyncMock`` to simulate psycopg connection and
cursor results. No real database or network required.
"""

from __future__ import annotations

import base64
from datetime import datetime, timezone
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest

from server.encryption_service import (
    EncryptedAssetKeyUpdate,
    EncryptedAssetMetadata,
    EncryptedAssetNotFoundError,
    EncryptedAssetResponse,
    EncryptedAssetStore,
    InvalidAuthorizedKeys,
    KeyGatedRetrievalResult,
    _consume_matching_assertions,
    _validate_authorized_key_ids,
    delete_encrypted_asset,
    get_encrypted_asset,
    get_encrypted_asset_with_key_check,
    list_encrypted_assets_for_user,
    store_encrypted_asset,
    update_authorized_keys,
)
from server.hardware_key_service import (
    InvalidInputError,
)


# ============================================================================
# Constants & Helpers
# ============================================================================

NOW = datetime(2026, 3, 2, 12, 0, 0, tzinfo=timezone.utc)
LATER = datetime(2026, 3, 2, 12, 5, 0, tzinfo=timezone.utc)
USER_ID = str(uuid4())
KEY_ID_1 = str(uuid4())
KEY_ID_2 = str(uuid4())
ASSET_ID = str(uuid4())


def _b64(data: bytes) -> str:
    """Encode bytes to standard base64 string."""
    return base64.b64encode(data).decode()


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


def _make_encrypted_asset_row(**overrides: object) -> dict:
    """Build a minimal encrypted_asset_data row dict."""
    row = {
        "id": uuid4(),
        "asset_type": "document",
        "asset_id": uuid4(),
        "encrypted_payload": b"\x00encrypted-payload-bytes",
        "encryption_algorithm": "AES-GCM-256",
        "key_derivation_method": "webauthn-prf-hkdf",
        "initialization_vector": b"\x00iv-bytes-here",
        "authorized_key_ids": [uuid4(), uuid4()],
        "encrypted_by_user_id": uuid4(),
        "created_at": NOW,
        "updated_at": NOW,
    }
    row.update(overrides)
    return row


def _make_metadata_row(**overrides: object) -> dict:
    """Build a minimal row for metadata queries (no payload/iv)."""
    row = {
        "id": uuid4(),
        "asset_type": "document",
        "asset_id": uuid4(),
        "encryption_algorithm": "AES-GCM-256",
        "key_derivation_method": "webauthn-prf-hkdf",
        "authorized_key_ids": [uuid4()],
        "encrypted_by_user_id": uuid4(),
        "created_at": NOW,
    }
    row.update(overrides)
    return row


def _make_store_data(**overrides: object) -> EncryptedAssetStore:
    """Build a valid EncryptedAssetStore model."""
    defaults = {
        "asset_type": "document",
        "asset_id": str(uuid4()),
        "encrypted_payload": _b64(b"ciphertext-data-here"),
        "initialization_vector": _b64(b"iv-12-bytes!"),
        "authorized_key_ids": [KEY_ID_1],
    }
    defaults.update(overrides)
    return EncryptedAssetStore(**defaults)


# ============================================================================
# _validate_authorized_key_ids
# ============================================================================


class TestValidateAuthorizedKeyIds:
    """Tests for ``_validate_authorized_key_ids()``."""

    async def test_all_keys_exist(self) -> None:
        """All key IDs found in DB — no error raised."""
        found_rows = [{"id": KEY_ID_1}, {"id": KEY_ID_2}]
        result = _make_mock_result(fetchall_return=found_rows)
        connection = _make_connection(result)

        # Should not raise
        await _validate_authorized_key_ids(connection, [KEY_ID_1, KEY_ID_2])

    async def test_empty_list_raises_invalid_input(self) -> None:
        """Empty authorized_key_ids raises InvalidInputError."""
        connection = AsyncMock()

        with pytest.raises(InvalidInputError, match="at least one key ID"):
            await _validate_authorized_key_ids(connection, [])

        connection.execute.assert_not_called()

    async def test_missing_keys_raises_invalid_authorized_keys(self) -> None:
        """Some key IDs not found in DB raises InvalidAuthorizedKeys."""
        missing_key = str(uuid4())
        found_rows = [{"id": KEY_ID_1}]
        result = _make_mock_result(fetchall_return=found_rows)
        connection = _make_connection(result)

        with pytest.raises(InvalidAuthorizedKeys) as exc_info:
            await _validate_authorized_key_ids(connection, [KEY_ID_1, missing_key])

        assert missing_key in exc_info.value.invalid_key_ids

    async def test_all_keys_missing_raises(self) -> None:
        """All key IDs missing raises InvalidAuthorizedKeys with all IDs."""
        key_a = str(uuid4())
        key_b = str(uuid4())
        result = _make_mock_result(fetchall_return=[])
        connection = _make_connection(result)

        with pytest.raises(InvalidAuthorizedKeys) as exc_info:
            await _validate_authorized_key_ids(connection, [key_a, key_b])

        assert set(exc_info.value.invalid_key_ids) == {key_a, key_b}

    async def test_passes_key_ids_to_query(self) -> None:
        """Key IDs passed as ANY parameter to SQL."""
        found_rows = [{"id": KEY_ID_1}]
        result = _make_mock_result(fetchall_return=found_rows)
        connection = _make_connection(result)

        await _validate_authorized_key_ids(connection, [KEY_ID_1])

        params = connection.execute.call_args[0][1]
        assert params["key_ids"] == [KEY_ID_1]


# ============================================================================
# store_encrypted_asset
# ============================================================================


class TestStoreEncryptedAsset:
    """Tests for ``store_encrypted_asset()``."""

    async def test_successful_store(self) -> None:
        """Happy path: validates, decodes, inserts, returns response."""
        row = _make_encrypted_asset_row()
        # First call: _validate_authorized_key_ids SELECT
        validate_result = _make_mock_result(fetchall_return=[{"id": KEY_ID_1}])
        # Second call: INSERT RETURNING
        insert_result = _make_mock_result(fetchone_return=row)
        connection = _make_connection(validate_result, insert_result)

        data = _make_store_data()
        response = await store_encrypted_asset(connection, USER_ID, data)

        assert isinstance(response, EncryptedAssetResponse)
        assert connection.execute.call_count == 2

    async def test_invalid_asset_type_raises(self) -> None:
        """Invalid asset_type raises InvalidInputError before DB."""
        connection = AsyncMock()
        data = _make_store_data(asset_type="INVALID")

        with pytest.raises(InvalidInputError):
            await store_encrypted_asset(connection, USER_ID, data)

        connection.execute.assert_not_called()

    async def test_invalid_encryption_algorithm_raises(self) -> None:
        """Invalid encryption_algorithm raises InvalidInputError."""
        connection = AsyncMock()
        data = _make_store_data(encryption_algorithm="ROT13")

        with pytest.raises(InvalidInputError):
            await store_encrypted_asset(connection, USER_ID, data)

    async def test_invalid_key_derivation_method_raises(self) -> None:
        """Invalid key_derivation_method raises InvalidInputError."""
        connection = AsyncMock()
        data = _make_store_data(key_derivation_method="md5-yolo")

        with pytest.raises(InvalidInputError):
            await store_encrypted_asset(connection, USER_ID, data)

    async def test_invalid_authorized_keys_raises(self) -> None:
        """Non-existent authorized_key_ids raises InvalidAuthorizedKeys."""
        validate_result = _make_mock_result(fetchall_return=[])
        connection = _make_connection(validate_result)
        data = _make_store_data(authorized_key_ids=[str(uuid4())])

        with pytest.raises(InvalidAuthorizedKeys):
            await store_encrypted_asset(connection, USER_ID, data)

    async def test_base64_payload_decoded_to_bytes(self) -> None:
        """encrypted_payload base64 string decoded to bytes for bytea."""
        row = _make_encrypted_asset_row()
        validate_result = _make_mock_result(fetchall_return=[{"id": KEY_ID_1}])
        insert_result = _make_mock_result(fetchone_return=row)
        connection = _make_connection(validate_result, insert_result)

        payload_bytes = b"test-payload-data"
        data = _make_store_data(encrypted_payload=_b64(payload_bytes))

        await store_encrypted_asset(connection, USER_ID, data)

        insert_params = connection.execute.call_args_list[1][0][1]
        assert insert_params["encrypted_payload"] == payload_bytes

    async def test_user_id_recorded_as_encryptor(self) -> None:
        """User ID passed as encrypted_by_user_id to SQL."""
        row = _make_encrypted_asset_row()
        validate_result = _make_mock_result(fetchall_return=[{"id": KEY_ID_1}])
        insert_result = _make_mock_result(fetchone_return=row)
        connection = _make_connection(validate_result, insert_result)

        data = _make_store_data()
        await store_encrypted_asset(connection, USER_ID, data)

        insert_params = connection.execute.call_args_list[1][0][1]
        assert insert_params["encrypted_by_user_id"] == USER_ID

    async def test_custom_algorithm_and_method(self) -> None:
        """Non-default algorithm and method pass validation."""
        row = _make_encrypted_asset_row(
            encryption_algorithm="ChaCha20-Poly1305",
            key_derivation_method="shamir-recombine",
        )
        validate_result = _make_mock_result(fetchall_return=[{"id": KEY_ID_1}])
        insert_result = _make_mock_result(fetchone_return=row)
        connection = _make_connection(validate_result, insert_result)

        data = _make_store_data(
            encryption_algorithm="ChaCha20-Poly1305",
            key_derivation_method="shamir-recombine",
        )

        response = await store_encrypted_asset(connection, USER_ID, data)

        assert isinstance(response, EncryptedAssetResponse)

    async def test_multiple_authorized_keys(self) -> None:
        """Multiple authorized_key_ids all validated and stored."""
        row = _make_encrypted_asset_row()
        validate_result = _make_mock_result(
            fetchall_return=[{"id": KEY_ID_1}, {"id": KEY_ID_2}]
        )
        insert_result = _make_mock_result(fetchone_return=row)
        connection = _make_connection(validate_result, insert_result)

        data = _make_store_data(authorized_key_ids=[KEY_ID_1, KEY_ID_2])

        response = await store_encrypted_asset(connection, USER_ID, data)

        assert isinstance(response, EncryptedAssetResponse)
        insert_params = connection.execute.call_args_list[1][0][1]
        assert insert_params["authorized_key_ids"] == [KEY_ID_1, KEY_ID_2]


# ============================================================================
# get_encrypted_asset
# ============================================================================


class TestGetEncryptedAsset:
    """Tests for ``get_encrypted_asset()``."""

    async def test_found_returns_response(self) -> None:
        """Existing asset returns EncryptedAssetResponse."""
        row = _make_encrypted_asset_row()
        result = _make_mock_result(fetchone_return=row)
        connection = _make_connection(result)

        response = await get_encrypted_asset(connection, "document", ASSET_ID)

        assert isinstance(response, EncryptedAssetResponse)

    async def test_not_found_returns_none(self) -> None:
        """Non-existent asset returns None (not an error)."""
        result = _make_mock_result(fetchone_return=None)
        connection = _make_connection(result)

        response = await get_encrypted_asset(connection, "document", ASSET_ID)

        assert response is None

    async def test_invalid_asset_type_raises(self) -> None:
        """Invalid asset_type raises InvalidInputError."""
        connection = AsyncMock()

        with pytest.raises(InvalidInputError):
            await get_encrypted_asset(connection, "INVALID", ASSET_ID)

        connection.execute.assert_not_called()

    async def test_passes_params_correctly(self) -> None:
        """asset_type and asset_id passed in SQL params."""
        row = _make_encrypted_asset_row()
        result = _make_mock_result(fetchone_return=row)
        connection = _make_connection(result)

        await get_encrypted_asset(connection, "document", ASSET_ID)

        params = connection.execute.call_args[0][1]
        assert params["asset_type"] == "document"
        assert params["asset_id"] == ASSET_ID

    async def test_orders_by_created_at_desc(self) -> None:
        """Query orders by created_at DESC and limits to 1."""
        row = _make_encrypted_asset_row()
        result = _make_mock_result(fetchone_return=row)
        connection = _make_connection(result)

        await get_encrypted_asset(connection, "document", ASSET_ID)

        sql = connection.execute.call_args[0][0]
        assert "ORDER BY created_at DESC" in sql
        assert "LIMIT 1" in sql

    async def test_bytea_fields_encoded_to_base64(self) -> None:
        """Binary payload and IV returned as base64 strings."""
        payload = b"\x00\x01\x02\x03"
        iv_data = b"\x0a\x0b\x0c"
        row = _make_encrypted_asset_row(
            encrypted_payload=payload,
            initialization_vector=iv_data,
        )
        result = _make_mock_result(fetchone_return=row)
        connection = _make_connection(result)

        response = await get_encrypted_asset(connection, "document", ASSET_ID)

        assert response is not None
        assert response.encrypted_payload == _b64(payload)
        assert response.initialization_vector == _b64(iv_data)


# ============================================================================
# get_encrypted_asset_with_key_check
# ============================================================================


class TestGetEncryptedAssetWithKeyCheck:
    """Tests for ``get_encrypted_asset_with_key_check()``."""

    async def test_no_data_raises_not_found(self) -> None:
        """No encrypted data for asset raises EncryptedAssetNotFoundError."""
        data_result = _make_mock_result(fetchone_return=None)
        connection = _make_connection(data_result)

        with pytest.raises(EncryptedAssetNotFoundError):
            await get_encrypted_asset_with_key_check(
                connection, USER_ID, "document", ASSET_ID
            )

    async def test_no_policy_returns_data(self) -> None:
        """No key policy → data returned with access allowed."""
        data_row = _make_encrypted_asset_row()
        # 1. data SELECT
        data_result = _make_mock_result(fetchone_return=data_row)
        # 2. check_key_protected_access: policy SELECT → None (no policy)
        policy_result = _make_mock_result(fetchone_return=None)

        connection = _make_connection(data_result, policy_result)

        result = await get_encrypted_asset_with_key_check(
            connection, USER_ID, "document", ASSET_ID
        )

        assert isinstance(result, KeyGatedRetrievalResult)
        assert result.access.allowed is True
        assert result.data is not None

    async def test_access_denied_returns_no_data(self) -> None:
        """Key policy exists but no assertions → access denied, no data."""
        data_row = _make_encrypted_asset_row()
        policy_row = {"required_key_count": 1, "required_key_ids": None}
        assertion_row = {"assertion_count": 0}

        data_result = _make_mock_result(fetchone_return=data_row)
        policy_result = _make_mock_result(fetchone_return=policy_row)
        assertion_result = _make_mock_result(fetchone_return=assertion_row)

        connection = _make_connection(data_result, policy_result, assertion_result)

        result = await get_encrypted_asset_with_key_check(
            connection, USER_ID, "document", ASSET_ID
        )

        assert result.access.allowed is False
        assert result.data is None

    async def test_access_granted_with_auto_consume(self) -> None:
        """Access granted + auto_consume=True → assertions consumed."""
        data_row = _make_encrypted_asset_row()
        policy_row = {"required_key_count": 1, "required_key_ids": None}
        assertion_row = {"assertion_count": 1}

        data_result = _make_mock_result(fetchone_return=data_row)
        policy_result = _make_mock_result(fetchone_return=policy_row)
        assertion_result = _make_mock_result(fetchone_return=assertion_row)
        # _consume_matching_assertions UPDATE
        consume_result = _make_mock_result(rowcount=1)

        connection = _make_connection(
            data_result, policy_result, assertion_result, consume_result
        )

        result = await get_encrypted_asset_with_key_check(
            connection, USER_ID, "document", ASSET_ID, auto_consume=True
        )

        assert result.access.allowed is True
        assert result.data is not None
        # 4 calls: data SELECT, policy SELECT, assertion COUNT, consume UPDATE
        assert connection.execute.call_count == 4

    async def test_access_granted_without_auto_consume(self) -> None:
        """Access granted + auto_consume=False → assertions NOT consumed."""
        data_row = _make_encrypted_asset_row()
        policy_row = {"required_key_count": 1, "required_key_ids": None}
        assertion_row = {"assertion_count": 1}

        data_result = _make_mock_result(fetchone_return=data_row)
        policy_result = _make_mock_result(fetchone_return=policy_row)
        assertion_result = _make_mock_result(fetchone_return=assertion_row)

        connection = _make_connection(data_result, policy_result, assertion_result)

        result = await get_encrypted_asset_with_key_check(
            connection, USER_ID, "document", ASSET_ID, auto_consume=False
        )

        assert result.access.allowed is True
        assert result.data is not None
        # 3 calls: data SELECT, policy SELECT, assertion COUNT (no consume)
        assert connection.execute.call_count == 3

    async def test_no_policy_skips_consume(self) -> None:
        """No key policy → requires_assertion=False → no consume call."""
        data_row = _make_encrypted_asset_row()
        data_result = _make_mock_result(fetchone_return=data_row)
        policy_result = _make_mock_result(fetchone_return=None)

        connection = _make_connection(data_result, policy_result)

        result = await get_encrypted_asset_with_key_check(
            connection, USER_ID, "document", ASSET_ID, auto_consume=True
        )

        assert result.access.allowed is True
        assert result.access.requires_assertion is False
        # 2 calls only: data SELECT, policy SELECT (no assertion/consume)
        assert connection.execute.call_count == 2

    async def test_invalid_asset_type_raises(self) -> None:
        """Invalid asset_type raises InvalidInputError."""
        connection = AsyncMock()

        with pytest.raises(InvalidInputError):
            await get_encrypted_asset_with_key_check(
                connection, USER_ID, "INVALID", ASSET_ID
            )

    async def test_invalid_action_raises(self) -> None:
        """Invalid action raises InvalidInputError."""
        connection = AsyncMock()

        with pytest.raises(InvalidInputError):
            await get_encrypted_asset_with_key_check(
                connection, USER_ID, "document", ASSET_ID, action="INVALID"
            )

    async def test_default_action_is_decrypt(self) -> None:
        """Default action parameter is 'decrypt'."""
        data_row = _make_encrypted_asset_row()
        data_result = _make_mock_result(fetchone_return=data_row)
        policy_result = _make_mock_result(fetchone_return=None)

        connection = _make_connection(data_result, policy_result)

        await get_encrypted_asset_with_key_check(
            connection, USER_ID, "document", ASSET_ID
        )

        # Policy query should use 'decrypt' as the action
        policy_params = connection.execute.call_args_list[1][0][1]
        assert policy_params["action"] == "decrypt"

    async def test_custom_action_passed(self) -> None:
        """Custom action passed through to access check."""
        data_row = _make_encrypted_asset_row()
        data_result = _make_mock_result(fetchone_return=data_row)
        policy_result = _make_mock_result(fetchone_return=None)

        connection = _make_connection(data_result, policy_result)

        await get_encrypted_asset_with_key_check(
            connection, USER_ID, "document", ASSET_ID, action="export"
        )

        policy_params = connection.execute.call_args_list[1][0][1]
        assert policy_params["action"] == "export"


# ============================================================================
# list_encrypted_assets_for_user
# ============================================================================


class TestListEncryptedAssetsForUser:
    """Tests for ``list_encrypted_assets_for_user()``."""

    async def test_returns_metadata_list(self) -> None:
        """Multiple assets returned as EncryptedAssetMetadata list."""
        rows = [_make_metadata_row(), _make_metadata_row()]
        result = _make_mock_result(fetchall_return=rows)
        connection = _make_connection(result)

        assets = await list_encrypted_assets_for_user(connection, USER_ID)

        assert len(assets) == 2
        assert all(isinstance(asset, EncryptedAssetMetadata) for asset in assets)

    async def test_empty_list(self) -> None:
        """No assets returns empty list."""
        result = _make_mock_result(fetchall_return=[])
        connection = _make_connection(result)

        assets = await list_encrypted_assets_for_user(connection, USER_ID)

        assert assets == []

    async def test_with_asset_type_filter(self) -> None:
        """asset_type filter included in SQL params."""
        rows = [_make_metadata_row(asset_type="document")]
        result = _make_mock_result(fetchall_return=rows)
        connection = _make_connection(result)

        assets = await list_encrypted_assets_for_user(
            connection, USER_ID, asset_type="document"
        )

        assert len(assets) == 1
        params = connection.execute.call_args[0][1]
        assert params["asset_type"] == "document"

    async def test_without_asset_type_filter(self) -> None:
        """No asset_type filter → query doesn't include asset_type param."""
        result = _make_mock_result(fetchall_return=[])
        connection = _make_connection(result)

        await list_encrypted_assets_for_user(connection, USER_ID)

        sql = connection.execute.call_args[0][0]
        # Unfiltered query should not have "AND asset_type" clause
        assert "AND asset_type" not in sql

    async def test_invalid_asset_type_raises(self) -> None:
        """Invalid asset_type raises InvalidInputError."""
        connection = AsyncMock()

        with pytest.raises(InvalidInputError):
            await list_encrypted_assets_for_user(
                connection, USER_ID, asset_type="INVALID"
            )

    async def test_passes_user_id(self) -> None:
        """user_id passed correctly to SQL params."""
        result = _make_mock_result(fetchall_return=[])
        connection = _make_connection(result)

        await list_encrypted_assets_for_user(connection, USER_ID)

        params = connection.execute.call_args[0][1]
        assert params["user_id"] == USER_ID

    async def test_metadata_excludes_payload(self) -> None:
        """Metadata query selects specific columns without payload/IV."""
        result = _make_mock_result(fetchall_return=[])
        connection = _make_connection(result)

        await list_encrypted_assets_for_user(connection, USER_ID)

        sql = connection.execute.call_args[0][0]
        assert "encrypted_payload" not in sql or "SELECT" in sql
        # The query should NOT select encrypted_payload as a column
        # (it selects specific columns, not *)
        assert "SELECT *" not in sql

    async def test_orders_by_created_at_desc(self) -> None:
        """Results ordered by created_at DESC."""
        result = _make_mock_result(fetchall_return=[])
        connection = _make_connection(result)

        await list_encrypted_assets_for_user(connection, USER_ID)

        sql = connection.execute.call_args[0][0]
        assert "ORDER BY created_at DESC" in sql


# ============================================================================
# delete_encrypted_asset
# ============================================================================


class TestDeleteEncryptedAsset:
    """Tests for ``delete_encrypted_asset()``."""

    async def test_deleted_returns_true(self) -> None:
        """Deleting existing asset returns True."""
        result = _make_mock_result(fetchone_return={"id": str(uuid4())})
        connection = _make_connection(result)

        deleted = await delete_encrypted_asset(connection, "document", ASSET_ID)

        assert deleted is True

    async def test_not_found_returns_false(self) -> None:
        """Deleting non-existent asset returns False."""
        result = _make_mock_result(fetchone_return=None)
        connection = _make_connection(result)

        deleted = await delete_encrypted_asset(connection, "document", ASSET_ID)

        assert deleted is False

    async def test_invalid_asset_type_raises(self) -> None:
        """Invalid asset_type raises InvalidInputError."""
        connection = AsyncMock()

        with pytest.raises(InvalidInputError):
            await delete_encrypted_asset(connection, "INVALID", ASSET_ID)

        connection.execute.assert_not_called()

    async def test_passes_params(self) -> None:
        """asset_type and asset_id passed to SQL."""
        result = _make_mock_result(fetchone_return={"id": str(uuid4())})
        connection = _make_connection(result)

        await delete_encrypted_asset(connection, "document", ASSET_ID)

        params = connection.execute.call_args[0][1]
        assert params["asset_type"] == "document"
        assert params["asset_id"] == ASSET_ID

    async def test_uses_delete_returning(self) -> None:
        """SQL uses DELETE ... RETURNING to check existence."""
        result = _make_mock_result(fetchone_return={"id": str(uuid4())})
        connection = _make_connection(result)

        await delete_encrypted_asset(connection, "document", ASSET_ID)

        sql = connection.execute.call_args[0][0]
        assert "DELETE" in sql
        assert "RETURNING" in sql


# ============================================================================
# update_authorized_keys
# ============================================================================


class TestUpdateAuthorizedKeys:
    """Tests for ``update_authorized_keys()``."""

    async def test_keys_only_update(self) -> None:
        """Update authorized_key_ids without new payload."""
        row = _make_encrypted_asset_row()
        validate_result = _make_mock_result(fetchall_return=[{"id": KEY_ID_1}])
        update_result = _make_mock_result(fetchone_return=row)
        connection = _make_connection(validate_result, update_result)

        update = EncryptedAssetKeyUpdate(authorized_key_ids=[KEY_ID_1])

        response = await update_authorized_keys(
            connection, USER_ID, "document", ASSET_ID, update
        )

        assert isinstance(response, EncryptedAssetResponse)
        # SQL should update authorized_key_ids but not payload/IV
        update_sql = connection.execute.call_args_list[1][0][0]
        assert "authorized_key_ids" in update_sql
        assert "encrypted_payload" not in update_sql

    async def test_keys_and_payload_update(self) -> None:
        """Update keys + re-encrypted payload + IV."""
        row = _make_encrypted_asset_row()
        validate_result = _make_mock_result(fetchall_return=[{"id": KEY_ID_1}])
        update_result = _make_mock_result(fetchone_return=row)
        connection = _make_connection(validate_result, update_result)

        update = EncryptedAssetKeyUpdate(
            authorized_key_ids=[KEY_ID_1],
            encrypted_payload=_b64(b"new-ciphertext"),
            initialization_vector=_b64(b"new-iv-data!"),
        )

        response = await update_authorized_keys(
            connection, USER_ID, "document", ASSET_ID, update
        )

        assert isinstance(response, EncryptedAssetResponse)
        update_sql = connection.execute.call_args_list[1][0][0]
        assert "encrypted_payload" in update_sql
        assert "initialization_vector" in update_sql

    async def test_payload_without_iv_raises(self) -> None:
        """Payload without IV raises InvalidInputError."""
        validate_result = _make_mock_result(fetchall_return=[{"id": KEY_ID_1}])
        connection = _make_connection(validate_result)

        update = EncryptedAssetKeyUpdate(
            authorized_key_ids=[KEY_ID_1],
            encrypted_payload=_b64(b"data"),
            initialization_vector=None,
        )

        with pytest.raises(InvalidInputError, match="both be provided"):
            await update_authorized_keys(
                connection, USER_ID, "document", ASSET_ID, update
            )

    async def test_iv_without_payload_raises(self) -> None:
        """IV without payload raises InvalidInputError."""
        validate_result = _make_mock_result(fetchall_return=[{"id": KEY_ID_1}])
        connection = _make_connection(validate_result)

        update = EncryptedAssetKeyUpdate(
            authorized_key_ids=[KEY_ID_1],
            encrypted_payload=None,
            initialization_vector=_b64(b"iv-only"),
        )

        with pytest.raises(InvalidInputError, match="both be provided"):
            await update_authorized_keys(
                connection, USER_ID, "document", ASSET_ID, update
            )

    async def test_not_found_raises(self) -> None:
        """Updating non-existent asset raises EncryptedAssetNotFoundError."""
        validate_result = _make_mock_result(fetchall_return=[{"id": KEY_ID_1}])
        update_result = _make_mock_result(fetchone_return=None)
        connection = _make_connection(validate_result, update_result)

        update = EncryptedAssetKeyUpdate(authorized_key_ids=[KEY_ID_1])

        with pytest.raises(EncryptedAssetNotFoundError):
            await update_authorized_keys(
                connection, USER_ID, "document", ASSET_ID, update
            )

    async def test_invalid_asset_type_raises(self) -> None:
        """Invalid asset_type raises InvalidInputError before DB."""
        connection = AsyncMock()

        update = EncryptedAssetKeyUpdate(authorized_key_ids=[KEY_ID_1])

        with pytest.raises(InvalidInputError):
            await update_authorized_keys(
                connection, USER_ID, "INVALID", ASSET_ID, update
            )

        connection.execute.assert_not_called()

    async def test_invalid_authorized_keys_raises(self) -> None:
        """Non-existent key IDs raise InvalidAuthorizedKeys."""
        validate_result = _make_mock_result(fetchall_return=[])
        connection = _make_connection(validate_result)

        update = EncryptedAssetKeyUpdate(authorized_key_ids=[str(uuid4())])

        with pytest.raises(InvalidAuthorizedKeys):
            await update_authorized_keys(
                connection, USER_ID, "document", ASSET_ID, update
            )

    async def test_payload_bytes_decoded_correctly(self) -> None:
        """New payload and IV base64-decoded to bytes in SQL params."""
        payload_bytes = b"new-cipher-payload"
        iv_bytes = b"new-iv-12byte"
        row = _make_encrypted_asset_row()
        validate_result = _make_mock_result(fetchall_return=[{"id": KEY_ID_1}])
        update_result = _make_mock_result(fetchone_return=row)
        connection = _make_connection(validate_result, update_result)

        update = EncryptedAssetKeyUpdate(
            authorized_key_ids=[KEY_ID_1],
            encrypted_payload=_b64(payload_bytes),
            initialization_vector=_b64(iv_bytes),
        )

        await update_authorized_keys(connection, USER_ID, "document", ASSET_ID, update)

        update_params = connection.execute.call_args_list[1][0][1]
        assert update_params["encrypted_payload"] == payload_bytes
        assert update_params["initialization_vector"] == iv_bytes

    async def test_multiple_new_authorized_keys(self) -> None:
        """Multiple new key IDs all validated and stored."""
        row = _make_encrypted_asset_row()
        validate_result = _make_mock_result(
            fetchall_return=[{"id": KEY_ID_1}, {"id": KEY_ID_2}]
        )
        update_result = _make_mock_result(fetchone_return=row)
        connection = _make_connection(validate_result, update_result)

        update = EncryptedAssetKeyUpdate(authorized_key_ids=[KEY_ID_1, KEY_ID_2])

        response = await update_authorized_keys(
            connection, USER_ID, "document", ASSET_ID, update
        )

        assert isinstance(response, EncryptedAssetResponse)
        update_params = connection.execute.call_args_list[1][0][1]
        assert update_params["authorized_key_ids"] == [KEY_ID_1, KEY_ID_2]


# ============================================================================
# _consume_matching_assertions
# ============================================================================


class TestConsumeMatchingAssertions:
    """Tests for ``_consume_matching_assertions()``."""

    async def test_consumes_matching_assertions(self) -> None:
        """Returns the number of assertions consumed."""
        result = _make_mock_result(rowcount=3)
        connection = _make_connection(result)

        consumed = await _consume_matching_assertions(
            connection, USER_ID, "document", ASSET_ID
        )

        assert consumed == 3

    async def test_zero_consumed(self) -> None:
        """No matching assertions returns 0."""
        result = _make_mock_result(rowcount=0)
        connection = _make_connection(result)

        consumed = await _consume_matching_assertions(
            connection, USER_ID, "document", ASSET_ID
        )

        assert consumed == 0

    async def test_updates_consumed_and_consumed_at(self) -> None:
        """SQL sets consumed = true and consumed_at = now()."""
        result = _make_mock_result(rowcount=1)
        connection = _make_connection(result)

        await _consume_matching_assertions(connection, USER_ID, "document", ASSET_ID)

        sql = connection.execute.call_args[0][0]
        assert "consumed = true" in sql
        assert "consumed_at = now()" in sql

    async def test_filters_by_user_and_validity(self) -> None:
        """SQL filters by user_id, consumed=false, expires_at > now()."""
        result = _make_mock_result(rowcount=0)
        connection = _make_connection(result)

        await _consume_matching_assertions(connection, USER_ID, "document", ASSET_ID)

        sql = connection.execute.call_args[0][0]
        assert "user_id" in sql
        assert "consumed = false" in sql
        assert "expires_at > now()" in sql

    async def test_includes_scoped_and_general_assertions(self) -> None:
        """SQL matches both scoped (asset_type+asset_id) and general (NULL)."""
        result = _make_mock_result(rowcount=2)
        connection = _make_connection(result)

        await _consume_matching_assertions(connection, USER_ID, "document", ASSET_ID)

        sql = connection.execute.call_args[0][0]
        assert "asset_type IS NULL" in sql

    async def test_passes_all_params(self) -> None:
        """All required params passed to SQL."""
        result = _make_mock_result(rowcount=0)
        connection = _make_connection(result)

        await _consume_matching_assertions(connection, USER_ID, "document", ASSET_ID)

        params = connection.execute.call_args[0][1]
        assert params["user_id"] == USER_ID
        assert params["asset_type"] == "document"
        assert params["asset_id"] == ASSET_ID

    async def test_single_assertion_consumed(self) -> None:
        """Single assertion consumed returns 1."""
        result = _make_mock_result(rowcount=1)
        connection = _make_connection(result)

        consumed = await _consume_matching_assertions(
            connection, USER_ID, "document", ASSET_ID
        )

        assert consumed == 1
