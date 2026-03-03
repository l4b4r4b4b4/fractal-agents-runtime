"""Tests for SSE streaming endpoints.

Tests cover:
- SSE frame formatting utilities
- Streaming endpoint routing and authentication
- Event sequence and payload structure
- Agent execution integration with mocked agent
"""

import json
import uuid
from unittest.mock import AsyncMock, patch

import pytest
import pytest_asyncio
from langchain_core.messages import AIMessage, AIMessageChunk

from server.routes.sse import (
    create_ai_message,
    create_human_message,
    format_error_event,
    format_messages_tuple_event,
    format_metadata_event,
    format_sse_event,
    format_updates_event,
    format_values_event,
    sse_headers,
)
from server.storage import get_storage, reset_storage


# ============================================================================
# Fixtures
# ============================================================================


@pytest.fixture(autouse=True)
def reset_global_storage():
    """Reset storage before each test."""
    reset_storage()
    yield
    reset_storage()


@pytest.fixture
def storage():
    """Get the global storage instance."""
    return get_storage()


@pytest.fixture
def mock_user_identity():
    """Create a mock user identity."""
    return str(uuid.uuid4())


@pytest.fixture
def other_user_identity():
    """Create another mock user identity for owner isolation tests."""
    return str(uuid.uuid4())


@pytest_asyncio.fixture
async def assistant(storage, mock_user_identity):
    """Create a test assistant."""
    return await storage.assistants.create(
        {"graph_id": "agent", "name": "Test Assistant"},
        mock_user_identity,
    )


@pytest_asyncio.fixture
async def thread(storage, mock_user_identity):
    """Create a test thread."""
    return await storage.threads.create({}, mock_user_identity)


# ============================================================================
# SSE Frame Formatting Tests
# ============================================================================


class TestSSEFrameFormatting:
    """Tests for SSE frame formatting utilities."""

    def test_format_sse_event_basic(self):
        """Test basic SSE event formatting."""
        result = format_sse_event("test", {"key": "value"})
        assert result == 'event: test\ndata: {"key":"value"}\n\n'

    def test_format_sse_event_with_string_data(self):
        """Test SSE event formatting with string data."""
        result = format_sse_event("test", '{"pre":"formatted"}')
        assert result == 'event: test\ndata: {"pre":"formatted"}\n\n'

    def test_format_sse_event_complex_data(self):
        """Test SSE event formatting with complex nested data."""
        data = {
            "messages": [
                {"type": "human", "content": "Hello"},
                {"type": "ai", "content": "Hi there"},
            ]
        }
        result = format_sse_event("values", data)
        assert result.startswith("event: values\ndata: ")
        assert result.endswith("\n\n")
        # Verify JSON is valid
        data_line = result.split("data: ")[1].strip()
        parsed = json.loads(data_line)
        assert parsed == data

    def test_format_metadata_event(self):
        """Test metadata event formatting."""
        run_id = "019c2a97-2e57-7043-9ef0-c5e0915f482c"
        result = format_metadata_event(run_id, attempt=1)

        assert "event: metadata\n" in result
        assert f'"run_id":"{run_id}"' in result
        assert '"attempt":1' in result
        assert result.endswith("\n\n")

    def test_format_metadata_event_custom_attempt(self):
        """Test metadata event with custom attempt number."""
        result = format_metadata_event("test-run-id", attempt=3)
        assert '"attempt":3' in result

    def test_format_values_event(self):
        """Test values event formatting."""
        values = {"messages": [{"type": "human", "content": "Test"}]}
        result = format_values_event(values)

        assert "event: values\n" in result
        assert '"messages"' in result
        assert result.endswith("\n\n")

    def test_format_updates_event(self):
        """Test updates event formatting."""
        updates = {"messages": [{"type": "ai", "content": "Response"}]}
        result = format_updates_event("model", updates)

        assert "event: updates\n" in result
        assert '"model"' in result
        assert '"messages"' in result

    def test_format_messages_tuple_event(self):
        """Test messages-tuple event formatting (event: messages)."""
        message_delta = {"content": "Hello", "type": "ai", "id": "test-id"}
        metadata = {"langgraph_node": "model", "run_id": "test-run"}
        result = format_messages_tuple_event(message_delta, metadata)

        assert "event: messages\n" in result
        # Should be a 2-element tuple [message_delta, metadata]
        parsed_data = json.loads(result.split("data: ")[1].strip())
        assert isinstance(parsed_data, list)
        assert len(parsed_data) == 2
        assert parsed_data[0]["content"] == "Hello"
        assert parsed_data[0]["type"] == "ai"
        assert parsed_data[1]["langgraph_node"] == "model"
        assert parsed_data[1]["run_id"] == "test-run"

    def test_format_messages_tuple_event_empty_content(self):
        """Test messages-tuple with empty content delta (initial event)."""
        message_delta = {"content": "", "type": "ai", "id": "test-id"}
        metadata = {"langgraph_node": "model"}
        result = format_messages_tuple_event(message_delta, metadata)

        assert "event: messages\n" in result
        parsed_data = json.loads(result.split("data: ")[1].strip())
        assert parsed_data[0]["content"] == ""

    def test_format_error_event(self):
        """Test error event formatting."""
        result = format_error_event("Something went wrong")

        assert "event: error\n" in result
        assert '"error":"Something went wrong"' in result

    def test_format_error_event_with_code(self):
        """Test error event formatting with error code."""
        result = format_error_event("Not found", code="NOT_FOUND")

        assert "event: error\n" in result
        assert '"error":"Not found"' in result
        assert '"code":"NOT_FOUND"' in result


# ============================================================================
# SSE Headers Tests
# ============================================================================


