"""Unit tests for ``server.postgres_storage`` with mocked ``AsyncConnection``.

These tests exercise all five Postgres-backed stores (assistants, threads,
runs, store-items, crons) **without** a real database.  Every DB interaction
is intercepted by a lightweight mock connection factory.

Coverage targets
~~~~~~~~~~~~~~~~
``postgres_storage.py`` is 514 statements at 0 %.  This file aims for ~70 %
(~360 statements) which is the single largest coverage gain in the project.
"""

from __future__ import annotations

import json
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any

import pytest

from server.postgres_storage import (
    PostgresAssistantStore,
    PostgresCronStore,
    PostgresRunStore,
    PostgresStorage,
    PostgresStoreItem,
    PostgresStoreStorage,
    PostgresThreadStore,
    _generate_id,
    _json_dumps,
    _utc_now,
)
from server.models import Assistant, AssistantConfig, Run, Thread, ThreadState


# ---------------------------------------------------------------------------
# Mock infrastructure
# ---------------------------------------------------------------------------


class MockCursor:
    """Minimal async cursor returned by ``MockConnection.execute()``."""

    def __init__(
        self,
        rows: list[dict[str, Any]] | None = None,
        rowcount: int = 0,
    ) -> None:
        self._rows = rows or []
        self.rowcount = rowcount

    async def fetchone(self) -> dict[str, Any] | None:
        return self._rows[0] if self._rows else None

    async def fetchall(self) -> list[dict[str, Any]]:
        return self._rows


class MockConnection:
    """Async connection that records executed queries and returns preset rows."""

    def __init__(self, cursors: list[MockCursor] | None = None) -> None:
        self.executed: list[tuple[str, tuple[Any, ...] | None]] = []
        self._cursors = list(cursors) if cursors else []
        self._call_index = 0

    async def execute(
        self, query: str, params: tuple[Any, ...] | None = None
    ) -> MockCursor:
        self.executed.append((query, params))
        if self._call_index < len(self._cursors):
            cursor = self._cursors[self._call_index]
            self._call_index += 1
            return cursor
        return MockCursor()


def _make_factory(*cursors: MockCursor):
    """Return ``(factory_callable, connection_ref)`` for a mock connection.

    ``connection_ref`` is populated on first use so callers can inspect
    ``connection_ref[0].executed`` after the test.
    """
    connection = MockConnection(list(cursors))
    refs: list[MockConnection] = [connection]

    @asynccontextmanager
    async def factory():
        yield refs[0]

    return factory, refs


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ---------------------------------------------------------------------------
# Helper function tests
# ---------------------------------------------------------------------------


class TestHelperFunctions:
    """Cover ``_generate_id``, ``_utc_now``, ``_json_dumps``."""

    def test_generate_id_is_hex32(self):
        result = _generate_id()
        assert isinstance(result, str)
        assert len(result) == 32
        int(result, 16)  # must be valid hex

    def test_generate_id_unique(self):
        ids = {_generate_id() for _ in range(50)}
        assert len(ids) == 50

    def test_utc_now_is_timezone_aware(self):
        now = _utc_now()
        assert now.tzinfo is not None
        assert now.tzinfo == timezone.utc

    def test_json_dumps_dict(self):
        result = _json_dumps({"a": 1})
        assert json.loads(result) == {"a": 1}

    def test_json_dumps_datetime(self):
        dt = datetime(2026, 1, 1, tzinfo=timezone.utc)
        result = _json_dumps({"ts": dt})
        parsed = json.loads(result)
        assert "2026" in parsed["ts"]

    def test_json_dumps_empty(self):
        assert _json_dumps({}) == "{}"


# ============================================================================
# PostgresAssistantStore
# ============================================================================


class TestPostgresAssistantStoreCreate:
    """Tests for ``PostgresAssistantStore.create()``."""

    async def test_create_basic(self):
        factory, refs = _make_factory()
        store = PostgresAssistantStore(factory)

        assistant = await store.create({"graph_id": "agent"}, "user-1")

        assert isinstance(assistant, Assistant)
        assert assistant.graph_id == "agent"
        assert assistant.metadata["owner"] == "user-1"
        assert assistant.assistant_id  # non-empty
        assert assistant.created_at is not None
        assert len(refs[0].executed) == 1
        sql = refs[0].executed[0][0]
        assert "INSERT INTO" in sql

    async def test_create_with_deterministic_id(self):
        """Bug 1 fix: caller-provided ``assistant_id`` must be honoured."""
        factory, _ = _make_factory()
        store = PostgresAssistantStore(factory)

        assistant = await store.create(
            {"assistant_id": "det-id-123", "graph_id": "agent"},
            "system",
        )

        assert assistant.assistant_id == "det-id-123"

    async def test_create_without_assistant_id_autogenerates(self):
        factory, _ = _make_factory()
        store = PostgresAssistantStore(factory)

        assistant = await store.create({"graph_id": "agent"}, "user-1")

        assert assistant.assistant_id is not None
        assert assistant.assistant_id != ""

    async def test_create_requires_graph_id(self):
        factory, _ = _make_factory()
        store = PostgresAssistantStore(factory)

        with pytest.raises(ValueError, match="graph_id is required"):
            await store.create({"name": "no-graph"}, "user-1")

    async def test_create_preserves_config(self):
        factory, _ = _make_factory()
        store = PostgresAssistantStore(factory)

        assistant = await store.create(
            {
                "graph_id": "agent",
                "config": {"configurable": {"model": "gpt-4o"}},
            },
            "user-1",
        )

        assert assistant.config.configurable == {"model": "gpt-4o"}

    async def test_create_preserves_metadata(self):
        factory, _ = _make_factory()
        store = PostgresAssistantStore(factory)

        assistant = await store.create(
            {
                "graph_id": "agent",
                "metadata": {"custom": "value"},
            },
            "user-1",
        )

        assert assistant.metadata["custom"] == "value"
        assert assistant.metadata["owner"] == "user-1"

    async def test_create_with_name_and_description(self):
        factory, _ = _make_factory()
        store = PostgresAssistantStore(factory)

        assistant = await store.create(
            {
                "graph_id": "agent",
                "name": "My Bot",
                "description": "A test bot",
            },
            "user-1",
        )

        assert assistant.name == "My Bot"
        assert assistant.description == "A test bot"

    async def test_create_default_version(self):
        factory, _ = _make_factory()
        store = PostgresAssistantStore(factory)

        assistant = await store.create({"graph_id": "agent"}, "user-1")

        assert assistant.version == 1

    async def test_create_custom_version(self):
        factory, _ = _make_factory()
        store = PostgresAssistantStore(factory)

        assistant = await store.create({"graph_id": "agent", "version": 5}, "user-1")

        assert assistant.version == 5


