"""Unit tests for the in-memory storage layer.

Tests cover:
- CRUD operations for all resource types
- Owner isolation and filtering
- Edge cases and error handling

All test methods are async to match the async storage interface.
"""

import pytest

from robyn_server.models import Assistant, Run, Thread
from robyn_server.storage import (
    AssistantStore,
    RunStore,
    Storage,
    ThreadStore,
    generate_id,
    get_storage,
    reset_storage,
)


# ============================================================================
# Fixtures
# ============================================================================


@pytest.fixture
def assistant_store() -> AssistantStore:
    """Create a fresh AssistantStore for testing."""
    return AssistantStore()


@pytest.fixture
def thread_store() -> ThreadStore:
    """Create a fresh ThreadStore for testing."""
    return ThreadStore()


@pytest.fixture
def run_store() -> RunStore:
    """Create a fresh RunStore for testing."""
    return RunStore()


@pytest.fixture
def storage() -> Storage:
    """Create a fresh Storage container for testing."""
    return Storage()


@pytest.fixture(autouse=True)
def reset_global_storage():
    """Reset global storage before and after each test."""
    reset_storage()
    yield
    reset_storage()


# ============================================================================
# Helper Function Tests
# ============================================================================


class TestHelperFunctions:
    """Tests for utility helper functions."""

    def test_generate_id_returns_hex_string(self):
        """generate_id returns a valid hex string."""
        result = generate_id()
        assert isinstance(result, str)
        assert len(result) == 32  # UUID hex is 32 chars
        int(result, 16)  # Should not raise

    def test_generate_id_returns_unique_values(self):
        """generate_id returns unique values each call."""
        ids = {generate_id() for _ in range(100)}
        assert len(ids) == 100


# ============================================================================
# AssistantStore Tests
# ============================================================================


