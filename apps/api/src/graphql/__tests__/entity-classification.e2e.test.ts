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
 */
import { expect } from "bun:test";
import {
  describe,
  expectData,
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
  tables,
  tablesByTypeName,
  withClassifiedColumn,
} from "./e2e/entity-factory.js";

registerSuiteLifecycle();

async function expectForbidden(
  identity: Identity,
  query: string,
  variables?: Record<string, unknown>,
) {
  const result = await gql(identity, query, variables);
  expect(result.errors?.[0]?.extensions?.code).toBe("FORBIDDEN");
  // A refusal that still answered the query would defeat its own purpose; the
  // list field is non-null, so the error nulls the whole data payload.
  expect(result.data ?? null).toBeNull();
}

for (const table of tables) {
  const graphql = table.source!.graphql!;
  const typeName = graphql.typeName;
  const classified = redactableColumnFor(table);
  if (!classified) continue;
  const field = fieldName(classified);

  describe(`${typeName} field-level classification`, () => {
    const singleQuery = `query($id: ID!) {
      ${graphql.singleQueryName}(id: $id) { id ${field} }
    }`;

    test.skipIf(remoteUrl)(
      `${field} is nulled for a read-only reader on single and list reads`,
      async () => {
        const value = `gql-redaction-${seed}`;
        const id = await createRow(table, tenantA, { [field]: value });

        // Control: unclassified, a read-only reader sees the value.
        const control = await expectData(readOnly, singleQuery, { id });
        expect(control[graphql.singleQueryName][field]).toBe(value);

        await withClassifiedColumn(classified, "pii", async () => {
          const single = await expectData(readOnly, singleQuery, { id });
          expect(single[graphql.singleQueryName][field]).toBeNull();
          expect(single[graphql.singleQueryName].id).toBe(id);

          const listed = await expectData(
            readOnly,
            `query($filter: ${typeName}Filter) {
               ${graphql.listQueryName}(filter: $filter, first: 1) {
                 totalCount
                 edges { node { id ${field} } }
               }
             }`,
            { filter: { id } },
          );
          expect(listed[graphql.listQueryName].totalCount).toBe(1);
          expect(listed[graphql.listQueryName].edges[0].node.id).toBe(id);
          expect(listed[graphql.listQueryName].edges[0].node[field]).toBeNull();

          const asWriter = await expectData(tenantA, singleQuery, { id });
          expect(asWriter[graphql.singleQueryName][field]).toBe(value);
        });
      },
    );

    test.skipIf(remoteUrl)(
      `a read-only reader cannot filter or sort by ${field}`,
      async () => {
        const value = `gql-oracle-${seed}`;
        await createRow(table, tenantA, { [field]: value });

        await withClassifiedColumn(classified, "pii", async () => {
          const filterQuery = `query($filter: ${typeName}Filter) {
            ${graphql.listQueryName}(filter: $filter, first: 1) { totalCount }
          }`;
          await expectForbidden(readOnly, filterQuery, { filter: { [field]: value } });
          await expectForbidden(readOnly, filterQuery, {
            filter: { [`${field}In`]: [value] },
          });
          await expectForbidden(
            readOnly,
            `query($sort: ${typeName}Sort) {
               ${graphql.listQueryName}(sort: $sort, first: 1) { totalCount }
             }`,
            { sort: { field, direction: "asc" } },
          );

          // Unchanged for a write grant.
          const allowed = await expectData(tenantA, filterQuery, {
            filter: { [field]: value },
          });
          expect(allowed[graphql.listQueryName].totalCount).toBe(1);
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
  const graphql = belongsTo.table.source!.graphql!;
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
          const query = `query($id: ID!) {
            ${graphql.singleQueryName}(id: $id) {
              id
              ${belongsTo.relationship.name} { id ${field} }
            }
          }`;

          await withClassifiedColumn(belongsTo.classified, "pii", async () => {
            const asReader = await expectData(readOnly, query, { id: parentId });
            const traversed = asReader[graphql.singleQueryName][belongsTo.relationship.name];
            expect(traversed.id).toBe(targetId);
            expect(traversed[field]).toBeNull();

            const asWriter = await expectData(tenantA, query, { id: parentId });
            expect(asWriter[graphql.singleQueryName][belongsTo.relationship.name][field]).toBe(
              value,
            );
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
  const graphql = hasMany.table.source!.graphql!;
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
          const query = `query($id: ID!) {
            ${graphql.singleQueryName}(id: $id) {
              id
              ${hasMany.relationship.name} { id }
            }
          }`;
          const idsOf = (data: Record<string, any>) =>
            data[graphql.singleQueryName][hasMany.relationship.name].map(
              (node: { id: string }) => node.id,
            );

          const asWriter = await expectData(tenantA, query, { id: parentId });
          expect(idsOf(asWriter)).toEqual([created.aaa!, created.bbb!, created.ccc!]);

          await withClassifiedColumn(hasMany.sortColumn, "pii", async () => {
            const asReader = await expectData(readOnly, query, { id: parentId });
            // Falls back to the primary-key ordering the CRUD layer uses when
            // no sort is supplied; uuid text order matches Postgres uuid order.
            expect(idsOf(asReader)).toEqual([...Object.values(created)].sort());
            // A write grant keeps the declared ordering while the column is
            // classified.
            const stillSorted = await expectData(tenantA, query, { id: parentId });
            expect(idsOf(stillSorted)).toEqual([created.aaa!, created.bbb!, created.ccc!]);
          });
        },
      );
    },
  );
}
