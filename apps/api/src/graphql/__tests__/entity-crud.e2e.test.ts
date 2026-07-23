/**
 * Core CRUD lifecycle per generated entity: create/get, filtered lists,
 * cursor pagination, sorting, updates, and deletes — all derived from the
 * generated db manifest, so new entities are covered automatically.
 */
import { expect } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  describe,
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

  describe(`${typeName} (${table.name})`, () => {
    test("create + get by id", async () => {
      const id = await createRow(table, tenantA);
      const data = await expectData(
        tenantA,
        `query($id: ID!) { ${graphql.singleQueryName}(id: $id) { id } }`,
        { id },
      );
      expect(data[graphql.singleQueryName]?.id).toBe(id);
    });

    test("list with filter (eq and In) + totalCount", async () => {
      const id = await createRow(table, tenantA);
      const eq = await expectData(
        tenantA,
        `query($filter: ${typeName}Filter) {
           ${graphql.listQueryName}(filter: $filter, first: 10) {
             totalCount edges { node { id } }
           }
         }`,
        { filter: { id } },
      );
      expect(eq[graphql.listQueryName].totalCount).toBe(1);
      expect(eq[graphql.listQueryName].edges[0].node.id).toBe(id);

      const inFilter = await expectData(
        tenantA,
        `query($filter: ${typeName}Filter) {
           ${graphql.listQueryName}(filter: $filter, first: 10) { totalCount }
         }`,
        { filter: { idIn: [id, randomUUID()] } },
      );
      expect(inFilter[graphql.listQueryName].totalCount).toBe(1);
    });

    test("cursor pagination walks all pages without overlap", async () => {
      const ids = [
        await createRow(table, tenantA),
        await createRow(table, tenantA),
        await createRow(table, tenantA),
      ];
      const pageQuery = `query($filter: ${typeName}Filter, $first: Int, $after: String) {
        ${graphql.listQueryName}(filter: $filter, first: $first, after: $after) {
          totalCount
          edges { node { id } }
          pageInfo { hasNextPage endCursor }
        }
      }`;
      const first = await expectData(tenantA, pageQuery, {
        filter: { idIn: ids },
        first: 2,
      });
      const page1 = first[graphql.listQueryName];
      expect(page1.totalCount).toBe(3);
      expect(page1.edges).toHaveLength(2);
      expect(page1.pageInfo.hasNextPage).toBe(true);
      expect(page1.pageInfo.endCursor).toBeTruthy();

      const second = await expectData(tenantA, pageQuery, {
        filter: { idIn: ids },
        first: 2,
        after: page1.pageInfo.endCursor,
      });
      const page2 = second[graphql.listQueryName];
      expect(page2.edges).toHaveLength(1);
      expect(page2.pageInfo.hasNextPage).toBe(false);

      const seen = [...page1.edges, ...page2.edges].map((edge: any) => edge.node.id);
      expect(new Set(seen).size).toBe(3);
      expect(seen.sort()).toEqual([...ids].sort());
    });

    const sortField = graphql.defaultSort?.field;
    const sortColumn = sortField ? textColumnFor(table, sortField) : textColumnFor(table);
    if (sortColumn) {
      const filterField = fieldName(sortColumn);
      test(`filter eq on ${filterField}`, async () => {
        const unique = `e2e-filter-${randomUUID().slice(0, 8)}`;
        const id = await createRow(table, tenantA, { [filterField]: unique });
        const data = await expectData(
          tenantA,
          `query($filter: ${typeName}Filter) {
             ${graphql.listQueryName}(filter: $filter, first: 5) {
               totalCount edges { node { id } }
             }
           }`,
          { filter: { [filterField]: unique } },
        );
        expect(data[graphql.listQueryName].totalCount).toBe(1);
        expect(data[graphql.listQueryName].edges[0].node.id).toBe(id);
      });

      const field = fieldName(sortColumn);
      test(`sort by ${field} asc/desc`, async () => {
        const low = await createRow(table, tenantA, { [field]: `aaa-${seed}` });
        const high = await createRow(table, tenantA, { [field]: `zzz-${seed}` });
        for (const [direction, expectedFirst] of [
          ["asc", low],
          ["desc", high],
        ] as const) {
          const data = await expectData(
            tenantA,
            `query($filter: ${typeName}Filter, $sort: ${typeName}Sort) {
               ${graphql.listQueryName}(filter: $filter, sort: $sort, first: 2) {
                 edges { node { id } }
               }
             }`,
            { filter: { idIn: [low, high] }, sort: { field, direction } },
          );
          expect(data[graphql.listQueryName].edges[0].node.id).toBe(expectedFirst);
        }
      });
    }

    const updateColumn = textColumnFor(table);
    if (updateColumn) {
      const field = fieldName(updateColumn);
      test(`update ${field}`, async () => {
        const id = await createRow(table, tenantA);
        const updated = `e2e-updated-${seed}`;
        const data = await expectData(
          tenantA,
          `mutation($input: Update${typeName}Input!) {
             ${graphql.updateMutationName}(input: $input) { id ${field} }
           }`,
          { input: { id, [field]: updated } },
        );
        expect(data[graphql.updateMutationName][field]).toBe(updated);
      });
    }

    test("delete removes the row", async () => {
      const id = await createRow(table, tenantA);
      const data = await expectData(
        tenantA,
        `mutation($id: ID!) { ${graphql.deleteMutationName}(id: $id) }`,
        { id },
      );
      expect(data[graphql.deleteMutationName]).toBe(true);
      const after = await expectData(
        tenantA,
        `query($id: ID!) { ${graphql.singleQueryName}(id: $id) { id } }`,
        { id },
      );
      expect(after[graphql.singleQueryName]).toBeNull();
      untrackRow(id);
    });

    test("delete of a nonexistent row returns false", async () => {
      const data = await expectData(
        tenantA,
        `mutation($id: ID!) { ${graphql.deleteMutationName}(id: $id) }`,
        { id: randomUUID() },
      );
      expect(data[graphql.deleteMutationName]).toBe(false);
    });
  });
}
