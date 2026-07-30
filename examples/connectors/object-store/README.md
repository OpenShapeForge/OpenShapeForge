# Example connector: object store

A worked implementation of the contract in
`packages/compiler/config/authoring/connectors/example-object-store.yaml`.

It exists to answer one question that a contract alone cannot: is the runtime
package shape actually implementable? Everything else about connectors is proved
against fixtures — this is the only place a real package is loaded, handed a
real context, and invoked.

## The split

| Lives in | Holds |
| --- | --- |
| `…/config/authoring/connectors/example-object-store.yaml` | the contract: operations, config fields, egress allowlist, reliability policy, which surfaces expose it |
| this package | the only thing that knows how to talk to the remote system |

A real connector would live in its own repository, ship on its own release
cycle, and carry its own license — the contract's `implementation.license` block
is where those terms are declared. This one is in-tree so the example is
runnable and covered by the repo's gates, which is why it carries the same
BUSL-1.1 headers as everything else here.

It is a **devDependency** of `apps/api`, not a dependency. The API depends on no
particular connector; the link exists so this example and its tests resolve. A
real deployment installs the connectors it is licensed for, and plain
`import(specifier)` finds them.

## What the platform does, so this package does not

- authorizes the caller — invoke roles are checked before this is reached
- validates input and output against the contract's generated JSON Schemas
- decides what it may reach — `context.fetch` is bound to `network.egress`
- applies timeouts, retries, concurrency, rate limits, the circuit breaker
- decrypts and hands over only the secrets **this** contract declares

The context is everything it gets, and everything it needs: no database handle,
no session, no filesystem, no environment reads.

## What this package does do

Two operations, and one obligation worth naming. The contract declares
`idempotency: { strategy: key, keyInput: requestId }` on `putObject`, which is
the only reason that operation may be retried at all. Forwarding that key
upstream as `Idempotency-Key` is this package's side of the bargain — without
it, a retry creates a second object and the contract claims a safety it does not
have.

## Running it

```bash
bun test apps/api/src/connectors/__tests__/example-connector.e2e.test.ts
```

That suite loads this package through the real loader, puts it through the
boot-time contract handshake, and invokes both operations against a stubbed
upstream — asserting the egress refusal, the credential handover, the
idempotency key, and that a result which does not match the declared output is
rejected.

See [docs/connectors.md](../../../docs/connectors.md) for the full model.
