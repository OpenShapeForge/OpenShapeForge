// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { operationErrorOf } from "@openshapeforge/operations";
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import {
  mintOperationPrerequisiteReceipt,
  operationPrerequisiteReceiptMatches,
  requireOperationPrerequisites,
} from "./prerequisite-receipts.js";

const SECRET = "operation-prerequisite-test-7Zp1_xK9-vR3_mN5-qT8_cW2";

function identity(overrides: Partial<{
  tenantId: string;
  userId: string;
  loginSessionBinding: string;
  sourceOperationId: string;
  targetOperationId: string;
}> = {}) {
  return {
    tenantId: "11111111-1111-4111-8111-111111111111",
    userId: "22222222-2222-4222-8222-222222222222",
    loginSessionBinding: "lsb1.session-a",
    sourceOperationId: "osf-integration.provider.setup-guide",
    targetOperationId: "Adapter.create",
    ...overrides,
  };
}

describe("Operation prerequisite receipts", () => {
  test("bind the core proof to tenant, user, login session, source and exact target", () => {
    const receipt = mintOperationPrerequisiteReceipt(identity(), { secret: SECRET });
    expect(receipt).toMatch(/^opr1\.[A-Za-z0-9_-]+$/);
    for (const changed of [
      { tenantId: "33333333-3333-4333-8333-333333333333" },
      { userId: "44444444-4444-4444-8444-444444444444" },
      { loginSessionBinding: "lsb1.session-b" },
      { sourceOperationId: "another.guide" },
      { targetOperationId: "Adapter.update" },
    ]) {
      expect(mintOperationPrerequisiteReceipt(identity(changed), { secret: SECRET })).not.toBe(receipt);
    }
  });

  test("cannot mint with the public development secret", () => {
    expect(mintOperationPrerequisiteReceipt(identity(), {
      secret: "openshapeforge-local-dev-context-secret",
    })).toBeUndefined();
  });

  test("rejects spoofed events and receipts copied across authority bindings", () => {
    const receipt = mintOperationPrerequisiteReceipt(identity(), { secret: SECRET })!;
    expect(operationPrerequisiteReceiptMatches("opr1.forged", identity(), {
      secret: SECRET,
    })).toBe(false);
    expect(operationPrerequisiteReceiptMatches(receipt, identity({
      loginSessionBinding: "lsb1.another-session",
    }), { secret: SECRET })).toBe(false);
    expect(operationPrerequisiteReceiptMatches(receipt, identity(), {
      secret: SECRET,
    })).toBe(true);
  });

  test("fails closed before database work without a login-session binding", async () => {
    const session: TrustedSessionContext = {
      tenantId: identity().tenantId,
      userId: identity().userId,
      roles: ["integration_admin"],
      groups: [],
      scope: "tenant",
      credential: "bearer",
    };
    try {
      await requireOperationPrerequisites({} as never, session, {
        id: "Adapter.create",
        prerequisites: [{
          operation: "osf-integration.provider.setup-guide",
          receipt: { binding: "loginSession" },
        }],
      });
      throw new Error("expected prerequisite receipt failure");
    } catch (error) {
      expect(operationErrorOf(error)).toMatchObject({
        code: "PREREQUISITE_RECEIPT_UNAVAILABLE",
        retryable: false,
      });
    }
  });
});
