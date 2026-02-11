ARG BASE_IMAGE=ghcr.io/uncensored-ai-inc/fractal-agents-base:latest
FROM ${BASE_IMAGE}

# Copy entrypoint script from context
COPY fractal-agents/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Expose development and debug ports
EXPOSE 7373 5678

# Set the entrypoint
ENTRYPOINT ["/entrypoint.sh"]

# Health check for the development container
HEALTHCHECK --interval=30s --timeout=10s --start-period=180s --retries=3 \
    CMD curl -f http://localhost:7373/health || exit 1
