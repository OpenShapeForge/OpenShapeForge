# Host organization session binding

This is an unactivated preparation, not an end-to-end authorization boundary.
The existing invitation and member-role writers assign user-wide client roles;
those grants do not preserve organization provenance. Hosts must not enable
multi-organization operation until organization-scoped grants replace that path.
API-key provisioning also still creates Keycloak clients at runtime and must
be reconciled with a Git-owned client-configuration policy before activation.

`OPENSHAPEFORGE_ORGANIZATION_CONTEXT=host` enables strict binding in the shared
`resolveSessionContext` used by REST, GraphQL and MCP. The flag is read per
request. Unset or `off` retains the legacy behavior, including `tid` preference.

A verified human bearer must have the generic `organization` scope and exactly
one organization claim entry with an immutable ID. Multiple entries, malformed
entries, missing IDs, missing registry links and conflicting `tid` claims are
refused. Alias-specific scopes cannot select a subset. The tenant comes from
`app.tenant_for_keycloak_organization(verified issuer realm, organization ID)`.
Headers, URLs, subjects, login session IDs and previous tokens do not select it.
Fresh access tokens are evaluated independently; refresh and login remain IdP
responsibilities. Membership is verified as of token issuance, not by a live
membership query on every request.

`ResolveSessionOptions.requiredAudience` requires an exact `aud` value in
addition to ordinary signature, issuer, configured audience and authorized-party
verification. In host mode only, this exact resource audience replaces the
static authorized-party allowlist so dynamically registered OAuth clients can
authenticate; a nonempty verified `azp` is still required. The generic API and
API-key exchange paths retain the static allowlist. Signature, issuer and
configured API audience remain mandatory verifier checks for both paths when
configured. Supplying `requiredAudience` makes that endpoint bearer-only, also
outside host mode. Resource-origin configuration belongs to the transport/host.

Explicit deployment service identities may use a `tid`-only token. The verified
client and service-account username must match the configured credential. Its
tenant-scoped registry row must match the issuer realm, and its organization ID
must resolve back to that same tenant. Any membership carried alongside it must
also agree. A missing database or registry mapping refuses the service session.

API keys remain available on endpoints without `requiredAudience`. Their stored
credential supplies the tenant/client binding, and the exchanged verified token
undergoes the same service registry checks in host mode. Key roles intersect
the token's grants. API keys cannot authenticate on bearer-only resources.

Trusted-context headers carry no verified selected organization or resource
audience. Host mode rejects them, even with a valid HMAC; it never falls back to
them after a rejected bearer. Hosts that currently forward only signed context
must forward the bearer or provide a separately designed verified delegation
contract before enabling this mode.

Host mode accepts client roles only from the configured verifier audience;
sibling client roles and nested organization roles are not flattened. Realm
roles remain global issuer grants. The IdP must not flatten organization-local
permissions into realm-wide grants: the application cannot recover their
organization provenance from a flat role string.

The existing organization registry lookup caches positive mappings for 60
seconds and its database helper returns one matching row. Provisioning must
maintain a unique realm/organization-to-tenant mapping; this change does not add
a database uniqueness constraint or live Keycloak revocation check. API tests
use real signed tokens, a local JWKS/token endpoint, and fake registry rows;
they do not prove deployed provisioning, database RLS, login prompts or client
refresh behavior. Deployment activation and live acceptance remain host work.
