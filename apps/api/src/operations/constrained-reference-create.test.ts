// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { nativeConstrainedReferenceCreateBinding } from "./constrained-reference-create.js";
import type { OperationContract } from "./runtime.js";

const fixture = (): OperationContract => ({
  key: "core.Deal.customer.create-constrained-reference",
  title: "Create customer",
  description: "Create a customer and its required membership.",
  handler: "constrainedReferenceCreate",
  plugin: "core",
  target: { entityId: "core.Relation", entityName: "Relation", scope: "collection" },
  inputSchema: { type: "object" }, outputSchema: { type: "object" }, errors: [],
  auth: { mode: "session", roles: ["Relations.All.ReadWrite", "Relations.RelationGroups.ReadWrite"] },
  tenancy: { mode: "required" }, idempotency: { mode: "none" },
  effects: { data: "write", external: "none" }, confirmation: { mode: "none" },
  transports: {
    rest: { method: "POST", path: "/api/core/reference/deal/customer", response: { kind: "json" } },
    mcp: { enabled: true, name: "deal_customer_create_reference" },
    graphql: { enabled: true, kind: "mutation", field: "dealCustomerCreateReference" },
    typescript: { enabled: true, functionName: "dealCustomerCreateReference" },
  },
  implementation: {
    type: "constrained-reference-create", targetEntityName: "Relation",
    collectionEntityName: "RelationGroupMembership", parentField: "relationId",
    targetValues: { relationType: "organization" },
    childValues: { relationGroupId: "10000000-0000-4000-8000-000000000099" },
  },
});

test("accepts only compiler-owned bounded compound-create metadata", () => {
  expect(nativeConstrainedReferenceCreateBinding(fixture())).toMatchObject({
    type: "constrained-reference-create", targetEntityName: "Relation",
    collectionEntityName: "RelationGroupMembership", parentField: "relationId",
  });
  expect(() => nativeConstrainedReferenceCreateBinding({ ...fixture(), plugin: "cpq" })).toThrow("unsupported or incomplete");
  expect(() => nativeConstrainedReferenceCreateBinding({ ...fixture(), target: { entityId: "core.Person", entityName: "Person", scope: "collection" } })).toThrow("unsupported or incomplete");
});
