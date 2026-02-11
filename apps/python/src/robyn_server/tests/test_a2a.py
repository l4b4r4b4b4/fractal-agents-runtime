"""A2A Protocol tests.

Comprehensive tests for the A2A (Agent-to-Agent) Protocol implementation:
- Schema validation tests
- Handler unit tests
- Route integration tests
- Error handling tests
"""

import json
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from robyn_server.a2a import (
    A2AMessage,
    Artifact,
    DataPart,
    FilePart,
    JsonRpcError,
    JsonRpcErrorCode,
    JsonRpcRequest,
    JsonRpcResponse,
    MessageSendParams,
    StatusUpdateEvent,
    Task,
    TaskCancelParams,
    TaskGetParams,
    TaskState,
    TaskStatus,
    TextPart,
    create_error_response,
    create_success_response,
    create_task_id,
    extract_data_from_parts,
    extract_text_from_parts,
    has_file_parts,
    map_run_status_to_task_state,
    parse_task_id,
)
from robyn_server.a2a.handlers import A2AMethodHandler, a2a_handler


# ============================================================================
# Schema Tests - JSON-RPC 2.0
# ============================================================================


class TestJsonRpcSchemas:
    """Tests for JSON-RPC 2.0 base schemas."""

    def test_json_rpc_request_minimal(self):
        """Test creating a minimal JSON-RPC request."""
        request = JsonRpcRequest(method="test/method")
        assert request.jsonrpc == "2.0"
        assert request.method == "test/method"
        assert request.id is None
        assert request.params is None

    def test_json_rpc_request_full(self):
        """Test creating a full JSON-RPC request."""
        request = JsonRpcRequest(
            id="req-123",
            method="message/send",
            params={"message": {"role": "user"}},
        )
        assert request.id == "req-123"
        assert request.method == "message/send"
        assert request.params == {"message": {"role": "user"}}

    def test_json_rpc_request_numeric_id(self):
        """Test JSON-RPC request with numeric ID."""
        request = JsonRpcRequest(id=42, method="test")
        assert request.id == 42

    def test_json_rpc_error(self):
        """Test JSON-RPC error object."""
        error = JsonRpcError(
            code=-32600,
            message="Invalid request",
            data={"field": "method"},
        )
        assert error.code == -32600
        assert error.message == "Invalid request"
        assert error.data == {"field": "method"}

    def test_json_rpc_response_success(self):
        """Test JSON-RPC success response."""
        response = JsonRpcResponse(id="1", result={"status": "ok"})
        dump = response.model_dump()
        assert dump["jsonrpc"] == "2.0"
        assert dump["id"] == "1"
        assert dump["result"] == {"status": "ok"}
        assert "error" not in dump

    def test_json_rpc_response_error(self):
        """Test JSON-RPC error response."""
        response = JsonRpcResponse(
            id="1",
            error=JsonRpcError(code=-32600, message="Bad request"),
        )
        dump = response.model_dump()
        assert dump["jsonrpc"] == "2.0"
        assert dump["id"] == "1"
        assert dump["error"]["code"] == -32600
        assert dump["error"]["message"] == "Bad request"
        assert "result" not in dump


class TestErrorCodes:
    """Tests for JSON-RPC error codes."""

    def test_standard_error_codes(self):
        """Test standard JSON-RPC 2.0 error codes."""
        assert JsonRpcErrorCode.PARSE_ERROR == -32700
        assert JsonRpcErrorCode.INVALID_REQUEST == -32600
        assert JsonRpcErrorCode.METHOD_NOT_FOUND == -32601
        assert JsonRpcErrorCode.INVALID_PARAMS == -32602
        assert JsonRpcErrorCode.INTERNAL_ERROR == -32603

    def test_a2a_specific_error_codes(self):
        """Test A2A-specific error codes."""
        assert JsonRpcErrorCode.TASK_NOT_FOUND == -32001
        assert JsonRpcErrorCode.TASK_NOT_CANCELABLE == -32002
        assert JsonRpcErrorCode.UNSUPPORTED_OPERATION == -32003
        assert JsonRpcErrorCode.INVALID_PART_TYPE == -32004