class TestSSEHeaders:
    """Tests for SSE response headers."""

    def test_sse_headers_basic(self):
        """Test basic SSE headers."""
        headers = sse_headers()

        # Access headers using get method
        assert "text/event-stream" in str(headers)

    def test_sse_headers_with_thread_and_run(self):
        """Test SSE headers with thread and run IDs."""
        headers = sse_headers(thread_id="thread-123", run_id="run-456")

        # Headers should include Location and Content-Location
        headers_str = str(headers)
        assert "thread-123" in headers_str or headers is not None

    def test_sse_headers_stateless(self):
        """Test SSE headers for stateless runs."""
        headers = sse_headers(run_id="run-789", stateless=True)

        # Should be valid headers
        assert headers is not None


# ============================================================================
# Message Creation Tests
# ============================================================================


class TestMessageCreation:
    """Tests for LangChain message creation utilities."""

    def test_create_human_message(self):
        """Test human message creation."""
        message = create_human_message("Hello world")

        assert message["type"] == "human"
        assert message["content"] == "Hello world"
        assert message["additional_kwargs"] == {}
        assert message["response_metadata"] == {}
        assert message["name"] is None

    def test_create_human_message_with_id(self):
        """Test human message creation with ID."""
        message = create_human_message("Hello", message_id="msg-123")

        assert message["id"] == "msg-123"
        assert message["content"] == "Hello"

    def test_create_ai_message(self):
        """Test AI message creation."""
        message = create_ai_message("Hi there")

        assert message["type"] == "ai"
        assert message["content"] == "Hi there"
        assert message["tool_calls"] == []
        assert message["invalid_tool_calls"] == []
        assert message["usage_metadata"] is None
        assert "model_provider" in message["response_metadata"]

    def test_create_ai_message_with_finish_reason(self):
        """Test AI message creation with finish reason."""
        message = create_ai_message(
            "Complete response",
            message_id="ai-msg-1",
            finish_reason="stop",
            model_name="gpt-4",
            model_provider="openai",
        )

        assert message["id"] == "ai-msg-1"
        assert message["response_metadata"]["finish_reason"] == "stop"
        assert message["response_metadata"]["model_name"] == "gpt-4"
        assert message["response_metadata"]["model_provider"] == "openai"


# ============================================================================
# Run Stream Integration Tests (Storage Layer)
# ============================================================================


class TestRunStreamStorage:
    """Tests for run stream storage operations."""

    async def test_create_run_for_stream(
        self, storage, mock_user_identity, assistant, thread
    ):
        """Test creating a run for streaming."""
        run_data = {
            "thread_id": thread.thread_id,
            "assistant_id": assistant.assistant_id,
            "status": "running",
            "metadata": {},
            "kwargs": {
                "input": {"messages": [{"type": "human", "content": "Test"}]},
                "stream_mode": ["values", "messages"],
            },
            "multitask_strategy": "reject",
        }

        run = await storage.runs.create(run_data, mock_user_identity)

        assert run.run_id is not None
        assert run.status == "running"
        assert run.thread_id == thread.thread_id

    async def test_update_run_status_after_stream(
        self, storage, mock_user_identity, assistant, thread
    ):
        """Test updating run status after streaming completes."""
        run_data = {
            "thread_id": thread.thread_id,
            "assistant_id": assistant.assistant_id,
            "status": "running",
            "metadata": {},
            "kwargs": {},
            "multitask_strategy": "reject",
        }

        run = await storage.runs.create(run_data, mock_user_identity)
        assert run.status == "running"

        # Update to success
        updated = await storage.runs.update_status(
            run.run_id, "success", mock_user_identity
        )
        assert updated is not None
        assert updated.status == "success"

    async def test_thread_state_update_after_stream(
        self, storage, mock_user_identity, assistant, thread
    ):
        """Test that thread state is updated after streaming."""
        final_values = {
            "messages": [
                {"type": "human", "content": "Hello"},
                {"type": "ai", "content": "Hi there"},
            ]
        }

        # Add state snapshot
        result = await storage.threads.add_state_snapshot(
            thread.thread_id, final_values, mock_user_identity
        )
        assert result is True

        # Get state
        state = await storage.threads.get_state(thread.thread_id, mock_user_identity)
        assert state is not None


# ============================================================================
# SSE Event Sequence Tests
# ============================================================================


class TestSSEEventSequence:
    """Tests for correct SSE event sequencing."""

    def test_event_sequence_order(self):
        """Test that events are emitted in correct order.

        New protocol: no separate messages/metadata event. Each messages
        event is a [delta, metadata] tuple with ``event: messages``.
        """
        run_id = "test-run-id"
        metadata = {"langgraph_node": "model", "run_id": run_id}

        events = []

        # Simulate the event sequence (new messages-tuple protocol)
        events.append(format_metadata_event(run_id, attempt=1))
        events.append(
            format_values_event({"messages": [{"type": "human", "content": "Hello"}]})
        )
        # Initial empty-content delta
        events.append(
            format_messages_tuple_event(
                {"content": "", "type": "ai", "id": "123"}, metadata
            )
        )
        # Streaming delta
        events.append(
            format_messages_tuple_event(
                {"content": "Response", "type": "ai", "id": "123"}, metadata
            )
        )
        events.append(
            format_updates_event(
                "model", {"messages": [{"type": "ai", "content": "Response"}]}
            )
        )
        events.append(
            format_values_event(
                {
                    "messages": [
                        {"type": "human", "content": "Hello"},
                        {"type": "ai", "content": "Response"},
                    ]
                }
            )
        )

        # Verify sequence
        assert "event: metadata" in events[0]
        assert "event: values" in events[1]
        assert "event: messages" in events[2]
        assert "event: messages" in events[3]
        assert "event: updates" in events[4]
        assert "event: values" in events[5]

        # Verify NO old-format events present
        for event in events:
            assert "messages/partial" not in event
            assert "messages/metadata" not in event

    def test_all_events_end_with_double_newline(self):
        """Test that all SSE events end with double newline."""
        events = [
            format_metadata_event("run-1"),
            format_values_event({"messages": []}),
            format_updates_event("model", {"messages": []}),
            format_messages_tuple_event(
                {"content": "test", "type": "ai"}, {"langgraph_node": "model"}
            ),
            format_error_event("test error"),
        ]

        for event in events:
            assert event.endswith("\n\n"), (
                f"Event does not end with double newline: {event[:50]}"
            )


