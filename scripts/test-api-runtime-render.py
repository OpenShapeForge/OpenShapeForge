#!/usr/bin/env python3
"""Prove a digest-only API selection leaves identity and credential manifests intact."""
import json, re, subprocess
values = {
    'database': {'url': 'postgres://app:fixture@db/app', 'migrateUrl': 'postgres://mig:fixture@db/app',
                 'appPassword': 'ci-template-only', 'workerPassword': 'ci-template-worker'},
    'auth': {'internalContextSecret': 'ci-template-only', 'bearer': {
        'issuer': 'https://auth.fixture.test/realms/fixture', 'audience': 'fixture', 'jwksUri': 'http://keycloak/certs'}},
    'keycloak': {'enabled': True, 'image': {'tag': 'sha-1111111'},
                 'database': {'jdbcUrl': 'jdbc:postgresql://db/keycloak', 'password': 'ci-template-only'},
                 'admin': {'password': 'ci-template-only'}, 'realm': {'json': '{"realm":"fixture","enabled":true}'}}
}
repo = 'ghcr.io/openshapeforge/openshapeforge-api'
locked = 'sha-2222222@sha256:' + 'a' * 64

def render(tag):
    r = subprocess.run(['helm', 'template', 'openshapeforge', './deploy/helm/openshapeforge-api',
                        '--namespace', 'openshapeforge', '--values', '-', '--set-string', 'image.repository=' + repo,
                        '--set-string', 'image.tag=' + tag], input=json.dumps(values), text=True, capture_output=True, check=True)
    docs = {}
    for doc in re.split(r'(?m)^---\s*\n', r.stdout):
        source = re.search(r'(?m)^# Source: (.+)$', doc)
        if source: docs.setdefault(source.group(1), []).append(doc)
    return docs
before, after = render('sha-1111111'), render(locked)
assert before.keys() == after.keys()
allowed = {'openshapeforge-api/templates/deployment.yaml', 'openshapeforge-api/templates/migrate-job.yaml'}
changed = {source for source in before if before[source] != after[source]}
assert changed == allowed, 'Runtime pin changed a non-API manifest: ' + repr(changed)
assert sum('/charts/keycloak/' in source for source in before) >= 3
assert all(repo + ':' + locked in ''.join(after[source]) for source in allowed)
print('Runtime pin changes only API and migration images; all identity, credential and ingress manifests stay identical.')