class TestPostgresAssistantStoreGet:
    """Tests for ``PostgresAssistantStore.get()``."""

    async def test_get_found(self):
        now = _now()
        row = {
            "id": "abc",
            "graph_id": "agent",
            "config": json.dumps({"configurable": {}}),
            "context": json.dumps({}),
            "metadata": json.dumps({"owner": "user-1"}),
            "name": "Bot",
            "description": None,
            "version": 1,
            "created_at": now,
            "updated_at": now,
        }
        factory, refs = _make_factory(MockCursor([row]))
        store = PostgresAssistantStore(factory)

        result = await store.get("abc", "user-1")

        assert result is not None
        assert result.assistant_id == "abc"
        assert result.name == "Bot"
        # Verify the SQL uses system-owner visibility
        sql = refs[0].executed[0][0]
        assert "metadata->>'owner'" in sql

    async def test_get_not_found(self):
        factory, _ = _make_factory(MockCursor([]))
        store = PostgresAssistantStore(factory)

        result = await store.get("nonexistent", "user-1")

        assert result is None

    async def test_get_system_visibility(self):
        """Bug 2 fix: system-owner assistants visible to real users."""
        now = _now()
        row = {
            "id": "sys-assistant",
            "graph_id": "agent",
            "config": json.dumps({}),
            "context": json.dumps({}),
            "metadata": json.dumps({"owner": "system"}),
            "name": None,
            "description": None,
            "version": 1,
            "created_at": now,
            "updated_at": now,
        }
        factory, refs = _make_factory(MockCursor([row]))
        store = PostgresAssistantStore(factory)

        result = await store.get("sys-assistant", "user-abc")

        assert result is not None
        sql = refs[0].executed[0][0]
        assert "system" in sql or "OR" in sql


class TestPostgresAssistantStoreList:
    """Tests for ``PostgresAssistantStore.list()``."""

    async def test_list_returns_rows(self):
        now = _now()
        rows = [
            {
                "id": f"a-{i}",
                "graph_id": "agent",
                "config": json.dumps({}),
                "context": json.dumps({}),
                "metadata": json.dumps({"owner": "user-1"}),
                "name": f"Bot {i}",
                "description": None,
                "version": 1,
                "created_at": now,
                "updated_at": now,
            }
            for i in range(3)
        ]
        factory, _ = _make_factory(MockCursor(rows))
        store = PostgresAssistantStore(factory)

        result = await store.list("user-1")

        assert len(result) == 3
        assert all(isinstance(a, Assistant) for a in result)

    async def test_list_empty(self):
        factory, _ = _make_factory(MockCursor([]))
        store = PostgresAssistantStore(factory)

        result = await store.list("user-1")

        assert result == []

    async def test_list_with_filter(self):
        now = _now()
        rows = [
            {
                "id": "a-1",
                "graph_id": "agent",
                "config": json.dumps({}),
                "context": json.dumps({}),
                "metadata": json.dumps({"owner": "user-1"}),
                "name": "Bot",
                "description": None,
                "version": 1,
                "created_at": now,
                "updated_at": now,
            },
            {
                "id": "a-2",
                "graph_id": "other",
                "config": json.dumps({}),
                "context": json.dumps({}),
                "metadata": json.dumps({"owner": "user-1"}),
                "name": "Other",
                "description": None,
                "version": 1,
                "created_at": now,
                "updated_at": now,
            },
        ]
        factory, _ = _make_factory(MockCursor(rows))
        store = PostgresAssistantStore(factory)

        result = await store.list("user-1", graph_id="agent")

        assert len(result) == 1
        assert result[0].graph_id == "agent"

    async def test_list_includes_system_assistants(self):
        """Bug 2 fix: SQL includes system-owned rows."""
        factory, refs = _make_factory(MockCursor([]))
        store = PostgresAssistantStore(factory)

        await store.list("user-abc")

        sql = refs[0].executed[0][0]
        # The SQL must include an OR for system visibility
        assert "OR" in sql


class TestPostgresAssistantStoreUpdate:
    """Tests for ``PostgresAssistantStore.update()``."""

    async def test_update_found(self):
        now = _now()
        existing_row = {
            "id": "abc",
            "graph_id": "agent",
            "config": json.dumps({}),
            "context": json.dumps({}),
            "metadata": json.dumps({"owner": "user-1"}),
            "name": "Old",
            "description": None,
            "version": 1,
            "created_at": now,
            "updated_at": now,
        }
        updated_row = {**existing_row, "name": "New", "version": 2}

        # First call: SELECT to check existence, Second: UPDATE, Third: SELECT updated
        factory, _ = _make_factory(
            MockCursor([existing_row]),  # ownership check
            MockCursor(),  # UPDATE
            MockCursor([updated_row]),  # SELECT updated
        )
        store = PostgresAssistantStore(factory)

        result = await store.update("abc", {"name": "New"}, "user-1")

        assert result is not None
        assert result.name == "New"

    async def test_update_not_found(self):
        factory, _ = _make_factory(MockCursor([]))
        store = PostgresAssistantStore(factory)

        result = await store.update("nonexistent", {"name": "X"}, "user-1")

        assert result is None


class TestPostgresAssistantStoreDelete:
    """Tests for ``PostgresAssistantStore.delete()``."""

    async def test_delete_success(self):
        factory, _ = _make_factory(MockCursor(rowcount=1))
        store = PostgresAssistantStore(factory)

        result = await store.delete("abc", "user-1")

        assert result is True

    async def test_delete_not_found(self):
        factory, _ = _make_factory(MockCursor(rowcount=0))
        store = PostgresAssistantStore(factory)

        result = await store.delete("nonexistent", "user-1")

        assert result is False


class TestPostgresAssistantStoreCountAndClear:
    """Tests for count and clear."""

    async def test_count_delegates_to_list(self):
        now = _now()
        rows = [
            {
                "id": f"a-{i}",
                "graph_id": "agent",
                "config": json.dumps({}),
                "context": json.dumps({}),
                "metadata": json.dumps({"owner": "u"}),
                "name": None,
                "description": None,
                "version": 1,
                "created_at": now,
                "updated_at": now,
            }
            for i in range(2)
        ]
        factory, _ = _make_factory(MockCursor(rows))
        store = PostgresAssistantStore(factory)

        count = await store.count("u")

        assert count == 2

    async def test_clear(self):
        factory, refs = _make_factory()
        store = PostgresAssistantStore(factory)

        await store.clear()

        assert len(refs[0].executed) == 1
        assert "DELETE" in refs[0].executed[0][0]


