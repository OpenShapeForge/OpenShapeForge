// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import manifest from "../../generated/db/manifest.json" with { type: "json" };
import catalog from "../../generated/operations/catalog.json" with { type: "json" };
import type { GeneratedCrudTable } from "./types.js";
import {
  addTrustedOperationValues,
  assertNoForeignOperationWrittenValues,
  assertNoOperationWrittenValues,
  normalizeWritableValues,
} from "./write-policy.js";

test("canonical create owns attribution across every projected interface", () => {
  const table = (manifest.tables as GeneratedCrudTable[]).find(
    (candidate) => candidate.source?.authoringEntityName === "Comment",
  )!;
  const operation = catalog.entityOperations.find((candidate) => candidate.id === "Comment.create")!;
  const valuesSchema = (operation.inputSchema.properties.values as { properties: Record<string, unknown> });

  expect(operation.stamps).toEqual([{ field: "authorId", source: "actorRelation" }]);
  expect(valuesSchema.properties.authorId).toBeUndefined();
  expect(() => assertNoOperationWrittenValues(table, { authorId: "caller-choice" }))
    .toThrow("cannot be set through create or update");

  const values = normalizeWritableValues(table, { body: "hello" }, "create");
  addTrustedOperationValues(table, values, operation.id, { authorId: "linked-relation" });
  expect([...values.entries()].map(([column, value]) => [column.sourceField, value]))
    .toContainEqual(["authorId", "linked-relation"]);
  expect(() => addTrustedOperationValues(table, values, "Comment.update", { authorId: "forged" }))
    .toThrow("generated writer metadata is missing");
});

test("a plugin Operation may accept only the process fields it owns", () => {
  const table = (manifest.tables as GeneratedCrudTable[]).find(
    (candidate) => candidate.source?.authoringEntityName === "AgreementMilestone",
  )!;

  expect(() =>
    assertNoForeignOperationWrittenValues(
      table,
      { amount: 7.5 },
      "AgreementMilestone.create",
    ),
  ).not.toThrow();
  expect(() =>
    assertNoForeignOperationWrittenValues(
      table,
      { producedInvoiceId: "caller-choice" },
      "AgreementMilestone.create",
    ),
  ).toThrow("AgreementMilestone.invoice");
});

test("Account IdP lifecycle fields are unavailable to generic create and update", () => {
  const account = (manifest.tables as GeneratedCrudTable[]).find(
    (candidate) => candidate.source?.authoringEntityName === "Account",
  )!;
  for (const id of ["Account.create", "Account.update"]) {
    const operation = catalog.entityOperations.find((candidate) => candidate.id === id)!;
    const values = operation.inputSchema.properties.values as { properties: Record<string, unknown> };
    for (const field of ["keycloakSub", "lastLoginAt", "passwordChangedAt"]) {
      expect(values.properties[field]).toBeUndefined();
      expect(() => assertNoOperationWrittenValues(account, { [field]: "caller-choice" }))
        .toThrow("cannot be set through create or update");
    }
  }
});
