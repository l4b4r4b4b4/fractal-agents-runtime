/**
 * A2A Protocol method handlers — TypeScript/Bun.
 *
 * Implements the JSON-RPC 2.0 method handlers for the A2A protocol.
 * Maps A2A concepts (tasks, messages, artifacts) to LangGraph concepts
 * (runs, threads, input/output).
 *
 * Supported methods:
 *   - `message/send` — Send a message and wait for a response (synchronous).
 *   - `tasks/get` — Retrieve task status and artifacts.
 *   - `tasks/cancel` — Cancel a running task (returns unsupported).
 *
 * The `message/stream` method is handled at the route level (SSE) and
 * delegates to `handleMessageStream()` on this handler.
 *
 * Port of: apps/python/src/server/a2a/handlers.py
 */

import type {
  JsonRpcRequest,
  JsonRpcResponse,
  Task,
  TaskStatus,
  Artifact,
  MessagePart,
  TextPart,
  A2AMessage,
} from "./schemas";
import {
  JsonRpcErrorCode,
  createErrorResponse,
  createSuccessResponse,
  createTaskId,
  parseTaskId,
  mapRunStatusToTaskState,
  extractTextFromParts,
  extractDataFromParts,
  hasFileParts,
  parseMessageSendParams,
  parseTaskGetParams,
  parseTaskCancelParams,
} from "./schemas";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Minimal storage interface required by the A2A handler.
 *
 * This avoids importing the full storage module, keeping the A2A handler
 * testable in isolation with mock implementations.
 */
export interface A2AStorage {
  assistants: {
    get(assistantId: string, ownerId: string): unknown | null;
    list(ownerId: string): unknown[];
  };
  threads: {
    get(threadId: string, ownerId: string): unknown | null;
    create(metadata: Record<string, unknown>, ownerId: string): unknown;
  };
  runs: {
    get(runId: string, ownerId: string): unknown | null;
    create(data: Record<string, unknown>, ownerId: string): unknown;
  };
}

/**
 * Options for creating an A2A handler.
 */
export interface A2AHandlerOptions {
  /** Storage backend for assistants, threads, and runs. */
  storage: A2AStorage;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum characters to show in message preview for logging. */
const MAX_MESSAGE_PREVIEW_LENGTH = 100;

// ---------------------------------------------------------------------------
// A2AMethodHandler
// ---------------------------------------------------------------------------

/**
 * Handler for A2A JSON-RPC methods.
 *
 * Provides method routing and execution for the A2A protocol,
 * mapping A2A operations to LangGraph run/thread operations.
 *
 * Usage:
 *
 *   const handler = new A2AMethodHandler({ storage });
 *   const response = await handler.handleRequest(rpcRequest, assistantId, ownerId);
 */
export class A2AMethodHandler {
  private readonly storage: A2AStorage;

  constructor(options: A2AHandlerOptions) {
    this.storage = options.storage;
  }

  /**
   * Route a JSON-RPC request to the appropriate handler method.
   *
   * @param request - The validated JSON-RPC request.
   * @param assistantId - The assistant ID from the URL path.
   * @param ownerId - The authenticated user's identity.
   * @returns JSON-RPC response with result or error.
   */
  async handleRequest(
    request: JsonRpcRequest,
    assistantId: string,
    ownerId: string,
  ): Promise<JsonRpcResponse> {
    const method = request.method;
    const params = request.params ?? {};

    console.info(
      `[a2a] request: method=${method}, id=${String(request.id)}`,
    );

    // message/stream is handled separately at the route level (SSE)
    if (method === "message/stream") {
      return createErrorResponse(
        request.id,
        JsonRpcErrorCode.INTERNAL_ERROR,
        "message/stream should be handled by SSE route",
      );
    }

    // Route to handler
    const handlerMap: Record<
      string,
      (
        params: Record<string, unknown>,
        assistantId: string,
        ownerId: string,
      ) => Promise<unknown>
    > = {
      "message/send": this.handleMessageSend.bind(this),
      "tasks/get": this.handleTasksGet.bind(this),
      "tasks/cancel": this.handleTasksCancel.bind(this),
    };

    const handler = handlerMap[method];
    if (!handler) {
      console.warn(`[a2a] method not found: ${method}`);
      return createErrorResponse(
        request.id,
        JsonRpcErrorCode.METHOD_NOT_FOUND,
        `Method not found: ${method}`,
      );
    }

    try {
      const result = await handler(params, assistantId, ownerId);
      return createSuccessResponse(request.id, result);
    } catch (error: unknown) {
      if (error instanceof ValueError) {
        console.error(`[a2a] invalid params: ${error.message}`);
        return createErrorResponse(
          request.id,
          JsonRpcErrorCode.INVALID_PARAMS,
          error.message,
        );
      }

      const message =
        error instanceof Error ? error.message : String(error);
      console.error(`[a2a] internal error: ${message}`);
      return createErrorResponse(
        request.id,
        JsonRpcErrorCode.INTERNAL_ERROR,
        `Internal error: ${message}`,
      );
    }
  }

