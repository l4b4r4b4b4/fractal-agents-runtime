/**
 * Worker utilities for the research agent graph.
 *
 * This module provides helpers for extracting structured research results
 * from the raw output of a ReAct agent invocation. Each parallel worker
 * is a mini `createAgent()` instance that reasons and uses tools to
 * fulfil its assigned SearchTask.
 *
 * The extraction logic is intentionally lenient — it tries multiple
 * strategies (JSON parsing, regex, plain-text fallback) because the
 * worker LLM may not always produce perfectly structured output,
 * especially with weaker models or complex tool interactions.
 *
 * Reference: apps/python/src/graphs/research_agent/worker.py
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single research finding produced by a worker. */
export interface ResearchResult {
  title: string;
  summary: string;
  sourceUrl: string | null;
  relevanceScore: number | null;
  metadata: Record<string, unknown>;
}

/** The structured output from a worker extraction. */
export interface WorkerOutput {
  results: ResearchResult[];
}

/** A task dict (serialised SearchTask). */
export interface TaskDict {
  taskId?: string;
  task_id?: string;
  description?: string;
  searchFocus?: string;
  search_focus?: string;
  constraints?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Regex to find JSON arrays or objects in freeform text.
// ---------------------------------------------------------------------------

const JSON_BLOCK_PATTERN =
  /```(?:json)?\s*\n?([\s\S]*?)```|(\[[\s\S]*?\])|(\{[\s\S]*?\})/g;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract structured research results from a ReAct agent's output.
 *
 * The function inspects the agent's `messages` list (newest first)
 * and attempts to parse structured JSON results. If JSON extraction
 * fails, it falls back to wrapping the plain-text response as a
 * single ResearchResult-shaped dict.
 *
 * @param agentResult - The dict returned by `agent.invoke()`.
 *   Expected to contain a `messages` key with a list of message objects.
 * @param task - Optional task dict (a serialised SearchTask). Used
 *   to enrich the fallback result with task metadata.
 * @returns A WorkerOutput with a `results` array containing at least
 *   one result (the fallback).
 *
 * @example
 *   const raw = await workerAgent.invoke({ messages: [...] });
 *   const output = extractWorkerOutput(raw, task);
 *   // output.results.length >= 1
 */
export function extractWorkerOutput(
  agentResult: Record<string, unknown>,
  task?: TaskDict | null,
): WorkerOutput {
  const messages = agentResult.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    console.warn("[research-worker] Worker returned no messages — producing empty result");
    return fallbackResult("No output from worker.", task ?? null);
  }

  // Walk messages newest-first looking for AI/assistant content.
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    const content = getMessageContent(message);
    if (!content) continue;

    // Strategy 1: Try to parse structured JSON from the content.
    const parsed = tryParseResultsJson(content);
    if (parsed !== null) {
      return { results: parsed };
    }
  }

  // Strategy 2: Use the last AI message as plain-text fallback.
  const lastContent = getLastAiContent(messages);
  if (lastContent) {
    return fallbackResult(lastContent, task ?? null);
  }

  console.warn("[research-worker] Worker output: no usable content found in messages");
  return fallbackResult("Worker produced no usable content.", task ?? null);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Extract the text content from a LangChain message object or dict.
 *
 * Handles both object-style (`message.content`) and dict-style
 * (`message["content"]`) messages, as well as list-of-blocks
 * content (multimodal messages).
 */
function getMessageContent(message: unknown): string | null {
  if (message === null || message === undefined) return null;

  let content: unknown;

  if (typeof message === "object") {
    const messageRecord = message as Record<string, unknown>;
    content = messageRecord.content;
  } else {
    return null;
  }

  if (typeof content === "string" && content.trim()) {
    return content.trim();
  }

  if (Array.isArray(content)) {
    // Multimodal: extract text blocks only.
    const textParts: string[] = [];
    for (const block of content) {
      if (typeof block === "string") {
        textParts.push(block);
      } else if (
        typeof block === "object" &&
        block !== null &&
        (block as Record<string, unknown>).type === "text"
      ) {
        const text = (block as Record<string, unknown>).text;
        if (typeof text === "string") {
          textParts.push(text);
        }
      }
    }
    const joined = textParts.join("\n").trim();
    return joined || null;
  }

  return null;
}

/**
 * Check whether a message is from the AI / assistant.
 */
