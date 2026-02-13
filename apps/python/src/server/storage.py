"""In-memory storage layer for Robyn server resources.

This module provides owner-scoped CRUD operations for:
- Assistants
- Threads
- Runs
- Store Items (key-value storage)
- Crons

All operations enforce owner isolation via metadata.owner filtering.
All methods are async to support both in-memory and Postgres backends.
The storage can be swapped for Postgres/Supabase persistence via
``get_storage()`` which checks ``is_postgres_enabled()``.
"""

import logging
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any, Generic, TypeVar
from uuid import uuid4

from pydantic import BaseModel

from server.models import Assistant, AssistantConfig, Run, Thread, ThreadState

if TYPE_CHECKING:
    from server.crons.schemas import Cron

logger = logging.getLogger(__name__)

#: Owner ID used for system-synced assistants (startup agent sync).
#: Assistants created with this owner are visible to all authenticated users
#: but can only be mutated (update/delete) by the system itself.
SYSTEM_OWNER_ID = "system"

# Type variable for generic store - bound to BaseModel for type safety
T = TypeVar("T", bound="BaseModel")


def generate_id() -> str:
    """Generate a unique resource ID.

    Returns:
        UUID hex string (32 characters, no dashes)
    """
    return uuid4().hex


def utc_now() -> datetime:
    """Get current UTC datetime.

    Returns:
        Timezone-aware datetime in UTC
    """
    return datetime.now(timezone.utc)


# ============================================================================
# Base Store
# ============================================================================


