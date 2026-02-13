"""Metrics API routes for Robyn server.

Implements Prometheus-format metrics endpoint for monitoring and observability.
"""

import time
from collections import defaultdict
from threading import Lock
from typing import Any

from robyn import Request, Response, Robyn

from server.storage import get_storage

# ============================================================================
# Metrics Storage (Thread-Safe)
# ============================================================================

_metrics_lock = Lock()
_request_counts: dict[str, int] = defaultdict(int)
_request_errors: dict[str, int] = defaultdict(int)
_request_durations: list[tuple[str, float]] = []
_stream_count: int = 0
_agent_invocations: int = 0
_agent_errors: int = 0
_start_time: float = time.time()


def increment_request_count(endpoint: str, method: str, status: int) -> None:
    """Increment request counter."""
    with _metrics_lock:
        key = f"{method}_{endpoint}_{status}"
        _request_counts[key] += 1


def increment_request_error(error_type: str) -> None:
    """Increment error counter."""
    with _metrics_lock:
        _request_errors[error_type] += 1


def record_request_duration(endpoint: str, duration_seconds: float) -> None:
    """Record request duration."""
    with _metrics_lock:
        _request_durations.append((endpoint, duration_seconds))
        # Keep only last 1000 samples to prevent memory growth
        if len(_request_durations) > 1000:
            _request_durations.pop(0)


def increment_stream_count() -> None:
    """Increment active stream counter."""
    global _stream_count
    with _metrics_lock:
        _stream_count += 1


def decrement_stream_count() -> None:
    """Decrement active stream counter."""
    global _stream_count
    with _metrics_lock:
        _stream_count = max(0, _stream_count - 1)


def increment_agent_invocation() -> None:
    """Increment agent invocation counter."""
    global _agent_invocations
    with _metrics_lock:
        _agent_invocations += 1


def increment_agent_error() -> None:
    """Increment agent error counter."""
    global _agent_errors
    with _metrics_lock:
        _agent_errors += 1


# ============================================================================
# Metrics Formatting (Prometheus)
# ============================================================================


