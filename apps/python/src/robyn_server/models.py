"""Pydantic models for Robyn API request/response types.

This module defines the data structures used by the LangGraph-compatible API.
Models are added as endpoints are implemented in subsequent tasks.
"""

from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field, field_serializer


# ============================================================================
# Health & Info Models
# ============================================================================


class HealthResponse(BaseModel):
    """Health check response."""

    status: str = "ok"


class ServiceInfoResponse(BaseModel):
    """Service information response."""

    service: str = "oap-langgraph-tools-agent"
    runtime: str = "robyn"
    version: str = "0.0.2"


# ============================================================================
# Assistant Models (Task 04)
# ============================================================================


class AssistantConfig(BaseModel):
    """Configuration for an assistant.

    Matches LangGraph API Config schema.
    """

    tags: list[str] = Field(default_factory=list)
    recursion_limit: int = 25
    configurable: dict[str, Any] = Field(default_factory=dict)


class AssistantCreate(BaseModel):
    """Request to create an assistant.

    Matches LangGraph API AssistantCreate schema.
    """

    graph_id: str
    assistant_id: str | None = None  # Optional, auto-generated if not provided
    config: dict[str, Any] = Field(default_factory=dict)
    context: dict[str, Any] = Field(default_factory=dict)
    metadata: dict[str, Any] = Field(default_factory=dict)
    name: str | None = None
    description: str | None = None
    if_exists: str = "raise"  # "raise" or "do_nothing"


class AssistantPatch(BaseModel):
    """Request to update an assistant.

    Matches LangGraph API AssistantPatch schema.
    All fields are optional - only provided fields are updated.
    """

    graph_id: str | None = None
    config: dict[str, Any] | None = None
    context: dict[str, Any] | None = None
    metadata: dict[str, Any] | None = None
    name: str | None = None
    description: str | None = None


class Assistant(BaseModel):
    """Assistant resource.

    Matches LangGraph API Assistant schema.
    """

    assistant_id: str
    graph_id: str
    config: AssistantConfig = Field(default_factory=AssistantConfig)
    context: dict[str, Any] = Field(default_factory=dict)
    metadata: dict[str, Any] = Field(default_factory=dict)
    name: str | None = None
    description: str | None = None
    version: int = 1
    created_at: datetime
    updated_at: datetime

    @field_serializer("created_at", "updated_at")
    @classmethod
    def serialize_datetime(cls, value: datetime) -> str:
        """Serialize datetime to ISO 8601 format with Z suffix."""
        return value.isoformat().replace("+00:00", "Z")


# ============================================================================
# Thread Models (Task 05)
# ============================================================================


class ThreadCreate(BaseModel):
    """Request to create a thread.

    Matches LangGraph API ThreadCreate schema.
    """

    thread_id: str | None = None  # Optional, auto-generated if not provided
    metadata: dict[str, Any] = Field(default_factory=dict)
    if_exists: str = "raise"  # "raise" or "do_nothing"


class ThreadPatch(BaseModel):
    """Request to update a thread.

    Matches LangGraph API ThreadPatch schema.
    All fields are optional - only provided fields are updated.
    """

    metadata: dict[str, Any] | None = None


class Thread(BaseModel):
    """Thread resource.

    Matches LangGraph API Thread schema.
    """

    thread_id: str
    metadata: dict[str, Any] = Field(default_factory=dict)
    config: dict[str, Any] = Field(default_factory=dict)
    status: str = "idle"  # "idle", "busy", "interrupted", "error"
    values: dict[str, Any] = Field(default_factory=dict)
    interrupts: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime
    updated_at: datetime

    @field_serializer("created_at", "updated_at")
    @classmethod
    def serialize_datetime(cls, value: datetime) -> str:
        """Serialize datetime to ISO 8601 format with Z suffix."""
        return value.isoformat().replace("+00:00", "Z")


class ThreadState(BaseModel):
    """Thread state snapshot.

    Matches LangGraph API ThreadState schema.
    """

    values: dict[str, Any] | list[dict[str, Any]] = Field(default_factory=dict)
    next: list[str] = Field(default_factory=list)
    tasks: list[dict[str, Any]] = Field(default_factory=list)
    checkpoint: dict[str, Any] | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)
    created_at: str | None = None
    parent_checkpoint: dict[str, Any] | None = None
    interrupts: list[dict[str, Any]] = Field(default_factory=list)


