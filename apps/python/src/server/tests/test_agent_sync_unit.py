"""Unit tests for ``server.agent_sync`` with mocked DB and storage.

These tests cover the complete agent sync module without any real database
or external service connections.  All DB interactions and storage calls
are mocked.

Coverage target: ``agent_sync.py`` is 301 statements at 21%.  This file
aims to cover ~70% of the remaining uncovered lines (~170 statements gained).
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from typing import Any
from unittest.mock import MagicMock
from uuid import UUID, uuid4

import pytest

from server.agent_sync import (
    AgentSyncData,
    AgentSyncMcpTool,
    AgentSyncResult,
    AgentSyncScope,
    _add_mcp_tool_from_row,
    _agent_from_row,
    _build_assistant_configurable,
    _build_fetch_agents_sql,
    _coerce_uuid,
    _extract_assistant_configurable,
    _group_agent_rows,
    _safe_mask_url,
    _to_bool_or_none,
    _assistant_payload_for_agent,
    _write_back_langgraph_assistant_id,
    fetch_active_agent_by_id,
    fetch_active_agents,
    lazy_sync_agent,
    parse_agent_sync_scope,
    startup_agent_sync,
    sync_single_agent,
)


# ---------------------------------------------------------------------------
# Mock infrastructure
# ---------------------------------------------------------------------------


class MockCursor:
    """Minimal async cursor."""

    def __init__(
        self,
        rows: list[dict[str, Any]] | None = None,
        rowcount: int = 0,
    ) -> None:
        self._rows = rows or []
        self.rowcount = rowcount

    async def fetchone(self) -> dict[str, Any] | None:
        return self._rows[0] if self._rows else None

    async def fetchall(self) -> list[dict[str, Any]]:
        return self._rows


class MockConnection:
    """Async connection that records executed queries."""

    def __init__(self, cursors: list[MockCursor] | None = None) -> None:
        self.executed: list[tuple[str, Any]] = []
        self._cursors = list(cursors) if cursors else []
        self._call_index = 0

    async def execute(self, query: str, params: Any = None) -> MockCursor:
        self.executed.append((query, params))
        if self._call_index < len(self._cursors):
            cursor = self._cursors[self._call_index]
            self._call_index += 1
            return cursor
        return MockCursor()


def _make_factory(*cursors: MockCursor):
    """Return (factory_callable, connection_ref)."""
    connection = MockConnection(list(cursors))
    refs: list[MockConnection] = [connection]

    @asynccontextmanager
    async def factory():
        yield refs[0]

    return factory, refs


class FakeAssistants:
    """Fake assistant storage for sync tests."""

    def __init__(self) -> None:
        self._store: dict[str, Any] = {}
        self.create_calls: list[tuple[dict, str]] = []
        self.update_calls: list[tuple[str, dict, str]] = []

    async def get(self, assistant_id: str, owner_id: str) -> Any:
        item = self._store.get(assistant_id)
        if item is None:
            return None
        return item

    async def create(self, payload: dict[str, Any], owner_id: str) -> Any:
        self.create_calls.append((payload, owner_id))
        assistant_id = payload.get("assistant_id", "generated-id")
        obj = MagicMock()
        obj.config = MagicMock()
        obj.config.model_dump.return_value = payload.get("config", {})
        obj.metadata = payload.get("metadata", {})
        self._store[assistant_id] = obj
        return obj

    async def update(
        self, assistant_id: str, payload: dict[str, Any], owner_id: str
    ) -> Any:
        self.update_calls.append((assistant_id, payload, owner_id))
        obj = MagicMock()
        obj.config = MagicMock()
        obj.config.model_dump.return_value = payload.get("config", {})
        self._store[assistant_id] = obj
        return obj

    def seed(
        self,
        assistant_id: str,
        config_dict: dict | None = None,
        metadata: dict | None = None,
    ) -> None:
        """Pre-populate an assistant in the fake store."""
        obj = MagicMock()
        obj.config = MagicMock()
        obj.config.model_dump.return_value = config_dict or {}
        obj.metadata = metadata or {}
        self._store[assistant_id] = obj


class FakeStorage:
    """Minimal storage object matching AssistantStorageProtocol."""

    def __init__(self) -> None:
        self.assistants = FakeAssistants()


# ---------------------------------------------------------------------------
# Helpers for building test data
# ---------------------------------------------------------------------------

AGENT_UUID = UUID("a0000000-0000-4000-a000-000000000001")
ORG_UUID = UUID("00000000-0000-4000-0000-000000000099")


def _make_agent(
    agent_id: UUID | None = None,
    organization_id: UUID | None = None,
    name: str | None = "Test Agent",
    system_prompt: str | None = "You are a test agent.",
    runtime_model_name: str | None = "openai:gpt-4o-mini",
    mcp_tools: list[AgentSyncMcpTool] | None = None,
    **kwargs: Any,
) -> AgentSyncData:
    return AgentSyncData(
        agent_id=agent_id or AGENT_UUID,
        organization_id=organization_id or ORG_UUID,
        name=name,
        system_prompt=system_prompt,
        runtime_model_name=runtime_model_name,
        mcp_tools=mcp_tools or [],
        **kwargs,
    )


def _make_agent_row(
    agent_id: str | UUID | None = None,
    organization_id: str | UUID | None = None,
    name: str | None = "Test Agent",
    system_prompt: str | None = "You are a test agent.",
    runtime_model_name: str = "openai:gpt-4o-mini",
    mcp_tool_id: str | None = None,
    mcp_tool_name: str | None = None,
    mcp_endpoint_url: str | None = None,
    mcp_is_builtin: bool | None = None,
    mcp_auth_required: bool | None = None,
    sampling_params: dict[str, Any] | None = None,
    assistant_tool_ids: list[str] | None = None,
    **overrides: Any,
) -> dict[str, Any]:
    row: dict[str, Any] = {
        "agent_id": str(agent_id or AGENT_UUID),
        "organization_id": str(organization_id or ORG_UUID),
        "name": name,
        "system_prompt": system_prompt,
        "sampling_params": sampling_params if sampling_params is not None else {},
        "assistant_tool_ids": assistant_tool_ids
        if assistant_tool_ids is not None
        else [],
        "langgraph_assistant_id": None,
        "graph_id": "agent",
        "runtime_model_name": runtime_model_name,
        "mcp_tool_id": mcp_tool_id,
        "mcp_tool_name": mcp_tool_name,
        "mcp_endpoint_url": mcp_endpoint_url,
        "mcp_is_builtin": mcp_is_builtin,
        "mcp_auth_required": mcp_auth_required,
    }
    row.update(overrides)
    return row


# ============================================================================
# Data model tests
# ============================================================================


class TestAgentSyncMcpTool:
    """Tests for AgentSyncMcpTool model."""

    def test_defaults(self):
        tool = AgentSyncMcpTool()
        assert tool.tool_id is None
        assert tool.tool_name is None
        assert tool.endpoint_url is None
        assert tool.is_builtin is None
        assert tool.auth_required is None

    def test_with_values(self):
        tool_id = uuid4()
        tool = AgentSyncMcpTool(
            tool_id=tool_id,
            tool_name="search",
            endpoint_url="https://mcp.example.com",
            is_builtin=False,
            auth_required=True,
        )
        assert tool.tool_id == tool_id
        assert tool.tool_name == "search"
        assert tool.auth_required is True


class TestAgentSyncData:
    """Tests for AgentSyncData model."""

    def test_minimal(self):
        agent = AgentSyncData(agent_id=AGENT_UUID)
        assert agent.agent_id == AGENT_UUID
        assert agent.organization_id is None
        assert agent.mcp_tools == []
        assert agent.name is None
        assert agent.sampling_params == {}
        assert agent.assistant_tool_ids == []

    def test_full(self):
        agent = _make_agent(
            sampling_params={"temperature": 0.7, "max_tokens": 1024},
            assistant_tool_ids=["id-1", "id-2"],
            graph_id="custom",
        )
        assert agent.sampling_params == {"temperature": 0.7, "max_tokens": 1024}
        assert agent.assistant_tool_ids == ["id-1", "id-2"]
        assert agent.graph_id == "custom"


class TestAgentSyncResult:
    """Tests for AgentSyncResult dataclass."""

    def test_created(self):
        result = AgentSyncResult(assistant_id="abc", action="created")
        assert result.assistant_id == "abc"
        assert result.action == "created"
        assert result.wrote_back_assistant_id is False

    def test_with_write_back(self):
        result = AgentSyncResult(
            assistant_id="abc", action="updated", wrote_back_assistant_id=True
        )
        assert result.wrote_back_assistant_id is True


# ============================================================================
# AgentSyncScope + parse_agent_sync_scope
# ============================================================================


class TestAgentSyncScope:
    """Tests for AgentSyncScope model."""

    def test_none_factory(self):
        scope = AgentSyncScope.none()
        assert scope.type == "none"
        assert scope.organization_ids == []

    def test_all_factory(self):
        scope = AgentSyncScope.all()
        assert scope.type == "all"
        assert scope.organization_ids == []

    def test_orgs_factory(self):
        org1, org2 = uuid4(), uuid4()
        scope = AgentSyncScope.orgs([org1, org2])
        assert scope.type == "org"
        assert scope.organization_ids == [org1, org2]

    def test_orgs_deduplicates(self):
        org = uuid4()
        scope = AgentSyncScope.orgs([org, org, org])
        assert len(scope.organization_ids) == 1


class TestParseAgentSyncScope:
    """Tests for parse_agent_sync_scope()."""

    def test_none_string(self):
        assert parse_agent_sync_scope("none").type == "none"

    def test_none_default(self):
        assert parse_agent_sync_scope(None).type == "none"

    def test_empty_string(self):
        assert parse_agent_sync_scope("").type == "none"

    def test_whitespace(self):
        assert parse_agent_sync_scope("  ").type == "none"

    def test_all(self):
        scope = parse_agent_sync_scope("all")
        assert scope.type == "all"

    def test_all_case_insensitive(self):
        assert parse_agent_sync_scope("ALL").type == "all"
        assert parse_agent_sync_scope("All").type == "all"

    def test_single_org(self):
        org_id = "11111111-1111-1111-1111-111111111111"
        scope = parse_agent_sync_scope(f"org:{org_id}")
        assert scope.type == "org"
        assert len(scope.organization_ids) == 1
        assert str(scope.organization_ids[0]) == org_id

    def test_multiple_orgs(self):
        org1 = "11111111-1111-1111-1111-111111111111"
        org2 = "22222222-2222-2222-2222-222222222222"
        scope = parse_agent_sync_scope(f"org:{org1},org:{org2}")
        assert scope.type == "org"
        assert len(scope.organization_ids) == 2

    def test_invalid_entry(self):
        with pytest.raises(ValueError, match="Invalid AGENT_SYNC_SCOPE entry"):
            parse_agent_sync_scope("bad:value")

    def test_invalid_uuid(self):
        with pytest.raises(ValueError, match="Invalid organization UUID"):
            parse_agent_sync_scope("org:not-a-uuid")

    def test_org_with_whitespace(self):
        org_id = "11111111-1111-1111-1111-111111111111"
        scope = parse_agent_sync_scope(f"  org:{org_id}  ")
        assert scope.type == "org"

    def test_empty_orgs_returns_none(self):
        """Edge case: empty parts after splitting."""
        scope = parse_agent_sync_scope(",,,")
        assert scope.type == "none"


# ============================================================================
# Helper functions
# ============================================================================


class TestCoerceUuid:
    """Tests for _coerce_uuid()."""

    def test_none(self):
        assert _coerce_uuid(None) is None

    def test_uuid_passthrough(self):
        uid = uuid4()
        assert _coerce_uuid(uid) == uid

    def test_valid_string(self):
        uid_str = "a0000000-0000-4000-a000-000000000001"
        result = _coerce_uuid(uid_str)
        assert result == UUID(uid_str)

    def test_invalid_string(self):
        assert _coerce_uuid("not-a-uuid") is None

    def test_other_type(self):
        assert _coerce_uuid(12345) is None


class TestToBoolOrNone:
    """Tests for _to_bool_or_none()."""

    def test_none(self):
        assert _to_bool_or_none(None) is None

    def test_bool_true(self):
        assert _to_bool_or_none(True) is True

    def test_bool_false(self):
        assert _to_bool_or_none(False) is False

    def test_int_truthy(self):
        assert _to_bool_or_none(1) is True

    def test_int_falsy(self):
        assert _to_bool_or_none(0) is False

    def test_string_true(self):
        for val in ["true", "True", "TRUE", "t", "T", "1", "yes", "YES", "y", "Y"]:
            assert _to_bool_or_none(val) is True, f"Failed for {val!r}"

    def test_string_false(self):
        for val in ["false", "False", "FALSE", "f", "F", "0", "no", "NO", "n", "N"]:
            assert _to_bool_or_none(val) is False, f"Failed for {val!r}"

    def test_string_unrecognized(self):
        assert _to_bool_or_none("maybe") is None

    def test_other_type(self):
        assert _to_bool_or_none([1, 2]) is None


class TestSafeMaskUrl:
    """Tests for _safe_mask_url()."""

    def test_none(self):
        assert _safe_mask_url(None) is None

    def test_empty_string(self):
        assert _safe_mask_url("") == ""

    def test_plain_url(self):
        assert _safe_mask_url("https://example.com/api") == "https://example.com/api"

    def test_strips_query(self):
        assert (
            _safe_mask_url("https://example.com?token=secret") == "https://example.com"
        )

    def test_strips_fragment(self):
        assert _safe_mask_url("https://example.com#section") == "https://example.com"

    def test_strips_both(self):
        assert _safe_mask_url("https://example.com?a=b#c") == "https://example.com"


# ============================================================================
# Row parsing and grouping
# ============================================================================


class TestAddMcpToolFromRow:
    """Tests for _add_mcp_tool_from_row()."""

    def test_adds_tool_when_present(self):
        agent = _make_agent(mcp_tools=[])
        tool_id = uuid4()
        row = {
            "mcp_tool_id": tool_id,
            "mcp_tool_name": "search",
            "mcp_endpoint_url": "https://mcp.example.com",
            "mcp_is_builtin": False,
            "mcp_auth_required": True,
        }

        _add_mcp_tool_from_row(agent, row)

        assert len(agent.mcp_tools) == 1
        assert agent.mcp_tools[0].tool_name == "search"
        assert agent.mcp_tools[0].auth_required is True

    def test_skips_when_all_null(self):
        agent = _make_agent(mcp_tools=[])
        row = {
            "mcp_tool_id": None,
            "mcp_tool_name": None,
            "mcp_endpoint_url": None,
        }

        _add_mcp_tool_from_row(agent, row)

        assert len(agent.mcp_tools) == 0

    def test_adds_tool_with_partial_fields(self):
        agent = _make_agent(mcp_tools=[])
        row = {
            "mcp_tool_id": None,
            "mcp_tool_name": "partial",
            "mcp_endpoint_url": None,
            "mcp_is_builtin": None,
            "mcp_auth_required": None,
        }

        _add_mcp_tool_from_row(agent, row)

        assert len(agent.mcp_tools) == 1
        assert agent.mcp_tools[0].tool_name == "partial"


class TestAgentFromRow:
    """Tests for _agent_from_row()."""

    def test_basic_row(self):
        row = _make_agent_row()
        agent = _agent_from_row(row)

        assert agent.agent_id == AGENT_UUID
        assert agent.organization_id == ORG_UUID
        assert agent.name == "Test Agent"
        assert agent.runtime_model_name == "openai:gpt-4o-mini"

    def test_row_with_id_instead_of_agent_id(self):
        row = _make_agent_row()
        row["id"] = row.pop("agent_id")
        agent = _agent_from_row(row)
        assert agent.agent_id == AGENT_UUID

    def test_missing_agent_id_raises(self):
        row = {"organization_id": str(ORG_UUID)}
        with pytest.raises(ValueError, match="missing agent_id"):
            _agent_from_row(row)

    def test_row_with_sampling_params_dict(self):
        row = _make_agent_row(sampling_params={"temperature": 0.5, "max_tokens": 512})
        agent = _agent_from_row(row)
        assert agent.sampling_params == {"temperature": 0.5, "max_tokens": 512}

    def test_row_with_sampling_params_string(self):
        row = _make_agent_row(sampling_params='{"temperature": 0.3}')
        agent = _agent_from_row(row)
        assert agent.sampling_params == {"temperature": 0.3}

    def test_row_with_sampling_params_empty(self):
        row = _make_agent_row(sampling_params={})
        agent = _agent_from_row(row)
        assert agent.sampling_params == {}

    def test_row_with_sampling_params_none(self):
        row = _make_agent_row()
        row["sampling_params"] = None
        agent = _agent_from_row(row)
        assert agent.sampling_params == {}

    def test_row_with_sampling_params_invalid_string(self):
        row = _make_agent_row()
        row["sampling_params"] = "not-json"
        agent = _agent_from_row(row)
        assert agent.sampling_params == {}

    def test_row_with_assistant_tool_ids(self):
        tool_ids = [
            "a0000000-0000-4000-a000-000000000001",
            "b0000000-0000-4000-b000-000000000002",
        ]
        row = _make_agent_row(assistant_tool_ids=tool_ids)
        agent = _agent_from_row(row)
        assert agent.assistant_tool_ids == tool_ids

    def test_row_with_empty_assistant_tool_ids(self):
        row = _make_agent_row(assistant_tool_ids=[])
        agent = _agent_from_row(row)
        assert agent.assistant_tool_ids == []

    def test_row_with_none_assistant_tool_ids(self):
        row = _make_agent_row()
        row["assistant_tool_ids"] = None
        agent = _agent_from_row(row)
        assert agent.assistant_tool_ids == []

    def test_row_with_mcp_tool(self):
        tool_id = uuid4()
        row = _make_agent_row(
            mcp_tool_id=str(tool_id),
            mcp_tool_name="search",
            mcp_endpoint_url="https://mcp.example.com",
        )
        agent = _agent_from_row(row)
        assert len(agent.mcp_tools) == 1

    def test_row_with_none_optional_strings(self):
        row = _make_agent_row(
            name=None,
            system_prompt=None,
            runtime_model_name=None,
        )
        row["runtime_model_name"] = None
        row["graph_id"] = None
        row["langgraph_assistant_id"] = None
        agent = _agent_from_row(row)
        assert agent.name is None
        assert agent.system_prompt is None
        assert agent.runtime_model_name is None
        assert agent.graph_id is None
        assert agent.langgraph_assistant_id is None

    def test_row_with_string_values(self):
        """Ensure string coercion works for name/system_prompt etc."""
        row = _make_agent_row(name=123)  # numeric name
        agent = _agent_from_row(row)
        assert agent.name == "123"


class TestGroupAgentRows:
    """Tests for _group_agent_rows()."""

    def test_single_agent_single_row(self):
        rows = [_make_agent_row()]
        agents = _group_agent_rows(rows)
        assert len(agents) == 1
        assert agents[0].agent_id == AGENT_UUID

    def test_single_agent_multiple_tools(self):
        tool1 = uuid4()
        tool2 = uuid4()
        rows = [
            _make_agent_row(
                mcp_tool_id=str(tool1),
                mcp_tool_name="tool-1",
                mcp_endpoint_url="https://a.com",
            ),
            _make_agent_row(
                mcp_tool_id=str(tool2),
                mcp_tool_name="tool-2",
                mcp_endpoint_url="https://b.com",
            ),
        ]
        agents = _group_agent_rows(rows)
        assert len(agents) == 1
        assert len(agents[0].mcp_tools) == 2

    def test_multiple_agents(self):
        uid1 = uuid4()
        uid2 = uuid4()
        rows = [
            _make_agent_row(agent_id=uid1, name="Agent A"),
            _make_agent_row(agent_id=uid2, name="Agent B"),
        ]
        agents = _group_agent_rows(rows)
        assert len(agents) == 2

    def test_sorts_by_org_name_id(self):
        org_a = UUID("00000000-0000-0000-0000-000000000001")
        org_b = UUID("00000000-0000-0000-0000-000000000002")
        uid1 = uuid4()
        uid2 = uuid4()
        rows = [
            _make_agent_row(agent_id=uid1, organization_id=org_b, name="Z Agent"),
            _make_agent_row(agent_id=uid2, organization_id=org_a, name="A Agent"),
        ]
        agents = _group_agent_rows(rows)
        assert agents[0].organization_id == org_a

    def test_skips_rows_without_agent_id(self):
        rows = [{"name": "no id"}]
        agents = _group_agent_rows(rows)
        assert len(agents) == 0

    def test_empty_rows(self):
        assert _group_agent_rows([]) == []


# ============================================================================
# SQL builder
# ============================================================================


class TestBuildFetchAgentsSql:
    """Tests for _build_fetch_agents_sql()."""

    def test_all_scope(self):
        sql, params = _build_fetch_agents_sql(AgentSyncScope.all())
        assert "public.agents" in sql
        assert "status = 'active'" in sql
        assert "organization_id = ANY" not in sql
        assert params == {}
        # Verify new columns are queried instead of old ones
        assert "a.sampling_params" in sql
        assert "a.assistant_tool_ids" in sql
        assert "a.temperature" not in sql
        assert "a.max_tokens" not in sql

    def test_org_scope(self):
        org = uuid4()
        sql, params = _build_fetch_agents_sql(AgentSyncScope.orgs([org]))
        assert "organization_id = ANY" in sql
        assert "organization_ids" in params
        assert str(org) in params["organization_ids"]

    def test_none_scope(self):
        """Even for none scope, SQL is built (caller decides not to run it)."""
        sql, params = _build_fetch_agents_sql(AgentSyncScope.none())
        assert "public.agents" in sql


# ============================================================================
# _build_assistant_configurable
# ============================================================================


class TestBuildAssistantConfigurable:
    """Tests for _build_assistant_configurable()."""

    def test_basic_agent(self):
        agent = _make_agent()
        config = _build_assistant_configurable(agent)

        assert config["model_name"] == "openai:gpt-4o-mini"
        assert config["system_prompt"] == "You are a test agent."
        assert config["supabase_organization_id"] == str(ORG_UUID)

    def test_agent_with_sampling_params(self):
        agent = _make_agent(sampling_params={"temperature": 0.5, "max_tokens": 1024})
        config = _build_assistant_configurable(agent)
        assert config["temperature"] == 0.5
        assert config["max_tokens"] == 1024

    def test_agent_with_sampling_params_spread(self):
        agent = _make_agent(
            sampling_params={"temperature": 0.3, "top_p": 0.9, "seed": 42}
        )
        config = _build_assistant_configurable(agent)
        assert config["temperature"] == 0.3
        assert config["top_p"] == 0.9
        assert config["seed"] == 42

    def test_agent_with_sampling_params_none_values_skipped(self):
        agent = _make_agent(sampling_params={"temperature": 0.5, "max_tokens": None})
        config = _build_assistant_configurable(agent)
        assert config["temperature"] == 0.5
        assert "max_tokens" not in config

    def test_agent_with_assistant_tool_ids(self):
        tool_ids = [
            "a0000000-0000-4000-a000-000000000001",
            "b0000000-0000-4000-b000-000000000002",
        ]
        agent = _make_agent(assistant_tool_ids=tool_ids)
        config = _build_assistant_configurable(agent)
        assert config["agent_tools"] == tool_ids

    def test_agent_without_assistant_tool_ids(self):
        agent = _make_agent(assistant_tool_ids=[])
        config = _build_assistant_configurable(agent)
        assert "agent_tools" not in config

    def test_agent_without_optional_fields(self):
        agent = AgentSyncData(agent_id=AGENT_UUID)
        config = _build_assistant_configurable(agent)
        assert "model_name" not in config
        assert "system_prompt" not in config
        assert "supabase_organization_id" not in config
        assert "temperature" not in config
        assert "max_tokens" not in config
        assert "agent_tools" not in config

    def test_agent_with_mcp_tools(self):
        tools = [
            AgentSyncMcpTool(
                tool_id=uuid4(),
                tool_name="search",
                endpoint_url="https://mcp1.example.com",
                auth_required=True,
            ),
            AgentSyncMcpTool(
                tool_id=uuid4(),
                tool_name="embed",
                endpoint_url="https://mcp1.example.com",
                auth_required=False,
            ),
        ]
        agent = _make_agent(mcp_tools=tools)
        config = _build_assistant_configurable(agent)

        assert "mcp_config" in config
        servers = config["mcp_config"]["servers"]
        assert len(servers) == 1  # same endpoint → grouped into 1 server
        # tools key is no longer emitted — server name comes from first tool_name
        assert "tools" not in servers[0]
        assert servers[0]["name"] == "embed"  # sorted alphabetically: embed < search
        # auth_required is OR'd: True because at least one tool requires it
        assert servers[0]["auth_required"] is True

    def test_multiple_mcp_servers(self):
        tools = [
            AgentSyncMcpTool(tool_name="tool-a", endpoint_url="https://a.com"),
            AgentSyncMcpTool(tool_name="tool-b", endpoint_url="https://b.com"),
        ]
        agent = _make_agent(mcp_tools=tools)
        config = _build_assistant_configurable(agent)

        servers = config["mcp_config"]["servers"]
        assert len(servers) == 2
        # Sorted by endpoint URL
        assert servers[0]["url"] == "https://a.com"
        assert servers[1]["url"] == "https://b.com"
        # Server names derived from tool_name entries
        assert servers[0]["name"] == "tool-a"
        assert servers[1]["name"] == "tool-b"
        # No tools filter key
        assert "tools" not in servers[0]
        assert "tools" not in servers[1]

    def test_mcp_tools_without_url_or_name_skipped(self):
        tools = [
            AgentSyncMcpTool(tool_name=None, endpoint_url="https://a.com"),
            AgentSyncMcpTool(tool_name="tool", endpoint_url=None),
        ]
        agent = _make_agent(mcp_tools=tools)
        config = _build_assistant_configurable(agent)

        assert "mcp_config" not in config

    def test_server_naming(self):
        tools = [
            AgentSyncMcpTool(tool_name="my-server-z", endpoint_url="https://z.com"),
            AgentSyncMcpTool(tool_name="my-server-a", endpoint_url="https://a.com"),
        ]
        agent = _make_agent(mcp_tools=tools)
        config = _build_assistant_configurable(agent)

        servers = config["mcp_config"]["servers"]
        # Sorted by endpoint URL: a.com first, z.com second
        assert servers[0]["name"] == "my-server-a"
        assert servers[1]["name"] == "my-server-z"


class TestAssistantPayloadForAgent:
    """Tests for _assistant_payload_for_agent()."""

    def test_basic_payload(self):
        agent = _make_agent()
        payload = _assistant_payload_for_agent(agent)

        assert payload["assistant_id"] == str(AGENT_UUID)
        assert payload["name"] == "Test Agent"
        assert payload["graph_id"] == "agent"
        assert "configurable" in payload["config"]
        assert payload["metadata"]["supabase_agent_id"] == str(AGENT_UUID)
        assert payload["metadata"]["supabase_organization_id"] == str(ORG_UUID)
        assert "synced_at" in payload["metadata"]

    def test_name_included_in_payload(self):
        agent = _make_agent(name="Dokumenten-Assistent")
        payload = _assistant_payload_for_agent(agent)
        assert payload["name"] == "Dokumenten-Assistent"

    def test_none_name_in_payload(self):
        agent = AgentSyncData(agent_id=AGENT_UUID, name=None)
        payload = _assistant_payload_for_agent(agent)
        assert payload["name"] is None

    def test_custom_graph_id(self):
        agent = _make_agent(graph_id="custom-graph")
        payload = _assistant_payload_for_agent(agent)
        assert payload["graph_id"] == "custom-graph"

    def test_none_graph_id_defaults_to_agent(self):
        agent = _make_agent(graph_id=None)
        payload = _assistant_payload_for_agent(agent)
        assert payload["graph_id"] == "agent"

    def test_none_organization_id(self):
        agent = AgentSyncData(agent_id=AGENT_UUID, organization_id=None)
        payload = _assistant_payload_for_agent(agent)
        assert payload["metadata"]["supabase_organization_id"] is None


class TestExtractAssistantConfigurable:
    """Tests for _extract_assistant_configurable()."""

    def test_with_pydantic_config(self):
        obj = MagicMock()
        obj.config.model_dump.return_value = {"configurable": {"k": "v"}}
        result = _extract_assistant_configurable(obj)
        assert result == {"k": "v"}

    def test_with_dict_config(self):
        obj = MagicMock(spec=[])  # no model_dump
        obj.config = {"configurable": {"k": "v"}}
        result = _extract_assistant_configurable(obj)
        assert result == {"k": "v"}

    def test_with_none_config(self):
        obj = MagicMock()
        obj.config = None
        result = _extract_assistant_configurable(obj)
        assert result == {}

    def test_with_no_config_attr(self):
        obj = object()
        result = _extract_assistant_configurable(obj)
        assert result == {}

    def test_with_non_dict_configurable(self):
        obj = MagicMock()
        obj.config.model_dump.return_value = {"configurable": "not-a-dict"}
        result = _extract_assistant_configurable(obj)
        assert result == {}

    def test_with_no_configurable_key(self):
        obj = MagicMock()
        obj.config.model_dump.return_value = {"other": "data"}
        result = _extract_assistant_configurable(obj)
        assert result == {}

    def test_with_opaque_config(self):
        """Config that is neither dict nor has model_dump."""

        class OpaqueConfig:
            """Object with no model_dump and not a dict."""

            pass

        obj = MagicMock()
        obj.config = OpaqueConfig()
        result = _extract_assistant_configurable(obj)
        assert result == {}


# ============================================================================
# Fetch functions (mocked DB)
# ============================================================================


class TestFetchActiveAgents:
    """Tests for fetch_active_agents()."""

    async def test_none_scope_raises(self):
        factory, _ = _make_factory()
        with pytest.raises(RuntimeError, match="scope=none"):
            await fetch_active_agents(factory, AgentSyncScope.none())

    async def test_all_scope_returns_agents(self):
        rows = [_make_agent_row()]
        factory, _ = _make_factory(MockCursor(rows))

        agents = await fetch_active_agents(factory, AgentSyncScope.all())

        assert len(agents) == 1
        assert agents[0].agent_id == AGENT_UUID

    async def test_empty_rows(self):
        factory, _ = _make_factory(MockCursor([]))

        agents = await fetch_active_agents(factory, AgentSyncScope.all())

        assert agents == []

    async def test_non_dict_rows_converted(self):
        """Cover the dict(row) fallback branch."""

        class FakeRow:
            def __init__(self, data: dict):
                self._data = data

            def __iter__(self):
                return iter(self._data.items())

            def keys(self):
                return self._data.keys()

            def __getitem__(self, key):
                return self._data[key]

        row_data = _make_agent_row()
        rows = [FakeRow(row_data)]
        factory, _ = _make_factory(MockCursor(rows))

        agents = await fetch_active_agents(factory, AgentSyncScope.all())

        assert len(agents) == 1

    async def test_unconvertible_rows_skipped(self):
        """Cover the except branch when dict() conversion fails."""

        class BadRow:
            pass

        rows = [BadRow()]
        factory, _ = _make_factory(MockCursor(rows))

        agents = await fetch_active_agents(factory, AgentSyncScope.all())

        assert agents == []

    async def test_org_scope(self):
        rows = [_make_agent_row()]
        factory, refs = _make_factory(MockCursor(rows))

        agents = await fetch_active_agents(factory, AgentSyncScope.orgs([ORG_UUID]))

        assert len(agents) == 1
        # Verify org filter was in SQL
        sql = refs[0].executed[0][0]
        assert "organization_id" in sql


class TestFetchActiveAgentById:
    """Tests for fetch_active_agent_by_id()."""

    async def test_found(self):
        rows = [_make_agent_row()]
        factory, _ = _make_factory(MockCursor(rows))

        agent = await fetch_active_agent_by_id(factory, AGENT_UUID)

        assert agent is not None
        assert agent.agent_id == AGENT_UUID

    async def test_not_found(self):
        factory, _ = _make_factory(MockCursor([]))

        agent = await fetch_active_agent_by_id(factory, AGENT_UUID)

        assert agent is None

    async def test_non_dict_rows(self):
        """Cover the dict(row) fallback for single agent fetch."""

        class FakeRow:
            def __init__(self, data):
                self._data = data

            def __iter__(self):
                return iter(self._data.items())

            def keys(self):
                return self._data.keys()

            def __getitem__(self, key):
                return self._data[key]

        rows = [FakeRow(_make_agent_row())]
        factory, _ = _make_factory(MockCursor(rows))

        agent = await fetch_active_agent_by_id(factory, AGENT_UUID)
        assert agent is not None

    async def test_unconvertible_rows(self):
        class BadRow:
            pass

        rows = [BadRow()]
        factory, _ = _make_factory(MockCursor(rows))

        agent = await fetch_active_agent_by_id(factory, AGENT_UUID)
        assert agent is None


# ============================================================================
# _write_back_langgraph_assistant_id
# ============================================================================


class TestWriteBackLanggraphAssistantId:
    """Tests for _write_back_langgraph_assistant_id()."""

    async def test_write_back_success(self):
        factory, _ = _make_factory(MockCursor(rowcount=1))

        result = await _write_back_langgraph_assistant_id(
            factory,
            agent_id=AGENT_UUID,
            assistant_id=str(AGENT_UUID),
        )

        assert result is True

    async def test_write_back_no_change(self):
        factory, _ = _make_factory(MockCursor(rowcount=0))

        result = await _write_back_langgraph_assistant_id(
            factory,
            agent_id=AGENT_UUID,
            assistant_id=str(AGENT_UUID),
        )

        assert result is False

    async def test_write_back_rowcount_exception(self):
        """Cover the except branch when cursor.rowcount fails."""

        class BadCursor:
            """Cursor whose rowcount property raises."""

            async def fetchone(self):
                return None

            async def fetchall(self):
                return []

            @property
            def rowcount(self):
                raise RuntimeError("no rowcount")

        bad_cursor = BadCursor()
        connection = MockConnection()

        async def patched_execute(query, params=None):
            connection.executed.append((query, params))
            return bad_cursor

        connection.execute = patched_execute

        @asynccontextmanager
        async def factory():
            yield connection

        result = await _write_back_langgraph_assistant_id(
            factory,
            agent_id=AGENT_UUID,
            assistant_id=str(AGENT_UUID),
        )

        assert result is False


# ============================================================================
# sync_single_agent
# ============================================================================


class TestSyncSingleAgent:
    """Tests for sync_single_agent()."""

    async def test_creates_new_assistant(self):
        factory, _ = _make_factory(MockCursor(rowcount=1))  # write-back
        storage = FakeStorage()
        agent = _make_agent()

        result = await sync_single_agent(
            factory, storage, agent=agent, owner_id="system"
        )

        assert result.action == "created"
        assert result.assistant_id == str(AGENT_UUID)
        assert len(storage.assistants.create_calls) == 1

    async def test_creates_with_write_back(self):
        factory, _ = _make_factory(MockCursor(rowcount=1))
        storage = FakeStorage()
        agent = _make_agent()

        result = await sync_single_agent(
            factory,
            storage,
            agent=agent,
            owner_id="system",
            write_back_assistant_id=True,
        )

        assert result.wrote_back_assistant_id is True

    async def test_creates_without_write_back(self):
        factory, _ = _make_factory()
        storage = FakeStorage()
        agent = _make_agent()

        result = await sync_single_agent(
            factory,
            storage,
            agent=agent,
            owner_id="system",
            write_back_assistant_id=False,
        )

        assert result.action == "created"
        assert result.wrote_back_assistant_id is False

    async def test_skips_when_config_and_name_unchanged(self):
        factory, _ = _make_factory()
        storage = FakeStorage()
        agent = _make_agent()

        # Pre-populate with matching config and name
        expected_config = _build_assistant_configurable(agent)
        storage.assistants.seed(
            str(AGENT_UUID),
            config_dict={"configurable": expected_config},
        )
        # Patch the seeded assistant to have the matching name
        storage.assistants._store[str(AGENT_UUID)].name = agent.name

        result = await sync_single_agent(
            factory, storage, agent=agent, owner_id="system"
        )

        assert result.action == "skipped"
        assert result.wrote_back_assistant_id is False

    async def test_updates_when_name_changed(self):
        factory, _ = _make_factory(MockCursor(rowcount=1))
        storage = FakeStorage()
        agent = _make_agent(name="New Name")

        # Seed with matching config but different name
        expected_config = _build_assistant_configurable(agent)
        storage.assistants.seed(
            str(AGENT_UUID),
            config_dict={"configurable": expected_config},
        )
        storage.assistants._store[str(AGENT_UUID)].name = "Old Name"

        result = await sync_single_agent(
            factory, storage, agent=agent, owner_id="system"
        )

        assert result.action == "updated"

    async def test_updates_when_config_changed(self):
        factory, _ = _make_factory(MockCursor(rowcount=1))
        storage = FakeStorage()
        agent = _make_agent()

        # Seed with different config
        storage.assistants.seed(
            str(AGENT_UUID),
            config_dict={"configurable": {"model_name": "openai:gpt-4o"}},
        )

        result = await sync_single_agent(
            factory, storage, agent=agent, owner_id="system"
        )

        assert result.action == "updated"
        assert len(storage.assistants.update_calls) == 1

    async def test_updates_with_write_back(self):
        factory, _ = _make_factory(MockCursor(rowcount=1))
        storage = FakeStorage()
        agent = _make_agent()

        storage.assistants.seed(
            str(AGENT_UUID),
            config_dict={"configurable": {"old": True}},
        )

        result = await sync_single_agent(
            factory,
            storage,
            agent=agent,
            owner_id="system",
            write_back_assistant_id=True,
        )

        assert result.action == "updated"
        assert result.wrote_back_assistant_id is True

    async def test_write_back_failure_logged_not_raised(self):
        """Write-back failures should not crash sync."""

        @asynccontextmanager
        async def failing_factory():
            conn = MockConnection()

            async def failing_execute(query, params=None):
                raise RuntimeError("DB down")

            conn.execute = failing_execute
            yield conn

        storage = FakeStorage()
        agent = _make_agent()

        result = await sync_single_agent(
            failing_factory,
            storage,
            agent=agent,
            owner_id="system",
            write_back_assistant_id=True,
        )

        assert result.action == "created"
        assert result.wrote_back_assistant_id is False


# ============================================================================
# startup_agent_sync
# ============================================================================


class TestStartupAgentSync:
    """Tests for startup_agent_sync()."""

    async def test_none_scope_returns_zeros(self):
        factory, _ = _make_factory()
        storage = FakeStorage()

        summary = await startup_agent_sync(
            factory, storage, scope=AgentSyncScope.none(), owner_id="system"
        )

        assert summary == {
            "total": 0,
            "created": 0,
            "updated": 0,
            "skipped": 0,
            "failed": 0,
        }

    async def test_creates_agents(self):
        rows = [_make_agent_row()]
        factory, _ = _make_factory(
            MockCursor(rows),  # fetch_active_agents
            MockCursor(rowcount=1),  # write_back
        )
        storage = FakeStorage()

        summary = await startup_agent_sync(
            factory, storage, scope=AgentSyncScope.all(), owner_id="system"
        )

        assert summary["total"] == 1
        assert summary["created"] == 1

    async def test_handles_sync_failure(self):
        """When sync_single_agent raises, it's counted as failed."""
        rows = [_make_agent_row()]
        factory, _ = _make_factory(MockCursor(rows))

        # Make storage.assistants.create raise
        storage = FakeStorage()

        async def failing_create(payload, owner_id):
            raise RuntimeError("boom")

        storage.assistants.create = failing_create

        summary = await startup_agent_sync(
            factory, storage, scope=AgentSyncScope.all(), owner_id="system"
        )

        assert summary["total"] == 1
        assert summary["failed"] == 1

    async def test_multiple_agents_mixed_results(self):
        uid1 = uuid4()
        uid2 = uuid4()
        rows = [
            _make_agent_row(agent_id=uid1, name="Agent 1"),
            _make_agent_row(agent_id=uid2, name="Agent 2"),
        ]
        factory, _ = _make_factory(
            MockCursor(rows),  # fetch
            MockCursor(rowcount=1),  # write_back for agent 1
            MockCursor(rowcount=1),  # write_back for agent 2
        )
        storage = FakeStorage()

        summary = await startup_agent_sync(
            factory, storage, scope=AgentSyncScope.all(), owner_id="system"
        )

        assert summary["total"] == 2
        assert summary["created"] == 2


