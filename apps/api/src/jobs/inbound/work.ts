// SPDX-License-Identifier: BUSL-1.1
/**
 * The durable work store behind an admitted inbound delivery: what the core
 * `job-worker` contributes as `resolveOperationWork`, `pinOperationContract`
 * and `markOperationDispatch`, so `createDurableWorkerBroker`
 * (operations/durable-worker.ts) can dispatch a receipt to a canonical
 * Operation under the organization's service identity.
 *
 * Every statement runs on the WORKER connection inside
 * `withJobWorkerSession`: `platform.inbound_deliveries` declares
 * `workerAccess: job-worker`, so the role may read and write across tenants
 * for exactly this table and no other widening is involved.
 *
 * ## What fences a claim here
 *
 * The broker's work reference is `{ workId, attempt, workerId }`, and the
 * fence is the delivery's own queue row:
 *
 *   join platform.jobs on j.id = d.dispatch_job_id and j.tenant_id = d.tenant_id
 *   and j.status = 'running' and j.attempts = <attempt> and j.lease_until > now()
 *
 * That triple IS this queue's claim identity. A reclaim bumps `attempts`, so a
 * worker still running the previous attempt no longer matches; a lease that
 * expired without being reclaimed does not match either, because the lease is
 * in the predicate. The public job-claim contract (`RuntimeJobClaim`)
 * deliberately hands a handler no claim token — the token is the worker loop's
 * own fencing secret — so `workerId` is the worker process's identity, carried
 * for telemetry and checked for shape, never treated as proof. Nothing is
 * admitted on it that the queue row does not already establish.
 *
 * ## The registration must still be live — rechecked, not remembered
 *
 * A queued dispatch is a decision taken at admission. Between then and the
 * request leaving, the tenant may have stopped the subscription, so the claim
 * fence above is not enough: it proves who owns the attempt, not that the
 * endpoint is still active. Every read here therefore also requires
 * `app.inbound_endpoint_active(d.endpoint_id, d.tenant_id)` — one boolean for
 * one TENANT-PAIRED endpoint, so a delivery can never be cleared by an active
 * endpoint of another tenant, and the worker still cannot read the
 * registration row itself (it holds the sealed provider secret). The function
 * is a SECURITY DEFINER point lookup whose owner may read three columns of
 * that table and nothing else (db/migrations/inbound.ts); the worker holds
 * EXECUTE on it and on no other inbound lookup.
 *
 * What that guarantees, exactly, and where it stops.
 *
 * `createDurableWorkerBroker` re-resolves the work immediately before dispatch
 * and again before every limiter repeat, and `markOperationDispatch` — same
 * predicate — commits BEFORE the request leaves. The mark is therefore the last
 * point a revocation can stop anything: before it, the resolve finds nothing,
 * the broker reports a lost claim, and the delivery is settled `failed` with
 * nothing sent; at it, the mark affects no row and the broker reports that
 * nothing was executed.
 *
 * The mark and the revocation are SERIALIZED against each other, so that last
 * point is a decision with an order rather than a window. Both take the same
 * `(tenant, endpoint)` transaction advisory lock before writing anything
 * (modules/inbound-endpoint-gate.ts): the mark here, the status write in
 * `revokeInboundEndpoint`. Whichever acquires it reaches its decision alone, and
 * the mark's `update` then evaluates the liveness predicate in a statement
 * snapshot taken AFTER the lock was granted — so a revocation that committed
 * first is seen and the mark fails, and a revocation that did not commit first
 * cannot commit until this transaction has. The lock needs no privilege on the
 * registration row, because an advisory key is not a catalog object; what the
 * worker reads is still only the liveness bit. A dispatch authorized after a
 * revocation that won is not an ordering this leaves open.
 *
 * A mark that wins is the other direction, and it is deliberate: that attempt is
 * explicitly in flight, and revocation has never claimed to retract one. Past
 * the mark there is nothing left to stop — no transaction spans an outbound HTTP
 * call. That delivery settles on its own outcome, the record of the started
 * attempt is never rewritten, and the row says which case it was —
 * `dispatch_state = 'started'` with `dispatch_attempt` means a request went out,
 * `'not-dispatched'` means one provably did not.
 *
 * Revocation never withdraws a receipt already taken, and no connection-state
 * check beyond the endpoint's own status happens here: a provider Connection is
 * plugin-owned and core has no liveness port for one (docs/inbound-deliveries.md).
 *
 * ## The payload is sealed, and the worker opens it under the row's own scope
 *
 * `body_ciphertext` is AES-256-GCM with AAD bound to tenant + endpoint +
 * delivery (`inboundBodyScope`). The worker rebuilds that scope from the row it
 * just read under its claim, so a ciphertext moved onto another row — another
 * tenant's, another endpoint's, another delivery's — fails to open rather than
 * decrypting into the wrong dispatch. A payload that cannot be opened is a
 * REFUSAL to dispatch, never an empty body: a key this host no longer has is
 * retryable (restore the key), a ciphertext no present key can open and a
 * payload already removed by retention are terminal and say so.
 *
 * ## Two connections on one row, deliberately
 *
 * The pin and the dispatch mark are queue bookkeeping and run here, on the
 * worker connection, each in its own committed transaction. The delivery's
 * TERMINAL state is written by the handler instead (`./dispatch.ts`), on its
 * own tenant transaction, so it commits together with the job's outcome.
 *
 * The two do not contend. The handler's `select ... for update` holds the JOB
 * row, which everything here only reads — and an MVCC reader does not block on
 * a row lock. The updates here target the DELIVERY row, which the handler
 * touches only when it settles, by which time these have committed; the
 * session is READ COMMITTED, so the handler's settle sees them. The mark's gate
 * is held inside that one transaction and released by its commit, so it is
 * never held while the handler runs or while anything waits on the network.
 *
 * ## Why the authority is not the enqueuing actor
 *
 * The job row's actor is the verified user who registered the endpoint; it
 * fences the handler's database session and nothing more. The authority the
 * Operation executes under is `service_identity_id` on the delivery row, which
 * the broker exchanges for a live token and re-verifies against the
 * organization before every dispatch. A stored identifier is not an authority
 * and is never treated as one.
 */
