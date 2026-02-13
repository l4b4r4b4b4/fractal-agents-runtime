"""A2A (Agent-to-Agent) Protocol implementation.

This module provides the A2A protocol endpoint for inter-agent communication
using JSON-RPC 2.0 over HTTP. It maps A2A concepts to LangGraph primitives:

- A2A Task → LangGraph Run
- A2A contextId → LangGraph thread_id
- A2A Message → LangGraph input
- A2A Artifact → LangGraph output

Supported Methods:
- message/send: Send message and wait for response
- message/stream: Send message and stream response (SSE)
- tasks/get: Get task status
- tasks/cancel: Cancel task (not supported)

Example:
    >>> from server.a2a import a2a_handler, JsonRpcRequest
    >>> request = JsonRpcRequest(
    ...     method="message/send",
    ...     id="1",
    ...     params={"message": {...}}
    ... )
    >>> response = await a2a_handler.handle_request(
    ...     request, assistant_id="agent", owner_id="user123"
    ... )
"""

from server.a2a.handlers import A2AMethodHandler, a2a_handler
from server.a2a.schemas import (
    A2AMessage,
    Artifact,
    ArtifactUpdateEvent,
    DataPart,
    FilePart,
    JsonRpcError,
    JsonRpcErrorCode,
    JsonRpcRequest,
    JsonRpcResponse,
    MessagePart,
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

__all__ = [
    # Handler
    "A2AMethodHandler",
    "a2a_handler",
    # JSON-RPC types
    "JsonRpcError",
    "JsonRpcErrorCode",
    "JsonRpcRequest",
    "JsonRpcResponse",
    # A2A message types
    "A2AMessage",
    "DataPart",
    "FilePart",
    "MessagePart",
    "TextPart",
    # A2A task types
    "Artifact",
    "ArtifactUpdateEvent",
    "StatusUpdateEvent",
    "Task",
    "TaskState",
    "TaskStatus",
    # Method parameters
    "MessageSendParams",
    "TaskCancelParams",
    "TaskGetParams",
    # Helper functions
    "create_error_response",
    "create_success_response",
    "create_task_id",
    "extract_data_from_parts",
    "extract_text_from_parts",
    "has_file_parts",
    "map_run_status_to_task_state",
    "parse_task_id",
]