class BaseStore(Generic[T]):
    """Generic base store with common CRUD logic.

    All operations enforce owner isolation by checking metadata.owner.
    All public methods are async for compatibility with Postgres backends.
    """

    def __init__(self, id_field: str = "id"):
        """Initialize the store.

        Args:
            id_field: Name of the ID field for the resource type
        """
        self._data: dict[str, dict[str, Any]] = {}
        self._id_field = id_field

    def _get_owner(self, resource_data: dict[str, Any]) -> str | None:
        """Extract owner from resource metadata.

        Args:
            resource_data: Raw resource data dict

        Returns:
            Owner ID or None if not set
        """
        metadata = resource_data.get("metadata", {})
        return metadata.get("owner")

    def _matches_filters(
        self, resource_data: dict[str, Any], filters: dict[str, Any]
    ) -> bool:
        """Check if resource matches all filters.

        Args:
            resource_data: Raw resource data dict
            filters: Key-value filters to match

        Returns:
            True if all filters match
        """
        for key, value in filters.items():
            if resource_data.get(key) != value:
                return False
        return True

    def _to_model(self, data: dict[str, Any]) -> T:
        """Convert raw data to model instance.

        Override in subclasses to return the correct model type.
        """
        raise NotImplementedError

    async def create(self, data: dict[str, Any], owner_id: str) -> T:
        """Create a new resource with owner stamping.

        Args:
            data: Resource data (without ID or timestamps)
            owner_id: ID of the owner (from authenticated user)

        Returns:
            Created resource instance
        """
        resource_id = data.get(self._id_field, generate_id())
        now = utc_now()

        # Ensure metadata exists and stamp owner
        metadata = data.get("metadata", {}).copy()
        metadata["owner"] = owner_id

        # Build full resource data
        resource_data = {
            **data,
            self._id_field: resource_id,
            "metadata": metadata,
            "created_at": now,
            "updated_at": now,
        }

        self._data[resource_id] = resource_data
        logger.debug(f"Created {self.__class__.__name__} resource: {resource_id}")

        return self._to_model(resource_data)

    async def get(self, resource_id: str, owner_id: str) -> T | None:
        """Get a resource by ID if owned by the user.

        Args:
            resource_id: Resource ID to fetch
            owner_id: ID of the requesting user

        Returns:
            Resource instance if found and owned, None otherwise
        """
        resource_data = self._data.get(resource_id)
        if resource_data is None:
            return None

        # Check owner
        if self._get_owner(resource_data) != owner_id:
            logger.debug(f"Access denied: {resource_id} not owned by {owner_id}")
            return None

        return self._to_model(resource_data)

    async def list(self, owner_id: str, **filters: Any) -> list[T]:
        """List resources owned by the user.

        Args:
            owner_id: ID of the requesting user
            **filters: Additional equality filters (e.g., thread_id=...)

        Returns:
            List of matching resources
        """
        results = []
        for resource_data in self._data.values():
            # Check owner
            if self._get_owner(resource_data) != owner_id:
                continue

            # Check additional filters
            if not self._matches_filters(resource_data, filters):
                continue

            results.append(self._to_model(resource_data))

        return results

    async def update(
        self, resource_id: str, data: dict[str, Any], owner_id: str
    ) -> T | None:
        """Update a resource if owned by the user.

        Args:
            resource_id: Resource ID to update
            data: Fields to update (partial update)
            owner_id: ID of the requesting user

        Returns:
            Updated resource instance if found and owned, None otherwise
        """
        resource_data = self._data.get(resource_id)
        if resource_data is None:
            return None

        # Check owner
        if self._get_owner(resource_data) != owner_id:
            logger.debug(f"Update denied: {resource_id} not owned by {owner_id}")
            return None

        # Update fields (except ID, owner, and created_at)
        for key, value in data.items():
            if key in (self._id_field, "created_at"):
                continue
            if key == "metadata":
                # Merge metadata but preserve owner
                current_metadata = resource_data.get("metadata", {})
                new_metadata = {**current_metadata, **value}
                new_metadata["owner"] = owner_id  # Ensure owner can't be changed
                resource_data["metadata"] = new_metadata
            else:
                resource_data[key] = value

        resource_data["updated_at"] = utc_now()
        self._data[resource_id] = resource_data

        logger.debug(f"Updated {self.__class__.__name__} resource: {resource_id}")
        return self._to_model(resource_data)

    async def delete(self, resource_id: str, owner_id: str) -> bool:
        """Delete a resource if owned by the user.

        Args:
            resource_id: Resource ID to delete
            owner_id: ID of the requesting user

        Returns:
            True if deleted, False if not found or not owned
        """
        resource_data = self._data.get(resource_id)
        if resource_data is None:
            return False

        # Check owner
        if self._get_owner(resource_data) != owner_id:
            logger.debug(f"Delete denied: {resource_id} not owned by {owner_id}")
            return False

        del self._data[resource_id]
        logger.debug(f"Deleted {self.__class__.__name__} resource: {resource_id}")
        return True

    async def count(self, owner_id: str, **filters: Any) -> int:
        """Count resources owned by the user.

        Args:
            owner_id: ID of the requesting user
            **filters: Additional equality filters

        Returns:
            Count of matching resources
        """
        return len(await self.list(owner_id, **filters))

    async def clear(self) -> None:
        """Clear all data (for testing only)."""
        self._data.clear()


# ============================================================================
# Assistant Store
# ============================================================================


