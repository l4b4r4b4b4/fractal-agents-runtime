# Goal 32: Resource-Profiled Benchmarks with Animated Visualization

> **Status**: ⚪ Not Started
> **Priority**: P2 (Medium)
> **Created**: 2026-02-16
> **Updated**: 2026-02-16
> **Depends On**: Goal 31 (Langfuse stack), Goal 26 (v0.0.3 benchmarks)

## Overview

Run TS and Python runtime benchmarks across realistic k8s resource allocation tiers
(CPU/memory limits), then generate animated comparison visualizations inspired by
[Anton Putra's benchmark videos](https://www.youtube.com/@intoantonputra). Use Docker
Compose `deploy.resources.limits` to simulate k8s pod constraints locally.

## Success Criteria

- [ ] Both runtimes benchmarked across 4 resource tiers (XS/S/M/L)
- [ ] k6 JSON results saved per runtime × tier combination (8 total runs minimum)
- [ ] Python visualization script generates animated comparison charts
- [ ] Charts cover: throughput (req/s), latency (p50/p95/p99), error rate, by tier
- [ ] Results reproducible via a single sweep script
- [ ] All benchmark artifacts committed to `benchmarks/results/` with metadata

## Resource Tiers

Realistic single-pod k8s allocations for an agent runtime:

| Tier | CPU (cores) | Memory | Docker Compose `cpus` | Notes |
|------|-------------|--------|-----------------------|-------|
| XS   | 0.25        | 256MB  | `0.25`                | Dev / edge / burstable |
| S    | 0.5         | 512MB  | `0.50`                | Small workload, starter |
| M    | 1.0         | 1GB    | `1.00`                | Standard production |
| L    | 2.0         | 2GB    | `2.00`                | High-throughput |

## Test Matrix

| Runtime | Tier | VU Profile | Duration | Output File |
|---------|------|------------|----------|-------------|
| ts      | XS   | ramp 1→5→10 | 90s    | `results/ts-xs.json` |
| ts      | S    | ramp 1→5→10 | 90s    | `results/ts-s.json` |
| ts      | M    | ramp 1→5→10 | 90s    | `results/ts-m.json` |
| ts      | L    | ramp 1→5→10 | 90s    | `results/ts-l.json` |
| python  | XS   | ramp 1→5→10 | 90s    | `results/python-xs.json` |
| python  | S    | ramp 1→5→10 | 90s    | `results/python-s.json` |
| python  | M    | ramp 1→5→10 | 90s    | `results/python-m.json` |
| python  | L    | ramp 1→5→10 | 90s    | `results/python-l.json` |

**Total runtime:** ~20 min (8 × ~90s + container restarts)

## Approach

### Docker Compose Resource Limits

```yaml
# Example: pass via environment or override file
services:
  python-runtime:
    deploy:
      resources:
        limits:
          cpus: "${BENCH_CPUS:-1.0}"
          memory: "${BENCH_MEMORY:-1G}"
```

### Sweep Script (`benchmarks/sweep.sh`)

```
for RUNTIME in ts python; do
  for TIER in xs s m l; do
    1. Set resource limits (via env vars or compose override)
    2. Restart only the target runtime container
    3. Wait for healthy
    4. Run k6 with --out json=results/{runtime}-{tier}.json
    5. Stop runtime
  done
done
```

### Visualization Script (`benchmarks/visualize.py`)

- Parse k6 JSON output files
- Extract metrics: http_req_duration (p50/p95/p99), http_reqs (throughput), http_req_failed (error rate)
- Generate animated bar charts comparing TS vs Python across tiers
- Output: MP4/GIF animation + static PNG summary

### Visualization Libraries (evaluate)

| Library | Pros | Cons |
|---------|------|------|
| `matplotlib.animation` | Standard, well-documented | Verbose, dated aesthetics |
| `plotly` | Interactive HTML, clean | Not easily animated to video |
| `bar_chart_race` | Racing bar charts out of the box | Limited customization |
| `manim` | Cinema-quality (3Blue1Brown) | Steep learning curve |

## Tasks

| Task ID | Description | Status |
|---------|-------------|--------|
| Task-01 | Add parameterized resource limits to compose | ⚪ |
| Task-02 | Write sweep script (loop tiers × runtimes, run k6, save JSON) | ⚪ |
| Task-03 | Run full sweep, collect results | ⚪ |
| Task-04 | Write Python visualization script | ⚪ |
| Task-05 | Generate animated comparison charts | ⚪ |

## Reference Material

- **Anton Putra's repo:** `.agent/antonputra-tutorials/` (cloned)
  - `lessons/276/` — Python (FastAPI) vs JavaScript (Bun) benchmark
  - `lessons/273/` — Deno vs Node.js vs Bun benchmark
  - `lessons/275/` — Go vs TypeScript benchmark
- **His approach:** Real k8s clusters, custom Rust load tester, Prometheus + Grafana,
  video-edited motion graphics (not programmatic). His k8s deployments use
  `resources.requests: {cpu: 750m, memory: 3Gi}` / `limits: {cpu: 1000m, memory: 3Gi}`
- **Key insight:** His animated charts are post-production video edits, not auto-generated.
  We aim to auto-generate comparable visuals with Python.
- **Our k6 script:** `benchmarks/k6/agent-flow.js` — full agent lifecycle benchmark
- **Our mock LLM:** `benchmarks/mock-llm/server.ts` — deterministic latency for Tier 1 tests

## Notes

- Use mock LLM for resource profiling (isolates runtime overhead from LLM variance)
- Run only ONE runtime at a time during benchmarks (fair comparison)
- Langfuse tracing should be active during benchmarks (measures real-world overhead)
- k6 `--out json` format includes per-request metrics needed for visualization
- Consider also exporting k6 results to CSV for easier pandas processing