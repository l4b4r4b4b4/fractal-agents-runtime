import logging

from langchain.agents import create_agent
from langchain_core.runnables import RunnableConfig
from langchain_mcp_adapters.client import MultiServerMCPClient
from pydantic import BaseModel, Field

from graphs.configuration import MCPConfig, RagConfig
from graphs.llm import create_chat_model
from graphs.react_agent.utils.mcp_interceptors import (
    handle_interaction_required,
)
from graphs.react_agent.utils.token import fetch_tokens
from graphs.react_agent.utils.tools import create_rag_tool
from infra.prompts import get_prompt, register_default_prompt

logger = logging.getLogger(__name__)


def _safe_present_configurable_keys(config: RunnableConfig) -> list[str]:
    """Return a stable, non-sensitive view of the configurable keys present.

    This intentionally does not log values to avoid leaking secrets.
    """
    configurable: dict = config.get("configurable", {}) or {}
    return sorted(str(key) for key in configurable)


def _safe_mask_url(url: str | None) -> str | None:
    """Mask potentially sensitive URL parts (query strings, userinfo).

    This keeps the scheme/host/path which is enough to confirm routing.
    """
    if not url:
        return url
    # Avoid importing urllib just for logging; keep it conservative.
    # Drop query fragments if present.
    return url.split("?", 1)[0].split("#", 1)[0]


def _merge_assistant_configurable_into_run_config(
    config: RunnableConfig,
) -> RunnableConfig:
    """Merge assistant-level configurable settings into the run config.

    LangGraph runtime-inmem passes per-run metadata in `configurable`, but in some
    versions it may not automatically inject assistant `configurable` fields into
    `graph(config)`. This merge reads the assistant settings (if present) and
    overlays them onto the run config so fields such as `base_url` reach the agent.

    Notes:
        - Values are not logged here to avoid leaking secrets.
        - Run-level keys take precedence over assistant-level keys.

    Returns:
        A new RunnableConfig with merged `configurable`.
    """
    original_configurable: dict = config.get("configurable", {}) or {}

    # Common places LangGraph API may attach assistant settings:
    # - "assistant" (object)
    # - "assistant_config" (object)
    # - "assistant_configurable" (already flattened)
    assistant_configurable: dict = {}

    assistant_container = original_configurable.get("assistant")
    if isinstance(assistant_container, dict):
        assistant_cfg = assistant_container.get("configurable")
        if isinstance(assistant_cfg, dict):
            assistant_configurable.update(assistant_cfg)

    assistant_config_container = original_configurable.get("assistant_config")
    if isinstance(assistant_config_container, dict):
        assistant_cfg = assistant_config_container.get("configurable")
        if isinstance(assistant_cfg, dict):
            assistant_configurable.update(assistant_cfg)

    assistant_config_flat = original_configurable.get("assistant_configurable")
    if isinstance(assistant_config_flat, dict):
        assistant_configurable.update(assistant_config_flat)

    if not assistant_configurable:
        return config

    merged_configurable = {**assistant_configurable, **original_configurable}
    return {**config, "configurable": merged_configurable}


UNEDITABLE_SYSTEM_PROMPT = (
    "\nIf the tool throws an error requiring authentication, provide the user"
    " with a Markdown link to the authentication page and prompt them to"
    " authenticate."
)

DEFAULT_SYSTEM_PROMPT = (
    "You are a helpful assistant. You have access ONLY to the tools explicitly"
    " provided to you below. Do NOT claim to have access to any tools, APIs,"
    " or capabilities that are not listed. If the user asks for something that"
    " requires a tool you do not have, tell them honestly that you cannot do it"
    " with your current tools."
)

# Register with Langfuse prompt registry so seed_default_prompts() can
# auto-create this prompt in Langfuse on first startup.
register_default_prompt("react-agent-system-prompt", DEFAULT_SYSTEM_PROMPT)


# RagConfig, MCPServerConfig, MCPConfig imported from graphs.configuration