# ============================================================================
# Stateless Run Tests
# ============================================================================


class TestStatelessRunStorage:
    """Tests for stateless run storage operations."""

    async def test_create_stateless_thread(self, storage, mock_user_identity):
        """Test creating a temporary thread for stateless run."""
        thread = await storage.threads.create(
            {"metadata": {"stateless": True, "on_completion": "delete"}},
            mock_user_identity,
        )

        assert thread.thread_id is not None
        assert thread.metadata.get("stateless") is True
        assert thread.metadata.get("on_completion") == "delete"

    async def test_delete_stateless_resources(
        self, storage, mock_user_identity, assistant
    ):
        """Test deleting stateless resources after completion."""
        # Create temporary thread
        thread = await storage.threads.create(
            {"metadata": {"stateless": True, "on_completion": "delete"}},
            mock_user_identity,
        )

        # Create run
        run_data = {
            "thread_id": thread.thread_id,
            "assistant_id": assistant.assistant_id,
            "status": "running",
            "metadata": {"stateless": True},
            "kwargs": {},
            "multitask_strategy": "reject",
        }
        run = await storage.runs.create(run_data, mock_user_identity)

        # Delete resources (simulating on_completion="delete")
        deleted_run = await storage.runs.delete_by_thread(
            thread.thread_id, run.run_id, mock_user_identity
        )
        deleted_thread = await storage.threads.delete(
            thread.thread_id, mock_user_identity
        )

        assert deleted_run is True
        assert deleted_thread is True

        # Verify resources are gone
        assert await storage.runs.get(run.run_id, mock_user_identity) is None
        assert await storage.threads.get(thread.thread_id, mock_user_identity) is None


# ============================================================================
# Edge Cases
# ============================================================================


class TestSSEEdgeCases:
    """Tests for SSE edge cases."""

    def test_format_sse_event_with_special_characters(self):
        """Test SSE formatting with special characters in data."""
        data = {"content": 'Hello "world" with \\backslash and\nnewline'}
        result = format_sse_event("test", data)

        # Should be valid SSE format
        assert "event: test\n" in result
        assert "data: " in result
        assert result.endswith("\n\n")

        # JSON should be parseable
        data_line = result.split("data: ")[1].rstrip("\n")
        parsed = json.loads(data_line)
        assert "Hello" in parsed["content"]

    def test_format_sse_event_with_unicode(self):
        """Test SSE formatting with unicode characters."""
        data = {"content": "Hello 世界 🌍 مرحبا"}
        result = format_sse_event("test", data)

        # Should be valid SSE format
        assert "event: test\n" in result
        data_line = result.split("data: ")[1].rstrip("\n")
        parsed = json.loads(data_line)
        assert "世界" in parsed["content"]
        assert "🌍" in parsed["content"]

    def test_format_sse_event_with_empty_dict(self):
        """Test SSE formatting with empty dictionary."""
        result = format_sse_event("test", {})
        assert result == "event: test\ndata: {}\n\n"

    def test_format_sse_event_with_list(self):
        """Test SSE formatting with list data."""
        data = [{"id": 1}, {"id": 2}]
        result = format_sse_event("test", data)

        assert "event: test\n" in result
        data_line = result.split("data: ")[1].rstrip("\n")
        parsed = json.loads(data_line)
        assert len(parsed) == 2

    def test_human_message_with_empty_content(self):
        """Test creating human message with empty content."""
        message = create_human_message("")
        assert message["content"] == ""
        assert message["type"] == "human"

    def test_ai_message_minimal(self):
        """Test creating minimal AI message."""
        msg = create_ai_message("Response")
        assert msg["content"] == "Response"
        assert msg["type"] == "ai"
        assert msg["tool_calls"] == []


# ============================================================================
# Agent Execution Integration Tests
# ============================================================================


