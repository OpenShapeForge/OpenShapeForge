// SPDX-License-Identifier: BUSL-1.1
/** Durable server-issued confirmation challenges for destructive entity Operations. */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { sql, type Transaction } from "kysely";
import {
  operationFailure,
  type OperationConfirmation,
  type OperationError,
} from "@openshapeforge/operations";
import type { OpenShapeForgeDatabase } from "../../db/connection.js";
import type { DB } from "../../generated/db/types.js";
import {
  createDbSessionContext,
  withDbSession,
  type DbSessionInput,
} from "../../db/session.js";
import { normalizeTimestampToken } from "../../db/timestamps.js";
import { appendScopedEntityEventInTransaction } from "../../platform/entity-events.js";
import { fieldNameForColumn } from "./columns.js";
import {
  fixedDurationSeconds,
  validateEntityEditLeaseInTransaction,
  type EditLeaseRequirement,
  type LeaseProtectedOperation,
  type VersionRequirement,
} from "./edit-leases.js";
import type { GeneratedCrudTable } from "./types.js";

type ChallengeConfirmation = Extract<OperationConfirmation, { mode: "challenge" }>;

export type ChallengeProtectedOperation = {
  id: string;
  entityId: string;
  entityName: string;
  intent: "update" | "delete" | "invoke";
  concurrency?: {
    version?: VersionRequirement;
    editLease?: EditLeaseRequirement;
  };
  interaction: { confirmation: OperationConfirmation };
};

