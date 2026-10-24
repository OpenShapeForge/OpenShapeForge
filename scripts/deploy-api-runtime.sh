#!/usr/bin/env bash
# Update a published API runtime while retaining the installed identity configuration.
set -euo pipefail
[[ "${RELEASE:-}" == openshapeforge && "${NAMESPACE:-}" == openshapeforge ]] || { echo 'Expected the existing OpenShapeForge release and namespace.' >&2; exit 1; }
[[ "${IMAGE_TAG:-}" =~ ^sha-[a-f0-9]{7,40}$ ]] || { echo 'A published commit image tag is required.' >&2; exit 1; }
[[ "${API_IMAGE_DIGEST:-}" =~ ^sha256:[a-f0-9]{64}$ ]] || { echo 'An immutable API image digest is required.' >&2; exit 1; }
case "${1:-}" in
  --validate-only) exit 0 ;;
  ''|--check-release) ;;
  *) echo 'Unknown runtime deployment mode.' >&2; exit 1 ;;
esac
# Never create a release or race an unfinished upgrade.
helm status "$RELEASE" --namespace "$NAMESPACE" --output json |
  jq -e '.info.status == "deployed"' >/dev/null
[[ "${1:-}" != --check-release ]] || exit 0
# No realm generation, realm import, credential rotation or Keycloak overrides.
# The normal migration hooks still run from the selected immutable API image.
exec helm upgrade "$RELEASE" ./deploy/helm/openshapeforge-api \
  --namespace "$NAMESPACE" --reuse-values \
  --set-string image.repository=ghcr.io/openshapeforge/openshapeforge-api \
  --set-string "image.tag=${IMAGE_TAG}@${API_IMAGE_DIGEST}" \
  --wait --timeout 15m