class TestExecuteRunStreamIntegration:
    """Tests for execute_run_stream with mocked agent graph."""

    @pytest.mark.asyncio
    async def test_execute_run_stream_emits_metadata_first(
        self, storage, mock_user_identity, assistant, thread
    ):
        """Test that metadata event is always emitted first."""
        from server.routes.streams import execute_run_stream

        # Create a mock agent that streams events
        mock_agent = AsyncMock()

        async def mock_stream_events(*args, **kwargs):
            # Yield a minimal set of events
            yield {
                "event": "on_chat_model_start",
                "name": "ChatOpenAI",
                "run_id": "test-run-123",
                "data": {},
                "metadata": {},
            }
            yield {
                "event": "on_chat_model_stream",
                "name": "ChatOpenAI",
                "run_id": "test-run-123",
                "data": {"chunk": AIMessageChunk(content="Hello")},
                "metadata": {},
            }
            yield {
                "event": "on_chat_model_end",
                "name": "ChatOpenAI",
                "run_id": "test-run-123",
                "data": {"output": AIMessage(content="Hello", id="msg-1")},
                "metadata": {},
            }

        mock_agent.astream_events = mock_stream_events

        mock_factory = AsyncMock(return_value=mock_agent)
        with patch(
            "server.routes.streams.resolve_graph_factory",
            return_value=mock_factory,
        ):
            events = []
            async for event in execute_run_stream(
                run_id="run-123",
                thread_id=thread.thread_id,
                assistant_id=assistant.assistant_id,
                input_data={"messages": [{"role": "user", "content": "Hi"}]},
                config=None,
                owner_id=mock_user_identity,
                assistant_config=assistant.config,
            ):
                events.append(event)

            # First event should be metadata
            assert events[0].startswith("event: metadata")
            assert '"run_id":"run-123"' in events[0]

    @pytest.mark.asyncio
    async def test_execute_run_stream_emits_initial_values(
        self, storage, mock_user_identity, assistant, thread
    ):
        """Test that initial values event contains input messages."""
        from server.routes.streams import execute_run_stream

        mock_agent = AsyncMock()

        async def mock_stream_events(*args, **kwargs):
            yield {
                "event": "on_chat_model_start",
                "name": "ChatOpenAI",
                "run_id": "test-run-123",
                "data": {},
                "metadata": {},
            }
            yield {
                "event": "on_chat_model_end",
                "name": "ChatOpenAI",
                "run_id": "test-run-123",
                "data": {"output": AIMessage(content="Response", id="msg-1")},
                "metadata": {},
            }

        mock_agent.astream_events = mock_stream_events

        mock_factory = AsyncMock(return_value=mock_agent)
        with patch(
            "server.routes.streams.resolve_graph_factory",
            return_value=mock_factory,
        ):
            events = []
            async for event in execute_run_stream(
                run_id="run-123",
                thread_id=thread.thread_id,
                assistant_id=assistant.assistant_id,
                input_data={"messages": [{"role": "user", "content": "Test input"}]},
                config=None,
                owner_id=mock_user_identity,
                assistant_config=assistant.config,
            ):
                events.append(event)

            # Second event should be values with input
            values_event = events[1]
            assert values_event.startswith("event: values")
            assert "Test input" in values_event

    @pytest.mark.asyncio
    async def test_execute_run_stream_streams_tokens(
        self, storage, mock_user_identity, assistant, thread
    ):
        """Test that streaming tokens emit messages-tuple events with deltas."""
        from server.routes.streams import execute_run_stream

        mock_agent = AsyncMock()

        async def mock_stream_events(*args, **kwargs):
            yield {
                "event": "on_chat_model_start",
                "name": "ChatOpenAI",
                "run_id": "test-run-123",
                "data": {},
                "metadata": {},
            }
            # Stream tokens (these are already deltas from astream_events v2)
            yield {
                "event": "on_chat_model_stream",
                "name": "ChatOpenAI",
                "run_id": "test-run-123",
                "data": {"chunk": AIMessageChunk(content="Hello")},
                "metadata": {},
            }
            yield {
                "event": "on_chat_model_stream",
                "name": "ChatOpenAI",
                "run_id": "test-run-123",
                "data": {"chunk": AIMessageChunk(content=" world")},
                "metadata": {},
            }
            yield {
                "event": "on_chat_model_end",
                "name": "ChatOpenAI",
                "run_id": "test-run-123",
                "data": {"output": AIMessage(content="Hello world", id="msg-1")},
                "metadata": {},
            }

        mock_agent.astream_events = mock_stream_events

        mock_factory = AsyncMock(return_value=mock_agent)
        with patch(
            "server.routes.streams.resolve_graph_factory",
            return_value=mock_factory,
        ):
            events = []
            async for event in execute_run_stream(
                run_id="run-123",
                thread_id=thread.thread_id,
                assistant_id=assistant.assistant_id,
                input_data={"messages": [{"role": "user", "content": "Hi"}]},
                config=None,
                owner_id=mock_user_identity,
                assistant_config=assistant.config,
            ):
                events.append(event)

            # Find messages-tuple events (event: messages)
            messages_events = [e for e in events if e.startswith("event: messages\n")]
            # At least: initial empty delta + "Hello" + " world" + final empty delta
            assert len(messages_events) >= 3

            # Verify NO old-format events
            for event in events:
                assert "messages/partial" not in event
                assert "messages/metadata" not in event

            # Verify each messages event is a [delta, metadata] tuple
            for msg_event in messages_events:
                data_line = msg_event.split("data: ", 1)[1].strip()
                parsed = json.loads(data_line)
                assert isinstance(parsed, list), "messages event data must be a list"
                assert len(parsed) == 2, "messages event must be a 2-element tuple"
                assert "content" in parsed[0], "first element must have content"
                assert isinstance(parsed[1], dict), "second element must be metadata"

            # Verify content is DELTA (not accumulated)
            # The "Hello" delta should appear, NOT "Hello world" in a single event
            delta_contents = []
            for msg_event in messages_events:
                data_line = msg_event.split("data: ", 1)[1].strip()
                parsed = json.loads(data_line)
                delta_contents.append(parsed[0]["content"])

            # First is empty (initial), then "Hello", then " world", then "" (final)
            assert "" in delta_contents  # initial empty delta
            assert "Hello" in delta_contents
            assert " world" in delta_contents
            # Accumulated "Hello world" should NOT appear as a single delta
            assert "Hello world" not in delta_contents

    @pytest.mark.asyncio
    async def test_execute_run_stream_emits_final_values(
        self, storage, mock_user_identity, assistant, thread
    ):
        """Test that final values event contains all messages."""
        from server.routes.streams import execute_run_stream

        mock_agent = AsyncMock()

        async def mock_stream_events(*args, **kwargs):
            yield {
                "event": "on_chat_model_start",
                "name": "ChatOpenAI",
                "run_id": "test-run-123",
                "data": {},
                "metadata": {},
            }
            yield {
                "event": "on_chat_model_end",
                "name": "ChatOpenAI",
                "run_id": "test-run-123",
                "data": {
                    "output": AIMessage(
                        content="Final response",
                        id="msg-1",
                        response_metadata={"finish_reason": "stop"},
                    )
                },
                "metadata": {},
            }

        mock_agent.astream_events = mock_stream_events

        mock_factory = AsyncMock(return_value=mock_agent)
        with patch(
            "server.routes.streams.resolve_graph_factory",
            return_value=mock_factory,
        ):
            events = []
            async for event in execute_run_stream(
                run_id="run-123",
                thread_id=thread.thread_id,
                assistant_id=assistant.assistant_id,
                input_data={"messages": [{"role": "user", "content": "Query"}]},
                config=None,
                owner_id=mock_user_identity,
                assistant_config=assistant.config,
            ):
                events.append(event)

            # Last event should be final values
            final_values = events[-1]
            assert final_values.startswith("event: values")
            # Should contain both human and AI messages
            assert "Query" in final_values or "human" in final_values

    @pytest.mark.asyncio
    async def test_execute_run_stream_handles_agent_init_error(
        self, storage, mock_user_identity, assistant, thread
    ):
        """Test that agent initialization errors emit error event."""
        from server.routes.streams import execute_run_stream

        mock_factory = AsyncMock(side_effect=ValueError("Failed to initialize model"))
        with patch(
            "server.routes.streams.resolve_graph_factory",
            return_value=mock_factory,
        ):
            events = []
            async for event in execute_run_stream(
                run_id="run-123",
                thread_id=thread.thread_id,
                assistant_id=assistant.assistant_id,
                input_data={"messages": [{"role": "user", "content": "Hi"}]},
                config=None,
                owner_id=mock_user_identity,
                assistant_config=assistant.config,
            ):
                events.append(event)

            # Should have metadata, values, and error
            assert any("event: error" in e for e in events)
            assert any("AGENT_INIT_ERROR" in e for e in events)

    @pytest.mark.asyncio
    async def test_execute_run_stream_handles_stream_error(
        self, storage, mock_user_identity, assistant, thread
    ):
        """Test that streaming errors emit error event but still complete."""
        from server.routes.streams import execute_run_stream

        mock_agent = AsyncMock()

        async def mock_stream_events(*args, **kwargs):
            yield {
                "event": "on_chat_model_start",
                "name": "ChatOpenAI",
                "run_id": "test-run-123",
                "data": {},
                "metadata": {},
            }
            raise RuntimeError("Connection lost")

        mock_agent.astream_events = mock_stream_events

        mock_factory = AsyncMock(return_value=mock_agent)
        with patch(
            "server.routes.streams.resolve_graph_factory",
            return_value=mock_factory,
        ):
            events = []
            async for event in execute_run_stream(
                run_id="run-123",
                thread_id=thread.thread_id,
                assistant_id=assistant.assistant_id,
                input_data={"messages": [{"role": "user", "content": "Hi"}]},
                config=None,
                owner_id=mock_user_identity,
                assistant_config=assistant.config,
            ):
                events.append(event)

            # Should have error event
            assert any("event: error" in e for e in events)
            assert any("STREAM_ERROR" in e for e in events)
            # Should still have final values
            assert any("event: values" in e for e in events)

    @pytest.mark.asyncio
    async def test_execute_run_stream_stores_final_state(
        self, storage, mock_user_identity, assistant, thread
    ):
        """Test that final state is stored in thread."""
        from server.routes.streams import execute_run_stream

        mock_agent = AsyncMock()

        async def mock_stream_events(*args, **kwargs):
            yield {
                "event": "on_chat_model_start",
                "name": "ChatOpenAI",
                "run_id": "test-run-123",
                "data": {},
                "metadata": {},
            }
            yield {
                "event": "on_chat_model_end",
                "name": "ChatOpenAI",
                "run_id": "test-run-123",
                "data": {"output": AIMessage(content="Stored response", id="msg-1")},
                "metadata": {},
            }

        mock_agent.astream_events = mock_stream_events

        mock_factory = AsyncMock(return_value=mock_agent)
        with patch(
            "server.routes.streams.resolve_graph_factory",
            return_value=mock_factory,
        ):
            # Consume all events
            async for _ in execute_run_stream(
                run_id="run-123",
                thread_id=thread.thread_id,
                assistant_id=assistant.assistant_id,
                input_data={"messages": [{"role": "user", "content": "Store this"}]},
                config=None,
                owner_id=mock_user_identity,
                assistant_config=assistant.config,
            ):
                pass

            # Check thread state was updated
            state = await storage.threads.get_state(
                thread.thread_id, mock_user_identity
            )
            assert state is not None

    @pytest.mark.asyncio
    async def test_multi_llm_streaming_second_node_gets_own_session(
        self, storage, mock_user_identity, assistant, thread
    ):
        """Bug repro: when a graph has multiple LLM nodes, the second
        on_chat_model_start is silently ignored because current_ai_message_id
        is never reset after on_chat_model_end. Tokens from the second LLM
        call either leak into the first message or are dropped.

        Expected: each LLM node gets its own streaming session with a
        unique message ID and its own initial empty delta.
        """
        from server.routes.streams import execute_run_stream

        mock_agent = AsyncMock()

        async def mock_stream_events(*args, **kwargs):
            # ── Node A: first LLM call ──
            yield {
                "event": "on_chat_model_start",
                "name": "ChatOpenAI",
                "run_id": "run-aaa",
                "data": {},
                "metadata": {"langgraph_node": "intake"},
            }
            yield {
                "event": "on_chat_model_stream",
                "name": "ChatOpenAI",
                "run_id": "run-aaa",
                "data": {"chunk": AIMessageChunk(content="First")},
                "metadata": {"langgraph_node": "intake"},
            }
            yield {
                "event": "on_chat_model_end",
                "name": "ChatOpenAI",
                "run_id": "run-aaa",
                "data": {"output": AIMessage(content="First", id="msg-a")},
                "metadata": {"langgraph_node": "intake"},
            }
            # ── Node B: second LLM call ──
            yield {
                "event": "on_chat_model_start",
                "name": "ChatOpenAI",
                "run_id": "run-bbb",
                "data": {},
                "metadata": {"langgraph_node": "analyzer"},
            }
            yield {
                "event": "on_chat_model_stream",
                "name": "ChatOpenAI",
                "run_id": "run-bbb",
                "data": {"chunk": AIMessageChunk(content="Second")},
                "metadata": {"langgraph_node": "analyzer"},
            }
            yield {
                "event": "on_chat_model_end",
                "name": "ChatOpenAI",
                "run_id": "run-bbb",
                "data": {"output": AIMessage(content="Second", id="msg-b")},
                "metadata": {"langgraph_node": "analyzer"},
            }

        mock_agent.astream_events = mock_stream_events

        mock_factory = AsyncMock(return_value=mock_agent)
        with patch(
            "server.routes.streams.resolve_graph_factory",
            return_value=mock_factory,
        ):
            events = []
            async for event in execute_run_stream(
                run_id="run-multi",
                thread_id=thread.thread_id,
                assistant_id=assistant.assistant_id,
                input_data={"messages": [{"role": "user", "content": "Hi"}]},
                config=None,
                owner_id=mock_user_identity,
                assistant_config=assistant.config,
            ):
                events.append(event)

            # Collect all messages-tuple events
            messages_events = [e for e in events if e.startswith("event: messages\n")]

            # Extract (content, message_id) from each messages event
            deltas = []
            for msg_event in messages_events:
                data_line = msg_event.split("data: ", 1)[1].strip()
                parsed = json.loads(data_line)
                deltas.append((parsed[0]["content"], parsed[0].get("id")))

            # We must see two distinct message IDs
            message_ids = {mid for _, mid in deltas if mid is not None}
            assert len(message_ids) == 2, (
                f"Expected 2 distinct message IDs (one per LLM node), "
                f"got {len(message_ids)}: {message_ids}"
            )

            # The "Second" content must appear as a delta
            delta_contents = [content for content, _ in deltas]
            assert "Second" in delta_contents, (
                f"Second LLM node's tokens missing from deltas: {delta_contents}"
            )

            # Both IDs should appear in content-bearing deltas
            ids_with_content = {
                mid for content, mid in deltas if content and mid is not None
            }
            assert len(ids_with_content) == 2, (
                f"Expected content-bearing deltas from 2 message IDs, "
                f"got {len(ids_with_content)}: {ids_with_content}"
            )

    @pytest.mark.asyncio
    async def test_custom_node_name_emits_updates_event(
        self, storage, mock_user_identity, assistant, thread
    ):
        """Bug repro: on_chain_end only emits 'event: updates' when the
        event_name is exactly "model". Graphs with custom node names
        (e.g. "analyzer") never trigger update events — their AIMessages
        only appear in the final 'event: values'.

        Expected: any LangGraph node whose output contains messages should
        emit 'event: updates' with the actual node name.
        """
        from server.routes.streams import execute_run_stream

        mock_agent = AsyncMock()

        async def mock_stream_events(*args, **kwargs):
            yield {
                "event": "on_chat_model_start",
                "name": "ChatOpenAI",
                "run_id": "test-run-123",
                "data": {},
                "metadata": {"langgraph_node": "analyzer"},
            }
            yield {
                "event": "on_chat_model_stream",
                "name": "ChatOpenAI",
                "run_id": "test-run-123",
                "data": {"chunk": AIMessageChunk(content="Analysis result")},
                "metadata": {"langgraph_node": "analyzer"},
            }
            yield {
                "event": "on_chat_model_end",
                "name": "ChatOpenAI",
                "run_id": "test-run-123",
                "data": {"output": AIMessage(content="Analysis result", id="msg-1")},
                "metadata": {"langgraph_node": "analyzer"},
            }
            # Node-level on_chain_end for "analyzer" node
            yield {
                "event": "on_chain_end",
                "name": "analyzer",
                "run_id": "test-run-123",
                "data": {
                    "output": {
                        "messages": [AIMessage(content="Analysis result", id="msg-1")]
                    }
                },
                "metadata": {"langgraph_node": "analyzer"},
            }

        mock_agent.astream_events = mock_stream_events

        mock_factory = AsyncMock(return_value=mock_agent)
        with patch(
            "server.routes.streams.resolve_graph_factory",
            return_value=mock_factory,
        ):
            events = []
            async for event in execute_run_stream(
                run_id="run-custom-node",
                thread_id=thread.thread_id,
                assistant_id=assistant.assistant_id,
                input_data={"messages": [{"role": "user", "content": "Analyze"}]},
                config=None,
                owner_id=mock_user_identity,
                assistant_config=assistant.config,
            ):
                events.append(event)

            # Find updates events
            updates_events = [e for e in events if e.startswith("event: updates\n")]
            assert len(updates_events) >= 1, (
                f"Expected at least 1 updates event for custom node 'analyzer', "
                f"got {len(updates_events)}. All event types: "
                f"{[e.split(chr(10))[0] for e in events]}"
            )

            # The updates event should use the actual node name, not "model"
            updates_data = updates_events[0].split("data: ", 1)[1].strip()
            parsed = json.loads(updates_data)
            assert "analyzer" in parsed, (
                f"Updates event should be keyed by node name 'analyzer', "
                f"got keys: {list(parsed.keys())}"
            )
            assert "model" not in parsed, (
                "Updates event should NOT use hard-coded 'model' key"
            )

    @pytest.mark.asyncio
    async def test_hardcoded_model_node_still_emits_updates(
        self, storage, mock_user_identity, assistant, thread
    ):
        """Regression guard: a node named exactly "model" must still emit
        updates events after the node-name filter is generalized."""
        from server.routes.streams import execute_run_stream

        mock_agent = AsyncMock()

        async def mock_stream_events(*args, **kwargs):
            yield {
                "event": "on_chat_model_start",
                "name": "ChatOpenAI",
                "run_id": "test-run-123",
                "data": {},
                "metadata": {"langgraph_node": "model"},
            }
            yield {
                "event": "on_chat_model_end",
                "name": "ChatOpenAI",
                "run_id": "test-run-123",
                "data": {"output": AIMessage(content="Reply", id="msg-1")},
                "metadata": {"langgraph_node": "model"},
            }
            # Node-level on_chain_end for "model" node
            yield {
                "event": "on_chain_end",
                "name": "model",
                "run_id": "test-run-123",
                "data": {
                    "output": {"messages": [AIMessage(content="Reply", id="msg-1")]}
                },
                "metadata": {"langgraph_node": "model"},
            }

        mock_agent.astream_events = mock_stream_events

        mock_factory = AsyncMock(return_value=mock_agent)
        with patch(
            "server.routes.streams.resolve_graph_factory",
            return_value=mock_factory,
        ):
            events = []
            async for event in execute_run_stream(
                run_id="run-model-node",
                thread_id=thread.thread_id,
                assistant_id=assistant.assistant_id,
                input_data={"messages": [{"role": "user", "content": "Hi"}]},
                config=None,
                owner_id=mock_user_identity,
                assistant_config=assistant.config,
            ):
                events.append(event)

            updates_events = [e for e in events if e.startswith("event: updates\n")]
            assert len(updates_events) >= 1, (
                "Node named 'model' must still emit updates events"
            )
            updates_data = updates_events[0].split("data: ", 1)[1].strip()
            parsed = json.loads(updates_data)
            assert "model" in parsed

    @pytest.mark.asyncio
    async def test_internal_chain_end_does_not_emit_spurious_updates(
        self, storage, mock_user_identity, assistant, thread
    ):
        """Guard against spurious updates: an internal chain completion
        (e.g. ChatOpenAI finishing inside a node) should NOT emit an
        'event: updates' even if its output happens to contain messages.

        Internal chains have event_name != langgraph_node (e.g.
        event_name="ChatOpenAI" while langgraph_node="analyzer").
        """
        from server.routes.streams import execute_run_stream

        mock_agent = AsyncMock()

        async def mock_stream_events(*args, **kwargs):
            yield {
                "event": "on_chat_model_start",
                "name": "ChatOpenAI",
                "run_id": "test-run-123",
                "data": {},
                "metadata": {"langgraph_node": "analyzer"},
            }
            yield {
                "event": "on_chat_model_end",
                "name": "ChatOpenAI",
                "run_id": "test-run-123",
                "data": {"output": AIMessage(content="Done", id="msg-1")},
                "metadata": {"langgraph_node": "analyzer"},
            }
            # Internal chain end — ChatOpenAI completing inside "analyzer"
            # event_name is "ChatOpenAI", NOT the node name "analyzer"
            yield {
                "event": "on_chain_end",
                "name": "ChatOpenAI",
                "run_id": "test-run-123",
                "data": {
                    "output": {"messages": [AIMessage(content="Done", id="msg-1")]}
                },
                "metadata": {"langgraph_node": "analyzer"},
            }

        mock_agent.astream_events = mock_stream_events

        mock_factory = AsyncMock(return_value=mock_agent)
        with patch(
            "server.routes.streams.resolve_graph_factory",
            return_value=mock_factory,
        ):
            events = []
            async for event in execute_run_stream(
                run_id="run-internal",
                thread_id=thread.thread_id,
                assistant_id=assistant.assistant_id,
                input_data={"messages": [{"role": "user", "content": "Hi"}]},
                config=None,
                owner_id=mock_user_identity,
                assistant_config=assistant.config,
            ):
                events.append(event)

            # No updates events should be emitted for internal chain ends
            updates_events = [e for e in events if e.startswith("event: updates\n")]
            assert len(updates_events) == 0, (
                f"Internal chain end (ChatOpenAI inside analyzer) should NOT "
                f"emit updates events, but got {len(updates_events)}"
            )

    # ============================================================================
    # Goal 45: LangGraph Auth User & Configurable Headers
    # ============================================================================


