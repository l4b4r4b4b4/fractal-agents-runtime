/**
 * A2A Protocol JSON-RPC 2.0 schemas and helper functions — TypeScript/Bun.
 *
 * Implements the Agent-to-Agent (A2A) Protocol types according to the
 * Google A2A specification using JSON-RPC 2.0 over HTTP.
 *
 * Concepts mapping:
 *   - A2A Task → LangGraph Run (identified by thread_id:run_id)
 *   - A2A contextId → LangGraph thread_id
 *   - A2A Message parts → LangGraph input/output messages
 *   - A2A Artifact → Agent response content
 *
 * Port of: apps/python/src/server/a2a/schemas.py
 */

// ============================================================================
// JSON-RPC 2.0 Error Codes
// ============================================================================

/**
 * Standard JSON-RPC 2.0 error codes plus A2A-specific extensions.
 */
export const JsonRpcErrorCode = {
  /** Invalid JSON was received by the server. */
  PARSE_ERROR: -32700,
  /** The JSON sent is not a valid Request object. */
  INVALID_REQUEST: -32600,
  /** The method does not exist / is not available. */
  METHOD_NOT_FOUND: -32601,
  /** Invalid method parameter(s). */
  INVALID_PARAMS: -32602,
  /** Internal JSON-RPC error. */
  INTERNAL_ERROR: -32603,

  // A2A-specific error codes (application-defined)
  /** Referenced task was not found. */
  TASK_NOT_FOUND: -32001,
  /** Task cannot be cancelled in its current state. */
  TASK_NOT_CANCELABLE: -32002,
  /** Requested operation is not supported. */
  UNSUPPORTED_OPERATION: -32003,
  /** Invalid message part type. */
  INVALID_PART_TYPE: -32004,
} as const;

export type JsonRpcErrorCodeValue =
  (typeof JsonRpcErrorCode)[keyof typeof JsonRpcErrorCode];

// ============================================================================
// JSON-RPC 2.0 Base Types
// ============================================================================

/**
 * JSON-RPC 2.0 request object.
 */
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number | null;
  method: string;
  params?: Record<string, unknown> | null;
}

/**
 * JSON-RPC 2.0 error object.
 */
export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

/**
 * JSON-RPC 2.0 response object.
 *
 * Either `result` or `error` is present, never both.
 */
export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: JsonRpcError;
}

// ============================================================================
// A2A Task Status
// ============================================================================

/**
 * A2A task states mapped from LangGraph run states.
 */
export type TaskState =
  | "submitted"
  | "working"
  | "input-required"
  | "completed"
  | "failed"
  | "canceled";

/**
 * A2A task status.
 */
export interface TaskStatus {
  state: TaskState;
  message?: string | null;
  timestamp?: string | null;
}

// ============================================================================
// A2A Message Parts
// ============================================================================

/**
 * Text content part.
 */
export interface TextPart {
  kind: "text";
  text: string;
}

/**
 * Structured data part.
 */
export interface DataPart {
  kind: "data";
  data: Record<string, unknown>;
}

/**
 * File content part (not supported, included for schema completeness).
 */
export interface FilePart {
  kind: "file";
  file: Record<string, unknown>;
}

/** Union type for message parts. */
export type MessagePart = TextPart | DataPart | FilePart;

// ============================================================================
// A2A Message
// ============================================================================

/**
 * A2A protocol message.
 *
 * Maps to LangGraph:
 *   - contextId → thread_id
 *   - taskId → run_id (for resuming interrupted tasks)
 *   - parts → input content
 */
export interface A2AMessage {
  role: "user" | "agent";
  parts: MessagePart[];
  messageId: string;
  contextId?: string | null;
  taskId?: string | null;
}

// ============================================================================
// A2A Artifacts
// ============================================================================

/**
 * A2A artifact — represents agent output.
 */
export interface Artifact {
  artifactId: string;
  name: string;
  parts: MessagePart[];
}

// ============================================================================
// A2A Task
// ============================================================================

/**
 * A2A task — wraps a LangGraph run with A2A semantics.
 *
 * The task ID format is: `{thread_id}:{run_id}`
 * This allows reconstruction of both IDs from a single identifier.
 */
export interface Task {
  kind: "task";
  id: string;
  contextId: string;
  status: TaskStatus;
  artifacts: Artifact[];
  history: A2AMessage[];
}

// ============================================================================
// A2A Method Parameters
// ============================================================================

/**
 * Parameters for `message/send` and `message/stream` methods.
 */
export interface MessageSendParams {
  message: A2AMessage;
}

/**
 * Parameters for `tasks/get` method.
 */
export interface TaskGetParams {
  id: string;
  contextId: string;
  historyLength?: number;
}

/**
 * Parameters for `tasks/cancel` method.
 */
