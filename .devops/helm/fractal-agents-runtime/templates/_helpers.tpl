{{/*
Expand the name of the chart.
*/}}
{{- define "fractal-agents-runtime.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "fractal-agents-runtime.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "fractal-agents-runtime.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "fractal-agents-runtime.labels" -}}
helm.sh/chart: {{ include "fractal-agents-runtime.chart" . }}
{{ include "fractal-agents-runtime.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/component: runtime
app.kubernetes.io/part-of: fractal-agents
{{- end }}

{{/*
Selector labels
*/}}
{{- define "fractal-agents-runtime.selectorLabels" -}}
app.kubernetes.io/name: {{ include "fractal-agents-runtime.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Create the name of the service account to use.
*/}}
{{- define "fractal-agents-runtime.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "fractal-agents-runtime.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Runtime-conditional container image.
If image.repository is set explicitly, use it.
Otherwise, derive from the runtime value.
*/}}
{{- define "fractal-agents-runtime.image" -}}
{{- if .Values.image.repository }}
{{- .Values.image.repository }}
{{- else if eq .Values.runtime "ts" }}
{{- "ghcr.io/l4b4r4b4b4/fractal-agents-runtime-ts" }}
{{- else }}
{{- "ghcr.io/l4b4r4b4b4/fractal-agents-runtime-python" }}
{{- end }}
{{- end }}

{{/*
Runtime-conditional container port.
Python default: 8081, TypeScript default: 3000.
Explicit overrides via python.port / typescript.port are honoured.
*/}}
{{- define "fractal-agents-runtime.port" -}}
{{- if eq .Values.runtime "ts" }}
{{- .Values.typescript.port | default 3000 }}
{{- else }}
{{- .Values.python.port | default 8081 }}
{{- end }}
{{- end }}

{{/*
Runtime-conditional image tag.
Falls back to Chart.appVersion if image.tag is empty.
*/}}
{{- define "fractal-agents-runtime.imageTag" -}}
{{- .Values.image.tag | default .Chart.AppVersion }}
{{- end }}

{{/*
Full image reference with tag.
*/}}
{{- define "fractal-agents-runtime.imageRef" -}}
{{- printf "%s:%s" (include "fractal-agents-runtime.image" .) (include "fractal-agents-runtime.imageTag" .) }}
{{- end }}

{{/*
Runtime label value — "python" or "ts".
Useful for pod labels and selectors.
*/}}
{{- define "fractal-agents-runtime.runtimeLabel" -}}
{{- .Values.runtime | default "python" }}
{{- end }}

{{/*
Secret name — use existingSecret.name if provided, otherwise generate from fullname.
*/}}
{{- define "fractal-agents-runtime.secretName" -}}
{{- if .Values.existingSecret.name }}
{{- .Values.existingSecret.name }}
{{- else }}
{{- printf "%s-secrets" (include "fractal-agents-runtime.fullname" .) }}
{{- end }}
{{- end }}
