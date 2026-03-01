"""Custom OpenAPI specification for the Robyn LangGraph runtime.

This module generates a complete OpenAPI 3.1.0 specification that matches
the quality of the original FastAPI LangGraph runtime's documentation.

Robyn's built-in OpenAPI generator doesn't auto-infer schemas from Pydantic
models like FastAPI does, so we define the spec explicitly here.

Version is read from ``pyproject.toml`` via the server package's
``__version__`` — that file is the **single source of truth**.
"""

from typing import Any

from server import __version__

# API version and metadata — derived from pyproject.toml, never hardcoded
API_VERSION = __version__
API_TITLE = "OAP LangGraph Runtime"
API_DESCRIPTION = """
Robyn-based LangGraph-compatible runtime for Open Agent Platform.

This API provides endpoints for managing assistants, threads, runs, and the store.
It implements the LangGraph API specification for compatibility with LangGraph clients.
"""

# Tag definitions for endpoint grouping
TAGS = [
    {
        "name": "Assistants",
        "description": "An assistant is a configured instance of a graph.",
    },
    {
        "name": "Threads",
        "description": "A thread contains the accumulated outputs of a group of runs.",
    },
    {
        "name": "Thread Runs",
        "description": "A run is an invocation of a graph / assistant on a thread. It updates the state of the thread.",
    },
    {
        "name": "Stateless Runs",
        "description": "A run is an invocation of a graph / assistant, with no state or memory persistence.",
    },
    {
        "name": "Store",
        "description": "Store is an API for managing persistent key-value store (long-term memory) that is available from any thread.",
    },
    {
        "name": "System",
        "description": "System endpoints for health checks, metrics, and server information.",
    },
    {
        "name": "MCP",
        "description": "Model Context Protocol endpoints. Exposes the LangGraph agent as an MCP server for external clients.",
    },
    {
        "name": "A2A",
        "description": "Agent-to-Agent Protocol endpoints. Enables inter-agent communication using JSON-RPC 2.0 over HTTP.",
    },
    {
        "name": "Crons",
        "description": "Cron endpoints for scheduling recurring runs. Allows creation of scheduled jobs that execute on a cron schedule.",
    },
]

