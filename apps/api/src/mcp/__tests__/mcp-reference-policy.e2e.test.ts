// SPDX-License-Identifier: BUSL-1.1
/**
 * The reference-policy half of the MCP sweep: for every MCP entity, each
 * reference column an Operation writes (`writtenBy` — the invoice a
 * milestone's `invoice` transition names) is advertised as a filter only,
 * never as create or update input; a create or update naming it is refused
 * as BAD_USER_INPUT naming the field and every writer, whether the create is
 * entity- or plugin-backed; and the filter is no oracle across tenants. Which
 * columns those are comes from the manifest through the shared reference
 * policy, the same source the REST and GraphQL sweeps read.
 *
 * Run (cwd apps/api):
 *   set -o pipefail; bun test src/mcp/__tests__/mcp-reference-policy.e2e.test.ts 2>&1
 */
import { expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { createRow } from "../../graphql/__tests__/e2e/entity-factory.js";
import { isEntityBackedCreate } from "../../graphql/__tests__/e2e/operations.js";
import { expectCreateWriteRefusal, expectWriterRefusal, operationWrittenReferences, plantReference, referenceTarget } from "../../graphql/__tests__/e2e/reference-policy.js";
import { createdRows, describe, registerSuiteLifecycle, tenantA, tenantB, test, type Identity } from "../../graphql/__tests__/e2e/harness.js";
import {
  advertisedSchema, argsFor, callTool, createArgs, mcpCreateTables, rpc, toolError, toolNameFor, toolPayload, type CrudOperation, type McpTable,
} from "./e2e/mcp-sweep.js";

registerSuiteLifecycle();

describe("generated MCP server: operation-written references", () => {
  for (const table of mcpCreateTables as McpTable[]) {
    const prefix = table.source!.mcp!.tools === "generic" ? `osf_*[${table.source!.authoringEntityName}]` : table.source!.mcp!.toolPrefix;
    const call = (identity: Identity, operation: CrudOperation, args: Record<string, unknown> = {}) =>
      callTool(identity, toolNameFor(table, operation), argsFor(table, args));
    const listedIds = async (identity: Identity, field: string, value: string) =>
      toolPayload((await call(identity, "list", { filter: { [field]: value } })).body).items.map((item: any) => item.id);

    for (const reference of operationWrittenReferences(table)) {
      const { field, writers, column } = reference;
      // A partial-policy target (no create of its own) is seeded through the engine fixture.
      const targetTable = referenceTarget(reference);
      const target = (identity: Identity) => createRow(targetTable, identity);

      test(`${prefix}: ${field} is written by ${writers.join(", ")} only — a filter, never create or update input`, async () => {
        const { body } = await rpc(tenantA, "tools/list");
        const tools = body.result.tools as { name: string; inputSchema: any }[];
        expect((await advertisedSchema(tenantA, tools, table, "list")).properties.filter.properties[field]).toMatchObject({ type: "string", format: "uuid" });
        expect((await advertisedSchema(tenantA, tools, table, "update")).properties.values.properties).not.toHaveProperty(field);
        if (isEntityBackedCreate(table)) expect((await advertisedSchema(tenantA, tools, table, "create")).properties).not.toHaveProperty(field);

        const refusedCreate = await call(tenantA, "create", { ...(await createArgs(table, tenantA)), [field]: randomUUID() });
        expectCreateWriteRefusal(table, { text: toolError(refusedCreate.body) }, field, writers);

        const created = await call(tenantA, "create", await createArgs(table, tenantA));
        expect(toolError(created.body)).toBeUndefined();
        const row = toolPayload(created.body);
        createdRows.push({ table, id: row.id, identity: tenantA });
        const before = row[field] ?? null;

        const refusedUpdate = await call(tenantA, "update", { id: row.id, values: { [field]: randomUUID() } });
        expectWriterRefusal({ text: toolError(refusedUpdate.body) }, field, writers);
        expect(toolPayload((await call(tenantA, "get", { id: row.id })).body)[field] ?? null).toEqual(before);
      });

      test(`${prefix}: a filter on ${field} finds the row that carries it and never another tenant's rows`, async () => {
        // The value is another tenant's real key, on another tenant's real
        // row: row security answers with nothing, as a list without the
        // filter would. A row of this tenant that carries the value is found.
        const foreignTargetId = await target(tenantB);
        const foreignRow = toolPayload((await call(tenantB, "create", await createArgs(table, tenantB))).body);
        createdRows.push({ table, id: foreignRow.id, identity: tenantB });
        await plantReference(table, foreignRow.id, column, foreignTargetId);
        expect(await listedIds(tenantB, field, foreignTargetId)).toContain(foreignRow.id);
        expect(await listedIds(tenantA, field, foreignTargetId)).toEqual([]);

        const targetId = await target(tenantA);
        const row = toolPayload((await call(tenantA, "create", await createArgs(table, tenantA))).body);
        createdRows.push({ table, id: row.id, identity: tenantA });
        await plantReference(table, row.id, column, targetId);
        expect(await listedIds(tenantA, field, targetId)).toContain(row.id);
        expect(await listedIds(tenantA, field, randomUUID())).toEqual([]);
      });
    }
  }
});