class GraphConfigPydantic(BaseModel):
    model_name: str | None = Field(
        default="openai:gpt-4o",
        json_schema_extra={
            "x_oap_ui_config": {
                "type": "select",
                "default": "openai:gpt-4o",
                "description": "The model to use in all generations",
                "options": [
                    {
                        "label": "Claude Sonnet 4",
                        "value": "anthropic:claude-sonnet-4-0",
                    },
                    {
                        "label": "Claude 3.7 Sonnet",
                        "value": "anthropic:claude-3-7-sonnet-latest",
                    },
                    {
                        "label": "Claude 3.5 Sonnet",
                        "value": "anthropic:claude-3-5-sonnet-latest",
                    },
                    {
                        "label": "Claude 3.5 Haiku",
                        "value": "anthropic:claude-3-5-haiku-latest",
                    },
                    {"label": "o4 mini", "value": "openai:o4-mini"},
                    {"label": "o3", "value": "openai:o3"},
                    {"label": "o3 mini", "value": "openai:o3-mini"},
                    {"label": "GPT 4o", "value": "openai:gpt-4o"},
                    {"label": "GPT 4o mini", "value": "openai:gpt-4o-mini"},
                    {"label": "GPT 4.1", "value": "openai:gpt-4.1"},
                    {"label": "GPT 4.1 mini", "value": "openai:gpt-4.1-mini"},
                    {
                        "label": "Custom OpenAI-compatible endpoint",
                        "value": "custom:",
                    },
                ],
            }
        },
    )
    temperature: float | None = Field(
        default=0.7,
        json_schema_extra={
            "x_oap_ui_config": {
                "type": "slider",
                "default": 0.7,
                "min": 0,
                "max": 2,
                "step": 0.1,
                "description": "Controls randomness (0 = deterministic, 2 = creative)",
            }
        },
    )
    max_tokens: int | None = Field(
        default=4000,
        json_schema_extra={
            "x_oap_ui_config": {
                "type": "number",
                "default": 4000,
                "min": 1,
                "description": "The maximum number of tokens to generate",
            }
        },
    )
    system_prompt: str | None = Field(
        default=DEFAULT_SYSTEM_PROMPT,
        json_schema_extra={
            "x_oap_ui_config": {
                "type": "textarea",
                "placeholder": "Enter a system prompt...",
                "description": (
                    "The system prompt to use in all generations."
                    " The following prompt will always be included"
                    " at the end of the system prompt:\n---"
                    f"{UNEDITABLE_SYSTEM_PROMPT}\n---"
                ),
                "default": DEFAULT_SYSTEM_PROMPT,
            }
        },
    )
    mcp_config: MCPConfig | None = Field(
        default=None,
        json_schema_extra={
            "x_oap_ui_config": {
                "type": "mcp",
            }
        },
    )
    rag: RagConfig | None = Field(
        default=None,
        json_schema_extra={
            "x_oap_ui_config": {
                "type": "rag",
                # Here is where you would set the default collection. Use collection IDs
                # "default": {
                #     "collections": [
                #         "fd4fac19-886c-4ac8-8a59-fff37d2b847f",
                #         "659abb76-fdeb-428a-ac8f-03b111183e25",
                #     ]
                # },
            }
        },
    )
    # Custom endpoint configuration
    base_url: str | None = Field(
        default=None,
        json_schema_extra={
            "x_oap_ui_config": {
                "type": "text",
                "placeholder": "http://localhost:7374/v1",
                "description": "Base URL for custom OpenAI-compatible API",
                "visible_when": {"model_name": "custom:"},
            }
        },
    )
    custom_model_name: str | None = Field(
        default=None,
        json_schema_extra={
            "x_oap_ui_config": {
                "type": "text",
                "placeholder": "mistralai/ministral-3b-instruct",
                "description": "Model name for custom endpoint",
                "visible_when": {"model_name": "custom:"},
            }
        },
    )
    custom_api_key: str | None = Field(
        default=None,
        json_schema_extra={
            "x_oap_ui_config": {
                "type": "password",
                "placeholder": "Leave empty for local vLLM",
                "description": "API key for custom endpoint (optional)",
                "visible_when": {"model_name": "custom:"},
            }
        },
    )


# get_api_key_for_model imported from graphs.llm


