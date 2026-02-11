# Goal 14: Agent Persistence (Supabase/Postgres)

> **Status**: ⚪ Not Started
> **Priority**: P2 (Medium)
> **Created**: 2026-02-11
> **Updated**: 2026-02-11
> **Depends On**: Goal 12 (Postgres Persistence)

## Overview

Persist created agent definitions (compiled graph configurations, tool bindings, model settings) in the Supabase Postgres database so they survive server restarts, can be versioned, shared across instances, and managed as first-class entities. Currently, agents are ephemeral — the `graph()` factory in `tools_agent/agent.py` builds a fresh agent on every invocation from inline config. Goal 12 persists the Robyn runtime *metadata* (assistants, threads, runs), but the agent *definitions* themselves — the graph architecture, tool wiring, and compilation parameters — are not stored or versioned.

## Problem Statement

### What exists today

1. **Single hardcoded graph factory** — `tools_agent/agent.py:graph()` is the only agent. It's referenced in `langgraph.json` as `"agent": "./tools_agent/agent.py:graph"`.
2. **Assistants ≠ Agents** — Assistants (Goal 12) are lightweight config wrappers (`graph_id`, `config.configurable`). They point to a graph by name but don't define the graph itself.
3. **No agent registry** — there's no way to register multiple graph types, version them, or discover available agent architectures at runtime.
4. **No agent versioning** — when the `graph()` function changes (new tools, different model defaults), all assistants are affected simultaneously. No rollback possible.
5. **No agent templates** — users can't save a working agent configuration as a reusable template.

### What this goal adds

A persistent agent registry in Postgres where agent definitions are stored, versioned, and queryable. This enables:
- **Multi-graph support** — register different agent architectures (e.g., RAG-only agent, tool-calling agent, research agent)
- **Agent versioning** — track changes to agent definitions over time, roll back if needed
- **Agent templates** — save and share proven agent configurations
- **Runtime discovery** — API endpoints to list/describe available agent types
- **Instance-independent** — agent definitions available on any server instance connected to the same database

## Success Criteria

- [ ] Agent definitions table in `langgraph_server` schema (or equivalent)
- [ ] Agent definition includes: graph factory reference, default config, tool bindings, system prompt template, model constraints
- [ ] Agent versioning — each update creates a new version, previous versions queryable
- [ ] API endpoints: list agents, get agent by ID, create agent, update agent (new version)
- [ ] Assistants reference agent definitions by ID + version (not just `graph_id` string)
- [ ] Default agent definition seeded on startup (current `graph()` factory)
- [ ] Backward compatible — existing `graph_id: "agent"` continues to work
- [ ] Agent definitions persist across server restarts
- [ ] All existing tests pass

## Current Architecture

```
Assistant (runtime metadata)          Agent (code, ephemeral)
┌──────────────────────────┐         ┌─────────────────────────┐
│ assistant_id: UUID       │         │ tools_agent/agent.py    │
│ graph_id: "agent"        │────────▶│   graph(config) →       │
│ config.configurable:     │         │     create_agent(...)   │
│   model_name: "openai:…" │         │                         │
│   system_prompt: "..."   │         │ Single hardcoded factory│
│   mcp_config: {...}      │         │ No versioning           │
│   rag: {...}             │         │ No persistence          │
└──────────────────────────┘         └─────────────────────────┘
```

### Target Architecture

```
Assistant (runtime)         Agent Definition (persisted)       Graph Factory (code)
┌───────────────────┐      ┌───────────────────────────┐      ┌──────────────────┐
│ assistant_id: UUID│      │ agent_id: UUID             │      │ tools_agent/     │
│ agent_id: UUID    │─────▶│ name: "tools-agent"        │─────▶│   agent.py:graph │
│ agent_version: 3  │      │ version: 3                 │      │                  │
│ config: {...}     │      │ graph_factory: "agent.py"  │      │ (or future:      │
│                   │      │ default_config: {...}       │      │  custom graphs)  │
│                   │      │ tool_bindings: [...]        │      │                  │
│                   │      │ system_prompt_template: "…" │      └──────────────────┘
│                   │      │ model_constraints: {...}    │
│                   │      │ created_at, updated_at      │
│                   │      │ created_by: user_id         │
│                   │      └───────────────────────────┘
└───────────────────┘
```

## Proposed Tasks

| Task ID | Description | Status | Depends On |
|---------|-------------|--------|------------|
| Task-01 | Research & Design — agent definition schema, versioning strategy, API surface | ⚪ | - |
| Task-02 | Database Schema — DDL for agent_definitions table in `langgraph_server` schema | ⚪ | Task-01 |
| Task-03 | Agent Registry — Postgres-backed agent registry with CRUD + versioning | ⚪ | Task-02 |
| Task-04 | API Endpoints — REST endpoints for agent management (list, get, create, update) | ⚪ | Task-03 |
| Task-05 | Assistant Integration — link assistants to agent definitions by ID + version | ⚪ | Task-03 |
| Task-06 | Testing — unit tests, integration tests, backward compatibility verification | ⚪ | Task-04, Task-05 |

