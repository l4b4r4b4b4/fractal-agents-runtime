# Goal 41: FastMCP Supabase User-Data Tool — JWT-Scoped DB & File Storage Access

> **Status:** ⚪ Not Started
> **Priority:** High
> **Created:** 2026-02-23
> **Branch:** TBD (`goal-41-fastmcp-supabase-userdata`)

---

## Overview

Build a **FastMCP server** that receives the user's Supabase JWT from the agent runtime, then uses it to make **RLS-scoped** queries against Supabase Postgres and **signed-URL** access to Supabase Storage — all within the user's permission boundary.

The agent runtime already forwards `x-supabase-access-token` through the MCP config (see `fetch_tokens()` in `apps/python/src/graphs/react_agent/utils/token.py`). This tool receives that JWT and creates a per-request Supabase client that respects Row-Level Security.

### Why This Matters

Today, agents can only interact with Supabase through the runtime's `service_role` connection (bypasses RLS) or through pre-built route handlers. There is no way for an agent to:

- Query the user's documents, repositories, or projects **as the user**
- Upload/download files from Supabase Storage **with the user's permissions**
- Respect org membership, team scoping, and resource_permissions RLS policies

This MCP tool closes that gap: the agent gets scoped data access tools that enforce the same permission model as the webapp.

---

## Architecture

```text
┌─────────────────────────────────────────────────────┐
│  Agent Runtime (Python or TS)                       │
│                                                     │
│  configurable:                                      │
│    x-supabase-access-token: "eyJ..."                │
│    mcp_config.servers:                              │
│      - name: supabase-userdata                      │
│        url: http://supabase-userdata-mcp:8000       │
│        auth_required: true                          │
│                                                     │
│  → Authorization: Bearer <user-jwt>                 │
└─────────────┬───────────────────────────────────────┘
              │ HTTP (Streamable HTTP transport)
              ▼
┌─────────────────────────────────────────────────────┐
│  FastMCP Server (Python)                            │
│  supabase-userdata-mcp                              │
│                                                     │
│  On each tool call:                                 │
│    1. Extract JWT from Authorization header         │
│    2. Create Supabase client with JWT (anon key +   │
│       user access token → RLS-scoped)               │
│    3. Execute query / storage op as the user        │
│    4. Return results to agent                       │
│                                                     │
│  Tools:                                             │
│    - query_table        (read rows via RLS)         │
│    - get_document       (document metadata + URL)   │
│    - list_documents     (scoped to user's repos)    │
│    - search_documents   (full-text / metadata)      │
│    - download_file      (signed URL generation)     │
│    - upload_file        (to user's repository)      │
│    - list_repositories  (user's accessible repos)   │
│    - list_projects      (user's accessible projects)│
│                                                     │
│  Auth: JWT verification via SUPABASE_JWT_SECRET     │
│  DB:   supabase-py client (postgrest, RLS-aware)    │
│  Storage: supabase-py storage (signed URLs)         │
└─────────────────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────────────┐
│  Supabase (local or hosted)                         │
│                                                     │
│  PostgREST (port 3000) ← RLS enforced per JWT      │
│  Storage API (port 5000) ← bucket policies          │
│  Auth (port 9999) ← JWT validation                  │
│                                                     │
│  RLS policies check uid() = auth.jwt()->>'sub'      │
│  which comes from the user's JWT, NOT service_role  │
└─────────────────────────────────────────────────────┘
```

---

## JWT Flow — How the User Token Reaches the MCP Tool

### Current Flow (already implemented)

1. **Webapp** authenticates user → gets Supabase JWT
2. **Webapp** calls agent runtime with `x-supabase-access-token` in configurable
3. **Runtime** calls `fetch_tokens(config)` which reads `configurable["x-supabase-access-token"]`
4. **Runtime** passes `Authorization: Bearer <token>` to MCP servers with `auth_required: true`

### What This Tool Needs

The FastMCP server receives the **raw Supabase user JWT** in the `Authorization` header. It then:

