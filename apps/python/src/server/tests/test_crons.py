"""Tests for Crons API.

Tests cover:
- Cron schema validation
- Cron handlers (create, search, count, delete)
- Cron routes (HTTP endpoints)
- Scheduler functionality
"""

import json
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch

import pytest
import pytest_asyncio

from server.crons import (
    Cron,
    CronConfig,
    CronCountRequest,
    CronCreate,
    CronPayload,
    CronScheduler,
    CronSearch,
    CronSortBy,
    OnRunCompleted,
    SortOrder,
    calculate_next_run_date,
    get_cron_handler,
    is_cron_expired,
    reset_cron_handler,
    reset_scheduler,
)
from server.storage import get_storage, reset_storage


# ============================================================================
# Fixtures
# ============================================================================


@pytest.fixture(autouse=True)
def reset_state():
    """Reset global state before each test."""
    reset_storage()
    reset_cron_handler()
    reset_scheduler()
    yield
    reset_storage()
    reset_cron_handler()
    reset_scheduler()


@pytest.fixture
def owner_id():
    """Test owner ID."""
    return "test-owner-123"


@pytest_asyncio.fixture
async def assistant_id(owner_id):
    """Create a test assistant and return its ID."""
    storage = get_storage()
    assistant = await storage.assistants.create(
        {"graph_id": "test-graph", "config": {}},
        owner_id,
    )
    return assistant.assistant_id


# ============================================================================
# Schema Tests
# ============================================================================


class TestCronSchemas:
    """Tests for Cron Pydantic schemas."""

    def test_cron_create_minimal(self):
        """Test creating CronCreate with minimal required fields."""
        data = CronCreate(
            schedule="*/5 * * * *",
            assistant_id="test-assistant-id",
        )
        assert data.schedule == "*/5 * * * *"
        assert data.assistant_id == "test-assistant-id"
        assert data.on_run_completed == OnRunCompleted.DELETE
        assert data.input is None
        assert data.metadata is None

    def test_cron_create_full(self):
        """Test creating CronCreate with all fields."""
        end_time = datetime.now(timezone.utc) + timedelta(days=30)
        data = CronCreate(
            schedule="0 0 * * *",
            assistant_id="test-assistant-id",
            end_time=end_time,
            input={"message": "Hello"},
            metadata={"source": "test"},
            config=CronConfig(tags=["daily"], recursion_limit=50),
            webhook="https://example.com/webhook",
            interrupt_before=["node1"],
            interrupt_after=["node2"],
            on_run_completed=OnRunCompleted.KEEP,
        )
        assert data.schedule == "0 0 * * *"
        assert data.end_time == end_time
        assert data.input == {"message": "Hello"}
        assert data.on_run_completed == OnRunCompleted.KEEP
        assert data.config.tags == ["daily"]

    def test_cron_create_invalid_schedule(self):
        """Test CronCreate rejects invalid cron schedule."""
        with pytest.raises(ValueError, match="Invalid cron schedule"):
            CronCreate(
                schedule="invalid-schedule",
                assistant_id="test-assistant-id",
            )

    def test_cron_create_schedule_too_few_fields(self):
        """Test CronCreate rejects schedule with too few fields."""
        with pytest.raises(ValueError):
            CronCreate(
                schedule="* * *",
                assistant_id="test-assistant-id",
            )

    def test_cron_model(self):
        """Test Cron response model."""
        now = datetime.now(timezone.utc)
        cron = Cron(
            cron_id="cron-123",
            assistant_id="assistant-123",
            thread_id="thread-123",
            schedule="*/5 * * * *",
            created_at=now,
            updated_at=now,
            payload={"assistant_id": "assistant-123"},
        )
        assert cron.cron_id == "cron-123"
        assert cron.schedule == "*/5 * * * *"
        assert cron.metadata == {}

    def test_cron_search_defaults(self):
        """Test CronSearch default values."""
        search = CronSearch()
        assert search.limit == 10
        assert search.offset == 0
        assert search.sort_by == CronSortBy.CREATED_AT
        assert search.sort_order == SortOrder.DESC
        assert search.select is None

    def test_cron_search_with_filters(self):
        """Test CronSearch with filters."""
        search = CronSearch(
            assistant_id="assistant-123",
            thread_id="thread-123",
            limit=50,
            offset=10,
            sort_by=CronSortBy.NEXT_RUN_DATE,
            sort_order=SortOrder.ASC,
        )
        assert search.assistant_id == "assistant-123"
        assert search.limit == 50
        assert search.sort_by == CronSortBy.NEXT_RUN_DATE

    def test_cron_search_invalid_select_field(self):
        """Test CronSearch rejects invalid select fields."""
        with pytest.raises(ValueError, match="Invalid select field"):
            CronSearch(select=["invalid_field"])

    def test_cron_search_valid_select_fields(self):
        """Test CronSearch accepts valid select fields."""
        search = CronSearch(select=["cron_id", "schedule", "next_run_date"])
        assert search.select == ["cron_id", "schedule", "next_run_date"]

    def test_cron_count_request(self):
        """Test CronCountRequest model."""
        count_req = CronCountRequest(
            assistant_id="assistant-123",
            thread_id="thread-123",
        )
        assert count_req.assistant_id == "assistant-123"
        assert count_req.thread_id == "thread-123"

    def test_cron_payload(self):
        """Test CronPayload internal model."""
        payload = CronPayload(
            assistant_id="assistant-123",
            input={"message": "Hello"},
            on_run_completed=OnRunCompleted.KEEP,
        )
        data = payload.to_dict()
        assert data["assistant_id"] == "assistant-123"
        assert data["input"] == {"message": "Hello"}
        assert data["on_run_completed"] == OnRunCompleted.KEEP