def format_prometheus_metrics() -> str:
    """Format metrics in Prometheus exposition format."""
    lines: list[str] = []

    # Uptime
    uptime = time.time() - _start_time
    lines.append("# HELP agent_runtime_uptime_seconds Time since server start")
    lines.append("# TYPE agent_runtime_uptime_seconds gauge")
    lines.append(f"agent_runtime_uptime_seconds {uptime:.2f}")
    lines.append("")

    # Request counts
    lines.append("# HELP agent_runtime_requests_total Total number of requests")
    lines.append("# TYPE agent_runtime_requests_total counter")
    with _metrics_lock:
        for key, count in _request_counts.items():
            parts = key.rsplit("_", 2)
            if len(parts) >= 3:
                method = parts[0]
                status = parts[-1]
                endpoint = "_".join(parts[1:-1])
                lines.append(
                    f'agent_runtime_requests_total{{method="{method}",endpoint="{endpoint}",status="{status}"}} {count}'
                )
    lines.append("")

    # Error counts
    lines.append("# HELP agent_runtime_errors_total Total number of errors")
    lines.append("# TYPE agent_runtime_errors_total counter")
    with _metrics_lock:
        for error_type, count in _request_errors.items():
            lines.append(f'agent_runtime_errors_total{{type="{error_type}"}} {count}')
    if not _request_errors:
        lines.append('agent_runtime_errors_total{type="none"} 0')
    lines.append("")

    # Active streams
    lines.append("# HELP agent_runtime_active_streams Number of active SSE streams")
    lines.append("# TYPE agent_runtime_active_streams gauge")
    with _metrics_lock:
        lines.append(f"agent_runtime_active_streams {_stream_count}")
    lines.append("")

    # Agent metrics
    lines.append(
        "# HELP agent_runtime_agent_invocations_total Total agent graph invocations"
    )
    lines.append("# TYPE agent_runtime_agent_invocations_total counter")
    with _metrics_lock:
        lines.append(f"agent_runtime_agent_invocations_total {_agent_invocations}")
    lines.append("")

    lines.append("# HELP agent_runtime_agent_errors_total Total agent execution errors")
    lines.append("# TYPE agent_runtime_agent_errors_total counter")
    with _metrics_lock:
        lines.append(f"agent_runtime_agent_errors_total {_agent_errors}")
    lines.append("")

    # Storage metrics
    try:
        storage = get_storage()

        # Count all items (across all owners)
        assistant_count = len(storage.assistants._data)
        thread_count = len(storage.threads._data)
        run_count = len(storage.runs._data)

        lines.append("# HELP agent_runtime_assistants_total Total number of assistants")
        lines.append("# TYPE agent_runtime_assistants_total gauge")
        lines.append(f"agent_runtime_assistants_total {assistant_count}")
        lines.append("")

        lines.append("# HELP agent_runtime_threads_total Total number of threads")
        lines.append("# TYPE agent_runtime_threads_total gauge")
        lines.append(f"agent_runtime_threads_total {thread_count}")
        lines.append("")

        lines.append("# HELP agent_runtime_runs_total Total number of runs")
        lines.append("# TYPE agent_runtime_runs_total gauge")
        lines.append(f"agent_runtime_runs_total {run_count}")
        lines.append("")

        # Run status breakdown
        lines.append("# HELP agent_runtime_runs_by_status Number of runs by status")
        lines.append("# TYPE agent_runtime_runs_by_status gauge")
        status_counts: dict[str, int] = defaultdict(int)
        for run_data in storage.runs._data.values():
            run_status = run_data.get("status", "unknown")
            status_counts[run_status] += 1
        for status in ["pending", "running", "success", "error", "interrupted"]:
            lines.append(
                f'agent_runtime_runs_by_status{{status="{status}"}} {status_counts.get(status, 0)}'
            )
        lines.append("")

    except Exception:
        # Storage not initialized yet
        pass

    # Request duration histogram (simplified - just percentiles)
    with _metrics_lock:
        if _request_durations:
            durations = [d[1] for d in _request_durations]
            durations.sort()

            lines.append(
                "# HELP agent_runtime_request_duration_seconds Request duration in seconds"
            )
            lines.append("# TYPE agent_runtime_request_duration_seconds summary")

            # Calculate percentiles
            p50_idx = int(len(durations) * 0.5)
            p90_idx = int(len(durations) * 0.9)
            p99_idx = int(len(durations) * 0.99)

            lines.append(
                f'agent_runtime_request_duration_seconds{{quantile="0.5"}} {durations[p50_idx]:.6f}'
            )
            lines.append(
                f'agent_runtime_request_duration_seconds{{quantile="0.9"}} {durations[p90_idx]:.6f}'
            )
            lines.append(
                f'agent_runtime_request_duration_seconds{{quantile="0.99"}} {durations[min(p99_idx, len(durations) - 1)]:.6f}'
            )
            lines.append(
                f"agent_runtime_request_duration_seconds_sum {sum(durations):.6f}"
            )
            lines.append(
                f"agent_runtime_request_duration_seconds_count {len(durations)}"
            )
            lines.append("")

    return "\n".join(lines)


# ============================================================================
# Route Registration
# ============================================================================


def register_metrics_routes(app: Robyn) -> None:
    """Register metrics routes with the Robyn app.

    Args:
        app: Robyn application instance
    """

    @app.get("/metrics")
    async def get_metrics(request: Request) -> Response:
        """Prometheus-format metrics endpoint.

        This endpoint is intentionally public (no auth) to allow
        Prometheus scrapers to collect metrics.

        Response: Prometheus exposition format (text/plain)
        """
        metrics_text = format_prometheus_metrics()

        # Robyn Response signature: (status_code, headers, description)
        return Response(
            200,
            {"Content-Type": "text/plain; charset=utf-8"},
            metrics_text,
        )

    @app.get("/metrics/json")
    async def get_metrics_json(request: Request) -> dict[str, Any]:
        """JSON-format metrics endpoint for debugging.

        Response: JSON object with all metrics
        """
        storage = get_storage()

        # Gather all metrics
        with _metrics_lock:
            return {
                "uptime_seconds": time.time() - _start_time,
                "requests": dict(_request_counts),
                "errors": dict(_request_errors),
                "active_streams": _stream_count,
                "agent": {
                    "invocations": _agent_invocations,
                    "errors": _agent_errors,
                },
                "storage": {
                    "assistants": len(storage.assistants._data),
                    "threads": len(storage.threads._data),
                    "runs": len(storage.runs._data),
                },
            }
