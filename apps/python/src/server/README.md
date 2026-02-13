# Robyn Runtime Server

A high-performance Rust-based HTTP server for the Open Agent Platform (OAP) LangGraph Tools Agent, providing full compatibility with the LangGraph API.

## Overview

This Robyn-based runtime server replaces `langgraph dev` with a production-ready alternative that offers:

- **🚀 Performance**: Rust-powered HTTP runtime for lower latency
- **🔒 Security**: Built-in Supabase JWT authentication
- **📊 Observability**: Prometheus metrics and detailed info endpoints
- **🌊 Streaming**: Full SSE (Server-Sent Events) support for real-time agent execution
- **💾 Storage**: Key-value Store API for long-term memory

## Quick Start

### Prerequisites

- Python 3.11+ (tested with 3.12)
- UV package manager
- Supabase instance (for authentication)
- LLM backend (OpenAI, vLLM, or compatible)

### Installation

The Robyn server is installed as part of the project dependencies:

```bash
# From project root
uv sync
```

### Configuration

Copy the example environment file and configure your settings:

```bash
cp .env.example .env
```

Required environment variables:

```bash
# Supabase Authentication
SUPABASE_URL="http://127.0.0.1:54321"
SUPABASE_KEY="your-supabase-anon-or-service-key"

# LLM Configuration
OPENAI_API_KEY="your-api-key"
# OR for vLLM/OpenAI-compatible endpoints:
OPENAI_API_BASE="http://localhost:8001/v1"

# Optional: Server Configuration
ROBYN_HOST="0.0.0.0"
ROBYN_PORT="8081"
ROBYN_WORKERS="1"
ROBYN_DEV="false"
```

### Running the Server

```bash
# Run from project root
uv run python -m robyn_server

# Or from robyn_server directory
cd robyn_server
uv run python -m robyn_server
```

The server will start on `http://localhost:8081` by default.

### Testing the Server

Run the unit tests:

```bash
cd robyn_server
uv run pytest tests/ -v
```

Run manual integration tests:

```bash
# From project root
uv run python test_robyn_manual.py
uv run python test_tier2_endpoints.py
uv run python test_tier3_endpoints.py
```

## API Endpoints

The Robyn runtime implements the LangGraph API specification with three tiers of functionality:

### Tier 1 — Core Functionality (Complete ✅)

Essential endpoints for end-to-end agent execution:

**System**
- `GET /health` — Health check (Robyn-specific)
- `GET /ok` — LangGraph-style health check
- `GET /` — Service information
- `GET /info` — Detailed service information

**Assistants**
- `POST /assistants` — Create assistant
- `GET /assistants/{assistant_id}` — Get assistant
- `PATCH /assistants/{assistant_id}` — Update assistant
- `DELETE /assistants/{assistant_id}` — Delete assistant

**Threads**
- `POST /threads` — Create thread
- `GET /threads/{thread_id}` — Get thread
- `GET /threads/{thread_id}/state` — Get thread state
- `GET /threads/{thread_id}/history` — Get thread history
- `PATCH /threads/{thread_id}` — Update thread
- `DELETE /threads/{thread_id}` — Delete thread

**Runs (Stateful)**
- `POST /threads/{thread_id}/runs` — Create background run
- `GET /threads/{thread_id}/runs/{run_id}` — Get run status
- `POST /threads/{thread_id}/runs/stream` — **Create and stream run (SSE)**
- `GET /threads/{thread_id}/runs` — List runs for thread

**Runs (Stateless)**
- `POST /runs/stream` — **Stateless streaming execution (SSE)**

### Tier 2 — Developer Experience (Complete ✅)

Convenience endpoints for search, listing, and stream management:

**Search & Count**
- `POST /assistants/search` — Search/list assistants
- `POST /assistants/count` — Count assistants
- `POST /threads/search` — Search/list threads
- `POST /threads/count` — Count threads

**Join Streams**
- `GET /threads/{thread_id}/runs/{run_id}/stream` — Join existing run stream
- `GET /threads/{thread_id}/stream` — Subscribe to thread activity

