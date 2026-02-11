"""Crons API route handlers.

Implements LangGraph-compatible endpoints for scheduled cron jobs:
- POST /runs/crons - Create a cron job
- POST /runs/crons/search - Search cron jobs
- POST /runs/crons/count - Count cron jobs
- DELETE /runs/crons/{cron_id} - Delete a cron job
"""

import json
import logging
from typing import TYPE_CHECKING

from pydantic import ValidationError
from robyn import Response

from robyn_server.auth import AuthenticationError, require_user
from robyn_server.crons import (
    CronCountRequest,
    CronCreate,
    CronSearch,
    get_cron_handler,
)
from robyn_server.routes.helpers import error_response, json_response, parse_json_body

if TYPE_CHECKING:
    from robyn import Robyn

logger = logging.getLogger(__name__)


def register_cron_routes(app: "Robyn") -> None:
    """Register cron API routes on the Robyn application.

    Args:
        app: The Robyn application instance.
    """

    @app.post("/runs/crons")
    async def create_cron(request) -> Response:
        """Create a new cron job.

        Request body: CronCreate
        Response: Cron (200) or error (4xx)
        """
        try:
            user = require_user()
        except AuthenticationError as e:
            return error_response(e.message, 401)

        try:
            body = parse_json_body(request)
            create_data = CronCreate(**body)
        except json.JSONDecodeError:
            return error_response("Invalid JSON in request body", 422)
        except ValidationError as e:
            return error_response(str(e), 422)

        handler = get_cron_handler()

        try:
            cron = await handler.create_cron(create_data, user.identity)
            return json_response(cron.model_dump(mode="json"), 200)
        except ValueError as e:
            return error_response(str(e), 404)
        except Exception as e:
            logger.exception(f"Error creating cron: {e}")
            return error_response(f"Internal error: {str(e)}", 500)

    @app.post("/runs/crons/search")
    async def search_crons(request) -> Response:
        """Search cron jobs.

        Request body: CronSearch
        Response: List[Cron] (200) or error (4xx)
        """
        try:
            user = require_user()
        except AuthenticationError as e:
            return error_response(e.message, 401)

        try:
            body = parse_json_body(request)
            search_params = CronSearch(**body)
        except json.JSONDecodeError:
            return error_response("Invalid JSON in request body", 422)
        except ValidationError as e:
            return error_response(str(e), 422)

        handler = get_cron_handler()

        try:
            crons = await handler.search_crons(search_params, user.identity)
            return json_response(
                [cron.model_dump(mode="json") for cron in crons],
                200,
            )
        except Exception as e:
            logger.exception(f"Error searching crons: {e}")
            return error_response(f"Internal error: {str(e)}", 500)

    @app.post("/runs/crons/count")
    async def count_crons(request) -> Response:
        """Count cron jobs matching filters.

        Request body: CronCountRequest
        Response: int (200) or error (4xx)
        """
        try:
            user = require_user()
        except AuthenticationError as e:
            return error_response(e.message, 401)

        try:
            body = parse_json_body(request)
            count_params = CronCountRequest(**body)
        except json.JSONDecodeError:
            return error_response("Invalid JSON in request body", 422)
        except ValidationError as e:
            return error_response(str(e), 422)

        handler = get_cron_handler()

        try:
            count = await handler.count_crons(count_params, user.identity)
            return json_response(count, 200)
        except Exception as e:
            logger.exception(f"Error counting crons: {e}")
            return error_response(f"Internal error: {str(e)}", 500)

    @app.delete("/runs/crons/:cron_id")
    async def delete_cron(request) -> Response:
        """Delete a cron job.

        Path parameters:
            cron_id: ID of the cron to delete

        Response: {} (200) or error (4xx)
        """
        try:
            user = require_user()
        except AuthenticationError as e:
            return error_response(e.message, 401)

        cron_id = request.path_params.get("cron_id")
        if not cron_id:
            return error_response("cron_id is required", 422)

        handler = get_cron_handler()

        try:
            result = await handler.delete_cron(cron_id, user.identity)
            return json_response(result, 200)
        except ValueError as e:
            return error_response(str(e), 404)
        except Exception as e:
            logger.exception(f"Error deleting cron: {e}")
            return error_response(f"Internal error: {str(e)}", 500)

    logger.info(
        "Cron routes registered: "
        "POST /runs/crons, "
        "POST /runs/crons/search, "
        "POST /runs/crons/count, "
        "DELETE /runs/crons/{cron_id}"
    )
