# Host execution policies

An execution policy is a server-owned admission guard: it answers whether a
tenant may change anything at all right now. Core evaluates it before it runs a
governed canonical Operation, on every transport.

This is deliberately not the same seam as
[operation availability](operation-availability.md). Availability answers
whether one authored action is meaningful for one record of its own target
entity, and is keyed on that Operation's handler. A host that must make a
tenant read-only — at a deadline it persisted, during an operator maintenance
window — has nothing to attach such a handler to: the rule applies to every
entity, every plugin and every transport at once. That is what this contract is
for.

Core owns the boundary; it owns no business rule. OpenShapeForge ships no
deadline, no subscription state and no freeze schedule. What it ships is where
the question is asked, what a policy is allowed to see, and what happens when a
policy refuses or cannot answer.

## Ownership

| Owner | What it owns |
| --- | --- |
| The compiler | Operation identity, intent and the immutable `effects` declaration a policy decides on. |
| Core runtime | Where admission is checked, which Operations are governed, the tenant-scoped transaction and session a policy receives, decision validation, composition, and the canonical refusal. |
| A runtime module | The policies themselves: `executionPolicies` on its `RuntimeModule`. |

A policy is contributed code, not configuration and not request input. Nothing
a caller sends can select, add, replace, reorder or disable one.

## Contributing a policy

```ts
import type { RuntimeExecutionPolicy, RuntimeModule } from "@openshapeforge/plugin-runtime";

const readOnlyAfterDeadline: RuntimeExecutionPolicy = {
  name: "tenant-write-deadline",
  async evaluate(request, context) {
    // context.db is a tenant-scoped transaction under context.session, so this
    // reads exactly one tenant's row, under row-level security.
    const rows = await context.db
      .selectFrom("tenant_write_window")
      .select(["writesUntil"])
      .execute();
    const until = rows[0]?.writesUntil;
    if (!until || new Date() < new Date(until)) return { admitted: true };
    return {
      admitted: false,
      refusal: {
        message: "This workspace is read-only.",
        detail: "Its write period ended; everything stays readable.",
      },
    };
  },
};

export default {
  name: "example-host",
  executionPolicies: [readOnlyAfterDeadline],
} satisfies RuntimeModule;
```

Core binds the policies of every module that loaded and initialised cleanly,
once, at boot (`roles/api.ts`), keyed on the database connection — the same way
`registerEntityOperationAvailability` binds availability handlers. A module
that failed to load contributes no policy. A policy name contributed twice, a
blank name or a missing `evaluate` is refused at boot rather than resolved
silently.

## What a policy may see

`request.operation` is a frozen copy of the compiler-owned facts:

| Field | Meaning |
| --- | --- |
| `id` | Canonical Operation id as the compiler emitted it. |
| `intent` | `list`, `get`, `create`, `update`, `delete` for entity Operations; `invoke` otherwise. |
| `effects.data` | `read`, `write` or `delete`. |
| `effects.external` | `none`, `read` or `write`. |

`context.session` is a frozen copy of the verified live session core
authorized this invocation with, and `context.db` is a tenant-scoped
transaction opened — or joined — under exactly that session.

Deliberately absent: the request input, HTTP headers, a client clock, claimed
roles, a database URL, a privileged or cross-tenant connection, and any mutable
annotation on the Operation. A policy that writes to `context.session` or to
`request.operation` changes nothing: both are frozen, and the next policy sees
the originals.

## Which Operations are governed

An Operation is governed when its declared effects say it changes something:

```
effects.data !== "read"  ||  effects.external === "write"
```

A declared read with no external write is never governed. That is what keeps a
read-only tenant usable: sign-in, token refresh, session resolution, Operation
discovery, projections, `get` and `list` all keep working while writes are
refused. Core's own identity bookkeeping — identity ↔ Relation linking, the
OAuth callback's connection row, credential resolution — does not run as a
canonical Operation at all, so it is outside this guard by construction and
cannot be denied because a tenant's product writes are.

Only tenant-scoped sessions are consulted. A control-realm operator has no
tenant, so a tenant policy has nothing to say about the `osf-control`
Operations; those remain governed by their own operator roles.

## Where admission is checked

Admission is checked on actual execution, never only on an offer, a projection
or a UI state. The four places core runs a canonical Operation each ask:

