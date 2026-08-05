# Connectors

A connector declares an **interface** — what it can do and how the platform
exposes it — while the code that talks to the remote system ships as a separate
package under its own license and its own release cycle.

```
connectors/<slug>/authoring/connectors/<slug>.yaml   the CONTRACT
connectors/<slug>/                                   the PACKAGE
platform.connector_*                                 the CONFIG   per tenant, RLS'd, encrypted
apps/api/src/generated/connectors/                   the PROJECTION  GraphQL + REST + MCP
```

A connector is **one directory**. Its contract sits beside the package that
implements it, and `authoring.config.yaml` lists that directory's `authoring/`
as a layer — the same shape a plugin uses to ship its own authoring. Adding or
dropping an integration is one directory and one line, rather than an edit in
two trees that can drift apart.

`examples/connectors/object-store` is the exception and stays where it is: it
has no real upstream and exists to prove the package shape is implementable.

**Contract-first, implementation-optional.** The compiler never resolves the
implementation package: doing so would make output depend on `node_modules` and
break the determinism gates. A contract compiles identically on a machine that
has none of the packages installed, and the runtime answers what is actually
available. That is what lets a locked commercial connector be visible in the
product before anyone buys it.

## Authoring a contract

One YAML file per connector under `connectors/` in an authoring layer — for a
shipped connector that means `connectors/<slug>/authoring/connectors/<slug>.yaml`.
The slug is the file stem and must be unique across the tree, like entity slugs.
Worked examples: `connectors/exact-online/` (OAuth, per-country endpoints) and
`connectors/afas-profit/` (a static token).

```yaml
schemaVersion: 1
kind: connector
connector: ObjectStore              # PascalCase; the GraphQL namespace type
title: Object storage
capabilities: [operations]

implementation:
  package: "@scope/connector-object-store"   # recorded verbatim, never resolved
  contractVersion: 1
  provenance: firstParty            # firstParty | reviewed | thirdParty
  license:
    spdx: LicenseRef-Acme-Commercial

availability:
  entitlement: connector.object-store   # absent ⇒ always available

configuration:
  instances: multiple                 # single | multiple
  fields:                             # same field vocabulary as workflow nodes
    - { key: endpoint, valueType: string, required: true }
    - { key: apiKey, valueType: string, required: true, secret: true }

network:
  egress: ["*.objectstore.example"]   # omitted ⇒ no outbound HTTP at all

operations:
  - key: listObjects
    kind: query                       # query | mutation
    authorization: { roles: { invoke: [Connectors.All.Read] } }
    input:  [ { key: prefix, valueType: string } ]
    output: { cardinality: many, fields: [ { key: key, valueType: string, required: true } ] }

exposure:
  graphql: true                       # on by default, as for entities
  rest: { enabled: true, basePath: object-store }
  mcp: true
```

### Capabilities

Typed and opt-in, so surfaces follow from what a connector *is*. An
infrastructure connector that only ships events must not acquire a GraphQL
namespace it has no use for.

| Capability | State |
| --- | --- |
| `operations` | implemented |
| `eventSource` / `eventSink` | **reserved** — declaring either is a compile error |

The event capabilities are rejected rather than ignored: the canonical event
envelope, outbox boundary, retry scheduling, dead-letter and replay are
platform-owned and designed separately, and a contract must not advertise
delivery guarantees nothing enforces. The `events:` block is rejected for the
same reason.

### Egress

The allowlist is the grant, not a filter over an open door: omitting
`network.egress` means no outbound HTTP at all. Three forms, narrowest first:

| Pattern | Matches |
| --- | --- |
| `example.com` | that host, exactly |
| `*.example.com` | exactly one extra label — `api.example.com`, not `a.b.example.com` |
| `**.example.com` | any depth — `api.example.com` **and** `api.eu.example.com` |

`**.` exists because some vendors do not put their API on a fixed host.
Twinfield reports a per-organisation cluster as `api.<cluster>.twinfield.com`
and a Dynamics sandbox sits at `<env>.sandbox.operations.dynamics.com` — both
two labels deep, where `*.` covers one. Enumerating hosts works until the vendor
adds one nobody here knew about, and the connector then fails in a way that
looks like an outage at the far end.

It is a **separate form**, not a widening of `*.`. Changing what `*.` meant
would have broadened the egress of every contract already written, with no diff
for anyone to review.

