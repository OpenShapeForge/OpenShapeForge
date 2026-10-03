// SPDX-License-Identifier: BUSL-1.1
/**
 * Entity-event journal behavior per generated entity: every mutation appends
 * exactly one created/updated/deleted event (in-transaction, into
 * platform.entity_events), reads append nothing, and sequences increase
 * monotonically. Journal state is read through the same RLS session layer
 * the API uses and shown in the HTML report.
 *
 * Shape-aware through e2e/gql-shapes.ts: a canonical update or delete goes
 * through its lease and confirmation controls, which journal their own
 * events under the Operation's aggregate — not the entity's — so the CRUD
 * lifecycle read here is the same for both generations.
 */
import { expect } from "bun:test";
import {
  describe,
  eventsFor,
  gql,
  registerSuiteLifecycle,
  seed,
  tenantA,
  test,
} from "./e2e/harness.js";
import {
  createRow,
  fieldName,
  graphqlTables as tables,
  textColumnFor,
  untrackRow,
} from "./e2e/entity-factory.js";
import {
  collectionOf,
  expectDeleted,
  fetchRecord,
  listDoc,
  recordOf,
  updateRecord,
} from "./e2e/gql-shapes.js";
import { isEntityBackedCreate } from "./e2e/operations.js";

registerSuiteLifecycle();

for (const table of tables) {
  const graphql = table.source!.graphql!;
  const typeName = graphql.typeName;

  describe(`${typeName} (${table.name}) events`, () => {
    test("mutations append entity events; reads append none", async () => {
      const id = await createRow(table, tenantA);
      const afterCreate = await eventsFor(tenantA, table, id);
      const created = afterCreate.map((event) => event.eventType);
      // Plugin commands may persist through the generic core (and journal a
      // create) or own their transaction completely. Both are valid; reads
      // and refused writes below must not change the observed baseline.
      expect([[], ["created"]]).toContainEqual(created);
      // A realtime-projected entity also journals the columns its channel
      // filters on; the manifest says which, so the assertion follows it.
      if (created.length > 0) {
        expect(afterCreate[0]!.payload).toEqual({
          table: table.name,
          schema: table.schema,
          operation: "created",
          ...(table.realtime
            ? {
                visibility: Object.fromEntries(
                  table.realtime.visibilityColumns.map((column) => [column, expect.anything()]),
                ),
              }
            : {}),
        });
      }

      expect((await fetchRecord(tenantA, table, id))?.id).toBe(id);
      const listed = collectionOf(
        table,
        await gql(
          tenantA,
          listDoc(table, { variables: ["filter"], args: "first: 1", totalCount: true }),
          { filter: { id } },
        ),
        graphql.listQueryName,
      );
      expect(listed.totalCount).toBe(1);
      expect((await eventsFor(tenantA, table, id)).length).toBe(created.length);

      const updateColumn = textColumnFor(table);
      if (updateColumn) {
        const updated = await updateRecord(tenantA, table, id, {
          [fieldName(updateColumn)]: `e2e-evented-${seed}`,
        });
        expect(recordOf(table, updated, graphql.updateMutationName)?.id).toBe(id);
      }

      // A plugin-created row keeps the companion records its create made, and
      // the entity delete is authored to refuse while they exist — so its
      // lifecycle here ends at the update; entity-crud pins that refusal.
      const deletable = isEntityBackedCreate(table);
      if (deletable) {
        await expectDeleted(tenantA, table, id);
        untrackRow(id);
      }

      const lifecycle = await eventsFor(tenantA, table, id);
      expect(lifecycle.map((event) => event.eventType)).toEqual([
        ...created,
        ...(updateColumn ? ["updated"] : []),
        ...(deletable ? ["deleted"] : []),
      ]);
      const sequences = lifecycle.map((event) => BigInt(event.sequence));
      expect([...sequences].sort((a, b) => (a < b ? -1 : 1))).toEqual(sequences);
    });
  });
}
