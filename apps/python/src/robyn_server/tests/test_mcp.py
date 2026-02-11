"""Tests for MCP Protocol endpoints.

Tests the JSON-RPC 2.0 based MCP (Model Context Protocol) implementation.
"""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from robyn_server.mcp import (
    JsonRpcErrorCode,
    JsonRpcRequest,
    McpCapabilities,
    McpInitializeParams,
    McpInitializeResult,
    McpServerInfo,
    McpTool,
    McpToolCallContentItem,
    McpToolCallParams,
    McpToolCallResult,
    McpToolInputSchema,
    McpToolsListResult,
    create_error_response,
    create_success_response,
    mcp_handler,
)
from robyn_server.mcp.handlers import PROTOCOL_VERSION, McpMethodHandler


# ============================================================================
# Schema Tests
# ============================================================================


class TestJsonRpcSchemas:
    """Tests for JSON-RPC 2.0 schema models."""

    def test_json_rpc_request_minimal(self):
        """Test minimal JSON-RPC request."""
        request = JsonRpcRequest(method="ping")
        assert request.jsonrpc == "2.0"
        assert request.method == "ping"
        assert request.id is None
        assert request.params is None

    def test_json_rpc_request_full(self):
        """Test full JSON-RPC request with all fields."""
        request = JsonRpcRequest(
            jsonrpc="2.0",
            id="123",
            method="tools/call",
            params={"name": "test", "arguments": {}},
        )
        assert request.jsonrpc == "2.0"
        assert request.id == "123"
        assert request.method == "tools/call"
        assert request.params == {"name": "test", "arguments": {}}

    def test_json_rpc_request_integer_id(self):
        """Test JSON-RPC request with integer ID."""
        request = JsonRpcRequest(id=42, method="test")
        assert request.id == 42

    def test_json_rpc_response_success(self):
        """Test successful JSON-RPC response."""
        response = create_success_response("1", {"status": "ok"})
        assert response.jsonrpc == "2.0"
        assert response.id == "1"
        assert response.result == {"status": "ok"}
        assert response.error is None

    def test_json_rpc_response_error(self):
        """Test error JSON-RPC response."""
        response = create_error_response("1", -32600, "Invalid Request")
        assert response.jsonrpc == "2.0"
        assert response.id == "1"
        assert response.result is None
        assert response.error is not None
        assert response.error.code == -32600
        assert response.error.message == "Invalid Request"

    def test_json_rpc_response_model_dump_success(self):
        """Test model_dump excludes error for success response."""
        response = create_success_response("1", {"data": "test"})
        dumped = response.model_dump()
        assert "result" in dumped
        assert "error" not in dumped
        assert dumped["result"] == {"data": "test"}

    def test_json_rpc_response_model_dump_error(self):
        """Test model_dump excludes result for error response."""
        response = create_error_response("1", -32600, "Invalid")
        dumped = response.model_dump()
        assert "error" in dumped
        assert dumped.get("result") is None or "result" not in dumped


