# Changelog (Python Runtime)

All notable changes to the Python runtime are documented in this file.

## 0.1.1 (2026-03-10)

### Fixed
- Remove the MCP OAuth token exchange flow and pass the Supabase JWT directly as the MCP access token.
- Fix lefthook pre-push hook regenerating `uv.lock` after commit. Lockfile sync now runs in the pre-commit hook; pre-push uses `--frozen` to enforce read-only checks.

## 0.1.0

### Added
- Feature parity milestone with the TS/Bun runtime at the time of release.

### Notes
- Python is generally more mature because some bug fixes are not yet implemented in Bun.