# ============================================================================
# Schema Tests - A2A Message Parts
# ============================================================================


class TestMessageParts:
    """Tests for A2A message part schemas."""

    def test_text_part(self):
        """Test TextPart schema."""
        part = TextPart(text="Hello, agent!")
        assert part.kind == "text"
        assert part.text == "Hello, agent!"

    def test_data_part(self):
        """Test DataPart schema."""
        part = DataPart(data={"locale": "en-US", "timezone": "UTC"})
        assert part.kind == "data"
        assert part.data == {"locale": "en-US", "timezone": "UTC"}

    def test_file_part(self):
        """Test FilePart schema (for completeness)."""
        part = FilePart(file={"name": "test.txt", "content": "..."})
        assert part.kind == "file"


class TestA2AMessage:
    """Tests for A2A message schema."""

    def test_minimal_message(self):
        """Test creating a minimal A2A message."""
        message = A2AMessage(
            role="user",
            parts=[TextPart(text="Hello")],
            messageId="msg-123",
        )
        assert message.role == "user"
        assert len(message.parts) == 1
        assert message.message_id == "msg-123"
        assert message.context_id is None
        assert message.task_id is None

    def test_full_message(self):
        """Test creating a full A2A message."""
        message = A2AMessage(
            role="agent",
            parts=[
                TextPart(text="Response text"),
                DataPart(data={"confidence": 0.95}),
            ],
            messageId="msg-456",
            contextId="ctx-789",
            taskId="task-abc",
        )
        assert message.role == "agent"
        assert len(message.parts) == 2
        assert message.context_id == "ctx-789"
        assert message.task_id == "task-abc"

    def test_message_alias_serialization(self):
        """Test that message uses camelCase aliases."""
        message = A2AMessage(
            role="user",
            parts=[TextPart(text="test")],
            messageId="msg-1",
            contextId="ctx-1",
        )
        # Access via Python names
        assert message.message_id == "msg-1"
        assert message.context_id == "ctx-1"


# ============================================================================
# Schema Tests - A2A Task
# ============================================================================


class TestTaskStatus:
    """Tests for TaskStatus schema."""

    def test_task_status_states(self):
        """Test all task states."""
        assert TaskState.SUBMITTED == "submitted"
        assert TaskState.WORKING == "working"
        assert TaskState.INPUT_REQUIRED == "input-required"
        assert TaskState.COMPLETED == "completed"
        assert TaskState.FAILED == "failed"
        assert TaskState.CANCELED == "canceled"

    def test_task_status_minimal(self):
        """Test minimal TaskStatus."""
        status = TaskStatus(state=TaskState.WORKING)
        assert status.state == TaskState.WORKING
        assert status.message is None
        assert status.timestamp is None

    def test_task_status_full(self):
        """Test full TaskStatus."""
        status = TaskStatus(
            state=TaskState.COMPLETED,
            message="Task finished successfully",
            timestamp="2024-01-01T00:00:00Z",
        )
        assert status.state == TaskState.COMPLETED
        assert status.message == "Task finished successfully"


class TestTask:
    """Tests for Task schema."""

    def test_task_minimal(self):
        """Test creating a minimal task."""
        task = Task(
            id="thread-1:run-1",
            context_id="thread-1",
            status=TaskStatus(state=TaskState.WORKING),
        )
        assert task.kind == "task"
        assert task.id == "thread-1:run-1"
        assert task.context_id == "thread-1"
        assert len(task.artifacts) == 0
        assert len(task.history) == 0

    def test_task_with_artifacts(self):
        """Test task with artifacts."""
        artifact = Artifact(
            artifact_id="art-1",
            name="Response",
            parts=[TextPart(text="Hello!")],
        )
        task = Task(
            id="t:r",
            context_id="t",
            status=TaskStatus(state=TaskState.COMPLETED),
            artifacts=[artifact],
        )
        assert len(task.artifacts) == 1
        assert task.artifacts[0].artifact_id == "art-1"

    def test_task_serialization_uses_aliases(self):
        """Test task serialization uses camelCase."""
        task = Task(
            id="t:r",
            context_id="thread-id",
            status=TaskStatus(state=TaskState.WORKING),
        )
        dump = task.model_dump(by_alias=True)
        assert "contextId" in dump
        assert dump["contextId"] == "thread-id"


