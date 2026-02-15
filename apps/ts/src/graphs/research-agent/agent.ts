/**
 * Two-phase parallel research workflow with human-in-the-loop review.
 *
 * This module implements the core StateGraph that maps the research
 * workflow pattern into a generic, reusable LangGraph graph:
 *
 *     START
 *       → analyzer_phase1   (LLM: decompose query into SearchTasks)
 *       → [Send] worker_phase1  (parallel ReAct agents with MCP tools)
 *       → aggregator_phase1  (LLM: combine & rank results)
 *       → review_phase1      (interrupt: human approves or adjusts)
 *           ├─ adjust → analyzer_phase1
 *           └─ approve → set_phase2
 *
 *     set_phase2
 *       → analyzer_phase2   (LLM: create validation tasks)
 *       → [Send] worker_phase2  (parallel ReAct agents)
 *       → aggregator_phase2  (LLM: final selection & ranking)
 *       → review_phase2      (interrupt: human approves or adjusts)
 *           ├─ adjust → aggregator_phase2
 *           └─ approve → END
 *
 * All domain specificity comes from **prompts** (Langfuse) and **tools**
 * (MCP servers assigned per assistant). The graph code is generic.
 *
 * Key LangGraph primitives used:
 *
 * - `StateGraph` for the workflow definition
 * - `Send` for parallel worker fan-out
 * - `interrupt` for human-in-the-loop pauses
 * - `Command` for routing after review decisions
 *
 * Reference: apps/python/src/graphs/research_agent/graph.py
 * Reference: apps/python/src/graphs/research_agent/__init__.py
 */

import {
  Annotation,
  Command,
  END,
  Send,
  START,
  StateGraph,
  interrupt,
  MessagesAnnotation,
} from "@langchain/langgraph";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import { createAgent } from "langchain";

import type { GraphFactory, GraphFactoryOptions } from "../types";
import { parseResearchConfig } from "./configuration";
import { createChatModel } from "../react-agent/providers";
import { fetchMcpTools } from "../react-agent/utils/mcp-tools";
import { createRagTools } from "../react-agent/utils/rag-tools";
import { extractWorkerOutput } from "./worker";
import {
  ANALYZER_PHASE1_PROMPT,
  ANALYZER_PHASE2_PROMPT,
  WORKER_PHASE1_PROMPT,
  WORKER_PHASE2_PROMPT,
  AGGREGATOR_PHASE1_PROMPT,
  AGGREGATOR_PHASE2_PROMPT,
} from "./prompts";

// Trigger prompt registration on import (side-effect).
import "./prompts";

// ---------------------------------------------------------------------------
// Prompt fetching helper
// ---------------------------------------------------------------------------

// Dynamic import for infra/prompts — may not be available in test environments.
let getPromptFn:
  | ((options: {
      name: string;
      fallback?: string;
      variables?: Record<string, string> | null;
    }) => string)
  | null = null;

async function ensureGetPrompt(): Promise<typeof getPromptFn> {
  if (getPromptFn !== null) return getPromptFn;
  try {
    const promptsModule = await import("../../infra/prompts");
    if (typeof promptsModule.getPrompt === "function") {
      // Wrap the real getPrompt to match our simplified signature.
      // The real API is getPrompt<T>({ name, fallback, variables, ... }): PromptResult<T>
      getPromptFn = (options: {
        name: string;
        fallback?: string;
        variables?: Record<string, string> | null;
      }): string => {
        const result = promptsModule.getPrompt({
          name: options.name,
          fallback: options.fallback,
          variables: options.variables ?? null,
        });
        return typeof result === "string" ? result : (options.fallback ?? "");
      };
    } else {
      // Fallback: use a no-op that returns the fallback
      getPromptFn = (options: { fallback?: string }) =>
        options.fallback ?? "";
    }
  } catch {
    getPromptFn = (options: { fallback?: string }) =>
      options.fallback ?? "";
  }
  return getPromptFn;
}

