"""Database module for Postgres persistence.

Provides per-request connection management that avoids event-loop-bound
shared state.  This is critical for Robyn/Actix, which may dispatch
Python coroutines on **different** event loops across requests.

**Why no shared ``AsyncConnectionPool``?**

``psycopg_pool.AsyncConnectionPool`` creates an internal ``asyncio.Lock``
(and scheduler, task queue, etc.) during ``open()``.  These bind to the
event loop that called ``open()``.  When Robyn's Actix runtime dispatches
a subsequent request on a *different* event loop, any ``pool.connection()``
call hits ``async with self._lock`` → ``RuntimeError: Lock is bound to a
different event loop``.

The same problem affects ``AsyncPostgresSaver`` and ``AsyncPostgresStore``
from LangGraph, which each create an internal ``asyncio.Lock`` in
``__init__``.

**Solution: per-request connections.**

* LangGraph checkpointer/store use their built-in ``from_conn_string()``
  async context managers — each call creates a fresh ``AsyncConnection``
  on the *current* event loop and closes it on exit.
* Our custom ``PostgresStorage`` receives a *connection factory* (an async
  context manager callable) instead of a pool.  Each DB operation creates
  a fresh connection, does its work, and closes it.
* At startup, temporary ``from_conn_string()`` instances run idempotent
  DDL setup (table creation, RLS).  These are discarded after setup.

Usage at server startup::

    from server.database import initialize_database, shutdown_database

    await initialize_database()   # probe, create tables
    # ... server runs ...
    await shutdown_database()     # reset state

Per-request access::

    from server.database import checkpointer, store, get_connection

    async with checkpointer() as cp, store() as st:
        agent = build_agent(config, checkpointer=cp, store=st)
        ...

    async with get_connection() as conn:
        await conn.execute("SELECT ...")
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import TYPE_CHECKING, AsyncGenerator

if TYPE_CHECKING:
    from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
    from langgraph.store.postgres.aio import AsyncPostgresStore
    from psycopg import AsyncConnection

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Module-level state (no asyncio primitives — just strings and booleans)
# ---------------------------------------------------------------------------

_database_url: str | None = None
_initialized: bool = False


# ---------------------------------------------------------------------------
# Lifecycle
# ---------------------------------------------------------------------------


async def initialize_database() -> bool:
    """Initialise Postgres persistence: probe connectivity, create tables.

    Reads ``DATABASE_URL`` from the application config.  When the URL is
    empty the function returns ``False`` and the server continues with
    in-memory storage.

    On success the following are available:

    * ``get_database_url()`` → connection string
    * ``checkpointer()``     → async CM yielding ``AsyncPostgresSaver``
    * ``store()``            → async CM yielding ``AsyncPostgresStore``
    * ``get_connection()``   → async CM yielding ``AsyncConnection``

    Returns:
        ``True`` when Postgres is connected and ready, ``False`` otherwise.
    """
    global _database_url, _initialized  # noqa: PLW0603

    from server.config import get_config

    config = get_config()

    if not config.database.is_configured:
        logger.info("DATABASE_URL not set — using in-memory storage")
        return False

    database_url = config.database.url

    # Local Supabase instances don't expose TLS; ensure sslmode is set so
    # psycopg doesn't try to negotiate SSL with a server that doesn't have it.
    if "sslmode" not in database_url and (
        "127.0.0.1" in database_url or "localhost" in database_url
    ):
        separator = "&" if "?" in database_url else "?"
        database_url = f"{database_url}{separator}sslmode=disable"

    try:
        # Fast-fail connectivity probe
        await _probe_connection(database_url)

        # Store URL for runtime use — no asyncio objects, safe across loops
        _database_url = database_url

        # Idempotent DDL setup with temporary per-call connections
        await _run_setup()

        _initialized = True
        logger.info("Postgres persistence initialised (per-request connections)")
    except Exception:
        logger.exception(
            "Failed to connect to Postgres — falling back to in-memory storage"
        )
        _database_url = None
        _initialized = False
        return False

    return True


async def shutdown_database() -> None:
    """Reset database state.

    Safe to call even when Postgres was never initialised.
    No connections or pools to close — everything is per-request.
    """
    global _database_url, _initialized  # noqa: PLW0603
    _database_url = None
    _initialized = False
    logger.info("Database state reset")


# ---------------------------------------------------------------------------
# Accessors
# ---------------------------------------------------------------------------


def get_database_url() -> str | None:
    """Return the validated database URL, or ``None`` when Postgres is disabled."""
    return _database_url


def is_postgres_enabled() -> bool:
    """Return ``True`` when the database has been successfully initialised."""
    return _initialized


# ---------------------------------------------------------------------------
# Per-request connection factory
# ---------------------------------------------------------------------------


@asynccontextmanager
async def get_connection() -> AsyncGenerator["AsyncConnection", None]:
    """Create a fresh ``AsyncConnection`` for the current request.

    The connection is created on the **current** event loop and closed
    when the context manager exits.  No shared pool, no cross-loop issues.

    Raises:
        RuntimeError: If the database has not been initialised.

    Yields:
        An open ``AsyncConnection`` with ``autocommit=True``,
        ``prepare_threshold=0``, and ``row_factory=dict_row``.
    """
    if not _database_url:
        raise RuntimeError(
            "Database not initialised — call initialize_database() first"
        )

    from psycopg import AsyncConnection as _AsyncConnection
    from psycopg.rows import dict_row

    connection = await _AsyncConnection.connect(
        _database_url,
        autocommit=True,
        prepare_threshold=0,
        row_factory=dict_row,
    )
    try:
        yield connection
    finally:
        await connection.close()


# ---------------------------------------------------------------------------
# Per-request LangGraph checkpointer & store
# ---------------------------------------------------------------------------


@asynccontextmanager
async def checkpointer() -> AsyncGenerator["AsyncPostgresSaver | None", None]:
    """Create a per-request ``AsyncPostgresSaver`` via ``from_conn_string``.

    Uses LangGraph's built-in connection management: each call creates a
    fresh ``AsyncConnection`` on the current event loop.  The connection
    (and the checkpointer's internal ``asyncio.Lock``) are bound to the
    caller's loop — no cross-loop issues.

    Yields ``None`` when Postgres is disabled.

    Example::

        async with checkpointer() as cp:
            agent = await build_agent(config, checkpointer=cp)
    """
    if not _database_url:
        yield None
        return

    from langgraph.checkpoint.postgres.aio import (
        AsyncPostgresSaver as _AsyncPostgresSaver,
    )

    async with _AsyncPostgresSaver.from_conn_string(_database_url) as saver:
        yield saver


@asynccontextmanager
async def store() -> AsyncGenerator["AsyncPostgresStore | None", None]:
    """Create a per-request ``AsyncPostgresStore`` via ``from_conn_string``.

    Same rationale as :func:`checkpointer` — per-request connection on the
    current event loop.

    Yields ``None`` when Postgres is disabled.

    Example::

        async with store() as st:
            agent = await build_agent(config, store=st)
    """
    if not _database_url:
        yield None
        return

    from langgraph.store.postgres.aio import AsyncPostgresStore as _AsyncPostgresStore

    async with _AsyncPostgresStore.from_conn_string(_database_url) as postgres_store:
        yield postgres_store


# ---------------------------------------------------------------------------
# Backward-compatible stubs (deprecated — used by tests)
# ---------------------------------------------------------------------------


def get_pool() -> None:
    """Return ``None``.

    .. deprecated::
        The shared ``AsyncConnectionPool`` has been removed to eliminate
        event-loop-bound shared state.  Use :func:`get_connection` instead.
    """
    return None


def get_checkpointer() -> None:
    """Return ``None``.

    .. deprecated::
        Use ``async with database.checkpointer() as cp:`` instead.
    """
    return None


def get_store() -> None:
    """Return ``None``.

    .. deprecated::
        Use ``async with database.store() as st:`` instead.
    """
    return None


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

_LANGGRAPH_TABLES = (
    "checkpoints",
    "checkpoint_blobs",
    "checkpoint_writes",
    "checkpoint_migrations",
    "store",
    "store_migrations",
)
"""Tables created by ``AsyncPostgresSaver.setup()`` and ``AsyncPostgresStore.setup()``."""


async def _probe_connection(database_url: str) -> None:
    """Open a single throwaway connection to verify Postgres is reachable.

    Fails fast (~5 s) instead of waiting for pool reconnect loops.
    """
    import asyncio

    from psycopg import AsyncConnection as _AsyncConnection
    from psycopg.rows import dict_row

    probe_timeout = 5.0
    try:
        probe_connection = await asyncio.wait_for(
            _AsyncConnection.connect(
                database_url,
                autocommit=True,
                prepare_threshold=0,
                row_factory=dict_row,
            ),
            timeout=probe_timeout,
        )
        await probe_connection.close()
    except (asyncio.TimeoutError, OSError) as probe_error:
        raise ConnectionError(
            f"Postgres unreachable (probe timed out after {probe_timeout}s)"
        ) from probe_error


async def _enable_rls_on_langgraph_tables() -> None:
    """Enable Row-Level Security on LangGraph tables (idempotent).

    LangGraph's ``setup()`` creates tables in the ``public`` schema without
    RLS.  In Supabase, the ``public`` schema is exposed via PostgREST, so
    tables without RLS are readable/writable by anyone with the anon key.

    Enabling RLS with **no permissive policies** means:

    * PostgREST (``anon`` / ``authenticated`` roles) → access denied.
    * Our ``psycopg`` connection (``postgres`` superuser) → bypasses RLS.
    """
    async with get_connection() as connection:
        for table_name in _LANGGRAPH_TABLES:
            await connection.execute(
                f"ALTER TABLE IF EXISTS public.{table_name} "  # noqa: S608
                f"ENABLE ROW LEVEL SECURITY"
            )
    logger.info("RLS enabled on LangGraph tables (PostgREST access denied)")


async def _create_langgraph_server_schema() -> None:
    """Create the ``langgraph_server`` schema and runtime tables.

    Uses :class:`~server.postgres_storage.PostgresStorage.run_migrations`
    which executes idempotent ``CREATE SCHEMA/TABLE IF NOT EXISTS`` DDL.
    """
    from server.postgres_storage import PostgresStorage

    storage = PostgresStorage(get_connection)
    await storage.run_migrations()


async def _run_setup() -> None:
    """Run all idempotent DDL setup with temporary connections.

    Each ``from_conn_string()`` call creates its own connection on the
    current event loop, runs the DDL, and closes the connection.
    """
    from langgraph.checkpoint.postgres.aio import (
        AsyncPostgresSaver as _AsyncPostgresSaver,
    )
    from langgraph.store.postgres.aio import AsyncPostgresStore as _AsyncPostgresStore

    # 1. Create LangGraph checkpoint tables
    async with _AsyncPostgresSaver.from_conn_string(
        _database_url
    ) as setup_checkpointer:
        await setup_checkpointer.setup()
    logger.info("LangGraph checkpointer tables ready")

    # 2. Create LangGraph store tables
    async with _AsyncPostgresStore.from_conn_string(_database_url) as setup_store:
        await setup_store.setup()
    logger.info("LangGraph store tables ready")

    # 3. Enable RLS on LangGraph tables
    await _enable_rls_on_langgraph_tables()

    # 4. Create langgraph_server schema (assistants, threads, runs, etc.)
    await _create_langgraph_server_schema()