class TestAssistantStore:
    """Tests for AssistantStore."""

    async def test_create_assistant(self, assistant_store: AssistantStore):
        """Create assistant with owner stamping."""
        data = {"graph_id": "test-graph", "name": "Test Assistant"}
        owner_id = "user-123"

        assistant = await assistant_store.create(data, owner_id)

        assert isinstance(assistant, Assistant)
        assert assistant.graph_id == "test-graph"
        assert assistant.name == "Test Assistant"
        assert assistant.metadata["owner"] == owner_id
        assert assistant.assistant_id is not None
        assert assistant.created_at is not None
        assert assistant.updated_at is not None

    async def test_create_assistant_requires_graph_id(
        self, assistant_store: AssistantStore
    ):
        """Create assistant without graph_id raises ValueError."""
        data = {"name": "Test Assistant"}
        owner_id = "user-123"

        with pytest.raises(ValueError, match="graph_id is required"):
            await assistant_store.create(data, owner_id)

    async def test_create_assistant_with_existing_metadata(
        self, assistant_store: AssistantStore
    ):
        """Create assistant preserves existing metadata and adds owner."""
        data = {
            "graph_id": "test-graph",
            "metadata": {"custom_key": "custom_value"},
        }
        owner_id = "user-123"

        assistant = await assistant_store.create(data, owner_id)

        assert assistant.metadata["owner"] == owner_id
        assert assistant.metadata["custom_key"] == "custom_value"

    async def test_get_assistant_by_owner(self, assistant_store: AssistantStore):
        """Get assistant by owner succeeds."""
        data = {"graph_id": "test-graph"}
        owner_id = "user-123"
        created = await assistant_store.create(data, owner_id)

        retrieved = await assistant_store.get(created.assistant_id, owner_id)

        assert retrieved is not None
        assert retrieved.assistant_id == created.assistant_id

    async def test_get_assistant_by_different_owner_returns_none(
        self, assistant_store: AssistantStore
    ):
        """Get assistant by different owner returns None."""
        data = {"graph_id": "test-graph"}
        owner_id = "user-123"
        other_owner = "user-456"
        created = await assistant_store.create(data, owner_id)

        retrieved = await assistant_store.get(created.assistant_id, other_owner)

        assert retrieved is None

    async def test_get_nonexistent_assistant_returns_none(
        self, assistant_store: AssistantStore
    ):
        """Get nonexistent assistant returns None."""
        result = await assistant_store.get("nonexistent-id", "user-123")
        assert result is None

    async def test_list_assistants_by_owner(self, assistant_store: AssistantStore):
        """List assistants filters by owner."""
        owner_a = "user-a"
        owner_b = "user-b"

        await assistant_store.create({"graph_id": "graph-1"}, owner_a)
        await assistant_store.create({"graph_id": "graph-2"}, owner_a)
        await assistant_store.create({"graph_id": "graph-3"}, owner_b)

        list_a = await assistant_store.list(owner_a)
        list_b = await assistant_store.list(owner_b)

        assert len(list_a) == 2
        assert len(list_b) == 1
        assert all(a.metadata["owner"] == owner_a for a in list_a)
        assert all(a.metadata["owner"] == owner_b for a in list_b)

    async def test_list_assistants_empty_for_new_owner(
        self, assistant_store: AssistantStore
    ):
        """List assistants returns empty for owner with no assistants."""
        await assistant_store.create({"graph_id": "graph-1"}, "user-a")

        result = await assistant_store.list("user-new")

        assert result == []

    async def test_update_assistant(self, assistant_store: AssistantStore):
        """Update assistant preserves owner."""
        owner_id = "user-123"
        created = await assistant_store.create({"graph_id": "graph-1"}, owner_id)

        updated = await assistant_store.update(
            created.assistant_id,
            {"name": "Updated Name"},
            owner_id,
        )

        assert updated is not None
        assert updated.name == "Updated Name"
        assert updated.metadata["owner"] == owner_id
        assert updated.updated_at > created.updated_at

    async def test_update_assistant_by_different_owner_returns_none(
        self, assistant_store: AssistantStore
    ):
        """Update assistant by different owner returns None."""
        owner_id = "user-123"
        other_owner = "user-456"
        created = await assistant_store.create({"graph_id": "graph-1"}, owner_id)

        result = await assistant_store.update(
            created.assistant_id,
            {"name": "Hacked Name"},
            other_owner,
        )

        assert result is None
        # Verify original unchanged
        original = await assistant_store.get(created.assistant_id, owner_id)
        assert original is not None
        assert original.name != "Hacked Name"

    async def test_update_cannot_change_owner(self, assistant_store: AssistantStore):
        """Update cannot change the owner via metadata."""
        owner_id = "user-123"
        created = await assistant_store.create({"graph_id": "graph-1"}, owner_id)

        updated = await assistant_store.update(
            created.assistant_id,
            {"metadata": {"owner": "attacker"}},
            owner_id,
        )

        assert updated is not None
        assert updated.metadata["owner"] == owner_id  # Owner preserved

    async def test_update_merges_metadata(self, assistant_store: AssistantStore):
        """Update merges metadata instead of replacing."""
        owner_id = "user-123"
        created = await assistant_store.create(
            {"graph_id": "graph-1", "metadata": {"key1": "value1"}},
            owner_id,
        )

        updated = await assistant_store.update(
            created.assistant_id,
            {"metadata": {"key2": "value2"}},
            owner_id,
        )

        assert updated is not None
        assert updated.metadata["key1"] == "value1"
        assert updated.metadata["key2"] == "value2"
        assert updated.metadata["owner"] == owner_id

    async def test_delete_assistant(self, assistant_store: AssistantStore):
        """Delete assistant by owner succeeds."""
        owner_id = "user-123"
        created = await assistant_store.create({"graph_id": "graph-1"}, owner_id)

        result = await assistant_store.delete(created.assistant_id, owner_id)

        assert result is True
        assert await assistant_store.get(created.assistant_id, owner_id) is None

    async def test_delete_assistant_by_different_owner_fails(
        self, assistant_store: AssistantStore
    ):
        """Delete assistant by different owner fails."""
        owner_id = "user-123"
        other_owner = "user-456"
        created = await assistant_store.create({"graph_id": "graph-1"}, owner_id)

        result = await assistant_store.delete(created.assistant_id, other_owner)

        assert result is False
        # Verify still exists
        assert await assistant_store.get(created.assistant_id, owner_id) is not None

    async def test_delete_nonexistent_assistant_returns_false(
        self, assistant_store: AssistantStore
    ):
        """Delete nonexistent assistant returns False."""
        result = await assistant_store.delete("nonexistent-id", "user-123")
        assert result is False

    async def test_count_assistants(self, assistant_store: AssistantStore):
        """Count assistants by owner."""
        owner_a = "user-a"
        owner_b = "user-b"

        await assistant_store.create({"graph_id": "graph-1"}, owner_a)
        await assistant_store.create({"graph_id": "graph-2"}, owner_a)
        await assistant_store.create({"graph_id": "graph-3"}, owner_b)

        assert await assistant_store.count(owner_a) == 2
        assert await assistant_store.count(owner_b) == 1
        assert await assistant_store.count("owner-c") == 0


