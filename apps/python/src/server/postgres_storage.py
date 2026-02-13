"""Postgres-backed storage layer for Robyn server resources.

This module provides Postgres implementations of all storage classes,
mirroring the async interface of the in-memory stores in ``storage.py``.
All queries use parameterized placeholders (``%s``) to prevent SQL injection.
Owner isolation is enforced via ``metadata->>'owner'`` WHERE clauses.

Usage::

    from server.postgres_storage import PostgresStorage

    pool = get_pool()
    storage = PostgresStorage(pool)
    await storage.run_migrations()

    assistant = await storage.assistants.create({"graph_id": "agent"}, owner_id)
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any
from uuid import uuid4

from server.models import Assistant, AssistantConfig, Run, Thread, ThreadState

if TYPE_CHECKING:
    from psycopg_pool import AsyncConnectionPool

    from server.crons.schemas import Cron

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_SCHEMA = "langgraph_server"


def _generate_id() -> str:
    """Generate a unique resource ID (UUID hex, 32 chars, no dashes)."""
    return uuid4().hex


def _utc_now() -> datetime:
    """Return the current UTC datetime."""
    return datetime.now(timezone.utc)


def _json_dumps(value: Any) -> str:
    """Serialize a value to a JSON string for Postgres JSONB columns."""
    return json.dumps(value, default=str)


# ---------------------------------------------------------------------------
# DDL — idempotent, safe to run on every startup
# ---------------------------------------------------------------------------

_DDL = """\
CREATE SCHEMA IF NOT EXISTS langgraph_server;

