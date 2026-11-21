#!/usr/bin/env bash
# SPDX-License-Identifier: BUSL-1.1
# Builds the sandbox image, starts it with run.sh, asserts the container controls
# from outside, then proves the Unix-socket path from a separate, network-less
# caller container that shares only the socket volume. Needs Docker; cleans up.
# Run from the repository root: deploy/script-sandbox/verify.sh
set -euo pipefail

image=openshapeforge-script-sandbox:verify
name="osf-script-sandbox-verify-$$"
volume="${name}-ipc"
bun_image="oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d"

cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; docker volume rm "$volume" >/dev/null 2>&1 || true; }
trap cleanup EXIT

check() { if ! "$@"; then echo "FAIL: $*" >&2; exit 1; fi; }
inspect() { docker inspect -f "$1" "$name"; }

docker build -f deploy/script-sandbox/Dockerfile -t "$image" .
deploy/script-sandbox/run.sh "$image" "$name" "$volume" >/dev/null

# Controls applied from outside.
check test "$(inspect '{{.HostConfig.NetworkMode}}')" = none
check test "$(inspect '{{.HostConfig.ReadonlyRootfs}}')" = true
check test "$(inspect '{{.Config.User}}')" = 10001:10002
check test "$(inspect '{{.HostConfig.CapDrop}}')" = "[ALL]"
check test "$(inspect '{{.HostConfig.SecurityOpt}}')" = "[no-new-privileges]"
# The only mount is the socket volume: no app code, data, secrets or Docker socket.
check test "$(inspect '{{range .Mounts}}{{.Destination}} {{end}}')" = "/run/script-sandbox "
# Observed from inside: only loopback, and the root filesystem rejects writes.
check test "$(docker exec "$name" ls /sys/class/net)" = lo
if docker exec "$name" touch /probe 2>/dev/null; then echo "FAIL: rootfs is writable" >&2; exit 1; fi

# Wait for the socket, then drive it from a separate caller container.
for _ in $(seq 1 50); do
  docker exec "$name" test -S /run/script-sandbox/sandbox.sock 2>/dev/null && break
  sleep 0.2
done
docker run --rm --network none --read-only --user 10003:10003 --group-add 10002 --cap-drop ALL \
  -v "$volume":/run/script-sandbox:ro \
  -v "$PWD/apps/api/src/script-sandbox":/proof:ro \
  "$bun_image" bun /proof/container-proof.ts /run/script-sandbox/sandbox.sock

# After the proof (including its cancelled run) no worker may remain.
sleep 1
if docker top "$name" | grep -q worker.ts; then echo "FAIL: orphaned worker process" >&2; exit 1; fi
echo "VERIFY OK"
