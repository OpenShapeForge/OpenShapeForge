// SPDX-License-Identifier: BUSL-1.1
/**
 * Field-level data protection over GraphQL (#96/#101) now that redaction and
 * the classified filter/sort guard live in the shared generated CRUD core
 * instead of the resolvers (#164).
 *
 * The resolvers no longer redact anything themselves, so this suite is the
 * regression proof that GraphQL behaviour is unchanged by that move — its REST
 * twin lives in src/rest/__tests__/rest-crud.e2e.test.ts, and the two assert
 * the same rules because they now run the same code.
 *
 * No entity shipped here declares a classification (the manifest-conditional
 * cases in entity-authorization.e2e.test.ts therefore stay dormant), so every
 * test below arms one column for its own duration with withClassifiedColumn
 * rather than asserting nothing. That arming is in-process, hence skipped when
 * the suite runs against a remote server.
 *
 * Shape-aware through e2e/gql-shapes.ts: the refusal a canonical list answers
 * with sits in band, and expectOperationError checks that it did not answer
 * the question it refused at either generation.
 */
import { expect } from "bun:test";
import {
  describe,
  gql,
  readOnly,
  registerSuiteLifecycle,
  remoteUrl,
  seed,
  tenantA,
  test,
  type Identity,
} from "./e2e/harness.js";
import {
  createRow,
  fieldName,
  redactableColumnFor,
  graphqlTables as tables,
  tablesByTypeName,
  withClassifiedColumn,
} from "./e2e/entity-factory.js";
import {
  collectionOf,
  expectOperationError,
  fetchRecord,
  listDoc,
} from "./e2e/gql-shapes.js";

registerSuiteLifecycle();

for (const table of tables) {
  const graphql = table.source!.graphql!;
  const typeName = graphql.typeName;
  const classified = redactableColumnFor(table);
  if (!classified) continue;
  const field = fieldName(classified);
  const countOnly = listDoc(table, { variables: ["filter"], args: "first: 1", totalCount: true });

  async function expectForbidden(
    identity: Identity,
    query: string,
    variables?: Record<string, unknown>,
  ) {
    expectOperationError(
      table,
      await gql(identity, query, variables),
      graphql.listQueryName,
      "FORBIDDEN",
    );
  }

  describe(`${typeName} field-level classification`, () => {
    test.skipIf(remoteUrl)(
      `${field} is nulled for a read-only reader on single and list reads`,
      async () => {
        const value = `gql-redaction-${seed}`;
        const id = await createRow(table, tenantA, { [field]: value });

        // Control: unclassified, a read-only reader sees the value.
        const control = await fetchRecord(readOnly, table, id, `id ${field}`);
        expect(control[field]).toBe(value);

        await withClassifiedColumn(classified, "pii", async () => {
          const single = await fetchRecord(readOnly, table, id, `id ${field}`);
          expect(single[field]).toBeNull();
          expect(single.id).toBe(id);

          const listed = collectionOf(
            table,
            await gql(
              readOnly,
              listDoc(table, {
                variables: ["filter"],
                args: "first: 1",
                selection: `id ${field}`,
                totalCount: true,
              }),
              { filter: { id } },
            ),
            graphql.listQueryName,
          );
          expect(listed.totalCount).toBe(1);
          expect(listed.items[0].id).toBe(id);
          expect(listed.items[0][field]).toBeNull();

          const asWriter = await fetchRecord(tenantA, table, id, `id ${field}`);
          expect(asWriter[field]).toBe(value);
        });
      },
    );

    test.skipIf(remoteUrl)(
      `a read-only reader cannot filter or sort by ${field}`,
      async () => {
        const value = `gql-oracle-${seed}`;
        await createRow(table, tenantA, { [field]: value });

        await withClassifiedColumn(classified, "pii", async () => {
          await expectForbidden(readOnly, countOnly, { filter: { [field]: value } });
          await expectForbidden(readOnly, countOnly, { filter: { [`${field}In`]: [value] } });
          await expectForbidden(
            readOnly,
            listDoc(table, { variables: ["sort"], args: "first: 1", totalCount: true }),
            { sort: { field, direction: "asc" } },
          );

          // Unchanged for a write grant.
          const allowed = collectionOf(
            table,
            await gql(tenantA, countOnly, { filter: { [field]: value } }),
            graphql.listQueryName,
          );
          expect(allowed.totalCount).toBe(1);
        });
      },
    );
  });
}

