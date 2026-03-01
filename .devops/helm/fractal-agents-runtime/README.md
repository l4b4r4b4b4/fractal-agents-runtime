# Fractal Agents Runtime — Helm Chart

Unified Helm chart for deploying the Fractal Agents Runtime on Kubernetes.
Supports both **Python (Robyn)** and **TypeScript (Bun)** backends via a single `runtime` toggle.

## Prerequisites

- Kubernetes ≥ 1.25
- Helm ≥ 3.12
- A Supabase instance (URL + keys)
- Container images pushed to GHCR (see [Image Build](#image-build))

## Quick Start

```bash
# Python runtime (default)
helm install agent-runtime .devops/helm/fractal-agents-runtime \
  -f .devops/helm/fractal-agents-runtime/values-testing.yaml \
  -n testing

# TypeScript runtime
helm install agent-runtime .devops/helm/fractal-agents-runtime \
  -f .devops/helm/fractal-agents-runtime/values-ts.yaml \
  -n testing
```

## Runtime Toggle

The chart uses a single top-level `runtime` value to switch between backends:

| Value | Backend | Default Port | Image |
|-------|---------|-------------|-------|
| `python` | Robyn (multi-worker) | 8081 | `ghcr.io/l4b4r4b4b4/fractal-agents-runtime-python` |
| `ts` | Bun (single-process) | 3000 | `ghcr.io/l4b4r4b4b4/fractal-agents-runtime-ts` |

The runtime value controls:

- **Image selection** — auto-selected when `image.repository` is empty
- **Container port** — derived from `python.port` or `typescript.port`
- **Environment variables** — Shared vars (`DATABASE_URL`, `AGENT_SYNC_SCOPE`, tracing) rendered for both runtimes; Python-specific (`ROBYN_*`) and TS-specific (`PORT`, `NODE_ENV`) are conditionally rendered
- **Network policy** — Postgres egress (port 5432) is enabled for both runtimes when database is configured

## Values Files

| File | Purpose | Runtime |
|------|---------|---------|
| `values.yaml` | Production-ready defaults | Python |
| `values-ts.yaml` | TypeScript runtime overrides | TS |
| `values-dev.yaml` | Local/dev (1 replica, no HPA) | Python |
| `values-testing.yaml` | AKS testing (real Supabase + vLLM) | Python |
| `values-staging.yaml` | Staging (2 replicas, ingress) | Python |
| `values-prod.yaml` | Production (5 replicas, HPA 5–20) | Python |

Combine values files to layer overrides:

```bash
# TS runtime in dev mode
helm install agent-runtime .devops/helm/fractal-agents-runtime \
  -f .devops/helm/fractal-agents-runtime/values-ts.yaml \
  -f .devops/helm/fractal-agents-runtime/values-dev.yaml \
  --set runtime=ts \
  -n dev
```

## Secrets Management

### Option 1: Existing Secret (Recommended)

Create a Kubernetes Secret manually, via External Secrets Operator, or sealed-secrets:

```bash
kubectl create secret generic fractal-agents-runtime-secrets \
  --from-literal=supabase-key='YOUR_SUPABASE_ANON_KEY' \
  --from-literal=supabase-secret='YOUR_SUPABASE_SERVICE_ROLE_KEY' \
  --from-literal=supabase-jwt-secret='YOUR_SUPABASE_JWT_SECRET' \
  --from-literal=openai-api-key='sk-...' \
  --from-literal=anthropic-api-key='sk-ant-...' \
  --from-literal=langchain-api-key='ls-...' \
  --from-literal=langfuse-secret-key='sk-lf-...' \
  --from-literal=langfuse-public-key='pk-lf-...' \
  --from-literal=database-url='postgresql://user:pass@host:5432/db' \
  -n <namespace>
```

Then reference it:

```yaml
existingSecret:
  name: "fractal-agents-runtime-secrets"
```

The `existingSecret.keys` map lets you customise key names if your secret uses different field names (e.g. when sharing a Supabase secret that uses `anonKey` instead of `supabase-key`).

### Option 2: Helm-Managed Secret (Development Only)

```yaml
secrets:
  create: true
  data:
    supabase-key: "sb-anon-key-here"
    openai-api-key: "sk-..."
    database-url: "postgresql://user:pass@host:5432/db"
```

> **Warning:** Never commit real credentials in values files. Use `--set` or environment-specific overlays.

## Environment Variables

### Shared (Both Runtimes)

| Variable | Source | Description |
|----------|--------|-------------|
| `SUPABASE_URL` | `config.supabase.url` | Supabase project URL |
| `SUPABASE_KEY` | `existingSecret` | Supabase anon key |
| `SUPABASE_SECRET` | `existingSecret` | Supabase service role key |
| `SUPABASE_JWT_SECRET` | `existingSecret` | JWT verification secret |
| `OPENAI_API_KEY` | `existingSecret` | OpenAI API key |
| `OPENAI_API_BASE` | `config.llm.openaiApiBase` | Custom OpenAI-compatible endpoint |
| `MODEL_NAME` | `config.llm.modelName` | LLM model name |
| `ANTHROPIC_API_KEY` | `existingSecret` | Anthropic API key |
| `LANGFUSE_SECRET_KEY` | `existingSecret` | Langfuse secret key |
| `LANGFUSE_PUBLIC_KEY` | `existingSecret` | Langfuse public key |
| `LANGFUSE_BASE_URL` | `config.tracing.langfuseBaseUrl` | Langfuse server URL |
| `LANGCHAIN_API_KEY` | `existingSecret` | LangSmith API key |
| `LANGCHAIN_TRACING_V2` | `config.tracing.langchainTracingV2` | Enable LangSmith tracing |
| `LANGCHAIN_PROJECT` | `config.tracing.langchainProject` | LangSmith project name |
| `DATABASE_URL` | `existingSecret` / `config.database.url` | Postgres connection string |
| `DATABASE_POOL_MIN_SIZE` | `config.database.poolMinSize` | Connection pool minimum |
| `DATABASE_POOL_MAX_SIZE` | `config.database.poolMaxSize` | Connection pool maximum |
| `DATABASE_POOL_TIMEOUT` | `config.database.poolTimeout` | Pool acquire timeout (seconds) |
| `AGENT_SYNC_SCOPE` | `config.agentSync.scope` | Startup agent sync scope |
| `LANGFUSE_PROMPT_CACHE_TTL_SECONDS` | `config.tracing.langfusePromptCacheTtlSeconds` | Prompt template cache TTL |

### Python Only (`runtime: python`)

| Variable | Source | Description |
|----------|--------|-------------|
| `ROBYN_HOST` | `python.host` | Bind address |
| `ROBYN_PORT` | `python.port` | Listen port |
| `ROBYN_WORKERS` | `python.workers` | Worker process count |
| `ROBYN_DEV` | `python.devMode` | Dev mode (hot reload) |

### TypeScript Only (`runtime: ts`)

| Variable | Source | Description |
|----------|--------|-------------|
| `PORT` | `typescript.port` | Listen port |
| `NODE_ENV` | `typescript.nodeEnv` | Node environment |

## Features

### Templates Included

| Template | Description | Gated By |
|----------|-------------|----------|
| `deployment.yaml` | Main deployment with runtime-conditional env vars | Always |
| `service.yaml` | ClusterIP service | Always |
| `serviceaccount.yaml` | ServiceAccount | `serviceAccount.create` |
| `configmap.yaml` | Optional ConfigMap | `configMap.create` |
| `secret.yaml` | Optional Helm-managed Secret | `secrets.create` |
| `ingress.yaml` | Ingress with TLS support | `ingress.enabled` |
| `hpa.yaml` | HorizontalPodAutoscaler v2 | `autoscaling.enabled` |
| `pdb.yaml` | PodDisruptionBudget | `podDisruptionBudget.enabled` |
| `networkpolicy.yaml` | NetworkPolicy with auto Postgres egress | `networkPolicy.enabled` |
| `servicemonitor.yaml` | Prometheus ServiceMonitor | `serviceMonitor.enabled` |
| `prometheusrule.yaml` | Prometheus alerting rules | `prometheusRule.enabled` |

### Security Defaults

- Non-root user (UID 65532)
- Read-only root filesystem (production)
- All capabilities dropped
- seccomp RuntimeDefault profile
- No privilege escalation

### Health Endpoints

Both runtimes serve:

- `GET /health` — JSON health status
- `GET /ok` — LangGraph health format
- `GET /info` — Service information
- `GET /openapi.json` — OpenAPI 3.1 spec

Both runtimes additionally serve:

- `GET /metrics` — Prometheus exposition format
- `GET /metrics/json` — JSON metrics format

## Image Build

Images are built by GitHub Actions workflows:

```bash
# Python
docker build -f .devops/docker/python.Dockerfile . \
  -t ghcr.io/l4b4r4b4b4/fractal-agents-runtime-python:latest

# TypeScript
docker build -f .devops/docker/ts.Dockerfile . \
  -t ghcr.io/l4b4r4b4b4/fractal-agents-runtime-ts:latest
```

Image tags produced by CI: `sha-<short>`, `development`, `nightly`, `v<version>` (e.g. `v0.0.3`).

## Migrating from Old Chart

The old chart at `apps/python/src/server/helm/robyn-runtime/` has been removed. Key changes:

| Old | New |
|-----|-----|
| Chart name: `robyn-runtime` | `fractal-agents-runtime` |
| Location: `apps/python/src/server/helm/` | `.devops/helm/fractal-agents-runtime/` |
| Image: `ghcr.io/your-org/robyn-runtime` | `ghcr.io/l4b4r4b4b4/fractal-agents-runtime-python` |
| Secret name: `robyn-runtime-secrets` | `fractal-agents-runtime-secrets` |
| Helper prefix: `robyn-runtime.*` | `fractal-agents-runtime.*` |
| Runtime: Python only | Python or TypeScript via `runtime` toggle |
| UID: 1000 | 65532 (`appuser` from Dockerfile) |

New environment variables added (were missing in old chart):

- `DATABASE_URL` — Postgres persistence (shared, both runtimes)
- `DATABASE_POOL_MIN_SIZE` / `MAX_SIZE` / `TIMEOUT` — Pool tuning (shared)
- `SUPABASE_JWT_SECRET` — JWT verification
- `AGENT_SYNC_SCOPE` — Agent sync on startup (shared, both runtimes)
- `LANGFUSE_SECRET_KEY` — Langfuse tracing
- `LANGFUSE_PUBLIC_KEY` — Langfuse tracing
- `LANGFUSE_PROMPT_CACHE_TTL_SECONDS` — Prompt template cache TTL
- `ANTHROPIC_API_KEY` — Anthropic LLM provider

New secret keys in `existingSecret.keys`:

- `supabaseJwtSecret`
- `anthropicApiKey`
- `langfuseSecretKey`
- `langfusePublicKey`
- `databaseUrl`

## Uninstall

```bash
helm uninstall agent-runtime -n <namespace>
```

## License

See the [repository root](https://github.com/l4b4r4b4b4/fractal-agents-runtime) for license information.