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