// Relationship traversal reads TARGET rows through listGeneratedEntityRelation,
// a third read path that used to be redacted by the resolver.
const belongsTo = tables.flatMap((table) =>
  (table.source?.graphql?.relationships ?? [])
    .filter((relationship) => relationship.resolve === "belongsTo")
    .flatMap((relationship) => {
      const target = tablesByTypeName.get(relationship.target);
      const classified = target ? redactableColumnFor(target) : undefined;
      return target && classified ? [{ table, relationship, target, classified }] : [];
    }),
)[0];

if (belongsTo) {
  const field = fieldName(belongsTo.classified);
  const foreignKeyField = fieldName(
    belongsTo.table.columns.find(
      (column) => column.name === belongsTo.relationship.foreignKey,
    )!,
  );

  describe(
    `relationship traversal (${belongsTo.table.name} → ${belongsTo.relationship.target}) classification`,
    () => {
      test.skipIf(remoteUrl)(
        "a traversed row is redacted for a read-only reader",
        async () => {
          const value = `gql-relation-redaction-${seed}`;
          const targetId = await createRow(belongsTo.target, tenantA, { [field]: value });
          const parentId = await createRow(belongsTo.table, tenantA, {
            [foreignKeyField]: targetId,
          });
          const selection = `id ${belongsTo.relationship.name} { id ${field} }`;

          await withClassifiedColumn(belongsTo.classified, "pii", async () => {
            const asReader = await fetchRecord(readOnly, belongsTo.table, parentId, selection);
            const traversed = asReader[belongsTo.relationship.name];
            expect(traversed.id).toBe(targetId);
            expect(traversed[field]).toBeNull();

            const asWriter = await fetchRecord(tenantA, belongsTo.table, parentId, selection);
            expect(asWriter[belongsTo.relationship.name][field]).toBe(value);
          });
        },
      );
    },
  );
}

// The embedded-list default sort is compiler-derived, not caller-supplied, so
// it is dropped rather than refused when it names a column the reader may not
// see — refusing it would break an otherwise legitimate traversal.
const hasMany = tables.flatMap((table) =>
  (table.source?.graphql?.relationships ?? [])
    .filter((relationship) => relationship.resolve === "hasMany")
    .flatMap((relationship) => {
      const target = tablesByTypeName.get(relationship.target);
      const sort = target?.source?.graphql?.defaultSort;
      const sortColumn = sort
        ? target!.columns.find((column) => fieldName(column) === sort.field)
        : undefined;
      return target && sort && sortColumn && sort.direction === "asc"
        ? [{ table, relationship, target, sortColumn }]
        : [];
    }),
)[0];

if (hasMany) {
  const sortField = fieldName(hasMany.sortColumn);
  const foreignKeyField = fieldName(
    hasMany.target.columns.find(
      (column) => column.name === hasMany.relationship.foreignKey,
    )!,
  );

  describe(
    `embedded default sort (${hasMany.relationship.target} by ${sortField})`,
    () => {
      test.skipIf(remoteUrl)(
        "is applied for a writer and dropped for a reader who cannot see the column",
        async () => {
          const parentId = await createRow(hasMany.table, tenantA);
          // Created in reverse sort order so "ordered by the sort column" and
          // "ordered by insertion" cannot be confused.
          const created: Record<string, string> = {};
          for (const marker of ["ccc", "bbb", "aaa"]) {
            created[marker] = await createRow(hasMany.target, tenantA, {
              [foreignKeyField]: parentId,
              [sortField]: `${marker}-defaultsort-${seed}`,
            });
          }
          const selection = `id ${hasMany.relationship.name} { id }`;
          const idsOf = async (identity: Identity) =>
            (await fetchRecord(identity, hasMany.table, parentId, selection))[
              hasMany.relationship.name
            ].map((node: { id: string }) => node.id);

          expect(await idsOf(tenantA)).toEqual([created.aaa!, created.bbb!, created.ccc!]);

          await withClassifiedColumn(hasMany.sortColumn, "pii", async () => {
            // Falls back to the primary-key ordering the CRUD layer uses when
            // no sort is supplied; uuid text order matches Postgres uuid order.
            expect(await idsOf(readOnly)).toEqual([...Object.values(created)].sort());
            // A write grant keeps the declared ordering while the column is
            // classified.
            expect(await idsOf(tenantA)).toEqual([created.aaa!, created.bbb!, created.ccc!]);
          });
        },
      );
    },
  );
}