class TestCronHelpers:
    """Tests for cron helper functions."""

    def test_calculate_next_run_date(self):
        """Test calculating next run date."""
        # Every minute
        next_run = calculate_next_run_date("* * * * *")
        assert next_run > datetime.now(timezone.utc)
        assert (next_run - datetime.now(timezone.utc)).total_seconds() <= 60

    def test_calculate_next_run_date_with_base_time(self):
        """Test calculating next run date from specific base time."""
        base = datetime(2024, 1, 1, 12, 0, 0, tzinfo=timezone.utc)
        # Every hour at minute 0
        next_run = calculate_next_run_date("0 * * * *", base)
        assert next_run == datetime(2024, 1, 1, 13, 0, 0, tzinfo=timezone.utc)

    def test_calculate_next_run_date_daily(self):
        """Test calculating next run date for daily cron."""
        base = datetime(2024, 1, 1, 12, 0, 0, tzinfo=timezone.utc)
        # Every day at midnight
        next_run = calculate_next_run_date("0 0 * * *", base)
        assert next_run == datetime(2024, 1, 2, 0, 0, 0, tzinfo=timezone.utc)

    def test_is_cron_expired_none(self):
        """Test is_cron_expired with None (never expires)."""
        assert is_cron_expired(None) is False

    def test_is_cron_expired_future(self):
        """Test is_cron_expired with future date."""
        future = datetime.now(timezone.utc) + timedelta(days=1)
        assert is_cron_expired(future) is False

    def test_is_cron_expired_past(self):
        """Test is_cron_expired with past date."""
        past = datetime.now(timezone.utc) - timedelta(days=1)
        assert is_cron_expired(past) is True


# ============================================================================
# Handler Tests
# ============================================================================


