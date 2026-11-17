#!/usr/bin/env bash
# SPDX-License-Identifier: BUSL-1.1
# Recover Ubuntu mirror DNS only on ephemeral hosted runners. The normal
# browser dependency installation, canonical HTTPS and apt signatures remain.
set -euo pipefail

ubuntu_codename=$(. /etc/os-release; printf '%s' "$VERSION_CODENAME")
[[ "$ubuntu_codename" =~ ^[a-z]+$ ]] || exit 1
for ubuntu_host in archive.ubuntu.com security.ubuntu.com azure.archive.ubuntu.com; do
  if timeout 5 getent ahostsv4 "$ubuntu_host" >/dev/null 2>&1; then continue; fi
  if [[ "${GITHUB_ACTIONS:-}" != true || "${RUNNER_ENVIRONMENT:-}" != github-hosted ]]; then
    echo 'Ubuntu mirror DNS recovery is restricted to ephemeral hosted runners.' >&2
    exit 1
  fi
  ubuntu_distribution=$ubuntu_codename
  if [[ "$ubuntu_host" == security.ubuntu.com ]]; then ubuntu_distribution="${ubuntu_codename}-security"; fi
  echo "Recovering DNS for canonical Ubuntu mirror ${ubuntu_host}."
  resolved_addresses=$(UBUNTU_DNS_HOST="$ubuntu_host" python3 - <<'PY'
import ipaddress, json, os, urllib.request
host = os.environ['UBUNTU_DNS_HOST']
if host not in {'archive.ubuntu.com', 'security.ubuntu.com', 'azure.archive.ubuntu.com'}:
    raise SystemExit('Unsupported Ubuntu mirror.')
request = urllib.request.Request('https://cloudflare-dns.com/dns-query?name='+host+'&type=A', headers={'Accept':'application/dns-json'})
with urllib.request.urlopen(request,timeout=15) as response:
    answer=json.loads(response.read(65536))
if answer.get('Status') != 0:
    raise SystemExit('The HTTPS resolver did not return a successful answer.')
addresses=set()
for record in answer.get('Answer',[]):
    if record.get('type') != 1: continue
    address=ipaddress.ip_address(record['data'])
    if address.version != 4 or not address.is_global:
        raise SystemExit('Refusing a non-public Ubuntu mirror address.')
    addresses.add(str(address))
if not addresses: raise SystemExit('No public IPv4 Ubuntu mirror address was returned.')
print('\n'.join(sorted(addresses)))
PY
)
  recovered=false
  while IFS= read -r resolved_address; do
    if curl --fail --silent --show-error --proto '=https' --tlsv1.2 \
      --connect-timeout 5 --max-time 15 --resolve "${ubuntu_host}:443:${resolved_address}" \
      --output /dev/null "https://${ubuntu_host}/ubuntu/dists/${ubuntu_distribution}/InRelease"; then
      printf '%s %s\n' "$resolved_address" "$ubuntu_host" | sudo tee -a /etc/hosts >/dev/null
      recovered=true
      break
    fi
  done <<< "$resolved_addresses"
  if [[ "$recovered" != true ]]; then
    echo "No resolved ${ubuntu_host} address passed canonical HTTPS verification." >&2
    exit 1
  fi
done
