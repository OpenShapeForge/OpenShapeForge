// SPDX-License-Identifier: BUSL-1.1
/**
 * The editor lock on a workflow definition.
 *
 * Definitions are edited pessimistically — one writer at a time, claimed before
 * the editing starts — where the rest of the platform is optimistic. What
 * decides that is the cost of losing the race. Optimistic concurrency asks the
 * loser to reload and redo, which is the right trade when the unit of work is a
 * field and the redo is a keystroke. A designer session is not that shape: it
 * runs for minutes and holds a whole graph, so the loser does not retry an
 * edit, they lose all of them. Detecting the collision at save time is already
 * too late — by then the work that has to be thrown away exists. The second
 * editor has to be turned away before they start.
 *
 * ## The lock is a lease
 *
 * A lock without an expiry is a lock a closed laptop holds forever, and getting
 * out of that means an administrator with database access. So a lock is valid
 * for `WORKFLOW_DEFINITION_LOCK_TTL_MS` from acquisition, and the designer keeps
 * it alive by re-acquiring while the definition is open. Re-acquiring your own
 * lock is therefore the same call as taking it: refresh and first acquisition
 * are indistinguishable, and both are idempotent in effect.
 *
 * `steal` exists because a lease long enough to survive someone thinking is
 * also long enough to obstruct. It is the same upsert with the guard removed —
 * an explicit, recorded override, rather than an expiry short enough to make
 * every lock unreliable in order to make one lock less inconvenient.
 *
 * ## The clock is the database's
 *
 * A lease compared against a replica's own clock lasts however long that
 * replica's drift says it does, and two replicas disagreeing about whether a
 * lock is live is exactly the case the lock exists to prevent. So the write
 * path reads `now()` from the database once per transaction — `now()` is
 * transaction start time, so one read is the value every statement in that
 * transaction would have seen — and derives both the acquisition instant and
 * the expiry from it. Nothing here dates a lock from `Date.now()`.
 */
import { randomUUID } from "node:crypto";
import type { OpenShapeForgeDatabase } from "../../../../apps/api/src/db/connection.js";
import {
  withDbSession,
  type DbSessionContext,
  type DbSessionInput,
} from "../../../../apps/api/src/db/session.js";
import { timestampToIso } from "../../../../apps/api/src/db/timestamps.js";
import type { Json } from "../../../../apps/api/src/generated/db/types.js";
import { appendScopedEntityEventInTransaction } from "../../../../apps/api/src/platform/entity-events.js";
import { hasWorkflowWriterRole } from "./definition-authorization.js";
import {
  WorkflowDefinitionError,
  type WorkflowDefinitionLockRecord,
} from "./definition-types.js";

/** How long an acquired or refreshed lock stays valid. */
export const WORKFLOW_DEFINITION_LOCK_TTL_MS = 15 * 60_000;

/**
 * Lock transitions land on the definition's own event stream rather than one of
 * their own: "who had this open when it changed" is a question about the
 * definition, and answering it should not mean reading two streams and
 * interleaving them by timestamp.
 */
const LOCK_AGGREGATE_TYPE = "workflow.definition";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const LOCK_COLUMNS = [
  "definition_id",
  "lock_token",
  "owner_user_id",
  "acquired_at",
  "expires_at",
] as const;

/**
 * `Transaction<DB>`, taken from a function that already declares it.
 *
 * `kysely` is a dependency of `apps/api`, not of the repo root, so a bare
 * `import ... from "kysely"` inside `examples/` resolves from neither tsc nor
 * bun. Everything else this module needs from the query builder it gets from
 * the builder itself.
 */
type WorkflowTransaction = Parameters<typeof appendScopedEntityEventInTransaction>[0];

type WorkflowDefinitionLockRow = {
  definition_id: string;
  lock_token: string;
  owner_user_id: string;
  acquired_at: string;
  expires_at: string;
};

function normalizeUuid(value: string, label: string): string {
  const normalized = value.trim();
  if (!UUID_PATTERN.test(normalized)) {
    throw new WorkflowDefinitionError("BAD_USER_INPUT", `${label} must be a UUID.`);
  }
  return normalized;
}

function mapLock(row: WorkflowDefinitionLockRow): WorkflowDefinitionLockRecord {
  return {
    definitionId: row.definition_id,
    lockToken: row.lock_token,
    ownerUserId: row.owner_user_id,
    acquiredAt: timestampToIso(row.acquired_at),
    expiresAt: timestampToIso(row.expires_at),
  };
}

