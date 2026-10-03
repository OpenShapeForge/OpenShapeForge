// SPDX-License-Identifier: BUSL-1.1
import { AsyncLocalStorage } from "node:async_hooks";
import type { Transaction } from "kysely";
import type { DB } from "../../generated/db/types.js";
import type { DbSessionInput } from "../../db/session.js";
import { normalizeTimestampToken } from "../../db/timestamps.js";
import { consumeEntityEditLeaseInTransaction, type LeaseProtectedOperation } from "./edit-leases.js";

type LeaseInput = {
  operation: LeaseProtectedOperation;
  targetId: string;
  expectedVersion: string;
  leaseToken: string;
};
type Receipt = {
  trx: Transaction<DB>;
  tenantId: string;
  userId: string;
  operation: LeaseProtectedOperation;
  targetId: string;
  expectedVersion: string;
};
const receipts = new AsyncLocalStorage<Receipt>();

/** A receipt exists only after a real lease is consumed in this transaction. */
export async function withConsumedCollectionLeaseInTransaction<T>(
  trx: Transaction<DB>, session: DbSessionInput, input: LeaseInput, work: () => Promise<T>,
): Promise<T> {
  await consumeEntityEditLeaseInTransaction(trx, session, input);
  return receipts.run({
    trx, tenantId: session.tenantId!, userId: session.userId!,
    operation: structuredClone(input.operation), targetId: input.targetId,
    expectedVersion: normalizeTimestampToken(input.expectedVersion),
  }, work);
}

/** No request input can supply this transaction/identity/Operation receipt. */
export function hasConsumedCollectionLease(
  trx: Transaction<DB> | undefined, session: DbSessionInput,
  operation: LeaseProtectedOperation | undefined, targetId: string, expectedVersion: string,
): boolean {
  const receipt = receipts.getStore();
  return Boolean(receipt && trx && operation?.concurrency?.editLease &&
    receipt.trx === trx && receipt.tenantId === session.tenantId && receipt.userId === session.userId &&
    receipt.operation.id === operation.id && receipt.operation.entityId === operation.entityId &&
    receipt.operation.entityName === operation.entityName &&
    receipt.operation.concurrency?.version?.field === operation.concurrency.version?.field &&
    receipt.operation.concurrency?.editLease?.expiresAfterInactivity === operation.concurrency.editLease.expiresAfterInactivity &&
    receipt.targetId === targetId && receipt.expectedVersion === normalizeTimestampToken(expectedVersion));
}