type ChallengeRow = {
  operation_id: string;
  entity_id: string;
  target_id: string;
  target_version: string;
  owner_user_id: string;
  expected_answer_hash: string;
  expires_at: Date | string;
  expired: boolean;
  consumed_at: Date | string | null;
};

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function matchesDigest(value: string, expectedHex: string): boolean {
  const actual = Buffer.from(digest(value), "hex");
  const expected = Buffer.from(expectedHex, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function challengeContract(operation: ChallengeProtectedOperation): {
  confirmation: ChallengeConfirmation;
  version: VersionRequirement;
} {
  const confirmation = operation.interaction.confirmation;
  const version = operation.concurrency?.version;
  if (confirmation.mode !== "challenge" || !version) {
    throw operationFailure({
      code: "CONFIRMATION_NOT_SUPPORTED",
      message: "This operation does not use a server confirmation challenge.",
    });
  }
  return { confirmation, version };
}

function columnForField(table: GeneratedCrudTable, field: string) {
  const column = table.columns.find(
    (candidate) => fieldNameForColumn(candidate) === field,
  );
  if (!column) {
    throw operationFailure({
      code: "INTERNAL_SERVER_ERROR",
      message: "The confirmation field is not available.",
    });
  }
  return column;
}

export async function issueEntityConfirmationChallenge(
  db: OpenShapeForgeDatabase,
  sessionInput: DbSessionInput,
  input: {
    operation: ChallengeProtectedOperation;
    table: GeneratedCrudTable;
    targetId: string;
    expectedVersion: string;
    leaseToken?: string;
  },
): Promise<OperationError> {
  const { confirmation, version } = challengeContract(input.operation);
  const versionColumn = columnForField(input.table, version.field);
  const answerColumn = columnForField(
    input.table,
    confirmation.challenge.field,
  );
  const ttlSeconds = fixedDurationSeconds(confirmation.challenge.expiresAfter);
  const challengeToken = randomBytes(32).toString("base64url");

  return withDbSession(db, sessionInput, async (trx, session) => {
    if (input.operation.concurrency?.editLease) {
      if (!input.leaseToken) {
        throw operationFailure({
          code: "LEASE_INVALID",
          message: "A valid edit lease is required before requesting confirmation.",
        });
      }
      await validateEntityEditLeaseInTransaction(trx, sessionInput, {
        operation: input.operation as LeaseProtectedOperation,
        targetId: input.targetId,
        expectedVersion: input.expectedVersion,
        leaseToken: input.leaseToken,
      });
    }
    const tenantWhere = input.table.tenantScoped
      ? sql`and ${sql.id("tenant_id")} = ${session.tenantId}::uuid`
      : sql``;
    const record = await sql<{ version: string; answer: unknown }>`
      select ${sql.id(versionColumn.name)}::text as version,
             to_jsonb(${sql.id(answerColumn.name)}) as answer
      from ${sql.id(input.table.schema, input.table.table)}
      where ${sql.id(input.table.primaryKey!)}::text = ${input.targetId}
        ${tenantWhere}
    `.execute(trx);
    const row = record.rows[0];
    if (!row) {
      throw operationFailure({ code: "NOT_FOUND", message: "Resource not found." });
    }
    const targetVersion = normalizeTimestampToken(String(row.version));
    if (targetVersion !== normalizeTimestampToken(input.expectedVersion)) {
      throw operationFailure({
        code: "VERSION_CONFLICT",
        message: "The record has changed since it was loaded.",
        detail: "Reload the record before requesting a new confirmation.",
      });
    }
    // The generated read surface also projects rows through PostgreSQL
    // `to_jsonb`. Canonicalizing the challenge value through the same function
    // keeps dates, datetimes, numbers, booleans and strings byte-for-byte aligned
    // with the value a user sees over REST or MCP before we hash it.
    const answer = String(row.answer ?? "");
    if (!answer) {
      throw operationFailure({
        code: "CONFIRMATION_VALUE_UNAVAILABLE",
        message: "The current confirmation value is empty.",
      });
    }

    const inserted = await sql<{ expires_at: Date | string }>`
      insert into platform.operation_confirmation_challenges
        (tenant_id, operation_id, entity_id, target_id, target_version,
         owner_user_id, token_hash, expected_answer_hash, expires_at)
      values
        (${session.tenantId}::uuid, ${input.operation.id}, ${input.operation.entityId},
         ${input.targetId}, ${targetVersion}, ${session.userId}::uuid,
         ${digest(challengeToken)}, ${digest(answer)},
         now() + ${ttlSeconds} * interval '1 second')
      returning expires_at
    `.execute(trx);
    const expiresAt = new Date(inserted.rows[0]!.expires_at).toISOString();
    await appendScopedEntityEventInTransaction(trx, {
      aggregateType: input.operation.entityId,
      aggregateId: input.targetId,
      eventType: "confirmation_challenge_issued",
      payload: {
        operationId: input.operation.id,
        ownerUserId: session.userId,
        targetVersion,
        expiresAt,
      },
    });

    return {
      code: "CONFIRMATION_REQUIRED",
      message: input.operation.intent === "invoke"
        ? `Confirmation is required before ${input.operation.entityName} can be changed.`
        : `Confirmation is required before ${input.operation.entityName} can be ${input.operation.intent === "delete" ? "deleted" : "updated"}.`,
      detail: `Type the current value of ${confirmation.challenge.field} to continue.`,
      retryable: true,
      data: {
        confirmation: {
          challengeToken,
          kind: confirmation.challenge.kind,
          field: confirmation.challenge.field,
          targetId: input.targetId,
          targetVersion,
          expiresAt,
          singleUse: true,
        },
      },
    };
  });
}

export async function consumeEntityConfirmationInTransaction(
  trx: Transaction<DB>,
  sessionInput: DbSessionInput,
  input: {
    operation: ChallengeProtectedOperation;
    targetId: string;
    expectedVersion: string;
    confirmationToken: string;
    confirmationAnswer: string;
  },
): Promise<void> {
  challengeContract(input.operation);
  const session = createDbSessionContext(sessionInput);
  const result = await sql<ChallengeRow>`
    select operation_id, entity_id, target_id, target_version, owner_user_id,
           expected_answer_hash, expires_at, (expires_at <= now()) as expired,
           consumed_at
    from platform.operation_confirmation_challenges
    where tenant_id = ${session.tenantId}::uuid
      and token_hash = ${digest(input.confirmationToken)}
    for update
  `.execute(trx);
  const row = result.rows[0];
  if (!row || row.owner_user_id !== session.userId) {
    throw operationFailure({
      code: "CONFIRMATION_MISMATCH",
      message: "The confirmation challenge is invalid for this identity.",
    });
  }
  if (row.consumed_at) {
    throw operationFailure({
      code: "CONFIRMATION_ALREADY_USED",
      message: "The confirmation challenge has already been used.",
    });
  }
  if (row.expired) {
    throw operationFailure({
      code: "CONFIRMATION_EXPIRED",
      message: "The confirmation challenge has expired.",
      detail: "Request a new challenge and try again.",
    });
  }
  const expectedVersion = normalizeTimestampToken(input.expectedVersion);
  if (
    row.operation_id !== input.operation.id ||
    row.entity_id !== input.operation.entityId ||
    row.target_id !== input.targetId
  ) {
    throw operationFailure({
      code: "CONFIRMATION_MISMATCH",
      message: "The confirmation challenge belongs to a different operation or record.",
    });
  }
  if (normalizeTimestampToken(row.target_version) !== expectedVersion) {
    throw operationFailure({
      code: "CONFIRMATION_STALE",
      message: "The confirmation challenge belongs to an older record version.",
      detail: "Reload the record and request a new confirmation.",
    });
  }
  if (!matchesDigest(input.confirmationAnswer, row.expected_answer_hash)) {
    throw operationFailure({
      code: "CONFIRMATION_MISMATCH",
      message: "The typed confirmation value does not match the current record.",
    });
  }

  await sql`
    update platform.operation_confirmation_challenges
    set consumed_at = now()
    where tenant_id = ${session.tenantId}::uuid
      and token_hash = ${digest(input.confirmationToken)}
      and consumed_at is null
  `.execute(trx);
  await appendScopedEntityEventInTransaction(trx, {
    aggregateType: input.operation.entityId,
    aggregateId: input.targetId,
    eventType: "confirmation_challenge_consumed",
    payload: {
      operationId: input.operation.id,
      ownerUserId: session.userId,
      targetVersion: expectedVersion,
    },
  });
}
