FROM pytorch/pytorch:2.6.0-cuda12.4-cudnn9-runtime

WORKDIR /app

# Install essential OS-level dependencies
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    curl \
    iputils-ping \
    libpq-dev \
    postgresql-client \
    gcc \
    git \
    && rm -rf /var/lib/apt/lists/*

# Install Poetry
RUN pip install --no-cache-dir poetry==1.5.1

# Configure Poetry
RUN poetry config virtualenvs.create false

# Set environment variables
ENV PYTHONPATH=/app
ENV PYTHONUNBUFFERED=1
ENV PORT=7373
ENV HOSTNAME=0.0.0.0

# Set CUDA-related environment variables
ENV NVIDIA_VISIBLE_DEVICES=all
ENV NVIDIA_DRIVER_CAPABILITIES=compute,utility,video
ENV HF_HUB_ENABLE_HF_TRANSFER=1

# Default command - will be overridden by specific environment Dockerfiles
CMD ["echo", "This is a GPU base image and should not be run directly"]