class TestMcpSchemas:
    """Tests for MCP-specific schema models."""

    def test_mcp_initialize_params(self):
        """Test MCP initialize parameters parsing."""
        params = McpInitializeParams.model_validate(
            {
                "clientInfo": {"name": "test_client", "version": "1.0.0"},
                "protocolVersion": "2024-11-05",
                "capabilities": {},
            }
        )
        assert params.client_info.name == "test_client"
        assert params.client_info.version == "1.0.0"
        assert params.protocol_version == "2024-11-05"

    def test_mcp_initialize_result(self):
        """Test MCP initialize result."""
        result = McpInitializeResult(
            protocol_version="2025-03-26",
            server_info=McpServerInfo(name="test", version="0.1.0"),
            capabilities=McpCapabilities(tools={}),
        )
        dumped = result.model_dump(by_alias=True)
        assert dumped["protocolVersion"] == "2025-03-26"
        assert dumped["serverInfo"]["name"] == "test"
        assert "tools" in dumped["capabilities"]

    def test_mcp_initialize_result_default_protocol_version(self):
        """Test that the default protocol version is 2025-03-26."""
        result = McpInitializeResult()
        dumped = result.model_dump(by_alias=True)
        assert dumped["protocolVersion"] == "2025-03-26"

    def test_mcp_tool(self):
        """Test MCP tool definition."""
        tool = McpTool(
            name="test_tool",
            description="A test tool",
            input_schema=McpToolInputSchema(
                type="object",
                properties={"arg1": {"type": "string"}},
                required=["arg1"],
            ),
        )
        dumped = tool.model_dump(by_alias=True)
        assert dumped["name"] == "test_tool"
        assert dumped["inputSchema"]["type"] == "object"
        assert "arg1" in dumped["inputSchema"]["properties"]

    def test_mcp_tools_list_result(self):
        """Test tools list result."""
        result = McpToolsListResult(
            tools=[
                McpTool(
                    name="tool1",
                    description="Tool 1",
                    input_schema=McpToolInputSchema(),
                )
            ]
        )
        assert len(result.tools) == 1
        assert result.tools[0].name == "tool1"

    def test_mcp_tool_call_params(self):
        """Test tool call parameters."""
        params = McpToolCallParams(
            name="langgraph_agent", arguments={"message": "Hello"}
        )
        assert params.name == "langgraph_agent"
        assert params.arguments["message"] == "Hello"

    def test_mcp_tool_call_result_success(self):
        """Test successful tool call result."""
        result = McpToolCallResult(
            content=[McpToolCallContentItem(type="text", text="Response")],
            is_error=False,
        )
        dumped = result.model_dump(by_alias=True)
        assert dumped["isError"] is False
        assert len(dumped["content"]) == 1
        assert dumped["content"][0]["text"] == "Response"

    def test_mcp_tool_call_result_error(self):
        """Test error tool call result."""
        result = McpToolCallResult(
            content=[
                McpToolCallContentItem(type="text", text="Error: something failed")
            ],
            is_error=True,
        )
        dumped = result.model_dump(by_alias=True)
        assert dumped["isError"] is True


# ============================================================================
# Handler Tests
# ============================================================================


class TestMcpHandler:
    """Tests for MCP method handler."""

    @pytest.mark.asyncio
    async def test_handle_ping(self):
        """Test ping method."""
        request = JsonRpcRequest(id="1", method="ping")
        response = await mcp_handler.handle_request(request)
        assert response.error is None
        assert response.result == {}

    @pytest.mark.asyncio
    async def test_handle_initialize(self):
        """Test initialize method returns 2025-03-26 protocol version."""
        request = JsonRpcRequest(
            id="1",
            method="initialize",
            params={
                "clientInfo": {"name": "test", "version": "1.0"},
                "protocolVersion": "2024-11-05",
            },
        )
        response = await mcp_handler.handle_request(request)
        assert response.error is None
        assert response.result["protocolVersion"] == "2025-03-26"
        assert "serverInfo" in response.result
        assert "capabilities" in response.result

    @pytest.mark.asyncio
    async def test_handle_initialized(self):
        """Test initialized notification."""
        request = JsonRpcRequest(method="initialized", params={})
        response = await mcp_handler.handle_request(request)
        assert response.error is None
        assert response.result == {}

    @pytest.mark.asyncio
    async def test_handle_tools_list(self):
        """Test tools/list method."""
        request = JsonRpcRequest(id="1", method="tools/list")
        response = await mcp_handler.handle_request(request)
        assert response.error is None
        assert "tools" in response.result
        assert len(response.result["tools"]) > 0
        # Check the langgraph_agent tool exists
        tool_names = [t["name"] for t in response.result["tools"]]
        assert "langgraph_agent" in tool_names

    @pytest.mark.asyncio
    async def test_handle_tools_call_missing_message(self):
        """Test tools/call with missing required argument."""
        request = JsonRpcRequest(
            id="1",
            method="tools/call",
            params={"name": "langgraph_agent", "arguments": {}},
        )
        response = await mcp_handler.handle_request(request)
        assert response.error is not None
        assert response.error.code == JsonRpcErrorCode.INVALID_PARAMS

    @pytest.mark.asyncio
    async def test_handle_tools_call_unknown_tool(self):
        """Test tools/call with unknown tool name."""
        request = JsonRpcRequest(
            id="1",
            method="tools/call",
            params={"name": "unknown_tool", "arguments": {"message": "test"}},
        )
        response = await mcp_handler.handle_request(request)
        assert response.error is not None
        assert response.error.code == JsonRpcErrorCode.INVALID_PARAMS

    @pytest.mark.asyncio
    async def test_handle_tools_call_langgraph_agent(self):
        """Test tools/call with langgraph_agent tool."""
        request = JsonRpcRequest(
            id="1",
            method="tools/call",
            params={
                "name": "langgraph_agent",
                "arguments": {"message": "Hello, agent!"},
            },
        )
        response = await mcp_handler.handle_request(request)
        # The agent execution might fail (no agent configured), but we should
        # still get a valid MCP response structure
        assert response.id == "1"
        if response.error is None:
            assert "content" in response.result
            assert "isError" in response.result

    @pytest.mark.asyncio
    async def test_handle_prompts_list(self):
        """Test prompts/list method (returns empty)."""
        request = JsonRpcRequest(id="1", method="prompts/list")
        response = await mcp_handler.handle_request(request)
        assert response.error is None
        assert response.result == {"prompts": []}

    @pytest.mark.asyncio
    async def test_handle_resources_list(self):
        """Test resources/list method (returns empty)."""
        request = JsonRpcRequest(id="1", method="resources/list")
        response = await mcp_handler.handle_request(request)
        assert response.error is None
        assert response.result == {"resources": []}

    @pytest.mark.asyncio
    async def test_handle_unknown_method(self):
        """Test unknown method returns method not found error."""
        request = JsonRpcRequest(id="1", method="unknown/method")
        response = await mcp_handler.handle_request(request)
        assert response.error is not None
        assert response.error.code == JsonRpcErrorCode.METHOD_NOT_FOUND

    @pytest.mark.asyncio
    async def test_handle_notification_no_id(self):
        """Test that notifications (no id) still work."""
        request = JsonRpcRequest(method="ping")  # No id = notification
        response = await mcp_handler.handle_request(request)
        assert response.id is None
        assert response.error is None


