// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { getGeneratedCrudTables, isWritableColumn } from "../../graphql/generated-crud.js";
import { generatedEntityTypeDefs } from "../../graphql/generated-entity-schema.js";
import { resolveMilestoneAmounts } from "../agreement-milestone-service.js";

describe("resolveMilestoneAmounts", () => {
  test("computes amount from basisAmount * percentOfBasis / 100", () => {
    expect(
      resolveMilestoneAmounts({ basisAmount: 240000, percentOfBasis: 20 }),
    ).toEqual({ basisAmount: 240000, percentOfBasis: 20, amount: 48000 });
  });

  test("rounds the computed amount to cents", () => {
    expect(
      resolveMilestoneAmounts({ basisAmount: 100, percentOfBasis: 33.333 }),
    ).toEqual({ basisAmount: 100, percentOfBasis: 33.333, amount: 33.33 });
  });

  test("ignores a client-supplied amount alongside a percentage", () => {
    expect(
      resolveMilestoneAmounts({ basisAmount: 1000, percentOfBasis: 10, amount: 999999 }),
    ).toEqual({ basisAmount: 1000, percentOfBasis: 10, amount: 100 });
  });

  test("requires basisAmount when percentOfBasis is set", () => {
    expect(() => resolveMilestoneAmounts({ percentOfBasis: 20 })).toThrow(
      /basisAmount is required/,
    );
  });

  test("rejects a percentOfBasis outside 0-100", () => {
    expect(() => resolveMilestoneAmounts({ basisAmount: 100, percentOfBasis: 101 })).toThrow(
      /percentOfBasis must be a number between 0 and 100/,
    );
  });

  test("accepts a plain fixed amount with no percentage", () => {
    expect(resolveMilestoneAmounts({ amount: 5000 })).toEqual({
      basisAmount: null,
      percentOfBasis: null,
      amount: 5000,
    });
  });

  test("carries an informational basisAmount alongside a fixed amount", () => {
    expect(resolveMilestoneAmounts({ amount: 5000, basisAmount: 25000 })).toEqual({
      basisAmount: 25000,
      percentOfBasis: null,
      amount: 5000,
    });
  });

  test("requires a positive amount when there is no percentage", () => {
    expect(() => resolveMilestoneAmounts({ amount: 0 })).toThrow(
      /amount must be a positive number/,
    );
    expect(() => resolveMilestoneAmounts({})).toThrow(/amount must be a positive number/);
  });
});

describe("AgreementMilestone immutability in the shipped manifest", () => {
  const table = getGeneratedCrudTables().find((entry) => entry.name === "erp.agreement_milestones");

  test("basisAmount, percentOfBasis and amount are all flagged immutable", () => {
    expect(table).toBeDefined();
    for (const columnName of ["basis_amount", "percent_of_basis", "amount"]) {
      const column = table?.columns.find((entry) => entry.name === columnName);
      expect(column?.immutable).toBe(true);
      expect(isWritableColumn(column!, "create")).toBe(true);
      expect(isWritableColumn(column!, "update")).toBe(false);
    }
  });

  test("description and status stay writable on update", () => {
    for (const columnName of ["description", "status"]) {
      const column = table?.columns.find((entry) => entry.name === columnName);
      expect(column?.immutable).toBeUndefined();
      expect(isWritableColumn(column!, "update")).toBe(true);
    }
  });

  test("the generated SDL offers amount on create but withholds it on update", () => {
    const createInput = /input CreateAgreementMilestoneInput \{([^}]*)\}/.exec(
      generatedEntityTypeDefs,
    );
    const updateInput = /input UpdateAgreementMilestoneInput \{([^}]*)\}/.exec(
      generatedEntityTypeDefs,
    );
    expect(createInput?.[1]).toContain("amount:");
    expect(createInput?.[1]).toContain("basisAmount:");
    expect(createInput?.[1]).toContain("percentOfBasis:");
    expect(updateInput?.[1]).not.toContain("amount:");
    expect(updateInput?.[1]).not.toContain("basisAmount:");
    expect(updateInput?.[1]).not.toContain("percentOfBasis:");
  });
});
