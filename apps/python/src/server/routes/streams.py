"""SSE streaming endpoints for Robyn server.

Implements LangGraph-compatible streaming endpoints:
- POST /threads/{thread_id}/runs/stream — Create run, stream output
- GET /threads/{thread_id}/runs/{run_id}/stream — Join existing run stream
- POST /runs/stream — Stateless run with streaming
"""

import json
import logging
import uuid
from typing import Any, AsyncGenerator

from langchain_core.messages import AIMessage, AIMessageChunk, BaseMessage, HumanMessage
from langchain_core.runnables import RunnableConfig
from pydantic import ValidationError
from robyn import Request, Robyn
from robyn.responses import SSEResponse

from server.auth import AuthenticationError, require_user
from server.models import RunCreate
from server.routes.helpers import error_response, parse_json_body
from server.routes.sse import (
    create_ai_message,
    format_error_event,
    format_metadata_event,
    format_messages_tuple_event,
    format_updates_event,
    format_values_event,
    sse_headers,
)
from server.storage import get_storage
from graphs.registry import resolve_graph_factory
from infra.tracing import inject_tracing
from server.database import checkpointer as create_checkpointer, store as create_store

logger = logging.getLogger(__name__)


def _message_to_dict(message: BaseMessage) -> dict[str, Any]:
    """Convert a LangChain message to a dict for SSE serialization.

    Args:
        message: LangChain message object

    Returns:
        Dict representation compatible with LangGraph SSE format
    """
    if hasattr(message, "model_dump"):
        # Pydantic v2
        msg_dict = message.model_dump()
    elif hasattr(message, "dict"):
        # Pydantic v1
        msg_dict = message.dict()
    else:
        # Fallback for basic conversion
        msg_dict = {
            "content": getattr(message, "content", ""),
            "type": getattr(message, "type", "unknown"),
            "id": getattr(message, "id", None),
        }

    # Ensure required fields exist
    msg_dict.setdefault("additional_kwargs", {})
    msg_dict.setdefault("response_metadata", {})
    msg_dict.setdefault("name", None)

    # AI-specific fields
    if msg_dict.get("type") == "ai":
        msg_dict.setdefault("tool_calls", [])
        msg_dict.setdefault("invalid_tool_calls", [])
        msg_dict.setdefault("usage_metadata", None)

    return msg_dict


def _build_runnable_config(
    run_id: str,
    thread_id: str,
    assistant_id: str,
    assistant_config: Any | None,
    run_config: dict[str, Any] | None,
    owner_id: str,
) -> RunnableConfig:
    """Build a RunnableConfig from assistant and run configurations.

    Args:
        run_id: The run ID
        thread_id: The thread ID
        assistant_id: The assistant ID
        assistant_config: Configuration from the assistant (dict or Pydantic model)
        run_config: Configuration from the run request (overrides assistant)
        owner_id: Owner ID for auth context

    Returns:
        RunnableConfig with merged configurable dict
    """
    # Start with empty configurable
    configurable: dict[str, Any] = {}

    # Layer 1: Assistant-level configuration
    # Handle both dict and Pydantic model (AssistantConfig)
    if assistant_config:
        if isinstance(assistant_config, dict):
            assistant_configurable = assistant_config.get("configurable", {})
        elif hasattr(assistant_config, "configurable"):
            # Pydantic model with configurable attribute
            assistant_configurable = assistant_config.configurable
        else:
            assistant_configurable = {}

        if isinstance(assistant_configurable, dict):
            configurable.update(assistant_configurable)

    # Layer 2: Run-level configuration (overrides assistant)
    if run_config:
        run_configurable = run_config.get("configurable", {})
        if isinstance(run_configurable, dict):
            configurable.update(run_configurable)

    # Layer 3: Runtime metadata
    configurable["run_id"] = run_id
    configurable["thread_id"] = thread_id
    configurable["assistant_id"] = assistant_id
    configurable["owner"] = owner_id
    configurable["user_id"] = owner_id

    # Include assistant config reference for _merge_assistant_configurable_into_run_config
    # Convert Pydantic model to dict if needed
    if assistant_config:
        if isinstance(assistant_config, dict):
            configurable["assistant"] = assistant_config
        elif hasattr(assistant_config, "model_dump"):
            configurable["assistant"] = assistant_config.model_dump()
        elif hasattr(assistant_config, "dict"):
            configurable["assistant"] = assistant_config.dict()

    return RunnableConfig(
        configurable=configurable,
        run_id=run_id,
    )


