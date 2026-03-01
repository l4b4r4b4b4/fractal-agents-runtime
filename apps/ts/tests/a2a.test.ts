/**
 * Unit tests for the A2A (Agent-to-Agent) protocol module.
 *
 * Covers:
 *   - JSON-RPC 2.0 schema helpers (createErrorResponse, createSuccessResponse)
 *   - Task ID helpers (parseTaskId, createTaskId)
 *   - Run status mapping (mapRunStatusToTaskState)
 *   - Message part extraction (extractTextFromParts, extractDataFromParts, hasFileParts)
 *   - JSON-RPC request parsing (parseJsonRpcRequest)
 *   - Message param parsing (parseMessageSendParams)
 *   - Task param parsing (parseTaskGetParams, parseTaskCancelParams)
 *   - A2AMethodHandler routing and method handling
 *   - ValueError distinction from internal errors
 *
 * Reference: apps/python/src/server/a2a/schemas.py
 * Reference: apps/python/src/server/a2a/handlers.py
 * Reference: apps/python/src/server/tests/test_a2a.py
 */

import { describe, it, expect, beforeEach } from "bun:test";

// Schemas — constants and helpers
import {
  JsonRpcErrorCode,
  createErrorResponse,
  createSuccessResponse,
  parseTaskId,
  createTaskId,
  mapRunStatusToTaskState,
  extractTextFromParts,
  extractDataFromParts,
  hasFileParts,
  parseJsonRpcRequest,
  parseMessageSendParams,
  parseTaskGetParams,
  parseTaskCancelParams,
} from "../src/a2a/schemas";

// Handlers
import { A2AMethodHandler, ValueError } from "../src/a2a/handlers";

import type {
  JsonRpcRequest,
  JsonRpcResponse,
  MessagePart,
  TextPart,
  DataPart,
  FilePart,
  TaskState,
  A2AStorage,
} from "../src/a2a";

// ===========================================================================
// Mock storage factory
// ===========================================================================

/**
 * Create a minimal mock A2AStorage for testing the handler.
 *
 * Stores assistants, threads, and runs in plain Maps so tests can
 * inspect and manipulate state without a real database.
 */
function createMockStorage(): A2AStorage & {
  _assistants: Map<string, Record<string, unknown>>;
  _threads: Map<string, Record<string, unknown>>;
  _runs: Map<string, Record<string, unknown>>;
} {
  const assistants = new Map<string, Record<string, unknown>>();
  const threads = new Map<string, Record<string, unknown>>();
  const runs = new Map<string, Record<string, unknown>>();

  return {
    _assistants: assistants,
    _threads: threads,
    _runs: runs,
    assistants: {
      get(id: string, _ownerId: string) {
        return assistants.get(id) ?? null;
      },
      list(_ownerId: string) {
        return Array.from(assistants.values());
      },
    },
    threads: {
      get(id: string, _ownerId: string) {
        return threads.get(id) ?? null;
      },
      create(metadata: Record<string, unknown>, _ownerId: string) {
        const threadId = crypto.randomUUID();
        const thread = { thread_id: threadId, ...metadata };
        threads.set(threadId, thread);
        return thread;
      },
    },
    runs: {
      get(id: string, _ownerId: string) {
        return runs.get(id) ?? null;
      },
      create(data: Record<string, unknown>, _ownerId: string) {
        const runId = crypto.randomUUID();
        const run = { run_id: runId, ...data };
        runs.set(runId, run);
        return run;
      },
    },
  };
}

// ===========================================================================
// JsonRpcErrorCode constants
// ===========================================================================

describe("JsonRpcErrorCode", () => {
  it("has standard JSON-RPC 2.0 error codes", () => {
    expect(JsonRpcErrorCode.PARSE_ERROR).toBe(-32700);
    expect(JsonRpcErrorCode.INVALID_REQUEST).toBe(-32600);
    expect(JsonRpcErrorCode.METHOD_NOT_FOUND).toBe(-32601);
    expect(JsonRpcErrorCode.INVALID_PARAMS).toBe(-32602);
    expect(JsonRpcErrorCode.INTERNAL_ERROR).toBe(-32603);
  });

  it("has A2A-specific error codes", () => {
    expect(JsonRpcErrorCode.TASK_NOT_FOUND).toBe(-32001);
    expect(JsonRpcErrorCode.TASK_NOT_CANCELABLE).toBe(-32002);
    expect(JsonRpcErrorCode.UNSUPPORTED_OPERATION).toBe(-32003);
    expect(JsonRpcErrorCode.INVALID_PART_TYPE).toBe(-32004);
  });
});

// ===========================================================================
// createErrorResponse
// ===========================================================================

describe("createErrorResponse", () => {
  it("creates error response with string id", () => {
    const response = createErrorResponse("req-1", -32600, "Bad request");
    expect(response.jsonrpc).toBe("2.0");
    expect(response.id).toBe("req-1");
    expect(response.error).toBeDefined();
    expect(response.error!.code).toBe(-32600);
    expect(response.error!.message).toBe("Bad request");
    expect(response.result).toBeUndefined();
  });

  it("creates error response with numeric id", () => {
    const response = createErrorResponse(42, -32700, "Parse error");
    expect(response.id).toBe(42);
    expect(response.error!.code).toBe(-32700);
  });

  it("creates error response with null id (parse errors)", () => {
    const response = createErrorResponse(null, -32700, "Invalid JSON");
    expect(response.id).toBeNull();
    expect(response.error!.code).toBe(-32700);
  });

  it("includes optional data field when provided", () => {
    const response = createErrorResponse(
      "req-1",
      -32603,
      "Internal error",
      { details: "stack trace" },
    );
    expect(response.error!.data).toEqual({ details: "stack trace" });
  });

  it("omits data field when not provided", () => {
    const response = createErrorResponse("req-1", -32603, "Error");
    expect(response.error!.data).toBeUndefined();
  });
});

