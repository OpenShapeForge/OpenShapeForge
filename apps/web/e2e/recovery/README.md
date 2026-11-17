# Browser session recovery regression

This test signs in through real Keycloak authorization-code login and the shared
Auth.js callbacks, uses real Redis and retains Playwright video/screenshots.
The loopback test host injects a 429 and a response that stops after headers at
the refresh transport boundary. No session cookie or initial token is injected.
It proves cookie/session continuity and refusal of expired authority. The same
authenticated fixture also mounts the real SessionExpiryGuard and SessionProvider,
with only Next pathname routing supplied by its loopback host. It covers the
non-dismissable reconnecting dialog and retention of an unsaved draft when the
provider omits refresh expiry. The same native session also exercises the admin
operator-session policy: temporary refresh unavailability redirects to recovery,
withholds console access, and admits the same session after provider recovery.
The loopback admin response is a fixture, not the complete admin UI. This is guard integration evidence, not acceptance
of the complete application UI or a deployed identity-provider outage.

From the repository root, generate ephemeral credentials into a new private
folder outside retained evidence with `bun apps/web/e2e/recovery/prepare.ts <folder>`.
Start isolated Redis and Keycloak instances. Import the generated
`session-recovery-test-realm.json` into Keycloak (the suffix is required).
The source `realm.json` is a template without credentials. Callbacks use port 3950.
Then, from `apps/web`:

```sh
AUTH_RECOVERY_ISSUER=http://127.0.0.1:58183/realms/session-recovery-test \
REDIS_URL=redis://127.0.0.1:56383 bun --env-file <folder>/fixture.env run test:browser:recovery
```

The test refuses an external issuer. Never use an existing product realm or
Redis instance. The host binds only loopback and exposes test controls only in
this fixture. Reports live under `.runtime/auth-recovery`; traces are disabled
to avoid retaining tokens. Stop the isolated infrastructure and remove the generated private folder after the run.
