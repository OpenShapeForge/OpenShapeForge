# Authenticated inbound deliveries

How a third-party provider's webhook becomes a tenant-authorized Operation
invocation, and which half of that belongs to core.

This is **not** the signed workflow webhook
(`packages/plugin-runtime/src/webhook-secrets.ts`). That protocol is
OpenShapeForge's own: the host mints the secret, the caller signs
`timestamp "." eventId "." body`, and the tenant travels in the request. A
third-party provider signs what *it* decided to sign and tells nobody our
tenant, so the two deliberately share no scheme and no code path. Nothing in
this document weakens or reuses workflow authentication.

## Ownership

| Core owns | A plugin owns |
| --- | --- |
| The signing secret at rest, with no read API | The product meaning: which adapter, which provider events, which subscription |
| Verification of the HMAC over the exact request bytes | How an administrator configures a subscription, and its UI |
| Resolving the tenant, only from a stored registration | The canonical Operation that consumes a delivery |
| The delivery's identity, from signed material only | What that Operation does with the payload |
| The durable receipt, its encryption at rest and its removal | Revoking the endpoint when the subscription or connection stops |
| The dispatch's identity, idempotency and live re-authorization | — |

Core owns the credential for the same reason it owns `platform.api_keys`: a
credential that *resolves* a tenant cannot be fenced by the tenant it resolves.
A plugin registering an endpoint supplies no tenant and can read no secret.

## The journey

```
POST /api/inbound/<endpointKey>/<endpointId>
  │  exact bytes, bounded at 256 KiB  (http/raw-json-body.ts, route bodyLimit)
  ▼
app.inbound_endpoint_tenant(<endpointId>)        ← one tenant for one id, pre-auth
  ▼
tenant-fenced transaction (withCredentialResolutionSession)
  ├─ read platform.inbound_endpoints             ← tenant, scheme, sealed secret
  ├─ verify HMAC over the exact bytes            ← constant-time, bounded algorithms
  ├─ read the delivery's identity from those bytes ← signed material ONLY
  ├─ seal the payload to tenant + endpoint + receipt
  ├─ insert platform.inbound_deliveries          ← the receipt, unique per delivery key
  └─ insert platform.jobs  (osf-inbound.dispatch) ← the processing intent
  ▼  COMMIT
202 accepted | duplicate
  ▼
job-worker claims the job
  ▼
durable broker (operations/durable-worker.ts)
  ├─ resolve the work: live claim AND the endpoint still active in its tenant
  ├─ open the sealed payload under the row's own scope
  ├─ exchange the organization service identity for a fresh token
  ├─ re-read the Operation's contract, refuse a changed one
  ├─ pin the contract once, under this exact claim
  ├─ re-resolve immediately before dispatch (revocation lands here or not at all)
  ├─ record the dispatch before the request leaves  ← serialized against revoke
  └─ POST /api/operations/<id>/execute  with the delivery's idempotency key
```

### What each step guarantees

**The URL is not authority.** `endpointKey` names a protocol and `endpointId`
selects a candidate registration. Both are public. A stranger holding them gets
the same `404` as a stranger who guessed them, because the tenant comes from the
registration the signature proved possession of.