// ===========================================================================
// createSuccessResponse
// ===========================================================================

describe("createSuccessResponse", () => {
  it("creates success response with object result", () => {
    const response = createSuccessResponse("req-1", { status: "ok" });
    expect(response.jsonrpc).toBe("2.0");
    expect(response.id).toBe("req-1");
    expect(response.result).toEqual({ status: "ok" });
    expect(response.error).toBeUndefined();
  });

  it("creates success response with string result", () => {
    const response = createSuccessResponse("req-1", "done");
    expect(response.result).toBe("done");
  });

  it("creates success response with null result", () => {
    const response = createSuccessResponse("req-1", null);
    expect(response.result).toBeNull();
  });

  it("creates success response with numeric id", () => {
    const response = createSuccessResponse(99, { data: true });
    expect(response.id).toBe(99);
  });

  it("creates success response with null id", () => {
    const response = createSuccessResponse(null, "result");
    expect(response.id).toBeNull();
  });
});

// ===========================================================================
// parseTaskId
// ===========================================================================

describe("parseTaskId", () => {
  it("parses valid task ID into thread_id and run_id", () => {
    const [threadId, runId] = parseTaskId("thread-abc:run-123");
    expect(threadId).toBe("thread-abc");
    expect(runId).toBe("run-123");
  });

  it("handles UUIDs in task ID", () => {
    const tid = "550e8400-e29b-41d4-a716-446655440000";
    const rid = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
    const [threadId, runId] = parseTaskId(`${tid}:${rid}`);
    expect(threadId).toBe(tid);
    expect(runId).toBe(rid);
  });

  it("handles multiple colons (only splits on first)", () => {
    const [threadId, runId] = parseTaskId("thread:run:extra:colons");
    expect(threadId).toBe("thread");
    expect(runId).toBe("run:extra:colons");
  });

  it("throws on task ID without colon", () => {
    expect(() => parseTaskId("no-colon-here")).toThrow(
      "Invalid task ID format",
    );
  });

  it("throws on empty string", () => {
    expect(() => parseTaskId("")).toThrow("Invalid task ID format");
  });
});

// ===========================================================================
// createTaskId
// ===========================================================================

describe("createTaskId", () => {
  it("creates task ID from thread and run IDs", () => {
    expect(createTaskId("thread-1", "run-1")).toBe("thread-1:run-1");
  });

  it("creates task ID with UUIDs", () => {
    const tid = "550e8400-e29b-41d4-a716-446655440000";
    const rid = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
    expect(createTaskId(tid, rid)).toBe(`${tid}:${rid}`);
  });

  it("roundtrips with parseTaskId", () => {
    const taskId = createTaskId("abc", "def");
    const [threadId, runId] = parseTaskId(taskId);
    expect(threadId).toBe("abc");
    expect(runId).toBe("def");
  });
});

// ===========================================================================
// mapRunStatusToTaskState
// ===========================================================================

describe("mapRunStatusToTaskState", () => {
  it("maps 'pending' to 'submitted'", () => {
    expect(mapRunStatusToTaskState("pending")).toBe("submitted");
  });

  it("maps 'running' to 'working'", () => {
    expect(mapRunStatusToTaskState("running")).toBe("working");
  });

  it("maps 'success' to 'completed'", () => {
    expect(mapRunStatusToTaskState("success")).toBe("completed");
  });

  it("maps 'error' to 'failed'", () => {
    expect(mapRunStatusToTaskState("error")).toBe("failed");
  });

  it("maps 'timeout' to 'failed'", () => {
    expect(mapRunStatusToTaskState("timeout")).toBe("failed");
  });

  it("maps 'interrupted' to 'input-required'", () => {
    expect(mapRunStatusToTaskState("interrupted")).toBe("input-required");
  });

  it("maps unknown status to 'failed'", () => {
    expect(mapRunStatusToTaskState("unknown-status")).toBe("failed");
    expect(mapRunStatusToTaskState("")).toBe("failed");
  });
});

// ===========================================================================
// extractTextFromParts
// ===========================================================================

describe("extractTextFromParts", () => {
  it("extracts text from single text part", () => {
    const parts: MessagePart[] = [{ kind: "text", text: "Hello world" }];
    expect(extractTextFromParts(parts)).toBe("Hello world");
  });

  it("joins multiple text parts with newlines", () => {
    const parts: MessagePart[] = [
      { kind: "text", text: "Line 1" },
      { kind: "text", text: "Line 2" },
    ];
    expect(extractTextFromParts(parts)).toBe("Line 1\nLine 2");
  });

  it("ignores non-text parts", () => {
    const parts: MessagePart[] = [
      { kind: "text", text: "Hello" },
      { kind: "data", data: { key: "value" } },
      { kind: "text", text: "World" },
    ];
    expect(extractTextFromParts(parts)).toBe("Hello\nWorld");
  });

  it("returns empty string when no text parts", () => {
    const parts: MessagePart[] = [
      { kind: "data", data: { key: "value" } },
    ];
    expect(extractTextFromParts(parts)).toBe("");
  });

  it("returns empty string for empty array", () => {
    expect(extractTextFromParts([])).toBe("");
  });
});