/**
 * Get a prompt by name with variable substitution and fallback.
 *
 * Mirrors Python's `get_prompt(name, fallback=..., config=..., variables={...})`.
 */
async function resolvePrompt(
  name: string,
  fallback: string,
  variables?: Record<string, string>,
): Promise<string> {
  const getter = await ensureGetPrompt();
  if (!getter) return substituteVariables(fallback, variables);

  try {
    const text = getter({ name, fallback, variables: variables ?? null });
    return text || substituteVariables(fallback, variables);
  } catch {
    return substituteVariables(fallback, variables);
  }
}

function substituteVariables(
  text: string,
  variables?: Record<string, string>,
): string {
  if (!variables) return text;
  let result = text;
  for (const [key, value] of Object.entries(variables)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }
  return result;
}

// ---------------------------------------------------------------------------
// State annotations
// ---------------------------------------------------------------------------

/**
 * Main graph state for the two-phase research workflow.
 *
 * Uses a list reducer for `workerResults` so that parallel workers
 * can write to the same key concurrently (results are concatenated).
 */
const WorkflowAnnotation = Annotation.Root({
  // Inherit messages with add_messages reducer
  ...MessagesAnnotation.spec,

  /** The original user query. */
  userInput: Annotation<string>({
    reducer: (_previous, next) => next,
    default: () => "",
  }),

  /** Current phase: "phase1" | "phase2". */
  currentPhase: Annotation<string>({
    reducer: (_previous, next) => next,
    default: () => "phase1",
  }),

  /** Tasks produced by the analyzer. */
  taskList: Annotation<Record<string, unknown>[]>({
    reducer: (_previous, next) => next,
    default: () => [],
  }),

  /** Worker results — parallel writes via concatenation reducer. */
  workerResults: Annotation<Record<string, unknown>[]>({
    reducer: (previous, next) => [...previous, ...next],
    default: () => [],
  }),

  /** Aggregated results from phase 1. */
  phase1Results: Annotation<Record<string, unknown>[]>({
    reducer: (_previous, next) => next,
    default: () => [],
  }),

  /** Final aggregated results from phase 2. */
  finalResults: Annotation<Record<string, unknown>[]>({
    reducer: (_previous, next) => next,
    default: () => [],
  }),

  /** Final synthesis summary. */
  finalSummary: Annotation<string>({
    reducer: (_previous, next) => next,
    default: () => "",
  }),

  /** Human review feedback (used for loops). */
  reviewFeedback: Annotation<string>({
    reducer: (_previous, next) => next,
    default: () => "",
  }),
});

/**
 * State for individual worker Send nodes.
 *
 * Each worker receives a single task and produces results
 * that are accumulated into the parent's `workerResults`.
 */
const WorkerAnnotation = Annotation.Root({
  /** The task assigned to this worker. */
  task: Annotation<Record<string, unknown>>({
    reducer: (_previous, next) => next,
    default: () => ({}),
  }),

  /** Which phase this worker belongs to. */
  phase: Annotation<string>({
    reducer: (_previous, next) => next,
    default: () => "phase1",
  }),

  /** Worker results — accumulated via concatenation. */
  workerResults: Annotation<Record<string, unknown>[]>({
    reducer: (previous, next) => [...previous, ...next],
    default: () => [],
  }),
});

// ---------------------------------------------------------------------------
// JSON parsing helpers (mirrors Python's _parse_analyzer_response etc.)
// ---------------------------------------------------------------------------

/** Regex for JSON in freeform LLM output. */
const JSON_BLOCK_RE =
  /```(?:json)?\s*\n?([\s\S]*?)```|(\{[\s\S]*\})/g;

/**
 * Extract the text content from a LangChain message response.
 */
function extractContent(response: unknown): string {
  if (typeof response === "string") return response;

  if (response !== null && typeof response === "object") {
    const record = response as Record<string, unknown>;
    const content = record.content;

    if (typeof content === "string") return content;

    if (Array.isArray(content)) {
      return content
        .map((block: unknown) => {
          if (typeof block === "string") return block;
          if (
            typeof block === "object" &&
            block !== null &&
            (block as Record<string, unknown>).type === "text"
          ) {
            return String((block as Record<string, unknown>).text ?? "");
          }
          return String(block);
        })
        .join(" ");
    }
  }

  return String(response);
}

