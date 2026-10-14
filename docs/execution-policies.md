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
once, at boot, keyed on the database connection — the same way
`registerEntityOperationAvailability` binds availability handlers. A policy
name contributed twice, a blank name or a missing `evaluate` is refused at boot
rather than resolved silently.

Every process that runs canonical Operations binds them, each on the
connection it creates:

| Process | Where |
| --- | --- |
| The API role | `roles/api.ts`, once the modules have initialised |
| The worker role — every contributed worker, the core `job-worker` included | `roles/worker.ts`, before any worker starts |

Both because the registry is keyed on the database handle: a process that
skipped this step would admit, on its own connection, exactly the governed work
the policy refuses on the other one.

A module that was configured to contribute a policy and then failed to
initialise **refuses boot**, in the API and in a worker alike, naming the
module and the reason. An enforcement owner that cannot run must never turn a
frozen tenant writable, and at request time its absence is indistinguishable
from a host that deliberately contributes none. A module that fails to
initialise and contributes no policy keeps the ordinary fail-soft behaviour.

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
or a UI state. The places core runs governed work each ask:

| Path | Call site |
| --- | --- |
| Authored, custom, native and collection Operations — REST, GraphQL, MCP, the generic Operations API, nested `execute`, keyed replay | `operations/runtime.ts`, in `invokeOperation` |
| The ordinary entity CRUD fast path — REST, GraphQL, MCP, resource reads | `operations/entity/runtime.ts`, in `executeEntityOperation` |
| Record-derived provider Operations | `modules/platform.ts`, before `provider.execute` |
| The host compatibility bridge (`invokeHostOperation`) | `modules/platform.ts` |
| A claimed job, before its contributed handler | `jobs/worker.ts`, in `runClaimedJob` |

In each case the guard runs **after** authorization — so a refusal discloses
nothing to a caller who was never allowed the action — and **before** the input
schema, the idempotency receipt, any mutation control and the handler.

### Twice: early, and again where the effects are

A governed Operation is decided twice, deliberately:

1. **Early**, before the input schema, the receipt, any transaction and any
   mutation control. This is the friendly refusal: nothing has happened yet, so
   the caller gets the policy's own sentence and no work was started.
2. **Again inside the owning execution boundary**, immediately before the
   effects: inside the transaction that will write, after every record lock,
   availability decision, lease and confirmation this invocation consumed, and
   before core admits the effects of a keyed Operation.

The second one is the decisive one. The first can be minutes old by the time a
row lock, an edit lease, a confirmation challenge or a committed receipt claim
has been dealt with, and a persisted freeze can begin — or a deadline pass —
in exactly that window. Because the second decision runs in the transaction
that owns the write, the decision and the change commit together or not at all.

Ordering follows from that: a refusal precedes every data change and every
external effect, a refused keyed Operation leaves no receipt a later retry
could replay (the claim is deleted, not completed), and a refusal never reports
an uncertain external delivery, because it is decided before core admits
effects.

A policy is therefore called more than once per invocation and must not count
its own calls; the decision is a function of trusted state, not of how often it
is asked.

### Queued and background work

A job ([jobs.md](jobs.md)) is the one execution path whose authorization is
older than its effects: it was admitted when someone enqueued it and it runs
whenever a worker reaches it. So the `job-worker` role decides again, inside
the claimed job's own transaction — after the claim is proven to still hold and
before the contributed handler writes a row or reaches a provider.

Core classifies a queued run conservatively as a data change that may also
write externally (`data: write`, `external: write`), identified by its
registered kind. A job handler is a function: nothing in the compiler declares
what it writes, and the payload that would claim to is the caller's, so the
governed reading is the only safe one.

A refusal there is a **known** settlement, never `outcome_unknown` — nothing
ran:

| Refusal | Settlement |
| --- | --- |
| Names a `retryAt` | Queued again for exactly that moment, with the attempt it never made given back. |
| Retryable with no named end | Queued again on the ordinary backoff, attempt-neutral. |
| Open-ended (not retryable), including a policy that could not answer | `failed`, with `EXECUTION_NOT_PERMITTED` recorded as the job's error. |

Claiming, locking and settling are the host's own queue bookkeeping and stay
outside the governed effects, so a frozen tenant's queue is still managed
correctly. A durable worker or broker that re-enters through the canonical
Operation API over HTTP is decided by the API process in the ordinary way.

Nested execution is decided on its own declaration: a handler that calls
`context.execute(...)`, `invokeHostOperation` or entity CRUD reaches the guard
again for the Operation it dispatches. A read-classified Operation therefore
cannot lend its admission to a governed change it delegates.

## Transactions, retries and failure

`withDbSession` joins the active session's transaction when there is one, so a
policy evaluated inside an owning Operation transaction reads the same tenant
state that transaction will write; outside one, the guard opens its own tenant
transaction.

**A decision is a read, and core enforces that.** Each policy is evaluated
inside its own savepoint with the transaction tightened to
`transaction_read_only`, and that savepoint is rolled back when the decision
returns — whatever the decision was:

- a policy that writes is refused by the database rather than by convention;
- an admitting policy's write cannot ride along with the change it admitted;
- a policy that writes and then throws leaves neither the write nor the failed
  statement behind, and the surrounding transaction — the caller's unrelated
  earlier work, a queued job's own settlement — continues unharmed, which is
  also why a poisoned decision surfaces as the canonical refusal instead of an
  internal error.

Repeated evaluation must be sound: core decides twice per governed invocation
(see above), and a nested call or a retry decides again.

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
- **A queued run is classified, not declared.** Core governs a job by its
  conservative classification, not by a contract the handler ships, so a
  read-only job is refused along with the writing ones while a tenant is
  frozen. Narrowing that needs server-owned per-kind effect facts, which this
  contract does not yet define.
- **A module that never loaded is an unknown, not a contributor.** Boot
  refuses when a module that DECLARED `executionPolicies` fails to initialise,
  because the module object exists to be read. A module whose runtime entry
  point cannot be imported at all leaves core nothing to read: its
  contributions are invisible, and the ordinary fail-soft load applies. A host
  that depends on a policy should keep it in a module whose canonical
  Operations already make a load failure fatal
  ([plugins.md](plugins.md)), and should check boot logs for load failures.
- **The last word is a decision, not a lock.** The second decision runs inside
  the owning transaction immediately before the effects, which closes the
  window the early check leaves open. It does not freeze time: a policy's state
  can still change during the write statement itself. Admission is a decision
  at a moment, and `retryAt` wording should allow for that.
- **The same Operation may be asked several times.** A governed invocation
  decides twice by design, a plugin-backed entity Operation passes the entity
  fast path and then the canonical runtime, and nested execution decides again.
  A policy must be a function of trusted state and must not count its calls.
- **An unclassifiable declaration is treated as a change.** Only a runtime
  Operation provider — plugin code — can report effects outside the compiler's
  vocabulary; core reads those as a governed write rather than admitting them.
- **Row-level security is still the floor.** A policy is an admission decision,
  not an isolation mechanism. Tenant isolation remains RLS's job, and the
  policy's own reads are subject to it.
- **No clock override is exposed.** Core gives a policy no time source and no
  way to make one caller-supplied. A host that needs a testable clock keeps it
  inside its own policy implementation.
- **Not a reservation.** Admission says the change is permitted at that moment,
  not that it will still succeed: conditional writes, version tokens and
  database constraints remain necessary.