def register_stream_routes(app: Robyn) -> None:
    """Register streaming routes with the Robyn app.

    Args:
        app: Robyn application instance
    """

    # ========================================================================
    # Stateful Streaming - POST /threads/:thread_id/runs/stream
    # ========================================================================

    @app.post("/threads/:thread_id/runs/stream")
    async def create_run_stream(request: Request):
        """Create a run and stream output via SSE.

        This endpoint creates a run and streams the execution output
        as Server-Sent Events (SSE) in LangGraph-compatible format.

        Request body: RunCreate
        Response: SSE stream
        """
        try:
            user = require_user()
        except AuthenticationError as auth_error:
            return error_response(auth_error.message, 401)

        thread_id = request.path_params.get("thread_id")
        if not thread_id:
            return error_response("thread_id is required", 422)

        try:
            body = parse_json_body(request)
            create_data = RunCreate(**body)
        except json.JSONDecodeError:
            return error_response("Invalid JSON in request body", 422)
        except ValidationError as validation_error:
            return error_response(str(validation_error), 422)

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
            "status": "running",
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
        await storage.threads.update(thread_id, {"status": "busy"}, user.identity)

        # Create the SSE generator
        async def stream_generator() -> AsyncGenerator[str, None]:
            try:
                async for event in execute_run_stream(
                    run_id=run.run_id,
                    thread_id=thread_id,
                    assistant_id=assistant.assistant_id,
                    input_data=create_data.input,
                    config=create_data.config,
                    owner_id=user.identity,
                    assistant_config=assistant.config,
                    graph_id=assistant.graph_id,
                ):
                    yield event
            except Exception as stream_error:
                logger.exception("Error in stream generator")
                yield format_error_event(str(stream_error))
            finally:
                # Update run status and thread status
                await storage.runs.update_status(run.run_id, "success", user.identity)
                await storage.threads.update(
                    thread_id, {"status": "idle"}, user.identity
                )

        # Return SSE response with proper headers
        headers = sse_headers(thread_id=thread_id, run_id=run.run_id)
        return SSEResponse(
            content=stream_generator(),
            status_code=200,
            headers=headers,
        )

    # ========================================================================
    # Join Stream - GET /threads/:thread_id/runs/:run_id/stream
    # ========================================================================

    @app.get("/threads/:thread_id/runs/:run_id/stream")
    async def join_run_stream(request: Request):
        """Join an existing run's SSE stream.

        This endpoint allows clients to join an already-running stream.
        For now, this returns a simple status message since we don't
        have persistent stream state.

        Response: SSE stream
        """
        try:
            user = require_user()
        except AuthenticationError as auth_error:
            return error_response(auth_error.message, 401)

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

        # Check if run exists
        run = await storage.runs.get_by_thread(thread_id, run_id, user.identity)
        if run is None:
            return error_response(f"Run {run_id} not found", 404)

        # Create a simple SSE generator that shows current run status
        async def status_generator() -> AsyncGenerator[str, None]:
            # Emit metadata event
            yield format_metadata_event(run_id, attempt=1)

            # Emit current values from thread state
            state = await storage.threads.get_state(thread_id, user.identity)
            if state and state.values:
                yield format_values_event(
                    state.values
                    if isinstance(state.values, dict)
                    else {"values": state.values}
                )

            # If run is already completed, emit final status
            if run.status in ("success", "error", "interrupted"):
                yield format_updates_event(
                    "status", {"status": run.status, "message": "Run already completed"}
                )

        headers = sse_headers(thread_id=thread_id, run_id=run_id)
        return SSEResponse(
            content=status_generator(),
            status_code=200,
            headers=headers,
        )

    # ========================================================================
    # Thread Stream - GET /threads/:thread_id/stream
    # ========================================================================

    @app.get("/threads/:thread_id/stream")
    async def join_thread_stream(request: Request):
        """Join the most recent run's stream for a thread.

        This endpoint returns the current thread state and joins any
        active run's stream. If no active run exists, returns the
        current thread state.

        Response: SSE stream with thread state
        """
        try:
            user = require_user()
        except AuthenticationError as auth_error:
            return error_response(auth_error.message, 401)

        thread_id = request.path_params.get("thread_id")

        if not thread_id:
            return error_response("thread_id is required", 422)

        storage = get_storage()

        # Check if thread exists
        thread = await storage.threads.get(thread_id, user.identity)
        if thread is None:
            return error_response(f"Thread {thread_id} not found", 404)

        # Find the most recent run for this thread
        runs = await storage.runs.list_by_thread(thread_id, user.identity, limit=1)
        most_recent_run = runs[0] if runs else None
        run_id = most_recent_run.run_id if most_recent_run else "no-run"

        # Create SSE generator with thread state
        async def thread_state_generator() -> AsyncGenerator[str, None]:
            # Emit metadata event
            yield format_metadata_event(run_id, attempt=1)

            # Emit current thread state
            state = await storage.threads.get_state(thread_id, user.identity)
            if state and state.values:
                yield format_values_event(
                    state.values
                    if isinstance(state.values, dict)
                    else {"values": state.values}
                )

            # If there's a recent run, emit its status
            if most_recent_run:
                yield format_updates_event(
                    "status",
                    {
                        "run_id": most_recent_run.run_id,
                        "status": most_recent_run.status,
                        "message": f"Most recent run status: {most_recent_run.status}",
                    },
                )

        headers = sse_headers(thread_id=thread_id, run_id=run_id)
        return SSEResponse(
            content=thread_state_generator(),
            status_code=200,
            headers=headers,
        )

    # ========================================================================
    # Stateless Streaming - POST /runs/stream
    # ========================================================================

    @app.post("/runs/stream")
    async def create_stateless_run_stream(request: Request):
        """Create a stateless run and stream output via SSE.

        Stateless runs don't persist thread state. The thread is created
        temporarily and can be deleted after completion based on
        on_completion setting.

        Request body: RunCreate
        Response: SSE stream
        """
        try:
            user = require_user()
        except AuthenticationError as auth_error:
            return error_response(auth_error.message, 401)

        try:
            body = parse_json_body(request)
            create_data = RunCreate(**body)
        except json.JSONDecodeError:
            return error_response("Invalid JSON in request body", 422)
        except ValidationError as validation_error:
            return error_response(str(validation_error), 422)

        storage = get_storage()

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

        # Create a temporary thread for stateless execution
        temp_thread = await storage.threads.create(
            {
                "metadata": {
                    "stateless": True,
                    "on_completion": create_data.on_completion,
                }
            },
            user.identity,
        )
        thread_id = temp_thread.thread_id

        # Build run data
        run_data: dict[str, Any] = {
            "thread_id": thread_id,
            "assistant_id": assistant.assistant_id,
            "status": "running",
            "metadata": {**create_data.metadata, "stateless": True},
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

        # Create the SSE generator
        async def stream_generator() -> AsyncGenerator[str, None]:
            try:
                async for event in execute_run_stream(
                    run_id=run.run_id,
                    thread_id=thread_id,
                    assistant_id=assistant.assistant_id,
                    input_data=create_data.input,
                    config=create_data.config,
                    owner_id=user.identity,
                    assistant_config=assistant.config,
                    graph_id=assistant.graph_id,
                ):
                    yield event
            except Exception as stream_error:
                logger.exception("Error in stateless stream generator")
                yield format_error_event(str(stream_error))
            finally:
                # Update run status
                await storage.runs.update_status(run.run_id, "success", user.identity)

                # Handle on_completion behavior
                if create_data.on_completion == "delete":
                    # Delete thread and run for stateless execution
                    await storage.runs.delete_by_thread(
                        thread_id, run.run_id, user.identity
                    )
                    await storage.threads.delete(thread_id, user.identity)

        # Return SSE response with stateless headers
        headers = sse_headers(run_id=run.run_id, stateless=True)
        return SSEResponse(
            content=stream_generator(),
            status_code=200,
            headers=headers,
        )


async def execute_run_stream(
    run_id: str,
    thread_id: str,
    assistant_id: str,
    input_data: Any,
    config: dict[str, Any] | None,
    owner_id: str,
    assistant_config: dict[str, Any] | None = None,
    graph_id: str | None = None,
) -> AsyncGenerator[str, None]:
    """Execute a run using the agent graph and yield SSE events.

    Resolves the graph factory from :func:`graphs.registry.resolve_graph_factory`
    based on the assistant's ``graph_id`` and streams LangGraph events as
    SSE-formatted responses.

    Args:
        run_id: The run ID
        thread_id: The thread ID
        assistant_id: The assistant ID
        input_data: Input data for the run (messages or dict with messages)
        config: Configuration from the run request
        owner_id: Owner ID for storage operations
        assistant_config: Configuration from the assistant (base settings)
        graph_id: The assistant's graph_id (e.g. ``"agent"``,
            ``"research_agent"``).  Falls back to ``"agent"`` if not
            provided.

    Yields:
        SSE-formatted event strings
    """
    storage = get_storage()

    # 1. Emit metadata event (always first)
    yield format_metadata_event(run_id, attempt=1)

    # 2. Extract input messages and emit initial values
    input_messages: list[BaseMessage] = []
    if isinstance(input_data, dict):
        # Handle {"messages": [...]} format
        raw_messages = input_data.get("messages", [])
        for msg in raw_messages:
            if isinstance(msg, BaseMessage):
                input_messages.append(msg)
            elif isinstance(msg, dict):
                content = msg.get("content", "")
                msg_type = msg.get("type") or msg.get("role", "human")
                msg_id = msg.get("id") or str(uuid.uuid4())
                if msg_type in ("human", "user"):
                    input_messages.append(HumanMessage(content=content, id=msg_id))
                elif msg_type in ("ai", "assistant"):
                    input_messages.append(AIMessage(content=content, id=msg_id))
                else:
                    # Default to human message
                    input_messages.append(HumanMessage(content=content, id=msg_id))
            elif isinstance(msg, str):
                input_messages.append(HumanMessage(content=msg, id=str(uuid.uuid4())))

        # Handle {"input": "..."} format as fallback
        if not input_messages and "input" in input_data:
            input_messages.append(
                HumanMessage(
                    content=str(input_data["input"]),
                    id=str(uuid.uuid4()),
                )
            )
    elif isinstance(input_data, str):
        input_messages.append(HumanMessage(content=input_data, id=str(uuid.uuid4())))

    # Emit initial values with input messages
    initial_values = {"messages": [_message_to_dict(m) for m in input_messages]}
    yield format_values_event(initial_values)

    # 3. Build RunnableConfig
    runnable_config = _build_runnable_config(
        run_id=run_id,
        thread_id=thread_id,
        assistant_id=assistant_id,
        assistant_config=assistant_config,
        run_config=config,
        owner_id=owner_id,
    )

    # 3b. Inject Langfuse tracing (no-op if not configured)
    runnable_config = inject_tracing(
        runnable_config,
        user_id=owner_id,
        session_id=thread_id,
        trace_name="agent-stream",
        tags=["robyn", "streaming"],
    )

    # 4-6. Build agent, stream events, emit final values.
    #
    # The checkpointer and store are created as per-request async context
    # managers via LangGraph's ``from_conn_string()``.  Each creates a
    # fresh ``AsyncConnection`` on the **current** event loop — no shared
    # pool, no cross-loop ``asyncio.Lock`` issues.
    async with create_checkpointer() as cp, create_store() as st:
        # 4. Build the agent graph
        try:
            build_graph = resolve_graph_factory(graph_id)
            agent = await build_graph(
                runnable_config,
                checkpointer=cp,
                store=st,
            )
        except Exception as agent_build_error:
            logger.exception("Failed to build agent graph")
            yield format_error_event(
                f"Failed to initialize agent: {agent_build_error}",
                code="AGENT_INIT_ERROR",
            )
            return

        # Track state for SSE event generation
        current_ai_message_id: str | None = None
        current_metadata: dict[str, Any] = {}
        accumulated_content = ""
        final_ai_message_dict: dict[str, Any] | None = None
        all_messages: list[dict[str, Any]] = list(initial_values["messages"])

        # 5. Stream events from the agent
        try:
            agent_input = {"messages": input_messages}

            async for event in agent.astream_events(
                agent_input,
                runnable_config,
                version="v2",
            ):
                event_kind = event.get("event", "")
                event_data = event.get("data", {})
                event_name = event.get("name", "")
                event_run_id = event.get("run_id", "")
                event_metadata = event.get("metadata", {})

                # Handle chat model start — build metadata, emit initial empty delta
                if event_kind == "on_chat_model_start" and not current_ai_message_id:
                    current_ai_message_id = f"lc_run--{event_run_id}"
                    accumulated_content = ""

                    # Build flat metadata dict (included inline with every
                    # messages-tuple event — no separate metadata event needed)
                    current_metadata = {
                        "owner": owner_id,
                        "graph_id": graph_id or "agent",
                        "assistant_id": assistant_id,
                        "run_id": run_id,
                        "thread_id": thread_id,
                        "user_id": owner_id,
                        "langgraph_node": event_metadata.get("langgraph_node", "model"),
                        "langgraph_step": event_metadata.get("langgraph_step", 1),
                        "langgraph_checkpoint_ns": event_metadata.get(
                            "langgraph_checkpoint_ns", ""
                        ),
                        # Forward LangSmith-style ls_* keys from LangChain metadata
                        **{
                            k: v
                            for k, v in event_metadata.items()
                            if k.startswith("ls_")
                        },
                    }

                    # Emit initial empty-content delta as messages tuple
                    initial_delta = create_ai_message("", current_ai_message_id)
                    yield format_messages_tuple_event(initial_delta, current_metadata)

                # Handle streaming tokens — emit content DELTA (not accumulated)
                elif event_kind == "on_chat_model_stream":
                    chunk = event_data.get("chunk")
                    if chunk and current_ai_message_id:
                        # astream_events v2 already yields per-token deltas
                        if isinstance(chunk, AIMessageChunk):
                            chunk_content = chunk.content or ""
                        elif isinstance(chunk, dict):
                            chunk_content = chunk.get("content", "")
                        else:
                            chunk_content = str(chunk) if chunk else ""

                        if chunk_content:
                            # Accumulate locally (needed for final values event)
                            accumulated_content += chunk_content

                            # Emit the DELTA only — SDK concatenates via .concat()
                            delta_msg = create_ai_message(
                                chunk_content, current_ai_message_id
                            )
                            yield format_messages_tuple_event(
                                delta_msg, current_metadata
                            )

                # Handle chat model end — emit final delta with finish_reason
                elif event_kind == "on_chat_model_end":
                    output = event_data.get("output")
                    if output and current_ai_message_id:
                        # Extract response metadata for finish_reason / model_name
                        if isinstance(output, AIMessage):
                            final_content = output.content or accumulated_content
                            response_metadata = (
                                getattr(output, "response_metadata", {}) or {}
                            )
                        elif isinstance(output, dict):
                            final_content = output.get("content", accumulated_content)
                            response_metadata = output.get("response_metadata", {})
                        else:
                            final_content = accumulated_content
                            response_metadata = {}

                        finish_reason = response_metadata.get("finish_reason", "stop")
                        model_name = response_metadata.get("model_name")
                        model_provider = response_metadata.get(
                            "model_provider", "openai"
                        )

                        # Build the complete final AI message
                        final_ai_message_dict = create_ai_message(
                            final_content,
                            current_ai_message_id,
                            finish_reason=finish_reason,
                            model_name=model_name,
                            model_provider=model_provider,
                        )

                        # Emit a final empty-content delta carrying finish metadata
                        final_delta = create_ai_message(
                            "",
                            current_ai_message_id,
                            finish_reason=finish_reason,
                            model_name=model_name,
                            model_provider=model_provider,
                        )
                        yield format_messages_tuple_event(final_delta, current_metadata)

                # Handle chain/graph end - emit updates event
                elif event_kind == "on_chain_end" and event_name == "model":
                    output = event_data.get("output", {})
                    if isinstance(output, dict):
                        output_messages = output.get("messages", [])
                        if output_messages:
                            # Convert messages to dicts
                            update_messages = []
                            for msg in output_messages:
                                if isinstance(msg, BaseMessage):
                                    update_messages.append(_message_to_dict(msg))
                                elif isinstance(msg, dict):
                                    update_messages.append(msg)

                            if update_messages:
                                yield format_updates_event(
                                    "model", {"messages": update_messages}
                                )
                                # Use the last AI message for final values
                                for msg in reversed(update_messages):
                                    if msg.get("type") == "ai":
                                        final_ai_message_dict = msg
                                        break

        except Exception as stream_error:
            logger.exception("Error during agent streaming")
            yield format_error_event(str(stream_error), code="STREAM_ERROR")
            # Don't return - still emit final values with what we have

        # 6. Emit final values event
        if final_ai_message_dict:
            all_messages.append(final_ai_message_dict)
        elif accumulated_content and current_ai_message_id:
            # Fallback: create AI message from accumulated content
            final_ai_message_dict = create_ai_message(
                accumulated_content,
                current_ai_message_id,
                finish_reason="stop",
                model_provider="openai",
            )
            all_messages.append(final_ai_message_dict)

        final_values = {"messages": all_messages}
        yield format_values_event(final_values)

    # Store the final state in the thread (outside the checkpointer/store
    # context — uses PostgresStorage which has its own connections).
    await storage.threads.add_state_snapshot(thread_id, final_values, owner_id)
    await storage.threads.update(thread_id, {"values": final_values}, owner_id)
