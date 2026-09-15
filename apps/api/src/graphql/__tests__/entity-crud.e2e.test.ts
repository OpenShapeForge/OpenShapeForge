// SPDX-License-Identifier: BUSL-1.1
/**
 * Core CRUD lifecycle per generated entity: create/get, filtered lists,
 * cursor pagination, sorting, updates, and deletes — all derived from the
 * generated db manifest, so new entities are covered automatically.
 *
 * Shape-aware: the documents and readers come from e2e/gql-shapes.ts, so the
 * same assertions run against a v1 entity (bare payloads, Relay connection,
 * Boolean delete) and a canonical v2 one (operation results, items/nextCursor,
 * lease + confirmation on delete).
 */
import { expect } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  describe,
  gql,
  registerSuiteLifecycle,
  seed,
  tenantA,
  test,
} from "./e2e/harness.js";
import {
  createRow,
  eligibleTablesByName,
  fieldName,
  foreignKeyTargets,
  graphqlTables as tables,
  textColumnFor,
  untrackRow,
} from "./e2e/entity-factory.js";
import {
  collectionOf,
  deleteDoc,
  deletedOf,
  deleteRecord,
  deleteVariables,
  expectDeleted,
  expectOperationError,
  fetchRecord,
  listDoc,
  recordOf,
  updateDoc,
  updateRecord,
} from "./e2e/gql-shapes.js";
import {
  isEntityBackedCreate,
  leaseRequired,
  placeholderControls,
  requestLease,
} from "./e2e/operations.js";

registerSuiteLifecycle();

