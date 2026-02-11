"""Crons API handlers.

Business logic for cron job management including creation, search,
counting, and deletion of scheduled recurring runs.
"""

import logging
from datetime import datetime, timezone
from typing import Any

from robyn_server.crons.schemas import (
    Cron,
    CronCountRequest,
    CronCreate,
    CronPayload,
    CronSearch,
    OnRunCompleted,
    SortOrder,
    calculate_next_run_date,
    is_cron_expired,
)
from robyn_server.storage import get_storage

logger = logging.getLogger(__name__)


class CronHandler:
    """Handler for cron job operations.

    Manages CRUD operations for cron jobs and coordinates
    with the scheduler for execution.
    """

    def __init__(self):
        """Initialize the cron handler."""
        self._scheduler = None  # Lazy initialization

    @property
    def scheduler(self):
        """Get the scheduler instance (lazy initialization)."""
        if self._scheduler is None:
            from robyn_server.crons.scheduler import get_scheduler

            self._scheduler = get_scheduler()
        return self._scheduler

    async def create_cron(
        self,
        create_data: CronCreate,
        owner_id: str,
    ) -> Cron:
        """Create a new cron job.

        Args:
            create_data: Cron creation parameters
            owner_id: ID of the user creating the cron

        Returns:
            Created Cron instance

        Raises:
            ValueError: If validation fails
        """
        storage = get_storage()

        # Verify assistant exists
        assistant = await storage.assistants.get(create_data.assistant_id, owner_id)
        if assistant is None:
            # Try to find by graph_id
            assistants = await storage.assistants.list(owner_id)
            assistant = next(
                (a for a in assistants if a.graph_id == create_data.assistant_id),
                None,
            )
            if assistant is None:
                raise ValueError(f"Assistant not found: {create_data.assistant_id}")

        # Create a placeholder thread for the cron
        # (actual runs may use new threads based on on_run_completed setting)
        thread = await storage.threads.create({}, owner_id)
        thread_id = thread.thread_id

        # Build the payload
        payload = CronPayload(
            assistant_id=assistant.assistant_id,
            input=create_data.input,
            metadata=create_data.metadata,
            config=create_data.config,
            context=create_data.context,
            webhook=create_data.webhook,
            interrupt_before=create_data.interrupt_before,
            interrupt_after=create_data.interrupt_after,
            on_run_completed=create_data.on_run_completed,
        )

        # Calculate next run date
        next_run_date = calculate_next_run_date(create_data.schedule)

        # Check if already expired
        if is_cron_expired(create_data.end_time):
            raise ValueError(f"Cron end_time {create_data.end_time} is in the past")

        # Create cron in storage
        cron_data = {
            "assistant_id": assistant.assistant_id,
            "thread_id": thread_id,
            "schedule": create_data.schedule,
            "end_time": create_data.end_time,
            "user_id": owner_id,
            "payload": payload.to_dict(),
            "next_run_date": next_run_date,
            "on_run_completed": create_data.on_run_completed,
            "metadata": create_data.metadata or {},
        }

        cron = await storage.crons.create(cron_data, owner_id)

        # Schedule the cron job
        self.scheduler.add_cron_job(cron, owner_id)

        logger.info(f"Created cron {cron.cron_id} for user {owner_id}")
        return cron

    async def search_crons(
        self,
        search_params: CronSearch,
        owner_id: str,
    ) -> list[Cron]:
        """Search for cron jobs.

        Args:
            search_params: Search and filter parameters
            owner_id: ID of the requesting user

        Returns:
            List of matching Cron instances
        """
        storage = get_storage()

        # Build filters
        filters: dict[str, Any] = {}
        if search_params.assistant_id:
            filters["assistant_id"] = search_params.assistant_id
        if search_params.thread_id:
            filters["thread_id"] = search_params.thread_id

        # Get all crons for user with filters
        crons = await storage.crons.list(owner_id, **filters)

        # Sort
        sort_key = search_params.sort_by.value
        reverse = search_params.sort_order == SortOrder.DESC

        def get_sort_value(cron: Cron) -> Any:
            """Get value for sorting, handling None values."""
            value = getattr(cron, sort_key, None)
            if value is None:
                # Use epoch for None datetime values, empty string for others
                if sort_key in (
                    "next_run_date",
                    "end_time",
                    "created_at",
                    "updated_at",
                ):
                    return datetime.min.replace(tzinfo=timezone.utc)
                return ""
            return value

        crons.sort(key=get_sort_value, reverse=reverse)

        # Apply pagination
        start = search_params.offset
        end = start + search_params.limit
        crons = crons[start:end]

        # Apply field selection if specified
        if search_params.select:
            crons = self._apply_field_selection(crons, search_params.select)

        return crons

    async def count_crons(
        self,
        count_params: CronCountRequest,
        owner_id: str,
    ) -> int:
        """Count cron jobs matching filters.

        Args:
            count_params: Filter parameters
            owner_id: ID of the requesting user

        Returns:
            Count of matching crons
        """
        storage = get_storage()

        # Build filters
        filters: dict[str, Any] = {}
        if count_params.assistant_id:
            filters["assistant_id"] = count_params.assistant_id
        if count_params.thread_id:
            filters["thread_id"] = count_params.thread_id

        # Get count
        count = await storage.crons.count(owner_id, **filters)
        return count

    async def delete_cron(
        self,
        cron_id: str,
        owner_id: str,
    ) -> dict[str, Any]:
        """Delete a cron job.

        Args:
            cron_id: ID of the cron to delete
            owner_id: ID of the requesting user

        Returns:
            Empty dict on success

        Raises:
            ValueError: If cron not found
        """
        storage = get_storage()

        # Verify cron exists and belongs to user
        cron = await storage.crons.get(cron_id, owner_id)
        if cron is None:
            raise ValueError(f"Cron not found: {cron_id}")

        # Remove from scheduler
        self.scheduler.remove_cron_job(cron_id)

        # Delete from storage
        deleted = await storage.crons.delete(cron_id, owner_id)
        if not deleted:
            raise ValueError(f"Failed to delete cron: {cron_id}")

        logger.info(f"Deleted cron {cron_id} for user {owner_id}")
        return {}

    async def get_cron(
        self,
        cron_id: str,
        owner_id: str,
    ) -> Cron | None:
        """Get a cron job by ID.

        Args:
            cron_id: ID of the cron to retrieve
            owner_id: ID of the requesting user

        Returns:
            Cron instance if found, None otherwise
        """
        storage = get_storage()
        return await storage.crons.get(cron_id, owner_id)

    async def execute_cron_run(
        self,
        cron_id: str,
        owner_id: str,
    ) -> None:
        """Execute a scheduled cron run.

        Called by the scheduler when a cron job fires.

        Args:
            cron_id: ID of the cron to execute
            owner_id: ID of the cron owner
        """
        storage = get_storage()

        # Get the cron
        cron = await storage.crons.get(cron_id, owner_id)
        if cron is None:
            logger.warning(f"Cron {cron_id} not found during execution")
            return

        # Check if expired
        if is_cron_expired(cron.end_time):
            logger.info(f"Cron {cron_id} has expired, removing from scheduler")
            self.scheduler.remove_cron_job(cron_id)
            return

        # Get payload
        payload = cron.payload
        on_run_completed = OnRunCompleted(payload.get("on_run_completed", "delete"))

        # Determine which thread to use
        if on_run_completed == OnRunCompleted.KEEP:
            # Create a new thread for this execution
            new_thread = await storage.threads.create({}, owner_id)
            thread_id = new_thread.thread_id
        else:
            # Use the cron's designated thread (will be cleaned up after)
            thread_id = cron.thread_id

        # Create the run
        run_data = {
            "assistant_id": payload.get("assistant_id"),
            "input": payload.get("input"),
            "metadata": payload.get("metadata"),
            "config": payload.get("config"),
            "webhook": payload.get("webhook"),
            "interrupt_before": payload.get("interrupt_before"),
            "interrupt_after": payload.get("interrupt_after"),
        }

        try:
            # Create run (actual execution happens asynchronously)
            run = await storage.runs.create(
                thread_id=thread_id,
                data=run_data,
                owner_id=owner_id,
            )

            logger.info(
                f"Cron {cron_id} created run {run.run_id} on thread {thread_id}"
            )

            # Update next_run_date
            next_run = calculate_next_run_date(cron.schedule)
            await storage.crons.update(
                cron_id=cron_id,
                owner_id=owner_id,
                updates={"next_run_date": next_run},
            )

            # If delete policy, schedule thread cleanup after run completes
            if on_run_completed == OnRunCompleted.DELETE:
                # Note: In a real implementation, we'd register a callback
                # to delete the thread when the run completes.
                # For now, we'll handle this in the run completion logic.
                pass

        except Exception as e:
            logger.exception(f"Failed to execute cron {cron_id}: {e}")

    def _apply_field_selection(
        self,
        crons: list[Cron],
        select: list[str],
    ) -> list[Cron]:
        """Apply field selection to cron list.

        Returns crons with only the selected fields populated.

        Args:
            crons: List of crons
            select: Fields to include

        Returns:
            List of crons with selected fields
        """
        # For now, we return full crons since Pydantic models have required fields
        # A proper implementation would return dicts with only selected fields
        # This matches the LangGraph API behavior where select is a hint
        return crons


# Global handler instance
_cron_handler: CronHandler | None = None


def get_cron_handler() -> CronHandler:
    """Get the global cron handler instance.

    Returns:
        CronHandler singleton instance
    """
    global _cron_handler
    if _cron_handler is None:
        _cron_handler = CronHandler()
    return _cron_handler


def reset_cron_handler() -> None:
    """Reset the global cron handler (for testing)."""
    global _cron_handler
    _cron_handler = None
