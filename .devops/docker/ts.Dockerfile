# Multi-stage Dockerfile for Fractal Agents Runtime — TypeScript/Bun
# Build context: repo root (so we can access both apps/ and packages/)
# Usage: docker build -f .devops/docker/ts.Dockerfile .
#
# Follows official Bun Docker best practices:
#   https://bun.com/docs/guides/ecosystem/docker
#
# NOTE: We do NOT use `bun build --compile` because @langchain/* packages
# rely on dynamic imports, WASM modules, and other patterns that are
# incompatible with single-binary compilation. Bun runs TypeScript
# natively, so no build step is needed.

# ── Base stage ────────────────────────────────────────────────────────
# Use the official Bun image as base for all stages.
# See all versions at https://hub.docker.com/r/oven/bun/tags
FROM oven/bun:1 AS base
WORKDIR /usr/src/app

# ── Install stage — cache dependencies in temp directories ────────────
# Installing into /temp/ dirs ensures dependency layers are cached
# independently of source code changes, speeding up rebuilds.
FROM base AS install

# Install production dependencies only (no devDependencies).
# These go into the final image.
RUN mkdir -p /temp/prod
COPY apps/ts/package.json bun.lock /temp/prod/
RUN cd /temp/prod && bun install --frozen-lockfile --production

# ── Release stage — minimal production image ──────────────────────────
FROM base AS release

LABEL org.opencontainers.image.source="https://github.com/l4b4r4b4b4/fractal-agents-runtime"
LABEL org.opencontainers.image.description="Fractal Agents Runtime — TypeScript/Bun (free, self-hostable LangGraph-compatible agent runtime)"
LABEL org.opencontainers.image.licenses="MIT"

# Copy production node_modules from the install stage.
COPY --from=install /temp/prod/node_modules node_modules

# Copy application source and config.
COPY apps/ts/package.json .
COPY apps/ts/tsconfig.json .
COPY apps/ts/src/ ./src/

# Set environment variables.
ENV NODE_ENV=production \
    PORT=3000

# Switch to the built-in non-root `bun` user (provided by oven/bun image).
USER bun

# Expose server port.
EXPOSE 3000/tcp

# Health check — lightweight fetch against the /health endpoint.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD bun -e "fetch('http://localhost:3000/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

# Run the server. Bun executes TypeScript natively — no build step needed.
ENTRYPOINT [ "bun", "run", "src/index.ts" ]
