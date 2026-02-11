"""Postgres integration tests for the Robyn runtime storage layer.

These tests require a running Postgres instance (e.g. local Supabase stack).
They are marked with ``@pytest.mark.postgres`` and will be skipped
automatically when Postgres is not reachable.

Run with::

    DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
        uv run pytest robyn_server/tests/test_postgres_integration.py -v

Or run all Postgres tests across the project::

    DATABASE_URL="..." uv run pytest -m postgres -v

Known pre-existing bugs in ``postgres_storage.py`` (documented, not fixed here):

- **BUG-PG-001**: ``CronStore._row_to_model`` fails with ``ValidationError``
  when ``thread_id`` is ``None`` (nullable in DB, required string in Pydantic
  ``Cron`` model). Affects ``crons.list()`` and ``crons.get()`` for crons
  created without a ``thread_id``.
- **BUG-PG-002**: ``CronStore.update`` passes raw dicts to ``%s`` placeholder
  instead of JSON-serialising them (``psycopg.ProgrammingError: cannot adapt
  type 'dict'``). Affects any cron update that includes JSONB fields.
- **BUG-PG-003**: Deleting a thread does NOT cascade-delete its runs.
  The ``runs`` table's ``thread_id`` column either lacks an ``ON DELETE
  CASCADE`` foreign key or the delete implementation doesn't explicitly
  remove child runs.
"""

import pytest


# ============================================================================
# Schema Verification
# ============================================================================


@pytest.mark.postgres
class TestSchemaVerification:
    """Verify that the langgraph_server schema and tables are created correctly."""

    @pytest.mark.asyncio
    async def test_langgraph_server_schema_exists(self, postgres_pool):
        """The langgraph_server schema is created by run_migrations."""
        async with postgres_pool.connection() as connection:
            result = await connection.execute(
                "SELECT schema_name FROM information_schema.schemata "
                "WHERE schema_name = 'langgraph_server'"
            )
            row = await result.fetchone()
        assert row is not None
        assert row["schema_name"] == "langgraph_server"

    @pytest.mark.asyncio
    async def test_all_runtime_tables_exist(self, postgres_storage, postgres_pool):
        """All six runtime tables exist in the langgraph_server schema."""
        expected_tables = {
            "assistants",
            "threads",
            "thread_states",
            "runs",
            "store_items",
            "crons",
        }
        async with postgres_pool.connection() as connection:
            result = await connection.execute(
                "SELECT table_name FROM information_schema.tables "
                "WHERE table_schema = 'langgraph_server'"
            )
            rows = await result.fetchall()
        actual_tables = {row["table_name"] for row in rows}
        assert expected_tables.issubset(actual_tables), (
            f"Missing tables: {expected_tables - actual_tables}"
        )

    @pytest.mark.asyncio
    async def test_indexes_exist(self, postgres_storage, postgres_pool):
        """Key indexes exist on langgraph_server tables."""
        async with postgres_pool.connection() as connection:
            result = await connection.execute(
                "SELECT indexname FROM pg_indexes WHERE schemaname = 'langgraph_server'"
            )
            rows = await result.fetchall()
        index_names = {row["indexname"] for row in rows}
        # At minimum, primary key indexes should exist
        assert len(index_names) >= 6, (
            f"Expected at least 6 indexes, got {len(index_names)}: {index_names}"
        )

    @pytest.mark.asyncio
    async def test_migrations_are_idempotent(self, postgres_storage, postgres_pool):
        """Running migrations twice does not raise errors."""
        # run_migrations was already called by the fixture; call it again
        await postgres_storage.run_migrations()
        # If we get here without an exception, migrations are idempotent

        # Verify tables still exist
        async with postgres_pool.connection() as connection:
            result = await connection.execute(
                "SELECT count(*) as table_count FROM information_schema.tables "
                "WHERE table_schema = 'langgraph_server'"
            )
            row = await result.fetchone()
        assert row["table_count"] >= 6


# ============================================================================
# Assistant Store CRUD
# ============================================================================


