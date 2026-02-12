# fractal-graph-react-agent

ReAct agent with MCP tools — part of the [fractal-agents-runtime](https://github.com/l4b4r4b4b4/fractal-agents-runtime) graph catalog.

## Overview

This package provides a portable, self-contained ReAct agent graph built on LangGraph with:

- **MCP tool integration** — connects to Model Context Protocol servers for extensible tool use
- **RAG tool factory** — creates retrieval-augmented generation tools from document collections
- **OAuth token exchange** — handles MCP server authentication with token caching
- **Multi-provider LLM support** — OpenAI, Anthropic, Google, and custom OpenAI-compatible endpoints

## Installation

```bash
uv add fractal-graph-react-agent
```

## Usage

The graph is a portable factory function that accepts a `RunnableConfig` and optional persistence components via dependency injection:

```python
from react_agent import graph
from langchain_core.runnables import RunnableConfig

# Build the agent graph — runtime injects persistence
config = RunnableConfig(configurable={"model_name": "openai:gpt-4o"})
agent = await graph(config, checkpointer=my_checkpointer, store=my_store)

# Invoke
result = await agent.ainvoke({"messages": [{"role": "user", "content": "Hello!"}]})
```

### Dependency Injection

The `graph()` factory uses dependency injection for persistence — it never imports from any specific runtime:

```python
# The runtime (e.g., Robyn server) creates and injects these:
from my_runtime.database import get_checkpointer, get_store

agent = await graph(
    config,
    checkpointer=get_checkpointer(),  # Thread-level conversation memory
    store=get_store(),                  # Cross-thread long-term memory
)
```

When `checkpointer` and `store` are `None` (the default), the agent runs without persistence — useful for testing or stateless invocations.

## Configuration

The graph is configured via `RunnableConfig.configurable`:

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `model_name` | `str` | `"openai:gpt-4o"` | LLM provider and model |
| `temperature` | `float` | `0.7` | Sampling temperature |
| `max_tokens` | `int` | `4000` | Maximum generation tokens |
| `system_prompt` | `str` | Generic helpful assistant | System prompt |
| `mcp_config` | `dict` | `None` | MCP server configuration |
| `rag` | `dict` | `None` | RAG collection configuration |
| `base_url` | `str` | `None` | Custom OpenAI-compatible endpoint |

## Architecture

This package is part of the 3-layer architecture:

```
apps/          → Thin HTTP wrappers (Robyn, FastAPI, etc.)
  ↓ depends on
graphs/        → Portable agent architectures (this package)
  ↓ depends on
infra/         → Shared runtime infrastructure (tracing, auth, store namespace)
```

Graphs have **zero coupling** to any runtime — they can be deployed to LangGraph Platform, embedded in any server framework, or run standalone.

## License

MIT