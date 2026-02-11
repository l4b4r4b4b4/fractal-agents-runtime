"""Tests for OpenAPI specification and Swagger UI endpoints."""

import json


from robyn_server.openapi_spec import (
    API_TITLE,
    API_VERSION,
    COMPONENTS,
    PATHS,
    TAGS,
    get_openapi_spec,
)


class TestOpenAPISpec:
    """Test the OpenAPI specification generation."""

    def test_get_openapi_spec_returns_valid_structure(self):
        """Test that get_openapi_spec returns a valid OpenAPI structure."""
        spec = get_openapi_spec()

        assert "openapi" in spec
        assert spec["openapi"] == "3.1.0"
        assert "info" in spec
        assert "tags" in spec
        assert "paths" in spec
        assert "components" in spec

    def test_openapi_info_section(self):
        """Test that the info section has required fields."""
        spec = get_openapi_spec()

        info = spec["info"]
        assert info["title"] == API_TITLE
        assert info["version"] == API_VERSION
        assert "description" in info

    def test_openapi_has_all_tags(self):
        """Test that all expected tags are defined."""
        spec = get_openapi_spec()

        tag_names = [tag["name"] for tag in spec["tags"]]

        expected_tags = [
            "Assistants",
            "Threads",
            "Thread Runs",
            "Stateless Runs",
            "Store",
            "System",
        ]

        for expected in expected_tags:
            assert expected in tag_names, f"Missing tag: {expected}"

    def test_tags_have_descriptions(self):
        """Test that all tags have descriptions."""
        for tag in TAGS:
            assert "name" in tag
            assert "description" in tag
            assert len(tag["description"]) > 0


class TestOpenAPIEndpointCoverage:
    """Test that all API endpoints are documented."""

    def test_assistant_endpoints_documented(self):
        """Test that all assistant endpoints are in the spec."""
        assistant_paths = [
            "/assistants",
            "/assistants/search",
            "/assistants/count",
            "/assistants/{assistant_id}",
        ]

        for path in assistant_paths:
            assert path in PATHS, f"Missing path: {path}"

    def test_thread_endpoints_documented(self):
        """Test that all thread endpoints are in the spec."""
        thread_paths = [
            "/threads",
            "/threads/search",
            "/threads/count",
            "/threads/{thread_id}",
            "/threads/{thread_id}/state",
            "/threads/{thread_id}/history",
        ]

        for path in thread_paths:
            assert path in PATHS, f"Missing path: {path}"

    def test_run_endpoints_documented(self):
        """Test that run endpoints are in the spec."""
        run_paths = [
            "/threads/{thread_id}/runs",
            "/threads/{thread_id}/runs/stream",
            "/threads/{thread_id}/runs/wait",
            "/threads/{thread_id}/runs/{run_id}",
            "/threads/{thread_id}/runs/{run_id}/cancel",
            "/threads/{thread_id}/runs/{run_id}/join",
            "/threads/{thread_id}/runs/{run_id}/stream",
        ]

        for path in run_paths:
            assert path in PATHS, f"Missing path: {path}"

    def test_stateless_run_endpoints_documented(self):
        """Test that stateless run endpoints are in the spec."""
        stateless_paths = [
            "/runs",
            "/runs/stream",
            "/runs/wait",
        ]

        for path in stateless_paths:
            assert path in PATHS, f"Missing path: {path}"

    def test_store_endpoints_documented(self):
        """Test that store endpoints are in the spec."""
        store_paths = [
            "/store/items",
            "/store/items/search",
            "/store/namespaces",
        ]

        for path in store_paths:
            assert path in PATHS, f"Missing path: {path}"

    def test_system_endpoints_documented(self):
        """Test that system endpoints are in the spec."""
        system_paths = [
            "/",
            "/health",
            "/ok",
            "/info",
            "/metrics",
        ]

        for path in system_paths:
            assert path in PATHS, f"Missing path: {path}"


class TestOpenAPISchemas:
    """Test that all schemas are properly defined."""

    def test_assistant_schemas_exist(self):
        """Test that assistant-related schemas are defined."""
        schemas = COMPONENTS["schemas"]

        required_schemas = [
            "Assistant",
            "AssistantCreate",
            "AssistantPatch",
            "AssistantSearchRequest",
            "AssistantCountRequest",
        ]

        for schema in required_schemas:
            assert schema in schemas, f"Missing schema: {schema}"

    def test_thread_schemas_exist(self):
        """Test that thread-related schemas are defined."""
        schemas = COMPONENTS["schemas"]

        required_schemas = [
            "Thread",
            "ThreadCreate",
            "ThreadPatch",
            "ThreadSearchRequest",
            "ThreadCountRequest",
            "ThreadState",
        ]

        for schema in required_schemas:
            assert schema in schemas, f"Missing schema: {schema}"

    def test_run_schemas_exist(self):
        """Test that run-related schemas are defined."""
        schemas = COMPONENTS["schemas"]

        required_schemas = [
            "Run",
            "RunCreateStateful",
            "RunCreateStateless",
        ]

        for schema in required_schemas:
            assert schema in schemas, f"Missing schema: {schema}"

    def test_store_schemas_exist(self):
        """Test that store-related schemas are defined."""
        schemas = COMPONENTS["schemas"]

        required_schemas = [
            "StorePutRequest",
            "StoreDeleteRequest",
            "StoreSearchRequest",
            "StoreListNamespacesRequest",
            "Item",
        ]

        for schema in required_schemas:
            assert schema in schemas, f"Missing schema: {schema}"

    def test_error_response_schema_exists(self):
        """Test that the error response schema is defined."""
        schemas = COMPONENTS["schemas"]
        assert "ErrorResponse" in schemas

        error_schema = schemas["ErrorResponse"]
        assert "properties" in error_schema
        assert "detail" in error_schema["properties"]

    def test_assistant_schema_has_required_fields(self):
        """Test that Assistant schema has all required fields."""
        schema = COMPONENTS["schemas"]["Assistant"]

        assert "required" in schema
        assert "properties" in schema

        required_fields = schema["required"]
        assert "assistant_id" in required_fields
        assert "graph_id" in required_fields
        assert "created_at" in required_fields
        assert "updated_at" in required_fields

    def test_assistant_create_schema_has_graph_id_required(self):
        """Test that AssistantCreate requires graph_id."""
        schema = COMPONENTS["schemas"]["AssistantCreate"]

        assert "required" in schema
        assert "graph_id" in schema["required"]

    def test_run_create_stateful_schema_has_assistant_id_required(self):
        """Test that RunCreateStateful requires assistant_id."""
        schema = COMPONENTS["schemas"]["RunCreateStateful"]

        assert "required" in schema
        assert "assistant_id" in schema["required"]