# ============================================================================
# ThreadStore Tests
# ============================================================================


class TestThreadStore:
    """Tests for ThreadStore."""

    async def test_create_thread(self, thread_store: ThreadStore):
        """Create thread with owner stamping."""
        data = {"metadata": {"purpose": "testing"}}
        owner_id = "user-123"

        thread = await thread_store.create(data, owner_id)

        assert isinstance(thread, Thread)
        assert thread.metadata["owner"] == owner_id
        assert thread.metadata["purpose"] == "testing"
        assert thread.thread_id is not None
        assert thread.created_at is not None

    async def test_create_thread_minimal(self, thread_store: ThreadStore):
        """Create thread with minimal data."""
        owner_id = "user-123"

        thread = await thread_store.create({}, owner_id)

        assert thread.metadata["owner"] == owner_id
        assert thread.thread_id is not None

    async def test_get_thread_by_owner(self, thread_store: ThreadStore):
        """Get thread by owner succeeds."""
        owner_id = "user-123"
        created = await thread_store.create({}, owner_id)

        retrieved = await thread_store.get(created.thread_id, owner_id)

        assert retrieved is not None
        assert retrieved.thread_id == created.thread_id

    async def test_get_thread_by_different_owner_returns_none(
        self, thread_store: ThreadStore
    ):
        """Get thread by different owner returns None."""
        owner_id = "user-123"
        other_owner = "user-456"
        created = await thread_store.create({}, owner_id)

        retrieved = await thread_store.get(created.thread_id, other_owner)

        assert retrieved is None

    async def test_list_threads_by_owner(self, thread_store: ThreadStore):
        """List threads filters by owner."""
        owner_a = "user-a"
        owner_b = "user-b"

        await thread_store.create({}, owner_a)
        await thread_store.create({}, owner_a)
        await thread_store.create({}, owner_b)

        list_a = await thread_store.list(owner_a)
        list_b = await thread_store.list(owner_b)

        assert len(list_a) == 2
        assert len(list_b) == 1

    async def test_update_thread(self, thread_store: ThreadStore):
        """Update thread metadata."""
        owner_id = "user-123"
        created = await thread_store.create({}, owner_id)

        updated = await thread_store.update(
            created.thread_id,
            {"metadata": {"status": "active"}},
            owner_id,
        )

        assert updated is not None
        assert updated.metadata["status"] == "active"
        assert updated.metadata["owner"] == owner_id

    async def test_delete_thread(self, thread_store: ThreadStore):
        """Delete thread by owner succeeds."""
        owner_id = "user-123"
        created = await thread_store.create({}, owner_id)

        result = await thread_store.delete(created.thread_id, owner_id)

        assert result is True
        assert await thread_store.get(created.thread_id, owner_id) is None


# ============================================================================
# RunStore Tests
# ============================================================================


