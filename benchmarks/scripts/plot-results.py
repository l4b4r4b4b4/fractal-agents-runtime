#!/usr/bin/env python3
"""Benchmark visualization — grid of time-series and distribution plots from k6 JSON output.

Usage:
    # Compare two runtimes (typical):
    uv run --with matplotlib --with numpy benchmarks/scripts/plot-results.py \
        --ts benchmarks/results/ts-v0.1.0-mock-5vu.json \
        --python benchmarks/results/python-v0.1.0-mock-5vu.json \
        --output benchmarks/results/v0.1.0-comparison.png

    # Single runtime:
    uv run --with matplotlib --with numpy benchmarks/scripts/plot-results.py \
        --ts benchmarks/results/ts-v0.1.0-mock-5vu.json \
        --output benchmarks/results/ts-v0.1.0.png

    # Custom title:
    uv run --with matplotlib --with numpy benchmarks/scripts/plot-results.py \
        --ts results/ts.json --python results/py.json \
        --title "v0.1.0 Benchmark — Mock LLM, 5 VUs, HS256 JWT" \
        --output comparison.png

The k6 ``--out json`` format is line-delimited JSON with one metric point per
line.  This script extracts ``http_req_duration`` (per operation),
``agent_flow_duration``, ``agent_flow_success_rate``, and ``http_reqs`` to
produce a 3×3 grid:

    Row 1: Latency over time (per-operation), Throughput over time, Full flow latency over time
    Row 2: Latency box plots (per-operation), CDF of full flow, p50/p95/p99 bar chart
    Row 3: Error rate over time, Store ops latency, Summary stats text

Requires: matplotlib, numpy (provided via ``uv run --with``).
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import matplotlib

matplotlib.use("Agg")  # Non-interactive backend — no display needed

import matplotlib.pyplot as plt
import matplotlib.ticker as ticker
import numpy as np

# ---------------------------------------------------------------------------
# Colours and style
# ---------------------------------------------------------------------------

COLOUR_TS = "#e8590c"  # Orange-red (Bun branding)
COLOUR_PYTHON = "#16a34a"  # Green (Python branding)
COLOUR_TS_LIGHT = "#fed7aa"
COLOUR_PYTHON_LIGHT = "#bbf7d0"

RUNTIME_STYLES = {
    "ts": {
        "color": COLOUR_TS,
        "color_light": COLOUR_TS_LIGHT,
        "label": "TypeScript (Bun)",
    },
    "python": {
        "color": COLOUR_PYTHON,
        "color_light": COLOUR_PYTHON_LIGHT,
        "label": "Python (Robyn)",
    },
}

# Operations to include in per-operation plots (order matters for display)
MAIN_OPERATIONS = [
    "create_assistant",
    "create_thread",
    "run_wait",
    "run_stream",
    "stateless_run_wait",
    "store_put",
    "store_get",
    "store_list",
]

OPERATION_LABELS = {
    "create_assistant": "Create\nAssistant",
    "create_thread": "Create\nThread",
    "run_wait": "Run\nWait",
    "run_stream": "Run\nStream",
    "stateless_run_wait": "Stateless\nRun",
    "store_put": "Store\nPut",
    "store_get": "Store\nGet",
    "store_list": "Store\nSearch",
}

# Time bucket size for time-series plots (seconds)
BUCKET_SECONDS = 5


# ---------------------------------------------------------------------------
# Data loading
# ---------------------------------------------------------------------------


def parse_timestamp(timestamp_string: str) -> float:
    """Parse an ISO-8601 timestamp with timezone to a POSIX epoch float."""
    # k6 timestamps: "2026-02-20T12:52:13.290838588+01:00"
    # Python's fromisoformat handles this in 3.11+, but nanosecond
    # precision may need trimming for older stdlib.
    # Truncate fractional seconds to 6 digits (microseconds) for compat.
    if "." in timestamp_string:
        base, rest = timestamp_string.split(".", 1)
        # rest is like "290838588+01:00" — split on +/- for tz
        frac = ""
        tz_part = ""
        for index, character in enumerate(rest):
            if character in ("+", "-") and index > 0:
                frac = rest[:index]
                tz_part = rest[index:]
                break
        else:
            # No tz offset found (unlikely for k6)
            frac = rest
        frac = frac[:6].ljust(6, "0")
        timestamp_string = f"{base}.{frac}{tz_part}"

    parsed_datetime = datetime.fromisoformat(timestamp_string)
    return parsed_datetime.timestamp()


def load_k6_json(filepath: Path) -> dict[str, list[dict[str, Any]]]:
    """Load k6 line-delimited JSON and group data points by metric name.

    Returns a dict mapping metric name → list of {time: float, value: float, tags: dict}.
    Only ``Point`` records are included.
    """
    metrics: dict[str, list[dict[str, Any]]] = defaultdict(list)
    with filepath.open() as file_handle:
        for line in file_handle:
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            if record.get("type") != "Point":
                continue
            metric_name = record.get("metric", "")
            data = record.get("data", {})
            time_value = data.get("time")
            point_value = data.get("value")
            tags = data.get("tags", {})
            if time_value is None or point_value is None:
                continue
            metrics[metric_name].append(
                {
                    "time": parse_timestamp(time_value),
                    "value": point_value,
                    "tags": tags,
                }
            )
    return dict(metrics)


def extract_operation_latencies(
    metrics: dict[str, list[dict[str, Any]]],
) -> dict[str, list[tuple[float, float]]]:
    """Extract per-operation latency time-series from ``http_req_duration`` points.

    Returns a dict mapping operation name → list of (epoch_seconds, latency_ms).
    """
    operations: dict[str, list[tuple[float, float]]] = defaultdict(list)
    for point in metrics.get("http_req_duration", []):
        operation = point["tags"].get("operation")
        if operation:
            operations[operation].append((point["time"], point["value"]))
    return dict(operations)


def extract_flow_durations(
    metrics: dict[str, list[dict[str, Any]]],
) -> list[tuple[float, float]]:
    """Extract agent flow duration time-series.

    Returns list of (epoch_seconds, duration_ms).
    """
    return [
        (point["time"], point["value"])
        for point in metrics.get("agent_flow_duration", [])
    ]


def extract_http_reqs(
    metrics: dict[str, list[dict[str, Any]]],
) -> list[tuple[float, float]]:
    """Extract HTTP request counts (for throughput calculation).

    Returns list of (epoch_seconds, 1.0) — each point is one request.
    """
    return [(point["time"], point["value"]) for point in metrics.get("http_reqs", [])]


def extract_errors(
    metrics: dict[str, list[dict[str, Any]]],
) -> list[tuple[float, float]]:
    """Extract HTTP error points.

    Returns list of (epoch_seconds, 0_or_1).
    """
    return [
        (point["time"], point["value"]) for point in metrics.get("http_req_failed", [])
    ]


# ---------------------------------------------------------------------------
# Bucketing helpers
# ---------------------------------------------------------------------------


def bucket_time_series(
    points: list[tuple[float, float]],
    bucket_seconds: int = BUCKET_SECONDS,
    start_epoch: float | None = None,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Bucket a time-series into fixed-width time windows.

    Returns (bucket_midpoints_relative_seconds, means, p95s).
    ``bucket_midpoints_relative_seconds`` is relative to ``start_epoch``.
    """
    if not points:
        return np.array([]), np.array([]), np.array([])

    if start_epoch is None:
        start_epoch = min(time for time, _ in points)

    buckets: dict[int, list[float]] = defaultdict(list)
    for time_value, value in points:
        bucket_index = int((time_value - start_epoch) // bucket_seconds)
        buckets[bucket_index].append(value)

    if not buckets:
        return np.array([]), np.array([]), np.array([])

    sorted_indices = sorted(buckets.keys())
    midpoints = np.array([(index + 0.5) * bucket_seconds for index in sorted_indices])
    means = np.array([np.mean(buckets[index]) for index in sorted_indices])
    p95_values = np.array(
        [
            np.percentile(buckets[index], 95)
            if len(buckets[index]) >= 2
            else buckets[index][0]
            for index in sorted_indices
        ]
    )
    return midpoints, means, p95_values


def bucket_throughput(
    points: list[tuple[float, float]],
    bucket_seconds: int = BUCKET_SECONDS,
    start_epoch: float | None = None,
) -> tuple[np.ndarray, np.ndarray]:
    """Bucket HTTP request counts into requests/second.

    Returns (bucket_midpoints_relative_seconds, requests_per_second).
    """
    if not points:
        return np.array([]), np.array([])

    if start_epoch is None:
        start_epoch = min(time for time, _ in points)

    buckets: dict[int, int] = defaultdict(int)
    for time_value, _ in points:
        bucket_index = int((time_value - start_epoch) // bucket_seconds)
        buckets[bucket_index] += 1

    if not buckets:
        return np.array([]), np.array([])

    sorted_indices = sorted(buckets.keys())
    midpoints = np.array([(index + 0.5) * bucket_seconds for index in sorted_indices])
    requests_per_second = np.array(
        [buckets[index] / bucket_seconds for index in sorted_indices]
    )
    return midpoints, requests_per_second


def bucket_error_rate(
    points: list[tuple[float, float]],
    bucket_seconds: int = BUCKET_SECONDS,
    start_epoch: float | None = None,
) -> tuple[np.ndarray, np.ndarray]:
    """Bucket error points into error rate percentage per window.

    Returns (bucket_midpoints_relative_seconds, error_rate_percent).
    """
    if not points:
        return np.array([]), np.array([])

    if start_epoch is None:
        start_epoch = min(time for time, _ in points)

    bucket_totals: dict[int, int] = defaultdict(int)
    bucket_errors: dict[int, int] = defaultdict(int)
    for time_value, value in points:
        bucket_index = int((time_value - start_epoch) // bucket_seconds)
        bucket_totals[bucket_index] += 1
        if value == 1:
            bucket_errors[bucket_index] += 1

    if not bucket_totals:
        return np.array([]), np.array([])

    sorted_indices = sorted(bucket_totals.keys())
    midpoints = np.array([(index + 0.5) * bucket_seconds for index in sorted_indices])
    error_rates = np.array(
        [
            100.0 * bucket_errors.get(index, 0) / bucket_totals[index]
            for index in sorted_indices
        ]
    )
    return midpoints, error_rates


def compute_percentiles(values: list[float]) -> dict[str, float]:
    """Compute summary statistics for a list of values."""
    if not values:
        return {"count": 0, "min": 0, "max": 0, "avg": 0, "p50": 0, "p95": 0, "p99": 0}
    arr = np.array(values)
    return {
        "count": len(arr),
        "min": float(np.min(arr)),
        "max": float(np.max(arr)),
        "avg": float(np.mean(arr)),
        "p50": float(np.percentile(arr, 50)),
        "p95": float(np.percentile(arr, 95)),
        "p99": float(np.percentile(arr, 99)),
    }


# ---------------------------------------------------------------------------
# Plotting
# ---------------------------------------------------------------------------


def plot_comparison_grid(
    runtime_data: dict[str, dict[str, Any]],
    title: str,
    output_path: Path,
) -> None:
    """Generate a 3×3 comparison grid and save to ``output_path``.

    ``runtime_data`` maps runtime key ("ts" / "python") to a dict with:
        - "metrics": raw k6 metrics
        - "operations": per-operation latencies
        - "flow_durations": agent flow durations
        - "http_reqs": request count points
        - "errors": error points
    """
    fig, axes = plt.subplots(3, 3, figsize=(20, 14))
    fig.suptitle(title, fontsize=16, fontweight="bold", y=0.98)
    fig.patch.set_facecolor("#fafafa")

    # Compute a per-runtime start epoch so each runtime's t=0 is its own
    # first data point — the two runs happen at different absolute times.
    per_runtime_start: dict[str, float] = {}
    for runtime_key, data in runtime_data.items():
        all_times: list[float] = []
        for operation, points in data["operations"].items():
            all_times.extend(time for time, _ in points)
        all_times.extend(time for time, _ in data["flow_durations"])
        all_times.extend(time for time, _ in data["http_reqs"])
        per_runtime_start[runtime_key] = min(all_times) if all_times else 0.0

    # --- Row 1: time-series overview ---
    # (0,0) Full flow latency over time
    _plot_flow_latency_over_time(axes[0][0], runtime_data, per_runtime_start)
    # (0,1) Throughput over time (req/s)
    _plot_throughput_over_time(axes[0][1], runtime_data, per_runtime_start)
    # (0,2) Error rate over time
    _plot_error_rate_over_time(axes[0][2], runtime_data, per_runtime_start)

    # --- Row 2: per-operation time-series (each gets its own plot) ---
    # (1,0) Run/Wait latency over time
    _plot_single_operation_over_time(
        axes[1][0], runtime_data, per_runtime_start, "run_wait", "Run / Wait"
    )
    # (1,1) Run/Stream latency over time
    _plot_single_operation_over_time(
        axes[1][1], runtime_data, per_runtime_start, "run_stream", "Run / Stream"
    )
    # (1,2) Store ops latency over time (put + get + search averaged)
    _plot_store_ops_over_time(axes[1][2], runtime_data, per_runtime_start)

    # --- Row 3: distributions + summary ---
    # (2,0) Box plots per operation (log scale)
    _plot_operation_boxplots(axes[2][0], runtime_data)
    # (2,1) CDF of full flow duration (log x-axis)
    _plot_flow_cdf(axes[2][1], runtime_data)
    # (2,2) Summary stats text
    _plot_summary_text(axes[2][2], runtime_data)

    plt.tight_layout(rect=[0, 0, 1, 0.96])
    fig.savefig(
        str(output_path), dpi=150, bbox_inches="tight", facecolor=fig.get_facecolor()
    )
    plt.close(fig)
    print(f"Saved: {output_path}")


def _style_axis(
    axis: plt.Axes,
    title: str,
    xlabel: str,
    ylabel: str,
    log_y: bool = False,
) -> None:
    """Apply consistent styling to an axis."""
    axis.set_title(title, fontsize=11, fontweight="bold", pad=8)
    axis.set_xlabel(xlabel, fontsize=9)
    axis.set_ylabel(ylabel, fontsize=9)
    axis.tick_params(labelsize=8)
    axis.grid(True, alpha=0.3, linewidth=0.5)
    axis.set_facecolor("#ffffff")
    if log_y:
        axis.set_yscale("log")
        axis.yaxis.set_major_formatter(ticker.ScalarFormatter())
        axis.yaxis.set_minor_formatter(ticker.NullFormatter())


def _add_legend(axis: plt.Axes, **kwargs: Any) -> None:
    """Add a compact legend."""
    defaults = {"fontsize": 8, "framealpha": 0.8, "edgecolor": "#cccccc"}
    defaults.update(kwargs)
    axis.legend(**defaults)


def _plot_single_operation_over_time(
    axis: plt.Axes,
    runtime_data: dict[str, dict[str, Any]],
    per_runtime_start: dict[str, float],
    operation: str,
    operation_display_name: str,
) -> None:
    """Plot mean + p95 band for a single operation over time (log y-axis)."""
    _style_axis(
        axis,
        f"{operation_display_name} — Latency Over Time",
        "Time (s)",
        "Latency (ms, log)",
        log_y=True,
    )

    for runtime_key, data in runtime_data.items():
        style = RUNTIME_STYLES[runtime_key]
        start_epoch = per_runtime_start[runtime_key]
        points = data["operations"].get(operation, [])
        if not points:
            continue
        midpoints, means, p95_values = bucket_time_series(
            points, start_epoch=start_epoch
        )
        if len(midpoints) == 0:
            continue
        axis.fill_between(
            midpoints, means, p95_values, alpha=0.15, color=style["color"]
        )
        axis.plot(
            midpoints,
            means,
            color=style["color"],
            linewidth=1.5,
            alpha=0.8,
            label=f"{style['label']} (mean)",
        )
        axis.plot(
            midpoints,
            p95_values,
            color=style["color"],
            linewidth=1.0,
            alpha=0.5,
            linestyle="--",
            label=f"{style['label']} (p95)",
        )

    _add_legend(axis, loc="upper right")


def _plot_store_ops_over_time(
    axis: plt.Axes,
    runtime_data: dict[str, dict[str, Any]],
    per_runtime_start: dict[str, float],
) -> None:
    """Plot store put/get/search latency over time (separate lines, log y-axis)."""
    _style_axis(
        axis,
        "Store Operations — Latency Over Time",
        "Time (s)",
        "Latency (ms, log)",
        log_y=True,
    )

    store_operations = ["store_put", "store_get", "store_list"]
    store_labels = {"store_put": "put", "store_get": "get", "store_list": "search"}
    linestyles_map = {"store_put": "-", "store_get": "--", "store_list": ":"}

    for runtime_key, data in runtime_data.items():
        style = RUNTIME_STYLES[runtime_key]
        start_epoch = per_runtime_start[runtime_key]
        for store_operation in store_operations:
            points = data["operations"].get(store_operation, [])
            if not points:
                continue
            midpoints, means, _p95_values = bucket_time_series(
                points, start_epoch=start_epoch
            )
            if len(midpoints) == 0:
                continue
            axis.plot(
                midpoints,
                means,
                color=style["color"],
                linestyle=linestyles_map[store_operation],
                linewidth=1.5,
                alpha=0.7,
                label=f"{style['label']} — {store_labels[store_operation]}",
            )

    _add_legend(axis, loc="upper right", ncol=2, fontsize=7)


def _plot_throughput_over_time(
    axis: plt.Axes,
    runtime_data: dict[str, dict[str, Any]],
    per_runtime_start: dict[str, float],
) -> None:
    """Plot HTTP requests/second over time."""
    _style_axis(axis, "Throughput Over Time", "Time (s)", "Requests / sec")

    for runtime_key, data in runtime_data.items():
        style = RUNTIME_STYLES[runtime_key]
        start_epoch = per_runtime_start[runtime_key]
        midpoints, rps = bucket_throughput(data["http_reqs"], start_epoch=start_epoch)
        if len(midpoints) == 0:
            continue
        axis.fill_between(midpoints, rps, alpha=0.15, color=style["color"])
        axis.plot(
            midpoints,
            rps,
            color=style["color"],
            linewidth=1.5,
            alpha=0.8,
            label=style["label"],
        )

    _add_legend(axis, loc="upper right")


def _plot_flow_latency_over_time(
    axis: plt.Axes,
    runtime_data: dict[str, dict[str, Any]],
    per_runtime_start: dict[str, float],
) -> None:
    """Plot full agent flow latency over time (mean + p95 band, log y-axis)."""
    _style_axis(
        axis,
        "Full Flow Latency Over Time",
        "Time (s)",
        "Duration (ms, log)",
        log_y=True,
    )

    for runtime_key, data in runtime_data.items():
        style = RUNTIME_STYLES[runtime_key]
        start_epoch = per_runtime_start[runtime_key]
        midpoints, means, p95_values = bucket_time_series(
            data["flow_durations"],
            start_epoch=start_epoch,
        )
        if len(midpoints) == 0:
            continue
        axis.fill_between(
            midpoints, means, p95_values, alpha=0.15, color=style["color"]
        )
        axis.plot(
            midpoints,
            means,
            color=style["color"],
            linewidth=1.5,
            alpha=0.8,
            label=f"{style['label']} (mean)",
        )
        axis.plot(
            midpoints,
            p95_values,
            color=style["color"],
            linewidth=1.0,
            alpha=0.5,
            linestyle="--",
            label=f"{style['label']} (p95)",
        )

    _add_legend(axis, loc="upper right")


def _plot_operation_boxplots(
    axis: plt.Axes,
    runtime_data: dict[str, dict[str, Any]],
) -> None:
    """Side-by-side box plots per operation (log scale)."""
    _style_axis(axis, "Per-Operation Latency Distribution", "", "Latency (ms, log)")

    runtime_keys = list(runtime_data.keys())
    num_runtimes = len(runtime_keys)

    # Only include operations that have data
    available_operations = []
    for operation in MAIN_OPERATIONS:
        has_data = any(
            operation in data["operations"] and len(data["operations"][operation]) > 0
            for data in runtime_data.values()
        )
        if has_data:
            available_operations.append(operation)

    if not available_operations:
        axis.text(0.5, 0.5, "No operation data", transform=axis.transAxes, ha="center")
        return

    positions = []
    box_data = []
    colours = []
    group_width = 0.8
    box_width = group_width / max(num_runtimes, 1)

    for operation_index, operation in enumerate(available_operations):
        for runtime_index, runtime_key in enumerate(runtime_keys):
            style = RUNTIME_STYLES[runtime_key]
            points = runtime_data[runtime_key]["operations"].get(operation, [])
            values = [value for _, value in points]
            if not values:
                values = [0]

            position = (
                operation_index + (runtime_index - (num_runtimes - 1) / 2) * box_width
            )
            positions.append(position)
            box_data.append(values)
            colours.append(style["color_light"])

    box_plot = axis.boxplot(
        box_data,
        positions=positions,
        widths=box_width * 0.8,
        patch_artist=True,
        showfliers=False,
        medianprops={"color": "#333333", "linewidth": 1.5},
        whiskerprops={"linewidth": 0.8},
        capprops={"linewidth": 0.8},
    )
    for patch, colour in zip(box_plot["boxes"], colours):
        patch.set_facecolor(colour)
        patch.set_alpha(0.7)

    axis.set_xticks(range(len(available_operations)))
    axis.set_xticklabels(
        [
            OPERATION_LABELS.get(operation, operation)
            for operation in available_operations
        ],
        fontsize=7,
    )
    axis.set_yscale("log")
    axis.yaxis.set_major_formatter(ticker.ScalarFormatter())

    # Legend
    legend_patches = []
    for runtime_key in runtime_keys:
        style = RUNTIME_STYLES[runtime_key]
        legend_patches.append(
            matplotlib.patches.Patch(
                facecolor=style["color_light"],
                edgecolor=style["color"],
                label=style["label"],
            )
        )
    axis.legend(handles=legend_patches, fontsize=8, loc="upper right")


def _plot_flow_cdf(
    axis: plt.Axes,
    runtime_data: dict[str, dict[str, Any]],
) -> None:
    """CDF of full agent flow duration (log x-axis for cross-runtime readability)."""
    _style_axis(axis, "Full Flow Duration — CDF", "Duration (ms, log)", "Cumulative %")

    for runtime_key, data in runtime_data.items():
        style = RUNTIME_STYLES[runtime_key]
        values = sorted(value for _, value in data["flow_durations"])
        if not values:
            continue
        cumulative_percent = np.linspace(0, 100, len(values))
        axis.plot(
            values,
            cumulative_percent,
            color=style["color"],
            linewidth=2,
            alpha=0.8,
            label=style["label"],
        )

        # Add vertical lines at p50 and p95 for each runtime
        flow_stats = compute_percentiles(values)
        for percentile_key, linestyle in [("p50", "-"), ("p95", "--")]:
            percentile_value = flow_stats[percentile_key]
            axis.axvline(
                x=percentile_value,
                color=style["color"],
                linewidth=0.8,
                linestyle=linestyle,
                alpha=0.4,
            )
            axis.text(
                percentile_value,
                5 if runtime_key == "ts" else 15,
                f"{percentile_key}={percentile_value:.0f}",
                fontsize=6,
                color=style["color"],
                alpha=0.7,
                rotation=90,
                va="bottom",
            )

    # Reference lines at p50, p95, p99
    for pct in [50, 95, 99]:
        axis.axhline(y=pct, color="#999999", linewidth=0.5, linestyle=":", alpha=0.3)

    axis.set_xscale("log")
    axis.xaxis.set_major_formatter(ticker.ScalarFormatter())
    axis.xaxis.set_minor_formatter(ticker.NullFormatter())
    _add_legend(axis, loc="lower right")


def _plot_error_rate_over_time(
    axis: plt.Axes,
    runtime_data: dict[str, dict[str, Any]],
    per_runtime_start: dict[str, float],
) -> None:
    """Plot HTTP error rate over time."""
    _style_axis(axis, "HTTP Error Rate Over Time", "Time (s)", "Error Rate (%)")

    has_any_errors = False
    for runtime_key, data in runtime_data.items():
        style = RUNTIME_STYLES[runtime_key]
        start_epoch = per_runtime_start[runtime_key]
        midpoints, error_rates = bucket_error_rate(
            data["errors"], start_epoch=start_epoch
        )
        if len(midpoints) == 0:
            continue
        if np.max(error_rates) > 0:
            has_any_errors = True
        axis.plot(
            midpoints,
            error_rates,
            color=style["color"],
            linewidth=1.5,
            alpha=0.8,
            label=style["label"],
        )
        axis.fill_between(midpoints, error_rates, alpha=0.1, color=style["color"])

    if not has_any_errors:
        axis.text(
            0.5,
            0.5,
            "✓ 0% errors across all runtimes",
            transform=axis.transAxes,
            ha="center",
            va="center",
            fontsize=12,
            color="#22c55e",
            fontweight="bold",
        )

    axis.set_ylim(bottom=-0.5)
    _add_legend(axis, loc="upper right")


def _plot_summary_text(
    axis: plt.Axes,
    runtime_data: dict[str, dict[str, Any]],
) -> None:
    """Render a text summary panel with key stats."""
    axis.axis("off")
    axis.set_title("Summary", fontsize=11, fontweight="bold", pad=8)

    lines: list[str] = []
    for runtime_key, data in runtime_data.items():
        style = RUNTIME_STYLES[runtime_key]
        flow_values = [value for _, value in data["flow_durations"]]
        flow_stats = compute_percentiles(flow_values)

        total_requests = len(data["http_reqs"])
        error_count = sum(1 for _, value in data["errors"] if value == 1)
        error_rate = 100.0 * error_count / total_requests if total_requests > 0 else 0.0

        lines.append(f"{'─' * 40}")
        lines.append(f"  {style['label']}")
        lines.append(f"{'─' * 40}")
        lines.append(f"  Iterations:    {flow_stats['count']:,.0f}")
        lines.append(f"  HTTP requests: {total_requests:,}")
        lines.append(f"  Error rate:    {error_rate:.1f}%")
        lines.append(f"  Flow p50:      {flow_stats['p50']:.0f} ms")
        lines.append(f"  Flow p95:      {flow_stats['p95']:.0f} ms")
        lines.append(f"  Flow p99:      {flow_stats['p99']:.0f} ms")
        lines.append(f"  Flow min:      {flow_stats['min']:.0f} ms")
        lines.append(f"  Flow max:      {flow_stats['max']:.0f} ms")
        lines.append("")

    # Add ratio if both runtimes present
    if "ts" in runtime_data and "python" in runtime_data:
        ts_p50 = compute_percentiles(
            [v for _, v in runtime_data["ts"]["flow_durations"]]
        )["p50"]
        py_p50 = compute_percentiles(
            [v for _, v in runtime_data["python"]["flow_durations"]]
        )["p50"]
        if ts_p50 > 0:
            ratio = py_p50 / ts_p50
            lines.append(f"  Ratio (p50): TS is {ratio:.1f}x faster")

    text_content = "\n".join(lines)
    axis.text(
        0.05,
        0.95,
        text_content,
        transform=axis.transAxes,
        fontsize=8,
        fontfamily="monospace",
        verticalalignment="top",
        bbox={"boxstyle": "round,pad=0.5", "facecolor": "#f0f0f0", "alpha": 0.8},
    )


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def parse_arguments() -> argparse.Namespace:
    """Parse command-line arguments."""
    parser = argparse.ArgumentParser(
        description="Generate benchmark comparison plots from k6 JSON output.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Compare both runtimes:
  uv run --with matplotlib --with numpy benchmarks/scripts/plot-results.py \\
      --ts benchmarks/results/ts-v0.1.0-mock-5vu.json \\
      --python benchmarks/results/python-v0.1.0-mock-5vu.json \\
      --output benchmarks/results/v0.1.0-comparison.png

  # Single runtime:
  uv run --with matplotlib --with numpy benchmarks/scripts/plot-results.py \\
      --ts benchmarks/results/ts-v0.1.0-mock-5vu.json
        """,
    )
    parser.add_argument(
        "--ts",
        type=Path,
        help="Path to TypeScript runtime k6 JSON results",
    )
    parser.add_argument(
        "--python",
        type=Path,
        help="Path to Python runtime k6 JSON results",
    )
    parser.add_argument(
        "--output",
        "-o",
        type=Path,
        default=Path("benchmarks/results/comparison.png"),
        help="Output PNG path (default: benchmarks/results/comparison.png)",
    )
    parser.add_argument(
        "--title",
        "-t",
        type=str,
        default=None,
        help="Plot title (auto-generated if not specified)",
    )
    parser.add_argument(
        "--bucket-seconds",
        type=int,
        default=BUCKET_SECONDS,
        help=f"Time bucket width in seconds for time-series plots (default: {BUCKET_SECONDS})",
    )
    return parser.parse_args()


def main() -> None:
    """Entry point."""
    arguments = parse_arguments()

    global BUCKET_SECONDS
    BUCKET_SECONDS = arguments.bucket_seconds

    if not arguments.ts and not arguments.python:
        print("Error: provide at least one of --ts or --python", file=sys.stderr)
        sys.exit(1)

    runtime_data: dict[str, dict[str, Any]] = {}

    for runtime_key, filepath in [("ts", arguments.ts), ("python", arguments.python)]:
        if filepath is None:
            continue
        if not filepath.exists():
            print(f"Error: file not found: {filepath}", file=sys.stderr)
            sys.exit(1)

        print(f"Loading {runtime_key}: {filepath} ...", end=" ", flush=True)
        metrics = load_k6_json(filepath)
        operations = extract_operation_latencies(metrics)
        flow_durations = extract_flow_durations(metrics)
        http_reqs = extract_http_reqs(metrics)
        errors = extract_errors(metrics)

        iteration_count = len(flow_durations)
        request_count = len(http_reqs)
        print(f"{iteration_count} iterations, {request_count} HTTP requests")

        runtime_data[runtime_key] = {
            "metrics": metrics,
            "operations": operations,
            "flow_durations": flow_durations,
            "http_reqs": http_reqs,
            "errors": errors,
        }

    # Auto-generate title
    title = arguments.title
    if title is None:
        runtime_names = " vs ".join(
            RUNTIME_STYLES[runtime_key]["label"] for runtime_key in runtime_data
        )
        title = f"Fractal Agents Runtime — {runtime_names}\nMock LLM · HS256 Local JWT · In-Memory Storage · 5 VUs"

    # Ensure output directory exists
    arguments.output.parent.mkdir(parents=True, exist_ok=True)

    plot_comparison_grid(runtime_data, title, arguments.output)


if __name__ == "__main__":
    main()
