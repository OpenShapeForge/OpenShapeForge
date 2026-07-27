// SPDX-License-Identifier: BUSL-1.1
/**
 * Function-level (operation/role) authorization on generated resolvers (#94)
 * and field-level data-classification protection (#96/#101).
 *
 * A read-only principal (holding only `Relaties.All.Read`) must be:
 *   - ALLOWED to read (single + list),
 *   - REJECTED with FORBIDDEN on create/update/delete,
 *   - and, where a classified column exists, served the row with that column
 *     redacted (a write grant is required to read pii/bsn/confidential data).
 *
 * A role-less principal must be rejected on every operation. These prove the
 * compiled per-operation roles now reach and are enforced at runtime, closing
 * the broken-function-level-authorization gap.
 */
import { expect } from "bun:test";
import {
  describe,
  expectData,
  gql,
  registerSuiteLifecycle,
  tenantA,
  test,
  type Identity,
} from "./e2e/harness.js";
import { createRow, fieldName, sampleValue, tables } from "./e2e/entity-factory.js";

registerSuiteLifecycle();

type Authorization = {
  roles: { read: string[]; create: string[]; update: string[]; delete: string[] };
};

// A read-only identity in tenant A: only the entity's read role, no write role.
// Derived per-entity from the manifest so the suite never drifts from authoring.
function readOnlyIdentity(readRoles: string[], writeRoles: string[]): Identity {
  const readOnlyRole = readRoles.find((role) => !writeRoles.includes(role)) ?? readRoles[0]!;
  return { tenantId: tenantA.tenantId, userId: tenantA.userId, roles: [readOnlyRole] };
}

const roleLess: Identity = {
  tenantId: tenantA.tenantId,
  userId: tenantA.userId,
  roles: [],
};

for (const table of tables) {
  const graphql = table.source!.graphql!;
  const typeName = graphql.typeName;
  const authorization = (table.source as { authorization?: Authorization } | undefined)?.authorization;

  // Only entities that declare per-operation roles participate — which, by the
  // fail-closed compiler, is every generated entity.
  if (!authorization) continue;

  const { read: readRoles, create, update, delete: del } = authorization.roles;
  const writeRoles = [...new Set([...create, ...update, ...del])];
  const reader = readOnlyIdentity(readRoles, writeRoles);

  describe(`${typeName} (${table.name}) function-level authorization`, () => {
    test("read-only role is ALLOWED to list", async () => {
      const data = await expectData(
        reader,
        `{ ${graphql.listQueryName}(first: 1) { totalCount } }`,
      );
      expect(typeof data[graphql.listQueryName].totalCount).toBe("number");
    });

    test("read-only role is ALLOWED to read a single row", async () => {
      // Seed with a full write-grant identity, then read it back as read-only.
      const id = await createRow(table, tenantA);
      const data = await expectData(
        reader,
        `query($id: ID!) { ${graphql.singleQueryName}(id: $id) { id } }`,
        { id },
      );
      expect(data[graphql.singleQueryName]?.id).toBe(id);
    });

    test("read-only role is REJECTED (FORBIDDEN) on create", async () => {
      const result = await gql(
        reader,
        `mutation { ${graphql.createMutationName}(input: {}) { id } }`,
      );
      expect(result.errors?.[0]?.extensions?.code).toBe("FORBIDDEN");
    });

    test("read-only role is REJECTED (FORBIDDEN) on update", async () => {
      const id = await createRow(table, tenantA);
      const result = await gql(
        reader,
        `mutation($id: ID!) { ${graphql.updateMutationName}(input: { id: $id }) { id } }`,
        { id },
      );
      expect(result.errors?.[0]?.extensions?.code).toBe("FORBIDDEN");
    });

    test("read-only role is REJECTED (FORBIDDEN) on delete; the row survives", async () => {
      const id = await createRow(table, tenantA);
      const result = await gql(
        reader,
        `mutation($id: ID!) { ${graphql.deleteMutationName}(id: $id) }`,
        { id },
      );
      expect(result.errors?.[0]?.extensions?.code).toBe("FORBIDDEN");

      // The rejected delete must not have removed the row.
      const stillThere = await expectData(
        tenantA,
        `query($id: ID!) { ${graphql.singleQueryName}(id: $id) { id } }`,
        { id },
      );
      expect(stillThere[graphql.singleQueryName]?.id).toBe(id);
    });

    test("a role-less session is REJECTED (FORBIDDEN) on read", async () => {
      const result = await gql(
        roleLess,
        `{ ${graphql.listQueryName}(first: 1) { totalCount } }`,
      );
      expect(result.errors?.[0]?.extensions?.code).toBe("FORBIDDEN");
    });

    // Field-level redaction (#96/#101): where the entity carries a classified
    // column, a read-only reader sees it nulled while a write grant sees it.
    const classifiedColumns = table.columns.filter(
      (column) =>
        (column as { classification?: string }).classification !== undefined,
    );
    if (classifiedColumns.length > 0) {
      const fieldNameFor = (column: (typeof table.columns)[number]) =>
        column.sourceField ??
        column.name.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
      const selection = classifiedColumns.map(fieldNameFor).join(" ");

      test("classified columns are redacted for a read-only reader, visible to a writer", async () => {
        const id = await createRow(table, tenantA);
        const asWriter = await expectData(
          tenantA,
          `query($id: ID!) { ${graphql.singleQueryName}(id: $id) { id ${selection} } }`,
          { id },
        );
        const asReader = await expectData(
          reader,
          `query($id: ID!) { ${graphql.singleQueryName}(id: $id) { id ${selection} } }`,
          { id },
        );
        for (const column of classifiedColumns) {
          const field = fieldNameFor(column);
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
        const result = await gql(
          reader,
          `query($filter: ${typeName}Filter) {
             ${graphql.listQueryName}(filter: $filter, first: 1) { totalCount }
           }`,
          { filter: { [classifiedField]: probeValue } },
        );
        expect(result.errors?.[0]?.extensions?.code).toBe("FORBIDDEN");

        const fieldInResult = await gql(
          reader,
          "query($filter: " +
            typeName +
            "Filter) { " +
            graphql.listQueryName +
            "(filter: $filter, first: 1) { totalCount } }",
          { filter: { [classifiedField + "In"]: [probeValue] } },
        );
        expect(fieldInResult.errors?.[0]?.extensions?.code).toBe("FORBIDDEN");
      });

      test("read-only sort on a classified field is rejected before ordering can leak", async () => {
        const result = await gql(
          reader,
          `query($sort: ${typeName}Sort) {
             ${graphql.listQueryName}(sort: $sort, first: 1) { totalCount }
           }`,
          { sort: { field: classifiedField, direction: "asc" } },
        );
        expect(result.errors?.[0]?.extensions?.code).toBe("FORBIDDEN");
      });
    }
  });
}