class TestRunStore:
    """Tests for RunStore."""

    async def test_create_run(self, run_store: RunStore):
        """Create run with owner stamping."""
        data = {
            "thread_id": "thread-123",
            "assistant_id": "assistant-456",
        }
        owner_id = "user-123"

        run = await run_store.create(data, owner_id)

        assert isinstance(run, Run)
        assert run.thread_id == "thread-123"
        assert run.assistant_id == "assistant-456"
        assert run.status == "pending"  # Default status
        assert run.metadata["owner"] == owner_id
        assert run.run_id is not None

    async def test_create_run_requires_thread_id(self, run_store: RunStore):
        """Create run without thread_id raises ValueError."""
        data = {"assistant_id": "assistant-456"}
        owner_id = "user-123"

        with pytest.raises(ValueError, match="thread_id is required"):
            await run_store.create(data, owner_id)

    async def test_create_run_requires_assistant_id(self, run_store: RunStore):
        """Create run without assistant_id raises ValueError."""
        data = {"thread_id": "thread-123"}
        owner_id = "user-123"

        with pytest.raises(ValueError, match="assistant_id is required"):
            await run_store.create(data, owner_id)

    async def test_create_run_with_custom_status(self, run_store: RunStore):
        """Create run with custom status."""
        data = {
            "thread_id": "thread-123",
            "assistant_id": "assistant-456",
            "status": "running",
        }
        owner_id = "user-123"

        run = await run_store.create(data, owner_id)

        assert run.status == "running"

    async def test_get_run_by_owner(self, run_store: RunStore):
        """Get run by owner succeeds."""
        owner_id = "user-123"
        created = await run_store.create(
            {"thread_id": "t1", "assistant_id": "a1"},
            owner_id,
        )

        retrieved = await run_store.get(created.run_id, owner_id)

        assert retrieved is not None
        assert retrieved.run_id == created.run_id

    async def test_get_run_by_different_owner_returns_none(self, run_store: RunStore):
        """Get run by different owner returns None."""
        owner_id = "user-123"
        other_owner = "user-456"
        created = await run_store.create(
            {"thread_id": "t1", "assistant_id": "a1"},
            owner_id,
        )

        retrieved = await run_store.get(created.run_id, other_owner)

        assert retrieved is None

    async def test_list_runs_by_owner(self, run_store: RunStore):
        """List runs filters by owner."""
        owner_a = "user-a"
        owner_b = "user-b"

        await run_store.create({"thread_id": "t1", "assistant_id": "a1"}, owner_a)
        await run_store.create({"thread_id": "t2", "assistant_id": "a1"}, owner_a)
        await run_store.create({"thread_id": "t3", "assistant_id": "a1"}, owner_b)

        list_a = await run_store.list(owner_a)
        list_b = await run_store.list(owner_b)

        assert len(list_a) == 2
        assert len(list_b) == 1

    async def test_list_by_thread(self, run_store: RunStore):
        """List runs by thread_id."""
        owner_id = "user-123"
        thread_1 = "thread-1"
        thread_2 = "thread-2"

        await run_store.create({"thread_id": thread_1, "assistant_id": "a1"}, owner_id)
        await run_store.create({"thread_id": thread_1, "assistant_id": "a1"}, owner_id)
        await run_store.create({"thread_id": thread_2, "assistant_id": "a1"}, owner_id)

        runs_t1 = await run_store.list_by_thread(thread_1, owner_id)
        runs_t2 = await run_store.list_by_thread(thread_2, owner_id)

        assert len(runs_t1) == 2
        assert len(runs_t2) == 1

    async def test_list_by_thread_respects_owner(self, run_store: RunStore):
        """List by thread respects owner isolation."""
        owner_a = "user-a"
        owner_b = "user-b"
        thread_id = "shared-thread"

        await run_store.create({"thread_id": thread_id, "assistant_id": "a1"}, owner_a)
        await run_store.create({"thread_id": thread_id, "assistant_id": "a1"}, owner_b)

        runs_a = await run_store.list_by_thread(thread_id, owner_a)
        runs_b = await run_store.list_by_thread(thread_id, owner_b)

        assert len(runs_a) == 1
        assert len(runs_b) == 1
        assert runs_a[0].metadata["owner"] == owner_a
        assert runs_b[0].metadata["owner"] == owner_b

    async def test_update_status(self, run_store: RunStore):
        """Update run status."""
        owner_id = "user-123"
        created = await run_store.create(
            {"thread_id": "t1", "assistant_id": "a1"},
            owner_id,
        )
        assert created.status == "pending"

        updated = await run_store.update_status(created.run_id, "running", owner_id)

        assert updated is not None
        assert updated.status == "running"

    async def test_update_status_by_different_owner_fails(self, run_store: RunStore):
        """Update status by different owner returns None."""
        owner_id = "user-123"
        other_owner = "user-456"
        created = await run_store.create(
            {"thread_id": "t1", "assistant_id": "a1"},
            owner_id,
        )

        result = await run_store.update_status(created.run_id, "cancelled", other_owner)

        assert result is None
        # Verify original unchanged
        original = await run_store.get(created.run_id, owner_id)
        assert original is not None
        assert original.status == "pending"

    async def test_delete_run(self, run_store: RunStore):
        """Delete run by owner succeeds."""
        owner_id = "user-123"
        created = await run_store.create(
            {"thread_id": "t1", "assistant_id": "a1"},
            owner_id,
        )

        result = await run_store.delete(created.run_id, owner_id)

        assert result is True
        assert await run_store.get(created.run_id, owner_id) is None