class TestArtifact:
    """Tests for Artifact schema."""

    def test_artifact_minimal(self):
        """Test minimal artifact."""
        artifact = Artifact(artifact_id="a-1")
        assert artifact.artifact_id == "a-1"
        assert artifact.name == "Assistant Response"
        assert len(artifact.parts) == 0

    def test_artifact_with_parts(self):
        """Test artifact with multiple parts."""
        artifact = Artifact(
            artifact_id="a-2",
            name="Analysis Result",
            parts=[
                TextPart(text="Summary: ..."),
                DataPart(data={"score": 0.8}),
            ],
        )
        assert len(artifact.parts) == 2


# ============================================================================
# Schema Tests - Method Parameters
# ============================================================================


class TestMethodParameters:
    """Tests for A2A method parameter schemas."""

    def test_message_send_params(self):
        """Test MessageSendParams validation."""
        params = MessageSendParams(
            message=A2AMessage(
                role="user",
                parts=[TextPart(text="Hello")],
                messageId="m-1",
            )
        )
        assert params.message.role == "user"

    def test_task_get_params(self):
        """Test TaskGetParams validation."""
        params = TaskGetParams(
            id="thread:run",
            contextId="thread",
            historyLength=5,
        )
        assert params.id == "thread:run"
        assert params.context_id == "thread"
        assert params.history_length == 5

    def test_task_get_params_defaults(self):
        """Test TaskGetParams default values."""
        params = TaskGetParams(id="t:r", contextId="t")
        assert params.history_length == 0

    def test_task_get_params_history_bounds(self):
        """Test TaskGetParams history_length bounds."""
        # Should accept 0-10
        params = TaskGetParams(id="t:r", contextId="t", historyLength=10)
        assert params.history_length == 10

        # Should reject values outside 0-10
        with pytest.raises(Exception):
            TaskGetParams(id="t:r", contextId="t", historyLength=11)

    def test_task_cancel_params(self):
        """Test TaskCancelParams validation."""
        params = TaskCancelParams(id="t:r", contextId="t")
        assert params.id == "t:r"
        assert params.context_id == "t"


# ============================================================================
# Helper Function Tests
# ============================================================================