Neither wildcard matches the bare apex or a lookalike: `**.example.com` is
neither `example.com` nor `evil-example.com`. And a `**.` pattern must name at
least a domain and its suffix — `**.com` is a compile error, because that is not
a vendor, it is the internet. The check is not public-suffix aware, so `**.co.uk`
passes it while being just as broad; closing that needs the public suffix list
as a dependency.

### Reliability

`kind` alone is not enough to operate a remote system, so the operating policy
is part of the contract. Everything has a platform default; authoring only
overrides.

| Field | Meaning |
| --- | --- |
| `timeouts.attemptMs` | one attempt (default 30s, max 120s) |
| `timeouts.totalMs` | the whole operation including retries (defaults to `attemptMs × maxAttempts`, max 300s) |
| `retry` | `eligible`, `maxAttempts`, `backoff` |
| `idempotency` | `strategy: natural \| key`, `keyInput`, `header` (default `Idempotency-Key`) |
| `concurrency.perTenant` | in-flight cap per tenant |
| `rateLimit.perTenantPerMinute` | fixed-window cap per tenant |
| `circuitBreaker` | `failureThreshold`, `resetAfterMs` |
| `limits`, `pagination` | request/response byte caps; upstream paging style |

Two timeouts rather than one because a single number cannot express both: three
attempts at a 30-second budget occupy 90 seconds while every individual attempt
looks well-behaved.

**The one rule that is not a default:** a `mutation` may not be retry-eligible
without a declared idempotency strategy. That is a compile error, and it is
re-checked at runtime. An automatic retry of a non-idempotent remote mutation
duplicates real-world side effects, and nothing afterwards undoes it.

## Surfaces

All three project from the same compiled contract and delegate to the same
service, so they cannot answer differently about who may do what.

| Surface | Shape |
| --- | --- |
| GraphQL | `connectors` / `connector(slug)`; configuration mutations. Catalog types are **static**, so a connector this deployment is not licensed for is `status: NOT_LICENSED`, not a hole in the schema |
| REST | under a fixed `/api/rest/v1/connectors` segment, which removes the collision class with generated entity base paths |
| MCP | connector operations join the **existing** tool catalog: same `tools/list`, same per-session filtering, same shared 60-tool budget |

`configFields` carries the compiled field contract, so the configuration form is
generic — no connector ships UI code.

MCP annotations are derived from the operation: a query is read-only and
idempotent; a mutation claims `idempotentHint` **only** when the contract
declares a strategy, because that hint is what a model reads before deciding a
retry is safe.

## Licensing and availability

Two things that are easy to conflate and must not be:

- **`implementation.license.spdx`** is metadata. It states the package's terms
  and is surfaced wherever the connector is offered. It grants and restricts
  nothing at runtime.
- **`availability.entitlement`** is the gate.

Entitlement resolves over two axes that must agree: an Ed25519-signed
**deployment license** is the ceiling of what this deployment may offer, and a
`platform.connector_entitlements` row is the **grant** to a specific tenant.
Effective availability is the intersection, so a forged row cannot grant what
the deployment is unlicensed for, and a shared license cannot give a tenant
something nobody granted it. Every rejection path — absent, malformed, expired,
wrong deployment, bad signature — yields the empty set.

| Status | Meaning |
| --- | --- |
| `NOT_LICENSED` | reported **before** package state, so an unlicensed caller cannot learn what a deployment ships |
| `NOT_INSTALLED` | licensed, but no implementation package resolved at boot |
| `NOT_CONFIGURED` | installed, but this tenant has no usable installation |
| `DISABLED` | configured and switched off |
| `AVAILABLE` | ready |

## Configuration and secrets

Per-tenant state lives in three platform tables, all `tenantScoped`,
`domainInternal` and outside generated CRUD — they reference credentials and
entitlement state and must only ever be reached through the connector API.

Configuration is validated server-side against the contract's generated schema,
with unknown keys **rejected** rather than dropped: silently dropping is how a
misspelled key becomes a connector pointing somewhere the operator does not
expect.

Secret-marked fields never enter the installation row. They are encrypted with
AES-256-GCM, with the installation id and field key bound in as additional
authenticated data — so a ciphertext moved to another field or installation
fails to decrypt. Reads return `__set__`, never the value. Retired keys stay in
the keyring so rotation needs no downtime.

Configuring a connector requires the `Platform.ConnectorAdmin` capability, not
merely a particular caller identity: configuration hands credentials for another
system to the platform.

A package receives only the secrets **its own contract declares**. The store
answers with every row an installation holds — which is what key rotation needs
— and the invocation path narrows that to the contract before anything reaches
package code. Both halves matter, because the platform keeps rows of its own
there.