// ===========================================================================
// extractDataFromParts
// ===========================================================================

describe("extractDataFromParts", () => {
  it("extracts data from single data part", () => {
    const parts: MessagePart[] = [
      { kind: "data", data: { key: "value" } },
    ];
    expect(extractDataFromParts(parts)).toEqual({ key: "value" });
  });

  it("merges multiple data parts", () => {
    const parts: MessagePart[] = [
      { kind: "data", data: { a: 1 } },
      { kind: "data", data: { b: 2 } },
    ];
    expect(extractDataFromParts(parts)).toEqual({ a: 1, b: 2 });
  });

  it("later data parts override earlier ones for same key", () => {
    const parts: MessagePart[] = [
      { kind: "data", data: { key: "first" } },
      { kind: "data", data: { key: "second" } },
    ];
    expect(extractDataFromParts(parts)).toEqual({ key: "second" });
  });

  it("ignores non-data parts", () => {
    const parts: MessagePart[] = [
      { kind: "text", text: "Hello" },
      { kind: "data", data: { found: true } },
    ];
    expect(extractDataFromParts(parts)).toEqual({ found: true });
  });

  it("returns empty object when no data parts", () => {
    const parts: MessagePart[] = [{ kind: "text", text: "Hello" }];
    expect(extractDataFromParts(parts)).toEqual({});
  });

  it("returns empty object for empty array", () => {
    expect(extractDataFromParts([])).toEqual({});
  });
});

// ===========================================================================
// hasFileParts
// ===========================================================================

describe("hasFileParts", () => {
  it("returns true when file part exists", () => {
    const parts: MessagePart[] = [
      { kind: "text", text: "Hello" },
      { kind: "file", file: { name: "doc.pdf" } },
    ];
    expect(hasFileParts(parts)).toBe(true);
  });

  it("returns false when no file parts", () => {
    const parts: MessagePart[] = [
      { kind: "text", text: "Hello" },
      { kind: "data", data: { key: "val" } },
    ];
    expect(hasFileParts(parts)).toBe(false);
  });

  it("returns false for empty array", () => {
    expect(hasFileParts([])).toBe(false);
  });

  it("returns true when only file parts", () => {
    const parts: MessagePart[] = [
      { kind: "file", file: { name: "a.txt" } },
      { kind: "file", file: { name: "b.txt" } },
    ];
    expect(hasFileParts(parts)).toBe(true);
  });
});

// ===========================================================================
// parseJsonRpcRequest
// ===========================================================================

describe("parseJsonRpcRequest", () => {
  it("parses valid request with all fields", () => {
    const data = {
      jsonrpc: "2.0",
      id: "req-1",
      method: "message/send",
      params: { message: {} },
    };
    const result = parseJsonRpcRequest(data);
    expect(result.jsonrpc).toBe("2.0");
    expect(result.id).toBe("req-1");
    expect(result.method).toBe("message/send");
    expect(result.params).toEqual({ message: {} });
  });

  it("parses request with numeric id", () => {
    const data = { jsonrpc: "2.0", id: 42, method: "tasks/get" };
    const result = parseJsonRpcRequest(data);
    expect(result.id).toBe(42);
  });

  it("parses request without id (notification)", () => {
    const data = { jsonrpc: "2.0", method: "tasks/cancel" };
    const result = parseJsonRpcRequest(data);
    expect(result.id).toBeNull();
  });

  it("parses request with null id", () => {
    const data = { jsonrpc: "2.0", id: null, method: "message/send" };
    const result = parseJsonRpcRequest(data);
    expect(result.id).toBeNull();
  });

  it("parses request without params", () => {
    const data = { jsonrpc: "2.0", id: "1", method: "message/send" };
    const result = parseJsonRpcRequest(data);
    expect(result.params).toBeNull();
  });

  it("throws on invalid jsonrpc version", () => {
    const data = { jsonrpc: "1.0", id: "1", method: "test" };
    expect(() => parseJsonRpcRequest(data)).toThrow("Invalid jsonrpc version");
  });

  it("throws on missing jsonrpc field", () => {
    const data = { id: "1", method: "test" } as Record<string, unknown>;
    expect(() => parseJsonRpcRequest(data)).toThrow("Invalid jsonrpc version");
  });

  it("throws on missing method", () => {
    const data = { jsonrpc: "2.0", id: "1" } as Record<string, unknown>;
    expect(() => parseJsonRpcRequest(data)).toThrow(
      "Missing or invalid 'method'",
    );
  });

  it("throws on empty method string", () => {
    const data = { jsonrpc: "2.0", id: "1", method: "" };
    expect(() => parseJsonRpcRequest(data)).toThrow(
      "Missing or invalid 'method'",
    );
  });

  it("throws on non-string method", () => {
    const data = { jsonrpc: "2.0", id: "1", method: 42 };
    expect(() => parseJsonRpcRequest(data)).toThrow(
      "Missing or invalid 'method'",
    );
  });

  it("ignores array params (treats as null)", () => {
    const data = {
      jsonrpc: "2.0",
      id: "1",
      method: "test",
      params: [1, 2, 3],
    };
    const result = parseJsonRpcRequest(data);
    expect(result.params).toBeNull();
  });
});

