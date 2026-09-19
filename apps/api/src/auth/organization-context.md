# Host organization session binding

One Keycloak account may be a member of several organizations. The identity
provider asserts WHO signs in and WHICH organizations they belong to; what a
person may do in one of them is recorded by that organization, in
`platform.identity_relations.roles`, per (identity, tenant): the persona the
invitation admitted them as (`org_admin`, `org_employee`) and the OSF
baseline beside it. The invitation path writes it on first sign-in, in one
transaction with the Relation, the link and the claim of the invitation
(auth/identity-link-admission.ts — the invitation is claimed with
`UPDATE … RETURNING role`, so a revoke or role change in between wins);
`set_member_role` and the platform operator's member-role operations replace
it, on linked rows only, and removing a member clears the row. A person's
session expands the row's names through the realm's composites
(`generated/compiler/role-composites.json`, per realm and per owning client;
auth/person-roles.ts) exactly as Keycloak expanded a composite into
`resource_access` — the base `authorization.yaml` declares what `org_admin`
and `org_employee` expand to, a host widens them with an authorization patch —
unions the token's realm roles, and never reads `resource_access`. A person
whose membership row cannot be read (a surface without a database) gets no
session: 503, never a token-only one. A client-credentials token
(`preferred_username = service-account-<azp>`) is not a person and keeps its
client roles. A Keycloak client role on the user is user-wide and would
apply in every organization the account is a member of, so nothing in this
runtime writes one for a person any more (see `identity-link.ts`,
`employee-invitations.ts`). Service identities — configured service accounts
and API-key exchanges — keep their client roles: their clients are per tenant.

API-key provisioning still creates Keycloak clients at runtime and must be
reconciled with a Git-owned client-configuration policy before activation.

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
membership query on every request. Admission and roles are the tenant's own
record and are read on every request (cached 60 s per replica): a person the
tenant never invited is refused (403 `NOT_INVITED`), and a failure to read
that record is 503 `AUTHENTICATION_UNAVAILABLE` — never a session built from
the token alone.

Short addresses carry their organization to every surface. `/<alias>`,
`/<alias>/mcp`, `/<alias>/api/...` and `/<alias>/graphql` name one
organization; the MCP resource binds the token to it through its audience and
membership, and the REST and GraphQL rewrites record the alias in a
server-owned request header that the session resolver compares with the
credential's tenant slug. A credential of another tenant is refused with the
same 403 `ORGANIZATION_RESOURCE_FORBIDDEN` on all three.

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

For service identities, host mode accepts client roles only from the
configured verifier audience; sibling client roles and nested organization
roles are not flattened. For persons, client roles are not read at all; their
organization roles come from the membership row. Realm roles remain global
issuer grants in both cases. The IdP must not flatten organization-local
permissions into realm-wide grants: the application cannot recover their
organization provenance from a flat role string.

`platform.api_keys` and `platform.system_bypass_audit` are under row-level
security like every other platform table (db/migrations/api-keys.ts). The
one read authentication makes before it knows a tenant goes through
`app.api_key_tenant(lookup_id)`, a point lookup answering one tenant for one
lookup id; everything after runs in a tenant-fenced session.

The existing organization registry lookup caches positive mappings for 60
seconds and its database helper returns one matching row. Provisioning must
maintain a unique realm/organization-to-tenant mapping; this change does not add
a database uniqueness constraint or live Keycloak revocation check. API tests
use real signed tokens, a local JWKS/token endpoint, and fake registry rows;
they do not prove deployed provisioning, database RLS, login prompts or client
refresh behavior. Deployment activation and live acceptance remain host work.
