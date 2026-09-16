// SPDX-License-Identifier: BUSL-1.1
/** Central edit-lease service for generated entity Operations. */
import { createHash, randomBytes } from "node:crypto";
import { sql, type Transaction } from "kysely";
import { operationFailure, type OperationError } from "@openshapeforge/operations";
import type { OpenShapeForgeDatabase } from "../../db/connection.js";
import type { DB } from "../../generated/db/types.js";
import {
  createDbSessionContext,
  withDbSession,
  type DbSessionContext,
  type DbSessionInput,
} from "../../db/session.js";
import { normalizeTimestampToken } from "../../db/timestamps.js";
import { appendScopedEntityEventInTransaction } from "../../platform/entity-events.js";
import { fieldNameForColumn } from "./columns.js";
import type { GeneratedCrudTable } from "./types.js";

export type EditLeaseRequirement = {
  mode: "required";
  expiresAfterInactivity: string;
};

export type VersionRequirement = {
  mode: "required";
  field: string;
};

export type LeaseProtectedOperation = {
  id: string;
  entityId: string;
  entityName: string;
  intent: "update" | "delete" | "invoke";
  concurrency?: {
    version?: VersionRequirement;
    editLease?: EditLeaseRequirement;
  };
};

export type EntityEditLease = {
  leaseToken: string;
  operationId: string;
  entityId: string;
  targetId: string;
  targetVersion: string;
  expiresAt: string;
};

type LeaseRow = {
  id: string;
  entity_id: string;
  target_id: string;
  operation_id: string;
  owner_user_id: string;
  owner_display_name: string | null;
  acquired_version: string;
  inactivity_timeout_seconds: number;
  expires_at: Date | string;
};

type HeldLeaseRow = LeaseRow & { token_hash: string };

function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function mintToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Deliberately accepts only exact day/time durations; months and years are not fixed lengths. */
export function fixedDurationSeconds(value: string): number {
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value);
  if (!match) throw new Error(`Duration ${JSON.stringify(value)} must use fixed ISO-8601 days/time.`);
  const seconds =
    Number(match[1] ?? 0) * 86_400 +
    Number(match[2] ?? 0) * 3_600 +
    Number(match[3] ?? 0) * 60 +
    Number(match[4] ?? 0);
  if (!Number.isSafeInteger(seconds) || seconds < 30 || seconds > 86_400) {
    throw new Error("Edit-lease inactivity duration must be between PT30S and P1D.");
  }
  return seconds;
}

function versionColumn(
  table: GeneratedCrudTable,
  requirement: VersionRequirement,
) {
  const column = table.columns.find(
    (candidate) => fieldNameForColumn(candidate) === requirement.field,
  );
  if (!column || column.type !== "timestamptz") {
    throw operationFailure({
      code: "INTERNAL_SERVER_ERROR",
      message: "The operation's version contract is not available.",
    });
  }
  return column;
}

async function currentVersionInTransaction(
  trx: Transaction<DB>,
  session: DbSessionContext,
  table: GeneratedCrudTable,
  targetId: string,
  requirement: VersionRequirement,
): Promise<string | null> {
  const column = versionColumn(table, requirement);
  const tenantWhere = table.tenantScoped
    ? sql`and ${sql.id("tenant_id")} = ${session.tenantId}::uuid`
    : sql``;
  const result = await sql<{ version: string }>`
    select ${sql.id(column.name)}::text as version
    from ${sql.id(table.schema, table.table)}
    where ${sql.id(table.primaryKey!)}::text = ${targetId}
      ${tenantWhere}
  `.execute(trx);
  const version = result.rows[0]?.version;
  return version === undefined ? null : normalizeTimestampToken(String(version));
}

/**
 * Lock a custom Operation's target row and prove its canonical version before
 * any plugin write runs in the same transaction.
 */