# ============================================================================
# Storage Container Tests
# ============================================================================


class TestStorage:
    """Tests for Storage container."""

    def test_storage_has_all_stores(self, storage: Storage):
        """Storage has assistants, threads, and runs stores."""
        assert isinstance(storage.assistants, AssistantStore)
        assert isinstance(storage.threads, ThreadStore)
        assert isinstance(storage.runs, RunStore)

    async def test_clear_all(self, storage: Storage):
        """clear_all removes all data from all stores."""
        owner_id = "user-123"

        await storage.assistants.create({"graph_id": "g1"}, owner_id)
        await storage.threads.create({}, owner_id)
        await storage.runs.create({"thread_id": "t1", "assistant_id": "a1"}, owner_id)

        await storage.clear_all()

        assert await storage.assistants.count(owner_id) == 0
        assert await storage.threads.count(owner_id) == 0
        assert await storage.runs.count(owner_id) == 0


# ============================================================================
# Global Storage Tests
# ============================================================================


class TestGlobalStorage:
    """Tests for module-level storage access."""

    def test_get_storage_returns_same_instance(self):
        """get_storage returns the same instance."""
        storage_1 = get_storage()
        storage_2 = get_storage()

        assert storage_1 is storage_2

    def test_reset_storage_creates_new_instance(self):
        """reset_storage creates a new instance."""
        storage_1 = get_storage()
        reset_storage()
        storage_2 = get_storage()

        assert storage_1 is not storage_2

    async def test_global_storage_is_functional(self):
        """Global storage works end-to-end."""
        storage = get_storage()
        owner_id = "user-123"

        assistant = await storage.assistants.create({"graph_id": "g1"}, owner_id)
        thread = await storage.threads.create({}, owner_id)
        run = await storage.runs.create(
            {"thread_id": thread.thread_id, "assistant_id": assistant.assistant_id},
            owner_id,
        )

        assert (
            await storage.assistants.get(assistant.assistant_id, owner_id) is not None
        )
        assert await storage.threads.get(thread.thread_id, owner_id) is not None
        assert await storage.runs.get(run.run_id, owner_id) is not None


# ============================================================================
# Cross-Owner Isolation Tests
# ============================================================================


