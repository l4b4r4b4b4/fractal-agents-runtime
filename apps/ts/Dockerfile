# Multi-stage Dockerfile for Fractal Agents Runtime — TypeScript/Bun
# https://bun.sh/guides/ecosystem/docker

# Build stage
FROM oven/bun:1.3.8 AS builder

WORKDIR /app

# Install dependencies first (cached layer)
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production

# Copy application source
COPY src/ ./src/
COPY tsconfig.json ./

# Build the application
RUN bun build src/index.ts --outdir dist --target bun

# Runtime stage — minimal image
FROM oven/bun:1.3.8-slim AS runtime

LABEL org.opencontainers.image.source="https://github.com/l4b4r4b4b4/fractal-agents-runtime"
LABEL org.opencontainers.image.description="Fractal Agents Runtime — TypeScript/Bun (free, self-hostable LangGraph-compatible agent runtime)"
LABEL org.opencontainers.image.licenses="MIT"

# Create non-root user for security (no adduser in slim images)
RUN echo "appuser:x:65532:65532:appuser:/home/appuser:/sbin/nologin" >> /etc/passwd && \
    echo "appuser:x:65532:" >> /etc/group && \
    mkdir -p /home/appuser && \
    chown 65532:65532 /home/appuser

WORKDIR /app

# Copy built output and production node_modules
COPY --from=builder --chown=65532:65532 /app/dist ./dist
COPY --from=builder --chown=65532:65532 /app/node_modules ./node_modules
COPY --from=builder --chown=65532:65532 /app/package.json ./

# Set environment variables
ENV NODE_ENV=production \
    PORT=3000

# Switch to non-root user
USER appuser

# Expose server port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD bun -e "fetch('http://localhost:3000/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

# Run the server
CMD ["bun", "run", "dist/index.js"]