export async function validateEntityVersionInTransaction(
  trx: Transaction<DB>,
  sessionInput: DbSessionInput,
  input: {
    operation: LeaseProtectedOperation;
    table: GeneratedCrudTable;
    targetId: string;
    expectedVersion: string;
  },
): Promise<void> {
  const requirement = input.operation.concurrency?.version;
  if (!requirement) {
    throw operationFailure({
      code: "INTERNAL_SERVER_ERROR",
      message: "The operation's version contract is not available.",
    });
  }
  const session = createDbSessionContext(sessionInput);
  const column = versionColumn(input.table, requirement);
  const tenantWhere = input.table.tenantScoped
    ? sql`and ${sql.id("tenant_id")} = ${session.tenantId}::uuid`
    : sql``;
  const result = await sql<{ version: string }>`
    select ${sql.id(column.name)}::text as version
    from ${sql.id(input.table.schema, input.table.table)}
    where ${sql.id(input.table.primaryKey!)}::text = ${input.targetId}
      ${tenantWhere}
    for update
  `.execute(trx);
  const current = result.rows[0]?.version;
  if (current === undefined) {
    throw operationFailure({ code: "NOT_FOUND", message: "Resource not found." });
  }
  if (
    normalizeTimestampToken(String(current)) !==
      normalizeTimestampToken(input.expectedVersion)
  ) {
    throw operationFailure({
      code: "VERSION_CONFLICT",
      message: "The record has changed since it was loaded.",
      detail: "Reload the record before trying again.",
    });
  }
}

function lockedError(row: LeaseRow): OperationError {
  const owner = row.owner_display_name?.trim() || "another user";
  const expiresAt = new Date(row.expires_at).toISOString();
  return {
    code: "LOCKED",
    message: `This record is currently being edited by ${owner}.`,
    detail: `Their edit lease remains valid until ${expiresAt}.`,
    retryable: true,
    retryAt: expiresAt,
    data: { ownerDisplayName: owner },
  };
}

export async function editLeaseErrorsByTarget(
  db: OpenShapeForgeDatabase,
  sessionInput: DbSessionInput,
  input: { entityId: string; targetIds: readonly string[] },
): Promise<ReadonlyMap<string, OperationError>> {
  const targetIds = [...new Set(input.targetIds.filter(Boolean))];
  if (targetIds.length === 0) return new Map();
  return withDbSession(db, sessionInput, async (trx, session) => {
    const result = await sql<LeaseRow>`
      select id, entity_id, target_id, operation_id, owner_user_id,
             owner_display_name, acquired_version, inactivity_timeout_seconds,
             expires_at
      from platform.entity_edit_leases
      where tenant_id = ${session.tenantId}::uuid
        and entity_id = ${input.entityId}
        and target_id in (${sql.join(targetIds)})
        and owner_user_id <> ${session.userId}::uuid
        and expires_at > now()
    `.execute(trx);
    return new Map(result.rows.map((row) => [row.target_id, lockedError(row)]));
  });
}

function requireLeaseContract(operation: LeaseProtectedOperation) {
  const version = operation.concurrency?.version;
  const lease = operation.concurrency?.editLease;
  if (!version || !lease) {
    throw operationFailure({
      code: "LEASE_NOT_SUPPORTED",
      message: "This operation does not require an edit lease.",
    });
  }
  return { version, lease };
}

