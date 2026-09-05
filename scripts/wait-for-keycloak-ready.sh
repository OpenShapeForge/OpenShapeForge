#!/usr/bin/env bash
# SPDX-License-Identifier: BUSL-1.1
#
# Wait for a Keycloak container started with KC_HEALTH_ENABLED=true and host
# networking to report ready on its management port, or fail with the
# container's logs and remove it so the caller never has to.
#
#   scripts/wait-for-keycloak-ready.sh <container-name> [timeout-seconds]
#
# Used by .github/workflows/docker-keycloak.yml for every container it boots,
# so the poll loop exists once instead of drifting across steps.
set -euo pipefail

container="${1:?usage: $0 <container-name> [timeout-seconds]}"
timeout="${2:-90}"
# Keycloak serves health on the management port (9000), not 8080.
health_url="${KC_HEALTH_URL:-http://127.0.0.1:9000/health/ready}"

for i in $(seq 1 "$timeout"); do
  if curl -fsS "$health_url" 2>/dev/null | grep -q '"status": *"UP"'; then
    echo "keycloak ($container) ready after ${i}s"
    exit 0
  fi
  sleep 1
done

echo "::error::keycloak ($container) did not become ready within ${timeout}s"
docker logs "$container" || true
docker rm -f "$container" >/dev/null || true
exit 1