class TestPostgresAssistantStoreBuildModel:
    """Test ``_build_model`` and ``_row_to_model`` helpers."""

    def test_build_model_with_dict_config(self):
        now = _now()
        assistant = PostgresAssistantStore._build_model(
            resource_id="r1",
            graph_id="agent",
            config={"configurable": {"k": "v"}},
            context={},
            metadata={"owner": "u"},
            name="N",
            description="D",
            version=2,
            created_at=now,
            updated_at=now,
        )

        assert assistant.assistant_id == "r1"
        assert assistant.config.configurable == {"k": "v"}
        assert assistant.version == 2

    def test_build_model_with_json_string_config(self):
        now = _now()
        assistant = PostgresAssistantStore._build_model(
            resource_id="r2",
            graph_id="agent",
            config=json.dumps({"configurable": {"x": 1}}),
            context=json.dumps({}),
            metadata=json.dumps({"owner": "u"}),
            name=None,
            description=None,
            version=1,
            created_at=now,
            updated_at=now,
        )

        assert assistant.config.configurable == {"x": 1}
        assert assistant.metadata["owner"] == "u"

    def test_build_model_with_assistant_config_instance(self):
        now = _now()
        config = AssistantConfig(
            tags=["test"], recursion_limit=10, configurable={"m": "v"}
        )
        assistant = PostgresAssistantStore._build_model(
            resource_id="r3",
            graph_id="agent",
            config=config,
            context={},
            metadata={},
            name=None,
            description=None,
            version=1,
            created_at=now,
            updated_at=now,
        )

        assert assistant.config.tags == ["test"]
        assert assistant.config.recursion_limit == 10

    def test_row_to_model(self):
        now = _now()
        row = {
            "id": "row-1",
            "graph_id": "agent",
            "config": {"configurable": {}},
            "context": {},
            "metadata": {"owner": "u"},
            "name": "R",
            "description": None,
            "version": 3,
            "created_at": now,
            "updated_at": now,
        }

        assistant = PostgresAssistantStore._row_to_model(row)

        assert assistant.assistant_id == "row-1"
        assert assistant.version == 3


# ============================================================================
# PostgresThreadStore
# ============================================================================


def _make_thread_row(
    thread_id: str = "t-1",
    owner: str = "user-1",
    status: str = "idle",
    **overrides: Any,
) -> dict[str, Any]:
    now = _now()
    row = {
        "id": thread_id,
        "metadata": json.dumps({"owner": owner}),
        "config": json.dumps({}),
        "status": status,
        "values": json.dumps({}),
        "interrupts": json.dumps({}),
        "created_at": now,
        "updated_at": now,
    }
    row.update(overrides)
    return row


