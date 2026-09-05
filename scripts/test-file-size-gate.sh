#!/usr/bin/env bash
# Proves the readability gate itself, on a throwaway repository: it rejects a
# file the change made too long, ignores a long file the change did not touch,
# and ignores an exempted artifact.
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
fixture_root=$(mktemp -d)
trap 'rm -rf "$fixture_root"' EXIT

# The path the gate exempts, and a path it does not.
readonly exempt_file=THIRD-PARTY-NOTICES.md
readonly checked_file=packages/compiler/src/oversized.ts

cp "$repo_root/scripts/validate-pr-file-sizes.sh" "$fixture_root/validate.sh"
git -C "$fixture_root" init -b main >/dev/null
git -C "$fixture_root" config user.email test@example.invalid
git -C "$fixture_root" config user.name "OpenShapeForge test"

long_file() {
  local path=$1 lines=$2 final_newline=$3
  mkdir -p "$fixture_root/$(dirname "$path")"
  awk -v total="$lines" -v newline="$final_newline" \
    'BEGIN { for (row=1; row<=total; row++) { printf "line"; if (row<total || newline=="yes") printf "\n" } }' \
    > "$fixture_root/$path"
}

# A pre-existing 500-line file on the base branch: nobody has to rewrite it.
long_file packages/compiler/src/inherited.ts 500 yes
git -C "$fixture_root" add packages/compiler/src/inherited.ts
git -C "$fixture_root" commit -m baseline >/dev/null
git -C "$fixture_root" checkout -b feature >/dev/null 2>&1

run_gate() {
  OPENSHAPEFORGE_PR_BASE_REF=main bash -c 'cd "$1" && bash validate.sh' _ "$fixture_root" 2>&1
}

# 1. Untouched inherited file only: the gate passes.
if ! run_gate >/dev/null; then
  echo "file-size gate rejected a pre-existing long file nobody touched" >&2
  exit 1
fi

# 2. An exempted artifact may grow.
long_file "$exempt_file" 900 yes
if ! run_gate >/dev/null; then
  echo "file-size gate rejected an exempted artifact: $exempt_file" >&2
  exit 1
fi

# 3. A new 401-line file WITHOUT a trailing newline is still 401 lines.
long_file "$checked_file" 401 no
output=$(run_gate) && {
  echo "file-size gate accepted 401 logical lines without a final newline" >&2
  exit 1
}
case "$output" in
  *"$checked_file"*"(401)"*) ;;
  *)
    echo "file-size gate did not name the file and its line count: $output" >&2
    exit 1
    ;;
esac

echo "File-size gate regression passed."
