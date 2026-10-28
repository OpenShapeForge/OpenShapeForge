// SPDX-License-Identifier: BUSL-1.1
/**
 * Which entities can carry a managed record-action assignment, derived from
 * the compiled manifest and from nothing else.
 *
 * The named-action axis (docs/authoring.md) is declared per entity: an entity
 * names the actions its ACL may grant and the principal kinds each admits.
 * That declaration is the ONLY input to this registry. There is no second
 * table of manageable entities, no configuration file and no caller-supplied
 * list — an entity that did not opt in simply has no entry here, and nothing
 * a caller sends can add one.
 *
 * What is deliberately excluded, each for a reason the read model would
 * otherwise have to carry:
 *
 *   - an entity without the ACL, without a tenant column or without a single
 *     `uuid` primary key. The point lookup and the row policy need the first
 *     three; the `uuid` is the canonical delegation Operation's contract
 *     (operations/record-action-operations.ts), and listing a row whose only
 *     writer would refuse it would be an offer this surface cannot keep;
 *   - a subtype projection. A subtype shares its base's physical table and the
 *     action axis is keyed on the base entity, so managing one through the
 *     other would let a sibling projection answer for it;
 *   - an entity whose generated CRUD is not served. Managing an assignment is
 *     an ordinary ACL edit through the entity's own update Operation, so an
 *     entity that has no update has no manageable assignment either;
 *   - an action that admits no `integration` principal. This surface manages
 *     application subjects; a person subject stays an ordinary ACL edit.
 */
import { getGeneratedCrudTables, isGeneratedCrudOperationEnabled } from "../entity/catalog.js";
import { fieldNameForColumn } from "../entity/columns.js";
import { declaredRecordActions } from "../entity/record-permissions.js";
import type { GeneratedCrudColumn, GeneratedCrudTable } from "../entity/types.js";

/** Field keys an entity without a single-field display template is named by. */
const NAME_FIELD_CANDIDATES = ["name", "title", "label", "displayName", "key"] as const;
/** Text-ish column types a record name may be read from. */
const NAME_COLUMN_TYPES = new Set(["text", "varchar", "citext"]);

export type ManageableRecordAction = {
  name: string;
  /** The entity's declaration; `person` may be admitted beside `integration`. */
  principals: ReadonlyArray<"person" | "integration">;
};

export type RecordActionAssignmentEntity = {
  /** Authoring entity name, the same identifier `app.record_action_allows` takes. */
  entity: string;
  table: GeneratedCrudTable;
  /** The ACL: authored field, stored column and what an empty subject set means. */
  acl: { field: string; column: string; empty: "public" | "restricted" };
  keyColumn: string;
  /** The column a record's name is read from, when the entity has one. */
  nameColumn?: GeneratedCrudColumn;
  /** The optimistic-concurrency column, when the entity stores one. */
  versionColumn?: GeneratedCrudColumn;
  labels: { en?: string; nl?: string };
  /** Declared actions that admit an application principal, sorted by name. */
  actions: ManageableRecordAction[];
};

/**
 * The column a record's name is read from: the single field a display template
 * names, else the first conventional name field the entity stores. Both are
 * resolved to a plain stored column — a computed, localized or relationship
 * field has no column of its own and so never answers here.
 *
 * The column is NOT assumed readable. Whether this session may see its value
 * is decided per row by the entity's own field policy (read-model.ts).
 */
export function recordNameColumn(table: GeneratedCrudTable): GeneratedCrudColumn | undefined {
  const byField = (field: string) =>
    table.columns.find((column) =>
      fieldNameForColumn(column) === field && NAME_COLUMN_TYPES.has(column.type));
  const templated = table.source?.displayTemplate?.match(/^\{\{\s*(\w+)\s*\}\}$/)?.[1];
  if (templated) return byField(templated);
  for (const candidate of NAME_FIELD_CANDIDATES) {
    const column = byField(candidate);
    if (column) return column;
  }
  return undefined;
}

function entityFor(table: GeneratedCrudTable): RecordActionAssignmentEntity | undefined {
  const entity = table.source?.authoringEntityName;
  const policy = table.source?.authorization?.recordPermissions;
  if (!entity || !policy || !table.primaryKey || !table.tenantScoped || table.subtype) return undefined;
  const key = table.columns.find((column) => column.name === table.primaryKey);
  if (key?.type !== "uuid") return undefined;
  // Assigning an action is an ACL edit through the entity's own update, so an
  // entity that does not serve update cannot carry a managed assignment.
  if (!isGeneratedCrudOperationEnabled(table, "update")) return undefined;
  const actions = declaredRecordActions(table)
    .filter((action) => action.principals.includes("integration"))
    .map((action) => ({ name: action.name, principals: [...action.principals] }))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (actions.length === 0) return undefined;
  const versionColumn = table.columns.find((column) => column.name === "updated_at");
  const nameColumn = recordNameColumn(table);
  return {
    entity,
    table,
    acl: { field: policy.field, column: policy.column, empty: policy.empty },
    keyColumn: table.primaryKey,
    ...(nameColumn ? { nameColumn } : {}),
    ...(versionColumn ? { versionColumn } : {}),
    labels: { ...table.source?.labels },
    actions,
  };
}

/**
 * The two input names the generated first-grant form submits for one entity.
 *
 * ONE rule, applied in two places: here, where the handler reads what the form
 * sent, and in packages/compiler/src/record-action-grants.ts, where the form's
 * variant is generated. Per-variant names rather than a shared `recordId`
 * because each variant's record input carries its OWN reference target, and a
 * single property cannot carry two.
 *
 * It is a naming convention and not a trust boundary: the entity, the record
 * and the action that come out of it go through exactly the checks a locator
 * from the listing goes through.
 */
export function recordActionGrantInputs(entity: string): { record: string; action: string } {
  const prefix = `${entity.slice(0, 1).toLowerCase()}${entity.slice(1)}`;
  return { record: `${prefix}RecordId`, action: `${prefix}Action` };
}

/**
 * The one input the generated form submits them UNDER: an object that carries
 * the chosen record type with that type's own record and action.
 *
 * The same name the compiler generates
 * (packages/compiler/src/record-action-grants.ts,
 * `RECORD_ACTION_GRANT_TARGET`), stated again here because this is the side
 * that reads it. It is one level down rather than at the root of the input
 * because that is where a generic operation form resolves a discriminated
 * choice; `integrationId` stays at the root, where the collection's route
 * binding fills it.
 */
export const RECORD_ACTION_GRANT_TARGET = "target";

/**
 * Every entity that can carry a managed assignment, in entity-name order.
 *
 * The order is part of the contract: the read model pages through entities in
 * exactly this sequence, so a cursor stays meaningful for as long as the
 * deployment's manifest does.
 */
export function recordActionAssignmentEntities(
  tables: readonly GeneratedCrudTable[] = getGeneratedCrudTables(),
): RecordActionAssignmentEntity[] {
  return tables
    .flatMap((table) => entityFor(table) ?? [])
    .sort((left, right) => left.entity.localeCompare(right.entity));
}

export function recordActionAssignmentEntity(
  entity: string,
  tables?: readonly GeneratedCrudTable[],
): RecordActionAssignmentEntity | undefined {
  return recordActionAssignmentEntities(tables).find((candidate) => candidate.entity === entity);
}
