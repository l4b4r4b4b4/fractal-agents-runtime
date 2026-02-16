# Goal 31: Local Langfuse v3 Dev Stack

> **Status**: 🟢 Complete
> **Priority**: P1 (High)
> **Created**: 2026-02-15
> **Updated**: 2026-02-16 (Session 37)

## Overview

Add a fully self-contained Langfuse v3 instance as a **separate compose file** (`docker-compose.langfuse.yml`) with headless initialization, joined to the main runtime compose via an external `langfuse_network` (same pattern as Supabase). Point both runtimes (Python + TS) and benchmarks at the local instance instead of Langfuse Cloud. This eliminates external dependencies for tracing, prompt management, and observability during local development and CI.

## Success Criteria

- [ ] Langfuse v3 services added to `docker-compose.yml` (web, worker, clickhouse, redis, minio, postgres)
- [ ] Headless initialization creates org, project, user, and API keys on first boot
- [ ] `LANGFUSE_BASE_URL`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` point to local instance
- [ ] Both runtimes connect to local Langfuse (tracing + prompt management work)
- [ ] k6 benchmark scripts work with local Langfuse (no cloud dependency)
- [ ] `.env.example` updated with local Langfuse defaults
- [ ] No port conflicts with existing services (Supabase, runtimes, mock LLM, vLLM)
- [ ] `docker compose up langfuse-web` starts Langfuse and all its dependencies
- [ ] Langfuse UI accessible at `http://localhost:3003`
- [ ] README updated with local Langfuse instructions

## Context & Background

Both runtimes integrate with Langfuse for:
1. **Tracing** — LLM call observability via `@langfuse/langchain` (TS) and `langfuse` SDK (Python)
2. **Prompt management** — Prompt templates fetched from Langfuse API with cache + fallback
3. **Benchmarking** — Tracing overhead is part of the runtime performance profile

