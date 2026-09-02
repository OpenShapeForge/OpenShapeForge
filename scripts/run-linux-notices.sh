#!/usr/bin/env bash
# SPDX-License-Identifier: BUSL-1.1
set -euo pipefail

if [[ $# -gt 1 || ($# -eq 1 && "$1" != "--check") ]]; then
  echo "Usage: $0 [--check]" >&2
  exit 2
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
image="oven/bun:1.3.4@sha256:7608db4aeb44f1fe8169cc8ec7055376b3013557b106407ccf092b00e426407d"
output_mount=(-v /out)
mode=write

if [[ ${1:-} == "--check" ]]; then
  mode=check
else
  output_mount=(-v "$repo_root/THIRD-PARTY-NOTICES.md:/out/THIRD-PARTY-NOTICES.md")
fi

# Source is streamed into the Docker-managed /w volume. Container UID 0 works
# with both rootful Docker and rootless Docker's user mapping, without exposing
# any host node_modules directory to subordinate UID writes.
run_container() {
  docker run --rm -i --platform linux/amd64 \
    -e HOME=/tmp \
    -v /w \
    "${output_mount[@]}" \
    -w /w \
    "$image" \
    sh -ec '
      tar -xf -
      bun install --frozen-lockfile >/dev/null 2>&1
      if [ "$0" = check ]; then
        bun scripts/gen-third-party-notices.ts --check
      else
        bun scripts/gen-third-party-notices.ts
        cp THIRD-PARTY-NOTICES.md /out/THIRD-PARTY-NOTICES.md
      fi
    ' "$mode"
}

# Both modes operate on the exact commit CI will test. This also excludes all
# ignored/untracked material, including every nested node_modules directory.
git -C "$repo_root" archive --format=tar HEAD | run_container