### Tier 3 — Platform Features (Complete ✅)

Advanced platform capabilities:

**Store API** (Complete ✅)
- `GET /store/items` — Get item by namespace/key
- `PUT /store/items` — Put item
- `DELETE /store/items` — Delete item
- `POST /store/items/search` — Search items

**Metrics** (Complete ✅)
- `GET /metrics` — Prometheus metrics
- `GET /metrics/json` — Metrics in JSON format

**Crons API** (Complete ✅)
- `POST /runs/crons` — Create a cron job (scheduled recurring runs)
- `POST /runs/crons/search` — Search crons with filters
- `POST /runs/crons/count` — Count matching crons
- `DELETE /runs/crons/{cron_id}` — Delete a cron job

**A2A Protocol** (Complete ✅)
- `POST /a2a/{assistant_id}` — JSON-RPC 2.0 endpoint for Agent-to-Agent communication
  - `message/send` — Send message and wait for result
  - `message/stream` — Send message with SSE streaming
  - `tasks/get` — Retrieve task status
  - `tasks/cancel` — Cancel task (returns not-supported)

**MCP Protocol** (Complete ✅)
- `POST /mcp/` — JSON-RPC 2.0 Model Context Protocol endpoint
  - `initialize` — Client handshake with capabilities
  - `tools/list` — Returns available tools
  - `tools/call` — Execute agent with message
  - `ping` — Health check
- `GET /mcp/` — Returns 405 (streaming not supported)
- `DELETE /mcp/` — Returns 404 (stateless, no sessions)

### Auto-Generated API Documentation

OpenAPI documentation is auto-generated and available at:

```
http://localhost:8081/docs
```

## Authentication

All API endpoints (except `/health`, `/ok`, `/`, `/info`, `/metrics`) require authentication.

### JWT Authentication

Requests must include a valid Supabase JWT token:

```bash
curl -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  http://localhost:8081/assistants
```

### Ownership Isolation

The server enforces strict ownership:

- On **create**: Automatically stamps `metadata.owner = user_id` from JWT
- On **read/search/list**: Filters results to `metadata.owner == user_id`
- Users can only access their own assistants, threads, and runs

### Public Endpoints

The following endpoints are public (no auth required):

- `/health` — Server health check
- `/ok` — LangGraph health format
- `/` — Root service info
- `/info` — Detailed service information
- `/metrics` — Prometheus metrics (for scraping)
- `/metrics/json` — Metrics in JSON

## Streaming (SSE)

The Robyn runtime implements full Server-Sent Events (SSE) streaming for real-time agent execution.

### SSE Endpoints

- `POST /threads/{thread_id}/runs/stream` — Create run and stream results
- `POST /runs/stream` — Stateless streaming execution
- `GET /threads/{thread_id}/runs/{run_id}/stream` — Join existing stream
- `GET /threads/{thread_id}/stream` — Subscribe to thread activity

### SSE Event Types

Events are emitted in the following order:

1. `metadata` — Run ID and attempt number
2. `values` — Initial state with input messages
3. `messages/metadata` — Rich invocation metadata
4. `messages/partial` — Streaming token chunks (multiple events)
5. `updates` — Graph node updates
6. `values` — Final state with complete messages

### Example Client

```python
import httpx

headers = {"Authorization": f"Bearer {jwt_token}"}
data = {
    "assistant_id": "asst_123",
    "input": {"messages": [{"role": "human", "content": "Hello!"}]}
}

with httpx.stream("POST", "http://localhost:8081/runs/stream", 
                  json=data, headers=headers) as response:
    for line in response.iter_lines():
        if line.startswith("event:"):
            event_type = line.split(":", 1)[1].strip()
        elif line.startswith("data:"):
            event_data = line.split(":", 1)[1].strip()
            print(f"{event_type}: {event_data}")
```

## Storage

The server uses in-memory storage by default, with owner-scoped isolation.

### In-Memory Storage

Current implementation:

- Thread-safe dictionary-based storage
- Automatic owner filtering on all operations
- Data lost on server restart
- Suitable for development and testing

### Future: Persistent Storage

