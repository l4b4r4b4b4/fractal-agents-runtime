"""Hardware key management API routes for Robyn server.

Implements endpoints for:
- Hardware key registration, listing, update, and deactivation
- Key assertion recording, status checking, listing, and consumption
- Asset key policy CRUD
- Encrypted asset data storage, retrieval (with key-gated access), listing, and deletion
- Authorized key rotation on encrypted assets

All endpoints require JWT authentication via the ``require_user()`` middleware.
Service-layer Pydantic models are used directly for request/response serialization.

See also:
    - ``server/hardware_key_service.py`` — Key CRUD and assertion management
    - ``server/encryption_service.py`` — Encrypted asset data management
    - ``Task-06-Python-Key-Routes/scratchpad.md`` — Design rationale
"""

import json
import logging

from pydantic import ValidationError
from robyn import Request, Response, Robyn

from server.auth import AuthenticationError, require_user
from server.database import get_connection
from server.encryption_service import (
    EncryptedAssetKeyUpdate,
    EncryptedAssetNotFoundError,
    EncryptedAssetStore,
    InvalidAuthorizedKeys,
    KeyAssertionRequired,
    delete_encrypted_asset,
    get_encrypted_asset,
    get_encrypted_asset_with_key_check,
    list_encrypted_assets_for_user,
    store_encrypted_asset,
    update_authorized_keys,
)
from server.hardware_key_service import (
    AssetKeyPolicyCreate,
    AssertionConsumedError,
    AssertionExpiredError,
    AssertionNotFoundError,
    AssertionRecord,
    HardwareKeyConflictError,
    HardwareKeyError,
    HardwareKeyNotFoundError,
    HardwareKeyRegistration,
    HardwareKeyUpdate,
    InvalidInputError,
    PolicyConflictError,
    check_key_protected_access,
    consume_assertion,
    create_asset_key_policy,
    deactivate_hardware_key,
    delete_asset_key_policy,
    get_asset_key_policy,
    get_hardware_key,
    list_asset_key_policies,
    list_user_hardware_keys,
    list_valid_assertions,
    record_assertion,
    register_hardware_key,
    update_hardware_key,
)
from server.routes.helpers import error_response, json_response, parse_json_body

logger = logging.getLogger(__name__)