## OAuth

For a provider that speaks OAuth 2.0, the contract declares **where** and the
platform does **everything else**. Two flows, and which one a contract declares
changes what an operator has to do:

| `flow` | Represents | Consent screen | Refresh token | Setup |
| --- | --- | --- | --- | --- |
| `authorizationCode` | a person | yes | yes, often rotating | save, then **Connect** |
| `clientCredentials` | the application | **none** | **none** | save; the token is minted on first use |

`clientCredentials` is the simpler of the two: there is no callback, nothing
single-use to lose a race over, and no `CONNECTOR_REAUTHORIZATION_REQUIRED`
state to recover from — an expired token is simply requested again. Its scope is
**required**, because it is the only thing saying which resource the token is
for; Entra issues a token for whatever audience the scope names, and a wrong one
is accepted by the provider and rejected by the API much later.

Both flows interpolate `{fieldKey}` into endpoints **and scopes** from
non-secret configuration.

The authorization-code shape:

```yaml
auth:
  type: oauth2
  flow: authorizationCode
  authorizeUrl: https://start.provider.{region}/oauth2/auth
  tokenUrl: https://start.provider.{region}/oauth2/token
  clientIdField: clientId          # ordinary config fields, because each
  clientSecretField: clientSecret  # tenant registers its own application
```

The platform obtains, stores, refreshes and rotates the tokens; a package is
handed a `fetch` that already carries the access token and **never receives a
refresh token at all**. That is strictly less privilege than a package
authenticating for itself, and it is what makes rotation correct once rather
than once per connector.

Rotation is not an optional nicety. Some providers issue **single-use** refresh
tokens and replace them on every refresh — Exact Online among them — so a
connector that dropped the replacement would authenticate once and fail on its
next call.

| Decision | Why |
| --- | --- |
| Endpoints may interpolate `{fieldKey}` | A provider's endpoint is frequently per-tenant. A literal URL would mean one contract per region, differing only by a hostname. |
| Interpolated fields must be non-secret | A secret in a URL is written to every log that records the request line. |
| The client secret field must be `secret: true` | Otherwise it sits in the installation row and is returned by every configuration read. |
| The token URL's host must be in `network.egress` | The platform performs the exchange through the connector's own allowlist, so a token endpoint it cannot reach is a compile error rather than a runtime mystery. |
| Tokens live under the reserved `platform.` key prefix | The compiler refuses a contract field in that namespace, and the invocation path withholds it — so a contract can neither shadow the token row nor name its way into reading it. |

**A refresh holds a row lock across the token exchange.** A single-use refresh
token cannot survive two concurrent refreshes: both callers spend it, one wins,
and the loser could overwrite the winner's stored set. Optimistic retry is not
available because the token is already burned by the time the conflict is
visible. The cost is one database connection held for one HTTPS round trip, once
per token lifetime per installation — the second waiter re-reads the row and
finds a valid token rather than issuing a second exchange.

`CONNECTOR_REAUTHORIZATION_REQUIRED` is its own error code, and 409 rather than
401 over REST. The caller authenticated fine; it is the connector's authorization
to the provider that lapsed, and a 401 would send a client into its own re-login
flow, which cannot fix it.

### The authorize round trip

Two routes, with deliberately different threat models:

| Route | Auth |
| --- | --- |
| `POST …/connectors/:slug/installations/:key/authorize` | `Platform.ConnectorAdmin`. Mints a state and **returns** the provider URL rather than redirecting, so the authenticated half never becomes a cross-site navigation. |
| `GET …/connectors/oauth/callback` | **None, by necessity.** The provider sends the user's browser here, so no cookie or header of ours is attached. |

Everything that makes the callback safe is the `state` parameter, which is
`<tenantId>.<userId>.<secret>`:

- **Unguessable** — 32 random bytes.
- **Single-use** — `consumed_at` is stamped by the same `UPDATE` that claims the
  row, so a replay finds nothing. Reading, deciding, then marking would leave a
  window where two callbacks both pass.
- **Expiring** — ten minutes.
- **Stored as a hash** — a read of the table yields nothing presentable back.
- **Carries its own routing** — so the callback opens a normal tenant-scoped
  session and finds the row under RLS. The alternative was bypassing RLS on the
  one endpoint an unauthenticated stranger can reach, which is a far worse trade
  than two ids in a URL that already round-trips through the provider. Neither
  id authorizes anything: forge them and the hash matches no row that tenant can
  see. The user id is there because `createDbSessionContext` refuses an
  anonymous session, and carrying the ConnectorAdmin who started the flow is the
  accurate answer rather than inventing a system identity.