class TestHelperFunctions:
    """Tests for A2A helper functions."""

    def test_create_error_response(self):
        """Test create_error_response helper."""
        response = create_error_response(
            "req-1",
            JsonRpcErrorCode.INVALID_PARAMS,
            "Missing field",
            {"field": "message"},
        )
        assert response.id == "req-1"
        assert response.error is not None
        assert response.error.code == JsonRpcErrorCode.INVALID_PARAMS
        assert response.error.message == "Missing field"
        assert response.error.data == {"field": "message"}

    def test_create_success_response(self):
        """Test create_success_response helper."""
        response = create_success_response("req-2", {"status": "ok"})
        assert response.id == "req-2"
        assert response.result == {"status": "ok"}
        assert response.error is None

    def test_parse_task_id_valid(self):
        """Test parse_task_id with valid ID."""
        thread_id, run_id = parse_task_id("thread-123:run-456")
        assert thread_id == "thread-123"
        assert run_id == "run-456"

    def test_parse_task_id_with_colons_in_ids(self):
        """Test parse_task_id with colons in the IDs."""
        # UUID format has no colons, but test edge case
        thread_id, run_id = parse_task_id("abc:def:ghi")
        assert thread_id == "abc"
        assert run_id == "def:ghi"  # Everything after first colon

    def test_parse_task_id_invalid(self):
        """Test parse_task_id with invalid ID."""
        with pytest.raises(ValueError) as exc_info:
            parse_task_id("invalid-task-id")
        assert "Invalid task ID format" in str(exc_info.value)

    def test_create_task_id(self):
        """Test create_task_id helper."""
        task_id = create_task_id("thread-abc", "run-xyz")
        assert task_id == "thread-abc:run-xyz"

    def test_task_id_roundtrip(self):
        """Test task ID creation and parsing roundtrip."""
        original_thread = "t-123"
        original_run = "r-456"
        task_id = create_task_id(original_thread, original_run)
        thread_id, run_id = parse_task_id(task_id)
        assert thread_id == original_thread
        assert run_id == original_run

    def test_map_run_status_to_task_state(self):
        """Test mapping LangGraph run status to A2A task state."""
        assert map_run_status_to_task_state("pending") == TaskState.SUBMITTED
        assert map_run_status_to_task_state("running") == TaskState.WORKING
        assert map_run_status_to_task_state("success") == TaskState.COMPLETED
        assert map_run_status_to_task_state("error") == TaskState.FAILED
        assert map_run_status_to_task_state("timeout") == TaskState.FAILED
        assert map_run_status_to_task_state("interrupted") == TaskState.INPUT_REQUIRED

    def test_map_run_status_unknown(self):
        """Test mapping unknown run status defaults to FAILED."""
        assert map_run_status_to_task_state("unknown") == TaskState.FAILED

    def test_extract_text_from_parts(self):
        """Test extracting text from message parts."""
        parts = [
            TextPart(text="Line 1"),
            DataPart(data={"key": "value"}),
            TextPart(text="Line 2"),
        ]
        text = extract_text_from_parts(parts)
        assert text == "Line 1\nLine 2"

    def test_extract_text_from_dict_parts(self):
        """Test extracting text from dict-style parts."""
        parts = [
            {"kind": "text", "text": "Hello"},
            {"kind": "data", "data": {}},
            {"kind": "text", "text": "World"},
        ]
        text = extract_text_from_parts(parts)
        assert text == "Hello\nWorld"

    def test_extract_text_empty(self):
        """Test extracting text from empty parts."""
        assert extract_text_from_parts([]) == ""

    def test_extract_data_from_parts(self):
        """Test extracting and merging data from parts."""
        parts = [
            TextPart(text="ignore"),
            DataPart(data={"a": 1, "b": 2}),
            DataPart(data={"b": 3, "c": 4}),  # b should be overwritten
        ]
        data = extract_data_from_parts(parts)
        assert data == {"a": 1, "b": 3, "c": 4}

    def test_extract_data_from_dict_parts(self):
        """Test extracting data from dict-style parts."""
        parts = [
            {"kind": "text", "text": "ignore"},
            {"kind": "data", "data": {"x": 1}},
        ]
        data = extract_data_from_parts(parts)
        assert data == {"x": 1}

    def test_has_file_parts_true(self):
        """Test detecting file parts - true case."""
        parts = [TextPart(text="ok"), FilePart(file={"name": "test"})]
        assert has_file_parts(parts) is True

    def test_has_file_parts_false(self):
        """Test detecting file parts - false case."""
        parts = [TextPart(text="ok"), DataPart(data={"key": "val"})]
        assert has_file_parts(parts) is False

    def test_has_file_parts_dict_style(self):
        """Test detecting file parts in dict-style."""
        parts = [{"kind": "file", "file": {}}]
        assert has_file_parts(parts) is True


# ============================================================================
# Handler Tests
# ============================================================================


