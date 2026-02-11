"""Unit tests for the runs API endpoints.

Tests cover:
- CRUD operations (create, list, get, delete)
- Owner isolation
- Thread validation
- Multitask strategy handling
- Wait endpoint
- Cancel endpoint
- Error handling
"""

import json
import time

import pytest

from robyn_server.models import (
    RunCreate,
)
from robyn_server.routes.helpers import (
    json_response,
)
from robyn_server.storage import Storage, get_storage, reset_storage


# ============================================================================
# Fixtures
# ============================================================================


@pytest.fixture(autouse=True)
def reset_global_storage():
    """Reset global storage before and after each test."""
    reset_storage()
    yield
    reset_storage()


@pytest.fixture
def storage() -> Storage:
    """Get a fresh storage instance."""
    return get_storage()


@pytest.fixture
def mock_user():
    """Create a mock authenticated user."""
    from robyn_server.auth import AuthUser

    return AuthUser(identity="user-123", email="test@example.com")


@pytest.fixture
def other_user():
    """Create a different mock authenticated user."""
    from robyn_server.auth import AuthUser

    return AuthUser(identity="user-456", email="other@example.com")


@pytest.fixture
async def assistant(storage, mock_user):
    """Create a test assistant."""
    return await storage.assistants.create(
        {"graph_id": "test-graph", "name": "Test Assistant"},
        mock_user.identity,
    )


@pytest.fixture
async def thread(storage, mock_user):
    """Create a test thread."""
    return await storage.threads.create({}, mock_user.identity)


# ============================================================================
# Model Tests
# ============================================================================


class TestRunModels:
    """Tests for Run Pydantic models."""

    def test_run_create_required_fields(self):
        """RunCreate requires assistant_id."""
        create = RunCreate(assistant_id="test-assistant")
        assert create.assistant_id == "test-assistant"

    def test_run_create_defaults(self):
        """RunCreate should have sensible defaults."""
        create = RunCreate(assistant_id="test")
        assert create.input is None
        assert create.command is None
        assert create.checkpoint is None
        assert create.metadata == {}
        assert create.config == {}
        assert create.context == {}
        assert create.webhook is None
        assert create.interrupt_before is None
        assert create.interrupt_after is None
        assert create.stream_mode == ["values"]
        assert create.stream_subgraphs is False
        assert create.stream_resumable is False
        assert create.feedback_keys is None
        assert create.multitask_strategy == "enqueue"
        assert create.on_disconnect == "continue"
        assert create.on_completion == "delete"
        assert create.if_not_exists == "reject"
        assert create.after_seconds is None
        assert create.checkpoint_during is False
        assert create.durability == "async"

    def test_run_create_with_input(self):
        """RunCreate should accept various input types."""
        # Dict input
        create = RunCreate(assistant_id="test", input={"messages": []})
        assert create.input == {"messages": []}

        # List input
        create = RunCreate(assistant_id="test", input=[1, 2, 3])
        assert create.input == [1, 2, 3]

        # String input
        create = RunCreate(assistant_id="test", input="hello")
        assert create.input == "hello"

        # Boolean input
        create = RunCreate(assistant_id="test", input=True)
        assert create.input is True

    def test_run_create_multitask_strategies(self):
        """RunCreate should accept all multitask strategies."""
        for strategy in ["reject", "enqueue", "rollback", "interrupt"]:
            create = RunCreate(assistant_id="test", multitask_strategy=strategy)
            assert create.multitask_strategy == strategy


# ============================================================================
# Run Storage Tests
# ============================================================================


