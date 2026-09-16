// SPDX-License-Identifier: BUSL-1.1
/**
 * Security behavior per generated entity: unauthenticated rejection and
 * cross-tenant RLS isolation — other tenants see nothing, cannot delete,
 * and the event journal is tenant-isolated too.
 */
import { expect } from "bun:test";
import {
  describe,
  eventsFor,
  expectData,
  gql,
  registerSuiteLifecycle,
  tenantA,
  tenantB,
  test,
} from "./e2e/harness.js";
import { createRow, tables } from "./e2e/entity-factory.js";

registerSuiteLifecycle();

for (const table of tables) {
  const graphql = table.source!.graphql!;
  const typeName = graphql.typeName;

  describe(`${typeName} (${table.name}) security`, () => {
    test("unauthenticated requests are rejected", async () => {
      const result = await gql(null, `{ ${graphql.listQueryName}(first: 1) { totalCount } }`);
      expect(result.errors?.[0]?.extensions?.code).toBe("UNAUTHENTICATED");
    });

    if (table.tenantScoped) {
      test("rows are invisible to other tenants (RLS)", async () => {
        const id = await createRow(table, tenantA);

        const otherGet = await expectData(
          tenantB,
          `query($id: ID!) { ${graphql.singleQueryName}(id: $id) { id } }`,
          { id },
        );
        expect(otherGet[graphql.singleQueryName]).toBeNull();

        const otherList = await expectData(
          tenantB,
          `query($filter: ${typeName}Filter) {
             ${graphql.listQueryName}(filter: $filter, first: 1) { totalCount }
           }`,
          { filter: { id } },
        );
        expect(otherList[graphql.listQueryName].totalCount).toBe(0);

        // A cross-tenant delete must not remove the row for its owner.
        await gql(tenantB, `mutation($id: ID!) { ${graphql.deleteMutationName}(id: $id) }`, {
          id,
        });
        const stillThere = await expectData(
          tenantA,
          `query($id: ID!) { ${graphql.singleQueryName}(id: $id) { id } }`,
          { id },
        );
        expect(stillThere[graphql.singleQueryName]?.id).toBe(id);

        // The failed delete must not journal an event, and the journal itself
        // is tenant-isolated: tenant B sees no events for tenant A's row.
        const ownerEvents = await eventsFor(tenantA, table, id);
        expect(ownerEvents.map((event) => event.eventType)).toEqual(["created"]);
        expect(await eventsFor(tenantB, table, id)).toEqual([]);
      });
    }
  });
}
