"""Pytest configuration for Robyn server tests.

Provides fixtures and markers for both unit tests (no Postgres) and
integration tests (requires a running Postgres instance).

Usage::

    # Run all tests (skips Postgres tests if DATABASE_URL not set)
    uv run pytest

    # Run only Postgres integration tests
    DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
        uv run pytest -m postgres -v

    # Run only non-Postgres tests
    uv run pytest -m "not postgres"
"""

import os

import pytest
import pytest_asyncio


def pytest_configure(config: pytest.Config) -> None:
    """Register custom markers."""
    config.addinivalue_line(
        "markers",
        "postgres: marks tests that require a running Postgres instance",
    )


@pytest.fixture
def anyio_backend():
    """Configure anyio to use asyncio backend only."""
    return "asyncio"


@pytest.fixture
def database_url() -> str:
    """Return the DATABASE_URL for Postgres integration tests.

    Reads from the ``DATABASE_URL`` environment variable. Falls back to
    the local Supabase default if not set.

    Returns:
        Postgres connection string with ``sslmode=disable`` appended
        for local connections.
    """
    url = os.getenv(
        "DATABASE_URL",
        "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
    )
    # Ensure sslmode=disable for local connections
    if "sslmode" not in url and ("127.0.0.1" in url or "localhost" in url):
        separator = "&" if "?" in url else "?"
        url = f"{url}{separator}sslmode=disable"
    return url


def _is_postgres_reachable(url: str) -> bool:
    """Synchronously check whether Postgres is reachable.

    Uses a blocking ``psycopg`` connection with a short timeout.
    Returns ``False`` on any failure (import error, connection error, etc.).
    """
    try:
        import psycopg

        connection = psycopg.connect(url, connect_timeout=3)
        connection.close()
        return True
    except Exception:
        return False


@pytest.fixture
def postgres_available(database_url: str) -> bool:
    """Return ``True`` if a Postgres instance is reachable at ``database_url``.

    Use this fixture to conditionally skip tests::

        def test_something(self, postgres_available):
            if not postgres_available:
                pytest.skip("Postgres not available")
    """
    return _is_postgres_reachable(database_url)


@pytest_asyncio.fixture
async def postgres_pool(database_url: str, postgres_available: bool):
    """Create and yield an async connection pool for integration tests.

    Automatically skips the test if Postgres is not reachable.
    Closes the pool after the test completes.

    Yields:
        ``psycopg_pool.AsyncConnectionPool`` connected to the test database.
    """
    if not postgres_available:
        pytest.skip("Postgres not available")

    from psycopg.rows import dict_row
    from psycopg_pool import AsyncConnectionPool

    pool = AsyncConnectionPool(
        conninfo=database_url,
        min_size=1,
        max_size=3,
        timeout=10.0,
        open=False,
        kwargs={
            "autocommit": True,
            "prepare_threshold": 0,
            "row_factory": dict_row,
        },
    )
    await pool.open(wait=True, timeout=10.0)

    try:
        yield pool
    finally:
        await pool.close()


@pytest_asyncio.fixture
async def postgres_storage(postgres_pool):
    """Create a ``PostgresStorage`` instance backed by the test pool.

    Runs migrations to ensure tables exist, then yields the storage.
    After the test, truncates all ``langgraph_server`` tables to ensure
    test isolation.

    The pool is wrapped in a connection-factory callable so that
    ``PostgresStorage`` receives the same interface used in production
    (``server.database.get_connection``).  In tests the factory simply
    delegates to the pool — the pool lives on the test event loop so
    there are no cross-loop issues.

    Yields:
        ``PostgresStorage`` instance ready for CRUD operations.
    """
    from contextlib import asynccontextmanager

    from server.postgres_storage import PostgresStorage

    @asynccontextmanager
    async def _test_get_connection():
        """Wrap the test pool in the connection-factory interface."""
        async with postgres_pool.connection() as conn:
            yield conn

    storage = PostgresStorage(_test_get_connection)
    await storage.run_migrations()

    try:
        yield storage
    finally:
        # Truncate all langgraph_server tables for test isolation
        async with postgres_pool.connection() as connection:
            await connection.execute(
                "TRUNCATE TABLE "
                "langgraph_server.runs, "
                "langgraph_server.thread_states, "
                "langgraph_server.threads, "
                "langgraph_server.assistants, "
                "langgraph_server.store_items, "
                "langgraph_server.crons "
                "CASCADE"
            )