class TestRunStorage:
    """Tests for RunStore CRUD operations."""

    async def test_create_run(self, storage, mock_user, assistant, thread):
        """Should create a run with generated ID and timestamps."""
        run = await storage.runs.create(
            {
                "thread_id": thread.thread_id,
                "assistant_id": assistant.assistant_id,
            },
            mock_user.identity,
        )

        assert run.run_id is not None
        assert len(run.run_id) == 32  # UUID hex
        assert run.thread_id == thread.thread_id
        assert run.assistant_id == assistant.assistant_id
        assert run.status == "pending"
        assert run.metadata["owner"] == mock_user.identity
        assert run.kwargs == {}
        assert run.multitask_strategy == "reject"
        assert run.created_at is not None
        assert run.updated_at is not None

    async def test_create_run_with_metadata(
        self, storage, mock_user, assistant, thread
    ):
        """Should create a run with custom metadata."""
        run = await storage.runs.create(
            {
                "thread_id": thread.thread_id,
                "assistant_id": assistant.assistant_id,
                "metadata": {"task": "test", "priority": "high"},
            },
            mock_user.identity,
        )

        assert run.metadata["task"] == "test"
        assert run.metadata["priority"] == "high"
        assert run.metadata["owner"] == mock_user.identity

    async def test_create_run_requires_thread_id(self, storage, mock_user, assistant):
        """Should raise error if thread_id is missing."""
        with pytest.raises(ValueError, match="thread_id is required"):
            await storage.runs.create(
                {"assistant_id": assistant.assistant_id},
                mock_user.identity,
            )

    async def test_create_run_requires_assistant_id(self, storage, mock_user, thread):
        """Should raise error if assistant_id is missing."""
        with pytest.raises(ValueError, match="assistant_id is required"):
            await storage.runs.create(
                {"thread_id": thread.thread_id},
                mock_user.identity,
            )

    async def test_get_run(self, storage, mock_user, assistant, thread):
        """Should retrieve a run by ID."""
        created = await storage.runs.create(
            {
                "thread_id": thread.thread_id,
                "assistant_id": assistant.assistant_id,
            },
            mock_user.identity,
        )
        retrieved = await storage.runs.get(created.run_id, mock_user.identity)

        assert retrieved is not None
        assert retrieved.run_id == created.run_id

    async def test_get_run_owner_isolation(
        self, storage, mock_user, other_user, assistant, thread
    ):
        """Should not retrieve runs owned by other users."""
        created = await storage.runs.create(
            {
                "thread_id": thread.thread_id,
                "assistant_id": assistant.assistant_id,
            },
            mock_user.identity,
        )

        # Same user can retrieve
        retrieved = await storage.runs.get(created.run_id, mock_user.identity)
        assert retrieved is not None

        # Different user cannot retrieve
        retrieved = await storage.runs.get(created.run_id, other_user.identity)
        assert retrieved is None

    async def test_delete_run(self, storage, mock_user, assistant, thread):
        """Should delete a run."""
        created = await storage.runs.create(
            {
                "thread_id": thread.thread_id,
                "assistant_id": assistant.assistant_id,
            },
            mock_user.identity,
        )

        deleted = await storage.runs.delete(created.run_id, mock_user.identity)
        assert deleted is True

        # Verify it's gone
        retrieved = await storage.runs.get(created.run_id, mock_user.identity)
        assert retrieved is None

    async def test_delete_run_owner_isolation(
        self, storage, mock_user, other_user, assistant, thread
    ):
        """Should not delete runs owned by other users."""
        created = await storage.runs.create(
            {
                "thread_id": thread.thread_id,
                "assistant_id": assistant.assistant_id,
            },
            mock_user.identity,
        )

        deleted = await storage.runs.delete(created.run_id, other_user.identity)
        assert deleted is False

        # Verify it still exists
        retrieved = await storage.runs.get(created.run_id, mock_user.identity)
        assert retrieved is not None


# ============================================================================
# List Runs Tests
# ============================================================================


