// SPDX-License-Identifier: BUSL-1.1
/**
 * Entity subtypes at run time. A subtype is served from a virtual table
 * (`manifest.entitySubtypes`) that shares its base's physical table: every
 * read and write the generic CRUD runtime performs for it carries the
 * discriminator predicate below, so a sibling row of the base is never read,
 * changed, deleted, leased or challenged through the subtype; a create fixes
 * the discriminator; and a caller may neither supply the discriminator nor a
 * hidden field. Leases, confirmation challenges and lease availability use
 * the BASE entity identity, so one record has one lease whichever projection
 * took it.
 */
import { sql, type RawBuilder } from "kysely";
import { operationFailure } from "@openshapeforge/operations";
import type { GeneratedCrudColumn, GeneratedCrudTable, GeneratedEntityRow } from "./types.js";

export type SubtypeScopeValue = string | number | boolean;

/** The discriminator conditions of a subtype table; empty for a base table. */
export function subtypeScope(table: GeneratedCrudTable): ReadonlyArray<{ field: string; column: string; value: SubtypeScopeValue }> {
  return table.subtype?.scope ?? [];
}

export function isSubtypeScopeColumn(table: GeneratedCrudTable, column: Pick<GeneratedCrudColumn, "name">): boolean {
  return subtypeScope(table).some((scope) => scope.column === column.name);
}

/**
 * ` and <alias>.<column> = <value> …` for every discriminator, or nothing.
 * Appended to a WHERE that already names the row's identity and tenant.
 */
export function subtypeScopeWhere(table: GeneratedCrudTable, alias?: string): RawBuilder<unknown> {
  const conditions = subtypeScope(table).map((scope) =>
    sql`${alias ? sql.id(alias, scope.column) : sql.id(scope.column)} = ${scope.value}`);
  return conditions.length === 0 ? sql`` : sql` and ${sql.join(conditions, sql` and `)}`;
}

/** The discriminator columns a create of this subtype writes, as the runtime's own values. */
export function subtypeScopeInsertColumns(table: GeneratedCrudTable): Array<{ column: GeneratedCrudColumn; value: SubtypeScopeValue }> {
  return subtypeScope(table).map((scope) => ({
    column: table.columns.find((candidate) => candidate.name === scope.column) ??
      { name: scope.column, type: typeof scope.value === "string" ? "text" : typeof scope.value === "boolean" ? "boolean" : "numeric", required: true, primaryKey: false, generated: null, sourceField: scope.field },
    value: scope.value,
  }));
}

function owns(input: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(input, key);
}

/**
 * Refuse a body that names the discriminator or a hidden field, by field or
 * by column. Dropping either silently would read as accepted: the
 * discriminator is the subtype's identity and a hidden field is outside its
 * contract altogether.
 */
export function assertNoCallerSubtypeValues(table: GeneratedCrudTable, input: Readonly<Record<string, unknown>>): void {
  const subtype = table.subtype;
  if (!subtype) return;
  const entity = table.source?.authoringEntityName ?? table.name;
  for (const scope of subtype.scope) {
    if (owns(input, scope.field) || owns(input, scope.column)) {
      throw operationFailure({
        code: "BAD_USER_INPUT",
        message: `"${scope.field}" is fixed to ${JSON.stringify(scope.value)} for every ${entity} and cannot be supplied or changed through ${entity} Operations.`,
        retryable: false,
      });
    }
  }
  for (const hidden of subtype.hiddenColumns) {
    if (owns(input, hidden.field) || owns(input, hidden.column)) {
      throw operationFailure({
        code: "BAD_USER_INPUT",
        message: `"${hidden.field}" is not part of the ${entity} contract.`,
        retryable: false,
      });
    }
  }
}

/** The stored row without the columns this projection hides. */
export function withoutHiddenColumns(table: GeneratedCrudTable, row: GeneratedEntityRow): GeneratedEntityRow {
  const hidden = table.subtype?.hiddenColumns ?? [];
  if (hidden.length === 0) return row;
  const projected = { ...row };
  for (const column of hidden) {
    delete projected[column.column];
    delete projected[column.field];
  }
  return projected;
}

/**
 * The entity identity leases, challenges and their availability are keyed
 * by: the base's for a subtype, so a record cannot be leased twice through
 * two projections and a lease taken through one is visible through the other.
 */
export function policyEntityId(table: GeneratedCrudTable, operation: { entityId: string }): string {
  return table.subtype?.base.entityId ?? operation.entityId;
}

const policyProjections = new WeakMap<object, Map<string, object>>();

export function policyOperation<T extends { entityId: string }>(table: GeneratedCrudTable, operation: T): T {
  const entityId = policyEntityId(table, operation);
  if (entityId === operation.entityId) return operation;
  let projections = policyProjections.get(operation);
  if (!projections) { projections = new Map(); policyProjections.set(operation, projections); }
  let projected = projections.get(entityId);
  if (!projected) { projected = { ...operation, entityId }; projections.set(entityId, projected); }
  return projected as T;
}
