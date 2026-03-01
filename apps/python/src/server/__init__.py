"""Robyn-based runtime server for OAP LangGraph Tools Agent.

This package provides a high-performance Rust-based async web server
that implements the LangGraph Runtime API for Open Agent Platform compatibility.

Version is read from ``pyproject.toml`` via ``importlib.metadata`` —
that file is the **single source of truth**.  Never hardcode version
strings elsewhere; always import ``__version__`` from this module.
"""

from importlib.metadata import PackageNotFoundError, version

try:
    __version__: str = version("fractal-agents-runtime")
except PackageNotFoundError:
    # Running from source / editable install before first ``uv sync``.
    __version__ = "0.0.0-dev"

__all__ = [
    "__version__",
]