class TestListRuns:
    """Tests for listing runs by thread."""

    async def test_list_by_thread(self, storage, mock_user, assistant, thread):
        """Should list runs for a specific thread."""
        # Create multiple runs
        for i in range(3):
            await storage.runs.create(
                {
                    "thread_id": thread.thread_id,
                    "assistant_id": assistant.assistant_id,
                    "metadata": {"index": i},
                },
                mock_user.identity,
            )

        runs = await storage.runs.list_by_thread(thread.thread_id, mock_user.identity)
        assert len(runs) == 3

    async def test_list_by_thread_owner_isolation(
        self, storage, mock_user, other_user, assistant, thread
    ):
        """Should only list runs owned by the user."""
        # User 1 creates runs
        await storage.runs.create(
            {
                "thread_id": thread.thread_id,
                "assistant_id": assistant.assistant_id,
            },
            mock_user.identity,
        )

        # Other user creates their own thread and run
        other_thread = await storage.threads.create({}, other_user.identity)
        other_assistant = await storage.assistants.create(
            {"graph_id": "other-graph"},
            other_user.identity,
        )
        await storage.runs.create(
            {
                "thread_id": other_thread.thread_id,
                "assistant_id": other_assistant.assistant_id,
            },
            other_user.identity,
        )

        # Each user only sees their own runs
        user1_runs = await storage.runs.list_by_thread(
            thread.thread_id, mock_user.identity
        )
        assert len(user1_runs) == 1

        user2_runs = await storage.runs.list_by_thread(
            other_thread.thread_id, other_user.identity
        )
        assert len(user2_runs) == 1

    async def test_list_by_thread_with_pagination(
        self, storage, mock_user, assistant, thread
    ):
        """Should paginate results correctly."""
        # Create 5 runs
        for i in range(5):
            await storage.runs.create(
                {
                    "thread_id": thread.thread_id,
                    "assistant_id": assistant.assistant_id,
                    "metadata": {"index": i},
                },
                mock_user.identity,
            )

        # Get first page
        page1 = await storage.runs.list_by_thread(
            thread.thread_id, mock_user.identity, limit=2, offset=0
        )
        assert len(page1) == 2

        # Get second page
        page2 = await storage.runs.list_by_thread(
            thread.thread_id, mock_user.identity, limit=2, offset=2
        )
        assert len(page2) == 2

        # Get third page (partial)
        page3 = await storage.runs.list_by_thread(
            thread.thread_id, mock_user.identity, limit=2, offset=4
        )
        assert len(page3) == 1

    async def test_list_by_thread_with_status_filter(
        self, storage, mock_user, assistant, thread
    ):
        """Should filter runs by status."""
        # Create runs with different statuses
        run1 = await storage.runs.create(
            {
                "thread_id": thread.thread_id,
                "assistant_id": assistant.assistant_id,
            },
            mock_user.identity,
        )
        run2 = await storage.runs.create(
            {
                "thread_id": thread.thread_id,
                "assistant_id": assistant.assistant_id,
            },
            mock_user.identity,
        )

        # Update one to success
        await storage.runs.update_status(run2.run_id, "success", mock_user.identity)

        # Filter by pending
        pending = await storage.runs.list_by_thread(
            thread.thread_id, mock_user.identity, status="pending"
        )
        assert len(pending) == 1
        assert pending[0].run_id == run1.run_id

        # Filter by success
        success = await storage.runs.list_by_thread(
            thread.thread_id, mock_user.identity, status="success"
        )
        assert len(success) == 1
        assert success[0].run_id == run2.run_id


# ============================================================================
# Get/Delete by Thread Tests
# ============================================================================


class TestGetDeleteByThread:
    """Tests for thread-scoped get and delete operations."""

    async def test_get_by_thread(self, storage, mock_user, assistant, thread):
        """Should get a run scoped to thread."""
        run = await storage.runs.create(
            {
                "thread_id": thread.thread_id,
                "assistant_id": assistant.assistant_id,
            },
            mock_user.identity,
        )

        retrieved = await storage.runs.get_by_thread(
            thread.thread_id, run.run_id, mock_user.identity
        )
        assert retrieved is not None
        assert retrieved.run_id == run.run_id

    async def test_get_by_thread_wrong_thread(
        self, storage, mock_user, assistant, thread
    ):
        """Should not get run with wrong thread_id."""
        run = await storage.runs.create(
            {
                "thread_id": thread.thread_id,
                "assistant_id": assistant.assistant_id,
            },
            mock_user.identity,
        )

        # Create another thread
        other_thread = await storage.threads.create({}, mock_user.identity)

        # Try to get run with wrong thread_id
        retrieved = await storage.runs.get_by_thread(
            other_thread.thread_id, run.run_id, mock_user.identity
        )
        assert retrieved is None

    async def test_delete_by_thread(self, storage, mock_user, assistant, thread):
        """Should delete a run scoped to thread."""
        run = await storage.runs.create(
            {
                "thread_id": thread.thread_id,
                "assistant_id": assistant.assistant_id,
            },
            mock_user.identity,
        )

        deleted = await storage.runs.delete_by_thread(
            thread.thread_id, run.run_id, mock_user.identity
        )
        assert deleted is True

        # Verify it's gone
        retrieved = await storage.runs.get(run.run_id, mock_user.identity)
        assert retrieved is None

    async def test_delete_by_thread_wrong_thread(
        self, storage, mock_user, assistant, thread
    ):
        """Should not delete run with wrong thread_id."""
        run = await storage.runs.create(
            {
                "thread_id": thread.thread_id,
                "assistant_id": assistant.assistant_id,
            },
            mock_user.identity,
        )

        # Create another thread
        other_thread = await storage.threads.create({}, mock_user.identity)

        # Try to delete run with wrong thread_id
        deleted = await storage.runs.delete_by_thread(
            other_thread.thread_id, run.run_id, mock_user.identity
        )
        assert deleted is False

        # Verify it still exists
        retrieved = await storage.runs.get(run.run_id, mock_user.identity)
        assert retrieved is not None


