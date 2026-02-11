# Goal 16: User × Agent Store Namespacing (Org-Scoped)

> **Status:** 🟡 In Progress
> **Priority:** High
> **Created:** 2026-02-22
> **Branch:** per-task branches (see below)
> **Depends on:** Goal 15 (Startup Agent Sync — 🟢 Tasks 01–04 merged, Task-05 tests remaining)

---

## Problem Statement

The LangGraph `Store` (`AsyncPostgresStore`) is a cross-thread key-value store passed to every agent invocation via `create_agent(store=store)`. It currently uses **flat `(user_id, category)` namespaces**, meaning:

- All agents running for the same user **share the same namespace**
- Rechts-Assistent's learned facts about German law bleed into Dokumenten-Assistent's document context
- The webapp (docproc-platform) cannot write **agent-specific context** for a user
- There is no organization-level scoping — data from one org could theoretically be accessed by another
- No isolation between agents for runtime-learned memories

### Current Namespace Convention (Fixed by Task-01)

```
# BEFORE (broken — flat, no isolation):
(user_id, "tokens")     → MCP token cache — shared across ALL agents for a user

# AFTER (Task-01 — org-scoped):
(org_id, user_id, assistant_id, "tokens")  → MCP token cache — per org × user × agent
```

---

## Solution: Org-Scoped Namespace Convention

### Namespace Format

```
(org_id, user_id, agent_id, category)
```

Four components, each serving a clear purpose:

| Component | Source | Purpose |
|---|---|---|
| `org_id` | `AgentSyncData.organization_id` (from sync) | Top-level isolation; Supabase RLS enforces org membership |
| `user_id` | JWT `identity` (from auth) | Per-user isolation within org |
| `agent_id` | `assistant_id` = Supabase agent UUID (from sync) | Per-agent isolation within user |
| `category` | Convention (see below) | Type of stored data |

### Standard Categories

| Category | Writer | Reader | Description |
|---|---|---|---|
| `"tokens"` | Runtime | Runtime | MCP token cache (per agent) |
| `"context"` | Webapp | Runtime | Webapp-provided agent-specific user context |
| `"memories"` | Runtime | Runtime | Runtime-learned facts persisted across threads |
| `"preferences"` | Webapp / Runtime | Runtime | User preferences for this agent |

### Special Namespace Variants

```
# Organization-wide shared context (all users in org see this)
(org_id, "shared", agent_id, category)
# Example: org-wide legal templates for Rechts-Assistent

# User-global context (shared across all agents for a user in an org)
(org_id, user_id, "global", category)
# Example: Alice's preferred citation format (applies to all agents)
```

### Why NOT Encode Repo/Team/Project

- **Loose coupling**: repos can move between teams, projects span repos — baking IDs into namespace keys means migrating data when relationships change
- **Runtime doesn't care**: it just needs org + user + agent to scope data correctly
- **Supabase RLS handles access control**: row-level policies enforce "user X can only see store items for orgs they belong to" — no need for the store namespace to encode the full hierarchy
- **Additive later**: going from `(org, user, agent, category)` to `(org, user, agent, project, category)` is additive, not breaking

### Permissions: Supabase RLS, Not Runtime

| Concern | Owner | Mechanism |
|---|---|---|
| **"Where does data live?"** | Store namespace | `(org_id, user_id, agent_id, category)` |
| **"Who can access what?"** | Supabase RLS + webapp | Policies on `organization_members`, etc. |

The runtime validates `namespace[0]` matches the user's org (from JWT/sync). Supabase RLS handles the rest (team/project/repo access).

---

## Architecture

### Separation of Concerns

| Responsibility | Owner | Mechanism |
|---|---|---|
| **Define namespace convention** | Both (agreed contract) | `(org_id, user_id, agent_id, category)` |
| **Write user+agent context** | Webapp (docproc-platform) | `PUT /store/items` with correct namespace |
| **Read user+agent context at runtime** | Runtime (robyn-server / graph) | Agent reads from its scoped namespace |
| **Write learned facts at runtime** | Runtime (agent during chat) | Agent writes to its scoped namespace |
| **Enforce namespace isolation** | Supabase RLS + runtime auth | RLS for org membership; auth guard validates `namespace[0:2]` |

