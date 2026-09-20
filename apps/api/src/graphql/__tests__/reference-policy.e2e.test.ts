// SPDX-License-Identifier: BUSL-1.1
/**
 * The reference-policy half of the GraphQL sweep: for every GraphQL entity,
 * each reference column an Operation writes (`writtenBy`) is absent from the
 * create (entity-backed) and update input types — so a mutation naming it
 * is refused by schema validation, before dispatch, with the input type's
 * note naming every writer — and a list filter on it finds the row that
 * carries the value and never another tenant's. Which columns those are
 * comes from the manifest through the shared reference policy, the same
 * source the MCP and REST sweeps read.
 *
 * Run (cwd apps/api):
 *   set -o pipefail; bun test src/graphql/__tests__/reference-policy.e2e.test.ts 2>&1
 */
import { expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { createInput, createRow, graphqlTables as tables, tablesByName } from "./e2e/entity-factory.js";
import { collectionOf, createDoc, fetchRecord, listDoc, updateDoc } from "./e2e/gql-shapes.js";
import { isEntityBackedCreate } from "./e2e/operations.js";
import { operationWrittenReferences, plantReference } from "./e2e/reference-policy.js";
import { describe, gql, registerSuiteLifecycle, tenantA, tenantB, test, type Identity } from "./e2e/harness.js";

registerSuiteLifecycle();

const INTROSPECT_INPUT = `query($name: String!) { __type(name: $name) { description inputFields { name } } }`;

describe("GraphQL transport: operation-written references", () => {
  for (const table of tables) {
    const graphql = table.source!.graphql!;
    if (graphql.operations?.create === false) continue;
    const typeName = graphql.typeName;
    const listedIds = async (identity: Identity, field: string, value: string) => {
      const doc = listDoc(table, { variables: ["filter"], args: "first: 10", selection: "id" });
      return collectionOf(table, await gql(identity, doc, { filter: { [field]: value } }), graphql.listQueryName).items.map((item: any) => item.id);
    };

    for (const reference of operationWrittenReferences(table, tablesByName)) {
      const { field, writers, column } = reference;
      const targetTable = tablesByName.get(reference.targetTable)!;

      test(`${typeName}: ${field} is written by ${writers.join(", ")} only — omitted from the input types, which say so`, async () => {
        for (const input of [...(isEntityBackedCreate(table) ? [`Create${typeName}Input`] : []), `Update${typeName}Input`]) {
          const { data } = await gql(tenantA, INTROSPECT_INPUT, { name: input });
          expect(data?.__type).toBeTruthy();
          expect(data!.__type.inputFields.map((entry: { name: string }) => entry.name)).not.toContain(field);
          // Schema validation precedes dispatch, so the refusal is the schema's;
          // the input type's description is where a client learns who writes it.
          expect(data!.__type.description).toContain(field);
          for (const writer of writers) expect(data!.__type.description).toContain(writer);
        }

        if (isEntityBackedCreate(table)) {
          const refusedCreate = await gql(tenantA, createDoc(table), { input: { ...(await createInput(table, tenantA)), [field]: randomUUID() } });
          expect(refusedCreate.data ?? null).toBeNull();
          expect(JSON.stringify(refusedCreate.errors)).toContain(`Field \\"${field}\\" is not defined by type \\"Create${typeName}Input\\"`);
        }
        const id = await createRow(table, tenantA);
        const refusedUpdate = await gql(tenantA, updateDoc(table), { input: { id, [field]: randomUUID() } });
        expect(refusedUpdate.data ?? null).toBeNull();
        expect(JSON.stringify(refusedUpdate.errors)).toContain(`Field \\"${field}\\" is not defined by type \\"Update${typeName}Input\\"`);
        expect((await fetchRecord(tenantA, table, id, `id ${field} { id }`))?.[field] ?? null).toBeNull();
      });

      test(`${typeName}: a filter on ${field} finds the row that carries it and never another tenant's rows`, async () => {
        const foreignTargetId = await createRow(targetTable, tenantB);
        const foreignId = await createRow(table, tenantB);
        await plantReference(table, foreignId, column, foreignTargetId);
        expect(await listedIds(tenantB, field, foreignTargetId)).toEqual([foreignId]);
        expect(await listedIds(tenantA, field, foreignTargetId)).toEqual([]);

        const targetId = await createRow(targetTable, tenantA);
        const id = await createRow(table, tenantA);
        await plantReference(table, id, column, targetId);
        expect(await listedIds(tenantA, field, targetId)).toEqual([id]);
        expect(await listedIds(tenantA, field, randomUUID())).toEqual([]);
      });
    }
  }
});
