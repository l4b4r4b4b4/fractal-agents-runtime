# STAGE 1: Builder
ARG BASE_IMAGE=python:3.10-slim
FROM ${BASE_IMAGE} AS builder
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

# Copy project dependencies
COPY pyproject.toml poetry.lock* ./

# Install dependencies including development ones for debugging
RUN poetry install --no-root --all-extras --with dev

# Copy source code
COPY . .

# Build the package
RUN poetry build

# STAGE 2: Runner
FROM ${BASE_IMAGE} AS runner
WORKDIR /app

# Install runtime dependencies and debugging tools
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    curl \
    libpq-dev \
    postgresql-client \
    ca-certificates \
    vim \
    htop \
    net-tools \
    && rm -rf /var/lib/apt/lists/*

# Create a non-root user
RUN groupadd -g 1001 appuser && \
    useradd -r -u 1001 -g appuser appuser

# Copy the built package and dependencies from the builder
COPY --from=builder /app/dist/*.whl /tmp/
RUN pip install --no-cache-dir /tmp/*.whl && rm /tmp/*.whl

# Install debugging packages
RUN pip install --no-cache-dir ipython debugpy

# Copy configuration files
COPY --chown=appuser:appuser config /app/config
COPY --chown=appuser:appuser alembic.ini /app/

# Set environment variables
ENV PYTHONPATH=/app
ENV PYTHONUNBUFFERED=1
ENV PORT=7373
ENV HOSTNAME=0.0.0.0
ENV NODE_ENV=staging

# Set CUDA-related environment variables
ENV NVIDIA_VISIBLE_DEVICES=all
ENV NVIDIA_DRIVER_CAPABILITIES=compute,utility,video
ENV HF_HUB_ENABLE_HF_TRANSFER=1

# Create a startup script with enhanced logging
RUN echo '#!/bin/bash\n\
echo "Starting fractal-agents service in staging mode..."\n\
    exec gunicorn src.system_0.app:app --workers 2 --worker-class uvicorn.workers.UvicornWorker --bind 0.0.0.0:7373 --access-logformat "%(h)s %(l)s %(u)s %(t)s \"%(r)s\" %(s)s %(b)s \"%(f)s\" \"%(a)s\" %(L)s"\n\
    ' > /app/start.sh && chmod +x /app/start.sh && chown appuser:appuser /app/start.sh

# Switch to non-root user
USER appuser

# Expose API port
EXPOSE 7373 5678

# Start the FastAPI application with Gunicorn and Uvicorn workers
CMD ["/app/start.sh"]

# Health check for Kubernetes
HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
    CMD curl -f http://localhost:7373/health || exit 1