### Data Flow

```
Webapp (docproc-platform)
  │
  ├─ Agent sync creates assistant with ID = agent UUID (Goal 15 ✅)
  │   → provides org_id + agent_id for namespace construction
  │
  ├─ Webapp writes user-specific agent context:
  │     PUT /store/items
  │     namespace: "{org_id}/{user_id}/{agent_id}/context"
  │     key: "jurisdiction"
  │     value: {"region": "Bavaria", "court_level": "Landgericht"}
  │
  └─ User starts chat with Rechts-Assistent
        │
        └─ Runtime (graph):
              ├─ org_id = from synced agent config
              ├─ assistant_id = agent UUID (from sync)
              ├─ user_id = JWT identity
              ├─ store.aget((org_id, user_id, assistant_id, "context"), "jurisdiction")
              │     → {"region": "Bavaria", ...}
              ├─ Agent uses this context in responses
              └─ Agent writes learned facts:
                    store.aput((org_id, user_id, assistant_id, "memories"), "citation_pref", "APA")
```

### Permissions Model: Namespace-Position-Based (Not Unix rwx)

Rather than implementing a full `user:group:other` + `rwx` permission model (which would duplicate what Supabase RLS already does), permissions are derived from **namespace position**:

| Namespace Pattern | Who Can Read | Who Can Write | Enforcement |
|---|---|---|---|
| `(org_id, user_id, agent_id, category)` | That user only | That user only | Auth guard: `namespace[1] == user_id` |
| `(org_id, "shared", agent_id, category)` | All org members | Org admins only | Auth guard: role check for writes |
| `(org_id, user_id, "global", category)` | That user only | That user only | Auth guard: `namespace[1] == user_id` |

**Why not Unix-style permissions:**
- Supabase RLS already enforces org membership (who can *reach* the data)
- The auth guard already enforces user identity from JWT
- Adding `rwx` bits creates two permission enforcement points = two places for bugs
- Namespace position gives you the same expressiveness with zero extra state to manage

**Where this might evolve:**
- If fine-grained sharing is needed later (e.g., "Alice shares her Rechts-Assistent context with Bob"), add a `(org_id, "shared-with", target_user_id, agent_id, category)` namespace pattern — still position-based, no permission bits
- Team-scoped shared context: `(org_id, "team", team_id, agent_id, category)` — Supabase RLS validates team membership

### Store API Namespace Format

The Robyn Store API (`/store/items`) uses flat string namespaces. Convention:

- **HTTP API**: slash-separated string `"{org_id}/{user_id}/{agent_id}/{category}"`
- **Internal**: converted to tuple `(org_id, user_id, agent_id, category)`
- **No backward compatibility**: this is v0.0.0 greenfield

---

## Tasks

### Task-01: Define Namespace Convention & Update Token Cache — 🟢 Complete

