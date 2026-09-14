// SPDX-License-Identifier: BUSL-1.1
/** Core-issued proof that a canonical prerequisite Operation was completed. */
import { createHmac, timingSafeEqual } from "node:crypto";
import { sql } from "kysely";
import {
  operationFailure,
  type OperationPrerequisite,
} from "@openshapeforge/operations";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import { withDbSession, type DbSessionInput } from "../db/session.js";
import { appendEntityEvent } from "../platform/entity-events.js";
import { cryptographicallyUsableContextSecret } from "../auth/login-session-binding.js";

const AGGREGATE_TYPE = "OperationPrerequisiteReceipt";
const EVENT_TYPE = "operation_prerequisite_satisfied";

export type PrerequisiteProtectedOperation = {
  id: string;
  prerequisites?: readonly OperationPrerequisite[];
};

export type OperationPrerequisiteReceiptIdentity = {
  tenantId: string;
  userId: string;
  loginSessionBinding: string;
  sourceOperationId: string;
  targetOperationId: string;
};

function canonicalReceiptIdentity(identity: OperationPrerequisiteReceiptIdentity): string {
  return JSON.stringify([
    1,
    identity.tenantId,
    identity.userId,
    identity.loginSessionBinding,
    identity.sourceOperationId,
    identity.targetOperationId,
  ]);
}

export function mintOperationPrerequisiteReceipt(
  identity: OperationPrerequisiteReceiptIdentity,
  options: { secret?: string } = {},
): string | undefined {
  const secret = cryptographicallyUsableContextSecret(options.secret);
  if (!secret) return undefined;
  const digest = createHmac("sha256", secret)
    .update("openshapeforge:operation-prerequisite-receipt:v1\0")
    .update(canonicalReceiptIdentity(identity))
    .digest("base64url");
  return `opr1.${digest}`;
}

export function operationPrerequisiteReceiptMatches(
  receipt: string,
  identity: OperationPrerequisiteReceiptIdentity,
  options: { secret?: string } = {},
): boolean {
  const expected = mintOperationPrerequisiteReceipt(identity, options);
  return expected !== undefined && sameReceipt(receipt, expected);
}

function sameReceipt(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function receiptIdentity(
  session: DbSessionInput,
  sourceOperationId: string,
  targetOperationId: string,
): OperationPrerequisiteReceiptIdentity | undefined {
  if (
    !session.tenantId ||
    !session.userId ||
    !session.loginSessionBinding ||
    !sourceOperationId.trim() ||
    !targetOperationId.trim()
  ) {
    return undefined;
  }
  return {
    tenantId: session.tenantId,
    userId: session.userId,
    loginSessionBinding: session.loginSessionBinding,
    sourceOperationId,
    targetOperationId,
  };
}

function unavailable(): never {
  throw operationFailure({
    code: "PREREQUISITE_RECEIPT_UNAVAILABLE",
    message: "This prerequisite requires a verified interactive login session.",
    detail: "Sign in with a user account and complete the prerequisite again.",
    retryable: false,
  });
}

function receiptFor(
  session: DbSessionInput,
  sourceOperationId: string,
  targetOperationId: string,
): string {
  const identity = receiptIdentity(session, sourceOperationId, targetOperationId);
  if (!identity) return unavailable();
  const receipt = mintOperationPrerequisiteReceipt(identity);
  return receipt ?? unavailable();
}

export async function issueOperationPrerequisiteReceipt(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  input: { sourceOperationId: string; targetOperationId: string },
): Promise<void> {
  const receipt = receiptFor(
    session,
    input.sourceOperationId,
    input.targetOperationId,
  );
  await appendEntityEvent(db, session, {
    aggregateType: AGGREGATE_TYPE,
    aggregateId: input.targetOperationId,
    eventType: EVENT_TYPE,
    payload: {
      version: 1,
      sourceOperationId: input.sourceOperationId,
      targetOperationId: input.targetOperationId,
      receipt,
    },
  });
}

export async function hasOperationPrerequisiteReceipt(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  input: { sourceOperationId: string; targetOperationId: string },
): Promise<boolean> {
  const receipt = receiptFor(
    session,
    input.sourceOperationId,
    input.targetOperationId,
  );
  return withDbSession(db, session, async (trx, scopedSession) => {
    const result = await sql<{ receipt: string }>`
      select payload ->> 'receipt' as receipt
      from platform.entity_events
      where tenant_id = ${scopedSession.tenantId}
        and aggregate_type = ${AGGREGATE_TYPE}
        and aggregate_id = ${input.targetOperationId}
        and event_type = ${EVENT_TYPE}
        and payload ->> 'sourceOperationId' = ${input.sourceOperationId}
        and payload ->> 'targetOperationId' = ${input.targetOperationId}
      order by sequence desc
    `.execute(trx);
    return result.rows.some((row) =>
      typeof row.receipt === "string" && sameReceipt(row.receipt, receipt)
    );
  });
}

export async function requireOperationPrerequisites(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  operation: PrerequisiteProtectedOperation,
): Promise<void> {
  for (const prerequisite of operation.prerequisites ?? []) {
    if (prerequisite.receipt.binding !== "loginSession") return unavailable();
    const satisfied = await hasOperationPrerequisiteReceipt(db, session, {
      sourceOperationId: prerequisite.operation,
      targetOperationId: operation.id,
    });
    if (!satisfied) {
      throw operationFailure({
        code: "PREREQUISITE_REQUIRED",
        message: "Complete the required instructions before continuing.",
        detail: "Open the prerequisite, review its instructions, and then retry this Operation.",
        retryable: true,
        data: {
          prerequisite: {
            operation: prerequisite.operation,
            receipt: { binding: prerequisite.receipt.binding },
          },
        },
      });
    }
  }
}
