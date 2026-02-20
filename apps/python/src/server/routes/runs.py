"""Runs API routes for Robyn server.

Implements LangGraph-compatible endpoints:
- POST /threads/{thread_id}/runs — Create a background run
- GET /threads/{thread_id}/runs — List runs for a thread
- GET /threads/{thread_id}/runs/{run_id} — Get a run by ID
- DELETE /threads/{thread_id}/runs/{run_id} — Delete a run
- POST /threads/{thread_id}/runs/wait — Create run, wait for output (real agent execution)

SSE streaming endpoints are implemented in streams.py.
"""

import json
import logging
from typing import Any

from pydantic import ValidationError
from robyn import Request, Response, Robyn

from server.auth import AuthenticationError, require_user
from server.models import RunCreate
from server.routes.helpers import error_response, json_response, parse_json_body
from server.routes.streams import execute_run_wait
from server.storage import get_storage

logger = logging.getLogger(__name__)


def register_run_routes(app: Robyn) -> None:
    """Register run routes with the Robyn app.

    Args:
        app: Robyn application instance
    """

    # ========================================================================
    # Tier 1 Endpoints - Core CRUD
    # ========================================================================

    @app.post("/threads/:thread_id/runs")
    async def create_run(request: Request) -> Response:
        """Create a background run for a thread.

        The run is created in "pending" status and returned immediately.
        Actual execution happens asynchronously.

        Request body: RunCreate
        Response: Run (200) or error (4xx)
        """
        try:
            user = require_user()
        except AuthenticationError as e:
            return error_response(e.message, 401)

        thread_id = request.path_params.get("thread_id")
        if not thread_id:
            return error_response("thread_id is required", 422)

        try:
            body = parse_json_body(request)
            create_data = RunCreate(**body)
        except json.JSONDecodeError:
            return error_response("Invalid JSON in request body", 422)
        except ValidationError as e:
            return error_response(str(e), 422)

        storage = get_storage()

        # Check if thread exists
        thread = await storage.threads.get(thread_id, user.identity)
        if thread is None:
            # Handle if_not_exists behavior
            if create_data.if_not_exists == "create":
                # Create the thread automatically
                thread = await storage.threads.create({}, user.identity)
                thread_id = thread.thread_id
            else:
                return error_response(f"Thread {thread_id} not found", 404)

        # Check if assistant exists (if specified)
        assistant = await storage.assistants.get(
            create_data.assistant_id, user.identity
        )
        if assistant is None:
            # Try to find by graph_id (assistant_id can be a graph name)
            assistants = await storage.assistants.list(user.identity)
            assistant = next(
                (a for a in assistants if a.graph_id == create_data.assistant_id),
                None,
            )
            if assistant is None:
                return error_response(
                    f"Assistant {create_data.assistant_id} not found", 404
                )

        # Check for multitask conflicts
        active_run = await storage.runs.get_active_run(thread_id, user.identity)
        if active_run:
            strategy = create_data.multitask_strategy
            if strategy == "reject":
                return error_response(
                    f"Thread {thread_id} already has an active run. "
                    f"Use multitask_strategy='enqueue' to queue runs.",
                    409,
                )
            elif strategy == "interrupt":
                # Interrupt the active run
                await storage.runs.update_status(
                    active_run.run_id, "interrupted", user.identity
                )
            elif strategy == "rollback":
                # Cancel and delete the active run
                await storage.runs.update_status(
                    active_run.run_id, "error", user.identity
                )
            # "enqueue" - just create the new run, it will wait

        # Build run data
        run_data: dict[str, Any] = {
            "thread_id": thread_id,
            "assistant_id": assistant.assistant_id,
            "status": "pending",
            "metadata": create_data.metadata,
            "kwargs": {
                "input": create_data.input,
                "config": create_data.config,
                "context": create_data.context,
                "interrupt_before": create_data.interrupt_before,
                "interrupt_after": create_data.interrupt_after,
                "stream_mode": create_data.stream_mode,
                "webhook": create_data.webhook,
            },
            "multitask_strategy": create_data.multitask_strategy,
        }

        run = await storage.runs.create(run_data, user.identity)

        # Update thread status to busy
        await storage.threads.update(thread_id, {"status": "busy"}, user.identity)

        # Return with Content-Location header
        response = json_response(run)
        response.headers["Content-Location"] = f"/threads/{thread_id}/runs/{run.run_id}"
        return response

    @app.get("/threads/:thread_id/runs")
    async def list_runs(request: Request) -> Response:
        """List runs for a thread.

        Query params:
        - limit: Maximum number of runs to return (default: 10)
        - offset: Number of runs to skip (default: 0)
        - status: Filter by status (pending, running, error, success, timeout, interrupted)

        Response: list[Run] (200) or error (404)
        """
        try:
            user = require_user()
        except AuthenticationError as e:
            return error_response(e.message, 401)

        thread_id = request.path_params.get("thread_id")
        if not thread_id:
            return error_response("thread_id is required", 422)

        storage = get_storage()

        # Check if thread exists
        thread = await storage.threads.get(thread_id, user.identity)
        if thread is None:
            return error_response(f"Thread {thread_id} not found", 404)

        # Parse query params
        limit = 10
        offset = 0
        status = None

        if request.query_params:
            limit_param = request.query_params.get("limit", None)
            if limit_param:
                try:
                    limit = max(1, min(int(limit_param), 100))
                except ValueError:
                    pass

            offset_param = request.query_params.get("offset", None)
            if offset_param:
                try:
                    offset = max(0, int(offset_param))
                except ValueError:
                    pass

            status = request.query_params.get("status", None)

        runs = await storage.runs.list_by_thread(
            thread_id, user.identity, limit=limit, offset=offset, status=status
        )

        return json_response(runs)

    @app.get("/threads/:thread_id/runs/:run_id")
    async def get_run(request: Request) -> Response:
        """Get a run by ID.

        Response: Run (200) or error (404)
        """
        try:
            user = require_user()
        except AuthenticationError as e:
            return error_response(e.message, 401)

        thread_id = request.path_params.get("thread_id")
        run_id = request.path_params.get("run_id")

        if not thread_id:
            return error_response("thread_id is required", 422)
        if not run_id:
            return error_response("run_id is required", 422)

        storage = get_storage()

        # Check if thread exists first
        thread = await storage.threads.get(thread_id, user.identity)
        if thread is None:
            return error_response(f"Thread {thread_id} not found", 404)

        run = await storage.runs.get_by_thread(thread_id, run_id, user.identity)
        if run is None:
            return error_response(f"Run {run_id} not found", 404)

        return json_response(run)

    @app.delete("/threads/:thread_id/runs/:run_id")
    async def delete_run(request: Request) -> Response:
        """Delete a run by ID.

        Response: empty object (200) or error (404)
        """
        try:
            user = require_user()
        except AuthenticationError as e:
            return error_response(e.message, 401)

        thread_id = request.path_params.get("thread_id")
        run_id = request.path_params.get("run_id")

        if not thread_id:
            return error_response("thread_id is required", 422)
        if not run_id:
            return error_response("run_id is required", 422)

        storage = get_storage()

        # Check if thread exists first
        thread = await storage.threads.get(thread_id, user.identity)
        if thread is None:
            return error_response(f"Thread {thread_id} not found", 404)

        deleted = await storage.runs.delete_by_thread(thread_id, run_id, user.identity)
        if not deleted:
            return error_response(f"Run {run_id} not found", 404)

        # Return empty object on success (matches LangGraph API)
        return json_response({})

    # ========================================================================
    # Wait Endpoint - Synchronous Execution
    # ========================================================================

    @app.post("/threads/:thread_id/runs/wait")
    async def create_run_wait(request: Request) -> Response:
        """Create a run and wait for output.

        This endpoint blocks until the run completes and returns the final
        thread state.  The agent graph is executed synchronously via
        :func:`execute_run_wait` (``agent.ainvoke``).

        Request body: RunCreate
        Response: thread state (200) or error (4xx/5xx)
        """
        try:
            user = require_user()
        except AuthenticationError as e:
            return error_response(e.message, 401)

        thread_id = request.path_params.get("thread_id")
        if not thread_id:
            return error_response("thread_id is required", 422)

        try:
            body = parse_json_body(request)
            create_data = RunCreate(**body)
        except json.JSONDecodeError:
            return error_response("Invalid JSON in request body", 422)
        except ValidationError as e:
            return error_response(str(e), 422)

        storage = get_storage()

        # Check if thread exists
        thread = await storage.threads.get(thread_id, user.identity)
        if thread is None:
            if create_data.if_not_exists == "create":
                thread = await storage.threads.create({}, user.identity)
                thread_id = thread.thread_id
            else:
                return error_response(f"Thread {thread_id} not found", 404)

        # Check if assistant exists
        assistant = await storage.assistants.get(
            create_data.assistant_id, user.identity
        )
        if assistant is None:
            assistants = await storage.assistants.list(user.identity)
            assistant = next(
                (a for a in assistants if a.graph_id == create_data.assistant_id),
                None,
            )
            if assistant is None:
                return error_response(
                    f"Assistant {create_data.assistant_id} not found", 404
                )

        # Check for multitask conflicts - wait uses reject by default
        active_run = await storage.runs.get_active_run(thread_id, user.identity)
        if active_run:
            strategy = create_data.multitask_strategy
            if strategy == "reject":
                return error_response(
                    f"Thread {thread_id} already has an active run", 409
                )
            elif strategy == "interrupt":
                await storage.runs.update_status(
                    active_run.run_id, "interrupted", user.identity
                )
            elif strategy == "rollback":
                await storage.runs.update_status(
                    active_run.run_id, "error", user.identity
                )

        # Build run data
        run_data: dict[str, Any] = {
            "thread_id": thread_id,
            "assistant_id": assistant.assistant_id,
            "status": "running",  # Mark as running immediately for wait
            "metadata": create_data.metadata,
            "kwargs": {
                "input": create_data.input,
                "config": create_data.config,
                "context": create_data.context,
                "interrupt_before": create_data.interrupt_before,
                "interrupt_after": create_data.interrupt_after,
            },
            "multitask_strategy": create_data.multitask_strategy,
        }

        run = await storage.runs.create(run_data, user.identity)

        # Update thread status to busy while executing
        await storage.threads.update(thread_id, {"status": "busy"}, user.identity)

        # Execute agent graph synchronously
        try:
            await execute_run_wait(
                run_id=run.run_id,
                thread_id=thread_id,
                assistant_id=assistant.assistant_id,
                input_data=create_data.input,
                config=create_data.config,
                owner_id=user.identity,
                assistant_config=assistant.config,
                graph_id=assistant.graph_id,
            )

            # Mark run as success and thread as idle
            await storage.runs.update_status(run.run_id, "success", user.identity)
            await storage.threads.update(thread_id, {"status": "idle"}, user.identity)

            # Get final thread state (includes full message history)
            state = await storage.threads.get_state(thread_id, user.identity)

            response = json_response(state)
            response.headers["Content-Location"] = (
                f"/threads/{thread_id}/runs/{run.run_id}"
            )
            return response

        except Exception as execution_error:
            logger.exception("Run %s failed for thread %s", run.run_id, thread_id)

            # Mark run as error and thread as idle
            await storage.runs.update_status(run.run_id, "error", user.identity)
            await storage.threads.update(thread_id, {"status": "idle"}, user.identity)

            return error_response(f"Agent execution failed: {execution_error}", 500)

    # ========================================================================
    # Cancel Endpoint
    # ========================================================================

    @app.post("/threads/:thread_id/runs/:run_id/cancel")
    async def cancel_run(request: Request) -> Response:
        """Cancel a running run.

        Response: empty object (200) or error (404)
        """
        try:
            user = require_user()
        except AuthenticationError as e:
            return error_response(e.message, 401)

        thread_id = request.path_params.get("thread_id")
        run_id = request.path_params.get("run_id")

        if not thread_id:
            return error_response("thread_id is required", 422)
        if not run_id:
            return error_response("run_id is required", 422)

        storage = get_storage()

        # Check if thread exists
        thread = await storage.threads.get(thread_id, user.identity)
        if thread is None:
            return error_response(f"Thread {thread_id} not found", 404)

        # Get the run
        run = await storage.runs.get_by_thread(thread_id, run_id, user.identity)
        if run is None:
            return error_response(f"Run {run_id} not found", 404)

        # Can only cancel pending or running runs
        if run.status not in ("pending", "running"):
            return error_response(f"Cannot cancel run with status '{run.status}'", 409)

        # Update run status to interrupted
        await storage.runs.update_status(run_id, "interrupted", user.identity)

        # Update thread status back to idle
        await storage.threads.update(thread_id, {"status": "idle"}, user.identity)

        # Return empty object on success
        return json_response({})