class TestA2AHandler:
    """Tests for A2AMethodHandler."""

    @pytest.fixture
    def handler(self):
        """Create a fresh handler for each test."""
        return A2AMethodHandler()

    @pytest.mark.asyncio
    async def test_handle_unknown_method(self, handler):
        """Test handling unknown method returns METHOD_NOT_FOUND."""
        request = JsonRpcRequest(id="1", method="unknown/method")
        response = await handler.handle_request(
            request, assistant_id="agent", owner_id="user-1"
        )
        assert response.error is not None
        assert response.error.code == JsonRpcErrorCode.METHOD_NOT_FOUND
        assert "Method not found" in response.error.message

    @pytest.mark.asyncio
    async def test_handle_message_stream_returns_error(self, handler):
        """Test that message/stream method returns error (handled at route level)."""
        request = JsonRpcRequest(id="1", method="message/stream")
        response = await handler.handle_request(
            request, assistant_id="agent", owner_id="user-1"
        )
        assert response.error is not None
        assert response.error.code == JsonRpcErrorCode.INTERNAL_ERROR

    @pytest.mark.asyncio
    async def test_handle_message_send_invalid_params(self, handler):
        """Test message/send with invalid params."""
        request = JsonRpcRequest(
            id="1",
            method="message/send",
            params={"invalid": "params"},
        )
        with patch("robyn_server.a2a.handlers.get_storage"):
            response = await handler.handle_request(
                request, assistant_id="agent", owner_id="user-1"
            )
        assert response.error is not None
        assert response.error.code == JsonRpcErrorCode.INVALID_PARAMS

    @pytest.mark.asyncio
    async def test_handle_message_send_with_file_parts(self, handler):
        """Test message/send rejects file parts."""
        request = JsonRpcRequest(
            id="1",
            method="message/send",
            params={
                "message": {
                    "role": "user",
                    "parts": [{"kind": "file", "file": {}}],
                    "messageId": "m-1",
                }
            },
        )
        with patch("robyn_server.a2a.handlers.get_storage"):
            response = await handler.handle_request(
                request, assistant_id="agent", owner_id="user-1"
            )
        assert response.error is not None
        assert "File parts" in response.error.message

    @pytest.mark.asyncio
    async def test_handle_tasks_get_invalid_task_id(self, handler):
        """Test tasks/get with invalid task ID format."""
        request = JsonRpcRequest(
            id="1",
            method="tasks/get",
            params={
                "id": "invalid-no-colon",
                "contextId": "ctx",
            },
        )
        response = await handler.handle_request(
            request, assistant_id="agent", owner_id="user-1"
        )
        assert response.error is not None
        assert "Invalid task ID format" in response.error.message

    @pytest.mark.asyncio
    async def test_handle_tasks_get_context_mismatch(self, handler):
        """Test tasks/get with mismatched contextId."""
        request = JsonRpcRequest(
            id="1",
            method="tasks/get",
            params={
                "id": "thread-a:run-1",
                "contextId": "thread-b",  # Mismatch!
            },
        )
        response = await handler.handle_request(
            request, assistant_id="agent", owner_id="user-1"
        )
        assert response.error is not None
        assert "contextId mismatch" in response.error.message

    @pytest.mark.asyncio
    async def test_handle_tasks_cancel_not_supported(self, handler):
        """Test tasks/cancel returns not supported error."""
        request = JsonRpcRequest(
            id="1",
            method="tasks/cancel",
            params={
                "id": "thread:run",
                "contextId": "thread",
            },
        )
        response = await handler.handle_request(
            request, assistant_id="agent", owner_id="user-1"
        )
        assert response.error is not None
        assert "not supported" in response.error.message.lower()