def register_hardware_key_routes(app: Robyn) -> None:
    """Register hardware key management routes with the Robyn app.

    Registers 18 endpoints under the ``/keys/`` prefix covering:
    - Key CRUD (register, list, get, update, deactivate)
    - Assertion management (record, list, status, consume)
    - Asset key policies (create, list, get, delete)
    - Encrypted asset data (store, get, list, delete, rotate keys)

    Args:
        app: Robyn application instance.
    """

    # ====================================================================
    # Hardware Key CRUD
    # ====================================================================

    @app.post("/keys/register")
    async def route_register_hardware_key(request: Request) -> Response:
        """Register a new hardware key for the authenticated user.

        Request body: HardwareKeyRegistration
        Response: HardwareKeyResponse (201) or error (4xx)
        """
        try:
            user = require_user()
        except AuthenticationError as authentication_error:
            return error_response(authentication_error.message, 401)

        try:
            body = parse_json_body(request)
            registration = HardwareKeyRegistration(**body)
        except json.JSONDecodeError:
            return error_response("Invalid JSON in request body", 422)
        except ValidationError as validation_error:
            return error_response(str(validation_error), 422)

        try:
            async with get_connection() as connection:
                hardware_key = await register_hardware_key(
                    connection, user.identity, registration
                )
            return json_response(hardware_key, status_code=201)
        except HardwareKeyConflictError as conflict_error:
            return error_response(conflict_error.message, 409)
        except InvalidInputError as input_error:
            return error_response(input_error.message, 400)
        except HardwareKeyError as service_error:
            return error_response(service_error.message, service_error.status_code)
        except Exception:
            logger.exception("Unexpected error registering hardware key")
            return error_response("Internal server error", 500)

    @app.get("/keys")
    async def route_list_hardware_keys(request: Request) -> Response:
        """List hardware keys for the authenticated user.

        Query params:
            include_inactive: "true" to include deactivated keys (default: false)

        Response: list[HardwareKeyResponse] (200)
        """
        try:
            user = require_user()
        except AuthenticationError as authentication_error:
            return error_response(authentication_error.message, 401)

        query_params = request.query_params
        raw_include_inactive = query_params.get("include_inactive")
        if raw_include_inactive is not None:
            include_inactive = raw_include_inactive.lower() in ("true", "1", "yes")
        else:
            include_inactive = False

        try:
            async with get_connection() as connection:
                keys = await list_user_hardware_keys(
                    connection, user.identity, include_inactive=include_inactive
                )
            return json_response(keys)
        except HardwareKeyError as service_error:
            return error_response(service_error.message, service_error.status_code)
        except Exception:
            logger.exception("Unexpected error listing hardware keys")
            return error_response("Internal server error", 500)

    @app.get("/keys/:key_id")
    async def route_get_hardware_key(request: Request) -> Response:
        """Get a specific hardware key by ID.

        Response: HardwareKeyResponse (200) or error (404)
        """
        try:
            user = require_user()
        except AuthenticationError as authentication_error:
            return error_response(authentication_error.message, 401)

        key_id = request.path_params.get("key_id")
        if not key_id:
            return error_response("key_id is required", 422)

        try:
            async with get_connection() as connection:
                hardware_key = await get_hardware_key(connection, user.identity, key_id)
            return json_response(hardware_key)
        except HardwareKeyNotFoundError:
            return error_response(f"Hardware key {key_id} not found", 404)
        except HardwareKeyError as service_error:
            return error_response(service_error.message, service_error.status_code)
        except Exception:
            logger.exception("Unexpected error getting hardware key")
            return error_response("Internal server error", 500)

    @app.patch("/keys/:key_id")
    async def route_update_hardware_key(request: Request) -> Response:
        """Update mutable metadata on a hardware key.

        Request body: HardwareKeyUpdate (friendly_name, device_type)
        Response: HardwareKeyResponse (200) or error (4xx)
        """
        try:
            user = require_user()
        except AuthenticationError as authentication_error:
            return error_response(authentication_error.message, 401)

        key_id = request.path_params.get("key_id")
        if not key_id:
            return error_response("key_id is required", 422)

        try:
            body = parse_json_body(request)
            updates = HardwareKeyUpdate(**body)
        except json.JSONDecodeError:
            return error_response("Invalid JSON in request body", 422)
        except ValidationError as validation_error:
            return error_response(str(validation_error), 422)

        try:
            async with get_connection() as connection:
                hardware_key = await update_hardware_key(
                    connection, user.identity, key_id, updates
                )
            return json_response(hardware_key)
        except HardwareKeyNotFoundError:
            return error_response(f"Hardware key {key_id} not found", 404)
        except InvalidInputError as input_error:
            return error_response(input_error.message, 400)
        except HardwareKeyError as service_error:
            return error_response(service_error.message, service_error.status_code)
        except Exception:
            logger.exception("Unexpected error updating hardware key")
            return error_response("Internal server error", 500)

    @app.delete("/keys/:key_id")
    async def route_deactivate_hardware_key(request: Request) -> Response:
        """Soft-deactivate a hardware key (set is_active=false).

        The key remains in the database for audit purposes but cannot
        be used for new assertions.

        Response: {"deactivated": true, "key": HardwareKeyResponse} (200) or error (404)
        """
        try:
            user = require_user()
        except AuthenticationError as authentication_error:
            return error_response(authentication_error.message, 401)

        key_id = request.path_params.get("key_id")
        if not key_id:
            return error_response("key_id is required", 422)

        try:
            async with get_connection() as connection:
                hardware_key = await deactivate_hardware_key(
                    connection, user.identity, key_id
                )
            return json_response(
                {"deactivated": True, "key": hardware_key.model_dump(mode="json")}
            )
        except HardwareKeyNotFoundError:
            return error_response(f"Hardware key {key_id} not found", 404)
        except HardwareKeyError as service_error:
            return error_response(service_error.message, service_error.status_code)
        except Exception:
            logger.exception("Unexpected error deactivating hardware key")
            return error_response("Internal server error", 500)

    # ====================================================================
    # Key Assertion Management
    # ====================================================================

    @app.post("/keys/assertions")
    async def route_record_assertion(request: Request) -> Response:
        """Record a verified key assertion.

        In production the Supabase Edge Function verifies the WebAuthn
        assertion cryptographically and then calls this endpoint (or
        inserts directly via SECURITY DEFINER). This endpoint exists
        for dev/testing and for forwarding verified assertions from
        the Edge Function into the runtime's assertion table.

        Note: key_assertions has NO INSERT RLS — the service_role
        connection (superuser) used here bypasses RLS, so INSERT works.

        Request body: AssertionRecord (hardware_key_id, challenge, asset_type?, asset_id?)
        Response: AssertionResponse (201) or error (4xx)
        """
        try:
            user = require_user()
        except AuthenticationError as authentication_error:
            return error_response(authentication_error.message, 401)

        try:
            body = parse_json_body(request)
            assertion_data = AssertionRecord(**body)
        except json.JSONDecodeError:
            return error_response("Invalid JSON in request body", 422)
        except ValidationError as validation_error:
            return error_response(str(validation_error), 422)

        try:
            async with get_connection() as connection:
                assertion = await record_assertion(
                    connection, user.identity, assertion_data
                )
            return json_response(assertion, status_code=201)
        except HardwareKeyNotFoundError as not_found_error:
            return error_response(not_found_error.message, 404)
        except InvalidInputError as input_error:
            return error_response(input_error.message, 400)
        except HardwareKeyError as service_error:
            return error_response(service_error.message, service_error.status_code)
        except Exception:
            logger.exception("Unexpected error recording assertion")
            return error_response("Internal server error", 500)

    @app.get("/keys/assertions")
    async def route_list_assertions(request: Request) -> Response:
        """List valid (unexpired, unconsumed) assertions for the authenticated user.

        Query params:
            asset_type: Optional asset type filter
            asset_id: Optional asset UUID filter

        Response: list[AssertionResponse] (200)
        """
        try:
            user = require_user()
        except AuthenticationError as authentication_error:
            return error_response(authentication_error.message, 401)

        query_params = request.query_params
        asset_type = query_params.get("asset_type")
        asset_id = query_params.get("asset_id")

        try:
            async with get_connection() as connection:
                assertions = await list_valid_assertions(
                    connection,
                    user.identity,
                    asset_type=asset_type,
                    asset_id=asset_id,
                )
            return json_response(assertions)
        except HardwareKeyError as service_error:
            return error_response(service_error.message, service_error.status_code)
        except Exception:
            logger.exception("Unexpected error listing assertions")
            return error_response("Internal server error", 500)

    @app.get("/keys/assertions/status")
    async def route_check_assertion_status(request: Request) -> Response:
        """Check whether the user has sufficient key assertions for a protected action.

        The frontend calls this before attempting a protected operation to
        determine if a hardware key touch is needed.

        Query params (required):
            asset_type: Asset type to check
            asset_id: Asset UUID to check
        Query params (optional):
            action: Protected action to check (default: "decrypt")

        Response: KeyProtectedAccessResult (200) or error (4xx)
        """
        try:
            user = require_user()
        except AuthenticationError as authentication_error:
            return error_response(authentication_error.message, 401)

        query_params = request.query_params
        asset_type = query_params.get("asset_type")
        asset_id = query_params.get("asset_id")
        raw_action = query_params.get("action")
        if raw_action is not None:
            action = raw_action
        else:
            action = "decrypt"

        if not asset_type:
            return error_response("asset_type query parameter is required", 422)
        if not asset_id:
            return error_response("asset_id query parameter is required", 422)

        try:
            async with get_connection() as connection:
                access_result = await check_key_protected_access(
                    connection, user.identity, asset_type, asset_id, action
                )
            return json_response(access_result)
        except InvalidInputError as input_error:
            return error_response(input_error.message, 400)
        except HardwareKeyError as service_error:
            return error_response(service_error.message, service_error.status_code)
        except Exception:
            logger.exception("Unexpected error checking assertion status")
            return error_response("Internal server error", 500)

    @app.post("/keys/assertions/:assertion_id/consume")
    async def route_consume_assertion(request: Request) -> Response:
        """Mark a key assertion as consumed (single-use).

        A consumed assertion cannot be reused. This is typically called
        automatically during key-gated retrieval, but can also be called
        explicitly by the client.

        Response: AssertionResponse (200) or error (4xx)
        """
        try:
            user = require_user()
        except AuthenticationError as authentication_error:
            return error_response(authentication_error.message, 401)

        assertion_id = request.path_params.get("assertion_id")
        if not assertion_id:
            return error_response("assertion_id is required", 422)

        try:
            async with get_connection() as connection:
                assertion = await consume_assertion(
                    connection, user.identity, assertion_id
                )
            return json_response(assertion)
        except AssertionNotFoundError:
            return error_response(f"Assertion {assertion_id} not found", 404)
        except AssertionConsumedError:
            return error_response(
                f"Assertion {assertion_id} has already been consumed", 410
            )
        except AssertionExpiredError:
            return error_response(f"Assertion {assertion_id} has expired", 410)
        except HardwareKeyError as service_error:
            return error_response(service_error.message, service_error.status_code)
        except Exception:
            logger.exception("Unexpected error consuming assertion")
            return error_response("Internal server error", 500)

    # ====================================================================
    # Asset Key Policies
    # ====================================================================

    @app.post("/keys/policies")
    async def route_create_policy(request: Request) -> Response:
        """Create a key policy requiring hardware key touch for an asset operation.

        Request body: AssetKeyPolicyCreate (asset_type, asset_id, protected_action,
            required_key_count?, required_key_ids?)
        Response: AssetKeyPolicyResponse (201) or error (4xx)
        """
        try:
            user = require_user()
        except AuthenticationError as authentication_error:
            return error_response(authentication_error.message, 401)

        try:
            body = parse_json_body(request)
            policy_data = AssetKeyPolicyCreate(**body)
        except json.JSONDecodeError:
            return error_response("Invalid JSON in request body", 422)
        except ValidationError as validation_error:
            return error_response(str(validation_error), 422)

        try:
            async with get_connection() as connection:
                policy = await create_asset_key_policy(
                    connection, user.identity, policy_data
                )
            return json_response(policy, status_code=201)
        except PolicyConflictError as conflict_error:
            return error_response(conflict_error.message, 409)
        except InvalidInputError as input_error:
            return error_response(input_error.message, 400)
        except HardwareKeyError as service_error:
            return error_response(service_error.message, service_error.status_code)
        except Exception:
            logger.exception("Unexpected error creating key policy")
            return error_response("Internal server error", 500)

    @app.get("/keys/policies")
    async def route_list_policies(request: Request) -> Response:
        """List key policies for a specific asset.

        Query params (required):
            asset_type: Asset type to query
            asset_id: Asset UUID to query

        Response: list[AssetKeyPolicyResponse] (200) or error (4xx)
        """
        try:
            require_user()
        except AuthenticationError as authentication_error:
            return error_response(authentication_error.message, 401)

        query_params = request.query_params
        asset_type = query_params.get("asset_type")
        asset_id = query_params.get("asset_id")

        if not asset_type:
            return error_response("asset_type query parameter is required", 422)
        if not asset_id:
            return error_response("asset_id query parameter is required", 422)

        try:
            async with get_connection() as connection:
                policies = await list_asset_key_policies(
                    connection, asset_type, asset_id
                )
            return json_response(policies)
        except InvalidInputError as input_error:
            return error_response(input_error.message, 400)
        except HardwareKeyError as service_error:
            return error_response(service_error.message, service_error.status_code)
        except Exception:
            logger.exception("Unexpected error listing key policies")
            return error_response("Internal server error", 500)

    @app.get("/keys/policies/:policy_id")
    async def route_get_policy(request: Request) -> Response:
        """Get a specific asset key policy by ID.

        Response: AssetKeyPolicyResponse (200) or error (404)
        """
        try:
            require_user()
        except AuthenticationError as authentication_error:
            return error_response(authentication_error.message, 401)

        policy_id = request.path_params.get("policy_id")
        if not policy_id:
            return error_response("policy_id is required", 422)

        try:
            async with get_connection() as connection:
                policy = await get_asset_key_policy(connection, policy_id)
            if policy is None:
                return error_response(f"Policy {policy_id} not found", 404)
            return json_response(policy)
        except HardwareKeyError as service_error:
            return error_response(service_error.message, service_error.status_code)
        except Exception:
            logger.exception("Unexpected error getting key policy")
            return error_response("Internal server error", 500)

    @app.delete("/keys/policies/:policy_id")
    async def route_delete_policy(request: Request) -> Response:
        """Delete an asset key policy.

        Response: {"deleted": true} (200) or error (404)
        """
        try:
            require_user()
        except AuthenticationError as authentication_error:
            return error_response(authentication_error.message, 401)

        policy_id = request.path_params.get("policy_id")
        if not policy_id:
            return error_response("policy_id is required", 422)

        try:
            async with get_connection() as connection:
                deleted = await delete_asset_key_policy(connection, policy_id)
            if not deleted:
                return error_response(f"Policy {policy_id} not found", 404)
            return json_response({"deleted": True})
        except HardwareKeyError as service_error:
            return error_response(service_error.message, service_error.status_code)
        except Exception:
            logger.exception("Unexpected error deleting key policy")
            return error_response("Internal server error", 500)

    # ====================================================================
    # Encrypted Asset Data
    # ====================================================================

    @app.post("/keys/encrypted-data")
    async def route_store_encrypted_asset(request: Request) -> Response:
        """Store a client-side encrypted asset payload.

        The server stores the ciphertext, IV, algorithm metadata, and
        authorized key list. The server never sees plaintext.

        Request body: EncryptedAssetStore (asset_type, asset_id,
            encrypted_payload, encryption_algorithm?, key_derivation_method?,
            initialization_vector, authorized_key_ids)
        Response: EncryptedAssetResponse (201) or error (4xx)
        """
        try:
            user = require_user()
        except AuthenticationError as authentication_error:
            return error_response(authentication_error.message, 401)

        try:
            body = parse_json_body(request)
            asset_data = EncryptedAssetStore(**body)
        except json.JSONDecodeError:
            return error_response("Invalid JSON in request body", 422)
        except ValidationError as validation_error:
            return error_response(str(validation_error), 422)

        try:
            async with get_connection() as connection:
                encrypted_asset = await store_encrypted_asset(
                    connection, user.identity, asset_data
                )
            return json_response(encrypted_asset, status_code=201)
        except InvalidAuthorizedKeys as invalid_keys_error:
            return error_response(invalid_keys_error.message, 400)
        except InvalidInputError as input_error:
            return error_response(input_error.message, 400)
        except HardwareKeyError as service_error:
            return error_response(service_error.message, service_error.status_code)
        except Exception:
            logger.exception("Unexpected error storing encrypted asset")
            return error_response("Internal server error", 500)

    @app.get("/keys/encrypted-data")
    async def route_list_encrypted_assets(request: Request) -> Response:
        """List encrypted asset metadata for assets encrypted by the current user.

        Returns lightweight metadata (no ciphertext) for listing and discovery.

        Query params (optional):
            asset_type: Filter by asset type

        Response: list[EncryptedAssetMetadata] (200)
        """
        try:
            user = require_user()
        except AuthenticationError as authentication_error:
            return error_response(authentication_error.message, 401)

        query_params = request.query_params
        asset_type = query_params.get("asset_type")

        try:
            async with get_connection() as connection:
                assets = await list_encrypted_assets_for_user(
                    connection, user.identity, asset_type=asset_type
                )
            return json_response(assets)
        except InvalidInputError as input_error:
            return error_response(input_error.message, 400)
        except HardwareKeyError as service_error:
            return error_response(service_error.message, service_error.status_code)
        except Exception:
            logger.exception("Unexpected error listing encrypted assets")
            return error_response("Internal server error", 500)

    @app.get("/keys/encrypted-data/:asset_type/:asset_id")
    async def route_get_encrypted_asset(request: Request) -> Response:
        """Retrieve encrypted asset data, optionally with key-assertion gating.

        When ``require_key_check=true`` (default), the endpoint checks for
        valid hardware key assertions before releasing the ciphertext. If
        the user lacks a valid assertion, returns HTTP 428 with details
        about what key touches are needed.

        When ``require_key_check=false``, returns ciphertext with base
        permission check only (RLS still applies).

        Query params (optional):
            require_key_check: "true" (default) or "false"
            action: Protected action to check (default: "decrypt")
            auto_consume: "true" (default) or "false" — consume assertions on access

        Response: EncryptedAssetResponse or KeyGatedRetrievalResult (200),
            or 428 with assertion details, or 404
        """
        try:
            user = require_user()
        except AuthenticationError as authentication_error:
            return error_response(authentication_error.message, 401)

        asset_type = request.path_params.get("asset_type")
        asset_id = request.path_params.get("asset_id")

        if not asset_type:
            return error_response("asset_type is required", 422)
        if not asset_id:
            return error_response("asset_id is required", 422)

        query_params = request.query_params
        raw_require_key_check = query_params.get("require_key_check")
        if raw_require_key_check is not None:
            require_key_check = raw_require_key_check.lower() in ("true", "1", "yes")
        else:
            require_key_check = True
        raw_action = query_params.get("action")
        if raw_action is not None:
            action = raw_action
        else:
            action = "decrypt"
        raw_auto_consume = query_params.get("auto_consume")
        if raw_auto_consume is not None:
            auto_consume = raw_auto_consume.lower() in ("true", "1", "yes")
        else:
            auto_consume = True

        try:
            async with get_connection() as connection:
                if require_key_check:
                    retrieval_result = await get_encrypted_asset_with_key_check(
                        connection,
                        user.identity,
                        asset_type,
                        asset_id,
                        action=action,
                        auto_consume=auto_consume,
                    )
                    if not retrieval_result.access.allowed:
                        # Return 428 Precondition Required with actionable details
                        error_body = {
                            "detail": "Hardware key assertion required",
                            "asset_type": asset_type,
                            "asset_id": asset_id,
                            "action": action,
                            "requires_assertion": retrieval_result.access.requires_assertion,
                            "required_key_count": retrieval_result.access.required_key_count,
                            "assertions_present": retrieval_result.access.assertions_present,
                            "reason": retrieval_result.access.reason,
                        }
                        return Response(
                            428,
                            {"Content-Type": "application/json"},
                            json.dumps(error_body),
                        )
                    return json_response(retrieval_result)
                else:
                    encrypted_asset = await get_encrypted_asset(
                        connection, asset_type, asset_id
                    )
                    if encrypted_asset is None:
                        return error_response(
                            f"No encrypted data found for {asset_type}/{asset_id}", 404
                        )
                    return json_response(encrypted_asset)
        except EncryptedAssetNotFoundError:
            return error_response(
                f"No encrypted data found for {asset_type}/{asset_id}", 404
            )
        except KeyAssertionRequired as assertion_required_error:
            error_body = {
                "detail": "Hardware key assertion required",
                "asset_type": assertion_required_error.asset_type,
                "asset_id": assertion_required_error.asset_id,
                "action": assertion_required_error.action,
                "required_key_count": assertion_required_error.required_count,
                "assertions_present": assertion_required_error.assertions_present,
            }
            return Response(
                428,
                {"Content-Type": "application/json"},
                json.dumps(error_body),
            )
        except InvalidInputError as input_error:
            return error_response(input_error.message, 400)
        except HardwareKeyError as service_error:
            return error_response(service_error.message, service_error.status_code)
        except Exception:
            logger.exception("Unexpected error retrieving encrypted asset")
            return error_response("Internal server error", 500)

    @app.delete("/keys/encrypted-data/:asset_type/:asset_id")
    async def route_delete_encrypted_asset(request: Request) -> Response:
        """Delete encrypted asset data.

        Response: {"deleted": true} (200) or error (404)
        """
        try:
            require_user()
        except AuthenticationError as authentication_error:
            return error_response(authentication_error.message, 401)

        asset_type = request.path_params.get("asset_type")
        asset_id = request.path_params.get("asset_id")

        if not asset_type:
            return error_response("asset_type is required", 422)
        if not asset_id:
            return error_response("asset_id is required", 422)

        try:
            async with get_connection() as connection:
                deleted = await delete_encrypted_asset(connection, asset_type, asset_id)
            if not deleted:
                return error_response(
                    f"No encrypted data found for {asset_type}/{asset_id}", 404
                )
            return json_response({"deleted": True})
        except InvalidInputError as input_error:
            return error_response(input_error.message, 400)
        except HardwareKeyError as service_error:
            return error_response(service_error.message, service_error.status_code)
        except Exception:
            logger.exception("Unexpected error deleting encrypted asset")
            return error_response("Internal server error", 500)

    @app.patch("/keys/encrypted-data/:asset_type/:asset_id/authorized-keys")
    async def route_update_authorized_keys(request: Request) -> Response:
        """Update authorized keys and optionally the re-encrypted payload.

        Used during key rotation. The client re-wraps the DEK with a new
        KEK and may re-encrypt the payload with a new DEK.

        Response: EncryptedAssetResponse (200) or error (4xx)
        """
        try:
            user = require_user()
        except AuthenticationError as authentication_error:
            return error_response(authentication_error.message, 401)

        asset_type = request.path_params.get("asset_type")
        asset_id = request.path_params.get("asset_id")

        if not asset_type:
            return error_response("asset_type is required", 422)
        if not asset_id:
            return error_response("asset_id is required", 422)

        try:
            body = parse_json_body(request)
            key_update = EncryptedAssetKeyUpdate(**body)
        except json.JSONDecodeError:
            return error_response("Invalid JSON in request body", 422)
        except ValidationError as validation_error:
            return error_response(str(validation_error), 422)

        try:
            async with get_connection() as connection:
                updated_asset = await update_authorized_keys(
                    connection, user.identity, asset_type, asset_id, key_update
                )
            return json_response(updated_asset)
        except EncryptedAssetNotFoundError:
            return error_response(
                f"No encrypted data found for {asset_type}/{asset_id}", 404
            )
        except InvalidAuthorizedKeys as invalid_keys_error:
            return error_response(invalid_keys_error.message, 400)
        except InvalidInputError as input_error:
            return error_response(input_error.message, 400)
        except HardwareKeyError as service_error:
            return error_response(service_error.message, service_error.status_code)
        except Exception:
            logger.exception("Unexpected error updating authorized keys")
            return error_response("Internal server error", 500)