class AssistantStore(BaseStore[Assistant]):
    """Store for Assistant resources."""

    def __init__(self):
        super().__init__(id_field="assistant_id")

    def _to_model(self, data: dict[str, Any]) -> Assistant:
        """Convert raw data to Assistant model."""
        config_data = data.get("config", {})
        if isinstance(config_data, AssistantConfig):
            config = config_data
        else:
            # Build AssistantConfig from dict
            config = AssistantConfig(
                tags=config_data.get("tags", []),
                recursion_limit=config_data.get("recursion_limit", 25),
                configurable=config_data.get("configurable", {}),
            )

        return Assistant(
            assistant_id=data["assistant_id"],
            graph_id=data["graph_id"],
            config=config,
            context=data.get("context", {}),
            metadata=data.get("metadata", {}),
            name=data.get("name"),
            description=data.get("description"),
            version=data.get("version", 1),
            created_at=data["created_at"],
            updated_at=data["updated_at"],
        )

    async def create(self, data: dict[str, Any], owner_id: str) -> Assistant:
        """Create a new assistant.

        Args:
            data: Assistant data with required 'graph_id'
            owner_id: ID of the owner

        Returns:
            Created Assistant instance

        Raises:
            ValueError: If graph_id is missing
        """
        if "graph_id" not in data:
            raise ValueError("graph_id is required")

        # Set default version
        if "version" not in data:
            data = {**data, "version": 1}

        return await super().create(data, owner_id)

    async def get(self, resource_id: str, owner_id: str) -> Assistant | None:
        """Get an assistant by ID, including system-synced assistants.

        System-owned assistants (created by startup agent sync) are visible
        to all authenticated users.  This override relaxes the strict owner
        check from ``BaseStore.get()`` for read access only.

        Args:
            resource_id: Assistant ID to fetch.
            owner_id: ID of the requesting user.

        Returns:
            Assistant if found and accessible, None otherwise.
        """
        resource_data = self._data.get(resource_id)
        if resource_data is None:
            return None

        resource_owner = self._get_owner(resource_data)
        if resource_owner == owner_id or resource_owner == SYSTEM_OWNER_ID:
            return self._to_model(resource_data)

        logger.debug("Access denied: %s not owned by %s", resource_id, owner_id)
        return None

    async def list(self, owner_id: str, **filters: Any) -> list[Assistant]:
        """List assistants owned by the user plus system-synced assistants.

        System-owned assistants are included so that real users can discover
        assistants that were synced from Supabase at startup.

        Args:
            owner_id: ID of the requesting user.
            **filters: Additional equality filters (e.g., ``graph_id=...``).

        Returns:
            List of matching assistants (own + system).
        """
        results: list[Assistant] = []
        for resource_data in self._data.values():
            resource_owner = self._get_owner(resource_data)
            if resource_owner != owner_id and resource_owner != SYSTEM_OWNER_ID:
                continue
            if not self._matches_filters(resource_data, filters):
                continue
            results.append(self._to_model(resource_data))
        return results

    async def update(
        self, resource_id: str, data: dict[str, Any], owner_id: str
    ) -> Assistant | None:
        """Update an assistant, incrementing version on changes.

        Args:
            resource_id: Assistant ID to update
            data: Fields to update
            owner_id: ID of the requesting user

        Returns:
            Updated Assistant instance if found and owned, None otherwise
        """
        # Get current assistant to increment version
        current = self._data.get(resource_id)
        if current is not None and self._get_owner(current) == owner_id:
            current_version = current.get("version", 1)
            data = {**data, "version": current_version + 1}

        return await super().update(resource_id, data, owner_id)


# ============================================================================
# Thread Store
# ============================================================================


