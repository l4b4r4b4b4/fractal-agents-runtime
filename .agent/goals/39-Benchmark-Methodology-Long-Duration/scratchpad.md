# Goal 39: Benchmark Methodology — Long-Duration Runs & Statistical Rigor

> **Status**: ⚪ Not Started
> **Priority**: P3 (Low — improves confidence, not blocking releases)
> **Created**: 2026-02-20
> **Updated**: 2026-02-20
> **Depends On**: Goal 38 (Store namespace fix — 0% error rate prerequisite), Goal 32 (Resource-profiled benchmarks — shares k6 infrastructure)

## Problem Statement

Our current v0.1.0 benchmarks run for **90 seconds** with a simple 5-stage ramp (0→1→3→5→3→1 VUs). This is adequate as a smoke test and correctness gate, but insufficient for meaningful performance characterization:

| Issue | Current State | Impact |
|-------|--------------|--------|
| **Sample size** | TS: 1042 iters, Python: 401 iters | p99 based on ~10/4 worst requests — statistically noisy |
| **Warmup** | 10s at 1 VU | JIT, connection pools, OS buffers not at steady state |
| **No steady-state window** | Load constantly changing | Cannot isolate true throughput from ramp artifacts |
| **No recovery testing** | Single ramp-down | No evidence system recovers cleanly after load spikes |
| **No saturation discovery** | Max 5 VUs | Don't know at what concurrency latency degrades non-linearly |
| **Run-to-run variance** | Single run per config | No confidence intervals, no error bars |
| **GC / memory pressure** | 90s total | May finish before first major GC cycle |

### Reference: Anton Putra's Methodology

