/**
 * Relationship traversal per generated entity: belongsTo resolution and
 * hasMany lists with aggregate counts, derived from the manifest's
 * relationship metadata.
 */
import { expect } from "bun:test";
import {
  describe,
  expectData,
  registerSuiteLifecycle,
  tenantA,
  test,
} from "./e2e/harness.js";
import { createRow, fieldName, tables, tablesByTypeName } from "./e2e/entity-factory.js";

registerSuiteLifecycle();

for (const table of tables) {
  const graphql = table.source!.graphql!;
  const relationships = (graphql.relationships ?? []).filter((relationship) =>
    tablesByTypeName.has(relationship.target),
  );
  if (relationships.length === 0) continue;

  describe(`${graphql.typeName} (${table.name}) relationships`, () => {
    for (const relationship of relationships) {
      const targetTable = tablesByTypeName.get(relationship.target)!;

      if (relationship.resolve === "belongsTo") {
        test(`belongsTo ${relationship.name} -> ${relationship.target}`, async () => {
          const targetId = await createRow(targetTable, tenantA);
          const fkColumn = table.columns.find(
            (column) => column.name === relationship.foreignKey,
          );
          expect(fkColumn).toBeTruthy();
          const id = await createRow(table, tenantA, { [fieldName(fkColumn!)]: targetId });
          const data = await expectData(
            tenantA,
            `query($id: ID!) {
               ${graphql.singleQueryName}(id: $id) { id ${relationship.name} { id } }
             }`,
            { id },
          );
          expect(data[graphql.singleQueryName][relationship.name]?.id).toBe(targetId);
        });
      }

      if (relationship.resolve === "hasMany") {
        test(`hasMany ${relationship.name} -> ${relationship.target}`, async () => {
          const parentId = await createRow(table, tenantA);
          const childFkColumn = targetTable.columns.find(
            (column) => column.name === relationship.foreignKey,
          );
          expect(childFkColumn).toBeTruthy();
          const childId = await createRow(targetTable, tenantA, {
            [fieldName(childFkColumn!)]: parentId,
          });
          const data = await expectData(
            tenantA,
            `query($id: ID!) {
               ${graphql.singleQueryName}(id: $id) {
                 id
                 ${relationship.name} { id }
                 ${relationship.name}Aggregate { count }
               }
             }`,
            { id: parentId },
          );
          const childIds = data[graphql.singleQueryName][relationship.name].map(
            (row: { id: string }) => row.id,
          );
          expect(childIds).toContain(childId);
          expect(
            data[graphql.singleQueryName][`${relationship.name}Aggregate`].count,
          ).toBeGreaterThanOrEqual(1);
        });
      }
    }
  });
}
