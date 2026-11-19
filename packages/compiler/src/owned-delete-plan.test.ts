// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import type { CompiledEntityContract, CompiledRelationship } from "./authoring/types.js";
import type { TableDefinition } from "./schema.js";
import { compileOwnedDeletePlan } from "./owned-delete-plan.js";

const owned = (field: string, target: string, foreignKey: string): CompiledRelationship => ({
  kind: "hasMany", key: field, fieldKey: field, ownership: "owned", target, foreignKey,
});

function entity(name: string, relationships: CompiledRelationship[] = []): CompiledEntityContract {
  return { entity: { name }, model: { fields: [], relationships } } as unknown as CompiledEntityContract;
}

function table(entity: string, schema: string, name: string, parent?: [string, string, string]): TableDefinition {
  return {
    schema, name, tenantScoped: true, source: { authoringEntityName: entity },
    columns: [
      { name: "id", type: "uuid", primaryKey: true }, { name: "tenant_id", type: "uuid" },
      ...(parent ? [{
        name: parent[2], type: "uuid" as const,
        references: {
          schema: parent[0], table: parent[1], column: "id",
          localColumns: ["tenant_id", parent[2]], targetColumns: ["tenant_id", "id"],
        },
      }] : []),
    ],
  };
}

test("owned delete emits independent ownership, lock and write order from the composed model", () => {
  const models = [
    entity("Budget", [owned("lines", "Line", "budget_id")]),
    entity("Line", [owned("values", "Value", "line_id")]),
    entity("Value"),
  ];
  const tables = [
    table("Budget", "erp", "budgets"), table("Line", "erp", "lines", ["erp", "budgets", "budget_id"]),
    table("Value", "forecast", "values", ["erp", "lines", "line_id"]),
  ];
  const plan = compileOwnedDeletePlan("Budget", models, tables);
  expect(plan.discover.map(step => step.entity)).toEqual(["Budget", "Line", "Value"]);
  expect(plan.lockOrder).toEqual(["Budget", "Line", "Value"]);
  expect(plan.writeOrder).toEqual(["Value", "Line", "Budget"]);
  expect(plan.discover[2]!.remove).toContain('AND "line_id" = ANY($3::uuid[]) RETURNING id');
  expect(plan.discover[0]!.lock).toContain("ORDER BY id FOR UPDATE");
  expect(compileOwnedDeletePlan("Budget", [...models].reverse(), [...tables].reverse())).toEqual(plan);
});

test("owned delete refuses a non-tenant foreign key and recursive ownership", () => {
  const models = [entity("Root", [owned("children", "Child", "root_id")]), entity("Child")];
  const root = table("Root", "erp", "roots");
  const child = table("Child", "erp", "children", ["erp", "roots", "root_id"]);
  const relation = child.columns.find(column => column.name === "root_id")!.references!;
  delete relation.localColumns;
  expect(() => compileOwnedDeletePlan("Root", models, [root, child])).toThrow("tenant-bound FK");
  relation.localColumns = ["tenant_id", "root_id"];
  models[1]!.model.relationships.push(owned("parents", "Root", "child_id"));
  root.columns.push({
    name: "child_id", type: "uuid", references: {
      schema: "erp", table: "children", column: "id",
      localColumns: ["tenant_id", "child_id"], targetColumns: ["tenant_id", "id"],
    },
  });
  expect(() => compileOwnedDeletePlan("Root", models, [root, child])).toThrow("Repeated or unresolved target");
});
