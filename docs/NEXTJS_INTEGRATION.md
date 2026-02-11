# Next.js 16 Integration Guide (Bun)

> Connect your Next.js 16 application to the OAP LangGraph Tools Agent (Robyn Runtime) using Bun as the JavaScript runtime.

This guide covers everything you need to integrate the Robyn agent API into a Next.js 16 frontend with Bun, including authentication, assistant management, streaming chat, and MCP tool integration.

---

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Prerequisites](#prerequisites)
- [Project Setup](#project-setup)
- [Environment Setup](#environment-setup)
- [Authentication](#authentication)
- [LangGraph SDK Client](#langgraph-sdk-client)
- [API Reference Quick Start](#api-reference-quick-start)
  - [Assistants](#assistants)
  - [Threads](#threads)
  - [Runs (Streaming)](#runs-streaming)
- [Streaming Chat Implementation](#streaming-chat-implementation)
  - [SSE Event Format](#sse-event-format)
  - [React Hook](#react-hook)
  - [Full Chat Component](#full-chat-component)
- [Server Actions](#server-actions)
- [MCP Tool Integration](#mcp-tool-integration)
- [Model Configuration](#model-configuration)
  - [Standard Providers](#standard-providers)
  - [Custom vLLM Endpoint](#custom-vllm-endpoint)
- [Docker Compose Deployment](#docker-compose-deployment)
- [Troubleshooting](#troubleshooting)

---

## Overview

The Robyn runtime server exposes a **LangGraph-compatible REST API** with:

- **Supabase JWT authentication** — same tokens your Next.js app already uses
- **SSE streaming** — real-time token-by-token chat responses
- **Postgres persistence** — conversations survive server restarts
- **MCP support** — connect external tool servers (e.g., LangChain docs, custom tools)
- **Langfuse tracing** — full observability of agent runs

**Base URL:** `http://localhost:8081` (local) or your deployed endpoint.

---

## Architecture

```
┌──────────────────┐     JWT Token      ┌──────────────────┐
│  Next.js 16 App  │ ────────────────▶  │  Robyn Server    │
│  (Bun runtime)   │                    │  :8081            │
│                  │ ◀──── SSE ──────  │                  │
│  Supabase Auth   │                    │  ┌────────────┐  │
│  @supabase/ssr   │                    │  │ LangGraph   │  │
└──────────────────┘                    │  │ Agent       │  │
        │                               │  └──────┬─────┘  │
        │                               │         │        │
        ▼                               │    ┌────▼─────┐  │
┌──────────────────┐                    │    │ MCP      │  │
│  Supabase        │ ◀──── Postgres ──  │    │ Servers   │  │
│  (Auth + DB)     │                    │    └──────────┘  │
└──────────────────┘                    └──────────────────┘
```

Your Next.js app authenticates users via Supabase, then passes the JWT to the Robyn server. The server verifies the token with Supabase and scopes all data (assistants, threads, runs) to the authenticated user.

---

## Prerequisites

- **Bun 1.3+** (`curl -fsSL https://bun.sh/install | bash`)
- **Next.js 16.x** (App Router, React 19, Server Components)
- **Supabase project** with authentication configured
- **Robyn server** running (see [Docker Compose Deployment](#docker-compose-deployment))

---

## Project Setup

Create a new Next.js 16 project with Bun:

```bash
bun create next-app@latest my-agent-app
cd my-agent-app
```

Install dependencies:

```bash
bun add @supabase/supabase-js @supabase/ssr @langchain/langgraph-sdk
```

Verify Bun is being used as the runtime:

```bash
# next.config.ts should not need changes — Bun is the default
# runtime when you run `bun --bun next dev`
bun --bun next dev
```

> **Tip:** Always use `bun --bun` to ensure Bun's native runtime is used instead of falling back to Node.js. You can add this to your `package.json` scripts:

```json
{
  "scripts": {
    "dev": "bun --bun next dev --turbopack",
    "build": "bun --bun next build",
    "start": "bun --bun next start"
  }
}
```

---

## Environment Setup

Add these to your `.env.local`:

```bash
# Supabase (same instance the Robyn server uses)
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...your-anon-key...

# Robyn Agent API
NEXT_PUBLIC_AGENT_API_URL=http://localhost:8081
```

---

## Authentication

The Robyn server accepts Supabase JWT tokens in the `Authorization: Bearer <token>` header. Your Next.js app should already have Supabase auth — you just need to forward the session token.

### Supabase Client (Browser)

```typescript
// lib/supabase.ts
import { createBrowserClient } from "@supabase/ssr";

export const supabase = createBrowserClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

export async function getAccessToken(): Promise<string> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session?.access_token) {
    throw new Error("Not authenticated");
  }
  return session.access_token;
}
```

### Authenticated Fetch Helper

```typescript
// lib/agent-api.ts
import { getAccessToken } from "./supabase";

const AGENT_API_URL = process.env.NEXT_PUBLIC_AGENT_API_URL!;

export async function agentFetch(
  path: string,
  options: RequestInit = {}
): Promise<Response> {
  const token = await getAccessToken();
  return fetch(`${AGENT_API_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...options.headers,
    },
  });
}
```

---

## LangGraph SDK Client

The official `@langchain/langgraph-sdk` works with the Robyn server since it implements the same API. This is the **recommended** approach:

```typescript
// lib/langgraph-client.ts
import { Client } from "@langchain/langgraph-sdk";
import { getAccessToken } from "./supabase";

export async function createAgentClient(): Promise<Client> {
  const token = await getAccessToken();
  return new Client({
    apiUrl: process.env.NEXT_PUBLIC_AGENT_API_URL!,
    defaultHeaders: {
      Authorization: `Bearer ${token}`,
    },
  });
}
```

### Using the SDK

```typescript
const client = await createAgentClient();

// Create an assistant
const assistant = await client.assistants.create({
  graphId: "agent",
  name: "My Chat Assistant",
  config: {
    configurable: {
      model_name: "openai:gpt-4o-mini",
    },
  },
});

// Create a thread
const thread = await client.threads.create();

// Stream a run
const stream = client.runs.stream(thread.thread_id, assistant.assistant_id, {
  input: {
    messages: [{ role: "user", content: "Hello!" }],
  },
  streamMode: ["messages-tuple"],
});

for await (const event of stream) {
  if (event.event === "messages") {
    const [message] = event.data;
    if (message.content) {
      process.stdout.write(message.content);
    }
  }
}
```

---

## API Reference Quick Start

All endpoints require `Authorization: Bearer <supabase-jwt>` except `/health`, `/info`, `/ok`, and `/docs`.

### Assistants

Assistants hold the model configuration, system prompt, and MCP settings. They are scoped to the authenticated user.

```typescript
// Create
const response = await agentFetch("/assistants", {
  method: "POST",
  body: JSON.stringify({
    graph_id: "agent",
    name: "My Assistant",
    config: {
      configurable: {
        model_name: "openai:gpt-4o-mini",
        temperature: 0.7,
        max_tokens: 4000,
        system_prompt: "You are a helpful assistant.",
      },
    },
  }),
});
const assistant = await response.json();
// assistant.assistant_id → "abc123..."

// Get
const detail = await agentFetch(`/assistants/${assistantId}`).then((r) =>
  r.json()
);

// Search (list all yours)
const assistants = await agentFetch("/assistants/search", {
  method: "POST",
  body: JSON.stringify({ limit: 50 }),
}).then((r) => r.json());

// Update
await agentFetch(`/assistants/${assistantId}`, {
  method: "PATCH",
  body: JSON.stringify({
    name: "Renamed Assistant",
    config: {
      configurable: { model_name: "openai:gpt-4.1-mini" },
    },
  }),
});

// Delete
await agentFetch(`/assistants/${assistantId}`, { method: "DELETE" });
```

### Threads

Threads represent conversations. Each thread has its own message history persisted in Postgres.

```typescript
// Create
const thread = await agentFetch("/threads", {
  method: "POST",
  body: JSON.stringify({ metadata: { topic: "general" } }),
}).then((r) => r.json());
// thread.thread_id → "def456..."

// Get
const detail = await agentFetch(`/threads/${threadId}`).then((r) => r.json());

// Get thread history (all checkpoints)
const history = await agentFetch(`/threads/${threadId}/history`).then((r) =>
  r.json()
);

// Get thread state (latest checkpoint)
const state = await agentFetch(`/threads/${threadId}/state`).then((r) =>
  r.json()
);

// Search
const threads = await agentFetch("/threads/search", {
  method: "POST",
  body: JSON.stringify({ limit: 20 }),
}).then((r) => r.json());

// Delete (cascades to runs)
await agentFetch(`/threads/${threadId}`, { method: "DELETE" });
```

### Runs (Streaming)

Runs execute the agent. Use streaming for real-time token delivery.

```typescript
// Stream a run
const response = await agentFetch(`/threads/${threadId}/runs/stream`, {
  method: "POST",
  body: JSON.stringify({
    assistant_id: assistantId,
    input: {
      messages: [{ role: "user", content: "What is 2 + 2?" }],
    },
    stream_mode: ["messages-tuple"],
  }),
});

// The response is an SSE stream — see "Streaming Chat Implementation" below
```

---

## Streaming Chat Implementation

### SSE Event Format

The server emits Server-Sent Events in this order:

| Event | Description |
|-------|-------------|
| `metadata` | `{"run_id": "...", "attempt": 1}` |
| `values` | Initial state with input messages |
| `messages` | `[message_delta, metadata]` — streaming token chunks |
| `error` | `{"error": "...", "code": "..."}` — if something fails |
| `values` | Final state with complete messages |

Each `messages` event contains a **tuple** `[message, metadata]`:

```json
[
  {
    "content": "Hello",
    "type": "ai",
    "response_metadata": { "model_provider": "openai" }
  },
  {
    "run_id": "abc123",
    "thread_id": "def456",
    "langgraph_node": "model",
    "ls_model_name": "gpt-4o-mini"
  }
]
```

- **Token deltas**: Each `messages` event has a small `content` string (a few characters)
- **Finish signal**: The last `messages` event has `"finish_reason": "stop"` in `response_metadata`
- **Tool calls**: When the model calls a tool, `finish_reason` is `"tool_calls"`

### React Hook

```typescript
// hooks/use-agent-stream.ts
"use client";

import { useState, useCallback, useRef } from "react";
import { getAccessToken } from "@/lib/supabase";

interface Message {
  role: "user" | "assistant";
  content: string;
}

interface UseAgentStreamOptions {
  assistantId: string;
  threadId: string;
}

export function useAgentStream({
  assistantId,
  threadId,
}: UseAgentStreamOptions) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const sendMessage = useCallback(
    async (content: string) => {
      setMessages((prev) => [
        ...prev,
        { role: "user", content },
        { role: "assistant", content: "" },
      ]);
      setIsStreaming(true);

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const token = await getAccessToken();
        const response = await fetch(
          `${process.env.NEXT_PUBLIC_AGENT_API_URL}/threads/${threadId}/runs/stream`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
              assistant_id: assistantId,
              input: { messages: [{ role: "user", content }] },
              stream_mode: ["messages-tuple"],
            }),
            signal: controller.signal,
          }
        );

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let currentEvent = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (line.startsWith("event: ")) {
              currentEvent = line.slice(7).trim();
            } else if (
              line.startsWith("data: ") &&
              currentEvent === "messages"
            ) {
              try {
                const [delta] = JSON.parse(line.slice(6));
                if (delta?.content && delta.type === "ai") {
                  setMessages((prev) => {
                    const updated = [...prev];
                    const last = updated.length - 1;
                    updated[last] = {
                      ...updated[last],
                      content: updated[last].content + delta.content,
                    };
                    return updated;
                  });
                }
              } catch {
                /* skip malformed lines */
              }
            } else if (
              line.startsWith("data: ") &&
              currentEvent === "error"
            ) {
              try {
                const errorData = JSON.parse(line.slice(6));
                console.error("Agent error:", errorData.error);
                setMessages((prev) => {
                  const updated = [...prev];
                  const last = updated.length - 1;
                  updated[last] = {
                    ...updated[last],
                    content: `Error: ${errorData.error}`,
                  };
                  return updated;
                });
              } catch {
                /* skip */
              }
            }
          }
        }
      } catch (error) {
        if ((error as Error).name !== "AbortError") {
          console.error("Stream error:", error);
        }
      } finally {
        setIsStreaming(false);
        abortRef.current = null;
      }
    },
    [assistantId, threadId]
  );

  const stop = useCallback(() => abortRef.current?.abort(), []);

  return { messages, isStreaming, sendMessage, stop, setMessages };
}
```

### Full Chat Component

```tsx
// components/chat.tsx
"use client";

import { useState, useEffect, useRef } from "react";
import { useAgentStream } from "@/hooks/use-agent-stream";
import { agentFetch } from "@/lib/agent-api";

export function Chat({ assistantId }: { assistantId: string }) {
  const [threadId, setThreadId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  // Create a thread on mount
  useEffect(() => {
    agentFetch("/threads", {
      method: "POST",
      body: JSON.stringify({}),
    })
      .then((r) => r.json())
      .then((thread) => setThreadId(thread.thread_id));
  }, []);

  const { messages, isStreaming, sendMessage, stop } = useAgentStream({
    assistantId,
    threadId: threadId || "",
  });

  // Auto-scroll
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isStreaming || !threadId) return;
    sendMessage(input.trim());
    setInput("");
  };

  if (!threadId) return <p>Creating conversation…</p>;

  return (
    <div className="flex flex-col h-full max-w-2xl mx-auto">
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.map((msg, i) => (
          <div
            key={i}
            className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
          >
            <div
              className={`max-w-[80%] rounded-lg px-4 py-2 ${
                msg.role === "user"
                  ? "bg-blue-600 text-white"
                  : "bg-gray-100 text-gray-900"
              }`}
            >
              <p className="whitespace-pre-wrap">{msg.content}</p>
              {isStreaming &&
                i === messages.length - 1 &&
                msg.role === "assistant" && (
                  <span className="inline-block w-2 h-4 bg-gray-400 animate-pulse ml-1" />
                )}
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      <form onSubmit={handleSubmit} className="border-t p-4 flex gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Type a message…"
          className="flex-1 border rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
          disabled={isStreaming}
        />
        {isStreaming ? (
          <button
            type="button"
            onClick={stop}
            className="px-4 py-2 bg-red-500 text-white rounded-lg hover:bg-red-600"
          >
            Stop
          </button>
        ) : (
          <button
            type="submit"
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
            disabled={!input.trim()}
          >
            Send
          </button>
        )}
      </form>
    </div>
  );
}
```

### Usage in a Page

```tsx
// app/chat/page.tsx
import { Chat } from "@/components/chat";

export default function ChatPage() {
  return (
    <main className="h-screen">
      <Chat assistantId="your-assistant-id-here" />
    </main>
  );
}
```

---

## Server Actions

Next.js 16 Server Actions run on the server and can securely access secrets. Use them to keep Supabase service role keys out of the client:

```typescript
// app/actions/agent.ts
"use server";

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

const AGENT_API_URL = process.env.NEXT_PUBLIC_AGENT_API_URL!;

async function getServerToken(): Promise<string> {
  const cookieStore = await cookies();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: { getAll: () => cookieStore.getAll() } }
  );
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) throw new Error("Not authenticated");
  return session.access_token;
}

export async function createAssistant(name: string, modelName: string) {
  const token = await getServerToken();
  const response = await fetch(`${AGENT_API_URL}/assistants`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      graph_id: "agent",
      name,
      config: { configurable: { model_name: modelName } },
    }),
  });
  return response.json();
}

export async function createThread() {
  const token = await getServerToken();
  const response = await fetch(`${AGENT_API_URL}/threads`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({}),
  });
  return response.json();
}

export async function listAssistants() {
  const token = await getServerToken();
  const response = await fetch(`${AGENT_API_URL}/assistants/search`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ limit: 50 }),
  });
  return response.json();
}
```

---

## MCP Tool Integration

MCP (Model Context Protocol) lets the agent call external tool servers at runtime. Configure MCP in the assistant's `config.configurable.mcp_config`:

```typescript
// Create an assistant with LangChain docs MCP server
const assistant = await agentFetch("/assistants", {
  method: "POST",
  body: JSON.stringify({
    graph_id: "agent",
    name: "Docs Research Assistant",
    config: {
      configurable: {
        model_name: "openai:gpt-4o-mini",
        system_prompt:
          "You are a research assistant. Use the available tools to search documentation and answer questions accurately.",
        mcp_config: {
          url: "https://docs.langchain.com/mcp",
          auth_required: false,
        },
      },
    },
  }),
}).then((r) => r.json());
```

### MCP Config Fields

| Field | Type | Description |
|-------|------|-------------|
| `url` | `string` | MCP server endpoint URL. If it ends with `/mcp`, used as-is. Otherwise `/mcp` is appended. |
| `tools` | `string[]` (optional) | Filter to specific tool names. If omitted, all tools from the server are loaded. |
| `auth_required` | `boolean` | Whether the MCP server requires authentication (Supabase token forwarding). |

### Example MCP Servers

```typescript
// LangChain documentation search
{ url: "https://docs.langchain.com/mcp", auth_required: false }

// Your own internal MCP server (with auth)
{ url: "https://mcp.your-company.com", auth_required: true }

// Filter to specific tools only
{ url: "https://docs.langchain.com/mcp", auth_required: false, tools: ["search_docs"] }
```

When the agent uses MCP tools, the SSE stream shows the tool call flow:

1. `messages` event with `finish_reason: "tool_calls"` — model wants to call a tool
2. (tool execution happens server-side)
3. `messages` events resume with the model's response based on tool results

---

## Model Configuration

### Standard Providers

Use the `provider:model` format. The API key is read from the server's environment variables or passed via `apiKeys` in the config.

```typescript
// OpenAI
{ model_name: "openai:gpt-4o" }
{ model_name: "openai:gpt-4o-mini" }
{ model_name: "openai:gpt-4.1" }
{ model_name: "openai:gpt-4.1-mini" }
{ model_name: "openai:o3-mini" }

// Anthropic
{ model_name: "anthropic:claude-sonnet-4-0" }
{ model_name: "anthropic:claude-3-5-sonnet-latest" }
{ model_name: "anthropic:claude-3-5-haiku-latest" }

// Google
{ model_name: "google_genai:gemini-2.0-flash" }
```

### Custom vLLM Endpoint

For self-hosted models via vLLM or any OpenAI-compatible API:

```typescript
{
  model_name: "ministral-3b-instruct",  // served model name
  base_url: "http://ministral:80/v1",   // vLLM endpoint (Docker-internal)
  // custom_api_key: "..."              // optional, defaults to "EMPTY"
}
```

> **Note:** vLLM has stricter content block validation than OpenAI. MCP tool results with structured content may fail on vLLM. Use standard providers (OpenAI, Anthropic) for MCP + tool calling workflows.

### Passing API Keys from the Frontend

If users manage their own API keys (e.g., in a settings page), pass them via the run config:

```typescript
const response = await agentFetch(`/threads/${threadId}/runs/stream`, {
  method: "POST",
  body: JSON.stringify({
    assistant_id: assistantId,
    input: { messages: [{ role: "user", content: "Hello" }] },
    config: {
      configurable: {
        apiKeys: {
          OPENAI_API_KEY: "sk-...",
          ANTHROPIC_API_KEY: "sk-ant-...",
        },
      },
    },
    stream_mode: ["messages-tuple"],
  }),
});
```

---

## Docker Compose Deployment

### Starting the Full Stack

```bash
# From the oap-langgraph-tools-agent directory
docker compose up robyn-server ministral -d --build
```

This starts:

- **Robyn server** at `http://localhost:8081` — the agent API
- **Ministral** (vLLM) at `http://localhost:7374` — local LLM (GPU required)

The Robyn server connects to your existing Supabase instance via the `supabase_network_immoflow-platform` Docker network.

### Without Local LLM (OpenAI Only)

If you only need OpenAI/Anthropic models and don't have a GPU:

```yaml
# docker-compose.override.yml
services:
  robyn-server:
    depends_on: []  # Remove ministral dependency
```

```bash
docker compose up robyn-server -d --build
```

### Verify the Stack

```bash
# Health check
curl http://localhost:8081/health
# → {"status":"ok","persistence":"postgres"}

# Full capabilities
curl http://localhost:8081/info | bun -e "console.log(JSON.stringify(JSON.parse(await Bun.stdin.text()), null, 2))"
```

### Required Environment Variables

Your `.env` file (in the agent repo, not Next.js) needs:

```bash
# Supabase (required)
SUPABASE_URL="http://127.0.0.1:54321"
SUPABASE_KEY="your-service-role-key"

# Database (auto-configured in Docker Compose)
DATABASE_URL="postgresql://postgres:postgres@supabase_db:5432/postgres"

# Model API keys (at least one required)
OPENAI_API_KEY="sk-..."
# ANTHROPIC_API_KEY="sk-ant-..."

# Langfuse tracing (optional)
LANGFUSE_PUBLIC_KEY="pk-lf-..."
LANGFUSE_SECRET_KEY="sk-lf-..."
LANGFUSE_BASE_URL="https://cloud.langfuse.com"
```

---

## Troubleshooting

### Common Issues

**401 Unauthorized**

- Verify your Supabase JWT is valid and not expired
- Check that the Robyn server's `SUPABASE_URL` and `SUPABASE_KEY` match your Supabase instance
- The `SUPABASE_KEY` must be the **service role key** (not the anon key)

**Connection refused on port 8081**

- Ensure the Robyn server container is running: `docker compose ps`
- Check container logs: `docker compose logs robyn-server`

**Streaming stops or hangs**

- Check the `error` SSE event in the stream — it contains the error message
- Verify the model API key is valid (check `OPENAI_API_KEY` etc.)
- For vLLM: ensure the model server is healthy at `http://localhost:7374/health`

**MCP tools not loading**

- Verify the MCP server URL is reachable from inside the Docker container
- Check the Robyn server logs for `Failed to fetch MCP tools: ...`
- For external MCP servers (e.g., `https://docs.langchain.com/mcp`), ensure the container has internet access

**`AGENT_INIT_ERROR: Unable to infer model provider`**

- Use the `provider:model` format: `openai:gpt-4o-mini`, not just `gpt-4o-mini`
- For vLLM/custom endpoints, set `base_url` in the assistant config

**`resource temporarily unavailable` in container logs**

- This is a `nproc` (process limit) issue — the container's user UID shares the host's process quota
- Fix: ensure `ulimits.nproc` is set in the robyn-server service in `docker-compose.yml`

**Bun-specific: `crypto` or `node:` import issues**

- Ensure you're on Bun 1.3+ which has full Node.js API compatibility
- Use `bun --bun next dev` (the `--bun` flag is critical)

### Checking Langfuse Traces

If Langfuse is configured, every agent run is traced. Check your [Langfuse dashboard](https://cloud.langfuse.com) and filter by:

- `trace_name: "agent-stream"` for streaming runs
- `user_id` matches the Supabase user ID
- `session_id` matches the thread ID

### API Documentation

The Robyn server includes auto-generated OpenAPI docs:

- **Swagger UI**: `http://localhost:8081/docs`
- **OpenAPI JSON**: `http://localhost:8081/openapi.json`

---

## Further Reading

- [Robyn Runtime README](../robyn_server/README.md) — server architecture and all API endpoints
- [Robyn Deployment Guide](../robyn_server/DEPLOYMENT.md) — production deployment
- [LangGraph SDK Docs](https://langchain-ai.github.io/langgraph/cloud/reference/sdk/python_sdk_ref/) — official SDK reference
- [Open Agent Platform](https://github.com/langchain-ai/open-agent-platform) — the full OAP UI
- [Supabase Auth Docs](https://supabase.com/docs/guides/auth) — authentication setup
- [Bun Documentation](https://bun.sh/docs) — Bun runtime reference
- [Next.js 16 Docs](https://nextjs.org/docs) — App Router, Server Actions, React 19