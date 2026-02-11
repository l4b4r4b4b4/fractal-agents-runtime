# Robyn Runtime Helm Chart

Helm chart for deploying the Robyn-based LangGraph runtime server on Kubernetes.

## Prerequisites

- Kubernetes 1.21+
- Helm 3.8+
- Prometheus Operator (optional, for ServiceMonitor and PrometheusRule)
- Cert-manager (optional, for automatic TLS certificates)

## Installing the Chart

### Quick Start

```bash
# Add your Helm repository (if published)
helm repo add oap https://your-org.github.io/helm-charts
helm repo update

# Install with default values
helm install robyn-runtime oap/robyn-runtime \
  --namespace oap \
  --create-namespace
```

### Install from Local Chart

```bash
# From the helm directory
helm install robyn-runtime ./robyn-runtime \
  --namespace oap \
  --create-namespace \
  --values ./robyn-runtime/values.yaml
```

### Install with Custom Values

```bash
# Development
helm install robyn-runtime ./robyn-runtime \
  --namespace oap-dev \
  --create-namespace \
  --values ./robyn-runtime/values-dev.yaml

# Staging
helm install robyn-runtime ./robyn-runtime \
  --namespace oap-staging \
  --create-namespace \
  --values ./robyn-runtime/values-staging.yaml

# Production
helm install robyn-runtime ./robyn-runtime \
  --namespace oap-prod \
  --create-namespace \
  --values ./robyn-runtime/values-prod.yaml
```

## Configuration

### Secrets Management

**Option 1: Create Kubernetes Secret (Recommended)**

```bash
# Create secret from files
kubectl create secret generic robyn-runtime-secrets \
  --from-literal=supabase-key='your-supabase-key' \
  --from-literal=supabase-secret='your-supabase-secret' \
  --from-literal=openai-api-key='your-openai-key' \
  --from-literal=langchain-api-key='your-langsmith-key' \
  --namespace oap

# Then reference it in values
helm install robyn-runtime ./robyn-runtime \
  --set existingSecret.name=robyn-runtime-secrets
```

**Option 2: Use Helm Values (NOT for production)**

```bash
# Only for dev/testing
helm install robyn-runtime ./robyn-runtime \
  --set secrets.create=true \
  --set secrets.data.supabaseKey='your-key'
```

**Option 3: External Secret Operator**

```yaml
# external-secret.yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: robyn-runtime-secrets
spec:
  secretStoreRef:
    name: aws-secrets-manager
    kind: SecretStore
  target:
    name: robyn-runtime-secrets
  data:
    - secretKey: supabase-key
      remoteRef:
        key: prod/robyn-runtime/supabase-key
```

### Common Configuration Examples

**Custom Image:**

```bash
helm install robyn-runtime ./robyn-runtime \
  --set image.repository=ghcr.io/your-org/robyn-runtime \
  --set image.tag=v1.2.3
```

**Custom Resource Limits:**

```bash
helm install robyn-runtime ./robyn-runtime \
  --set resources.limits.cpu=4000m \
  --set resources.limits.memory=4Gi \
  --set resources.requests.cpu=1000m \
  --set resources.requests.memory=2Gi
```

**Custom Ingress:**

```bash
helm install robyn-runtime ./robyn-runtime \
  --set ingress.enabled=true \
  --set ingress.hosts[0].host=api.example.com \
  --set ingress.tls[0].secretName=api-tls \
  --set ingress.tls[0].hosts[0]=api.example.com
```

**Custom vLLM Backend:**

```bash
helm install robyn-runtime ./robyn-runtime \
  --set config.llm.openaiApiBase=http://vllm.ai-infra.svc.cluster.local/v1 \
  --set config.llm.modelName=mistral-7b
```

## Upgrading

```bash
# Upgrade with new values
helm upgrade robyn-runtime ./robyn-runtime \
  --namespace oap \
  --values ./robyn-runtime/values-prod.yaml

# Upgrade with new image version
helm upgrade robyn-runtime ./robyn-runtime \
  --namespace oap \
  --set image.tag=v0.2.0

# Force recreation of pods
helm upgrade robyn-runtime ./robyn-runtime \
  --namespace oap \
  --recreate-pods
```

## Uninstalling

```bash
helm uninstall robyn-runtime --namespace oap
```

## Configuration Reference

### Global Parameters

| Parameter | Description | Default |
|-----------|-------------|---------|
| `image.repository` | Image repository | `ghcr.io/your-org/robyn-runtime` |
| `image.pullPolicy` | Image pull policy | `IfNotPresent` |
| `image.tag` | Image tag | `0.1.0` |
| `replicaCount` | Number of replicas | `3` |