export interface TaskCancelParams {
  id: string;
  contextId: string;
}

// ============================================================================
// A2A Streaming Events
// ============================================================================

/**
 * SSE event for task status updates during streaming.
 */
export interface StatusUpdateEvent {
  kind: "status-update";
  taskId: string;
  contextId: string;
  status: TaskStatus;
  final: boolean;
}

/**
 * SSE event for artifact updates during streaming.
 */
export interface ArtifactUpdateEvent {
  kind: "artifact-update";
  taskId: string;
  contextId: string;
  artifact: Artifact;
  final: boolean;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Create a JSON-RPC 2.0 error response.
 *
 * @param requestId - The request ID to echo back (may be null for parse errors).
 * @param code - The error code.
 * @param message - Human-readable error message.
 * @param data - Optional additional error data.
 * @returns A well-formed JSON-RPC 2.0 error response.
 */
export function createErrorResponse(
  requestId: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  const response: JsonRpcResponse = {
    jsonrpc: "2.0",
    id: requestId,
    error: { code, message },
  };

  if (data !== undefined) {
    response.error!.data = data;
  }

  return response;
}

/**
 * Create a JSON-RPC 2.0 success response.
 *
 * @param requestId - The request ID to echo back.
 * @param result - The result payload.
 * @returns A well-formed JSON-RPC 2.0 success response.
 */
export function createSuccessResponse(
  requestId: string | number | null,
  result: unknown,
): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id: requestId,
    result,
  };
}

/**
 * Parse a task ID into thread_id and run_id.
 *
 * Task IDs have the format `{thread_id}:{run_id}`.
 *
 * @param taskId - The task ID to parse.
 * @returns Tuple of `[threadId, runId]`.
 * @throws {Error} If the task ID format is invalid.
 */
export function parseTaskId(taskId: string): [string, string] {
  const colonIndex = taskId.indexOf(":");
  if (colonIndex === -1) {
    throw new Error(
      `Invalid task ID format: ${taskId}. Expected format: thread_id:run_id`,
    );
  }
  return [taskId.slice(0, colonIndex), taskId.slice(colonIndex + 1)];
}

/**
 * Create a task ID from thread_id and run_id.
 *
 * @param threadId - The thread ID.
 * @param runId - The run ID.
 * @returns Task ID in format `{thread_id}:{run_id}`.
 */
export function createTaskId(threadId: string, runId: string): string {
  return `${threadId}:${runId}`;
}

/**
 * Map a LangGraph run status string to an A2A task state.
 *
 * @param runStatus - LangGraph run status.
 * @returns Corresponding A2A TaskState.
 */
export function mapRunStatusToTaskState(runStatus: string): TaskState {
  const statusMap: Record<string, TaskState> = {
    pending: "submitted",
    running: "working",
    success: "completed",
    error: "failed",
    timeout: "failed",
    interrupted: "input-required",
  };
  return statusMap[runStatus] ?? "failed";
}

/**
 * Extract concatenated text from message parts.
 *
 * Joins all `TextPart` content with newlines.
 *
 * @param parts - Array of message parts.
 * @returns Concatenated text content.
 */
export function extractTextFromParts(parts: MessagePart[]): string {
  const texts: string[] = [];

  for (const part of parts) {
    if (part.kind === "text") {
      texts.push(part.text);
    }
  }

  return texts.join("\n");
}

/**
 * Extract and merge structured data from message parts.
 *
 * Merges all `DataPart` data dictionaries into a single object.
 * Later parts override earlier ones for duplicate keys.
 *
 * @param parts - Array of message parts.
 * @returns Merged data dictionary.
 */
export function extractDataFromParts(
  parts: MessagePart[],
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};

  for (const part of parts) {
    if (part.kind === "data") {
      Object.assign(merged, part.data);
    }
  }

  return merged;
}

/**
 * Check if any parts are file type (unsupported).
 *
 * @param parts - Array of message parts.
 * @returns `true` if any file parts exist.
 */
export function hasFileParts(parts: MessagePart[]): boolean {
  return parts.some((part) => part.kind === "file");
}

/**
 * Validate and parse a raw object as a JSON-RPC 2.0 request.
 *
 * Checks for required fields (`jsonrpc`, `method`) and returns
 * a typed `JsonRpcRequest` or throws with a descriptive error.
 *
 * @param data - The raw parsed JSON object.
 * @returns A validated `JsonRpcRequest`.
 * @throws {Error} If the data does not conform to JSON-RPC 2.0.
 */