class TestPostgresThreadStore:
    """Tests for ``PostgresThreadStore``."""

    async def test_create(self):
        factory, refs = _make_factory()
        store = PostgresThreadStore(factory)

        thread = await store.create({}, "user-1")

        assert isinstance(thread, Thread)
        assert thread.metadata["owner"] == "user-1"
        assert thread.status == "idle"
        assert len(refs[0].executed) == 1

    async def test_create_with_status(self):
        factory, _ = _make_factory()
        store = PostgresThreadStore(factory)

        thread = await store.create({"status": "busy"}, "user-1")

        assert thread.status == "busy"

    async def test_get_found(self):
        row = _make_thread_row()
        factory, _ = _make_factory(MockCursor([row]))
        store = PostgresThreadStore(factory)

        result = await store.get("t-1", "user-1")

        assert result is not None
        assert result.thread_id == "t-1"

    async def test_get_not_found(self):
        factory, _ = _make_factory(MockCursor([]))
        store = PostgresThreadStore(factory)

        result = await store.get("nope", "user-1")

        assert result is None

    async def test_list(self):
        rows = [_make_thread_row(f"t-{i}") for i in range(3)]
        factory, _ = _make_factory(MockCursor(rows))
        store = PostgresThreadStore(factory)

        result = await store.list("user-1")

        assert len(result) == 3

    async def test_list_empty(self):
        factory, _ = _make_factory(MockCursor([]))
        store = PostgresThreadStore(factory)

        result = await store.list("user-1")

        assert result == []

    async def test_list_with_filter(self):
        rows = [
            _make_thread_row("t-1", status="idle"),
            _make_thread_row("t-2", status="busy"),
        ]
        factory, _ = _make_factory(MockCursor(rows))
        store = PostgresThreadStore(factory)

        result = await store.list("user-1", status="busy")

        assert len(result) == 1
        assert result[0].status == "busy"

    async def test_update_not_found(self):
        factory, _ = _make_factory(MockCursor([]))
        store = PostgresThreadStore(factory)

        result = await store.update("nope", {"status": "x"}, "user-1")

        assert result is None

    async def test_update_found(self):
        existing = {"metadata": json.dumps({"owner": "user-1"})}
        updated_row = _make_thread_row("t-1", status="busy")
        factory, _ = _make_factory(
            MockCursor([existing]),  # ownership check
            MockCursor(),  # UPDATE
            MockCursor([updated_row]),  # SELECT updated
        )
        store = PostgresThreadStore(factory)

        result = await store.update("t-1", {"status": "busy"}, "user-1")

        assert result is not None
        assert result.status == "busy"

    async def test_update_with_metadata_merge(self):
        existing = {"metadata": json.dumps({"owner": "user-1", "old": "val"})}
        updated_row = _make_thread_row("t-1")
        factory, refs = _make_factory(
            MockCursor([existing]),
            MockCursor(),
            MockCursor([updated_row]),
        )
        store = PostgresThreadStore(factory)

        result = await store.update("t-1", {"metadata": {"new": "val2"}}, "user-1")

        assert result is not None
        # The update SQL should have been executed
        assert len(refs[0].executed) == 3

    async def test_update_with_values_and_config(self):
        existing = {"metadata": json.dumps({"owner": "user-1"})}
        updated_row = _make_thread_row("t-1")
        factory, _ = _make_factory(
            MockCursor([existing]),
            MockCursor(),
            MockCursor([updated_row]),
        )
        store = PostgresThreadStore(factory)

        result = await store.update(
            "t-1",
            {"values": {"k": "v"}, "config": {"c": 1}, "interrupts": {"i": 2}},
            "user-1",
        )

        assert result is not None

    async def test_update_returns_none_when_refetch_empty(self):
        existing = {"metadata": json.dumps({"owner": "user-1"})}
        factory, _ = _make_factory(
            MockCursor([existing]),  # ownership
            MockCursor(),  # UPDATE
            MockCursor([]),  # refetch returns nothing (edge case)
        )
        store = PostgresThreadStore(factory)

        result = await store.update("t-1", {"status": "x"}, "user-1")

        assert result is None

    async def test_delete_success(self):
        factory, _ = _make_factory(MockCursor(rowcount=1))
        store = PostgresThreadStore(factory)

        result = await store.delete("t-1", "user-1")

        assert result is True

    async def test_delete_not_found(self):
        factory, _ = _make_factory(MockCursor(rowcount=0))
        store = PostgresThreadStore(factory)

        result = await store.delete("nope", "user-1")

        assert result is False

    async def test_get_state_found(self):
        thread_row = {
            "id": "t-1",
            "metadata": json.dumps({"owner": "user-1", "k": "v"}),
            "values": json.dumps({"msg": "hello"}),
        }
        factory, _ = _make_factory(MockCursor([thread_row]))
        store = PostgresThreadStore(factory)

        state = await store.get_state("t-1", "user-1")

        assert state is not None
        assert isinstance(state, ThreadState)
        assert state.values == {"msg": "hello"}
        assert state.metadata["k"] == "v"

    async def test_get_state_with_json_string_values(self):
        thread_row = {
            "id": "t-1",
            "metadata": '{"owner": "user-1"}',
            "values": '{"data": 42}',
        }
        factory, _ = _make_factory(MockCursor([thread_row]))
        store = PostgresThreadStore(factory)

        state = await store.get_state("t-1", "user-1")

        assert state is not None
        assert state.values == {"data": 42}

    async def test_get_state_not_found(self):
        factory, _ = _make_factory(MockCursor([]))
        store = PostgresThreadStore(factory)

        state = await store.get_state("nope", "user-1")

        assert state is None

    async def test_add_state_snapshot_success(self):
        factory, _ = _make_factory(
            MockCursor([{"id": "t-1"}]),  # ownership check
            MockCursor(),  # INSERT snapshot
            MockCursor(),  # UPDATE thread values
        )
        store = PostgresThreadStore(factory)

        result = await store.add_state_snapshot(
            "t-1", {"values": {"msg": "hi"}, "metadata": {}}, "user-1"
        )

        assert result is True

    async def test_add_state_snapshot_not_owned(self):
        factory, _ = _make_factory(MockCursor([]))
        store = PostgresThreadStore(factory)

        result = await store.add_state_snapshot("t-1", {}, "user-1")

        assert result is False

    async def test_get_history_not_owned(self):
        factory, _ = _make_factory(MockCursor([]))
        store = PostgresThreadStore(factory)

        result = await store.get_history("t-1", "user-1")

        assert result is None

    async def test_get_history_empty(self):
        factory, _ = _make_factory(
            MockCursor([{"id": "t-1"}]),  # ownership
            MockCursor([]),  # no snapshots
        )
        store = PostgresThreadStore(factory)

        result = await store.get_history("t-1", "user-1")

        assert result is not None
        assert result == []

    async def test_get_history_with_rows(self):
        now = _now()
        snapshot_row = {
            "values": json.dumps({"msg": "hi"}),
            "metadata": json.dumps({"k": "v"}),
            "next": [],
            "tasks": json.dumps([]),
            "checkpoint_id": "ckpt-1",
            "parent_checkpoint": json.dumps(None),
            "interrupts": json.dumps([]),
            "created_at": now,
        }
        factory, _ = _make_factory(
            MockCursor([{"id": "t-1"}]),  # ownership
            MockCursor([snapshot_row]),
        )
        store = PostgresThreadStore(factory)

        result = await store.get_history("t-1", "user-1")

        assert result is not None
        assert len(result) == 1
        assert isinstance(result[0], ThreadState)
        assert result[0].values == {"msg": "hi"}

    async def test_get_history_with_string_fields(self):
        """Cover JSON string deserialization in history rows."""
        now = _now()
        snapshot_row = {
            "values": '{"v": 1}',
            "metadata": '{"m": 2}',
            "next": ["step"],
            "tasks": '[{"id": "t"}]',
            "checkpoint_id": "ckpt-2",
            "parent_checkpoint": '{"parent": true}',
            "interrupts": '[{"type": "x"}]',
            "created_at": now,
        }
        factory, _ = _make_factory(
            MockCursor([{"id": "t-1"}]),
            MockCursor([snapshot_row]),
        )
        store = PostgresThreadStore(factory)

        result = await store.get_history("t-1", "user-1")

        assert len(result) == 1
        assert result[0].values == {"v": 1}
        assert result[0].metadata == {"m": 2}
        assert result[0].tasks == [{"id": "t"}]
        assert result[0].parent_checkpoint == {"parent": True}
        assert result[0].interrupts == [{"type": "x"}]

    async def test_get_history_with_string_created_at(self):
        """Cover string ``created_at`` branch."""
        snapshot_row = {
            "values": json.dumps({}),
            "metadata": json.dumps({}),
            "next": [],
            "tasks": json.dumps([]),
            "checkpoint_id": "ckpt-3",
            "parent_checkpoint": json.dumps(None),
            "interrupts": json.dumps([]),
            "created_at": "2026-01-01T00:00:00Z",  # string, not datetime
        }
        factory, _ = _make_factory(
            MockCursor([{"id": "t-1"}]),
            MockCursor([snapshot_row]),
        )
        store = PostgresThreadStore(factory)

        result = await store.get_history("t-1", "user-1")

        assert len(result) == 1
        assert "2026" in result[0].created_at

    async def test_get_history_with_before_cursor(self):
        factory, refs = _make_factory(
            MockCursor([{"id": "t-1"}]),  # ownership
            MockCursor([]),  # history query
        )
        store = PostgresThreadStore(factory)

        result = await store.get_history("t-1", "user-1", before="ckpt-0")

        assert result == []
        # Should have used the before-cursor SQL
        sql = refs[0].executed[1][0]
        assert "checkpoint_id" in sql

    async def test_count(self):
        rows = [_make_thread_row(f"t-{i}") for i in range(4)]
        factory, _ = _make_factory(MockCursor(rows))
        store = PostgresThreadStore(factory)

        count = await store.count("user-1")

        assert count == 4

    async def test_clear(self):
        factory, refs = _make_factory()
        store = PostgresThreadStore(factory)

        await store.clear()

        assert len(refs[0].executed) == 2  # DELETE thread_states + DELETE threads

    async def test_row_to_model_with_json_strings(self):
        now = _now()
        row = {
            "id": "t-json",
            "metadata": '{"owner": "u", "extra": 1}',
            "config": '{"k": "v"}',
            "status": "idle",
            "values": '{"data": true}',
            "interrupts": '{"i": 1}',
            "created_at": now,
            "updated_at": now,
        }

        thread = PostgresThreadStore._row_to_model(row)

        assert thread.thread_id == "t-json"
        assert thread.metadata["extra"] == 1
        assert thread.values == {"data": True}


# ============================================================================
# PostgresRunStore
# ============================================================================


def _make_run_row(
    run_id: str = "r-1",
    thread_id: str = "t-1",
    assistant_id: str = "a-1",
    owner: str = "user-1",
    status: str = "pending",
    **overrides: Any,
) -> dict[str, Any]:
    now = _now()
    row = {
        "id": run_id,
        "thread_id": thread_id,
        "assistant_id": assistant_id,
        "status": status,
        "metadata": json.dumps({"owner": owner}),
        "kwargs": json.dumps({}),
        "multitask_strategy": "reject",
        "created_at": now,
        "updated_at": now,
    }
    row.update(overrides)
    return row