1. **Verifies** the JWT signature using `SUPABASE_JWT_SECRET` (HMAC-SHA256)
2. **Extracts** `sub` (user UUID), `email`, `role`, and `exp` claims
3. **Creates** a Supabase client: `create_client(SUPABASE_URL, SUPABASE_ANON_KEY, headers={"Authorization": f"Bearer {user_jwt}"})`
4. **All queries** go through PostgREST with the user's JWT → RLS is enforced automatically

**Key insight:** The Supabase Python client accepts a user JWT that overrides the anon key for RLS purposes. PostgREST sets `auth.uid()` and `auth.role()` from the JWT, so every query respects the same RLS policies as the webapp.

---

## Tools Design

### 1. `query_table` — Generic RLS-Scoped Read

```python
@mcp.tool()
async def query_table(
    table_name: str,       # e.g. "repositories", "documents", "projects"
    select: str = "*",     # PostgREST select syntax
    filters: dict | None = None,  # {"organization_id": "eq.uuid", "deleted_at": "is.null"}
    order_by: str | None = None,  # e.g. "created_at.desc"
    limit: int = 50,
) -> list[dict]:
    """Query any public table with the user's RLS permissions.
    
    Only returns rows the authenticated user has SELECT access to.
    Filters use PostgREST operator syntax (eq, neq, gt, lt, like, in, is).
    """
```

**Security:** RLS prevents access to rows outside the user's org/permissions. The `table_name` should be validated against an allowlist to prevent querying `auth.*` or system tables.

### 2. `list_repositories` — User's Accessible Repositories

```python
@mcp.tool()
async def list_repositories(
    organization_id: str | None = None,
) -> list[dict]:
    """List repositories the user can access.
    
    Respects visibility rules: organization-scoped repos visible to all org members,
    restricted repos only visible to explicitly granted users/teams.
    """
```

### 3. `list_documents` — Documents in a Repository

```python
@mcp.tool()
async def list_documents(
    repository_id: str,
    content_type: str | None = None,  # filter by MIME type
    limit: int = 100,
) -> list[dict]:
    """List documents in a repository the user has access to.
    
    Returns metadata only (no file content). Use download_file for content.
    """
```

### 4. `get_document` — Single Document Metadata + Signed URL

```python
@mcp.tool()
async def get_document(
    document_id: str,
    include_download_url: bool = True,
) -> dict:
    """Get document metadata and optionally a time-limited download URL.
    
    The signed URL expires after 60 seconds and respects storage bucket policies.
    """
```

### 5. `download_file` — Generate Signed Download URL

```python
@mcp.tool()
async def download_file(
    bucket: str,
    object_path: str,
    expires_in: int = 60,
) -> dict:
    """Generate a signed download URL for a file in Supabase Storage.
    
    The URL is time-limited and scoped to the user's storage permissions.
    Returns {"url": "https://...", "expires_in": 60}.
    """
```

### 6. `upload_file` — Upload to User's Repository

```python
@mcp.tool()
async def upload_file(
    repository_id: str,
    filename: str,
    content_base64: str,
    content_type: str = "application/octet-stream",
) -> dict:
    """Upload a file to a repository the user has write access to.
    
    Content must be base64-encoded. Returns the created document metadata.
    """
```

### 7. `list_projects` — User's Accessible Projects

```python
@mcp.tool()
async def list_projects(
    organization_id: str | None = None,
    status: str | None = None,
) -> list[dict]:
    """List projects the user can access, optionally filtered by status."""
```

### 8. `search_documents` — Full-Text / Metadata Search

```python
@mcp.tool()
async def search_documents(
    query: str,
    organization_id: str | None = None,
    repository_id: str | None = None,
    content_type: str | None = None,
    limit: int = 20,
) -> list[dict]:
    """Search documents by filename or metadata within the user's accessible scope."""
```

---

## Implementation Plan

### Tech Stack