export function parseJsonRpcRequest(
  data: Record<string, unknown>,
): JsonRpcRequest {
  if (data.jsonrpc !== "2.0") {
    throw new Error(
      `Invalid jsonrpc version: ${String(data.jsonrpc)}. Expected "2.0"`,
    );
  }

  if (typeof data.method !== "string" || data.method.length === 0) {
    throw new Error("Missing or invalid 'method' field");
  }

  const id =
    data.id === undefined || data.id === null
      ? null
      : typeof data.id === "string" || typeof data.id === "number"
        ? data.id
        : null;

  const params =
    data.params !== undefined &&
    data.params !== null &&
    typeof data.params === "object" &&
    !Array.isArray(data.params)
      ? (data.params as Record<string, unknown>)
      : null;

  return {
    jsonrpc: "2.0",
    id,
    method: data.method,
    params,
  };
}

/**
 * Validate and parse raw params as `MessageSendParams`.
 *
 * @param params - The raw params object from the JSON-RPC request.
 * @returns Validated `MessageSendParams`.
 * @throws {Error} If the params do not contain a valid A2A message.
 */
export function parseMessageSendParams(
  params: Record<string, unknown>,
): MessageSendParams {
  const rawMessage = params.message;

  if (!rawMessage || typeof rawMessage !== "object" || Array.isArray(rawMessage)) {
    throw new Error("Invalid message/send params: 'message' field is required and must be an object");
  }

  const message = rawMessage as Record<string, unknown>;

  // Validate required fields
  const role = message.role;
  if (role !== "user" && role !== "agent") {
    throw new Error(
      `Invalid message role: ${String(role)}. Expected "user" or "agent"`,
    );
  }

  const parts = message.parts;
  if (!Array.isArray(parts)) {
    throw new Error("Invalid message: 'parts' must be an array");
  }

  const messageId = message.messageId ?? message.message_id;
  if (typeof messageId !== "string" || messageId.length === 0) {
    throw new Error("Invalid message: 'messageId' is required");
  }

  // Parse parts
  const parsedParts: MessagePart[] = parts.map((part: unknown) => {
    if (!part || typeof part !== "object" || Array.isArray(part)) {
      throw new Error("Invalid message part: must be an object");
    }
    const partObj = part as Record<string, unknown>;
    const kind = partObj.kind;

    if (kind === "text") {
      return {
        kind: "text" as const,
        text: typeof partObj.text === "string" ? partObj.text : "",
      };
    }

    if (kind === "data") {
      return {
        kind: "data" as const,
        data:
          typeof partObj.data === "object" &&
          partObj.data !== null &&
          !Array.isArray(partObj.data)
            ? (partObj.data as Record<string, unknown>)
            : {},
      };
    }

    if (kind === "file") {
      return {
        kind: "file" as const,
        file:
          typeof partObj.file === "object" &&
          partObj.file !== null &&
          !Array.isArray(partObj.file)
            ? (partObj.file as Record<string, unknown>)
            : {},
      };
    }

    throw new Error(`Invalid message part kind: ${String(kind)}`);
  });

  const contextId =
    typeof (message.contextId ?? message.context_id) === "string"
      ? (String(message.contextId ?? message.context_id))
      : null;

  const taskId =
    typeof (message.taskId ?? message.task_id) === "string"
      ? (String(message.taskId ?? message.task_id))
      : null;

  return {
    message: {
      role,
      parts: parsedParts,
      messageId,
      contextId,
      taskId,
    },
  };
}

/**
 * Validate and parse raw params as `TaskGetParams`.
 *
 * @param params - The raw params object from the JSON-RPC request.
 * @returns Validated `TaskGetParams`.
 * @throws {Error} If required fields are missing.
 */
export function parseTaskGetParams(
  params: Record<string, unknown>,
): TaskGetParams {
  const id = params.id;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("Invalid tasks/get params: 'id' is required");
  }

  const contextId = params.contextId ?? params.context_id;
  if (typeof contextId !== "string" || contextId.length === 0) {
    throw new Error("Invalid tasks/get params: 'contextId' is required");
  }

  const historyLength = params.historyLength ?? params.history_length;
  const parsedHistoryLength =
    typeof historyLength === "number" && Number.isFinite(historyLength)
      ? Math.max(0, Math.min(10, Math.round(historyLength)))
      : 0;

  return {
    id,
    contextId,
    historyLength: parsedHistoryLength,
  };
}

/**
 * Validate and parse raw params as `TaskCancelParams`.
 *
 * @param params - The raw params object from the JSON-RPC request.
 * @returns Validated `TaskCancelParams`.
 * @throws {Error} If required fields are missing.
 */
export function parseTaskCancelParams(
  params: Record<string, unknown>,
): TaskCancelParams {
  const id = params.id;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("Invalid tasks/cancel params: 'id' is required");
  }

  const contextId = params.contextId ?? params.context_id;
  if (typeof contextId !== "string" || contextId.length === 0) {
    throw new Error("Invalid tasks/cancel params: 'contextId' is required");
  }

  return { id, contextId };
}