Planned migration to Supabase Postgres:

- Persistent data across restarts
- Scalable for production workloads
- Compatible with LangGraph checkpoint format
- Owner isolation via database queries

### Store API

The Store API provides long-term key-value storage:

```python
# Put item
PUT /store/items?namespace=user_prefs&key=theme
{"value": "dark", "metadata": {...}}

# Get item
GET /store/items?namespace=user_prefs&key=theme

# Search items
POST /store/items/search
{"namespace": "user_prefs", "filter": {...}}

# Delete item
DELETE /store/items?namespace=user_prefs&key=theme
```

## Metrics & Observability

### Prometheus Metrics

Available at `/metrics` in Prometheus exposition format:

```
# HELP robyn_requests_total Total HTTP requests
# TYPE robyn_requests_total counter
robyn_requests_total{method="POST",path="/runs/stream",status="200"} 42

# HELP robyn_request_duration_seconds Request duration in seconds
# TYPE robyn_request_duration_seconds histogram
robyn_request_duration_seconds_bucket{le="0.1"} 35
```

### JSON Metrics

Available at `/metrics/json`:

```json
{
  "runtime": {
    "uptime_seconds": 3600,
    "python_version": "3.12.0"
  },
  "storage": {
    "assistants": 5,
    "threads": 12,
    "runs": 28,
    "store_items": 156
  },
  "agent": {
    "total_runs": 42,
    "active_streams": 2
  }
}
```

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                   Robyn Server (Rust)                   │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ┌──────────────┐  ┌──────────────┐  ┌─────────────┐  │
│  │ Auth Middle  │  │  API Routes  │  │   Metrics   │  │
│  │(Supabase JWT)│  │ (37 routes)  │  │ (Prometheus)│  │
│  └──────┬───────┘  └──────┬───────┘  └─────────────┘  │
│         │                 │                            │
│         v                 v                            │
│  ┌──────────────────────────────────┐                 │
│  │       Storage Layer              │                 │
│  │  (In-memory → Postgres later)    │                 │
│  └──────────────┬───────────────────┘                 │
│                 │                                      │
│                 v                                      │
│  ┌──────────────────────────────────┐                 │
│  │      Agent Executor              │                 │
│  │  (tools_agent.agent.graph)       │                 │
│  └──────────────┬───────────────────┘                 │
│                 │                                      │
│                 v                                      │
│         ┌───────────────┐                              │
│         │  LLM Backend  │                              │
│         │ (OpenAI/vLLM) │                              │
│         └───────────────┘                              │
└─────────────────────────────────────────────────────────┘
```

## Testing

### Unit Tests (240+ passing)

```bash
cd robyn_server
uv run pytest tests/ -v
```

Test coverage:

- Authentication middleware (41 tests)
- Storage layer (owner isolation, CRUD)
- All API routes (assistants, threads, runs, store)
- SSE streaming logic
- Metrics collection

### Integration Tests

**Manual E2E Test** (with vLLM):

```bash
uv run python test_robyn_manual.py
```

**Tier 2 Endpoints**:

```bash
uv run python test_tier2_endpoints.py
```

**Tier 3 Platform Features**:

```bash
uv run python test_tier3_endpoints.py
```

### vLLM Backend Setup

For local testing with vLLM on AKS:

```bash
# Port-forward vLLM service
kubectl port-forward svc/ministral-vllm 8001:80 -n testing