# ============================================================================
# Active Run Tests
# ============================================================================


class TestActiveRun:
    """Tests for active run detection."""

    async def test_get_active_run_pending(self, storage, mock_user, assistant, thread):
        """Should find pending run as active."""
        run = await storage.runs.create(
            {
                "thread_id": thread.thread_id,
                "assistant_id": assistant.assistant_id,
                "status": "pending",
            },
            mock_user.identity,
        )

        active = await storage.runs.get_active_run(thread.thread_id, mock_user.identity)
        assert active is not None
        assert active.run_id == run.run_id

    async def test_get_active_run_running(self, storage, mock_user, assistant, thread):
        """Should find running run as active."""
        run = await storage.runs.create(
            {
                "thread_id": thread.thread_id,
                "assistant_id": assistant.assistant_id,
                "status": "running",
            },
            mock_user.identity,
        )

        active = await storage.runs.get_active_run(thread.thread_id, mock_user.identity)
        assert active is not None
        assert active.run_id == run.run_id

    async def test_get_active_run_none_when_completed(
        self, storage, mock_user, assistant, thread
    ):
        """Should return None when all runs are completed."""
        run = await storage.runs.create(
            {
                "thread_id": thread.thread_id,
                "assistant_id": assistant.assistant_id,
            },
            mock_user.identity,
        )

        # Mark as success
        await storage.runs.update_status(run.run_id, "success", mock_user.identity)

        active = await storage.runs.get_active_run(thread.thread_id, mock_user.identity)
        assert active is None

    async def test_get_active_run_none_when_empty(self, storage, mock_user, thread):
        """Should return None when thread has no runs."""
        active = await storage.runs.get_active_run(thread.thread_id, mock_user.identity)
        assert active is None


# ============================================================================
# Update Status Tests
# ============================================================================


class TestUpdateStatus:
    """Tests for run status updates."""

    async def test_update_status(self, storage, mock_user, assistant, thread):
        """Should update run status."""
        run = await storage.runs.create(
            {
                "thread_id": thread.thread_id,
                "assistant_id": assistant.assistant_id,
            },
            mock_user.identity,
        )
        assert run.status == "pending"

        updated = await storage.runs.update_status(
            run.run_id, "running", mock_user.identity
        )
        assert updated is not None
        assert updated.status == "running"

        updated = await storage.runs.update_status(
            run.run_id, "success", mock_user.identity
        )
        assert updated is not None
        assert updated.status == "success"

    async def test_update_status_owner_isolation(
        self, storage, mock_user, other_user, assistant, thread
    ):
        """Should not update status for runs owned by other users."""
        run = await storage.runs.create(
            {
                "thread_id": thread.thread_id,
                "assistant_id": assistant.assistant_id,
            },
            mock_user.identity,
        )

        updated = await storage.runs.update_status(
            run.run_id, "success", other_user.identity
        )
        assert updated is None

        # Verify status unchanged
        retrieved = await storage.runs.get(run.run_id, mock_user.identity)
        assert retrieved.status == "pending"


# ============================================================================
# Count Tests
# ============================================================================


class TestCountRuns:
    """Tests for counting runs."""

    async def test_count_by_thread(self, storage, mock_user, assistant, thread):
        """Should count runs for a thread."""
        # Initially zero
        count = await storage.runs.count_by_thread(thread.thread_id, mock_user.identity)
        assert count == 0

        # Create some runs
        for _ in range(3):
            await storage.runs.create(
                {
                    "thread_id": thread.thread_id,
                    "assistant_id": assistant.assistant_id,
                },
                mock_user.identity,
            )

        count = await storage.runs.count_by_thread(thread.thread_id, mock_user.identity)
        assert count == 3


# ============================================================================
# Edge Cases Tests
# ============================================================================