function requireWriterRole(session: DbSessionContext): void {
  if (!hasWorkflowWriterRole(session)) {
    throw new WorkflowDefinitionError(
      "FORBIDDEN",
      "Taking an editor lock on a workflow definition requires a workflow author role.",
    );
  }
}

async function appendLockEvent(
  trx: WorkflowTransaction,
  eventType: string,
  definitionId: string,
  payload: Json,
): Promise<void> {
  await appendScopedEntityEventInTransaction(trx, {
    aggregateType: LOCK_AGGREGATE_TYPE,
    aggregateId: definitionId,
    eventType,
    payload,
  });
}

/** The database's clock, as one instant for the whole transaction. */
async function readTransactionNow(trx: WorkflowTransaction): Promise<string> {
  const row = await trx
    .selectNoFrom((eb) => eb.fn<Date | string>("now").as("now"))
    .executeTakeFirstOrThrow();
  return timestampToIso(row.now);
}

/**
 * The upsert both `acquire` and `steal` issue. `override` drops the guard on
 * the update, which is the whole difference between taking a free lock and
 * taking someone else's.
 *
 * The guarded form yields no row when another user holds a live lock, because a
 * conflicting row that fails the `where` is neither updated nor returned. That
 * empty result is the signal; there is nothing else to interrogate.
 *
 * A refresh rotates `lock_token`, so a caller must keep the token it is handed
 * back — an earlier token from the same user stops being able to release. That
 * is deliberate: the token identifies a holding session, not a person.
 */
async function upsertDefinitionLock(
  trx: WorkflowTransaction,
  session: DbSessionContext,
  definitionId: string,
  override: boolean,
): Promise<WorkflowDefinitionLockRow | undefined> {
  const acquiredAt = await readTransactionNow(trx);
  const expiresAt = new Date(
    Date.parse(acquiredAt) + WORKFLOW_DEFINITION_LOCK_TTL_MS,
  ).toISOString();

  return trx
    .insertInto("workflow.definition_locks")
    .values({
      // The tenant is carried as a value rather than a predicate here, and it
      // is part of the unique index the upsert conflicts on, so the conflict
      // target cannot reach across tenants.
      tenant_id: session.tenantId,
      definition_id: definitionId,
      lock_token: randomUUID(),
      owner_user_id: session.userId,
      acquired_at: acquiredAt,
      expires_at: expiresAt,
    })
    .onConflict((oc) => {
      // The natural key is a unique index and not a composite primary key —
      // the table carries a surrogate `id` — so the conflict target is spelled
      // out as its columns.
      const update = oc.columns(["tenant_id", "definition_id"]).doUpdateSet((eb) => ({
        lock_token: eb.ref("excluded.lock_token"),
        owner_user_id: eb.ref("excluded.owner_user_id"),
        acquired_at: eb.ref("excluded.acquired_at"),
        expires_at: eb.ref("excluded.expires_at"),
      }));
      if (override) return update;
      return update.where((eb) =>
        eb.or([
          eb("workflow.definition_locks.expires_at", "<=", acquiredAt),
          eb(
            "workflow.definition_locks.owner_user_id",
            "=",
            eb.ref("excluded.owner_user_id"),
          ),
        ]),
      );
    })
    .returning(LOCK_COLUMNS)
    .executeTakeFirst();
}

/**
 * Take the lock, or refresh it when this user already holds it.
 *
 * Throws `LOCK_HELD` when someone else holds a live one. The owner is named in
 * the message because the only useful next step is to go and ask them.
 */
export async function acquireWorkflowDefinitionLock(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  definitionId: string,
): Promise<WorkflowDefinitionLockRecord> {
  const normalizedDefinitionId = normalizeUuid(definitionId, "definitionId");

  return withDbSession(db, session, async (trx, scopedSession) => {
    requireWriterRole(scopedSession);

    const row = await upsertDefinitionLock(trx, scopedSession, normalizedDefinitionId, false);
    if (!row) {
      // Only on the failure path, and only to name the owner. Folding it into
      // the upsert would take a CTE to return a row the upsert deliberately did
      // not produce, and this costs nothing whenever the lock is free. The
      // holder may have released between the two statements, hence the
      // fallback.
      const current = await trx
        .selectFrom("workflow.definition_locks")
        .select("owner_user_id")
        .where("tenant_id", "=", scopedSession.tenantId)
        .where("definition_id", "=", normalizedDefinitionId)
        .executeTakeFirst();
      throw new WorkflowDefinitionError(
        "LOCK_HELD",
        `Workflow definition ${normalizedDefinitionId} is locked by ${
          current?.owner_user_id ?? "another user"
        }.`,
      );
    }

    const lock = mapLock(row);
    await appendLockEvent(trx, "workflow.definition.lock_acquired", lock.definitionId, {
      definitionId: lock.definitionId,
      lockToken: lock.lockToken,
      ownerUserId: lock.ownerUserId,
      expiresAt: lock.expiresAt,
    });
    return lock;
  });
}

