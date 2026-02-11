"""Crons API Pydantic schemas.

Data models for scheduled cron jobs matching the LangGraph API specification.
Crons enable recurring scheduled runs on threads.
"""

from datetime import datetime
from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator


# ============================================================================
# Enums
# ============================================================================


class OnRunCompleted(StrEnum):
    """Action to take when a cron run completes."""

    DELETE = "delete"  # Delete thread after execution (stateless)
    KEEP = "keep"  # Keep thread (creates new thread each time)


class CronSortBy(StrEnum):
    """Fields available for sorting crons."""

    CRON_ID = "cron_id"
    ASSISTANT_ID = "assistant_id"
    THREAD_ID = "thread_id"
    NEXT_RUN_DATE = "next_run_date"
    END_TIME = "end_time"
    CREATED_AT = "created_at"
    UPDATED_AT = "updated_at"


class SortOrder(StrEnum):
    """Sort direction."""

    ASC = "asc"
    DESC = "desc"


# ============================================================================
# Cron Configuration
# ============================================================================


class CronConfig(BaseModel):
    """Configuration for cron job runs."""

    tags: list[str] | None = None
    recursion_limit: int | None = None
    configurable: dict[str, Any] | None = None


# ============================================================================
# Cron Create Request
# ============================================================================


class CronCreate(BaseModel):
    """Request model for creating a cron job.

    Creates a stateless cron that schedules runs on new threads.
    """

    schedule: str = Field(
        ...,
        description="Cron schedule expression (e.g., '*/5 * * * *' for every 5 minutes)",
    )
    assistant_id: str = Field(
        ...,
        description="Assistant ID (UUID) or graph name to run",
    )
    end_time: datetime | None = Field(
        default=None,
        description="End date to stop running the cron (optional, runs indefinitely if not set)",
    )
    input: list[dict[str, Any]] | dict[str, Any] | None = Field(
        default=None,
        description="Input to pass to the graph",
    )
    metadata: dict[str, Any] | None = Field(
        default=None,
        description="Metadata to assign to cron job runs",
    )
    config: CronConfig | None = Field(
        default=None,
        description="Configuration for the assistant",
    )
    context: dict[str, Any] | None = Field(
        default=None,
        description="Static context added to the assistant",
    )
    webhook: str | None = Field(
        default=None,
        description="Webhook URL to call after each run completes",
    )
    interrupt_before: Literal["*"] | list[str] | None = Field(
        default=None,
        description="Nodes to interrupt before execution",
    )
    interrupt_after: Literal["*"] | list[str] | None = Field(
        default=None,
        description="Nodes to interrupt after execution",
    )
    on_run_completed: OnRunCompleted = Field(
        default=OnRunCompleted.DELETE,
        description="Action after run completes: 'delete' removes thread, 'keep' preserves it",
    )

    @field_validator("schedule")
    @classmethod
    def validate_schedule(cls, value: str) -> str:
        """Validate cron schedule expression."""
        # Import here to avoid circular imports and keep validation isolated
        try:
            from croniter import croniter

            # Validate by attempting to create a croniter instance
            croniter(value)
        except (ValueError, KeyError) as e:
            raise ValueError(f"Invalid cron schedule expression: {e}") from e
        return value


# ============================================================================
# Cron Response Model
# ============================================================================


class Cron(BaseModel):
    """Response model for a cron job."""

    cron_id: str = Field(
        ...,
        description="Unique identifier for the cron job",
    )
    assistant_id: str | None = Field(
        default=None,
        description="Assistant ID associated with this cron",
    )
    thread_id: str = Field(
        ...,
        description="Thread ID for the cron (used for stateful crons)",
    )
    end_time: datetime | None = Field(
        default=None,
        description="End date when the cron stops running",
    )
    schedule: str = Field(
        ...,
        description="Cron schedule expression",
    )
    created_at: datetime = Field(
        ...,
        description="When the cron was created",
    )
    updated_at: datetime = Field(
        ...,
        description="When the cron was last updated",
    )
    user_id: str | None = Field(
        default=None,
        description="User ID who owns this cron",
    )
    payload: dict[str, Any] = Field(
        ...,
        description="Run payload configuration",
    )
    next_run_date: datetime | None = Field(
        default=None,
        description="Next scheduled run time",
    )
    metadata: dict[str, Any] = Field(
        default_factory=dict,
        description="Cron metadata",
    )

    model_config = {"from_attributes": True}


