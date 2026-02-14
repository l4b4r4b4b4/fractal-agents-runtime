"""Main Robyn application entry point.

This module provides the Robyn web server for the OAP LangGraph Tools Agent.
It implements a LangGraph-compatible API for Open Agent Platform compatibility.
"""

import json
import logging
import os
import re

# ---------------------------------------------------------------------------
# Logging — configure BEFORE any other imports so all loggers inherit the level.
# Set LOG_LEVEL=DEBUG in .env or environment for full request tracing.
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=getattr(logging, os.getenv("LOG_LEVEL", "INFO").upper(), logging.INFO),
    format="%(asctime)s %(levelname)-8s [%(name)s] %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
)

from robyn import Request, Robyn
from robyn.openapi import OpenAPI, OpenAPIInfo

# Import tracing module early so LANGCHAIN_TRACING_V2 is set before
# any LangChain code is loaded.
from infra.prompts import seed_default_prompts
from infra.tracing import (
    initialize_langfuse,
    is_langfuse_enabled,
    shutdown_langfuse,
)

from server.agent_sync import parse_agent_sync_scope, startup_agent_sync
from server.storage import SYSTEM_OWNER_ID
from server.auth import auth_middleware
from server.config import get_config
from server.database import (
    get_connection,
    initialize_database,
    is_postgres_enabled,
    shutdown_database,
)
from server.models import HealthResponse, ServiceInfoResponse
from server.openapi_spec import (
    API_DESCRIPTION,
    API_TITLE,
    API_VERSION,
    get_openapi_spec,
)
from server.routes import (
    register_assistant_routes,
    register_cron_routes,
    register_run_routes,
    register_stream_routes,
    register_thread_routes,
)
from server.routes.a2a import register_a2a_routes
from server.routes.mcp import register_mcp_routes
from server.routes.metrics import register_metrics_routes
from server.routes.store import register_store_routes
from server.storage import get_storage

logger = logging.getLogger(__name__)

# Pre-compiled pattern for extracting well-known UUIDs from request paths.
# Matches path segments that look like UUIDs (with or without dashes) directly
# after known resource names.
_PATH_ID_PATTERN = re.compile(
    r"/(?P<resource>assistants|threads|runs)/(?P<id>[0-9a-fA-F-]{8,36})"
)

# Keys whose values must never appear in debug logs.
_SENSITIVE_KEYS = frozenset(
    {
        "authorization",
        "api_key",
        "apikey",
        "api-key",
        "token",
        "secret",
        "password",
        "credential",
    }
)

# Create custom OpenAPI configuration
openapi_info = OpenAPIInfo(
    title=API_TITLE,
    version=API_VERSION,
    description=API_DESCRIPTION,
)
openapi = OpenAPI(info=openapi_info)

# Override with our complete custom spec
openapi.openapi_spec = get_openapi_spec()
openapi.openapi_file_override = True

# Create the Robyn application with custom OpenAPI
app = Robyn(__file__, openapi=openapi)


# ---------------------------------------------------------------------------
# Lifecycle hooks
# ---------------------------------------------------------------------------