class TestCrossOwnerIsolation:
    """Tests ensuring complete owner isolation."""

    async def test_user_a_cannot_see_user_b_assistants(self, storage: Storage):
        """User A cannot see User B's assistants."""
        user_a = "user-a"
        user_b = "user-b"

        assistant_b = await storage.assistants.create({"graph_id": "secret"}, user_b)

        # User A tries to access User B's assistant
        assert await storage.assistants.get(assistant_b.assistant_id, user_a) is None
        assert assistant_b.assistant_id not in [
            a.assistant_id for a in await storage.assistants.list(user_a)
        ]

    async def test_user_a_cannot_see_user_b_threads(self, storage: Storage):
        """User A cannot see User B's threads."""
        user_a = "user-a"
        user_b = "user-b"

        thread_b = await storage.threads.create({}, user_b)

        # User A tries to access User B's thread
        assert await storage.threads.get(thread_b.thread_id, user_a) is None
        assert thread_b.thread_id not in [
            t.thread_id for t in await storage.threads.list(user_a)
        ]

    async def test_user_a_cannot_see_user_b_runs(self, storage: Storage):
        """User A cannot see User B's runs."""
        user_a = "user-a"
        user_b = "user-b"

        run_b = await storage.runs.create(
            {"thread_id": "t1", "assistant_id": "a1"},
            user_b,
        )

        # User A tries to access User B's run
        assert await storage.runs.get(run_b.run_id, user_a) is None
        assert run_b.run_id not in [r.run_id for r in await storage.runs.list(user_a)]

    async def test_user_a_cannot_update_user_b_resources(self, storage: Storage):
        """User A cannot update User B's resources."""
        user_a = "user-a"
        user_b = "user-b"

        assistant_b = await storage.assistants.create({"graph_id": "g1"}, user_b)
        thread_b = await storage.threads.create({}, user_b)
        run_b = await storage.runs.create(
            {"thread_id": "t1", "assistant_id": "a1"},
            user_b,
        )

        # User A tries to update User B's resources
        assert (
            await storage.assistants.update(
                assistant_b.assistant_id, {"name": "hacked"}, user_a
            )
            is None
        )
        assert (
            await storage.threads.update(
                thread_b.thread_id, {"metadata": {"hacked": True}}, user_a
            )
            is None
        )
        assert (
            await storage.runs.update_status(run_b.run_id, "cancelled", user_a) is None
        )

    async def test_user_a_cannot_delete_user_b_resources(self, storage: Storage):
        """User A cannot delete User B's resources."""
        user_a = "user-a"
        user_b = "user-b"

        assistant_b = await storage.assistants.create({"graph_id": "g1"}, user_b)
        thread_b = await storage.threads.create({}, user_b)
        run_b = await storage.runs.create(
            {"thread_id": "t1", "assistant_id": "a1"},
            user_b,
        )

        # User A tries to delete User B's resources
        assert (
            await storage.assistants.delete(assistant_b.assistant_id, user_a) is False
        )
        assert await storage.threads.delete(thread_b.thread_id, user_a) is False
        assert await storage.runs.delete(run_b.run_id, user_a) is False

        # Verify resources still exist for User B
        assert (
            await storage.assistants.get(assistant_b.assistant_id, user_b) is not None
        )
        assert await storage.threads.get(thread_b.thread_id, user_b) is not None
        assert await storage.runs.get(run_b.run_id, user_b) is not None


# ============================================================================
# Deterministic Assistant ID Tests
# ============================================================================


