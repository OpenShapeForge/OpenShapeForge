// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { operationErrorOf } from "@openshapeforge/operations";
import { keyedOperationReceiptIdentity } from "./execution-receipts.js";

const session = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  userId: "22222222-2222-4222-8222-222222222222",
};

function identity(overrides: Record<string, unknown> = {}) {
  return keyedOperationReceiptIdentity(session, {
    operation: { id: "example.record.publish", intent: "invoke" },
    idempotencyKey: "attempt-1",
    idempotencyInputField: "requestKey",
    platformControlFields: [
      "expectedVersion",
      "leaseToken",
      "confirmed",
      "confirmationToken",
      "confirmationAnswer",
    ],
    contractFingerprint: `sha256:${"a".repeat(64)}`,
    input: {
      recordId: "33333333-3333-4333-8333-333333333333",
      values: { z: 2, a: [true, null] },
      requestKey: "attempt-1",
      expectedVersion: "2026-09-13T10:00:00.000Z",
      leaseToken: "lease-one",
      confirmed: true,
      ...overrides,
    },
  });
}

describe("keyed Operation receipt identity", () => {
  test("normalizes object order and excludes only platform controls and the declared key field", () => {
    const first = identity();
    const reordered = keyedOperationReceiptIdentity(session, {
      operation: { id: "example.record.publish", intent: "invoke" },
      idempotencyKey: "attempt-1",
      idempotencyInputField: "requestKey",
      platformControlFields: [
        "expectedVersion",
        "leaseToken",
        "confirmed",
        "confirmationToken",
        "confirmationAnswer",
      ],
      contractFingerprint: `sha256:${"a".repeat(64)}`,
      input: {
        confirmationAnswer: "new answer",
        leaseToken: "another lease",
        values: { a: [true, null], z: 2 },
        recordId: "33333333-3333-4333-8333-333333333333",
        confirmationToken: "new challenge",
        expectedVersion: "2026-09-13T11:00:00.000Z",
        requestKey: "another projected copy",
      },
    });
    expect(reordered.requestFingerprint).toBe(first.requestFingerprint);
    expect(reordered.keyHash).toBe(first.keyHash);
    expect(first.keyHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("binds every business value, array order, actor, tenant, operation, key and contract", () => {
    const first = identity();
    expect(identity({ values: { z: 3, a: [true, null] } }).requestFingerprint)
      .not.toBe(first.requestFingerprint);
    expect(identity({ values: { z: 2, a: [null, true] } }).requestFingerprint)
      .not.toBe(first.requestFingerprint);
    expect(keyedOperationReceiptIdentity(
      { ...session, userId: "44444444-4444-4444-8444-444444444444" },
      {
        operation: { id: "example.record.publish", intent: "invoke" },
        idempotencyKey: "attempt-1",
        contractFingerprint: `sha256:${"a".repeat(64)}`,
        input: { values: {} },
      },
    ).actorId).not.toBe(first.actorId);
    expect(keyedOperationReceiptIdentity(session, {
      operation: { id: "example.record.publish", intent: "invoke" },
      idempotencyKey: "attempt-2",
      contractFingerprint: `sha256:${"a".repeat(64)}`,
      input: { values: {} },
    }).keyHash).not.toBe(first.keyHash);
    const authoredConfirmed = keyedOperationReceiptIdentity(session, {
      operation: { id: "example.record.publish", intent: "invoke" },
      idempotencyKey: "attempt-1",
      contractFingerprint: `sha256:${"a".repeat(64)}`,
      input: { confirmed: true },
    });
    const changedAuthoredConfirmed = keyedOperationReceiptIdentity(session, {
      operation: { id: "example.record.publish", intent: "invoke" },
      idempotencyKey: "attempt-1",
      contractFingerprint: `sha256:${"a".repeat(64)}`,
      input: { confirmed: false },
    });
    expect(changedAuthoredConfirmed.requestFingerprint)
      .not.toBe(authoredConfirmed.requestFingerprint);
  });

  test("rejects missing, oversized and non-JSON-safe values before persistence", () => {
    for (const idempotencyKey of ["", " ", "x".repeat(513)]) {
      try {
        keyedOperationReceiptIdentity(session, {
          operation: { id: "example", intent: "invoke" },
          idempotencyKey,
          contractFingerprint: `sha256:${"a".repeat(64)}`,
          input: {},
        });
        throw new Error("expected key refusal");
      } catch (error) {
        expect(operationErrorOf(error)?.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
      }
    }
    for (const value of [undefined, Number.NaN, Number.POSITIVE_INFINITY, 1n]) {
      try {
        identity({ values: { unsafe: value } });
        throw new Error("expected JSON refusal");
      } catch (error) {
        expect(operationErrorOf(error)?.code).toBe("BAD_USER_INPUT");
      }
    }
  });
});
