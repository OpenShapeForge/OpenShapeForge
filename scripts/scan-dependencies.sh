#!/usr/bin/env bash
set -euo pipefail

readonly SCANNER_VERSION="2.3.8"
readonly REPOSITORY_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
readonly LOCKFILE="${REPOSITORY_ROOT}/bun.lock"

if [[ ! -f "${LOCKFILE}" ]]; then
  echo "Dependency scan failed: ${LOCKFILE} does not exist." >&2
  exit 2
fi

case "$(uname -s):$(uname -m)" in
  Darwin:arm64)
    readonly SCANNER_ASSET="osv-scanner_darwin_arm64"
    readonly SCANNER_SHA256="a8cd6507b06239f463a7642430cfd2d154882f150f6e30cdc0653e28dfc34216"
    ;;
  Darwin:x86_64)
    readonly SCANNER_ASSET="osv-scanner_darwin_amd64"
    readonly SCANNER_SHA256="b8a80a9f14ca4c0cd0fc2d351b28f740da9e6a5b18385ac9f9d083360b5b504e"
    ;;
  Linux:x86_64)
    readonly SCANNER_ASSET="osv-scanner_linux_amd64"
    readonly SCANNER_SHA256="bc98e15319ed0d515e3f9235287ba53cdc5535d576d24fd573978ecfe9ab92dc"
    ;;
  Linux:aarch64|Linux:arm64)
    readonly SCANNER_ASSET="osv-scanner_linux_arm64"
    readonly SCANNER_SHA256="8158b18edd2d03b1a30d905ca91b032bc62262167be8f206c27114f08823e27c"
    ;;
  *)
    echo "Dependency scan failed: unsupported platform $(uname -s)/$(uname -m)." >&2
    exit 2
    ;;
esac

readonly SCANNER_URL="https://github.com/google/osv-scanner/releases/download/v${SCANNER_VERSION}/${SCANNER_ASSET}"
readonly CACHE_ROOT="${OSV_SCANNER_CACHE_DIR:-${XDG_CACHE_HOME:-${TMPDIR:-/tmp}/openshapeforge-osv-scanner}}"
readonly SCANNER_PATH="${CACHE_ROOT}/osv-scanner-${SCANNER_VERSION}-${SCANNER_ASSET}"

verify_sha256() {
  local file="$1"

  if command -v sha256sum >/dev/null 2>&1; then
    printf '%s  %s\n' "${SCANNER_SHA256}" "${file}" | sha256sum --check --status -
  elif command -v shasum >/dev/null 2>&1; then
    printf '%s  %s\n' "${SCANNER_SHA256}" "${file}" | shasum --algorithm 256 --check --status -
  else
    echo "Dependency scan failed: sha256sum or shasum is required to verify the scanner." >&2
    exit 2
  fi
}

download_scanner() {
  local temporary_path

  command -v curl >/dev/null 2>&1 || {
    echo "Dependency scan failed: curl is required to download OSV-Scanner ${SCANNER_VERSION}." >&2
    exit 2
  }

  mkdir -p "${CACHE_ROOT}"
  temporary_path="$(mktemp "${SCANNER_PATH}.tmp.XXXXXX")"
  trap 'rm -f -- "${temporary_path}"' EXIT

  echo "Downloading OSV-Scanner ${SCANNER_VERSION} (${SCANNER_ASSET})..." >&2
  curl --fail --location --silent --show-error --retry 3 --proto '=https' --tlsv1.2 \
    "${SCANNER_URL}" --output "${temporary_path}"
  verify_sha256 "${temporary_path}"
  chmod 755 "${temporary_path}"
  mv -- "${temporary_path}" "${SCANNER_PATH}"
  trap - EXIT
}

if [[ ! -x "${SCANNER_PATH}" ]] || ! verify_sha256 "${SCANNER_PATH}"; then
  download_scanner
fi

# Gate contract: fail on every known OSV vulnerability, including advisories
# without a CVSS severity. OSV-Scanner preserves its result/error exit codes.
exec "${SCANNER_PATH}" scan source \
  --lockfile "${LOCKFILE}" \
  --all-vulns \
  --format table \
  --verbosity info
