# Browser session recovery regression

This test signs in through real Keycloak authorization-code login and the shared
Auth.js callbacks, uses real Redis and retains Playwright video/screenshots.
The loopback test host injects a 429 and a response that stops after headers at
the refresh transport boundary. No session cookie or initial token is injected.
It proves cookie/session continuity and refusal of expired authority, not the
complete application UI or a deployed identity provider outage.

Start isolated Redis and Keycloak instances. Import `realm.json` into Keycloak
as `session-recovery-test-realm.json` (the suffix is required). The fixture
contains only synthetic credentials and permits callbacks on port 3950.
Then, from `apps/web`:

```sh
AUTH_RECOVERY_ISSUER=http://127.0.0.1:58183/realms/session-recovery-test \
REDIS_URL=redis://127.0.0.1:56383 bun run test:browser:recovery
```

The test refuses an external issuer. Never use an existing product realm or
Redis instance. The host binds only loopback and exposes test controls only in
this fixture. Reports live under `.runtime/auth-recovery`; traces are disabled
to avoid retaining tokens. Stop the isolated infrastructure after the run.
