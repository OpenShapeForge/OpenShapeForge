#!/usr/bin/env bash
# Generate the locally-trusted TLS certificate the local Keycloak serves on
# :8443 (docker-compose.local.yml, KC_HTTPS_CERTIFICATE_FILE).
#
# Why this exists: MCP clients following the OAuth 2.0 protected-resource
# discovery chain refuse to open a sign-in URL that is not https ("Refused to
# open sign-in URL ... must be https"), so a local Keycloak that developers sign
# in against has to speak TLS. mkcert issues a leaf certificate from a per-machine
# development CA, so the certificate is trusted by browsers and by anything that
# consults the system trust store — no `-k`, no NODE_TLS_REJECT_UNAUTHORIZED=0.
#
# One-time, per machine (needs an admin password, so run it yourself):
#
#     brew install mkcert
#     mkcert -install            # installs the dev CA into the system keychain
#
# Then, any time (idempotent — safe to re-run; certificates last ~2 years):
#
#     scripts/dev-tls-cert.sh
#     docker compose -f docker-compose.local.yml up -d keycloak
#
# The output lands in ./certs/keycloak/, which is gitignored: the private key
# must never be committed, and the CA is per-machine anyway.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out_dir="${repo_root}/certs/keycloak"

if ! command -v mkcert >/dev/null 2>&1; then
  echo "mkcert not found. Install it first:  brew install mkcert && mkcert -install" >&2
  exit 1
fi

mkdir -p "$out_dir"
cd "$out_dir"

# host.docker.internal is included so a container on the same Docker network can
# reach the https listener under a name the certificate actually covers.
mkcert -cert-file keycloak.crt.pem -key-file keycloak.key.pem \
  localhost 127.0.0.1 ::1 host.docker.internal

# Keycloak runs as a non-root user inside the container and reads the key
# through a read-only bind mount, so it has to be world-readable.
chmod 644 keycloak.crt.pem keycloak.key.pem

echo
echo "Wrote ${out_dir}/keycloak.crt.pem and keycloak.key.pem"
if ! mkcert -CAROOT >/dev/null 2>&1; then
  exit 0
fi
echo "CA root: $(mkcert -CAROOT)"
echo "If you have not run 'mkcert -install' on this machine yet, do that now —"
echo "without it nothing will trust https://localhost:8443."