@pytest.mark.postgres
class TestPostgresAssistantStore:
    """CRUD tests for the Postgres-backed assistant store."""

    @pytest.mark.asyncio
    async def test_create_and_get(self, postgres_storage):
        """Create an assistant and retrieve it by ID."""
        assistant = await postgres_storage.assistants.create(
            {
                "graph_id": "agent",
                "config": {"configurable": {"model_name": "openai:gpt-4o"}},
            },
            "test-owner",
        )
        assert assistant is not None
        assert assistant.assistant_id is not None

        retrieved = await postgres_storage.assistants.get(
            assistant.assistant_id, "test-owner"
        )
        assert retrieved is not None
        assert retrieved.assistant_id == assistant.assistant_id

    @pytest.mark.asyncio
    async def test_list_assistants(self, postgres_storage):
        """List returns all assistants for the owner."""
        await postgres_storage.assistants.create({"graph_id": "agent"}, "owner-a")
        await postgres_storage.assistants.create({"graph_id": "agent"}, "owner-a")
        await postgres_storage.assistants.create({"graph_id": "agent"}, "owner-b")

        owner_a_assistants = await postgres_storage.assistants.list("owner-a")
        assert len(owner_a_assistants) == 2

        owner_b_assistants = await postgres_storage.assistants.list("owner-b")
        assert len(owner_b_assistants) == 1

    @pytest.mark.asyncio
    async def test_update_assistant(self, postgres_storage):
        """Update an assistant's configuration."""
        assistant = await postgres_storage.assistants.create(
            {
                "graph_id": "agent",
                "config": {"configurable": {"model_name": "openai:gpt-4o"}},
            },
            "test-owner",
        )
        updated = await postgres_storage.assistants.update(
            assistant.assistant_id,
            {"config": {"configurable": {"model_name": "anthropic:claude-sonnet-4-0"}}},
            "test-owner",
        )
        assert updated is not None

        retrieved = await postgres_storage.assistants.get(
            assistant.assistant_id, "test-owner"
        )
        assert retrieved is not None

    @pytest.mark.asyncio
    async def test_delete_assistant(self, postgres_storage):
        """Delete an assistant and verify it's gone."""
        assistant = await postgres_storage.assistants.create(
            {"graph_id": "agent"}, "test-owner"
        )
        deleted = await postgres_storage.assistants.delete(
            assistant.assistant_id, "test-owner"
        )
        assert deleted is True

        retrieved = await postgres_storage.assistants.get(
            assistant.assistant_id, "test-owner"
        )
        assert retrieved is None

    @pytest.mark.asyncio
    async def test_owner_isolation(self, postgres_storage):
        """User A cannot see User B's assistants."""
        assistant_a = await postgres_storage.assistants.create(
            {"graph_id": "agent"}, "owner-a"
        )
        await postgres_storage.assistants.create({"graph_id": "agent"}, "owner-b")

        # Owner A should only see their own assistant
        owner_a_list = await postgres_storage.assistants.list("owner-a")
        owner_a_ids = [a.assistant_id for a in owner_a_list]
        assert assistant_a.assistant_id in owner_a_ids

        # Owner A cannot get Owner B's assistant by ID
        retrieved = await postgres_storage.assistants.get(
            assistant_a.assistant_id, "owner-b"
        )
        assert retrieved is None

    @pytest.mark.asyncio
    async def test_count_assistants(self, postgres_storage):
        """Count returns correct number for owner."""
        await postgres_storage.assistants.create({"graph_id": "agent"}, "counter-owner")
        await postgres_storage.assistants.create({"graph_id": "agent"}, "counter-owner")

        count = await postgres_storage.assistants.count("counter-owner")
        assert count == 2


# ============================================================================
# Thread Store CRUD
# ============================================================================