# ============================================================================
# Protocol Version Tests
# ============================================================================


class TestProtocolVersion:
    """Tests for MCP protocol version constant."""

    def test_protocol_version_is_2025_03_26(self):
        """Verify PROTOCOL_VERSION constant is set to 2025-03-26."""
        assert PROTOCOL_VERSION == "2025-03-26"


# ============================================================================
# Dynamic Tool Listing Tests
# ============================================================================


class TestDynamicToolListing:
    """Tests for dynamic tool listing in MCP handler."""

    @pytest.mark.asyncio
    async def test_tools_list_always_includes_langgraph_agent(self):
        """Tool list always contains the langgraph_agent tool."""
        handler = McpMethodHandler()
        request = JsonRpcRequest(id="1", method="tools/list")
        response = await handler.handle_request(request)
        assert response.error is None
        tool_names = [t["name"] for t in response.result["tools"]]
        assert "langgraph_agent" in tool_names

    @pytest.mark.asyncio
    async def test_tools_list_has_required_input_schema(self):
        """The langgraph_agent tool has 'message' as required input."""
        handler = McpMethodHandler()
        request = JsonRpcRequest(id="1", method="tools/list")
        response = await handler.handle_request(request)
        assert response.error is None
        agent_tool = response.result["tools"][0]
        assert agent_tool["name"] == "langgraph_agent"
        assert "message" in agent_tool["inputSchema"]["properties"]
        assert "message" in agent_tool["inputSchema"]["required"]

    @pytest.mark.asyncio
    async def test_tools_list_includes_optional_params(self):
        """The langgraph_agent tool exposes thread_id and assistant_id."""
        handler = McpMethodHandler()
        request = JsonRpcRequest(id="1", method="tools/list")
        response = await handler.handle_request(request)
        agent_tool = response.result["tools"][0]
        properties = agent_tool["inputSchema"]["properties"]
        assert "thread_id" in properties
        assert "assistant_id" in properties

    @pytest.mark.asyncio
    async def test_dynamic_description_with_mcp_tools(self):
        """Description includes sub-tool names when agent has MCP tools."""
        from robyn_server.mcp.handlers import _build_tool_description

        tool_info = {
            "mcp_tools": ["Math_Add", "Math_Multiply"],
            "mcp_url": "http://math-service/mcp",
            "rag_collections": [],
            "rag_url": None,
            "model_name": "openai:gpt-4o",
        }
        description = _build_tool_description(tool_info)
        assert "Math_Add" in description
        assert "Math_Multiply" in description
        assert "gpt-4o" in description

    @pytest.mark.asyncio
    async def test_dynamic_description_with_rag_collections(self):
        """Description mentions RAG collection count when configured."""
        from robyn_server.mcp.handlers import _build_tool_description

        tool_info = {
            "mcp_tools": [],
            "mcp_url": None,
            "rag_collections": ["uuid-1", "uuid-2", "uuid-3"],
            "rag_url": "http://rag/api",
            "model_name": None,
        }
        description = _build_tool_description(tool_info)
        assert "3 collection(s)" in description

    @pytest.mark.asyncio
    async def test_dynamic_description_empty_config(self):
        """Description is base description when no tools are configured."""
        from robyn_server.mcp.handlers import (
            _BASE_TOOL_DESCRIPTION,
            _build_tool_description,
        )

        tool_info = {
            "mcp_tools": [],
            "mcp_url": None,
            "rag_collections": [],
            "rag_url": None,
            "model_name": None,
        }
        description = _build_tool_description(tool_info)
        assert description == _BASE_TOOL_DESCRIPTION

    @pytest.mark.asyncio
    async def test_get_dynamic_agent_tool_fallback_on_error(self):
        """Falls back to base description when introspection fails."""
        from robyn_server.mcp.handlers import _BASE_TOOL_DESCRIPTION

        handler = McpMethodHandler()
        # Patch at the source module so the lazy import inside
        # _get_dynamic_agent_tool picks up the mock.
        with patch(
            "robyn_server.agent.get_agent_tool_info",
            new_callable=AsyncMock,
            side_effect=RuntimeError("storage not available"),
        ):
            tool = await handler._get_dynamic_agent_tool()

        assert tool.name == "langgraph_agent"
        assert tool.description == _BASE_TOOL_DESCRIPTION