**PR:** [#13](https://github.com/l4b4r4b4b4/oap-langgraph-tools-agent/pull/13) | **Branch:** `feature/store-namespace-convention`

**What was done:**
- Created `tools_agent/utils/store_namespace.py` — canonical namespace helper (single source of truth)
  - `build_namespace()`, `extract_namespace_components()`, `NamespaceComponents` NamedTuple
  - Category constants: `CATEGORY_TOKENS`, `CATEGORY_CONTEXT`, `CATEGORY_MEMORIES`, `CATEGORY_PREFERENCES`
  - Special pseudo-IDs: `SHARED_USER_ID`, `GLOBAL_AGENT_ID`
- Edited `robyn_server/agent_sync.py` — added `supabase_organization_id` to `_build_assistant_configurable()`
  - Bridges the gap: org_id now flows from sync → configurable → graph()
- Edited `tools_agent/utils/token.py` — token cache uses `(org_id, user_id, assistant_id, "tokens")`
  - All 5 store operations updated, `thread_id` dependency removed
- 550/550 tests pass, ruff clean

### Task-02: Update Robyn Store API for Structured Namespaces

**Scope:**
- Update `robyn_server/routes/store.py` to parse slash-separated namespace strings
- Update `robyn_server/storage.py:StoreStorage` to handle tuple namespaces internally
- Validate namespace format on write (must have 4 components)
- Ensure `/store/items` API accepts `"{org_id}/{user_id}/{agent_id}/{category}"`
- Search API supports prefix matching (e.g., all items for a user in an org)

**Files to modify:**
- `robyn_server/routes/store.py` — namespace parsing/validation
- `robyn_server/storage.py` — StoreStorage tuple namespace handling

### Task-03: Update Auth Guard for Org-Scoped Namespaces

**Scope:**
- Update `robyn_server/auth.py` — validate `namespace[0]` is an org the user belongs to
- For robyn-server: the user's org memberships come from JWT claims or a DB lookup
- For LangGraph runtime: `tools_agent/security/auth.py:authorize_store()` validates namespace[0:2]
- Reject writes where `namespace[1] != user_id` (users can't write to other users' namespaces)
- Exception: `"shared"` pseudo-user for org-wide data (requires org admin role?)

**Files to modify:**
- `robyn_server/auth.py` — org-scoped namespace validation
- `tools_agent/security/auth.py` — update `authorize_store()`

### Task-04: Wire Agent Runtime to Use Scoped Namespaces

**Scope:**
- In `tools_agent/agent.py:graph()`, ensure store access uses `(org_id, user_id, assistant_id, ...)`
- `org_id` is available from the synced assistant config metadata (`supabase_organization_id`)
- Options:
  - Create a namespace-scoped store wrapper that auto-prefixes operations
  - Or pass namespace components through config and let consuming code construct them
- Update any code that accesses the store (currently just `token.py`)

**Files to modify:**
- `tools_agent/agent.py` — pass org_id + user_id + assistant_id to store consumers
- Possibly new: `tools_agent/utils/scoped_store.py` — namespace-scoped store wrapper

### Task-05: Documentation & Testing

**Scope:**
- Document the namespace convention and Store API contract
- Integration test: webapp writes context → agent reads it at runtime
- Unit tests: namespace parsing, auth guard, scoped store wrapper
- Test org isolation: user in org A cannot access org B's store data

**Files to create:**
- `docs/STORE_NAMESPACING.md` — namespace convention documentation
- `robyn_server/tests/test_store_namespacing.py` — tests

---

## Key Files Reference

### Runtime (this repo)
- `tools_agent/agent.py` — `graph()`, `create_agent(store=store)`
- `tools_agent/utils/token.py` — `get_tokens()`, `set_tokens()` — current store usage
- `tools_agent/security/auth.py` — `authorize_store()` — namespace auth guard (LangGraph runtime)
- `robyn_server/storage.py` — `StoreStorage` class (in-memory), `StoreItem`
- `robyn_server/routes/store.py` — `/store/items` HTTP API
- `robyn_server/database.py` — `AsyncPostgresStore` lifecycle (Postgres-backed)
- `robyn_server/agent_sync.py` — agent sync (provides `organization_id` + deterministic `assistant_id`)
- `robyn_server/auth.py` — Robyn auth middleware

### Webapp (docproc-platform — consumer)
- Supabase schema: `organizations`, `organization_members`, `teams`, `projects`, `agents`, etc.
- Store API client (to be implemented in webapp)
- Agent config UI (uses `langgraph_assistant_id` from sync)

### Supabase Data Model (check with MCP)
- `public.organizations` — org table
- `public.organization_members` — user↔org membership
- `public.teams` / `public.projects` / `public.repositories` — hierarchy (permissions only, not in namespace)
- `public.agents` — agents belong to organizations (has `organization_id`)
- `public.agent_mcp_tools` — agent↔tool assignments

---

## Existing Store Capabilities

### LangGraph AsyncPostgresStore
- Tuple namespaces: `(component1, component2, ...)`
- Key-value pairs within namespaces
- `aget(namespace, key)`, `aput(namespace, key, value)`, `adelete(namespace, key)`
- Prefix-based search
- Already wired into `create_agent(store=store)` in `graph()`

### Robyn Store API (HTTP)
- `PUT /store/items` — store/update items
- `GET /store/items` — retrieve by namespace + key
- `DELETE /store/items` — delete by namespace + key
- `POST /store/items/search` — search by prefix within namespace
- `GET /store/namespaces` — list all namespaces for user
- All endpoints require authentication (JWT)
- Owner isolation: each user only sees their own store items

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| `org_id` not available in runtime config | Namespace construction fails | Agent sync already writes `supabase_organization_id` in assistant metadata |
| Webapp writes to wrong namespace format | Agent doesn't see context | Validate namespace format in Store API (must have 4 slash-separated components) |
| Store size growth (per-org × per-user × per-agent) | Postgres bloat | Add TTL/cleanup for stale entries (future) |
| Org-wide "shared" namespace needs admin role | Unauthorized writes | Validate role in auth guard for `"shared"` pseudo-user namespace |
| Supabase schema differs from assumptions | Query/namespace mismatch | Task-01 starts by checking actual schema via `supabase-local-dev-server` MCP |

---

## Success Criteria

### Namespace Isolation
- [ ] Two agents for the same user have separate store namespaces
- [ ] Agent A cannot read Agent B's store data (different `agent_id` in namespace)
- [ ] Users in Org A cannot access Org B's store data (different `org_id`)
- [ ] Token cache is scoped per org + user + agent

### Webapp Integration
- [ ] Webapp writes context via `PUT /store/items` with namespace `"{org_id}/{user_id}/{agent_id}/context"`
- [ ] Agent reads webapp-provided context at runtime from the correct namespace
- [ ] Webapp writes org-wide shared context with namespace `"{org_id}/shared/{agent_id}/context"`

### Runtime Memory
- [ ] Agent writes learned facts to `(org_id, user_id, agent_id, "memories")` namespace
- [ ] Facts persist across threads (cross-thread memory with new namespacing)
- [ ] Agent reads its own memories on subsequent conversations

### Auth & Security (Namespace-Position-Based Permissions)
- [ ] Auth guard validates `namespace[0]` matches user's org membership
- [ ] Auth guard validates `namespace[1]` matches `user_id` (except for `"shared"`)
- [ ] `"shared"` namespace: all org members can read, only org admins can write
- [ ] Store API rejects malformed namespaces (wrong number of components)
- [ ] No Unix-style permission bits — access derived from namespace position + Supabase RLS

---

## Session Log

### Session 75 (2026-02-22) — Task-01 Implemented

**Completed:** Task-01 (Namespace Convention & Token Cache Update)
- Verified Supabase schema via MCP: `organizations`, `organization_members`, `agents` confirmed
- Identified key gap: `supabase_organization_id` was in assistant metadata but not configurable
- Created `store_namespace.py` as single source of truth for namespace construction
- Updated `agent_sync.py` to inject org_id into configurable
- Updated `token.py` to use 4-component org-scoped namespace
- PR #13 created, CI pending

### Session 74 (2026-02-22) — Goal Created

**Context:** After implementing Goal 15 (Startup Agent Sync), discussed how the LangGraph Store relates to agent sync. Key insights:

1. Store should be namespaced by `(org_id, user_id, agent_id, category)` for proper isolation
2. Store data management (writing context) is the **webapp's responsibility**
3. Runtime's job is to **scope store access** to the correct namespace
4. **Supabase RLS handles permissions** (org/team/project access) — don't encode full hierarchy in namespace
5. Agent sync (Goal 15) provides deterministic `assistant_id` (= Supabase agent UUID) and `organization_id` — both needed for namespace construction
6. No backward compatibility needed — this is v0.0.0 greenfield

**Decision:** Org-scoped `(org_id, user_id, agent_id, category)` namespace with Supabase RLS for permission enforcement. Repo/team/project scoping stays in Supabase policies, not in store namespace keys.

**Permissions decision:** Namespace-position-based access (not Unix `user:group:other` + `rwx`). Reasoning: Supabase RLS already handles org/team/role authorization. Adding permission bits to store items would create two enforcement points and duplicate what RLS does natively. Instead, the namespace position itself determines access: `namespace[1] == user_id` → user-private, `namespace[1] == "shared"` → org-wide read / admin write.

**Prerequisite:** Verify Goal 15 works end-to-end (sync agents, check logs, test chat with real MCP tools). Check Supabase data model via `supabase-local-dev-server` MCP before implementing.