class TestPostgresRunStore:
    """Tests for ``PostgresRunStore``."""

    async def test_create(self):
        factory, _ = _make_factory()
        store = PostgresRunStore(factory)

        run = await store.create({"thread_id": "t-1", "assistant_id": "a-1"}, "user-1")

        assert isinstance(run, Run)
        assert run.thread_id == "t-1"
        assert run.assistant_id == "a-1"
        assert run.status == "pending"
        assert run.metadata["owner"] == "user-1"

    async def test_create_with_custom_status(self):
        factory, _ = _make_factory()
        store = PostgresRunStore(factory)

        run = await store.create(
            {"thread_id": "t-1", "assistant_id": "a-1", "status": "running"},
            "user-1",
        )

        assert run.status == "running"

    async def test_create_requires_thread_id(self):
        factory, _ = _make_factory()
        store = PostgresRunStore(factory)

        with pytest.raises(ValueError, match="thread_id"):
            await store.create({"assistant_id": "a-1"}, "user-1")

    async def test_create_requires_assistant_id(self):
        factory, _ = _make_factory()
        store = PostgresRunStore(factory)

        with pytest.raises(ValueError, match="assistant_id"):
            await store.create({"thread_id": "t-1"}, "user-1")

    async def test_get_found(self):
        row = _make_run_row()
        factory, _ = _make_factory(MockCursor([row]))
        store = PostgresRunStore(factory)

        result = await store.get("r-1", "user-1")

        assert result is not None
        assert result.run_id == "r-1"

    async def test_get_not_found(self):
        factory, _ = _make_factory(MockCursor([]))
        store = PostgresRunStore(factory)

        result = await store.get("nope", "user-1")

        assert result is None

    async def test_list(self):
        rows = [_make_run_row(f"r-{i}") for i in range(3)]
        factory, _ = _make_factory(MockCursor(rows))
        store = PostgresRunStore(factory)

        result = await store.list("user-1")

        assert len(result) == 3

    async def test_list_with_filter(self):
        rows = [
            _make_run_row("r-1", status="pending"),
            _make_run_row("r-2", status="completed"),
        ]
        factory, _ = _make_factory(MockCursor(rows))
        store = PostgresRunStore(factory)

        result = await store.list("user-1", status="completed")

        assert len(result) == 1

    async def test_list_by_thread(self):
        rows = [_make_run_row("r-1"), _make_run_row("r-2")]
        factory, _ = _make_factory(MockCursor(rows))
        store = PostgresRunStore(factory)

        result = await store.list_by_thread("t-1", "user-1")

        assert len(result) == 2

    async def test_list_by_thread_with_status_filter(self):
        rows = [_make_run_row("r-1", status="running")]
        factory, refs = _make_factory(MockCursor(rows))
        store = PostgresRunStore(factory)

        result = await store.list_by_thread("t-1", "user-1", status="running")

        assert len(result) == 1
        sql = refs[0].executed[0][0]
        assert "status = %s" in sql

    async def test_list_by_thread_without_status(self):
        factory, refs = _make_factory(MockCursor([]))
        store = PostgresRunStore(factory)

        await store.list_by_thread("t-1", "user-1")

        sql = refs[0].executed[0][0]
        # Without status, should not have status = %s
        assert "AND status = %s" not in sql

    async def test_get_by_thread_found(self):
        row = _make_run_row("r-1", thread_id="t-1")
        factory, _ = _make_factory(MockCursor([row]))
        store = PostgresRunStore(factory)

        result = await store.get_by_thread("t-1", "r-1", "user-1")

        assert result is not None
        assert result.run_id == "r-1"

    async def test_get_by_thread_wrong_thread(self):
        row = _make_run_row("r-1", thread_id="t-other")
        factory, _ = _make_factory(MockCursor([row]))
        store = PostgresRunStore(factory)

        result = await store.get_by_thread("t-1", "r-1", "user-1")

        assert result is None

    async def test_get_by_thread_not_found(self):
        factory, _ = _make_factory(MockCursor([]))
        store = PostgresRunStore(factory)

        result = await store.get_by_thread("t-1", "r-1", "user-1")

        assert result is None

    async def test_delete_by_thread_success(self):
        row = _make_run_row("r-1", thread_id="t-1")
        factory, _ = _make_factory(
            MockCursor([row]),  # get_by_thread -> get
            MockCursor(rowcount=1),  # delete
        )
        store = PostgresRunStore(factory)

        result = await store.delete_by_thread("t-1", "r-1", "user-1")

        assert result is True

    async def test_delete_by_thread_not_found(self):
        factory, _ = _make_factory(MockCursor([]))
        store = PostgresRunStore(factory)

        result = await store.delete_by_thread("t-1", "r-1", "user-1")

        assert result is False

    async def test_get_active_run_found(self):
        row = _make_run_row("r-1", status="running")
        factory, _ = _make_factory(MockCursor([row]))
        store = PostgresRunStore(factory)

        result = await store.get_active_run("t-1", "user-1")

        assert result is not None
        assert result.status == "running"

    async def test_get_active_run_none(self):
        factory, _ = _make_factory(MockCursor([]))
        store = PostgresRunStore(factory)

        result = await store.get_active_run("t-1", "user-1")

        assert result is None

    async def test_update_status(self):
        existing = {"id": "r-1"}
        updated_row = _make_run_row("r-1", status="completed")
        factory, _ = _make_factory(
            MockCursor([existing]),  # ownership check
            MockCursor(),  # UPDATE
            MockCursor([updated_row]),  # refetch
        )
        store = PostgresRunStore(factory)

        result = await store.update_status("r-1", "completed", "user-1")

        assert result is not None
        assert result.status == "completed"

    async def test_update_not_found(self):
        factory, _ = _make_factory(MockCursor([]))
        store = PostgresRunStore(factory)

        result = await store.update("nope", {"status": "x"}, "user-1")

        assert result is None

    async def test_update_with_kwargs_and_metadata(self):
        existing = {"id": "r-1"}
        updated_row = _make_run_row("r-1")
        factory, _ = _make_factory(
            MockCursor([existing]),
            MockCursor(),
            MockCursor([updated_row]),
        )
        store = PostgresRunStore(factory)

        result = await store.update(
            "r-1",
            {"kwargs": {"k": 1}, "metadata": {"m": 2}},
            "user-1",
        )

        assert result is not None

    async def test_update_refetch_empty(self):
        existing = {"id": "r-1"}
        factory, _ = _make_factory(
            MockCursor([existing]),
            MockCursor(),
            MockCursor([]),
        )
        store = PostgresRunStore(factory)

        result = await store.update("r-1", {"status": "x"}, "user-1")

        assert result is None

    async def test_delete_success(self):
        factory, _ = _make_factory(MockCursor(rowcount=1))
        store = PostgresRunStore(factory)

        assert await store.delete("r-1", "user-1") is True

    async def test_delete_not_found(self):
        factory, _ = _make_factory(MockCursor(rowcount=0))
        store = PostgresRunStore(factory)

        assert await store.delete("nope", "user-1") is False

    async def test_count_by_thread(self):
        factory, _ = _make_factory(MockCursor([{"count": 7}]))
        store = PostgresRunStore(factory)

        result = await store.count_by_thread("t-1", "user-1")

        assert result == 7

    async def test_count_by_thread_empty(self):
        factory, _ = _make_factory(MockCursor([]))
        store = PostgresRunStore(factory)

        result = await store.count_by_thread("t-1", "user-1")

        assert result == 0

    async def test_count(self):
        rows = [_make_run_row(f"r-{i}") for i in range(5)]
        factory, _ = _make_factory(MockCursor(rows))
        store = PostgresRunStore(factory)

        assert await store.count("user-1") == 5

    async def test_clear(self):
        factory, refs = _make_factory()
        store = PostgresRunStore(factory)

        await store.clear()

        assert "DELETE" in refs[0].executed[0][0]

    def test_row_to_model(self):
        row = _make_run_row()
        run = PostgresRunStore._row_to_model(row)

        assert run.run_id == "r-1"
        assert run.thread_id == "t-1"

    def test_row_to_model_with_json_strings(self):
        now = _now()
        row = {
            "id": "r-json",
            "thread_id": "t-1",
            "assistant_id": "a-1",
            "status": "pending",
            "metadata": '{"owner": "u"}',
            "kwargs": '{"k": 1}',
            "multitask_strategy": "reject",
            "created_at": now,
            "updated_at": now,
        }

        run = PostgresRunStore._row_to_model(row)

        assert run.kwargs == {"k": 1}
        assert run.metadata["owner"] == "u"


