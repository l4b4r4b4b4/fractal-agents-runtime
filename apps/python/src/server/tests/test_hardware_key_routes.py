"""Route handler tests for hardware key management endpoints.

Tests exercise the Robyn route handler closures directly using the
``RouteCapture`` harness. All external dependencies (auth, storage, DB)
are patched so no real server or database is needed.

Coverage targets:
- Key CRUD: register, list, get, update, deactivate
- Assertion management: record, list, status, consume
- Asset key policies: create, list, get, delete
- Encrypted asset data: store, list, get (with/without key check), delete, rotate keys
- Error paths: 401, 404, 409, 410, 422, 428, 500
"""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, patch

import pytest

from server.tests.conftest_routes import (
    MockRequest,
    RouteCapture,
    make_auth_user,
    response_json,
)


# ---------------------------------------------------------------------------
# Constants and helpers
# ---------------------------------------------------------------------------

USER = make_auth_user("user-hw-1", "hw@test.com")

_AUTH_TARGET = "server.routes.hardware_keys.require_user"
_CONN_TARGET = "server.routes.hardware_keys.get_connection"

# Service module targets for patching
_HK_SVC = "server.routes.hardware_keys"


def _capture():
    """Build a RouteCapture with hardware key routes registered."""
    from server.routes.hardware_keys import register_hardware_key_routes

    cap = RouteCapture()
    register_hardware_key_routes(cap)
    return cap


def _patch_auth(user=USER):
    return patch(_AUTH_TARGET, return_value=user)


def _patch_auth_error():
    from server.auth import AuthenticationError

    return patch(_AUTH_TARGET, side_effect=AuthenticationError("Unauthorized"))


class _FakeConnection:
    """Async context manager that yields a sentinel connection object."""

    def __init__(self):
        self.conn = object()

    async def __aenter__(self):
        return self.conn

    async def __aexit__(self, *args):
        pass


def _patch_conn():
    return patch(_CONN_TARGET, return_value=_FakeConnection())


# ---------------------------------------------------------------------------
# Fake response models (mimic Pydantic .model_dump / .model_dump_json)
# ---------------------------------------------------------------------------


class _FakeModel:
    """Minimal stand-in that satisfies json_response's Pydantic detection."""

    def __init__(self, data: dict):
        self._data = data

    def model_dump(self, **kwargs):
        return self._data

    def model_dump_json(self, **kwargs):
        return json.dumps(self._data)


def _fake_key_response(**overrides):
    base = {
        "id": "key-001",
        "credential_id": "cred-abc",
        "friendly_name": "My SoloKey",
        "device_type": "solokey",
        "transports": ["usb"],
        "attestation_format": "packed",
        "aaguid": None,
        "is_active": True,
        "last_used_at": None,
        "created_at": "2026-01-01T00:00:00Z",
        "updated_at": "2026-01-01T00:00:00Z",
    }
    base.update(overrides)
    return _FakeModel(base)


def _fake_assertion_response(**overrides):
    base = {
        "assertion_id": "assert-001",
        "hardware_key_id": "key-001",
        "expires_at": "2026-01-01T00:05:00Z",
        "consumed": False,
        "asset_type": None,
        "asset_id": None,
    }
    base.update(overrides)
    return _FakeModel(base)


def _fake_policy_response(**overrides):
    base = {
        "id": "pol-001",
        "asset_type": "document",
        "asset_id": "doc-001",
        "protected_action": "decrypt",
        "required_key_count": 1,
        "required_key_ids": None,
        "created_by_user_id": "user-hw-1",
        "created_at": "2026-01-01T00:00:00Z",
        "updated_at": "2026-01-01T00:00:00Z",
    }
    base.update(overrides)
    return _FakeModel(base)


def _fake_access_result(allowed=True, **overrides):
    base = {
        "allowed": allowed,
        "reason": "Access granted",
        "requires_assertion": False,
        "required_key_count": None,
        "assertions_present": None,
    }
    base.update(overrides)
    return _FakeModel(base)


def _fake_encrypted_asset_response(**overrides):
    base = {
        "id": "enc-001",
        "asset_type": "document",
        "asset_id": "doc-001",
        "encrypted_payload": "Y2lwaGVydGV4dA==",
        "encryption_algorithm": "AES-GCM-256",
        "key_derivation_method": "webauthn-prf-hkdf",
        "initialization_vector": "aXYxMjM=",
        "authorized_key_ids": ["key-001"],
        "encrypted_by_user_id": "user-hw-1",
        "created_at": "2026-01-01T00:00:00Z",
        "updated_at": "2026-01-01T00:00:00Z",
    }
    base.update(overrides)
    return _FakeModel(base)


def _fake_encrypted_asset_metadata(**overrides):
    base = {
        "id": "enc-001",
        "asset_type": "document",
        "asset_id": "doc-001",
        "encryption_algorithm": "AES-GCM-256",
        "key_derivation_method": "webauthn-prf-hkdf",
        "authorized_key_ids": ["key-001"],
        "encrypted_by_user_id": "user-hw-1",
        "created_at": "2026-01-01T00:00:00Z",
    }
    base.update(overrides)
    return _FakeModel(base)


def _fake_key_gated_result(allowed=True, data=None):
    access = _fake_access_result(allowed=allowed)
    if not allowed:
        access._data.update(
            {
                "requires_assertion": True,
                "required_key_count": 1,
                "assertions_present": 0,
                "reason": "Hardware key assertion required",
            }
        )

    class _Result:
        def __init__(self):
            self.access = type("A", (), access._data)()
            self.data = data

        def model_dump(self, **kwargs):
            result = {"access": access._data, "data": None}
            if data is not None:
                result["data"] = data._data
            return result

        def model_dump_json(self, **kwargs):
            return json.dumps(self.model_dump())

    return _Result()


# ============================================================================
# Key CRUD
# ============================================================================


