// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { getGeneratedCrudTables, isWritableColumn } from "../../graphql/generated-crud.js";
import { billingOperationHandlerNames } from "./module.js";
import { resolveExpectedAt, resolveMilestoneAmounts } from "./agreement-milestone.js";

const fails = (run: () => unknown, field: string, message: RegExp) => {
  try {
    run();
  } catch (error) {
    expect(error).toMatchObject({ operationError: { code: "VALIDATION", violations: [{ field }] } });
    expect(String((error as { operationError: { message: string } }).operationError.message)).toMatch(message);
    return;
  }
  throw new Error("expected a VALIDATION refusal");
};

describe("resolveMilestoneAmounts", () => {
  test("computes amount from basisAmount * percentOfBasis / 100, rounded to cents", () => {
    expect(resolveMilestoneAmounts({ basisAmount: 240000, percentOfBasis: 20 })).toEqual({ basisAmount: 240000, percentOfBasis: 20, amount: 48000 });
    expect(resolveMilestoneAmounts({ basisAmount: 100, percentOfBasis: 33.333 })).toEqual({ basisAmount: 100, percentOfBasis: 33.333, amount: 33.33 });
  });

  test("ignores a client-supplied amount alongside a percentage", () => {
    expect(resolveMilestoneAmounts({ basisAmount: 1000, percentOfBasis: 10, amount: 999999 })).toEqual({ basisAmount: 1000, percentOfBasis: 10, amount: 100 });
  });

  test("requires a positive basisAmount with a percentage, and a percentage above 0 and at most 100", () => {
    fails(() => resolveMilestoneAmounts({ percentOfBasis: 20 }), "basisAmount", /basisAmount is required/);
    fails(() => resolveMilestoneAmounts({ basisAmount: 100, percentOfBasis: 101 }), "percentOfBasis", /more than 0 and at most 100/);
    // Zero bills nothing, so it is no milestone; a non-positive basis is no basis.
    fails(() => resolveMilestoneAmounts({ basisAmount: 100, percentOfBasis: 0 }), "percentOfBasis", /more than 0/);
    fails(() => resolveMilestoneAmounts({ basisAmount: 0, percentOfBasis: 10 }), "basisAmount", /positive number/);
    fails(() => resolveMilestoneAmounts({ basisAmount: -5, amount: 10 }), "basisAmount", /positive number/);
  });

  test("accepts a plain fixed amount, with an informational basisAmount, and refuses a non-positive one", () => {
    expect(resolveMilestoneAmounts({ amount: 5000 })).toEqual({ basisAmount: null, percentOfBasis: null, amount: 5000 });
    expect(resolveMilestoneAmounts({ amount: 5000, basisAmount: 25000 })).toEqual({ basisAmount: 25000, percentOfBasis: null, amount: 5000 });
    fails(() => resolveMilestoneAmounts({ amount: 0 }), "amount", /positive number/);
    fails(() => resolveMilestoneAmounts({}), "amount", /positive number/);
  });
});

describe("resolveExpectedAt", () => {
  test("takes a calendar date or nothing, never a timestamp", () => {
    expect(resolveExpectedAt(undefined)).toBeNull();
    expect(resolveExpectedAt(null)).toBeNull();
    expect(resolveExpectedAt("2026-10-01")).toBe("2026-10-01");
    fails(() => resolveExpectedAt("2026-10-01T00:00:00Z"), "expectedAt", /YYYY-MM-DD/);
    fails(() => resolveExpectedAt("2026-13-45"), "expectedAt", /YYYY-MM-DD/);
  });
});

describe("the shipped milestone manifest", () => {
  const table = getGeneratedCrudTables().find((entry) => entry.name === "erp.agreement_milestones")!;

  test("basisAmount, percentOfBasis and amount are set once and immutable afterwards", () => {
    for (const name of ["basis_amount", "percent_of_basis", "amount"]) {
      const column = table.columns.find((entry) => entry.name === name)!;
      expect(column.immutable).toBe(true);
      expect(isWritableColumn(column, "create")).toBe(true);
      expect(isWritableColumn(column, "update")).toBe(false);
    }
  });

  test("status and producedInvoiceId are written only by the transitions", () => {
    expect(table.columns.find((entry) => entry.name === "status")!.writtenBy!.map((writer) => writer.operation))
      .toEqual(["AgreementMilestone.trigger", "AgreementMilestone.cancel", "AgreementMilestone.invoice"]);
    expect(table.columns.find((entry) => entry.name === "produced_invoice_id")!.writtenBy!.map((writer) => writer.operation))
      .toEqual(["AgreementMilestone.invoice"]);
  });

  test("the core billing module carries exactly the handlers the catalogue names", () => {
    expect(billingOperationHandlerNames()).toEqual(["createAgreementMilestone", "executeBillingRun"]);
  });
});