# ============================================================================
# PostgresStoreStorage
# ============================================================================


class TestPostgresStoreStorage:
    """Tests for ``PostgresStoreStorage``."""

    async def test_put_creates_item(self):
        factory, refs = _make_factory()
        store = PostgresStoreStorage(factory)

        item = await store.put("ns", "key1", {"data": 1}, "user-1")

        assert isinstance(item, PostgresStoreItem)
        assert item.namespace == "ns"
        assert item.key == "key1"
        assert item.value == {"data": 1}
        sql = refs[0].executed[0][0]
        assert "INSERT" in sql
        assert "ON CONFLICT" in sql

    async def test_put_with_metadata(self):
        factory, _ = _make_factory()
        store = PostgresStoreStorage(factory)

        item = await store.put("ns", "key1", {}, "user-1", metadata={"m": 1})

        assert item.metadata == {"m": 1}

    async def test_get_found(self):
        now = _now()
        row = {
            "namespace": "ns",
            "key": "key1",
            "value": json.dumps({"data": 1}),
            "owner_id": "user-1",
            "metadata": json.dumps({"m": 1}),
            "created_at": now,
            "updated_at": now,
        }
        factory, _ = _make_factory(MockCursor([row]))
        store = PostgresStoreStorage(factory)

        item = await store.get("ns", "key1", "user-1")

        assert item is not None
        assert item.value == {"data": 1}
        assert item.metadata == {"m": 1}

    async def test_get_with_non_string_value(self):
        now = _now()
        row = {
            "namespace": "ns",
            "key": "key1",
            "value": {"data": 1},  # dict, not string
            "owner_id": "user-1",
            "metadata": {"m": 1},  # dict, not string
            "created_at": now,
            "updated_at": now,
        }
        factory, _ = _make_factory(MockCursor([row]))
        store = PostgresStoreStorage(factory)

        item = await store.get("ns", "key1", "user-1")

        assert item.value == {"data": 1}

    async def test_get_not_found(self):
        factory, _ = _make_factory(MockCursor([]))
        store = PostgresStoreStorage(factory)

        item = await store.get("ns", "nope", "user-1")

        assert item is None

    async def test_delete_success(self):
        factory, _ = _make_factory(MockCursor(rowcount=1))
        store = PostgresStoreStorage(factory)

        assert await store.delete("ns", "key1", "user-1") is True

    async def test_delete_not_found(self):
        factory, _ = _make_factory(MockCursor(rowcount=0))
        store = PostgresStoreStorage(factory)

        assert await store.delete("ns", "key1", "user-1") is False

    async def test_search_without_prefix(self):
        now = _now()
        rows = [
            {
                "namespace": "ns",
                "key": f"k{i}",
                "value": json.dumps({}),
                "owner_id": "user-1",
                "metadata": json.dumps({}),
                "created_at": now,
                "updated_at": now,
            }
            for i in range(2)
        ]
        factory, refs = _make_factory(MockCursor(rows))
        store = PostgresStoreStorage(factory)

        items = await store.search("ns", "user-1")

        assert len(items) == 2
        sql = refs[0].executed[0][0]
        assert "LIKE" not in sql

    async def test_search_with_prefix(self):
        factory, refs = _make_factory(MockCursor([]))
        store = PostgresStoreStorage(factory)

        await store.search("ns", "user-1", prefix="doc-")

        sql = refs[0].executed[0][0]
        assert "LIKE" in sql

    async def test_search_with_json_string_fields(self):
        now = _now()
        rows = [
            {
                "namespace": "ns",
                "key": "k",
                "value": '{"x": 1}',
                "owner_id": "user-1",
                "metadata": '{"m": 2}',
                "created_at": now,
                "updated_at": now,
            }
        ]
        factory, _ = _make_factory(MockCursor(rows))
        store = PostgresStoreStorage(factory)

        items = await store.search("ns", "user-1")

        assert len(items) == 1
        assert items[0].value == {"x": 1}
        assert items[0].metadata == {"m": 2}

    async def test_list_namespaces(self):
        rows = [{"namespace": "ns1"}, {"namespace": "ns2"}]
        factory, _ = _make_factory(MockCursor(rows))
        store = PostgresStoreStorage(factory)

        namespaces = await store.list_namespaces("user-1")

        assert namespaces == ["ns1", "ns2"]

    async def test_list_namespaces_empty(self):
        factory, _ = _make_factory(MockCursor([]))
        store = PostgresStoreStorage(factory)

        assert await store.list_namespaces("user-1") == []

    async def test_clear(self):
        factory, refs = _make_factory()
        store = PostgresStoreStorage(factory)

        await store.clear()

        assert "DELETE" in refs[0].executed[0][0]