async def graph(config: RunnableConfig, *, checkpointer=None, store=None):
    config = _merge_assistant_configurable_into_run_config(config)

    # INFO-level, runtime-safe logging to confirm config propagation.
    # Do NOT log values that may contain secrets.
    logger.info(
        "graph() invoked; configurable_keys=%s",
        _safe_present_configurable_keys(config),
    )

    cfg = GraphConfigPydantic(**(config.get("configurable", {}) or {}))

    logger.info(
        "graph() parsed_config; model_name=%s base_url_present=%s"
        " custom_model_name_present=%s custom_api_key_present=%s",
        cfg.model_name,
        bool(cfg.base_url),
        bool(cfg.custom_model_name),
        bool(cfg.custom_api_key),
    )

    tools = []

    supabase_token = config.get("configurable", {}).get("x-supabase-access-token")
    if cfg.rag and cfg.rag.rag_url and cfg.rag.collections and supabase_token:
        for collection in cfg.rag.collections:
            rag_tool = await create_rag_tool(
                cfg.rag.rag_url, collection, supabase_token
            )
            tools.append(rag_tool)

    if cfg.mcp_config and cfg.mcp_config.servers:
        mcp_server_entries: dict[str, dict] = {}
        server_tool_filters: dict[str, set[str] | None] = {}
        any_auth_required = any(
            server.auth_required for server in cfg.mcp_config.servers
        )

        if any_auth_required:
            mcp_tokens = await fetch_tokens(config)
        else:
            mcp_tokens = None

        for server in cfg.mcp_config.servers:
            # Append /mcp only if the URL doesn't already end with it.
            raw_url = server.url.rstrip("/")
            server_url = raw_url if raw_url.endswith("/mcp") else raw_url + "/mcp"

            headers: dict[str, str] = {}
            if server.auth_required:
                if not mcp_tokens:
                    # Auth required but token exchange failed / not available.
                    # Skip connecting to this server.
                    logger.warning(
                        "MCP server skipped (auth required but no tokens): name=%s url=%s",
                        server.name,
                        _safe_mask_url(server_url),
                    )
                    continue
                headers["Authorization"] = f"Bearer {mcp_tokens['access_token']}"

            # Ensure unique keys for MultiServerMCPClient config
            server_key = server.name or "default"
            if server_key in mcp_server_entries:
                # Deterministic de-dupe by suffixing with an index.
                index = 2
                while f"{server_key}-{index}" in mcp_server_entries:
                    index += 1
                server_key = f"{server_key}-{index}"

            mcp_server_entries[server_key] = {
                "transport": "http",
                "url": server_url,
                "headers": headers,
            }
            server_tool_filters[server_key] = (
                set(server.tools) if server.tools else None
            )

        if mcp_server_entries:
            try:
                mcp_client = MultiServerMCPClient(
                    mcp_server_entries,
                    tool_interceptors=[handle_interaction_required],
                )
                mcp_tools = await mcp_client.get_tools()

                # Apply per-server filtering when requested.
                filtered_tools = []
                for tool in mcp_tools:
                    tool_origin = getattr(tool, "server_name", None)
                    if tool_origin and tool_origin in server_tool_filters:
                        requested = server_tool_filters[tool_origin]
                        if requested is None or tool.name in requested:
                            filtered_tools.append(tool)
                    else:
                        # If origin is unknown, include it (conservative).
                        filtered_tools.append(tool)

                tools.extend(filtered_tools)
                logger.info(
                    "MCP tools loaded: count=%d servers=%s",
                    len(filtered_tools),
                    [
                        _safe_mask_url(entry["url"])
                        for entry in mcp_server_entries.values()
                    ],
                )
            except Exception as e:
                logger.warning("Failed to fetch MCP tools: %s", str(e))

    # Initialize model via shared LLM factory
    configurable = config.get("configurable", {}) or {}

    # Build routing metadata for the semantic router (or any proxy).
    # These headers help the router make better routing decisions.
    routing_metadata: dict[str, str] = {"x-sr-graph-id": "agent"}
    org_id = configurable.get("x-org-id")
    if org_id:
        routing_metadata["x-sr-org-id"] = org_id
    user_tier = configurable.get("x-user-tier")
    if user_tier:
        routing_metadata["x-sr-user-tier"] = user_tier

    model = create_chat_model(
        config,
        model_name=cfg.model_name,
        temperature=cfg.temperature,
        max_tokens=cfg.max_tokens,
        base_url=cfg.base_url,
        custom_model_name=cfg.custom_model_name,
        model_name_override=configurable.get("model_name_override"),
        routing_metadata=routing_metadata,
    )

    # Persistence components are injected by the runtime caller.
    # When None (the default), the agent runs without persistence.
    if checkpointer is not None:
        logger.info("graph() using injected checkpointer for thread persistence")
    if store is not None:
        logger.info("graph() using injected store for cross-thread memory")

    # --- Resolve system prompt -------------------------------------------
    # Priority: assistant config > Langfuse prompt > hardcoded default.
    # If the user explicitly set a system prompt via the assistant
    # configurable (i.e. it differs from the default), honour it.
    # Otherwise, try Langfuse with the hardcoded default as fallback.
    if cfg.system_prompt and cfg.system_prompt != DEFAULT_SYSTEM_PROMPT:
        effective_system_prompt = cfg.system_prompt
        logger.info("System prompt: using assistant-configured override")
    else:
        effective_system_prompt = get_prompt(
            "react-agent-system-prompt",
            fallback=DEFAULT_SYSTEM_PROMPT,
            config=config,
        )
        logger.info("System prompt: resolved via get_prompt()")

    return create_agent(
        model=model,
        tools=tools,
        system_prompt=effective_system_prompt + UNEDITABLE_SYSTEM_PROMPT,
        checkpointer=checkpointer,
        store=store,
    )