class TestKeyRegister:
    """POST /keys/register"""

    @pytest.mark.asyncio
    async def test_register_success(self):
        cap = _capture()
        handler = cap.get_handler("POST", "/keys/register")
        body = {
            "credential_id": "cred-abc",
            "public_key": "cHVia2V5",
            "counter": 0,
            "transports": ["usb"],
            "friendly_name": "My Key",
            "device_type": "solokey",
        }
        request = MockRequest(body=body)
        fake_key = _fake_key_response()

        with (
            _patch_auth(),
            _patch_conn(),
            patch(
                f"{_HK_SVC}.register_hardware_key",
                new_callable=AsyncMock,
                return_value=fake_key,
            ),
        ):
            response = await handler(request)

        assert response.status_code == 201
        data = response_json(response)
        assert data["id"] == "key-001"
        assert data["credential_id"] == "cred-abc"

    @pytest.mark.asyncio
    async def test_register_unauthenticated(self):
        cap = _capture()
        handler = cap.get_handler("POST", "/keys/register")
        request = MockRequest(body={"credential_id": "x", "public_key": "y"})

        with _patch_auth_error():
            response = await handler(request)

        assert response.status_code == 401

    @pytest.mark.asyncio
    async def test_register_invalid_json(self):
        cap = _capture()
        handler = cap.get_handler("POST", "/keys/register")
        request = MockRequest(body=b"not-json{{{")

        with _patch_auth():
            response = await handler(request)

        assert response.status_code == 422
        data = response_json(response)
        assert "Invalid JSON" in data["detail"]

    @pytest.mark.asyncio
    async def test_register_validation_error(self):
        cap = _capture()
        handler = cap.get_handler("POST", "/keys/register")
        # Missing required fields
        request = MockRequest(body={"friendly_name": "missing cred"})

        with _patch_auth():
            response = await handler(request)

        assert response.status_code == 422

    @pytest.mark.asyncio
    async def test_register_conflict(self):
        from server.hardware_key_service import HardwareKeyConflictError

        cap = _capture()
        handler = cap.get_handler("POST", "/keys/register")
        body = {
            "credential_id": "cred-dup",
            "public_key": "cHVia2V5",
            "counter": 0,
        }
        request = MockRequest(body=body)

        with (
            _patch_auth(),
            _patch_conn(),
            patch(
                f"{_HK_SVC}.register_hardware_key",
                new_callable=AsyncMock,
                side_effect=HardwareKeyConflictError("cred-dup"),
            ),
        ):
            response = await handler(request)

        assert response.status_code == 409

    @pytest.mark.asyncio
    async def test_register_invalid_input(self):
        from server.hardware_key_service import InvalidInputError

        cap = _capture()
        handler = cap.get_handler("POST", "/keys/register")
        body = {
            "credential_id": "cred-x",
            "public_key": "cHVia2V5",
            "counter": 0,
            "device_type": "invalid_brand",
        }
        request = MockRequest(body=body)

        with (
            _patch_auth(),
            _patch_conn(),
            patch(
                f"{_HK_SVC}.register_hardware_key",
                new_callable=AsyncMock,
                side_effect=InvalidInputError("Invalid device_type"),
            ),
        ):
            response = await handler(request)

        assert response.status_code == 400

    @pytest.mark.asyncio
    async def test_register_unexpected_error(self):
        cap = _capture()
        handler = cap.get_handler("POST", "/keys/register")
        body = {
            "credential_id": "cred-x",
            "public_key": "cHVia2V5",
            "counter": 0,
        }
        request = MockRequest(body=body)

        with (
            _patch_auth(),
            _patch_conn(),
            patch(
                f"{_HK_SVC}.register_hardware_key",
                new_callable=AsyncMock,
                side_effect=RuntimeError("boom"),
            ),
        ):
            response = await handler(request)

        assert response.status_code == 500


class TestKeyList:
    """GET /keys"""

    @pytest.mark.asyncio
    async def test_list_success(self):
        cap = _capture()
        handler = cap.get_handler("GET", "/keys")
        request = MockRequest()

        with (
            _patch_auth(),
            _patch_conn(),
            patch(
                f"{_HK_SVC}.list_user_hardware_keys",
                new_callable=AsyncMock,
                return_value=[_fake_key_response(), _fake_key_response(id="key-002")],
            ),
        ):
            response = await handler(request)

        assert response.status_code == 200
        data = response_json(response)
        assert isinstance(data, list)
        assert len(data) == 2

    @pytest.mark.asyncio
    async def test_list_empty(self):
        cap = _capture()
        handler = cap.get_handler("GET", "/keys")
        request = MockRequest()

        with (
            _patch_auth(),
            _patch_conn(),
            patch(
                f"{_HK_SVC}.list_user_hardware_keys",
                new_callable=AsyncMock,
                return_value=[],
            ),
        ):
            response = await handler(request)

        assert response.status_code == 200
        data = response_json(response)
        assert data == []

    @pytest.mark.asyncio
    async def test_list_include_inactive(self):
        cap = _capture()
        handler = cap.get_handler("GET", "/keys")
        request = MockRequest(query_params={"include_inactive": "true"})
        mock_list = AsyncMock(return_value=[_fake_key_response(is_active=False)])

        with (
            _patch_auth(),
            _patch_conn(),
            patch(f"{_HK_SVC}.list_user_hardware_keys", mock_list),
        ):
            response = await handler(request)

        assert response.status_code == 200
        mock_list.assert_awaited_once()
        call_kwargs = mock_list.call_args
        assert call_kwargs[1]["include_inactive"] is True

    @pytest.mark.asyncio
    async def test_list_unauthenticated(self):
        cap = _capture()
        handler = cap.get_handler("GET", "/keys")
        request = MockRequest()

        with _patch_auth_error():
            response = await handler(request)

        assert response.status_code == 401


class TestKeyGet:
    """GET /keys/:key_id"""

    @pytest.mark.asyncio
    async def test_get_found(self):
        cap = _capture()
        handler = cap.get_handler("GET", "/keys/:key_id")
        request = MockRequest(path_params={"key_id": "key-001"})

        with (
            _patch_auth(),
            _patch_conn(),
            patch(
                f"{_HK_SVC}.get_hardware_key",
                new_callable=AsyncMock,
                return_value=_fake_key_response(),
            ),
        ):
            response = await handler(request)

        assert response.status_code == 200
        data = response_json(response)
        assert data["id"] == "key-001"

    @pytest.mark.asyncio
    async def test_get_not_found(self):
        from server.hardware_key_service import HardwareKeyNotFoundError

        cap = _capture()
        handler = cap.get_handler("GET", "/keys/:key_id")
        request = MockRequest(path_params={"key_id": "missing"})

        with (
            _patch_auth(),
            _patch_conn(),
            patch(
                f"{_HK_SVC}.get_hardware_key",
                new_callable=AsyncMock,
                side_effect=HardwareKeyNotFoundError("missing"),
            ),
        ):
            response = await handler(request)

        assert response.status_code == 404

    @pytest.mark.asyncio
    async def test_get_missing_key_id(self):
        cap = _capture()
        handler = cap.get_handler("GET", "/keys/:key_id")
        request = MockRequest(path_params={})

        with _patch_auth():
            response = await handler(request)

        assert response.status_code == 422

    @pytest.mark.asyncio
    async def test_get_unauthenticated(self):
        cap = _capture()
        handler = cap.get_handler("GET", "/keys/:key_id")
        request = MockRequest(path_params={"key_id": "key-001"})

        with _patch_auth_error():
            response = await handler(request)

        assert response.status_code == 401