class TestPostgresStoreItem:
    """Tests for ``PostgresStoreItem``."""

    def test_init_defaults(self):
        item = PostgresStoreItem(
            namespace="ns",
            key="k",
            value={"v": 1},
            owner_id="u",
        )

        assert item.namespace == "ns"
        assert item.key == "k"
        assert item.value == {"v": 1}
        assert item.owner_id == "u"
        assert item.metadata == {}
        assert item.created_at is not None
        assert item.updated_at is not None

    def test_init_with_metadata_and_times(self):
        now = _now()
        item = PostgresStoreItem(
            namespace="ns",
            key="k",
            value={},
            owner_id="u",
            metadata={"m": 1},
            created_at=now,
            updated_at=now,
        )

        assert item.metadata == {"m": 1}
        assert item.created_at == now

    def test_to_dict(self):
        now = _now()
        item = PostgresStoreItem(
            namespace="ns",
            key="k",
            value={"v": 1},
            owner_id="u",
            metadata={"m": 1},
            created_at=now,
            updated_at=now,
        )

        d = item.to_dict()

        assert d["namespace"] == "ns"
        assert d["key"] == "k"
        assert d["value"] == {"v": 1}
        assert d["metadata"] == {"m": 1}
        assert "created_at" in d
        assert "updated_at" in d

    def test_to_dict_with_string_timestamps(self):
        item = PostgresStoreItem(
            namespace="ns",
            key="k",
            value={},
            owner_id="u",
            created_at="2026-01-01",
            updated_at="2026-01-01",
        )

        d = item.to_dict()

        assert d["created_at"] == "2026-01-01"


# ============================================================================
# PostgresCronStore
# ============================================================================


def _make_cron_row(
    cron_id: str = "c-1",
    owner: str = "user-1",
    schedule: str = "*/5 * * * *",
    **overrides: Any,
) -> dict[str, Any]:
    now = _now()
    row = {
        "id": cron_id,
        "assistant_id": "a-1",
        "thread_id": "t-1",
        "end_time": None,
        "schedule": schedule,
        "user_id": "user-1",
        "payload": json.dumps({}),
        "next_run_date": None,
        "metadata": json.dumps({"owner": owner}),
        "created_at": now,
        "updated_at": now,
    }
    row.update(overrides)
    return row


class TestPostgresCronStore:
    """Tests for ``PostgresCronStore``."""

    async def test_create(self):
        factory, _ = _make_factory()
        store = PostgresCronStore(factory)

        cron = await store.create({"schedule": "*/5 * * * *"}, "user-1")

        assert cron.schedule == "*/5 * * * *"
        assert cron.metadata["owner"] == "user-1"

    async def test_create_with_all_fields(self):
        factory, _ = _make_factory()
        store = PostgresCronStore(factory)

        cron = await store.create(
            {
                "assistant_id": "a-1",
                "thread_id": "t-1",
                "schedule": "0 * * * *",
                "user_id": "u-1",
                "payload": {"action": "sync"},
                "end_time": None,
                "next_run_date": None,
            },
            "user-1",
        )

        assert cron.assistant_id == "a-1"
        assert cron.payload == {"action": "sync"}

    async def test_get_found(self):
        row = _make_cron_row()
        factory, _ = _make_factory(MockCursor([row]))
        store = PostgresCronStore(factory)

        cron = await store.get("c-1", "user-1")

        assert cron is not None
        assert cron.cron_id == "c-1"

    async def test_get_not_found(self):
        factory, _ = _make_factory(MockCursor([]))
        store = PostgresCronStore(factory)

        assert await store.get("nope", "user-1") is None

    async def test_list_all(self):
        rows = [_make_cron_row(f"c-{i}") for i in range(3)]
        factory, _ = _make_factory(MockCursor(rows))
        store = PostgresCronStore(factory)

        result = await store.list("user-1")

        assert len(result) == 3

    async def test_list_with_assistant_id_filter(self):
        rows = [_make_cron_row()]
        factory, refs = _make_factory(MockCursor(rows))
        store = PostgresCronStore(factory)

        result = await store.list("user-1", assistant_id="a-1")

        assert len(result) == 1
        sql = refs[0].executed[0][0]
        assert "assistant_id" in sql

    async def test_list_with_extra_filter(self):
        rows = [
            _make_cron_row("c-1", schedule="*/5 * * * *"),
            _make_cron_row("c-2", schedule="0 * * * *"),
        ]
        factory, _ = _make_factory(MockCursor(rows))
        store = PostgresCronStore(factory)

        result = await store.list("user-1", schedule="0 * * * *")

        assert len(result) == 1

    async def test_update_not_found(self):
        factory, _ = _make_factory(MockCursor([]))
        store = PostgresCronStore(factory)

        result = await store.update("nope", "user-1", {"schedule": "x"})

        assert result is None

    async def test_update_success(self):
        updated_row = _make_cron_row("c-1", schedule="0 0 * * *")
        factory, _ = _make_factory(
            MockCursor([{"id": "c-1"}]),  # ownership
            MockCursor(),  # UPDATE
            MockCursor([updated_row]),  # refetch
        )
        store = PostgresCronStore(factory)

        result = await store.update("c-1", "user-1", {"schedule": "0 0 * * *"})

        assert result is not None

    async def test_update_all_fields(self):
        updated_row = _make_cron_row("c-1")
        factory, _ = _make_factory(
            MockCursor([{"id": "c-1"}]),
            MockCursor(),
            MockCursor([updated_row]),
        )
        store = PostgresCronStore(factory)

        result = await store.update(
            "c-1",
            "user-1",
            {
                "schedule": "new",
                "next_run_date": _now(),
                "end_time": _now(),
                "payload": {"new": True},
                "metadata": {"m": 1},
            },
        )

        assert result is not None

    async def test_update_refetch_empty(self):
        factory, _ = _make_factory(
            MockCursor([{"id": "c-1"}]),
            MockCursor(),
            MockCursor([]),
        )
        store = PostgresCronStore(factory)

        result = await store.update("c-1", "user-1", {"schedule": "x"})

        assert result is None

    async def test_delete_success(self):
        factory, _ = _make_factory(MockCursor(rowcount=1))
        store = PostgresCronStore(factory)

        assert await store.delete("c-1", "user-1") is True

    async def test_delete_not_found(self):
        factory, _ = _make_factory(MockCursor(rowcount=0))
        store = PostgresCronStore(factory)

        assert await store.delete("nope", "user-1") is False

    async def test_count_without_assistant_id(self):
        factory, refs = _make_factory(MockCursor([{"count": 3}]))
        store = PostgresCronStore(factory)

        result = await store.count("user-1")

        assert result == 3
        sql = refs[0].executed[0][0]
        assert "assistant_id" not in sql

    async def test_count_with_assistant_id(self):
        factory, refs = _make_factory(MockCursor([{"count": 2}]))
        store = PostgresCronStore(factory)

        result = await store.count("user-1", assistant_id="a-1")

        assert result == 2
        sql = refs[0].executed[0][0]
        assert "assistant_id" in sql

    async def test_count_empty(self):
        factory, _ = _make_factory(MockCursor([]))
        store = PostgresCronStore(factory)

        result = await store.count("user-1")

        assert result == 0

    async def test_clear(self):
        factory, refs = _make_factory()
        store = PostgresCronStore(factory)

        await store.clear()

        assert "DELETE" in refs[0].executed[0][0]

    def test_row_to_model(self):
        row = _make_cron_row()
        cron = PostgresCronStore._row_to_model(row)

        assert cron.cron_id == "c-1"
        assert cron.schedule == "*/5 * * * *"

    def test_row_to_model_with_json_strings(self):
        now = _now()
        row = {
            "id": "c-json",
            "assistant_id": None,
            "thread_id": "",
            "end_time": None,
            "schedule": "* * * * *",
            "user_id": None,
            "payload": '{"p": 1}',
            "next_run_date": None,
            "metadata": '{"owner": "u"}',
            "created_at": now,
            "updated_at": now,
        }

        cron = PostgresCronStore._row_to_model(row)

        assert cron.payload == {"p": 1}
        assert cron.metadata["owner"] == "u"