class ThreadStore(BaseStore[Thread]):
    """Store for Thread resources with state history tracking."""

    def __init__(self):
        super().__init__(id_field="thread_id")
        # Separate storage for state history (thread_id -> list of ThreadState snapshots)
        self._history: dict[str, list[dict[str, Any]]] = {}

    def _to_model(self, data: dict[str, Any]) -> Thread:
        """Convert raw data to Thread model."""
        return Thread(
            thread_id=data["thread_id"],
            metadata=data.get("metadata", {}),
            config=data.get("config", {}),
            status=data.get("status", "idle"),
            values=data.get("values", {}),
            interrupts=data.get("interrupts", {}),
            created_at=data["created_at"],
            updated_at=data["updated_at"],
        )

    async def create(self, data: dict[str, Any], owner_id: str) -> Thread:
        """Create a new thread with initial empty state history.

        Args:
            data: Thread data
            owner_id: ID of the owner

        Returns:
            Created Thread instance
        """
        thread = await super().create(data, owner_id)
        # Initialize empty history for this thread
        self._history[thread.thread_id] = []
        return thread

    async def delete(self, resource_id: str, owner_id: str) -> bool:
        """Delete a thread and its state history.

        Args:
            resource_id: Thread ID to delete
            owner_id: ID of the requesting user

        Returns:
            True if deleted, False if not found or not owned
        """
        deleted = await super().delete(resource_id, owner_id)
        if deleted:
            # Clean up history
            self._history.pop(resource_id, None)
        return deleted

    async def get_state(self, thread_id: str, owner_id: str) -> ThreadState | None:
        """Get the current state of a thread.

        Args:
            thread_id: Thread ID
            owner_id: ID of the requesting user

        Returns:
            ThreadState if thread exists and is owned, None otherwise
        """
        thread_data = self._data.get(thread_id)
        if thread_data is None:
            return None

        # Check owner
        if self._get_owner(thread_data) != owner_id:
            return None

        # Build ThreadState from current thread values
        now = utc_now()
        return ThreadState(
            values=thread_data.get("values", {}),
            next=[],  # No pending nodes in basic implementation
            tasks=[],
            checkpoint={
                "thread_id": thread_id,
                "checkpoint_ns": "",
                "checkpoint_id": thread_data.get("checkpoint_id", generate_id()),
            },
            metadata=thread_data.get("metadata", {}),
            created_at=now.isoformat().replace("+00:00", "Z"),
            parent_checkpoint=None,
            interrupts=[],
        )

    async def add_state_snapshot(
        self, thread_id: str, state: dict[str, Any], owner_id: str
    ) -> bool:
        """Add a state snapshot to the thread's history.

        Args:
            thread_id: Thread ID
            state: State snapshot to add
            owner_id: ID of the requesting user

        Returns:
            True if added, False if thread not found or not owned
        """
        thread_data = self._data.get(thread_id)
        if thread_data is None:
            return False

        # Check owner
        if self._get_owner(thread_data) != owner_id:
            return False

        # Add to history
        if thread_id not in self._history:
            self._history[thread_id] = []

        snapshot = {
            **state,
            "created_at": utc_now().isoformat().replace("+00:00", "Z"),
            "checkpoint_id": generate_id(),
        }
        self._history[thread_id].append(snapshot)

        # Update thread's current values
        thread_data["values"] = state.get("values", {})
        thread_data["updated_at"] = utc_now()
        self._data[thread_id] = thread_data

        return True

    async def get_history(
        self, thread_id: str, owner_id: str, limit: int = 10, before: str | None = None
    ) -> list[ThreadState] | None:
        """Get state history for a thread.

        Args:
            thread_id: Thread ID
            owner_id: ID of the requesting user
            limit: Maximum number of states to return
            before: Return states before this checkpoint ID

        Returns:
            List of ThreadState if thread exists and is owned, None otherwise
        """
        thread_data = self._data.get(thread_id)
        if thread_data is None:
            return None

        # Check owner
        if self._get_owner(thread_data) != owner_id:
            return None

        history = self._history.get(thread_id, [])

        # If before is specified, filter
        if before:
            filtered = []
            for snapshot in history:
                if snapshot.get("checkpoint_id") == before:
                    break
                filtered.append(snapshot)
            history = filtered

        # Return most recent first, limited
        history = list(reversed(history))[:limit]

        # Convert to ThreadState objects
        result = []
        for snapshot in history:
            result.append(
                ThreadState(
                    values=snapshot.get("values", {}),
                    next=snapshot.get("next", []),
                    tasks=snapshot.get("tasks", []),
                    checkpoint={
                        "thread_id": thread_id,
                        "checkpoint_ns": "",
                        "checkpoint_id": snapshot.get("checkpoint_id", ""),
                    },
                    metadata=snapshot.get("metadata", {}),
                    created_at=snapshot.get("created_at"),
                    parent_checkpoint=snapshot.get("parent_checkpoint"),
                    interrupts=snapshot.get("interrupts", []),
                )
            )

        return result

    async def clear(self) -> None:
        """Clear all data including history (for testing only)."""
        await super().clear()
        self._history.clear()


# ============================================================================
# Run Store
# ============================================================================