import { sql, type Transaction } from "kysely";
import type {
  RuntimeDurableWorkReference, RuntimeInboundDeliveryEnvelope, RuntimeResolvedOperationWork,
} from "@openshapeforge/plugin-runtime";
import type { OpenShapeForgeDatabase } from "../../db/connection.js";
import type { DB } from "../../generated/db/types.js";
import { jsonbLiteral } from "../../db/sql-helpers.js";
import { DurableAuthorityError } from "../../operations/durable-worker.js";
import { INBOUND_BODY_FIELD, inboundBodyScope } from "../../modules/inbound-admission.js";
import {
  boundInboundEndpointGateWait, restoreInboundEndpointGateWait, inboundEndpointGateKey,
} from "../../modules/inbound-endpoint-gate.js";
import { decryptSecret, keyringFromEnv, type SecretKeyring } from "../../platform/secrets.js";
import { withJobWorkerSession } from "../worker.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type DeliveryWorkRow = {
  id: string;
  tenant_id: string;
  endpoint_id: string;
  endpoint_key: string;
  service_identity_id: string;
  operation_id: string;
  operation_input_field: string;
  idempotency_key: string;
  event_type: string | null;
  unsigned_provider_delivery_id: string | null;
  unsigned_event_type: string | null;
  body_sha256: string;
  body_ciphertext: string | null;
  body_key_id: string | null;
  body_algorithm: string | null;
  body_purged_at: string | Date | null;
  received_at: string | Date;
  contract_fingerprint: string | null;
  dispatch_attempt: number | null;
  dispatch_state: string;
};