// ===========================================================================
// parseMessageSendParams
// ===========================================================================

describe("parseMessageSendParams", () => {
  it("parses valid message/send params with text part", () => {
    const params = {
      message: {
        role: "user",
        parts: [{ kind: "text", text: "Hello agent" }],
        messageId: "msg-1",
      },
    };
    const result = parseMessageSendParams(params);
    expect(result.message.role).toBe("user");
    expect(result.message.parts).toHaveLength(1);
    expect(result.message.parts[0].kind).toBe("text");
    expect((result.message.parts[0] as TextPart).text).toBe("Hello agent");
    expect(result.message.messageId).toBe("msg-1");
  });

  it("parses message with contextId", () => {
    const params = {
      message: {
        role: "user",
        parts: [{ kind: "text", text: "Hi" }],
        messageId: "msg-1",
        contextId: "thread-123",
      },
    };
    const result = parseMessageSendParams(params);
    expect(result.message.contextId).toBe("thread-123");
  });

  it("parses message with taskId", () => {
    const params = {
      message: {
        role: "user",
        parts: [{ kind: "text", text: "Hi" }],
        messageId: "msg-1",
        taskId: "thread-1:run-1",
      },
    };
    const result = parseMessageSendParams(params);
    expect(result.message.taskId).toBe("thread-1:run-1");
  });

  it("parses message with data part", () => {
    const params = {
      message: {
        role: "user",
        parts: [{ kind: "data", data: { key: "value" } }],
        messageId: "msg-1",
      },
    };
    const result = parseMessageSendParams(params);
    expect(result.message.parts[0].kind).toBe("data");
    expect((result.message.parts[0] as DataPart).data).toEqual({
      key: "value",
    });
  });

  it("parses message with file part", () => {
    const params = {
      message: {
        role: "user",
        parts: [{ kind: "file", file: { name: "doc.pdf" } }],
        messageId: "msg-1",
      },
    };
    const result = parseMessageSendParams(params);
    expect(result.message.parts[0].kind).toBe("file");
  });

  it("parses agent role", () => {
    const params = {
      message: {
        role: "agent",
        parts: [{ kind: "text", text: "Response" }],
        messageId: "msg-1",
      },
    };
    const result = parseMessageSendParams(params);
    expect(result.message.role).toBe("agent");
  });

  it("handles snake_case aliases (message_id, context_id, task_id)", () => {
    const params = {
      message: {
        role: "user",
        parts: [{ kind: "text", text: "Hi" }],
        message_id: "msg-1",
        context_id: "ctx-1",
        task_id: "task-1:run-1",
      },
    };
    const result = parseMessageSendParams(params);
    expect(result.message.messageId).toBe("msg-1");
    expect(result.message.contextId).toBe("ctx-1");
    expect(result.message.taskId).toBe("task-1:run-1");
  });

  it("throws when message field is missing", () => {
    expect(() => parseMessageSendParams({})).toThrow(
      "'message' field is required",
    );
  });

  it("throws when message is not an object", () => {
    expect(() => parseMessageSendParams({ message: "invalid" })).toThrow(
      "'message' field is required",
    );
  });

  it("throws on invalid role", () => {
    const params = {
      message: {
        role: "system",
        parts: [{ kind: "text", text: "Hi" }],
        messageId: "msg-1",
      },
    };
    expect(() => parseMessageSendParams(params)).toThrow("Invalid message role");
  });

  it("throws when parts is not an array", () => {
    const params = {
      message: {
        role: "user",
        parts: "invalid",
        messageId: "msg-1",
      },
    };
    expect(() => parseMessageSendParams(params)).toThrow(
      "'parts' must be an array",
    );
  });

  it("throws when messageId is missing", () => {
    const params = {
      message: {
        role: "user",
        parts: [{ kind: "text", text: "Hi" }],
      },
    };
    expect(() => parseMessageSendParams(params)).toThrow(
      "'messageId' is required",
    );
  });

  it("throws on invalid part kind", () => {
    const params = {
      message: {
        role: "user",
        parts: [{ kind: "unknown-kind" }],
        messageId: "msg-1",
      },
    };
    expect(() => parseMessageSendParams(params)).toThrow(
      "Invalid message part kind",
    );
  });

  it("sets null contextId when not provided", () => {
    const params = {
      message: {
        role: "user",
        parts: [{ kind: "text", text: "Hi" }],
        messageId: "msg-1",
      },
    };
    const result = parseMessageSendParams(params);
    expect(result.message.contextId).toBeNull();
  });

  it("sets null taskId when not provided", () => {
    const params = {
      message: {
        role: "user",
        parts: [{ kind: "text", text: "Hi" }],
        messageId: "msg-1",
      },
    };
    const result = parseMessageSendParams(params);
    expect(result.message.taskId).toBeNull();
  });
});

// ===========================================================================
// parseTaskGetParams
// ===========================================================================

