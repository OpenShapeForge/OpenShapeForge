// SPDX-License-Identifier: BUSL-1.1
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
  gql,
  registerSuiteLifecycle,
  seed,
  tenantA,
  test,
} from "./e2e/harness.js";
import {
  createRow,
  fieldName,
  foreignKeyTargets,
  tables,
  tablesByName,
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

    /**
     * Authored `immutable` over GraphQL (#177). The update input is rendered
     * from the same writability rule REST and MCP consult, so the field is
     * offered on create and simply is not a member of the update input — a
     * mutation naming it fails schema validation rather than being silently
     * dropped. Manifest-driven: a table with no immutable column contributes no
     * test and keeps exactly the surface it had.
     */
    const immutable = table.columns.find((column) => column.immutable);
    if (immutable) {
      const immutableField = fieldName(immutable);
      const fkTarget = foreignKeyTargets(table).get(immutable.name);
      const read = `query($id: ID!) { ${graphql.singleQueryName}(id: $id) { ${immutableField} } }`;

      test(`create accepts ${immutableField}; update naming it is refused`, async () => {
        const value = fkTarget
          ? await createRow(tablesByName.get(fkTarget)!, tenantA)
          : randomUUID();
        const id = await createRow(table, tenantA, { [immutableField]: value });

        const created = await expectData(tenantA, read, { id });
        expect(created[graphql.singleQueryName][immutableField]).toBe(value);

        // Re-pointing the record at a different parent is the integrity gap.
        // The value offered is one the column would otherwise accept, so this
        // fails for the schema's reason and not the database's.
        const repointed = fkTarget
          ? await createRow(tablesByName.get(fkTarget)!, tenantA)
          : randomUUID();
        const refused = await gql(
          tenantA,
          `mutation($input: Update${typeName}Input!) {
             ${graphql.updateMutationName}(input: $input) { id }
           }`,
          { input: { id, [immutableField]: repointed } },
        );
        expect(refused.data ?? null).toBeNull();
        expect(JSON.stringify(refused.errors)).toContain(
          `Field \\"${immutableField}\\" is not defined by type \\"Update${typeName}Input\\"`,
        );

        const after = await expectData(tenantA, read, { id });
        expect(after[graphql.singleQueryName][immutableField]).toBe(value);
      });
    }
  });
}

describe("shared enum write invariant", () => {
  const relation = tables.find((table) => table.name === "erp.relations")!;
  const relationType = relation.columns.find(
    (column) => fieldName(column) === "relationType",
  )!;
  const optional = tables
    .flatMap((table) => table.columns.map((column) => ({ table, column })))
    .find(
      ({ column }) =>
        !column.required &&
        column.immutable !== true &&
        (column.enumConstraint?.values?.length ?? 0) > 0,
    )!;

  test("GraphQL rejects a value outside the authored vocabulary", async () => {
    const result = await gql(
      tenantA,
      `mutation($input: CreateRelationInput!) {
         createRelation(input: $input) { id relationType }
       }`,
      { input: { displayName: "invalid-enum", relationType: "spaceship" } },
    );

    expect(result.data?.createRelation ?? null).toBeNull();
    expect(result.errors?.[0]?.extensions?.code).toBe("BAD_USER_INPUT");
    expect(result.errors?.[0]?.message).toContain("relationType");
  });

  test("GraphQL still clears an optional enum field with null", async () => {
    const field = fieldName(optional.column);
    const graphql = optional.table.source!.graphql!;
    const allowed = optional.column.enumConstraint!.values![0]!;
    const id = await createRow(optional.table, tenantA, { [field]: allowed });

    const updated = await expectData(
      tenantA,
      `mutation($input: Update${graphql.typeName}Input!) {
         ${graphql.updateMutationName}(input: $input) { id ${field} }
       }`,
      { input: { id, [field]: null } },
    );
    expect(updated[graphql.updateMutationName][field]).toBeNull();
  });

  test("the shipped Relation enum metadata matches the advertised field", () => {
    expect(relationType.enumConstraint?.values).toEqual([
      "person",
      "organization",
      "group",
    ]);
  });
});
