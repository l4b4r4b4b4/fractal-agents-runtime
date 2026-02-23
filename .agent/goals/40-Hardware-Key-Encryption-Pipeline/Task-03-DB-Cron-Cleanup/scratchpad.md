# Task-03: Database Cron — Expired Assertion Cleanup

> **Status**: ⚪ Not Started
> **Phase**: 1 — Foundation
> **Updated**: 2026-02-23
> **Depends On**: Task-02 (Schema) ✅

## Objective

Enable the `pg_cron` extension and schedule automatic cleanup of expired `key_assertions` records. Assertions have a 5-minute TTL by default and accumulate as users interact with hardware keys. Without periodic cleanup, the table grows unbounded and the partial indexes on `consumed = false` become less efficient.

## Problem

- `cleanup_expired_key_assertions()` function exists but is never called
- No `pg_cron` extension enabled on the local Supabase dev instance
- Expired assertions remain in the table indefinitely
- Partial indexes (`WHERE consumed = false`) still scan expired-but-unconsumed rows

## Implementation Plan

### Option A: pg_cron (Preferred for Production)

1. Create a new Supabase migration to:
   - Enable `pg_cron` extension: `CREATE EXTENSION IF NOT EXISTS pg_cron`
   - Schedule cleanup every 5 minutes:
     ```sql
     SELECT cron.schedule(
       'cleanup-expired-key-assertions',
       '*/5 * * * *',
       $$SELECT public.cleanup_expired_key_assertions()$$
     );
     ```
2. Verify with `SELECT * FROM cron.job;`

### Option B: Application-Level Cleanup (Fallback)

If `pg_cron` is not available (e.g., some Supabase plans), add cleanup to the Python/TS runtime:
- Call `cleanup_expired_key_assertions()` on a background timer (every 5 min)
- Less reliable (depends on runtime being up) but works everywhere

### Decision

- **Local dev / self-hosted**: Option A (pg_cron)
- **Supabase Cloud**: Check plan support for pg_cron; fall back to Option B if unavailable
- **Both options are non-blocking** — the system works without cleanup, it's just a hygiene concern

## Files to Create/Modify

- [ ] New Supabase migration SQL file (if pg_cron approach)
- [ ] OR: Background cleanup task in Python runtime (`apps/python/src/server/crons/`)
- [ ] OR: Background cleanup task in TS runtime (`apps/ts/src/`)

## Acceptance Criteria

- [ ] Expired assertions are automatically deleted within 5-10 minutes of expiry
- [ ] Cleanup function correctly reports deleted count
- [ ] No impact on active (non-expired) assertions
- [ ] Cleanup is idempotent and safe to run concurrently

## Notes

- `pg_cron` may not be available on local Supabase dev CLI — need to verify
- If pg_cron isn't available locally, Option B (application-level) may be the pragmatic choice for dev
- Production Supabase (Pro plan+) supports pg_cron
- The cleanup function already exists and is tested at the SQL level — this task is purely about scheduling