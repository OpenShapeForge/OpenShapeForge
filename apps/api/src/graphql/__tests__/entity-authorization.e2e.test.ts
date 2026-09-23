// SPDX-License-Identifier: BUSL-1.1
/**
 * Function-level (operation/role) authorization on generated entities (#94)
 * and field-level data-classification protection (#96/#101), manifest-driven
 * per generated entity.
 *
 * A read-only principal must be:
 *   - ALLOWED to read (single + list) and to traverse relationships,
 *   - REJECTED with FORBIDDEN on create/update/delete (empty-body update
 *     included) without journaling an entity event,
 *   - and, where a classified column exists, served the row with that column
 *     redacted — and refused any filter/sort on it, which would otherwise leak
 *     the value through totalCount or ordering.
 *
 * A role-less principal is denied every operation. The authored (Dutch) role
 * spelling must keep working alongside the Keycloak-normalized (English) one,
 * since the compiler emits the union of both. All identities share tenant A so
 * role denial is isolated from RLS/tenant denial.
 *
 * Shape-aware: a v1 entity throws FORBIDDEN as a top-level GraphQL error, a
 * canonical entity reports it in band at `data.<field>.error`; the readers in
 * e2e/gql-shapes.ts look in the right place. Authorization precedes the
 * canonical lease/version checks, so a denied mutation carries placeholder
 * controls rather than acquiring a lease it must never be granted.
 */
import { expect } from "bun:test";
import {
  describe,
  eventsFor,
  gql,
  noRoles,
  readOnly,
  registerSuiteLifecycle,
  tenantA,
  test,
  type Identity,
} from "./e2e/harness.js";
import {
  createInput,
  createRow,
  fieldName,
  sampleValue,
  graphqlTables as tables,
  tablesByTypeName,
  untrackRow,
} from "./e2e/entity-factory.js";
import {
  collectionOf,
  createDoc,
  deleteDoc,
  deleteVariables,
  expectDeleted,
  expectOperationError,
  fetchRecord,
  getDoc,
  listDoc,
  updateDoc,
} from "./e2e/gql-shapes.js";
import { isEntityBackedCreate, placeholderControls } from "./e2e/operations.js";

registerSuiteLifecycle();

// The manifest's allow-lists are a vocabulary union: the compiler emits every
// spelling of a role the authoring produces (an authored Dutch name plus its
// Keycloak-normalized English form, when they differ). Since #403 the base
// catalog is authored in English, so most lists carry a single spelling — the
// per-entity test below therefore iterates whatever the list actually
// contains, instead of hardcoding a Dutch spelling that no longer exists.