class TestCronHandler:
    """Tests for CronHandler."""

    @pytest.mark.asyncio
    async def test_create_cron_success(self, owner_id, assistant_id):
        """Test successful cron creation."""
        handler = get_cron_handler()
        # Mock the scheduler to avoid actually scheduling
        handler._scheduler = MagicMock()
        handler._scheduler.add_cron_job = MagicMock(return_value="job-123")

        create_data = CronCreate(
            schedule="*/5 * * * *",
            assistant_id=assistant_id,
        )

        cron = await handler.create_cron(create_data, owner_id)

        assert cron is not None
        assert cron.cron_id is not None
        assert cron.schedule == "*/5 * * * *"
        assert cron.assistant_id == assistant_id
        assert cron.next_run_date is not None

    @pytest.mark.asyncio
    async def test_create_cron_invalid_assistant(self, owner_id):
        """Test cron creation with non-existent assistant."""
        handler = get_cron_handler()
        handler._scheduler = MagicMock()

        create_data = CronCreate(
            schedule="*/5 * * * *",
            assistant_id="non-existent-assistant",
        )

        with pytest.raises(ValueError, match="Assistant not found"):
            await handler.create_cron(create_data, owner_id)

    @pytest.mark.asyncio
    async def test_create_cron_expired_end_time(self, owner_id, assistant_id):
        """Test cron creation with expired end_time."""
        handler = get_cron_handler()
        handler._scheduler = MagicMock()

        create_data = CronCreate(
            schedule="*/5 * * * *",
            assistant_id=assistant_id,
            end_time=datetime.now(timezone.utc) - timedelta(days=1),
        )

        with pytest.raises(ValueError, match="Cron end_time .* is in the past"):
            await handler.create_cron(create_data, owner_id)

    @pytest.mark.asyncio
    async def test_search_crons_empty(self, owner_id):
        """Test searching crons when none exist."""
        handler = get_cron_handler()

        search_params = CronSearch()
        crons = await handler.search_crons(search_params, owner_id)

        assert crons == []

    @pytest.mark.asyncio
    async def test_search_crons_with_results(self, owner_id, assistant_id):
        """Test searching crons with results."""
        handler = get_cron_handler()
        handler._scheduler = MagicMock()
        handler._scheduler.add_cron_job = MagicMock(return_value="job-123")

        # Create multiple crons
        for i in range(3):
            create_data = CronCreate(
                schedule=f"*/{i + 1} * * * *",
                assistant_id=assistant_id,
            )
            await handler.create_cron(create_data, owner_id)

        search_params = CronSearch(limit=10)
        crons = await handler.search_crons(search_params, owner_id)

        assert len(crons) == 3

    @pytest.mark.asyncio
    async def test_search_crons_with_filter(self, owner_id, assistant_id):
        """Test searching crons with assistant_id filter."""
        handler = get_cron_handler()
        handler._scheduler = MagicMock()
        handler._scheduler.add_cron_job = MagicMock(return_value="job-123")

        create_data = CronCreate(
            schedule="*/5 * * * *",
            assistant_id=assistant_id,
        )
        await handler.create_cron(create_data, owner_id)

        # Search with matching filter
        search_params = CronSearch(assistant_id=assistant_id)
        crons = await handler.search_crons(search_params, owner_id)
        assert len(crons) == 1

        # Search with non-matching filter
        search_params = CronSearch(assistant_id="other-assistant")
        crons = await handler.search_crons(search_params, owner_id)
        assert len(crons) == 0

    @pytest.mark.asyncio
    async def test_search_crons_pagination(self, owner_id, assistant_id):
        """Test cron search pagination."""
        handler = get_cron_handler()
        handler._scheduler = MagicMock()
        handler._scheduler.add_cron_job = MagicMock(return_value="job-123")

        # Create 5 crons
        for i in range(5):
            create_data = CronCreate(
                schedule=f"*/{i + 1} * * * *",
                assistant_id=assistant_id,
            )
            await handler.create_cron(create_data, owner_id)

        # Get first page
        search_params = CronSearch(limit=2, offset=0)
        crons = await handler.search_crons(search_params, owner_id)
        assert len(crons) == 2

        # Get second page
        search_params = CronSearch(limit=2, offset=2)
        crons = await handler.search_crons(search_params, owner_id)
        assert len(crons) == 2

        # Get third page
        search_params = CronSearch(limit=2, offset=4)
        crons = await handler.search_crons(search_params, owner_id)
        assert len(crons) == 1

    @pytest.mark.asyncio
    async def test_count_crons(self, owner_id, assistant_id):
        """Test counting crons."""
        handler = get_cron_handler()
        handler._scheduler = MagicMock()
        handler._scheduler.add_cron_job = MagicMock(return_value="job-123")

        # Create 3 crons
        for i in range(3):
            create_data = CronCreate(
                schedule=f"*/{i + 1} * * * *",
                assistant_id=assistant_id,
            )
            await handler.create_cron(create_data, owner_id)

        count_params = CronCountRequest()
        count = await handler.count_crons(count_params, owner_id)

        assert count == 3

    @pytest.mark.asyncio
    async def test_count_crons_with_filter(self, owner_id, assistant_id):
        """Test counting crons with filter."""
        handler = get_cron_handler()
        handler._scheduler = MagicMock()
        handler._scheduler.add_cron_job = MagicMock(return_value="job-123")

        create_data = CronCreate(
            schedule="*/5 * * * *",
            assistant_id=assistant_id,
        )
        await handler.create_cron(create_data, owner_id)

        # Count with matching filter
        count_params = CronCountRequest(assistant_id=assistant_id)
        count = await handler.count_crons(count_params, owner_id)
        assert count == 1

        # Count with non-matching filter
        count_params = CronCountRequest(assistant_id="other-assistant")
        count = await handler.count_crons(count_params, owner_id)
        assert count == 0

    @pytest.mark.asyncio
    async def test_delete_cron_success(self, owner_id, assistant_id):
        """Test successful cron deletion."""
        handler = get_cron_handler()
        handler._scheduler = MagicMock()
        handler._scheduler.add_cron_job = MagicMock(return_value="job-123")
        handler._scheduler.remove_cron_job = MagicMock(return_value=True)

        create_data = CronCreate(
            schedule="*/5 * * * *",
            assistant_id=assistant_id,
        )
        cron = await handler.create_cron(create_data, owner_id)

        result = await handler.delete_cron(cron.cron_id, owner_id)

        assert result == {}
        handler._scheduler.remove_cron_job.assert_called_once_with(cron.cron_id)

    @pytest.mark.asyncio
    async def test_delete_cron_not_found(self, owner_id):
        """Test deleting non-existent cron."""
        handler = get_cron_handler()

        with pytest.raises(ValueError, match="Cron not found"):
            await handler.delete_cron("non-existent-cron", owner_id)

    @pytest.mark.asyncio
    async def test_get_cron(self, owner_id, assistant_id):
        """Test getting a cron by ID."""
        handler = get_cron_handler()
        handler._scheduler = MagicMock()
        handler._scheduler.add_cron_job = MagicMock(return_value="job-123")

        create_data = CronCreate(
            schedule="*/5 * * * *",
            assistant_id=assistant_id,
        )
        created_cron = await handler.create_cron(create_data, owner_id)

        cron = await handler.get_cron(created_cron.cron_id, owner_id)

        assert cron is not None
        assert cron.cron_id == created_cron.cron_id

    @pytest.mark.asyncio
    async def test_get_cron_not_found(self, owner_id):
        """Test getting non-existent cron."""
        handler = get_cron_handler()

        cron = await handler.get_cron("non-existent-cron", owner_id)

        assert cron is None