# ============================================================================
# Agent Execution Wiring Tests
# ============================================================================


class TestAgentExecutionWiring:
    """Tests for _execute_agent wiring to robyn_server.agent."""

    @pytest.mark.asyncio
    async def test_execute_agent_calls_execute_agent_run(self):
        """_execute_agent delegates to robyn_server.agent.execute_agent_run."""
        handler = McpMethodHandler()
        mock_result = "Hello from the agent!"

        with patch(
            "robyn_server.agent.execute_agent_run",
            new_callable=AsyncMock,
            return_value=mock_result,
        ):
            result = await handler._execute_agent(
                message="test message",
                thread_id="thread-123",
                assistant_id="agent",
            )

        assert result == "Hello from the agent!"

    @pytest.mark.asyncio
    async def test_execute_agent_passes_arguments(self):
        """_execute_agent passes all arguments to execute_agent_run."""
        handler = McpMethodHandler()

        with patch(
            "robyn_server.agent.execute_agent_run",
            new_callable=AsyncMock,
            return_value="ok",
        ) as mock_run:
            await handler._execute_agent(
                message="hello",
                thread_id="tid-1",
                assistant_id="custom-agent",
            )

        mock_run.assert_awaited_once_with(
            message="hello",
            thread_id="tid-1",
            assistant_id="custom-agent",
        )

    @pytest.mark.asyncio
    async def test_execute_agent_propagates_errors(self):
        """_execute_agent lets exceptions propagate (no placeholder fallback)."""
        handler = McpMethodHandler()

        with patch(
            "robyn_server.agent.execute_agent_run",
            new_callable=AsyncMock,
            side_effect=RuntimeError("LLM not configured"),
        ):
            with pytest.raises(RuntimeError, match="LLM not configured"):
                await handler._execute_agent(message="test")

    @pytest.mark.asyncio
    async def test_tools_call_returns_agent_response(self):
        """Full tools/call flow returns agent response as MCP content."""
        handler = McpMethodHandler()

        with patch(
            "robyn_server.agent.execute_agent_run",
            new_callable=AsyncMock,
            return_value="The answer is 42.",
        ):
            request = JsonRpcRequest(
                id="call-1",
                method="tools/call",
                params={
                    "name": "langgraph_agent",
                    "arguments": {"message": "What is the meaning of life?"},
                },
            )
            response = await handler.handle_request(request)

        assert response.error is None
        assert response.result["isError"] is False
        assert response.result["content"][0]["text"] == "The answer is 42."

    @pytest.mark.asyncio
    async def test_tools_call_returns_error_on_agent_failure(self):
        """tools/call returns isError=true when agent execution fails."""
        handler = McpMethodHandler()

        with patch(
            "robyn_server.agent.execute_agent_run",
            new_callable=AsyncMock,
            side_effect=RuntimeError("Model unavailable"),
        ):
            request = JsonRpcRequest(
                id="call-2",
                method="tools/call",
                params={
                    "name": "langgraph_agent",
                    "arguments": {"message": "test"},
                },
            )
            response = await handler.handle_request(request)

        assert response.error is None  # JSON-RPC level is success
        assert response.result["isError"] is True
        assert "Model unavailable" in response.result["content"][0]["text"]

    @pytest.mark.asyncio
    async def test_tools_call_with_thread_id_and_assistant_id(self):
        """tools/call passes thread_id and assistant_id to execute_agent_run."""
        handler = McpMethodHandler()

        with patch(
            "robyn_server.agent.execute_agent_run",
            new_callable=AsyncMock,
            return_value="response",
        ) as mock_run:
            request = JsonRpcRequest(
                id="call-3",
                method="tools/call",
                params={
                    "name": "langgraph_agent",
                    "arguments": {
                        "message": "hello",
                        "thread_id": "t-abc",
                        "assistant_id": "my-assistant",
                    },
                },
            )
            await handler.handle_request(request)

        mock_run.assert_awaited_once_with(
            message="hello",
            thread_id="t-abc",
            assistant_id="my-assistant",
        )


