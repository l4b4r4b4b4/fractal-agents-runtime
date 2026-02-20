#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# create-mock-jwt.sh — Generate an HS256-signed JWT for benchmarks
#
# Produces a valid Supabase-shaped JWT signed with a known secret, suitable
# for benchmarking both runtimes with local JWT verification enabled
# (SUPABASE_JWT_SECRET). No external dependencies beyond base64 and openssl.
#
# Usage:
#   # Print just the token:
#   ./benchmarks/scripts/create-mock-jwt.sh
#
#   # Export as env var:
#   export AUTH_TOKEN=$(./benchmarks/scripts/create-mock-jwt.sh)
#
#   # Custom secret / expiry:
#   MOCK_JWT_SECRET="my-secret" MOCK_JWT_TTL=7200 ./benchmarks/scripts/create-mock-jwt.sh
#
#   # Use in k6:
#   k6 run -e AUTH_TOKEN=$(./benchmarks/scripts/create-mock-jwt.sh) benchmarks/k6/agent-flow.js
#
# Environment:
#   MOCK_JWT_SECRET   — HMAC-SHA256 signing secret (default: benchmark-jwt-secret-that-is-at-least-32-characters-long)
#   MOCK_JWT_TTL      — Token lifetime in seconds   (default: 3600 = 1 hour)
#   MOCK_JWT_USER_ID  — sub claim / user UUID        (default: 00000000-0000-0000-0000-000000000001)
#   MOCK_JWT_EMAIL    — email claim                   (default: benchmark@fractal-agents.test)
#   VERBOSE           — Set to 1 for debug output
#
# The same MOCK_JWT_SECRET must be passed to runtimes as SUPABASE_JWT_SECRET:
#
#   SUPABASE_JWT_SECRET="benchmark-jwt-secret-that-is-at-least-32-characters-long" \
#   SUPABASE_URL=http://localhost:54321 \
#   SUPABASE_KEY=<anon-key> \
#   bun run apps/ts/src/index.ts
#
# ---------------------------------------------------------------------------
set -euo pipefail

# ── Defaults ──────────────────────────────────────────────────────────────

MOCK_JWT_SECRET="${MOCK_JWT_SECRET:-benchmark-jwt-secret-that-is-at-least-32-characters-long}"
MOCK_JWT_TTL="${MOCK_JWT_TTL:-3600}"
MOCK_JWT_USER_ID="${MOCK_JWT_USER_ID:-00000000-0000-0000-0000-000000000001}"
MOCK_JWT_EMAIL="${MOCK_JWT_EMAIL:-benchmark@fractal-agents.test}"
VERBOSE="${VERBOSE:-0}"

# ── Helpers ───────────────────────────────────────────────────────────────

log() {
    if [ "$VERBOSE" = "1" ]; then
        echo "[mock-jwt] $*" >&2
    fi
}

# Base64url encode (RFC 7515): +→- /→_ strip trailing =
base64url_encode() {
    openssl base64 -e -A | tr '+/' '-_' | tr -d '='
}

# ── Timestamps ────────────────────────────────────────────────────────────

NOW=$(date +%s)
EXPIRY=$((NOW + MOCK_JWT_TTL))

log "Generating HS256 JWT"
log "  User ID:  $MOCK_JWT_USER_ID"
log "  Email:    $MOCK_JWT_EMAIL"
log "  Issued:   $(date -d "@$NOW" 2>/dev/null || date -r "$NOW" 2>/dev/null || echo "$NOW")"
log "  Expires:  $(date -d "@$EXPIRY" 2>/dev/null || date -r "$EXPIRY" 2>/dev/null || echo "$EXPIRY") (TTL ${MOCK_JWT_TTL}s)"
log "  Secret:   ${MOCK_JWT_SECRET:0:10}... (${#MOCK_JWT_SECRET} chars)"

# ── Header ────────────────────────────────────────────────────────────────

HEADER='{"alg":"HS256","typ":"JWT"}'
HEADER_B64=$(printf '%s' "$HEADER" | base64url_encode)

# ── Payload ───────────────────────────────────────────────────────────────
#
# Matches the Supabase JWT structure so both runtimes' local verifiers
# can extract sub, email, user_metadata, role, etc.

PAYLOAD=$(
    cat <<EOF
{
  "iss": "supabase-benchmark",
  "sub": "$MOCK_JWT_USER_ID",
  "aud": "authenticated",
  "exp": $EXPIRY,
  "iat": $NOW,
  "email": "$MOCK_JWT_EMAIL",
  "phone": "",
  "app_metadata": {
    "provider": "email",
    "providers": ["email"]
  },
  "user_metadata": {
    "email": "$MOCK_JWT_EMAIL",
    "email_verified": true,
    "phone_verified": false,
    "sub": "$MOCK_JWT_USER_ID",
    "benchmark": true
  },
  "role": "authenticated",
  "aal": "aal1",
  "amr": [{"method": "password", "timestamp": $NOW}],
  "session_id": "00000000-0000-0000-0000-benchmark0001",
  "is_anonymous": false
}
EOF
)

# Compact the JSON (remove newlines and excess whitespace)
PAYLOAD_COMPACT=$(printf '%s' "$PAYLOAD" | tr -d '\n' | sed 's/  */ /g')
PAYLOAD_B64=$(printf '%s' "$PAYLOAD_COMPACT" | base64url_encode)

# ── Signature ─────────────────────────────────────────────────────────────
#
# HMAC-SHA256 over "<header_b64>.<payload_b64>" with the shared secret.

SIGNATURE_INPUT="${HEADER_B64}.${PAYLOAD_B64}"
SIGNATURE_B64=$(printf '%s' "$SIGNATURE_INPUT" |
    openssl dgst -sha256 -hmac "$MOCK_JWT_SECRET" -binary |
    base64url_encode)

# ── Output ────────────────────────────────────────────────────────────────

TOKEN="${HEADER_B64}.${PAYLOAD_B64}.${SIGNATURE_B64}"

log "Token generated (${#TOKEN} chars)"

# Print just the token to stdout (for piping / $() capture)
echo "$TOKEN"
