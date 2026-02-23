#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# get-benchmark-token.sh — Obtain a fresh JWT for the benchmark user
#
# Creates the benchmark user on first run (idempotent), then logs in to
# get a fresh access_token.  Designed for local Supabase dev stacks.
#
# Usage:
#   # Print just the token (for piping):
#   ./benchmarks/scripts/get-benchmark-token.sh
#
#   # Export as env var:
#   export AUTH_TOKEN=$(./benchmarks/scripts/get-benchmark-token.sh)
#
#   # Pass to k6:
#   k6 run -e AUTH_TOKEN=$(./benchmarks/scripts/get-benchmark-token.sh) ...
#
# Environment (all have sensible defaults for the local dev stack):
#   SUPABASE_HOST          — Supabase Kong URL  (default: http://localhost:54321)
#   SUPABASE_ANON_KEY      — Anon/public key    (default: from .env)
#   BENCHMARK_EMAIL        — User email          (default: benchmark@fractal-agents.test)
#   BENCHMARK_PASSWORD     — User password       (default: benchmark-runner-2026!)
#   VERBOSE                — Set to 1 for debug output
# ---------------------------------------------------------------------------
set -euo pipefail

# ── Defaults ──────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

SUPABASE_HOST="${SUPABASE_HOST:-http://localhost:54321}"
BENCHMARK_EMAIL="${BENCHMARK_EMAIL:-benchmark@fractal-agents.test}"
BENCHMARK_PASSWORD="${BENCHMARK_PASSWORD:-benchmark-runner-2026!}"
VERBOSE="${VERBOSE:-0}"

# Try to read SUPABASE_ANON_KEY from env, then from .env file
if [ -z "${SUPABASE_ANON_KEY:-}" ]; then
    if [ -f "$PROJECT_ROOT/.env" ]; then
        SUPABASE_ANON_KEY=$(grep -E '^SUPABASE_KEY=' "$PROJECT_ROOT/.env" | cut -d'=' -f2-)
    fi
fi

if [ -z "${SUPABASE_ANON_KEY:-}" ]; then
    echo "ERROR: SUPABASE_ANON_KEY not set and not found in $PROJECT_ROOT/.env" >&2
    exit 1
fi

# ── Helpers ───────────────────────────────────────────────────────────────

log() {
    if [ "$VERBOSE" = "1" ]; then
        echo "[benchmark-auth] $*" >&2
    fi
}

die() {
    echo "ERROR: $*" >&2
    exit 1
}

# ── Health check ──────────────────────────────────────────────────────────

log "Checking Supabase at $SUPABASE_HOST ..."

if ! curl -sf "$SUPABASE_HOST/auth/v1/health" \
    -H "apikey: $SUPABASE_ANON_KEY" >/dev/null 2>&1; then
    die "Supabase Auth not reachable at $SUPABASE_HOST/auth/v1/health — is the stack running?"
fi

log "Supabase Auth is healthy"

# ── Sign up (idempotent — 200 on first call, 400 "already registered" after) ─

log "Ensuring benchmark user exists: $BENCHMARK_EMAIL"

SIGNUP_RESPONSE=$(curl -s -w "\n%{http_code}" \
    "$SUPABASE_HOST/auth/v1/signup" \
    -H "apikey: $SUPABASE_ANON_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"email\": \"$BENCHMARK_EMAIL\", \"password\": \"$BENCHMARK_PASSWORD\"}")

SIGNUP_HTTP_CODE=$(echo "$SIGNUP_RESPONSE" | tail -1)
SIGNUP_BODY=$(echo "$SIGNUP_RESPONSE" | sed '$d')

if [ "$SIGNUP_HTTP_CODE" = "200" ]; then
    log "Benchmark user created (first run)"
elif [ "$SIGNUP_HTTP_CODE" = "422" ] || [ "$SIGNUP_HTTP_CODE" = "400" ]; then
    log "Benchmark user already exists (expected)"
else
    log "Signup returned HTTP $SIGNUP_HTTP_CODE: $SIGNUP_BODY"
    # Continue anyway — login might still work
fi

# ── Login ─────────────────────────────────────────────────────────────────

log "Logging in as $BENCHMARK_EMAIL ..."

LOGIN_RESPONSE=$(curl -s -w "\n%{http_code}" \
    "$SUPABASE_HOST/auth/v1/token?grant_type=password" \
    -H "apikey: $SUPABASE_ANON_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"email\": \"$BENCHMARK_EMAIL\", \"password\": \"$BENCHMARK_PASSWORD\"}")

LOGIN_HTTP_CODE=$(echo "$LOGIN_RESPONSE" | tail -1)
LOGIN_BODY=$(echo "$LOGIN_RESPONSE" | sed '$d')

if [ "$LOGIN_HTTP_CODE" != "200" ]; then
    die "Login failed (HTTP $LOGIN_HTTP_CODE): $LOGIN_BODY"
fi

# ── Extract token ─────────────────────────────────────────────────────────

ACCESS_TOKEN=$(echo "$LOGIN_BODY" | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])" 2>/dev/null) ||
    die "Failed to parse access_token from login response"

if [ -z "$ACCESS_TOKEN" ]; then
    die "Empty access_token in login response"
fi

log "Got access token (${#ACCESS_TOKEN} chars, expires in ~1h)"

# Print just the token to stdout (for piping / $() capture)
echo "$ACCESS_TOKEN"