### Application Configuration

| Parameter | Description | Default |
|-----------|-------------|---------|
| `config.host` | Server bind address | `0.0.0.0` |
| `config.port` | Server port | `8081` |
| `config.workers` | Number of workers | `4` |
| `config.devMode` | Enable development mode | `false` |
| `config.supabase.url` | Supabase URL | `""` |
| `config.llm.openaiApiBase` | LLM API base URL | `""` |
| `config.llm.modelName` | Default model name | `""` |

### Security

| Parameter | Description | Default |
|-----------|-------------|---------|
| `podSecurityContext` | Pod security context | See values.yaml |
| `securityContext` | Container security context | See values.yaml |
| `existingSecret.name` | Existing secret name | `robyn-runtime-secrets` |
| `networkPolicy.enabled` | Enable network policies | `true` |

### Autoscaling

| Parameter | Description | Default |
|-----------|-------------|---------|
| `autoscaling.enabled` | Enable HPA | `true` |
| `autoscaling.minReplicas` | Minimum replicas | `3` |
| `autoscaling.maxReplicas` | Maximum replicas | `10` |
| `autoscaling.targetCPUUtilizationPercentage` | Target CPU % | `70` |

### Ingress

| Parameter | Description | Default |
|-----------|-------------|---------|
| `ingress.enabled` | Enable ingress | `true` |
| `ingress.className` | Ingress class name | `nginx` |
| `ingress.hosts` | Ingress hosts | See values.yaml |
| `ingress.tls` | Ingress TLS configuration | See values.yaml |

### Monitoring

| Parameter | Description | Default |
|-----------|-------------|---------|
| `serviceMonitor.enabled` | Enable ServiceMonitor | `true` |
| `serviceMonitor.interval` | Scrape interval | `30s` |
| `prometheusRule.enabled` | Enable PrometheusRule | `true` |

## Examples

### Multi-Environment Deployment

```bash
# Deploy to dev
helm install robyn-dev ./robyn-runtime \
  -n oap-dev --create-namespace \
  -f values-dev.yaml

# Deploy to staging
helm install robyn-staging ./robyn-runtime \
  -n oap-staging --create-namespace \
  -f values-staging.yaml

# Deploy to production
helm install robyn-prod ./robyn-runtime \
  -n oap-prod --create-namespace \
  -f values-prod.yaml
```

### Blue-Green Deployment

```bash
# Deploy green
helm install robyn-green ./robyn-runtime \
  -n oap \
  --set nameOverride=robyn-green \
  --set service.selector.version=green

# Test green deployment
kubectl port-forward -n oap svc/robyn-green 8081:80

# Switch traffic (update ingress)
# Then remove blue
helm uninstall robyn-blue -n oap
```

### Canary Deployment with Flagger

```yaml
# canary.yaml
apiVersion: flagger.app/v1beta1
kind: Canary
metadata:
  name: robyn-runtime
  namespace: oap
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: robyn-runtime
  service:
    port: 80
  analysis:
    interval: 1m
    threshold: 5
    maxWeight: 50
    stepWeight: 10
    metrics:
    - name: request-success-rate
      thresholdRange:
        min: 99
      interval: 1m
```

## Troubleshooting

### Check Deployment Status

```bash
# Get deployment status
helm status robyn-runtime -n oap

# Get all resources
kubectl get all -n oap -l app.kubernetes.io/name=robyn-runtime

# Check pod logs
kubectl logs -n oap -l app.kubernetes.io/name=robyn-runtime -f

# Describe deployment
kubectl describe deployment -n oap robyn-runtime
```

### Common Issues

**Pods not starting:**
```bash
kubectl describe pod -n oap -l app.kubernetes.io/name=robyn-runtime
kubectl logs -n oap <pod-name>
```

**Secret not found:**
```bash
kubectl get secrets -n oap
kubectl create secret generic robyn-runtime-secrets --from-literal=supabase-key=xyz
```

**Ingress not working:**
```bash
kubectl get ingress -n oap
kubectl describe ingress -n oap robyn-runtime
```

## Testing

```bash
# Dry run installation
helm install robyn-runtime ./robyn-runtime \
  --namespace oap \
  --dry-run --debug

# Template validation
helm template robyn-runtime ./robyn-runtime \
  --namespace oap \
  --values values-prod.yaml

# Lint chart
helm lint ./robyn-runtime
```

## Development

```bash
# Package chart
helm package ./robyn-runtime

# Update dependencies
helm dependency update ./robyn-runtime

# Generate documentation
helm-docs
```

## License

See parent project license.

## Support

For issues and questions, see the main project repository.