/**
 * Try to parse JSON from freeform text. Returns `null` on failure.
 */
function tryParseJson(text: string): Record<string, unknown> | unknown[] | null {
  if (!text) return null;

  // Try full text first.
  try {
    return JSON.parse(text);
  } catch {
    // Continue to regex extraction.
  }

  // Try extracting from code fences or embedded braces.
  JSON_BLOCK_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = JSON_BLOCK_RE.exec(text)) !== null) {
    const candidate = match[1] ?? match[2];
    if (candidate) {
      try {
        return JSON.parse(candidate.trim());
      } catch {
        continue;
      }
    }
  }

  return null;
}

/**
 * Ensure every task dict has the required keys.
 */
function normaliseTasks(items: unknown[]): Record<string, unknown>[] {
  const normalised: Record<string, unknown>[] = [];

  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if (typeof item !== "object" || item === null) continue;

    const record = item as Record<string, unknown>;
    normalised.push({
      task_id: record.task_id ?? `task-${index + 1}`,
      description: String(record.description ?? ""),
      search_focus: String(record.search_focus ?? record.description ?? ""),
      constraints: record.constraints ?? {},
    });
  }

  if (normalised.length === 0) {
    return [
      {
        task_id: "task-fallback",
        description: "General research",
        search_focus: "Research the query",
        constraints: {},
      },
    ];
  }

  return normalised;
}

/**
 * Extract a list of task dicts from the analyzer LLM response.
 *
 * Tries to parse structured JSON from the response content.
 * Falls back to a single catch-all task if parsing fails.
 */
function parseAnalyzerResponse(response: unknown): Record<string, unknown>[] {
  const content = extractContent(response);
  const parsed = tryParseJson(content);

  if (parsed !== null) {
    if (
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      Array.isArray((parsed as Record<string, unknown>).tasks)
    ) {
      return normaliseTasks(
        (parsed as Record<string, unknown>).tasks as unknown[],
      );
    }
    if (Array.isArray(parsed)) {
      return normaliseTasks(parsed);
    }
  }

  // Fallback: create a single task from the whole response.
  console.warn(
    "[research-agent] analyzer response was not valid JSON — creating single fallback task",
  );
  return [
    {
      task_id: "task-fallback",
      description: content ? content.slice(0, 500) : "General research",
      search_focus: content ? content.slice(0, 200) : "Research the query",
      constraints: {},
    },
  ];
}

/**
 * Extract aggregated results from the aggregator LLM response.
 *
 * Falls back to flattening all worker results if parsing fails.
 */
function parseAggregatorResponse(
  response: unknown,
  workerResults: Record<string, unknown>[],
): Record<string, unknown> {
  const content = extractContent(response);
  const parsed = tryParseJson(content);

  if (
    parsed !== null &&
    typeof parsed === "object" &&
    !Array.isArray(parsed)
  ) {
    const parsedRecord = parsed as Record<string, unknown>;
    const results = parsedRecord.results;
    if (Array.isArray(results) && results.length > 0) {
      return {
        results,
        summary: parsedRecord.summary ?? "",
        total_sources_reviewed: parsedRecord.total_sources_reviewed ?? 0,
      };
    }
  }

  // Fallback: flatten worker results.
  console.warn(
    "[research-agent] aggregator response was not valid JSON — flattening worker results",
  );
  const flatResults: unknown[] = [];
  for (const workerOutput of workerResults) {
    const results = workerOutput.results;
    if (Array.isArray(results)) {
      for (const result of results) {
        flatResults.push(result);
      }
    }
  }

  return {
    results: flatResults,
    summary: content ? content.slice(0, 500) : "Aggregation summary unavailable.",
    total_sources_reviewed: flatResults.length,
  };
}

// ---------------------------------------------------------------------------
// Graph builder
// ---------------------------------------------------------------------------