# Configure in .env
OPENAI_API_BASE=http://localhost:8001/v1
```

## Deployment

See [DEPLOYMENT.md](./DEPLOYMENT.md) for detailed deployment instructions including:

- Docker containerization
- Environment configuration
- AKS/Kubernetes deployment
- Production best practices

## Development

### Project Structure

```
robyn_server/
├── __init__.py          # Package initialization
├── __main__.py          # CLI entry point
├── app.py               # Main Robyn app + routes registration
├── auth.py              # JWT authentication middleware
├── config.py            # Environment configuration
├── models.py            # Pydantic models for API
├── storage.py           # In-memory storage layer
├── routes/              # API route handlers
│   ├── assistants.py    # Assistant CRUD + search
│   ├── threads.py       # Thread CRUD + search
│   ├── runs.py          # Run CRUD + polling
│   ├── streams.py       # SSE streaming execution
│   ├── sse.py           # SSE utilities
│   ├── store.py         # Store API
│   ├── metrics.py       # Metrics endpoints
│   └── helpers.py       # Shared utilities
├── tests/               # Unit tests
│   ├── test_auth.py
│   ├── test_storage.py
│   ├── test_routes_*.py
│   └── ...
├── CAPABILITIES.md      # Endpoint parity tracking
├── README.md            # This file
└── DEPLOYMENT.md        # Deployment guide
```

### Adding New Routes

1. Create route handler in `routes/`:

```python
def register_my_routes(app: Robyn) -> None:
    @app.get("/my-endpoint")
    async def my_handler(request: Request) -> Response:
        return json_response({"status": "ok"})
```

2. Register in `app.py`:

```python
from robyn_server.routes.my_routes import register_my_routes

register_my_routes(app)
```

3. Add tests in `tests/test_routes_my.py`

### Code Quality

The project follows strict code quality standards:

- **Type hints**: All public functions have type annotations
- **Docstrings**: All public APIs documented
- **Testing**: ≥73% code coverage maintained
- **Linting**: Ruff (PEP8 + additional checks)
- **Formatting**: Ruff formatter

Run quality checks:

```bash
cd robyn_server
uv run ruff check . --fix
uv run ruff format .
uv run pytest tests/ --cov=robyn_server --cov-report=term-missing
```

## Comparison with `langgraph dev`

| Feature | langgraph dev | Robyn Runtime |
|---------|---------------|---------------|
| Runtime | Python (FastAPI) | Rust (Robyn) |
| Performance | Good | Excellent |
| SSE Streaming | ✅ | ✅ |
| Authentication | Basic | Supabase JWT |
| Store API | ✅ | ✅ |
| Metrics | Basic | Prometheus |
| Crons | ✅ | ⏳ Planned |
| A2A Protocol | ✅ | ⏳ Planned |
| MCP Endpoints | ✅ | ⏳ Planned |
| Production Ready | Development | Yes |

## Troubleshooting

### Common Issues

**Server won't start:**
- Check that port 8081 is available: `lsof -i :8081`
- Verify environment variables are set: `cat .env`
- Check logs for configuration errors

**Authentication errors:**
- Verify Supabase URL and key are correct
- Test JWT token validity: `jwt.io`
- Ensure token is not expired

**SSE streaming fails:**
- Check LLM backend is accessible
- Verify `OPENAI_API_BASE` or `OPENAI_API_KEY` is set
- Test LLM endpoint directly with curl

**Tests failing:**
- Ensure you're in the `robyn_server/` directory
- Check Python version: `python --version` (3.11+ required)
- Clean pytest cache: `rm -rf .pytest_cache __pycache__`

### Debug Mode

Enable debug logging:

```bash
export ROBYN_DEV="true"
uv run python -m robyn_server
```

## Contributing

See the main project [.rules](./../.rules) file for:

- Development workflow
- Code style guidelines
- Testing requirements
- PR submission process

## License

This project inherits the license from the parent Open Agent Platform project.

## Related Documentation

- [CAPABILITIES.md](./CAPABILITIES.md) — Detailed endpoint parity tracking
- [DEPLOYMENT.md](./DEPLOYMENT.md) — Production deployment guide
- [Main Project README](../README.md) — Overall project documentation
- [LangGraph API Reference](https://langchain-ai.github.io/langgraph/cloud/reference/api/api_ref.html)
- [Robyn Documentation](https://robyn.tech/documentation)

## Status

**Current Version**: 0.0.1

**Implementation Status**:
- ✅ Tier 1 Complete (Core + Streaming)
- ✅ Tier 2 Complete (Developer UX)
- ✅ Tier 3 Complete (Store, Metrics, Crons, A2A, MCP)

**Test Coverage**: 426 unit tests passing

**Production Ready**: Yes, full LangGraph API feature parity achieved