describe("parseTaskGetParams", () => {
  it("parses valid params", () => {
    const result = parseTaskGetParams({
      id: "thread-1:run-1",
      contextId: "thread-1",
    });
    expect(result.id).toBe("thread-1:run-1");
    expect(result.contextId).toBe("thread-1");
    expect(result.historyLength).toBe(0);
  });

  it("parses with custom historyLength", () => {
    const result = parseTaskGetParams({
      id: "t:r",
      contextId: "t",
      historyLength: 5,
    });
    expect(result.historyLength).toBe(5);
  });

  it("clamps historyLength to max 10", () => {
    const result = parseTaskGetParams({
      id: "t:r",
      contextId: "t",
      historyLength: 100,
    });
    expect(result.historyLength).toBe(10);
  });

  it("clamps historyLength to min 0", () => {
    const result = parseTaskGetParams({
      id: "t:r",
      contextId: "t",
      historyLength: -5,
    });
    expect(result.historyLength).toBe(0);
  });

  it("handles snake_case context_id", () => {
    const result = parseTaskGetParams({
      id: "t:r",
      context_id: "thread-1",
    });
    expect(result.contextId).toBe("thread-1");
  });

  it("handles snake_case history_length", () => {
    const result = parseTaskGetParams({
      id: "t:r",
      contextId: "t",
      history_length: 3,
    });
    expect(result.historyLength).toBe(3);
  });

  it("throws when id is missing", () => {
    expect(() =>
      parseTaskGetParams({ contextId: "t" }),
    ).toThrow("'id' is required");
  });

  it("throws when contextId is missing", () => {
    expect(() =>
      parseTaskGetParams({ id: "t:r" }),
    ).toThrow("'contextId' is required");
  });
});

// ===========================================================================
// parseTaskCancelParams
// ===========================================================================

describe("parseTaskCancelParams", () => {
  it("parses valid params", () => {
    const result = parseTaskCancelParams({
      id: "thread-1:run-1",
      contextId: "thread-1",
    });
    expect(result.id).toBe("thread-1:run-1");
    expect(result.contextId).toBe("thread-1");
  });

  it("handles snake_case context_id", () => {
    const result = parseTaskCancelParams({
      id: "t:r",
      context_id: "thread-1",
    });
    expect(result.contextId).toBe("thread-1");
  });

  it("throws when id is missing", () => {
    expect(() =>
      parseTaskCancelParams({ contextId: "t" }),
    ).toThrow("'id' is required");
  });

  it("throws when contextId is missing", () => {
    expect(() =>
      parseTaskCancelParams({ id: "t:r" }),
    ).toThrow("'contextId' is required");
  });
});

// ===========================================================================
// ValueError
// ===========================================================================

describe("ValueError", () => {
  it("is an instance of Error", () => {
    const error = new ValueError("test");
    expect(error).toBeInstanceOf(Error);
  });

  it("has correct name", () => {
    const error = new ValueError("test");
    expect(error.name).toBe("ValueError");
  });

  it("has correct message", () => {
    const error = new ValueError("bad params");
    expect(error.message).toBe("bad params");
  });

  it("is distinguishable from generic Error", () => {
    const valueError = new ValueError("ve");
    const genericError = new Error("ge");
    expect(valueError instanceof ValueError).toBe(true);
    expect(genericError instanceof ValueError).toBe(false);
  });
});

// ===========================================================================
// A2AMethodHandler — routing
// ===========================================================================

describe("A2AMethodHandler — routing", () => {
  let storage: ReturnType<typeof createMockStorage>;
  let handler: A2AMethodHandler;

  beforeEach(() => {
    storage = createMockStorage();
    handler = new A2AMethodHandler({ storage });
  });

  it("routes message/send to the correct handler", async () => {
    // Set up a thread so message/send can find it
    storage._threads.set("thread-1", { thread_id: "thread-1" });

    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: "req-1",
      method: "message/send",
      params: {
        message: {
          role: "user",
          parts: [{ kind: "text", text: "Hello" }],
          messageId: "msg-1",
          contextId: "thread-1",
        },
      },
    };

    const response = await handler.handleRequest(
      request,
      "assistant-1",
      "owner-1",
    );
    expect(response.jsonrpc).toBe("2.0");
    expect(response.id).toBe("req-1");
    // Should have a result (task)
    expect(response.result).toBeDefined();
    expect(response.error).toBeUndefined();
  });

  it("returns METHOD_NOT_FOUND for unknown method", async () => {
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: "req-1",
      method: "unknown/method",
      params: null,
    };

    const response = await handler.handleRequest(
      request,
      "assistant-1",
      "owner-1",
    );
    expect(response.error).toBeDefined();
    expect(response.error!.code).toBe(JsonRpcErrorCode.METHOD_NOT_FOUND);
    expect(response.error!.message).toContain("unknown/method");
  });

  it("returns INTERNAL_ERROR for message/stream (should be SSE)", async () => {
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: "req-1",
      method: "message/stream",
      params: null,
    };

    const response = await handler.handleRequest(
      request,
      "assistant-1",
      "owner-1",
    );
    expect(response.error).toBeDefined();
    expect(response.error!.code).toBe(JsonRpcErrorCode.INTERNAL_ERROR);
    expect(response.error!.message).toContain("SSE route");
  });

  it("handles null params gracefully", async () => {
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: "req-1",
      method: "message/send",
      params: null,
    };

    const response = await handler.handleRequest(
      request,
      "assistant-1",
      "owner-1",
    );
    // Should fail with INVALID_PARAMS (params are empty, no message field)
    expect(response.error).toBeDefined();
    expect(response.error!.code).toBe(JsonRpcErrorCode.INVALID_PARAMS);
  });
});

// ===========================================================================
// A2AMethodHandler — message/send
// ===========================================================================