# ============================================================================
# Agent Module Tests
# ============================================================================


class TestAgentModule:
    """Tests for robyn_server.agent module functions."""

    @pytest.mark.asyncio
    async def test_extract_response_text_ai_message(self):
        """Extracts content from the last AIMessage in the result."""
        from langchain_core.messages import AIMessage, HumanMessage

        from robyn_server.agent import _extract_response_text

        result = {
            "messages": [
                HumanMessage(content="What is 2+2?", id="h1"),
                AIMessage(content="The answer is 4.", id="a1"),
            ]
        }
        assert _extract_response_text(result) == "The answer is 4."

    @pytest.mark.asyncio
    async def test_extract_response_text_multiple_ai_messages(self):
        """Returns the LAST AI message when multiple exist."""
        from langchain_core.messages import AIMessage, HumanMessage

        from robyn_server.agent import _extract_response_text

        result = {
            "messages": [
                HumanMessage(content="Q1", id="h1"),
                AIMessage(content="First answer", id="a1"),
                HumanMessage(content="Q2", id="h2"),
                AIMessage(content="Second answer", id="a2"),
            ]
        }
        assert _extract_response_text(result) == "Second answer"

    @pytest.mark.asyncio
    async def test_extract_response_text_dict_message(self):
        """Extracts content from dict-format AI messages."""
        from robyn_server.agent import _extract_response_text

        result = {
            "messages": [
                {"type": "human", "content": "hello"},
                {"type": "ai", "content": "hi there"},
            ]
        }
        assert _extract_response_text(result) == "hi there"

    @pytest.mark.asyncio
    async def test_extract_response_text_no_messages(self):
        """Returns JSON fallback when no messages are present."""
        from robyn_server.agent import _extract_response_text

        result = {"messages": []}
        text = _extract_response_text(result)
        assert "messages" in text  # JSON serialized

    @pytest.mark.asyncio
    async def test_build_mcp_runnable_config(self):
        """Builds a RunnableConfig with merged assistant + runtime fields."""
        from robyn_server.agent import _build_mcp_runnable_config

        assistant_config = {"configurable": {"model_name": "openai:gpt-4o"}}
        config = _build_mcp_runnable_config(
            thread_id="t-1",
            assistant_id="agent",
            assistant_config=assistant_config,
            owner_id="mcp-client",
        )
        assert config["configurable"]["thread_id"] == "t-1"
        assert config["configurable"]["assistant_id"] == "agent"
        assert config["configurable"]["owner"] == "mcp-client"
        assert config["configurable"]["model_name"] == "openai:gpt-4o"
        assert "run_id" in config["configurable"]

    @pytest.mark.asyncio
    async def test_build_mcp_runnable_config_no_assistant(self):
        """Builds config correctly when assistant_config is None."""
        from robyn_server.agent import _build_mcp_runnable_config

        config = _build_mcp_runnable_config(
            thread_id="t-2",
            assistant_id="agent",
            assistant_config=None,
            owner_id="test-user",
        )
        assert config["configurable"]["thread_id"] == "t-2"
        assert config["configurable"]["owner"] == "test-user"
        assert "assistant" not in config["configurable"]

    @pytest.mark.asyncio
    async def test_get_agent_tool_info_no_assistant(self):
        """Returns empty defaults when no assistant is found in storage."""
        from robyn_server.agent import get_agent_tool_info

        mock_storage = MagicMock()
        mock_storage.assistants.get = AsyncMock(return_value=None)
        mock_storage.assistants.list = AsyncMock(return_value=[])

        # Patch at the source module so the lazy import inside
        # get_agent_tool_info picks up the mock.
        with patch("robyn_server.storage.get_storage", return_value=mock_storage):
            info = await get_agent_tool_info()

        assert info["mcp_tools"] == []
        assert info["rag_collections"] == []
        assert info["model_name"] is None

    @pytest.mark.asyncio
    async def test_get_agent_tool_info_with_assistant(self):
        """Extracts tool info from assistant config."""
        from robyn_server.agent import get_agent_tool_info

        mock_assistant = MagicMock()
        mock_assistant.graph_id = "agent"
        mock_assistant.config = {
            "configurable": {
                "model_name": "anthropic:claude-sonnet-4-0",
                "mcp_config": {
                    "servers": [
                        {
                            "name": "math",
                            "url": "http://math-svc/api",
                            "tools": ["Math_Add", "Math_Sub"],
                            "auth_required": False,
                        },
                    ],
                },
                "rag": {
                    "rag_url": "http://rag/api",
                    "collections": ["col-uuid-1"],
                },
            }
        }

        mock_storage = MagicMock()
        mock_storage.assistants.get = AsyncMock(return_value=mock_assistant)

        with patch("robyn_server.storage.get_storage", return_value=mock_storage):
            info = await get_agent_tool_info()

        assert info["model_name"] == "anthropic:claude-sonnet-4-0"
        assert info["mcp_tools"] == sorted(["Math_Add", "Math_Sub"])
        assert info["mcp_url"] == "http://math-svc/api"
        assert info["rag_collections"] == ["col-uuid-1"]
        assert info["rag_url"] == "http://rag/api"