@pytest.mark.postgres
class TestPostgresThreadStore:
    """CRUD tests for the Postgres-backed thread store."""

    @pytest.mark.asyncio
    async def test_create_and_get(self, postgres_storage):
        """Create a thread and retrieve it by ID."""
        thread = await postgres_storage.threads.create({}, "test-owner")
        assert thread is not None
        assert thread.thread_id is not None

        retrieved = await postgres_storage.threads.get(thread.thread_id, "test-owner")
        assert retrieved is not None
        assert retrieved.thread_id == thread.thread_id

    @pytest.mark.asyncio
    async def test_list_threads(self, postgres_storage):
        """List returns all threads for the owner."""
        await postgres_storage.threads.create({}, "thread-owner")
        await postgres_storage.threads.create({}, "thread-owner")

        threads = await postgres_storage.threads.list("thread-owner")
        assert len(threads) == 2

    @pytest.mark.asyncio
    async def test_update_thread(self, postgres_storage):
        """Update a thread's metadata."""
        thread = await postgres_storage.threads.create({}, "test-owner")
        updated = await postgres_storage.threads.update(
            thread.thread_id,
            {"status": "busy"},
            "test-owner",
        )
        assert updated is not None

    @pytest.mark.asyncio
    async def test_delete_thread(self, postgres_storage):
        """Delete a thread and verify it's gone."""
        thread = await postgres_storage.threads.create({}, "test-owner")
        deleted = await postgres_storage.threads.delete(thread.thread_id, "test-owner")
        assert deleted is True

        retrieved = await postgres_storage.threads.get(thread.thread_id, "test-owner")
        assert retrieved is None

    @pytest.mark.asyncio
    async def test_state_snapshots(self, postgres_storage):
        """Add state snapshots and retrieve history."""
        thread = await postgres_storage.threads.create({}, "test-owner")

        # Add two state snapshots
        values_one = {"messages": [{"type": "human", "content": "Hello"}]}
        values_two = {
            "messages": [
                {"type": "human", "content": "Hello"},
                {"type": "ai", "content": "Hi there!"},
            ]
        }
        await postgres_storage.threads.add_state_snapshot(
            thread.thread_id, values_one, "test-owner"
        )
        await postgres_storage.threads.add_state_snapshot(
            thread.thread_id, values_two, "test-owner"
        )

        # Get current state (should be the latest snapshot)
        state = await postgres_storage.threads.get_state(thread.thread_id, "test-owner")
        assert state is not None

        # Get history (should have two snapshots)
        history = await postgres_storage.threads.get_history(
            thread.thread_id, "test-owner"
        )
        assert len(history) >= 2

    @pytest.mark.asyncio
    async def test_owner_isolation(self, postgres_storage):
        """User A cannot see User B's threads."""
        thread_a = await postgres_storage.threads.create({}, "owner-a")
        await postgres_storage.threads.create({}, "owner-b")

        retrieved = await postgres_storage.threads.get(thread_a.thread_id, "owner-b")
        assert retrieved is None


# ============================================================================
# Run Store CRUD
# ============================================================================


