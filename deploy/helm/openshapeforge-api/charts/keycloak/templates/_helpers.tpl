{{- define "keycloak.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "keycloak.fullname" -}}
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

{{- define "keycloak.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
app.kubernetes.io/name: {{ include "keycloak.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "keycloak.selectorLabels" -}}
app.kubernetes.io/name: {{ include "keycloak.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "keycloak.secretName" -}}
{{- if .Values.database.existingSecret -}}
{{- .Values.database.existingSecret -}}
{{- else -}}
{{- include "keycloak.fullname" . -}}
{{- end -}}
{{- end -}}

{{- define "keycloak.realmSecretName" -}}
{{- if .Values.realm.existingSecret -}}
{{- .Values.realm.existingSecret -}}
{{- else -}}
{{- printf "%s-realm" (include "keycloak.fullname" .) -}}
{{- end -}}
{{- end -}}

{{/*
True when a realm should be mounted and imported: either inline JSON was
supplied (--set-file) or an existing Secret was named.
*/}}
{{- define "keycloak.realmEnabled" -}}
{{- if and .Values.realm.enabled (or .Values.realm.json .Values.realm.existingSecret) -}}
true
{{- end -}}
{{- end -}}

{{/*
Image pull secrets, preferring the subchart's own list and falling back to the
parent's global list so a single --set at the top level covers both workloads.
*/}}
{{- define "keycloak.imagePullSecrets" -}}
{{- $secrets := .Values.imagePullSecrets -}}
{{- if and (not $secrets) .Values.global -}}
{{- $secrets = .Values.global.imagePullSecrets -}}
{{- end -}}
{{- with $secrets }}
imagePullSecrets:
{{- toYaml . | nindent 2 }}
{{- end }}
{{- end -}}