# ============================================================================
# lazy_sync_agent
# ============================================================================


class TestLazySyncAgent:
    """Tests for lazy_sync_agent()."""

    async def test_returns_none_when_agent_not_found(self):
        factory, _ = _make_factory(MockCursor([]))
        storage = FakeStorage()

        result = await lazy_sync_agent(
            factory, storage, agent_id=AGENT_UUID, owner_id="system"
        )

        assert result is None

    async def test_syncs_when_not_cached(self):
        rows = [_make_agent_row()]
        factory, _ = _make_factory(
            MockCursor(rows),  # fetch_active_agent_by_id
            MockCursor(rowcount=1),  # write_back
        )
        storage = FakeStorage()

        result = await lazy_sync_agent(
            factory, storage, agent_id=AGENT_UUID, owner_id="system"
        )

        assert result == str(AGENT_UUID)
        assert len(storage.assistants.create_calls) == 1

    async def test_returns_cached_when_recently_synced(self):
        """If assistant exists and synced_at is recent, skip resync."""
        factory, _ = _make_factory()
        storage = FakeStorage()

        recently = datetime.now(timezone.utc).isoformat()
        storage.assistants.seed(
            str(AGENT_UUID),
            config_dict={},
            metadata={"synced_at": recently},
        )

        result = await lazy_sync_agent(
            factory,
            storage,
            agent_id=AGENT_UUID,
            owner_id="system",
            cache_ttl=timedelta(minutes=5),
        )

        assert result == str(AGENT_UUID)
        # Should NOT have created or fetched
        assert len(storage.assistants.create_calls) == 0

    async def test_resyncs_when_expired(self):
        """If synced_at is older than TTL, resync."""
        expired = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()

        rows = [_make_agent_row()]
        factory, _ = _make_factory(
            MockCursor(rows),  # fetch
            MockCursor(rowcount=1),  # write_back
        )
        storage = FakeStorage()
        storage.assistants.seed(
            str(AGENT_UUID),
            config_dict={},
            metadata={"synced_at": expired},
        )

        result = await lazy_sync_agent(
            factory,
            storage,
            agent_id=AGENT_UUID,
            owner_id="system",
            cache_ttl=timedelta(minutes=5),
        )

        assert result == str(AGENT_UUID)

    async def test_resyncs_when_synced_at_missing(self):
        rows = [_make_agent_row()]
        factory, _ = _make_factory(
            MockCursor(rows),
            MockCursor(rowcount=1),
        )
        storage = FakeStorage()
        storage.assistants.seed(str(AGENT_UUID), config_dict={}, metadata={})

        result = await lazy_sync_agent(
            factory,
            storage,
            agent_id=AGENT_UUID,
            owner_id="system",
        )

        assert result == str(AGENT_UUID)

    async def test_resyncs_when_synced_at_unparseable(self):
        rows = [_make_agent_row()]
        factory, _ = _make_factory(
            MockCursor(rows),
            MockCursor(rowcount=1),
        )
        storage = FakeStorage()
        storage.assistants.seed(
            str(AGENT_UUID),
            config_dict={},
            metadata={"synced_at": "not-a-date"},
        )

        result = await lazy_sync_agent(
            factory,
            storage,
            agent_id=AGENT_UUID,
            owner_id="system",
        )

        assert result == str(AGENT_UUID)

    async def test_handles_Z_suffix_in_synced_at(self):
        """Cover the Z → +00:00 replacement path."""
        recent = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S") + "Z"
        factory, _ = _make_factory()
        storage = FakeStorage()
        storage.assistants.seed(
            str(AGENT_UUID),
            config_dict={},
            metadata={"synced_at": recent},
        )

        result = await lazy_sync_agent(
            factory,
            storage,
            agent_id=AGENT_UUID,
            owner_id="system",
            cache_ttl=timedelta(minutes=10),
        )

        assert result == str(AGENT_UUID)
        assert len(storage.assistants.create_calls) == 0

    async def test_metadata_not_dict(self):
        """Cover branch where metadata is not a dict."""
        rows = [_make_agent_row()]
        factory, _ = _make_factory(
            MockCursor(rows),
            MockCursor(rowcount=1),
        )
        storage = FakeStorage()
        # Seed with metadata that's not a dict
        obj = MagicMock()
        obj.config = MagicMock()
        obj.config.model_dump.return_value = {}
        obj.metadata = "not-a-dict"
        storage.assistants._store[str(AGENT_UUID)] = obj

        result = await lazy_sync_agent(
            factory,
            storage,
            agent_id=AGENT_UUID,
            owner_id="system",
        )

        assert result == str(AGENT_UUID)