/**
 * Construct and compile the two-phase research StateGraph.
 *
 * This function is the core graph builder. It is called by the
 * public `graph()` factory after tools, model, and configuration
 * have been resolved.
 *
 * All node functions are defined as closures that capture `model`,
 * `tools`, and config from the enclosing scope.
 *
 * @param model - A LangChain chat model instance.
 * @param tools - List of LangChain-compatible tool objects.
 * @param options - Checkpointer, store, and research-specific settings.
 * @returns A compiled LangGraph `Pregel` instance ready for `.invoke()` / `.stream()`.
 */
function buildResearchGraph(
  model: unknown,
  tools: unknown[],
  options: {
    checkpointer?: unknown;
    store?: unknown;
    maxWorkerIterations: number;
    autoApprovePhase1: boolean;
    autoApprovePhase2: boolean;
  },
): unknown {
  const {
    checkpointer,
    store,
    maxWorkerIterations,
    autoApprovePhase1,
    autoApprovePhase2,
  } = options;

  // Cast model for invocation
  const chatModel = model as {
    invoke: (
      messages: Array<Record<string, unknown>>,
    ) => Promise<unknown>;
  };

  // -------------------------------------------------------------------
  // Node implementations (closures over model, tools, config)
  // -------------------------------------------------------------------

  async function analyzerPhase1(
    state: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const userInput = String(state.userInput ?? "");
    const feedback = String(state.reviewFeedback ?? "");

    const promptText = await resolvePrompt(
      "research-agent-analyzer-phase1",
      ANALYZER_PHASE1_PROMPT,
      {
        review_feedback: feedback
          ? `\nUser feedback on previous attempt:\n${feedback}`
          : "",
      },
    );

    const response = await chatModel.invoke([
      { role: "system", content: promptText },
      { role: "user", content: userInput },
    ]);

    const tasks = parseAnalyzerResponse(response);
    console.info(
      `[research-agent] analyzer_phase1: generated ${tasks.length} tasks for query: ${userInput.slice(0, 80)}`,
    );

    return {
      taskList: tasks,
      currentPhase: "phase1",
      workerResults: [], // Reset for new fan-out
    };
  }

  async function analyzerPhase2(
    state: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const phase1Results = (state.phase1Results ?? []) as Record<string, unknown>[];
    const feedback = String(state.reviewFeedback ?? "");

    const promptText = await resolvePrompt(
      "research-agent-analyzer-phase2",
      ANALYZER_PHASE2_PROMPT,
      {
        phase1_results: JSON.stringify(phase1Results),
        review_feedback: feedback
          ? `\nUser feedback:\n${feedback}`
          : "",
      },
    );

    const response = await chatModel.invoke([
      { role: "system", content: promptText },
      {
        role: "user",
        content: `Create validation tasks for these ${phase1Results.length} preliminary results.`,
      },
    ]);

    const tasks = parseAnalyzerResponse(response);
    console.info(
      `[research-agent] analyzer_phase2: generated ${tasks.length} validation tasks`,
    );

    return {
      taskList: tasks,
      currentPhase: "phase2",
      workerResults: [], // Reset for new fan-out
    };
  }

  async function workerNode(
    state: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const task = (state.task ?? {}) as Record<string, unknown>;
    const phase = String(state.phase ?? "phase1");

    const promptName = `research-agent-worker-${phase}`;
    const fallback =
      phase === "phase1" ? WORKER_PHASE1_PROMPT : WORKER_PHASE2_PROMPT;

    let workerPrompt = await resolvePrompt(promptName, fallback);

    // Append task details to the system prompt.
    const taskDescription = String(task.description ?? "");
    const searchFocus = String(
      task.search_focus ?? task.description ?? "",
    );
    const constraints = task.constraints;

    if (taskDescription) {
      workerPrompt += `\n\n--- Your assigned task ---\n${taskDescription}`;
    }
    if (
      constraints &&
      typeof constraints === "object" &&
      Object.keys(constraints as Record<string, unknown>).length > 0
    ) {
      workerPrompt += `\n\nConstraints: ${JSON.stringify(constraints)}`;
    }

    // Create a mini ReAct agent with the shared tools.
    // No checkpointer — the parent graph handles persistence.
    const workerAgent = createAgent({
      model: model as Parameters<typeof createAgent>[0]["model"],
      tools: tools as Parameters<typeof createAgent>[0]["tools"],
      systemPrompt: workerPrompt,
    });

    const taskId = String(task.task_id ?? "unknown");
    let output: { results: Record<string, unknown>[] };

    try {
      const result = await (
        workerAgent as unknown as {
          invoke: (
            input: Record<string, unknown>,
            config?: Record<string, unknown>,
          ) => Promise<Record<string, unknown>>;
        }
      ).invoke(
        { messages: [{ role: "user", content: searchFocus }] },
        { recursionLimit: maxWorkerIterations },
      );

      const workerOutput = extractWorkerOutput(result, {
        task_id: taskId,
        description: taskDescription,
        search_focus: searchFocus,
      });
      output = {
        results: workerOutput.results.map((resultItem) => ({ ...resultItem })),
      };
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : String(error);
      console.warn(
        `[research-agent] Worker failed for task ${taskId}: ${message}`,
      );
      output = {
        results: [
          {
            title: `Worker error: ${taskId}`,
            summary:
              "The research worker encountered an error and could not complete this task.",
            source_url: null,
            relevance_score: 0.0,
            metadata: { error: true },
          },
        ],
      };
    }

    const resultCount = output.results.length;
    console.info(
      `[research-agent] worker (${phase}, ${taskId}): produced ${resultCount} results`,
    );

    return {
      workerResults: [
        {
          task_id: taskId,
          phase,
          results: output.results,
        },
      ],
    };
  }

  async function aggregatorPhase1(
    state: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const workerResults = (state.workerResults ?? []) as Record<
      string,
      unknown
    >[];
    const userInput = String(state.userInput ?? "");

    const promptText = await resolvePrompt(
      "research-agent-aggregator-phase1",
      AGGREGATOR_PHASE1_PROMPT,
      {
        user_input: userInput,
        worker_results: JSON.stringify(workerResults),
      },
    );

    const response = await chatModel.invoke([
      { role: "system", content: promptText },
      {
        role: "user",
        content: `Aggregate results from ${workerResults.length} workers. Original query: ${userInput}`,
      },
    ]);

    const aggregated = parseAggregatorResponse(response, workerResults);
    const results = (aggregated.results ?? []) as unknown[];

    console.info(
      `[research-agent] aggregator_phase1: produced ${results.length} aggregated results`,
    );

    return {
      phase1Results: results,
    };
  }

  async function aggregatorPhase2(
    state: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const workerResults = (state.workerResults ?? []) as Record<
      string,
      unknown
    >[];
    const phase1Results = (state.phase1Results ?? []) as Record<
      string,
      unknown
    >[];
    const userInput = String(state.userInput ?? "");

    const promptText = await resolvePrompt(
      "research-agent-aggregator-phase2",
      AGGREGATOR_PHASE2_PROMPT,
      {
        user_input: userInput,
        phase1_results: JSON.stringify(phase1Results),
        worker_results: JSON.stringify(workerResults),
      },
    );

    const response = await chatModel.invoke([
      { role: "system", content: promptText },
      {
        role: "user",
        content: `Final aggregation: ${workerResults.length} validation workers, ${phase1Results.length} phase-1 results. Original query: ${userInput}`,
      },
    ]);

    const aggregated = parseAggregatorResponse(response, workerResults);
    const results = (aggregated.results ?? []) as unknown[];
    const summary = String(aggregated.summary ?? "Research complete.");

    console.info(
      `[research-agent] aggregator_phase2: final selection of ${results.length} results`,
    );

    return {
      finalResults: results,
      finalSummary: summary,
    };
  }

  function reviewPhase1(state: Record<string, unknown>): Command {
    const phase1Results = (state.phase1Results ?? []) as unknown[];

    if (autoApprovePhase1) {
      console.info(
        `[research-agent] review_phase1: auto-approved (${phase1Results.length} results)`,
      );
      return new Command({
        goto: "set_phase2",
        update: { reviewFeedback: "" },
      });
    }

    const decision = interrupt({
      type: "review_results",
      phase: "phase1",
      result_count: phase1Results.length,
      results: phase1Results,
      message:
        "Please review the phase 1 research results. " +
        "Respond with {'approved': true} to proceed to validation, " +
        "or {'approved': false, 'feedback': '...'} to adjust.",
    });

    if (
      typeof decision === "object" &&
      decision !== null &&
      (decision as Record<string, unknown>).approved
    ) {
      console.info(
        "[research-agent] review_phase1: human approved — proceeding to phase 2",
      );
      return new Command({
        goto: "set_phase2",
        update: { reviewFeedback: "" },
      });
    }

    const feedback =
      typeof decision === "object" && decision !== null
        ? String(
            (decision as Record<string, unknown>).feedback ?? "",
          )
        : String(decision ?? "");

    console.info(
      `[research-agent] review_phase1: human requested adjustments — feedback: ${feedback.slice(0, 200)}`,
    );
    return new Command({
      goto: "analyzer_phase1",
      update: { reviewFeedback: feedback },
    });
  }

  function reviewPhase2(state: Record<string, unknown>): Command {
    const finalResults = (state.finalResults ?? []) as unknown[];

    if (autoApprovePhase2) {
      console.info(
        `[research-agent] review_phase2: auto-approved (${finalResults.length} final results)`,
      );
      return new Command({
        goto: END,
        update: { reviewFeedback: "" },
      });
    }

    const decision = interrupt({
      type: "review_results",
      phase: "phase2",
      result_count: finalResults.length,
      results: finalResults,
      summary: state.finalSummary ?? "",
      message:
        "Please review the final research results. " +
        "Respond with {'approved': true} to finish, " +
        "or {'approved': false, 'feedback': '...'} to re-aggregate.",
    });

    if (
      typeof decision === "object" &&
      decision !== null &&
      (decision as Record<string, unknown>).approved
    ) {
      console.info(
        "[research-agent] review_phase2: human approved — finishing workflow",
      );
      return new Command({
        goto: END,
        update: { reviewFeedback: "" },
      });
    }

    const feedback =
      typeof decision === "object" && decision !== null
        ? String(
            (decision as Record<string, unknown>).feedback ?? "",
          )
        : String(decision ?? "");

    console.info(
      `[research-agent] review_phase2: human requested re-aggregation — feedback: ${feedback.slice(0, 200)}`,
    );
    return new Command({
      goto: "aggregator_phase2",
      update: { reviewFeedback: feedback },
    });
  }

  function setPhase2(
    _state: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      currentPhase: "phase2",
      reviewFeedback: "",
    };
  }

  // -------------------------------------------------------------------
  // Fan-out: conditional edges that create parallel workers via Send
  // -------------------------------------------------------------------

  function assignPhase1Workers(state: Record<string, unknown>): Send[] {
    const tasks = (state.taskList ?? []) as Record<string, unknown>[];

    if (tasks.length === 0) {
      console.warn(
        "[research-agent] assign_phase1_workers: no tasks — using fallback worker",
      );
      return [
        new Send("worker_phase1", {
          task: {
            task_id: "fallback",
            description: String(state.userInput ?? "General research"),
            search_focus: String(state.userInput ?? ""),
          },
          phase: "phase1",
        }),
      ];
    }

    return tasks.map(
      (task) =>
        new Send("worker_phase1", { task, phase: "phase1" }),
    );
  }

  function assignPhase2Workers(state: Record<string, unknown>): Send[] {
    const tasks = (state.taskList ?? []) as Record<string, unknown>[];

    if (tasks.length === 0) {
      console.warn(
        "[research-agent] assign_phase2_workers: no tasks — using fallback worker",
      );
      return [
        new Send("worker_phase2", {
          task: {
            task_id: "fallback-v",
            description: "Validate preliminary results",
            search_focus: "Verify the preliminary research findings",
          },
          phase: "phase2",
        }),
      ];
    }

    return tasks.map(
      (task) =>
        new Send("worker_phase2", { task, phase: "phase2" }),
    );
  }

  // -------------------------------------------------------------------
  // Build the StateGraph
  // -------------------------------------------------------------------

  // Use `as any` for the StateGraph builder because LangGraph's strict
  // TypeScript typing requires node name literals to match exactly at
  // the type level, which is incompatible with our dynamic node registration.
  // The runtime behavior is correct — all nodes are registered before edges.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const builder: any = new StateGraph(WorkflowAnnotation);

  // Phase 1 nodes
  builder.addNode("analyzer_phase1", analyzerPhase1);
  builder.addNode("worker_phase1", workerNode);
  builder.addNode("aggregator_phase1", aggregatorPhase1);
  builder.addNode("review_phase1", reviewPhase1);

  // Transition
  builder.addNode("set_phase2", setPhase2);

  // Phase 2 nodes
  builder.addNode("analyzer_phase2", analyzerPhase2);
  builder.addNode("worker_phase2", workerNode);
  builder.addNode("aggregator_phase2", aggregatorPhase2);
  builder.addNode("review_phase2", reviewPhase2);

  // Phase 1 edges
  builder.addEdge(START, "analyzer_phase1");
  builder.addConditionalEdges(
    "analyzer_phase1",
    assignPhase1Workers,
    ["worker_phase1"],
  );
  builder.addEdge("worker_phase1", "aggregator_phase1");
  builder.addEdge("aggregator_phase1", "review_phase1");
  // review_phase1 uses Command to route → analyzer_phase1 or set_phase2

  // Transition edge
  builder.addEdge("set_phase2", "analyzer_phase2");

  // Phase 2 edges
  builder.addConditionalEdges(
    "analyzer_phase2",
    assignPhase2Workers,
    ["worker_phase2"],
  );
  builder.addEdge("worker_phase2", "aggregator_phase2");
  builder.addEdge("aggregator_phase2", "review_phase2");
  // review_phase2 uses Command to route → aggregator_phase2 or END

  // Compile
  const compiled = builder.compile({
    checkpointer: checkpointer as BaseCheckpointSaver | undefined,
    store: store as unknown,
  });

  console.info(
    `[research-agent] graph compiled: ${tools.length} tools, checkpointer=${checkpointer ? "yes" : "none"}, store=${store ? "yes" : "none"}`,
  );

  return compiled;
}

