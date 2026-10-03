// SPDX-License-Identifier: BUSL-1.1
/**
 * accounts.assign-group-role accepts any role from the organization's
 * catalogue, and its handler commits before the runtime validates the result
 * against the declared output schema. So the output schemas of the group-role
 * Operations must accept every role key the assign Operation can store, or a
 * committed grant answers 500 and the group's roles can no longer be listed
 * or revoked.
 */
import { expect, test } from "bun:test";
import rawCatalog from "../generated/operations/catalog.json" with { type: "json" };
import { createOperationAjv } from "./operation-ajv.js";

type CatalogOperation = { id: string; outputSchema: Record<string, unknown> };
const catalog = (rawCatalog as unknown as { operations: CatalogOperation[] }).operations;
const assignment = {
  id: "00000000-0000-4000-8000-000000000001",
  relationGroupId: "00000000-0000-4000-8000-000000000002",
  roleKey: "Connectors.ExampleObjectStore.Write",
  roleLabel: "Example object store",
};
const LIST_SAMPLE = { assignments: [assignment] };

test.each([
  ["accounts.assign-group-role", assignment],
  ["accounts.get-group-role", assignment],
  ["accounts.list-group-roles", LIST_SAMPLE],
])("%s output accepts any catalogue role key", (id, sample) => {
  const operation = catalog.find((candidate) => candidate.id === id);
  expect(operation).toBeDefined();
  const validate = createOperationAjv().compile(operation!.outputSchema);
  expect(validate(sample)).toBe(true);
});