class TestDeterministicAssistantIds:
    """Tests for caller-provided assistant_id support (Bug 1 fix)."""

    async def test_create_with_provided_assistant_id(
        self, assistant_store: AssistantStore
    ):
        """Create uses the caller-provided assistant_id instead of generating one."""
        provided_id = "a0000000-0000-4000-a000-000000000001"
        data = {"graph_id": "agent", "assistant_id": provided_id}

        assistant = await assistant_store.create(data, "user-123")

        assert assistant.assistant_id == provided_id

    async def test_create_without_assistant_id_generates_one(
        self, assistant_store: AssistantStore
    ):
        """Create without assistant_id still auto-generates a unique ID."""
        assistant = await assistant_store.create({"graph_id": "agent"}, "user-123")

        assert assistant.assistant_id is not None
        assert len(assistant.assistant_id) == 32  # UUID hex

    async def test_create_with_empty_assistant_id_generates_one(
        self, assistant_store: AssistantStore
    ):
        """Create with empty-string assistant_id falls back to generation."""
        data = {"graph_id": "agent", "assistant_id": ""}
        assistant = await assistant_store.create(data, "user-123")

        assert assistant.assistant_id != ""
        assert len(assistant.assistant_id) == 32

    async def test_get_by_provided_id(self, assistant_store: AssistantStore):
        """Retrieving by the provided assistant_id works."""
        provided_id = "my-deterministic-id-001"
        data = {"graph_id": "agent", "assistant_id": provided_id}
        await assistant_store.create(data, "user-123")

        retrieved = await assistant_store.get(provided_id, "user-123")

        assert retrieved is not None
        assert retrieved.assistant_id == provided_id
        assert retrieved.graph_id == "agent"

    async def test_provided_id_preserves_config(self, assistant_store: AssistantStore):
        """Deterministic-ID assistant preserves full config including configurable."""
        provided_id = "agent-uuid-with-config"
        data = {
            "graph_id": "agent",
            "assistant_id": provided_id,
            "config": {
                "configurable": {
                    "model_name": "openai:gpt-4o-mini",
                    "system_prompt": "You are a helpful assistant.",
                    "mcp_config": {
                        "servers": [{"name": "s1", "url": "http://localhost:8080"}]
                    },
                }
            },
        }
        await assistant_store.create(data, "system")

        retrieved = await assistant_store.get(provided_id, "system")

        assert retrieved is not None
        assert retrieved.config.configurable["model_name"] == "openai:gpt-4o-mini"
        assert (
            retrieved.config.configurable["system_prompt"]
            == "You are a helpful assistant."
        )
        assert "mcp_config" in retrieved.config.configurable

    async def test_two_creates_with_same_id_second_overwrites(
        self, assistant_store: AssistantStore
    ):
        """Creating with the same provided ID overwrites the first entry."""
        provided_id = "duplicate-id"
        await assistant_store.create(
            {"graph_id": "agent", "assistant_id": provided_id, "name": "First"},
            "user-123",
        )
        second = await assistant_store.create(
            {"graph_id": "agent", "assistant_id": provided_id, "name": "Second"},
            "user-123",
        )

        assert second.name == "Second"
        retrieved = await assistant_store.get(provided_id, "user-123")
        assert retrieved is not None
        assert retrieved.name == "Second"


# ============================================================================
# Synced Assistant Visibility Tests
# ============================================================================


