# Capability grants

A **capability grant** is a hashed, expiring, recipient-bound token that lets
someone *without an account* invoke a fixed set of Operations on exactly one
record: a customer who receives a link, opens a document and accepts or signs
it; a contact who answers a request. The plugin that owns the record decides
which Operations a recipient gets; core owns the token, its resolution, the
attempt limits and the audit trail. Nothing a plugin does with a grant can
widen it.

The pieces, in the order a request meets them:

| Piece | Where |
| --- | --- |
| `auth.mode: capability` on an Operation | `packages/compiler/src/plugins.ts`, validated in `generate-operations.ts` |
| the one OpenAPI security scheme, `capabilityGrant` | `generate-openapi.ts` |
| the grant table `platform.capability_grants` | `packages/compiler/config/platform-schema.yaml` |
| the tenant lookup and check constraints | `apps/api/src/db/migrations/capability-grants.ts` |
| token format and hashing | `apps/api/src/operations/capability-grant-token.ts` |
| resolution into a grant session; use counting | `apps/api/src/operations/capability-grant-resolution.ts` |
| issue, revoke, list, purge | `apps/api/src/operations/capability-grants.ts` |
| `platform.grants` for plugin handlers | `apps/api/src/modules/platform.ts` |
| `grants.list` and `grants.revoke` for operators | `packages/compiler/config/authoring/operations/grants.yaml`, `apps/api/src/operations/grants-operations.ts` |

## Declaring a capability Operation

```ts
{
  key: "envelopes.envelope.sign",
  handler: "signEnvelope",
  auth: { mode: "capability" },
  tenancy: { mode: "required" },
  transports: {
    rest: { method: "POST", path: "/api/envelopes/link/sign", response: { kind: "json" } },
    mcp: { enabled: false, reason: "A grant token is presented on REST only." },
    graphql: { enabled: false, reason: "A grant token is presented on REST only." },
    typescript: { enabled: true, functionName: "signEnvelope" },
  },
  // …input, output, errors, effects as for any Operation
}
```

The compiler holds a capability Operation to three rules:

- **REST only.** A grant is presented on a link; the authenticated MCP and
  GraphQL endpoints have no way to carry one, so both projections must be
  disabled with a reason, like a `custom` scheme. The web manifest refuses
  it for the same reason: a signed-in page never holds a recipient's token.
- **Tenancy `required`.** The grant row supplies the tenant; no other tenancy
  mode is meaningful.
- **The grant errors are appended.** `CAPABILITY_GRANT_ERRORS` — the six
  status-and-code pairs below — are added to the Operation's declared errors
  so OpenAPI and every client see them without each plugin repeating the
  list. An Operation that declares one of the pairs itself keeps its own
  description.

OpenAPI describes every capability Operation by one platform-owned scheme,
`capabilityGrant` (`type: http`, `scheme: grant`). A plugin cannot use that
name for a `custom` scheme.

## The token

`<grantId>.<secret>` — a UUID, a dot, and 32 random bytes in base64url. It is
returned exactly once, by `platform.grants.issue`, and is never stored: the
row keeps `token_hash`, the SHA-256 of the secret half. The id locates the
row by primary key, so an attacker cannot make the database compare against
every hash, and the secret is compared in constant time (`timingSafeEqual`).
An unknown id costs the same comparison against a decoy hash as a wrong
secret does.

