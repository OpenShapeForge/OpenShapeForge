#!/usr/bin/env bash
# Readability gate: every file a change TOUCHES stays LLM-readable.
#
# Scoped to the change rather than the tree on purpose — this repository has 155
# files over 400 lines today, and forcing a rewrite on whoever happens to edit
# one line of one of them is not a review this gate can make.
set -euo pipefail

readonly max_lines=400
readonly max_source_line_length=750
readonly max_text_line_length=1200
base_ref=${OPENSHAPEFORGE_PR_BASE_REF:-}

if [[ -z "$base_ref" && -n "${GITHUB_BASE_REF:-}" ]]; then
  base_ref="refs/remotes/origin/${GITHUB_BASE_REF}"
fi
if [[ -z "$base_ref" ]]; then
  # `main` is the integration branch this repository's ruleset protects. The
  # GITHUB_BASE_REF branch above matters here: a pull request stacked on
  # another feature branch is a shape this repository produces on purpose
  # (ci.yml, #240), and it must be measured against ITS base, not against main.
  base_ref=origin/main
fi

git rev-parse --verify "$base_ref^{commit}" >/dev/null 2>&1 || {
  echo "Cannot resolve PR base ref: $base_ref" >&2
  exit 2
}

base_commit=$(git merge-base "$base_ref" HEAD)
violations=0

is_generated_artifact() {
  case ${1:?file path is required} in
    # Almost everything `bun run generate` writes is gitignored (see
    # packages/compiler/src/generated-artifact-paths.ts against .gitignore), so
    # it never reaches a diff. This is the one compiler-owned file that is
    # committed, and check:generated proves it is byte-identical across runs.
    packages/compiler/config/referentiedata/core-by-groep.json) return 0 ;;
    # Emitted by `bun run notices` from the dependency tree and gated by
    # check:notices — its length is the tree's, not an author's.
    THIRD-PARTY-NOTICES.md) return 0 ;;
    # Written by `bun install`; CI installs it with --frozen-lockfile.
    bun.lock) return 0 ;;
    # A verbatim snapshot of the VERA standard's reference lists, imported as
    # data by apps/web/src/lib/vera-referentiedata.ts. Splitting it would make
    # this repository's copy diverge from the published standard.
    apps/web/src/lib/vera-referentiedata-by-soort.json) return 0 ;;
    # An authored entity contract is one declarative file per entity: the
    # authoring loader resolves an entity from exactly one path, so its length
    # is the model it describes and "split it" would rename the entity.
    # Catalogs, compiler source, runtime code, scripts and prose stay in scope.
    */authoring/entities/*) return 0 ;;
    *) return 1 ;;
  esac
}

check_file() {
  local file_path=${1:?file path is required}
  local extension line_count long_line probe_status

  [[ -f "$file_path" ]] || return 0
  is_generated_artifact "$file_path" && return

  # Git content containing NUL bytes is not LLM-readable source text.
  set +e
  LC_ALL=C grep -Iq '' -- "$file_path"
  probe_status=$?
  set -e
  case "$probe_status" in
    0) ;;
    1) return ;;
    *)
      printf 'Cannot classify changed file as text or binary: %q\n' "$file_path" >&2
      violations=$((violations + 1))
      return
      ;;
  esac

  line_count=$(LC_ALL=C awk 'END { print NR }' "$file_path")
  if (( line_count > max_lines )); then
    printf 'LLM-readable PR file exceeds %d lines: %s (%d)\n' \
      "$max_lines" "$file_path" "$line_count" >&2
    violations=$((violations + 1))
  fi
  extension=${file_path##*.}
  case "$extension" in
    ts|tsx|js|jsx|mjs|sh|yml|yaml|json|sql|java)
      long_line=$(LC_ALL=C awk -v maximum="$max_source_line_length" 'length($0)>maximum {print NR ":" length($0); exit}' "$file_path")
      if [[ -n "$long_line" ]]; then
        printf 'LLM-readable PR source line exceeds %d characters: %s:%s\n' \
          "$max_source_line_length" "$file_path" "$long_line" >&2
        violations=$((violations + 1))
      fi
      ;;
  esac
  long_line=$(LC_ALL=C awk -v maximum="$max_text_line_length" 'length($0)>maximum {print NR ":" length($0); exit}' "$file_path")
  if [[ -n "$long_line" ]]; then
    printf 'LLM-readable PR text line exceeds %d characters: %s:%s\n' \
      "$max_text_line_length" "$file_path" "$long_line" >&2
    violations=$((violations + 1))
  fi
}

check_paths() {
  local file_path
  while IFS= read -r -d '' file_path; do
    check_file "$file_path"
  done
}

check_paths < <(git diff --name-only --diff-filter=ACMR -z "$base_commit" HEAD)
check_paths < <(git diff --name-only --diff-filter=ACMR -z)
check_paths < <(git ls-files --others --exclude-standard -z)

if (( violations > 0 )); then
  echo "Split each reported file on coherent responsibility boundaries." >&2
  exit 1
fi

echo "PR readability gate passed: changed non-generated text files are at most ${max_lines} lines, source lines at most ${max_source_line_length} characters, and other text lines at most ${max_text_line_length} characters."
