// SPDX-License-Identifier: BUSL-1.1
import type { OpenShapeForgeDatabase } from "../../db/connection.js";
import type { DbSessionInput } from "../../db/session.js";
import { canReadClassifiedColumns } from "../../graphql/generated-authz.js";
import {
  isElicitedOutputColumn,
  requireEntityOperation,
} from "./catalog.js";
import { fieldColumnMap } from "./columns.js";
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
  // Relationship traversal reads TARGET rows via the private list helper,
  // bypassing readGeneratedCrudTable — gate the target's read roles here,
  // before the degenerate empty-connection early-returns. The parent needs
  // no check: its row was only obtainable through a read-gated query.
  requireEntityOperation(
    input.targetTable,
    input.relationship.resolve === "belongsTo" ? "get" : "list",
    session,
  );
  // An empty connection still answers a requested count — with 0, not null.
  const emptyCount = input.includeTotalCount ? 0 : null;
  const relationship = input.relationship;
  if (!relationship.foreignKey) {
    return { rows: [], nextCursor: null, totalCount: emptyCount };
  }

  if (relationship.resolve === "belongsTo") {
    const id = input.parent[relationship.foreignKey];
    if (id == null) {
      return { rows: [], nextCursor: null, totalCount: emptyCount };
    }
    return listGeneratedEntitiesForTable(db, session, input.targetTable, {
      limit: 1,
      fixedWhere: [{ column: input.targetTable.primaryKey!, value: id }],
      ...(input.includeTotalCount ? { includeTotalCount: true } : {}),
    });
  }

  const parentPrimaryKey = input.parentTable.primaryKey;
  const parentId = parentPrimaryKey == null ? null : input.parent[parentPrimaryKey];
  if (parentId == null) {
    return { rows: [], nextCursor: null, totalCount: emptyCount };
  }
  const targetDefaultSort = readableDefaultSort(input.targetTable, session);
  return listGeneratedEntitiesForTable(db, session, input.targetTable, {
    limit: input.limit ?? 50,
    fixedWhere: [{ column: relationship.foreignKey, value: parentId }],
    ...(input.includeTotalCount ? { includeTotalCount: true } : {}),
    ...(targetDefaultSort
      ? { sort: { field: targetDefaultSort.field, direction: targetDefaultSort.direction } }
      : {}),
  });
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
