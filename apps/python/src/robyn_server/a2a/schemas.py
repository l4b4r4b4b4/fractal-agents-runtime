"""A2A Protocol Pydantic schemas.

JSON-RPC 2.0 request/response models and A2A-specific types
for the Agent-to-Agent Protocol implementation.

The A2A protocol enables inter-agent communication using a standardized
JSON-RPC 2.0 interface, mapping to LangGraph's thread and run concepts.
"""

from enum import IntEnum, StrEnum
from typing import Any, Literal

from pydantic import BaseModel, Field


# ============================================================================
# JSON-RPC 2.0 Error Codes (reuse from MCP where applicable)
# ============================================================================


class JsonRpcErrorCode(IntEnum):
    """Standard JSON-RPC 2.0 error codes."""

    PARSE_ERROR = -32700
    INVALID_REQUEST = -32600
    METHOD_NOT_FOUND = -32601
    INVALID_PARAMS = -32602
    INTERNAL_ERROR = -32603

    # A2A-specific error codes (application-defined)
    TASK_NOT_FOUND = -32001
    TASK_NOT_CANCELABLE = -32002
    UNSUPPORTED_OPERATION = -32003
    INVALID_PART_TYPE = -32004


# ============================================================================
# JSON-RPC 2.0 Base Models
# ============================================================================


class JsonRpcRequest(BaseModel):
    """JSON-RPC 2.0 request object."""

    jsonrpc: Literal["2.0"] = "2.0"
    id: str | int | None = None
    method: str
    params: dict[str, Any] | None = None


class JsonRpcError(BaseModel):
    """JSON-RPC 2.0 error object."""

    code: int
    message: str
    data: Any | None = None


class JsonRpcResponse(BaseModel):
    """JSON-RPC 2.0 response object."""

    jsonrpc: Literal["2.0"] = "2.0"
    id: str | int | None = None
    result: Any | None = None
    error: JsonRpcError | None = None

    def model_dump(self, **kwargs) -> dict[str, Any]:
        """Custom dump to exclude None result/error based on which is set."""
        data: dict[str, Any] = {"jsonrpc": self.jsonrpc, "id": self.id}
        if self.error is not None:
            data["error"] = self.error.model_dump()
        else:
            data["result"] = self.result
        return data


# ============================================================================
# A2A Task Status
# ============================================================================


class TaskState(StrEnum):
    """A2A task states mapped from LangGraph run states."""

    SUBMITTED = "submitted"  # Run created, pending
    WORKING = "working"  # Run is executing
    INPUT_REQUIRED = "input-required"  # Run interrupted, needs input
    COMPLETED = "completed"  # Run finished successfully
    FAILED = "failed"  # Run errored
    CANCELED = "canceled"  # Run was cancelled


class TaskStatus(BaseModel):
    """A2A task status."""

    state: TaskState
    message: str | None = None
    timestamp: str | None = None


# ============================================================================
# A2A Message Parts
# ============================================================================


class TextPart(BaseModel):
    """Text content part."""

    kind: Literal["text"] = "text"
    text: str


class DataPart(BaseModel):
    """Structured data part."""

    kind: Literal["data"] = "data"
    data: dict[str, Any]


class FilePart(BaseModel):
    """File content part (not supported, for schema completeness)."""

    kind: Literal["file"] = "file"
    file: dict[str, Any]


# Union type for message parts
MessagePart = TextPart | DataPart | FilePart


# ============================================================================
# A2A Message
# ============================================================================


class A2AMessage(BaseModel):
    """A2A protocol message.

    Maps to LangGraph:
    - contextId → thread_id
    - taskId → run_id (for resuming interrupted tasks)
    - parts → input content
    """

    role: Literal["user", "agent"]
    parts: list[MessagePart]
    message_id: str = Field(alias="messageId")
    context_id: str | None = Field(default=None, alias="contextId")
    task_id: str | None = Field(default=None, alias="taskId")

    model_config = {"populate_by_name": True}


# ============================================================================
# A2A Artifacts
# ============================================================================


class Artifact(BaseModel):
    """A2A artifact - represents agent output."""

    artifact_id: str = Field(alias="artifactId")
    name: str = "Assistant Response"
    parts: list[MessagePart] = Field(default_factory=list)

    model_config = {"populate_by_name": True, "by_alias": True}


# ============================================================================
# A2A Task
# ============================================================================


class Task(BaseModel):
    """A2A task - wraps a LangGraph run with A2A semantics.

    The task ID format is: {thread_id}:{run_id}
    This allows reconstruction of both IDs from a single identifier.
    """

    kind: Literal["task"] = "task"
    id: str  # Format: {thread_id}:{run_id}
    context_id: str = Field(alias="contextId")
    status: TaskStatus
    artifacts: list[Artifact] = Field(default_factory=list)
    history: list[A2AMessage] = Field(default_factory=list)

    model_config = {"populate_by_name": True, "by_alias": True}


