# Multi-stage Dockerfile for Fractal Agents Runtime — Python/Robyn
# Following UV Docker best practices: https://docs.astral.sh/uv/guides/integration/docker/

# Build stage
FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim AS builder

LABEL org.opencontainers.image.source="https://github.com/l4b4r4b4b4/fractal-agents-runtime"
LABEL org.opencontainers.image.description="Fractal Agents Runtime — Python/Robyn (free, self-hostable LangGraph-compatible agent runtime)"
LABEL org.opencontainers.image.licenses="MIT"

WORKDIR /app

# Enable bytecode compilation for faster startup
ENV UV_COMPILE_BYTECODE=1
# Use copy mode since we're using cache mounts
ENV UV_LINK_MODE=copy
# Disable dev dependencies
ENV UV_NO_DEV=1

# Install dependencies first (cached layer)
RUN --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=uv.lock,target=uv.lock \
    --mount=type=bind,source=pyproject.toml,target=pyproject.toml \
    uv sync --locked --no-install-project --no-editable

# Copy application source (src/ layout)
COPY src/react_agent_with_mcp_tools/ ./src/react_agent_with_mcp_tools/
COPY src/robyn_server/ ./src/robyn_server/

# Copy pyproject.toml and uv.lock for final sync
COPY pyproject.toml uv.lock ./

# Sync the project (installs the project itself)
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked --no-editable

# Runtime stage — minimal image
FROM python:3.12-slim-bookworm AS runtime

LABEL org.opencontainers.image.source="https://github.com/l4b4r4b4b4/fractal-agents-runtime"
LABEL org.opencontainers.image.description="Fractal Agents Runtime — Python/Robyn (free, self-hostable LangGraph-compatible agent runtime)"
LABEL org.opencontainers.image.licenses="MIT"

# Install runtime system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

# Create non-root user for security
RUN useradd --create-home --uid 65532 appuser

WORKDIR /app

# Copy the virtual environment from builder
COPY --from=builder --chown=appuser:appuser /app/.venv /app/.venv

# Set environment variables
ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    # Robyn server configuration
    ROBYN_HOST="0.0.0.0" \
    ROBYN_PORT="8081" \
    ROBYN_WORKERS="4"

# Create runtime directories
RUN mkdir -p /app/data /tmp/robyn && \
    chown -R appuser:appuser /app /tmp/robyn

# Switch to non-root user
USER appuser

# Expose Robyn server port
EXPOSE 8081

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -f http://localhost:8081/health || exit 1

# Run the Robyn server
CMD ["python", "-m", "robyn_server"]