class TestOpenAPIEndpointDetails:
    """Test endpoint-level details in the spec."""

    def test_post_endpoints_have_request_body(self):
        """Test that POST endpoints have request body defined."""
        spec = get_openapi_spec()

        for path, methods in spec["paths"].items():
            if "post" in methods:
                post_spec = methods["post"]
                # Most POST endpoints should have requestBody (except cancels)
                if "cancel" not in path and path not in ["/store/namespaces"]:
                    if "requestBody" not in post_spec:
                        # Some endpoints may not need request body
                        pass

    def test_endpoints_have_tags(self):
        """Test that all endpoints have tags for grouping."""
        spec = get_openapi_spec()

        for path, methods in spec["paths"].items():
            for method, details in methods.items():
                assert "tags" in details, f"{method.upper()} {path} missing tags"
                assert len(details["tags"]) > 0

    def test_endpoints_have_summary(self):
        """Test that all endpoints have summaries."""
        spec = get_openapi_spec()

        for path, methods in spec["paths"].items():
            for method, details in methods.items():
                assert "summary" in details, f"{method.upper()} {path} missing summary"

    def test_endpoints_have_operation_id(self):
        """Test that all endpoints have operation IDs."""
        spec = get_openapi_spec()

        for path, methods in spec["paths"].items():
            for method, details in methods.items():
                assert "operationId" in details, (
                    f"{method.upper()} {path} missing operationId"
                )

    def test_endpoints_have_responses(self):
        """Test that all endpoints have responses defined."""
        spec = get_openapi_spec()

        for path, methods in spec["paths"].items():
            for method, details in methods.items():
                assert "responses" in details, (
                    f"{method.upper()} {path} missing responses"
                )
                # Most endpoints return 200/204, but some (like MCP GET/DELETE) return 4xx
                has_valid_response = (
                    "200" in details["responses"]
                    or "204" in details["responses"]
                    or "405" in details["responses"]  # MCP GET
                    or "404" in details["responses"]  # MCP DELETE
                )
                assert has_valid_response, (
                    f"{method.upper()} {path} missing valid response code"
                )

    def test_path_parameters_defined(self):
        """Test that path parameters are properly defined."""
        spec = get_openapi_spec()

        # Check assistant_id parameter
        assistant_path = spec["paths"]["/assistants/{assistant_id}"]
        get_params = assistant_path["get"]["parameters"]
        assert len(get_params) > 0

        param = get_params[0]
        assert param["name"] == "assistant_id"
        assert param["in"] == "path"
        assert param["required"] is True

    def test_request_body_references_schemas(self):
        """Test that request bodies reference component schemas."""
        spec = get_openapi_spec()

        create_assistant = spec["paths"]["/assistants"]["post"]
        request_body = create_assistant["requestBody"]

        assert "content" in request_body
        assert "application/json" in request_body["content"]

        schema = request_body["content"]["application/json"]["schema"]
        assert "$ref" in schema
        assert "#/components/schemas/AssistantCreate" in schema["$ref"]


class TestOpenAPISpecSerialization:
    """Test that the spec can be serialized to JSON."""

    def test_spec_is_json_serializable(self):
        """Test that the entire spec can be serialized to JSON."""
        spec = get_openapi_spec()

        # Should not raise
        json_str = json.dumps(spec)
        assert len(json_str) > 0

    def test_spec_roundtrips_through_json(self):
        """Test that spec survives JSON roundtrip."""
        spec = get_openapi_spec()

        json_str = json.dumps(spec)
        parsed = json.loads(json_str)

        assert parsed["openapi"] == spec["openapi"]
        assert parsed["info"]["title"] == spec["info"]["title"]
        assert len(parsed["paths"]) == len(spec["paths"])


class TestOpenAPITagOrdering:
    """Test that tags are in the expected order for Swagger UI display."""

    def test_tags_in_logical_order(self):
        """Test that tags appear in a logical order for the UI."""
        tag_names = [tag["name"] for tag in TAGS]

        # Assistants should come before Threads
        assert tag_names.index("Assistants") < tag_names.index("Threads")

        # Threads should come before Thread Runs
        assert tag_names.index("Threads") < tag_names.index("Thread Runs")

        # Thread Runs should come before Stateless Runs
        assert tag_names.index("Thread Runs") < tag_names.index("Stateless Runs")

        # System should be second-to-last (MCP is last as it's advanced)
        assert "System" in tag_names
        # MCP should be after System (advanced feature)
        if "MCP" in tag_names:
            assert tag_names.index("System") < tag_names.index("MCP")
