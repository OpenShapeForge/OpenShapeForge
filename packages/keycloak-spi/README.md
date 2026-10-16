# Keycloak enrollment continuation

The existing OSF provider image includes an optional decorator for Keycloak
26.7.3's native passwordless registration required action. It delegates native
challenge, attestation verification and credential storage unchanged. The child
login theme stores its existing platform/timestamp label automatically; no
browser label prompt is shown.

Native organization invitation registration in its original browser already
completes SSO. Email verification in another browser starts a detached required
action session, which stock Keycloak ends with “Account updated”. After native
registration reports SUCCESS, the decorator can resume normal completion.

Opt in through the **account** client's attribute
`osf.passkey-enrollment-return-origin`, an exact application origin. The host application's
account-console reconciler supplies its development application origin. Other realms
and unconfigured clients retain stock completion. The continuation additionally
requires an enabled user, verified email, the detached-session note, exactly one
enabled native organization and its configured return URL on that same origin.
HTTPS is required, with one exception that does not depend on the environment:
an `http://localhost` or `http://127.0.0.1` origin, on any port, is accepted
wherever the attribute is set, production realms included. It exists for local
tests; do not configure such an origin on a deployed realm. Userinfo, query
parameters, fragments and other origins are rejected.
An ambiguous or unsafe return retains the standard completion page.

Only the detached completion note and bounded return URL are changed. Keycloak
creates the native SSO session; the application then performs its own regular
OIDC/PKCE exchange. No application tokens are injected and no second credential
assertion is needed after registration. This does not grant organization roles:
the host application's own admission rules (an invitation, or an existing
Relation carrying the person's e-mail; see
[docs/identity-providers.md](../../docs/identity-providers.md)) and relation/group
membership determine admission.

Run policy tests with `mvn -f pom.xml test`. Build the pinned Dockerfile, publish
an immutable image, then adopt its digest through the consuming deployment.
The automatic-label script is derived from Keycloak 26.7.3's Apache-2.0 script;
keep native credential serialization and error handling synchronized on upgrades.

For the same opt-in origin, successful native passkey enrollment can replace a
previous different user's SSO session in this browser. The provider logs out
only the session matching the current root authentication session; it never
lists or removes another device's sessions. An enabled enrolled user, exactly
one enabled organization, and its bounded return URL are required. Failed or
cancelled enrollment and unconfigured realms keep stock behavior.

The replacement finishes native required actions and action-token invalidation
without creating a different user's session under the old session ID. The child
theme follows the bounded `account_changed=1` return. Consuming applications must
remove their saved OIDC user on this marker and start normal OIDC/PKCE login;
the newly registered passkey authenticates the new account. The marker carries
no identity, token, role or permission. This does not bypass admission checks.

## Re-invitations of existing members

Keycloak's native `invite-existing-user` endpoint sends a signed `ORGIVT` mail,
including for someone who is already a member. Its stock handler displays an
expired-action heading for that valid already-member case. The OSF handler
inherits native signature, expiry, invitation, organization and email validation.
For an enabled, verified current member only, it consumes the invitation and
returns to the organization's configured app URL, bounded by the same account
client origin above. It does not create an SSO session, complete required actions,
add membership or grant roles. The app still performs normal login and admission.
New members and realms without this opt-in retain native handling. The shared
origin is intentionally one host app-return policy for both enrollment and
existing-member invitations; deploying this provider enables both continuations
in realms already configured with that origin. Audit events distinguish this
return with `osf.invitation_outcome=existing_member_return`.

The browser proof uses a separately started disposable image on port 8183 and
Mailpit on port 8025 (SMTP reachable from the container on host port 1025). Set
`INVITATION_PROOF_KEYCLOAK=http://127.0.0.1:8183` and
`INVITATION_PROOF_ADMIN_PASSWORD` for that disposable server's `proof-admin`, then
run from the repository root:

```sh
node apps/web/node_modules/@playwright/test/cli.js test --config apps/web/keycloak-invitations.config.ts
```

The proof creates and removes its own realm, opens the actual SMTP mail in
Chromium, checks the app return and absence of an identity cookie, and refuses
consumed, revoked, tampered, disabled-organization and foreign-return cases.
The app return in this proof is a login-entry fixture, not an authenticated host
journey. Reports, screenshots and video are retained under `.runtime/`.

## MCP resource scopes for dynamically registered clients

The opt-in `osf-mcp-resource-scopes` client-policy executor runs at two native
Keycloak boundaries. `REGISTERED` attaches explicitly registration-enabled resource scopes as
**optional** scopes in the DCR transaction, before its response. Explicit `registration-scopes` can also make supporting OpenID scopes available when a client registers a smaller scope set than it later requests. It changes no
roles, default scopes, callbacks or user grants. `AUTHORIZATION_REQUEST`
validates one exact RFC 8707 `resource` and records its configured scope in a server-owned client note after native scope, redirect and PKCE validation, before login and consent. The required `osf-mcp-resource-scope-binding` authenticator must be the first browser-flow execution; it projects that note idempotently into native scope state before cookie or scope conditions run. No client mutation occurs at login.
A conflicting resource scope or repeated resource/scope parameter fails closed.
Requests without a resource, and resources outside this policy, retain native
behavior. Existing clients must already have the optional scope; the executor
never repairs them during login.

Configure a realm client profile containing this executor, then reference the
profile from an enabled `any-client` client policy. The executor configuration is:

```json
{
  "resources": [
    {"resource": "https://app.example.test/admin/mcp", "scope": "mcp-resource:control", "organization": false, "registration": true, "registration-scopes": ["profile", "roles"]},
    {"resource": "https://app.example.test/acme/mcp", "scope": "mcp-resource:acme", "organization": true, "registration": false}
  ]
}
```

Registration attachment is opt-in per binding (`registration` defaults to false); do not enable it for a tenant audience unless that audience is deliberately available to every registering client. Membership and resource-server role checks still enforce access. A missing realm scope is skipped during registration, with a warning, and authorization remains denied until the scope is present and assigned. Resource URLs are exact HTTPS
addresses without userinfo, query or fragment; no wildcard or prefix matching
is performed. The host owns the scopes, audience mappers, registration callback
policy and authentication flows. An organization-free binding removes requested
`organization`/`organization:<alias>` scopes for that request only. The resulting
scope can select a host's platform login flow; it grants no platform role.
Native consent, token issuance and resource-server authorization still apply.

The binding survives native KC_RESTART reconstruction because it is a dedicated client note, written by the policy (not a request parameter). The authenticator records the effective scope in the native audit event. Matching is deliberately exact, including host case and trailing slash; aliases must be listed explicitly. Invalid configuration produces a bounded OAuth policy error, not a server stack trace.
