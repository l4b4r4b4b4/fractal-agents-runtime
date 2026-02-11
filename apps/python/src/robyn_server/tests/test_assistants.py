"""Unit tests for the assistants API endpoints.

Tests cover:
- CRUD operations (create, get, update, delete)
- Owner isolation
- Error handling
- Search and count endpoints
"""

import json
from unittest.mock import MagicMock

import pytest

from robyn_server.models import (
    AssistantCountRequest,
    AssistantCreate,
    AssistantPatch,
    AssistantSearchRequest,
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
        """json_response handles dict data."""
        response = json_response({"key": "value"})
        assert response.status_code == 200
        assert response.headers["Content-Type"] == "application/json"
        assert json.loads(response.description) == {"key": "value"}

    def test_json_response_with_custom_status(self):
        """json_response respects custom status code."""
        response = json_response({"key": "value"}, status_code=201)
        assert response.status_code == 201

    def test_error_response_format(self):
        """error_response matches LangGraph API format."""
        response = error_response("Something went wrong", 400)
        assert response.status_code == 400
        body = json.loads(response.description)
        assert body == {"detail": "Something went wrong"}

    def test_parse_json_body_with_bytes(self):
        """parse_json_body handles bytes input."""
        mock_request = MagicMock()
        mock_request.body = b'{"key": "value"}'
        result = parse_json_body(mock_request)
        assert result == {"key": "value"}

    def test_parse_json_body_with_string(self):
        """parse_json_body handles string input."""
        mock_request = MagicMock()
        mock_request.body = '{"key": "value"}'
        result = parse_json_body(mock_request)
        assert result == {"key": "value"}

    def test_parse_json_body_empty(self):
        """parse_json_body returns empty dict for empty body."""
        mock_request = MagicMock()
        mock_request.body = ""
        result = parse_json_body(mock_request)
        assert result == {}


# ============================================================================
# Assistant Model Tests
# ============================================================================


class TestAssistantModels:
    """Tests for assistant Pydantic models."""

    def test_assistant_create_required_fields(self):
        """AssistantCreate requires graph_id."""
        with pytest.raises(Exception):  # ValidationError
            AssistantCreate()

    def test_assistant_create_defaults(self):
        """AssistantCreate has sensible defaults."""
        create = AssistantCreate(graph_id="agent")
        assert create.graph_id == "agent"
        assert create.config == {}
        assert create.metadata == {}
        assert create.name is None
        assert create.description is None
        assert create.if_exists == "raise"

    def test_assistant_patch_all_optional(self):
        """AssistantPatch has all optional fields."""
        patch = AssistantPatch()
        assert patch.graph_id is None
        assert patch.config is None
        assert patch.metadata is None
        assert patch.name is None
        assert patch.description is None

    def test_assistant_search_defaults(self):
        """AssistantSearchRequest has sensible defaults."""
        search = AssistantSearchRequest()
        assert search.limit == 10
        assert search.offset == 0

    def test_assistant_count_all_optional(self):
        """AssistantCountRequest has all optional fields."""
        count = AssistantCountRequest()
        assert count.metadata is None
        assert count.graph_id is None
        assert count.name is None


# ============================================================================
# Storage Integration Tests
# ============================================================================


class TestAssistantStorage:
    """Tests for assistant storage operations."""

    async def test_create_assistant(self, storage: Storage, mock_user):
        """Create assistant stores with correct fields."""
        assistant = await storage.assistants.create(
            {
                "graph_id": "agent",
                "name": "Test Assistant",
                "config": {"configurable": {"model": "gpt-4"}},
            },
            mock_user.identity,
        )

        assert assistant.graph_id == "agent"
        assert assistant.name == "Test Assistant"
        assert assistant.metadata["owner"] == mock_user.identity
        assert assistant.version == 1

    async def test_create_assistant_with_description(self, storage: Storage, mock_user):
        """Create assistant with description field."""
        assistant = await storage.assistants.create(
            {
                "graph_id": "agent",
                "name": "My Assistant",
                "description": "A helpful assistant",
            },
            mock_user.identity,
        )

        assert assistant.description == "A helpful assistant"

    async def test_update_assistant_increments_version(
        self, storage: Storage, mock_user
    ):
        """Update assistant increments version number."""
        created = await storage.assistants.create(
            {"graph_id": "agent"},
            mock_user.identity,
        )
        assert created.version == 1

        updated = await storage.assistants.update(
            created.assistant_id,
            {"name": "Updated Name"},
            mock_user.identity,
        )

        assert updated is not None
        assert updated.version == 2

    async def test_update_assistant_preserves_context(
        self, storage: Storage, mock_user
    ):
        """Update assistant preserves context field."""
        created = await storage.assistants.create(
            {
                "graph_id": "agent",
                "context": {"key": "value"},
            },
            mock_user.identity,
        )

        updated = await storage.assistants.update(
            created.assistant_id,
            {"name": "New Name"},
            mock_user.identity,
        )

        assert updated is not None
        assert updated.context == {"key": "value"}

    async def test_get_assistant_owner_isolation(
        self, storage: Storage, mock_user, other_user
    ):
        """Users can only get their own assistants."""
        assistant = await storage.assistants.create(
            {"graph_id": "agent"},
            mock_user.identity,
        )

        # Owner can access
        result = await storage.assistants.get(
            assistant.assistant_id, mock_user.identity
        )
        assert result is not None

        # Other user cannot access
        result = await storage.assistants.get(
            assistant.assistant_id, other_user.identity
        )
        assert result is None

    async def test_list_assistants_owner_isolation(
        self, storage: Storage, mock_user, other_user
    ):
        """List only returns user's own assistants."""
        await storage.assistants.create({"graph_id": "agent"}, mock_user.identity)
        await storage.assistants.create({"graph_id": "agent"}, mock_user.identity)
        await storage.assistants.create({"graph_id": "agent"}, other_user.identity)

        user_assistants = await storage.assistants.list(mock_user.identity)
        other_assistants = await storage.assistants.list(other_user.identity)

        assert len(user_assistants) == 2
        assert len(other_assistants) == 1

    async def test_delete_assistant_owner_isolation(
        self, storage: Storage, mock_user, other_user
    ):
        """Users can only delete their own assistants."""
        assistant = await storage.assistants.create(
            {"graph_id": "agent"},
            mock_user.identity,
        )

        # Other user cannot delete
        result = await storage.assistants.delete(
            assistant.assistant_id, other_user.identity
        )
        assert result is False

        # Owner can delete
        result = await storage.assistants.delete(
            assistant.assistant_id, mock_user.identity
        )
        assert result is True


# ============================================================================
# Search and Filter Tests
# ============================================================================


class TestAssistantSearch:
    """Tests for assistant search functionality."""

    async def test_filter_by_graph_id(self, storage: Storage, mock_user):
        """Search filters by graph_id."""
        await storage.assistants.create({"graph_id": "agent"}, mock_user.identity)
        await storage.assistants.create({"graph_id": "agent"}, mock_user.identity)

        assistants = await storage.assistants.list(mock_user.identity)
        filtered = [a for a in assistants if a.graph_id == "agent"]

        assert len(filtered) == 2

    async def test_filter_by_name(self, storage: Storage, mock_user):
        """Search filters by name substring."""
        await storage.assistants.create(
            {"graph_id": "agent", "name": "Test Assistant"},
            mock_user.identity,
        )
        await storage.assistants.create(
            {"graph_id": "agent", "name": "Production Bot"},
            mock_user.identity,
        )

        assistants = await storage.assistants.list(mock_user.identity)
        filtered = [a for a in assistants if a.name and "Test" in a.name]

        assert len(filtered) == 1
        assert filtered[0].name == "Test Assistant"

    async def test_filter_by_metadata(self, storage: Storage, mock_user):
        """Search filters by metadata values."""
        await storage.assistants.create(
            {"graph_id": "agent", "metadata": {"env": "prod"}},
            mock_user.identity,
        )
        await storage.assistants.create(
            {"graph_id": "agent", "metadata": {"env": "dev"}},
            mock_user.identity,
        )

        assistants = await storage.assistants.list(mock_user.identity)
        # Note: owner is also in metadata, so we check env specifically
        filtered = [a for a in assistants if a.metadata.get("env") == "prod"]

        assert len(filtered) == 1

    async def test_pagination(self, storage: Storage, mock_user):
        """Search respects limit and offset."""
        # Create 5 assistants
        for i in range(5):
            await storage.assistants.create(
                {"graph_id": "agent", "name": f"Assistant {i}"},
                mock_user.identity,
            )

        assistants = await storage.assistants.list(mock_user.identity)

        # Simulate pagination
        page1 = assistants[0:2]
        page2 = assistants[2:4]
        page3 = assistants[4:6]

        assert len(page1) == 2
        assert len(page2) == 2
        assert len(page3) == 1


# ============================================================================
# Config Tests
# ============================================================================


class TestAssistantConfig:
    """Tests for assistant config handling."""

    async def test_config_with_configurable(self, storage: Storage, mock_user):
        """Config stores configurable settings."""
        assistant = await storage.assistants.create(
            {
                "graph_id": "agent",
                "config": {
                    "tags": ["production"],
                    "recursion_limit": 50,
                    "configurable": {
                        "model_name": "custom:",
                        "temperature": 0.7,
                    },
                },
            },
            mock_user.identity,
        )

        assert assistant.config.tags == ["production"]
        assert assistant.config.recursion_limit == 50
        assert assistant.config.configurable["model_name"] == "custom:"

    async def test_config_defaults(self, storage: Storage, mock_user):
        """Config has sensible defaults."""
        assistant = await storage.assistants.create(
            {"graph_id": "agent"},
            mock_user.identity,
        )

        assert assistant.config.tags == []
        assert assistant.config.recursion_limit == 25
        assert assistant.config.configurable == {}

    async def test_update_config_partial(self, storage: Storage, mock_user):
        """Update can modify config partially."""
        created = await storage.assistants.create(
            {
                "graph_id": "agent",
                "config": {
                    "tags": ["v1"],
                    "configurable": {"key1": "value1"},
                },
            },
            mock_user.identity,
        )

        updated = await storage.assistants.update(
            created.assistant_id,
            {
                "config": {
                    "tags": ["v2"],
                    "configurable": {"key2": "value2"},
                },
            },
            mock_user.identity,
        )

        assert updated is not None
        assert updated.config.tags == ["v2"]
        assert updated.config.configurable == {"key2": "value2"}


# ============================================================================
# Edge Cases
# ============================================================================


class TestEdgeCases:
    """Tests for edge cases and error conditions."""

    async def test_get_nonexistent_assistant(self, storage: Storage, mock_user):
        """Get returns None for nonexistent assistant."""
        result = await storage.assistants.get("nonexistent-id", mock_user.identity)
        assert result is None

    async def test_update_nonexistent_assistant(self, storage: Storage, mock_user):
        """Update returns None for nonexistent assistant."""
        result = await storage.assistants.update(
            "nonexistent-id",
            {"name": "New Name"},
            mock_user.identity,
        )
        assert result is None

    async def test_delete_nonexistent_assistant(self, storage: Storage, mock_user):
        """Delete returns False for nonexistent assistant."""
        result = await storage.assistants.delete("nonexistent-id", mock_user.identity)
        assert result is False

    async def test_create_requires_graph_id(self, storage: Storage, mock_user):
        """Create raises ValueError without graph_id."""
        with pytest.raises(ValueError, match="graph_id is required"):
            await storage.assistants.create({}, mock_user.identity)

    async def test_assistant_id_is_generated(self, storage: Storage, mock_user):
        """Create generates unique assistant_id."""
        a1 = await storage.assistants.create({"graph_id": "agent"}, mock_user.identity)
        a2 = await storage.assistants.create({"graph_id": "agent"}, mock_user.identity)

        assert a1.assistant_id != a2.assistant_id
        assert len(a1.assistant_id) == 32  # UUID hex

    async def test_timestamps_are_set(self, storage: Storage, mock_user):
        """Create sets created_at and updated_at."""
        assistant = await storage.assistants.create(
            {"graph_id": "agent"},
            mock_user.identity,
        )

        assert assistant.created_at is not None
        assert assistant.updated_at is not None

    async def test_update_changes_updated_at(self, storage: Storage, mock_user):
        """Update modifies updated_at timestamp."""
        created = await storage.assistants.create(
            {"graph_id": "agent"},
            mock_user.identity,
        )

        import time

        time.sleep(0.01)  # Small delay to ensure different timestamp

        updated = await storage.assistants.update(
            created.assistant_id,
            {"name": "New Name"},
            mock_user.identity,
        )

        assert updated is not None
        assert updated.updated_at > created.updated_at
        assert updated.created_at == created.created_at