@app.startup_handler
async def on_startup() -> None:
    """Initialise Postgres persistence, Langfuse tracing, and optional agent sync."""
    database_enabled = await initialize_database()
    if database_enabled:
        logger.info("Robyn startup: Postgres persistence enabled")
    else:
        logger.info("Robyn startup: running with in-memory storage")

    if initialize_langfuse():
        logger.info("Robyn startup: Langfuse tracing enabled")
        # Auto-create any missing prompts in Langfuse so users have
        # something to iterate on in the UI from the very first deploy.
        # Import graphs to trigger their register_default_prompt() calls.
        import graphs.react_agent.agent  # noqa: F401 — registration side-effect
        import graphs.research_agent.prompts  # noqa: F401 — registration side-effect

        seeded = seed_default_prompts()
        if seeded:
            logger.info("Robyn startup: seeded %d prompt(s) in Langfuse", seeded)
    else:
        logger.info("Robyn startup: Langfuse tracing disabled (not configured)")

    # -----------------------------------------------------------------------
    # Optional startup agent sync (warm cache)
    #
    # Production default: AGENT_SYNC_SCOPE=none (lazy sync only).
    # Dev testing:        AGENT_SYNC_SCOPE=all
    # -----------------------------------------------------------------------
    if not is_postgres_enabled():
        logger.info("Robyn startup: agent sync skipped (Postgres not enabled)")
        return

    # Read scope from environment via parser to avoid coupling app to config changes.
    import os

    try:
        scope = parse_agent_sync_scope(os.getenv("AGENT_SYNC_SCOPE", "none"))
    except ValueError as scope_error:
        logger.warning(
            "Robyn startup: invalid AGENT_SYNC_SCOPE; skipping startup sync. error=%s",
            scope_error,
        )
        return

    if scope.type == "none":
        logger.info("Robyn startup: agent sync disabled (AGENT_SYNC_SCOPE=none)")
        return

    try:
        storage = get_storage()
        summary = await startup_agent_sync(
            get_connection,
            storage,
            scope=scope,
            owner_id=SYSTEM_OWNER_ID,
        )
        logger.info(
            "Robyn startup: agent sync complete total=%d created=%d updated=%d skipped=%d failed=%d",
            summary.get("total", 0),
            summary.get("created", 0),
            summary.get("updated", 0),
            summary.get("skipped", 0),
            summary.get("failed", 0),
        )
    except Exception as sync_error:
        # Non-fatal: the server should still start even if sync fails.
        logger.exception("Robyn startup: agent sync failed (non-fatal): %s", sync_error)


@app.shutdown_handler
async def on_shutdown() -> None:
    """Reset database state and close Langfuse client gracefully."""
    shutdown_langfuse()
    await shutdown_database()
    logger.info("Robyn shutdown: database and tracing resources released")


# ---------------------------------------------------------------------------
# Debug request logging middleware — registered BEFORE auth so every
# request is logged, including those rejected by auth.
#
# At INFO:  one-line summary (method, path, extracted IDs)
# At DEBUG: full request details (headers, body) with sensitive values masked
# ---------------------------------------------------------------------------


async def log_request(request: Request) -> Request:
    """Log incoming requests at DEBUG level for development/integration tracing.

    Extracted as a standalone async function so it can be tested independently
    of Robyn's ``@app.before_request()`` decorator (which consumes the function
    and returns ``None``).
    """
    if not logger.isEnabledFor(logging.DEBUG):
        return request

    # Extract path — handle Robyn's URL object variations
    if hasattr(request, "url"):
        url = request.url
        path = url.path if hasattr(url, "path") else str(url).split("?")[0]
    else:
        path = "/"

    method = request.method if hasattr(request, "method") else "?"

    # Extract well-known resource IDs from the path
    ids = {m.group("resource"): m.group("id") for m in _PATH_ID_PATTERN.finditer(path)}
    id_parts = " ".join(f"{resource}_id={rid}" for resource, rid in ids.items())

    # Content length (may not be present on all requests)
    content_length = (
        request.headers.get("content-length")
        or request.headers.get("Content-Length")
        or "-"
    )

    # One-line summary
    logger.debug(
        "▶ %s %s %scontent_length=%s",
        method,
        path,
        f"{id_parts} " if id_parts else "",
        content_length,
    )

    # Full body at DEBUG (only for methods that typically have a body)
    if method in ("POST", "PUT", "PATCH"):
        try:
            raw_body = request.body if hasattr(request, "body") else None
            if raw_body:
                body_str = (
                    raw_body
                    if isinstance(raw_body, str)
                    else raw_body.decode("utf-8", errors="replace")
                )
                if len(body_str) <= 4096:
                    # Try to parse as JSON for pretty-printing and masking
                    try:
                        body_obj = json.loads(body_str)
                        _mask_sensitive(body_obj)
                        logger.debug("  body: %s", json.dumps(body_obj, default=str))
                    except (json.JSONDecodeError, TypeError):
                        logger.debug("  body (raw): %s", body_str[:2048])
                else:
                    logger.debug("  body: <%d bytes, truncated>", len(body_str))
        except Exception:
            pass  # Never fail the request because of debug logging

    return request


@app.before_request()
async def request_logging_middleware(request: Request) -> Request:
    """Robyn before-request hook — delegates to :func:`log_request`."""
    return await log_request(request)


def _is_sensitive_key(key: str) -> bool:
    """Check if a key name contains any sensitive keyword (substring match).

    This catches keys like ``OPENAI_API_KEY``, ``custom_api_key``,
    ``x-auth-token``, etc. — not just exact matches.
    """
    lower = key.lower()
    return any(sensitive in lower for sensitive in _SENSITIVE_KEYS)