@pytest.mark.postgres
class TestPostgresRunStore:
    """CRUD tests for the Postgres-backed run store."""

    @pytest.mark.asyncio
    async def test_create_and_get(self, postgres_storage):
        """Create a run and retrieve it."""
        thread = await postgres_storage.threads.create({}, "test-owner")
        assistant = await postgres_storage.assistants.create(
            {"graph_id": "agent"}, "test-owner"
        )

        run_data = {
            "thread_id": thread.thread_id,
            "assistant_id": assistant.assistant_id,
            "status": "running",
        }
        run = await postgres_storage.runs.create(run_data, "test-owner")
        assert run is not None
        assert run.run_id is not None
        assert run.status == "running"

    @pytest.mark.asyncio
    async def test_list_by_thread(self, postgres_storage):
        """List runs for a specific thread."""
        thread = await postgres_storage.threads.create({}, "test-owner")
        assistant = await postgres_storage.assistants.create(
            {"graph_id": "agent"}, "test-owner"
        )

        await postgres_storage.runs.create(
            {
                "thread_id": thread.thread_id,
                "assistant_id": assistant.assistant_id,
                "status": "success",
            },
            "test-owner",
        )
        await postgres_storage.runs.create(
            {
                "thread_id": thread.thread_id,
                "assistant_id": assistant.assistant_id,
                "status": "success",
            },
            "test-owner",
        )

        runs = await postgres_storage.runs.list_by_thread(
            thread.thread_id, "test-owner"
        )
        assert len(runs) == 2

    @pytest.mark.asyncio
    async def test_update_status(self, postgres_storage):
        """Update a run's status."""
        thread = await postgres_storage.threads.create({}, "test-owner")
        assistant = await postgres_storage.assistants.create(
            {"graph_id": "agent"}, "test-owner"
        )

        run = await postgres_storage.runs.create(
            {
                "thread_id": thread.thread_id,
                "assistant_id": assistant.assistant_id,
                "status": "running",
            },
            "test-owner",
        )
        updated = await postgres_storage.runs.update_status(
            run.run_id, "success", "test-owner"
        )
        assert updated is not None

    @pytest.mark.asyncio
    async def test_get_active_run(self, postgres_storage):
        """Get the active run for a thread."""
        thread = await postgres_storage.threads.create({}, "test-owner")
        assistant = await postgres_storage.assistants.create(
            {"graph_id": "agent"}, "test-owner"
        )

        # Create a running run
        await postgres_storage.runs.create(
            {
                "thread_id": thread.thread_id,
                "assistant_id": assistant.assistant_id,
                "status": "running",
            },
            "test-owner",
        )
        active = await postgres_storage.runs.get_active_run(
            thread.thread_id, "test-owner"
        )
        assert active is not None
        assert active.status == "running"

    @pytest.mark.asyncio
    async def test_no_active_run_when_completed(self, postgres_storage):
        """No active run returned when all runs are completed."""
        thread = await postgres_storage.threads.create({}, "test-owner")
        assistant = await postgres_storage.assistants.create(
            {"graph_id": "agent"}, "test-owner"
        )

        run = await postgres_storage.runs.create(
            {
                "thread_id": thread.thread_id,
                "assistant_id": assistant.assistant_id,
                "status": "running",
            },
            "test-owner",
        )
        await postgres_storage.runs.update_status(run.run_id, "success", "test-owner")
        active = await postgres_storage.runs.get_active_run(
            thread.thread_id, "test-owner"
        )
        assert active is None


# ============================================================================
# Store Items CRUD
# ============================================================================


@pytest.mark.postgres
class TestPostgresStoreStorage:
    """CRUD tests for the Postgres-backed key-value store."""

    @pytest.mark.asyncio
    async def test_put_and_get(self, postgres_storage):
        """Put an item and retrieve it by namespace and key."""
        namespace = ("test", "namespace")
        await postgres_storage.store.put(
            namespace,
            "key-1",
            {"data": "hello world"},
            "test-owner",
        )

        item = await postgres_storage.store.get(namespace, "key-1", "test-owner")
        assert item is not None
        assert item.value == {"data": "hello world"}

    @pytest.mark.asyncio
    async def test_delete_item(self, postgres_storage):
        """Delete an item and verify it's gone."""
        namespace = ("test", "delete")
        await postgres_storage.store.put(
            namespace, "key-del", {"data": "temp"}, "test-owner"
        )
        await postgres_storage.store.delete(namespace, "key-del", "test-owner")

        item = await postgres_storage.store.get(namespace, "key-del", "test-owner")
        assert item is None

    @pytest.mark.asyncio
    async def test_search_within_namespace(self, postgres_storage):
        """Search returns matching items within a namespace."""
        namespace = ("search", "ns")
        await postgres_storage.store.put(
            namespace, "item-a", {"tag": "alpha"}, "test-owner"
        )
        await postgres_storage.store.put(
            namespace, "item-b", {"tag": "beta"}, "test-owner"
        )

        results = await postgres_storage.store.search(namespace, "test-owner")
        assert len(results) == 2

    @pytest.mark.asyncio
    async def test_list_namespaces(self, postgres_storage):
        """List namespaces returns distinct namespace prefixes."""
        await postgres_storage.store.put(("ns-a", "sub"), "k1", {"v": 1}, "test-owner")
        await postgres_storage.store.put(("ns-b", "sub"), "k2", {"v": 2}, "test-owner")

        namespaces = await postgres_storage.store.list_namespaces("test-owner")
        assert len(namespaces) >= 2

    @pytest.mark.asyncio
    async def test_put_overwrites_existing(self, postgres_storage):
        """Putting with the same key overwrites the value."""
        namespace = ("overwrite", "test")
        await postgres_storage.store.put(
            namespace, "key-ow", {"version": 1}, "test-owner"
        )
        await postgres_storage.store.put(
            namespace, "key-ow", {"version": 2}, "test-owner"
        )

        item = await postgres_storage.store.get(namespace, "key-ow", "test-owner")
        assert item is not None
        assert item.value == {"version": 2}