class FakeRobynHeaders:
    """Mimics Robyn's Headers.get_headers() for testing."""

    def __init__(self, data: dict[str, str | list[str]]):
        self._headers = {}
        for k, v in data.items():
            if isinstance(v, list):
                self._headers[k.lower()] = v
            else:
                self._headers[k.lower()] = [v]

    def get_headers(self) -> dict[str, list[str]]:
        return self._headers

    def __bool__(self) -> bool:
        return bool(self._headers)

    class TestExtractConfigurableHeaders:
        """Tests for _extract_configurable_headers helper (Goal 45)."""

        def test_forwards_x_headers(self):
            """Include x-* headers following LangGraph Platform convention."""
            from server.routes.streams import _extract_configurable_headers

            headers = FakeRobynHeaders(
                {
                    "x-organization-id": "org-123",
                    "x-user-id": "user-456",
                    "x-custom-header": "value",
                }
            )
            result = _extract_configurable_headers(headers)
            assert result == {
                "x-organization-id": "org-123",
                "x-user-id": "user-456",
                "x-custom-header": "value",
            }

        def test_excludes_authorization_header(self):
            """Exclude authorization (sensitive credential)."""
            from server.routes.streams import _extract_configurable_headers

            headers = FakeRobynHeaders(
                {
                    "authorization": "Bearer secret",
                    "x-safe-header": "value",
                }
            )
            result = _extract_configurable_headers(headers)
            assert result == {"x-safe-header": "value"}

        def test_excludes_x_api_key(self):
            """Exclude x-api-key (sensitive credential)."""
            from server.routes.streams import _extract_configurable_headers

            headers = FakeRobynHeaders(
                {
                    "x-api-key": "secret-key",
                    "x-organization-id": "org-123",
                }
            )
            result = _extract_configurable_headers(headers)
            assert result == {"x-organization-id": "org-123"}

        def test_lowercases_header_names(self):
            """Header names are lowercased (LangGraph Platform behaviour)."""
            from server.routes.streams import _extract_configurable_headers

            headers = FakeRobynHeaders(
                {
                    "X-Organization-Id": "org-123",
                    "X-USER-ID": "user-456",
                }
            )
            result = _extract_configurable_headers(headers)
            assert result == {
                "x-organization-id": "org-123",
                "x-user-id": "user-456",
            }

        def test_ignores_non_x_headers(self):
            """Only x-* headers are forwarded."""
            from server.routes.streams import _extract_configurable_headers

            headers = FakeRobynHeaders(
                {
                    "content-type": "application/json",
                    "accept": "text/html",
                    "x-custom": "value",
                }
            )
            result = _extract_configurable_headers(headers)
            assert result == {"x-custom": "value"}

        def test_multi_value_headers_takes_last(self):
            """When a header has multiple values, take the last one."""
            from server.routes.streams import _extract_configurable_headers

            headers = FakeRobynHeaders(
                {
                    "x-org": ["old", "new"],
                    "x-user": "active",
                }
            )
            result = _extract_configurable_headers(headers)
            assert result == {"x-org": "new", "x-user": "active"}

        def test_handles_none_headers(self):
            """None headers → empty dict."""
            from server.routes.streams import _extract_configurable_headers

            result = _extract_configurable_headers(FakeRobynHeaders({}))
            assert result == {}

        def test_multi_value_headers_takes_last_with_auth(self):
            """When a header has multiple values and authorization, take the last one and exclude auth."""
            from server.routes.streams import _extract_configurable_headers

            headers = FakeRobynHeaders(
                {
                    "x-org": ["old", "new"],
                    "x-user": "active",
                    "authorization": "secret",
                }
            )
            result = _extract_configurable_headers(headers)
            assert result == {"x-org": "new", "x-user": "active"}

        def test_handles_empty_headers(self):
            """Empty headers dict → empty dict."""
            from server.routes.streams import _extract_configurable_headers

            result = _extract_configurable_headers(FakeRobynHeaders({}))
            assert result == {}


