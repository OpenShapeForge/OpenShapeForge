// SPDX-License-Identifier: BUSL-1.1
/**
 * The capability grant store: issue, revoke, list and purge rows of
 * `platform.capability_grants`, always inside a tenant-fenced transaction the
 * caller opened. Resolving a presented token into a grant session lives in
 * capability-grant-resolution.ts; the token format and hashing they share is
 * in capability-grant-token.ts.
 *
 * Nothing here returns a token hash. The token itself exists exactly once, in
 * the return value of `issueCapabilityGrantInTransaction`.
 */
import { randomUUID } from "node:crypto";
import { sql, type Transaction } from "kysely";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import type { DB, Json } from "../generated/db/types.js";
import type { DbSessionInput } from "../db/session.js";
import { withDbSession } from "../db/session.js";
import { appendScopedEntityEventInTransaction } from "../platform/entity-events.js";
import type {
  RuntimeCapabilityGrantIssueInput,
  RuntimeCapabilityGrantIssued,
  RuntimeCapabilityGrantRecipient,
  RuntimeCapabilityGrantSummary,
  RuntimeCapabilityGrantStatus,
} from "@openshapeforge/plugin-runtime";
import { hashGrantSecret, mintGrantSecret, renderGrantToken } from "./capability-grant-token.js";
import rawCatalog from "../generated/operations/catalog.json" with { type: "json" };

let capabilityOperationCache: ReadonlySet<string> | undefined;

/** Canonical keys of every `auth.mode: capability` Operation in the generated catalog. */
export function generatedCapabilityOperations(): ReadonlySet<string> {
  if (!capabilityOperationCache) {
    const operations = (rawCatalog as { operations?: { key: string; auth: { mode: string } }[] }).operations ?? [];
    capabilityOperationCache = new Set(
      operations.filter((operation) => operation.auth.mode === "capability").map((operation) => operation.key),
    );
  }
  return capabilityOperationCache;
}

export const CAPABILITY_GRANT_AGGREGATE = "capability_grant";

/** Row shape as read back from platform.capability_grants. */
export type CapabilityGrantRow = {
  id: string;
  tenant_id: string;
  token_hash: string;
  operations: string[];
  subject_entity: string;
  subject_id: string;
  recipient: RuntimeCapabilityGrantRecipient;
  issued_by: string;
  issued_at: Date | string;
  expires_at: Date | string;
  max_uses: number | null;
  uses: number;
  consumed_at: Date | string | null;
  revoked_at: Date | string | null;
  revoked_reason: string | null;
  superseded_by: string | null;
  failed_attempts: number;
  window_started_at: Date | string | null;
  locked_until: Date | string | null;
};

const SUMMARY_COLUMNS = sql.raw(
  "id, tenant_id, operations, subject_entity, subject_id, recipient, issued_by, issued_at, " +
    "expires_at, max_uses, uses, consumed_at, revoked_at, revoked_reason, superseded_by, " +
    "failed_attempts, window_started_at, locked_until",
);

const MAX_RECIPIENT_JSON_BYTES = 2048;
const MAX_REASON_LENGTH = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function iso(value: Date | string): string {
  return new Date(value).toISOString();
}

function isoOrNull(value: Date | string | null): string | null {
  return value === null ? null : iso(value);
}

/** Lifecycle as of `now`; revoked wins over consumed wins over expired. */
export function capabilityGrantStatus(
  row: Pick<CapabilityGrantRow, "expires_at" | "max_uses" | "uses" | "consumed_at" | "revoked_at">,
  now: Date = new Date(),
): RuntimeCapabilityGrantStatus {
  if (row.revoked_at !== null) return "revoked";
  if (row.consumed_at !== null || (row.max_uses !== null && row.uses >= row.max_uses)) return "consumed";
  if (new Date(row.expires_at).getTime() <= now.getTime()) return "expired";
  return "active";
}

export function summarizeCapabilityGrant(
  row: Omit<CapabilityGrantRow, "token_hash">,
  now: Date = new Date(),
): RuntimeCapabilityGrantSummary {
  return {
    id: row.id,
    subjectEntity: row.subject_entity,
    subjectId: row.subject_id,
    recipient: row.recipient,
    operations: [...row.operations],
    issuedBy: row.issued_by,
    issuedAt: iso(row.issued_at),
    expiresAt: iso(row.expires_at),
    maxUses: row.max_uses,
    uses: row.uses,
    consumedAt: isoOrNull(row.consumed_at),
    revokedAt: isoOrNull(row.revoked_at),
    revokedReason: row.revoked_reason,
    supersededBy: row.superseded_by,
    lockedUntil: isoOrNull(row.locked_until),
    status: capabilityGrantStatus(row, now),
  };
}