/**
 * Take the lock regardless of who holds it.
 *
 * No `LOCK_HELD` path: overriding is the point, and the event is what makes the
 * override accountable rather than silent.
 */
export async function stealWorkflowDefinitionLock(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  definitionId: string,
): Promise<WorkflowDefinitionLockRecord> {
  const normalizedDefinitionId = normalizeUuid(definitionId, "definitionId");

  return withDbSession(db, session, async (trx, scopedSession) => {
    requireWriterRole(scopedSession);

    const row = await upsertDefinitionLock(trx, scopedSession, normalizedDefinitionId, true);
    if (!row) {
      // Unreachable: an unguarded upsert either inserts or updates. Asserting
      // that beats assembling a record out of nothing.
      throw new WorkflowDefinitionError(
        "CONFLICT",
        `Workflow definition ${normalizedDefinitionId} lock could not be written.`,
      );
    }

    const lock = mapLock(row);
    await appendLockEvent(trx, "workflow.definition.lock_stolen", lock.definitionId, {
      definitionId: lock.definitionId,
      lockToken: lock.lockToken,
      ownerUserId: lock.ownerUserId,
      expiresAt: lock.expiresAt,
    });
    return lock;
  });
}

/**
 * Release the lock, if this token still holds it.
 *
 * The token is the authority, which is why there is no role check: releasing
 * takes nothing from anyone, and a user whose role was revoked mid-session
 * should still be able to hand the definition back.
 *
 * A token that no longer matches returns false rather than throwing. The caller
 * is usually a tab closing, and a mismatch means the lease lapsed and someone
 * else has since taken it — a fact about the world, not a fault in the request.
 * Failing loudly would turn a benign race into an error nobody can act on.
 */
export async function releaseWorkflowDefinitionLock(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  definitionId: string,
  lockToken: string,
): Promise<boolean> {
  const normalizedDefinitionId = normalizeUuid(definitionId, "definitionId");
  const normalizedLockToken = normalizeUuid(lockToken, "lockToken");

  return withDbSession(db, session, async (trx, scopedSession) => {
    const result = await trx
      .deleteFrom("workflow.definition_locks")
      .where("tenant_id", "=", scopedSession.tenantId)
      .where("definition_id", "=", normalizedDefinitionId)
      .where("lock_token", "=", normalizedLockToken)
      .executeTakeFirst();

    if (result.numDeletedRows === 0n) return false;

    await appendLockEvent(trx, "workflow.definition.lock_released", normalizedDefinitionId, {
      definitionId: normalizedDefinitionId,
      lockToken: normalizedLockToken,
    });
    return true;
  });
}

/**
 * The live lock, or null.
 *
 * An expired row is not a lock, so it reads as null rather than as a record the
 * caller has to check the expiry of itself — every caller asking "is this
 * locked" would otherwise reimplement the same comparison, and one of them
 * would reach for the wrong clock. Reading is not gated on the writer role:
 * seeing that a definition is busy is not editing it.
 */
export async function getWorkflowDefinitionLock(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  definitionId: string,
): Promise<WorkflowDefinitionLockRecord | null> {
  const normalizedDefinitionId = normalizeUuid(definitionId, "definitionId");

  return withDbSession(db, session, async (trx, scopedSession) => {
    const row = await trx
      .selectFrom("workflow.definition_locks")
      .select(LOCK_COLUMNS)
      .where("tenant_id", "=", scopedSession.tenantId)
      .where("definition_id", "=", normalizedDefinitionId)
      // Nothing to derive on a read, so the comparison is made where the clock
      // lives instead of costing a round trip to fetch it.
      .where((eb) => eb("expires_at", ">", eb.fn<string>("now")))
      .executeTakeFirst();
    return row ? mapLock(row) : null;
  });
}
