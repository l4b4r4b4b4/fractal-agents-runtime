# Multi-Agent Checkpoint Namespace Architecture

> **Status:** v0.0.3 — Initial implementation  
> **Affects:** TS runtime (`apps/ts/`), Python runtime (`apps/python/`), Next.js + Supabase app layer  
> **Last updated:** 2025-02-16

## Table of Contents

- [Problem Statement](#problem-statement)
- [Two Thread Concepts](#two-thread-concepts)
- [Checkpoint Namespace Design](#checkpoint-namespace-design)
  - [Current State (Broken)](#current-state-broken)
  - [Target State](#target-state)
  - [Namespace Policy](#namespace-policy)
- [Runtime Changes](#runtime-changes)
  - [TypeScript Runtime](#typescript-runtime)
  - [Python Runtime](#python-runtime)
  - [Shared Contract](#shared-contract)
- [Message History Strategy](#message-history-strategy)
  - [How Agents Get Conversation Context](#how-agents-get-conversation-context)
  - [How Agents Accumulate Their Own History](#how-agents-accumulate-their-own-history)
- [Interaction Scenarios](#interaction-scenarios)
  - [Single User, Single Agent](#single-user-single-agent)
  - [Single User, Multi-Agent (Default Agent + Delegates)](#single-user-multi-agent-default-agent--delegates)
  - [Multi-User, Multi-Agent (@-mention Triggered)](#multi-user-multi-agent-mention-triggered)
  - [Cross-Runtime (TS Agent Calls Python Agent)](#cross-runtime-ts-agent-calls-python-agent)
  - [Message Edit with Cascading Regeneration](#message-edit-with-cascading-regeneration)
  - [Branching (Discord Thread-like)](#branching-discord-thread-like)
- [Cross-Runtime Checkpoint Compatibility](#cross-runtime-checkpoint-compatibility)
- [App-Side Requirements (Next.js + Supabase)](#app-side-requirements-nextjs--supabase)
  - [Database Schema](#database-schema)
  - [Message → Run Mapping](#message--run-mapping)
  - [Cascading Regeneration Logic](#cascading-regeneration-logic)
  - [Frontend Considerations](#frontend-considerations)
- [API Contract](#api-contract)
  - [Run Creation (App → Runtime)](#run-creation-app--runtime)
  - [Run Response (Runtime → App)](#run-response-runtime--app)
  - [Resume from Checkpoint](#resume-from-checkpoint)
- [Diagrams](#diagrams)
- [FAQ](#faq)

---

## Problem Statement

The Fractal Agents platform supports multi-user, multi-agent chat where:

1. Multiple agents can participate in the same conversation thread.
2. Agents can run on different runtimes (TS on Bun, Python on Robyn).
3. Users can edit messages, triggering cascading regeneration of downstream agent responses.
4. Agents can call other agents via MCP tools or A2A protocol.
5. Single-user flows support resuming, editing, rerunning, and branching (Discord thread-like).

**The core problem:** LangGraph checkpoints store agent execution state (messages, tool calls, HIL interrupts, intermediate reasoning). If multiple agents in the same chat thread share the same checkpoint namespace, they overwrite each other's state, causing:

- Lost HIL interrupt state (agent B's resume overwrites agent A's pending interrupt).
- Corrupted message history (agent B sees agent A's internal tool-call messages).
- Non-deterministic behavior on resume.

---

## Two Thread Concepts

The system has two distinct "thread" concepts that must not be conflated:

### 1. App-Level Thread (Supabase Realtime Chat)

- The Discord/Teams-like conversation visible to users.
- Managed entirely by Supabase (messages table, Realtime subscriptions, RLS).
- Contains messages from all participants (humans and agents).
- Source of truth for "what was said."
- Identity: `app_thread_id` (UUID from Supabase).

### 2. LangGraph Thread (Runtime Execution Context)

- The agent's internal execution state persisted by LangGraph's checkpointer.
- Contains: accumulated messages within the graph, tool call history, pending interrupts, intermediate state.
- NOT directly visible to users (the app extracts the final AI response and writes it to the Supabase chat).
- Identity: `(thread_id, checkpoint_ns, checkpoint_id)` tuple in LangGraph's Postgres checkpointer.

**Key insight:** The `thread_id` passed to LangGraph can be the same as the `app_thread_id`. The `checkpoint_ns` provides the per-agent isolation within that thread.

---

## Checkpoint Namespace Design

### Current State (Broken)

Both runtimes hardcode `checkpoint_ns: ""` everywhere:

**TypeScript** (`apps/ts/src/routes/runs.ts`):
```typescript
// buildRunnableConfig() sets:
configurable.run_id = runId;
configurable.thread_id = threadId;
configurable.assistant_id = assistantId;
// ❌ No checkpoint_ns — all agents share the empty namespace
```

**TypeScript** (`apps/ts/src/storage/postgres.ts`):
```typescript
checkpoint: {
  thread_id: threadId,
  checkpoint_ns: "",  // ❌ Always empty
  checkpoint_id: snapshot.checkpoint_id,
},
```

**Python** (`apps/python/src/server/routes/streams.py`):
```python
configurable["thread_id"] = thread_id
configurable["assistant_id"] = assistant_id
# ❌ No checkpoint_ns set
```

**Python** (`apps/python/src/server/postgres_storage.py`):
```python
checkpoint={
    "thread_id": thread_id,
    "checkpoint_ns": "",  # ❌ Always empty
    "checkpoint_id": _generate_id(),
},
```

**Impact:** Two agents running on the same `thread_id` share the same checkpoint space. The second agent's invocation may see/overwrite the first agent's state.

### Target State

Each agent gets its own checkpoint namespace within a thread, keyed by `assistant_id`:

```
Checkpoint key: (thread_id, checkpoint_ns, checkpoint_id)
                     │            │              │
                     │            │              └── Auto-generated by LangGraph
                     │            └── "assistant:<assistant_id>"
                     └── Same as app_thread_id
```

### Namespace Policy

**Policy: per-assistant namespace**

```
checkpoint_ns = "assistant:<assistant_id>"
```

Why per-assistant (not per-run):

| Policy | Pros | Cons |
|--------|------|------|
| Per-run (`run:<run_id>`) | Strongest isolation | Agent loses memory between invocations in the same thread |
| **Per-assistant** (`assistant:<assistant_id>`) | Agent retains memory across invocations in the thread; HIL resumes correctly | Need explicit cleanup if assistant is reassigned |
| Per-thread (current: `""`) | Simplest | Agents collide; broken for multi-agent |

Per-assistant gives the right semantics:
- Agent A and Agent B in the same thread have independent state.
- Agent A invoked twice in the same thread accumulates message history (via LangGraph's `add_messages` reducer).
- HIL interrupts are scoped to the correct agent.
- Edit/regeneration targets the correct agent's checkpoint.

---

## Runtime Changes

### TypeScript Runtime

#### `apps/ts/src/routes/runs.ts` — `buildRunnableConfig()`

Add `checkpoint_ns` to the configurable dict:

```typescript
// Layer 3: Runtime metadata
configurable.run_id = runId;
configurable.thread_id = threadId;
configurable.assistant_id = assistantId;
configurable.checkpoint_ns = `assistant:${assistantId}`;  // ← NEW
```

#### `apps/ts/src/mcp/agent.ts` — `buildMcpRunnableConfig()`

Same change:

```typescript
configurable.run_id = runId;
configurable.thread_id = threadId;
configurable.assistant_id = assistantId;
configurable.checkpoint_ns = `assistant:${assistantId}`;  // ← NEW
```

#### `apps/ts/src/storage/postgres.ts` — Thread state/history APIs

When returning checkpoint metadata, propagate the namespace instead of hardcoding `""`:

```typescript
checkpoint: {
  thread_id: threadId,
  checkpoint_ns: checkpointNamespace,  // ← From query parameter or stored value
  checkpoint_id: snapshot.checkpoint_id,
},
```

#### `apps/ts/src/storage/memory.ts` — In-memory thread store

Same pattern — store and return the namespace from the run's configurable.

#### `apps/ts/src/routes/streams.ts` — SSE metadata

```typescript
const eventMetadata = {
  // ...existing fields...
  langgraph_checkpoint_ns: checkpointNamespace,  // ← From configurable
};
```

### Python Runtime

#### `apps/python/src/server/routes/streams.py` — `_build_runnable_config()`

```python
# Layer 3: Runtime metadata
configurable["run_id"] = run_id
configurable["thread_id"] = thread_id
configurable["assistant_id"] = assistant_id
configurable["checkpoint_ns"] = f"assistant:{assistant_id}"  # ← NEW
```

#### `apps/python/src/server/agent.py` — `_build_mcp_runnable_config()`

```python
configurable["run_id"] = run_id
configurable["thread_id"] = thread_id
configurable["assistant_id"] = assistant_id
configurable["checkpoint_ns"] = f"assistant:{assistant_id}"  # ← NEW
```

#### `apps/python/src/server/postgres_storage.py` — Thread state/history

Same as TS: propagate namespace instead of hardcoding `""`.

#### `apps/python/src/server/storage.py` — In-memory store

Same pattern.

### Shared Contract

Both runtimes MUST:

1. Set `configurable.checkpoint_ns = "assistant:<assistant_id>"` in all config builders.
2. Pass `checkpoint_ns` through to thread state/history API responses.
3. Use the same namespace format string (`"assistant:"` prefix) so cross-runtime queries work.
4. Accept an optional `checkpoint_ns` parameter in thread state/history queries (for the app to filter by agent).

---

## Message History Strategy

### How Agents Get Conversation Context

There are two complementary mechanisms:

#### 1. LangGraph Checkpoint Accumulation (Agent's Own History)

When an agent is invoked multiple times on the same thread (same `thread_id` + same `checkpoint_ns`), LangGraph's `add_messages` reducer accumulates messages across invocations. This gives the agent "memory" of its own prior interactions in the thread.

**This only includes messages the agent itself produced or received as input.** It does NOT automatically include messages from other agents or users that were added to the Supabase chat between invocations.

#### 2. App-Injected Context (Cross-Agent Awareness)

For an agent to "see" messages from other participants (users, other agents), the app must include relevant context in the `input.messages` array when creating a run.

**Recommended approach:**

```typescript
// App creates a run for Agent B, including relevant recent messages
const run = await client.runs.create(threadId, {
  assistant_id: agentBId,
  input: {
    messages: [
      // Include the last N messages from the Supabase chat for context
      { role: "user", content: "What did Agent A find about logistics?" },
      // Optionally include Agent A's response for cross-agent awareness
      { role: "assistant", content: "Agent A found 3 logistics parks..." },
      // The actual trigger message
      { role: "user", content: "@AgentB Can you verify these findings?" },
    ],
  },
});
```

**Why not share checkpoint state between agents?**

- Agents may have different graph structures (ReAct vs Research Agent).
- Agents may have different tools, producing different tool-call messages.
- Internal reasoning messages (tool calls, intermediate steps) from one agent are noise for another.
- Checkpoint serialization may differ between graph types.

### How Agents Accumulate Their Own History

Within a single `(thread_id, checkpoint_ns)` scope:

1. First invocation: agent receives input messages, processes them, produces output.
2. LangGraph checkpointer saves the state (including all messages).
3. Second invocation: LangGraph loads the checkpoint, applies `add_messages` reducer with new input, agent sees full history.
4. This continues for all subsequent invocations.

This is the standard LangGraph behavior and requires no special handling — it "just works" as long as:
- Same `thread_id` is used.
- Same `checkpoint_ns` is used (our `"assistant:<id>"` policy ensures this).
- The checkpointer is configured (Postgres in production).

---

## Interaction Scenarios

### Single User, Single Agent

```
User → Chat Thread (Supabase) → Runtime → Agent A
                                              │
                                              ├── checkpoint_ns: "assistant:<A_id>"
                                              └── thread_id: "<app_thread_id>"
```

- Simplest case. Works exactly as today.
- Agent accumulates message history via checkpointer.
- Edit/regeneration: app creates new run with edited input, same thread + assistant.

### Single User, Multi-Agent (Default Agent + Delegates)

```
User → Chat Thread → Runtime → Default Agent A
                                    │
                                    ├── MCP call → Agent B (same or different runtime)
                                    │                  └── checkpoint_ns: "assistant:<B_id>"
                                    │                     thread_id: "<app_thread_id>" or new
                                    │
                                    └── checkpoint_ns: "assistant:<A_id>"
                                        thread_id: "<app_thread_id>"
```

- Default agent A is invoked by the user.
- Agent A calls Agent B via MCP tool or A2A.
- Agent B's execution has its own checkpoint namespace.
- If using A2A: the runtime creates a sub-run for Agent B with a separate `checkpoint_ns`.
- If using MCP: Agent B runs as a tool call within Agent A's graph, using Agent A's checkpoint namespace (this is fine — it's Agent A's execution context).

### Multi-User, Multi-Agent (@-mention Triggered)

```
User 1: "Hello everyone"           → Supabase chat only (no agent trigger)
User 2: "@AgentA analyze this"     → App detects mention → creates run for Agent A
Agent A: "Here's my analysis..."   → App writes response to Supabase chat
User 1: "@AgentB verify that"      → App detects mention → creates run for Agent B
Agent B: "I've verified..."        → App writes response to Supabase chat
```

Each agent invocation:
- Gets its own `checkpoint_ns` (keyed by `assistant_id`).
- Receives relevant context from the app as `input.messages`.
- Does NOT see the other agent's internal state.
- CAN see the other agent's public responses (if app includes them in input).

### Cross-Runtime (TS Agent Calls Python Agent)

```
TS Runtime                              Python Runtime
┌──────────────────┐                    ┌──────────────────┐
│ Agent A (TS)     │ ── A2A ──────────> │ Agent B (Python) │
│ ns: assistant:A  │                    │ ns: assistant:B  │
│ thread: T1       │                    │ thread: T1       │
└──────────────────┘                    └──────────────────┘
         │                                       │
         └───── Postgres Checkpointer ───────────┘
               (shared database, separate namespaces)
```

- Both runtimes write to the same Postgres checkpoint tables.
- Namespace isolation prevents collisions.
- **IMPORTANT:** Cross-runtime checkpoint RESUME is not supported (see [Cross-Runtime Checkpoint Compatibility](#cross-runtime-checkpoint-compatibility)). Each runtime can only resume its own checkpoints.
- A2A is the recommended inter-runtime communication mechanism.

### Message Edit with Cascading Regeneration

```
Timeline:
  M1 (user)  → triggers Run R1 (Agent A) → produces M2 (agent A response)
  M3 (user)  → triggers Run R2 (Agent B) → produces M4 (agent B response)
  M5 (user, references M2) → triggers Run R3 (Agent A) → produces M6

User edits M1:
  1. App marks M2 as stale (it was produced by R1, triggered by M1)
  2. App creates new Run R1' for Agent A with edited M1
  3. Agent A produces M2' (new response)
  4. App checks: does M3 reference M2? If yes → cascade
  5. App creates new Run R2' for Agent B with updated context
  6. Continue cascading until N-message limit → notify human for approval
```

**Runtime responsibility:** Accept the re-run request, execute the agent, return the response.  
**App responsibility:** Track the message → run dependency graph, decide what to cascade, enforce the N-message approval limit.

### Branching (Discord Thread-like)

Branching creates a new execution context from a specific point:

```
Main thread: M1 → M2 → M3 → M4
                    │
                    └── Branch: M2 → M5 → M6 (new thread or same thread with fork)
```

**Implementation options:**

1. **New app thread + shared checkpoint start:** App creates a new `app_thread_id`, but the first run includes M1-M2 as context in `input.messages`. No checkpoint continuity — fresh start with historical context.

2. **Same thread, checkpoint fork:** App creates a new run on the same thread, specifying a `checkpoint_id` to resume from. LangGraph creates a new branch in the checkpoint history. The `checkpoint_ns` remains the same (`"assistant:<id>"`).

Option 2 is more elegant but requires the app to track checkpoint IDs per message. Option 1 is simpler and sufficient for most use cases.

---

## Cross-Runtime Checkpoint Compatibility

**Can a checkpoint written by the TS runtime be resumed by the Python runtime (or vice versa)?**

**No.** This is not feasible without a custom cross-language serialization contract because:

1. **Serialization format:** Python LangGraph uses `pickle` or `json` with Python-specific type annotations. JS LangGraph uses its own serialization. The binary checkpoint blobs are not interchangeable.

2. **Message object encoding:** Python `AIMessage`, `HumanMessage`, `ToolMessage` objects serialize differently than their JS counterparts (`@langchain/core/messages`).

3. **Graph structure identity:** Even if both runtimes compile the "same" graph (e.g., `graph_id = "agent"`), the compiled node IDs, edge map, and state reducers may differ in internal representation.

4. **State schema:** Python state annotations (`TypedDict`, Pydantic) vs TypeScript state annotations (interfaces, Zod) produce different schemas. The checkpointer stores state as opaque blobs — it doesn't validate cross-language compatibility.

**Recommended approach:** Use A2A or MCP for cross-runtime communication. Each runtime manages its own checkpoints. The app tracks which runtime owns which agent and routes accordingly.

---

## App-Side Requirements (Next.js + Supabase)

### Database Schema

The app needs tables to track the relationship between chat messages and agent runs:

```sql
-- Existing: Supabase Realtime chat messages
-- (This likely already exists in your chat implementation)
CREATE TABLE public.chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id UUID NOT NULL REFERENCES public.chat_threads(id),
  sender_id UUID REFERENCES auth.users(id),       -- NULL for agent messages
  agent_id UUID REFERENCES public.agents(id),      -- NULL for human messages
  content TEXT NOT NULL,
  metadata JSONB DEFAULT '{}',
  parent_message_id UUID REFERENCES public.chat_messages(id), -- For threading/replies
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  is_deleted BOOLEAN DEFAULT false
);

-- NEW: Map messages to agent runs for edit/regeneration tracking
CREATE TABLE public.message_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID NOT NULL REFERENCES public.chat_messages(id),
  run_id UUID NOT NULL,                            -- LangGraph run_id
  assistant_id UUID NOT NULL,                      -- Which agent produced this
  runtime TEXT NOT NULL DEFAULT 'ts',              -- 'ts' or 'python'
  thread_id UUID NOT NULL,                         -- App-level thread
  trigger_message_id UUID REFERENCES public.chat_messages(id), -- What triggered this run
  checkpoint_id TEXT,                              -- LangGraph checkpoint_id (for branching)
  status TEXT DEFAULT 'completed',                 -- 'pending', 'running', 'completed', 'error'
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Index for cascading regeneration queries
CREATE INDEX idx_message_runs_trigger ON public.message_runs(trigger_message_id);
CREATE INDEX idx_message_runs_thread ON public.message_runs(thread_id);

-- RLS policies (adapt to your auth model)
ALTER TABLE public.message_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view message_runs in their threads"
  ON public.message_runs FOR SELECT
  USING (
    thread_id IN (
      SELECT id FROM public.chat_threads
      WHERE organization_id IN (
        SELECT organization_id FROM public.organization_members
        WHERE user_id = auth.uid()
      )
    )
  );
```

### Message → Run Mapping

When the app creates a run (in response to an @-mention or user message), it should record the mapping:

```typescript
// Next.js Server Action or API route
async function triggerAgentRun(
  threadId: string,
  triggerMessageId: string,
  assistantId: string,
  inputMessages: Message[],
) {
  // 1. Create the run via LangGraph runtime API
  const response = await agentFetch(`/threads/${threadId}/runs/stream`, {
    method: "POST",
    body: JSON.stringify({
      assistant_id: assistantId,
      input: { messages: inputMessages },
      stream_mode: ["events"],
    }),
  });

  // 2. Extract run_id from the stream metadata
  const runId = extractRunIdFromStream(response);

  // 3. Record the mapping in Supabase
  await supabase.from("message_runs").insert({
    run_id: runId,
    assistant_id: assistantId,
    runtime: "ts", // or "python" depending on routing
    thread_id: threadId,
    trigger_message_id: triggerMessageId,
    status: "running",
  });

  // 4. When the agent response is received, create the response message
  // and update the message_runs record
  const agentResponse = await collectStreamResponse(response);
  const responseMessage = await supabase.from("chat_messages").insert({
    thread_id: threadId,
    agent_id: assistantId,
    content: agentResponse.content,
    parent_message_id: triggerMessageId,
  }).select().single();

  await supabase.from("message_runs").update({
    message_id: responseMessage.data.id,
    checkpoint_id: agentResponse.checkpoint_id,
    status: "completed",
  }).eq("run_id", runId);
}
```

### Cascading Regeneration Logic

When a user edits a message that triggered an agent run:

```typescript
async function handleMessageEdit(
  editedMessageId: string,
  newContent: string,
  maxCascadeDepth: number = 5, // N-message limit before asking for approval
) {
  // 1. Update the edited message
  await supabase.from("chat_messages")
    .update({ content: newContent, updated_at: new Date() })
    .eq("id", editedMessageId);

  // 2. Find all runs triggered by this message
  const { data: affectedRuns } = await supabase
    .from("message_runs")
    .select("*, message:message_id(id, content, agent_id)")
    .eq("trigger_message_id", editedMessageId);

  if (!affectedRuns?.length) return; // No agent responses to regenerate

  // 3. Regenerate each affected agent response
  for (const run of affectedRuns) {
    // Mark the old response as stale
    await supabase.from("chat_messages")
      .update({ metadata: { stale: true, replaced_by: null } })
      .eq("id", run.message_id);

    // Re-trigger the agent with updated context
    await triggerAgentRun(
      run.thread_id,
      editedMessageId,
      run.assistant_id,
      buildContextMessages(editedMessageId, newContent),
    );
  }

  // 4. Check for downstream cascade
  for (const run of affectedRuns) {
    const downstreamRuns = await findDownstreamRuns(run.message_id);
    if (downstreamRuns.length > 0) {
      if (downstreamRuns.length > maxCascadeDepth) {
        // Notify the human invoker for approval
        await notifyForCascadeApproval(run, downstreamRuns);
      } else {
        // Auto-cascade
        for (const downstream of downstreamRuns) {
          await handleMessageEdit(downstream.trigger_message_id, downstream.newContent);
        }
      }
    }
  }
}

async function findDownstreamRuns(messageId: string) {
  // Find runs where trigger_message_id references a message
  // that was produced by the run we just regenerated
  const { data } = await supabase
    .from("message_runs")
    .select("*")
    .eq("trigger_message_id", messageId);
  return data ?? [];
}
```

### Frontend Considerations

#### `useStream` Integration

The LangGraph SDK's `useStream` hook works with `thread_id`. Since we're using `checkpoint_ns` for isolation (not changing the `thread_id`), `useStream` continues to work as-is.

The app should pass the `assistant_id` when creating runs — the runtime handles namespace isolation transparently.

```typescript
// This continues to work — no changes needed
const stream = client.runs.stream(threadId, {
  assistant_id: selectedAgentId,
  input: { messages },
  streamMode: ["events"],
});
```

#### Multi-Agent Chat UI

For multi-agent chats, the frontend needs to:

1. **Attribute messages to agents:** Use `agent_id` on `chat_messages` to render agent avatars/names.
2. **Show agent status:** Subscribe to `message_runs` for real-time status (pending, running, completed, error).
3. **Handle @-mentions:** Parse message content for `@AgentName` patterns, resolve to `assistant_id`, trigger the run.
4. **Show stale messages:** When a message is marked `stale` (due to upstream edit), render it with a visual indicator.

#### Branching UI

For Discord thread-like branching:

```typescript
// Create a branch from a specific message
async function createBranch(parentMessageId: string) {
  // Option 1: New thread with context
  const newThread = await agentFetch("/threads", {
    method: "POST",
    body: JSON.stringify({
      metadata: { branched_from: parentMessageId },
    }),
  });

  // Copy relevant messages as context for the new thread
  const contextMessages = await getMessagesUpTo(parentMessageId);
  return { threadId: newThread.thread_id, contextMessages };
}
```

---

## API Contract

### Run Creation (App → Runtime)

```http
POST /threads/{thread_id}/runs/stream
Authorization: Bearer <supabase_access_token>

{
  "assistant_id": "<agent_uuid>",
  "input": {
    "messages": [
      {"role": "user", "content": "..."}
    ]
  },
  "stream_mode": ["events"],
  "config": {
    "configurable": {
      // Optional: app can override checkpoint_ns (advanced use)
      // If omitted, runtime defaults to "assistant:<assistant_id>"
    }
  }
}
```

The runtime:
1. Sets `checkpoint_ns = "assistant:<assistant_id>"` (unless overridden).
2. Loads/creates checkpointer state for `(thread_id, checkpoint_ns)`.
3. Executes the graph with accumulated history + new input.
4. Streams events back to the app.

### Run Response (Runtime → App)

SSE events include metadata for the app to track:

```
event: metadata
data: {"run_id": "...", "thread_id": "...", "assistant_id": "...", "checkpoint_ns": "assistant:<id>"}

event: data
data: {"content": "...", "type": "ai", ...}

event: end
data: {"run_id": "...", "checkpoint_id": "...", "status": "completed"}
```

The `checkpoint_id` in the `end` event is what the app stores in `message_runs` for future branching/replay.

### Resume from Checkpoint

For edit/regeneration or HIL resume:

```http
POST /threads/{thread_id}/runs/stream
Authorization: Bearer <supabase_access_token>

{
  "assistant_id": "<agent_uuid>",
  "input": {
    "messages": [
      {"role": "user", "content": "<edited message>"}
    ]
  },
  "config": {
    "configurable": {
      // Optionally specify a checkpoint to resume from
      "checkpoint_id": "<specific_checkpoint_id>"
    }
  }
}
```

---

## Diagrams

### Checkpoint Namespace Isolation

```
┌─────────────────────────────────────────────────────────┐
│                    Postgres Database                     │
│                                                         │
│  checkpoint_writes / checkpoints tables                 │
│  ┌───────────────────────────────────────────────────┐  │
│  │ thread_id: "app-thread-123"                       │  │
│  │                                                   │  │
│  │  ┌─────────────────────────────────────────────┐  │  │
│  │  │ checkpoint_ns: "assistant:agent-A-uuid"     │  │  │
│  │  │                                             │  │  │
│  │  │  cp-001 → cp-002 → cp-003 (Agent A state)  │  │  │
│  │  └─────────────────────────────────────────────┘  │  │
│  │                                                   │  │
│  │  ┌─────────────────────────────────────────────┐  │  │
│  │  │ checkpoint_ns: "assistant:agent-B-uuid"     │  │  │
│  │  │                                             │  │  │
│  │  │  cp-101 → cp-102 (Agent B state)            │  │  │
│  │  └─────────────────────────────────────────────┘  │  │
│  │                                                   │  │
│  │  ┌─────────────────────────────────────────────┐  │  │
│  │  │ checkpoint_ns: "assistant:agent-C-uuid"     │  │  │
│  │  │                                             │  │  │
│  │  │  cp-201 (Agent C state — single invocation) │  │  │
│  │  └─────────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────┘  │
│                                                         │
│  threads / thread_states tables (runtime storage)       │
│  ┌───────────────────────────────────────────────────┐  │
│  │ thread_id: "app-thread-123"                       │  │
│  │ Stores: last known state per checkpoint_ns        │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

### Multi-Agent Chat Flow

```
┌──────────┐     ┌──────────────┐     ┌─────────────────┐
│ Frontend │     │ Next.js App  │     │ Agent Runtime(s) │
│ (React)  │     │ (Supabase)   │     │ (TS / Python)    │
└────┬─────┘     └──────┬───────┘     └────────┬────────┘
     │                  │                      │
     │ User sends msg   │                      │
     │ "@AgentA help"   │                      │
     ├─────────────────>│                      │
     │                  │                      │
     │                  │ Detect @mention       │
     │                  │ Resolve assistant_id  │
     │                  │                      │
     │                  │ POST /threads/T1/     │
     │                  │   runs/stream         │
     │                  │ { assistant_id: A,    │
     │                  │   input: messages }   │
     │                  ├─────────────────────>│
     │                  │                      │
     │                  │                      │ checkpoint_ns = "assistant:A"
     │                  │                      │ Load checkpoint(T1, ns)
     │                  │                      │ Execute graph
     │                  │                      │ Save checkpoint
     │                  │                      │
     │                  │  SSE: events + end   │
     │                  │<─────────────────────┤
     │                  │                      │
     │                  │ Write agent response  │
     │                  │ to chat_messages      │
     │                  │ Record message_runs   │
     │                  │                      │
     │ Realtime update  │                      │
     │<─────────────────┤                      │
     │                  │                      │
     │ User: "@AgentB   │                      │
     │  verify that"    │                      │
     ├─────────────────>│                      │
     │                  │                      │
     │                  │ POST /threads/T1/     │
     │                  │   runs/stream         │
     │                  │ { assistant_id: B,    │
     │                  │   input: messages     │
     │                  │   (includes A's       │
     │                  │    response) }        │
     │                  ├─────────────────────>│
     │                  │                      │
     │                  │                      │ checkpoint_ns = "assistant:B"
     │                  │                      │ (Independent from A!)
     │                  │                      │
```

---

## FAQ

### Q: Does the app need to pass `checkpoint_ns` when creating runs?

**No.** The runtime sets it automatically from `assistant_id`. The app just passes `thread_id` and `assistant_id` as before. The namespace is an internal runtime concern.

### Q: What if I want an agent to NOT have memory across invocations?

Pass a unique `thread_id` per invocation (e.g., generate a new UUID). Or, if you want per-thread memory but fresh-start semantics, don't use the checkpointer (stateless runs via `/runs` instead of `/threads/{id}/runs`).

### Q: Can I query all agent activity in a thread?

Yes. The checkpoint tables support querying by `thread_id` alone (across all namespaces). The `message_runs` table in your app provides a higher-level view.

### Q: What happens to existing data after enabling namespaces?

Existing checkpoints have `checkpoint_ns = ""`. New checkpoints will use `"assistant:<id>"`. Existing checkpoints won't be found by the new namespace-aware queries. This is a clean break — existing threads effectively start fresh for each agent. If you need migration, you'd need to update existing checkpoint rows with the correct namespace (based on the `assistant_id` in the configurable metadata).

### Q: Does this affect the LangGraph SDK's `useStream` hook?

No. `useStream` works at the `thread_id` level. The namespace is set server-side by the runtime. The SDK doesn't need to know about it.

### Q: What about sub-graphs (LangGraph's internal checkpoint namespacing)?

LangGraph already uses `checkpoint_ns` internally for sub-graph execution (e.g., nested graphs within a parent graph). Our `"assistant:<id>"` namespace is set at the top level and does not conflict with LangGraph's internal sub-graph namespacing, which appends to the namespace with a `|` delimiter (e.g., `"assistant:<id>|sub_graph_node"`).

### Q: The runtime's thread state/history APIs still return `checkpoint_ns: ""` — is that a bug?

**Known limitation in v0.0.3.** There are two separate layers that deal with checkpoints:

1. **Graph execution layer** (`buildRunnableConfig()` → `agent.invoke()` / `agent.stream()`): This is where `checkpoint_ns = "assistant:<id>"` is now set. LangGraph's checkpointer uses this when reading/writing checkpoint state during graph execution. **This is the critical layer for isolation, and it's fixed.**

2. **Runtime storage layer** (`PostgresThreadStore.getState()`, `getHistory()`, `InMemoryThreadStore`): These are the runtime's own thread snapshot APIs (backing `/threads/:id/state` and `/threads/:id/history` endpoints). They currently hardcode `checkpoint_ns: ""` in their return values because they predate namespace support.

**Impact:** The thread state/history API responses report `checkpoint_ns: ""` in the `checkpoint` metadata, even though the actual LangGraph checkpointer is using `"assistant:<id>"` internally. This is a cosmetic/metadata issue — it does NOT affect checkpoint isolation during graph execution.

**Future fix:** Update the storage layer to accept and propagate `checkpoint_ns` (e.g., as a query parameter on the state/history endpoints, or derived from `assistant_id`). This is tracked as a follow-up task, not required for v0.0.3 correctness.

### Q: Should both TS and Python runtimes use the exact same Postgres database?

They can, and that's the recommended setup for shared state. Both runtimes read/write to the same `checkpoints` and `checkpoint_writes` tables (created by LangGraph's setup). Namespace isolation ensures they don't collide. However, cross-runtime checkpoint resume is NOT supported — each runtime can only resume checkpoints it created.