class TestA2AHandlerWithMockedStorage:
    """Tests for A2AMethodHandler with mocked storage."""

    @pytest.fixture
    def mock_storage(self):
        """Create mock storage."""
        storage = MagicMock()

        # Mock thread operations (async methods)
        mock_thread = MagicMock()
        mock_thread.thread_id = "thread-123"
        storage.threads.get = AsyncMock(return_value=mock_thread)
        storage.threads.create = AsyncMock(return_value=mock_thread)
        storage.threads.update = AsyncMock(return_value=mock_thread)
        storage.threads.add_state_snapshot = AsyncMock(return_value=True)

        # Mock assistant operations (async methods)
        mock_assistant = MagicMock()
        mock_assistant.assistant_id = "assistant-456"
        mock_assistant.graph_id = "agent"
        storage.assistants.get = AsyncMock(return_value=mock_assistant)
        storage.assistants.list = AsyncMock(return_value=[mock_assistant])

        # Mock run operations (async methods)
        mock_run = MagicMock()
        mock_run.run_id = "run-789"
        mock_run.status = "success"
        mock_run.updated_at = datetime.now(timezone.utc)
        storage.runs.create = AsyncMock(return_value=mock_run)
        storage.runs.get_by_thread = AsyncMock(return_value=mock_run)
        storage.runs.update_status = AsyncMock(return_value=mock_run)

        # Mock thread state (async methods)
        mock_state = MagicMock()
        mock_state.values = {"messages": [{"type": "ai", "content": "Hello!"}]}
        storage.threads.get_state = AsyncMock(return_value=mock_state)
        storage.threads.get_state_history = AsyncMock(return_value=[])

        return storage

    @pytest.fixture
    def handler(self):
        return A2AMethodHandler()

    @pytest.mark.asyncio
    async def test_handle_message_send_success(self, handler, mock_storage):
        """Test successful message/send."""
        request = JsonRpcRequest(
            id="1",
            method="message/send",
            params={
                "message": {
                    "role": "user",
                    "parts": [{"kind": "text", "text": "Hello!"}],
                    "messageId": "msg-1",
                    "contextId": "thread-123",
                }
            },
        )

        with patch("robyn_server.a2a.handlers.get_storage", return_value=mock_storage):
            # Also mock the agent execution
            handler._execute_agent = AsyncMock(return_value="Agent response")

            response = await handler.handle_request(
                request, assistant_id="agent", owner_id="user-1"
            )

        assert response.error is None
        assert response.result is not None
        assert response.result["kind"] == "task"
        assert response.result["status"]["state"] == "completed"
        assert len(response.result["artifacts"]) == 1

    @pytest.mark.asyncio
    async def test_handle_message_send_creates_thread(self, handler, mock_storage):
        """Test message/send creates thread if contextId not provided."""
        mock_storage.threads.get = AsyncMock(return_value=None)  # Thread doesn't exist

        request = JsonRpcRequest(
            id="1",
            method="message/send",
            params={
                "message": {
                    "role": "user",
                    "parts": [{"kind": "text", "text": "Hello!"}],
                    "messageId": "msg-1",
                    # No contextId - should create new thread
                }
            },
        )

        with patch("robyn_server.a2a.handlers.get_storage", return_value=mock_storage):
            handler._execute_agent = AsyncMock(return_value="Response")

            response = await handler.handle_request(
                request, assistant_id="agent", owner_id="user-1"
            )

        # Should have called create
        mock_storage.threads.create.assert_called()
        assert response.error is None

    @pytest.mark.asyncio
    async def test_handle_tasks_get_success(self, handler, mock_storage):
        """Test successful tasks/get."""
        request = JsonRpcRequest(
            id="1",
            method="tasks/get",
            params={
                "id": "thread-123:run-789",
                "contextId": "thread-123",
                "historyLength": 0,
            },
        )

        with patch("robyn_server.a2a.handlers.get_storage", return_value=mock_storage):
            response = await handler.handle_request(
                request, assistant_id="agent", owner_id="user-1"
            )

        assert response.error is None
        assert response.result is not None
        assert response.result["kind"] == "task"
        assert response.result["id"] == "thread-123:run-789"

    @pytest.mark.asyncio
    async def test_handle_tasks_get_not_found(self, handler, mock_storage):
        """Test tasks/get when run not found."""
        mock_storage.runs.get_by_thread = AsyncMock(return_value=None)

        request = JsonRpcRequest(
            id="1",
            method="tasks/get",
            params={
                "id": "thread-123:run-notfound",
                "contextId": "thread-123",
            },
        )

        with patch("robyn_server.a2a.handlers.get_storage", return_value=mock_storage):
            response = await handler.handle_request(
                request, assistant_id="agent", owner_id="user-1"
            )

        # Result contains error structure (TASK_NOT_FOUND)
        assert response.result is not None
        assert "error" in response.result