describe("A2AMethodHandler — message/send", () => {
  let storage: ReturnType<typeof createMockStorage>;
  let handler: A2AMethodHandler;

  beforeEach(() => {
    storage = createMockStorage();
    handler = new A2AMethodHandler({ storage });
  });

  it("creates a new thread when contextId is not provided", async () => {
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: "req-1",
      method: "message/send",
      params: {
        message: {
          role: "user",
          parts: [{ kind: "text", text: "Hello" }],
          messageId: "msg-1",
        },
      },
    };

    const response = await handler.handleRequest(
      request,
      "assistant-1",
      "owner-1",
    );
    expect(response.result).toBeDefined();
    expect(response.error).toBeUndefined();

    // A new thread should have been created
    expect(storage._threads.size).toBe(1);
    // A new run should have been created
    expect(storage._runs.size).toBe(1);
  });

  it("uses existing thread when contextId is provided", async () => {
    storage._threads.set("existing-thread", {
      thread_id: "existing-thread",
    });

    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: "req-1",
      method: "message/send",
      params: {
        message: {
          role: "user",
          parts: [{ kind: "text", text: "Hello" }],
          messageId: "msg-1",
          contextId: "existing-thread",
        },
      },
    };

    const response = await handler.handleRequest(
      request,
      "assistant-1",
      "owner-1",
    );
    expect(response.result).toBeDefined();
    // Should NOT have created a new thread (still 1)
    expect(storage._threads.size).toBe(1);
  });

  it("returns error when contextId refers to non-existent thread", async () => {
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: "req-1",
      method: "message/send",
      params: {
        message: {
          role: "user",
          parts: [{ kind: "text", text: "Hello" }],
          messageId: "msg-1",
          contextId: "nonexistent-thread",
        },
      },
    };

    const response = await handler.handleRequest(
      request,
      "assistant-1",
      "owner-1",
    );
    expect(response.error).toBeDefined();
    expect(response.error!.code).toBe(JsonRpcErrorCode.INVALID_PARAMS);
    expect(response.error!.message).toContain("Context not found");
  });

  it("returns error when message has file parts", async () => {
    storage._threads.set("thread-1", { thread_id: "thread-1" });

    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: "req-1",
      method: "message/send",
      params: {
        message: {
          role: "user",
          parts: [{ kind: "file", file: { name: "doc.pdf" } }],
          messageId: "msg-1",
          contextId: "thread-1",
        },
      },
    };

    const response = await handler.handleRequest(
      request,
      "assistant-1",
      "owner-1",
    );
    expect(response.error).toBeDefined();
    expect(response.error!.code).toBe(JsonRpcErrorCode.INVALID_PARAMS);
    expect(response.error!.message).toContain("File parts are not supported");
  });

  it("returns a task with 'submitted' state", async () => {
    storage._threads.set("thread-1", { thread_id: "thread-1" });

    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: "req-1",
      method: "message/send",
      params: {
        message: {
          role: "user",
          parts: [{ kind: "text", text: "Hello agent" }],
          messageId: "msg-1",
          contextId: "thread-1",
        },
      },
    };

    const response = await handler.handleRequest(
      request,
      "assistant-1",
      "owner-1",
    );
    const task = response.result as Record<string, unknown>;
    expect(task.kind).toBe("task");
    expect(typeof task.id).toBe("string");
    expect(task.contextId).toBe("thread-1");

    const status = task.status as Record<string, unknown>;
    expect(status.state).toBe("submitted");
    expect(typeof status.timestamp).toBe("string");
  });

  it("creates run with metadata containing a2a_message_id", async () => {
    storage._threads.set("thread-1", { thread_id: "thread-1" });

    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: "req-1",
      method: "message/send",
      params: {
        message: {
          role: "user",
          parts: [{ kind: "text", text: "Hello" }],
          messageId: "msg-abc",
          contextId: "thread-1",
        },
      },
    };

    await handler.handleRequest(request, "assistant-1", "owner-1");

    // Check the run was created with correct metadata
    expect(storage._runs.size).toBe(1);
    const run = Array.from(storage._runs.values())[0];
    const metadata = run.metadata as Record<string, unknown>;
    expect(metadata.a2a_message_id).toBe("msg-abc");
  });

  it("returns INVALID_PARAMS for invalid message params", async () => {
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: "req-1",
      method: "message/send",
      params: { not_a_message: true },
    };

    const response = await handler.handleRequest(
      request,
      "assistant-1",
      "owner-1",
    );
    expect(response.error).toBeDefined();
    expect(response.error!.code).toBe(JsonRpcErrorCode.INVALID_PARAMS);
  });
});

// ===========================================================================
// A2AMethodHandler — tasks/get
// ===========================================================================

