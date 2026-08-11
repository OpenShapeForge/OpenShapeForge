// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import {
  __resolveErasurePlanForTests,
  PRIVACY_DATA_ERASURE_ROLE,
  requirePrivacyDataErasure,
} from "./data-subject-erasure.js";

describe("data-subject erasure manifest boundary", () => {
  test("accepts only the dedicated privacy role", () => {
    expect(() => requirePrivacyDataErasure({ roles: ["Relations.All.ReadWrite"] })).toThrow("Not authorized");
    expect(() => requirePrivacyDataErasure({ roles: [PRIVACY_DATA_ERASURE_ROLE] })).not.toThrow();
  });

  test("emits an explicit relation plan with only statutory payment fields anonymized", () => {
    const plan = __resolveErasurePlanForTests();
    expect(plan.root.schema).toBe("erp");
    expect(plan.root.table).toBe("relations");
    expect(plan.contactDetails).toMatchObject({ via: "relation_id" });
    expect(plan.paymentDetails).toMatchObject({
      via: "relation_id",
      anonymizeColumns: ["iban", "bic", "account_holder"],
    });
  });
});
