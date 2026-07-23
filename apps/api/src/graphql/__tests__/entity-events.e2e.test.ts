// SPDX-License-Identifier: BUSL-1.1
/**
 * Entity-event journal behavior per generated entity: every mutation appends
 * exactly one created/updated/deleted event (in-transaction, into
 * platform.entity_events), reads append nothing, and sequences increase
 * monotonically. Journal state is read through the same RLS session layer
 * the API uses and shown in the HTML report.
 */
import { expect } from "bun:test";
import {
  describe,
  eventsFor,
  expectData,
  registerSuiteLifecycle,
  seed,
  tenantA,
  test,
} from "./e2e/harness.js";
import {
  createRow,
  fieldName,
  tables,
  textColumnFor,
  untrackRow,
} from "./e2e/entity-factory.js";

registerSuiteLifecycle();

for (const table of tables) {
  const graphql = table.source!.graphql!;
  const typeName = graphql.typeName;

  describe(`${typeName} (${table.name}) events`, () => {
    test("mutations append entity events; reads append none", async () => {
      const id = await createRow(table, tenantA);
      const afterCreate = await eventsFor(tenantA, table, id);
      expect(afterCreate.map((event) => event.eventType)).toEqual(["created"]);
      expect(afterCreate[0]!.payload).toEqual({
        table: table.name,
        schema: table.schema,
        operation: "created",
      });

      await expectData(
        tenantA,
        `query($id: ID!) { ${graphql.singleQueryName}(id: $id) { id } }`,
        { id },
      );
      await expectData(
        tenantA,
        `query($filter: ${typeName}Filter) {
           ${graphql.listQueryName}(filter: $filter, first: 1) { totalCount }
         }`,
        { filter: { id } },
      );
      expect((await eventsFor(tenantA, table, id)).length).toBe(1);

      const updateColumn = textColumnFor(table);
      if (updateColumn) {
        await expectData(
          tenantA,
          `mutation($input: Update${typeName}Input!) {
             ${graphql.updateMutationName}(input: $input) { id }
           }`,
          { input: { id, [fieldName(updateColumn)]: `e2e-evented-${seed}` } },
        );
      }

      await expectData(
        tenantA,
        `mutation($id: ID!) { ${graphql.deleteMutationName}(id: $id) }`,
        { id },
      );
      untrackRow(id);

      const lifecycle = await eventsFor(tenantA, table, id);
      expect(lifecycle.map((event) => event.eventType)).toEqual(
        updateColumn ? ["created", "updated", "deleted"] : ["created", "deleted"],
      );
      const sequences = lifecycle.map((event) => BigInt(event.sequence));
      expect([...sequences].sort((a, b) => (a < b ? -1 : 1))).toEqual(sequences);
    });
  });
}