def _mask_sensitive(obj: object, _depth: int = 0) -> None:
    """Recursively mask values of sensitive keys in a dict/list, in-place.

    Handles nested structures up to depth 5 to avoid pathological payloads.
    """
    if _depth > 5:
        return
    if isinstance(obj, dict):
        for key in obj:
            if isinstance(key, str) and _is_sensitive_key(key):
                obj[key] = "***"
            else:
                _mask_sensitive(obj[key], _depth + 1)
    elif isinstance(obj, list):
        for item in obj:
            _mask_sensitive(item, _depth + 1)


# Register authentication middleware using decorator pattern
@app.before_request()
async def middleware_wrapper(request):
    """Wrap auth middleware for Robyn's decorator pattern."""
    return await auth_middleware(request)


# Register API routes
register_assistant_routes(app)
register_thread_routes(app)
register_run_routes(app)
register_stream_routes(app)
register_metrics_routes(app)
register_store_routes(app)
register_mcp_routes(app)
register_cron_routes(app)
register_a2a_routes(app)


# ============================================================================
# Health & Info Endpoints
# ============================================================================


@app.get("/health")
async def health() -> dict:
    """Health check endpoint (public - no auth required).

    Returns:
        JSON response with status "ok" and persistence information.
    """
    response = HealthResponse()
    data = response.model_dump()
    data["persistence"] = "postgres" if is_postgres_enabled() else "in-memory"
    return data


@app.get("/ok")
async def ok() -> dict:
    """LangGraph-style health check endpoint (public - no auth required).

    Returns:
        JSON response with {"ok": true} matching LangGraph API shape.
    """
    return {"ok": True}


@app.get("/")
async def root() -> dict:
    """Root endpoint with service information (public - no auth required).

    Returns:
        JSON response with service name, runtime, and version.
    """
    response = ServiceInfoResponse()
    return response.model_dump()


@app.get("/info")
async def info() -> dict:
    """Detailed service information endpoint (public - no auth required).

    Returns LangGraph-compatible service information including:
    - Version and build info
    - Capability flags
    - Available graphs
    - Runtime details

    Returns:
        JSON response with service details and configuration status.
    """
    import os
    import subprocess
    from datetime import datetime

    config = get_config()

    # Try to get git commit hash
    commit_hash = "unknown"
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if result.returncode == 0:
            commit_hash = result.stdout.strip()
    except Exception:
        pass

    # Get build date from environment or use current date
    build_date = os.getenv("BUILD_DATE", datetime.now().strftime("%Y-%m-%d"))

    return {
        # Core identification
        "service": "oap-langgraph-tools-agent",
        "runtime": "robyn",
        "version": "0.1.0",
        # Build information
        "build": {
            "commit": commit_hash,
            "date": build_date,
            "python": os.sys.version.split()[0],
        },
        # Capability flags (what features are available)
        "capabilities": {
            "streaming": True,  # SSE streaming supported
            "store": True,  # Store API supported
            "crons": True,  # Cron jobs (scheduled runs) implemented
            "a2a": True,  # Agent-to-Agent protocol implemented
            "mcp": True,  # MCP endpoints implemented
            "metrics": True,  # Prometheus metrics available
            "persistence": is_postgres_enabled(),  # Postgres persistence
            "tracing": is_langfuse_enabled(),  # Langfuse tracing
        },
        # Available agent graphs
        "graphs": ["agent", "research_agent"],
        # Configuration status
        "config": {
            "supabase_configured": config.supabase.is_configured,
            "llm_configured": bool(
                config.llm.openai_api_key or config.llm.openai_api_base
            ),
            "postgres_configured": config.database.is_configured,
            "postgres_connected": is_postgres_enabled(),
        },
        # Tier completion status
        "tiers": {
            "tier1": True,  # Core CRUD + Streaming
            "tier2": True,  # Search/Count/List
            "tier3": True,  # Metrics + Store + Crons + A2A + MCP
        },
    }


# ============================================================================
# Main Entry Point
# ============================================================================


def main() -> None:
    """Start the Robyn server."""
    config = get_config()
    print(f"Starting Robyn server on {config.server.host}:{config.server.port}")
    app.start(
        host=config.server.host,
        port=config.server.port,
    )


if __name__ == "__main__":
    main()
