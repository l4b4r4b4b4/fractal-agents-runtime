# fractal-agent-infra

Shared runtime infrastructure for the [fractal-agents-runtime](https://github.com/l4b4r4b4b4/fractal-agents-runtime) ecosystem.

> **Status:** Local path dependency only. PyPI publishing planned for a future release when multiple consumers exist.

## What's Included

| Module | Purpose |
|--------|---------|
| `fractal_agent_infra.tracing` | Langfuse initialization, callback handlers, `inject_tracing()` helper |
| `fractal_agent_infra.store_namespace` | Canonical 4-component namespace convention for LangGraph Store |
| `fractal_agent_infra.security.auth` | LangGraph SDK auth middleware (Supabase JWT verification for Platform deploy) |

## Usage

```python
from fractal_agent_infra.tracing import initialize_langfuse, inject_tracing, shutdown_langfuse
from fractal_agent_infra.store_namespace import build_namespace, extract_namespace_components, CATEGORY_TOKENS

# At startup
initialize_langfuse()

# Per invocation — inject Langfuse tracing into a RunnableConfig
config = inject_tracing(
    runnable_config,
    user_id=owner_id,
    session_id=thread_id,
    trace_name="agent-stream",
)

# At shutdown
shutdown_langfuse()
```

## Architecture

This package sits in the **infra layer** of the 3-layer architecture:

```
apps/          → Thin HTTP wrappers (Robyn, Bun) — imports graphs + infra
packages/graphs/ → Portable agent architectures — imports infra only
packages/infra/  → Shared runtime infrastructure (THIS PACKAGE) — no upstream deps
```

**Dependency rules:**
- Graphs → Infra: ✅ Allowed
- Apps → Infra: ✅ Allowed
- Infra → Graphs: ❌ Never
- Infra → Apps: ❌ Never

## License

MIT