class TestKeyUpdate:
    """PATCH /keys/:key_id"""

    @pytest.mark.asyncio
    async def test_update_success(self):
        cap = _capture()
        handler = cap.get_handler("PATCH", "/keys/:key_id")
        request = MockRequest(
            path_params={"key_id": "key-001"},
            body={"friendly_name": "Renamed Key"},
        )

        with (
            _patch_auth(),
            _patch_conn(),
            patch(
                f"{_HK_SVC}.update_hardware_key",
                new_callable=AsyncMock,
                return_value=_fake_key_response(friendly_name="Renamed Key"),
            ),
        ):
            response = await handler(request)

        assert response.status_code == 200
        data = response_json(response)
        assert data["friendly_name"] == "Renamed Key"

    @pytest.mark.asyncio
    async def test_update_not_found(self):
        from server.hardware_key_service import HardwareKeyNotFoundError

        cap = _capture()
        handler = cap.get_handler("PATCH", "/keys/:key_id")
        request = MockRequest(
            path_params={"key_id": "missing"},
            body={"friendly_name": "nope"},
        )

        with (
            _patch_auth(),
            _patch_conn(),
            patch(
                f"{_HK_SVC}.update_hardware_key",
                new_callable=AsyncMock,
                side_effect=HardwareKeyNotFoundError("missing"),
            ),
        ):
            response = await handler(request)

        assert response.status_code == 404

    @pytest.mark.asyncio
    async def test_update_invalid_json(self):
        cap = _capture()
        handler = cap.get_handler("PATCH", "/keys/:key_id")
        request = MockRequest(path_params={"key_id": "key-001"}, body=b"bad{json")

        with _patch_auth():
            response = await handler(request)

        assert response.status_code == 422

    @pytest.mark.asyncio
    async def test_update_missing_key_id(self):
        cap = _capture()
        handler = cap.get_handler("PATCH", "/keys/:key_id")
        request = MockRequest(path_params={}, body={"friendly_name": "x"})

        with _patch_auth():
            response = await handler(request)

        assert response.status_code == 422

    @pytest.mark.asyncio
    async def test_update_invalid_device_type(self):
        from server.hardware_key_service import InvalidInputError

        cap = _capture()
        handler = cap.get_handler("PATCH", "/keys/:key_id")
        request = MockRequest(
            path_params={"key_id": "key-001"},
            body={"device_type": "bad_type"},
        )

        with (
            _patch_auth(),
            _patch_conn(),
            patch(
                f"{_HK_SVC}.update_hardware_key",
                new_callable=AsyncMock,
                side_effect=InvalidInputError("Invalid device_type"),
            ),
        ):
            response = await handler(request)

        assert response.status_code == 400


class TestKeyDeactivate:
    """DELETE /keys/:key_id"""

    @pytest.mark.asyncio
    async def test_deactivate_success(self):
        cap = _capture()
        handler = cap.get_handler("DELETE", "/keys/:key_id")
        request = MockRequest(path_params={"key_id": "key-001"})

        with (
            _patch_auth(),
            _patch_conn(),
            patch(
                f"{_HK_SVC}.deactivate_hardware_key",
                new_callable=AsyncMock,
                return_value=_fake_key_response(is_active=False),
            ),
        ):
            response = await handler(request)

        assert response.status_code == 200
        data = response_json(response)
        assert data["deactivated"] is True
        assert data["key"]["is_active"] is False

    @pytest.mark.asyncio
    async def test_deactivate_not_found(self):
        from server.hardware_key_service import HardwareKeyNotFoundError

        cap = _capture()
        handler = cap.get_handler("DELETE", "/keys/:key_id")
        request = MockRequest(path_params={"key_id": "missing"})

        with (
            _patch_auth(),
            _patch_conn(),
            patch(
                f"{_HK_SVC}.deactivate_hardware_key",
                new_callable=AsyncMock,
                side_effect=HardwareKeyNotFoundError("missing"),
            ),
        ):
            response = await handler(request)

        assert response.status_code == 404

    @pytest.mark.asyncio
    async def test_deactivate_missing_key_id(self):
        cap = _capture()
        handler = cap.get_handler("DELETE", "/keys/:key_id")
        request = MockRequest(path_params={})

        with _patch_auth():
            response = await handler(request)

        assert response.status_code == 422


# ============================================================================
# Assertion Management
# ============================================================================


class TestAssertionRecord:
    """POST /keys/assertions"""

    @pytest.mark.asyncio
    async def test_record_success(self):
        cap = _capture()
        handler = cap.get_handler("POST", "/keys/assertions")
        body = {
            "hardware_key_id": "key-001",
            "challenge": "Y2hhbGxlbmdl",
        }
        request = MockRequest(body=body)

        with (
            _patch_auth(),
            _patch_conn(),
            patch(
                f"{_HK_SVC}.record_assertion",
                new_callable=AsyncMock,
                return_value=_fake_assertion_response(),
            ),
        ):
            response = await handler(request)

        assert response.status_code == 201
        data = response_json(response)
        assert data["assertion_id"] == "assert-001"

    @pytest.mark.asyncio
    async def test_record_scoped_assertion(self):
        cap = _capture()
        handler = cap.get_handler("POST", "/keys/assertions")
        body = {
            "hardware_key_id": "key-001",
            "challenge": "Y2hhbGxlbmdl",
            "asset_type": "document",
            "asset_id": "doc-001",
        }
        request = MockRequest(body=body)
        mock_record = AsyncMock(
            return_value=_fake_assertion_response(
                asset_type="document", asset_id="doc-001"
            )
        )

        with (
            _patch_auth(),
            _patch_conn(),
            patch(f"{_HK_SVC}.record_assertion", mock_record),
        ):
            response = await handler(request)

        assert response.status_code == 201
        data = response_json(response)
        assert data["asset_type"] == "document"
        assert data["asset_id"] == "doc-001"

    @pytest.mark.asyncio
    async def test_record_unauthenticated(self):
        cap = _capture()
        handler = cap.get_handler("POST", "/keys/assertions")
        request = MockRequest(body={"hardware_key_id": "k", "challenge": "c"})

        with _patch_auth_error():
            response = await handler(request)

        assert response.status_code == 401

    @pytest.mark.asyncio
    async def test_record_invalid_json(self):
        cap = _capture()
        handler = cap.get_handler("POST", "/keys/assertions")
        request = MockRequest(body=b"not{json")

        with _patch_auth():
            response = await handler(request)

        assert response.status_code == 422

    @pytest.mark.asyncio
    async def test_record_validation_error(self):
        cap = _capture()
        handler = cap.get_handler("POST", "/keys/assertions")
        # Missing required fields
        request = MockRequest(body={"challenge": "only_challenge"})

        with _patch_auth():
            response = await handler(request)

        assert response.status_code == 422

    @pytest.mark.asyncio
    async def test_record_key_not_found(self):
        from server.hardware_key_service import HardwareKeyNotFoundError

        cap = _capture()
        handler = cap.get_handler("POST", "/keys/assertions")
        body = {"hardware_key_id": "missing", "challenge": "c"}
        request = MockRequest(body=body)

        with (
            _patch_auth(),
            _patch_conn(),
            patch(
                f"{_HK_SVC}.record_assertion",
                new_callable=AsyncMock,
                side_effect=HardwareKeyNotFoundError("missing"),
            ),
        ):
            response = await handler(request)

        assert response.status_code == 404


