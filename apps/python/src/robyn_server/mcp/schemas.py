"""MCP Protocol Pydantic schemas.

JSON-RPC 2.0 request/response models and MCP-specific types
for the Model Context Protocol implementation.
"""

from enum import IntEnum
from typing import Any, Literal

from pydantic import BaseModel, Field


# ============================================================================
# JSON-RPC 2.0 Error Codes
# ============================================================================


class JsonRpcErrorCode(IntEnum):
    """Standard JSON-RPC 2.0 error codes."""

    PARSE_ERROR = -32700
    INVALID_REQUEST = -32600
    METHOD_NOT_FOUND = -32601
    INVALID_PARAMS = -32602
    INTERNAL_ERROR = -32603


# ============================================================================
# JSON-RPC 2.0 Base Models
# ============================================================================


class JsonRpcRequest(BaseModel):
    """JSON-RPC 2.0 request object."""

    jsonrpc: Literal["2.0"] = "2.0"
    id: str | int | None = None
    method: str
    params: dict[str, Any] | None = None


class JsonRpcError(BaseModel):
    """JSON-RPC 2.0 error object."""

    code: int
    message: str
    data: Any | None = None


class JsonRpcResponse(BaseModel):
    """JSON-RPC 2.0 response object."""

    jsonrpc: Literal["2.0"] = "2.0"
    id: str | int | None = None
    result: Any | None = None
    error: JsonRpcError | None = None

    def model_dump(self, **kwargs) -> dict[str, Any]:
        """Custom dump to exclude None result/error based on which is set."""
        data = {"jsonrpc": self.jsonrpc, "id": self.id}
        if self.error is not None:
            data["error"] = self.error.model_dump()
        else:
            data["result"] = self.result
        return data


# ============================================================================
# MCP Protocol Types
# ============================================================================


class McpClientInfo(BaseModel):
    """MCP client information sent during initialization."""

    name: str
    version: str


class McpCapabilities(BaseModel):
    """MCP server/client capabilities."""

    tools: dict[str, Any] | None = None
    prompts: dict[str, Any] | None = None
    resources: dict[str, Any] | None = None
    logging: dict[str, Any] | None = None


class McpServerInfo(BaseModel):
    """MCP server information returned during initialization."""

    name: str = "oap-langgraph-agent"
    version: str = "0.1.0"


class McpInitializeParams(BaseModel):
    """Parameters for the initialize method."""

    client_info: McpClientInfo = Field(alias="clientInfo")
    protocol_version: str = Field(alias="protocolVersion")
    capabilities: McpCapabilities | None = None

    model_config = {"populate_by_name": True}


class McpInitializeResult(BaseModel):
    """Result of the initialize method."""

    protocol_version: str = Field(default="2025-03-26", alias="protocolVersion")
    server_info: McpServerInfo = Field(
        default_factory=McpServerInfo, alias="serverInfo"
    )
    capabilities: McpCapabilities = Field(default_factory=McpCapabilities)

    model_config = {"populate_by_name": True, "by_alias": True}


# ============================================================================
# MCP Tool Types
# ============================================================================


class McpToolInputSchema(BaseModel):
    """JSON Schema for tool input."""

    type: Literal["object"] = "object"
    properties: dict[str, Any] = Field(default_factory=dict)
    required: list[str] = Field(default_factory=list)


class McpTool(BaseModel):
    """MCP tool definition."""

    name: str
    description: str
    input_schema: McpToolInputSchema = Field(alias="inputSchema")

    model_config = {"populate_by_name": True, "by_alias": True}


class McpToolsListResult(BaseModel):
    """Result of tools/list method."""

    tools: list[McpTool]


class McpToolCallParams(BaseModel):
    """Parameters for tools/call method."""

    name: str
    arguments: dict[str, Any] = Field(default_factory=dict)


class McpToolCallContentItem(BaseModel):
    """Content item in tool call result."""

    type: Literal["text", "image", "resource"] = "text"
    text: str | None = None
    data: str | None = None
    mime_type: str | None = Field(default=None, alias="mimeType")

    model_config = {"populate_by_name": True, "by_alias": True}


class McpToolCallResult(BaseModel):
    """Result of tools/call method."""

    content: list[McpToolCallContentItem]
    is_error: bool = Field(default=False, alias="isError")

    model_config = {"populate_by_name": True, "by_alias": True}


# ============================================================================
# Helper Functions
# ============================================================================


def create_error_response(
    request_id: str | int | None,
    code: int,
    message: str,
    data: Any | None = None,
) -> JsonRpcResponse:
    """Create a JSON-RPC error response."""
    return JsonRpcResponse(
        id=request_id,
        error=JsonRpcError(code=code, message=message, data=data),
    )


def create_success_response(
    request_id: str | int | None,
    result: Any,
) -> JsonRpcResponse:
    """Create a JSON-RPC success response."""
    return JsonRpcResponse(id=request_id, result=result)