  /**
   * Handle the `message/send` method.
   *
   * Sends a message to the agent and returns a Task with the response.
   * Maps to LangGraph's run creation and execution.
   *
   * @param params - Raw parameters from the JSON-RPC request.
   * @param assistantId - The assistant ID from the URL path.
   * @param ownerId - The authenticated user's identity.
   * @returns Task result with status and artifacts.
   * @throws {ValueError} If params are invalid or resources not found.
   */
  async handleMessageSend(
    params: Record<string, unknown>,
    assistantId: string,
    ownerId: string,
  ): Promise<Record<string, unknown>> {
    // Parse and validate params
    let sendParams;
    try {
      sendParams = parseMessageSendParams(params);
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : String(error);
      throw new ValueError(`Invalid message/send params: ${message}`);
    }

    const message = sendParams.message;

    // Check for unsupported file parts
    if (hasFileParts(message.parts)) {
      throw new ValueError("File parts are not supported");
    }

    // Get or create thread (contextId)
    let threadId = message.contextId;

    if (threadId) {
      const thread = this.storage.threads.get(threadId, ownerId);
      if (thread === null || thread === undefined) {
        throw new ValueError(`Context not found: ${threadId}`);
      }
    } else {
      // Create new thread
      const thread = this.storage.threads.create({}, ownerId) as Record<
        string,
        unknown
      >;
      threadId = String(
        thread.thread_id ?? thread.threadId ?? crypto.randomUUID(),
      );
    }

    // Extract input from message parts
    const textContent = extractTextFromParts(message.parts);
    const dataContent = extractDataFromParts(message.parts);

    // Build input for LangGraph
    const runInput: Record<string, unknown> = {};
    if (textContent) {
      runInput.messages = [
        {
          type: "human",
          content: textContent,
          id: message.messageId,
        },
      ];
    }
    if (Object.keys(dataContent).length > 0) {
      Object.assign(runInput, dataContent);
    }

    // Create run
    const runData: Record<string, unknown> = {
      thread_id: threadId,
      assistant_id: assistantId,
      status: "pending",
      metadata: { a2a_message_id: message.messageId },
      kwargs: { input: runInput },
      multitask_strategy: "reject",
    };

    const run = this.storage.runs.create(runData, ownerId) as Record<
      string,
      unknown
    >;
    const runId = String(run.run_id ?? run.runId ?? crypto.randomUUID());

    // Build a preview of the message for logging
    const preview = textContent
      ? textContent.slice(0, MAX_MESSAGE_PREVIEW_LENGTH)
      : JSON.stringify(dataContent).slice(0, MAX_MESSAGE_PREVIEW_LENGTH);
    console.info(
      `[a2a] message/send: thread=${threadId}, run=${runId}, preview="${preview}"`,
    );

    // Note: In a full implementation, this would invoke the agent graph
    // and wait for the result. For now, we return a "submitted" task
    // that the caller can poll via tasks/get.
    //
    // The actual agent execution is handled by the runs subsystem which
    // processes the run asynchronously.

    const taskId = createTaskId(threadId, runId);
    const now = new Date().toISOString();

    const task: Task = {
      kind: "task",
      id: taskId,
      contextId: threadId,
      status: {
        state: "submitted",
        timestamp: now,
      },
      artifacts: [],
      history: [],
    };

    return task as unknown as Record<string, unknown>;
  }

