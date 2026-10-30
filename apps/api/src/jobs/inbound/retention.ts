// SPDX-License-Identifier: BUSL-1.1
/**
 * The bounded end of a retained inbound payload.
 *
 * A delivery receipt keeps the provider's exact bytes so a retry dispatches the
 * identical message. That is a real need and a real liability: the payload is
 * tenant data, routinely personal (a Jira issue carries names, e-mail
 * addresses and free text), and it stops being needed the moment the delivery
 * settles. Encrypting it answers "who can read this"; only removal answers "for
 * how long", so both are here and neither substitutes for the other.
 *
 * **Only a SETTLED delivery loses its payload here.** The 2xx this endpoint
 * returned to the provider was a durable acceptance: the provider will not send
 * these bytes again, and they are the only copy of the work still to be done.
 * Removing them from a delivery whose work has not settled would silently turn
 * pending work into work that can never be performed and never be replayed —
 * the acceptance would have been a lie, and nothing outside the database would
 * ever say so. Age is a reason to raise an alarm, not a reason to discard
 * accepted work.
 *
 * So the two windows do different things:
 *
 *  - **retention** — a settled delivery (`completed_at is not null`, which the
 *    status check in `db/migrations/inbound.ts` makes equivalent to a terminal
 *    status) loses its payload this many days after it settled. Zero is allowed
 *    and means "as soon as it settles"; retention exists so an operator can
 *    still inspect what a failed dispatch actually received.
 *  - **maximum age** — measured from arrival. For a settled delivery it is the
 *    outer bound on the same removal, so a long-settled receipt cannot outlive
 *    it on a misconfigured retention. For an UNSETTLED delivery it removes
 *    nothing: it is the age at which the payload is reported OVERDUE, because a
 *    delivery still pending this long after it was accepted — a dead job, a
 *    revoked endpoint, an Operation that was never authored — is a stuck
 *    pipeline an operator has to resolve, not data to drop.
 *
 * What survives a purge: everything that makes the receipt evidence.
 * `body_sha256` still says which bytes were accepted and verified, `body_bytes`
 * how large they were, and `body_purged_at` that the payload was removed rather
 * than never kept. `jobs/inbound/work.ts` refuses to dispatch a purged delivery
 * with `INBOUND_BODY_PURGED` instead of sending an empty body.
 *
 * **Not implemented here, and required before this is operationally complete:**
 * an alert on `overdue` reaching an operator (this module only reports the
 * count and the oldest arrival; the worker logs it), and admission-side
 * backpressure, so a pipeline that has stopped settling work refuses new
 * deliveries at the edge — where a provider still sees the refusal and retries
 * — rather than accumulating accepted payloads indefinitely. Until both exist,
 * unsettled payloads are retained without an upper bound by design, and the
 * overdue count is the only signal that this is happening.
 *
 * Each sweep is `limit`-bounded so one call cannot turn into an unbounded
 * update on a busy deployment; the worker calls it again on its next tick.
 */
import { sql, type Transaction } from "kysely";
import type { DB } from "../../generated/db/types.js";

/** Days a settled delivery keeps its payload for operator inspection. */
export const DEFAULT_INBOUND_BODY_RETENTION_DAYS = 7;
/** Outer bound on a settled payload, and the overdue age for a pending one. */
export const DEFAULT_INBOUND_BODY_MAX_AGE_DAYS = 30;
const DEFAULT_INBOUND_PURGE_LIMIT = 500;
/** Beyond this the bound stops being one; the configuration is clamped to it. */
export const MAX_INBOUND_BODY_MAX_AGE_DAYS = 365;

export type InboundBodyRetention = {
  retentionDays: number;
  maxAgeDays: number;
  limit?: number;
};

/** Unsettled deliveries still holding a payload past `maxAgeDays`. */
export type OverdueInboundBodies = {
  /** How many there are. Zero is the only healthy value. */
  count: number;
  /** Arrival of the oldest, so an operator sees how long this has been true. */
  oldestReceivedAt: Date | null;
};

/**
 * The configuration as the worker applies it: both windows clamped into a
 * range where they still mean something, and retention never longer than the
 * outer bound it sits inside.
 */
export function inboundBodyRetention(env: NodeJS.ProcessEnv = process.env): InboundBodyRetention {
  const days = (raw: string | undefined, fallback: number) => {
    const parsed = Number.parseInt(raw ?? "", 10);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
  };
  const maxAgeDays = Math.min(
    MAX_INBOUND_BODY_MAX_AGE_DAYS,
    Math.max(1, days(env.OPENSHAPEFORGE_INBOUND_BODY_MAX_AGE_DAYS, DEFAULT_INBOUND_BODY_MAX_AGE_DAYS)),
  );
  return {
    maxAgeDays,
    retentionDays: Math.min(
      maxAgeDays,
      days(env.OPENSHAPEFORGE_INBOUND_BODY_RETENTION_DAYS, DEFAULT_INBOUND_BODY_RETENTION_DAYS),
    ),
  };
}

/**
 * Remove up to `limit` retained payloads of SETTLED deliveries past either
 * bound; returns how many. An unsettled delivery is never touched, whatever
 * its age — see the module comment.
 */
export async function purgeInboundDeliveryBodies(
  trx: Transaction<DB>, retention: InboundBodyRetention,
): Promise<number> {
  const limit = Math.max(1, retention.limit ?? DEFAULT_INBOUND_PURGE_LIMIT);
  const result = await sql`
    update platform.inbound_deliveries
       set body_ciphertext = null, body_key_id = null, body_algorithm = null,
           body_purged_at = now(), updated_at = now()
     where id in (
       select id
         from platform.inbound_deliveries
        where body_ciphertext is not null
          and completed_at is not null
          and (
            completed_at < now() - (${retention.retentionDays} || ' days')::interval
            or received_at < now() - (${retention.maxAgeDays} || ' days')::interval
          )
        order by received_at
        limit ${limit}
       )
  `.execute(trx);
  return Number(result.numAffectedRows ?? 0n);
}

/**
 * The payloads the sweep deliberately did NOT remove: accepted work that has
 * not settled and is older than `maxAgeDays`. Reporting this is what keeps the
 * bound honest — the payload stays recoverable, and the fact that it had to
 * stay is visible rather than resolved by deletion.
 */
export async function overdueInboundDeliveryBodies(
  trx: Transaction<DB>, retention: InboundBodyRetention,
): Promise<OverdueInboundBodies> {
  const result = await sql<{ count: string; oldest: Date | string | null }>`
    select count(*)::text as count, min(received_at) as oldest
      from platform.inbound_deliveries
     where body_ciphertext is not null
       and completed_at is null
       and received_at < now() - (${retention.maxAgeDays} || ' days')::interval
  `.execute(trx);
  const row = result.rows[0];
  const oldest = row?.oldest ?? null;
  return {
    count: Number(row?.count ?? 0),
    oldestReceivedAt: oldest === null ? null : oldest instanceof Date ? oldest : new Date(oldest),
  };
}
