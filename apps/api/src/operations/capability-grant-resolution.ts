// SPDX-License-Identifier: BUSL-1.1
/**
 * Turning a presented capability grant token into a grant session, and
 * consuming the grant in the handler's transaction.
 *
 * Resolution runs in its own transaction BEFORE the Operation, and commits
 * whatever it learned about the attempt — a wrong secret counts even though
 * the request is refused. Consumption runs INSIDE the Operation transaction,
 * so a handler that fails leaves the grant usable, and a single-use grant
 * that succeeded can never be replayed.
 *
 * Refusals are `HttpError`s with the status-and-code pairs the compiler
 * appended to every capability Operation (`CAPABILITY_GRANT_ERRORS`).
 */
import { sql, type Kysely, type Transaction } from "kysely";
import type { DB } from "../generated/db/types.js";
import { withDbSession, type DbSessionInput } from "../db/session.js";
import { HttpError } from "../rest/http-error.js";
import type { CapabilityGrantSession, TrustedSessionContext } from "../auth/trusted-context.js";
import { appendScopedEntityEventInTransaction } from "../platform/entity-events.js";
import {
  CAPABILITY_GRANT_AGGREGATE,
  capabilityGrantStatus,
  type CapabilityGrantRow,
} from "./capability-grants.js";
import {
  DECOY_GRANT_HASH,
  grantSecretMatches,
  parseGrantToken,
} from "./capability-grant-token.js";

/**
 * Global attempt policy: a grant locks for `lockMs` once `maxFailedAttempts`
 * wrong secrets land inside one `windowMs` window. A correct secret resets
 * the window. Per-grant policies are deliberately absent until a consumer
 * needs one; these are the values a signing link is comfortable with.
 */
export const CAPABILITY_GRANT_ATTEMPT_POLICY = Object.freeze({
  maxFailedAttempts: 5,
  windowMs: 15 * 60 * 1000,
  lockMs: 15 * 60 * 1000,
});

export type CapabilityGrantRefusalCode =
  | "GRANT_INVALID"
  | "GRANT_SCOPE"
  | "GRANT_CONSUMED"
  | "GRANT_EXPIRED"
  | "GRANT_REVOKED"
  | "GRANT_LOCKED";

const REFUSALS: Record<CapabilityGrantRefusalCode, { status: number; message: string }> = {
  GRANT_INVALID: { status: 401, message: "The grant token is not valid." },
  GRANT_SCOPE: { status: 403, message: "The grant does not cover this Operation." },
  GRANT_CONSUMED: { status: 409, message: "The grant has already been used." },
  GRANT_EXPIRED: { status: 410, message: "The grant has expired." },
  GRANT_REVOKED: { status: 410, message: "The grant was revoked." },
  GRANT_LOCKED: { status: 423, message: "Too many failed attempts; the grant is temporarily locked." },
};

export function capabilityGrantRefusal(code: CapabilityGrantRefusalCode): HttpError {
  return new HttpError(REFUSALS[code].status, code, REFUSALS[code].message);
}

export type CapabilityOperationShape = {
  key: string;
  target?: { entityName: string };
};

function grantDbSession(tenantId: string, grantId: string): DbSessionInput {
  return { tenantId, userId: grantId, roles: [], groups: [], relationGroupIds: [], scope: "self" };
}

export function capabilityGrantSessionFromRow(
  row: Pick<
    CapabilityGrantRow,
    "id" | "tenant_id" | "subject_entity" | "subject_id" | "recipient" | "operations" | "expires_at" | "max_uses"
  >,
): TrustedSessionContext {
  const grant: CapabilityGrantSession = Object.freeze({
    id: row.id,
    subject: Object.freeze({ entity: row.subject_entity, id: row.subject_id }),
    recipient: Object.freeze(structuredClone(row.recipient)),
    operations: Object.freeze([...row.operations]),
    expiresAt: new Date(row.expires_at).toISOString(),
    maxUses: row.max_uses,
  });
  return {
    tenantId: row.tenant_id,
    userId: row.id,
    roles: [],
    groups: [],
    relationGroupIds: [],
    scope: "self",
    credential: "grant",
    grant,
  };
}

type Resolution =
  | { session: TrustedSessionContext }
  | { refusal: CapabilityGrantRefusalCode };

function statusRefusal(row: CapabilityGrantRow, now: Date): CapabilityGrantRefusalCode | undefined {
  switch (capabilityGrantStatus(row, now)) {
    case "revoked": return "GRANT_REVOKED";
    case "consumed": return "GRANT_CONSUMED";
    case "expired": return "GRANT_EXPIRED";
    default: return undefined;
  }
}

