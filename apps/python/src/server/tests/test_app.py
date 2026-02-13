"""Tests for Robyn application initialization.

These tests verify that the application can be imported and initialized
without errors. This catches issues like:
- Import errors in route modules
- Type annotation errors at runtime (e.g., missing __future__ annotations)
- Configuration errors during app setup
- Route registration failures

These tests act as a safeguard to catch startup errors before deployment.
"""


class TestAppInitialization:
    """Test that the Robyn application initializes correctly."""

    def test_app_module_imports(self):
        """Test that the app module can be imported without errors.

        This catches:
        - Syntax errors
        - Import errors
        - Type annotation errors (like Response | SSEResponse without __future__)
        - Module-level exceptions
        """
        # This import triggers all route registrations at module level
        from server import app  # noqa: F401

        assert app is not None

    def test_app_instance_exists(self):
        """Test that the Robyn app instance is created."""
        from server.app import app

        assert app is not None
        # Verify it's a Robyn instance
        from robyn import Robyn

        assert isinstance(app, Robyn)

    def test_all_route_modules_import(self):
        """Test that all route modules can be imported independently.

        Tests each route module in isolation to identify which module
        has issues if the full app import fails.
        """
        # Core routes
        from server.routes import (  # noqa: F401
            register_assistant_routes,
            register_cron_routes,
            register_run_routes,
            register_stream_routes,
            register_thread_routes,
        )

        # Additional routes
        from server.routes.a2a import register_a2a_routes  # noqa: F401
        from server.routes.mcp import register_mcp_routes  # noqa: F401
        from server.routes.metrics import register_metrics_routes  # noqa: F401
        from server.routes.store import register_store_routes  # noqa: F401

        # All imports successful
        assert True

    def test_route_registration_functions_callable(self):
        """Test that route registration functions are callable."""
        from server.routes import (
            register_assistant_routes,
            register_cron_routes,
            register_run_routes,
            register_stream_routes,
            register_thread_routes,
        )
        from server.routes.a2a import register_a2a_routes
        from server.routes.mcp import register_mcp_routes
        from server.routes.metrics import register_metrics_routes
        from server.routes.store import register_store_routes

        # Verify all are callable
        assert callable(register_assistant_routes)
        assert callable(register_thread_routes)
        assert callable(register_run_routes)
        assert callable(register_stream_routes)
        assert callable(register_cron_routes)
        assert callable(register_a2a_routes)
        assert callable(register_mcp_routes)
        assert callable(register_metrics_routes)
        assert callable(register_store_routes)

    def test_models_import(self):
        """Test that model classes can be imported."""
        from server.models import (  # noqa: F401
            Assistant,
            AssistantConfig,
            HealthResponse,
            Run,
            ServiceInfoResponse,
            Thread,
            ThreadState,
        )

        assert True

    def test_config_module_imports(self):
        """Test that config module loads without errors."""
        from server.config import get_config  # noqa: F401

        config = get_config()
        assert config is not None

    def test_storage_module_imports(self):
        """Test that storage module initializes correctly."""
        from server.storage import get_storage  # noqa: F401

        storage = get_storage()
        assert storage is not None

    def test_auth_module_imports(self):
        """Test that auth module can be imported."""
        from server.auth import (  # noqa: F401
            AuthenticationError,
            auth_middleware,
            require_user,
        )

        assert callable(auth_middleware)
        assert callable(require_user)


class TestHandlerModulesImport:
    """Test that handler modules can be imported."""

    def test_a2a_handlers_import(self):
        """Test A2A handler module imports."""
        from server.a2a import (  # noqa: F401
            A2AMethodHandler,
            JsonRpcErrorCode,
            JsonRpcRequest,
            a2a_handler,
            create_error_response,
        )

        assert True

    def test_crons_handlers_import(self):
        """Test Crons handler module imports."""
        from server.crons import (  # noqa: F401
            CronHandler,
            get_cron_handler,
        )

        assert True

    def test_mcp_handlers_import(self):
        """Test MCP handler module imports."""
        from server.mcp import (  # noqa: F401
            JsonRpcErrorCode,
            JsonRpcRequest,
            mcp_handler,
            create_error_response,
        )

        assert True


class TestOpenAPISpec:
    """Test OpenAPI specification generation."""

    def test_openapi_spec_generates(self):
        """Test that OpenAPI spec can be generated without errors."""
        from server.openapi_spec import get_openapi_spec

        spec = get_openapi_spec()
        assert spec is not None
        assert isinstance(spec, dict)
        assert "openapi" in spec
        assert "paths" in spec

    def test_openapi_spec_has_all_endpoints(self):
        """Test that OpenAPI spec includes key endpoints."""
        from server.openapi_spec import get_openapi_spec

        spec = get_openapi_spec()
        paths = spec.get("paths", {})

        # Verify core endpoints exist
        assert "/health" in paths
        assert "/info" in paths
        assert "/assistants" in paths
        assert "/threads" in paths

        # Verify Tier 3 endpoints exist
        assert "/runs/crons" in paths
        assert "/mcp/" in paths


class TestMainEntrypoint:
    """Test the __main__ module."""

    def test_main_module_imports(self):
        """Test that __main__ module can be imported.

        Note: We don't call main() as it would start the server.
        """
        from server.__main__ import main  # noqa: F401

        assert callable(main)
