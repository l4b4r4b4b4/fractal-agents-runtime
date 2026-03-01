# Task-03: Database Cron — Expired Assertion Cleanup

> **Status**: 🟢 Complete
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

## What Was Done

### Option A: pg_cron ✅ (Works on Local Supabase Dev)

pg_cron IS available on the local Supabase dev CLI. Applied as migration `add_key_assertion_cron_cleanup`:

```sql
CREATE EXTENSION IF NOT EXISTS pg_cron;

SELECT cron.schedule(
  'cleanup-expired-key-assertions',
  '*/5 * * * *',
  $$SELECT public.cleanup_expired_key_assertions()$$
);
```

### Verification

```
SELECT jobid, jobname, schedule, command FROM cron.job;
→ jobid=1, jobname='cleanup-expired-key-assertions', schedule='*/5 * * * *'
```

### Option B: Application-Level Cleanup (Fallback — Not Needed)

pg_cron works, so application-level fallback was not implemented. If needed for Supabase Cloud plans without pg_cron, add a background timer to the Python/TS runtime that calls `cleanup_expired_key_assertions()` every 5 minutes.

## Files Created

- [x] Supabase migration `add_key_assertion_cron_cleanup` applied via MCP

## Acceptance Criteria

- [x] Expired assertions are automatically deleted within 5-10 minutes of expiry
- [x] Cleanup function correctly reports deleted count
- [x] No impact on active (non-expired) assertions
- [x] Cleanup is idempotent and safe to run concurrently (`cron.schedule` with same name replaces existing)

## Notes

- pg_cron IS available on local Supabase dev CLI (confirmed 2026-02-23)
- `cron.schedule` with the same job name is idempotent (replaces existing schedule)
- The migration is reproducible — applying it again is a no-op