| Path | Call site |
| --- | --- |
| Authored, custom, native and collection Operations — REST, GraphQL, MCP, the generic Operations API, nested `execute`, keyed replay | `operations/runtime.ts`, in `invokeOperation` |
| The ordinary entity CRUD fast path — REST, GraphQL, MCP, resource reads | `operations/entity/runtime.ts`, in `executeEntityOperation` |
| Record-derived provider Operations | `modules/platform.ts`, before `provider.execute` |
| The host compatibility bridge (`invokeHostOperation`) | `modules/platform.ts` |

In each case the guard runs **after** authorization — so a refusal discloses
nothing to a caller who was never allowed the action — and **before** the input
schema, the idempotency receipt, any mutation control and the handler. A
refusal therefore precedes every data change and every external effect of the
Operation it refuses, and a keyed Operation that is refused persists no receipt
a later retry could replay.

A durable worker or broker re-enters through the canonical Operation API with a
service identity, so work queued while the tenant could still write is decided
again, on the live policy, when it actually executes.

Nested execution is decided on its own declaration: a handler that calls
`context.execute(...)`, `invokeHostOperation` or entity CRUD reaches the guard
again for the Operation it dispatches. A read-classified Operation therefore
cannot lend its admission to a governed change it delegates.

## Transactions, retries and failure

`withDbSession` joins the active session's transaction when there is one, so a
policy evaluated inside an owning Operation transaction reads the same tenant
state that transaction will write, and a policy evaluated outside one opens and
commits its own read-only tenant transaction — it cannot roll back unrelated
earlier work.

A policy must be a read-only decision. It is called inside the owning
transaction when there is one, so a write there would commit with, or be rolled
back by, work the policy has no business touching. Repeated evaluation must be
sound: core evaluates once per invocation, and a nested call or a retry
evaluates again.

Everything that is not an explicit, well-formed decision is a refusal:

| Outcome | Result |
| --- | --- |
| `{ admitted: true }` | Admitted. |
| `{ admitted: false, refusal: { message, detail?, retryAt? } }` | Refused with the policy's wording. |
| A thrown error, a rejected promise, a malformed or extra-keyed result, a missing discriminant, an empty or over-long message, an unparseable `retryAt` | Refused with core's own wording; the cause goes to the server log only. |
| The policy transaction itself fails | Refused as retryable; the cause goes to the server log only. |

## The refusal a caller sees

Core owns the error, so a policy can neither impersonate one of the
Operation's declared failures nor leak a cause into an answer:

```json
{
  "error": {
    "code": "EXECUTION_NOT_PERMITTED",
    "message": "This workspace is read-only.",
    "detail": "Its write period ended; everything stays readable.",
    "retryable": false
  }
}
```

`EXECUTION_NOT_PERMITTED` is 403 on REST — the caller authenticated and is
authorized for the action; the tenant's own policy forbids it right now — and
the same canonical failure on GraphQL, MCP, the generic Operations API and
every broker or queued execution. A refusal that supplies `retryAt` is
reported as retryable from that instant; an open-ended one is not retryable, so
a client does not spin.

## Composition

Policies are evaluated in a deterministic order — module load order, then
policy name within a module — and the **first refusal denies**. Every policy
must admit for an Operation to run, a policy that cannot answer denies, and the
remaining policies are not consulted once one has refused. Conservative on
purpose: adding a policy can only ever narrow what a tenant may do.

## Limits worth knowing

- **The declaration is the contract.** Core reads an Operation's
  compiler-owned `effects`, not its handler. A handler that declares
  `data: read` and then writes through its own transaction breaks the compiler
  contract, and this guard will not catch it. What core does hold is every
  governed change that goes through canonical execution, including the ones a
  read-classified Operation dispatches.
- **A job handler's own writes are not an Operation.** The durable queue runs
  contributed `jobHandlers` directly against a tenant transaction
  ([jobs.md](jobs.md)). Those writes are outside this guard; a queued job that
  works through canonical Operations — the durable broker's normal route — is
  inside it.
- **Row-level security is still the floor.** A policy is an admission decision,
  not an isolation mechanism. Tenant isolation remains RLS's job, and the
  policy's own reads are subject to it.
- **No clock override is exposed.** Core gives a policy no time source and no
  way to make one caller-supplied. A host that needs a testable clock keeps it
  inside its own policy implementation.
- **Not a reservation.** Admission says the change is permitted at that moment,
  not that it will still succeed: conditional writes, version tokens and
  database constraints remain necessary.