for (const table of tables) {
  const graphql = table.source!.graphql!;
  const typeName = graphql.typeName;
  const list = graphql.listQueryName;

  describe(`${typeName} (${table.name})`, () => {
    test("create + get by id", async () => {
      const id = await createRow(table, tenantA);
      const fetched = await fetchRecord(tenantA, table, id);
      expect(fetched?.id).toBe(id);
    });

    test("list with filter (eq and In) + totalCount", async () => {
      const id = await createRow(table, tenantA);
      const filtered = listDoc(table, {
        variables: ["filter"],
        args: "first: 10",
        selection: "id",
        totalCount: true,
      });
      const eq = collectionOf(table, await gql(tenantA, filtered, { filter: { id } }), list);
      expect(eq.totalCount).toBe(1);
      expect(eq.items[0].id).toBe(id);

      const inFilter = collectionOf(
        table,
        await gql(tenantA, filtered, { filter: { idIn: [id, randomUUID()] } }),
        list,
      );
      expect(inFilter.totalCount).toBe(1);
    });

    test("cursor pagination walks all pages without overlap", async () => {
      const ids = [
        await createRow(table, tenantA),
        await createRow(table, tenantA),
        await createRow(table, tenantA),
      ];
      const pageQuery = listDoc(table, {
        variables: ["filter", "first", "after"],
        selection: "id",
        totalCount: true,
        pageInfo: true,
      });
      const page1 = collectionOf(
        table,
        await gql(tenantA, pageQuery, { filter: { idIn: ids }, first: 2 }),
        list,
      );
      expect(page1.totalCount).toBe(3);
      expect(page1.items).toHaveLength(2);
      expect(page1.hasNextPage).toBe(true);
      expect(page1.nextCursor).toBeTruthy();

      const page2 = collectionOf(
        table,
        await gql(tenantA, pageQuery, {
          filter: { idIn: ids },
          first: 2,
          after: page1.nextCursor,
        }),
        list,
      );
      expect(page2.items).toHaveLength(1);
      expect(page2.hasNextPage).toBe(false);

      const seen = [...page1.items, ...page2.items].map((row: { id: string }) => row.id);
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
        const data = collectionOf(
          table,
          await gql(
            tenantA,
            listDoc(table, { variables: ["filter"], args: "first: 5", selection: "id", totalCount: true }),
            { filter: { [filterField]: unique } },
          ),
          list,
        );
        expect(data.totalCount).toBe(1);
        expect(data.items[0].id).toBe(id);
      });

      const field = fieldName(sortColumn);
      test(`sort by ${field} asc/desc`, async () => {
        const low = await createRow(table, tenantA, { [field]: `aaa-${seed}` });
        const high = await createRow(table, tenantA, { [field]: `zzz-${seed}` });
        for (const [direction, expectedFirst] of [
          ["asc", low],
          ["desc", high],
        ] as const) {
          const data = collectionOf(
            table,
            await gql(
              tenantA,
              listDoc(table, { variables: ["filter", "sort"], args: "first: 2", selection: "id" }),
              { filter: { idIn: [low, high] }, sort: { field, direction } },
            ),
            list,
          );
          expect(data.items[0].id).toBe(expectedFirst);
        }
      });
    }

    const updateColumn = textColumnFor(table);
    if (updateColumn) {
      const field = fieldName(updateColumn);
      test(`update ${field}`, async () => {
        const id = await createRow(table, tenantA);
        const updated = `e2e-updated-${seed}`;
        const result = await updateRecord(tenantA, table, id, { [field]: updated }, {
          selection: `id ${field}`,
        });
        expect(recordOf(table, result, graphql.updateMutationName)[field]).toBe(updated);
      });
    }

    if (isEntityBackedCreate(table)) {
      test("delete removes the row", async () => {
        const id = await createRow(table, tenantA);
        await expectDeleted(tenantA, table, id);
        expect(await fetchRecord(tenantA, table, id)).toBeNull();
        untrackRow(id);
      });
    } else {
      // A plugin-backed create makes companion records the entity delete is
      // authored to refuse while they exist (a document and its first
      // version); removing them is the plugin's own contract, so what the
      // generic delete must prove here is that it refuses cleanly.
      test("delete is refused while the create's companion records exist", async () => {
        const id = await createRow(table, tenantA);
        const refused = await deleteRecord(tenantA, table, id);
        expectOperationError(table, refused, graphql.deleteMutationName, "REFERENCE_IN_USE");
        expect((await fetchRecord(tenantA, table, id))?.id).toBe(id);
      });
    }

    if (leaseRequired(table, "delete")) {
      // A lease-protected delete cannot even begin on a row that does not
      // exist: the lease service answers NOT_FOUND before any mutation runs.
      test("delete of a nonexistent row is refused at the lease", async () => {
        const refused = await requestLease(tenantA, table, randomUUID(), "delete");
        expect(refused.status).toBe(404);
        expect(refused.body.error.code).toBe("NOT_FOUND");
      });
    } else {
      test("delete of a nonexistent row returns false", async () => {
        const result = await gql(
          tenantA,
          deleteDoc(table),
          deleteVariables(table, randomUUID(), placeholderControls(table, "delete")),
        );
        expect(deletedOf(table, result)).toBe(false);
      });
    }

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
      const valueFor = async () =>
        fkTarget ? createRow(eligibleTablesByName.get(fkTarget)!, tenantA) : randomUUID();
      // Only an entity-backed create offers the column as input; a plugin
      // create owns the value (a document's current version). The update
      // refusal is the schema's and holds either way.
      const offeredOnCreate = isEntityBackedCreate(table);
      const read = (id: string) => fetchRecord(tenantA, table, id, `id ${immutableField}`);

      test(`${offeredOnCreate ? `create accepts ${immutableField}; ` : ""}update naming ${immutableField} is refused`, async () => {
        const id = offeredOnCreate
          ? await createRow(table, tenantA, { [immutableField]: await valueFor() })
          : await createRow(table, tenantA);
        const value = (await read(id))[immutableField];
        if (offeredOnCreate) expect(value).toBeTruthy();

        // Re-pointing the record at a different parent is the integrity gap.
        // The value offered is one the column would otherwise accept, so this
        // fails for the schema's reason and not the database's. Schema
        // validation precedes dispatch at both generations, so the refusal is
        // a top-level error whatever the entity's shape.
        const repointed = await valueFor();
        const refused = await gql(tenantA, updateDoc(table), {
          input: { id, [immutableField]: repointed },
        });
        expect(refused.data ?? null).toBeNull();
        expect(JSON.stringify(refused.errors)).toContain(
          `Field \\"${immutableField}\\" is not defined by type \\"Update${typeName}Input\\"`,
        );

        expect((await read(id))[immutableField]).toBe(value);
      });
    }
  });
}
