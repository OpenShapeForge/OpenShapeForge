// SPDX-License-Identifier: BUSL-1.1
/**
 * Entity-level CRUD role enforcement, manifest-driven per generated entity:
 * no-role sessions are denied everything, read-only sessions can read but
 * not mutate, forbidden mutations journal no entity events, and the authored
 * (Dutch) role spelling keeps working alongside the Keycloak-normalized one.
 * Same-tenant identities isolate role denial from RLS/tenant denial.
 */
import { expect } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  describe,
  eventsFor,
  expectData,
  gql,
  noRoles,
  readOnly,
  registerSuiteLifecycle,
  tenantA,
  test,
  type Identity,
} from "./e2e/harness.js";
import { createRow, fieldName, tables, tablesByTypeName } from "./e2e/entity-factory.js";

registerSuiteLifecycle();

// Authored Dutch spelling — regression for the manifest's vocabulary union
// (trusted-context callers send authored names; bearer tokens send the
// normalized English names the other identities use).
const dutchWriter: Identity = {
  tenantId: tenantA.tenantId,
  userId: randomUUID(),
  roles: ["Relaties.All.ReadWrite"],
};

async function expectForbidden(
  identity: Identity,
  query: string,
  variables?: Record<string, unknown>,
) {
  const result = await gql(identity, query, variables);
  expect(result.errors?.[0]?.extensions?.code).toBe("FORBIDDEN");
}

for (const table of tables) {
  const graphql = table.source!.graphql!;
  const typeName = graphql.typeName;

  describe(`${typeName} (${table.name}) role enforcement`, () => {
    test("a session without roles is denied every operation", async () => {
      const id = await createRow(table, tenantA);
      await expectForbidden(
        noRoles,
        `query($id: ID!) { ${graphql.singleQueryName}(id: $id) { id } }`,
        { id },
      );
      await expectForbidden(
        noRoles,
        `{ ${graphql.listQueryName}(first: 1) { totalCount } }`,
      );
      await expectForbidden(
        noRoles,
        `mutation($input: Create${typeName}Input!) { ${graphql.createMutationName}(input: $input) { id } }`,
        { input: {} },
      );
      await expectForbidden(
        noRoles,
        `mutation($input: Update${typeName}Input!) { ${graphql.updateMutationName}(input: $input) { id } }`,
        { input: { id } },
      );
      await expectForbidden(
        noRoles,
        `mutation($id: ID!) { ${graphql.deleteMutationName}(id: $id) }`,
        { id },
      );
    });

    test("a read-only session can read but not mutate (empty update included)", async () => {
      const id = await createRow(table, tenantA);

      const fetched = await expectData(
        readOnly,
        `query($id: ID!) { ${graphql.singleQueryName}(id: $id) { id } }`,
        { id },
      );
      expect(fetched[graphql.singleQueryName]?.id).toBe(id);

      const listed = await expectData(
        readOnly,
        `query($filter: ${typeName}Filter) { ${graphql.listQueryName}(filter: $filter, first: 1) { totalCount } }`,
        { filter: { id } },
      );
      expect(listed[graphql.listQueryName].totalCount).toBe(1);

      await expectForbidden(
        readOnly,
        `mutation($input: Create${typeName}Input!) { ${graphql.createMutationName}(input: $input) { id } }`,
        { input: {} },
      );
      // Empty-body update: authorized by the UPDATE role alone — a read-only
      // session must be denied even though no column would change.
      await expectForbidden(
        readOnly,
        `mutation($input: Update${typeName}Input!) { ${graphql.updateMutationName}(input: $input) { id } }`,
        { input: { id } },
      );
      await expectForbidden(
        readOnly,
        `mutation($id: ID!) { ${graphql.deleteMutationName}(id: $id) }`,
        { id },
      );
    });

    test("forbidden mutations journal no entity events", async () => {
      const id = await createRow(table, tenantA);
      await expectForbidden(
        readOnly,
        `mutation($input: Update${typeName}Input!) { ${graphql.updateMutationName}(input: $input) { id } }`,
        { input: { id } },
      );
      await expectForbidden(
        readOnly,
        `mutation($id: ID!) { ${graphql.deleteMutationName}(id: $id) }`,
        { id },
      );
      const events = await eventsFor(tenantA, table, id);
      expect(events.map((event) => event.eventType)).toEqual(["created"]);
    });

    test("the authored Dutch role spelling is accepted (vocabulary union)", async () => {
      const id = await createRow(table, dutchWriter);
      const data = await expectData(
        dutchWriter,
        `mutation($id: ID!) { ${graphql.deleteMutationName}(id: $id) }`,
        { id },
      );
      expect(data[graphql.deleteMutationName]).toBe(true);
    });
  });
}

// Relationship traversal reads TARGET rows through a separate code path
// (listGeneratedEntityRelation) — prove a read-only session may traverse.
// All shipped entities share the Relaties vocabulary, so a cross-entity
// denial case cannot be constructed from the current catalog; the DENY
// branch of the traversal target-read gate is pinned DB-free in
// require-entity-operation.unit.test.ts.
const parentTable = tables.find((table) =>
  (table.source?.graphql?.relationships ?? []).some(
    (relationship) =>
      relationship.resolve === "belongsTo" && tablesByTypeName.has(relationship.target),
  ),
);

if (parentTable) {
  const graphql = parentTable.source!.graphql!;
  const relationship = graphql.relationships!.find(
    (candidate) =>
      candidate.resolve === "belongsTo" && tablesByTypeName.has(candidate.target),
  )!;

  describe(`relationship traversal (${parentTable.name} → ${relationship.target})`, () => {
    test("a read-only session can traverse relationships (target read allowed)", async () => {
      const targetTable = tablesByTypeName.get(relationship.target)!;
      const targetId = await createRow(targetTable, tenantA);
      const fkColumn = parentTable.columns.find(
        (column) => column.name === relationship.foreignKey,
      )!;
      const parentId = await createRow(parentTable, tenantA, {
        [fieldName(fkColumn)]: targetId,
      });

      const data = await expectData(
        readOnly,
        `query($id: ID!) {
           ${graphql.singleQueryName}(id: $id) { id ${relationship.name} { id } }
         }`,
        { id: parentId },
      );
      expect(data[graphql.singleQueryName]?.[relationship.name]?.id).toBe(targetId);
    });
  });
}
