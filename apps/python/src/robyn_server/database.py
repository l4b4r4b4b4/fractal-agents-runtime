"""Database module for Postgres persistence.

Manages the shared async connection pool and provides per-request
LangGraph checkpointer / store factories.  All components share a single
``AsyncConnectionPool`` to minimise Postgres connections.

**Why per-request factories with no-op Locks?**

``AsyncPostgresSaver`` and ``AsyncPostgresStore`` each create an internal
``asyncio.Lock`` that binds lazily to the first event loop that calls
``acquire()``.  Robyn (via Actix) may resume an SSE async generator on a
**different** event loop mid-stream — the checkpoint *read* at stream
start binds the Lock to Loop-A, then the checkpoint *write* at stream
end runs on Loop-B → ``RuntimeError: Lock is bound to a different event
loop``.

Creating per-request instances is necessary but not sufficient because
the Lock still binds on first use within the request.  Since each
per-request instance is used by exactly one request and the underlying
``AsyncConnectionPool`` already serialises connection checkout, the
instance-level Lock is redundant.  We replace it with a no-op async
context manager.

Usage at server startup::

    from robyn_server.database import initialize_database, shutdown_database

    # In Robyn startup handler
    await initialize_database()

    # In Robyn shutdown handler
    await shutdown_database()

Access components per-request::

    from robyn_server.database import (
        get_checkpointer,
        get_pool,
        get_store,
        is_postgres_enabled,
    )

    if is_postgres_enabled():
        checkpointer = get_checkpointer()  # fresh AsyncPostgresSaver per call
        store = get_store()                 # fresh AsyncPostgresStore per call
        pool = get_pool()                   # shared AsyncConnectionPool
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
    from langgraph.store.postgres.aio import AsyncPostgresStore
    from psycopg_pool import AsyncConnectionPool

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Module-level singletons
# ---------------------------------------------------------------------------

_pool: AsyncConnectionPool | None = None
_initialized: bool = False


# ---------------------------------------------------------------------------
# Lifecycle
# ---------------------------------------------------------------------------


async def initialize_database() -> bool:
    """Initialise the shared Postgres connection pool and LangGraph persistence.

    Reads ``DATABASE_URL`` (and optional pool-tuning variables) from the
    application config.  When the URL is empty the function returns ``False``
    and the server continues with in-memory storage.

    On success the following are available via their accessors:

    * ``get_pool()``         → ``AsyncConnectionPool``
    * ``get_checkpointer()`` → ``AsyncPostgresSaver``
    * ``get_store()``        → ``AsyncPostgresStore``

    Returns:
        ``True`` when Postgres is connected and ready, ``False`` otherwise.

    Raises:
        Nothing — connection errors are caught and logged so the server can
        fall back to in-memory mode.
    """
    global _pool, _initialized  # noqa: PLW0603

    from robyn_server.config import get_config

    config = get_config()

    if not config.database.is_configured:
        logger.info("DATABASE_URL not set — using in-memory storage")
        return False

    database_url = config.database.url

    # Local Supabase instances don't expose TLS; make sure sslmode is set so
    # psycopg doesn't try to negotiate SSL with a server that doesn't have it.
    if "sslmode" not in database_url and (
        "127.0.0.1" in database_url or "localhost" in database_url
    ):
        separator = "&" if "?" in database_url else "?"
        database_url = f"{database_url}{separator}sslmode=disable"

    try:
        await _create_pool(
            database_url,
            min_size=config.database.pool_min_size,
            max_size=config.database.pool_max_size,
            timeout=config.database.pool_timeout,
        )
        await _create_checkpointer_and_store()
        await _create_langgraph_server_schema()
        _initialized = True
        logger.info(
            "Postgres persistence initialised (pool min=%d max=%d)",
            config.database.pool_min_size,
            config.database.pool_max_size,
        )
    except Exception:
        logger.exception(
            "Failed to connect to Postgres — falling back to in-memory storage"
        )
        # Clean up anything that was partially created.
        await shutdown_database()
        return False

    return True


async def shutdown_database() -> None:
    """Close the connection pool and release all Postgres resources.

    Safe to call even when Postgres was never initialised.
    """
    global _pool, _initialized  # noqa: PLW0603

    if _pool is not None:
        try:
            await _pool.close()
            logger.info("Postgres connection pool closed")
        except Exception:
            logger.exception("Error closing Postgres connection pool")
        finally:
            _pool = None

    _initialized = False


# ---------------------------------------------------------------------------
# Accessors
# ---------------------------------------------------------------------------


def get_pool() -> AsyncConnectionPool | None:
    """Return the shared ``AsyncConnectionPool``, or ``None`` when Postgres is disabled."""
    return _pool


class _NoOpLock:
    """Async context manager that replaces ``asyncio.Lock`` for per-request use.

    ``AsyncPostgresSaver`` and ``AsyncPostgresStore`` use an instance-level
    ``asyncio.Lock`` to serialise cursor access.  In Robyn's Actix-backed
    runtime, SSE generators may be resumed on a **different** event loop
    mid-stream, causing ``RuntimeError: Lock is bound to a different event
    loop``.

    Because each per-request instance is used by exactly one request, and
    the underlying ``AsyncConnectionPool`` already handles connection-level
    concurrency, the instance Lock is redundant.  This no-op replacement
    avoids the cross-loop error entirely.
    """

    async def __aenter__(self) -> "_NoOpLock":
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc_val: BaseException | None,
        exc_tb: object,
    ) -> None:
        return None

    async def acquire(self) -> bool:
        return True

    def release(self) -> None:
        pass

    def locked(self) -> bool:
        return False


def get_checkpointer() -> AsyncPostgresSaver | None:
    """Create a **fresh** ``AsyncPostgresSaver`` with a no-op Lock.

    A new instance is returned on every call.  Its internal
    ``asyncio.Lock`` is replaced with :class:`_NoOpLock` so that Robyn's
    multi-loop SSE streaming cannot trigger cross-loop Lock errors.

    The underlying ``AsyncConnectionPool`` is shared and event-loop-safe,
    so creating lightweight wrappers per-request is cheap.  Table setup
    (``CREATE TABLE IF NOT EXISTS``) was already executed once at startup
    via :func:`_create_checkpointer_and_store`, so it is **not** repeated
    here.

    Returns:
        A new ``AsyncPostgresSaver`` (Lock-free), or ``None`` when
        Postgres is disabled.
    """
    if _pool is None:
        return None

    from langgraph.checkpoint.postgres.aio import (
        AsyncPostgresSaver as _AsyncPostgresSaver,
    )

    checkpointer = _AsyncPostgresSaver(conn=_pool)
    checkpointer.lock = _NoOpLock()
    return checkpointer


def get_store() -> AsyncPostgresStore | None:
    """Create a **fresh** ``AsyncPostgresStore`` with a no-op Lock.

    Same rationale as :func:`get_checkpointer` — the instance Lock is
    replaced with :class:`_NoOpLock` to avoid cross-loop errors in
    Robyn's SSE streaming.

    Returns:
        A new ``AsyncPostgresStore`` (Lock-free), or ``None`` when
        Postgres is disabled.
    """
    if _pool is None:
        return None

    from langgraph.store.postgres.aio import AsyncPostgresStore as _AsyncPostgresStore

    store = _AsyncPostgresStore(conn=_pool)
    if hasattr(store, "lock"):
        store.lock = _NoOpLock()
    return store


def is_postgres_enabled() -> bool:
    """Return ``True`` when the database has been successfully initialised."""
    return _initialized


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


async def _create_pool(
    database_url: str,
    *,
    min_size: int = 2,
    max_size: int = 10,
    timeout: float = 30.0,
) -> None:
    """Create and open the shared ``AsyncConnectionPool``.

    A single probe connection is attempted first so that unreachable hosts
    fail fast (~3 s) instead of triggering the pool's background reconnect
    loop for the full timeout window.

    The pool is configured with the same connection kwargs that
    ``AsyncPostgresSaver.from_conn_string`` and
    ``AsyncPostgresStore.from_conn_string`` use internally
    (``autocommit=True``, ``prepare_threshold=0``,
    ``row_factory=dict_row``).  This lets the checkpointer and store
    operate correctly when given the pool as their ``conn`` argument.
    """
    global _pool  # noqa: PLW0603

    import asyncio

    from psycopg import AsyncConnection
    from psycopg.rows import dict_row
    from psycopg_pool import AsyncConnectionPool as _AsyncConnectionPool

    # ------------------------------------------------------------------
    # Fast-fail probe: open a single throwaway connection with a short
    # timeout so we know immediately whether Postgres is reachable.
    # ------------------------------------------------------------------
    probe_timeout = min(timeout, 5.0)
    try:
        probe_connection = await asyncio.wait_for(
            AsyncConnection.connect(
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

    # ------------------------------------------------------------------
    # Probe succeeded — create the real pool.
    # ------------------------------------------------------------------
    _pool = _AsyncConnectionPool(
        conninfo=database_url,
        min_size=min_size,
        max_size=max_size,
        timeout=timeout,
        open=False,
        reconnect_timeout=5.0,
        kwargs={
            "autocommit": True,
            "prepare_threshold": 0,
            "row_factory": dict_row,
        },
    )
    await _pool.open(wait=True, timeout=timeout)


_LANGGRAPH_TABLES = (
    "checkpoints",
    "checkpoint_blobs",
    "checkpoint_writes",
    "checkpoint_migrations",
    "store",
    "store_migrations",
)
"""Tables created by ``AsyncPostgresSaver.setup()`` and ``AsyncPostgresStore.setup()``."""


async def _enable_rls_on_langgraph_tables() -> None:
    """Enable Row-Level Security on LangGraph tables (idempotent).

    LangGraph's ``setup()`` creates tables in the ``public`` schema without
    RLS.  In Supabase, the ``public`` schema is exposed via PostgREST, so
    tables without RLS are readable/writable by anyone with the anon key.

    Enabling RLS with **no permissive policies** means:

    * PostgREST (``anon`` / ``authenticated`` roles) → access denied.
    * Our ``psycopg`` connection (``postgres`` superuser) → bypasses RLS.

    ``ALTER TABLE … ENABLE ROW LEVEL SECURITY`` is a no-op on tables that
    already have RLS enabled, so this is safe to run on every startup.
    """
    if _pool is None:
        return

    async with _pool.connection() as connection:
        for table_name in _LANGGRAPH_TABLES:
            await connection.execute(
                f"ALTER TABLE IF EXISTS public.{table_name} "  # noqa: S608
                f"ENABLE ROW LEVEL SECURITY"
            )
    logger.info("RLS enabled on LangGraph tables (PostgREST access denied)")


async def _create_langgraph_server_schema() -> None:
    """Create the ``langgraph_server`` schema and runtime tables.

    Uses :class:`~robyn_server.postgres_storage.PostgresStorage.run_migrations`
    which executes idempotent ``CREATE SCHEMA/TABLE IF NOT EXISTS`` DDL.
    Safe to run on every startup.
    """
    if _pool is None:
        return

    from robyn_server.postgres_storage import PostgresStorage

    storage = PostgresStorage(_pool)
    await storage.run_migrations()


async def _create_checkpointer_and_store() -> None:
    """Instantiate the LangGraph checkpointer and store using the shared pool.

    Both ``AsyncPostgresSaver`` and ``AsyncPostgresStore`` accept an
    ``AsyncConnectionPool`` as their ``conn`` parameter (the internal
    ``_ainternal.Conn`` type is
    ``Union[AsyncConnection, AsyncConnectionPool]``).  Using the shared
    pool avoids spawning additional connections and simplifies lifecycle
    management.

    After construction, ``.setup()`` is called on each to ensure the
    required tables exist (idempotent ``CREATE TABLE IF NOT EXISTS``).
    """
    if _pool is None:
        raise RuntimeError("Connection pool must be created before checkpointer/store")

    from langgraph.checkpoint.postgres.aio import (
        AsyncPostgresSaver as _AsyncPostgresSaver,
    )
    from langgraph.store.postgres.aio import AsyncPostgresStore as _AsyncPostgresStore

    # Create temporary instances solely to run the idempotent DDL setup.
    # These are discarded after setup — per-request instances are created
    # by get_checkpointer() / get_store() on the caller's event loop.
    setup_checkpointer = _AsyncPostgresSaver(conn=_pool)
    setup_store = _AsyncPostgresStore(conn=_pool)

    await setup_checkpointer.setup()
    logger.info("LangGraph checkpointer tables ready")

    await setup_store.setup()
    logger.info("LangGraph store tables ready")

    await _enable_rls_on_langgraph_tables()
