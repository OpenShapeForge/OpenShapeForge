#!/usr/bin/env bash
# SPDX-License-Identifier: BUSL-1.1
# Starts the script sandbox container with every isolation control applied from
# outside. Usage: deploy/script-sandbox/run.sh [image] [name] [volume]
# The caller (API or runner) mounts the same volume at /run/script-sandbox and
# joins group 10002; it gets no Docker socket and no other path into this container.
set -euo pipefail

image="${1:-openshapeforge-script-sandbox:dev}"
name="${2:-osf-script-sandbox}"
volume="${3:-osf-script-sandbox-ipc}"

docker volume inspect "$volume" >/dev/null 2>&1 || docker volume create "$volume" >/dev/null

exec docker run -d --name "$name" \
  --init \
  --network none \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m \
  --user 10001:10002 \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --pids-limit 64 \
  --memory 512m --memory-swap 512m \
  --cpus 2 \
  --restart unless-stopped \
  -v "$volume":/run/script-sandbox \
  "$image"