class TestAssertionList:
    """GET /keys/assertions"""

    @pytest.mark.asyncio
    async def test_list_all(self):
        cap = _capture()
        handler = cap.get_handler("GET", "/keys/assertions")
        request = MockRequest()

        with (
            _patch_auth(),
            _patch_conn(),
            patch(
                f"{_HK_SVC}.list_valid_assertions",
                new_callable=AsyncMock,
                return_value=[_fake_assertion_response()],
            ),
        ):
            response = await handler(request)

        assert response.status_code == 200
        data = response_json(response)
        assert isinstance(data, list)
        assert len(data) == 1

    @pytest.mark.asyncio
    async def test_list_with_asset_filter(self):
        cap = _capture()
        handler = cap.get_handler("GET", "/keys/assertions")
        request = MockRequest(
            query_params={"asset_type": "document", "asset_id": "doc-001"}
        )
        mock_list = AsyncMock(return_value=[])

        with (
            _patch_auth(),
            _patch_conn(),
            patch(f"{_HK_SVC}.list_valid_assertions", mock_list),
        ):
            response = await handler(request)

        assert response.status_code == 200
        call_kwargs = mock_list.call_args
        assert call_kwargs[1]["asset_type"] == "document"
        assert call_kwargs[1]["asset_id"] == "doc-001"

    @pytest.mark.asyncio
    async def test_list_unauthenticated(self):
        cap = _capture()
        handler = cap.get_handler("GET", "/keys/assertions")
        request = MockRequest()

        with _patch_auth_error():
            response = await handler(request)

        assert response.status_code == 401


class TestAssertionStatus:
    """GET /keys/assertions/status"""

    @pytest.mark.asyncio
    async def test_status_allowed(self):
        cap = _capture()
        handler = cap.get_handler("GET", "/keys/assertions/status")
        request = MockRequest(
            query_params={"asset_type": "document", "asset_id": "doc-001"}
        )

        with (
            _patch_auth(),
            _patch_conn(),
            patch(
                f"{_HK_SVC}.check_key_protected_access",
                new_callable=AsyncMock,
                return_value=_fake_access_result(allowed=True),
            ),
        ):
            response = await handler(request)

        assert response.status_code == 200
        data = response_json(response)
        assert data["allowed"] is True

    @pytest.mark.asyncio
    async def test_status_denied(self):
        cap = _capture()
        handler = cap.get_handler("GET", "/keys/assertions/status")
        request = MockRequest(
            query_params={
                "asset_type": "document",
                "asset_id": "doc-001",
                "action": "delete",
            }
        )
        mock_check = AsyncMock(
            return_value=_fake_access_result(
                allowed=False,
                requires_assertion=True,
                required_key_count=1,
                assertions_present=0,
            )
        )

        with (
            _patch_auth(),
            _patch_conn(),
            patch(f"{_HK_SVC}.check_key_protected_access", mock_check),
        ):
            response = await handler(request)

        assert response.status_code == 200
        data = response_json(response)
        assert data["allowed"] is False
        # Verify action was passed
        call_args = mock_check.call_args
        assert call_args[0][4] == "delete"

    @pytest.mark.asyncio
    async def test_status_missing_asset_type(self):
        cap = _capture()
        handler = cap.get_handler("GET", "/keys/assertions/status")
        request = MockRequest(query_params={"asset_id": "doc-001"})

        with _patch_auth():
            response = await handler(request)

        assert response.status_code == 422
        data = response_json(response)
        assert "asset_type" in data["detail"]

    @pytest.mark.asyncio
    async def test_status_missing_asset_id(self):
        cap = _capture()
        handler = cap.get_handler("GET", "/keys/assertions/status")
        request = MockRequest(query_params={"asset_type": "document"})

        with _patch_auth():
            response = await handler(request)

        assert response.status_code == 422
        data = response_json(response)
        assert "asset_id" in data["detail"]

    @pytest.mark.asyncio
    async def test_status_default_action_is_decrypt(self):
        cap = _capture()
        handler = cap.get_handler("GET", "/keys/assertions/status")
        request = MockRequest(
            query_params={"asset_type": "document", "asset_id": "doc-001"}
        )
        mock_check = AsyncMock(return_value=_fake_access_result())

        with (
            _patch_auth(),
            _patch_conn(),
            patch(f"{_HK_SVC}.check_key_protected_access", mock_check),
        ):
            await handler(request)

        call_args = mock_check.call_args
        assert call_args[0][4] == "decrypt"

    @pytest.mark.asyncio
    async def test_status_invalid_input(self):
        from server.hardware_key_service import InvalidInputError

        cap = _capture()
        handler = cap.get_handler("GET", "/keys/assertions/status")
        request = MockRequest(
            query_params={"asset_type": "bogus_type", "asset_id": "doc-001"}
        )

        with (
            _patch_auth(),
            _patch_conn(),
            patch(
                f"{_HK_SVC}.check_key_protected_access",
                new_callable=AsyncMock,
                side_effect=InvalidInputError("Invalid asset_type"),
            ),
        ):
            response = await handler(request)

        assert response.status_code == 400


class TestAssertionConsume:
    """POST /keys/assertions/:assertion_id/consume"""

    @pytest.mark.asyncio
    async def test_consume_success(self):
        cap = _capture()
        handler = cap.get_handler("POST", "/keys/assertions/:assertion_id/consume")
        request = MockRequest(path_params={"assertion_id": "assert-001"})

        with (
            _patch_auth(),
            _patch_conn(),
            patch(
                f"{_HK_SVC}.consume_assertion",
                new_callable=AsyncMock,
                return_value=_fake_assertion_response(consumed=True),
            ),
        ):
            response = await handler(request)

        assert response.status_code == 200
        data = response_json(response)
        assert data["consumed"] is True

    @pytest.mark.asyncio
    async def test_consume_not_found(self):
        from server.hardware_key_service import AssertionNotFoundError

        cap = _capture()
        handler = cap.get_handler("POST", "/keys/assertions/:assertion_id/consume")
        request = MockRequest(path_params={"assertion_id": "missing"})

        with (
            _patch_auth(),
            _patch_conn(),
            patch(
                f"{_HK_SVC}.consume_assertion",
                new_callable=AsyncMock,
                side_effect=AssertionNotFoundError("missing"),
            ),
        ):
            response = await handler(request)

        assert response.status_code == 404

    @pytest.mark.asyncio
    async def test_consume_already_consumed(self):
        from server.hardware_key_service import AssertionConsumedError

        cap = _capture()
        handler = cap.get_handler("POST", "/keys/assertions/:assertion_id/consume")
        request = MockRequest(path_params={"assertion_id": "assert-old"})

        with (
            _patch_auth(),
            _patch_conn(),
            patch(
                f"{_HK_SVC}.consume_assertion",
                new_callable=AsyncMock,
                side_effect=AssertionConsumedError("assert-old"),
            ),
        ):
            response = await handler(request)

        assert response.status_code == 410
        data = response_json(response)
        assert "consumed" in data["detail"]

    @pytest.mark.asyncio
    async def test_consume_expired(self):
        from server.hardware_key_service import AssertionExpiredError

        cap = _capture()
        handler = cap.get_handler("POST", "/keys/assertions/:assertion_id/consume")
        request = MockRequest(path_params={"assertion_id": "assert-exp"})

        with (
            _patch_auth(),
            _patch_conn(),
            patch(
                f"{_HK_SVC}.consume_assertion",
                new_callable=AsyncMock,
                side_effect=AssertionExpiredError("assert-exp"),
            ),
        ):
            response = await handler(request)

        assert response.status_code == 410
        data = response_json(response)
        assert "expired" in data["detail"]

    @pytest.mark.asyncio
    async def test_consume_missing_assertion_id(self):
        cap = _capture()
        handler = cap.get_handler("POST", "/keys/assertions/:assertion_id/consume")
        request = MockRequest(path_params={})

        with _patch_auth():
            response = await handler(request)

        assert response.status_code == 422


