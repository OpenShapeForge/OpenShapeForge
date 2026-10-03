// SPDX-License-Identifier: BUSL-1.1
/**
 * A row every public boundary serializes must satisfy the record schema the
 * canonical catalogue, OpenAPI and MCP project for its entity. The rows here
 * are what the driver hands the runtime for each manifest column type — a
 * numeric as text, a bigint as text, a timestamp as text — plus the number
 * and bigint values a handler or a fixture may produce, so a schema that
 * says "string" is held to the wire and the wire to the schema.
 */
import { describe, expect, test } from "bun:test";
import openApi from "../../generated/rest/openapi.json" with { type: "json" };
import mcpCatalog from "../../generated/mcp/tools.json" with { type: "json" };
import { getGeneratedCrudTables } from "./catalog.js";
import { createOperationAjv } from "../operation-ajv.js";
import { serializeEntityRow } from "./serialize-result.js";
import type { GeneratedCrudColumn, GeneratedEntityRow } from "./types.js";

const ajv = createOperationAjv();

/** What Postgres hands the runtime for a column of this type, and what a handler might. */
function storedValues(column: GeneratedCrudColumn): unknown[] {
  switch (column.type) {
    case "uuid":
      return ["11111111-1111-4111-8111-111111111111"];
    case "text":
      return ["text"];
    case "boolean":
      return [true];
    case "integer":
      return [42];
    case "bigint":
      return ["9007199254740993", 9_007_199_254_740_993n, 2_147_483_648];
    case "numeric":
      return ["12.50", 12.5, "-0.001"];
    case "date":
      return ["2026-09-20"];
    case "timestamptz":
      return ["2026-09-20T10:00:00.000Z"];
    case "jsonb":
      return [{ any: "value" }];
    default:
      return [["text"]];
  }
}

type Schema = Record<string, unknown>;

/** The record schema each transport projects for an entity, by entity name. */
function projectedRecordSchemas(): Map<string, { transport: string; schema: Schema }[]> {
  const schemas = new Map<string, { transport: string; schema: Schema }[]>();
  const add = (entity: string, transport: string, schema: Schema) =>
    schemas.set(entity, [...(schemas.get(entity) ?? []), { transport, schema }]);
  const components = (openApi as { components: { schemas: Record<string, Schema> } }).components.schemas;
  for (const table of getGeneratedCrudTables()) {
    const entity = table.source?.authoringEntityName;
    if (entity && components[entity] && table.source?.rest) {
      // A record component references only the shared field-definition
      // component; `$defs` is how the strict validator resolves it.
      const referenced = JSON.parse(
        JSON.stringify(components[entity]).replaceAll("#/components/schemas/", "#/$defs/"),
      ) as Schema;
      add(entity, "REST", { ...referenced, $defs: components } as Schema);
    }
  }
  for (const tool of (mcpCatalog as { tools: { entity: string; operation: string; outputSchema: Schema }[] }).tools) {
    if (tool.operation !== "get") continue;
    const success = (tool.outputSchema.oneOf as Schema[])[0]!;
    const data = (success.properties as Record<string, Schema>).data;
    if (data?.properties) add(tool.entity, "MCP", { ...data, $defs: tool.outputSchema.$defs } as Schema);
  }
  return schemas;
}

describe("serialized rows satisfy every projected record schema", () => {
  const tables = new Map(getGeneratedCrudTables().map((table) => [table.source?.authoringEntityName, table]));
  const projected = projectedRecordSchemas();
  expect(projected.size).toBeGreaterThan(50);

  test.each([...projected.entries()])("%s", (entityName, schemas) => {
    const table = tables.get(entityName)!;
    const variants = Math.max(...table.columns.map((column) => storedValues(column).length));
    for (const { transport, schema } of schemas) {
      const validate = ajv.compile(schema);
      for (let variant = 0; variant < variants; variant += 1) {
        const stored: GeneratedEntityRow = {};
        for (const column of table.columns) {
          const values = storedValues(column);
          stored[column.name] = values[Math.min(variant, values.length - 1)];
        }
        const row = serializeEntityRow(table, stored);
        const valid = validate(row);
        expect(valid ? "valid" : `${transport} ${entityName}: ${ajv.errorsText(validate.errors)}`).toBe("valid");
      }
    }
  });
});