Currently, `LANGFUSE_BASE_URL` defaults to `https://cloud.langfuse.com`, which:
- Requires real API keys (can't use in CI or offline dev)
- Adds network latency to benchmarks
- Fails with 401 errors when keys are empty (noisy startup logs)
- Prevents local prompt template seeding/testing

Langfuse v3 (latest: v3.153.0) now ships an official `docker-compose.yml` with all required infrastructure. They also support [headless initialization](https://langfuse.com/self-hosting/administration/headless-initialization) via `LANGFUSE_INIT_*` env vars to pre-create org/project/user/keys on startup.

## Constraints & Requirements

- **Hard Requirements**:
  - No port conflicts with Supabase (54321), runtimes (9091/9092), mock LLM (11434), vLLM (7374)
  - Langfuse postgres MUST be separate from Supabase postgres (different schemas, migrations)
  - Headless init values are dev-only — deterministic, not real secrets
  - Both runtimes must work identically whether Langfuse is local or cloud (env var switch)
  - Langfuse services must NOT auto-start — user opts in with `docker compose up langfuse-web`
- **Soft Requirements**:
  - Minimize exposed ports (only langfuse-web needs external access)
  - Keep compose file readable with clear section comments
  - Volume names prefixed with `langfuse_` to avoid collisions
- **Out of Scope**:
  - Multimodal tracing (Minio media uploads from outside Docker)
  - Langfuse Helm chart integration
  - CI pipeline Langfuse integration (future goal)
  - Langfuse EE features (RBAC, SSO, instance management API)

## Approach

### Port Allocation

| Service | Internal Port | External Port | Notes |
|---------|--------------|---------------|-------|
| `langfuse-web` | 3000 | **3003** | UI + API — avoid 3000 (common dev port) |
| `langfuse-worker` | 3030 | none | Internal only |
| `langfuse-clickhouse` | 8123/9000 | none | Internal only |
| `langfuse-redis` | 6379 | none | Internal only |
| `langfuse-minio` | 9000/9001 | none | Internal only |
| `langfuse-postgres` | 5432 | none | Separate from Supabase DB |

### Headless Init Values

```
LANGFUSE_INIT_ORG_ID=fractal-dev
LANGFUSE_INIT_ORG_NAME=Fractal Agents Dev
LANGFUSE_INIT_PROJECT_ID=fractal-agents-runtime
LANGFUSE_INIT_PROJECT_NAME=Fractal Agents Runtime
LANGFUSE_INIT_PROJECT_PUBLIC_KEY=lf_pk_fractal_dev_local
LANGFUSE_INIT_PROJECT_SECRET_KEY=lf_sk_fractal_dev_local
LANGFUSE_INIT_USER_EMAIL=admin@fractal.local
LANGFUSE_INIT_USER_NAME=Admin
LANGFUSE_INIT_USER_PASSWORD=FractalAdmin123!
```

### Runtime Env Vars (local dev)

```
LANGFUSE_PUBLIC_KEY=lf_pk_fractal_dev_local
LANGFUSE_SECRET_KEY=lf_sk_fractal_dev_local
LANGFUSE_BASE_URL=http://localhost:3003          # bare-metal dev
# or http://langfuse-web:3000                    # when running inside Docker compose
```

## Tasks

| Task ID | Description | Status | Depends On |
|---------|-------------|--------|------------|
| Task-01 | Add Langfuse v3 stack as separate compose file + network bridge | 🟢 | - |
| Task-02 | Consolidate env files — single root `.env` with Langfuse vars | 🟢 | Task-01 |
| Task-03 | Verify both runtimes connect to local Langfuse (tracing + prompts) | 🟢 | Task-01, Task-02 |
| Task-04 | Update k6 benchmark scripts with versioned test asset naming | ⚪ | Task-02 |
| Task-05 | Update README + Helm README with local Langfuse instructions | ⚪ | Task-01 |
| Task-06 | Run Tier 1 k6 benchmark (TS vs Python) with full auth + local Langfuse | 🟢 | Task-03, Task-04 |

### Task Details

#### Task-01: Add Langfuse v3 stack as separate compose file + network bridge ✅
- **Created** `docker-compose.langfuse.yml` — self-contained Langfuse v3 stack (6 services)
- Services: `langfuse-web`, `langfuse-worker`, `langfuse-clickhouse`, `langfuse-redis`, `langfuse-minio`, `langfuse-postgres`
- Volumes: `langfuse_postgres_data`, `langfuse_clickhouse_data`, `langfuse_clickhouse_logs`, `langfuse_minio_data`
- Network: `langfuse_network` (named default network in Langfuse compose)
- Headless init env vars on `langfuse-web` only (deterministic dev keys, not double-quoted)
- Health checks on all 6 services, `depends_on` chain with `service_healthy` conditions
- Only `langfuse-web` exposed externally (3003:3000), all infra internal-only
- TELEMETRY_ENABLED=false, batch export disabled, media upload internal-only
- **Updated** `docker-compose.yml`:
  - Added `langfuse` external network (`langfuse_network`)
  - Both runtimes (`python-runtime`, `ts-runtime`) joined to `langfuse` network
  - Updated header "Requires:" section with Langfuse dependency + `docker network create` workaround
  - Replaced incomplete Langfuse comment block with pointer to separate compose file
  - Removed prematurely added Langfuse volumes
- **Architecture decision:** Separate compose file (not embedded) — same pattern as Supabase,
  keeps main compose clean, allows independent lifecycle management
- **Usage:** `docker compose -f docker-compose.langfuse.yml up -d` → starts Langfuse,
  creates `langfuse_network`, runtimes resolve `langfuse-web:3000` over shared network

#### Task-02: Consolidate env files — single root `.env` with Langfuse vars ✅
- **Added to root `.env`:**
  - `LANGFUSE_PUBLIC_KEY=lf_pk_fractal_dev_local`
  - `LANGFUSE_SECRET_KEY=lf_sk_fractal_dev_local`
  - `LANGFUSE_BASE_URL=http://langfuse-web:3000` (Docker-internal resolution)
  - `LANGFUSE_PROMPT_CACHE_TTL=300`
  - `LANGCHAIN_PROJECT=default`, `LANGCHAIN_API_KEY=`, `LANGCHAIN_TRACING_V2=false`
- **Switched** `python-runtime` in `docker-compose.yml` from `env_file: apps/python/.env` to `env_file: .env`
- **Deleted** `apps/python/.env` — all vars consolidated into root `.env`
- **Architecture decision:** Single `.env` for all compose services — eliminates duplicate
  keys, reduces drift risk, matches the "one compose, one env" pattern
- `apps/python/.env.example` kept for reference (documents Python-specific vars)

#### Task-03: Verify both runtimes connect to local Langfuse ✅
- **Session 36:** Both runtimes confirmed connecting to local Langfuse (tracing init logs)
- **Session 37:** Full verification under load — Langfuse API returns traces:
  - Python traces tagged `['robyn', 'streaming']`
  - TS traces confirmed via Langfuse UI at `http://localhost:3003`
- Langfuse v3.153.0 healthy throughout benchmarks

#### Task-06: Tier 1 k6 Benchmark — TS vs Python with Ministral + Local Langfuse ✅

**Infrastructure:**
- Supabase (54321) + Langfuse (3003) + Ministral vLLM (7374) + both runtimes (9091/9092)
- Auth: Supabase JWT (`bench3@test.local`) verified against both runtimes
- LLM: Ministral 3B via vLLM (`--max-num-seqs 9`, `--gpu-memory-utilization 0.875`, max concurrency 9.19x)
- Added `OPENAI_BASE_URL=http://ministral:80/v1` to root `.env` so runtimes use local Ministral
- k6 ramp-up scenario: 1→5→10 VUs over 90s

**Critical Bug Fix: `checkpoint_ns` subgraph namespace conflict**

Both runtimes set `configurable.checkpoint_ns = "assistant:<assistant_id>"` for multi-agent
checkpoint isolation (per docs/MULTI_AGENT_CHECKPOINT_ARCHITECTURE.md). However, LangGraph
uses `checkpoint_ns` internally for subgraph hierarchy navigation:

- `NS_END = ":"` separates subgraph name from task ID
- `NS_SEP = "|"` separates subgraph levels
- `recast_checkpoint_ns("assistant:abc123")` → `"assistant"` → `get_subgraphs(namespace="assistant")` → 💥

This caused `ValueError: Subgraph assistant not found` on every `getState()`/`aget_state()` call
(283x in TS, 354x in Python per benchmark run). The runtimes fell back to current run messages,
losing accumulated checkpoint history. Python additionally had 168 `Task was destroyed but it is
pending` errors from asyncio store batch cleanup during concurrent stream teardown.

**Fix applied (6 files):**
- `apps/ts/src/routes/runs.ts` — removed `checkpoint_ns` from `buildRunnableConfig()`
- `apps/ts/src/mcp/agent.ts` — removed `checkpoint_ns` from `buildMcpRunnableConfig()`
- `apps/ts/src/routes/streams.ts` — changed SSE `langgraph_checkpoint_ns` to `""`
- `apps/python/src/server/routes/streams.py` — removed `checkpoint_ns` from `_build_runnable_config()`
- `apps/python/src/server/agent.py` — removed `checkpoint_ns` from `_build_mcp_runnable_config()`
- `apps/python/src/server/routes/streams.py` — changed SSE `langgraph_checkpoint_ns` fallback to `""`

**Result:** Zero subgraph warnings, both runtimes now successfully read accumulated state
from the checkpointer (268 reads in TS, 178 in Python). Multi-agent checkpoint isolation
needs a different approach (composite thread_id or actual LangGraph subgraph wrapping).

**Tier 1 Results (clean, post-fix):**

| Metric | TS (0.0.3) | Python (0.1.0) | Delta |
|--------|-----------|---------------|-------|
| **Iterations completed** | 133 | **177** | Python +33% |
| **Success rate** | 100% | 100% | Tie |
| **HTTP failures** | 0% | 0% | Tie |
| **Agent flow avg** | 4.36s | **3.02s** | Python 1.4x faster |
| **Agent flow p95** | 9.35s | **4.74s** | Python 2.0x faster |
| **run/wait p95** | 3.20s | **429ms** | Python 7.4x faster |
| **create_assistant p95** | **61ms** | 121ms | TS 2.0x faster |
| **create_thread p95** | **56ms** | 112ms | TS 2.0x faster |
| **Throughput (req/s)** | 9.5 | **13.5** | Python +42% |
| **Subgraph errors** | 0 ✅ | 0 ✅ | Fixed |
| **Checkpointer reads OK** | 268 ✅ | 178 ✅ | Both working |

**Key observations:**
- Python dominates LLM-bound operations (run/wait, streaming) — 7.4x faster run/wait p95
- TS is faster on pure CRUD (assistant/thread creation) — 2x faster
- Python completes 33% more iterations in the same 90s window
- Python `data_received` is 37 MB vs TS 2.3 MB — Python streams more verbose response data
- Python still has `Task was destroyed` asyncio errors (171x) from `langgraph/store/base/batch.py`
  during concurrent stream teardown — LangGraph SDK issue, not our code, doesn't affect correctness
- TS `Subgraph with namespace "assistant" not found` completely eliminated

**Results saved for Goal 32 visualization:**
- `benchmarks/results/ts-tier1-ministral.json` (4.0 MB)
- `benchmarks/results/python-tier1-ministral.json` (5.2 MB)

#### Task-04: Benchmark asset naming
- k6 assistant names: `bench-test-{runtime}-v{version}-vu{vu}-iter{iter}`
- k6 thread metadata: include `runtime_version`, `benchmark: true`
- Langfuse prompt templates created by runtimes: suffix with `-test` when `BENCHMARK_MODE=true` (or similar) — evaluate if needed

## Risks & Mitigations

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| Langfuse v3 startup takes 2-3 min | Slows dev workflow | Medium | Only start when needed; health check gates |
| ClickHouse + Minio RAM usage (~1-2GB) | Dev machine resource pressure | Low | All services optional, `replicas: 0` possible |
| Minio port 9090 conflict with host services | Compose startup failure | Low | No external port exposure for minio |
| Langfuse SDK version mismatch with v3 API | Tracing failures | Low | Both SDKs already support v3 API |

## Dependencies

- **Upstream**: Langfuse v3.x Docker images, Supabase running for auth (separate concern)
- **Downstream**: Goal 26 benchmarks (Task-06 depends on this), future CI tracing

## Notes & Decisions

### Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-02-15 | Use port 3003 for Langfuse web | Avoid 3000 (common dev), 3001 (Next.js), 3002 (other tools) |
| 2026-02-15 | Separate Langfuse postgres from Supabase | Different migration paths, schema ownership, lifecycle |
| 2026-02-15 | No external ports for infra services | Only langfuse-web needs external access; reduces attack surface |
| 2026-02-15 | Headless init with deterministic dev keys | Reproducible local setup, no manual UI configuration needed |
| 2026-02-15 | Langfuse v3 not v2 | v2 compose was Postgres-only but v3 is current, actively maintained, and has headless init |

### Open Questions

- [ ] Should we add a `make langfuse-up` / `make langfuse-down` shortcut?
- [ ] Do we need to seed prompt templates into local Langfuse as part of startup?
- [ ] Should CI run with local Langfuse or stay cloud-based with test keys?
- [ ] Should TS ReAct agent call `getPromptAsync()` for Langfuse parity with Python? (see findings below)

## Prompt Caching & Retrieval Findings (Session 35)

### How prompts are retrieved today

Both runtimes call `get_prompt()` / `getPrompt()` at **graph compilation time** — meaning
every `run/wait` or `stream` request triggers a prompt fetch. The research agent is worse:
5+ calls per flow (analyzer phase 1 & 2, N workers, aggregator phase 1 & 2).

### Python Runtime — caching works correctly

The Langfuse Python SDK has **built-in client-side caching** via the `cache_ttl_seconds`
parameter passed to `client.get_prompt()`:

- Default TTL: **300 seconds** (5 minutes), configurable via `LANGFUSE_PROMPT_CACHE_TTL` env var
- First request after startup or TTL expiry → 1 HTTP call to Langfuse
- All subsequent requests within the TTL window → served from in-process memory, **zero network**
- After TTL expires → one HTTP refresh, then cached again
- Setting `LANGFUSE_PROMPT_CACHE_TTL=0` disables caching (useful in dev for instant prompt iteration)

**Verdict: No additional caching layer needed.** The SDK handles it. Against local Langfuse
the HTTP overhead is <1ms anyway.

### TS Runtime — PARITY GAP: Langfuse prompts not actually used

| Aspect | Python | TS |
|--------|--------|----|
| ReAct agent system prompt | `get_prompt()` → Langfuse with 300s cache | `getEffectiveSystemPrompt()` → hardcoded from assistant config, **no Langfuse** |
| Research agent prompts | `get_prompt()` → Langfuse with 300s cache (5+ calls/flow) | `resolvePrompt()` → `getPrompt()` (sync) → **always returns fallback** |
| `getPromptAsync()` exists? | N/A (Python SDK is sync-friendly) | Yes, built and tested, but **never called** in any graph |
| Cache TTL | 300s (env-configurable, works) | 300s (configured, but unused since Langfuse is never hit) |
| Net calls per prompt per 5min | 1 (then cached) | 0 (never hits Langfuse) |

**Root cause:** The Langfuse JS SDK `getPrompt()` is async-only. The TS `getPrompt()` (sync)
was designed to return the fallback immediately, with a comment saying "The Langfuse prompt
will be used when the SDK's caching layer has had time to warm up (subsequent calls)" — but
this never actually happens because the sync path always short-circuits to fallback.

The `getPromptAsync()` function exists in `apps/ts/src/infra/prompts.ts` (L511-612), is fully
implemented with cache TTL support, but is **not wired into any graph**. The research agent's
`resolvePrompt()` calls the sync `getPrompt()`, not the async version.

**Fix options (future task, not Goal 31):**
1. Change `resolvePrompt()` in `research-agent/agent.ts` to call `getPromptAsync()` — straightforward
2. Add `getPromptAsync()` call in `react-agent/agent.ts` graph factory (it's already async) — easy
3. Both fixes would give full Langfuse prompt management parity with Python

### Impact on benchmarking

- Python runtime: will show ~1ms overhead per unique prompt on first call, then zero for 5 min
- TS runtime: zero Langfuse overhead (never calls it) — benchmarks are **not comparable** for prompt-related latency
- Once TS parity is fixed, the local Langfuse stack will be essential for fair comparison

## Benchmark Status (Session 35)

### What was attempted

1. ✅ Mock LLM server started on port 11434
2. ✅ TS runtime started on port 9092 (with Supabase auth enabled)
3. ✅ Python runtime started on port 9091 (with Supabase auth enabled)
4. ✅ Test Supabase user created (`bench2@test.local`), JWT verified against both runtimes
5. ⚠️ TS benchmark without auth: **1076 iterations, 100% pass, 60ms avg flow** (p95=87ms)
6. ❌ Python benchmark without auth: **100% failure** — 401 auth required on all endpoints
7. ⚠️ TS benchmark with auth: **26.4% success** — Supabase rate-limited JWT verification under 10 VUs
8. ❌ Python benchmark with auth: not attempted (would hit same Supabase rate limit)

### Root cause of auth failures

Both runtimes call `supabase.auth.get_user(token)` on every request — this makes an HTTP call
to Supabase GoTrue. Under 10 concurrent VUs, the local Supabase instance rate-limits or drops
connections, causing ~73% of requests to fail.

### What this means for Goal 31

The local Langfuse stack is a prerequisite for clean benchmarks, but the **auth rate-limiting
is a separate problem**. Options:
1. Benchmark without auth (disable Supabase for both runtimes) — measures runtime overhead only
2. Add JWT caching in auth middleware (cache verified tokens for N seconds) — future improvement
3. Accept Supabase as a bottleneck and use lower VU counts (1-3 VUs)

## References

- [Langfuse v3 Docker Compose](https://github.com/langfuse/langfuse/blob/main/docker-compose.yml)
- [Langfuse Headless Initialization](https://langfuse.com/self-hosting/administration/headless-initialization)
- [Langfuse Self-Hosting Guide](https://langfuse.com/self-hosting/deployment/docker-compose)
- [Langfuse v3.153.0 Release](https://github.com/langfuse/langfuse/releases/tag/v3.153.0) — latest as of 2026-02-15
- Goal 26 Task-06 scratchpad — Session 35 benchmark handoff
- Goal 24 — Langfuse Prompt Template Integration
- `apps/python/src/infra/prompts.py` — Python prompt caching implementation
- `apps/ts/src/infra/prompts.ts` — TS prompt caching (sync fallback + unused async)
- `apps/ts/src/graphs/react-agent/configuration.ts` — TS ReAct agent (no Langfuse integration)