function isAiMessage(message: unknown): boolean {
  if (message === null || message === undefined || typeof message !== "object") {
    return false;
  }

  const messageRecord = message as Record<string, unknown>;

  // Dict-style checks
  const role = messageRecord.role;
  if (typeof role === "string" && (role === "assistant" || role === "ai")) {
    return true;
  }

  const messageType = messageRecord.type;
  if (typeof messageType === "string" && (messageType === "ai" || messageType === "AIMessage")) {
    return true;
  }

  // Object-style — check _getType() method (LangChain message objects)
  const getTypeFn = messageRecord._getType;
  if (typeof getTypeFn === "function") {
    try {
      const typeName = (getTypeFn as () => string).call(message);
      if (typeName === "ai") return true;
    } catch {
      // Ignore
    }
  }

  // Check constructor name
  const constructorName = (message as object).constructor?.name;
  if (constructorName === "AIMessage" || constructorName === "AIMessageChunk") {
    return true;
  }

  return false;
}

/**
 * Return the text content of the last AI message in the list.
 */
function getLastAiContent(messages: unknown[]): string | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (isAiMessage(message)) {
      const content = getMessageContent(message);
      if (content) return content;
    }
  }
  return null;
}

/**
 * Try to extract a JSON array of result dicts from freeform text.
 *
 * Returns `null` if no valid JSON could be parsed.
 */
function tryParseResultsJson(text: string): ResearchResult[] | null {
  // First, try the whole text as JSON.
  const directParsed = tryParseJsonString(text);
  if (directParsed !== null) return directParsed;

  // Try extracting from code blocks or embedded JSON.
  // Reset the regex lastIndex since it's global.
  JSON_BLOCK_PATTERN.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = JSON_BLOCK_PATTERN.exec(text)) !== null) {
    const candidate = match[1] ?? match[2] ?? match[3];
    if (candidate) {
      const parsed = tryParseJsonString(candidate.trim());
      if (parsed !== null) return parsed;
    }
  }

  return null;
}

/**
 * Parse a JSON string into a list of result dicts.
 *
 * Handles both a bare JSON array and a JSON object with a
 * `results` key. Returns `null` on any failure.
 */
function tryParseJsonString(text: string): ResearchResult[] | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }

  if (Array.isArray(data) && data.length > 0) {
    return normaliseResultList(data);
  }

  if (typeof data === "object" && data !== null && !Array.isArray(data)) {
    const dataRecord = data as Record<string, unknown>;

    // Could be { results: [...] } or a single result object.
    if (Array.isArray(dataRecord.results) && dataRecord.results.length > 0) {
      return normaliseResultList(dataRecord.results);
    }
    if ("title" in dataRecord || "summary" in dataRecord) {
      return normaliseResultList([data]);
    }
  }

  return null;
}

/**
 * Ensure every item in the list has the expected result keys.
 *
 * Returns `null` if no items could be normalised.
 */
function normaliseResultList(items: unknown[]): ResearchResult[] | null {
  const normalised: ResearchResult[] = [];

  for (const item of items) {
    if (typeof item !== "object" || item === null) continue;

    const record = item as Record<string, unknown>;

    normalised.push({
      title: String(record.title ?? "Untitled"),
      summary: String(record.summary ?? record.description ?? ""),
      sourceUrl:
        typeof record.source_url === "string"
          ? record.source_url
          : typeof record.sourceUrl === "string"
            ? record.sourceUrl
            : typeof record.url === "string"
              ? record.url
              : null,
      relevanceScore: safeFloat(record.relevance_score ?? record.relevanceScore ?? record.score),
      metadata:
        typeof record.metadata === "object" && record.metadata !== null
          ? (record.metadata as Record<string, unknown>)
          : {},
    });
  }

  return normalised.length > 0 ? normalised : null;
}

/**
 * Convert a value to a finite number, returning `null` on failure.
 */
function safeFloat(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

/**
 * Wrap plain-text content as a single-result output dict.
 */
function fallbackResult(
  content: string,
  task: TaskDict | null,
): WorkerOutput {
  let taskDescription = "";
  if (task) {
    taskDescription =
      task.description ??
      task.search_focus ??
      task.searchFocus ??
      "";
  }

  const title = taskDescription
    ? taskDescription.slice(0, 120)
    : "Research finding";

  return {
    results: [
      {
        title,
        summary: content.slice(0, 2000), // Truncate very long outputs
        sourceUrl: null,
        relevanceScore: null,
        metadata: { extraction_method: "plain_text_fallback" },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Exported for testing
// ---------------------------------------------------------------------------

export const _internals = {
  getMessageContent,
  isAiMessage,
  getLastAiContent,
  tryParseResultsJson,
  tryParseJsonString,
  normaliseResultList,
  safeFloat,
  fallbackResult,
};