# ============================================================================
# Cron Search Request
# ============================================================================


class CronSearch(BaseModel):
    """Request model for searching crons."""

    assistant_id: str | None = Field(
        default=None,
        description="Filter by assistant ID (exact match)",
    )
    thread_id: str | None = Field(
        default=None,
        description="Filter by thread ID",
    )
    limit: int = Field(
        default=10,
        ge=1,
        le=1000,
        description="Maximum number of results to return",
    )
    offset: int = Field(
        default=0,
        ge=0,
        description="Number of results to skip",
    )
    sort_by: CronSortBy = Field(
        default=CronSortBy.CREATED_AT,
        description="Field to sort by",
    )
    sort_order: SortOrder = Field(
        default=SortOrder.DESC,
        description="Sort direction",
    )
    select: list[str] | None = Field(
        default=None,
        description="Fields to include in response (None = all fields)",
    )

    @field_validator("select")
    @classmethod
    def validate_select(cls, value: list[str] | None) -> list[str] | None:
        """Validate select fields are valid Cron attributes."""
        if value is None:
            return value

        valid_fields = {
            "cron_id",
            "assistant_id",
            "thread_id",
            "on_run_completed",
            "end_time",
            "schedule",
            "created_at",
            "updated_at",
            "user_id",
            "payload",
            "next_run_date",
            "metadata",
        }

        for field in value:
            if field not in valid_fields:
                raise ValueError(
                    f"Invalid select field: '{field}'. "
                    f"Valid fields: {sorted(valid_fields)}"
                )
        return value


# ============================================================================
# Cron Count Request
# ============================================================================


class CronCountRequest(BaseModel):
    """Request model for counting crons."""

    assistant_id: str | None = Field(
        default=None,
        description="Filter by assistant ID",
    )
    thread_id: str | None = Field(
        default=None,
        description="Filter by thread ID",
    )


# ============================================================================
# Internal Models
# ============================================================================


class CronPayload(BaseModel):
    """Internal model for storing cron run configuration.

    This captures all the settings needed to create a run.
    """

    assistant_id: str
    input: list[dict[str, Any]] | dict[str, Any] | None = None
    metadata: dict[str, Any] | None = None
    config: CronConfig | None = None
    context: dict[str, Any] | None = None
    webhook: str | None = None
    interrupt_before: Literal["*"] | list[str] | None = None
    interrupt_after: Literal["*"] | list[str] | None = None
    on_run_completed: OnRunCompleted = OnRunCompleted.DELETE

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for storage."""
        return {
            "assistant_id": self.assistant_id,
            "input": self.input,
            "metadata": self.metadata,
            "config": self.config.model_dump() if self.config else None,
            "context": self.context,
            "webhook": self.webhook,
            "interrupt_before": self.interrupt_before,
            "interrupt_after": self.interrupt_after,
            "on_run_completed": self.on_run_completed,
        }


# ============================================================================
# Helper Functions
# ============================================================================


def calculate_next_run_date(
    schedule: str,
    base_time: datetime | None = None,
) -> datetime:
    """Calculate the next run date for a cron schedule.

    Args:
        schedule: Cron schedule expression
        base_time: Base time to calculate from (defaults to now)

    Returns:
        Next scheduled run time
    """
    from datetime import timezone

    from croniter import croniter

    if base_time is None:
        base_time = datetime.now(timezone.utc)

    # Ensure base_time is timezone-aware
    if base_time.tzinfo is None:
        base_time = base_time.replace(tzinfo=timezone.utc)

    cron = croniter(schedule, base_time)
    next_run = cron.get_next(datetime)

    # Ensure result is timezone-aware
    if next_run.tzinfo is None:
        next_run = next_run.replace(tzinfo=timezone.utc)

    return next_run


def is_cron_expired(cron_end_time: datetime | None) -> bool:
    """Check if a cron job has expired.

    Args:
        cron_end_time: The cron's end time (None = never expires)

    Returns:
        True if cron has expired, False otherwise
    """
    if cron_end_time is None:
        return False

    from datetime import timezone

    now = datetime.now(timezone.utc)

    # Make end_time timezone-aware if needed
    if cron_end_time.tzinfo is None:
        cron_end_time = cron_end_time.replace(tzinfo=timezone.utc)

    return now >= cron_end_time
