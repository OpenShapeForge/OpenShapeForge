# Durable jobs

Core ships one durable job queue — an outbox — so a plugin that delivers
e-mail or runs completion work after a commit does not build its own table,
lease columns, retry counter and worker grants. One table, one worker role,
one handler registry; plugins contribute job kinds and enqueue.

| Piece | Where |
| --- | --- |
| `platform.jobs` | `packages/compiler/config/platform-schema.yaml`; invariants in `apps/api/src/db/migrations/jobs.ts` |
| enqueue / claim | `apps/api/src/jobs/store.ts`; the persisted session in `actor-session.ts` |
| the row lock and settle | `apps/api/src/jobs/settle.ts` |
| resolve / list / sweep | `apps/api/src/jobs/queries.ts` |
| the `job-worker` role and poll loop | `apps/api/src/jobs/worker.ts`, contributed by `apps/api/src/jobs/module.ts` |
| the handler registry | `apps/api/src/jobs/handlers.ts` |
| the `mail.deliver` kind and the SMTP provider | `apps/api/src/jobs/mail/` |
| the `jobs.*` Operations | `packages/compiler/src/job-operations.ts`, handlers in `apps/api/src/jobs/operations.ts` |
| the public contract | `packages/plugin-runtime/src/index.ts` (`RuntimeJobServices`, `RuntimeJobHandler`, `jobHandlers`) |

## The model

A job is a row: a namespaced `kind` (`mail.deliver`, `<plugin>.<job>`), a
JSON `payload`, and a `status`:

```
queued ──claim──▶ running ──settle──▶ done
   ▲                 │                failed
   │   retry         │                dead              (attempts ≥ max_attempts)
   └─────────────────┘                outcome_unknown   (an external effect MAY have happened)
```

- **`queued`** — due once `available_at` has passed. A retry puts the job back
  here with an exponential, jittered `available_at` (30 s doubling, capped at
  an hour).
- **`running`** — claimed. The row holds `lease_until` and the SHA-256 of a
  one-time claim token. Only the holder of that token can settle the run; a
  lease that expires is reclaimed by the next claim, and one that expires at
  the attempt bound is closed as `dead` with `LEASE_EXPIRED`. While a handler
  runs, its transaction holds the row locked, so an expired lease is never
  reclaimed from under a run that is still going (below).
- **`done`** — with an optional `result`. Swept after retention (below).
- **`failed`** — the handler said retrying will not help. Terminal until an
  operator retries it.
- **`dead`** — the attempt budget ran out, or no active module handles the
  kind. Terminal until an operator retries it.