export async function acquireEntityEditLease(
  db: OpenShapeForgeDatabase,
  sessionInput: DbSessionInput,
  input: {
    operation: LeaseProtectedOperation;
    table: GeneratedCrudTable;
    targetId: string;
  },
): Promise<EntityEditLease> {
  const { version: versionRequirement, lease } = requireLeaseContract(input.operation);
  const inactivitySeconds = fixedDurationSeconds(lease.expiresAfterInactivity);
  const plainToken = mintToken();
  const hash = tokenHash(plainToken);

  return withDbSession(db, sessionInput, async (trx, session) => {
    const targetVersion = await currentVersionInTransaction(
      trx,
      session,
      input.table,
      input.targetId,
      versionRequirement,
    );
    if (!targetVersion) {
      throw operationFailure({ code: "NOT_FOUND", message: "Resource not found." });
    }

    const result = await sql<LeaseRow>`
      insert into platform.entity_edit_leases
        (tenant_id, entity_id, target_id, operation_id, owner_user_id,
         owner_display_name, token_hash, acquired_version,
         inactivity_timeout_seconds, acquired_at, last_activity_at, expires_at)
      values
        (${session.tenantId}::uuid, ${input.operation.entityId}, ${input.targetId},
         ${input.operation.id}, ${session.userId}::uuid,
         ${sessionInput.userDisplayName?.trim() || null}, ${hash}, ${targetVersion},
         ${inactivitySeconds}, now(), now(), now() + ${inactivitySeconds} * interval '1 second')
      on conflict (tenant_id, entity_id, target_id) do update set
        operation_id = excluded.operation_id,
        owner_user_id = excluded.owner_user_id,
        owner_display_name = excluded.owner_display_name,
        token_hash = excluded.token_hash,
        acquired_version = excluded.acquired_version,
        inactivity_timeout_seconds = excluded.inactivity_timeout_seconds,
        acquired_at = now(),
        last_activity_at = now(),
        expires_at = now() + excluded.inactivity_timeout_seconds * interval '1 second'
      where entity_edit_leases.expires_at <= now()
         or entity_edit_leases.owner_user_id = excluded.owner_user_id
      returning id, entity_id, target_id, operation_id, owner_user_id,
                owner_display_name, acquired_version, inactivity_timeout_seconds,
                expires_at
    `.execute(trx);

    const acquired = result.rows[0];
    if (!acquired) {
      const conflict = await sql<LeaseRow>`
        select id, entity_id, target_id, operation_id, owner_user_id,
               owner_display_name, acquired_version, inactivity_timeout_seconds,
               expires_at
        from platform.entity_edit_leases
        where tenant_id = ${session.tenantId}::uuid
          and entity_id = ${input.operation.entityId}
          and target_id = ${input.targetId}
          and expires_at > now()
      `.execute(trx);
      throw operationFailure(
        conflict.rows[0]
          ? lockedError(conflict.rows[0])
          : { code: "LEASE_ACQUIRE_FAILED", message: "The edit lease could not be acquired.", retryable: true },
      );
    }

    const expiresAt = new Date(acquired.expires_at).toISOString();
    await appendScopedEntityEventInTransaction(trx, {
      aggregateType: input.operation.entityId,
      aggregateId: input.targetId,
      eventType: "edit_lease_acquired",
      payload: {
        operationId: input.operation.id,
        ownerUserId: session.userId,
        expiresAt,
      },
    });

    return {
      leaseToken: plainToken,
      operationId: acquired.operation_id,
      entityId: acquired.entity_id,
      targetId: acquired.target_id,
      targetVersion: normalizeTimestampToken(acquired.acquired_version),
      expiresAt,
    };
  }, { isolationLevel: "serializable" });
}

export async function renewEntityEditLease(
  db: OpenShapeForgeDatabase,
  sessionInput: DbSessionInput,
  leaseToken: string,
  allowedOperationIds: readonly string[],
): Promise<Omit<EntityEditLease, "leaseToken">> {
  if (allowedOperationIds.length === 0) {
    throw operationFailure({
      code: "LEASE_EXPIRED",
      message: "The edit lease cannot be renewed because its operation is no longer available.",
    });
  }
  const hash = tokenHash(leaseToken);
  return withDbSession(db, sessionInput, async (trx, session) => {
    const result = await sql<LeaseRow>`
      update platform.entity_edit_leases
      set last_activity_at = now(),
          expires_at = now() + inactivity_timeout_seconds * interval '1 second'
      where tenant_id = ${session.tenantId}::uuid
        and owner_user_id = ${session.userId}::uuid
        and token_hash = ${hash}
        and operation_id in (${sql.join(allowedOperationIds)})
        and expires_at > now()
      returning id, entity_id, target_id, operation_id, owner_user_id,
                owner_display_name, acquired_version, inactivity_timeout_seconds,
                expires_at
    `.execute(trx);
    const renewed = result.rows[0];
    if (!renewed) {
      throw operationFailure({
        code: "LEASE_EXPIRED",
        message: "The edit lease has expired or does not belong to this identity.",
      });
    }
    const expiresAt = new Date(renewed.expires_at).toISOString();
    await appendScopedEntityEventInTransaction(trx, {
      aggregateType: renewed.entity_id,
      aggregateId: renewed.target_id,
      eventType: "edit_lease_renewed",
      payload: {
        operationId: renewed.operation_id,
        ownerUserId: session.userId,
        expiresAt,
      },
    });
    return {
      operationId: renewed.operation_id,
      entityId: renewed.entity_id,
      targetId: renewed.target_id,
      targetVersion: normalizeTimestampToken(renewed.acquired_version),
      expiresAt,
    };
  });
}