for (const table of tables) {
  const graphql = table.source!.graphql!;
  const typeName = graphql.typeName;
  const countOnly = listDoc(table, { variables: ["filter"], args: "first: 1", totalCount: true });

  async function expectForbidden(
    identity: Identity,
    field: string,
    query: string,
    variables?: Record<string, unknown>,
  ) {
    expectOperationError(table, await gql(identity, query, variables), field, "FORBIDDEN");
  }

  /** Every mutation a denied caller can attempt, controls included. */
  const denied = (identity: Identity, id: string) => [
    expectForbidden(identity, graphql.createMutationName, createDoc(table), { input: {} }),
    // Empty-body update: authorized by the UPDATE role alone — the caller must
    // be denied even though no column would change.
    expectForbidden(identity, graphql.updateMutationName, updateDoc(table), {
      input: { id, ...placeholderControls(table, "update") },
    }),
    expectForbidden(
      identity,
      graphql.deleteMutationName,
      deleteDoc(table),
      deleteVariables(table, id, placeholderControls(table, "delete")),
    ),
  ];

  describe(`${typeName} (${table.name}) role enforcement`, () => {
    test("a session without roles is denied every operation", async () => {
      const id = await createRow(table, tenantA);
      await expectForbidden(noRoles, graphql.singleQueryName, getDoc(table), { id });
      await expectForbidden(
        noRoles,
        graphql.listQueryName,
        listDoc(table, { args: "first: 1", totalCount: true }),
      );
      for (const attempt of denied(noRoles, id)) await attempt;
    });

    test("a read-only session can read but not mutate (empty update included)", async () => {
      const id = await createRow(table, tenantA);

      expect((await fetchRecord(readOnly, table, id))?.id).toBe(id);
      const listed = collectionOf(
        table,
        await gql(readOnly, countOnly, { filter: { id } }),
        graphql.listQueryName,
      );
      expect(listed.totalCount).toBe(1);

      for (const attempt of denied(readOnly, id)) await attempt;

      // The rejected delete must not have removed the row.
      expect((await fetchRecord(tenantA, table, id))?.id).toBe(id);
    });

    test("forbidden mutations journal no entity events", async () => {
      const id = await createRow(table, tenantA);
      const before = await eventsFor(tenantA, table, id);
      for (const attempt of denied(readOnly, id).slice(1)) await attempt;
      const events = await eventsFor(tenantA, table, id);
      expect(events).toEqual(before);
    });

    test("each allow-listed create role grants the operation on its own (vocabulary union)", async () => {
      const createRoles = table.source?.authorization?.roles?.create ?? [];
      expect(createRoles.length).toBeGreaterThan(0);
      for (const role of createRoles) {
        const writer: Identity = {
          tenantId: tenantA.tenantId,
          // Admission is request-fresh and identity-bound. Reuse the admitted
          // test subject while narrowing only its role vocabulary here.
          userId: tenantA.userId,
          roles: [role],
        };
        // The parents a row references are provisioned by the all-roles
        // identity: the grant under test is this entity's create, not its
        // dependencies'.
        const id = await createRow(table, writer, await createInput(table, tenantA));
        // Deleted by the all-write-roles identity: a single create role (e.g.
        // Support.Issues.Create) need not also appear in the delete list. A
        // plugin-created row keeps its companion records and cannot be
        // deleted through the entity delete (see entity-crud); the create
        // itself is the grant under test.
        if (isEntityBackedCreate(table)) {
          await expectDeleted(tenantA, table, id);
          untrackRow(id);
        }
      }
    });

    // Field-level redaction (#96/#101): where the entity carries a classified
    // column, a read-only reader sees it nulled while a write grant sees it.
    const classifiedColumns = table.columns.filter(
      (column) => (column as { classification?: string }).classification !== undefined,
    );
    if (classifiedColumns.length > 0) {
      const selection = `id ${classifiedColumns.map(fieldName).join(" ")}`;

      test("classified columns are redacted for a read-only reader, visible to a writer", async () => {
        const id = await createRow(table, tenantA);
        const asWriter = await fetchRecord(tenantA, table, id, selection);
        const asReader = await fetchRecord(readOnly, table, id, selection);
        for (const column of classifiedColumns) {
          const field = fieldName(column);
          expect(asReader[field]).toBeNull();
          // The writer sees the real value (created rows populate required
          // columns; optional classified columns may legitimately be null).
          if (column.required) {
            expect(asWriter[field]).not.toBeNull();
          }
        }
      });

      const classifiedColumn = classifiedColumns[0]!;
      const classifiedField = fieldName(classifiedColumn);
      const probeValue = sampleValue(classifiedColumn, "classified-query");

      test("read-only filter on a classified field is rejected before totalCount can leak", async () => {
        await expectForbidden(readOnly, graphql.listQueryName, countOnly, {
          filter: { [classifiedField]: probeValue },
        });
        await expectForbidden(readOnly, graphql.listQueryName, countOnly, {
          filter: { [`${classifiedField}In`]: [probeValue] },
        });
      });

      test("read-only sort on a classified field is rejected before ordering can leak", async () => {
        await expectForbidden(
          readOnly,
          graphql.listQueryName,
          listDoc(table, { variables: ["sort"], args: "first: 1", totalCount: true }),
          { sort: { field: classifiedField, direction: "asc" } },
        );
      });
    }
  });
}

// Relationship traversal reads TARGET rows through a separate code path
// (listGeneratedEntityRelation) — prove a read-only session may traverse.
// All shipped entities share the Relaties vocabulary, so a cross-entity
// denial case cannot be constructed from the current catalog; the DENY
// branch of the traversal target-read gate is pinned DB-free in
// require-entity-operation.unit.test.ts.
const parentTable = tables.find((table) =>
  (table.source?.graphql?.relationships ?? []).some(
    (relationship) =>
      relationship.resolve === "belongsTo" && tablesByTypeName.has(relationship.target),
  ),
);

if (parentTable) {
  const graphql = parentTable.source!.graphql!;
  const relationship = graphql.relationships!.find(
    (candidate) =>
      candidate.resolve === "belongsTo" && tablesByTypeName.has(candidate.target),
  )!;

  describe(`relationship traversal (${parentTable.name} → ${relationship.target})`, () => {
    test("a read-only session can traverse relationships (target read allowed)", async () => {
      const targetTable = tablesByTypeName.get(relationship.target)!;
      const targetId = await createRow(targetTable, tenantA);
      const fkColumn = parentTable.columns.find(
        (column) => column.name === relationship.foreignKey,
      )!;
      const parentId = await createRow(parentTable, tenantA, {
        [fieldName(fkColumn)]: targetId,
      });

      const parent = await fetchRecord(
        readOnly,
        parentTable,
        parentId,
        `id ${relationship.name} { id }`,
      );
      expect(parent?.[relationship.name]?.id).toBe(targetId);
    });
  });
}
