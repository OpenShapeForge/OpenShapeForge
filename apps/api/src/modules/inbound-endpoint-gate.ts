// SPDX-License-Identifier: BUSL-1.1
/**
 * The serialization point between revoking an inbound registration and the final
 * dispatch mark that authorizes a request under it.
 *
 * Two different connections, two different roles, two different tables decide
 * one question between them: may this attempt go out? The tenant's revocation
 * writes `platform.inbound_endpoints.status` under the app role; the worker's
 * `markOperationDispatch` reads that status through
 * `app.inbound_endpoint_active` and writes `platform.inbound_deliveries` under
 * the `job-worker` role (jobs/inbound/work.ts). Both statements are correct on
 * their own and neither can see the other's uncommitted work, so under READ
 * COMMITTED the mark's `UPDATE` can evaluate the liveness predicate in a
 * snapshot taken before a revocation commits, and still commit after it. That
 * ordering — revocation first in wall-clock terms, dispatch authorized anyway —
 * is the race this module exists to remove.
 *
 * ## What it is
 *
 * One transaction-scoped advisory lock per `(tenant, endpoint)` pair, taken as
 * the FIRST thing either path does and held until that path commits. The key is
 * `hashtextextended` over a versioned name — the pattern
 * `operations/execution-receipts.ts` and `platform/entity-change-stream.ts`
 * already use — so no object, grant or role contract changes to introduce it:
 * advisory locks live outside the catalog, which is precisely why the worker can
 * take one on a registration it may not read. Nothing here widens what either
 * role reaches, and nothing here CAN: `pg_advisory_xact_lock` and
 * `hashtextextended` are `pg_catalog` functions carrying the default `PUBLIC`
 * EXECUTE, which the restricted migrate role could not alter even if it wanted
 * to — so there is no grant to add and none to review. That both roles may take
 * the gate is established against a real database rather than assumed
 * (db/__tests__/inbound-deliveries.test.ts). The registration table stays
 * ungranted to the worker, the sealed provider secret stays unreachable, and
 * both paths still prove the tenant themselves: the revocation reads its
 * registration through the tenant policy
 * (`tenant_id = app.current_tenant()`), the mark reads the pair off the delivery
 * row it is already fenced to, and the liveness predicate remains
 * tenant-paired.
 *
 * ## Why that closes it
 *
 * Whoever holds the lock reaches its decision alone. A revocation can neither
 * begin nor commit its status write while a mark holds the lock, so a mark that
 * wins has already committed before any revocation is visible — and that attempt
 * is then explicitly in flight, which revocation has never claimed to retract. A
 * mark that waits acquires the lock only after the revocation commits, and its
 * `UPDATE` then takes a FRESH statement snapshot, which is what makes the
 * committed revocation visible to the predicate: no row matches, the mark fails,
 * and the broker reports that nothing was executed. There is no ordering left in
 * which a dispatch is authorized after a revocation that won.
 *
 * ## Deadlock, rollback and waiting
 *
 * Each path takes exactly ONE lock, takes it before any row lock, and takes it
 * on a key derived only from immutable columns — so there is no pair of
 * transactions that can hold what the other wants. The mark's own row work
 * cannot deadlock against a revocation either: it only ever READS
 * `platform.inbound_endpoints`, through the definer lookup, and an MVCC reader
 * does not block on a row lock.
 *
 * The lock is transaction-scoped, so a rollback, a failed statement, a killed
 * backend or a lost connection releases it with no cleanup path and no way to
 * strand a tenant's revocation behind a dead worker. It is never held across a
 * network call: each critical section is one `UPDATE` against one row, which is
 * also why the bounded wait below is orders of magnitude more headroom than
 * either side needs.
 *
 * Both sides bound the wait rather than queue indefinitely, and both fail
 * closed. A mark that times out authorizes no dispatch — the delivery stays
 * unsettled and its next attempt re-decides. A revocation that times out changes
 * nothing and is reported to the administrator, with the registration still
 * active: the same state as before the call, not a half-applied one.
 *
 * A hash collision between two unrelated pairs serializes work that did not need
 * serializing. It can never fail to serialize a pair with itself, and it grants
 * nothing — the same conservative direction `db/read-barrier.ts` states for its
 * own keys.
 */
import { sql, type RawBuilder, type Transaction } from "kysely";
import type { DB } from "../generated/db/types.js";

/**
 * Versioned, so a future change of what the gate covers is a different key
 * rather than a silently shared one.
 */
const GATE_NAME = "openshapeforge:inbound-endpoint-dispatch-gate:v1";

/**
 * How long either path may wait for the other's decision.
 *
 * The critical section it waits on is a single-row `UPDATE` with no network call
 * in it, so this is a safety bound against a pathologically stalled backend, not
 * a figure normal operation approaches. It stays below the default
 * `statement_timeout`, so the side that gives up reports the lock it could not
 * take rather than a generic cancelled statement.
 */
const GATE_WAIT = "5s";

/**
 * The advisory key for one `(tenant, endpoint)` pair, as a SQL expression.
 *
 * Both callers pass COLUMN references of the row they are already fenced to —
 * never a value from a request — so the key cannot be aimed at another tenant's
 * registration, and the two paths cannot drift into hashing different names.
 */
export function inboundEndpointGateKey(
  tenant: RawBuilder<unknown>, endpoint: RawBuilder<unknown>,
): RawBuilder<unknown> {
  // Every operand is cast, so the concatenation resolves on a bound parameter
  // instead of leaving `unknown || unknown` for Postgres to guess at.
  return sql`hashtextextended(
    ${GATE_NAME}::text || ':' || ${tenant}::text || ':' || ${endpoint}::text, 0)`;
}

/** Bound this transaction's wait for the gate. Transaction-local, so it ends with it. */
export async function boundInboundEndpointGateWait(trx: Transaction<DB>): Promise<void> {
  await sql`select set_config('lock_timeout', ${GATE_WAIT}, true)`.execute(trx);
}