> **Note**: Task breakdown is preliminary. Full research (Task-01) will refine scope and may split/merge tasks.

## Schema Design (Draft)

```sql
CREATE SCHEMA IF NOT EXISTS langgraph_server;

CREATE TABLE langgraph_server.agent_definitions (
    agent_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL UNIQUE,
    description     TEXT,
    graph_factory   TEXT NOT NULL,          -- e.g., "tools_agent/agent.py:graph"
    version         INTEGER NOT NULL DEFAULT 1,
    default_config  JSONB NOT NULL DEFAULT '{}',
    tool_bindings   JSONB NOT NULL DEFAULT '[]',
    system_prompt_template TEXT,
    model_constraints JSONB DEFAULT '{}',   -- allowed models, temperature ranges, etc.
    metadata        JSONB NOT NULL DEFAULT '{}',
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_by      UUID,                   -- references auth.users
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Version history (append-only)
CREATE TABLE langgraph_server.agent_definition_versions (
    id              BIGSERIAL PRIMARY KEY,
    agent_id        UUID NOT NULL REFERENCES langgraph_server.agent_definitions(agent_id),
    version         INTEGER NOT NULL,
    default_config  JSONB NOT NULL,
    tool_bindings   JSONB NOT NULL,
    system_prompt_template TEXT,
    model_constraints JSONB,
    change_summary  TEXT,
    created_by      UUID,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (agent_id, version)
);

-- Link assistants to agent definitions
-- (extends existing assistants table or adds FK)
ALTER TABLE langgraph_server.assistants
    ADD COLUMN IF NOT EXISTS agent_id UUID
        REFERENCES langgraph_server.agent_definitions(agent_id),
    ADD COLUMN IF NOT EXISTS agent_version INTEGER;
```

> **Note**: This schema is a draft. Task-01 research will finalize the design.

## API Surface (Draft)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/agents` | List all active agent definitions |
| GET | `/agents/:agent_id` | Get agent definition by ID |
| GET | `/agents/:agent_id/versions` | List version history |
| GET | `/agents/:agent_id/versions/:version` | Get specific version |
| POST | `/agents` | Create a new agent definition |
| PATCH | `/agents/:agent_id` | Update agent (creates new version) |
| DELETE | `/agents/:agent_id` | Soft-delete (set is_active=false) |

## Risks

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| Over-engineering for single-graph use case | High | Medium | Start minimal — registry + versioning only. Templates and multi-graph are future enhancements. |
| Schema migration conflicts with Goal 12 tables | Medium | Low | Both use `langgraph_server` schema; coordinate DDL carefully |
| Graph factory references become stale (code moves) | Medium | Medium | Validate factory references at startup; warn on missing factories |
| Agent versioning adds complexity to assistant creation | Medium | Medium | Default to latest version; explicit version only when pinning |
| Breaking change to assistant model (adding agent_id FK) | High | Medium | Make FK optional (nullable); existing assistants continue to work with `graph_id` string |

## Dependencies

- **Upstream**: Goal 12 (Postgres Persistence) — requires `langgraph_server` schema and database module
- **Downstream**: None identified yet, but multi-agent orchestration would build on this

## Constraints

- **Backward compatible** — existing `graph_id: "agent"` must continue to work
- **Same Storage interface pattern** — follow Goal 12's approach (Postgres-backed class, in-memory fallback)
- **No breaking API changes** — new endpoints only; existing assistant endpoints unchanged
- **Agent definitions are metadata, not code** — the graph factory function lives in Python code; the definition stores configuration and references

## Notes & Decisions

### Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-02-11 | Goal created as P2 after Postgres persistence | Foundation (Goal 12) needed first |
| 2026-02-11 | Separate from Goal 12 assistant persistence | Assistants are runtime instances; agent definitions are the blueprint layer above them |
| 2026-02-11 | Version history as append-only table | Enables rollback and audit trail without complicating the primary table |

### Open Questions

- [ ] Should agent definitions be scoped per-user/org or global? (multi-tenancy)
- [ ] How does this interact with OAP UI? Does the frontend need to know about agent types?
- [ ] Should the `graph_factory` reference support dynamic loading (plugin system) or just static references?
- [ ] Is JSONB sufficient for `tool_bindings` or do we need a normalized tools table?
- [ ] Should we support agent definition import/export (JSON files) for portability?
- [ ] How does this relate to LangGraph's own deployment/versioning if we ever use LangGraph Cloud?

## References

- Goal 12 scratchpad — Postgres persistence foundation
- `tools_agent/agent.py` — current single graph factory
- `robyn_server/models.py` — Assistant model (`graph_id` field)
- `robyn_server/storage.py` — current in-memory assistant storage
- `langgraph.json` — static graph registry (single entry)