class RunStore(BaseStore[Run]):
    """Store for Run resources with thread filtering support."""

    def __init__(self):
        super().__init__(id_field="run_id")

    def _to_model(self, data: dict[str, Any]) -> Run:
        """Convert raw data to Run model."""
        return Run(
            run_id=data["run_id"],
            thread_id=data["thread_id"],
            assistant_id=data["assistant_id"],
            status=data.get("status", "pending"),
            metadata=data.get("metadata", {}),
            kwargs=data.get("kwargs", {}),
            multitask_strategy=data.get("multitask_strategy", "reject"),
            created_at=data["created_at"],
            updated_at=data["updated_at"],
        )

    async def create(self, data: dict[str, Any], owner_id: str) -> Run:
        """Create a new run.

        Args:
            data: Run data with required 'thread_id' and 'assistant_id'
            owner_id: ID of the owner

        Returns:
            Created Run instance

        Raises:
            ValueError: If thread_id or assistant_id is missing
        """
        if "thread_id" not in data:
            raise ValueError("thread_id is required")
        if "assistant_id" not in data:
            raise ValueError("assistant_id is required")

        # Default status
        if "status" not in data:
            data = {**data, "status": "pending"}

        return await super().create(data, owner_id)

    async def list_by_thread(
        self,
        thread_id: str,
        owner_id: str,
        limit: int = 10,
        offset: int = 0,
        status: str | None = None,
    ) -> list[Run]:
        """List runs for a specific thread with pagination and filtering.

        Args:
            thread_id: Thread ID to filter by
            owner_id: ID of the requesting user
            limit: Maximum number of runs to return
            offset: Number of runs to skip
            status: Optional status filter

        Returns:
            List of runs for the thread
        """
        runs = await self.list(owner_id, thread_id=thread_id)

        # Apply status filter
        if status:
            runs = [r for r in runs if r.status == status]

        # Sort by created_at descending (most recent first)
        runs = sorted(runs, key=lambda r: r.created_at, reverse=True)

        # Apply pagination
        return runs[offset : offset + limit]

    async def get_by_thread(
        self, thread_id: str, run_id: str, owner_id: str
    ) -> Run | None:
        """Get a specific run by thread_id and run_id.

        Args:
            thread_id: Thread ID the run belongs to
            run_id: Run ID to fetch
            owner_id: ID of the requesting user

        Returns:
            Run if found, owned, and belongs to thread, None otherwise
        """
        run = await self.get(run_id, owner_id)
        if run is None:
            return None

        # Verify run belongs to the specified thread
        if run.thread_id != thread_id:
            return None

        return run

    async def delete_by_thread(
        self, thread_id: str, run_id: str, owner_id: str
    ) -> bool:
        """Delete a run by thread_id and run_id.

        Args:
            thread_id: Thread ID the run belongs to
            run_id: Run ID to delete
            owner_id: ID of the requesting user

        Returns:
            True if deleted, False if not found or not owned
        """
        # First verify the run belongs to the thread
        run = await self.get_by_thread(thread_id, run_id, owner_id)
        if run is None:
            return False

        return await self.delete(run_id, owner_id)

    async def get_active_run(self, thread_id: str, owner_id: str) -> Run | None:
        """Get the currently active (pending or running) run for a thread.

        Args:
            thread_id: Thread ID to check
            owner_id: ID of the requesting user

        Returns:
            Active Run if one exists, None otherwise
        """
        runs = await self.list(owner_id, thread_id=thread_id)
        for run in runs:
            if run.status in ("pending", "running"):
                return run
        return None

    async def update_status(
        self, run_id: str, status: str, owner_id: str
    ) -> Run | None:
        """Update run status.

        Args:
            run_id: Run ID to update
            status: New status value
            owner_id: ID of the requesting user

        Returns:
            Updated Run instance if found and owned, None otherwise
        """
        return await self.update(run_id, {"status": status}, owner_id)

    async def count_by_thread(self, thread_id: str, owner_id: str) -> int:
        """Count runs for a specific thread.

        Args:
            thread_id: Thread ID to count runs for
            owner_id: ID of the requesting user

        Returns:
            Number of runs for the thread
        """
        return len(await self.list(owner_id, thread_id=thread_id))


# ============================================================================
# Store Storage (Key-Value)
# ============================================================================