# ============================================================================
# Asset Key Policies
# ============================================================================


class TestPolicyCreate:
    """POST /keys/policies"""

    @pytest.mark.asyncio
    async def test_create_success(self):
        cap = _capture()
        handler = cap.get_handler("POST", "/keys/policies")
        body = {
            "asset_type": "document",
            "asset_id": "doc-001",
            "protected_action": "decrypt",
            "required_key_count": 1,
        }
        request = MockRequest(body=body)

        with (
            _patch_auth(),
            _patch_conn(),
            patch(
                f"{_HK_SVC}.create_asset_key_policy",
                new_callable=AsyncMock,
                return_value=_fake_policy_response(),
            ),
        ):
            response = await handler(request)

        assert response.status_code == 201
        data = response_json(response)
        assert data["id"] == "pol-001"

    @pytest.mark.asyncio
    async def test_create_conflict(self):
        from server.hardware_key_service import PolicyConflictError

        cap = _capture()
        handler = cap.get_handler("POST", "/keys/policies")
        body = {
            "asset_type": "document",
            "asset_id": "doc-001",
            "protected_action": "decrypt",
        }
        request = MockRequest(body=body)

        with (
            _patch_auth(),
            _patch_conn(),
            patch(
                f"{_HK_SVC}.create_asset_key_policy",
                new_callable=AsyncMock,
                side_effect=PolicyConflictError("document", "doc-001", "decrypt"),
            ),
        ):
            response = await handler(request)

        assert response.status_code == 409

    @pytest.mark.asyncio
    async def test_create_invalid_input(self):
        from server.hardware_key_service import InvalidInputError

        cap = _capture()
        handler = cap.get_handler("POST", "/keys/policies")
        body = {
            "asset_type": "document",
            "asset_id": "doc-001",
            "protected_action": "decrypt",
            "required_key_count": 0,
        }
        request = MockRequest(body=body)

        with (
            _patch_auth(),
            _patch_conn(),
            patch(
                f"{_HK_SVC}.create_asset_key_policy",
                new_callable=AsyncMock,
                side_effect=InvalidInputError("required_key_count must be >= 1"),
            ),
        ):
            response = await handler(request)

        assert response.status_code == 400

    @pytest.mark.asyncio
    async def test_create_validation_error(self):
        cap = _capture()
        handler = cap.get_handler("POST", "/keys/policies")
        # Missing required fields
        request = MockRequest(body={"asset_type": "document"})

        with _patch_auth():
            response = await handler(request)

        assert response.status_code == 422

    @pytest.mark.asyncio
    async def test_create_unauthenticated(self):
        cap = _capture()
        handler = cap.get_handler("POST", "/keys/policies")
        request = MockRequest(body={})

        with _patch_auth_error():
            response = await handler(request)

        assert response.status_code == 401


class TestPolicyList:
    """GET /keys/policies"""

    @pytest.mark.asyncio
    async def test_list_success(self):
        cap = _capture()
        handler = cap.get_handler("GET", "/keys/policies")
        request = MockRequest(
            query_params={"asset_type": "document", "asset_id": "doc-001"}
        )

        with (
            _patch_auth(),
            _patch_conn(),
            patch(
                f"{_HK_SVC}.list_asset_key_policies",
                new_callable=AsyncMock,
                return_value=[_fake_policy_response()],
            ),
        ):
            response = await handler(request)

        assert response.status_code == 200
        data = response_json(response)
        assert isinstance(data, list)
        assert len(data) == 1

    @pytest.mark.asyncio
    async def test_list_missing_asset_type(self):
        cap = _capture()
        handler = cap.get_handler("GET", "/keys/policies")
        request = MockRequest(query_params={"asset_id": "doc-001"})

        with _patch_auth():
            response = await handler(request)

        assert response.status_code == 422

    @pytest.mark.asyncio
    async def test_list_missing_asset_id(self):
        cap = _capture()
        handler = cap.get_handler("GET", "/keys/policies")
        request = MockRequest(query_params={"asset_type": "document"})

        with _patch_auth():
            response = await handler(request)

        assert response.status_code == 422


class TestPolicyGet:
    """GET /keys/policies/:policy_id"""

    @pytest.mark.asyncio
    async def test_get_found(self):
        cap = _capture()
        handler = cap.get_handler("GET", "/keys/policies/:policy_id")
        request = MockRequest(path_params={"policy_id": "pol-001"})

        with (
            _patch_auth(),
            _patch_conn(),
            patch(
                f"{_HK_SVC}.get_asset_key_policy",
                new_callable=AsyncMock,
                return_value=_fake_policy_response(),
            ),
        ):
            response = await handler(request)

        assert response.status_code == 200
        data = response_json(response)
        assert data["id"] == "pol-001"

    @pytest.mark.asyncio
    async def test_get_not_found(self):
        cap = _capture()
        handler = cap.get_handler("GET", "/keys/policies/:policy_id")
        request = MockRequest(path_params={"policy_id": "missing"})

        with (
            _patch_auth(),
            _patch_conn(),
            patch(
                f"{_HK_SVC}.get_asset_key_policy",
                new_callable=AsyncMock,
                return_value=None,
            ),
        ):
            response = await handler(request)

        assert response.status_code == 404

    @pytest.mark.asyncio
    async def test_get_missing_policy_id(self):
        cap = _capture()
        handler = cap.get_handler("GET", "/keys/policies/:policy_id")
        request = MockRequest(path_params={})

        with _patch_auth():
            response = await handler(request)

        assert response.status_code == 422