| Component | Choice | Rationale |
|-----------|--------|-----------|
| MCP framework | `fastmcp` (PyPI) | Standard Python MCP server, used by existing tools |
| Supabase client | `supabase-py` | Official client, supports RLS via user JWT |
| JWT verification | `PyJWT` or manual HMAC-SHA256 | Verify before creating client |
| Transport | Streamable HTTP (`/mcp`) | Matches existing MCP server pattern |
| Packaging | Standalone Docker image | Deployed alongside runtime in k8s |

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SUPABASE_URL` | Yes | Supabase project URL (e.g. `http://127.0.0.1:54321`) |
| `SUPABASE_ANON_KEY` | Yes | Supabase anon key (public, used with user JWT for RLS) |
| `SUPABASE_JWT_SECRET` | Yes | For verifying incoming JWTs before trusting them |
| `ALLOWED_TABLES` | No | Comma-separated allowlist (default: safe public tables) |
| `PORT` | No | Server port (default: 8000) |

### File Structure

```
mcp-servers/supabase-userdata/
├── pyproject.toml
├── Dockerfile
├── src/
│   └── supabase_userdata_mcp/
│       ├── __init__.py
│       ├── server.py          # FastMCP app + tool definitions
│       ├── auth.py            # JWT extraction + verification
│       ├── client.py          # Per-request Supabase client factory
│       ├── tools/
│       │   ├── __init__.py
│       │   ├── query.py       # query_table
│       │   ├── documents.py   # list_documents, get_document, search_documents
│       │   ├── storage.py     # download_file, upload_file
│       │   └── navigation.py  # list_repositories, list_projects
│       └── config.py          # Environment config
└── tests/
    ├── test_auth.py
    ├── test_client.py
    └── test_tools.py
```

### Phases

**Phase 1: Foundation** (MVP)
- [ ] Project scaffold (pyproject.toml, Dockerfile)
- [ ] JWT extraction from Authorization header
- [ ] JWT verification (HMAC-SHA256)
- [ ] Per-request Supabase client factory
- [ ] `query_table` tool with table allowlist
- [ ] `list_repositories` tool
- [ ] `list_documents` tool
- [ ] Health check endpoint
- [ ] Unit tests for auth + client factory

**Phase 2: Storage**
- [ ] `get_document` with signed URL
- [ ] `download_file` (signed URL generation)
- [ ] `upload_file` (base64 → storage)
- [ ] Storage bucket permission tests

**Phase 3: Search & Polish**
- [ ] `search_documents` (filename/metadata search)
- [ ] `list_projects`
- [ ] Docker image build + docker-compose entry
- [ ] Register in `mcp_tools` table
- [ ] Integration test with real Supabase

---

## Security Considerations

### Hard Requirements

1. **JWT must be verified** before creating any Supabase client — never trust an unverified token
2. **Table allowlist** — `query_table` must reject requests for `auth.*`, `storage.*`, system catalogs
3. **No service_role key** — this tool ONLY uses the anon key + user JWT; never bypasses RLS
4. **Signed URLs expire** — default 60s, max 3600s, enforced server-side
5. **No SQL injection** — all queries go through PostgREST (parameterized), never raw SQL
6. **Base64 upload size limit** — reject uploads > 10MB (configurable)
7. **Rate limiting** — consider per-user rate limits for storage operations

### What RLS Already Protects

The beauty of this design is that **Supabase RLS does the heavy lifting**:

| Table | RLS Policy | Effect |
|-------|-----------|--------|
| `repositories` | Org members see org repos; restricted repos need explicit grant | User only sees repos they're allowed to |
| `documents` | Org members see org docs; `deleted_at IS NULL` filter | Soft-deleted docs are invisible |
| `projects` | Org members see org projects | Same org-scoping |
| `hardware_keys` | `user_id = uid()` | Users only see their own keys |
| `organization_members` | Various per-role policies | Users see their own memberships |

The MCP tool doesn't need to re-implement any of these checks — it just passes the JWT and PostgREST enforces everything.

### What the MCP Tool Must Still Protect