**No unsigned header is authority — including the delivery id.** The signature
header, the hash algorithm, the encoding and the prefix are all *configuration*:
a delivery cannot name its own header, announce a different algorithm, or declare
itself unsigned. And a header's *value* decides nothing either, which is a
separate and easily-missed point. See
[Identifying a delivery](#identifying-a-delivery).

**The algorithms are explicitly bounded.** `sha256` and `sha512`, and that set
is enforced twice — in `normalizeInboundSignatureScheme` and as a CHECK
constraint, because `createHmac` honours `md5` and `sha1` without complaint and
the registration is tenant-authored configuration.

**The comparison is constant-time over the exact bytes.** The presented digest
must have exactly the algorithm's byte length before `timingSafeEqual` is
reached; the body is bounded before any HMAC runs; a registration may lower the
ceiling and never raise it.

**Success is sent only after the receipt and the work are committed.** They are
inserted in one transaction. A write that fails answers `503`, never `202`, so
the provider retries rather than assuming delivery.

**A duplicate is recognised, not re-dispatched.** The delivery key is derived
from signed material only, domain-separated per source. It is unique on
`(tenant, endpoint, key)` for the receipt and is the queue's `delivery_key` for
the job, so a repeat adds neither.

**A crashed worker does not double-dispatch silently.** The contract fingerprint
is pinned once under the live claim, and the attempt that started a dispatch is
recorded before the request leaves. A reclaim of a non-repeatable write whose
outcome cannot be established ends `outcome_unknown` for an operator, never an
automatic retry.

**A revoked endpoint stops a dispatch that has not started.** See
[Revocation and a dispatch in flight](#revocation-and-a-dispatch-in-flight).

### What is NOT claimed

There is **no exactly-once external side effect**. Repetition is *bounded* and a
repeat is *recognisable* to the Operation through a stable idempotency key.
Whether the Operation's own external effect happened once is the Operation's
contract; where it cannot be known, the delivery is left `outcome_unknown`.

A delivery's identity can only be as good as what the provider authenticated,
and a revocation can only stop a dispatch that has not yet been recorded as
started: the two are serialized, so the order is decided, but a revocation is
not a cancellation of the attempt already past that point. Both limits are
stated exactly below rather than papered over.

## Identifying a delivery

A provider's HMAC covers its **body**. It does not cover its headers. So a
header value on an inbound delivery is attacker-chosen for anyone who has ever
captured one valid delivery: those exact bytes with that exact signature verify
again, with any header the attacker likes. Keying duplicate suppression on the
provider's delivery-id header — the obvious design, and the one Jira's
`X-Atlassian-Webhook-Identifier` invites — fails twice over:

- a captured delivery replayed with a **fresh** id is a new key, so it is
  admitted and dispatched again, as often as the attacker wants;
- a genuine delivery whose id an attacker has already **burned** is a duplicate,
  so it is suppressed — a deletion event the tenant simply never processes.

Core therefore derives the key from signed material only, and
`inboundDeliveryKey` takes no header value at all. A registration declares
which signed material:

| `identity.source` | Key derived from | Use it when |
| --- | --- | --- |
| `body-digest` *(default)* | the digest of the exact verified bytes | the provider's payload already distinguishes its own events — Jira's does, it carries `timestamp` and `webhookEvent` |
| `body-field` | declared dotted paths **inside** the verified JSON body | the provider re-sends byte-identical bodies for distinct events, or varies bytes across retries of one event |

`identity.eventTypePath` names where the event name lives inside the signed
body, and that is the only event name a plugin may route on. The headers a
registration declares under `unsignedHeaders` are retained verbatim beside the
receipt for operator correlation and reach the Operation under
`envelope.unsigned`, where the field name says what they are worth.

A declared identity path that an authentic body does not carry is a **refusal**,
not a fallback: falling back to the digest would hand a provider two key spaces,
and treating an absent field as a stand-in value is how two distinct events
collapse into one receipt.

### The irreducible ambiguity

Only the provider can authenticate an event identity. Under `body-digest`, two
deliveries are the same event exactly when they are the same bytes — so a
provider that re-sends a byte-identical body for a genuinely new event, and
signs nothing that distinguishes the two, is **indistinguishable from a replay**
and the second delivery is suppressed as a duplicate. `body-field` escapes that
only where the provider actually puts an identity in the payload. Neither is a
general solution, and none is claimed: for a provider that authenticates no
event identity at all, no host-side scheme can recover one.

## The retained payload

`body_ciphertext` is the exact verified bytes, sealed with the same AES-256-GCM
keyring as elicited Connection secrets, with AAD bound to **tenant + endpoint +
this receipt** (`inboundBodyScope`). Base64 would have been storage, not
protection: a provider payload is tenant data, routinely personal, that a
database reader must not be able to read.

- The keyring lives in **admission**. The store port is handed a sealed value,
  so no statement, no driver parameter log and no fixture built against that
  port ever holds a provider's bytes in the clear.
- A ciphertext lifted onto another row — another tenant's, another endpoint's,
  another delivery's — **fails to open** rather than decrypting into the wrong
  dispatch. The worker rebuilds the scope from the row it read under its claim.
- A payload that cannot be opened is a refusal to dispatch, never an empty body.
  `INBOUND_BODY_KEY_UNAVAILABLE` (no keyring on this host) is **retryable** —
  restore the key and the attempt succeeds. `INBOUND_BODY_UNREADABLE` (no
  present key opens it) and `INBOUND_BODY_PURGED` are **terminal** and named, so
  key loss becomes a visible recovery problem rather than a silent one.

### Bounded removal

The payload stops being needed when the delivery **settles**, so it is removed
on a schedule rather than kept (`jobs/inbound/retention.ts`, swept on the
`job-worker`'s existing hourly tick):

| Bound | Default | Environment |
| --- | --- | --- |
| A **settled** delivery loses its payload this long after settling | 7 days | `OPENSHAPEFORGE_INBOUND_BODY_RETENTION_DAYS` |
| Outer bound on the same removal, measured from arrival | 30 days | `OPENSHAPEFORGE_INBOUND_BODY_MAX_AGE_DAYS` |

The second bound cannot be disabled, only shortened or lengthened (to at most a
year), so a settled receipt cannot outlive it on a misconfigured retention.
Each sweep is row-bounded, so one call cannot become an unbounded update.

**An unsettled delivery never loses its payload here, whatever its age.** The
2xx this endpoint returned was a durable acceptance: the provider will not send
these bytes again, and they are the only copy of work still to be performed.
Purging them on a timer would silently make accepted work unrecoverable, and
nothing outside the database would say so. A delivery still `pending` past
`OPENSHAPEFORGE_INBOUND_BODY_MAX_AGE_DAYS` — a dead job, a revoked endpoint, an
Operation that was never authored — is therefore reported as **overdue**
(`overdueInboundDeliveryBodies`: how many, and the oldest arrival) and left
intact, sealed and replayable. It is not marked purged, not settled and not
failed; resolving it is an operator decision.

> **Not implemented.** The overdue report reaches a worker log line and nothing
> else. An operational alert on that count, and admission-side backpressure so
> a pipeline that has stopped settling refuses new deliveries at the edge —
> where the provider still sees the refusal and retries — are both required
> before unbounded retention of unsettled payloads is operationally acceptable.
> Until then that retention is unbounded by design and visible only in the log.

What survives a purge is the evidence: `body_sha256` still says which bytes were
accepted and verified, `body_bytes` how large they were, and `body_purged_at`
that the payload was removed rather than never kept.

## Revocation and a dispatch in flight

A queued dispatch is a decision taken at admission, and the claim fence proves
only who owns the attempt — not that the subscription still exists. So every
read in `jobs/inbound/work.ts` also requires
`app.inbound_endpoint_active(d.endpoint_id, d.tenant_id)`: one boolean for one
**tenant-paired** endpoint. The `job-worker` role is deliberately *not* granted
`platform.inbound_endpoints` — that row holds the sealed provider secret — so
the one bit a dispatch needs is answered by a `SECURITY DEFINER` point function
instead, exactly as `app.inbound_endpoint_tenant` answers admission's one bit.
Both are owned by the non-login registry resolver whose entire reach is
`SELECT (id, tenant_id, status)` on that one table under a read policy written
to it, so the secret is unreachable *through* the definer and not merely
unselected by it. Neither raises a bypass setting. The worker holds `EXECUTE`
on the liveness lookup and not on the tenant lookup beside it.

**The guarantee.** `createDurableWorkerBroker` re-resolves the work immediately
before dispatch and again before every limiter repeat, and
`markOperationDispatch` — which carries the same predicate — commits *before*
the request leaves. So the last point at which a revocation still stops a
dispatch is that mark: a revocation that wins there fails the mark, the broker
reports `DURABLE_DISPATCH_UNRECORDED`, and nothing executed. Earlier than that,
the re-resolve finds nothing, the broker answers `DURABLE_CLAIM_LOST`, and the
delivery is settled `failed` with nothing sent.

### The serialization point

The mark and the revocation decide one question — may this attempt go out? — from
two connections, two roles and two tables, and under `READ COMMITTED` neither
sees the other's uncommitted work. So they are serialized explicitly
(`modules/inbound-endpoint-gate.ts`): both take the same transaction-scoped
advisory lock on their `(tenant, endpoint)` pair, as the first thing they do and
before any row lock, and hold it until they commit — the mark in
`jobs/inbound/work.ts`, the status write in `revokeInboundEndpoint`.

That makes the boundary an *order* rather than a window:

- **Revocation first.** The mark acquires the gate only after the revocation has
  committed, and its `UPDATE` then takes a fresh statement snapshot — which is
  what makes the committed revocation visible to
  `app.inbound_endpoint_active`. No row matches, the mark fails, nothing is
  launched. A revocation cannot commit *during* a mark, because it cannot hold
  the gate while the mark does.
- **Mark first.** The revocation waits, then applies. That specific attempt is
  explicitly in flight and is not retracted, which is what revocation has always
  claimed — see below.

The lock changes no grant and no role contract: an advisory key is not a catalog
object, which is precisely why the worker can take one scoped to a registration
it may not read. The registration table stays ungranted to `job-worker`, the
sealed secret stays unreachable, and both paths still establish the tenant
themselves — the revocation reads its row through the tenant policy, the mark
reads the pair off the delivery row it is already fenced to, and the liveness
predicate stays tenant-paired. Each path takes exactly one lock on a key derived
from immutable columns, so no two transactions can hold what the other wants;
the mark only ever *reads* `platform.inbound_endpoints`, and an MVCC reader does
not block on a row lock. Being transaction-scoped, the lock is released by a
rollback, a failed statement or a killed backend with no cleanup path, so a dead
worker cannot strand a tenant's revocation. Both sides bound the wait (5s, far
beyond the single-row `UPDATE` they wait on) and both fail closed: a mark that
times out authorizes no dispatch and the next attempt re-decides; a revocation
that times out changes nothing and is reported, with the registration still
active. A hash collision between unrelated pairs serializes work that did not
need it, and can never fail to serialize a pair with itself.

**What is not guaranteed.** Beyond the mark there is nothing left to stop: no
transaction spans an outbound HTTP call, so a revocation cannot retract a request
already in flight, and the record of a started attempt is never rewritten
afterwards. The gate is never held across a network call either — it covers one
`UPDATE`, not the dispatch.

That delivery settles on its own outcome, and the row distinguishes the cases:
`dispatch_state = 'started'` with `dispatch_attempt` means a request went out,
`'not-dispatched'` means one provably did not, `'none'` that none was ever
attempted. Revocation also never withdraws a receipt already taken.

So what revocation is, precisely: it stops admitting the next delivery
immediately, and it stops every queued dispatch whose mark it wins — including
one already at that mark and waiting for the gate. It is not a kill switch for
an attempt whose mark has committed.

**No connection-state check happens here, and that is a named gap.** A provider
*Connection* is plugin-owned; core has no liveness port for one, and inventing
one would widen the public worker contract for something no plugin implements.
Until a plugin owns that, stopping a connection must revoke the endpoint — which
is what the check above then enforces. See
[what the plugins still owe](#handing-over-what-the-integrations-and-workflow-plugins-still-owe).

## Who may register an endpoint

A registration says: when a stranger presents bytes carrying this HMAC, run
*that* canonical Operation under the **organization's service identity**. Left
to any authenticated session with a free choice of Operation id, that is
privilege escalation with extra steps — the shape
`auth/api-key/ceiling.ts` exists to refuse. Three established controls apply to
`register`, `revoke` and `list` alike, all before anything is stored:

1. **A verified person.** The deployment must have classified the principal as
   one (`isVerifiedPersonSession`, the same rule and the same code as API key
   management). A machine principal holding the integration role would otherwise
   climb its own ladder: register a webhook at an Operation only the service
   identity may run, then trigger it. Absence of a verdict is refused, because
   absence proves nothing.
2. **`Platform.ConnectorAdmin`**, through `requireConnectorAdmin` — the canonical
   integration-administration capability, already defined as "hand credentials
   for another system to the platform and decide what it may reach". No new role
   is invented; an inbound endpoint is that act from the other direction.
3. **Operation binding: nobody delegates what they cannot invoke.** The named
   Operation is resolved through core's own catalog *under the caller's session*,
   so an Operation this caller may not invoke does not resolve and cannot be
   bound. An unknown id and an unauthorized one are the same refusal, so the
   surface is not a catalog oracle. The Operation must also declare
   `reliability.idempotency.mode: keyed` with an input field distinct from
   `dispatch.inputField`.

Revocation is gated identically because it is a denial-of-service lever, and the
list because it names the providers a tenant works with.

## The plugin API

```ts
import type { RuntimeInboundEndpointServices } from "@openshapeforge/plugin-runtime";

// platform.inboundEndpoints is absent on a host without this capability.
// A consumer must fail closed rather than proceed unauthenticated.
const inbound = context.platform?.inboundEndpoints;
if (!inbound) throw new Error("This host does not support inbound deliveries.");

const endpoint = await inbound.register(session, {
  endpointKey: "jira-admin",
  signature: { header: "x-hub-signature", algorithm: "sha256", encoding: "hex", prefix: "sha256=" },
  secret: providerSharedSecret,            // ≥ 32 bytes; never readable again
  // Signed material only. Omit for the `body-digest` default.
  identity: { source: "body-digest", eventTypePath: "webhookEvent" },
  // Retained for correlation. Not signed, so they decide nothing.
  unsignedHeaders: {
    deliveryId: "x-atlassian-webhook-identifier",
    eventType: "x-atlassian-webhook-event",
  },
  dispatch: { operationId: "<canonical Operation id>", inputField: "delivery" },
});

// Give `endpoint.path` to the provider. It is public and carries no authority.
```

The session must be a verified person holding `Platform.ConnectorAdmin`, and the
named Operation must be one that session may itself invoke — see
[who may register an endpoint](#who-may-register-an-endpoint).

`revoke(session, { id, reason? })` stops admitting the next delivery and is
idempotent; it withdraws no receipt already taken. It *does* stop a queued
dispatch that has not started, and cannot retract one already in flight — see
[revocation and a dispatch in flight](#revocation-and-a-dispatch-in-flight).
`list(session, { endpointKey? })` answers the session's own tenant. There is
deliberately no `verify` and no secret read: admission is the host's own HTTP
path, so a plugin is never handed bytes and asked whether they are genuine.

### What the dispatched Operation receives

`input[<inputField>]` is a `RuntimeInboundDeliveryEnvelope`:

```ts
{
  deliveryId: string;            // the receipt
  endpointId: string;
  endpointKey: string;
  eventType: string | null;      // from INSIDE the signature, or null
  unsigned: {                    // never signed; correlation only
    providerDeliveryId: string | null;
    eventType: string | null;
  };
  receivedAt: string;            // RFC 3339
  bodySha256: string;
  body: string;                  // base64 of the exact verified bytes
}
```

Route on `eventType` and never on `unsigned.eventType`. The split is the whole
point of the type: the first was covered by the provider's HMAC, the second was
not, and a plugin that cannot tell them apart will eventually act on a value a
stranger chose.

Core neither parses nor interprets the payload beyond the identity paths the
registration declared, so a provider's own content shape stays the plugin's
business and a retry dispatches the identical message. The Operation runs under
the organization's service identity, with the delivery's idempotency key;
`reliability.idempotency.mode: keyed` is required at registration and is what
lets the Operation recognise a repeat.

## Jira Cloud admin webhooks, concretely

Jira Cloud signs the exact request body with `X-Hub-Signature: sha256=<hex>`
using the secret shown once when the webhook is registered, and sends JSON. That
is the `registration` above verbatim. A Jira webhook URL is registered once per
subscription, which is exactly what `endpoint.path` is for.

**Jira's authenticated event identity is inside the body.** The payload carries
`timestamp` (epoch milliseconds), `webhookEvent` (e.g. `jira:issue_updated`) and
the affected record — all inside the signature. Its delivery id travels in
`X-Atlassian-Webhook-Identifier`, which is **not**. So `body-digest` is the right
default for Jira: distinct Jira events produce distinct signed bytes because the
timestamp and event name are in them, and Jira's own retries of one event resend
the identical body. Declare the id header under `unsignedHeaders.deliveryId` for
correlation with Jira's console, and read the event name from
`identity.eventTypePath: "webhookEvent"`.

A `body-field` profile of `["webhookEvent", "timestamp", "issue.id"]` is
available if a Jira deployment turns out to vary bytes across retries of one
event (an added field, a reordered object). It is not the default, because it is
strictly narrower than the bytes: two events a millisecond apart on one issue
with one event name would key alike, and the digest form would not.

## Handing over: what the integrations and workflow plugins still owe

Core cannot complete the Jira journey on its own. The following are **not**
implemented here and are not stubbed:

1. **The integrations plugin** owns the Jira adapter, the provider/subscription
   entities and their authoring YAML, the administrator screens, and the call to
   `platform.inboundEndpoints.register` when a subscription is created. It also
   owns giving the registered URL and secret to Jira, and — importantly —
   **calling `revoke` when the subscription or its Connection stops**. Core
   enforces the endpoint's own status before every dispatch and has no liveness
   port for a provider Connection; a core-side connection recheck would need a
   plugin-contributed port that does not exist and is therefore **not
   implemented**, not stubbed.
2. **A canonical Operation to dispatch to.** Core dispatches to an Operation id
   the registration names; no such Operation exists in this repository. It must
   be authored by the owning plugin, be reachable by the organization's service
   identity, and declare `reliability.idempotency.mode: keyed` with the input
   field the delivery key goes in — otherwise the broker treats a reclaimed
   write as an uncertain repeat and refuses it, which is the correct but
   unhelpful outcome.
3. **The workflow plugin** owns consumption: turning the envelope into a
   workflow event. Nothing here publishes one, and the existing user-only
   publish handler is not machine-authorized — that boundary is untouched.
4. **A service identity per organization.** `register` refuses without one
   (`organizationServiceIdentities`), because a delivery that can never be
   dispatched should not be accepted.
5. **Operational surfaces.** There is no Operation to list or retry inbound
   deliveries yet; `platform.jobs` administration (`jobs.list`, `jobs.get`,
   `jobs.retry`) covers the queue side, and a delivery left `outcome_unknown`
   currently needs a database read to inspect.

## Tables

`platform.inbound_endpoints` is `tenantScoped: false`, like `platform.api_keys`
and for the same reason: the tenant is an *output* of admission, so the
generated tenant policy would gate the read that has to happen before any tenant
is known. `db/migrations/inbound.ts` enables and forces row-level security with
the same predicate every other `platform.*` row gets, and adds
`app.inbound_endpoint_tenant(endpoint_id)` — a `SECURITY DEFINER` point lookup
over three granted columns, answering one tenant for one id and nothing else
about the registration, not even whether it is revoked.

`platform.inbound_deliveries` is `tenantScoped: true` with
`workerAccess: job-worker`, the same axis as the queue it rides on: the worker
resolves durable work across tenants for exactly this table, while a tenant
session sees only its own receipts. The registration table is deliberately
**not** on that axis — the worker's one question about it is answered by
`app.inbound_endpoint_active(endpoint_id, tenant_id)` instead, so the sealed
provider secret stays out of the worker's reach.

Both tables are declared in `packages/compiler/config/platform-schema.yaml`;
their check constraints, state machines and policies are in
`apps/api/src/db/migrations/inbound.ts`. Adding them is additive, so
`bun run db:migrate` rolls a built database forward with no versioned migration
— including the column set changed while this feature was still unreleased,
because neither table exists in any database built before it. The same applies
to the one constraint that was *narrowed* while unreleased
(`inbound_endpoints_identity_shape`, which no longer admits a `body-field`
profile with no paths): `ensureCheckConstraint` replaces a same-name constraint
whose definition differs, and only a database carrying a row the new definition
rejects would fail that replacement — which, this table being unreleased, is
none.