# ============================================================================
# Run Models (Task 06)
# ============================================================================


class RunCreate(BaseModel):
    """Request to create/invoke a run.

    Matches LangGraph API RunCreateStateful schema.
    """

    assistant_id: str  # Required - UUID or graph name
    input: dict[str, Any] | list[Any] | str | int | bool | None = None
    command: dict[str, Any] | None = None
    checkpoint: dict[str, Any] | None = None  # Checkpoint to resume from
    metadata: dict[str, Any] = Field(default_factory=dict)
    config: dict[str, Any] = Field(default_factory=dict)
    context: dict[str, Any] = Field(default_factory=dict)
    webhook: str | None = None
    interrupt_before: list[str] | str | None = None
    interrupt_after: list[str] | str | None = None
    stream_mode: list[str] | str = Field(default_factory=lambda: ["values"])
    stream_subgraphs: bool = False
    stream_resumable: bool = False
    feedback_keys: list[str] | None = None
    multitask_strategy: str = "enqueue"  # "reject", "enqueue", "rollback", "interrupt"
    on_disconnect: str = "continue"  # "cancel" or "continue"
    on_completion: str = "delete"  # "delete" or "keep" (for stateless runs)
    if_not_exists: str = "reject"  # "create" or "reject" (for thread)
    after_seconds: float | None = None
    checkpoint_during: bool = False
    durability: str = "async"  # "sync", "async", or "exit"


class Run(BaseModel):
    """Run resource.

    Matches LangGraph API Run schema.
    """

    run_id: str
    thread_id: str
    assistant_id: str
    status: str  # "pending", "running", "success", "error", "timeout", "interrupted"
    metadata: dict[str, Any] = Field(default_factory=dict)
    kwargs: dict[str, Any] = Field(default_factory=dict)
    multitask_strategy: str = "reject"
    created_at: datetime
    updated_at: datetime

    @field_serializer("created_at", "updated_at")
    @classmethod
    def serialize_datetime(cls, value: datetime) -> str:
        """Serialize datetime to ISO 8601 format with Z suffix."""
        return value.isoformat().replace("+00:00", "Z")


# ============================================================================
# Search/Count Models (Tier 2)
# ============================================================================


class AssistantSearchRequest(BaseModel):
    """Request to search assistants."""

    metadata: dict[str, Any] | None = None
    graph_id: str | None = None
    name: str | None = None
    limit: int = 10
    offset: int = 0
    sort_by: str | None = None
    sort_order: str | None = None


class AssistantCountRequest(BaseModel):
    """Request to count assistants."""

    metadata: dict[str, Any] | None = None
    graph_id: str | None = None
    name: str | None = None


class ThreadSearchRequest(BaseModel):
    """Request to search threads.

    Matches LangGraph API ThreadSearchRequest schema.
    """

    ids: list[str] | None = None  # Filter by specific thread IDs
    metadata: dict[str, Any] | None = None
    values: dict[str, Any] | None = None  # Filter by state values
    status: str | None = None  # "idle", "busy", "interrupted", "error"
    limit: int = Field(default=10, ge=1, le=1000)
    offset: int = Field(default=0, ge=0)
    sort_by: str | None = None  # "thread_id", "status", "created_at", "updated_at"
    sort_order: str | None = None  # "asc", "desc"


class ThreadCountRequest(BaseModel):
    """Request to count threads.

    Matches LangGraph API ThreadCountRequest schema.
    """

    metadata: dict[str, Any] | None = None
    values: dict[str, Any] | None = None  # Filter by state values
    status: str | None = None  # "idle", "busy", "interrupted", "error"


# ============================================================================
# Error Models
# ============================================================================


class ErrorResponse(BaseModel):
    """Standard error response matching LangGraph API format.

    The LangGraph API uses {"detail": "message"} for errors.
    """

    detail: str


class ValidationErrorDetail(BaseModel):
    """Detail item for validation errors."""

    loc: list[str | int]
    msg: str
    type: str


class ValidationErrorResponse(BaseModel):
    """Validation error response."""

    detail: list[ValidationErrorDetail]
