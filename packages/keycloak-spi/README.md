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
HTTPS is required except for an exact localhost/127.0.0.1 HTTP origin in isolated
local tests. Userinfo, query parameters, fragments and other origins are rejected.
An ambiguous or unsafe return retains the standard completion page.

Only the detached completion note and bounded return URL are changed. Keycloak
creates the native SSO session; the application then performs its own regular
OIDC/PKCE exchange. No application tokens are injected and no second credential
assertion is needed after registration. This does not grant organization roles:
the host application's pending invitation and relation/group membership determine admission.

Run policy tests with `mvn -f pom.xml test`. Build the pinned Dockerfile, publish
an immutable image, then adopt its digest through the consuming deployment.
The automatic-label script is derived from Keycloak 26.7.3's Apache-2.0 script;
keep native credential serialization and error handling synchronized on upgrades.