CREATE TABLE IF NOT EXISTS langgraph_server.assistants (
    id TEXT PRIMARY KEY,
    graph_id TEXT NOT NULL,
    config JSONB NOT NULL DEFAULT '{}',
    context JSONB NOT NULL DEFAULT '{}',
    metadata JSONB NOT NULL DEFAULT '{}',
    name TEXT,
    description TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS langgraph_server.threads (
    id TEXT PRIMARY KEY,
    metadata JSONB NOT NULL DEFAULT '{}',
    config JSONB NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'idle',
    values JSONB NOT NULL DEFAULT '{}',
    interrupts JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS langgraph_server.thread_states (
    id SERIAL PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES langgraph_server.threads(id) ON DELETE CASCADE,
    values JSONB NOT NULL DEFAULT '{}',
    metadata JSONB NOT NULL DEFAULT '{}',
    next TEXT[] NOT NULL DEFAULT '{}',
    tasks JSONB NOT NULL DEFAULT '[]',
    checkpoint_id TEXT NOT NULL,
    parent_checkpoint JSONB,
    interrupts JSONB NOT NULL DEFAULT '[]',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_thread_states_thread_id
    ON langgraph_server.thread_states(thread_id, created_at DESC);

CREATE TABLE IF NOT EXISTS langgraph_server.runs (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    assistant_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    metadata JSONB NOT NULL DEFAULT '{}',
    kwargs JSONB NOT NULL DEFAULT '{}',
    multitask_strategy TEXT NOT NULL DEFAULT 'reject',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_runs_thread_id
    ON langgraph_server.runs(thread_id, created_at DESC);

CREATE TABLE IF NOT EXISTS langgraph_server.store_items (
    namespace TEXT NOT NULL,
    key TEXT NOT NULL,
    value JSONB NOT NULL DEFAULT '{}',
    owner_id TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (namespace, key, owner_id)
);

CREATE TABLE IF NOT EXISTS langgraph_server.crons (
    id TEXT PRIMARY KEY,
    assistant_id TEXT,
    thread_id TEXT,
    end_time TIMESTAMPTZ,
    schedule TEXT NOT NULL,
    user_id TEXT,
    payload JSONB NOT NULL DEFAULT '{}',
    next_run_date TIMESTAMPTZ,
    metadata JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
"""


# ============================================================================
# Postgres Assistant Store
# ============================================================================


class PostgresAssistantStore:
    """Postgres-backed store for Assistant resources."""

    def __init__(self, pool: AsyncConnectionPool) -> None:
        self._pool = pool

    async def create(self, data: dict[str, Any], owner_id: str) -> Assistant:
        """Create a new assistant.

        Args:
            data: Assistant data with required ``graph_id``.
            owner_id: ID of the owner.

        Returns:
            Created Assistant instance.

        Raises:
            ValueError: If ``graph_id`` is missing.
        """
        if "graph_id" not in data:
            raise ValueError("graph_id is required")

        resource_id = _generate_id()
        now = _utc_now()

        metadata = data.get("metadata", {}).copy()
        metadata["owner"] = owner_id

        config_data = data.get("config", {})
        version = data.get("version", 1)

        async with self._pool.connection() as connection:
            await connection.execute(
                f"""
                INSERT INTO {_SCHEMA}.assistants
                    (id, graph_id, config, context, metadata, name, description, version, created_at, updated_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    resource_id,
                    data["graph_id"],
                    _json_dumps(config_data),
                    _json_dumps(data.get("context", {})),
                    _json_dumps(metadata),
                    data.get("name"),
                    data.get("description"),
                    version,
                    now,
                    now,
                ),
            )

        return self._build_model(
            resource_id=resource_id,
            graph_id=data["graph_id"],
            config=config_data,
            context=data.get("context", {}),
            metadata=metadata,
            name=data.get("name"),
            description=data.get("description"),
            version=version,
            created_at=now,
            updated_at=now,
        )

    async def get(self, resource_id: str, owner_id: str) -> Assistant | None:
        """Get an assistant by ID if owned by the user."""
        async with self._pool.connection() as connection:
            result = await connection.execute(
                f"""
                SELECT id, graph_id, config, context, metadata, name,
                       description, version, created_at, updated_at
                FROM {_SCHEMA}.assistants
                WHERE id = %s AND metadata->>'owner' = %s
                """,
                (resource_id, owner_id),
            )
            row = await result.fetchone()

        if row is None:
            return None

        return self._row_to_model(row)

    async def list(self, owner_id: str, **filters: Any) -> list[Assistant]:
        """List assistants owned by the user."""
        async with self._pool.connection() as connection:
            result = await connection.execute(
                f"""
                SELECT id, graph_id, config, context, metadata, name,
                       description, version, created_at, updated_at
                FROM {_SCHEMA}.assistants
                WHERE metadata->>'owner' = %s
                ORDER BY created_at DESC
                """,
                (owner_id,),
            )
            rows = await result.fetchall()

        assistants = [self._row_to_model(row) for row in rows]

        # Apply additional in-memory filters (graph_id, name, etc.)
        for key, value in filters.items():
            assistants = [
                assistant
                for assistant in assistants
                if getattr(assistant, key, None) == value
            ]

        return assistants

    async def update(
        self, resource_id: str, data: dict[str, Any], owner_id: str
    ) -> Assistant | None:
        """Update an assistant, incrementing version."""
        async with self._pool.connection() as connection:
            # Fetch current to verify ownership and get version
            result = await connection.execute(
                f"""
                SELECT id, version, metadata
                FROM {_SCHEMA}.assistants
                WHERE id = %s AND metadata->>'owner' = %s
                """,
                (resource_id, owner_id),
            )
            current = await result.fetchone()

            if current is None:
                return None

            current_version = current["version"]
            new_version = current_version + 1
            now = _utc_now()

            # Build SET clause dynamically
            updates = {"version": new_version, "updated_at": now}

            if "name" in data:
                updates["name"] = data["name"]
            if "description" in data:
                updates["description"] = data["description"]
            if "graph_id" in data:
                updates["graph_id"] = data["graph_id"]
            if "context" in data:
                updates["context"] = _json_dumps(data["context"])
            if "config" in data:
                updates["config"] = _json_dumps(data["config"])
            if "metadata" in data:
                current_metadata = current["metadata"]
                if isinstance(current_metadata, str):
                    current_metadata = json.loads(current_metadata)
                merged = {**current_metadata, **data["metadata"]}
                merged["owner"] = owner_id
                updates["metadata"] = _json_dumps(merged)

            set_parts = []
            values = []
            for column_name, column_value in updates.items():
                set_parts.append(f"{column_name} = %s")
                values.append(column_value)

            values.extend([resource_id, owner_id])

            await connection.execute(
                f"""
                UPDATE {_SCHEMA}.assistants
                SET {", ".join(set_parts)}
                WHERE id = %s AND metadata->>'owner' = %s
                """,
                tuple(values),
            )

            # Fetch updated row
            result = await connection.execute(
                f"""
                SELECT id, graph_id, config, context, metadata, name,
                       description, version, created_at, updated_at
                FROM {_SCHEMA}.assistants
                WHERE id = %s
                """,
                (resource_id,),
            )
            row = await result.fetchone()

        return self._row_to_model(row) if row else None

    async def delete(self, resource_id: str, owner_id: str) -> bool:
        """Delete an assistant if owned by the user."""
        async with self._pool.connection() as connection:
            result = await connection.execute(
                f"""
                DELETE FROM {_SCHEMA}.assistants
                WHERE id = %s AND metadata->>'owner' = %s
                """,
                (resource_id, owner_id),
            )
            return result.rowcount > 0

    async def count(self, owner_id: str, **filters: Any) -> int:
        """Count assistants owned by the user."""
        return len(await self.list(owner_id, **filters))

    async def clear(self) -> None:
        """Clear all assistants (testing only)."""
        async with self._pool.connection() as connection:
            await connection.execute(f"DELETE FROM {_SCHEMA}.assistants")

    # -- helpers --

    @staticmethod
    def _build_model(
        *,
        resource_id: str,
        graph_id: str,
        config: Any,
        context: Any,
        metadata: Any,
        name: str | None,
        description: str | None,
        version: int,
        created_at: datetime,
        updated_at: datetime,
    ) -> Assistant:
        """Build an Assistant model from individual fields."""
        if isinstance(config, str):
            config = json.loads(config)
        if isinstance(context, str):
            context = json.loads(context)
        if isinstance(metadata, str):
            metadata = json.loads(metadata)

        if isinstance(config, AssistantConfig):
            assistant_config = config
        else:
            assistant_config = AssistantConfig(
                tags=config.get("tags", []),
                recursion_limit=config.get("recursion_limit", 25),
                configurable=config.get("configurable", {}),
            )

        return Assistant(
            assistant_id=resource_id,
            graph_id=graph_id,
            config=assistant_config,
            context=context,
            metadata=metadata,
            name=name,
            description=description,
            version=version,
            created_at=created_at,
            updated_at=updated_at,
        )

    @classmethod
    def _row_to_model(cls, row: dict[str, Any]) -> Assistant:
        """Convert a database row dict to an Assistant model."""
        return cls._build_model(
            resource_id=row["id"],
            graph_id=row["graph_id"],
            config=row["config"],
            context=row.get("context", {}),
            metadata=row.get("metadata", {}),
            name=row.get("name"),
            description=row.get("description"),
            version=row.get("version", 1),
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )


# ============================================================================
# Postgres Thread Store
# ============================================================================


class PostgresThreadStore:
    """Postgres-backed store for Thread resources with state history."""

    def __init__(self, pool: AsyncConnectionPool) -> None:
        self._pool = pool

    async def create(self, data: dict[str, Any], owner_id: str) -> Thread:
        """Create a new thread."""
        resource_id = _generate_id()
        now = _utc_now()

        metadata = data.get("metadata", {}).copy()
        metadata["owner"] = owner_id

        async with self._pool.connection() as connection:
            await connection.execute(
                f"""
                INSERT INTO {_SCHEMA}.threads
                    (id, metadata, config, status, values, interrupts, created_at, updated_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    resource_id,
                    _json_dumps(metadata),
                    _json_dumps(data.get("config", {})),
                    data.get("status", "idle"),
                    _json_dumps(data.get("values", {})),
                    _json_dumps(data.get("interrupts", {})),
                    now,
                    now,
                ),
            )

        return Thread(
            thread_id=resource_id,
            metadata=metadata,
            config=data.get("config", {}),
            status=data.get("status", "idle"),
            values=data.get("values", {}),
            interrupts=data.get("interrupts", {}),
            created_at=now,
            updated_at=now,
        )

    async def get(self, resource_id: str, owner_id: str) -> Thread | None:
        """Get a thread by ID if owned by the user."""
        async with self._pool.connection() as connection:
            result = await connection.execute(
                f"""
                SELECT id, metadata, config, status, values, interrupts,
                       created_at, updated_at
                FROM {_SCHEMA}.threads
                WHERE id = %s AND metadata->>'owner' = %s
                """,
                (resource_id, owner_id),
            )
            row = await result.fetchone()

        if row is None:
            return None

        return self._row_to_model(row)

    async def list(self, owner_id: str, **filters: Any) -> list[Thread]:
        """List threads owned by the user."""
        async with self._pool.connection() as connection:
            result = await connection.execute(
                f"""
                SELECT id, metadata, config, status, values, interrupts,
                       created_at, updated_at
                FROM {_SCHEMA}.threads
                WHERE metadata->>'owner' = %s
                ORDER BY created_at DESC
                """,
                (owner_id,),
            )
            rows = await result.fetchall()

        threads = [self._row_to_model(row) for row in rows]

        for key, value in filters.items():
            threads = [
                thread for thread in threads if getattr(thread, key, None) == value
            ]

        return threads

    async def update(
        self, resource_id: str, data: dict[str, Any], owner_id: str
    ) -> Thread | None:
        """Update a thread if owned by the user."""
        async with self._pool.connection() as connection:
            # Verify ownership
            result = await connection.execute(
                f"SELECT metadata FROM {_SCHEMA}.threads WHERE id = %s AND metadata->>'owner' = %s",
                (resource_id, owner_id),
            )
            current = await result.fetchone()
            if current is None:
                return None

            now = _utc_now()
            updates: dict[str, Any] = {"updated_at": now}

            if "status" in data:
                updates["status"] = data["status"]
            if "values" in data:
                updates["values"] = _json_dumps(data["values"])
            if "config" in data:
                updates["config"] = _json_dumps(data["config"])
            if "interrupts" in data:
                updates["interrupts"] = _json_dumps(data["interrupts"])
            if "metadata" in data:
                current_metadata = current["metadata"]
                if isinstance(current_metadata, str):
                    current_metadata = json.loads(current_metadata)
                merged = {**current_metadata, **data["metadata"]}
                merged["owner"] = owner_id
                updates["metadata"] = _json_dumps(merged)

            set_parts = []
            values = []
            for column_name, column_value in updates.items():
                set_parts.append(f"{column_name} = %s")
                values.append(column_value)

            values.extend([resource_id, owner_id])

            await connection.execute(
                f"""
                UPDATE {_SCHEMA}.threads
                SET {", ".join(set_parts)}
                WHERE id = %s AND metadata->>'owner' = %s
                """,
                tuple(values),
            )

            # Fetch updated
            result = await connection.execute(
                f"""
                SELECT id, metadata, config, status, values, interrupts,
                       created_at, updated_at
                FROM {_SCHEMA}.threads WHERE id = %s
                """,
                (resource_id,),
            )
            row = await result.fetchone()

        return self._row_to_model(row) if row else None

    async def delete(self, resource_id: str, owner_id: str) -> bool:
        """Delete a thread and its state history (CASCADE)."""
        async with self._pool.connection() as connection:
            result = await connection.execute(
                f"""
                DELETE FROM {_SCHEMA}.threads
                WHERE id = %s AND metadata->>'owner' = %s
                """,
                (resource_id, owner_id),
            )
            return result.rowcount > 0

    async def get_state(self, thread_id: str, owner_id: str) -> ThreadState | None:
        """Get the current state of a thread."""
        async with self._pool.connection() as connection:
            # Verify thread exists and is owned
            result = await connection.execute(
                f"""
                SELECT id, metadata, values
                FROM {_SCHEMA}.threads
                WHERE id = %s AND metadata->>'owner' = %s
                """,
                (thread_id, owner_id),
            )
            thread_row = await result.fetchone()

        if thread_row is None:
            return None

        thread_values = thread_row.get("values", {})
        if isinstance(thread_values, str):
            thread_values = json.loads(thread_values)

        thread_metadata = thread_row.get("metadata", {})
        if isinstance(thread_metadata, str):
            thread_metadata = json.loads(thread_metadata)

        now = _utc_now()
        return ThreadState(
            values=thread_values,
            next=[],
            tasks=[],
            checkpoint={
                "thread_id": thread_id,
                "checkpoint_ns": "",
                "checkpoint_id": _generate_id(),
            },
            metadata=thread_metadata,
            created_at=now.isoformat().replace("+00:00", "Z"),
            parent_checkpoint=None,
            interrupts=[],
        )

    async def add_state_snapshot(
        self, thread_id: str, state: dict[str, Any], owner_id: str
    ) -> bool:
        """Add a state snapshot to the thread's history."""
        async with self._pool.connection() as connection:
            # Verify ownership
            result = await connection.execute(
                f"SELECT id FROM {_SCHEMA}.threads WHERE id = %s AND metadata->>'owner' = %s",
                (thread_id, owner_id),
            )
            if await result.fetchone() is None:
                return False

            checkpoint_id = _generate_id()
            snapshot_values = state.get("values", {})

            # Insert state snapshot
            await connection.execute(
                f"""
                INSERT INTO {_SCHEMA}.thread_states
                    (thread_id, values, metadata, next, tasks, checkpoint_id,
                     parent_checkpoint, interrupts)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    thread_id,
                    _json_dumps(snapshot_values),
                    _json_dumps(state.get("metadata", {})),
                    state.get("next", []),
                    _json_dumps(state.get("tasks", [])),
                    checkpoint_id,
                    _json_dumps(state.get("parent_checkpoint")),
                    _json_dumps(state.get("interrupts", [])),
                ),
            )

            # Update thread's current values
            now = _utc_now()
            await connection.execute(
                f"""
                UPDATE {_SCHEMA}.threads
                SET values = %s, updated_at = %s
                WHERE id = %s
                """,
                (_json_dumps(snapshot_values), now, thread_id),
            )

        return True

    async def get_history(
        self, thread_id: str, owner_id: str, limit: int = 10, before: str | None = None
    ) -> list[ThreadState] | None:
        """Get state history for a thread."""
        async with self._pool.connection() as connection:
            # Verify ownership
            result = await connection.execute(
                f"SELECT id FROM {_SCHEMA}.threads WHERE id = %s AND metadata->>'owner' = %s",
                (thread_id, owner_id),
            )
            if await result.fetchone() is None:
                return None

            if before:
                result = await connection.execute(
                    f"""
                    SELECT values, metadata, next, tasks, checkpoint_id,
                           parent_checkpoint, interrupts, created_at
                    FROM {_SCHEMA}.thread_states
                    WHERE thread_id = %s
                      AND created_at < (
                          SELECT created_at FROM {_SCHEMA}.thread_states
                          WHERE checkpoint_id = %s AND thread_id = %s
                      )
                    ORDER BY created_at DESC
                    LIMIT %s
                    """,
                    (thread_id, before, thread_id, limit),
                )
            else:
                result = await connection.execute(
                    f"""
                    SELECT values, metadata, next, tasks, checkpoint_id,
                           parent_checkpoint, interrupts, created_at
                    FROM {_SCHEMA}.thread_states
                    WHERE thread_id = %s
                    ORDER BY created_at DESC
                    LIMIT %s
                    """,
                    (thread_id, limit),
                )

            rows = await result.fetchall()

        states = []
        for row in rows:
            row_values = row["values"]
            if isinstance(row_values, str):
                row_values = json.loads(row_values)
            row_metadata = row.get("metadata", {})
            if isinstance(row_metadata, str):
                row_metadata = json.loads(row_metadata)
            row_tasks = row.get("tasks", [])
            if isinstance(row_tasks, str):
                row_tasks = json.loads(row_tasks)
            row_parent = row.get("parent_checkpoint")
            if isinstance(row_parent, str):
                row_parent = json.loads(row_parent)
            row_interrupts = row.get("interrupts", [])
            if isinstance(row_interrupts, str):
                row_interrupts = json.loads(row_interrupts)

            states.append(
                ThreadState(
                    values=row_values,
                    next=row.get("next", []),
                    tasks=row_tasks,
                    checkpoint={
                        "thread_id": thread_id,
                        "checkpoint_ns": "",
                        "checkpoint_id": row.get("checkpoint_id", ""),
                    },
                    metadata=row_metadata,
                    created_at=row["created_at"].isoformat().replace("+00:00", "Z")
                    if isinstance(row["created_at"], datetime)
                    else str(row["created_at"]),
                    parent_checkpoint=row_parent,
                    interrupts=row_interrupts,
                )
            )

        return states

    async def count(self, owner_id: str, **filters: Any) -> int:
        """Count threads owned by the user."""
        return len(await self.list(owner_id, **filters))

    async def clear(self) -> None:
        """Clear all threads and state history (testing only)."""
        async with self._pool.connection() as connection:
            await connection.execute(f"DELETE FROM {_SCHEMA}.thread_states")
            await connection.execute(f"DELETE FROM {_SCHEMA}.threads")

    # -- helpers --

    @staticmethod
    def _row_to_model(row: dict[str, Any]) -> Thread:
        """Convert a database row dict to a Thread model."""
        metadata = row.get("metadata", {})
        if isinstance(metadata, str):
            metadata = json.loads(metadata)
        config = row.get("config", {})
        if isinstance(config, str):
            config = json.loads(config)
        values = row.get("values", {})
        if isinstance(values, str):
            values = json.loads(values)
        interrupts = row.get("interrupts", {})
        if isinstance(interrupts, str):
            interrupts = json.loads(interrupts)

        return Thread(
            thread_id=row["id"],
            metadata=metadata,
            config=config,
            status=row.get("status", "idle"),
            values=values,
            interrupts=interrupts,
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )


# ============================================================================
# Postgres Run Store
# ============================================================================


class PostgresRunStore:
    """Postgres-backed store for Run resources."""

    def __init__(self, pool: AsyncConnectionPool) -> None:
        self._pool = pool

    async def create(self, data: dict[str, Any], owner_id: str) -> Run:
        """Create a new run.

        Raises:
            ValueError: If ``thread_id`` or ``assistant_id`` is missing.
        """
        if "thread_id" not in data:
            raise ValueError("thread_id is required")
        if "assistant_id" not in data:
            raise ValueError("assistant_id is required")

        resource_id = _generate_id()
        now = _utc_now()

        metadata = data.get("metadata", {}).copy()
        metadata["owner"] = owner_id

        status = data.get("status", "pending")

        async with self._pool.connection() as connection:
            await connection.execute(
                f"""
                INSERT INTO {_SCHEMA}.runs
                    (id, thread_id, assistant_id, status, metadata, kwargs,
                     multitask_strategy, created_at, updated_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    resource_id,
                    data["thread_id"],
                    data["assistant_id"],
                    status,
                    _json_dumps(metadata),
                    _json_dumps(data.get("kwargs", {})),
                    data.get("multitask_strategy", "reject"),
                    now,
                    now,
                ),
            )

        return Run(
            run_id=resource_id,
            thread_id=data["thread_id"],
            assistant_id=data["assistant_id"],
            status=status,
            metadata=metadata,
            kwargs=data.get("kwargs", {}),
            multitask_strategy=data.get("multitask_strategy", "reject"),
            created_at=now,
            updated_at=now,
        )

    async def get(self, resource_id: str, owner_id: str) -> Run | None:
        """Get a run by ID if owned by the user."""
        async with self._pool.connection() as connection:
            result = await connection.execute(
                f"""
                SELECT id, thread_id, assistant_id, status, metadata, kwargs,
                       multitask_strategy, created_at, updated_at
                FROM {_SCHEMA}.runs
                WHERE id = %s AND metadata->>'owner' = %s
                """,
                (resource_id, owner_id),
            )
            row = await result.fetchone()

        return self._row_to_model(row) if row else None

    async def list(self, owner_id: str, **filters: Any) -> list[Run]:
        """List runs owned by the user."""
        async with self._pool.connection() as connection:
            result = await connection.execute(
                f"""
                SELECT id, thread_id, assistant_id, status, metadata, kwargs,
                       multitask_strategy, created_at, updated_at
                FROM {_SCHEMA}.runs
                WHERE metadata->>'owner' = %s
                ORDER BY created_at DESC
                """,
                (owner_id,),
            )
            rows = await result.fetchall()

        runs = [self._row_to_model(row) for row in rows]

        for key, value in filters.items():
            runs = [run for run in runs if getattr(run, key, None) == value]

        return runs

    async def list_by_thread(
        self,
        thread_id: str,
        owner_id: str,
        limit: int = 10,
        offset: int = 0,
        status: str | None = None,
    ) -> list[Run]:
        """List runs for a specific thread with pagination and filtering."""
        async with self._pool.connection() as connection:
            if status:
                result = await connection.execute(
                    f"""
                    SELECT id, thread_id, assistant_id, status, metadata, kwargs,
                           multitask_strategy, created_at, updated_at
                    FROM {_SCHEMA}.runs
                    WHERE thread_id = %s AND metadata->>'owner' = %s AND status = %s
                    ORDER BY created_at DESC
                    LIMIT %s OFFSET %s
                    """,
                    (thread_id, owner_id, status, limit, offset),
                )
            else:
                result = await connection.execute(
                    f"""
                    SELECT id, thread_id, assistant_id, status, metadata, kwargs,
                           multitask_strategy, created_at, updated_at
                    FROM {_SCHEMA}.runs
                    WHERE thread_id = %s AND metadata->>'owner' = %s
                    ORDER BY created_at DESC
                    LIMIT %s OFFSET %s
                    """,
                    (thread_id, owner_id, limit, offset),
                )

            rows = await result.fetchall()

        return [self._row_to_model(row) for row in rows]

    async def get_by_thread(
        self, thread_id: str, run_id: str, owner_id: str
    ) -> Run | None:
        """Get a specific run scoped to a thread."""
        run = await self.get(run_id, owner_id)
        if run is None:
            return None
        if run.thread_id != thread_id:
            return None
        return run

    async def delete_by_thread(
        self, thread_id: str, run_id: str, owner_id: str
    ) -> bool:
        """Delete a run scoped to a thread."""
        run = await self.get_by_thread(thread_id, run_id, owner_id)
        if run is None:
            return False
        return await self.delete(run_id, owner_id)

    async def get_active_run(self, thread_id: str, owner_id: str) -> Run | None:
        """Get the currently active (pending or running) run for a thread."""
        async with self._pool.connection() as connection:
            result = await connection.execute(
                f"""
                SELECT id, thread_id, assistant_id, status, metadata, kwargs,
                       multitask_strategy, created_at, updated_at
                FROM {_SCHEMA}.runs
                WHERE thread_id = %s AND metadata->>'owner' = %s
                  AND status IN ('pending', 'running')
                ORDER BY created_at DESC
                LIMIT 1
                """,
                (thread_id, owner_id),
            )
            row = await result.fetchone()

        return self._row_to_model(row) if row else None

    async def update_status(
        self, run_id: str, status: str, owner_id: str
    ) -> Run | None:
        """Update run status."""
        return await self.update(run_id, {"status": status}, owner_id)

    async def update(
        self, resource_id: str, data: dict[str, Any], owner_id: str
    ) -> Run | None:
        """Update a run if owned by the user."""
        async with self._pool.connection() as connection:
            result = await connection.execute(
                f"SELECT id FROM {_SCHEMA}.runs WHERE id = %s AND metadata->>'owner' = %s",
                (resource_id, owner_id),
            )
            if await result.fetchone() is None:
                return None

            now = _utc_now()
            updates: dict[str, Any] = {"updated_at": now}

            if "status" in data:
                updates["status"] = data["status"]
            if "kwargs" in data:
                updates["kwargs"] = _json_dumps(data["kwargs"])
            if "metadata" in data:
                updates["metadata"] = _json_dumps(data["metadata"])

            set_parts = []
            values = []
            for column_name, column_value in updates.items():
                set_parts.append(f"{column_name} = %s")
                values.append(column_value)

            values.extend([resource_id, owner_id])

            await connection.execute(
                f"""
                UPDATE {_SCHEMA}.runs
                SET {", ".join(set_parts)}
                WHERE id = %s AND metadata->>'owner' = %s
                """,
                tuple(values),
            )

            result = await connection.execute(
                f"""
                SELECT id, thread_id, assistant_id, status, metadata, kwargs,
                       multitask_strategy, created_at, updated_at
                FROM {_SCHEMA}.runs WHERE id = %s
                """,
                (resource_id,),
            )
            row = await result.fetchone()

        return self._row_to_model(row) if row else None

    async def delete(self, resource_id: str, owner_id: str) -> bool:
        """Delete a run if owned by the user."""
        async with self._pool.connection() as connection:
            result = await connection.execute(
                f"""
                DELETE FROM {_SCHEMA}.runs
                WHERE id = %s AND metadata->>'owner' = %s
                """,
                (resource_id, owner_id),
            )
            return result.rowcount > 0

    async def count_by_thread(self, thread_id: str, owner_id: str) -> int:
        """Count runs for a specific thread."""
        async with self._pool.connection() as connection:
            result = await connection.execute(
                f"""
                SELECT COUNT(*) as count
                FROM {_SCHEMA}.runs
                WHERE thread_id = %s AND metadata->>'owner' = %s
                """,
                (thread_id, owner_id),
            )
            row = await result.fetchone()

        return row["count"] if row else 0

    async def count(self, owner_id: str, **filters: Any) -> int:
        """Count runs owned by the user."""
        return len(await self.list(owner_id, **filters))

    async def clear(self) -> None:
        """Clear all runs (testing only)."""
        async with self._pool.connection() as connection:
            await connection.execute(f"DELETE FROM {_SCHEMA}.runs")

    # -- helpers --

    @staticmethod
    def _row_to_model(row: dict[str, Any]) -> Run:
        """Convert a database row dict to a Run model."""
        metadata = row.get("metadata", {})
        if isinstance(metadata, str):
            metadata = json.loads(metadata)
        kwargs = row.get("kwargs", {})
        if isinstance(kwargs, str):
            kwargs = json.loads(kwargs)

        return Run(
            run_id=row["id"],
            thread_id=row["thread_id"],
            assistant_id=row["assistant_id"],
            status=row.get("status", "pending"),
            metadata=metadata,
            kwargs=kwargs,
            multitask_strategy=row.get("multitask_strategy", "reject"),
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )


# ============================================================================
# Postgres Store Storage (Key-Value)
# ============================================================================


class PostgresStoreItem:
    """Represents a stored item from the Postgres Store API."""

    def __init__(
        self,
        namespace: str,
        key: str,
        value: Any,
        owner_id: str,
        metadata: dict[str, Any] | None = None,
        created_at: datetime | None = None,
        updated_at: datetime | None = None,
    ):
        self.namespace = namespace
        self.key = key
        self.value = value
        self.owner_id = owner_id
        self.metadata = metadata or {}
        self.created_at = created_at or _utc_now()
        self.updated_at = updated_at or _utc_now()

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary representation."""
        return {
            "namespace": self.namespace,
            "key": self.key,
            "value": self.value,
            "metadata": self.metadata,
            "created_at": self.created_at.isoformat()
            if isinstance(self.created_at, datetime)
            else str(self.created_at),
            "updated_at": self.updated_at.isoformat()
            if isinstance(self.updated_at, datetime)
            else str(self.updated_at),
        }


class PostgresStoreStorage:
    """Postgres-backed key-value storage with owner isolation."""

    def __init__(self, pool: AsyncConnectionPool) -> None:
        self._pool = pool

    async def put(
        self,
        namespace: str,
        key: str,
        value: Any,
        owner_id: str,
        metadata: dict[str, Any] | None = None,
    ) -> PostgresStoreItem:
        """Store or update an item (upsert)."""
        now = _utc_now()
        metadata = metadata or {}

        async with self._pool.connection() as connection:
            await connection.execute(
                f"""
                INSERT INTO {_SCHEMA}.store_items
                    (namespace, key, value, owner_id, metadata, created_at, updated_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (namespace, key, owner_id)
                DO UPDATE SET
                    value = EXCLUDED.value,
                    metadata = EXCLUDED.metadata,
                    updated_at = EXCLUDED.updated_at
                """,
                (
                    namespace,
                    key,
                    _json_dumps(value),
                    owner_id,
                    _json_dumps(metadata),
                    now,
                    now,
                ),
            )

        return PostgresStoreItem(
            namespace=namespace,
            key=key,
            value=value,
            owner_id=owner_id,
            metadata=metadata,
            created_at=now,
            updated_at=now,
        )

    async def get(
        self,
        namespace: str,
        key: str,
        owner_id: str,
    ) -> PostgresStoreItem | None:
        """Get an item by namespace and key."""
        async with self._pool.connection() as connection:
            result = await connection.execute(
                f"""
                SELECT namespace, key, value, owner_id, metadata, created_at, updated_at
                FROM {_SCHEMA}.store_items
                WHERE namespace = %s AND key = %s AND owner_id = %s
                """,
                (namespace, key, owner_id),
            )
            row = await result.fetchone()

        if row is None:
            return None

        value = row["value"]
        if isinstance(value, str):
            value = json.loads(value)
        row_metadata = row.get("metadata", {})
        if isinstance(row_metadata, str):
            row_metadata = json.loads(row_metadata)

        return PostgresStoreItem(
            namespace=row["namespace"],
            key=row["key"],
            value=value,
            owner_id=row["owner_id"],
            metadata=row_metadata,
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )

    async def delete(
        self,
        namespace: str,
        key: str,
        owner_id: str,
    ) -> bool:
        """Delete an item."""
        async with self._pool.connection() as connection:
            result = await connection.execute(
                f"""
                DELETE FROM {_SCHEMA}.store_items
                WHERE namespace = %s AND key = %s AND owner_id = %s
                """,
                (namespace, key, owner_id),
            )
            return result.rowcount > 0

    async def search(
        self,
        namespace: str,
        owner_id: str,
        prefix: str | None = None,
        limit: int = 10,
        offset: int = 0,
    ) -> list[PostgresStoreItem]:
        """Search items in a namespace."""
        async with self._pool.connection() as connection:
            if prefix:
                result = await connection.execute(
                    f"""
                    SELECT namespace, key, value, owner_id, metadata, created_at, updated_at
                    FROM {_SCHEMA}.store_items
                    WHERE namespace = %s AND owner_id = %s AND key LIKE %s
                    ORDER BY key
                    LIMIT %s OFFSET %s
                    """,
                    (namespace, owner_id, f"{prefix}%", limit, offset),
                )
            else:
                result = await connection.execute(
                    f"""
                    SELECT namespace, key, value, owner_id, metadata, created_at, updated_at
                    FROM {_SCHEMA}.store_items
                    WHERE namespace = %s AND owner_id = %s
                    ORDER BY key
                    LIMIT %s OFFSET %s
                    """,
                    (namespace, owner_id, limit, offset),
                )

            rows = await result.fetchall()

        items = []
        for row in rows:
            value = row["value"]
            if isinstance(value, str):
                value = json.loads(value)
            row_metadata = row.get("metadata", {})
            if isinstance(row_metadata, str):
                row_metadata = json.loads(row_metadata)

            items.append(
                PostgresStoreItem(
                    namespace=row["namespace"],
                    key=row["key"],
                    value=value,
                    owner_id=row["owner_id"],
                    metadata=row_metadata,
                    created_at=row["created_at"],
                    updated_at=row["updated_at"],
                )
            )

        return items

    async def list_namespaces(self, owner_id: str) -> list[str]:
        """List all namespaces for an owner."""
        async with self._pool.connection() as connection:
            result = await connection.execute(
                f"""
                SELECT DISTINCT namespace
                FROM {_SCHEMA}.store_items
                WHERE owner_id = %s
                ORDER BY namespace
                """,
                (owner_id,),
            )
            rows = await result.fetchall()

        return [row["namespace"] for row in rows]

    async def clear(self) -> None:
        """Clear all items (testing only)."""
        async with self._pool.connection() as connection:
            await connection.execute(f"DELETE FROM {_SCHEMA}.store_items")


# ============================================================================
# Postgres Cron Store
# ============================================================================


class PostgresCronStore:
    """Postgres-backed store for Cron resources."""

    def __init__(self, pool: AsyncConnectionPool) -> None:
        self._pool = pool

    async def create(self, data: dict[str, Any], owner_id: str) -> Cron:
        """Create a new cron."""
        resource_id = _generate_id()
        now = _utc_now()

        metadata = data.get("metadata", {}).copy()
        metadata["owner"] = owner_id

        async with self._pool.connection() as connection:
            await connection.execute(
                f"""
                INSERT INTO {_SCHEMA}.crons
                    (id, assistant_id, thread_id, end_time, schedule, user_id,
                     payload, next_run_date, metadata, created_at, updated_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    resource_id,
                    data.get("assistant_id"),
                    data.get("thread_id"),
                    data.get("end_time"),
                    data["schedule"],
                    data.get("user_id"),
                    _json_dumps(data.get("payload", {})),
                    data.get("next_run_date"),
                    _json_dumps(metadata),
                    now,
                    now,
                ),
            )

        return self._build_model(
            resource_id=resource_id,
            data=data,
            metadata=metadata,
            created_at=now,
            updated_at=now,
        )

    async def get(self, resource_id: str, owner_id: str) -> Cron | None:
        """Get a cron by ID if owned by the user."""
        async with self._pool.connection() as connection:
            result = await connection.execute(
                f"""
                SELECT id, assistant_id, thread_id, end_time, schedule,
                       user_id, payload, next_run_date, metadata,
                       created_at, updated_at
                FROM {_SCHEMA}.crons
                WHERE id = %s AND metadata->>'owner' = %s
                """,
                (resource_id, owner_id),
            )
            row = await result.fetchone()

        return self._row_to_model(row) if row else None

    async def list(
        self, owner_id: str, assistant_id: str | None = None, **filters: Any
    ) -> list[Cron]:
        """List crons owned by the user, optionally filtered."""
        async with self._pool.connection() as connection:
            if assistant_id:
                result = await connection.execute(
                    f"""
                    SELECT id, assistant_id, thread_id, end_time, schedule,
                           user_id, payload, next_run_date, metadata,
                           created_at, updated_at
                    FROM {_SCHEMA}.crons
                    WHERE metadata->>'owner' = %s AND assistant_id = %s
                    ORDER BY created_at DESC
                    """,
                    (owner_id, assistant_id),
                )
            else:
                result = await connection.execute(
                    f"""
                    SELECT id, assistant_id, thread_id, end_time, schedule,
                           user_id, payload, next_run_date, metadata,
                           created_at, updated_at
                    FROM {_SCHEMA}.crons
                    WHERE metadata->>'owner' = %s
                    ORDER BY created_at DESC
                    """,
                    (owner_id,),
                )

            rows = await result.fetchall()

        crons = [self._row_to_model(row) for row in rows]

        # Apply remaining filters
        for key, value in filters.items():
            if key == "assistant_id":
                continue  # Already handled in SQL
            crons = [cron for cron in crons if getattr(cron, key, None) == value]

        return crons

    async def update(
        self,
        cron_id: str,
        owner_id: str,
        updates: dict[str, Any],
    ) -> Cron | None:
        """Update a cron job."""
        async with self._pool.connection() as connection:
            # Verify ownership
            result = await connection.execute(
                f"SELECT id FROM {_SCHEMA}.crons WHERE id = %s AND metadata->>'owner' = %s",
                (cron_id, owner_id),
            )
            if await result.fetchone() is None:
                return None

            now = _utc_now()
            set_updates: dict[str, Any] = {"updated_at": now}

            if "schedule" in updates:
                set_updates["schedule"] = updates["schedule"]
            if "next_run_date" in updates:
                set_updates["next_run_date"] = updates["next_run_date"]
            if "end_time" in updates:
                set_updates["end_time"] = updates["end_time"]
            if "payload" in updates:
                set_updates["payload"] = _json_dumps(updates["payload"])
            if "metadata" in updates:
                set_updates["metadata"] = _json_dumps(updates["metadata"])

            set_parts = []
            values = []
            for column_name, column_value in set_updates.items():
                set_parts.append(f"{column_name} = %s")
                values.append(column_value)

            values.extend([cron_id, owner_id])

            await connection.execute(
                f"""
                UPDATE {_SCHEMA}.crons
                SET {", ".join(set_parts)}
                WHERE id = %s AND metadata->>'owner' = %s
                """,
                tuple(values),
            )

            # Fetch updated
            result = await connection.execute(
                f"""
                SELECT id, assistant_id, thread_id, end_time, schedule,
                       user_id, payload, next_run_date, metadata,
                       created_at, updated_at
                FROM {_SCHEMA}.crons WHERE id = %s
                """,
                (cron_id,),
            )
            row = await result.fetchone()

        return self._row_to_model(row) if row else None

    async def delete(self, resource_id: str, owner_id: str) -> bool:
        """Delete a cron if owned by the user."""
        async with self._pool.connection() as connection:
            result = await connection.execute(
                f"""
                DELETE FROM {_SCHEMA}.crons
                WHERE id = %s AND metadata->>'owner' = %s
                """,
                (resource_id, owner_id),
            )
            return result.rowcount > 0

    async def count(
        self, owner_id: str, assistant_id: str | None = None, **filters: Any
    ) -> int:
        """Count crons matching filters."""
        async with self._pool.connection() as connection:
            if assistant_id:
                result = await connection.execute(
                    f"""
                    SELECT COUNT(*) as count
                    FROM {_SCHEMA}.crons
                    WHERE metadata->>'owner' = %s AND assistant_id = %s
                    """,
                    (owner_id, assistant_id),
                )
            else:
                result = await connection.execute(
                    f"""
                    SELECT COUNT(*) as count
                    FROM {_SCHEMA}.crons
                    WHERE metadata->>'owner' = %s
                    """,
                    (owner_id,),
                )

            row = await result.fetchone()

        return row["count"] if row else 0

    async def clear(self) -> None:
        """Clear all crons (testing only)."""
        async with self._pool.connection() as connection:
            await connection.execute(f"DELETE FROM {_SCHEMA}.crons")

    # -- helpers --

    @staticmethod
    def _build_model(
        *,
        resource_id: str,
        data: dict[str, Any],
        metadata: dict[str, Any],
        created_at: datetime,
        updated_at: datetime,
    ) -> Cron:
        """Build a Cron model from insert data."""
        from server.crons.schemas import Cron as CronModel

        return CronModel(
            cron_id=resource_id,
            assistant_id=data.get("assistant_id"),
            thread_id=data.get("thread_id", ""),
            end_time=data.get("end_time"),
            schedule=data["schedule"],
            user_id=data.get("user_id"),
            payload=data.get("payload", {}),
            next_run_date=data.get("next_run_date"),
            metadata=metadata,
            created_at=created_at,
            updated_at=updated_at,
        )

    @staticmethod
    def _row_to_model(row: dict[str, Any]) -> Cron:
        """Convert a database row dict to a Cron model."""
        from server.crons.schemas import Cron as CronModel

        metadata = row.get("metadata", {})
        if isinstance(metadata, str):
            metadata = json.loads(metadata)
        payload = row.get("payload", {})
        if isinstance(payload, str):
            payload = json.loads(payload)

        return CronModel(
            cron_id=row["id"],
            assistant_id=row.get("assistant_id"),
            thread_id=row.get("thread_id", ""),
            end_time=row.get("end_time"),
            schedule=row["schedule"],
            user_id=row.get("user_id"),
            payload=payload,
            next_run_date=row.get("next_run_date"),
            metadata=metadata,
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )


# ============================================================================
# Postgres Storage Container
# ============================================================================


class PostgresStorage:
    """Container for all Postgres-backed resource stores.

    Provides the same interface as the in-memory ``Storage`` class.
    """

    def __init__(self, pool: AsyncConnectionPool) -> None:
        self._pool = pool
        self.assistants = PostgresAssistantStore(pool)
        self.threads = PostgresThreadStore(pool)
        self.runs = PostgresRunStore(pool)
        self.store = PostgresStoreStorage(pool)
        self.crons = PostgresCronStore(pool)

    async def run_migrations(self) -> None:
        """Run DDL migrations to create the ``langgraph_server`` schema and tables.

        All statements are idempotent (``CREATE … IF NOT EXISTS``), so this
        is safe to call on every startup.
        """
        async with self._pool.connection() as connection:
            # Execute each statement separately for compatibility.
            # psycopg doesn't support multi-statement execute in all modes.
            for statement in _DDL.split(";"):
                statement = statement.strip()
                if statement:
                    await connection.execute(statement)

        logger.info("langgraph_server schema and tables ready")

    async def clear_all(self) -> None:
        """Clear all stores (testing only)."""
        await self.runs.clear()
        await self.threads.clear()
        await self.assistants.clear()
        await self.store.clear()
        await self.crons.clear()