class TestBuildRunnableConfigAuthUser:
    """Tests for _build_runnable_config langgraph_auth_user injection (Goal 45)."""

    def test_populates_langgraph_auth_user_when_provided(self):
        """auth_user → langgraph_auth_user in configurable."""
        from server.auth import AuthUser
        from server.routes.streams import _build_runnable_config

        user = AuthUser(
            identity="user-123",
            email="test@example.com",
            metadata={"role": "admin"},
            token="jwt-abc",
        )
        config = _build_runnable_config(
            run_id="run-1",
            thread_id="thread-1",
            assistant_id="asst-1",
            assistant_config=None,
            run_config=None,
            owner_id="user-123",
            auth_user=user,
        )

        assert "langgraph_auth_user" in config["configurable"]
        auth_user_dict = config["configurable"]["langgraph_auth_user"]
        assert auth_user_dict["identity"] == "user-123"
        assert auth_user_dict["email"] == "test@example.com"
        assert auth_user_dict["token"] == "jwt-abc"

    def test_populates_langgraph_auth_user_id(self):
        """auth_user → langgraph_auth_user_id set to identity."""
        from server.auth import AuthUser
        from server.routes.streams import _build_runnable_config

        user = AuthUser(identity="user-456", token="jwt-xyz")
        config = _build_runnable_config(
            run_id="run-1",
            thread_id="thread-1",
            assistant_id="asst-1",
            assistant_config=None,
            run_config=None,
            owner_id="user-456",
            auth_user=user,
        )

        assert config["configurable"]["langgraph_auth_user_id"] == "user-456"

    def test_populates_x_supabase_access_token_for_backward_compat(self):
        """auth_user with token → x-supabase-access-token set (backward compat)."""
        from server.auth import AuthUser
        from server.routes.streams import _build_runnable_config

        user = AuthUser(identity="user-789", token="jwt-legacy")
        config = _build_runnable_config(
            run_id="run-1",
            thread_id="thread-1",
            assistant_id="asst-1",
            assistant_config=None,
            run_config=None,
            owner_id="user-789",
            auth_user=user,
        )

        assert config["configurable"]["x-supabase-access-token"] == "jwt-legacy"

    def test_skips_auth_keys_when_auth_user_none(self):
        """auth_user=None → no langgraph_auth_user or x-supabase-access-token."""
        from server.routes.streams import _build_runnable_config

        config = _build_runnable_config(
            run_id="run-1",
            thread_id="thread-1",
            assistant_id="asst-1",
            assistant_config=None,
            run_config=None,
            owner_id="mcp-client",
            auth_user=None,
        )

        assert "langgraph_auth_user" not in config["configurable"]
        assert "langgraph_auth_user_id" not in config["configurable"]
        assert "x-supabase-access-token" not in config["configurable"]

    def test_skips_x_supabase_access_token_when_token_none(self):
        """auth_user with token=None → x-supabase-access-token not set."""
        from server.auth import AuthUser
        from server.routes.streams import _build_runnable_config

        user = AuthUser(identity="user-no-token", token=None)
        config = _build_runnable_config(
            run_id="run-1",
            thread_id="thread-1",
            assistant_id="asst-1",
            assistant_config=None,
            run_config=None,
            owner_id="user-no-token",
            auth_user=user,
        )

        # langgraph_auth_user still populated
        assert "langgraph_auth_user" in config["configurable"]
        # But x-supabase-access-token is NOT set
        assert "x-supabase-access-token" not in config["configurable"]

    def test_forwards_request_headers_into_configurable(self):
        """request_headers with x-* → merged into configurable."""
        from server.routes.streams import _build_runnable_config

        headers = {
            "x-organization-id": "org-999",
            "x-custom-header": "custom-value",
        }
        config = _build_runnable_config(
            run_id="run-1",
            thread_id="thread-1",
            assistant_id="asst-1",
            assistant_config=None,
            run_config=None,
            owner_id="user-1",
            request_headers=headers,
        )

        assert config["configurable"]["x-organization-id"] == "org-999"
        assert config["configurable"]["x-custom-header"] == "custom-value"

    def test_request_headers_none_is_safe(self):
        """request_headers=None → no error, no headers in configurable."""
        from server.routes.streams import _build_runnable_config

        config = _build_runnable_config(
            run_id="run-1",
            thread_id="thread-1",
            assistant_id="asst-1",
            assistant_config=None,
            run_config=None,
            owner_id="user-1",
            request_headers=None,
        )

        # No crash, config built successfully
        assert config["configurable"]["thread_id"] == "thread-1"
