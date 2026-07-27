// SPDX-License-Identifier: BUSL-1.1
/**
 * Function-level (operation/role) authorization on generated entities (#94)
 * and field-level data-classification protection (#96/#101), manifest-driven
 * per generated entity.
 *
 * A read-only principal must be:
 *   - ALLOWED to read (single + list) and to traverse relationships,
 *   - REJECTED with FORBIDDEN on create/update/delete (empty-body update
 *     included) without journaling an entity event,
 *   - and, where a classified column exists, served the row with that column
 *     redacted — and refused any filter/sort on it, which would otherwise leak
 *     the value through totalCount or ordering.
 *
 * A role-less principal is denied every operation. The authored (Dutch) role
 * spelling must keep working alongside the Keycloak-normalized (English) one,
 * since the compiler emits the union of both. All identities share tenant A so
 * role denial is isolated from RLS/tenant denial.
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
import {
  createRow,
  fieldName,
  sampleValue,
  tables,
  tablesByTypeName,
} from "./e2e/entity-factory.js";

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

      // The rejected delete must not have removed the row.
      const stillThere = await expectData(
        tenantA,
        `query($id: ID!) { ${graphql.singleQueryName}(id: $id) { id } }`,
        { id },
      );
      expect(stillThere[graphql.singleQueryName]?.id).toBe(id);
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

    // Field-level redaction (#96/#101): where the entity carries a classified
    // column, a read-only reader sees it nulled while a write grant sees it.
    const classifiedColumns = table.columns.filter(
      (column) => (column as { classification?: string }).classification !== undefined,
    );
    if (classifiedColumns.length > 0) {
      const selection = classifiedColumns.map(fieldName).join(" ");

      test("classified columns are redacted for a read-only reader, visible to a writer", async () => {
        const id = await createRow(table, tenantA);
        const asWriter = await expectData(
          tenantA,
          `query($id: ID!) { ${graphql.singleQueryName}(id: $id) { id ${selection} } }`,
          { id },
        );
        const asReader = await expectData(
          readOnly,
          `query($id: ID!) { ${graphql.singleQueryName}(id: $id) { id ${selection} } }`,
          { id },
        );
        for (const column of classifiedColumns) {
          const field = fieldName(column);
          expect(asReader[graphql.singleQueryName][field]).toBeNull();
          // The writer sees the real value (created rows populate required
          // columns; optional classified columns may legitimately be null).
          if (column.required) {
            expect(asWriter[graphql.singleQueryName][field]).not.toBeNull();
          }
        }
      });

      const classifiedColumn = classifiedColumns[0]!;
      const classifiedField = fieldName(classifiedColumn);
      const probeValue = sampleValue(classifiedColumn, "classified-query");

      test("read-only filter on a classified field is rejected before totalCount can leak", async () => {
        await expectForbidden(
          readOnly,
          `query($filter: ${typeName}Filter) {
             ${graphql.listQueryName}(filter: $filter, first: 1) { totalCount }
           }`,
          { filter: { [classifiedField]: probeValue } },
        );
        await expectForbidden(
          readOnly,
          `query($filter: ${typeName}Filter) {
             ${graphql.listQueryName}(filter: $filter, first: 1) { totalCount }
           }`,
          { filter: { [`${classifiedField}In`]: [probeValue] } },
        );
      });

      test("read-only sort on a classified field is rejected before ordering can leak", async () => {
        await expectForbidden(
          readOnly,
          `query($sort: ${typeName}Sort) {
             ${graphql.listQueryName}(sort: $sort, first: 1) { totalCount }
           }`,
          { sort: { field: classifiedField, direction: "asc" } },
        );
      });
    }
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