# ============================================================================
# Integration Tests (Route-level)
# ============================================================================


class TestMcpRoutes:
    """Integration tests for MCP HTTP routes.

    These tests require a running test client.
    """

    @pytest.fixture
    def mcp_request_body(self):
        """Create a valid MCP request body."""
        return {
            "jsonrpc": "2.0",
            "id": "test-1",
            "method": "initialize",
            "params": {
                "clientInfo": {"name": "pytest", "version": "1.0.0"},
                "protocolVersion": "2024-11-05",
                "capabilities": {},
            },
        }

    def test_mcp_request_body_structure(self, mcp_request_body):
        """Test that fixture creates valid request body."""
        assert mcp_request_body["jsonrpc"] == "2.0"
        assert mcp_request_body["method"] == "initialize"

    def test_json_rpc_request_from_dict(self, mcp_request_body):
        """Test parsing request body into JsonRpcRequest."""
        request = JsonRpcRequest.model_validate(mcp_request_body)
        assert request.jsonrpc == "2.0"
        assert request.id == "test-1"
        assert request.method == "initialize"


# ============================================================================
# Error Code Tests
# ============================================================================


class TestJsonRpcErrorCodes:
    """Tests for JSON-RPC error codes."""

    def test_error_codes_values(self):
        """Test that error codes have correct values."""
        assert JsonRpcErrorCode.PARSE_ERROR == -32700
        assert JsonRpcErrorCode.INVALID_REQUEST == -32600
        assert JsonRpcErrorCode.METHOD_NOT_FOUND == -32601
        assert JsonRpcErrorCode.INVALID_PARAMS == -32602
        assert JsonRpcErrorCode.INTERNAL_ERROR == -32603

    def test_create_parse_error(self):
        """Test creating a parse error response."""
        response = create_error_response(
            None, JsonRpcErrorCode.PARSE_ERROR, "Invalid JSON"
        )
        assert response.error.code == -32700

    def test_create_method_not_found_error(self):
        """Test creating a method not found error."""
        response = create_error_response(
            "1", JsonRpcErrorCode.METHOD_NOT_FOUND, "Method not found: foo"
        )
        assert response.error.code == -32601
        assert "foo" in response.error.message