# Reusable schema components
COMPONENTS: dict[str, Any] = {
    "schemas": {
        # Error Response
        "ErrorResponse": {
            "type": "object",
            "required": ["detail"],
            "properties": {
                "detail": {
                    "type": "string",
                    "description": "Error message describing what went wrong.",
                }
            },
            "title": "ErrorResponse",
            "description": "Standard error response format.",
        },
        # Config schema
        "Config": {
            "type": "object",
            "properties": {
                "tags": {
                    "type": "array",
                    "items": {"type": "string"},
                    "title": "Tags",
                    "description": "Tags for categorizing the run.",
                },
                "recursion_limit": {
                    "type": "integer",
                    "title": "Recursion Limit",
                    "description": "Maximum recursion depth for the graph.",
                    "default": 25,
                },
                "configurable": {
                    "type": "object",
                    "title": "Configurable",
                    "description": "Configurable parameters for the graph.",
                },
            },
            "title": "Config",
        },
        # Assistant schemas
        "Assistant": {
            "type": "object",
            "required": [
                "assistant_id",
                "graph_id",
                "config",
                "created_at",
                "updated_at",
                "metadata",
            ],
            "properties": {
                "assistant_id": {
                    "type": "string",
                    "format": "uuid",
                    "title": "Assistant ID",
                    "description": "The unique identifier of the assistant.",
                },
                "graph_id": {
                    "type": "string",
                    "title": "Graph ID",
                    "description": "The ID of the graph the assistant uses.",
                    "enum": ["agent"],
                },
                "config": {
                    "$ref": "#/components/schemas/Config",
                    "description": "Configuration for the assistant.",
                },
                "context": {
                    "type": "object",
                    "title": "Context",
                    "description": "Static context added to the assistant.",
                },
                "created_at": {
                    "type": "string",
                    "format": "date-time",
                    "title": "Created At",
                    "description": "The time the assistant was created.",
                },
                "updated_at": {
                    "type": "string",
                    "format": "date-time",
                    "title": "Updated At",
                    "description": "The last time the assistant was updated.",
                },
                "metadata": {
                    "type": "object",
                    "title": "Metadata",
                    "description": "Custom metadata for the assistant.",
                },
                "version": {
                    "type": "integer",
                    "title": "Version",
                    "description": "The version number of the assistant.",
                },
                "name": {
                    "type": "string",
                    "title": "Name",
                    "description": "The name of the assistant.",
                },
                "description": {
                    "type": ["string", "null"],
                    "title": "Description",
                    "description": "A description of the assistant.",
                },
            },
            "title": "Assistant",
        },
        "AssistantCreate": {
            "type": "object",
            "required": ["graph_id"],
            "properties": {
                "assistant_id": {
                    "type": "string",
                    "format": "uuid",
                    "title": "Assistant ID",
                    "description": "The ID of the assistant. If not provided, a random UUID will be generated.",
                },
                "graph_id": {
                    "type": "string",
                    "title": "Graph ID",
                    "description": "The ID of the graph the assistant should use.",
                    "enum": ["agent"],
                },
                "config": {
                    "type": "object",
                    "title": "Config",
                    "description": "Configuration to use for the graph.",
                },
                "context": {
                    "type": "object",
                    "title": "Context",
                    "description": "Static context added to the assistant.",
                },
                "metadata": {
                    "type": "object",
                    "title": "Metadata",
                    "description": "Metadata to add to assistant.",
                },
                "if_exists": {
                    "type": "string",
                    "enum": ["raise", "do_nothing"],
                    "title": "If Exists",
                    "description": "How to handle duplicate creation. 'raise' raises error, 'do_nothing' returns existing.",
                    "default": "raise",
                },
                "name": {
                    "type": "string",
                    "title": "Name",
                    "description": "The name of the assistant.",
                },
                "description": {
                    "type": ["string", "null"],
                    "title": "Description",
                    "description": "The description of the assistant.",
                },
            },
            "title": "AssistantCreate",
            "description": "Payload for creating an assistant.",
        },
        "AssistantPatch": {
            "type": "object",
            "properties": {
                "graph_id": {
                    "type": "string",
                    "title": "Graph ID",
                    "description": "The ID of the graph the assistant should use.",
                    "enum": ["agent"],
                },
                "config": {
                    "type": "object",
                    "title": "Config",
                    "description": "Configuration to use for the graph.",
                },
                "context": {
                    "type": "object",
                    "title": "Context",
                    "description": "Static context added to the assistant.",
                },
                "metadata": {
                    "type": "object",
                    "title": "Metadata",
                    "description": "Metadata to merge with existing assistant metadata.",
                },
                "name": {
                    "type": "string",
                    "title": "Name",
                    "description": "The new name for the assistant.",
                },
                "description": {
                    "type": "string",
                    "title": "Description",
                    "description": "The new description for the assistant.",
                },
            },
            "title": "AssistantPatch",
            "description": "Payload for updating an assistant.",
        },
        "AssistantSearchRequest": {
            "type": "object",
            "properties": {
                "metadata": {
                    "type": "object",
                    "title": "Metadata",
                    "description": "Filter by metadata key-value pairs.",
                },
                "graph_id": {
                    "type": "string",
                    "title": "Graph ID",
                    "description": "Filter by graph ID.",
                    "enum": ["agent"],
                },
                "name": {
                    "type": "string",
                    "title": "Name",
                    "description": "Filter by name (partial match).",
                },
                "limit": {
                    "type": "integer",
                    "title": "Limit",
                    "description": "Maximum number of results to return.",
                    "default": 10,
                    "minimum": 1,
                    "maximum": 1000,
                },
                "offset": {
                    "type": "integer",
                    "title": "Offset",
                    "description": "Number of results to skip.",
                    "default": 0,
                    "minimum": 0,
                },
                "sort_by": {
                    "type": "string",
                    "title": "Sort By",
                    "description": "Field to sort by.",
                },
                "sort_order": {
                    "type": "string",
                    "enum": ["asc", "desc"],
                    "title": "Sort Order",
                    "description": "Sort order (ascending or descending).",
                },
            },
            "title": "AssistantSearchRequest",
            "description": "Request body for searching assistants.",
        },
        "AssistantCountRequest": {
            "type": "object",
            "properties": {
                "metadata": {
                    "type": "object",
                    "title": "Metadata",
                    "description": "Filter by metadata key-value pairs.",
                },
                "graph_id": {
                    "type": "string",
                    "title": "Graph ID",
                    "description": "Filter by graph ID.",
                },
                "name": {
                    "type": "string",
                    "title": "Name",
                    "description": "Filter by name (partial match).",
                },
            },
            "title": "AssistantCountRequest",
            "description": "Request body for counting assistants.",
        },
        # Thread schemas
        "Thread": {
            "type": "object",
            "required": [
                "thread_id",
                "created_at",
                "updated_at",
                "metadata",
                "status",
            ],
            "properties": {
                "thread_id": {
                    "type": "string",
                    "format": "uuid",
                    "title": "Thread ID",
                    "description": "The unique identifier of the thread.",
                },
                "created_at": {
                    "type": "string",
                    "format": "date-time",
                    "title": "Created At",
                    "description": "The time the thread was created.",
                },
                "updated_at": {
                    "type": "string",
                    "format": "date-time",
                    "title": "Updated At",
                    "description": "The last time the thread was updated.",
                },
                "metadata": {
                    "type": "object",
                    "title": "Metadata",
                    "description": "Custom metadata for the thread.",
                },
                "config": {
                    "type": "object",
                    "title": "Config",
                    "description": "Thread configuration.",
                },
                "status": {
                    "type": "string",
                    "enum": ["idle", "busy", "interrupted", "error"],
                    "title": "Status",
                    "description": "The current status of the thread.",
                },
                "values": {
                    "type": "object",
                    "title": "Values",
                    "description": "The current state values of the thread.",
                },
                "interrupts": {
                    "type": "object",
                    "title": "Interrupts",
                    "description": "Active interrupts on the thread.",
                },
            },
            "title": "Thread",
        },
        "ThreadCreate": {
            "type": "object",
            "properties": {
                "thread_id": {
                    "type": "string",
                    "format": "uuid",
                    "title": "Thread ID",
                    "description": "The ID of the thread. If not provided, a random UUID will be generated.",
                },
                "metadata": {
                    "type": "object",
                    "title": "Metadata",
                    "description": "Metadata to add to thread.",
                },
                "if_exists": {
                    "type": "string",
                    "enum": ["raise", "do_nothing"],
                    "title": "If Exists",
                    "description": "How to handle duplicate creation.",
                    "default": "raise",
                },
            },
            "title": "ThreadCreate",
            "description": "Payload for creating a thread.",
        },
        "ThreadPatch": {
            "type": "object",
            "properties": {
                "metadata": {
                    "type": "object",
                    "title": "Metadata",
                    "description": "Metadata to merge with existing thread metadata.",
                },
            },
            "title": "ThreadPatch",
            "description": "Payload for updating a thread.",
        },
        "ThreadSearchRequest": {
            "type": "object",
            "properties": {
                "ids": {
                    "type": "array",
                    "items": {"type": "string", "format": "uuid"},
                    "title": "IDs",
                    "description": "Filter by specific thread IDs.",
                },
                "metadata": {
                    "type": "object",
                    "title": "Metadata",
                    "description": "Filter by metadata key-value pairs.",
                },
                "values": {
                    "type": "object",
                    "title": "Values",
                    "description": "Filter by state values.",
                },
                "status": {
                    "type": "string",
                    "enum": ["idle", "busy", "interrupted", "error"],
                    "title": "Status",
                    "description": "Filter by thread status.",
                },
                "limit": {
                    "type": "integer",
                    "title": "Limit",
                    "description": "Maximum number of results to return.",
                    "default": 10,
                    "minimum": 1,
                    "maximum": 1000,
                },
                "offset": {
                    "type": "integer",
                    "title": "Offset",
                    "description": "Number of results to skip.",
                    "default": 0,
                    "minimum": 0,
                },
                "sort_by": {
                    "type": "string",
                    "title": "Sort By",
                    "description": "Field to sort by.",
                },
                "sort_order": {
                    "type": "string",
                    "enum": ["asc", "desc"],
                    "title": "Sort Order",
                    "description": "Sort order.",
                },
            },
            "title": "ThreadSearchRequest",
            "description": "Request body for searching threads.",
        },
        "ThreadCountRequest": {
            "type": "object",
            "properties": {
                "metadata": {
                    "type": "object",
                    "title": "Metadata",
                    "description": "Filter by metadata key-value pairs.",
                },
                "values": {
                    "type": "object",
                    "title": "Values",
                    "description": "Filter by state values.",
                },
                "status": {
                    "type": "string",
                    "enum": ["idle", "busy", "interrupted", "error"],
                    "title": "Status",
                    "description": "Filter by thread status.",
                },
            },
            "title": "ThreadCountRequest",
            "description": "Request body for counting threads.",
        },
        "ThreadState": {
            "type": "object",
            "required": ["values", "next", "tasks"],
            "properties": {
                "values": {
                    "anyOf": [
                        {"type": "object"},
                        {"type": "array", "items": {"type": "object"}},
                    ],
                    "title": "Values",
                    "description": "The current state values.",
                },
                "next": {
                    "type": "array",
                    "items": {"type": "string"},
                    "title": "Next",
                    "description": "The next nodes to execute.",
                },
                "tasks": {
                    "type": "array",
                    "items": {"type": "object"},
                    "title": "Tasks",
                    "description": "Pending tasks.",
                },
                "checkpoint": {
                    "type": "object",
                    "title": "Checkpoint",
                    "description": "The current checkpoint.",
                },
                "metadata": {
                    "type": "object",
                    "title": "Metadata",
                },
                "created_at": {
                    "type": "string",
                    "title": "Created At",
                },
                "parent_checkpoint": {
                    "type": "object",
                    "title": "Parent Checkpoint",
                },
                "interrupts": {
                    "type": "array",
                    "items": {"type": "object"},
                    "title": "Interrupts",
                },
            },
            "title": "ThreadState",
        },
        # Run schemas
        "Run": {
            "type": "object",
            "required": [
                "run_id",
                "thread_id",
                "assistant_id",
                "created_at",
                "updated_at",
                "status",
                "metadata",
            ],
            "properties": {
                "run_id": {
                    "type": "string",
                    "format": "uuid",
                    "title": "Run ID",
                    "description": "The unique identifier of the run.",
                },
                "thread_id": {
                    "type": "string",
                    "format": "uuid",
                    "title": "Thread ID",
                    "description": "The ID of the thread this run belongs to.",
                },
                "assistant_id": {
                    "type": "string",
                    "format": "uuid",
                    "title": "Assistant ID",
                    "description": "The ID of the assistant used for this run.",
                },
                "created_at": {
                    "type": "string",
                    "format": "date-time",
                    "title": "Created At",
                    "description": "The time the run was created.",
                },
                "updated_at": {
                    "type": "string",
                    "format": "date-time",
                    "title": "Updated At",
                    "description": "The last time the run was updated.",
                },
                "status": {
                    "type": "string",
                    "enum": [
                        "pending",
                        "running",
                        "success",
                        "error",
                        "timeout",
                        "interrupted",
                    ],
                    "title": "Status",
                    "description": "The current status of the run.",
                },
                "metadata": {
                    "type": "object",
                    "title": "Metadata",
                    "description": "Custom metadata for the run.",
                },
                "kwargs": {
                    "type": "object",
                    "title": "Kwargs",
                },
                "multitask_strategy": {
                    "type": "string",
                    "enum": ["reject", "enqueue", "rollback", "interrupt"],
                    "title": "Multitask Strategy",
                    "description": "Strategy for handling concurrent runs.",
                },
            },
            "title": "Run",
        },
        "RunCreateStateful": {
            "type": "object",
            "required": ["assistant_id"],
            "properties": {
                "assistant_id": {
                    "anyOf": [
                        {"type": "string", "format": "uuid"},
                        {"type": "string"},
                    ],
                    "title": "Assistant ID",
                    "description": "The assistant to use. Can be UUID or graph name.",
                },
                "input": {
                    "anyOf": [
                        {"type": "object"},
                        {"type": "array"},
                        {"type": "string"},
                        {"type": "integer"},
                        {"type": "boolean"},
                        {"type": "null"},
                    ],
                    "title": "Input",
                    "description": "The input to the graph.",
                },
                "command": {
                    "type": "object",
                    "title": "Command",
                    "description": "Command to control graph execution (update, resume, goto).",
                },
                "checkpoint": {
                    "type": "object",
                    "title": "Checkpoint",
                    "description": "Checkpoint to resume from.",
                },
                "metadata": {
                    "type": "object",
                    "title": "Metadata",
                    "description": "Metadata to attach to the run.",
                },
                "config": {
                    "type": "object",
                    "title": "Config",
                    "description": "Configuration for the graph.",
                },
                "context": {
                    "type": "object",
                    "title": "Context",
                    "description": "Context to pass to the graph.",
                },
                "webhook": {
                    "type": "string",
                    "format": "uri",
                    "title": "Webhook",
                    "description": "Webhook URL to call on run completion.",
                },
                "interrupt_before": {
                    "anyOf": [
                        {"type": "string", "enum": ["*"]},
                        {"type": "array", "items": {"type": "string"}},
                    ],
                    "title": "Interrupt Before",
                    "description": "Nodes to interrupt before execution.",
                },
                "interrupt_after": {
                    "anyOf": [
                        {"type": "string", "enum": ["*"]},
                        {"type": "array", "items": {"type": "string"}},
                    ],
                    "title": "Interrupt After",
                    "description": "Nodes to interrupt after execution.",
                },
                "stream_mode": {
                    "anyOf": [
                        {
                            "type": "array",
                            "items": {
                                "type": "string",
                                "enum": [
                                    "values",
                                    "updates",
                                    "messages",
                                    "messages-tuple",
                                    "debug",
                                    "events",
                                    "custom",
                                ],
                            },
                        },
                        {
                            "type": "string",
                            "enum": [
                                "values",
                                "updates",
                                "messages",
                                "messages-tuple",
                                "debug",
                                "events",
                                "custom",
                            ],
                        },
                    ],
                    "title": "Stream Mode",
                    "description": "What to stream back.",
                    "default": ["values"],
                },
                "stream_subgraphs": {
                    "type": "boolean",
                    "title": "Stream Subgraphs",
                    "description": "Whether to stream subgraph events.",
                    "default": False,
                },
                "stream_resumable": {
                    "type": "boolean",
                    "title": "Stream Resumable",
                    "description": "Whether to stream resumable checkpoints.",
                    "default": False,
                },
                "on_disconnect": {
                    "type": "string",
                    "enum": ["cancel", "continue"],
                    "title": "On Disconnect",
                    "description": "What to do when client disconnects.",
                    "default": "continue",
                },
                "feedback_keys": {
                    "type": "array",
                    "items": {"type": "string"},
                    "title": "Feedback Keys",
                    "description": "Keys to collect feedback on.",
                },
                "multitask_strategy": {
                    "type": "string",
                    "enum": ["reject", "enqueue", "rollback", "interrupt"],
                    "title": "Multitask Strategy",
                    "description": "How to handle concurrent runs on the same thread.",
                    "default": "enqueue",
                },
                "if_not_exists": {
                    "type": "string",
                    "enum": ["create", "reject"],
                    "title": "If Not Exists",
                    "description": "What to do if the thread doesn't exist.",
                    "default": "reject",
                },
                "after_seconds": {
                    "type": "number",
                    "title": "After Seconds",
                    "description": "Delay before starting the run.",
                },
                "checkpoint_during": {
                    "type": "boolean",
                    "title": "Checkpoint During",
                    "description": "Whether to create checkpoints during execution.",
                    "default": False,
                },
                "durability": {
                    "type": "string",
                    "enum": ["sync", "async", "exit"],
                    "title": "Durability",
                    "description": "Durability mode for the run.",
                    "default": "async",
                },
            },
            "title": "RunCreateStateful",
            "description": "Payload for creating a stateful run on a thread.",
        },
        "RunCreateStateless": {
            "type": "object",
            "required": ["assistant_id"],
            "properties": {
                "assistant_id": {
                    "anyOf": [
                        {"type": "string", "format": "uuid"},
                        {"type": "string"},
                    ],
                    "title": "Assistant ID",
                    "description": "The assistant to use. Can be UUID or graph name.",
                },
                "input": {
                    "anyOf": [
                        {"type": "object"},
                        {"type": "array"},
                        {"type": "string"},
                        {"type": "integer"},
                        {"type": "boolean"},
                        {"type": "null"},
                    ],
                    "title": "Input",
                    "description": "The input to the graph.",
                },
                "command": {
                    "type": "object",
                    "title": "Command",
                    "description": "Command to control graph execution.",
                },
                "metadata": {
                    "type": "object",
                    "title": "Metadata",
                    "description": "Metadata to attach to the run.",
                },
                "config": {
                    "type": "object",
                    "title": "Config",
                    "description": "Configuration for the graph.",
                },
                "context": {
                    "type": "object",
                    "title": "Context",
                    "description": "Context to pass to the graph.",
                },
                "webhook": {
                    "type": "string",
                    "format": "uri",
                    "title": "Webhook",
                    "description": "Webhook URL to call on run completion.",
                },
                "stream_mode": {
                    "anyOf": [
                        {
                            "type": "array",
                            "items": {
                                "type": "string",
                                "enum": [
                                    "values",
                                    "updates",
                                    "messages",
                                    "debug",
                                    "events",
                                ],
                            },
                        },
                        {"type": "string"},
                    ],
                    "title": "Stream Mode",
                    "description": "What to stream back.",
                    "default": ["values"],
                },
                "feedback_keys": {
                    "type": "array",
                    "items": {"type": "string"},
                    "title": "Feedback Keys",
                },
                "stream_subgraphs": {
                    "type": "boolean",
                    "title": "Stream Subgraphs",
                    "default": False,
                },
                "on_completion": {
                    "type": "string",
                    "enum": ["delete", "keep"],
                    "title": "On Completion",
                    "description": "Whether to delete the run on completion.",
                    "default": "delete",
                },
                "on_disconnect": {
                    "type": "string",
                    "enum": ["cancel", "continue"],
                    "title": "On Disconnect",
                    "default": "continue",
                },
                "after_seconds": {
                    "type": "number",
                    "title": "After Seconds",
                },
            },
            "title": "RunCreateStateless",
            "description": "Payload for creating a stateless run.",
        },
        # Store schemas
        "StorePutRequest": {
            "type": "object",
            "required": ["namespace", "key", "value"],
            "properties": {
                "namespace": {
                    "type": "array",
                    "items": {"type": "string"},
                    "title": "Namespace",
                    "description": "The namespace for the item (e.g., ['users', 'profiles']).",
                },
                "key": {
                    "type": "string",
                    "title": "Key",
                    "description": "The key for the item within the namespace.",
                },
                "value": {
                    "type": "object",
                    "title": "Value",
                    "description": "The value to store (must be JSON-serializable).",
                },
            },
            "title": "StorePutRequest",
            "description": "Request to store an item.",
        },
        "StoreSearchRequest": {
            "type": "object",
            "required": ["namespace"],
            "properties": {
                "namespace": {
                    "type": "array",
                    "items": {"type": "string"},
                    "title": "Namespace",
                    "description": "The namespace to search within.",
                },
                "filter": {
                    "type": "object",
                    "title": "Filter",
                    "description": "Filter by value fields.",
                },
                "limit": {
                    "type": "integer",
                    "title": "Limit",
                    "default": 10,
                    "description": "Maximum number of results.",
                },
                "offset": {
                    "type": "integer",
                    "title": "Offset",
                    "default": 0,
                    "description": "Number of results to skip.",
                },
                "query": {
                    "type": "string",
                    "title": "Query",
                    "description": "Full-text search query.",
                },
            },
            "title": "StoreSearchRequest",
            "description": "Request to search store items.",
        },
        "Item": {
            "type": "object",
            "required": ["namespace", "key", "value"],
            "properties": {
                "namespace": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "The namespace of the item.",
                },
                "key": {
                    "type": "string",
                    "description": "The key of the item.",
                },
                "value": {
                    "type": "object",
                    "description": "The stored value.",
                },
                "created_at": {
                    "type": "string",
                    "format": "date-time",
                    "description": "When the item was created.",
                },
                "updated_at": {
                    "type": "string",
                    "format": "date-time",
                    "description": "When the item was last updated.",
                },
            },
            "description": "A stored item.",
        },
        "SearchItemsResponse": {
            "type": "object",
            "required": ["items"],
            "properties": {
                "items": {
                    "type": "array",
                    "items": {"$ref": "#/components/schemas/Item"},
                }
            },
        },
        # Cron schemas
        "Cron": {
            "type": "object",
            "required": [
                "cron_id",
                "thread_id",
                "schedule",
                "created_at",
                "updated_at",
                "payload",
            ],
            "properties": {
                "cron_id": {
                    "type": "string",
                    "format": "uuid",
                    "title": "Cron Id",
                    "description": "The ID of the cron.",
                },
                "assistant_id": {
                    "type": ["string", "null"],
                    "format": "uuid",
                    "title": "Assistant Id",
                    "description": "The ID of the assistant.",
                },
                "thread_id": {
                    "type": "string",
                    "format": "uuid",
                    "title": "Thread Id",
                    "description": "The ID of the thread.",
                },
                "end_time": {
                    "type": ["string", "null"],
                    "format": "date-time",
                    "title": "End Time",
                    "description": "The end date to stop running the cron.",
                },
                "schedule": {
                    "type": "string",
                    "title": "Schedule",
                    "description": "The schedule to run, cron format.",
                },
                "created_at": {
                    "type": "string",
                    "format": "date-time",
                    "title": "Created At",
                    "description": "The time the cron was created.",
                },
                "updated_at": {
                    "type": "string",
                    "format": "date-time",
                    "title": "Updated At",
                    "description": "The last time the cron was updated.",
                },
                "user_id": {
                    "type": ["string", "null"],
                    "title": "User Id",
                    "description": "The ID of the user.",
                },
                "payload": {
                    "type": "object",
                    "title": "Payload",
                    "description": "The run payload to use for creating new run.",
                },
                "next_run_date": {
                    "type": ["string", "null"],
                    "format": "date-time",
                    "title": "Next Run Date",
                    "description": "The next run date of the cron.",
                },
                "metadata": {
                    "type": "object",
                    "title": "Metadata",
                    "description": "The cron metadata.",
                },
            },
            "title": "Cron",
            "description": "Represents a scheduled task.",
        },
        "CronCreate": {
            "type": "object",
            "required": ["assistant_id", "schedule"],
            "properties": {
                "schedule": {
                    "type": "string",
                    "title": "Schedule",
                    "description": "The cron schedule to execute this job on.",
                },
                "end_time": {
                    "type": ["string", "null"],
                    "format": "date-time",
                    "title": "End Time",
                    "description": "The end date to stop running the cron.",
                },
                "assistant_id": {
                    "type": "string",
                    "title": "Assistant Id",
                    "description": "The assistant ID or graph name to run.",
                },
                "input": {
                    "anyOf": [
                        {"items": {"type": "object"}, "type": "array"},
                        {"type": "object"},
                    ],
                    "title": "Input",
                    "description": "The input to the graph.",
                },
                "metadata": {
                    "type": "object",
                    "title": "Metadata",
                    "description": "Metadata to assign to the cron job runs.",
                },
                "config": {
                    "$ref": "#/components/schemas/Config",
                },
                "context": {
                    "type": "object",
                    "title": "Context",
                    "description": "Static context added to the assistant.",
                },
                "webhook": {
                    "type": "string",
                    "format": "uri-reference",
                    "title": "Webhook",
                    "description": "Webhook to call after LangGraph API call is done.",
                },
                "interrupt_before": {
                    "anyOf": [
                        {"type": "string", "enum": ["*"]},
                        {"items": {"type": "string"}, "type": "array"},
                    ],
                    "title": "Interrupt Before",
                    "description": "Nodes to interrupt immediately before they get executed.",
                },
                "interrupt_after": {
                    "anyOf": [
                        {"type": "string", "enum": ["*"]},
                        {"items": {"type": "string"}, "type": "array"},
                    ],
                    "title": "Interrupt After",
                    "description": "Nodes to interrupt immediately after they get executed.",
                },
                "on_run_completed": {
                    "type": "string",
                    "enum": ["delete", "keep"],
                    "default": "delete",
                    "title": "On Run Completed",
                    "description": "What to do with the thread after the run completes.",
                },
            },
            "title": "CronCreate",
            "description": "Payload for creating a stateless cron job.",
        },
        "CronSearch": {
            "type": "object",
            "properties": {
                "assistant_id": {
                    "type": "string",
                    "format": "uuid",
                    "title": "Assistant Id",
                    "description": "The assistant ID to filter by.",
                },
                "thread_id": {
                    "type": "string",
                    "format": "uuid",
                    "title": "Thread Id",
                    "description": "The thread ID to search for.",
                },
                "limit": {
                    "type": "integer",
                    "title": "Limit",
                    "default": 10,
                    "minimum": 1,
                    "maximum": 1000,
                    "description": "The maximum number of results to return.",
                },
                "offset": {
                    "type": "integer",
                    "title": "Offset",
                    "default": 0,
                    "minimum": 0,
                    "description": "The number of results to skip.",
                },
                "sort_by": {
                    "type": "string",
                    "title": "Sort By",
                    "default": "created_at",
                    "enum": [
                        "cron_id",
                        "assistant_id",
                        "thread_id",
                        "next_run_date",
                        "end_time",
                        "created_at",
                        "updated_at",
                    ],
                    "description": "The field to sort by.",
                },
                "sort_order": {
                    "type": "string",
                    "title": "Sort Order",
                    "default": "desc",
                    "enum": ["asc", "desc"],
                    "description": "The order to sort by.",
                },
                "select": {
                    "type": "array",
                    "items": {
                        "type": "string",
                        "enum": [
                            "cron_id",
                            "assistant_id",
                            "thread_id",
                            "on_run_completed",
                            "end_time",
                            "schedule",
                            "created_at",
                            "updated_at",
                            "user_id",
                            "payload",
                            "next_run_date",
                            "metadata",
                        ],
                    },
                    "title": "Select",
                    "description": "Specify which fields to return.",
                },
            },
            "title": "CronSearch",
            "description": "Payload for listing crons.",
        },
        "CronCountRequest": {
            "type": "object",
            "properties": {
                "assistant_id": {
                    "type": "string",
                    "format": "uuid",
                    "title": "Assistant Id",
                    "description": "The assistant ID to search for.",
                },
                "thread_id": {
                    "type": "string",
                    "format": "uuid",
                    "title": "Thread Id",
                    "description": "The thread ID to search for.",
                },
            },
            "title": "CronCountRequest",
            "description": "Payload for counting crons.",
        },
        # System schemas
        "HealthResponse": {
            "type": "object",
            "properties": {
                "status": {
                    "type": "string",
                    "title": "Status",
                    "default": "ok",
                }
            },
            "title": "HealthResponse",
        },
        "OkResponse": {
            "type": "object",
            "required": ["ok"],
            "properties": {
                "ok": {
                    "type": "boolean",
                    "const": True,
                    "title": "Ok",
                }
            },
            "title": "OkResponse",
        },
    }
}


