// SPDX-License-Identifier: BUSL-1.1
import type { OpenShapeForgeDatabase } from "../../db/connection.js";
import type { DbSessionInput } from "../../db/session.js";
import { sql } from "kysely";
import { canReadClassifiedColumns } from "../../graphql/generated-authz.js";
import {
  isElicitedOutputColumn,
  requireEntityOperation,
  isGeneratedCrudOperationEnabled,
  generatedCrudError,
  assertClassifiedQueryAllowed,
} from "./catalog.js";
import { fieldColumnMap, fieldNameForColumn } from "./columns.js";
import { listGeneratedEntitiesForTable } from "./queries.js";
import type {
  CountedEntityConnection,
  GeneratedCrudRelationship,
  GeneratedCrudTable,
  GeneratedEntityConnection,
  GeneratedEntityRow,
} from "./types.js";

type RelationInput = {
  parent: GeneratedEntityRow;
  parentTable: GeneratedCrudTable;
  relationship: GeneratedCrudRelationship;
  targetTable: GeneratedCrudTable;
  limit?: number | null;
  cursor?: string | null;
  includeTotalCount?: boolean;
};

export async function listGeneratedEntityRelation(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  input: RelationInput & { includeTotalCount: true },
): Promise<CountedEntityConnection>;
export async function listGeneratedEntityRelation(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  input: RelationInput,
): Promise<GeneratedEntityConnection>;
export async function listGeneratedEntityRelation(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  input: RelationInput,
): Promise<GeneratedEntityConnection> {
  // Metadata is compiler-owned. Never accept a caller's replacement join or FK.
  const relationship = input.parentTable.source?.graphql?.relationships?.find((entry) =>
    entry.name === input.relationship.name && entry.target === input.targetTable.source?.graphql?.typeName);
  if (!relationship) throw generatedCrudError("Unknown relationship traversal.", "BAD_USER_INPUT");
  requireEntityOperation(input.parentTable,
    isGeneratedCrudOperationEnabled(input.parentTable, "get") ? "get" : "list", session);
  requireEntityOperation(
    input.targetTable,
    relationship.resolve === "belongsTo" ? "get" : "list",
    session,
  );
  // An empty connection still answers a requested count — with 0, not null.
  const emptyCount = input.includeTotalCount ? 0 : null;
  if (!relationship.foreignKey && !relationship.via) {
    if (relationship.fieldKey) throw generatedCrudError("Relationship storage metadata is missing.", "INTERNAL_SERVER_ERROR");
    return { rows: [], nextCursor: null, totalCount: emptyCount };
  }

  const parentPrimaryKey = input.parentTable.primaryKey;
  const primaryColumn = input.parentTable.columns.find((column) => column.name === parentPrimaryKey);
  const parentId = parentPrimaryKey == null ? null : input.parent[parentPrimaryKey] ?? (primaryColumn ? input.parent[fieldNameForColumn(primaryColumn)] : null);
  if (parentId == null) {
    return { rows: [], nextCursor: null, totalCount: emptyCount };
  }
  const parent = input.parentTable;
  const target = input.targetTable;
  if (!parent.primaryKey || !target.primaryKey) throw generatedCrudError("Relationship requires primary keys.", "INTERNAL_SERVER_ERROR");
  const parentPredicate = sql`${sql.id("relation_parent", parent.primaryKey)}::text = ${String(parentId)}
    ${parent.tenantScoped ? sql`and relation_parent.tenant_id = ${session.tenantId}` : sql``}`;
  let where;
  let orderBy;
  if (relationship.via) {
    const via = sql.id(relationship.viaSchema ?? parent.schema, relationship.via);
    const linkPredicate = sql`relation_link.source_id = ${sql.id("relation_parent", parent.primaryKey)}
      and relation_link.target_id = ${sql.id("row_source", target.primaryKey)}
      ${parent.tenantScoped ? sql`and relation_link.tenant_id = relation_parent.tenant_id` : sql``}`;
    where = sql`exists (select 1 from ${sql.id(parent.schema, parent.table)} as relation_parent
      join ${via} as relation_link on ${linkPredicate} where ${parentPredicate})`;
    if (relationship.sortable && relationship.positionColumn) {
      orderBy = sql`(select ${sql.id("relation_link", relationship.positionColumn)} from ${via} as relation_link
        where relation_link.source_id::text = ${String(parentId)} and relation_link.target_id = ${sql.id("row_source", target.primaryKey)}
        ${parent.tenantScoped ? sql`and relation_link.tenant_id = ${session.tenantId}` : sql``}) asc,
        ${sql.id("row_source", target.primaryKey)} asc`;
    }
  } else {
    const belongsTo = relationship.resolve === "belongsTo";
    const columnTable = belongsTo ? parent : target;
    const column = columnTable.columns.find((column) => column.name === relationship.foreignKey);
    if (!column) throw generatedCrudError("Relationship foreign-key metadata is invalid.", "INTERNAL_SERVER_ERROR");
    assertClassifiedQueryAllowed(columnTable, session, { filter: { [fieldNameForColumn(column)]: parentId } });
    if (isElicitedOutputColumn(columnTable, column)) throw generatedCrudError("Secure input cannot be traversed as a relationship.", "FORBIDDEN");
    const join = belongsTo
      ? sql`${sql.id("relation_parent", column.name)} = ${sql.id("row_source", target.primaryKey)}`
      : sql`${sql.id("row_source", column.name)} = ${sql.id("relation_parent", parent.primaryKey)}`;
    where = sql`exists (select 1 from ${sql.id(parent.schema, parent.table)} as relation_parent where ${parentPredicate} and ${join})`;
    if (relationship.sortable && relationship.positionColumn) {
      if (!target.columns.some((column) => column.name === relationship.positionColumn)) throw generatedCrudError("Relationship position metadata is invalid.", "INTERNAL_SERVER_ERROR");
      orderBy = sql`${sql.id("row_source", relationship.positionColumn)} asc, ${sql.id("row_source", target.primaryKey)} asc`;
    }
  }
  const targetDefaultSort = relationship.resolve === "belongsTo" ? undefined : readableDefaultSort(input.targetTable, session);
  return listGeneratedEntitiesForTable(db, session, input.targetTable, {
    limit: relationship.resolve === "belongsTo" ? 1 : input.limit ?? 50,
    ...(input.cursor ? { cursor: input.cursor } : {}),
    ...(input.includeTotalCount ? { includeTotalCount: true } : {}),
    ...(targetDefaultSort
      ? { sort: { field: targetDefaultSort.field, direction: targetDefaultSort.direction } }
      : {}),
  }, { where, ...(orderBy ? { orderBy } : {}) });
}

/**
 * The embedded-list default sort comes from the compiler, not the caller, so
 * it is not an input to reject — but ordering by a column the reader may not
 * see is the same oracle assertClassifiedQueryAllowed refuses on the list
 * entry point. Drop it (falling back to primary-key order) instead of failing
 * an otherwise legitimate traversal.
 */
function readableDefaultSort(table: GeneratedCrudTable, session: DbSessionInput) {
  const sort = table.source?.graphql?.defaultSort;
  if (!sort) return undefined;
  const column = fieldColumnMap(table).get(sort.field);
  if (column && isElicitedOutputColumn(table, column)) return undefined;
  if (canReadClassifiedColumns(table.source?.authorization, session)) return sort;
  return column?.classification ? undefined : sort;
}