class TestPolicyDelete:
    """DELETE /keys/policies/:policy_id"""

    @pytest.mark.asyncio
    async def test_delete_success(self):
        cap = _capture()
        handler = cap.get_handler("DELETE", "/keys/policies/:policy_id")
        request = MockRequest(path_params={"policy_id": "pol-001"})

        with (
            _patch_auth(),
            _patch_conn(),
            patch(
                f"{_HK_SVC}.delete_asset_key_policy",
                new_callable=AsyncMock,
                return_value=True,
            ),
        ):
            response = await handler(request)

        assert response.status_code == 200
        data = response_json(response)
        assert data["deleted"] is True

    @pytest.mark.asyncio
    async def test_delete_not_found(self):
        cap = _capture()
        handler = cap.get_handler("DELETE", "/keys/policies/:policy_id")
        request = MockRequest(path_params={"policy_id": "missing"})

        with (
            _patch_auth(),
            _patch_conn(),
            patch(
                f"{_HK_SVC}.delete_asset_key_policy",
                new_callable=AsyncMock,
                return_value=False,
            ),
        ):
            response = await handler(request)

        assert response.status_code == 404

    @pytest.mark.asyncio
    async def test_delete_missing_policy_id(self):
        cap = _capture()
        handler = cap.get_handler("DELETE", "/keys/policies/:policy_id")
        request = MockRequest(path_params={})

        with _patch_auth():
            response = await handler(request)

        assert response.status_code == 422


# ============================================================================
# Encrypted Asset Data
# ============================================================================


class TestEncryptedDataStore:
    """POST /keys/encrypted-data"""

    @pytest.mark.asyncio
    async def test_store_success(self):
        cap = _capture()
        handler = cap.get_handler("POST", "/keys/encrypted-data")
        body = {
            "asset_type": "document",
            "asset_id": "doc-001",
            "encrypted_payload": "Y2lwaGVydGV4dA==",
            "initialization_vector": "aXYxMjM=",
            "authorized_key_ids": ["key-001"],
        }
        request = MockRequest(body=body)

        with (
            _patch_auth(),
            _patch_conn(),
            patch(
                f"{_HK_SVC}.store_encrypted_asset",
                new_callable=AsyncMock,
                return_value=_fake_encrypted_asset_response(),
            ),
        ):
            response = await handler(request)

        assert response.status_code == 201
        data = response_json(response)
        assert data["id"] == "enc-001"

    @pytest.mark.asyncio
    async def test_store_invalid_keys(self):
        from server.encryption_service import InvalidAuthorizedKeys

        cap = _capture()
        handler = cap.get_handler("POST", "/keys/encrypted-data")
        body = {
            "asset_type": "document",
            "asset_id": "doc-001",
            "encrypted_payload": "Y2lwaGVydGV4dA==",
            "initialization_vector": "aXYxMjM=",
            "authorized_key_ids": ["nonexistent-key"],
        }
        request = MockRequest(body=body)

        with (
            _patch_auth(),
            _patch_conn(),
            patch(
                f"{_HK_SVC}.store_encrypted_asset",
                new_callable=AsyncMock,
                side_effect=InvalidAuthorizedKeys(["nonexistent-key"]),
            ),
        ):
            response = await handler(request)

        assert response.status_code == 400

    @pytest.mark.asyncio
    async def test_store_validation_error(self):
        cap = _capture()
        handler = cap.get_handler("POST", "/keys/encrypted-data")
        # Missing required fields
        request = MockRequest(body={"asset_type": "document"})

        with _patch_auth():
            response = await handler(request)

        assert response.status_code == 422

    @pytest.mark.asyncio
    async def test_store_unauthenticated(self):
        cap = _capture()
        handler = cap.get_handler("POST", "/keys/encrypted-data")
        request = MockRequest(body={})

        with _patch_auth_error():
            response = await handler(request)

        assert response.status_code == 401


class TestEncryptedDataList:
    """GET /keys/encrypted-data"""

    @pytest.mark.asyncio
    async def test_list_all(self):
        cap = _capture()
        handler = cap.get_handler("GET", "/keys/encrypted-data")
        request = MockRequest()

        with (
            _patch_auth(),
            _patch_conn(),
            patch(
                f"{_HK_SVC}.list_encrypted_assets_for_user",
                new_callable=AsyncMock,
                return_value=[_fake_encrypted_asset_metadata()],
            ),
        ):
            response = await handler(request)

        assert response.status_code == 200
        data = response_json(response)
        assert isinstance(data, list)
        assert len(data) == 1

    @pytest.mark.asyncio
    async def test_list_filtered_by_type(self):
        cap = _capture()
        handler = cap.get_handler("GET", "/keys/encrypted-data")
        request = MockRequest(query_params={"asset_type": "chat_session"})
        mock_list = AsyncMock(return_value=[])

        with (
            _patch_auth(),
            _patch_conn(),
            patch(f"{_HK_SVC}.list_encrypted_assets_for_user", mock_list),
        ):
            response = await handler(request)

        assert response.status_code == 200
        call_kwargs = mock_list.call_args
        assert call_kwargs[1]["asset_type"] == "chat_session"