describe("A2AMethodHandler — tasks/get", () => {
  let storage: ReturnType<typeof createMockStorage>;
  let handler: A2AMethodHandler;

  beforeEach(() => {
    storage = createMockStorage();
    handler = new A2AMethodHandler({ storage });
  });

  it("returns task status for existing run", async () => {
    storage._threads.set("thread-1", { thread_id: "thread-1" });
    storage._runs.set("run-1", {
      run_id: "run-1",
      status: "success",
    });

    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: "req-1",
      method: "tasks/get",
      params: {
        id: "thread-1:run-1",
        contextId: "thread-1",
      },
    };

    const response = await handler.handleRequest(
      request,
      "assistant-1",
      "owner-1",
    );
    expect(response.result).toBeDefined();

    const task = response.result as Record<string, unknown>;
    expect(task.kind).toBe("task");
    expect(task.id).toBe("thread-1:run-1");
    expect(task.contextId).toBe("thread-1");

    const status = task.status as Record<string, unknown>;
    expect(status.state).toBe("completed");
  });

  it("returns error when thread not found", async () => {
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: "req-1",
      method: "tasks/get",
      params: {
        id: "nonexistent:run-1",
        contextId: "nonexistent",
      },
    };

    const response = await handler.handleRequest(
      request,
      "assistant-1",
      "owner-1",
    );
    expect(response.error).toBeDefined();
    expect(response.error!.code).toBe(JsonRpcErrorCode.INVALID_PARAMS);
    expect(response.error!.message).toContain("Context not found");
  });

  it("returns error when run not found", async () => {
    storage._threads.set("thread-1", { thread_id: "thread-1" });

    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: "req-1",
      method: "tasks/get",
      params: {
        id: "thread-1:nonexistent-run",
        contextId: "thread-1",
      },
    };

    const response = await handler.handleRequest(
      request,
      "assistant-1",
      "owner-1",
    );
    expect(response.error).toBeDefined();
    expect(response.error!.code).toBe(JsonRpcErrorCode.INVALID_PARAMS);
    expect(response.error!.message).toContain("Task not found");
  });

  it("returns error for invalid task ID format", async () => {
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: "req-1",
      method: "tasks/get",
      params: {
        id: "no-colon-here",
        contextId: "thread-1",
      },
    };

    const response = await handler.handleRequest(
      request,
      "assistant-1",
      "owner-1",
    );
    expect(response.error).toBeDefined();
    expect(response.error!.code).toBe(JsonRpcErrorCode.INVALID_PARAMS);
    expect(response.error!.message).toContain("Invalid task ID format");
  });

  it("maps 'pending' run status to 'submitted' task state", async () => {
    storage._threads.set("thread-1", { thread_id: "thread-1" });
    storage._runs.set("run-1", {
      run_id: "run-1",
      status: "pending",
    });

    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: "req-1",
      method: "tasks/get",
      params: {
        id: "thread-1:run-1",
        contextId: "thread-1",
      },
    };

    const response = await handler.handleRequest(
      request,
      "assistant-1",
      "owner-1",
    );
    const task = response.result as Record<string, unknown>;
    const status = task.status as Record<string, unknown>;
    expect(status.state).toBe("submitted");
  });

  it("maps 'running' run status to 'working' task state", async () => {
    storage._threads.set("thread-1", { thread_id: "thread-1" });
    storage._runs.set("run-1", {
      run_id: "run-1",
      status: "running",
    });

    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: "req-1",
      method: "tasks/get",
      params: {
        id: "thread-1:run-1",
        contextId: "thread-1",
      },
    };

    const response = await handler.handleRequest(
      request,
      "assistant-1",
      "owner-1",
    );
    const task = response.result as Record<string, unknown>;
    const status = task.status as Record<string, unknown>;
    expect(status.state).toBe("working");
  });

  it("maps 'error' run status to 'failed' task state", async () => {
    storage._threads.set("thread-1", { thread_id: "thread-1" });
    storage._runs.set("run-1", {
      run_id: "run-1",
      status: "error",
    });

    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: "req-1",
      method: "tasks/get",
      params: {
        id: "thread-1:run-1",
        contextId: "thread-1",
      },
    };

    const response = await handler.handleRequest(
      request,
      "assistant-1",
      "owner-1",
    );
    const task = response.result as Record<string, unknown>;
    const status = task.status as Record<string, unknown>;
    expect(status.state).toBe("failed");
  });
});

// ===========================================================================
// A2AMethodHandler — tasks/cancel
// ===========================================================================

describe("A2AMethodHandler — tasks/cancel", () => {
  let storage: ReturnType<typeof createMockStorage>;
  let handler: A2AMethodHandler;

  beforeEach(() => {
    storage = createMockStorage();
    handler = new A2AMethodHandler({ storage });
  });

  it("returns INVALID_PARAMS (cancellation not supported)", async () => {
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: "req-1",
      method: "tasks/cancel",
      params: {
        id: "thread-1:run-1",
        contextId: "thread-1",
      },
    };

    const response = await handler.handleRequest(
      request,
      "assistant-1",
      "owner-1",
    );
    expect(response.error).toBeDefined();
    expect(response.error!.code).toBe(JsonRpcErrorCode.INVALID_PARAMS);
    expect(response.error!.message).toContain("not supported");
  });

  it("validates params before returning unsupported error", async () => {
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: "req-1",
      method: "tasks/cancel",
      params: {}, // Missing required fields
    };

    const response = await handler.handleRequest(
      request,
      "assistant-1",
      "owner-1",
    );
    expect(response.error).toBeDefined();
    expect(response.error!.code).toBe(JsonRpcErrorCode.INVALID_PARAMS);
    // Should fail on missing params, not on "not supported"
    expect(response.error!.message).toContain("'id' is required");
  });
});

// ===========================================================================
// A2AMethodHandler — response structure
// ===========================================================================