/**
 * The verified bytes, base64, or a thrown recovery error naming what to do.
 *
 * `DurableAuthorityError` because the broker rethrows exactly that type
 * untouched; anything else it catches becomes a generic retryable answer, and
 * "key is gone" retried forever is how a visible configuration problem turns
 * into a silent one. The retryable/terminal split is the recovery instruction:
 *
 *   keyring absent      → retryable. The host is misconfigured, not the row;
 *                         restoring the key makes this attempt succeed.
 *   payload removed     → terminal. Retention took it (body_purged_at); no
 *                         retry brings it back, and dispatching an empty body
 *                         would be a falsified delivery. Retention only ever
 *                         purges a SETTLED delivery and a settled one is not
 *                         resolvable, so this is the floor under that rule
 *                         rather than a state the sweep produces.
 *   cannot be opened    → terminal. Key loss or a tampered row. Reported, never
 *                         acknowledged as delivered and never silently dropped.
 */
export function openInboundDeliveryBody(
  keyring: SecretKeyring | undefined, row: DeliveryWorkRow,
): string {
  if (row.body_purged_at !== null || row.body_ciphertext === null ||
    row.body_key_id === null || row.body_algorithm === null) {
    throw new DurableAuthorityError(
      "INBOUND_BODY_PURGED",
      "The retained payload of this inbound delivery has been removed and cannot be dispatched.",
    );
  }
  if (!keyring) {
    throw new DurableAuthorityError(
      "INBOUND_BODY_KEY_UNAVAILABLE",
      "This worker has no secret keyring and cannot open an inbound delivery payload.",
      true,
    );
  }
  try {
    return decryptSecret(
      keyring, inboundBodyScope(row.tenant_id, row.endpoint_id, row.id), INBOUND_BODY_FIELD,
      { ciphertext: row.body_ciphertext, keyId: row.body_key_id, algorithm: row.body_algorithm },
    );
  } catch {
    // Never the ciphertext, the key id or any part of the payload in the
    // message: this text reaches a job row and an operator's log.
    throw new DurableAuthorityError(
      "INBOUND_BODY_UNREADABLE",
      "The payload of this inbound delivery cannot be opened with the keys this host holds.",
    );
  }
}

/** A reference core may act on at all: shapes only, before any SQL runs. */
function usable(reference: RuntimeDurableWorkReference): boolean {
  return !!reference && UUID.test(reference.workId ?? "") &&
    Number.isSafeInteger(reference.attempt) && reference.attempt >= 1 &&
    typeof reference.workerId === "string" && reference.workerId.length > 0 &&
    reference.workerId.length <= 128;
}

export function inboundDeliveryEnvelope(
  row: DeliveryWorkRow, body: string,
): RuntimeInboundDeliveryEnvelope {
  return {
    deliveryId: row.id,
    endpointId: row.endpoint_id,
    endpointKey: row.endpoint_key,
    // From inside the provider's signature. The headers beside it were not,
    // and the envelope says so in its own field names.
    eventType: row.event_type,
    unsigned: {
      providerDeliveryId: row.unsigned_provider_delivery_id,
      eventType: row.unsigned_event_type,
    },
    receivedAt: new Date(row.received_at).toISOString(),
    bodySha256: row.body_sha256,
    body,
  };
}

/**
 * The read every operation here is fenced by: one delivery, under a live claim
 * on its own tenant's queue row, whose endpoint is still active. Anything else
 * is nothing — an expired lease, a reclaimed attempt, a settled delivery and a
 * revoked subscription are all simply absent, and the broker reports a lost
 * claim rather than dispatching.
 */
