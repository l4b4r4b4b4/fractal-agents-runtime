"""Entry point for running server as a module.

Usage:
    uv run python -m server
    python -m server
"""

from server.app import main

if __name__ == "__main__":
    main()
