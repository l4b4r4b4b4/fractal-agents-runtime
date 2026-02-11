"""Unit tests for the threads API endpoints.

Tests cover:
- CRUD operations (create, get, update, delete)
- Owner isolation
- State and history endpoints
- Search and count endpoints
- Error handling
"""

import json
import time
from unittest.mock import MagicMock

import pytest

from robyn_server.models import (
    ThreadCountRequest,
    ThreadCreate,
    ThreadPatch,
    ThreadSearchRequest,
)
from robyn_server.routes.helpers import (
    error_response,
    json_response,
    parse_json_body,
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


# ============================================================================
# Helper Function Tests
# ============================================================================


class TestHelperFunctions:
    """Tests for helper functions."""

    def test_json_response_with_dict(self):
        """json_response should serialize dicts to JSON."""
        response = json_response({"key": "value"})
        assert response.status_code == 200
        assert response.headers["Content-Type"] == "application/json"
        assert json.loads(response.description) == {"key": "value"}

    def test_json_response_with_custom_status(self):
        """json_response should use custom status code."""
        response = json_response({}, 201)
        assert response.status_code == 201

    def test_error_response_format(self):
        """error_response should match LangGraph API format."""
        response = error_response("Not found", 404)
        assert response.status_code == 404
        body = json.loads(response.description)
        assert body == {"detail": "Not found"}

    def test_parse_json_body_with_bytes(self):
        """parse_json_body should handle bytes input."""
        request = MagicMock()
        request.body = b'{"key": "value"}'
        result = parse_json_body(request)
        assert result == {"key": "value"}

    def test_parse_json_body_with_string(self):
        """parse_json_body should handle string input."""
        request = MagicMock()
        request.body = '{"key": "value"}'
        result = parse_json_body(request)
        assert result == {"key": "value"}

    def test_parse_json_body_empty(self):
        """parse_json_body should return empty dict for empty body."""
        request = MagicMock()
        request.body = ""
        result = parse_json_body(request)
        assert result == {}


# ============================================================================
# Model Tests
# ============================================================================


class TestThreadModels:
    """Tests for Thread Pydantic models."""

    def test_thread_create_defaults(self):
        """ThreadCreate should have sensible defaults."""
        create = ThreadCreate()
        assert create.thread_id is None
        assert create.metadata == {}
        assert create.if_exists == "raise"

    def test_thread_create_with_values(self):
        """ThreadCreate should accept all fields."""
        create = ThreadCreate(
            thread_id="test-123",
            metadata={"key": "value"},
            if_exists="do_nothing",
        )
        assert create.thread_id == "test-123"
        assert create.metadata == {"key": "value"}
        assert create.if_exists == "do_nothing"

    def test_thread_patch_all_optional(self):
        """ThreadPatch should make all fields optional."""
        patch = ThreadPatch()
        assert patch.metadata is None

    def test_thread_patch_with_metadata(self):
        """ThreadPatch should accept metadata."""
        patch = ThreadPatch(metadata={"new": "value"})
        assert patch.metadata == {"new": "value"}

    def test_thread_search_defaults(self):
        """ThreadSearchRequest should have sensible defaults."""
        search = ThreadSearchRequest()
        assert search.ids is None
        assert search.metadata is None
        assert search.values is None
        assert search.status is None
        assert search.limit == 10
        assert search.offset == 0
        assert search.sort_by is None
        assert search.sort_order is None

    def test_thread_count_all_optional(self):
        """ThreadCountRequest should make all fields optional."""
        count = ThreadCountRequest()
        assert count.metadata is None
        assert count.values is None
        assert count.status is None


# ============================================================================
# Thread Storage Tests
# ============================================================================


class TestThreadStorage:
    """Tests for ThreadStore CRUD operations."""

    async def test_create_thread(self, storage, mock_user):
        """Should create a thread with generated ID and timestamps."""
        thread = await storage.threads.create({}, mock_user.identity)

        assert thread.thread_id is not None
        assert len(thread.thread_id) == 32  # UUID hex
        assert thread.metadata["owner"] == mock_user.identity
        assert thread.status == "idle"
        assert thread.values == {}
        assert thread.config == {}
        assert thread.interrupts == {}
        assert thread.created_at is not None
        assert thread.updated_at is not None

    async def test_create_thread_with_metadata(self, storage, mock_user):
        """Should create a thread with custom metadata."""
        thread = await storage.threads.create(
            {"metadata": {"project": "test", "env": "dev"}},
            mock_user.identity,
        )

        assert thread.metadata["project"] == "test"
        assert thread.metadata["env"] == "dev"
        assert thread.metadata["owner"] == mock_user.identity

    async def test_get_thread(self, storage, mock_user):
        """Should retrieve a thread by ID."""
        created = await storage.threads.create({}, mock_user.identity)
        retrieved = await storage.threads.get(created.thread_id, mock_user.identity)

        assert retrieved is not None
        assert retrieved.thread_id == created.thread_id

    async def test_get_thread_owner_isolation(self, storage, mock_user, other_user):
        """Should not retrieve threads owned by other users."""
        created = await storage.threads.create({}, mock_user.identity)

        # Same user can retrieve
        retrieved = await storage.threads.get(created.thread_id, mock_user.identity)
        assert retrieved is not None

        # Different user cannot retrieve
        retrieved = await storage.threads.get(created.thread_id, other_user.identity)
        assert retrieved is None

    async def test_update_thread(self, storage, mock_user):
        """Should update thread metadata."""
        created = await storage.threads.create({}, mock_user.identity)

        updated = await storage.threads.update(
            created.thread_id,
            {"metadata": {"updated": True}},
            mock_user.identity,
        )

        assert updated is not None
        assert updated.metadata["updated"] is True
        assert updated.metadata["owner"] == mock_user.identity

    async def test_update_thread_owner_isolation(self, storage, mock_user, other_user):
        """Should not update threads owned by other users."""
        created = await storage.threads.create({}, mock_user.identity)

        updated = await storage.threads.update(
            created.thread_id,
            {"metadata": {"hacked": True}},
            other_user.identity,
        )

        assert updated is None

    async def test_delete_thread(self, storage, mock_user):
        """Should delete a thread."""
        created = await storage.threads.create({}, mock_user.identity)

        deleted = await storage.threads.delete(created.thread_id, mock_user.identity)
        assert deleted is True

        # Verify it's gone
        retrieved = await storage.threads.get(created.thread_id, mock_user.identity)
        assert retrieved is None

    async def test_delete_thread_owner_isolation(self, storage, mock_user, other_user):
        """Should not delete threads owned by other users."""
        created = await storage.threads.create({}, mock_user.identity)

        deleted = await storage.threads.delete(created.thread_id, other_user.identity)
        assert deleted is False

        # Verify it still exists
        retrieved = await storage.threads.get(created.thread_id, mock_user.identity)
        assert retrieved is not None

    async def test_list_threads_owner_isolation(self, storage, mock_user, other_user):
        """Should only list threads owned by the user."""
        await storage.threads.create(
            {"metadata": {"name": "user1-thread"}}, mock_user.identity
        )
        await storage.threads.create(
            {"metadata": {"name": "user2-thread"}}, other_user.identity
        )

        user1_threads = await storage.threads.list(mock_user.identity)
        assert len(user1_threads) == 1
        assert user1_threads[0].metadata["name"] == "user1-thread"

        user2_threads = await storage.threads.list(other_user.identity)
        assert len(user2_threads) == 1
        assert user2_threads[0].metadata["name"] == "user2-thread"


# ============================================================================
# Thread State Tests
# ============================================================================


class TestThreadState:
    """Tests for thread state management."""

    async def test_get_state_empty_thread(self, storage, mock_user):
        """Should return state for thread with no values."""
        thread = await storage.threads.create({}, mock_user.identity)
        state = await storage.threads.get_state(thread.thread_id, mock_user.identity)

        assert state is not None
        assert state.values == {}
        assert state.next == []
        assert state.tasks == []
        assert state.checkpoint is not None
        assert state.checkpoint["thread_id"] == thread.thread_id
        assert state.created_at is not None

    async def test_get_state_owner_isolation(self, storage, mock_user, other_user):
        """Should not return state for threads owned by other users."""
        thread = await storage.threads.create({}, mock_user.identity)

        state = await storage.threads.get_state(thread.thread_id, other_user.identity)
        assert state is None

    async def test_get_state_nonexistent_thread(self, storage, mock_user):
        """Should return None for nonexistent thread."""
        state = await storage.threads.get_state("nonexistent", mock_user.identity)
        assert state is None

    async def test_add_state_snapshot(self, storage, mock_user):
        """Should add state snapshot to history."""
        thread = await storage.threads.create({}, mock_user.identity)

        result = await storage.threads.add_state_snapshot(
            thread.thread_id,
            {"values": {"messages": [{"role": "user", "content": "Hello"}]}},
            mock_user.identity,
        )

        assert result is True

        # Verify thread values updated
        updated = await storage.threads.get(thread.thread_id, mock_user.identity)
        assert updated.values == {"messages": [{"role": "user", "content": "Hello"}]}

    async def test_add_state_snapshot_owner_isolation(
        self, storage, mock_user, other_user
    ):
        """Should not add state to threads owned by other users."""
        thread = await storage.threads.create({}, mock_user.identity)

        result = await storage.threads.add_state_snapshot(
            thread.thread_id,
            {"values": {"hacked": True}},
            other_user.identity,
        )

        assert result is False


# ============================================================================
# Thread History Tests
# ============================================================================


class TestThreadHistory:
    """Tests for thread history management."""

    async def test_get_history_empty(self, storage, mock_user):
        """Should return empty history for new thread."""
        thread = await storage.threads.create({}, mock_user.identity)
        history = await storage.threads.get_history(
            thread.thread_id, mock_user.identity
        )

        assert history is not None
        assert len(history) == 0

    async def test_get_history_with_snapshots(self, storage, mock_user):
        """Should return history with snapshots."""
        thread = await storage.threads.create({}, mock_user.identity)

        # Add some snapshots
        await storage.threads.add_state_snapshot(
            thread.thread_id,
            {"values": {"step": 1}},
            mock_user.identity,
        )
        await storage.threads.add_state_snapshot(
            thread.thread_id,
            {"values": {"step": 2}},
            mock_user.identity,
        )
        await storage.threads.add_state_snapshot(
            thread.thread_id,
            {"values": {"step": 3}},
            mock_user.identity,
        )

        history = await storage.threads.get_history(
            thread.thread_id, mock_user.identity
        )

        assert len(history) == 3
        # Most recent first
        assert history[0].values == {"step": 3}
        assert history[1].values == {"step": 2}
        assert history[2].values == {"step": 1}

    async def test_get_history_with_limit(self, storage, mock_user):
        """Should respect limit parameter."""
        thread = await storage.threads.create({}, mock_user.identity)

        for i in range(5):
            await storage.threads.add_state_snapshot(
                thread.thread_id,
                {"values": {"step": i}},
                mock_user.identity,
            )

        history = await storage.threads.get_history(
            thread.thread_id, mock_user.identity, limit=2
        )

        assert len(history) == 2
        # Most recent first
        assert history[0].values == {"step": 4}
        assert history[1].values == {"step": 3}

    async def test_get_history_owner_isolation(self, storage, mock_user, other_user):
        """Should not return history for threads owned by other users."""
        thread = await storage.threads.create({}, mock_user.identity)
        await storage.threads.add_state_snapshot(
            thread.thread_id,
            {"values": {"secret": "data"}},
            mock_user.identity,
        )

        history = await storage.threads.get_history(
            thread.thread_id, other_user.identity
        )
        assert history is None

    async def test_get_history_nonexistent_thread(self, storage, mock_user):
        """Should return None for nonexistent thread."""
        history = await storage.threads.get_history("nonexistent", mock_user.identity)
        assert history is None


# ============================================================================
# Thread Search Tests
# ============================================================================


class TestThreadSearch:
    """Tests for thread search and filtering."""

    async def test_filter_by_status(self, storage, mock_user):
        """Should filter threads by status."""
        await storage.threads.create({}, mock_user.identity)
        await storage.threads.create({}, mock_user.identity)

        # Update one to busy
        threads = await storage.threads.list(mock_user.identity)
        await storage.threads.update(
            threads[0].thread_id, {"status": "busy"}, mock_user.identity
        )

        # Filter by idle
        all_threads = await storage.threads.list(mock_user.identity)
        idle_threads = [t for t in all_threads if t.status == "idle"]
        assert len(idle_threads) == 1

        # Filter by busy
        busy_threads = [t for t in all_threads if t.status == "busy"]
        assert len(busy_threads) == 1

    async def test_filter_by_metadata(self, storage, mock_user):
        """Should filter threads by metadata."""
        await storage.threads.create(
            {"metadata": {"project": "alpha", "env": "dev"}}, mock_user.identity
        )
        await storage.threads.create(
            {"metadata": {"project": "beta", "env": "dev"}}, mock_user.identity
        )
        await storage.threads.create(
            {"metadata": {"project": "alpha", "env": "prod"}}, mock_user.identity
        )

        all_threads = await storage.threads.list(mock_user.identity)
        assert len(all_threads) == 3

        # Filter by project
        alpha_threads = [t for t in all_threads if t.metadata.get("project") == "alpha"]
        assert len(alpha_threads) == 2

        # Filter by multiple criteria
        alpha_dev = [
            t
            for t in all_threads
            if t.metadata.get("project") == "alpha" and t.metadata.get("env") == "dev"
        ]
        assert len(alpha_dev) == 1

    async def test_pagination(self, storage, mock_user):
        """Should paginate results correctly."""
        # Create 5 threads
        for i in range(5):
            await storage.threads.create({"metadata": {"index": i}}, mock_user.identity)

        all_threads = await storage.threads.list(mock_user.identity)
        assert len(all_threads) == 5

        # Paginate manually
        page1 = all_threads[0:2]
        page2 = all_threads[2:4]
        page3 = all_threads[4:6]

        assert len(page1) == 2
        assert len(page2) == 2
        assert len(page3) == 1


# ============================================================================
# Edge Cases Tests
# ============================================================================


class TestEdgeCases:
    """Tests for edge cases and error handling."""

    async def test_get_nonexistent_thread(self, storage, mock_user):
        """Should return None for nonexistent thread."""
        thread = await storage.threads.get("nonexistent-id", mock_user.identity)
        assert thread is None

    async def test_update_nonexistent_thread(self, storage, mock_user):
        """Should return None when updating nonexistent thread."""
        thread = await storage.threads.update(
            "nonexistent-id",
            {"metadata": {"key": "value"}},
            mock_user.identity,
        )
        assert thread is None

    async def test_delete_nonexistent_thread(self, storage, mock_user):
        """Should return False when deleting nonexistent thread."""
        deleted = await storage.threads.delete("nonexistent-id", mock_user.identity)
        assert deleted is False

    async def test_thread_id_is_generated(self, storage, mock_user):
        """Should generate unique thread IDs."""
        thread1 = await storage.threads.create({}, mock_user.identity)
        thread2 = await storage.threads.create({}, mock_user.identity)

        assert thread1.thread_id is not None
        assert thread2.thread_id is not None
        assert thread1.thread_id != thread2.thread_id

    async def test_timestamps_are_set(self, storage, mock_user):
        """Should set created_at and updated_at timestamps."""
        thread = await storage.threads.create({}, mock_user.identity)

        assert thread.created_at is not None
        assert thread.updated_at is not None
        assert thread.created_at == thread.updated_at

    async def test_update_changes_updated_at(self, storage, mock_user):
        """Should update updated_at on modification."""
        thread = await storage.threads.create({}, mock_user.identity)
        original_updated = thread.updated_at

        # Small delay to ensure timestamp difference
        time.sleep(0.01)

        updated = await storage.threads.update(
            thread.thread_id,
            {"metadata": {"modified": True}},
            mock_user.identity,
        )

        assert updated is not None
        assert updated.updated_at > original_updated
        assert updated.created_at == thread.created_at

    async def test_delete_cleans_up_history(self, storage, mock_user):
        """Should clean up history when thread is deleted."""
        thread = await storage.threads.create({}, mock_user.identity)

        # Add some history
        await storage.threads.add_state_snapshot(
            thread.thread_id,
            {"values": {"data": "test"}},
            mock_user.identity,
        )

        # Verify history exists
        history = await storage.threads.get_history(
            thread.thread_id, mock_user.identity
        )
        assert len(history) == 1

        # Delete thread
        await storage.threads.delete(thread.thread_id, mock_user.identity)

        # History should be gone (thread not found)
        history = await storage.threads.get_history(
            thread.thread_id, mock_user.identity
        )
        assert history is None


# ============================================================================
# Thread Model Serialization Tests
# ============================================================================


class TestThreadSerialization:
    """Tests for Thread model serialization."""

    async def test_thread_datetime_serialization(self, storage, mock_user):
        """Thread datetimes should serialize to ISO 8601 with Z suffix."""
        thread = await storage.threads.create({}, mock_user.identity)

        # Serialize to JSON
        json_data = thread.model_dump(mode="json")

        assert "created_at" in json_data
        assert "updated_at" in json_data
        assert json_data["created_at"].endswith("Z")
        assert json_data["updated_at"].endswith("Z")

    async def test_thread_state_serialization(self, storage, mock_user):
        """ThreadState should serialize properly."""
        thread = await storage.threads.create({}, mock_user.identity)
        state = await storage.threads.get_state(thread.thread_id, mock_user.identity)

        # Serialize to JSON
        json_data = state.model_dump(mode="json")

        assert "values" in json_data
        assert "next" in json_data
        assert "tasks" in json_data
        assert "checkpoint" in json_data
        assert "metadata" in json_data
        assert "created_at" in json_data

    async def test_json_response_with_thread(self, storage, mock_user):
        """json_response should serialize Thread model correctly."""
        thread = await storage.threads.create(
            {"metadata": {"test": "value"}}, mock_user.identity
        )

        response = json_response(thread)
        body = json.loads(response.description)

        assert body["thread_id"] == thread.thread_id
        assert body["metadata"]["test"] == "value"
        assert body["status"] == "idle"
        assert body["created_at"].endswith("Z")

    async def test_json_response_with_thread_list(self, storage, mock_user):
        """json_response should serialize list of Thread models."""
        await storage.threads.create({"metadata": {"name": "t1"}}, mock_user.identity)
        await storage.threads.create({"metadata": {"name": "t2"}}, mock_user.identity)

        threads = await storage.threads.list(mock_user.identity)
        response = json_response(threads)
        body = json.loads(response.description)

        assert len(body) == 2
        assert body[0]["status"] == "idle"
        assert body[1]["status"] == "idle"

    async def test_json_response_with_thread_state_list(self, storage, mock_user):
        """json_response should serialize list of ThreadState models."""
        thread = await storage.threads.create({}, mock_user.identity)

        await storage.threads.add_state_snapshot(
            thread.thread_id, {"values": {"step": 1}}, mock_user.identity
        )
        await storage.threads.add_state_snapshot(
            thread.thread_id, {"values": {"step": 2}}, mock_user.identity
        )

        history = await storage.threads.get_history(
            thread.thread_id, mock_user.identity
        )
        response = json_response(history)
        body = json.loads(response.description)

        assert len(body) == 2
        assert body[0]["values"] == {"step": 2}
        assert body[1]["values"] == {"step": 1}