- **`outcome_unknown`** — the handler could not tell whether its external
  effect happened: the SMTP `DATA` was sent and the acknowledgement never
  came. This is the state keyed Operations report as
  `OPERATION_OUTCOME_UNKNOWN` ([plugins.md](plugins.md#canonical-operations)),
  and it is a state rather than a retry for the same reason — the platform
  never repeats an effect it cannot prove did not happen. An operator confirms
  out of band and either retries (`jobs.retry`) or marks it done.

The row also carries an optional `delivery_key`, an optional subject
(`subject_entity`, `subject_id`), the enqueuing person's session
(`actor_id`, `actor_session`) and a monotonic `sequence`. The key makes
enqueueing idempotent per tenant and kind: enqueueing the same key twice
returns the first job, whatever state it is in. The subject is what a screen
uses to show the jobs of one record. The session is replayed when the job
runs (below). The sequence is a bigint identity, the `jobs.list` cursor:
`created_at` is not one, because jobs enqueued in one transaction share it.

The table is tenant-scoped and RLS'd. It declares `workerAccess: job-worker`,
so the worker claims across every tenant on the worker axis
([api.md](api.md#the-worker-axis)); an ordinary session sees its own
tenant's rows and nothing else.

## Enqueueing

From a plugin's Operation handler, through the platform services:

```ts
operationHandlers: {
  async sendLink(input, { platform, session }) {
    // ...domain write under the same session...
    await platform!.jobs.enqueue(session!, {
      kind: "mail.deliver",
      payload: { to: input.email, subject: "Your link", text: url },
      deliveryKey: `link:${recordId}`,
      subject: { entity: "Request", id: recordId },
    });
    return { value: { status: "queued" } };
  },
},
```

`enqueue` runs inside the active transaction when there is one — the
outbox: the job exists exactly when the domain write does, and a rolled back
handler enqueues nothing. The active transaction is the Operation's, or, for
a storage contribution called from its `stage` or `read`, the transaction
that artifact call opened: a provider that stages a file and schedules its
collection commits the row and the job together, and an Operation invoked
inside that stage joins the same transaction rather than opening a second
one. The same rule holds for `platform.db.withSession`, `platform.events`
and the record oracle. The tenant, the actor and the actor's whole
effective session — roles, org-unit groups, RelationGroup memberships,
scope — come from the verified session, never from input, and are persisted
on the row: the job will run as this person, with what this request could
reach and nothing a later role change would add or remove. `availableAt`
schedules a job for later (the default is the database's `now()`, the clock
the poll compares against) and `maxAttempts` (default 5) bounds retries.

## Handling

A module registers handlers by kind next to its operation handlers:

```ts
const runtimeModule: RuntimeModule = {
  name: "example",
  jobHandlers: {
    async "example.complete"(payload, { job, db, log }) {
      // db: a tenant session for job.tenantId as the worker role
      const row = await db.selectFrom("example.requests")/* … */.executeTakeFirst();
      if (!row) return { outcome: "failed", error: { message: "Request vanished." } };
      await renderAndStore(row);
      return { outcome: "done", result: { artifactId } };
    },
  },
};
```

A handler returns one of `done`, `retry`, `failed` or `outcome_unknown`
(`RuntimeJobOutcome`). Returning nothing is `done`; throwing is `retry`; an
outcome that is not one of those, or a `retry`, `failed` or `outcome_unknown`
without an `error` to record, is a handler bug and settles that job `failed`
with `INVALID_OUTCOME` — never the batch.

The handler's `db` is a tenant session that **replays the session of the
person who enqueued the job**: tenant, user, roles, groups, RelationGroup
memberships and scope, exactly as the row stored them at enqueue. Every row
the handler touches is fenced the way that person's own request would be.
`job-worker` appears nowhere in it — not in `app.roles`, and not in
`app.worker_role` either: that GUC is the cross-tenant widen of the queue's
own policy, and a handler holding it could read every tenant's jobs. The
module's own tables that declare `workerDml: true` are reachable through the
GRANTs the worker connection holds, under the tenant predicate like
everything else. Nothing in the control plane is reachable, and on
`platform.jobs` the handler sees its own tenant's rows only.

The run and its outcome are one transaction. Before the handler runs, that
transaction locks the job's own row against the claim token
(`select … for update`): a claim whose lease expired and was handed to
another worker matches nothing, and the stale holder stops before any
effect; while the lock is held, a claim (`skip locked`) cannot hand the job
to anyone else, however long the run takes. When the handler returns, the
outcome is settled in the same transaction, so the handler's writes and the
job's state commit together — there is no window in which the work is done
and the row still says `running`. Only a handler that **throws** is settled
apart, as a `retry`, after its transaction rolled back. A crash between
commit and nothing — the process dying mid-run — leaves a `running` row
whose lease expires and is reclaimed, and the handler runs again: a handler
with an external effect must be idempotent on its own terms, or end
`outcome_unknown` when it cannot be.

Composition fails closed: a kind two active modules both register stops the
API and the worker at boot, and a queued job whose kind no module handles ends
`dead` with `NO_HANDLER` on its first claim rather than spending the retry
budget on a configuration problem.

## The worker

```sh
OPENSHAPEFORGE_ROLE=job-worker \
OPENSHAPEFORGE_WORKER_DATABASE_URL=postgres://openshapeforge_worker:openshapeforge_worker@localhost:5434/openshapeforge_dev \
  bun apps/api/src/index.ts
```

One process, polling every second (`OPENSHAPEFORGE_JOBS_POLL_INTERVAL_MS`)
and running up to `OPENSHAPEFORGE_JOBS_BATCH_SIZE` jobs per tick. Each job is
claimed **immediately before it runs**, one claim per job, with a
`OPENSHAPEFORGE_JOBS_LEASE_SECONDS` lease (default 120 — size it to the
slowest handler) measured from the start of its own run, so a slow neighbour
in the same tick cannot eat it. `stop()` is checked before every claim: the
job in hand finishes and records its outcome, the ones not yet claimed stay
queued for the next worker, and nothing has to be released. It connects as
the `openshapeforge_worker` database role and refuses the API's connection
string ([plugins.md](plugins.md#worker-roles)).

The worker refuses to start without a mail transport (below): a queue that
would mark undelivered mail `done` is worse than a worker that is not
running.

Two workers are safe: a claim is `for update skip locked`, so a contended job
goes to exactly one of them and a slow job never stalls the other.

## `mail.deliver`

Payload `{ to, subject, text, html?, replyTo?, headers?, from? }` — `to` is one
bare address or up to fifty. Bodies are sent base64; a line break in a subject
or custom header is encoded away, so a payload cannot smuggle a header.

The provider is picked from the environment when the worker starts, and
**one must be configured** or the worker does not start:

- `OPENSHAPEFORGE_SMTP_URL` set — the built-in SMTP client
  (`apps/api/src/jobs/mail/smtp.ts`): `smtp://` plain with STARTTLS when the
  relay offers it, `smtps://` implicit TLS, `user:pass@` for AUTH PLAIN.
  `OPENSHAPEFORGE_MAIL_FROM` is required alongside it. The compose stack
  ships Mailpit: `smtp://localhost:1025`, inbox at http://localhost:8025.
- `OPENSHAPEFORGE_MAIL_PROVIDER=null` with `NODE_ENV=development` — the
  **null provider**, an opt-in that only explicit development gets; staging,
  production, test and an unlabelled environment are refused alike. Every
  message is logged at `warn` and the job ends **`failed`** with
  `MAIL_NOT_CONFIGURED`.
  A message nobody received is not delivered, and a `done` job would say it
  was; the queue keeps the truth for an operator to retry once a transport
  exists. Loud on purpose, so a developer sees what was dropped.
- neither — the worker refuses to start and says which of the two to set.
  The API process, which composes the jobs module only to validate the job
  kinds, needs no transport.

The client is written rather than depended on because the outcome depends on
*where* a failure happened, which a library's "send failed" does not say:

| What happened | Outcome |
| --- | --- |
| connection refused, handshake failed, `MAIL`/`RCPT` deferred (4xx) | `retry` |
| `RCPT`/`MAIL`/`DATA` refused permanently (5xx) | `failed` |
| the body was sent and the acknowledgement timed out or the socket dropped | `outcome_unknown` |
| the body was sent and the relay answered 4xx | `retry` (it said it did not take it) |

A deployment with other needs supplies its own `MailProvider`
(`apps/api/src/jobs/mail/provider.ts`): `send(message)` returning a provider
message id, throwing `MailDeliveryError` with the phase.

## Operating

Three canonical Operations, gated by the tenant role `Platform.Jobs.Manage`
and projected to REST, MCP and GraphQL:

| Operation | REST | MCP | GraphQL |
| --- | --- | --- | --- |
| `jobs.list` — filter by `kind`, `status`, `subject`; cursor paged | `POST /api/jobs/list` | `jobs_list` | `jobs` |
| `jobs.get` | `POST /api/jobs/get` | `jobs_get` | `job` |
| `jobs.retry` — `resolution: requeue` (default) or `done` | `POST /api/jobs/retry` | `jobs_retry` | `jobRetry` |

`retry` accepts `failed`, `dead` and `outcome_unknown` jobs only; `requeue`
resets the attempt budget, `done` closes the job as delivered when the effect
was confirmed elsewhere. Anything else answers `409 CONFLICT`. The views omit
the payload and actor: a payload may carry personal data, and the operator's
question is what happened, not what was sent.

## Retention

The worker deletes `done` jobs whose `completed_at` is older than
`OPENSHAPEFORGE_JOBS_DONE_RETENTION_DAYS` (default 30; `0` keeps them), once
an hour. `failed`, `dead` and `outcome_unknown` rows are never swept: each is
a decision an operator has not taken yet. See [retention.md](retention.md).

## Testing

- `apps/api/src/db/__tests__/jobs.test.ts` — the store under both database
  roles: idempotent enqueue, tenant isolation, concurrent claims, lease
  expiry, dead-lettering, `outcome_unknown` terminal, the replayed session
  (and that a handler sees no other tenant's jobs), the row lock a running handler holds and the stale
  claim that stops before any effect, the malformed outcome, `stop()`
  between jobs, the sequence cursor, the sweep, the Operations.
- `apps/api/src/jobs/mail/smtp.test.ts` — the SMTP client against an
  in-process fake relay, one failure phase per test.
- `apps/api/src/jobs/mail/smtp.test.ts` also covers provider selection: SMTP,
  the null opt-in under explicit development, its refusal everywhere else,
  and the worker refusing to start without either.
- `apps/api/src/rest/__tests__/jobs.e2e.test.ts` — a `mail.deliver` job
  through the worker with the null provider, ending `failed`, administered
  over REST and GraphQL.