export async function releaseEntityEditLease(
  db: OpenShapeForgeDatabase,
  sessionInput: DbSessionInput,
  leaseToken: string,
): Promise<{ released: boolean }> {
  const hash = tokenHash(leaseToken);
  return withDbSession(db, sessionInput, async (trx, session) => {
    const result = await sql<LeaseRow>`
      delete from platform.entity_edit_leases
      where tenant_id = ${session.tenantId}::uuid
        and owner_user_id = ${session.userId}::uuid
        and token_hash = ${hash}
      returning id, entity_id, target_id, operation_id, owner_user_id,
                owner_display_name, acquired_version, inactivity_timeout_seconds,
                expires_at
    `.execute(trx);
    const released = result.rows[0];
    if (released) {
      await appendScopedEntityEventInTransaction(trx, {
        aggregateType: released.entity_id,
        aggregateId: released.target_id,
        eventType: "edit_lease_released",
        payload: {
          operationId: released.operation_id,
          ownerUserId: session.userId,
        },
      });
    }
    return { released: Boolean(released) };
  });
}

async function requireEntityEditLeaseInTransaction(
  trx: Transaction<DB>,
  sessionInput: DbSessionInput,
  input: {
    operation: LeaseProtectedOperation;
    targetId: string;
    expectedVersion: string;
    leaseToken: string;
  },
): Promise<{ session: DbSessionContext; lease: HeldLeaseRow }> {
  requireLeaseContract(input.operation);
  const session = createDbSessionContext(sessionInput);
  const hash = tokenHash(input.leaseToken);
  const held = await sql<HeldLeaseRow>`
    select id, entity_id, target_id, operation_id, owner_user_id,
           owner_display_name, acquired_version, inactivity_timeout_seconds,
           expires_at, token_hash
    from platform.entity_edit_leases
    where tenant_id = ${session.tenantId}::uuid
      and entity_id = ${input.operation.entityId}
      and target_id = ${input.targetId}
      and expires_at > now()
    for update
  `.execute(trx);
  const lease = held.rows[0];
  if (lease && lease.owner_user_id !== session.userId) {
    throw operationFailure(lockedError(lease));
  }
  if (
    lease &&
    normalizeTimestampToken(lease.acquired_version) !==
      normalizeTimestampToken(input.expectedVersion)
  ) {
    throw operationFailure({
      code: "VERSION_CONFLICT",
      message: "The record changed after this edit lease was acquired.",
      detail: "Reload the current record and acquire a new edit lease before saving.",
    });
  }
  if (
    !lease ||
    lease.operation_id !== input.operation.id ||
    lease.token_hash !== hash
  ) {
    throw operationFailure({
      code: "LEASE_INVALID",
      message: "The edit lease is invalid, expired, or belongs to another identity.",
    });
  }
  return { session, lease };
}

/** Validate a lease for a multi-step interaction without consuming it. */
export async function validateEntityEditLeaseInTransaction(
  trx: Transaction<DB>,
  sessionInput: DbSessionInput,
  input: {
    operation: LeaseProtectedOperation;
    targetId: string;
    expectedVersion: string;
    leaseToken: string;
  },
): Promise<void> {
  await requireEntityEditLeaseInTransaction(trx, sessionInput, input);
}

/** Consume a validated lease in the same transaction as its protected write. */
export async function consumeEntityEditLeaseInTransaction(
  trx: Transaction<DB>,
  sessionInput: DbSessionInput,
  input: {
    operation: LeaseProtectedOperation;
    targetId: string;
    expectedVersion: string;
    leaseToken: string;
  },
): Promise<void> {
  const { session, lease } = await requireEntityEditLeaseInTransaction(
    trx,
    sessionInput,
    input,
  );
  await sql`
    delete from platform.entity_edit_leases
    where tenant_id = ${session.tenantId}::uuid
      and id = ${lease.id}::uuid
  `.execute(trx);
}
