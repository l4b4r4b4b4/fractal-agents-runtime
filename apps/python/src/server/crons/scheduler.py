"""APScheduler wrapper for cron job execution.

Manages the background scheduler that executes cron jobs at their
scheduled times. Provides methods to add, remove, and manage
scheduled jobs.
"""

import asyncio
import logging
from datetime import timezone
from typing import TYPE_CHECKING, Any

from apscheduler.executors.pool import ThreadPoolExecutor
from apscheduler.jobstores.memory import MemoryJobStore
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger

if TYPE_CHECKING:
    from server.crons.schemas import Cron

logger = logging.getLogger(__name__)


class CronScheduler:
    """Manages APScheduler for cron job execution.

    Wraps AsyncIOScheduler to provide:
    - Background cron job execution
    - Job management (add, remove, pause)
    - Graceful shutdown
    """

    def __init__(self):
        """Initialize the scheduler."""
        self._scheduler: AsyncIOScheduler | None = None
        self._started = False
        self._job_owner_map: dict[str, str] = {}  # job_id -> owner_id

    @property
    def scheduler(self) -> AsyncIOScheduler:
        """Get or create the scheduler instance."""
        if self._scheduler is None:
            self._scheduler = AsyncIOScheduler(
                jobstores={"default": MemoryJobStore()},
                executors={"default": ThreadPoolExecutor(10)},
                job_defaults={
                    "coalesce": True,  # Combine missed runs
                    "max_instances": 1,  # Prevent concurrent execution
                    "misfire_grace_time": 60,  # Allow 60s grace for misfires
                },
                timezone=timezone.utc,
            )
        return self._scheduler

    def start(self) -> None:
        """Start the scheduler.

        Safe to call multiple times - will only start once.
        """
        if not self._started:
            self.scheduler.start()
            self._started = True
            logger.info("Cron scheduler started")

    def shutdown(self, wait: bool = True) -> None:
        """Shutdown the scheduler.

        Args:
            wait: Whether to wait for jobs to complete
        """
        if self._started and self._scheduler is not None:
            self._scheduler.shutdown(wait=wait)
            self._started = False
            logger.info("Cron scheduler stopped")

    def add_cron_job(
        self,
        cron: "Cron",
        owner_id: str,
    ) -> str | None:
        """Add a cron job to the scheduler.

        Args:
            cron: Cron instance with schedule and configuration
            owner_id: ID of the cron owner

        Returns:
            Job ID if added successfully, None if failed
        """
        try:
            # Parse cron schedule expression
            trigger = self._parse_cron_schedule(cron.schedule)

            # Set end date if specified
            if cron.end_time:
                end_time = cron.end_time
                if end_time.tzinfo is None:
                    end_time = end_time.replace(tzinfo=timezone.utc)
                trigger.end_date = end_time

            # Ensure scheduler is running
            self.start()

            # Add the job
            job = self.scheduler.add_job(
                func=self._execute_cron_job,
                trigger=trigger,
                id=cron.cron_id,
                args=[cron.cron_id, owner_id],
                name=f"cron_{cron.cron_id}",
                replace_existing=True,
            )

            # Track owner
            self._job_owner_map[cron.cron_id] = owner_id

            logger.info(
                f"Scheduled cron {cron.cron_id} with schedule '{cron.schedule}'"
            )
            return job.id

        except Exception as e:
            logger.exception(f"Failed to schedule cron {cron.cron_id}: {e}")
            return None

    def remove_cron_job(self, cron_id: str) -> bool:
        """Remove a cron job from the scheduler.

        Args:
            cron_id: ID of the cron job to remove

        Returns:
            True if removed, False if not found
        """
        try:
            if self._scheduler is not None:
                self._scheduler.remove_job(cron_id)
            self._job_owner_map.pop(cron_id, None)
            logger.info(f"Removed cron job {cron_id}")
            return True
        except Exception as e:
            logger.warning(f"Could not remove cron job {cron_id}: {e}")
            return False

    def pause_cron_job(self, cron_id: str) -> bool:
        """Pause a cron job.

        Args:
            cron_id: ID of the cron job to pause

        Returns:
            True if paused, False if not found
        """
        try:
            if self._scheduler is not None:
                self._scheduler.pause_job(cron_id)
            logger.info(f"Paused cron job {cron_id}")
            return True
        except Exception as e:
            logger.warning(f"Could not pause cron job {cron_id}: {e}")
            return False

    def resume_cron_job(self, cron_id: str) -> bool:
        """Resume a paused cron job.

        Args:
            cron_id: ID of the cron job to resume

        Returns:
            True if resumed, False if not found
        """
        try:
            if self._scheduler is not None:
                self._scheduler.resume_job(cron_id)
            logger.info(f"Resumed cron job {cron_id}")
            return True
        except Exception as e:
            logger.warning(f"Could not resume cron job {cron_id}: {e}")
            return False

    def get_job_info(self, cron_id: str) -> dict[str, Any] | None:
        """Get information about a scheduled job.

        Args:
            cron_id: ID of the cron job

        Returns:
            Job info dict or None if not found
        """
        if self._scheduler is None:
            return None

        job = self._scheduler.get_job(cron_id)
        if job is None:
            return None

        return {
            "job_id": job.id,
            "name": job.name,
            "next_run_time": job.next_run_time,
            "pending": job.pending,
        }

    def list_jobs(self) -> list[dict[str, Any]]:
        """List all scheduled jobs.

        Returns:
            List of job info dicts
        """
        if self._scheduler is None:
            return []

        jobs = self._scheduler.get_jobs()
        return [
            {
                "job_id": job.id,
                "name": job.name,
                "next_run_time": job.next_run_time,
                "owner_id": self._job_owner_map.get(job.id),
            }
            for job in jobs
        ]

    def _parse_cron_schedule(self, schedule: str) -> CronTrigger:
        """Parse a cron schedule expression into an APScheduler trigger.

        Args:
            schedule: Cron expression (e.g., "*/5 * * * *")

        Returns:
            CronTrigger instance

        Raises:
            ValueError: If schedule is invalid
        """
        parts = schedule.strip().split()

        if len(parts) == 5:
            # Standard 5-field cron: minute hour day month day_of_week
            minute, hour, day, month, day_of_week = parts
            return CronTrigger(
                minute=minute,
                hour=hour,
                day=day,
                month=month,
                day_of_week=day_of_week,
                timezone=timezone.utc,
            )
        elif len(parts) == 6:
            # Extended 6-field cron with seconds
            second, minute, hour, day, month, day_of_week = parts
            return CronTrigger(
                second=second,
                minute=minute,
                hour=hour,
                day=day,
                month=month,
                day_of_week=day_of_week,
                timezone=timezone.utc,
            )
        else:
            raise ValueError(
                f"Invalid cron schedule: '{schedule}'. "
                f"Expected 5 or 6 fields, got {len(parts)}"
            )

    def _execute_cron_job(self, cron_id: str, owner_id: str) -> None:
        """Execute a cron job.

        This is called by APScheduler when a job fires.
        It runs the async execution in a new event loop since
        APScheduler calls this from a thread.

        Args:
            cron_id: ID of the cron to execute
            owner_id: ID of the cron owner
        """
        logger.info(f"Executing cron job {cron_id} for owner {owner_id}")

        try:
            # Get or create an event loop for async execution
            try:
                loop = asyncio.get_event_loop()
            except RuntimeError:
                loop = asyncio.new_event_loop()
                asyncio.set_event_loop(loop)

            # Import handler here to avoid circular imports
            from server.crons.handlers import get_cron_handler

            handler = get_cron_handler()

            # Run the async execution
            loop.run_until_complete(handler.execute_cron_run(cron_id, owner_id))

        except Exception as e:
            logger.exception(f"Error executing cron job {cron_id}: {e}")


# Global scheduler instance
_scheduler: CronScheduler | None = None


def get_scheduler() -> CronScheduler:
    """Get the global scheduler instance.

    Returns:
        CronScheduler singleton instance
    """
    global _scheduler
    if _scheduler is None:
        _scheduler = CronScheduler()
    return _scheduler


def reset_scheduler() -> None:
    """Reset the global scheduler (for testing).

    Shuts down the existing scheduler and creates a fresh instance.
    """
    global _scheduler
    if _scheduler is not None:
        _scheduler.shutdown(wait=False)
    _scheduler = None
