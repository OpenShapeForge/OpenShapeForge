// SPDX-License-Identifier: BUSL-1.1
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
import {
  createRow,
  fieldName,
  foreignKeyTargets,
  isMutableColumn,
  tables,
  tablesByTypeName,
} from "./e2e/entity-factory.js";

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

      // Subtype relationships cannot be driven generically: LegalEntity's
      // hasMany contactMoments joins on contact_moments.relation_id, whose
      // FOREIGN KEY references erp.relations — a row this factory creates in
      // erp.legal_entities does not exist there, so setting the child's FK to
      // the parent's id violates the constraint. Skip when the FK's emitted
      // target is a different table than the one this test would create in.
      const fkOwner = relationship.resolve === "belongsTo" ? table : targetTable;
      const fkRowTable = relationship.resolve === "belongsTo" ? targetTable : table;
      const emittedTarget =
        relationship.foreignKey === undefined
          ? undefined
          : foreignKeyTargets(fkOwner).get(relationship.foreignKey);
      if (emittedTarget !== undefined && emittedTarget !== fkRowTable.name) continue;

      // The engine populates tenant_id from the session; no input can set it.
      // Driving such a relationship means asserting against the session's own
      // tenant row (which the harness seeds), not against a created target.
      // The FK column lives on this table for belongsTo and on the target
      // table for hasMany.
      const sessionScoped = (owner: typeof table, columnName: string | undefined) => {
        const column = owner.columns.find((c) => c.name === columnName);
        return column !== undefined && !isMutableColumn(column);
      };

      if (
        relationship.resolve === "belongsTo" &&
        sessionScoped(table, relationship.foreignKey)
      ) {
        test(`belongsTo ${relationship.name} resolves the session tenant`, async () => {
          const id = await createRow(table, tenantA);
          const data = await expectData(
            tenantA,
            `query($id: ID!) {
               ${graphql.singleQueryName}(id: $id) { id ${relationship.name} { id } }
             }`,
            { id },
          );
          expect(data[graphql.singleQueryName][relationship.name]?.id).toBe(tenantA.tenantId);
        });
      } else if (relationship.resolve === "belongsTo") {
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

      if (
        relationship.resolve === "hasMany" &&
        sessionScoped(targetTable, relationship.foreignKey)
      ) {
        test(`hasMany ${relationship.name} lists the session tenant's rows`, async () => {
          const childId = await createRow(targetTable, tenantA);
          const data = await expectData(
            tenantA,
            `query($id: ID!) {
               ${graphql.singleQueryName}(id: $id) {
                 id
                 ${relationship.name} { id }
                 ${relationship.name}Aggregate { count }
               }
             }`,
            { id: tenantA.tenantId },
          );
          const childIds = data[graphql.singleQueryName][relationship.name].map(
            (row: { id: string }) => row.id,
          );
          expect(childIds).toContain(childId);
          expect(
            data[graphql.singleQueryName][`${relationship.name}Aggregate`].count,
          ).toBeGreaterThanOrEqual(1);
        });
      } else if (relationship.resolve === "hasMany") {
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