def _assistant_id_param() -> dict:
    """Common assistant_id path parameter."""
    return {
        "name": "assistant_id",
        "in": "path",
        "required": True,
        "schema": {"type": "string", "format": "uuid"},
        "description": "The ID of the assistant.",
    }


def _thread_id_param() -> dict:
    """Common thread_id path parameter."""
    return {
        "name": "thread_id",
        "in": "path",
        "required": True,
        "schema": {"type": "string", "format": "uuid"},
        "description": "The ID of the thread.",
    }


def _run_id_param() -> dict:
    """Common run_id path parameter."""
    return {
        "name": "run_id",
        "in": "path",
        "required": True,
        "schema": {"type": "string", "format": "uuid"},
        "description": "The ID of the run.",
    }


def _error_responses() -> dict:
    """Common error responses."""
    return {
        "404": {
            "description": "Not Found",
            "content": {
                "application/json": {
                    "schema": {"$ref": "#/components/schemas/ErrorResponse"}
                }
            },
        },
        "422": {
            "description": "Validation Error",
            "content": {
                "application/json": {
                    "schema": {"$ref": "#/components/schemas/ErrorResponse"}
                }
            },
        },
    }


# Path definitions
PATHS: dict[str, Any] = {
    # =========================================================================
    # Assistants
    # =========================================================================
    "/assistants": {
        "post": {
            "tags": ["Assistants"],
            "summary": "Create Assistant",
            "description": "Create a new assistant with the specified configuration.",
            "operationId": "create_assistant",
            "requestBody": {
                "required": True,
                "content": {
                    "application/json": {
                        "schema": {"$ref": "#/components/schemas/AssistantCreate"}
                    }
                },
            },
            "responses": {
                "200": {
                    "description": "Assistant created successfully",
                    "content": {
                        "application/json": {
                            "schema": {"$ref": "#/components/schemas/Assistant"}
                        }
                    },
                },
                "409": {
                    "description": "Conflict - Assistant already exists",
                    "content": {
                        "application/json": {
                            "schema": {"$ref": "#/components/schemas/ErrorResponse"}
                        }
                    },
                },
                **_error_responses(),
            },
        }
    },
    "/assistants/search": {
        "post": {
            "tags": ["Assistants"],
            "summary": "Search Assistants",
            "description": "Search for assistants matching the specified criteria.",
            "operationId": "search_assistants",
            "requestBody": {
                "required": True,
                "content": {
                    "application/json": {
                        "schema": {
                            "$ref": "#/components/schemas/AssistantSearchRequest"
                        }
                    }
                },
            },
            "responses": {
                "200": {
                    "description": "List of matching assistants",
                    "content": {
                        "application/json": {
                            "schema": {
                                "type": "array",
                                "items": {"$ref": "#/components/schemas/Assistant"},
                            }
                        }
                    },
                },
                **_error_responses(),
            },
        }
    },
    "/assistants/count": {
        "post": {
            "tags": ["Assistants"],
            "summary": "Count Assistants",
            "description": "Count assistants matching the specified criteria.",
            "operationId": "count_assistants",
            "requestBody": {
                "required": True,
                "content": {
                    "application/json": {
                        "schema": {"$ref": "#/components/schemas/AssistantCountRequest"}
                    }
                },
            },
            "responses": {
                "200": {
                    "description": "Count of matching assistants",
                    "content": {
                        "application/json": {
                            "schema": {"type": "integer", "title": "Count"}
                        }
                    },
                },
                **_error_responses(),
            },
        }
    },
    "/assistants/{assistant_id}": {
        "get": {
            "tags": ["Assistants"],
            "summary": "Get Assistant",
            "description": "Retrieve an assistant by its ID.",
            "operationId": "get_assistant",
            "parameters": [_assistant_id_param()],
            "responses": {
                "200": {
                    "description": "The requested assistant",
                    "content": {
                        "application/json": {
                            "schema": {"$ref": "#/components/schemas/Assistant"}
                        }
                    },
                },
                **_error_responses(),
            },
        },
        "patch": {
            "tags": ["Assistants"],
            "summary": "Update Assistant",
            "description": "Update an existing assistant's configuration.",
            "operationId": "update_assistant",
            "parameters": [_assistant_id_param()],
            "requestBody": {
                "required": True,
                "content": {
                    "application/json": {
                        "schema": {"$ref": "#/components/schemas/AssistantPatch"}
                    }
                },
            },
            "responses": {
                "200": {
                    "description": "The updated assistant",
                    "content": {
                        "application/json": {
                            "schema": {"$ref": "#/components/schemas/Assistant"}
                        }
                    },
                },
                **_error_responses(),
            },
        },
        "delete": {
            "tags": ["Assistants"],
            "summary": "Delete Assistant",
            "description": "Delete an assistant by its ID.",
            "operationId": "delete_assistant",
            "parameters": [_assistant_id_param()],
            "responses": {
                "200": {
                    "description": "Assistant deleted successfully",
                    "content": {"application/json": {"schema": {"type": "object"}}},
                },
                **_error_responses(),
            },
        },
    },
    # =========================================================================
    # Threads
    # =========================================================================
    "/threads": {
        "post": {
            "tags": ["Threads"],
            "summary": "Create Thread",
            "description": "Create a new thread for running conversations.",
            "operationId": "create_thread",
            "requestBody": {
                "required": True,
                "content": {
                    "application/json": {
                        "schema": {"$ref": "#/components/schemas/ThreadCreate"}
                    }
                },
            },
            "responses": {
                "200": {
                    "description": "Thread created successfully",
                    "content": {
                        "application/json": {
                            "schema": {"$ref": "#/components/schemas/Thread"}
                        }
                    },
                },
                "409": {
                    "description": "Conflict - Thread already exists",
                    "content": {
                        "application/json": {
                            "schema": {"$ref": "#/components/schemas/ErrorResponse"}
                        }
                    },
                },
                **_error_responses(),
            },
        }
    },
    "/threads/search": {
        "post": {
            "tags": ["Threads"],
            "summary": "Search Threads",
            "description": "Search for threads matching the specified criteria.",
            "operationId": "search_threads",
            "requestBody": {
                "required": True,
                "content": {
                    "application/json": {
                        "schema": {"$ref": "#/components/schemas/ThreadSearchRequest"}
                    }
                },
            },
            "responses": {
                "200": {
                    "description": "List of matching threads",
                    "content": {
                        "application/json": {
                            "schema": {
                                "type": "array",
                                "items": {"$ref": "#/components/schemas/Thread"},
                            }
                        }
                    },
                },
                **_error_responses(),
            },
        }
    },
    "/threads/count": {
        "post": {
            "tags": ["Threads"],
            "summary": "Count Threads",
            "description": "Count threads matching the specified criteria.",
            "operationId": "count_threads",
            "requestBody": {
                "required": True,
                "content": {
                    "application/json": {
                        "schema": {"$ref": "#/components/schemas/ThreadCountRequest"}
                    }
                },
            },
            "responses": {
                "200": {
                    "description": "Count of matching threads",
                    "content": {
                        "application/json": {
                            "schema": {"type": "integer", "title": "Count"}
                        }
                    },
                },
                **_error_responses(),
            },
        }
    },
    "/threads/{thread_id}": {
        "get": {
            "tags": ["Threads"],
            "summary": "Get Thread",
            "description": "Retrieve a thread by its ID.",
            "operationId": "get_thread",
            "parameters": [_thread_id_param()],
            "responses": {
                "200": {
                    "description": "The requested thread",
                    "content": {
                        "application/json": {
                            "schema": {"$ref": "#/components/schemas/Thread"}
                        }
                    },
                },
                **_error_responses(),
            },
        },
        "patch": {
            "tags": ["Threads"],
            "summary": "Update Thread",
            "description": "Update an existing thread's metadata.",
            "operationId": "update_thread",
            "parameters": [_thread_id_param()],
            "requestBody": {
                "required": True,
                "content": {
                    "application/json": {
                        "schema": {"$ref": "#/components/schemas/ThreadPatch"}
                    }
                },
            },
            "responses": {
                "200": {
                    "description": "The updated thread",
                    "content": {
                        "application/json": {
                            "schema": {"$ref": "#/components/schemas/Thread"}
                        }
                    },
                },
                **_error_responses(),
            },
        },
        "delete": {
            "tags": ["Threads"],
            "summary": "Delete Thread",
            "description": "Delete a thread by its ID.",
            "operationId": "delete_thread",
            "parameters": [_thread_id_param()],
            "responses": {
                "200": {
                    "description": "Thread deleted successfully",
                    "content": {"application/json": {"schema": {"type": "object"}}},
                },
                **_error_responses(),
            },
        },
    },
    "/threads/{thread_id}/state": {
        "get": {
            "tags": ["Threads"],
            "summary": "Get Thread State",
            "description": "Get the current state of a thread.",
            "operationId": "get_thread_state",
            "parameters": [_thread_id_param()],
            "responses": {
                "200": {
                    "description": "The current thread state",
                    "content": {
                        "application/json": {
                            "schema": {"$ref": "#/components/schemas/ThreadState"}
                        }
                    },
                },
                **_error_responses(),
            },
        }
    },
    "/threads/{thread_id}/history": {
        "get": {
            "tags": ["Threads"],
            "summary": "Get Thread History",
            "description": "Get the state history of a thread.",
            "operationId": "get_thread_history",
            "parameters": [
                _thread_id_param(),
                {
                    "name": "limit",
                    "in": "query",
                    "required": False,
                    "schema": {"type": "integer", "default": 10},
                    "description": "Maximum number of history entries to return.",
                },
            ],
            "responses": {
                "200": {
                    "description": "List of thread states",
                    "content": {
                        "application/json": {
                            "schema": {
                                "type": "array",
                                "items": {"$ref": "#/components/schemas/ThreadState"},
                            }
                        }
                    },
                },
                **_error_responses(),
            },
        }
    },
    # =========================================================================
    # Thread Runs
    # =========================================================================
    "/threads/{thread_id}/runs": {
        "get": {
            "tags": ["Thread Runs"],
            "summary": "List Thread Runs",
            "description": "List all runs for a thread.",
            "operationId": "list_thread_runs",
            "parameters": [
                _thread_id_param(),
                {
                    "name": "limit",
                    "in": "query",
                    "required": False,
                    "schema": {"type": "integer", "default": 10},
                },
                {
                    "name": "offset",
                    "in": "query",
                    "required": False,
                    "schema": {"type": "integer", "default": 0},
                },
            ],
            "responses": {
                "200": {
                    "description": "List of runs",
                    "content": {
                        "application/json": {
                            "schema": {
                                "type": "array",
                                "items": {"$ref": "#/components/schemas/Run"},
                            }
                        }
                    },
                },
                **_error_responses(),
            },
        },
        "post": {
            "tags": ["Thread Runs"],
            "summary": "Create Thread Run",
            "description": "Create a new run on a thread (background execution).",
            "operationId": "create_thread_run",
            "parameters": [_thread_id_param()],
            "requestBody": {
                "required": True,
                "content": {
                    "application/json": {
                        "schema": {"$ref": "#/components/schemas/RunCreateStateful"}
                    }
                },
            },
            "responses": {
                "200": {
                    "description": "Run created successfully",
                    "content": {
                        "application/json": {
                            "schema": {"$ref": "#/components/schemas/Run"}
                        }
                    },
                },
                "409": {
                    "description": "Conflict - Concurrent run rejected",
                    "content": {
                        "application/json": {
                            "schema": {"$ref": "#/components/schemas/ErrorResponse"}
                        }
                    },
                },
                **_error_responses(),
            },
        },
    },
    "/threads/{thread_id}/runs/stream": {
        "post": {
            "tags": ["Thread Runs"],
            "summary": "Stream Thread Run",
            "description": "Create a run and stream results via Server-Sent Events.",
            "operationId": "stream_thread_run",
            "parameters": [_thread_id_param()],
            "requestBody": {
                "required": True,
                "content": {
                    "application/json": {
                        "schema": {"$ref": "#/components/schemas/RunCreateStateful"}
                    }
                },
            },
            "responses": {
                "200": {
                    "description": "SSE stream of run events",
                    "content": {
                        "text/event-stream": {
                            "schema": {
                                "type": "string",
                                "description": "Server-Sent Events stream",
                            }
                        }
                    },
                },
                **_error_responses(),
            },
        }
    },
    "/threads/{thread_id}/runs/wait": {
        "post": {
            "tags": ["Thread Runs"],
            "summary": "Wait for Thread Run",
            "description": "Create a run and wait for completion, returning final output.",
            "operationId": "wait_thread_run",
            "parameters": [_thread_id_param()],
            "requestBody": {
                "required": True,
                "content": {
                    "application/json": {
                        "schema": {"$ref": "#/components/schemas/RunCreateStateful"}
                    }
                },
            },
            "responses": {
                "200": {
                    "description": "Final run output",
                    "content": {"application/json": {"schema": {"type": "object"}}},
                },
                **_error_responses(),
            },
        }
    },
    "/threads/{thread_id}/runs/{run_id}": {
        "get": {
            "tags": ["Thread Runs"],
            "summary": "Get Run",
            "description": "Get a specific run by ID.",
            "operationId": "get_run",
            "parameters": [_thread_id_param(), _run_id_param()],
            "responses": {
                "200": {
                    "description": "The requested run",
                    "content": {
                        "application/json": {
                            "schema": {"$ref": "#/components/schemas/Run"}
                        }
                    },
                },
                **_error_responses(),
            },
        },
        "delete": {
            "tags": ["Thread Runs"],
            "summary": "Delete Run",
            "description": "Delete a run by ID.",
            "operationId": "delete_run",
            "parameters": [_thread_id_param(), _run_id_param()],
            "responses": {
                "200": {
                    "description": "Run deleted successfully",
                    "content": {"application/json": {"schema": {"type": "object"}}},
                },
                **_error_responses(),
            },
        },
    },
    "/threads/{thread_id}/runs/{run_id}/cancel": {
        "post": {
            "tags": ["Thread Runs"],
            "summary": "Cancel Run",
            "description": "Cancel a running execution.",
            "operationId": "cancel_run",
            "parameters": [_thread_id_param(), _run_id_param()],
            "responses": {
                "200": {
                    "description": "Run cancelled",
                    "content": {"application/json": {"schema": {"type": "object"}}},
                },
                **_error_responses(),
            },
        }
    },
    "/threads/{thread_id}/runs/{run_id}/join": {
        "get": {
            "tags": ["Thread Runs"],
            "summary": "Join Run",
            "description": "Wait for a run to complete and return the result.",
            "operationId": "join_run",
            "parameters": [_thread_id_param(), _run_id_param()],
            "responses": {
                "200": {
                    "description": "Run result",
                    "content": {"application/json": {"schema": {"type": "object"}}},
                },
                **_error_responses(),
            },
        }
    },
    "/threads/{thread_id}/runs/{run_id}/stream": {
        "get": {
            "tags": ["Thread Runs"],
            "summary": "Stream Run Events",
            "description": "Stream events from an existing run via SSE.",
            "operationId": "stream_run_events",
            "parameters": [_thread_id_param(), _run_id_param()],
            "responses": {
                "200": {
                    "description": "SSE stream of run events",
                    "content": {
                        "text/event-stream": {
                            "schema": {
                                "type": "string",
                                "description": "Server-Sent Events stream",
                            }
                        }
                    },
                },
                **_error_responses(),
            },
        }
    },
    # =========================================================================
    # Stateless Runs
    # =========================================================================
    "/runs/stream": {
        "post": {
            "tags": ["Stateless Runs"],
            "summary": "Stream Stateless Run",
            "description": "Execute a stateless run and stream results via SSE.",
            "operationId": "stream_stateless_run",
            "requestBody": {
                "required": True,
                "content": {
                    "application/json": {
                        "schema": {"$ref": "#/components/schemas/RunCreateStateless"}
                    }
                },
            },
            "responses": {
                "200": {
                    "description": "SSE stream of run events",
                    "content": {
                        "text/event-stream": {
                            "schema": {
                                "type": "string",
                                "description": "Server-Sent Events stream",
                            }
                        }
                    },
                },
                **_error_responses(),
            },
        }
    },
    "/runs/wait": {
        "post": {
            "tags": ["Stateless Runs"],
            "summary": "Wait for Stateless Run",
            "description": "Execute a stateless run and wait for completion.",
            "operationId": "wait_stateless_run",
            "requestBody": {
                "required": True,
                "content": {
                    "application/json": {
                        "schema": {"$ref": "#/components/schemas/RunCreateStateless"}
                    }
                },
            },
            "responses": {
                "200": {
                    "description": "Final run output",
                    "content": {"application/json": {"schema": {"type": "object"}}},
                },
                **_error_responses(),
            },
        }
    },
    "/runs": {
        "post": {
            "tags": ["Stateless Runs"],
            "summary": "Create Stateless Run",
            "description": "Create a stateless run (background execution).",
            "operationId": "create_stateless_run",
            "requestBody": {
                "required": True,
                "content": {
                    "application/json": {
                        "schema": {"$ref": "#/components/schemas/RunCreateStateless"}
                    }
                },
            },
            "responses": {
                "200": {
                    "description": "Run created",
                    "content": {"application/json": {"schema": {"type": "object"}}},
                },
                **_error_responses(),
            },
        }
    },
    # =========================================================================
    # Store
    # =========================================================================
    "/store/items": {
        "get": {
            "tags": ["Store"],
            "summary": "Get Store Item",
            "description": "Retrieve an item from the store by namespace and key.",
            "operationId": "get_store_item",
            "parameters": [
                {
                    "name": "namespace",
                    "in": "query",
                    "required": True,
                    "schema": {"type": "string"},
                    "description": "The namespace (dot-separated, e.g., 'users.profiles').",
                },
                {
                    "name": "key",
                    "in": "query",
                    "required": True,
                    "schema": {"type": "string"},
                    "description": "The key within the namespace.",
                },
            ],
            "responses": {
                "200": {
                    "description": "The requested item",
                    "content": {
                        "application/json": {
                            "schema": {"$ref": "#/components/schemas/Item"}
                        }
                    },
                },
                **_error_responses(),
            },
        },
        "put": {
            "tags": ["Store"],
            "summary": "Put Store Item",
            "description": "Store an item in the key-value store.",
            "operationId": "put_store_item",
            "requestBody": {
                "required": True,
                "content": {
                    "application/json": {
                        "schema": {"$ref": "#/components/schemas/StorePutRequest"}
                    }
                },
            },
            "responses": {
                "204": {"description": "Item stored successfully"},
                **_error_responses(),
            },
        },
        "delete": {
            "tags": ["Store"],
            "summary": "Delete Store Item",
            "description": "Delete an item from the store by namespace and key.",
            "operationId": "delete_store_item",
            "parameters": [
                {
                    "name": "namespace",
                    "in": "query",
                    "required": True,
                    "schema": {"type": "string"},
                    "description": "The namespace for the item.",
                },
                {
                    "name": "key",
                    "in": "query",
                    "required": True,
                    "schema": {"type": "string"},
                    "description": "The key for the item to delete.",
                },
            ],
            "responses": {
                "200": {"description": "Item deleted successfully"},
                **_error_responses(),
            },
        },
    },
    "/store/items/search": {
        "post": {
            "tags": ["Store"],
            "summary": "Search Store Items",
            "description": "Search for items in the store.",
            "operationId": "search_store_items",
            "requestBody": {
                "required": True,
                "content": {
                    "application/json": {
                        "schema": {"$ref": "#/components/schemas/StoreSearchRequest"}
                    }
                },
            },
            "responses": {
                "200": {
                    "description": "Search results",
                    "content": {
                        "application/json": {
                            "schema": {
                                "$ref": "#/components/schemas/SearchItemsResponse"
                            }
                        }
                    },
                },
                **_error_responses(),
            },
        }
    },
    "/store/namespaces": {
        "get": {
            "tags": ["Store"],
            "summary": "List Namespaces",
            "description": "List namespaces in the store for the authenticated user.",
            "operationId": "list_namespaces",
            "responses": {
                "200": {
                    "description": "List of namespaces",
                    "content": {
                        "application/json": {
                            "schema": {
                                "type": "array",
                                "items": {
                                    "type": "array",
                                    "items": {"type": "string"},
                                },
                            }
                        }
                    },
                },
                **_error_responses(),
            },
        }
    },
    # =========================================================================
    # System
    # =========================================================================
    "/": {
        "get": {
            "tags": ["System"],
            "summary": "Root",
            "description": "Get basic service information.",
            "operationId": "root",
            "responses": {
                "200": {
                    "description": "Service information",
                    "content": {
                        "application/json": {
                            "schema": {
                                "type": "object",
                                "properties": {
                                    "service": {"type": "string"},
                                    "runtime": {"type": "string"},
                                    "version": {"type": "string"},
                                },
                            }
                        }
                    },
                }
            },
        }
    },
    "/health": {
        "get": {
            "tags": ["System"],
            "summary": "Health Check",
            "description": "Check if the service is healthy.",
            "operationId": "health_check",
            "responses": {
                "200": {
                    "description": "Service is healthy",
                    "content": {
                        "application/json": {
                            "schema": {"$ref": "#/components/schemas/HealthResponse"}
                        }
                    },
                }
            },
        }
    },
    "/ok": {
        "get": {
            "tags": ["System"],
            "summary": "OK Check",
            "description": "Simple health check returning {ok: true}.",
            "operationId": "ok_check",
            "responses": {
                "200": {
                    "description": "Service is OK",
                    "content": {
                        "application/json": {
                            "schema": {"$ref": "#/components/schemas/OkResponse"}
                        }
                    },
                }
            },
        }
    },
    "/info": {
        "get": {
            "tags": ["System"],
            "summary": "Service Info",
            "description": "Get detailed service information including capabilities and configuration status.",
            "operationId": "service_info",
            "responses": {
                "200": {
                    "description": "Detailed service information",
                    "content": {
                        "application/json": {
                            "schema": {
                                "type": "object",
                                "properties": {
                                    "service": {"type": "string"},
                                    "runtime": {"type": "string"},
                                    "version": {"type": "string"},
                                    "build": {
                                        "type": "object",
                                        "properties": {
                                            "commit": {"type": "string"},
                                            "date": {"type": "string"},
                                            "python": {"type": "string"},
                                        },
                                    },
                                    "capabilities": {
                                        "type": "object",
                                        "properties": {
                                            "streaming": {"type": "boolean"},
                                            "store": {"type": "boolean"},
                                            "crons": {"type": "boolean"},
                                            "a2a": {"type": "boolean"},
                                            "mcp": {"type": "boolean"},
                                            "metrics": {"type": "boolean"},
                                        },
                                    },
                                    "graphs": {
                                        "type": "array",
                                        "items": {"type": "string"},
                                    },
                                    "config": {
                                        "type": "object",
                                        "properties": {
                                            "supabase_configured": {"type": "boolean"},
                                            "llm_configured": {"type": "boolean"},
                                        },
                                    },
                                    "tiers": {
                                        "type": "object",
                                        "properties": {
                                            "tier1": {"type": "boolean"},
                                            "tier2": {"type": "boolean"},
                                            "tier3": {"type": "string"},
                                        },
                                    },
                                },
                            }
                        }
                    },
                }
            },
        }
    },
    "/metrics": {
        "get": {
            "tags": ["System"],
            "summary": "Prometheus Metrics",
            "description": "Get Prometheus-format metrics for monitoring.",
            "operationId": "get_metrics",
            "parameters": [
                {
                    "name": "format",
                    "in": "query",
                    "required": False,
                    "schema": {
                        "type": "string",
                        "enum": ["prometheus", "json"],
                        "default": "prometheus",
                    },
                    "description": "Output format for metrics.",
                }
            ],
            "responses": {
                "200": {
                    "description": "Metrics data",
                    "content": {
                        "text/plain": {
                            "schema": {
                                "type": "string",
                                "description": "Prometheus-format metrics",
                            }
                        },
                        "application/json": {
                            "schema": {
                                "type": "object",
                                "description": "JSON-format metrics",
                            }
                        },
                    },
                }
            },
        }
    },
    # =========================================================================
    # MCP (Model Context Protocol)
    # =========================================================================
    "/mcp/": {
        "post": {
            "tags": ["MCP"],
            "summary": "MCP Post",
            "description": """Implemented according to the Streamable HTTP Transport specification.
Sends a JSON-RPC 2.0 message to the server.

- **Request**: Provide an object with `jsonrpc`, `id`, `method`, and optional `params`.
- **Response**: Returns a JSON-RPC response or acknowledgment.

**Supported Methods:**
- `initialize` - Client handshake with capabilities
- `tools/list` - List available tools (returns the LangGraph agent)
- `tools/call` - Execute the agent with a message

**Notes:**
- Stateless: Sessions are not persisted across requests.
""",
            "operationId": "post_mcp",
            "parameters": [
                {
                    "name": "Accept",
                    "in": "header",
                    "required": False,
                    "schema": {
                        "type": "string",
                        "enum": [
                            "application/json",
                            "application/json, text/event-stream",
                        ],
                    },
                    "description": "Accept header should include 'application/json'.",
                }
            ],
            "requestBody": {
                "required": True,
                "content": {
                    "application/json": {
                        "schema": {
                            "type": "object",
                            "properties": {
                                "jsonrpc": {
                                    "type": "string",
                                    "enum": ["2.0"],
                                    "description": "JSON-RPC version (must be '2.0')",
                                },
                                "id": {
                                    "oneOf": [{"type": "string"}, {"type": "integer"}],
                                    "description": "Request ID for correlating responses",
                                },
                                "method": {
                                    "type": "string",
                                    "description": "Method to invoke (e.g., 'initialize', 'tools/list', 'tools/call')",
                                },
                                "params": {
                                    "type": "object",
                                    "description": "Method parameters",
                                },
                            },
                            "required": ["jsonrpc", "method"],
                        },
                        "example": {
                            "jsonrpc": "2.0",
                            "id": "1",
                            "method": "initialize",
                            "params": {
                                "clientInfo": {
                                    "name": "test_client",
                                    "version": "1.0.0",
                                },
                                "protocolVersion": "2024-11-05",
                                "capabilities": {},
                            },
                        },
                    }
                },
            },
            "responses": {
                "200": {
                    "description": "Successful JSON-RPC response",
                    "content": {
                        "application/json": {
                            "schema": {
                                "type": "object",
                                "properties": {
                                    "jsonrpc": {"type": "string", "enum": ["2.0"]},
                                    "id": {
                                        "oneOf": [
                                            {"type": "string"},
                                            {"type": "integer"},
                                        ]
                                    },
                                    "result": {"type": "object"},
                                    "error": {
                                        "type": "object",
                                        "properties": {
                                            "code": {"type": "integer"},
                                            "message": {"type": "string"},
                                        },
                                    },
                                },
                            }
                        }
                    },
                },
                "202": {"description": "Notification accepted; no content body"},
                "400": {"description": "Bad request: invalid JSON or message format"},
                "500": {"description": "Internal server error"},
            },
        },
        "get": {
            "tags": ["MCP"],
            "summary": "MCP Get",
            "description": "Implemented according to the Streamable HTTP Transport specification. GET is not supported (streaming not implemented).",
            "operationId": "get_mcp",
            "responses": {
                "405": {
                    "description": "GET method not allowed; streaming not supported"
                }
            },
        },
        "delete": {
            "tags": ["MCP"],
            "summary": "Terminate Session",
            "description": "Implemented according to the Streamable HTTP Transport specification. Since the server is stateless, there are no sessions to terminate.",
            "operationId": "delete_mcp",
            "responses": {
                "404": {"description": "Session not found (server is stateless)"}
            },
        },
    },
    # =========================================================================
    # Crons (Scheduled Runs)
    # =========================================================================
    "/runs/crons": {
        "post": {
            "tags": ["Crons"],
            "summary": "Create Cron",
            "description": "Create a cron to schedule runs on new threads.",
            "operationId": "create_cron_runs_crons_post",
            "requestBody": {
                "content": {
                    "application/json": {
                        "schema": {"$ref": "#/components/schemas/CronCreate"}
                    }
                },
                "required": True,
            },
            "responses": {
                "200": {
                    "description": "Success",
                    "content": {
                        "application/json": {
                            "schema": {"$ref": "#/components/schemas/Cron"}
                        }
                    },
                },
                "404": {
                    "description": "Not Found",
                    "content": {
                        "application/json": {
                            "schema": {"$ref": "#/components/schemas/ErrorResponse"}
                        }
                    },
                },
                "422": {
                    "description": "Validation Error",
                    "content": {
                        "application/json": {
                            "schema": {"$ref": "#/components/schemas/ErrorResponse"}
                        }
                    },
                },
            },
        },
    },
    "/runs/crons/search": {
        "post": {
            "tags": ["Crons"],
            "summary": "Search Crons",
            "description": "Search all active crons.",
            "operationId": "search_crons_runs_crons_search_post",
            "requestBody": {
                "content": {
                    "application/json": {
                        "schema": {"$ref": "#/components/schemas/CronSearch"}
                    }
                },
                "required": True,
            },
            "responses": {
                "200": {
                    "description": "Success",
                    "content": {
                        "application/json": {
                            "schema": {
                                "items": {"$ref": "#/components/schemas/Cron"},
                                "type": "array",
                                "title": "Response Search Crons",
                            }
                        }
                    },
                },
                "422": {
                    "description": "Validation Error",
                    "content": {
                        "application/json": {
                            "schema": {"$ref": "#/components/schemas/ErrorResponse"}
                        }
                    },
                },
            },
        },
    },
    "/runs/crons/count": {
        "post": {
            "tags": ["Crons"],
            "summary": "Count Crons",
            "description": "Get the count of crons matching the specified criteria.",
            "operationId": "count_crons_runs_crons_count_post",
            "requestBody": {
                "content": {
                    "application/json": {
                        "schema": {"$ref": "#/components/schemas/CronCountRequest"}
                    }
                },
                "required": True,
            },
            "responses": {
                "200": {
                    "description": "Success",
                    "content": {
                        "application/json": {
                            "schema": {"type": "integer", "title": "Count"}
                        }
                    },
                },
                "404": {
                    "description": "Not Found",
                    "content": {
                        "application/json": {
                            "schema": {"$ref": "#/components/schemas/ErrorResponse"}
                        }
                    },
                },
                "422": {
                    "description": "Validation Error",
                    "content": {
                        "application/json": {
                            "schema": {"$ref": "#/components/schemas/ErrorResponse"}
                        }
                    },
                },
            },
        },
    },
    "/runs/crons/{cron_id}": {
        "delete": {
            "tags": ["Crons"],
            "summary": "Delete Cron",
            "description": "Delete a cron by ID.",
            "operationId": "delete_cron_runs_crons__cron_id__delete",
            "parameters": [
                {
                    "required": True,
                    "schema": {"type": "string", "format": "uuid", "title": "Cron Id"},
                    "name": "cron_id",
                    "in": "path",
                }
            ],
            "responses": {
                "200": {
                    "description": "Success",
                    "content": {"application/json": {"schema": {}}},
                },
                "404": {
                    "description": "Not Found",
                    "content": {
                        "application/json": {
                            "schema": {"$ref": "#/components/schemas/ErrorResponse"}
                        }
                    },
                },
                "422": {
                    "description": "Validation Error",
                    "content": {
                        "application/json": {
                            "schema": {"$ref": "#/components/schemas/ErrorResponse"}
                        }
                    },
                },
            },
        },
    },
    # =========================================================================
    # A2A (Agent-to-Agent Protocol)
    # =========================================================================
    "/a2a/{assistant_id}": {
        "post": {
            "tags": ["A2A"],
            "summary": "A2A JSON-RPC",
            "description": """Communicate with an assistant using the Agent-to-Agent (A2A) Protocol over JSON-RPC 2.0.
This endpoint accepts a JSON-RPC envelope and dispatches based on `method`.

**Supported Methods:**
- `message/send`: Send a message and wait for the final Task result.
- `message/stream`: Send a message and receive Server-Sent Events (SSE) JSON-RPC responses.
- `tasks/get`: Fetch the current state of a Task by ID.
- `tasks/cancel`: Request cancellation (currently not supported; returns an error).

**LangGraph Mapping:**
- `message.contextId` maps to LangGraph `thread_id`
- `message.taskId` maps to LangGraph `run_id` (for resuming interrupted tasks)

**Notes:**
- Only `text` and `data` parts are supported; `file` parts are not.
- If `message.contextId` is omitted, a new context is created.
- Text parts require the assistant input schema to include a `messages` field.
""",
            "operationId": "post_a2a",
            "parameters": [
                {
                    "name": "assistant_id",
                    "in": "path",
                    "required": True,
                    "schema": {"type": "string", "format": "uuid"},
                    "description": "The ID of the assistant to communicate with",
                },
                {
                    "name": "Accept",
                    "in": "header",
                    "required": True,
                    "schema": {"type": "string"},
                    "description": "For `message/stream`, must include `text/event-stream`. For all other methods, use `application/json`.",
                },
            ],
            "requestBody": {
                "required": True,
                "content": {
                    "application/json": {
                        "schema": {
                            "type": "object",
                            "properties": {
                                "jsonrpc": {
                                    "type": "string",
                                    "enum": ["2.0"],
                                    "description": "JSON-RPC version",
                                },
                                "id": {
                                    "type": "string",
                                    "description": "Request identifier",
                                },
                                "method": {
                                    "type": "string",
                                    "enum": [
                                        "message/send",
                                        "message/stream",
                                        "tasks/get",
                                        "tasks/cancel",
                                    ],
                                    "description": "The method to invoke",
                                },
                                "params": {
                                    "type": "object",
                                    "description": "Method parameters; shape depends on the method.",
                                },
                            },
                            "required": ["jsonrpc", "id", "method"],
                        },
                        "examples": {
                            "message_send": {
                                "summary": "Send a message (synchronous)",
                                "value": {
                                    "jsonrpc": "2.0",
                                    "id": "1",
                                    "method": "message/send",
                                    "params": {
                                        "message": {
                                            "role": "user",
                                            "parts": [
                                                {
                                                    "kind": "text",
                                                    "text": "Hello from A2A",
                                                }
                                            ],
                                            "messageId": "msg-1",
                                            "contextId": "f5bd2a40-74b6-4f7a-b649-ea3f09890003",
                                        }
                                    },
                                },
                            },
                            "message_stream": {
                                "summary": "Send a message (streaming)",
                                "value": {
                                    "jsonrpc": "2.0",
                                    "id": "2",
                                    "method": "message/stream",
                                    "params": {
                                        "message": {
                                            "role": "user",
                                            "parts": [
                                                {
                                                    "kind": "text",
                                                    "text": "Stream this response",
                                                }
                                            ],
                                            "messageId": "msg-2",
                                        }
                                    },
                                },
                            },
                            "tasks_get": {
                                "summary": "Get a task",
                                "value": {
                                    "jsonrpc": "2.0",
                                    "id": "3",
                                    "method": "tasks/get",
                                    "params": {
                                        "id": "thread-uuid:run-uuid",
                                        "contextId": "thread-uuid",
                                        "historyLength": 5,
                                    },
                                },
                            },
                        },
                    }
                },
            },
            "responses": {
                "200": {
                    "description": "JSON-RPC response for non-streaming methods. For `message/stream`, the response is an SSE stream of JSON-RPC envelopes.",
                    "content": {
                        "application/json": {
                            "schema": {
                                "type": "object",
                                "properties": {
                                    "jsonrpc": {"type": "string", "enum": ["2.0"]},
                                    "id": {"type": "string"},
                                    "result": {
                                        "type": "object",
                                        "description": "Success result containing task information",
                                    },
                                    "error": {
                                        "type": "object",
                                        "properties": {
                                            "code": {"type": "integer"},
                                            "message": {"type": "string"},
                                        },
                                        "description": "Error information if request failed",
                                    },
                                },
                                "required": ["jsonrpc", "id"],
                            },
                            "example": {
                                "jsonrpc": "2.0",
                                "id": "1",
                                "result": {
                                    "kind": "task",
                                    "id": "thread-uuid:run-uuid",
                                    "contextId": "thread-uuid",
                                    "status": {"state": "completed"},
                                    "artifacts": [
                                        {
                                            "artifactId": "artifact-uuid",
                                            "name": "Assistant Response",
                                            "parts": [
                                                {"kind": "text", "text": "Hello back!"}
                                            ],
                                        }
                                    ],
                                },
                            },
                        },
                        "text/event-stream": {
                            "schema": {
                                "type": "string",
                                "description": "SSE stream of JSON-RPC response objects.",
                            },
                        },
                    },
                },
                "400": {
                    "description": "Bad Request (invalid JSON-RPC, invalid params, or missing Accept header)"
                },
                "401": {"description": "Unauthorized"},
                "404": {"description": "Assistant not found"},
                "500": {"description": "Internal server error"},
            },
        },
    },
}


def get_openapi_spec() -> dict[str, Any]:
    """Generate the complete OpenAPI specification.

    Returns:
        Complete OpenAPI 3.1.0 specification as a dictionary.
    """
    return {
        "openapi": "3.1.0",
        "info": {
            "title": API_TITLE,
            "version": API_VERSION,
            "description": API_DESCRIPTION,
        },
        "tags": TAGS,
        "paths": PATHS,
        "components": COMPONENTS,
    }