# ============================================================================
# PostgresStorage (container)
# ============================================================================


class TestPostgresStorage:
    """Tests for the top-level ``PostgresStorage`` container."""

    def test_init_creates_all_sub_stores(self):
        factory, _ = _make_factory()
        storage = PostgresStorage(factory)

        assert isinstance(storage.assistants, PostgresAssistantStore)
        assert isinstance(storage.threads, PostgresThreadStore)
        assert isinstance(storage.runs, PostgresRunStore)
        assert isinstance(storage.store, PostgresStoreStorage)
        assert isinstance(storage.crons, PostgresCronStore)

    async def test_run_migrations(self):
        factory, refs = _make_factory()
        storage = PostgresStorage(factory)

        await storage.run_migrations()

        # Should have executed multiple DDL statements
        assert len(refs[0].executed) > 5

    async def test_clear_all(self):
        factory, refs = _make_factory()
        storage = PostgresStorage(factory)

        await storage.clear_all()

        # Should have executed DELETE for runs, threads, assistants, store, crons
        sqls = [sql for sql, _ in refs[0].executed]
        assert (
            sum(1 for s in sqls if "DELETE" in s) == 6
        )  # threads.clear() does 2 DELETEs


# ============================================================================
# PostgresAssistantStore.update — deeper paths
# ============================================================================


class TestPostgresAssistantStoreUpdateDeep:
    """Cover more update branches: config, context, metadata merge, version bump."""

    async def test_update_config(self):
        now = _now()
        existing = {
            "id": "a-1",
            "graph_id": "agent",
            "config": json.dumps({"configurable": {"old": True}}),
            "context": json.dumps({}),
            "metadata": json.dumps({"owner": "user-1"}),
            "name": "Old",
            "description": None,
            "version": 1,
            "created_at": now,
            "updated_at": now,
        }
        updated = {
            **existing,
            "config": json.dumps({"configurable": {"new": True}}),
            "version": 2,
        }
        factory, refs = _make_factory(
            MockCursor([existing]),
            MockCursor(),
            MockCursor([updated]),
        )
        store = PostgresAssistantStore(factory)

        result = await store.update(
            "a-1",
            {"config": {"configurable": {"new": True}}},
            "user-1",
        )

        assert result is not None
        assert result.version == 2

    async def test_update_metadata_merge(self):
        now = _now()
        existing = {
            "id": "a-1",
            "graph_id": "agent",
            "config": json.dumps({}),
            "context": json.dumps({}),
            "metadata": json.dumps({"owner": "user-1", "existing_key": "val"}),
            "name": None,
            "description": None,
            "version": 1,
            "created_at": now,
            "updated_at": now,
        }
        updated = {**existing, "version": 2}
        factory, _ = _make_factory(
            MockCursor([existing]),
            MockCursor(),
            MockCursor([updated]),
        )
        store = PostgresAssistantStore(factory)

        result = await store.update(
            "a-1",
            {"metadata": {"new_key": "new_val"}},
            "user-1",
        )

        assert result is not None

    async def test_update_context(self):
        now = _now()
        existing = {
            "id": "a-1",
            "graph_id": "agent",
            "config": json.dumps({}),
            "context": json.dumps({}),
            "metadata": json.dumps({"owner": "user-1"}),
            "name": None,
            "description": None,
            "version": 1,
            "created_at": now,
            "updated_at": now,
        }
        updated = {**existing, "version": 2, "context": json.dumps({"ctx": 1})}
        factory, _ = _make_factory(
            MockCursor([existing]),
            MockCursor(),
            MockCursor([updated]),
        )
        store = PostgresAssistantStore(factory)

        result = await store.update(
            "a-1",
            {"context": {"ctx": 1}},
            "user-1",
        )

        assert result is not None

    async def test_update_name_and_description(self):
        now = _now()
        existing = {
            "id": "a-1",
            "graph_id": "agent",
            "config": json.dumps({}),
            "context": json.dumps({}),
            "metadata": json.dumps({"owner": "user-1"}),
            "name": "Old",
            "description": "Old desc",
            "version": 1,
            "created_at": now,
            "updated_at": now,
        }
        updated = {**existing, "name": "New", "description": "New desc", "version": 2}
        factory, _ = _make_factory(
            MockCursor([existing]),
            MockCursor(),
            MockCursor([updated]),
        )
        store = PostgresAssistantStore(factory)

        result = await store.update(
            "a-1",
            {"name": "New", "description": "New desc"},
            "user-1",
        )

        assert result is not None
        assert result.name == "New"
        assert result.description == "New desc"

    async def test_update_refetch_empty(self):
        now = _now()
        existing = {
            "id": "a-1",
            "graph_id": "agent",
            "config": json.dumps({}),
            "context": json.dumps({}),
            "metadata": json.dumps({"owner": "user-1"}),
            "name": None,
            "description": None,
            "version": 1,
            "created_at": now,
            "updated_at": now,
        }
        factory, _ = _make_factory(
            MockCursor([existing]),
            MockCursor(),
            MockCursor([]),  # refetch returns nothing
        )
        store = PostgresAssistantStore(factory)

        result = await store.update("a-1", {"name": "X"}, "user-1")

        assert result is None

    async def test_update_with_metadata_string_in_existing(self):
        """Cover the JSON-string metadata parsing branch in update."""
        now = _now()
        existing = {
            "id": "a-1",
            "graph_id": "agent",
            "config": json.dumps({}),
            "context": json.dumps({}),
            "metadata": '{"owner": "user-1", "k": "v"}',
            "name": None,
            "description": None,
            "version": 1,
            "created_at": now,
            "updated_at": now,
        }
        updated = {**existing, "version": 2}
        factory, _ = _make_factory(
            MockCursor([existing]),
            MockCursor(),
            MockCursor([updated]),
        )
        store = PostgresAssistantStore(factory)

        result = await store.update(
            "a-1",
            {"metadata": {"new": "val"}},
            "user-1",
        )

        assert result is not None