async function claimedDelivery(
  db: OpenShapeForgeDatabase, reference: RuntimeDurableWorkReference,
): Promise<DeliveryWorkRow | undefined> {
  const rows = await withJobWorkerSession(db, (trx) => sql<DeliveryWorkRow>`
    select d.id, d.tenant_id, d.endpoint_id, d.endpoint_key, d.service_identity_id,
           d.operation_id, d.operation_input_field, d.idempotency_key, d.event_type,
           d.unsigned_provider_delivery_id, d.unsigned_event_type, d.body_sha256,
           d.body_ciphertext, d.body_key_id, d.body_algorithm, d.body_purged_at,
           d.received_at, d.contract_fingerprint, d.dispatch_attempt, d.dispatch_state
      from platform.inbound_deliveries d
      join platform.jobs j on j.id = d.dispatch_job_id and j.tenant_id = d.tenant_id
     where d.id = ${reference.workId}::uuid
       and d.status in ('pending', 'dispatching')
       and j.status = 'running'
       and j.attempts = ${reference.attempt}
       and j.lease_until > now()
       and app.inbound_endpoint_active(d.endpoint_id, d.tenant_id)
  `.execute(trx));
  return rows.rows[0];
}

export function resolveInboundOperationWork(
  db: OpenShapeForgeDatabase,
  /** The host keyring, read per call so a rotation needs no worker restart. */
  keyring: () => SecretKeyring | undefined =
  () => keyringFromEnv(process.env.OPENSHAPEFORGE_ELICITED_SECRET_KEYS),
) {
  return async function resolve(
    reference: RuntimeDurableWorkReference,
  ): Promise<RuntimeResolvedOperationWork | undefined> {
    if (!usable(reference)) return undefined;
    const row = await claimedDelivery(db, reference);
    if (!row) return undefined;
    // Throws rather than returning undefined: a payload that cannot be opened
    // is not an absent claim, and reporting it as one would settle the delivery
    // under a code that says the worker lost the work.
    const body = openInboundDeliveryBody(keyring(), row);
    return {
      tenantId: row.tenant_id,
      serviceIdentityId: row.service_identity_id,
      ...(row.contract_fingerprint ? { operationContractFingerprint: row.contract_fingerprint } : {}),
      // Dispatch facts ARE persisted here, so core reads uncertainty off the
      // row instead of inferring it from `attempt > 1`. An attempt is reported
      // only while it is on record as having STARTED a dispatch: a
      // `not-dispatched` mark proved nothing reached the Operation, so the next
      // attempt is not an uncertain repeat.
      dispatch: {
        tracked: true,
        ...(row.dispatch_state === "started" && row.dispatch_attempt !== null
          ? { attempt: row.dispatch_attempt } : {}),
      },
      operation: {
        id: row.operation_id,
        input: { [row.operation_input_field]: inboundDeliveryEnvelope(row, body) },
        idempotencyKey: row.idempotency_key,
      },
    };
  };
}

export function pinInboundOperationContract(db: OpenShapeForgeDatabase) {
  return async function pin(
    reference: RuntimeDurableWorkReference, fingerprint: string,
  ): Promise<void> {
    if (!usable(reference) || !/^sha256:[0-9a-f]{64}$/.test(fingerprint)) {
      throw new Error("An inbound dispatch contract pin needs a live claim and a well-formed fingerprint.");
    }
    // Pin ONCE: the update only fires while the column is still null, so a
    // reclaim can never replace the contract an earlier attempt was authorized
    // against. The read-back is what distinguishes "already pinned to the same
    // contract" (fine) from "pinned to another" (refused).
    await withJobWorkerSession(db, (trx) => sql`
      update platform.inbound_deliveries d
         set contract_fingerprint = ${fingerprint}, updated_at = now()
        from platform.jobs j
       where d.id = ${reference.workId}::uuid
         and j.id = d.dispatch_job_id
         and j.tenant_id = d.tenant_id
         and j.status = 'running'
         and j.attempts = ${reference.attempt}
         and j.lease_until > now()
         and app.inbound_endpoint_active(d.endpoint_id, d.tenant_id)
         and d.contract_fingerprint is null
    `.execute(trx));
    const row = await claimedDelivery(db, reference);
    if (!row) throw new Error("The inbound dispatch claim was lost while pinning its Operation contract.");
    if (row.contract_fingerprint !== fingerprint) {
      throw new Error("The inbound dispatch is already pinned to a different Operation contract.");
    }
  };
}