describe("A2AMethodHandler — response structure", () => {
  let storage: ReturnType<typeof createMockStorage>;
  let handler: A2AMethodHandler;

  beforeEach(() => {
    storage = createMockStorage();
    handler = new A2AMethodHandler({ storage });
  });

  it("echoes back the request ID in the response", async () => {
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: "unique-req-id-42",
      method: "unknown/method",
      params: null,
    };

    const response = await handler.handleRequest(
      request,
      "assistant-1",
      "owner-1",
    );
    expect(response.id).toBe("unique-req-id-42");
  });

  it("echoes back numeric request ID", async () => {
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: 999,
      method: "unknown/method",
      params: null,
    };

    const response = await handler.handleRequest(
      request,
      "assistant-1",
      "owner-1",
    );
    expect(response.id).toBe(999);
  });

  it("echoes back null request ID", async () => {
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: null,
      method: "unknown/method",
      params: null,
    };

    const response = await handler.handleRequest(
      request,
      "assistant-1",
      "owner-1",
    );
    expect(response.id).toBeNull();
  });

  it("always includes jsonrpc: '2.0' in responses", async () => {
    storage._threads.set("thread-1", { thread_id: "thread-1" });

    // Success response
    const successRequest: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: "1",
      method: "message/send",
      params: {
        message: {
          role: "user",
          parts: [{ kind: "text", text: "Hi" }],
          messageId: "msg-1",
          contextId: "thread-1",
        },
      },
    };
    const successResponse = await handler.handleRequest(
      successRequest,
      "a",
      "o",
    );
    expect(successResponse.jsonrpc).toBe("2.0");

    // Error response
    const errorRequest: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: "2",
      method: "nonexistent",
      params: null,
    };
    const errorResponse = await handler.handleRequest(
      errorRequest,
      "a",
      "o",
    );
    expect(errorResponse.jsonrpc).toBe("2.0");
  });
});

// ===========================================================================
// Integration — full request/response cycle
// ===========================================================================

describe("A2A integration — full cycle", () => {
  let storage: ReturnType<typeof createMockStorage>;
  let handler: A2AMethodHandler;

  beforeEach(() => {
    storage = createMockStorage();
    handler = new A2AMethodHandler({ storage });
  });

  it("message/send creates thread + run, tasks/get retrieves status", async () => {
    // Step 1: Send a message (creates new thread)
    const sendRequest: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: "send-1",
      method: "message/send",
      params: {
        message: {
          role: "user",
          parts: [{ kind: "text", text: "What is 2+2?" }],
          messageId: "msg-calc",
        },
      },
    };

    const sendResponse = await handler.handleRequest(
      sendRequest,
      "math-assistant",
      "user-1",
    );
    expect(sendResponse.error).toBeUndefined();

    const task = sendResponse.result as Record<string, unknown>;
    const taskId = task.id as string;
    const contextId = task.contextId as string;

    expect(typeof taskId).toBe("string");
    expect(taskId).toContain(":");

    // Step 2: Get the task status
    const getRequest: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: "get-1",
      method: "tasks/get",
      params: {
        id: taskId,
        contextId,
      },
    };

    const getResponse = await handler.handleRequest(
      getRequest,
      "math-assistant",
      "user-1",
    );
    expect(getResponse.error).toBeUndefined();

    const retrievedTask = getResponse.result as Record<string, unknown>;
    expect(retrievedTask.id).toBe(taskId);
    expect(retrievedTask.contextId).toBe(contextId);
    expect(retrievedTask.kind).toBe("task");
  });

  it("handles multiple messages in same context", async () => {
    // Send first message
    const firstSend: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: "1",
      method: "message/send",
      params: {
        message: {
          role: "user",
          parts: [{ kind: "text", text: "Hello" }],
          messageId: "msg-1",
        },
      },
    };

    const firstResponse = await handler.handleRequest(
      firstSend,
      "assistant",
      "owner",
    );
    const firstTask = firstResponse.result as Record<string, unknown>;
    const contextId = firstTask.contextId as string;

    // Send second message in same context
    const secondSend: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: "2",
      method: "message/send",
      params: {
        message: {
          role: "user",
          parts: [{ kind: "text", text: "Follow up" }],
          messageId: "msg-2",
          contextId,
        },
      },
    };

    const secondResponse = await handler.handleRequest(
      secondSend,
      "assistant",
      "owner",
    );
    const secondTask = secondResponse.result as Record<string, unknown>;

    // Both tasks should have the same context (thread)
    expect(secondTask.contextId).toBe(contextId);

    // But different task IDs (different runs)
    expect(secondTask.id).not.toBe(firstTask.id);

    // Should have 2 runs now
    expect(storage._runs.size).toBe(2);
  });

  it("mixed data and text parts are both extracted", async () => {
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: "req-1",
      method: "message/send",
      params: {
        message: {
          role: "user",
          parts: [
            { kind: "text", text: "Analyze this" },
            { kind: "data", data: { temperature: 0.5, model: "gpt-4o" } },
          ],
          messageId: "msg-mixed",
        },
      },
    };

    const response = await handler.handleRequest(
      request,
      "assistant",
      "owner",
    );
    expect(response.error).toBeUndefined();
    expect(response.result).toBeDefined();

    // Check that the run was created with the input
    const run = Array.from(storage._runs.values())[0];
    const kwargs = run.kwargs as Record<string, unknown>;
    const input = kwargs.input as Record<string, unknown>;

    expect(input.messages).toBeDefined();
    expect(input.temperature).toBe(0.5);
    expect(input.model).toBe("gpt-4o");
  });
});