class TestEncryptedDataGet:
    """GET /keys/encrypted-data/:asset_type/:asset_id"""

    @pytest.mark.asyncio
    async def test_get_with_key_check_allowed(self):
        cap = _capture()
        handler = cap.get_handler("GET", "/keys/encrypted-data/:asset_type/:asset_id")
        request = MockRequest(
            path_params={"asset_type": "document", "asset_id": "doc-001"},
        )
        result = _fake_key_gated_result(
            allowed=True, data=_fake_encrypted_asset_response()
        )

        with (
            _patch_auth(),
            _patch_conn(),
            patch(
                f"{_HK_SVC}.get_encrypted_asset_with_key_check",
                new_callable=AsyncMock,
                return_value=result,
            ),
        ):
            response = await handler(request)

        assert response.status_code == 200

    @pytest.mark.asyncio
    async def test_get_with_key_check_denied_returns_428(self):
        cap = _capture()
        handler = cap.get_handler("GET", "/keys/encrypted-data/:asset_type/:asset_id")
        request = MockRequest(
            path_params={"asset_type": "document", "asset_id": "doc-001"},
        )
        result = _fake_key_gated_result(allowed=False)

        with (
            _patch_auth(),
            _patch_conn(),
            patch(
                f"{_HK_SVC}.get_encrypted_asset_with_key_check",
                new_callable=AsyncMock,
                return_value=result,
            ),
        ):
            response = await handler(request)

        assert response.status_code == 428
        data = response_json(response)
        assert data["detail"] == "Hardware key assertion required"
        assert data["asset_type"] == "document"
        assert data["asset_id"] == "doc-001"

    @pytest.mark.asyncio
    async def test_get_without_key_check(self):
        cap = _capture()
        handler = cap.get_handler("GET", "/keys/encrypted-data/:asset_type/:asset_id")
        request = MockRequest(
            path_params={"asset_type": "document", "asset_id": "doc-001"},
            query_params={"require_key_check": "false"},
        )

        with (
            _patch_auth(),
            _patch_conn(),
            patch(
                f"{_HK_SVC}.get_encrypted_asset",
                new_callable=AsyncMock,
                return_value=_fake_encrypted_asset_response(),
            ),
        ):
            response = await handler(request)

        assert response.status_code == 200
        data = response_json(response)
        assert data["id"] == "enc-001"

    @pytest.mark.asyncio
    async def test_get_without_key_check_not_found(self):
        cap = _capture()
        handler = cap.get_handler("GET", "/keys/encrypted-data/:asset_type/:asset_id")
        request = MockRequest(
            path_params={"asset_type": "document", "asset_id": "missing"},
            query_params={"require_key_check": "false"},
        )

        with (
            _patch_auth(),
            _patch_conn(),
            patch(
                f"{_HK_SVC}.get_encrypted_asset",
                new_callable=AsyncMock,
                return_value=None,
            ),
        ):
            response = await handler(request)

        assert response.status_code == 404

    @pytest.mark.asyncio
    async def test_get_with_key_check_asset_not_found(self):
        from server.encryption_service import EncryptedAssetNotFoundError

        cap = _capture()
        handler = cap.get_handler("GET", "/keys/encrypted-data/:asset_type/:asset_id")
        request = MockRequest(
            path_params={"asset_type": "document", "asset_id": "missing"},
        )

        with (
            _patch_auth(),
            _patch_conn(),
            patch(
                f"{_HK_SVC}.get_encrypted_asset_with_key_check",
                new_callable=AsyncMock,
                side_effect=EncryptedAssetNotFoundError("document", "missing"),
            ),
        ):
            response = await handler(request)

        assert response.status_code == 404

    @pytest.mark.asyncio
    async def test_get_custom_action(self):
        cap = _capture()
        handler = cap.get_handler("GET", "/keys/encrypted-data/:asset_type/:asset_id")
        request = MockRequest(
            path_params={"asset_type": "document", "asset_id": "doc-001"},
            query_params={"action": "export"},
        )
        mock_get = AsyncMock(
            return_value=_fake_key_gated_result(
                allowed=True, data=_fake_encrypted_asset_response()
            )
        )

        with (
            _patch_auth(),
            _patch_conn(),
            patch(f"{_HK_SVC}.get_encrypted_asset_with_key_check", mock_get),
        ):
            await handler(request)

        call_kwargs = mock_get.call_args[1]
        assert call_kwargs["action"] == "export"

    @pytest.mark.asyncio
    async def test_get_auto_consume_false(self):
        cap = _capture()
        handler = cap.get_handler("GET", "/keys/encrypted-data/:asset_type/:asset_id")
        request = MockRequest(
            path_params={"asset_type": "document", "asset_id": "doc-001"},
            query_params={"auto_consume": "false"},
        )
        mock_get = AsyncMock(
            return_value=_fake_key_gated_result(
                allowed=True, data=_fake_encrypted_asset_response()
            )
        )

        with (
            _patch_auth(),
            _patch_conn(),
            patch(f"{_HK_SVC}.get_encrypted_asset_with_key_check", mock_get),
        ):
            await handler(request)

        call_kwargs = mock_get.call_args[1]
        assert call_kwargs["auto_consume"] is False

    @pytest.mark.asyncio
    async def test_get_missing_asset_type(self):
        cap = _capture()
        handler = cap.get_handler("GET", "/keys/encrypted-data/:asset_type/:asset_id")
        request = MockRequest(path_params={"asset_id": "doc-001"})

        with _patch_auth():
            response = await handler(request)

        assert response.status_code == 422

    @pytest.mark.asyncio
    async def test_get_missing_asset_id(self):
        cap = _capture()
        handler = cap.get_handler("GET", "/keys/encrypted-data/:asset_type/:asset_id")
        request = MockRequest(path_params={"asset_type": "document"})

        with _patch_auth():
            response = await handler(request)

        assert response.status_code == 422

    @pytest.mark.asyncio
    async def test_get_key_assertion_required_exception(self):
        from server.encryption_service import KeyAssertionRequired

        cap = _capture()
        handler = cap.get_handler("GET", "/keys/encrypted-data/:asset_type/:asset_id")
        request = MockRequest(
            path_params={"asset_type": "document", "asset_id": "doc-001"},
        )

        with (
            _patch_auth(),
            _patch_conn(),
            patch(
                f"{_HK_SVC}.get_encrypted_asset_with_key_check",
                new_callable=AsyncMock,
                side_effect=KeyAssertionRequired(
                    asset_type="document",
                    asset_id="doc-001",
                    action="decrypt",
                    required_count=2,
                    assertions_present=1,
                ),
            ),
        ):
            response = await handler(request)

        assert response.status_code == 428
        data = response_json(response)
        assert data["required_key_count"] == 2
        assert data["assertions_present"] == 1


class TestEncryptedDataDelete:
    """DELETE /keys/encrypted-data/:asset_type/:asset_id"""

    @pytest.mark.asyncio
    async def test_delete_success(self):
        cap = _capture()
        handler = cap.get_handler(
            "DELETE", "/keys/encrypted-data/:asset_type/:asset_id"
        )
        request = MockRequest(
            path_params={"asset_type": "document", "asset_id": "doc-001"}
        )

        with (
            _patch_auth(),
            _patch_conn(),
            patch(
                f"{_HK_SVC}.delete_encrypted_asset",
                new_callable=AsyncMock,
                return_value=True,
            ),
        ):
            response = await handler(request)

        assert response.status_code == 200
        data = response_json(response)
        assert data["deleted"] is True

    @pytest.mark.asyncio
    async def test_delete_not_found(self):
        cap = _capture()
        handler = cap.get_handler(
            "DELETE", "/keys/encrypted-data/:asset_type/:asset_id"
        )
        request = MockRequest(
            path_params={"asset_type": "document", "asset_id": "missing"}
        )

        with (
            _patch_auth(),
            _patch_conn(),
            patch(
                f"{_HK_SVC}.delete_encrypted_asset",
                new_callable=AsyncMock,
                return_value=False,
            ),
        ):
            response = await handler(request)

        assert response.status_code == 404

    @pytest.mark.asyncio
    async def test_delete_missing_asset_type(self):
        cap = _capture()
        handler = cap.get_handler(
            "DELETE", "/keys/encrypted-data/:asset_type/:asset_id"
        )
        request = MockRequest(path_params={"asset_id": "doc-001"})

        with _patch_auth():
            response = await handler(request)

        assert response.status_code == 422


