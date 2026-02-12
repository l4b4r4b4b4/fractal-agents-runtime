"""Agent sync module (Supabase/Postgres → LangGraph assistant config).

This module provides:
- Pydantic data models representing agent configuration in Supabase/Postgres.
- Database query helpers for reading agents + MCP tool assignments.
- Assistant sync orchestration functions to create/update LangGraph assistants
  in the runtime storage layer.

Design goals:
- Idempotent: safe to run at startup and on-demand.
- Non-sensitive logging: never log secrets or tokenised URLs.
- Deterministic assistant IDs: assistant_id is the Supabase agent UUID string.

Task coverage (Goal 15):
- Task-01: data models + queries
- Task-02: startup sync + lazy sync + core sync logic (this module)
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable, Literal, Protocol, Sequence
from uuid import UUID

from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)


class AgentSyncMcpTool(BaseModel):
    """MCP tool metadata assigned to an agent.

    Attributes:
        tool_id: MCP tool UUID (if available from query).
        tool_name: Human-readable tool name.
        endpoint_url: Base URL for the MCP server (not necessarily suffixed with /mcp).
        is_builtin: Whether the tool is a built-in tool (vs remote MCP).
        auth_required: Whether the MCP server requires auth (if present in schema).
    """

    tool_id: UUID | None = None
    tool_name: str | None = None
    endpoint_url: str | None = None
    is_builtin: bool | None = None
    auth_required: bool | None = None


class AgentSyncData(BaseModel):
    """Agent configuration materialised from Supabase for sync into assistant storage.

    This is the canonical shape we use downstream to build a LangGraph assistant
    config (`config.configurable`) for the `react_agent.agent.graph()` factory.

    Attributes:
        agent_id: UUID of the agent in Supabase.
        organization_id: Organization UUID owning the agent.
        name: Display name.
        system_prompt: System prompt text.
        temperature: LLM temperature.
        max_tokens: Max tokens for response.
        runtime_model_name: Fully qualified provider model, e.g. "openai:gpt-4o".
        graph_id: LangGraph graph id to run (typically "agent").
        langgraph_assistant_id: Existing assistant id stored in Supabase (if any).
        mcp_tools: List of MCP tools assigned to the agent.
    """

    agent_id: UUID
    organization_id: UUID | None = None

    name: str | None = None
    system_prompt: str | None = None
    temperature: float | None = None
    max_tokens: int | None = None

    runtime_model_name: str | None = None
    graph_id: str | None = None
    langgraph_assistant_id: str | None = None

    mcp_tools: list[AgentSyncMcpTool] = Field(default_factory=list)


AgentSyncScopeType = Literal["none", "all", "org"]


class AssistantStorageProtocol(Protocol):
    """Minimal assistant storage protocol required for sync.

    This intentionally avoids importing concrete storage implementations to
    prevent circular dependencies and keep `agent_sync` testable.

    Implementations are expected to match `robyn_server.storage.get_storage()`
    semantics: methods are async and operate with an `owner_id`.
    """

    class Assistants(Protocol):
        async def get(self, assistant_id: str, owner_id: str) -> Any: ...
        async def create(self, payload: dict[str, Any], owner_id: str) -> Any: ...
        async def update(
            self, assistant_id: str, payload: dict[str, Any], owner_id: str
        ) -> Any: ...

    assistants: Assistants


class AgentSyncScope(BaseModel):
    """Parsed representation of AGENT_SYNC_SCOPE.

    This model is primarily used to express query intent.

    - type="none": no startup sync (lazy only)
    - type="all": sync all active agents
    - type="org": sync active agents for the listed organization_ids
    """

    type: AgentSyncScopeType
    organization_ids: list[UUID] = Field(default_factory=list)

    @classmethod
    def none(cls) -> "AgentSyncScope":
        """Return a scope that disables startup sync."""
        return cls(type="none", organization_ids=[])

    @classmethod
    def all(cls) -> "AgentSyncScope":
        """Return a scope that syncs all active agents."""
        return cls(type="all", organization_ids=[])

    @classmethod
    def orgs(cls, organization_ids: Iterable[UUID]) -> "AgentSyncScope":
        """Return a scope that syncs the provided organization ids."""
        unique_organization_ids = list(dict.fromkeys(list(organization_ids)))
        return cls(type="org", organization_ids=unique_organization_ids)


def parse_agent_sync_scope(raw_scope: str | None) -> AgentSyncScope:
    """Parse AGENT_SYNC_SCOPE into a structured scope.

    The scratchpad defines these formats:

    - "none" (default) → no startup sync
    - "all" → all active agents
    - "org:<uuid>" → a single org
    - "org:<uuid>,org:<uuid>" → multiple orgs

    Args:
        raw_scope: Raw env var value.

    Returns:
        AgentSyncScope instance.

    Raises:
        ValueError: If the scope string is malformed or contains non-UUID org ids.

    Examples:
        >>> parse_agent_sync_scope("none").type
        'none'
        >>> parse_agent_sync_scope("all").type
        'all'
        >>> scope = parse_agent_sync_scope("org:11111111-1111-1111-1111-111111111111")
        >>> scope.type
        'org'
    """
    normalized_scope = (raw_scope or "none").strip()
    if not normalized_scope or normalized_scope.lower() == "none":
        return AgentSyncScope.none()

    if normalized_scope.lower() == "all":
        return AgentSyncScope.all()

    parts = [part.strip() for part in normalized_scope.split(",") if part.strip()]
    organization_ids: list[UUID] = []
    for part in parts:
        if not part.lower().startswith("org:"):
            raise ValueError(
                f"Invalid AGENT_SYNC_SCOPE entry: {part!r}. Expected 'org:<uuid>'."
            )
        organization_id_text = part.split(":", 1)[1].strip()
        try:
            organization_ids.append(UUID(organization_id_text))
        except ValueError as error:
            raise ValueError(
                f"Invalid organization UUID in AGENT_SYNC_SCOPE: {organization_id_text!r}"
            ) from error

    if not organization_ids:
        return AgentSyncScope.none()

    return AgentSyncScope.orgs(organization_ids)


@dataclass(frozen=True)
class AgentSyncResult:
    """Outcome of syncing a single agent."""

    assistant_id: str
    action: Literal["created", "updated", "skipped"]
    wrote_back_assistant_id: bool = False


def _coerce_uuid(value: Any) -> UUID | None:
    """Best-effort conversion from DB-returned values to UUID.

    Supabase/Postgres drivers may return UUIDs as UUID objects or strings.
    """
    if value is None:
        return None
    if isinstance(value, UUID):
        return value
    if isinstance(value, str):
        try:
            return UUID(value)
        except ValueError:
            return None
    return None


def _to_bool_or_none(value: Any) -> bool | None:
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, int):
        return bool(value)
    if isinstance(value, str):
        lowered_value = value.strip().lower()
        if lowered_value in {"true", "t", "1", "yes", "y"}:
            return True
        if lowered_value in {"false", "f", "0", "no", "n"}:
            return False
    return None


def _add_mcp_tool_from_row(agent: AgentSyncData, row: dict[str, Any]) -> None:
    """Append an MCP tool derived from a join row, if present."""
    tool_id = _coerce_uuid(row.get("mcp_tool_id"))
    tool_name = row.get("mcp_tool_name")
    endpoint_url = row.get("mcp_endpoint_url")
    is_builtin = _to_bool_or_none(row.get("mcp_is_builtin"))
    auth_required = _to_bool_or_none(row.get("mcp_auth_required"))

    # If the LEFT JOIN produced nulls for the tool, skip.
    if tool_id is None and tool_name is None and endpoint_url is None:
        return

    agent.mcp_tools.append(
        AgentSyncMcpTool(
            tool_id=tool_id,
            tool_name=str(tool_name) if tool_name is not None else None,
            endpoint_url=str(endpoint_url) if endpoint_url is not None else None,
            is_builtin=is_builtin,
            auth_required=auth_required,
        )
    )


def _agent_from_row(row: dict[str, Any]) -> AgentSyncData:
    """Create an AgentSyncData from a single DB row (one tool join)."""
    agent_id = _coerce_uuid(row.get("agent_id") or row.get("id"))
    if agent_id is None:
        raise ValueError("Agent query row missing agent_id/id")

    organization_id = _coerce_uuid(row.get("organization_id"))
    temperature_value = row.get("temperature")
    max_tokens_value = row.get("max_tokens")

    temperature: float | None
    if temperature_value is None:
        temperature = None
    else:
        temperature = float(temperature_value)

    max_tokens: int | None
    if max_tokens_value is None:
        max_tokens = None
    else:
        max_tokens = int(max_tokens_value)

    runtime_model_name = row.get("runtime_model_name")
    if runtime_model_name is not None:
        runtime_model_name = str(runtime_model_name)

    data = AgentSyncData(
        agent_id=agent_id,
        organization_id=organization_id,
        name=str(row.get("name")) if row.get("name") is not None else None,
        system_prompt=(
            str(row.get("system_prompt"))
            if row.get("system_prompt") is not None
            else None
        ),
        temperature=temperature,
        max_tokens=max_tokens,
        runtime_model_name=runtime_model_name,
        graph_id=str(row.get("graph_id")) if row.get("graph_id") is not None else None,
        langgraph_assistant_id=(
            str(row.get("langgraph_assistant_id"))
            if row.get("langgraph_assistant_id") is not None
            else None
        ),
        mcp_tools=[],
    )

    _add_mcp_tool_from_row(data, row)
    return data


def _group_agent_rows(rows: Sequence[dict[str, Any]]) -> list[AgentSyncData]:
    """Group query rows into a per-agent list.

    The SQL uses LEFT JOINs to bring in MCP tool assignments, producing
    0..N rows per agent. This function collapses those into one AgentSyncData
    per agent with `mcp_tools` aggregated.
    """
    agents_by_id: dict[UUID, AgentSyncData] = {}
    for row in rows:
        agent_id = _coerce_uuid(row.get("agent_id") or row.get("id"))
        if agent_id is None:
            continue

        if agent_id not in agents_by_id:
            agents_by_id[agent_id] = _agent_from_row(row)
            continue

        _add_mcp_tool_from_row(agents_by_id[agent_id], row)

    # Stable ordering: organization_id then name then agent_id (best-effort)
    def sort_key(agent: AgentSyncData) -> tuple[str, str, str]:
        organization_key = str(agent.organization_id or "")
        name_key = (agent.name or "").lower()
        return (organization_key, name_key, str(agent.agent_id))

    return sorted(agents_by_id.values(), key=sort_key)


def _build_fetch_agents_sql(scope: AgentSyncScope) -> tuple[str, dict[str, Any]]:
    """Build SQL and params for fetching active agents according to scope.

    This function uses named parameters to support psycopg named binding.

    Returns:
        (sql, params)
    """
    scope_filter_sql = ""
    params: dict[str, Any] = {}

    if scope.type == "org":
        scope_filter_sql = "AND a.organization_id = ANY(%(organization_ids)s)"
        params["organization_ids"] = [
            str(organization_id) for organization_id in scope.organization_ids
        ]

    sql = f"""
    SELECT
      a.id AS agent_id,
      a.organization_id,
      a.name,
      a.system_prompt,
      a.temperature,
      a.max_tokens,
      a.langgraph_assistant_id,
      a.graph_id,
      mt.id AS mcp_tool_id,
      mt.endpoint_url AS mcp_endpoint_url,
      mt.tool_name AS mcp_tool_name,
      mt.is_builtin AS mcp_is_builtin,
      mt.auth_required AS mcp_auth_required,
      COALESCE(am.runtime_model_name, 'openai:gpt-4o') AS runtime_model_name
    FROM public.agents a
    LEFT JOIN public.agent_mcp_tools amt ON amt.agent_id = a.id
    LEFT JOIN public.mcp_tools mt ON mt.id = amt.mcp_tool_id
    LEFT JOIN public.global_ai_engines gae ON gae.id = a.engine_id
    LEFT JOIN public.ai_models am ON am.id = gae.language_model_id
    WHERE a.status = 'active'
      AND a.deleted_at IS NULL
      {scope_filter_sql}
    ORDER BY a.organization_id, a.name
    """.strip("\n")

    return sql, params


async def fetch_active_agents(
    pool: Any,
    scope: AgentSyncScope,
) -> list[AgentSyncData]:
    """Fetch active agents from Supabase/Postgres for sync.

    The function expects the project's configured async connection pool
    (created in `robyn_server.database.initialize_database()`).

    Args:
        pool: AsyncConnectionPool (psycopg_pool.AsyncConnectionPool).
            Typed as Any to avoid importing psycopg types at runtime.
        scope: Parsed scope determining which agents to return.

    Returns:
        List of AgentSyncData records aggregated by agent id.

    Raises:
        RuntimeError: If scope type is "none" (callers should skip sync).
        Exception: Propagates DB exceptions to the caller.
    """
    if scope.type == "none":
        raise RuntimeError("fetch_active_agents called with scope=none")

    sql, params = _build_fetch_agents_sql(scope)

    # psycopg with row_factory=dict_row (configured in database.py)
    # returns rows as dicts.
    async with pool.connection() as connection:
        cursor = await connection.execute(sql, params)
        rows = await cursor.fetchall()

    if not rows:
        return []

    # Defensive conversion to list[dict[str, Any]]
    normalized_rows: list[dict[str, Any]] = []
    for row in rows:
        if isinstance(row, dict):
            normalized_rows.append(row)
        else:
            # Unexpected row type; fall back to best-effort mapping.
            try:
                normalized_rows.append(dict(row))
            except Exception:
                continue

    return _group_agent_rows(normalized_rows)


async def fetch_active_agent_by_id(
    pool: Any,
    agent_id: UUID,
) -> AgentSyncData | None:
    """Fetch a single active agent by id (includes MCP tools).

    Args:
        pool: AsyncConnectionPool.
        agent_id: Agent UUID.

    Returns:
        AgentSyncData if found and active, else None.
    """
    sql = """
    SELECT
      a.id AS agent_id,
      a.organization_id,
      a.name,
      a.system_prompt,
      a.temperature,
      a.max_tokens,
      a.langgraph_assistant_id,
      a.graph_id,
      mt.id AS mcp_tool_id,
      mt.endpoint_url AS mcp_endpoint_url,
      mt.tool_name AS mcp_tool_name,
      mt.is_builtin AS mcp_is_builtin,
      mt.auth_required AS mcp_auth_required,
      COALESCE(am.runtime_model_name, 'openai:gpt-4o') AS runtime_model_name
    FROM public.agents a
    LEFT JOIN public.agent_mcp_tools amt ON amt.agent_id = a.id
    LEFT JOIN public.mcp_tools mt ON mt.id = amt.mcp_tool_id
    LEFT JOIN public.global_ai_engines gae ON gae.id = a.engine_id
    LEFT JOIN public.ai_models am ON am.id = gae.language_model_id
    WHERE a.id = %(agent_id)s
      AND a.status = 'active'
      AND a.deleted_at IS NULL
    ORDER BY a.organization_id, a.name
    """.strip("\n")

    params = {"agent_id": str(agent_id)}

    async with pool.connection() as connection:
        cursor = await connection.execute(sql, params)
        rows = await cursor.fetchall()

    if not rows:
        return None

    normalized_rows: list[dict[str, Any]] = []
    for row in rows:
        if isinstance(row, dict):
            normalized_rows.append(row)
        else:
            try:
                normalized_rows.append(dict(row))
            except Exception:
                continue

    agents = _group_agent_rows(normalized_rows)
    if not agents:
        return None
    return agents[0]


def _safe_mask_url(url: str | None) -> str | None:
    """Mask potentially sensitive URL parts for logs (drop query/fragment)."""
    if not url:
        return url
    return url.split("?", 1)[0].split("#", 1)[0]


def _build_assistant_configurable(agent: AgentSyncData) -> dict[str, Any]:
    """Build `config.configurable` for `react_agent.agent.graph()`.

    Emits multi-server MCP configuration:

        configurable["mcp_config"] = {
            "servers": [
                {"name": "...", "url": "...", "tools": [...], "auth_required": bool},
                ...
            ]
        }

    Servers are grouped by MCP endpoint URL, and tool filters are applied per
    server entry. This enables agents to use multiple MCP servers.
    """
    configurable: dict[str, Any] = {}

    # Org ID is required for store namespace scoping: (org_id, user_id, assistant_id, category)
    if agent.organization_id:
        configurable["supabase_organization_id"] = str(agent.organization_id)

    if agent.runtime_model_name:
        configurable["model_name"] = agent.runtime_model_name
    if agent.system_prompt is not None:
        configurable["system_prompt"] = agent.system_prompt
    if agent.temperature is not None:
        configurable["temperature"] = agent.temperature
    if agent.max_tokens is not None:
        configurable["max_tokens"] = agent.max_tokens

    if agent.mcp_tools:
        # Group tool names by endpoint URL.
        tools_by_endpoint_url: dict[str, list[str]] = {}
        auth_required_by_endpoint_url: dict[str, bool] = {}

        for mcp_tool in agent.mcp_tools:
            endpoint_url = mcp_tool.endpoint_url
            tool_name = mcp_tool.tool_name
            if not endpoint_url or not tool_name:
                continue

            tools_by_endpoint_url.setdefault(endpoint_url, []).append(str(tool_name))
            auth_required_by_endpoint_url[endpoint_url] = bool(
                auth_required_by_endpoint_url.get(endpoint_url, False)
                or bool(mcp_tool.auth_required)
            )

        servers: list[dict[str, Any]] = []
        for index, endpoint_url in enumerate(sorted(tools_by_endpoint_url.keys())):
            tool_names = sorted(set(tools_by_endpoint_url[endpoint_url]))
            servers.append(
                {
                    "name": f"server-{index + 1}",
                    "url": endpoint_url,
                    "tools": tool_names,
                    "auth_required": auth_required_by_endpoint_url.get(
                        endpoint_url, False
                    ),
                }
            )

        if servers:
            configurable["mcp_config"] = {"servers": servers}

    return configurable


def _assistant_payload_for_agent(agent: AgentSyncData) -> dict[str, Any]:
    """Build assistant create/update payload for storage.

    Storage expects a dict matching the assistant API shape used in this repo.
    This function only constructs fields necessary for correct execution.
    """
    assistant_id = str(agent.agent_id)
    return {
        "assistant_id": assistant_id,
        "graph_id": agent.graph_id or "agent",
        "config": {
            "configurable": _build_assistant_configurable(agent),
        },
        "metadata": {
            "supabase_agent_id": assistant_id,
            "supabase_organization_id": str(agent.organization_id)
            if agent.organization_id
            else None,
            "synced_at": datetime.now(timezone.utc).isoformat(),
        },
    }


def _extract_assistant_configurable(assistant: Any) -> dict[str, Any]:
    """Extract assistant.config.configurable as a dict when present."""
    config = getattr(assistant, "config", None)
    if config is None:
        return {}

    if hasattr(config, "model_dump"):
        dumped = config.model_dump()
    elif isinstance(config, dict):
        dumped = config
    else:
        return {}

    configurable = dumped.get("configurable", {})
    if isinstance(configurable, dict):
        return configurable
    return {}


async def _write_back_langgraph_assistant_id(
    pool: Any,
    *,
    agent_id: UUID,
    assistant_id: str,
) -> bool:
    """Write back langgraph_assistant_id to public.agents when needed.

    This is best-effort: if the column/table isn't available or update fails,
    we return False and let callers continue.
    """
    sql = """
    UPDATE public.agents
    SET langgraph_assistant_id = %(assistant_id)s
    WHERE id = %(agent_id)s
      AND (langgraph_assistant_id IS DISTINCT FROM %(assistant_id)s)
    """.strip("\n")

    params = {"assistant_id": assistant_id, "agent_id": str(agent_id)}

    async with pool.connection() as connection:
        cursor = await connection.execute(sql, params)
        try:
            row_count = cursor.rowcount
        except Exception:
            return False

    return bool(row_count and row_count > 0)


async def sync_single_agent(
    pool: Any,
    storage: AssistantStorageProtocol,
    *,
    agent: AgentSyncData,
    owner_id: str,
    write_back_assistant_id: bool = True,
) -> AgentSyncResult:
    """Create or update the LangGraph assistant for a single Supabase agent.

    Args:
        pool: AsyncConnectionPool.
        storage: Assistant storage implementation (passed in explicitly).
        agent: AgentSyncData produced by `fetch_active_agents()`/`fetch_active_agent_by_id()`.
        owner_id: Owner id used for assistant storage operations.
        write_back_assistant_id: If True, attempts to update `public.agents.langgraph_assistant_id`.

    Returns:
        AgentSyncResult describing what happened.

    Raises:
        Exception: If storage operations fail (callers can catch and aggregate).
    """
    assistant_id = str(agent.agent_id)
    payload = _assistant_payload_for_agent(agent)

    existing_assistant = await storage.assistants.get(assistant_id, owner_id)
    if existing_assistant is None:
        await storage.assistants.create(payload, owner_id)
        wrote_back = False
        if write_back_assistant_id:
            try:
                wrote_back = await _write_back_langgraph_assistant_id(
                    pool, agent_id=agent.agent_id, assistant_id=assistant_id
                )
            except Exception as write_back_error:
                logger.warning(
                    "Failed to write back langgraph_assistant_id for agent %s: %s",
                    agent.agent_id,
                    write_back_error,
                )
        return AgentSyncResult(
            assistant_id=assistant_id,
            action="created",
            wrote_back_assistant_id=wrote_back,
        )

    # Update when config differs (best-effort shallow comparison of configurable)
    existing_configurable = _extract_assistant_configurable(existing_assistant)
    desired_configurable = payload["config"]["configurable"]

    if existing_configurable == desired_configurable:
        return AgentSyncResult(
            assistant_id=assistant_id,
            action="skipped",
            wrote_back_assistant_id=False,
        )

    await storage.assistants.update(assistant_id, payload, owner_id)

    wrote_back = False
    if write_back_assistant_id:
        try:
            wrote_back = await _write_back_langgraph_assistant_id(
                pool, agent_id=agent.agent_id, assistant_id=assistant_id
            )
        except Exception as write_back_error:
            logger.warning(
                "Failed to write back langgraph_assistant_id for agent %s: %s",
                agent.agent_id,
                write_back_error,
            )

    return AgentSyncResult(
        assistant_id=assistant_id,
        action="updated",
        wrote_back_assistant_id=wrote_back,
    )


async def startup_agent_sync(
    pool: Any,
    storage: AssistantStorageProtocol,
    *,
    scope: AgentSyncScope,
    owner_id: str,
) -> dict[str, int]:
    """Sync agents at startup for the configured scope.

    This is intended to *warm* assistant storage in dev/single-tenant scenarios.
    In production multi-tenant environments, `scope` should usually be "none"
    and lazy sync should be used.

    Returns:
        Summary counters: {"total": N, "created": X, "updated": Y, "skipped": Z, "failed": W}
    """
    if scope.type == "none":
        return {"total": 0, "created": 0, "updated": 0, "skipped": 0, "failed": 0}

    agents = await fetch_active_agents(pool, scope)
    summary = {
        "total": len(agents),
        "created": 0,
        "updated": 0,
        "skipped": 0,
        "failed": 0,
    }

    for agent in agents:
        try:
            result = await sync_single_agent(
                pool,
                storage,
                agent=agent,
                owner_id=owner_id,
                write_back_assistant_id=True,
            )
            summary[result.action] += 1
        except Exception as sync_error:
            summary["failed"] += 1
            logger.exception(
                "Startup agent sync failed for agent %s: %s",
                agent.agent_id,
                sync_error,
            )

    logger.info(
        "Startup sync summary: total=%d created=%d updated=%d skipped=%d failed=%d",
        summary["total"],
        summary["created"],
        summary["updated"],
        summary["skipped"],
        summary["failed"],
    )
    return summary


async def lazy_sync_agent(
    pool: Any,
    storage: AssistantStorageProtocol,
    *,
    agent_id: UUID,
    owner_id: str,
    cache_ttl: timedelta = timedelta(minutes=5),
) -> str | None:
    """Sync a single agent on-demand and return the assistant_id.

    Behavior:
    - If assistant exists and appears recently synced, does nothing.
    - Otherwise fetches agent config from DB and creates/updates assistant.

    Returns:
        assistant_id on success, or None if agent not found/active.
    """
    assistant_id = str(agent_id)

    existing_assistant = await storage.assistants.get(assistant_id, owner_id)
    if existing_assistant is not None:
        # Best-effort TTL check using assistant metadata.synced_at if present.
        metadata = getattr(existing_assistant, "metadata", None)
        synced_at_text: str | None = None
        if isinstance(metadata, dict):
            synced_at_text = metadata.get("synced_at")
        if synced_at_text:
            try:
                synced_at = datetime.fromisoformat(
                    synced_at_text.replace("Z", "+00:00")
                )
                if datetime.now(timezone.utc) - synced_at < cache_ttl:
                    return assistant_id
            except Exception:
                # Ignore parse errors; we'll resync.
                pass

    agent = await fetch_active_agent_by_id(pool, agent_id)
    if agent is None:
        return None

    await sync_single_agent(
        pool,
        storage,
        agent=agent,
        owner_id=owner_id,
        write_back_assistant_id=True,
    )
    return assistant_id