# ============================================================================
# Scheduler Tests
# ============================================================================


class TestCronScheduler:
    """Tests for CronScheduler."""

    def test_scheduler_initialization(self):
        """Test scheduler initializes correctly."""
        scheduler = CronScheduler()
        assert scheduler._scheduler is None
        assert scheduler._started is False

    def test_scheduler_start_sets_flag(self):
        """Test scheduler start sets flag correctly (mocked)."""
        scheduler = CronScheduler()
        # Mock the underlying APScheduler to avoid event loop issues
        mock_apscheduler = MagicMock()
        scheduler._scheduler = mock_apscheduler

        scheduler.start()

        assert scheduler._started is True
        mock_apscheduler.start.assert_called_once()

    def test_scheduler_start_idempotent(self):
        """Test scheduler start is idempotent."""
        scheduler = CronScheduler()
        mock_apscheduler = MagicMock()
        scheduler._scheduler = mock_apscheduler

        scheduler.start()
        scheduler.start()  # Should not call start again
        assert scheduler._started is True
        # Only called once due to idempotency
        mock_apscheduler.start.assert_called_once()

    def test_scheduler_shutdown(self):
        """Test scheduler shutdown."""
        scheduler = CronScheduler()
        mock_apscheduler = MagicMock()
        scheduler._scheduler = mock_apscheduler
        scheduler._started = True

        scheduler.shutdown(wait=False)

        assert scheduler._started is False
        mock_apscheduler.shutdown.assert_called_once_with(wait=False)

    async def test_add_cron_job(self, owner_id, assistant_id):
        """Test adding a cron job."""
        scheduler = CronScheduler()
        mock_apscheduler = MagicMock()
        mock_job = MagicMock()
        mock_job.id = "cron-123"
        mock_apscheduler.add_job.return_value = mock_job
        scheduler._scheduler = mock_apscheduler
        scheduler._started = True

        now = datetime.now(timezone.utc)
        cron = Cron(
            cron_id="cron-123",
            assistant_id=assistant_id,
            thread_id="thread-123",
            schedule="*/5 * * * *",
            created_at=now,
            updated_at=now,
            payload={"assistant_id": assistant_id},
        )

        job_id = scheduler.add_cron_job(cron, owner_id)

        assert job_id == "cron-123"
        assert "cron-123" in scheduler._job_owner_map
        assert scheduler._job_owner_map["cron-123"] == owner_id

    async def test_remove_cron_job(self, owner_id, assistant_id):
        """Test removing a cron job."""
        scheduler = CronScheduler()
        mock_apscheduler = MagicMock()
        scheduler._scheduler = mock_apscheduler
        scheduler._job_owner_map["cron-123"] = owner_id

        result = scheduler.remove_cron_job("cron-123")

        assert result is True
        assert "cron-123" not in scheduler._job_owner_map
        mock_apscheduler.remove_job.assert_called_once_with("cron-123")

    def test_remove_nonexistent_job(self):
        """Test removing non-existent job handles gracefully."""
        scheduler = CronScheduler()
        mock_apscheduler = MagicMock()
        mock_apscheduler.remove_job.side_effect = Exception("Job not found")
        scheduler._scheduler = mock_apscheduler

        result = scheduler.remove_cron_job("nonexistent-job")

        # Should return False when job not found (exception caught)
        assert result is False

    async def test_get_job_info(self, owner_id, assistant_id):
        """Test getting job info."""
        scheduler = CronScheduler()
        mock_apscheduler = MagicMock()
        mock_job = MagicMock()
        mock_job.id = "cron-123"
        mock_job.name = "cron_cron-123"
        mock_job.next_run_time = datetime.now(timezone.utc)
        mock_job.pending = False
        mock_apscheduler.get_job.return_value = mock_job
        scheduler._scheduler = mock_apscheduler

        info = scheduler.get_job_info("cron-123")

        assert info is not None
        assert info["job_id"] == "cron-123"
        assert info["next_run_time"] is not None

    def test_get_job_info_not_found(self):
        """Test getting info for non-existent job."""
        scheduler = CronScheduler()
        mock_apscheduler = MagicMock()
        mock_apscheduler.get_job.return_value = None
        scheduler._scheduler = mock_apscheduler

        info = scheduler.get_job_info("nonexistent-job")

        assert info is None

    async def test_list_jobs(self, owner_id, assistant_id):
        """Test listing all jobs."""
        scheduler = CronScheduler()
        mock_apscheduler = MagicMock()

        # Create mock jobs
        mock_jobs = []
        for i in range(3):
            mock_job = MagicMock()
            mock_job.id = f"cron-{i}"
            mock_job.name = f"cron_cron-{i}"
            mock_job.next_run_time = datetime.now(timezone.utc)
            mock_jobs.append(mock_job)
            scheduler._job_owner_map[f"cron-{i}"] = owner_id

        mock_apscheduler.get_jobs.return_value = mock_jobs
        scheduler._scheduler = mock_apscheduler

        jobs = scheduler.list_jobs()

        assert len(jobs) == 3
        assert all(job["owner_id"] == owner_id for job in jobs)

    def test_parse_cron_schedule_5_fields(self):
        """Test parsing 5-field cron schedule."""
        scheduler = CronScheduler()
        trigger = scheduler._parse_cron_schedule("*/5 * * * *")

        assert trigger is not None

    def test_parse_cron_schedule_6_fields(self):
        """Test parsing 6-field cron schedule (with seconds)."""
        scheduler = CronScheduler()
        trigger = scheduler._parse_cron_schedule("0 */5 * * * *")

        assert trigger is not None

    def test_parse_cron_schedule_invalid(self):
        """Test parsing invalid cron schedule."""
        scheduler = CronScheduler()

        with pytest.raises(ValueError, match="Invalid cron schedule"):
            scheduler._parse_cron_schedule("invalid")


