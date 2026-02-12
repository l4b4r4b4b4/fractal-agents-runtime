import logging
import os

from langchain.agents import create_agent
from langchain.chat_models import init_chat_model
from langchain_core.runnables import RunnableConfig
from langchain_mcp_adapters.client import MultiServerMCPClient
from langchain_openai import ChatOpenAI
from pydantic import BaseModel, Field

from react_agent.utils.mcp_interceptors import (
    handle_interaction_required,
)
from react_agent.utils.token import fetch_tokens
from react_agent.utils.tools import create_rag_tool

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


class RagConfig(BaseModel):
    rag_url: str | None = None
    """The URL of the rag server"""
    collections: list[str] | None = None
    """The collections to use for rag"""


class MCPServerConfig(BaseModel):
    """Configuration for a single MCP server.

    Attributes:
        name: Stable identifier for this server entry. Used as the key when
            creating the MultiServerMCPClient config dict.
        url: Base URL for the MCP server (may or may not end with /mcp).
        tools: Optional list of tool names to expose from this server.
            If omitted/None, all tools from the server are exposed.
        auth_required: Whether this server requires auth token exchange.
    """

    name: str = Field(
        default="default",
        optional=True,
    )
    url: str
    tools: list[str] | None = Field(
        default=None,
        optional=True,
    )
    auth_required: bool = Field(
        default=False,
        optional=True,
    )


class MCPConfig(BaseModel):
    """Multi-server MCP configuration (no backward compatibility)."""

    servers: list[MCPServerConfig] = Field(default_factory=list)


class GraphConfigPydantic(BaseModel):
    model_name: str | None = Field(
        default="openai:gpt-4o",
        metadata={
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
        metadata={
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
        metadata={
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
        metadata={
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
        optional=True,
        metadata={
            "x_oap_ui_config": {
                "type": "mcp",
            }
        },
    )
    rag: RagConfig | None = Field(
        default=None,
        optional=True,
        metadata={
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
        optional=True,
        metadata={
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
        optional=True,
        metadata={
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
        optional=True,
        metadata={
            "x_oap_ui_config": {
                "type": "password",
                "placeholder": "Leave empty for local vLLM",
                "description": "API key for custom endpoint (optional)",
                "visible_when": {"model_name": "custom:"},
            }
        },
    )


def get_api_key_for_model(model_name: str, config: RunnableConfig):
    model_name = model_name.lower()

    # Handle custom endpoints
    if model_name.startswith("custom:"):
        # First check config for custom_api_key
        custom_key = config.get("configurable", {}).get("custom_api_key")
        if custom_key:
            return custom_key
        # Fallback to environment variable
        return os.getenv("CUSTOM_API_KEY")

    # Existing logic for standard providers
    model_to_key = {
        "openai:": "OPENAI_API_KEY",
        "anthropic:": "ANTHROPIC_API_KEY",
        "google": "GOOGLE_API_KEY",
    }
    key_name = next(
        (key for prefix, key in model_to_key.items() if model_name.startswith(prefix)),
        None,
    )
    if not key_name:
        return None
    api_keys = config.get("configurable", {}).get("apiKeys", {})
    if api_keys and api_keys.get(key_name) and len(api_keys[key_name]) > 0:
        return api_keys[key_name]
    # Fallback to environment variable
    return os.getenv(key_name)


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
            rag_tool = await create_rag_tool(cfg.rag.rag_url, collection, supabase_token)
            tools.append(rag_tool)

    if cfg.mcp_config and cfg.mcp_config.servers:
        mcp_server_entries: dict[str, dict] = {}
        server_tool_filters: dict[str, set[str] | None] = {}
        any_auth_required = any(server.auth_required for server in cfg.mcp_config.servers)

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
            server_tool_filters[server_key] = set(server.tools) if server.tools else None

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
                    [_safe_mask_url(entry["url"]) for entry in mcp_server_entries.values()],
                )
            except Exception as e:
                logger.warning("Failed to fetch MCP tools: %s", str(e))

    # Initialize model based on configuration
    if cfg.base_url:
        # Custom endpoint - use ChatOpenAI with OpenAI-compatible base URL.
        # LangChain's vLLM integration docs recommend `openai_api_base` + `openai_api_key="EMPTY"`.
        masked_base_url = _safe_mask_url(cfg.base_url)
        logger.info("LLM routing: custom endpoint enabled; base_url=%s", masked_base_url)

        # Get API key for custom endpoint (do not log the key)
        api_key = get_api_key_for_model("custom:", config)
        if not api_key:
            # Use "EMPTY" for local vLLM that doesn't require authentication
            api_key = "EMPTY"
            logger.info("LLM auth: no custom API key provided; using EMPTY")
        else:
            logger.info("LLM auth: custom API key provided (masked)")

        # Use custom model name if provided, otherwise use the configured model_name
        model_name = cfg.custom_model_name or cfg.model_name
        logger.info("LLM model: %s", model_name)

        # Prefer the vLLM-recommended parameters. Avoid passing multiple aliases
        # for the same setting to reduce ambiguity across versions.
        model = ChatOpenAI(
            openai_api_base=cfg.base_url,
            openai_api_key=api_key,
            model=model_name,
            temperature=cfg.temperature,
            max_tokens=cfg.max_tokens,
        )
    else:
        # Standard provider - use init_chat_model
        logger.info("LLM routing: standard provider enabled; model_name=%s", cfg.model_name)
        api_key = get_api_key_for_model(cfg.model_name, config)
        logger.info("LLM auth: standard provider api key present=%s", bool(api_key))

        model = init_chat_model(
            cfg.model_name,
            temperature=cfg.temperature,
            max_tokens=cfg.max_tokens,
            api_key=api_key or "No token found",
        )

    # Persistence components are injected by the runtime caller.
    # When None (the default), the agent runs without persistence.
    if checkpointer is not None:
        logger.info("graph() using injected checkpointer for thread persistence")
    if store is not None:
        logger.info("graph() using injected store for cross-thread memory")

    return create_agent(
        model=model,
        tools=tools,
        system_prompt=cfg.system_prompt + UNEDITABLE_SYSTEM_PROMPT,
        checkpointer=checkpointer,
        store=store,
    )