The callback trusts **nothing else** in its own query string. The connector, the
installation and the redirect URI all come from the claimed row — one that read
its target from the URL would let anyone holding a state write tokens into
another tenant's installation. It always answers with a 302 to a fixed path on
our own configured origin, never a URL derived from the request: an open
redirect here is the exact shape phishing wants.

PKCE (S256) is always sent. The verifier is stored encrypted under the row id as
additional authenticated data, because PKCE only binds a code to the client that
requested it while the verifier stays secret.

Two settings are required for any of this: `OPENSHAPEFORGE_PUBLIC_ORIGIN` (the
origin the provider redirects back to — configured, not derived from `Host`,
which a forged header could aim anywhere) and `OPENSHAPEFORGE_APP_ORIGIN` (where
the browser lands afterwards).

## Contract evolution

An installation records the contract version and checksum it was configured
against, because a build can succeed while every tenant's stored configuration
has quietly become invalid.

| State | Meaning |
| --- | --- |
| `CURRENT` | checksum matches |
| `CONTRACT_CHANGED` | changed but the stored config still satisfies it — still usable, because blocking every tenant on a help-text edit would make contract changes unshippable |
| `NEEDS_REPAIR` | a newly required field is absent; cannot be enabled until an operator supplies it |
| `INCOMPATIBLE` | the contract *version* moved; nothing about the stored configuration can be assumed |

## Writing an implementation package

Worked example: `examples/connectors/object-store/`.

```ts
export default {
  slug: "example-object-store",
  contractVersion: 1,
  operations: ["listObjects", "putObject"],
  async invoke(operationKey, context, input) { /* … */ },
};
```

At boot the platform resolves each package and asserts it matches its contract:
slug, contract version, optional contract checksum, and the **exact** operation
set. Missing operations and undeclared ones are both rejected — the second is
behaviour the contract never described, and so never reviewed. A package that
fails is recorded as unavailable with a reason; it never fails startup, because
one bad connector must not take an API down.

What a package receives is the whole of what it gets:

| `context` | |
| --- | --- |
| `config` | resolved non-secret configuration, frozen |
| `secrets` | only the secrets **this** contract declares, decrypted |
| `fetch` | bound to `network.egress`; non-http schemes refused |
| `signal` | the attempt budget |
| `log` | redacting logger |

No database handle, no session, no filesystem helper. A package does not
authorize the caller, validate its own input or output, decide what it may
reach, or manage retries and timeouts — the platform does all of that around it.

## Execution trust model

**This deployment executes reviewed packages in-process, as an explicit accepted
risk.** A contract declaring `provenance: thirdParty` is refused before its
module is ever imported.

That refusal is not a formality. A module loaded into this process runs with the
API's privileges: it can read `process.env`, open files, and reach the network
regardless of what the context hands it. The capability-shaped context is a real
guardrail against *mistakes* and is **not** a security boundary against hostile
code. Calling it a sandbox would be worse than having none, because it would
invite loading packages nobody reviewed.

**In-process cancellation is cooperative.** The abort signal is honoured by a
well-behaved package and by `fetch`, and ignored entirely by `while (true) {}`,
because JavaScript is single-threaded and nothing preempts it. Lateness is
therefore measured on the clock rather than on the signal, so a package that
blocks the event loop is still reported as having missed its budget — but the
work was not stopped. A test pins that limitation deliberately.

Enforceable termination needs an isolated executor (a worker thread or
subprocess the host can terminate). That is the second executor behind the same
interface, and it is what would lift the `thirdParty` refusal — for itself,
rather than by loosening the in-process path.

## What does not exist yet

- **Events and inbound webhooks.** A platform-owned pipeline with connector
  adapters, designed separately; the vocabulary is reserved and rejected.
- **Isolated execution**, per the trust model above.

(This section previously said nothing was invoked from a surface. That stopped
being true when dispatch landed alongside the surfaces in the same change:
GraphQL, REST and MCP all reach `invokeConnectorOperation`, and
`CONNECTOR_NOT_EXECUTABLE` now means only that no implementation package
resolved at boot.)

## See also

- [architecture.md](architecture.md) — where connectors sit in the pipeline
- [authoring.md](authoring.md) — the field vocabulary contracts share with entities
- [api.md](api.md) — sessions, RLS, and the surfaces connectors extend
- [mcp.md](mcp.md) — the transport connector tools join