/**
 * The decision itself, as one transaction body: take the gate, then mark.
 *
 * Separated from its session wrapper the way `settleInboundDeliverySql` is, so
 * the serialization point has ONE definition and a regression test can place a
 * real revocation on either side of it rather than reproducing these statements.
 */
export async function markInboundDispatchInTransaction(
  trx: Transaction<DB>, reference: RuntimeDurableWorkReference, state: "started" | "not-dispatched",
): Promise<void> {
  // Guarded here rather than in the wrapper, so the seam is safe for whoever
  // runs it and the shape rule has one home.
  if (!usable(reference) || (state !== "started" && state !== "not-dispatched")) {
    throw new Error("An inbound dispatch mark needs a live claim and a known state.");
  }
  // The gate (modules/inbound-endpoint-gate.ts), first and before any row lock.
  // The pair is read off the delivery row this claim is already fenced to —
  // both columns are immutable for the life of the row — so the worker scopes
  // the lock without reading, or being granted, the registration it names. An
  // absent delivery takes no lock and matches no row below: the same refusal.
  const previousLockTimeout = await boundInboundEndpointGateWait(trx);
  await sql`
    select pg_advisory_xact_lock(${inboundEndpointGateKey(sql`d.tenant_id`, sql`d.endpoint_id`)})
      from platform.inbound_deliveries d
     where d.id = ${reference.workId}::uuid
  `.execute(trx);
  await restoreInboundEndpointGateWait(trx, previousLockTimeout);
  // Committed before the request leaves, so a crash between here and the
  // Operation leaves this attempt on record as having started one. Holding the
  // gate is what makes the predicate's own statement snapshot decisive: a
  // revocation either committed before this statement — and is therefore seen —
  // or cannot commit until this transaction has.
  const result = await sql`
    update platform.inbound_deliveries d
       set dispatch_state = ${state}, dispatch_attempt = ${reference.attempt},
           status = 'dispatching', updated_at = now()
      from platform.jobs j
     where d.id = ${reference.workId}::uuid
       and j.id = d.dispatch_job_id
       and j.tenant_id = d.tenant_id
       and j.status = 'running'
       and j.attempts = ${reference.attempt}
       and j.lease_until > now()
       and app.inbound_endpoint_active(d.endpoint_id, d.tenant_id)
       and d.status in ('pending', 'dispatching')
  `.execute(trx);
  if (Number(result.numAffectedRows ?? 0n) !== 1) {
    // Includes a revocation that landed since the resolve a moment ago, and a
    // revocation that won the gate while this attempt waited for it. The broker
    // turns this into "nothing was executed", which is true: the mark commits
    // BEFORE the request leaves, so a failed mark is a dispatch that never
    // started.
    throw new Error("The inbound dispatch claim was lost while recording its dispatch.");
  }
}

export function markInboundOperationDispatch(db: OpenShapeForgeDatabase) {
  return async function mark(
    reference: RuntimeDurableWorkReference, state: "started" | "not-dispatched",
  ): Promise<void> {
    await withJobWorkerSession(db, (trx) => markInboundDispatchInTransaction(trx, reference, state));
  };
}

export type InboundDeliverySettlement = "delivered" | "failed" | "outcome_unknown";

/**
 * The delivery's own terminal state, written in the handler's tenant
 * transaction so it commits together with the job's outcome.
 */
export const settleInboundDeliverySql = (
  deliveryId: string, state: InboundDeliverySettlement, error: Record<string, unknown> | null,
) => sql`
  update platform.inbound_deliveries
     set status = ${state}, completed_at = now(), updated_at = now(),
         last_error = ${jsonbLiteral(error)}
   where id = ${deliveryId}::uuid and completed_at is null
`;