# ============================================================================
# Streaming Handler Tests
# ============================================================================


class TestA2AStreamingHandler:
    """Tests for A2A streaming (message/stream) handler."""

    @pytest.fixture
    def handler(self):
        return A2AMethodHandler()

    @pytest.fixture
    def mock_storage(self):
        storage = MagicMock()

        mock_thread = MagicMock()
        mock_thread.thread_id = "thread-123"
        storage.threads.get = AsyncMock(return_value=mock_thread)
        storage.threads.create = AsyncMock(return_value=mock_thread)

        mock_assistant = MagicMock()
        mock_assistant.assistant_id = "assistant-456"
        storage.assistants.get = AsyncMock(return_value=mock_assistant)
        storage.assistants.list = AsyncMock(return_value=[mock_assistant])

        return storage

    @pytest.mark.asyncio
    async def test_handle_message_stream_invalid_params(self, handler):
        """Test message/stream with invalid params."""
        events = []

        with patch("robyn_server.a2a.handlers.get_storage"):
            async for event in handler.handle_message_stream(
                params={"invalid": "params"},
                assistant_id="agent",
                owner_id="user-1",
                request_id="1",
            ):
                events.append(event)

        assert len(events) == 1
        assert "error" in events[0]
        assert "Invalid message/stream params" in events[0]

    @pytest.mark.asyncio
    async def test_handle_message_stream_file_parts(self, handler):
        """Test message/stream rejects file parts."""
        events = []

        with patch("robyn_server.a2a.handlers.get_storage"):
            async for event in handler.handle_message_stream(
                params={
                    "message": {
                        "role": "user",
                        "parts": [{"kind": "file", "file": {}}],
                        "messageId": "m-1",
                    }
                },
                assistant_id="agent",
                owner_id="user-1",
                request_id="1",
            ):
                events.append(event)

        assert len(events) == 1
        assert "File parts are not supported" in events[0]

    @pytest.mark.asyncio
    async def test_handle_message_stream_success(self, handler, mock_storage):
        """Test successful message/stream."""
        events = []

        with patch("robyn_server.a2a.handlers.get_storage", return_value=mock_storage):
            handler._execute_agent = AsyncMock(return_value="Streamed response")

            async for event in handler.handle_message_stream(
                params={
                    "message": {
                        "role": "user",
                        "parts": [{"kind": "text", "text": "Hello"}],
                        "messageId": "m-1",
                        "contextId": "thread-123",
                    }
                },
                assistant_id="agent",
                owner_id="user-1",
                request_id="1",
            ):
                events.append(event)

        # Should have at least 2 events: status update and final result
        assert len(events) >= 2

        # First event should be status update (working)
        first_event = json.loads(events[0].replace("data: ", "").strip())
        assert first_event["result"]["kind"] == "status-update"
        assert first_event["result"]["status"]["state"] == "working"

        # Last event should be final task
        last_event = json.loads(events[-1].replace("data: ", "").strip())
        assert last_event["result"]["kind"] == "task"
        assert last_event["result"]["status"]["state"] == "completed"


# ============================================================================
# SSE Event Schema Tests
# ============================================================================