class TestSyncedAssistantVisibility:
    """Tests for synced assistant cross-owner visibility (Bug 2 fix).

    Synced assistants (those with ``supabase_agent_id`` in metadata) should
    be visible to any authenticated user via ``get()`` and ``list()``, while
    user-created assistants remain strictly owner-isolated.
    """

    @staticmethod
    def _synced_payload(
        assistant_id: str = "supabase-agent-uuid-001",
        graph_id: str = "agent",
    ) -> dict:
        """Build a payload that mimics what agent_sync produces."""
        return {
            "assistant_id": assistant_id,
            "graph_id": graph_id,
            "config": {
                "configurable": {
                    "model_name": "openai:gpt-4o-mini",
                    "mcp_config": {"servers": []},
                }
            },
            "metadata": {
                "supabase_agent_id": assistant_id,
                "supabase_organization_id": "org-001",
                "synced_at": "2026-02-12T00:00:00+00:00",
            },
        }

    async def test_synced_assistant_visible_to_any_user_via_get(
        self, assistant_store: AssistantStore
    ):
        """A synced assistant created by 'system' is visible to a real user via get()."""
        payload = self._synced_payload()
        await assistant_store.create(payload, "system")

        retrieved = await assistant_store.get(payload["assistant_id"], "real-user-abc")

        assert retrieved is not None
        assert retrieved.assistant_id == payload["assistant_id"]
        assert retrieved.config.configurable["model_name"] == "openai:gpt-4o-mini"

    async def test_synced_assistant_visible_to_any_user_via_list(
        self, assistant_store: AssistantStore
    ):
        """A synced assistant appears in list() for any authenticated user."""
        payload = self._synced_payload()
        await assistant_store.create(payload, "system")

        # Also create a user-owned assistant
        await assistant_store.create({"graph_id": "agent"}, "real-user-abc")

        results = await assistant_store.list("real-user-abc")

        assistant_ids = [a.assistant_id for a in results]
        assert payload["assistant_id"] in assistant_ids
        assert len(results) == 2  # synced + user-owned

    async def test_non_synced_assistant_still_isolated(
        self, assistant_store: AssistantStore
    ):
        """A regular (non-synced) assistant is NOT visible to other users."""
        await assistant_store.create(
            {"graph_id": "agent", "name": "Private"},
            "user-owner",
        )

        # Different user cannot see it
        assert await assistant_store.list("other-user") == []

    async def test_synced_visible_but_non_synced_hidden_in_same_store(
        self, assistant_store: AssistantStore
    ):
        """Mixed scenario: synced assistants visible, regular ones hidden."""
        synced_payload = self._synced_payload("synced-id")
        await assistant_store.create(synced_payload, "system")
        await assistant_store.create(
            {"graph_id": "agent", "name": "UserA Private"}, "user-a"
        )
        await assistant_store.create(
            {"graph_id": "agent", "name": "UserB Private"}, "user-b"
        )

        results_a = await assistant_store.list("user-a")
        results_b = await assistant_store.list("user-b")
        results_c = await assistant_store.list("user-c")

        # user-a sees: synced + own private = 2
        assert len(results_a) == 2
        # user-b sees: synced + own private = 2
        assert len(results_b) == 2
        # user-c sees: synced only = 1
        assert len(results_c) == 1
        assert results_c[0].assistant_id == "synced-id"

    async def test_synced_assistant_config_propagates(
        self, assistant_store: AssistantStore
    ):
        """Full config (model, system prompt, MCP) survives create→get round-trip."""
        payload = self._synced_payload()
        payload["config"]["configurable"]["system_prompt"] = (
            "Du bist ein Rechtsassistent."
        )
        payload["config"]["configurable"]["temperature"] = 0.3
        await assistant_store.create(payload, "system")

        retrieved = await assistant_store.get(payload["assistant_id"], "any-user")

        assert retrieved is not None
        configurable = retrieved.config.configurable
        assert configurable["model_name"] == "openai:gpt-4o-mini"
        assert configurable["system_prompt"] == "Du bist ein Rechtsassistent."
        assert configurable["temperature"] == 0.3
        assert "mcp_config" in configurable

    async def test_update_synced_assistant_requires_owner(
        self, assistant_store: AssistantStore
    ):
        """Updating a synced assistant still requires the correct owner."""
        payload = self._synced_payload()
        await assistant_store.create(payload, "system")

        # A different user can read it but NOT update it
        result = await assistant_store.update(
            payload["assistant_id"],
            {"name": "Hacked"},
            "attacker-user",
        )
        assert result is None

        # The original owner can update
        result = await assistant_store.update(
            payload["assistant_id"],
            {"name": "Updated By System"},
            "system",
        )
        assert result is not None
        assert result.name == "Updated By System"

    async def test_delete_synced_assistant_requires_owner(
        self, assistant_store: AssistantStore
    ):
        """Deleting a synced assistant still requires the correct owner."""
        payload = self._synced_payload()
        await assistant_store.create(payload, "system")

        # A different user cannot delete it
        assert (
            await assistant_store.delete(payload["assistant_id"], "attacker") is False
        )

        # The original owner can delete
        assert await assistant_store.delete(payload["assistant_id"], "system") is True
        assert await assistant_store.get(payload["assistant_id"], "system") is None

    async def test_get_nonexistent_synced_id_returns_none(
        self, assistant_store: AssistantStore
    ):
        """Requesting a non-existent ID returns None, not an error."""
        result = await assistant_store.get("does-not-exist", "any-user")
        assert result is None

    async def test_multiple_synced_assistants_all_visible(
        self, assistant_store: AssistantStore
    ):
        """Multiple synced assistants from different orgs are all visible."""
        for index in range(3):
            payload = self._synced_payload(f"agent-{index}")
            payload["metadata"]["supabase_organization_id"] = f"org-{index}"
            await assistant_store.create(payload, "system")

        results = await assistant_store.list("any-user")
        assert len(results) == 3