[Anton Putra](https://www.youtube.com/@intoantonputra) runs 5–20 minute benchmarks with gradual ramp-up because:

1. **Warmup matters** — JIT compilers (V8/Bun, Python), connection pools, OS TCP buffers, kernel socket queues all need time to reach steady state. Blasting VUs immediately measures cold-start artifacts, not the runtime.
2. **Ramp-up reveals saturation curves** — Stepping through 1→2→5→10→20→10→5→1 VUs shows at what concurrency latency degrades, and whether the system recovers when load drops.
3. **Large sample sizes for tail latencies** — With 10k–50k iterations, p95/p99 are statistically meaningful. Our 401-iteration Python run has p99 based on the 4th-worst request.
4. **GC and memory pressure** — Short benchmarks often finish before the first major GC cycle. 10-minute runs force multiple GC passes, which is where real-world p99 spikes come from.
5. **Reproducibility** — Longer ramps smooth out OS scheduling noise, CPU frequency scaling, and thermal throttling. A 90-second benchmark can vary ±30% between runs; a 10-minute one is much more stable.

## Objectives

- [ ] Design a k6 scenario profile for long-duration performance characterization (10–15 min)
- [ ] Design a k6 scenario profile for saturation/breaking-point discovery (progressive VU increase)
- [ ] Run each scenario 3× per runtime, report mean ± stddev for key metrics
- [ ] Produce per-operation latency distributions (not just p50/p95/p99 — full histograms)
- [ ] Document the methodology in `benchmarks/README.md` so results are reproducible
- [ ] Keep the existing 90-second "smoke" scenario as-is for CI / quick regression checks

## Success Criteria

- At least 5,000 iterations per runtime in the long-duration profile
- Run-to-run coefficient of variation < 10% for p95 latency
- Saturation point identified (VU count where p95 > 2× baseline)
- Results include steady-state window analysis (exclude warmup/cooldown from reported metrics)
- Both runtimes benchmarked under identical conditions

## Proposed k6 Scenario Profiles

### Profile 1: `steady-state` (Performance Characterization)

```
Duration: ~12 minutes total
Stages:
  - 2 min warmup:     0 → target VUs (gradual)
  - 8 min steady:     hold at target VUs
  - 2 min cooldown:   target → 0 VUs (gradual)

Analysis window: minutes 3–10 only (discard warmup + cooldown)
Target VUs: 5 (matches current baseline for comparison)
Expected iterations: 5,000–10,000 (TS), 2,000–4,000 (Python)
Runs per config: 3 (report mean ± stddev)
```

### Profile 2: `saturation` (Breaking-Point Discovery)

```
Duration: ~15 minutes total
Stages:
  - 1 min:  1 VU   (baseline)
  - 2 min:  5 VUs
  - 2 min:  10 VUs
  - 2 min:  20 VUs
  - 2 min:  30 VUs
  - 2 min:  50 VUs   (if runtime survives)
  - 2 min:  10 VUs   (recovery test)
  - 2 min:  1 VU    (cooldown / recovery verification)

Key metrics per stage:
  - Throughput (iterations/sec)
  - p50, p95, p99 latency
  - Error rate
  - Whether p95 > 2× the baseline (1 VU) p95
```

### Profile 3: `smoke` (Existing — Keep As-Is)

```
Duration: ~90 seconds
Purpose: CI gate, correctness check, quick regression detection
File: benchmarks/k6/agent-flow.js (current)
No changes needed.
```

## Task Breakdown (Preliminary)

### Task-01: k6 Scenario Refactor
- Extract shared helper functions from `agent-flow.js` into `benchmarks/k6/lib/`
- Create `benchmarks/k6/steady-state.js` — imports helpers, defines 12-min profile
- Create `benchmarks/k6/saturation.js` — imports helpers, defines 15-min profile
- Keep `agent-flow.js` as the smoke test (no breaking changes)

### Task-02: Analysis Scripts
- Python or Bun script to parse k6 JSON output
- Compute per-stage metrics (not just overall)
- Steady-state window extraction (discard warmup/cooldown data points by timestamp)
- Multi-run aggregation (mean ± stddev across 3 runs)
- Histogram generation for latency distributions

### Task-03: Automation & Documentation
- Shell script: `benchmarks/scripts/run-benchmark-suite.sh` — runs all 3 profiles for both runtimes
- `benchmarks/README.md` — methodology, hardware requirements, how to reproduce, how to interpret results
- Result naming convention: `{runtime}-{profile}-{vus}-{run}.json`

### Task-04: Execution & Baseline Results
- Run steady-state 3× per runtime
- Run saturation 1× per runtime (exploratory)
- Commit baseline results and analysis
- Update main README with characterization data

## Relationship to Goal 32

Goal 32 (Resource-Profiled Benchmarks) varies **hardware constraints** (CPU/memory tiers) while holding methodology constant. This goal improves the **methodology itself** while holding hardware constant. They compose naturally:

- Goal 39 first → establish proper methodology
- Goal 32 second → apply that methodology across resource tiers

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Long runs eat dev time | Automate with scripts, run overnight or in background |
| Mock LLM becomes bottleneck at high VUs | Monitor mock LLM CPU; scale if needed (it's a simple Bun HTTP server) |
| Python runtime may not survive 50 VUs | That's a valid finding — document the saturation point |
| Results depend on host machine load | Run on idle machine, document system load during benchmark |
| k6 itself may be a bottleneck | k6 is Go-based and handles 1000s of VUs — unlikely at our scale |

## Hardware Reference (Current Benchmark Machine)

- **CPU**: AMD Threadripper 3970X (64 threads)
- **RAM**: 64 GB
- **GPU**: RTX 3080 Ti (not used by benchmarks)
- **OS**: NixOS 26.05, kernel 6.18.12
- **Runtimes**: Bun 1.3.9, Python 3.12.12
- **Load generator**: k6 1.6.0

## Notes

- The existing 90-second smoke test is valuable and should remain the default for quick iterations
- This goal is about adding complementary long-duration profiles, not replacing the smoke test
- Priority is P3 because current benchmarks are sufficient for v0.1.0 release — this is about doing it properly for v0.2.0+ characterization