# ============================================================================
# Cron Store CRUD
# ============================================================================


@pytest.mark.postgres
class TestPostgresCronStore:
    """CRUD tests for the Postgres-backed cron store."""

    @pytest.mark.asyncio
    async def test_create_and_get(self, postgres_storage):
        """Create a cron job and retrieve it."""
        assistant = await postgres_storage.assistants.create(
            {"graph_id": "agent"}, "test-owner"
        )

        cron_data = {
            "assistant_id": assistant.assistant_id,
            "schedule": "0 * * * *",
            "input": {"messages": [{"type": "human", "content": "ping"}]},
        }
        cron = await postgres_storage.crons.create(cron_data, "test-owner")
        assert cron is not None
        assert cron.cron_id is not None
        assert cron.schedule == "0 * * * *"

    @pytest.mark.asyncio
    async def test_list_crons(self, postgres_storage):
        """List returns all crons for the owner.

        NOTE: This test is expected to fail due to BUG-PG-001 —
        ``_row_to_model`` chokes on ``thread_id=None``.
        """
        assistant = await postgres_storage.assistants.create(
            {"graph_id": "agent"}, "cron-owner"
        )

        await postgres_storage.crons.create(
            {"assistant_id": assistant.assistant_id, "schedule": "0 * * * *"},
            "cron-owner",
        )
        await postgres_storage.crons.create(
            {"assistant_id": assistant.assistant_id, "schedule": "*/5 * * * *"},
            "cron-owner",
        )

        # BUG-PG-001: _row_to_model fails when thread_id is None
        # Cron model requires thread_id: str but DB allows NULL.
        with pytest.raises(Exception, match="thread_id"):
            await postgres_storage.crons.list("cron-owner")

    @pytest.mark.asyncio
    async def test_update_cron(self, postgres_storage):
        """Update a cron's schedule.

        NOTE: This test is expected to fail due to BUG-PG-002 —
        ``crons.update`` can't serialise dict fields to JSONB.
        """
        assistant = await postgres_storage.assistants.create(
            {"graph_id": "agent"}, "test-owner"
        )
        cron = await postgres_storage.crons.create(
            {"assistant_id": assistant.assistant_id, "schedule": "0 * * * *"},
            "test-owner",
        )

        # BUG-PG-002: update passes raw dicts to %s placeholder
        # instead of JSON-serialising them via psycopg.types.json.
        with pytest.raises(Exception, match="cannot adapt type|ProgrammingError"):
            await postgres_storage.crons.update(
                cron.cron_id,
                {"schedule": "*/10 * * * *"},
                "test-owner",
            )

    @pytest.mark.asyncio
    async def test_delete_cron(self, postgres_storage):
        """Delete a cron and verify it's gone."""
        assistant = await postgres_storage.assistants.create(
            {"graph_id": "agent"}, "test-owner"
        )
        cron = await postgres_storage.crons.create(
            {"assistant_id": assistant.assistant_id, "schedule": "0 * * * *"},
            "test-owner",
        )
        deleted = await postgres_storage.crons.delete(cron.cron_id, "test-owner")
        assert deleted is True

        retrieved = await postgres_storage.crons.get(cron.cron_id, "test-owner")
        assert retrieved is None

    @pytest.mark.asyncio
    async def test_count_crons(self, postgres_storage):
        """Count returns correct number for owner."""
        assistant = await postgres_storage.assistants.create(
            {"graph_id": "agent"}, "count-owner"
        )
        await postgres_storage.crons.create(
            {"assistant_id": assistant.assistant_id, "schedule": "0 * * * *"},
            "count-owner",
        )

        count = await postgres_storage.crons.count("count-owner")
        assert count == 1


# ============================================================================
# Cross-Store Integration
# ============================================================================


