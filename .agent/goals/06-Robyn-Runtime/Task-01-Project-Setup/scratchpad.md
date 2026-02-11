# Task 01 — Project Setup & Robyn Hello World

Status: 🟢 Complete  
Parent Goal: [06-Robyn-Runtime](../scratchpad.md)  
Priority: Critical  
Owner: You  
Created: 2026-01-30  
Last Updated: 2026-01-30  
Completed: 2026-01-30

---

## Objective

Set up the Robyn project structure and get a basic "hello world" server running. This establishes the foundation for all subsequent tasks.

---

## Acceptance Criteria

- [x] `robyn` added to project dependencies via `uv add robyn`
- [x] `robyn_server/` directory structure created
- [x] Basic Robyn app with `/health` endpoint
- [x] Server starts successfully on port 8080 (or configurable via ROBYN_PORT)
- [x] Health endpoint returns JSON `{"status":"ok"}`
- [x] Can run via `uv run python robyn_server/app.py`

---

## Completed Work (2026-01-30)

### Step 1: Added Robyn Dependency ✅

```bash
uv add robyn
# Installed robyn==0.76.0 with dependencies:
# dill, inquirerpy, multiprocess, orjson (upgraded), pfzy, 
# prompt-toolkit, rustimport, toml, uvloop, watchdog, wcwidth
```

### Step 2: Created Directory Structure ✅

Renamed `robyn_prototype/` to `robyn_server/` and created:

```
robyn_server/
├── __init__.py         # Package marker with docstring
├── app.py              # Main Robyn application entry point
├── config.py           # Configuration (env vars, settings)
├── models.py           # Pydantic models for API
└── routes/
    └── __init__.py     # Routes package marker
```

### Step 3: Implemented Basic App ✅

Created `robyn_server/app.py` with three endpoints:

1. **GET /health** → `{"status": "ok"}`
2. **GET /** → `{"service": "oap-langgraph-tools-agent", "runtime": "robyn", "version": "0.1.0"}`
3. **GET /info** → Extended info with config status

### Step 4: Verified Server Works ✅

```bash
ROBYN_PORT=8081 uv run python robyn_server/app.py

# Output:
# Starting Robyn server on 0.0.0.0:8081
# INFO:robyn.logger:Robyn version: 0.76.0
# INFO:actix_server.server:starting service...

# Tests passed:
curl http://localhost:8081/health  # {"status":"ok"}
curl http://localhost:8081/        # Service info
curl http://localhost:8081/info    # Full info with config status
```

---

## Key Learnings (Robyn 0.76.0 API)

### 1. Route Handlers Don't Need Request Parameter

Robyn 0.76.0 validates route handler signatures. If you don't use the request, don't include it:

```python
# ❌ WRONG - causes SyntaxError
@app.get("/health")
async def health(_request) -> dict:
    return {"status": "ok"}

# ✅ CORRECT - no unused parameters
@app.get("/health")
async def health() -> dict:
    return {"status": "ok"}
```

### 2. Exception Handler Syntax Changed

The `@app.exception(Exception)` decorator syntax has changed. Need to research `app.exception_handler` for proper error handling in later tasks.

### 3. Port Conflict Handling

Robyn prompts for a new port when the configured one is in use, which blocks in non-interactive contexts. Use environment variable `ROBYN_PORT` to configure.

### 4. Automatic OpenAPI/Docs

Robyn automatically adds:
- `GET /openapi.json` — OpenAPI schema
- `GET /docs` — Swagger UI

This is free documentation for our API!

---

## Files Created

| File | Lines | Purpose |
|------|-------|---------|
| `robyn_server/__init__.py` | 7 | Package marker |
| `robyn_server/app.py` | 65 | Main Robyn application |
| `robyn_server/config.py` | 98 | Environment configuration |
| `robyn_server/models.py` | 152 | Pydantic API models |
| `robyn_server/routes/__init__.py` | 3 | Routes package marker |

---

## Configuration Options

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ROBYN_HOST` | `0.0.0.0` | Server bind address |
| `ROBYN_PORT` | `8080` | Server port |
| `ROBYN_WORKERS` | `1` | Number of workers |
| `ROBYN_DEV` | `false` | Development mode |
| `SUPABASE_URL` | - | Supabase URL (for Task 02) |
| `SUPABASE_KEY` | - | Supabase anon key (for Task 02) |
| `OPENAI_API_KEY` | - | LLM API key |
| `OPENAI_API_BASE` | - | Custom LLM endpoint (vLLM) |

---

## Running the Server

```bash
# Default (port 8080)
uv run python robyn_server/app.py

# Custom port
ROBYN_PORT=8081 uv run python robyn_server/app.py

# With hot reload (development)
uv run python robyn_server/app.py --dev
```

---

## Testing Commands

```bash
# Health check
curl -s http://localhost:8080/health | jq .

# Service info
curl -s http://localhost:8080/ | jq .

# Extended info
curl -s http://localhost:8080/info | jq .

# OpenAPI schema (auto-generated)
curl -s http://localhost:8080/openapi.json | jq .
```

---

## Next Steps

→ **Task 02: Authentication Middleware**
- Port Supabase JWT auth from `tools_agent/security/auth.py`
- Implement `@app.before_request()` middleware
- Handle Bearer token validation

---

## Infrastructure Context

- **vLLM**: `http://localhost:7374/v1` (mistralai/ministral-3b-instruct)
- **LangGraph Runtime**: `langgraph dev` on `localhost:2024` (to be replaced)
- **Supabase**: `localhost:54321` (secret: `<REDACTED>`)
- **Robyn Server**: `localhost:8080` (new runtime) ✅