  /**
   * Handle the `tasks/get` method.
   *
   * Retrieves the current status and artifacts of a task.
   *
   * @param params - Raw parameters from the JSON-RPC request.
   * @param assistantId - The assistant ID from the URL path.
   * @param ownerId - The authenticated user's identity.
   * @returns Task with current status and artifacts.
   * @throws {ValueError} If params are invalid or task not found.
   */
  async handleTasksGet(
    params: Record<string, unknown>,
    assistantId: string,
    ownerId: string,
  ): Promise<Record<string, unknown>> {
    let getParams;
    try {
      getParams = parseTaskGetParams(params);
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : String(error);
      throw new ValueError(`Invalid tasks/get params: ${message}`);
    }

    // Parse task ID into thread_id and run_id
    let threadId: string;
    let runId: string;
    try {
      [threadId, runId] = parseTaskId(getParams.id);
    } catch {
      throw new ValueError(
        `Invalid task ID format: ${getParams.id}. Expected: thread_id:run_id`,
      );
    }

    // Verify thread exists
    const thread = this.storage.threads.get(threadId, ownerId);
    if (thread === null || thread === undefined) {
      throw new ValueError(`Context not found: ${threadId}`);
    }

    // Get run status
    const run = this.storage.runs.get(runId, ownerId) as Record<
      string,
      unknown
    > | null;
    if (run === null || run === undefined) {
      throw new ValueError(`Task not found: ${getParams.id}`);
    }

    const runStatus = String(run.status ?? "pending");
    const taskState = mapRunStatusToTaskState(runStatus);
    const now = new Date().toISOString();

    // Build artifacts from run output (if completed)
    const artifacts: Artifact[] = [];
    if (taskState === "completed") {
      const output = run.output ?? run.result ?? run.kwargs;
      if (output && typeof output === "object") {
        const outputObj = output as Record<string, unknown>;
        const messages = outputObj.messages;

        if (Array.isArray(messages) && messages.length > 0) {
          const lastMessage = messages[messages.length - 1] as Record<
            string,
            unknown
          >;
          const content = String(lastMessage.content ?? "");
          artifacts.push({
            artifactId: crypto.randomUUID(),
            name: "Assistant Response",
            parts: [{ kind: "text", text: content }],
          });
        }
      }
    }

    const task: Task = {
      kind: "task",
      id: getParams.id,
      contextId: threadId,
      status: {
        state: taskState,
        timestamp: now,
      },
      artifacts,
      history: [],
    };

    return task as unknown as Record<string, unknown>;
  }

  /**
   * Handle the `tasks/cancel` method.
   *
   * Task cancellation is not currently supported. Returns an error
   * response indicating the operation is unsupported.
   *
   * @param params - Raw parameters from the JSON-RPC request.
   * @param _assistantId - The assistant ID from the URL path (unused).
   * @param _ownerId - The authenticated user's identity (unused).
   * @throws {ValueError} Always — cancellation is not supported.
   */
  async handleTasksCancel(
    params: Record<string, unknown>,
    _assistantId: string,
    _ownerId: string,
  ): Promise<never> {
    // Validate params even though we don't support the operation
    try {
      parseTaskCancelParams(params);
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : String(error);
      throw new ValueError(`Invalid tasks/cancel params: ${message}`);
    }

    throw new ValueError(
      "Task cancellation is not supported. Tasks run to completion.",
    );
  }
}

// ---------------------------------------------------------------------------
// ValueError — distinguishes user errors from internal errors
// ---------------------------------------------------------------------------

/**
 * Error class for invalid parameters / user-facing validation errors.
 *
 * Used to differentiate between:
 *   - `ValueError` → JSON-RPC INVALID_PARAMS response (user error)
 *   - Other errors → JSON-RPC INTERNAL_ERROR response (server error)
 */
export class ValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValueError";
  }
}