// ---------------------------------------------------------------------------
// Public graph factory
// ---------------------------------------------------------------------------

/**
 * Build a compiled research agent graph from configuration.
 *
 * This is the main factory function registered in the graph registry
 * under the `"research_agent"` ID. It:
 *
 * 1. Parses the configurable dict into typed `ResearchAgentConfig`.
 * 2. Creates a chat model via the multi-provider factory.
 * 3. If `rag` is configured, creates RAG tools.
 * 4. If `mcp_config` is set, fetches tools from remote MCP servers.
 * 5. Calls `buildResearchGraph()` with the model, tools, and settings.
 * 6. Returns the compiled graph (supports `.invoke()` and `.stream()`).
 *
 * @param config - The assistant's configurable dictionary.
 * @param options - Optional checkpointer and store for persistence.
 * @returns A compiled graph ready for invocation.
 *
 * @example
 *   const agent = await graph(
 *     { model_name: "openai:gpt-4o", auto_approve_phase1: true },
 *     { checkpointer: new MemorySaver() },
 *   );
 */
export const graph: GraphFactory = async function graph(
  config: Record<string, unknown>,
  options?: GraphFactoryOptions,
): Promise<unknown> {
  const parsedConfig = parseResearchConfig(config);

  console.info(
    `[research-agent] graph() invoked; model_name=${parsedConfig.modelName}, ` +
      `base_url_present=${Boolean(parsedConfig.baseUrl)}, ` +
      `max_worker_iterations=${parsedConfig.maxWorkerIterations}, ` +
      `auto_approve=(${parsedConfig.autoApprovePhase1}, ${parsedConfig.autoApprovePhase2})`,
  );

  // Create the chat model using the shared multi-provider factory.
  // The react-agent's createChatModel expects GraphConfigValues (snake_case keys).
  // We build a compatible object from our parsed config.
  const modelConfig = {
    model_name: parsedConfig.modelName,
    modelName: parsedConfig.modelName,
    temperature: parsedConfig.temperature,
    max_tokens: parsedConfig.maxTokens,
    maxTokens: parsedConfig.maxTokens,
    base_url: parsedConfig.baseUrl,
    baseUrl: parsedConfig.baseUrl,
    custom_model_name: parsedConfig.customModelName,
    customModelName: parsedConfig.customModelName,
    custom_api_key: parsedConfig.customApiKey,
    customApiKey: parsedConfig.customApiKey,
    system_prompt: parsedConfig.systemPrompt,
    systemPrompt: parsedConfig.systemPrompt,
    mcp_config: null,
    mcpConfig: null,
    rag: null,
  };
  const model = await createChatModel(
    modelConfig as unknown as Parameters<typeof createChatModel>[0],
    config,
  );

  // Build tools list
  const tools: unknown[] = [];

  // Supabase access token for MCP token exchange and RAG authentication
  const supabaseToken =
    typeof config["x-supabase-access-token"] === "string"
      ? (config["x-supabase-access-token"] as string)
      : null;

  // RAG tool loading
  if (
    parsedConfig.rag &&
    parsedConfig.rag.ragUrl &&
    parsedConfig.rag.collections.length > 0 &&
    supabaseToken
  ) {
    try {
      const ragToolConfig = {
        rag_url: parsedConfig.rag.ragUrl,
        ragUrl: parsedConfig.rag.ragUrl,
        collections: parsedConfig.rag.collections,
      };
      const ragTools = await createRagTools(ragToolConfig, supabaseToken);
      tools.push(...ragTools);
      console.info(
        `[research-agent] loaded ${ragTools.length} RAG tools`,
      );
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : String(error);
      console.warn(
        `[research-agent] RAG tool loading failed: ${message}`,
      );
    }
  }

  // MCP tool loading
  if (
    parsedConfig.mcpConfig &&
    parsedConfig.mcpConfig.servers.length > 0
  ) {
    try {
      // Map our McpConfig to the MCPConfig shape expected by fetchMcpTools
      const mcpConfigForFetch = {
        servers: parsedConfig.mcpConfig.servers.map((server) => ({
          name: server.name,
          url: server.url,
          auth_required: server.authRequired,
          tools: server.tools,
        })),
      };
      const mcpTools = await fetchMcpTools(
        mcpConfigForFetch as Parameters<typeof fetchMcpTools>[0],
        supabaseToken,
      );
      tools.push(...mcpTools);
      console.info(
        `[research-agent] loaded ${mcpTools.length} MCP tools`,
      );
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : String(error);
      console.warn(
        `[research-agent] MCP tool loading failed: ${message}`,
      );
    }
  }

  // Build the graph
  const compiled = buildResearchGraph(model, tools, {
    checkpointer: options?.checkpointer,
    store: options?.store,
    maxWorkerIterations: parsedConfig.maxWorkerIterations,
    autoApprovePhase1: parsedConfig.autoApprovePhase1,
    autoApprovePhase2: parsedConfig.autoApprovePhase2,
  });

  console.info(
    `[research-agent] graph ready; tools=${tools.length}, model=${parsedConfig.modelName}`,
  );

  return compiled;
};

// ---------------------------------------------------------------------------
// Exported for testing
// ---------------------------------------------------------------------------

export {
  WorkflowAnnotation,
  WorkerAnnotation,
  buildResearchGraph,
  parseAnalyzerResponse,
  parseAggregatorResponse,
  extractContent,
  tryParseJson,
  normaliseTasks,
};
