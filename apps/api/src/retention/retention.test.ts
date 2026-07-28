// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import {
  buildRetentionPlans,
  durationToPostgresInterval,
  type RetentionManifest,
} from "./retention.js";

const manifest: RetentionManifest = {
  tables: [
    {
      schema: "erp",
      table: "contacts",
      primaryKey: "id",
      columns: [
        { name: "id", type: "uuid", required: true, primaryKey: true },
        { name: "valid_until", type: "date", required: false },
        { name: "updated_at", type: "timestamptz", required: true },
        { name: "email", type: "text", required: false, classification: "pii" },
        { name: "name", type: "text", required: true, classification: "pii" },
      ],
      retention: {
        clock: {
          column: "valid_until",
          type: "date",
          fallbackColumns: ["updated_at"],
        },
        rules: [
          {
            id: "delete_contacts",
            after: { years: 2, months: 1, days: 3 },
            action: "delete",
            disposition: "delete",
          },
        ],
      },
    },
  ],
};

describe("retention manifest planning", () => {
  test("preserves date clocks, fallback order, disposition, and redaction columns", () => {
    const [plan] = buildRetentionPlans(manifest);

    expect(plan).toMatchObject({
      schema: "erp",
      table: "contacts",
      primaryKey: "id",
      clock: [
        { name: "valid_until", type: "date" },
        { name: "updated_at", type: "timestamptz" },
      ],
      redactionColumns: [
        { name: "email", type: "text", required: false },
        { name: "name", type: "text", required: true },
      ],
      rules: [{ id: "delete_contacts", disposition: "delete", destructive: true }],
    });
    expect(durationToPostgresInterval(plan!.rules[0]!.after)).toBe(
      "2 years 1 months 3 days",
    );
  });

  test("suspends destructive rules under legal hold but still permits retain", () => {
    const held: RetentionManifest = structuredClone(manifest);
    held.tables[0]!.retention!.legalHold = { suspendDestruction: true };
    held.tables[0]!.retention!.rules.push(
      {
        id: "archive_contacts",
        after: { years: 5 },
        action: "archive",
        disposition: "archive",
      },
      {
        id: "keep_contacts",
        after: { years: 10 },
        action: "retain",
        disposition: "keep",
      },
    );

    const [plan] = buildRetentionPlans(held);
    expect(plan!.rules.map((rule) => [rule.id, rule.suspended])).toEqual([
      ["delete_contacts", true],
      ["archive_contacts", true],
      ["keep_contacts", false],
    ]);
  });

  test("routes explicit review gates and review dispositions to a queue", () => {
    const reviewed: RetentionManifest = structuredClone(manifest);
    reviewed.tables[0]!.retention!.rules = [
      {
        id: "review_delete",
        after: { days: 1 },
        action: "delete",
        disposition: "delete",
        review: { required: true, queue: "privacy-review" },
      },
      {
        id: "authored_review",
        after: { days: 2 },
        action: "archive",
        disposition: "review",
      },
    ];

    const [plan] = buildRetentionPlans(reviewed);
    expect(plan!.rules.map((rule) => rule.reviewQueue)).toEqual([
      "privacy-review",
      "retention-review",
    ]);
  });

  test("maps coarse and authored dispositions without losing crypto-delete keys", () => {
    const dispositions: RetentionManifest = structuredClone(manifest);
    dispositions.tables[0]!.retention!.rules = [
      { id: "keep", after: { days: 1 }, action: "retain" },
      { id: "archive", after: { days: 1 }, action: "archive" },
      { id: "redact", after: { days: 1 }, action: "redact" },
      { id: "mask", after: { days: 1 }, action: "redact", disposition: "mask" },
      {
        id: "crypto",
        after: { days: 1 },
        action: "redact",
        disposition: "cryptoDelete",
        cryptoDelete: { keyReference: "contact-key" },
      },
    ];

    const [plan] = buildRetentionPlans(dispositions);
    expect(plan!.rules.map((rule) => [rule.disposition, rule.cryptoDeleteKey])).toEqual([
      ["keep", undefined],
      ["archive", undefined],
      ["anonymize", undefined],
      ["mask", undefined],
      ["cryptoDelete", "contact-key"],
    ]);
  });

  test("rejects manifest identifiers and references that are not declared columns", () => {
    const invalidIdentifier: RetentionManifest = structuredClone(manifest);
    invalidIdentifier.tables[0]!.schema = "erp; drop schema erp";
    expect(() => buildRetentionPlans(invalidIdentifier)).toThrow(/unsafe schema/);

    const missingClock: RetentionManifest = structuredClone(manifest);
    missingClock.tables[0]!.retention!.clock.column = "missing";
    expect(() => buildRetentionPlans(missingClock)).toThrow(/unknown clock column/);
  });
});
