"""Proof-of-bug tests for Goal 18: Assistant Config Propagation.

These tests demonstrate the two bugs that prevent synced assistants from
reaching real users at runtime:

Bug 1 — ``create()`` ignores caller-provided ``assistant_id``
    The in-memory ``AssistantStore.create()`` (and ``PostgresAssistantStore``)
    always calls ``generate_id()``/``_generate_id()``, discarding any
    ``assistant_id`` passed in ``data``.  Agent sync relies on deterministic
    IDs so that the ``langgraph_assistant_id`` written back to Supabase
    matches the ID actually stored.

Bug 2 — Owner scoping hides system-synced assistants from real users
    Startup sync creates assistants with ``owner_id="system"``.  Both
    ``get()`` and ``list()`` filter ``metadata.owner == <requesting_user>``,
    so a real user (e.g. ``"user-abc"``) never sees system-owned assistants.

Both tests are written to **fail on the current (unfixed) code** and
**pass once the bugs are resolved**.
"""

from server.storage import AssistantStore


# ---------------------------------------------------------------------------
# Bug 1: create() ignores caller-provided assistant_id
# ---------------------------------------------------------------------------


class TestBug01DeterministicAssistantId:
    """Verify that ``create()`` honours ``data['assistant_id']``."""

    async def test_create_uses_provided_assistant_id(self):
        """When ``assistant_id`` is in the payload, the stored assistant
        must use that exact ID — not a randomly generated one.

        This is the mechanism ``agent_sync`` relies on: it passes the
        Supabase agent UUID as ``assistant_id`` so that the runtime can
        later look it up by that same ID.
        """
        store = AssistantStore()
        deterministic_id = "a0000000-0000-4000-a000-000000000001"

        assistant = await store.create(
            {
                "assistant_id": deterministic_id,
                "graph_id": "agent",
                "config": {"configurable": {"model_name": "openai:gpt-4o-mini"}},
            },
            owner_id="system",
        )

        assert assistant.assistant_id == deterministic_id, (
            f"Expected assistant_id={deterministic_id!r}, "
            f"got {assistant.assistant_id!r}.  "
            "Bug 1: create() ignores caller-provided assistant_id."
        )

    async def test_create_without_assistant_id_still_generates(self):
        """When no ``assistant_id`` is supplied the store must still
        auto-generate one (backward compatibility)."""
        store = AssistantStore()

        assistant = await store.create(
            {"graph_id": "agent"},
            owner_id="user-1",
        )

        assert assistant.assistant_id is not None
        assert len(assistant.assistant_id) > 0

    async def test_get_by_deterministic_id_succeeds(self):
        """After creating with a deterministic ID, ``get()`` with that
        same ID must return the assistant."""
        store = AssistantStore()
        deterministic_id = "b0000000-0000-4000-b000-000000000002"

        await store.create(
            {
                "assistant_id": deterministic_id,
                "graph_id": "agent",
            },
            owner_id="system",
        )

        result = await store.get(deterministic_id, owner_id="system")
        assert result is not None, (
            "get() returned None for the deterministic ID we just created. "
            "Bug 1: the assistant was stored under a random ID instead."
        )
        assert result.assistant_id == deterministic_id


# ---------------------------------------------------------------------------
# Bug 2: system-synced assistants invisible to real users
# ---------------------------------------------------------------------------


class TestBug02SystemOwnerVisibility:
    """Verify that assistants created by ``owner_id='system'`` are
    visible to real authenticated users."""

    async def test_real_user_can_get_system_assistant(self):
        """A real user should be able to ``get()`` a system-synced
        assistant by its ID.

        Currently fails because ``get()`` filters
        ``metadata.owner == owner_id`` and ``'user-abc' != 'system'``.
        """
        store = AssistantStore()
        assistant_id = "c0000000-0000-4000-c000-000000000003"

        # Simulate startup sync creating an assistant
        await store.create(
            {
                "assistant_id": assistant_id,
                "graph_id": "agent",
                "config": {"configurable": {"model_name": "openai:gpt-4o-mini"}},
                "metadata": {
                    "supabase_agent_id": assistant_id,
                    "synced_at": "2026-02-14T00:00:00Z",
                },
            },
            owner_id="system",
        )

        # A real user requests the same assistant
        result = await store.get(assistant_id, owner_id="user-abc")
        assert result is not None, (
            "get() returned None for a system-synced assistant when "
            "requested by a real user.  "
            "Bug 2: owner='system' assistants are invisible to real users."
        )
        assert result.assistant_id == assistant_id

    async def test_real_user_can_list_system_assistants(self):
        """``list()`` should include system-synced assistants alongside
        the user's own assistants."""
        store = AssistantStore()

        # System-synced assistant
        await store.create(
            {
                "assistant_id": "d0000000-0000-4000-d000-000000000004",
                "graph_id": "agent",
                "metadata": {"synced_at": "2026-02-14T00:00:00Z"},
            },
            owner_id="system",
        )

        # User's own assistant
        await store.create(
            {"graph_id": "agent", "name": "My Custom Assistant"},
            owner_id="user-abc",
        )

        # The user should see both
        visible = await store.list(owner_id="user-abc")
        assert len(visible) >= 2, (
            f"Expected at least 2 assistants (1 system + 1 own), "
            f"got {len(visible)}.  "
            "Bug 2: system-synced assistants are hidden from real users."
        )

    async def test_system_owner_still_sees_own_assistants(self):
        """The 'system' owner should still see its own assistants
        (sanity check — this already passes)."""
        store = AssistantStore()

        await store.create(
            {"graph_id": "agent"},
            owner_id="system",
        )

        visible = await store.list(owner_id="system")
        assert len(visible) == 1

    async def test_user_cannot_delete_system_assistant(self):
        """Real users should NOT be able to delete system-synced
        assistants — visibility does not imply mutability."""
        store = AssistantStore()
        assistant_id = "e0000000-0000-4000-e000-000000000005"

        await store.create(
            {
                "assistant_id": assistant_id,
                "graph_id": "agent",
            },
            owner_id="system",
        )

        deleted = await store.delete(assistant_id, owner_id="user-abc")
        assert deleted is False, (
            "A real user was able to delete a system-synced assistant. "
            "Visibility should not grant write access."
        )

        # System owner can still see it
        still_exists = await store.get(assistant_id, owner_id="system")
        assert still_exists is not None