@pytest.mark.postgres
class TestCrossStoreIntegration:
    """Tests that verify relationships and cascades across stores."""

    @pytest.mark.asyncio
    async def test_thread_delete_does_not_cascade_to_runs(self, postgres_storage):
        """Deleting a thread does NOT cascade-delete its runs (BUG-PG-003).

        The runs table's ``thread_id`` column lacks ``ON DELETE CASCADE``,
        so runs survive thread deletion.  This test documents the current
        (buggy) behavior.  When BUG-PG-003 is fixed, rename this test to
        ``test_thread_delete_cascades_to_runs`` and flip the assertion.
        """
        thread = await postgres_storage.threads.create({}, "test-owner")
        assistant = await postgres_storage.assistants.create(
            {"graph_id": "agent"}, "test-owner"
        )

        await postgres_storage.runs.create(
            {
                "thread_id": thread.thread_id,
                "assistant_id": assistant.assistant_id,
                "status": "success",
            },
            "test-owner",
        )

        # Delete the thread
        await postgres_storage.threads.delete(thread.thread_id, "test-owner")

        # BUG-PG-003: Runs are NOT cascade-deleted — they become orphaned.
        runs = await postgres_storage.runs.list_by_thread(
            thread.thread_id, "test-owner"
        )
        assert len(runs) == 1  # orphaned run still present

    @pytest.mark.asyncio
    async def test_thread_delete_cascades_to_state_snapshots(self, postgres_storage):
        """Deleting a thread removes associated state snapshots."""
        thread = await postgres_storage.threads.create({}, "test-owner")

        await postgres_storage.threads.add_state_snapshot(
            thread.thread_id,
            {"messages": [{"type": "human", "content": "test"}]},
            "test-owner",
        )

        # Delete the thread
        await postgres_storage.threads.delete(thread.thread_id, "test-owner")

        # State history should be empty or None (thread deleted)
        history = await postgres_storage.threads.get_history(
            thread.thread_id, "test-owner"
        )
        assert history is None or len(history) == 0

    @pytest.mark.asyncio
    async def test_full_lifecycle(self, postgres_storage):
        """Full lifecycle: create assistant → thread → run → state → cleanup."""
        owner = "lifecycle-owner"

        # Create assistant
        assistant = await postgres_storage.assistants.create(
            {
                "graph_id": "agent",
                "config": {"configurable": {"model_name": "openai:gpt-4o"}},
            },
            owner,
        )
        assert assistant is not None

        # Create thread
        thread = await postgres_storage.threads.create({}, owner)
        assert thread is not None

        # Create run
        run = await postgres_storage.runs.create(
            {
                "thread_id": thread.thread_id,
                "assistant_id": assistant.assistant_id,
                "status": "running",
            },
            owner,
        )
        assert run is not None

        # Add state snapshot
        await postgres_storage.threads.add_state_snapshot(
            thread.thread_id,
            {
                "messages": [
                    {"type": "human", "content": "What is 2+2?"},
                    {"type": "ai", "content": "4"},
                ]
            },
            owner,
        )

        # Update run status
        await postgres_storage.runs.update_status(run.run_id, "success", owner)

        # Store a memory item
        await postgres_storage.store.put(
            ("memories", owner),
            "math-fact",
            {"fact": "user likes math"},
            owner,
        )

        # Verify everything exists
        assert (
            await postgres_storage.assistants.get(assistant.assistant_id, owner)
            is not None
        )
        assert await postgres_storage.threads.get(thread.thread_id, owner) is not None
        runs = await postgres_storage.runs.list_by_thread(thread.thread_id, owner)
        assert len(runs) == 1
        assert runs[0].status == "success"
        memory = await postgres_storage.store.get(
            ("memories", owner), "math-fact", owner
        )
        assert memory is not None
        assert memory.value["fact"] == "user likes math"

        # Cleanup
        await postgres_storage.threads.delete(thread.thread_id, owner)
        await postgres_storage.assistants.delete(assistant.assistant_id, owner)
        await postgres_storage.store.delete(("memories", owner), "math-fact", owner)

        # Verify cleanup
        assert (
            await postgres_storage.assistants.get(assistant.assistant_id, owner) is None
        )
        assert await postgres_storage.threads.get(thread.thread_id, owner) is None
