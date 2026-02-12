"""Placeholder tests for react_agent and fractal_agent_infra package integration.

These tests verify that the graph and infra packages are
correctly installed and importable from the runtime application.
"""

import pytest


class TestGraphPackageIntegration:
    """Tests that the react_agent graph package is importable."""

    def test_import_react_agent(self) -> None:
        """Test that react_agent module can be imported."""
        from react_agent import agent

        assert agent is not None

    def test_graph_exists(self) -> None:
        """Test that the graph factory exists in agent module."""
        from react_agent.agent import graph

        assert graph is not None

    def test_graph_version_is_available(self) -> None:
        """Test that __version__ is set (from importlib.metadata or fallback)."""
        from react_agent import __version__

        assert isinstance(__version__, str)
        assert len(__version__) > 0


class TestInfraPackageIntegration:
    """Tests that the fractal_agent_infra package is importable."""

    def test_tracing_module_importable(self) -> None:
        """Test that the tracing module is importable."""
        from fractal_agent_infra.tracing import (
            initialize_langfuse,
            inject_tracing,
            is_langfuse_configured,
            is_langfuse_enabled,
            shutdown_langfuse,
        )

        assert callable(initialize_langfuse)
        assert callable(inject_tracing)
        assert callable(is_langfuse_configured)
        assert callable(is_langfuse_enabled)
        assert callable(shutdown_langfuse)

    def test_store_namespace_importable(self) -> None:
        """Test that store namespace utilities are importable."""
        from fractal_agent_infra.store_namespace import (
            CATEGORY_TOKENS,
            build_namespace,
            extract_namespace_components,
        )

        assert CATEGORY_TOKENS == "tokens"
        assert callable(build_namespace)
        assert callable(extract_namespace_components)

    def test_infra_version_is_available(self) -> None:
        """Test that __version__ is set (from importlib.metadata or fallback)."""
        from fractal_agent_infra import __version__

        assert isinstance(__version__, str)
        assert len(__version__) > 0


class TestGraphInvocation:
    """Integration tests requiring LLM configuration."""

    @pytest.mark.skip(reason="Requires LLM configuration")
    def test_graph_invocation(self) -> None:
        """Test that graph can be invoked (requires LLM setup)."""
        # This test is skipped by default as it requires LLM configuration
        # It serves as a template for future integration tests
        pass