class TestEdgeCases:
    """Tests for edge cases and error handling."""

    async def test_get_nonexistent_run(self, storage, mock_user):
        """Should return None for nonexistent run."""
        run = await storage.runs.get("nonexistent-id", mock_user.identity)
        assert run is None

    async def test_update_nonexistent_run(self, storage, mock_user):
        """Should return None when updating nonexistent run."""
        run = await storage.runs.update_status(
            "nonexistent-id", "success", mock_user.identity
        )
        assert run is None

    async def test_delete_nonexistent_run(self, storage, mock_user):
        """Should return False when deleting nonexistent run."""
        deleted = await storage.runs.delete("nonexistent-id", mock_user.identity)
        assert deleted is False

    async def test_run_id_is_generated(self, storage, mock_user, assistant, thread):
        """Should generate unique run IDs."""
        run1 = await storage.runs.create(
            {
                "thread_id": thread.thread_id,
                "assistant_id": assistant.assistant_id,
            },
            mock_user.identity,
        )
        run2 = await storage.runs.create(
            {
                "thread_id": thread.thread_id,
                "assistant_id": assistant.assistant_id,
            },
            mock_user.identity,
        )

        assert run1.run_id is not None
        assert run2.run_id is not None
        assert run1.run_id != run2.run_id

    async def test_timestamps_are_set(self, storage, mock_user, assistant, thread):
        """Should set created_at and updated_at timestamps."""
        run = await storage.runs.create(
            {
                "thread_id": thread.thread_id,
                "assistant_id": assistant.assistant_id,
            },
            mock_user.identity,
        )

        assert run.created_at is not None
        assert run.updated_at is not None
        assert run.created_at == run.updated_at

    async def test_update_changes_updated_at(
        self, storage, mock_user, assistant, thread
    ):
        """Should update updated_at on modification."""
        run = await storage.runs.create(
            {
                "thread_id": thread.thread_id,
                "assistant_id": assistant.assistant_id,
            },
            mock_user.identity,
        )
        original_updated = run.updated_at

        # Small delay to ensure timestamp difference
        time.sleep(0.01)

        updated = await storage.runs.update_status(
            run.run_id, "running", mock_user.identity
        )

        assert updated is not None
        assert updated.updated_at > original_updated
        assert updated.created_at == run.created_at


# ============================================================================
# Run Model Serialization Tests
# ============================================================================


class TestRunSerialization:
    """Tests for Run model serialization."""

    async def test_run_datetime_serialization(
        self, storage, mock_user, assistant, thread
    ):
        """Run datetimes should serialize to ISO 8601 with Z suffix."""
        run = await storage.runs.create(
            {
                "thread_id": thread.thread_id,
                "assistant_id": assistant.assistant_id,
            },
            mock_user.identity,
        )

        # Serialize to JSON
        json_data = run.model_dump(mode="json")

        assert "created_at" in json_data
        assert "updated_at" in json_data
        assert json_data["created_at"].endswith("Z")
        assert json_data["updated_at"].endswith("Z")

    async def test_json_response_with_run(self, storage, mock_user, assistant, thread):
        """json_response should serialize Run model correctly."""
        run = await storage.runs.create(
            {
                "thread_id": thread.thread_id,
                "assistant_id": assistant.assistant_id,
                "metadata": {"test": "value"},
            },
            mock_user.identity,
        )

        response = json_response(run)
        body = json.loads(response.description)

        assert body["run_id"] == run.run_id
        assert body["thread_id"] == thread.thread_id
        assert body["assistant_id"] == assistant.assistant_id
        assert body["metadata"]["test"] == "value"
        assert body["status"] == "pending"
        assert body["created_at"].endswith("Z")

    async def test_json_response_with_run_list(
        self, storage, mock_user, assistant, thread
    ):
        """json_response should serialize list of Run models."""
        await storage.runs.create(
            {
                "thread_id": thread.thread_id,
                "assistant_id": assistant.assistant_id,
            },
            mock_user.identity,
        )
        await storage.runs.create(
            {
                "thread_id": thread.thread_id,
                "assistant_id": assistant.assistant_id,
            },
            mock_user.identity,
        )

        runs = await storage.runs.list_by_thread(thread.thread_id, mock_user.identity)
        response = json_response(runs)
        body = json.loads(response.description)

        assert len(body) == 2
        assert body[0]["thread_id"] == thread.thread_id
        assert body[1]["thread_id"] == thread.thread_id