export function validateGrantRecipient(recipient: unknown): RuntimeCapabilityGrantRecipient {
  if (!recipient || typeof recipient !== "object" || Array.isArray(recipient)) {
    throw new Error("A capability grant recipient must be an object with a kind.");
  }
  const kind = (recipient as { kind?: unknown }).kind;
  if (typeof kind !== "string" || kind.trim() === "") {
    throw new Error("A capability grant recipient must carry a non-empty kind.");
  }
  const serialized = JSON.stringify(recipient);
  if (Buffer.byteLength(serialized, "utf8") > MAX_RECIPIENT_JSON_BYTES) {
    throw new Error(`A capability grant recipient must serialize to at most ${MAX_RECIPIENT_JSON_BYTES} bytes.`);
  }
  return JSON.parse(serialized) as RuntimeCapabilityGrantRecipient;
}

export type IssueCapabilityGrantOptions = {
  /** Canonical keys of every `auth.mode: capability` Operation the host knows. */
  capabilityOperations: ReadonlySet<string>;
  now?: Date;
};

/**
 * Issue a grant. The caller's session is the issuer: its tenant fences the
 * row and its user id is recorded as `issued_by`. Validation errors are plain
 * errors — a plugin passes authored configuration here, not client input.
 */
export async function issueCapabilityGrantInTransaction(
  trx: Transaction<DB>,
  session: DbSessionInput,
  input: RuntimeCapabilityGrantIssueInput,
  options: IssueCapabilityGrantOptions,
): Promise<RuntimeCapabilityGrantIssued> {
  if (!session.tenantId || !session.userId) {
    throw new Error("Issuing a capability grant requires a tenant session with a user.");
  }
  const operations = [...new Set(input.operations)];
  if (operations.length === 0) throw new Error("A capability grant must name at least one Operation.");
  for (const key of operations) {
    if (!options.capabilityOperations.has(key)) {
      throw new Error(`Operation "${key}" is not an auth.mode: capability Operation and cannot be granted.`);
    }
  }
  if (typeof input.subject?.entity !== "string" || input.subject.entity.trim() === "") {
    throw new Error("A capability grant subject must name an entity.");
  }
  if (typeof input.subject.id !== "string" || !UUID.test(input.subject.id)) {
    throw new Error("A capability grant subject id must be a UUID.");
  }
  const recipient = validateGrantRecipient(input.recipient);
  const now = options.now ?? new Date();
  const expiresAt = new Date(input.expiresAt);
  if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= now.getTime()) {
    throw new Error("A capability grant must expire in the future.");
  }
  const maxUses = input.maxUses ?? null;
  if (maxUses !== null && (!Number.isInteger(maxUses) || maxUses < 1)) {
    throw new Error("A capability grant maxUses must be a positive integer or null.");
  }
  const id = randomUUID();
  const secret = mintGrantSecret();
  if (input.supersede === "same-subject-and-recipient") {
    const superseded = await sql<{ id: string }>`
      update platform.capability_grants
         set revoked_at = ${now}, revoked_reason = 'superseded', superseded_by = ${id}
       where subject_entity = ${input.subject.entity}
         and subject_id = ${input.subject.id}
         and recipient = ${JSON.stringify(recipient)}::jsonb
         and revoked_at is null
         and consumed_at is null
         and expires_at > ${now}
       returning id
    `.execute(trx);
    for (const row of superseded.rows) {
      await appendScopedEntityEventInTransaction(trx, {
        aggregateType: CAPABILITY_GRANT_AGGREGATE,
        aggregateId: row.id,
        eventType: "capability_grant_revoked",
        payload: { reason: "superseded", supersededBy: id },
      });
    }
  }
  await sql`
    insert into platform.capability_grants
      (id, tenant_id, token_hash, operations, subject_entity, subject_id, recipient,
       issued_by, issued_at, expires_at, max_uses)
    values
      (${id}, ${session.tenantId}, ${hashGrantSecret(secret)}, ${sql.val(operations)}::text[],
       ${input.subject.entity}, ${input.subject.id}, ${JSON.stringify(recipient)}::jsonb,
       ${session.userId}, ${now}, ${expiresAt}, ${maxUses})
  `.execute(trx);
  await appendScopedEntityEventInTransaction(trx, {
    aggregateType: CAPABILITY_GRANT_AGGREGATE,
    aggregateId: id,
    eventType: "capability_grant_issued",
    payload: {
      subject: { entity: input.subject.entity, id: input.subject.id },
      recipient: recipient as Json,
      operations,
      expiresAt: expiresAt.toISOString(),
      maxUses,
      supersede: input.supersede ?? null,
    },
  });
  return { id, token: renderGrantToken(id, secret), expiresAt: expiresAt.toISOString() };
}

