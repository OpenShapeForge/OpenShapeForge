// SPDX-License-Identifier: BUSL-1.1
/**
 * Security behavior per generated entity: unauthenticated rejection and
 * cross-tenant RLS isolation — other tenants see nothing, cannot delete,
 * and the event journal is tenant-isolated too.
 *
 * Shape-aware through e2e/gql-shapes.ts. UNAUTHENTICATED is the one refusal
 * both generations throw at the top level (it precedes dispatch), so the
 * assertion below is shape-independent once the document itself validates.
 */
import { expect } from "bun:test";
import {
  describe,
  eventsFor,
  gql,
  registerSuiteLifecycle,
  tenantA,
  tenantB,
  test,
} from "./e2e/harness.js";
import { createRow, graphqlTables as tables } from "./e2e/entity-factory.js";
import {
  collectionOf,
  deleteDoc,
  deleteVariables,
  fetchRecord,
  listDoc,
} from "./e2e/gql-shapes.js";
import { isEntityBackedCreate, placeholderControls } from "./e2e/operations.js";

registerSuiteLifecycle();

for (const table of tables) {
  const graphql = table.source!.graphql!;
  const typeName = graphql.typeName;

  describe(`${typeName} (${table.name}) security`, () => {
    test("unauthenticated requests are rejected", async () => {
      const result = await gql(null, listDoc(table, { args: "first: 1", totalCount: true }));
      expect(result.errors?.[0]?.extensions?.code).toBe("UNAUTHENTICATED");
    });

    if (table.tenantScoped) {
      test("rows are invisible to other tenants (RLS)", async () => {
        const id = await createRow(table, tenantA);

        expect(await fetchRecord(tenantB, table, id)).toBeNull();

        const otherList = collectionOf(
          table,
          await gql(
            tenantB,
            listDoc(table, { variables: ["filter"], args: "first: 1", totalCount: true }),
            { filter: { id } },
          ),
          graphql.listQueryName,
        );
        expect(otherList.totalCount).toBe(0);

        // A cross-tenant delete must not remove the row for its owner. The
        // other tenant cannot hold a lease on a row it cannot see, so the
        // attempt carries placeholder controls; whichever check refuses it,
        // the row must survive.
        await gql(
          tenantB,
          deleteDoc(table),
          deleteVariables(table, id, placeholderControls(table, "delete")),
        );
        expect((await fetchRecord(tenantA, table, id))?.id).toBe(id);

        // The failed delete must not journal an event, and the journal itself
        // is tenant-isolated: tenant B sees no events for tenant A's row.
        // (A plugin-backed create journals nothing through the generic core;
        // see entity-events.)
        const ownerEvents = await eventsFor(tenantA, table, id);
        expect(ownerEvents.map((event) => event.eventType)).toEqual(
          isEntityBackedCreate(table) ? ["created"] : [],
        );
        expect(await eventsFor(tenantB, table, id)).toEqual([]);
      });
    }
  });
}
