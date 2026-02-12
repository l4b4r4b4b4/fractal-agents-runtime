"""Placeholder tests for fractal-graph-react-agent package.

These verify that the package is importable and exports the expected public API.
Integration tests live in apps/python/tests/ where the full runtime is available.
"""

from react_agent import __version__, graph


def test_package_version_is_string() -> None:
    """Package exposes a version string."""
    assert isinstance(__version__, str)
    assert len(__version__) > 0


def test_graph_is_callable() -> None:
    """The graph entry point is an async callable."""
    import asyncio
    import inspect

    assert callable(graph)
    assert inspect.iscoroutinefunction(graph)
