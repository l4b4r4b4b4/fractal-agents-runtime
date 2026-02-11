"""Entry point for running robyn_server as a module.

Usage:
    uv run python -m robyn_server
    python -m robyn_server
"""

from robyn_server.app import main

if __name__ == "__main__":
    main()