# ============================================================================
# A2A Method Parameters
# ============================================================================


class MessageSendParams(BaseModel):
    """Parameters for message/send and message/stream methods."""

    message: A2AMessage


class TaskGetParams(BaseModel):
    """Parameters for tasks/get method."""

    id: str  # Task ID (format: {thread_id}:{run_id})
    context_id: str = Field(alias="contextId")
    history_length: int = Field(default=0, ge=0, le=10, alias="historyLength")

    model_config = {"populate_by_name": True}


class TaskCancelParams(BaseModel):
    """Parameters for tasks/cancel method."""

    id: str  # Task ID
    context_id: str = Field(alias="contextId")

    model_config = {"populate_by_name": True}


# ============================================================================
# A2A Streaming Events
# ============================================================================


class StatusUpdateEvent(BaseModel):
    """SSE event for task status updates during streaming."""

    kind: Literal["status-update"] = "status-update"
    task_id: str = Field(alias="taskId")
    context_id: str = Field(alias="contextId")
    status: TaskStatus
    final: bool = False

    model_config = {"populate_by_name": True, "by_alias": True}


class ArtifactUpdateEvent(BaseModel):
    """SSE event for artifact updates during streaming."""

    kind: Literal["artifact-update"] = "artifact-update"
    task_id: str = Field(alias="taskId")
    context_id: str = Field(alias="contextId")
    artifact: Artifact
    final: bool = False

    model_config = {"populate_by_name": True, "by_alias": True}


# ============================================================================
# Helper Functions
# ============================================================================


def create_error_response(
    request_id: str | int | None,
    code: int,
    message: str,
    data: Any | None = None,
) -> JsonRpcResponse:
    """Create a JSON-RPC error response."""
    return JsonRpcResponse(
        id=request_id,
        error=JsonRpcError(code=code, message=message, data=data),
    )


def create_success_response(
    request_id: str | int | None,
    result: Any,
) -> JsonRpcResponse:
    """Create a JSON-RPC success response."""
    return JsonRpcResponse(id=request_id, result=result)


def parse_task_id(task_id: str) -> tuple[str, str]:
    """Parse a task ID into thread_id and run_id.

    Args:
        task_id: Task ID in format {thread_id}:{run_id}

    Returns:
        Tuple of (thread_id, run_id)

    Raises:
        ValueError: If task_id format is invalid
    """
    if ":" not in task_id:
        raise ValueError(
            f"Invalid task ID format: {task_id}. Expected format: thread_id:run_id"
        )
    parts = task_id.split(":", 1)
    return parts[0], parts[1]


def create_task_id(thread_id: str, run_id: str) -> str:
    """Create a task ID from thread_id and run_id.

    Args:
        thread_id: The thread ID
        run_id: The run ID

    Returns:
        Task ID in format {thread_id}:{run_id}
    """
    return f"{thread_id}:{run_id}"


def map_run_status_to_task_state(run_status: str) -> TaskState:
    """Map LangGraph run status to A2A task state.

    Args:
        run_status: LangGraph run status

    Returns:
        Corresponding A2A TaskState
    """
    status_map = {
        "pending": TaskState.SUBMITTED,
        "running": TaskState.WORKING,
        "success": TaskState.COMPLETED,
        "error": TaskState.FAILED,
        "timeout": TaskState.FAILED,
        "interrupted": TaskState.INPUT_REQUIRED,
    }
    return status_map.get(run_status, TaskState.FAILED)


def extract_text_from_parts(parts: list[MessagePart]) -> str:
    """Extract concatenated text from message parts.

    Args:
        parts: List of message parts

    Returns:
        Concatenated text content
    """
    texts = []
    for part in parts:
        if isinstance(part, TextPart):
            texts.append(part.text)
        elif isinstance(part, dict) and part.get("kind") == "text":
            texts.append(part.get("text", ""))
    return "\n".join(texts)


def extract_data_from_parts(parts: list[MessagePart]) -> dict[str, Any]:
    """Extract merged data from message parts.

    Args:
        parts: List of message parts

    Returns:
        Merged data dictionary
    """
    merged: dict[str, Any] = {}
    for part in parts:
        if isinstance(part, DataPart):
            merged.update(part.data)
        elif isinstance(part, dict) and part.get("kind") == "data":
            merged.update(part.get("data", {}))
    return merged


def has_file_parts(parts: list[MessagePart]) -> bool:
    """Check if any parts are file type (unsupported).

    Args:
        parts: List of message parts

    Returns:
        True if any file parts exist
    """
    for part in parts:
        if isinstance(part, FilePart):
            return True
        if isinstance(part, dict) and part.get("kind") == "file":
            return True
    return False
