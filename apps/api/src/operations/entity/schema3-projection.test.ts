// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { parse, Kind } from "graphql";
import { renderTypeDefinition } from "../../graphql/generated-entity-schema.js";
import { __describeToolForTests as describeTool } from "../../mcp/generated-mcp-server.js";
import { getGeneratedCrudTables } from "./catalog.js";

test("schema-3 GraphQL exposes a relation once, not both scalar and entity under the field key", () => {
  const original = getGeneratedCrudTables().find((table) => table.source?.authoringEntityName === "Relation")!;
  const table = structuredClone(original);
  table.source!.authoringVersion = 3;
  table.columns.push({ name: "owner_id", sourceField: "owner", type: "uuid", required: false, primaryKey: false, generated: null });
  table.source!.graphql!.relationships = [{ name: "owner", fieldKey: "owner", kind: "belongsTo", type: "Relation", target: "Relation", resolve: "belongsTo", foreignKey: "owner_id" }];
  const definition = parse(renderTypeDefinition(table)).definitions.find((definition) => definition.kind === Kind.OBJECT_TYPE_DEFINITION && definition.name.value === "Relation");
  if (!definition || definition.kind !== Kind.OBJECT_TYPE_DEFINITION) throw new Error("Missing Relation type");
  const owners = definition.fields!.filter((field) => field.name.value === "owner");
  expect(owners).toHaveLength(1);
  expect(owners[0]!.type).toMatchObject({ kind: Kind.NAMED_TYPE, name: { value: "Relation" } });
});

test("MCP live tools do not advertise unsupported collection values", () => {
  const table = structuredClone(getGeneratedCrudTables().find((table) => table.source?.authoringEntityName === "Relation")!);
  table.source!.authoringVersion = 3;
  table.source!.graphql!.relationships = [{ name: "blocks", fieldKey: "blocks", type: "[Relation!]!", target: "Relation", resolve: "hasMany", via: "relation_blocks", mutationSupport: "unsupported" }];
  const projected = describeTool({
    name: "create_relation", operation: "create", entity: "Relation", table: table.name, description: "Creates a fixture",
    inputSchema: { type: "object", properties: { values: { type: "object", properties: { blocks: { type: "array" }, displayName: { type: "string" } }, required: ["blocks"] } } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    errors: [],
  }, undefined, table, { roles: [] });
  expect(projected.inputSchema).toMatchObject({ properties: { values: { properties: { displayName: { type: "string" } }, required: [] } } });
  expect(JSON.stringify(projected.inputSchema)).not.toContain('"blocks"');
});