class TestSSEEventSchemas:
    """Tests for SSE streaming event schemas."""

    def test_status_update_event(self):
        """Test StatusUpdateEvent schema."""
        event = StatusUpdateEvent(
            task_id="t:r",
            context_id="t",
            status=TaskStatus(state=TaskState.WORKING),
            final=False,
        )
        assert event.kind == "status-update"
        dump = event.model_dump(by_alias=True)
        assert dump["taskId"] == "t:r"
        assert dump["contextId"] == "t"
        assert dump["final"] is False

    def test_artifact_update_event(self):
        """Test ArtifactUpdateEvent schema."""
        from robyn_server.a2a.schemas import ArtifactUpdateEvent

        event = ArtifactUpdateEvent(
            task_id="t:r",
            context_id="t",
            artifact=Artifact(artifact_id="a-1"),
            final=True,
        )
        assert event.kind == "artifact-update"
        dump = event.model_dump(by_alias=True)
        assert dump["final"] is True


# ============================================================================
# Global Handler Instance Tests
# ============================================================================


class TestGlobalHandler:
    """Tests for the global a2a_handler instance."""

    def test_global_handler_exists(self):
        """Test that global handler is instantiated."""
        assert a2a_handler is not None
        assert isinstance(a2a_handler, A2AMethodHandler)


# ============================================================================
# Route Integration Tests (with mocked app)
# ============================================================================


class TestA2ARouteIntegration:
    """Integration tests for A2A routes."""

    def test_route_module_imports(self):
        """Test that A2A route module can be imported."""
        # This verifies the module structure is correct
        from robyn_server.routes.a2a import register_a2a_routes

        # Verify the function exists and is callable
        assert callable(register_a2a_routes)

    def test_a2a_handler_in_routes(self):
        """Test that A2A handler is available in routes module."""
        from robyn_server.a2a import a2a_handler

        # Verify handler exists and has expected methods
        assert hasattr(a2a_handler, "handle_request")
        assert hasattr(a2a_handler, "handle_message_stream")


# ============================================================================
# Edge Case Tests
# ============================================================================


class TestEdgeCases:
    """Tests for edge cases and boundary conditions."""

    def test_empty_parts_array(self):
        """Test message with empty parts array."""
        message = A2AMessage(
            role="user",
            parts=[],
            messageId="m-1",
        )
        assert len(message.parts) == 0
        assert extract_text_from_parts(message.parts) == ""

    def test_very_long_text_part(self):
        """Test handling very long text content."""
        long_text = "x" * 100000
        part = TextPart(text=long_text)
        assert len(part.text) == 100000

    def test_nested_data_part(self):
        """Test deeply nested data in DataPart."""
        nested = {"a": {"b": {"c": {"d": {"e": "deep"}}}}}
        part = DataPart(data=nested)
        assert part.data["a"]["b"]["c"]["d"]["e"] == "deep"

    def test_unicode_in_text_part(self):
        """Test Unicode content in TextPart."""
        part = TextPart(text="Hello 🌍 世界 مرحبا")
        assert "🌍" in part.text
        assert "世界" in part.text

    def test_special_characters_in_task_id(self):
        """Test task ID with special characters."""
        # UUIDs are safe, but test the format
        task_id = create_task_id(
            "550e8400-e29b-41d4-a716-446655440000",
            "550e8400-e29b-41d4-a716-446655440001",
        )
        thread_id, run_id = parse_task_id(task_id)
        assert thread_id == "550e8400-e29b-41d4-a716-446655440000"
        assert run_id == "550e8400-e29b-41d4-a716-446655440001"

    def test_null_id_in_request(self):
        """Test JSON-RPC request with null ID (notification)."""
        request = JsonRpcRequest(id=None, method="message/send")
        assert request.id is None

    def test_response_dump_excludes_none(self):
        """Test response model_dump excludes None values appropriately."""
        success = JsonRpcResponse(id="1", result={"ok": True})
        dump = success.model_dump()
        assert "error" not in dump

        error = JsonRpcResponse(id="1", error=JsonRpcError(code=-1, message="err"))
        dump = error.model_dump()
        assert "result" not in dump
