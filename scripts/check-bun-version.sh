#!/usr/bin/env bash
# check-bun-version.sh — Verify local Bun matches .bun-version
#
# Used by:
#   - Lefthook pre-commit hook
#   - CI lint-ts job
#   - package.json check:bun-version script

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
VERSION_FILE="$REPO_ROOT/.bun-version"

if [ ! -f "$VERSION_FILE" ]; then
    echo "❌ .bun-version file not found at $VERSION_FILE"
    exit 1
fi

EXPECTED=$(tr -d '[:space:]' <"$VERSION_FILE")
ACTUAL=$(bun --version 2>/dev/null) || {
    echo "❌ bun not found in PATH"
    exit 1
}

if [ "$ACTUAL" != "$EXPECTED" ]; then
    echo "❌ Bun version mismatch: .bun-version expects $EXPECTED but running $ACTUAL"
    exit 1
fi

echo "✅ Bun $ACTUAL matches .bun-version"
