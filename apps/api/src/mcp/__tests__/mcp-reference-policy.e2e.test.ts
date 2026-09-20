// SPDX-License-Identifier: BUSL-1.1
/**
 * The reference-policy half of the MCP sweep: for every MCP entity, each
 * reference column an Operation writes (`writtenBy` — the invoice a
 * milestone's `invoice` transition names) is advertised as a filter only,
 * never as create or update input, and a create or update naming it is
 * refused as BAD_USER_INPUT naming the field and every writer. Which columns
 * those are comes from the manifest through the shared reference policy, the
 * same source the REST and GraphQL sweeps read.
 *
 * Run (cwd apps/api):
 *   set -o pipefail; bun test src/mcp/__tests__/mcp-reference-policy.e2e.test.ts 2>&1
 */
import { expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { tablesByName } from "../../graphql/__tests__/e2e/entity-factory.js";
import { isCanonical, isEntityBackedCreate } from "../../graphql/__tests__/e2e/operations.js";
import { expectWriterRefusal, operationWrittenReferences } from "../../graphql/__tests__/e2e/reference-policy.js";
import { createdRows, describe, registerSuiteLifecycle, tenantA, test } from "../../graphql/__tests__/e2e/harness.js";
import {
  advertisedSchema, argsFor, callTool, createArgs, mcpCreateTables, rpc, toolError, toolNameFor, toolPayload, type CrudOperation, type McpTable,
} from "./e2e/mcp-sweep.js";

registerSuiteLifecycle();

describe("generated MCP server: operation-written references", () => {
  for (const table of mcpCreateTables.filter((candidate) => isCanonical(candidate))) {
    const prefix = table.source!.mcp!.tools === "generic" ? `osf_*[${table.source!.authoringEntityName}]` : table.source!.mcp!.toolPrefix;
    const call = (operation: CrudOperation, args: Record<string, unknown> = {}) =>
      callTool(tenantA, toolNameFor(table as McpTable, operation), argsFor(table as McpTable, args));

    for (const reference of operationWrittenReferences(table, tablesByName)) {
      const { field, writers } = reference;

      test(`${prefix}: ${field} is written by ${writers.join(", ")} only — a filter, never create or update input`, async () => {
        const { body } = await rpc(tenantA, "tools/list");
        const tools = body.result.tools as { name: string; inputSchema: any }[];
        expect(advertisedSchema(tools, table as McpTable, "list").properties.filter.properties[field]).toMatchObject({ type: "string", format: "uuid" });
        expect(advertisedSchema(tools, table as McpTable, "update").properties.values.properties).not.toHaveProperty(field);
        if (isEntityBackedCreate(table)) expect(advertisedSchema(tools, table as McpTable, "create").properties).not.toHaveProperty(field);

        const refusedCreate = await call("create", { ...(await createArgs(table as McpTable, tenantA)), [field]: randomUUID() });
        expectWriterRefusal({ text: toolError(refusedCreate.body) }, field, writers);

        const created = await call("create", await createArgs(table as McpTable, tenantA));
        expect(toolError(created.body)).toBeUndefined();
        const row = toolPayload(created.body);
        createdRows.push({ table, id: row.id, identity: tenantA });
        expect(row[field] ?? null).toBeNull();

        const refusedUpdate = await call("update", { id: row.id, values: { [field]: randomUUID() } });
        expectWriterRefusal({ text: toolError(refusedUpdate.body) }, field, writers);
        const after = toolPayload((await call("get", { id: row.id })).body);
        expect(after[field] ?? null).toBeNull();
        expect(toolPayload((await call("list", { filter: { [field]: randomUUID() } })).body).items).toEqual([]);
      });
    }
  }
});