class TestEncryptedDataUpdateAuthorizedKeys:
    """PATCH /keys/encrypted-data/:asset_type/:asset_id/authorized-keys"""

    @pytest.mark.asyncio
    async def test_update_keys_success(self):
        cap = _capture()
        handler = cap.get_handler(
            "PATCH",
            "/keys/encrypted-data/:asset_type/:asset_id/authorized-keys",
        )
        body = {"authorized_key_ids": ["key-001", "key-002"]}
        request = MockRequest(
            path_params={"asset_type": "document", "asset_id": "doc-001"},
            body=body,
        )

        with (
            _patch_auth(),
            _patch_conn(),
            patch(
                f"{_HK_SVC}.update_authorized_keys",
                new_callable=AsyncMock,
                return_value=_fake_encrypted_asset_response(
                    authorized_key_ids=["key-001", "key-002"]
                ),
            ),
        ):
            response = await handler(request)

        assert response.status_code == 200
        data = response_json(response)
        assert "key-002" in data["authorized_key_ids"]

    @pytest.mark.asyncio
    async def test_update_keys_with_new_payload(self):
        cap = _capture()
        handler = cap.get_handler(
            "PATCH",
            "/keys/encrypted-data/:asset_type/:asset_id/authorized-keys",
        )
        body = {
            "authorized_key_ids": ["key-002"],
            "encrypted_payload": "bmV3X2NpcGhlcg==",
            "initialization_vector": "bmV3X2l2",
        }
        request = MockRequest(
            path_params={"asset_type": "document", "asset_id": "doc-001"},
            body=body,
        )
        mock_update = AsyncMock(return_value=_fake_encrypted_asset_response())

        with (
            _patch_auth(),
            _patch_conn(),
            patch(f"{_HK_SVC}.update_authorized_keys", mock_update),
        ):
            response = await handler(request)

        assert response.status_code == 200
        # Verify the update function was called with the key update data
        mock_update.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_update_keys_not_found(self):
        from server.encryption_service import EncryptedAssetNotFoundError

        cap = _capture()
        handler = cap.get_handler(
            "PATCH",
            "/keys/encrypted-data/:asset_type/:asset_id/authorized-keys",
        )
        body = {"authorized_key_ids": ["key-001"]}
        request = MockRequest(
            path_params={"asset_type": "document", "asset_id": "missing"},
            body=body,
        )

        with (
            _patch_auth(),
            _patch_conn(),
            patch(
                f"{_HK_SVC}.update_authorized_keys",
                new_callable=AsyncMock,
                side_effect=EncryptedAssetNotFoundError("document", "missing"),
            ),
        ):
            response = await handler(request)

        assert response.status_code == 404

    @pytest.mark.asyncio
    async def test_update_keys_invalid_keys(self):
        from server.encryption_service import InvalidAuthorizedKeys

        cap = _capture()
        handler = cap.get_handler(
            "PATCH",
            "/keys/encrypted-data/:asset_type/:asset_id/authorized-keys",
        )
        body = {"authorized_key_ids": ["nonexistent"]}
        request = MockRequest(
            path_params={"asset_type": "document", "asset_id": "doc-001"},
            body=body,
        )

        with (
            _patch_auth(),
            _patch_conn(),
            patch(
                f"{_HK_SVC}.update_authorized_keys",
                new_callable=AsyncMock,
                side_effect=InvalidAuthorizedKeys(["nonexistent"]),
            ),
        ):
            response = await handler(request)

        assert response.status_code == 400

    @pytest.mark.asyncio
    async def test_update_keys_invalid_json(self):
        cap = _capture()
        handler = cap.get_handler(
            "PATCH",
            "/keys/encrypted-data/:asset_type/:asset_id/authorized-keys",
        )
        request = MockRequest(
            path_params={"asset_type": "document", "asset_id": "doc-001"},
            body=b"bad{json",
        )

        with _patch_auth():
            response = await handler(request)

        assert response.status_code == 422

    @pytest.mark.asyncio
    async def test_update_keys_validation_error(self):
        cap = _capture()
        handler = cap.get_handler(
            "PATCH",
            "/keys/encrypted-data/:asset_type/:asset_id/authorized-keys",
        )
        # Missing required authorized_key_ids
        request = MockRequest(
            path_params={"asset_type": "document", "asset_id": "doc-001"},
            body={"encrypted_payload": "only_payload"},
        )

        with _patch_auth():
            response = await handler(request)

        assert response.status_code == 422

    @pytest.mark.asyncio
    async def test_update_keys_missing_asset_type(self):
        cap = _capture()
        handler = cap.get_handler(
            "PATCH",
            "/keys/encrypted-data/:asset_type/:asset_id/authorized-keys",
        )
        request = MockRequest(
            path_params={"asset_id": "doc-001"},
            body={"authorized_key_ids": ["key-001"]},
        )

        with _patch_auth():
            response = await handler(request)

        assert response.status_code == 422

    @pytest.mark.asyncio
    async def test_update_keys_unauthenticated(self):
        cap = _capture()
        handler = cap.get_handler(
            "PATCH",
            "/keys/encrypted-data/:asset_type/:asset_id/authorized-keys",
        )
        request = MockRequest(
            path_params={"asset_type": "document", "asset_id": "doc-001"},
            body={"authorized_key_ids": ["key-001"]},
        )

        with _patch_auth_error():
            response = await handler(request)

        assert response.status_code == 401


# ============================================================================
# Route registration
# ============================================================================


class TestRouteRegistration:
    """Verify all expected routes are captured."""

    def test_all_routes_registered(self):
        cap = _capture()
        routes = cap.list_routes()
        route_set = {(method, path) for method, path in routes}

        expected = {
            ("POST", "/keys/register"),
            ("GET", "/keys"),
            ("GET", "/keys/:key_id"),
            ("PATCH", "/keys/:key_id"),
            ("DELETE", "/keys/:key_id"),
            ("POST", "/keys/assertions"),
            ("GET", "/keys/assertions"),
            ("GET", "/keys/assertions/status"),
            ("POST", "/keys/assertions/:assertion_id/consume"),
            ("POST", "/keys/policies"),
            ("GET", "/keys/policies"),
            ("GET", "/keys/policies/:policy_id"),
            ("DELETE", "/keys/policies/:policy_id"),
            ("POST", "/keys/encrypted-data"),
            ("GET", "/keys/encrypted-data"),
            ("GET", "/keys/encrypted-data/:asset_type/:asset_id"),
            ("DELETE", "/keys/encrypted-data/:asset_type/:asset_id"),
            (
                "PATCH",
                "/keys/encrypted-data/:asset_type/:asset_id/authorized-keys",
            ),
        }

        assert route_set == expected, (
            f"Missing routes: {expected - route_set}\n"
            f"Extra routes: {route_set - expected}"
        )

    def test_route_count(self):
        cap = _capture()
        routes = cap.list_routes()
        assert len(routes) == 18
