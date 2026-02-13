# Robyn Runtime Deployment Guide

This guide covers deploying the Robyn runtime server for the Open Agent Platform LangGraph Tools Agent in production environments.

## Table of Contents

- [Helm Deployment (Recommended)](#helm-deployment-recommended)
- [Docker Deployment](#docker-deployment)
- [Environment Configuration](#environment-configuration)
- [Kubernetes/AKS Deployment](#kubernetesaks-deployment)
- [Production Best Practices](#production-best-practices)
- [Monitoring & Observability](#monitoring--observability)
- [Scaling & Performance](#scaling--performance)
- [Troubleshooting](#troubleshooting)

---

## Helm Deployment (Recommended)

The recommended way to deploy the Robyn runtime to Kubernetes is using the provided Helm chart.

### Prerequisites

- Kubernetes 1.21+
- Helm 3.8+
- Prometheus Operator (optional, for ServiceMonitor and PrometheusRule)
- Cert-manager (optional, for automatic TLS certificates)

### Quick Start

```bash
# Install from local chart
cd robyn_server/helm
helm install robyn-runtime ./robyn-runtime \
  --namespace oap \
  --create-namespace

# Or with custom values
helm install robyn-runtime ./robyn-runtime \
  --namespace oap \
  --create-namespace \
  --values ./robyn-runtime/values-prod.yaml
```

### Create Secrets First

Before deploying, create the required secrets:

```bash
kubectl create namespace oap

kubectl create secret generic robyn-runtime-secrets \
  --from-literal=supabase-key='your-supabase-key' \
  --from-literal=supabase-secret='your-supabase-secret' \
  --from-literal=openai-api-key='your-openai-key' \
  --from-literal=langchain-api-key='your-langsmith-key' \
  --namespace oap
```

### Environment-Specific Deployments

**Development:**

```bash
helm install robyn-dev ./robyn-runtime \
  --namespace oap-dev \
  --create-namespace \
  --values ./robyn-runtime/values-dev.yaml
```

**Staging:**

```bash
helm install robyn-staging ./robyn-runtime \
  --namespace oap-staging \
  --create-namespace \
  --values ./robyn-runtime/values-staging.yaml
```

**Production:**

```bash
helm install robyn-prod ./robyn-runtime \
  --namespace oap-prod \
  --create-namespace \
  --values ./robyn-runtime/values-prod.yaml
```

### Key Configuration Options

```bash
# Custom image
helm install robyn-runtime ./robyn-runtime \
  --set image.repository=ghcr.io/your-org/robyn-runtime \
  --set image.tag=v1.2.3

# Custom resources
helm install robyn-runtime ./robyn-runtime \
  --set resources.limits.cpu=4000m \
  --set resources.limits.memory=4Gi

# Custom vLLM backend
helm install robyn-runtime ./robyn-runtime \
  --set config.llm.openaiApiBase=http://vllm.ai.svc.cluster.local/v1

# Disable autoscaling (fixed replicas)
helm install robyn-runtime ./robyn-runtime \
  --set autoscaling.enabled=false \
  --set replicaCount=5
```

### Upgrading

```bash
# Upgrade with new values
helm upgrade robyn-runtime ./robyn-runtime \
  --namespace oap \
  --values ./robyn-runtime/values-prod.yaml

# Upgrade image only
helm upgrade robyn-runtime ./robyn-runtime \
  --namespace oap \
  --set image.tag=v0.2.0
```

### Uninstalling

```bash
helm uninstall robyn-runtime --namespace oap
```

### Chart Features

The Helm chart includes:

- **Deployment** with rolling updates and security best practices
- **Service** (ClusterIP) for internal communication
- **Ingress** with TLS support and SSE-optimized annotations
- **HorizontalPodAutoscaler** for automatic scaling
- **PodDisruptionBudget** for high availability
- **ServiceAccount** with minimal permissions
- **NetworkPolicy** for network isolation
- **ServiceMonitor** for Prometheus metrics collection
- **PrometheusRule** for alerting rules
- **ConfigMap** and **Secret** management

See [helm/robyn-runtime/README.md](helm/robyn-runtime/README.md) for complete documentation.

---

## Docker Deployment

### Building the Docker Image

Create a Dockerfile for the Robyn runtime:

```dockerfile
# Multi-stage Dockerfile for Robyn runtime
FROM python:3.12-slim AS builder

# Install uv
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

WORKDIR /app

# Copy dependency files
COPY pyproject.toml uv.lock ./

# Install dependencies
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-editable

# Copy application code
COPY tools_agent/ ./tools_agent/
COPY robyn_server/ ./robyn_server/
COPY langgraph.json ./

# Runtime stage
FROM python:3.12-slim AS runtime

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN useradd --create-home --uid 1000 appuser

WORKDIR /app

# Copy virtual environment and application
COPY --from=builder /app/.venv /app/.venv
COPY --from=builder /app/tools_agent/ ./tools_agent/
COPY --from=builder /app/robyn_server/ ./robyn_server/
COPY --from=builder /app/langgraph.json ./

# Set environment
ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONPATH="/app" \
    PYTHONUNBUFFERED="1" \
    ROBYN_HOST="0.0.0.0" \
    ROBYN_PORT="8081"

# Create runtime directories
RUN mkdir -p /app/data && chown -R appuser:appuser /app

USER appuser

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:8081/health || exit 1

EXPOSE 8081

CMD ["python", "-m", "robyn_server"]
```

### Build Commands

```bash
# Build image
docker build -t robyn-runtime:latest -f robyn_server/Dockerfile .

# Build with version tag
docker build -t robyn-runtime:0.1.0 -f robyn_server/Dockerfile .

# Build with cache optimization
docker build --cache-from robyn-runtime:latest \
  -t robyn-runtime:latest \
  -f robyn_server/Dockerfile .
```

### Running with Docker

**Development:**

```bash
docker run -it --rm \
  --name robyn-runtime-dev \
  -p 8081:8081 \
  -e SUPABASE_URL="http://host.docker.internal:54321" \
  -e SUPABASE_KEY="your-key" \
  -e OPENAI_API_KEY="your-key" \
  --env-file .env \
  robyn-runtime:latest
```

**Production:**

```bash
docker run -d \
  --name robyn-runtime \
  --restart unless-stopped \
  -p 8081:8081 \
  -e SUPABASE_URL="${SUPABASE_URL}" \
  -e SUPABASE_KEY="${SUPABASE_KEY}" \
  -e OPENAI_API_KEY="${OPENAI_API_KEY}" \
  -e ROBYN_WORKERS="4" \
  --memory="2g" \
  --cpus="2" \
  --health-cmd="curl -f http://localhost:8081/health || exit 1" \
  --health-interval=30s \
  --health-timeout=5s \
  --health-retries=3 \
  robyn-runtime:latest
```

### Docker Compose

```yaml
# docker-compose.yml
version: '3.8'

services:
  robyn-runtime:
    build:
      context: .
      dockerfile: robyn_server/Dockerfile
    image: robyn-runtime:latest
    container_name: robyn-runtime
    restart: unless-stopped
    ports:
      - "8081:8081"
    environment:
      - ROBYN_HOST=0.0.0.0
      - ROBYN_PORT=8081
      - ROBYN_WORKERS=4
      - SUPABASE_URL=${SUPABASE_URL}
      - SUPABASE_KEY=${SUPABASE_KEY}
      - OPENAI_API_KEY=${OPENAI_API_KEY}
      - OPENAI_API_BASE=${OPENAI_API_BASE:-}
    env_file:
      - .env
    volumes:
      - app-data:/app/data
    networks:
      - oap-network
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8081/health"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s
    deploy:
      resources:
        limits:
          cpus: '2'
          memory: 2G
        reservations:
          cpus: '1'
          memory: 1G

volumes:
  app-data:

networks:
  oap-network:
    driver: bridge
```

**Usage:**

```bash
# Start services
docker-compose up -d

# View logs
docker-compose logs -f robyn-runtime

# Stop services
docker-compose down

# Rebuild and restart
docker-compose up -d --build
```

---

## Environment Configuration

### Required Variables

```bash
# Authentication (Required)
SUPABASE_URL="https://your-project.supabase.co"
SUPABASE_KEY="your-supabase-service-role-key"

# LLM Backend (Required - choose one)
OPENAI_API_KEY="sk-..."                          # For OpenAI
# OR
OPENAI_API_BASE="http://vllm-service:8000/v1"    # For vLLM/compatible
```

### Optional Variables

```bash
# Server Configuration
ROBYN_HOST="0.0.0.0"           # Listen address
ROBYN_PORT="8081"              # Listen port
ROBYN_WORKERS="4"              # Number of worker processes
ROBYN_DEV="false"              # Development mode

# Model Configuration
MODEL_NAME="gpt-4"             # Default model name

# Observability
LANGCHAIN_TRACING_V2="true"    # LangSmith tracing
LANGCHAIN_API_KEY="..."        # LangSmith API key
LANGCHAIN_PROJECT="production" # LangSmith project

# Build Information (injected by CI/CD)
BUILD_DATE="2024-01-15"        # Build timestamp
GIT_COMMIT="abc123"            # Git commit hash
```

### Environment File Templates

**Development (.env.dev):**

```bash
SUPABASE_URL="http://127.0.0.1:54321"
SUPABASE_KEY="eyJhbGciOiJFUzI1NiIsImtpZCI6ImI4MTI2OWYxLTIxZDgtNGYyZS1iNzE5LWMyMjQwYTg0MGQ5MCIsInR5cCI6IkpXVCJ9..."
OPENAI_API_BASE="http://localhost:8001/v1"
ROBYN_DEV="true"
ROBYN_WORKERS="1"
```

**Production (.env.prod):**

```bash
SUPABASE_URL="https://prod-project.supabase.co"
SUPABASE_KEY="${SECRET_SUPABASE_KEY}"
OPENAI_API_KEY="${SECRET_OPENAI_KEY}"
ROBYN_WORKERS="4"
ROBYN_DEV="false"
LANGCHAIN_TRACING_V2="true"
```

### Secrets Management

**Using Kubernetes Secrets:**

```bash
# Create secret from env file
kubectl create secret generic robyn-runtime-secrets \
  --from-env-file=.env.prod \
  --namespace=oap

# Or create from literal values
kubectl create secret generic robyn-runtime-secrets \
  --from-literal=SUPABASE_KEY="your-key" \
  --from-literal=OPENAI_API_KEY="your-key" \
  --namespace=oap
```

**Using Docker Secrets:**

```yaml
# docker-compose with secrets
services:
  robyn-runtime:
    secrets:
      - supabase_key
      - openai_key
    environment:
      - SUPABASE_KEY_FILE=/run/secrets/supabase_key

secrets:
  supabase_key:
    file: ./secrets/supabase_key.txt
  openai_key:
    file: ./secrets/openai_key.txt
```

---

## Kubernetes/AKS Deployment

### Deployment Manifest

```yaml
# k8s/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: robyn-runtime
  namespace: oap
  labels:
    app: robyn-runtime
    tier: backend
spec:
  replicas: 3
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0
  selector:
    matchLabels:
      app: robyn-runtime
  template:
    metadata:
      labels:
        app: robyn-runtime
        tier: backend
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "8081"
        prometheus.io/path: "/metrics"
    spec:
      serviceAccountName: robyn-runtime
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        fsGroup: 1000
      containers:
      - name: robyn-runtime
        image: ghcr.io/your-org/robyn-runtime:0.1.0
        imagePullPolicy: IfNotPresent
        ports:
        - name: http
          containerPort: 8081
          protocol: TCP
        env:
        - name: ROBYN_HOST
          value: "0.0.0.0"
        - name: ROBYN_PORT
          value: "8081"
        - name: ROBYN_WORKERS
          value: "4"
        - name: SUPABASE_URL
          valueFrom:
            secretKeyRef:
              name: robyn-runtime-secrets
              key: supabase_url
        - name: SUPABASE_KEY
          valueFrom:
            secretKeyRef:
              name: robyn-runtime-secrets
              key: supabase_key
        - name: OPENAI_API_KEY
          valueFrom:
            secretKeyRef:
              name: robyn-runtime-secrets
              key: openai_api_key
              optional: true
        - name: OPENAI_API_BASE
          valueFrom:
            configMapKeyRef:
              name: robyn-runtime-config
              key: openai_api_base
              optional: true
        resources:
          requests:
            cpu: 500m
            memory: 1Gi
          limits:
            cpu: 2000m
            memory: 2Gi
        livenessProbe:
          httpGet:
            path: /health
            port: http
          initialDelaySeconds: 30
          periodSeconds: 10
          timeoutSeconds: 5
          failureThreshold: 3
        readinessProbe:
          httpGet:
            path: /health
            port: http
          initialDelaySeconds: 10
          periodSeconds: 5
          timeoutSeconds: 3
          failureThreshold: 3
        securityContext:
          allowPrivilegeEscalation: false
          readOnlyRootFilesystem: true
          capabilities:
            drop:
            - ALL
        volumeMounts:
        - name: tmp
          mountPath: /tmp
        - name: data
          mountPath: /app/data
      volumes:
      - name: tmp
        emptyDir: {}
      - name: data
        emptyDir: {}
      imagePullSecrets:
      - name: ghcr-pull-secret
```

### Service Manifest

```yaml
# k8s/service.yaml
apiVersion: v1
kind: Service
metadata:
  name: robyn-runtime
  namespace: oap
  labels:
    app: robyn-runtime
spec:
  type: ClusterIP
  selector:
    app: robyn-runtime
  ports:
  - name: http
    port: 80
    targetPort: http
    protocol: TCP
  sessionAffinity: None
```

### Ingress Manifest

```yaml
# k8s/ingress.yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: robyn-runtime
  namespace: oap
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
    nginx.ingress.kubernetes.io/proxy-read-timeout: "300"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "300"
    nginx.ingress.kubernetes.io/proxy-buffering: "off"  # Required for SSE
spec:
  ingressClassName: nginx
  tls:
  - hosts:
    - agent-api.your-domain.com
    secretName: robyn-runtime-tls
  rules:
  - host: agent-api.your-domain.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: robyn-runtime
            port:
              number: 80
```

### HPA (Horizontal Pod Autoscaler)

```yaml
# k8s/hpa.yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: robyn-runtime
  namespace: oap
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: robyn-runtime
  minReplicas: 3
  maxReplicas: 10
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
  - type: Resource
    resource:
      name: memory
      target:
        type: Utilization
        averageUtilization: 80
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 300
      policies:
      - type: Percent
        value: 50
        periodSeconds: 60
    scaleUp:
      stabilizationWindowSeconds: 0
      policies:
      - type: Percent
        value: 100
        periodSeconds: 30
      - type: Pods
        value: 2
        periodSeconds: 30
      selectPolicy: Max
```

### Deploy to Kubernetes

```bash
# Apply all manifests
kubectl apply -f k8s/

# Or apply individually
kubectl apply -f k8s/deployment.yaml
kubectl apply -f k8s/service.yaml
kubectl apply -f k8s/ingress.yaml
kubectl apply -f k8s/hpa.yaml

# Check deployment status
kubectl rollout status deployment/robyn-runtime -n oap

# View pods
kubectl get pods -n oap -l app=robyn-runtime

# View logs
kubectl logs -n oap -l app=robyn-runtime -f

# Port-forward for local testing
kubectl port-forward -n oap svc/robyn-runtime 8081:80
```

### AKS-Specific Configuration

**Connect to vLLM on AKS:**

```yaml
# ConfigMap for vLLM endpoint
apiVersion: v1
kind: ConfigMap
metadata:
  name: robyn-runtime-config
  namespace: oap
data:
  openai_api_base: "http://ministral-vllm.testing.svc.cluster.local/v1"
```

**Network Policy:**

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: robyn-runtime-netpol
  namespace: oap
spec:
  podSelector:
    matchLabels:
      app: robyn-runtime
  policyTypes:
  - Ingress
  - Egress
  ingress:
  - from:
    - namespaceSelector:
        matchLabels:
          name: ingress-nginx
    ports:
    - protocol: TCP
      port: 8081
  egress:
  - to:
    - namespaceSelector:
        matchLabels:
          name: testing
    - podSelector:
        matchLabels:
          app: ministral-vllm
    ports:
    - protocol: TCP
      port: 80
  - to:  # Allow DNS
    - namespaceSelector: {}
    ports:
    - protocol: UDP
      port: 53
```

---

## Production Best Practices

### Security

1. **Never expose secrets in images or logs:**
   - Use Kubernetes Secrets or external secret managers
   - Set `PYTHONUNBUFFERED=1` to avoid buffering sensitive data

2. **Run as non-root user:**
   - Dockerfile creates `appuser` with UID 1000
   - Kubernetes securityContext enforces non-root

3. **Read-only root filesystem:**
   - Mount writable volumes only where needed (`/tmp`, `/app/data`)

4. **Network policies:**
   - Restrict ingress to necessary namespaces
   - Limit egress to LLM backend and external APIs

5. **TLS/HTTPS:**
   - Use ingress with TLS termination
   - Cert-manager for automatic certificate renewal

### Reliability

1. **Health checks:**
   - Liveness: `/health` endpoint
   - Readiness: `/health` with startup delay
   - Startup probes for slow initialization

2. **Graceful shutdown:**
   - Robyn handles SIGTERM/SIGINT
   - Kubernetes `terminationGracePeriodSeconds: 30`

3. **Resource limits:**
   - Set both requests and limits
   - Monitor actual usage with Prometheus

4. **Horizontal scaling:**
   - HPA based on CPU/memory
   - Minimum 3 replicas for high availability

5. **Rolling updates:**
   - `maxUnavailable: 0` ensures zero downtime
   - `maxSurge: 1` for gradual rollout

### Performance

1. **Worker configuration:**
   - `ROBYN_WORKERS=4` (adjust based on CPU cores)
   - Formula: `workers = (2 × CPU cores) + 1`

2. **Connection pooling:**
   - Keep-alive for LLM backend connections
   - Reuse HTTP clients

3. **Caching:**
   - In-memory storage for low latency
   - Consider Redis for distributed cache

4. **SSE buffering:**
   - Disable nginx buffering for SSE: `proxy-buffering: off`
   - Set appropriate timeouts for long-running streams

### Observability

1. **Metrics:**
   - Prometheus scraping on `/metrics`
   - Custom metrics for agent execution

2. **Logging:**
   - Structured JSON logs
   - Log level configuration via env var
   - Correlation IDs for request tracing

3. **Tracing:**
   - LangSmith integration for agent traces
   - OpenTelemetry for distributed tracing

4. **Alerting:**
   - High error rates
   - Long response times
   - Pod restarts

---

## Monitoring & Observability

### Prometheus Configuration

```yaml
# prometheus-servicemonitor.yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: robyn-runtime
  namespace: oap
  labels:
    app: robyn-runtime
spec:
  selector:
    matchLabels:
      app: robyn-runtime
  endpoints:
  - port: http
    path: /metrics
    interval: 30s
    scrapeTimeout: 10s
```

### Key Metrics to Monitor

**System Metrics:**
- `robyn_requests_total` — Total HTTP requests
- `robyn_request_duration_seconds` — Request latency
- `robyn_active_connections` — Active connections
- `robyn_errors_total` — Error count by type

**Agent Metrics:**
- `agent_runs_total` — Total agent runs
- `agent_streams_active` — Active SSE streams
- `agent_execution_duration_seconds` — Agent execution time

**Storage Metrics:**
- `storage_assistants_total` — Total assistants
- `storage_threads_total` — Total threads
- `storage_runs_total` — Total runs
- `storage_store_items_total` — Store API items

### Grafana Dashboard

Sample PromQL queries:

```promql
# Request rate
rate(robyn_requests_total[5m])

# P95 latency
histogram_quantile(0.95, rate(robyn_request_duration_seconds_bucket[5m]))

# Error rate
rate(robyn_errors_total[5m]) / rate(robyn_requests_total[5m])

# Active streams
agent_streams_active

# Pod CPU usage
rate(container_cpu_usage_seconds_total{pod=~"robyn-runtime-.*"}[5m])
```

### Alerting Rules

```yaml
# prometheus-alerts.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: robyn-runtime-alerts
  namespace: oap
spec:
  groups:
  - name: robyn-runtime
    interval: 30s
    rules:
    - alert: HighErrorRate
      expr: |
        rate(robyn_errors_total[5m]) / rate(robyn_requests_total[5m]) > 0.05
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "High error rate detected"
        description: "Error rate is {{ $value | humanizePercentage }}"
    
    - alert: HighLatency
      expr: |
        histogram_quantile(0.95, rate(robyn_request_duration_seconds_bucket[5m])) > 5
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "High request latency"
        description: "P95 latency is {{ $value }}s"
    
    - alert: PodRestartingTooOften
      expr: |
        rate(kube_pod_container_status_restarts_total{pod=~"robyn-runtime-.*"}[1h]) > 0.1
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "Pod restarting frequently"
```

---

## Scaling & Performance

### Vertical Scaling

Adjust resources in deployment:

```yaml
resources:
  requests:
    cpu: 1000m      # 1 CPU core
    memory: 2Gi
  limits:
    cpu: 4000m      # 4 CPU cores
    memory: 8Gi
```

### Horizontal Scaling

Use HPA or manual scaling:

```bash
# Manual scale
kubectl scale deployment robyn-runtime --replicas=5 -n oap

# View HPA status
kubectl get hpa robyn-runtime -n oap

# Adjust HPA
kubectl patch hpa robyn-runtime -n oap -p '{"spec":{"maxReplicas":20}}'
```

### Performance Tuning

**Worker processes:**

```bash
# Formula: (2 × CPU cores) + 1
# For 4 CPU cores:
ROBYN_WORKERS=9
```

**Python optimizations:**

```bash
# In Dockerfile
ENV PYTHONOPTIMIZE=2        # Enable bytecode optimization
ENV PYTHONDONTWRITEBYTECODE=1  # Skip .pyc files
```

**Network tuning:**

```yaml
# Ingress annotations for SSE
nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"
nginx.ingress.kubernetes.io/proxy-send-timeout: "3600"
nginx.ingress.kubernetes.io/proxy-connect-timeout: "10"
nginx.ingress.kubernetes.io/proxy-buffering: "off"
nginx.ingress.kubernetes.io/proxy-request-buffering: "off"
```

### Load Testing

```bash
# Install k6
brew install k6  # macOS
# or download from https://k6.io/

# Run load test
k6 run load-test.js
```

**Sample k6 script:**

```javascript
// load-test.js
import http from 'k6/http';
import { check, sleep } from 'k6';

export let options = {
  stages: [
    { duration: '2m', target: 100 },  // Ramp up
    { duration: '5m', target: 100 },  // Stay at 100 users
    { duration: '2m', target: 0 },    // Ramp down
  ],
};

const BASE_URL = 'http://localhost:8081';
const TOKEN = 'your-jwt-token';

export default function () {
  let headers = {
    'Authorization': `Bearer ${TOKEN}`,
    'Content-Type': 'application/json',
  };

  // Health check
  let res = http.get(`${BASE_URL}/health`, { headers });
  check(res, { 'health check ok': (r) => r.status === 200 });

  sleep(1);
}
```

---

## Troubleshooting

### Common Issues

**Pods CrashLoopBackOff:**

```bash
# Check logs
kubectl logs -n oap -l app=robyn-runtime --tail=100

# Check events
kubectl get events -n oap --sort-by='.lastTimestamp'

# Describe pod
kubectl describe pod -n oap <pod-name>
```

Common causes:
- Missing environment variables
- Invalid Supabase credentials
- LLM backend unreachable
- Resource limits too low

**High memory usage:**

```bash
# Check current usage
kubectl top pods -n oap -l app=robyn-runtime

# Increase memory limits
kubectl patch deployment robyn-runtime -n oap -p \
  '{"spec":{"template":{"spec":{"containers":[{"name":"robyn-runtime","resources":{"limits":{"memory":"4Gi"}}}]}}}}'
```

**SSE streams not working:**

1. Check ingress buffering is disabled
2. Verify timeout settings
3. Test directly without ingress:
   ```bash
   kubectl port-forward -n oap svc/robyn-runtime 8081:80
   curl -N http://localhost:8081/runs/stream -H "Authorization: Bearer $TOKEN"
   ```

**Authentication failures:**

```bash
# Test Supabase connection
kubectl exec -it -n oap deployment/robyn-runtime -- \
  python -c "
import os
from supabase import create_client
client = create_client(os.getenv('SUPABASE_URL'), os.getenv('SUPABASE_KEY'))
print('Connected successfully')
"

# Verify secret
kubectl get secret robyn-runtime-secrets -n oap -o json | jq '.data | map_values(@base64d)'
```

### Debug Mode

Enable debug logging:

```yaml
env:
- name: ROBYN_DEV
  value: "true"
- name: PYTHONUNBUFFERED
  value: "1"
```

### Emergency Procedures

**Rollback deployment:**

```bash
# View rollout history
kubectl rollout history deployment/robyn-runtime -n oap

# Rollback to previous version
kubectl rollout undo deployment/robyn-runtime -n oap

# Rollback to specific revision
kubectl rollout undo deployment/robyn-runtime -n oap --to-revision=2
```

**Scale down/up for recovery:**

```bash
# Scale to 0 (emergency shutdown)
kubectl scale deployment robyn-runtime --replicas=0 -n oap

# Scale back up
kubectl scale deployment robyn-runtime --replicas=3 -n oap
```

---

## CI/CD Integration

### GitHub Actions Example

```yaml
# .github/workflows/deploy.yml
name: Build and Deploy Robyn Runtime

on:
  push:
    branches: [main]
    paths:
      - 'robyn_server/**'
      - 'tools_agent/**'

jobs:
  build-and-push:
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@v4
    
    - name: Set up Docker Buildx
      uses: docker/setup-buildx-action@v3
    
    - name: Login to GHCR
      uses: docker/login-action@v3
      with:
        registry: ghcr.io
        username: ${{ github.actor }}
        password: ${{ secrets.GITHUB_TOKEN }}
    
    - name: Build and push
      uses: docker/build-push-action@v5
      with:
        context: .
        file: robyn_server/Dockerfile
        push: true
        tags: |
          ghcr.io/${{ github.repository }}/robyn-runtime:latest
          ghcr.io/${{ github.repository }}/robyn-runtime:${{ github.sha }}
        cache-from: type=gha
        cache-to: type=gha,mode=max
  
  deploy:
    needs: build-and-push
    runs-on: ubuntu-latest
    steps:
    - uses: azure/setup-kubectl@v3
    
    - name: Set Kubernetes context
      uses: azure/aks-set-context@v3
      with:
        resource-group: ${{ secrets.AKS_RESOURCE_GROUP }}
        cluster-name: ${{ secrets.AKS_CLUSTER_NAME }}
    
    - name: Deploy to AKS
      run: |
        kubectl set image deployment/robyn-runtime \
          robyn-runtime=ghcr.io/${{ github.repository }}/robyn-runtime:${{ github.sha }} \
          -n oap
        
        kubectl rollout status deployment/robyn-runtime -n oap
```

---

## Additional Resources

- [Robyn Documentation](https://robyn.tech/documentation)
- [LangGraph API Reference](https://langchain-ai.github.io/langgraph/cloud/reference/api/api_ref.html)
- [Kubernetes Best Practices](https://kubernetes.io/docs/concepts/configuration/overview/)
- [Prometheus Monitoring](https://prometheus.io/docs/introduction/overview/)

---

**Deployment Checklist:**

- [ ] Environment variables configured
- [ ] Secrets created in Kubernetes
- [ ] Docker image built and pushed
- [ ] Deployment manifests applied
- [ ] Health checks passing
- [ ] Ingress/TLS configured
- [ ] HPA configured
- [ ] Monitoring/alerts set up
- [ ] Load testing completed
- [ ] Backup/disaster recovery plan
- [ ] Documentation updated

**Support:** For issues and questions, see the main project repository.