# STAGE 1: Builder
ARG FRACTAL_AGENTS_BASE_IMAGE=ghcr.io/uncensored-ai-inc/fractal-agents-base:latest
FROM python:3.11-slim AS builder
WORKDIR /app

# Install essential build dependencies
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    curl \
    libpq-dev \
    gcc \
    g++ \
    git \
    && rm -rf /var/lib/apt/lists/*

# Install Poetry
RUN pip install --no-cache-dir poetry==1.5.1

# Configure Poetry
RUN poetry config virtualenvs.create false

# Copy project dependencies from fractal-agents directory
COPY fractal-agents/pyproject.toml fractal-agents/poetry.lock* ./

# Install dependencies
RUN poetry install --no-root --only main --all-extras

# Copy source code from fractal-agents directory
COPY fractal-agents .

# Build the package
RUN poetry build

# STAGE 2: Runner
FROM python:3.11-slim AS runner
WORKDIR /app

# Install runtime dependencies
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    curl \
    libpq-dev \
    postgresql-client \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Create a non-root user
RUN groupadd -g 1001 appuser && \
    useradd -r -u 1001 -g appuser appuser

# Copy the built package and dependencies from the builder
COPY --from=builder /app/dist/*.whl /tmp/
RUN pip install --no-cache-dir /tmp/*.whl && rm /tmp/*.whl

# Copy source code from builder stage
COPY --from=builder --chown=appuser:appuser /app/src /app/src

# Copy configuration files (if they exist)
# COPY --chown=appuser:appuser config /app/config
# COPY --chown=appuser:appuser alembic.ini /app/

# Set environment variables
ENV PYTHONPATH=/app
ENV PYTHONUNBUFFERED=1
ENV PORT=7373
ENV HOSTNAME=0.0.0.0
ENV NODE_ENV=production

# Set CUDA-related environment variables (base image may have these)
ENV NVIDIA_VISIBLE_DEVICES=all
ENV NVIDIA_DRIVER_CAPABILITIES=compute,utility,video
ENV HF_HUB_ENABLE_HF_TRANSFER=1

# Switch to non-root user
USER appuser

# Expose API port
EXPOSE 7373

# Start the FastAPI application using the poetry script entry point
CMD ["fractal_agents"]

# Health check for Kubernetes
HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
    CMD curl -f http://localhost:7373/health || exit 1