The token is presented as **`Authorization: Grant <token>`**. A header rather
than a query parameter, for the same reason bearer tokens are ("bearer
credentials belong in request headers, never query parameters",
[api.md](api.md#the-entity-event-journal)): a query string lands in access
logs, referrers and browser history. A link the recipient opens carries the
token to the front end; the front end presents it in the header.

## Resolution: from token to grant session

`registerOperationRestRoutes` resolves a capability Operation's token before
the handler runs, in its own committed transaction:

1. Parse the token; anything not shaped like one is `401 GRANT_INVALID`.
2. Look up the tenant of the grant id through
   `app.capability_grant_tenant(id)` — the one read that happens before a
   grant session exists, a point lookup carrying the RLS bypass only for its
   own statement, like `app.tenant_for_keycloak_organization`.
3. Open an ordinary tenant-fenced session (`app.tenant_id` = the grant's
   tenant, `app.user_id` = the grant id, no roles, scope `self`) and `SELECT
   … FOR UPDATE` the row.
4. A grant whose `locked_until` is in the future is `423 GRANT_LOCKED`
   without comparing the secret, so a lock cannot become an oracle.
5. Compare the secret. A mismatch counts a failed attempt (see below) and is
   `401 GRANT_INVALID`, or `423 GRANT_LOCKED` when this attempt reached the
   limit. A match resets the attempt window.
6. Revoked or superseded is `410 GRANT_REVOKED`; used as often as `max_uses`
   allows is `409 GRANT_CONSUMED`; past `expires_at` is `410 GRANT_EXPIRED`.
7. The Operation key must be in the grant's `operations`, and when the
   Operation declares a record target, its entity must be the grant's
   `subject_entity`; otherwise `403 GRANT_SCOPE`.

What comes out is a **grant session**: a `TrustedSessionContext` with
`credential: "grant"`, the tenant, `userId` = the grant id (so receipts,
events and RLS have an actor), `roles: []`, and `session.grant`:

```ts
session.grant = {
  id, subject: { entity, id }, recipient, operations, records, expiresAt, maxUses,
};
```

The handler runs under it like under any other session: RLS is on and fenced
to the grant's tenant, `platform.db`, `platform.events`, `platform.records`
and the rest accept it. It has no roles, so the generated entity CRUD and
every session Operation refuse it — a grant reaches exactly the capability
Operations it lists, and a capability Operation accepts exactly a grant
session (a bearer session presented to one is `401 GRANT_INVALID`). When the
Operation declares a record target with an `inputField`, core sets that
field to the grant's subject id before validation; a different value in the
request is `403 GRANT_SCOPE`.

### What a grant session may reach

`platform.records.assertAccess` — and everything built on it, notably the
artifact port's `read` — answers a grant session from the grant row rather
than from roles: the **subject** record is reachable for `get` and `update`
(the Operation exists to act on it), and any other record only when the
grant **delegates** it:

```ts
records: [
  { entity: "DocumentVersion", id: pdfVersionId, intents: ["get"] },
  { entity: "Document", id: documentId, intents: ["get", "update"] },
]
```

Issuing verifies every delegated intent against the issuer's own access
through the same oracle, so a grant never reaches a record its issuer could
not; the delegation is journaled with the grant and shown in its summary.
`delete` is never delegated. This is what lets a recipient open the PDF they
are asked to sign and lets the completing handler append the signed copy to
the record's Document (`appendDocumentVersion` from
`@openshapeforge/documents/runtime`, the same command `DocumentVersion.create`
runs, under a grant that delegates `update` on that Document). Reading a
version's bytes through `platform.artifacts.read` names the **Document** as
the file's owner and asks its `get`: the versions a completion creates did
not exist when the grant was issued, and a version is the document's content
([artifact-storage-port.md](artifact-storage-port.md)).
The generated Operations still refuse the grant session: delegation admits
authored handler code, never a client.

### The use is counted in the handler's transaction

A capability Operation always runs inside a core-owned transaction
(`withModuleOperationTransaction`). Core counts the use first — `uses + 1`,
and `consumed_at` when that reaches `max_uses` — with a `WHERE` that
re-checks revocation, consumption, expiry and the lock, so a grant revoked
between resolution and execution still refuses. Then the handler runs. A
handler that throws rolls the count back with everything else, so a failed
signing leaves the link usable; a single-use grant that succeeded can never
be replayed. This is the same outcome binding confirmation challenges and
edit leases have ([plugins.md](plugins.md#canonical-operations)).

### Attempt limits

`CAPABILITY_GRANT_ATTEMPT_POLICY`: five wrong secrets inside a fifteen-minute
window lock the grant for fifteen minutes. The window starts at the first
failure and restarts when it has elapsed; a correct secret clears it. The
policy is global; per-grant policies are deliberately absent until a
consumer needs one.

## Issuing, superseding, revoking, listing

A plugin handler issues through `platform.grants`
(`RuntimeCapabilityGrantServices` in `@openshapeforge/plugin-runtime`):

```ts
const { id, token, expiresAt } = await platform.grants.issue(session, {
  operations: ["envelopes.envelope.read", "envelopes.envelope.sign"],
  subject: { entity: "Envelope", id: envelopeId },
  recipient: { kind: "email", address },
  expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
  maxUses: 1,                              // null or omitted: reusable until expiry
  supersede: "same-subject-and-recipient", // optional
});
```

- The session must be a live verified tenant session with a user; it is the
  issuer (`issued_by`). A grant session cannot issue.
- Every key in `operations` must be an `auth.mode: capability` Operation of
  the generated catalog; the subject id must be a UUID; the recipient is an
  object with a non-empty `kind`, at most 2 KB as JSON, and otherwise opaque
  to core; `records` (optional, at most sixteen) lists distinct records with
  `get`/`update` intents the issuer must hold; `expiresAt` must be in the
  future. Violations throw — this is authored plugin logic, not client input.
- `supersede: "same-subject-and-recipient"` revokes, in the same
  transaction, every still-active grant for the same subject and the same
  recipient object, recording `revoked_reason: "superseded"` and
  `superseded_by` = the new id. Sending a customer a fresh link therefore
  retires the old one.
- Issuing joins the active Operation transaction when there is one
  (`platform.db.withSession` around it), so a grant and the record it covers
  commit or roll back together.

`platform.grants.revoke(session, { id, reason? })` is idempotent — an
inactive grant is reported as it is — and throws for an id the tenant does
not hold. `platform.grants.list(session, subject)` returns the grants for a
record, newest first, as `RuntimeCapabilityGrantSummary`: id, subject,
recipient, Operations, issuer, timestamps, use count, `lockedUntil` and a
derived `status` (`active | consumed | expired | revoked`). No summary ever
carries the token or its hash.

Operators reach the same two through the core-owned session Operations
`grants.list` (`GET /api/grants?subjectEntity=&subjectId=`, MCP
`grants_list`, GraphQL `capabilityGrants`) and `grants.revoke`
(`POST /api/grants/:id/revoke`, `grants_revoke`, `revokeCapabilityGrant`),
gated by `Organization.All.ReadWrite` — the role that already governs the
organization-administration surface ([api.md](api.md#authentication--authorization)).
They are bound to the runtime's own `osf-grants` module and need no plugin.

## Audit

Every lifecycle change appends to `platform.entity_events` with
`aggregate_type: "capability_grant"` and the grant id, inside the
transaction that made the change: `capability_grant_issued` (subject,
recipient, Operations, delegated records, expiry, uses limit, supersede mode),
`capability_grant_used` (Operation, use count, whether it consumed the
grant), `capability_grant_locked` (attempts, `locked_until`) and
`capability_grant_revoked` (reason, and `supersededBy` when a newer grant
caused it). A wrong secret that does not reach the lock is not journaled.

## Housekeeping

Expired, consumed and revoked rows are inert — resolution refuses them — but
a table nobody deletes from grows without bound. `purgeCapabilityGrants(db,
session, { retainDays })` removes rows whose expiry or revocation is older
than the window (default thirty days); the audit trail stays in the journal.
There is no scheduler in the API that calls it; see
[retention.md](retention.md#runtime-enforcement-not-implemented-follow-up).
