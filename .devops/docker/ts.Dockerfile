# Multi-stage Dockerfile for Fractal Agents Runtime — TypeScript/Bun
# Build context: repo root (so we can access both apps/ and packages/)
# Usage: docker build -f .devops/docker/ts.Dockerfile .
#
# Bun Docker best practices:
#   https://bun.com/docs/guides/ecosystem/docker
#   https://bun.com/docs/bundler/bytecode

# ── Build stage ───────────────────────────────────────────────────────
FROM oven/bun:1.3.8 AS builder

WORKDIR /app

# ── Install runtime dependencies (cached layer) ──────────────────────
COPY apps/ts/package.json apps/ts/bun.lock* ./
RUN bun install --frozen-lockfile --production

# ── Copy runtime application source ──────────────────────────────────
COPY apps/ts/src/ ./src/
COPY apps/ts/tsconfig.json ./

# Build with bytecode compilation for faster cold start, minified,
# with sourcemaps for production debugging.
# --compile produces a single self-contained executable.
RUN bun build \
    --bytecode \
    --minify \
    --sourcemap \
    --target=bun \
    --compile \
    ./src/index.ts \
    --outfile=./dist/server

# ── Runtime stage — minimal image ────────────────────────────────────
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

# Copy the compiled single binary — no node_modules needed at runtime
COPY --from=builder --chown=65532:65532 /app/dist/server ./server

# Set environment variables
ENV NODE_ENV=production \
    PORT=3000

# Switch to non-root user
USER appuser

# Expose server port
EXPOSE 3000

# Health check — uses bun -e since slim still includes bun runtime
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD bun -e "fetch('http://localhost:3000/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

# Run the compiled server binary
CMD ["./server"]