# ============================================================================
# Storage Tests
# ============================================================================


class TestCronStorage:
    """Tests for CronStore in storage."""

    async def test_cron_store_create(self, owner_id):
        """Test creating a cron in storage."""
        storage = get_storage()

        cron_data = {
            "assistant_id": "assistant-123",
            "thread_id": "thread-123",
            "schedule": "*/5 * * * *",
            "payload": {"assistant_id": "assistant-123"},
        }

        cron = await storage.crons.create(cron_data, owner_id)

        assert cron.cron_id is not None
        assert cron.schedule == "*/5 * * * *"
        assert cron.created_at is not None

    async def test_cron_store_get(self, owner_id):
        """Test getting a cron from storage."""
        storage = get_storage()

        cron_data = {
            "assistant_id": "assistant-123",
            "thread_id": "thread-123",
            "schedule": "*/5 * * * *",
            "payload": {"assistant_id": "assistant-123"},
        }

        created = await storage.crons.create(cron_data, owner_id)
        retrieved = await storage.crons.get(created.cron_id, owner_id)

        assert retrieved is not None
        assert retrieved.cron_id == created.cron_id

    async def test_cron_store_get_wrong_owner(self, owner_id):
        """Test getting a cron with wrong owner fails."""
        storage = get_storage()

        cron_data = {
            "assistant_id": "assistant-123",
            "thread_id": "thread-123",
            "schedule": "*/5 * * * *",
            "payload": {"assistant_id": "assistant-123"},
        }

        created = await storage.crons.create(cron_data, owner_id)
        retrieved = await storage.crons.get(created.cron_id, "other-owner")

        assert retrieved is None

    async def test_cron_store_list(self, owner_id):
        """Test listing crons from storage."""
        storage = get_storage()

        for i in range(3):
            cron_data = {
                "assistant_id": f"assistant-{i}",
                "thread_id": f"thread-{i}",
                "schedule": "*/5 * * * *",
                "payload": {"assistant_id": f"assistant-{i}"},
            }
            await storage.crons.create(cron_data, owner_id)

        crons = await storage.crons.list(owner_id)

        assert len(crons) == 3

    async def test_cron_store_list_with_filter(self, owner_id):
        """Test listing crons with filter."""
        storage = get_storage()

        cron_data = {
            "assistant_id": "assistant-123",
            "thread_id": "thread-123",
            "schedule": "*/5 * * * *",
            "payload": {"assistant_id": "assistant-123"},
        }
        await storage.crons.create(cron_data, owner_id)

        # Filter matches
        crons = await storage.crons.list(owner_id, assistant_id="assistant-123")
        assert len(crons) == 1

        # Filter doesn't match
        crons = await storage.crons.list(owner_id, assistant_id="other")
        assert len(crons) == 0

    async def test_cron_store_update(self, owner_id):
        """Test updating a cron in storage."""
        storage = get_storage()

        cron_data = {
            "assistant_id": "assistant-123",
            "thread_id": "thread-123",
            "schedule": "*/5 * * * *",
            "payload": {"assistant_id": "assistant-123"},
        }

        created = await storage.crons.create(cron_data, owner_id)
        next_run = datetime.now(timezone.utc) + timedelta(hours=1)

        updated = await storage.crons.update(
            created.cron_id,
            owner_id,
            {"next_run_date": next_run},
        )

        assert updated is not None
        assert updated.next_run_date == next_run

    async def test_cron_store_delete(self, owner_id):
        """Test deleting a cron from storage."""
        storage = get_storage()

        cron_data = {
            "assistant_id": "assistant-123",
            "thread_id": "thread-123",
            "schedule": "*/5 * * * *",
            "payload": {"assistant_id": "assistant-123"},
        }

        created = await storage.crons.create(cron_data, owner_id)
        deleted = await storage.crons.delete(created.cron_id, owner_id)

        assert deleted is True

        retrieved = await storage.crons.get(created.cron_id, owner_id)
        assert retrieved is None

    async def test_cron_store_count(self, owner_id):
        """Test counting crons in storage."""
        storage = get_storage()

        for i in range(5):
            cron_data = {
                "assistant_id": "assistant-123",
                "thread_id": f"thread-{i}",
                "schedule": "*/5 * * * *",
                "payload": {"assistant_id": "assistant-123"},
            }
            await storage.crons.create(cron_data, owner_id)

        count = await storage.crons.count(owner_id)
        assert count == 5

        # Count with filter
        count = await storage.crons.count(owner_id, assistant_id="assistant-123")
        assert count == 5

        count = await storage.crons.count(owner_id, assistant_id="other")
        assert count == 0


