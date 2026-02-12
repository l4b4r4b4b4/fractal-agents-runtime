# Multi-stage Dockerfile for Fractal Agents Runtime — Python/Robyn
# Build context: repo root (so we can access both apps/ and packages/)
# Usage: docker build -f .devops/docker/python.Dockerfile .
#
# Best practices from https://docs.astral.sh/uv/guides/integration/docker/
#   - Pin uv version via COPY --from distroless image
#   - Bind-mount pyproject.toml + uv.lock for dependency layer (no extra COPY)
#   - Separate dependency install from project install (intermediate layers)
#   - --no-editable so .venv is self-contained (no source needed at runtime)
#   - UV_COMPILE_BYTECODE for faster cold start
#   - UV_LINK_MODE=copy because cache is a mounted volume
#   - Non-root user in runtime stage

# ── Build stage ───────────────────────────────────────────────────────
FROM python:3.12-slim-bookworm AS builder

# Pin uv version — update deliberately, not by accident
COPY --from=ghcr.io/astral-sh/uv:0.10.2 /uv /uvx /bin/

WORKDIR /app

# Enable bytecode compilation for faster startup
ENV UV_COMPILE_BYTECODE=1
# Copy from cache instead of linking (cache is a mounted volume)
ENV UV_LINK_MODE=copy
# Omit development dependencies in all uv sync calls
ENV UV_NO_DEV=1

# ── Copy path dependencies first (change less often than app code) ────
# The app's pyproject.toml references these via:
#   [tool.uv.sources]
#   fractal-graph-react-agent = { path = "../../packages/python/graphs/react_agent" }
#   fractal-agent-infra = { path = "../../packages/python/infra/fractal_agent_infra" }
# From WORKDIR /app, ../../packages resolves to /packages — matching these COPY targets.
COPY packages/python/infra/fractal_agent_infra/ /packages/python/infra/fractal_agent_infra/
COPY packages/python/graphs/react_agent/ /packages/python/graphs/react_agent/

# ── Install dependencies only (cached layer) ─────────────────────────
# Bind-mount pyproject.toml + uv.lock so they don't create an extra image layer.
# --no-install-project skips installing our project but DOES install all deps
# (including the graph + infra path dependencies copied above).
RUN --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=apps/python/uv.lock,target=uv.lock \
    --mount=type=bind,source=apps/python/pyproject.toml,target=pyproject.toml \
    uv sync --locked --no-install-project --no-editable

# ── Install the project itself ────────────────────────────────────────
# Now copy project metadata + source for the final sync that installs
# the robyn_server package into the venv (non-editable).
COPY apps/python/pyproject.toml apps/python/uv.lock ./
COPY apps/python/src/robyn_server/ ./src/robyn_server/

RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked --no-editable

# ── Runtime stage — minimal image ────────────────────────────────────
FROM python:3.12-slim-bookworm AS runtime

LABEL org.opencontainers.image.source="https://github.com/l4b4r4b4b4/fractal-agents-runtime"
LABEL org.opencontainers.image.description="Fractal Agents Runtime — Python/Robyn (free, self-hostable LangGraph-compatible agent runtime)"
LABEL org.opencontainers.image.licenses="MIT"

# Runtime system deps (curl needed for HEALTHCHECK)
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# Non-root user
RUN useradd --create-home --uid 65532 appuser

WORKDIR /app

# Copy only the virtual environment from builder.
# Because we used --no-editable, the project + path dependency are fully
# installed into site-packages — no source code needed in the final image.
COPY --from=builder --chown=appuser:appuser /app/.venv /app/.venv

# Place venv at front of PATH; configure Python for containers
ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    # Robyn server configuration (overridable at runtime)
    ROBYN_HOST="0.0.0.0" \
    ROBYN_PORT="8081" \
    ROBYN_WORKERS="4"

# Runtime directories
RUN mkdir -p /app/data /tmp/robyn \
    && chown -R appuser:appuser /app /tmp/robyn

USER appuser

EXPOSE 8081

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -f http://localhost:8081/health || exit 1

CMD ["python", "-m", "robyn_server"]