async function recordFailedAttempt(
  trx: Transaction<DB>,
  row: CapabilityGrantRow,
  now: Date,
): Promise<CapabilityGrantRefusalCode> {
  const policy = CAPABILITY_GRANT_ATTEMPT_POLICY;
  const windowStart = row.window_started_at ? new Date(row.window_started_at).getTime() : undefined;
  const inWindow = windowStart !== undefined && now.getTime() - windowStart < policy.windowMs;
  const attempts = inWindow ? row.failed_attempts + 1 : 1;
  const locked = attempts >= policy.maxFailedAttempts;
  const lockedUntil = locked ? new Date(now.getTime() + policy.lockMs) : null;
  await sql`
    update platform.capability_grants
       set failed_attempts = ${attempts},
           window_started_at = ${inWindow ? new Date(windowStart!) : now},
           locked_until = ${lockedUntil}
     where id = ${row.id}
  `.execute(trx);
  if (locked) {
    await appendScopedEntityEventInTransaction(trx, {
      aggregateType: CAPABILITY_GRANT_AGGREGATE,
      aggregateId: row.id,
      eventType: "capability_grant_locked",
      payload: { failedAttempts: attempts, lockedUntil: lockedUntil!.toISOString() },
    });
    return "GRANT_LOCKED";
  }
  return "GRANT_INVALID";
}

/**
 * Resolve a token for one Operation. Every refusal is an `HttpError`; the
 * attempt bookkeeping it caused is already committed when it is thrown.
 */
export async function resolveCapabilityGrantSession(
  db: Kysely<DB>,
  token: string | undefined,
  operation: CapabilityOperationShape,
  now: Date = new Date(),
): Promise<TrustedSessionContext> {
  const parsed = token === undefined ? undefined : parseGrantToken(token);
  if (!parsed) {
    grantSecretMatches("", DECOY_GRANT_HASH);
    throw capabilityGrantRefusal("GRANT_INVALID");
  }
  const tenant = await sql<{ tenant_id: string | null }>`
    select app.capability_grant_tenant(${parsed.id}::uuid) as tenant_id
  `.execute(db);
  const tenantId = tenant.rows[0]?.tenant_id ?? null;
  if (!tenantId) {
    grantSecretMatches(parsed.secret, DECOY_GRANT_HASH);
    throw capabilityGrantRefusal("GRANT_INVALID");
  }
  const outcome = await withDbSession(db, grantDbSession(tenantId, parsed.id), async (trx): Promise<Resolution> => {
    const result = await sql<CapabilityGrantRow>`
      select * from platform.capability_grants where id = ${parsed.id} for update
    `.execute(trx);
    const row = result.rows[0];
    if (!row) {
      grantSecretMatches(parsed.secret, DECOY_GRANT_HASH);
      return { refusal: "GRANT_INVALID" };
    }
    if (row.locked_until && new Date(row.locked_until).getTime() > now.getTime()) {
      // Locked means locked: the secret is not even compared, so a lock
      // cannot be used as an oracle either way.
      return { refusal: "GRANT_LOCKED" };
    }
    if (!grantSecretMatches(parsed.secret, row.token_hash)) {
      return { refusal: await recordFailedAttempt(trx, row, now) };
    }
    if (row.failed_attempts > 0 || row.locked_until) {
      await sql`
        update platform.capability_grants
           set failed_attempts = 0, window_started_at = null, locked_until = null
         where id = ${row.id}
      `.execute(trx);
    }
    const refusal = statusRefusal(row, now);
    if (refusal) return { refusal };
    if (!row.operations.includes(operation.key)) return { refusal: "GRANT_SCOPE" };
    if (operation.target && operation.target.entityName !== row.subject_entity) {
      return { refusal: "GRANT_SCOPE" };
    }
    return { session: capabilityGrantSessionFromRow(row) };
  });
  if ("refusal" in outcome) throw capabilityGrantRefusal(outcome.refusal);
  return outcome.session;
}

/**
 * Count one use inside the Operation transaction; the row is re-checked so a
 * grant revoked or consumed between resolution and execution still refuses.
 */
export async function consumeCapabilityGrantInTransaction(
  trx: Transaction<DB>,
  session: TrustedSessionContext,
  operationKey: string,
  now: Date = new Date(),
): Promise<{ uses: number; consumed: boolean }> {
  const grant = session.grant;
  if (session.credential !== "grant" || !grant) {
    throw new Error("Consuming a capability grant requires a grant session.");
  }
  const updated = await sql<{ uses: number; consumed_at: Date | string | null }>`
    update platform.capability_grants
       set uses = uses + 1,
           consumed_at = case
             when max_uses is not null and uses + 1 >= max_uses then ${now}
             else consumed_at
           end
     where id = ${grant.id}
       and revoked_at is null
       and consumed_at is null
       and (max_uses is null or uses < max_uses)
       and expires_at > ${now}
       and (locked_until is null or locked_until <= ${now})
     returning uses, consumed_at
  `.execute(trx);
  const row = updated.rows[0];
  if (!row) {
    const current = await sql<CapabilityGrantRow>`
      select * from platform.capability_grants where id = ${grant.id}
    `.execute(trx);
    const state = current.rows[0];
    if (!state) throw capabilityGrantRefusal("GRANT_INVALID");
    if (state.locked_until && new Date(state.locked_until).getTime() > now.getTime()) {
      throw capabilityGrantRefusal("GRANT_LOCKED");
    }
    throw capabilityGrantRefusal(statusRefusal(state, now) ?? "GRANT_INVALID");
  }
  const consumed = row.consumed_at !== null;
  await appendScopedEntityEventInTransaction(trx, {
    aggregateType: CAPABILITY_GRANT_AGGREGATE,
    aggregateId: grant.id,
    eventType: "capability_grant_used",
    payload: { operation: operationKey, uses: row.uses, consumed },
  });
  return { uses: row.uses, consumed };
}