# ============================================================================
# Route Tests
# ============================================================================


class TestCronRoutes:
    """Tests for Cron HTTP routes."""

    @pytest.fixture
    def mock_request(self):
        """Create a mock request object."""

        def _make_request(body=None, path_params=None):
            request = MagicMock()
            request.body = json.dumps(body or {}).encode() if body else b"{}"
            request.path_params = path_params or {}
            return request

        return _make_request

    @pytest.fixture
    def mock_user(self, owner_id):
        """Mock the require_user function."""
        with patch("server.routes.crons.require_user") as mock:
            user = MagicMock()
            user.identity = owner_id
            mock.return_value = user
            yield mock

    @pytest.mark.asyncio
    async def test_create_cron_route(
        self, mock_request, mock_user, owner_id, assistant_id
    ):
        """Test POST /runs/crons route."""
        from server.routes.crons import register_cron_routes

        app = MagicMock()
        handlers = {}

        def capture_route(path):
            def decorator(func):
                handlers[path] = func
                return func

            return decorator

        app.post = capture_route
        app.delete = capture_route
        register_cron_routes(app)

        # Setup handler with mocked scheduler
        handler = get_cron_handler()
        handler._scheduler = MagicMock()
        handler._scheduler.add_cron_job = MagicMock(return_value="job-123")

        request = mock_request(
            body={
                "schedule": "*/5 * * * *",
                "assistant_id": assistant_id,
            }
        )

        response = await handlers["/runs/crons"](request)

        assert response.status_code == 200
        body = json.loads(response.description)
        assert "cron_id" in body
        assert body["schedule"] == "*/5 * * * *"

    @pytest.mark.asyncio
    async def test_search_crons_route(
        self, mock_request, mock_user, owner_id, assistant_id
    ):
        """Test POST /runs/crons/search route."""
        from server.routes.crons import register_cron_routes

        app = MagicMock()
        handlers = {}

        def capture_route(path):
            def decorator(func):
                handlers[path] = func
                return func

            return decorator

        app.post = capture_route
        app.delete = capture_route
        register_cron_routes(app)

        # Create a cron first
        handler = get_cron_handler()
        handler._scheduler = MagicMock()
        handler._scheduler.add_cron_job = MagicMock(return_value="job-123")

        create_data = CronCreate(
            schedule="*/5 * * * *",
            assistant_id=assistant_id,
        )
        await handler.create_cron(create_data, owner_id)

        # Search
        request = mock_request(body={"limit": 10})
        response = await handlers["/runs/crons/search"](request)

        assert response.status_code == 200
        body = json.loads(response.description)
        assert isinstance(body, list)
        assert len(body) == 1

    @pytest.mark.asyncio
    async def test_count_crons_route(
        self, mock_request, mock_user, owner_id, assistant_id
    ):
        """Test POST /runs/crons/count route."""
        from server.routes.crons import register_cron_routes

        app = MagicMock()
        handlers = {}

        def capture_route(path):
            def decorator(func):
                handlers[path] = func
                return func

            return decorator

        app.post = capture_route
        app.delete = capture_route
        register_cron_routes(app)

        # Create crons first
        handler = get_cron_handler()
        handler._scheduler = MagicMock()
        handler._scheduler.add_cron_job = MagicMock(return_value="job-123")

        for i in range(3):
            create_data = CronCreate(
                schedule=f"*/{i + 1} * * * *",
                assistant_id=assistant_id,
            )
            await handler.create_cron(create_data, owner_id)

        # Count
        request = mock_request(body={})
        response = await handlers["/runs/crons/count"](request)

        assert response.status_code == 200
        body = json.loads(response.description)
        assert body == 3

    @pytest.mark.asyncio
    async def test_delete_cron_route(
        self, mock_request, mock_user, owner_id, assistant_id
    ):
        """Test DELETE /runs/crons/{cron_id} route."""
        from server.routes.crons import register_cron_routes

        app = MagicMock()
        handlers = {}

        def capture_route(path):
            def decorator(func):
                handlers[path] = func
                return func

            return decorator

        app.post = capture_route
        app.delete = capture_route
        register_cron_routes(app)

        # Create a cron first
        handler = get_cron_handler()
        handler._scheduler = MagicMock()
        handler._scheduler.add_cron_job = MagicMock(return_value="job-123")
        handler._scheduler.remove_cron_job = MagicMock(return_value=True)

        create_data = CronCreate(
            schedule="*/5 * * * *",
            assistant_id=assistant_id,
        )
        cron = await handler.create_cron(create_data, owner_id)

        # Delete
        request = mock_request(path_params={"cron_id": cron.cron_id})
        response = await handlers["/runs/crons/:cron_id"](request)

        assert response.status_code == 200

    @pytest.mark.asyncio
    async def test_delete_cron_not_found(self, mock_request, mock_user):
        """Test DELETE /runs/crons/{cron_id} with non-existent cron."""
        from server.routes.crons import register_cron_routes

        app = MagicMock()
        handlers = {}

        def capture_route(path):
            def decorator(func):
                handlers[path] = func
                return func

            return decorator

        app.post = capture_route
        app.delete = capture_route
        register_cron_routes(app)

        request = mock_request(path_params={"cron_id": "nonexistent-cron"})
        response = await handlers["/runs/crons/:cron_id"](request)

        assert response.status_code == 404

    @pytest.mark.asyncio
    async def test_create_cron_invalid_body(self, mock_request, mock_user):
        """Test POST /runs/crons with invalid body."""
        from server.routes.crons import register_cron_routes

        app = MagicMock()
        handlers = {}

        def capture_route(path):
            def decorator(func):
                handlers[path] = func
                return func

            return decorator

        app.post = capture_route
        app.delete = capture_route
        register_cron_routes(app)

        # Missing required fields
        request = mock_request(body={"schedule": "*/5 * * * *"})
        response = await handlers["/runs/crons"](request)

        assert response.status_code == 422

    @pytest.mark.asyncio
    async def test_create_cron_auth_required(self, mock_request):
        """Test POST /runs/crons requires authentication."""
        from server.auth import AuthenticationError
        from server.routes.crons import register_cron_routes

        app = MagicMock()
        handlers = {}

        def capture_route(path):
            def decorator(func):
                handlers[path] = func
                return func

            return decorator

        app.post = capture_route
        app.delete = capture_route
        register_cron_routes(app)

        with patch("server.routes.crons.require_user") as mock:
            mock.side_effect = AuthenticationError("Unauthorized")

            request = mock_request(
                body={
                    "schedule": "*/5 * * * *",
                    "assistant_id": "assistant-123",
                }
            )
            response = await handlers["/runs/crons"](request)

            assert response.status_code == 401