class StoreItem:
    """Represents a stored item in the Store API."""

    def __init__(
        self,
        namespace: str,
        key: str,
        value: Any,
        owner_id: str,
        metadata: dict[str, Any] | None = None,
    ):
        self.namespace = namespace
        self.key = key
        self.value = value
        self.owner_id = owner_id
        self.metadata = metadata or {}
        self.created_at = utc_now()
        self.updated_at = utc_now()

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary representation."""
        return {
            "namespace": self.namespace,
            "key": self.key,
            "value": self.value,
            "metadata": self.metadata,
            "created_at": self.created_at.isoformat(),
            "updated_at": self.updated_at.isoformat(),
        }


class StoreStorage:
    """Storage for key-value items (Store API).

    Items are organized by namespace and key, with owner isolation.
    All public methods are async for compatibility with Postgres backends.
    """

    def __init__(self):
        # Structure: {owner_id: {namespace: {key: StoreItem}}}
        self._items: dict[str, dict[str, dict[str, StoreItem]]] = {}

    async def put(
        self,
        namespace: str,
        key: str,
        value: Any,
        owner_id: str,
        metadata: dict[str, Any] | None = None,
    ) -> StoreItem:
        """Store or update an item.

        Args:
            namespace: Namespace for the item
            key: Key within the namespace
            value: Value to store (JSON-serializable)
            owner_id: Owner ID for isolation
            metadata: Optional metadata

        Returns:
            The stored item
        """
        if owner_id not in self._items:
            self._items[owner_id] = {}
        if namespace not in self._items[owner_id]:
            self._items[owner_id][namespace] = {}

        # Check if item exists (update) or new (create)
        if key in self._items[owner_id][namespace]:
            item = self._items[owner_id][namespace][key]
            item.value = value
            item.updated_at = utc_now()
            if metadata is not None:
                item.metadata = metadata
        else:
            item = StoreItem(
                namespace=namespace,
                key=key,
                value=value,
                owner_id=owner_id,
                metadata=metadata,
            )
            self._items[owner_id][namespace][key] = item

        return item

    async def get(
        self,
        namespace: str,
        key: str,
        owner_id: str,
    ) -> StoreItem | None:
        """Get an item by namespace and key.

        Args:
            namespace: Namespace for the item
            key: Key within the namespace
            owner_id: Owner ID for isolation

        Returns:
            The item or None if not found
        """
        owner_store = self._items.get(owner_id, {})
        namespace_store = owner_store.get(namespace, {})
        return namespace_store.get(key)

    async def delete(
        self,
        namespace: str,
        key: str,
        owner_id: str,
    ) -> bool:
        """Delete an item.

        Args:
            namespace: Namespace for the item
            key: Key within the namespace
            owner_id: Owner ID for isolation

        Returns:
            True if deleted, False if not found
        """
        owner_store = self._items.get(owner_id, {})
        namespace_store = owner_store.get(namespace, {})
        if key in namespace_store:
            del namespace_store[key]
            return True
        return False

    async def search(
        self,
        namespace: str,
        owner_id: str,
        prefix: str | None = None,
        limit: int = 10,
        offset: int = 0,
    ) -> list[StoreItem]:
        """Search items in a namespace.

        Args:
            namespace: Namespace to search
            owner_id: Owner ID for isolation
            prefix: Optional key prefix filter
            limit: Maximum number of results
            offset: Number of results to skip

        Returns:
            List of matching items
        """
        owner_store = self._items.get(owner_id, {})
        namespace_store = owner_store.get(namespace, {})

        items = list(namespace_store.values())

        # Apply prefix filter
        if prefix:
            items = [item for item in items if item.key.startswith(prefix)]

        # Sort by key for consistent ordering
        items.sort(key=lambda x: x.key)

        # Apply pagination
        return items[offset : offset + limit]

    async def list_namespaces(self, owner_id: str) -> list[str]:
        """List all namespaces for an owner.

        Args:
            owner_id: Owner ID for isolation

        Returns:
            List of namespace names
        """
        owner_store = self._items.get(owner_id, {})
        return list(owner_store.keys())

    async def clear(self) -> None:
        """Clear all items (for testing only)."""
        self._items.clear()


# ============================================================================
# Cron Store
# ============================================================================


class CronStore(BaseStore["Cron"]):
    """Store for cron job resources.

    Manages scheduled cron jobs with owner isolation.
    """

    def __init__(self):
        super().__init__(id_field="cron_id")

    def _to_model(self, data: dict[str, Any]) -> "Cron":
        """Convert raw data to Cron model."""
        from server.crons.schemas import Cron

        return Cron(
            cron_id=data["cron_id"],
            assistant_id=data.get("assistant_id"),
            thread_id=data["thread_id"],
            end_time=data.get("end_time"),
            schedule=data["schedule"],
            created_at=data["created_at"],
            updated_at=data["updated_at"],
            user_id=data.get("user_id"),
            payload=data.get("payload", {}),
            next_run_date=data.get("next_run_date"),
            metadata=data.get("metadata", {}),
        )

    async def create(self, data: dict[str, Any], owner_id: str) -> "Cron":
        """Create a new cron with owner stamping.

        Args:
            data: Cron data including schedule, assistant_id, etc.
            owner_id: ID of the owner

        Returns:
            Created Cron instance
        """
        resource_id = generate_id()
        now = utc_now()

        # Ensure metadata exists and stamp owner
        metadata = data.get("metadata", {}).copy()
        metadata["owner"] = owner_id

        # Build full resource data
        resource_data = {
            **data,
            "cron_id": resource_id,
            "metadata": metadata,
            "created_at": now,
            "updated_at": now,
        }

        self._data[resource_id] = resource_data
        logger.debug(f"Created cron: {resource_id}")

        return self._to_model(resource_data)

    async def update(
        self,
        cron_id: str,
        owner_id: str,
        updates: dict[str, Any],
    ) -> "Cron | None":
        """Update a cron job.

        Args:
            cron_id: ID of the cron to update
            owner_id: ID of the requesting user
            updates: Fields to update

        Returns:
            Updated Cron or None if not found
        """
        resource_data = self._data.get(cron_id)
        if resource_data is None:
            return None

        # Check owner
        if self._get_owner(resource_data) != owner_id:
            logger.debug(f"Access denied: cron {cron_id} not owned by {owner_id}")
            return None

        # Apply updates
        resource_data.update(updates)
        resource_data["updated_at"] = utc_now()

        self._data[cron_id] = resource_data
        logger.debug(f"Updated cron: {cron_id}")

        return self._to_model(resource_data)

    async def count(self, owner_id: str, **filters: Any) -> int:
        """Count crons matching filters.

        Args:
            owner_id: ID of the requesting user
            **filters: Additional equality filters

        Returns:
            Count of matching crons
        """
        count = 0
        for resource_data in self._data.values():
            # Check owner
            if self._get_owner(resource_data) != owner_id:
                continue

            # Check additional filters
            if not self._matches_filters(resource_data, filters):
                continue

            count += 1

        return count


# ============================================================================
# Storage Container
# ============================================================================


class Storage:
    """Container for all resource stores.

    Provides a single access point for all storage operations.
    """

    def __init__(self):
        self.assistants = AssistantStore()
        self.threads = ThreadStore()
        self.runs = RunStore()
        self.store = StoreStorage()
        self.crons = CronStore()

    async def clear_all(self) -> None:
        """Clear all stores (for testing only)."""
        await self.assistants.clear()
        await self.threads.clear()
        await self.runs.clear()
        await self.store.clear()
        await self.crons.clear()


# ============================================================================
# Module-Level Access
# ============================================================================

# Global storage instance
_storage: Storage | None = None


def get_storage() -> Storage:
    """Get the global storage instance.

    Returns PostgresStorage if DATABASE_URL is configured and Postgres
    is initialised, otherwise returns in-memory Storage.

    Returns:
        Storage instance with all stores
    """
    global _storage
    if _storage is None:
        from server.database import get_connection, is_postgres_enabled

        if is_postgres_enabled():
            from server.postgres_storage import PostgresStorage

            _storage = PostgresStorage(get_connection)
            logger.info("Using Postgres-backed storage")
        else:
            _storage = Storage()
    return _storage


def reset_storage() -> None:
    """Reset the global storage instance (for testing only)."""
    global _storage
    _storage = None
