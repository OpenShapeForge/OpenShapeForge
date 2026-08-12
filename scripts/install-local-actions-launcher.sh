#!/usr/bin/env bash
# SPDX-License-Identifier: BUSL-1.1

set -euo pipefail

if (( EUID == 0 )); then
  echo "Run this installer as the GUI runner operator; it invokes sudo only for the root-owned install step" >&2
  exit 1
fi

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SOURCE="${SCRIPT_DIR}/local-actions-launcher.c"
readonly TARGET="/usr/local/libexec/openshapeforge-actions-launcher"
readonly ISOLATION_GROUP="${OPENSHAPEFORGE_RUNNER_ISOLATION_GROUP:-_osfci}"
readonly RUNNER_UID="$(id -u)"
readonly RUNNER_HOME="${HOME}"
readonly SUPERVISOR_PATH="${RUNNER_HOME}/Library/Application Support/OpenShapeForge Actions/local-actions-runners.sh"

(( $# == 0 )) || {
  echo "Usage: $0" >&2
  exit 2
}

c_string() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

for tool in awk cc dscl install sed stat sudo; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "Required launcher installation tool is missing: ${tool}" >&2
    exit 1
  }
done

group_id="$(dscl . -read "/Groups/${ISOLATION_GROUP}" PrimaryGroupID 2>/dev/null | awk '{ print $2 }')"
[[ "$group_id" =~ ^[0-9]+$ ]] || {
  echo "Host isolation group is missing" >&2
  exit 1
}

build_dir="$(mktemp -d)"
trap 'rm -rf "$build_dir"' EXIT
config="${build_dir}/launcher-config.h"
binary="${build_dir}/openshapeforge-actions-launcher"
printf '#define OSF_SUPERVISOR_PATH "%s"\n#define OSF_RUNNER_HOME "%s"\n#define OSF_RUNNER_UID %s\n' \
  "$(c_string "$SUPERVISOR_PATH")" "$(c_string "$RUNNER_HOME")" "$RUNNER_UID" >"$config"

cc -std=c11 -Wall -Wextra -Werror -include "$config" "$SOURCE" -o "$binary"
sudo install -d -o root -g wheel -m 0755 "$(dirname "$TARGET")"
sudo install -o root -g "$ISOLATION_GROUP" -m 2755 "$binary" "$TARGET"

launcher_state="$(stat -f '%u:%g:%Mp%Lp' "$TARGET")"
[[ "$launcher_state" == "0:${group_id}:2755" ]] || {
  echo "Root-owned setgid runner launcher was not installed correctly" >&2
  exit 1
}
[[ "$("$TARGET" --print-egid)" == "${group_id}:slot-argument-v1" ]] || {
  echo "Runner launcher did not assume the isolation group" >&2
  exit 1
}
