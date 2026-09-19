// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import {
  parseAgreementMilestoneBody,
  parseMilestoneBillingRunBody,
} from "../rest-routes.js";

describe("agreement milestone command input", () => {
  test("accepts a percentage milestone request", () => {
    const input = {
      agreementId: "0d3f6b6a-1c1e-4a7a-9d6a-9e7b6d0a1234",
      description: "Go-live milestone",
      basisAmount: 240000,
      percentOfBasis: 20,
    };
    expect(parseAgreementMilestoneBody(Buffer.from(JSON.stringify(input)))).toEqual(input);
  });

  test("accepts an expected date beside the amounts", () => {
    const input = {
      agreementId: "0d3f6b6a-1c1e-4a7a-9d6a-9e7b6d0a1234",
      description: "Go-live milestone",
      amount: 5000,
      expectedAt: "2026-12-01",
    };
    expect(parseAgreementMilestoneBody(input)).toEqual(input);
  });

  test("rejects unknown fields before hitting the service", () => {
    expect(() =>
      parseAgreementMilestoneBody({
        agreementId: "0d3f6b6a-1c1e-4a7a-9d6a-9e7b6d0a1234",
        description: "Go-live milestone",
        amount: 5000,
        vatRateId: "should-not-exist-here",
      }),
    ).toThrow(/Unknown request field "vatRateId"/);
  });

  test("does not echo malformed JSON", () => {
    try {
      parseAgreementMilestoneBody(Buffer.from('{"description":"private-value"'));
      throw new Error("expected rejection");
    } catch (error) {
      expect((error as Error).message).toBe("Request body is not valid JSON.");
      expect((error as Error).message).not.toContain("private-value");
    }
  });
});

describe("milestone billing run command input", () => {
  test("accepts a scoped agreementFilter", () => {
    const input = {
      idempotencyKey: "milestone-run-1",
      agreementFilter: { agreementId: "0d3f6b6a-1c1e-4a7a-9d6a-9e7b6d0a1234" },
      dryRun: false,
    };
    expect(parseMilestoneBillingRunBody(input)).toEqual(input);
  });

  test("rejects an unknown agreementFilter field", () => {
    expect(() =>
      parseMilestoneBillingRunBody({
        idempotencyKey: "milestone-run-1",
        agreementFilter: { relationId: "0d3f6b6a-1c1e-4a7a-9d6a-9e7b6d0a1234" },
      }),
    ).toThrow(/Unknown agreementFilter field "relationId"/);
  });

  test("rejects unknown top-level fields", () => {
    expect(() =>
      parseMilestoneBillingRunBody({ idempotencyKey: "x", billUpToDate: "2026-01-01" }),
    ).toThrow(/Unknown request field "billUpToDate"/);
  });
});
