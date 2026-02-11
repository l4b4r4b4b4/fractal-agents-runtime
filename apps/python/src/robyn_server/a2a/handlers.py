"""A2A Protocol method handlers.

Implements the JSON-RPC 2.0 method handlers for A2A protocol.
Maps A2A concepts (tasks, messages, artifacts) to LangGraph concepts
(runs, threads, input/output).
"""

import json
import logging
import uuid
from datetime import datetime, timezone
from typing import Any, AsyncGenerator

from robyn_server.a2a.schemas import (
    A2AMessage,
    Artifact,
    JsonRpcErrorCode,
    JsonRpcRequest,
    JsonRpcResponse,
    MessageSendParams,
    StatusUpdateEvent,
    Task,
    TaskCancelParams,
    TaskGetParams,
    TaskState,
    TaskStatus,
    TextPart,
    create_error_response,
    create_success_response,
    create_task_id,
    extract_data_from_parts,
    extract_text_from_parts,
    has_file_parts,
    map_run_status_to_task_state,
    parse_task_id,
)
from robyn_server.storage import get_storage

logger = logging.getLogger(__name__)

# Maximum characters to show in message preview for logging/placeholders
MAX_MESSAGE_PREVIEW_LENGTH = 100


class A2AMethodHandler:
    """Handler for A2A JSON-RPC methods.

    Provides method routing and execution for the A2A protocol,
    mapping A2A operations to LangGraph run/thread operations.
    """

    def __init__(self) -> None:
        """Initialize the method handler."""
        pass

    async def handle_request(
        self,
        request: JsonRpcRequest,
        assistant_id: str,
        owner_id: str,
    ) -> JsonRpcResponse:
        """Route a JSON-RPC request to the appropriate handler.

        Args:
            request: The JSON-RPC request to handle.
            assistant_id: The assistant ID from the URL path.
            owner_id: The authenticated user's identity.

        Returns:
            JSON-RPC response with result or error.
        """
        method = request.method
        params = request.params or {}

        logger.debug(f"A2A request: method={method}, id={request.id}")

        # Route to appropriate handler
        handler_map = {
            "message/send": self._handle_message_send,
            "tasks/get": self._handle_tasks_get,
            "tasks/cancel": self._handle_tasks_cancel,
        }

        # message/stream is handled separately (returns SSE)
        if method == "message/stream":
            # Return error - streaming should be handled at route level
            return create_error_response(
                request.id,
                JsonRpcErrorCode.INTERNAL_ERROR,
                "message/stream should be handled by SSE route",
            )

        handler = handler_map.get(method)
        if handler is None:
            logger.warning(f"A2A method not found: {method}")
            return create_error_response(
                request.id,
                JsonRpcErrorCode.METHOD_NOT_FOUND,
                f"Method not found: {method}",
            )

        try:
            result = await handler(params, assistant_id, owner_id)
            return create_success_response(request.id, result)
        except ValueError as e:
            logger.error(f"A2A invalid params: {e}")
            return create_error_response(
                request.id,
                JsonRpcErrorCode.INVALID_PARAMS,
                str(e),
            )
        except Exception as e:
            logger.exception(f"A2A internal error: {e}")
            return create_error_response(
                request.id,
                JsonRpcErrorCode.INTERNAL_ERROR,
                f"Internal error: {str(e)}",
            )

    async def _handle_message_send(
        self,
        params: dict[str, Any],
        assistant_id: str,
        owner_id: str,
    ) -> dict[str, Any]:
        """Handle the message/send method.

        Sends a message to the agent and waits for the response.
        Maps to LangGraph's /runs/wait endpoint.

        Args:
            params: Message parameters including the A2A message.
            assistant_id: The assistant ID to use.
            owner_id: The authenticated user's identity.

        Returns:
            Task result with status and artifacts.
        """
        # Parse and validate params
        try:
            send_params = MessageSendParams.model_validate(params)
        except Exception as e:
            raise ValueError(f"Invalid message/send params: {e}") from e

        message = send_params.message

        # Check for unsupported file parts
        if has_file_parts(message.parts):
            raise ValueError("File parts are not supported")

        storage = get_storage()

        # Get or create thread (contextId)
        thread_id = message.context_id
        if thread_id:
            thread = await storage.threads.get(thread_id, owner_id)
            if thread is None:
                raise ValueError(f"Context not found: {thread_id}")
        else:
            # Create new thread
            thread = await storage.threads.create({}, owner_id)
            thread_id = thread.thread_id

        # Verify assistant exists
        assistant = await storage.assistants.get(assistant_id, owner_id)
        if assistant is None:
            # Try by graph_id
            assistants = await storage.assistants.list(owner_id)
            assistant = next(
                (a for a in assistants if a.graph_id == assistant_id),
                None,
            )
            if assistant is None:
                raise ValueError(f"Assistant not found: {assistant_id}")

        # Extract input from message parts
        text_content = extract_text_from_parts(message.parts)
        data_content = extract_data_from_parts(message.parts)

        # Build input for LangGraph
        run_input: dict[str, Any] = {}
        if text_content:
            # Text parts go into messages
            run_input["messages"] = [
                {
                    "type": "human",
                    "content": text_content,
                    "id": message.message_id,
                }
            ]
        if data_content:
            # Data parts are merged into input
            run_input.update(data_content)

        # Handle task resumption if taskId provided
        if message.task_id:
            try:
                _, existing_run_id = parse_task_id(message.task_id)
                # Could add resume logic here if needed
                logger.debug(f"Resuming task with run_id: {existing_run_id}")
            except ValueError:
                pass  # Ignore invalid task_id

        # Create and execute run
        run_data: dict[str, Any] = {
            "thread_id": thread_id,
            "assistant_id": assistant.assistant_id,
            "status": "running",
            "metadata": {"a2a_message_id": message.message_id},
            "kwargs": {"input": run_input},
            "multitask_strategy": "reject",
        }

        run = await storage.runs.create(run_data, owner_id)
        await storage.threads.update(thread_id, {"status": "busy"}, owner_id)

        # Execute the agent (simplified - in real impl would call agent graph)
        response_text = await self._execute_agent(
            message=text_content or json.dumps(data_content),
            thread_id=thread_id,
            assistant_id=assistant.assistant_id,
        )

        # Store result in thread state
        if run_input:
            await storage.threads.add_state_snapshot(
                thread_id,
                {"values": run_input},
                owner_id,
            )

        # Mark run as success
        await storage.runs.update_status(run.run_id, "success", owner_id)
        await storage.threads.update(thread_id, {"status": "idle"}, owner_id)

        # Build A2A Task response
        task_id = create_task_id(thread_id, run.run_id)
        task = Task(
            id=task_id,
            context_id=thread_id,
            status=TaskStatus(
                state=TaskState.COMPLETED,
                timestamp=datetime.now(timezone.utc).isoformat(),
            ),
            artifacts=[
                Artifact(
                    artifact_id=str(uuid.uuid4()),
                    name="Assistant Response",
                    parts=[TextPart(text=response_text)],
                )
            ],
        )

        return task.model_dump(by_alias=True)

    async def _handle_tasks_get(
        self,
        params: dict[str, Any],
        assistant_id: str,
        owner_id: str,
    ) -> dict[str, Any]:
        """Handle the tasks/get method.

        Retrieves the current state of a task.

        Args:
            params: Task get parameters.
            assistant_id: The assistant ID (not used).
            owner_id: The authenticated user's identity.

        Returns:
            Task with current status and artifacts.
        """
        # Parse params
        try:
            get_params = TaskGetParams.model_validate(params)
        except Exception as e:
            raise ValueError(f"Invalid tasks/get params: {e}") from e

        # Parse task_id to get thread_id and run_id
        try:
            thread_id, run_id = parse_task_id(get_params.id)
        except ValueError as e:
            raise ValueError(str(e)) from e

        # Verify context_id matches
        if get_params.context_id != thread_id:
            raise ValueError(
                f"contextId mismatch: expected {thread_id}, got {get_params.context_id}"
            )

        storage = get_storage()

        # Get the run
        run = await storage.runs.get_by_thread(thread_id, run_id, owner_id)
        if run is None:
            return create_error_response(
                None,
                JsonRpcErrorCode.TASK_NOT_FOUND,
                f"Task not found: {get_params.id}",
            ).model_dump()

        # Map run status to A2A task state
        task_state = map_run_status_to_task_state(run.status)

        # Get thread state for artifacts
        artifacts: list[Artifact] = []
        thread_state = await storage.threads.get_state(thread_id, owner_id)
        if thread_state and thread_state.values:
            # Extract last AI message as artifact
            messages = thread_state.values.get("messages", [])
            if messages:
                last_message = messages[-1] if isinstance(messages, list) else None
                if last_message and isinstance(last_message, dict):
                    content = last_message.get("content", "")
                    if content:
                        artifacts.append(
                            Artifact(
                                artifact_id=str(uuid.uuid4()),
                                name="Assistant Response",
                                parts=[TextPart(text=str(content))],
                            )
                        )

        # Build history if requested
        history: list[A2AMessage] = []
        if get_params.history_length > 0:
            # Get thread state history
            state_history = await storage.threads.get_state_history(
                thread_id,
                owner_id,
                limit=get_params.history_length,
            )
            for state in state_history:
                if hasattr(state, "values") and state.values:
                    messages = state.values.get("messages", [])
                    for msg in messages:
                        if isinstance(msg, dict):
                            role = "user" if msg.get("type") == "human" else "agent"
                            content = msg.get("content", "")
                            history.append(
                                A2AMessage(
                                    role=role,
                                    parts=[TextPart(text=str(content))],
                                    messageId=msg.get("id", str(uuid.uuid4())),
                                    contextId=thread_id,
                                )
                            )

        # Build task response
        task = Task(
            id=get_params.id,
            context_id=thread_id,
            status=TaskStatus(
                state=task_state,
                timestamp=run.updated_at.isoformat()
                if hasattr(run.updated_at, "isoformat")
                else str(run.updated_at),
            ),
            artifacts=artifacts,
            history=history[: get_params.history_length],
        )

        return task.model_dump(by_alias=True)

    async def _handle_tasks_cancel(
        self,
        params: dict[str, Any],
        assistant_id: str,
        owner_id: str,
    ) -> dict[str, Any]:
        """Handle the tasks/cancel method.

        Currently not supported - returns an error.

        Args:
            params: Task cancel parameters.
            assistant_id: The assistant ID (not used).
            owner_id: The authenticated user's identity.

        Returns:
            Error response indicating cancellation is not supported.
        """
        # Parse params for validation
        try:
            cancel_params = TaskCancelParams.model_validate(params)
        except Exception as e:
            raise ValueError(f"Invalid tasks/cancel params: {e}") from e

        # Task cancellation is not currently supported
        raise ValueError(
            f"Task cancellation is not supported. Task: {cancel_params.id}"
        )

    async def _execute_agent(
        self,
        message: str,
        thread_id: str,
        assistant_id: str,
    ) -> str:
        """Execute the LangGraph agent with a message.

        Args:
            message: The user message to send.
            thread_id: The thread ID for continuity.
            assistant_id: Assistant ID to use.

        Returns:
            The agent's response text.
        """
        # Try to import and use the actual agent
        try:
            from robyn_server.routes.streams import execute_run_stream

            # Collect response from stream
            response_parts = []
            run_id = str(uuid.uuid4())

            async for event in execute_run_stream(
                run_id=run_id,
                thread_id=thread_id,
                assistant_id=assistant_id,
                input_data={"messages": [{"type": "human", "content": message}]},
                config=None,
                owner_id="a2a-system",
            ):
                # Parse SSE event for final content
                if "event: values" in event or "event: updates" in event:
                    # Extract data from SSE format
                    lines = event.strip().split("\n")
                    for line in lines:
                        if line.startswith("data: "):
                            try:
                                data = json.loads(line[6:])
                                messages = data.get("messages", [])
                                if messages:
                                    last_msg = messages[-1]
                                    if isinstance(last_msg, dict):
                                        content = last_msg.get("content", "")
                                        if content and last_msg.get("type") == "ai":
                                            response_parts.append(content)
                            except json.JSONDecodeError:
                                pass

            if response_parts:
                return response_parts[-1]

            return (
                f"[Agent processed message: {message[:MAX_MESSAGE_PREVIEW_LENGTH]}...]"
            )

        except ImportError:
            logger.warning("Agent execution not available - returning placeholder")
            return f"[A2A Agent placeholder] Received: {message}"
        except Exception as e:
            logger.exception(f"Agent execution failed: {e}")
            return f"[Agent error: {str(e)}]"

    async def handle_message_stream(
        self,
        params: dict[str, Any],
        assistant_id: str,
        owner_id: str,
        request_id: str | int | None,
    ) -> AsyncGenerator[str, None]:
        """Handle the message/stream method with SSE.

        Sends a message and streams the response as SSE events.

        Args:
            params: Message parameters.
            assistant_id: The assistant ID to use.
            owner_id: The authenticated user's identity.
            request_id: The JSON-RPC request ID.

        Yields:
            SSE-formatted event strings with JSON-RPC envelopes.
        """
        # Parse params
        try:
            send_params = MessageSendParams.model_validate(params)
        except Exception as e:
            error_response = create_error_response(
                request_id,
                JsonRpcErrorCode.INVALID_PARAMS,
                f"Invalid message/stream params: {e}",
            )
            yield f"data: {json.dumps(error_response.model_dump())}\n\n"
            return

        message = send_params.message

        # Check for unsupported file parts
        if has_file_parts(message.parts):
            error_response = create_error_response(
                request_id,
                JsonRpcErrorCode.INVALID_PART_TYPE,
                "File parts are not supported",
            )
            yield f"data: {json.dumps(error_response.model_dump())}\n\n"
            return

        storage = get_storage()

        # Get or create thread
        thread_id = message.context_id
        if thread_id:
            thread = await storage.threads.get(thread_id, owner_id)
            if thread is None:
                error_response = create_error_response(
                    request_id,
                    JsonRpcErrorCode.INVALID_PARAMS,
                    f"Context not found: {thread_id}",
                )
                yield f"data: {json.dumps(error_response.model_dump())}\n\n"
                return
        else:
            thread = await storage.threads.create({}, owner_id)
            thread_id = thread.thread_id

        # Verify assistant
        assistant = await storage.assistants.get(assistant_id, owner_id)
        if assistant is None:
            assistants = await storage.assistants.list(owner_id)
            assistant = next(
                (a for a in assistants if a.graph_id == assistant_id),
                None,
            )
            if assistant is None:
                error_response = create_error_response(
                    request_id,
                    JsonRpcErrorCode.INVALID_PARAMS,
                    f"Assistant not found: {assistant_id}",
                )
                yield f"data: {json.dumps(error_response.model_dump())}\n\n"
                return

        # Create run
        run_id = str(uuid.uuid4())
        task_id = create_task_id(thread_id, run_id)

        # Emit initial status update
        status_event = StatusUpdateEvent(
            task_id=task_id,
            context_id=thread_id,
            status=TaskStatus(
                state=TaskState.WORKING,
                timestamp=datetime.now(timezone.utc).isoformat(),
            ),
            final=False,
        )
        response = create_success_response(
            request_id, status_event.model_dump(by_alias=True)
        )
        yield f"data: {json.dumps(response.model_dump())}\n\n"

        # Extract input
        text_content = extract_text_from_parts(message.parts)
        data_content = extract_data_from_parts(message.parts)

        # Execute agent and stream results
        response_text = await self._execute_agent(
            message=text_content or json.dumps(data_content),
            thread_id=thread_id,
            assistant_id=assistant.assistant_id,
        )

        # Emit final task result
        final_task = Task(
            id=task_id,
            context_id=thread_id,
            status=TaskStatus(
                state=TaskState.COMPLETED,
                timestamp=datetime.now(timezone.utc).isoformat(),
            ),
            artifacts=[
                Artifact(
                    artifact_id=str(uuid.uuid4()),
                    name="Assistant Response",
                    parts=[TextPart(text=response_text)],
                )
            ],
        )

        final_response = create_success_response(
            request_id, final_task.model_dump(by_alias=True)
        )
        yield f"data: {json.dumps(final_response.model_dump())}\n\n"


# Global handler instance
a2a_handler = A2AMethodHandler()
