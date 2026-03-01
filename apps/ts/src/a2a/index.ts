/**
 * A2A Protocol — barrel exports.
 *
 * Re-exports all public types, schemas, helpers, and the method handler
 * from the A2A module for convenient importing.
 *
 * Usage:
 *
 *   import {
 *     A2AMethodHandler,
 *     JsonRpcErrorCode,
 *     createErrorResponse,
 *     parseJsonRpcRequest,
 *   } from "./a2a";
 */

// Schemas — types
export type {
  JsonRpcErrorCodeValue,
  JsonRpcRequest,
  JsonRpcError,
  JsonRpcResponse,
  TaskState,
  TaskStatus,
  TextPart,
  DataPart,
  FilePart,
  MessagePart,
  A2AMessage,
  Artifact,
  Task,
  MessageSendParams,
  TaskGetParams,
  TaskCancelParams,
  StatusUpdateEvent,
  ArtifactUpdateEvent,
} from "./schemas";

// Schemas — constants and helpers
export {
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
} from "./schemas";

// Handlers — types
export type { A2AStorage, A2AHandlerOptions } from "./handlers";

// Handlers — classes
export { A2AMethodHandler, ValueError } from "./handlers";
