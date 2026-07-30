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