export async function readCapabilityGrantInTransaction(
  trx: Transaction<DB>,
  id: string,
): Promise<Omit<CapabilityGrantRow, "token_hash"> | undefined> {
  if (!UUID.test(id)) return undefined;
  const result = await sql<Omit<CapabilityGrantRow, "token_hash">>`
    select ${SUMMARY_COLUMNS} from platform.capability_grants where id = ${id}
  `.execute(trx);
  return result.rows[0];
}

/** Revoke; idempotent on an inactive grant. Returns undefined when the id is unknown here. */
export async function revokeCapabilityGrantInTransaction(
  trx: Transaction<DB>,
  input: { id: string; reason?: string },
  now: Date = new Date(),
): Promise<RuntimeCapabilityGrantSummary | undefined> {
  const reason = input.reason?.trim() || null;
  if (reason && reason.length > MAX_REASON_LENGTH) {
    throw new Error(`A revocation reason is at most ${MAX_REASON_LENGTH} characters.`);
  }
  const current = await readCapabilityGrantInTransaction(trx, input.id);
  if (!current) return undefined;
  if (capabilityGrantStatus(current, now) !== "active") return summarizeCapabilityGrant(current, now);
  const updated = await sql<Omit<CapabilityGrantRow, "token_hash">>`
    update platform.capability_grants
       set revoked_at = ${now}, revoked_reason = ${reason}
     where id = ${input.id} and revoked_at is null
     returning ${SUMMARY_COLUMNS}
  `.execute(trx);
  const row = updated.rows[0] ?? current;
  await appendScopedEntityEventInTransaction(trx, {
    aggregateType: CAPABILITY_GRANT_AGGREGATE,
    aggregateId: input.id,
    eventType: "capability_grant_revoked",
    payload: { reason },
  });
  return summarizeCapabilityGrant(row, now);
}

export async function listCapabilityGrantsInTransaction(
  trx: Transaction<DB>,
  subject: { entity: string; id: string },
  now: Date = new Date(),
): Promise<RuntimeCapabilityGrantSummary[]> {
  if (!UUID.test(subject.id)) return [];
  const result = await sql<Omit<CapabilityGrantRow, "token_hash">>`
    select ${SUMMARY_COLUMNS}
      from platform.capability_grants
     where subject_entity = ${subject.entity} and subject_id = ${subject.id}
     order by issued_at desc, id
  `.execute(trx);
  return result.rows.map((row) => summarizeCapabilityGrant(row, now));
}

export const DEFAULT_CAPABILITY_GRANT_RETENTION_DAYS = 30;

/**
 * Housekeeping: remove grants that expired or were revoked more than
 * `retainDays` ago. Inert rows are refused by the resolver already, so this
 * is hygiene — and the audit trail stays in platform.entity_events. There is
 * no scheduler in the API; see docs/retention.md.
 */
export async function purgeCapabilityGrants(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  options: { retainDays?: number; now?: Date } = {},
): Promise<number> {
  const retainDays = options.retainDays ?? DEFAULT_CAPABILITY_GRANT_RETENTION_DAYS;
  if (!Number.isInteger(retainDays) || retainDays < 0) throw new Error("retainDays must be a non-negative integer.");
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - retainDays * 24 * 60 * 60 * 1000);
  return withDbSession(db, session, async (trx) => {
    const result = await sql<{ id: string }>`
      delete from platform.capability_grants
       where expires_at < ${cutoff}
          or revoked_at < ${cutoff}
       returning id
    `.execute(trx);
    return result.rows.length;
  });
}