- **Table allowlist**: Prevent querying `pg_catalog`, `information_schema`, `auth.users` (even though PostgREST won't expose them, defense in depth)
- **Column redaction**: Optionally strip sensitive columns (e.g. `access_token` in `connected_accounts`)
- **Result size limits**: Cap `limit` parameter to prevent massive result sets
- **Upload validation**: MIME type checks, size limits, path traversal prevention

---

## Integration Points

### Runtime Registration

Add to `mcp_tools` table:

```sql
INSERT INTO public.mcp_tools (tool_name, display_name, description, endpoint_url, is_builtin, auth_required, sort_order, tags, pricing_tier)
VALUES (
  'supabase-userdata',
  'Supabase Daten-Zugriff',
  'Greift auf Dokumente, Repositories und Projekte des Benutzers zu — mit den gleichen Berechtigungen wie in der Web-App.',
  'http://supabase-userdata-mcp:8000',
  true,
  true,
  5,
  '{documents,storage,database,builtin}',
  'free'
);
```

### Docker Compose Entry

```yaml
supabase-userdata-mcp:
  build:
    context: ./mcp-servers/supabase-userdata
    dockerfile: Dockerfile
  ports:
    - "8001:8000"
  environment:
    - SUPABASE_URL=http://supabase_kong_immoflow-platform:8000
    - SUPABASE_ANON_KEY=${SUPABASE_ANON_KEY}
    - SUPABASE_JWT_SECRET=${SUPABASE_JWT_SECRET}
    - PORT=8000
  networks:
    - default
    - supabase
  restart: unless-stopped
  healthcheck:
    test: ["CMD", "curl", "-f", "http://localhost:8000/health"]
    interval: 15s
    timeout: 5s
    retries: 3
```

### Agent Config

When an agent has this MCP tool enabled, the runtime builds:

```json
{
  "configurable": {
    "mcp_config": {
      "servers": [
        {
          "name": "supabase-userdata",
          "url": "http://supabase-userdata-mcp:8000",
          "auth_required": true
        }
      ]
    }
  }
}
```

The existing `fetch_tokens()` + `MultiServerMCPClient` flow handles the rest — the user's JWT is forwarded as `Authorization: Bearer <jwt>`.

---

## Open Questions

1. **Token exchange vs. direct JWT?** — The current `fetch_tokens()` does an OAuth token exchange (`grant_type: urn:ietf:params:oauth:grant-type:token-exchange`). Should this tool accept the exchanged token or the raw Supabase JWT? If the raw JWT, we may need to update the token forwarding path.

2. **Separate repo or monorepo?** — Should this MCP server live in `mcp-servers/supabase-userdata/` within the monorepo, or in a separate repository? Monorepo is simpler for shared CI; separate repo is cleaner for independent versioning.

3. **Python or TypeScript?** — FastMCP is Python-native. A TS equivalent could use the `@modelcontextprotocol/sdk` package + `@supabase/supabase-js`. Python is the faster path given existing patterns.

4. **Column redaction scope** — Which columns should be stripped from results? Candidates: `access_token`, `refresh_token`, `token_expires_at` in `connected_accounts`; `public_key` in `hardware_keys` (raw bytes, not useful to agents).

5. **Write operations beyond upload?** — Should the tool support INSERT/UPDATE/DELETE on arbitrary tables, or only read + storage upload? Writes increase the attack surface significantly.

---

## References

- [FastMCP Documentation](https://github.com/jlowin/fastmcp)
- [Supabase Python Client — Auth](https://supabase.com/docs/reference/python/auth-getsession)
- [Supabase RLS — auth.uid()](https://supabase.com/docs/guides/auth/row-level-security)
- [PostgREST — Passing JWT](https://postgrest.org/en/stable/references/auth.html)
- [MCP Streamable HTTP Transport](https://modelcontextprotocol.io/docs/concepts/transports#streamable-http)
- Existing MCP integration: `apps/python/src/graphs/react_agent/agent.py` L339–419
- Token exchange: `apps/python/src/graphs/react_agent/utils/token.py`
- Existing MCP tools table: `public.mcp_tools` (3 entries: document-mcp, supabase-mcp, legal-mcp)