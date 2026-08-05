{{- define "openshapeforge-api.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "openshapeforge-api.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "openshapeforge-api.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
app.kubernetes.io/name: {{ include "openshapeforge-api.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "openshapeforge-api.selectorLabels" -}}
app.kubernetes.io/name: {{ include "openshapeforge-api.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/*
Names and labels for the worker workload (templates/worker-deployment.yaml).

`app.kubernetes.io/name` deliberately DIFFERS from the API's rather than being
distinguished only by `app.kubernetes.io/component`. A Service selector is a
SUBSET match: a pod carrying `name` + `instance` is an endpoint of the API
Service no matter what else is on it, so a worker labelled like the API would
be sent a share of every request and refuse all of it — it listens on nothing.
The alternative, narrowing the API Service's selector, is not available: a
Deployment's `spec.selector` is immutable once installed, so existing releases
could not be upgraded into it, and it would change the render even with the
worker disabled.
*/}}
{{- define "openshapeforge-api.workerName" -}}
{{- printf "%s-worker" (include "openshapeforge-api.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "openshapeforge-api.workerFullname" -}}
{{- printf "%s-worker" (include "openshapeforge-api.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "openshapeforge-api.workerSelectorLabels" -}}
app.kubernetes.io/name: {{ include "openshapeforge-api.workerName" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: worker
{{- end -}}

{{- define "openshapeforge-api.workerLabels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{ include "openshapeforge-api.workerSelectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{/*
The worker role, refused rather than defaulted when it names no worker.

`apps/api/src/index.ts` reads `OPENSHAPEFORGE_ROLE?.trim() || "api"`, so an
empty value — or a literal `api` — starts a second copy of the HTTP server
instead of a worker: no Service in front of it, no probes, and a grace period
sized for a queue drain. That is silent in every place an operator would look,
which is exactly what the chart's other fail-closed guards exist for.
*/}}
{{- define "openshapeforge-api.workerRole" -}}
{{- $role := .Values.workers.role | default "" | trim -}}
{{- if or (not $role) (eq $role "api") -}}
{{- fail "workers.enabled=true requires workers.role to name a module-contributed worker role (e.g. workflow-worker). Empty, or \"api\", would start a second copy of the HTTP server with no Service and no probes." -}}
{{- end -}}
{{- $role -}}
{{- end -}}

{{- define "openshapeforge-api.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "openshapeforge-api.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "openshapeforge-api.secretName" -}}
{{- if .Values.database.existingSecret -}}
{{- .Values.database.existingSecret -}}
{{- else -}}
{{- include "openshapeforge-api.fullname" . -}}
{{- end -}}
{{- end -}}

{{/*
Image pull secrets for the API pods and the migration Job. Prefers this chart's
own imagePullSecrets and falls back to global.imagePullSecrets, so one --set at
the top level covers the API and the Keycloak subchart together. Needed because
the GHCR packages are private.
*/}}
{{- define "openshapeforge-api.imagePullSecrets" -}}
{{- $secrets := .Values.imagePullSecrets -}}
{{- if and (not $secrets) .Values.global -}}
{{- $secrets = .Values.global.imagePullSecrets -}}
{{- end -}}
{{- with $secrets }}
imagePullSecrets:
{{- toYaml . | nindent 2 }}
{{- end }}
{{- end -}}

{{/*
Rolls the pods when a chart-managed credential changes.

Every secret value reaches the container by secretKeyRef, so rotating
database.url or auth.internalContextSecret updates the Secret object while
leaving the pod spec byte-identical — Kubernetes then has no reason to restart
anything, and the API keeps serving with the credential the operator just
rotated away. Hashing the rendered Secret into a pod annotation makes the pod
spec change with the credential.

Emitted ONLY for the chart-managed Secret: with database.existingSecret the
contents live outside this release and cannot be hashed from here, so the
annotation would be a constant and would falsely imply rotation coverage.
NOTES.txt tells the operator to restart the Deployment themselves in that case.
*/}}
{{- define "openshapeforge-api.secretChecksumAnnotation" -}}
{{- if not .Values.database.existingSecret -}}
checksum/secret: {{ include (print $.Template.BasePath "/secret.yaml") . | sha256sum }}
{{- end -}}
{{- end -}}

{{/*
Non-secret env shared by the API container and the migration Job.
NODE_ENV=production is always set, which triggers the production env validator.
*/}}
{{- define "openshapeforge-api.commonEnv" -}}
- name: NODE_ENV
  value: "production"
- name: PORT
  value: "3001"
- name: HOST
  value: "0.0.0.0"
- name: OPENSHAPEFORGE_API_VERIFY_BEARER_JWKS_URI
  value: {{ .Values.auth.bearer.jwksUri | quote }}
- name: OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER
  value: {{ .Values.auth.bearer.issuer | quote }}
- name: OPENSHAPEFORGE_API_VERIFY_BEARER_AUDIENCE
  value: {{ .Values.auth.bearer.audience | quote }}
{{- if .Values.auth.tenantBypassRoles }}
- name: APP_TENANT_BYPASS_ROLES
  value: {{ .Values.auth.tenantBypassRoles | quote }}
{{- end }}
- name: API_RATE_LIMIT_MAX
  value: {{ .Values.limits.rateLimit.max | quote }}
- name: API_RATE_LIMIT_WINDOW_MS
  value: {{ .Values.limits.rateLimit.windowMs | quote }}
{{- with .Values.limits.rateLimit.maxTrusted }}
- name: API_RATE_LIMIT_MAX_TRUSTED
  value: {{ . | quote }}
{{- end }}
{{- if and .Values.limits.rateLimit.redisUrl .Values.limits.rateLimit.redisUrlSecret.name }}
{{- fail "Set limits.rateLimit.redisUrl OR limits.rateLimit.redisUrlSecret, not both — two sources for one URL is a silent-precedence bug waiting to happen." }}
{{- end }}
{{- with .Values.limits.rateLimit.redisUrl }}
- name: API_RATE_LIMIT_REDIS_URL
  value: {{ . | quote }}
{{- end }}
{{- with .Values.limits.rateLimit.redisUrlSecret.name }}
- name: API_RATE_LIMIT_REDIS_URL
  valueFrom:
    secretKeyRef:
      name: {{ . | quote }}
      key: {{ $.Values.limits.rateLimit.redisUrlSecret.key | quote }}
{{- end }}
- name: API_REQUEST_TIMEOUT_MS
  value: {{ .Values.limits.requestTimeoutMs | quote }}
- name: DB_STATEMENT_TIMEOUT_MS
  value: {{ .Values.limits.dbStatementTimeoutMs | quote }}
- name: API_TRUST_PROXY
  value: {{ .Values.limits.trustProxy | quote }}
- name: OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET
  valueFrom:
    secretKeyRef:
      name: {{ include "openshapeforge-api.secretName" . }}
      key: OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET
{{- end -}}
