// SPDX-License-Identifier: BUSL-1.1
/**
 * Structured query over tenant fields (§5.6). A filter
 * `{ extensions: { <key>: { <operator>: <value> } } }` becomes an EXISTS
 * semi-join on the typed index, one per predicate, with the operator
 * vocabulary of structuredFilter for the field's index column; a sort on
 * `extensions.<key>` a LEFT JOIN on that one index row, nulls last, with the
 * id as tiebreaker. A classified tenant field is never a filter or sort key —
 * the existing oracle guard ignores names it does not know, so this one
 * refuses them explicitly.
 */
import { sql, type RawBuilder } from "kysely";
import { operationFailure } from "@openshapeforge/operations";
import type { DbSessionInput } from "../../../db/session.js";
import { structuredFilter, type QueryField } from "../../../platform/structured-filter.js";
import { filterLeaves } from "../filter-groups.js";
import type { GeneratedCrudTable, ListPageInput } from "../types.js";
import { extensionError, extensionShape, record, type ExtensionField, type ExtensionFieldSet, type ExtensionShape } from "./model.js";
import { extensibleEntityOf, provenExtensionFields } from "./store.js";
import { qualifiedTable } from "./write.js";

export const EXTENSION_SORT_PREFIX = "extensions.";
const VALUE_ALIAS = "extension_value";
const SORT_ALIAS = "extension_sort";

function provenSet(table: GeneratedCrudTable, session: DbSessionInput): ExtensionFieldSet {
  const set = provenExtensionFields(session, table);
  if (!set) extensionError("Tenant field definitions were not loaded for this query.", "INTERNAL_SERVER_ERROR");
  return set!;
}

function refuseClassified(field: ExtensionField, shape: ExtensionShape, entity: string): void {
  if (shape.classified) {
    throw operationFailure({
      code: "FORBIDDEN",
      message: `Not authorized to filter or sort by classified field "extensions.${field.key}" on ${entity}.`,
      retryable: false,
    });
  }
}

function fieldFor(set: ExtensionFieldSet, key: string): { field: ExtensionField; shape: ExtensionShape } {
  const field = set.byKey.get(key);
  if (!field) extensionError(`Unknown tenant field extensions.${key} for ${set.entity}.`, "BAD_USER_INPUT");
  const shape = extensionShape(set.entry, field!.definition);
  refuseClassified(field!, shape, set.entity);
  return { field: field!, shape };
}

/**
 * The query guard for tenant fields, before any SQL: unknown and classified
 * keys, collection operators, unsortable keys, and `limits.filtersPerQuery`
 * over the whole filter tree (each predicate is a semi-join).
 */
export function assertExtensionQueryAllowed(
  table: GeneratedCrudTable,
  session: DbSessionInput,
  input: Pick<ListPageInput, "filter" | "sort">,
): void {
  const extensible = extensibleEntityOf(table);
  const sortField = typeof input.sort?.field === "string" && input.sort.field.startsWith(EXTENSION_SORT_PREFIX)
    ? input.sort.field.slice(EXTENSION_SORT_PREFIX.length) : undefined;
  const leaves = filterLeaves(input.filter).filter((leaf) => Object.hasOwn(leaf, "extensions"));
  if (!extensible || (!leaves.length && sortField === undefined)) return;
  const set = provenSet(table, session);
  let predicates = 0;
  for (const leaf of leaves) {
    const filter = leaf.extensions;
    if (filter === null || filter === undefined) continue;
    if (!record(filter)) extensionError("An extensions filter maps field keys to predicates.", "BAD_USER_INPUT");
    for (const [key, predicate] of Object.entries(filter as Record<string, unknown>)) {
      const { shape } = fieldFor(set, key);
      if (!record(predicate) || !Object.keys(predicate).length) extensionError(`extensions.${key} needs an operator.`, "BAD_USER_INPUT");
      if (shape.collection && Object.keys(predicate as object).some((operator) => operator !== "contains")) {
        extensionError(`extensions.${key} holds several values; filter it with contains.`, "BAD_USER_INPUT");
      }
      predicates += Object.keys(predicate as object).length;
    }
  }
  if (predicates > set.entry.limits.filtersPerQuery) {
    extensionError(`A query filters on at most ${set.entry.limits.filtersPerQuery} tenant field predicates; this one has ${predicates}.`, "BAD_USER_INPUT");
  }
  if (sortField !== undefined) {
    const { shape } = fieldFor(set, sortField);
    if (shape.collection) extensionError(`extensions.${sortField} holds several values and cannot be sorted on.`, "BAD_USER_INPUT");
  }
}

function valueColumn(shape: ExtensionShape, alias: string): { sql: RawBuilder<unknown>; kind: QueryField["kind"] } {
  switch (shape.column) {
    case "number": return { sql: sql.id(alias, "value_number"), kind: "number" };
    case "boolean": return { sql: sql.id(alias, "value_boolean"), kind: "boolean" };
    case "date": return { sql: sql.id(alias, "value_date"), kind: "timestamp" };
    case "timestamp": return { sql: sql.id(alias, "value_timestamp"), kind: "timestamp" };
    case "ref": return { sql: sql`${sql.id(alias, "value_ref_id")}::text`, kind: "text" };
    default: return { sql: sql.id(alias, "value_text"), kind: "text" };
  }
}

function exists(set: ExtensionFieldSet, field: ExtensionField, predicate?: RawBuilder<unknown>): RawBuilder<unknown> {
  return sql`exists (select 1 from ${qualifiedTable(set.entry.valuesTable)} as ${sql.id(VALUE_ALIAS)}
    where ${sql.id(VALUE_ALIAS, "tenant_id")} = ${sql.id("row_source", "tenant_id")}
      and ${sql.id(VALUE_ALIAS, "record_id")} = ${sql.id("row_source", "id")}
      and ${sql.id(VALUE_ALIAS, "field_id")} = ${field.fieldId}::uuid
      ${predicate ? sql`and ${predicate}` : sql``})`;
}

/** The SQL of one `extensions` filter node, under the alias `row_source`. */
export function extensionFilterCondition(
  table: GeneratedCrudTable,
  session: DbSessionInput,
  value: unknown,
): RawBuilder<unknown> {
  const set = provenSet(table, session);
  if (!record(value)) extensionError("An extensions filter maps field keys to predicates.", "BAD_USER_INPUT");
  const conditions: RawBuilder<unknown>[] = [];
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const { field, shape } = fieldFor(set, key);
    const predicate = { ...(raw as Record<string, unknown>) };
    const column = valueColumn(shape, VALUE_ALIAS);
    if (Object.hasOwn(predicate, "isNull")) {
      if (typeof predicate.isNull !== "boolean") extensionError("Invalid null filter.", "BAD_USER_INPUT");
      conditions.push(predicate.isNull ? sql`not ${exists(set, field)}` : exists(set, field));
      delete predicate.isNull;
    }
    if (shape.collection) {
      if (Object.hasOwn(predicate, "contains")) {
        // One index row per element: "contains x" is "some element equals x".
        conditions.push(exists(set, field, structuredFilter({ value: { eq: predicate.contains } }, { value: column })));
      }
      continue;
    }
    if (Object.keys(predicate).length) {
      conditions.push(exists(set, field, structuredFilter({ value: predicate }, { value: column })));
    }
  }
  return conditions.length ? sql`(${sql.join(conditions, sql` and `)})` : sql`true`;
}

/** The ORDER BY and the one-row join of a tenant field sort; undefined for any other sort. */
export function extensionSort(
  table: GeneratedCrudTable,
  session: DbSessionInput,
  sort: { field?: string | null; direction?: string | null } | null | undefined,
): { join: RawBuilder<unknown>; orderBy: RawBuilder<unknown> } | undefined {
  if (typeof sort?.field !== "string" || !sort.field.startsWith(EXTENSION_SORT_PREFIX) || !extensibleEntityOf(table)) return undefined;
  const set = provenSet(table, session);
  const { field, shape } = fieldFor(set, sort.field.slice(EXTENSION_SORT_PREFIX.length));
  if (shape.collection) extensionError(`extensions.${field.key} holds several values and cannot be sorted on.`, "BAD_USER_INPUT");
  const column = valueColumn(shape, SORT_ALIAS).sql;
  const direction = typeof sort.direction === "string" && sort.direction.toLowerCase() === "desc" ? sql`desc` : sql`asc`;
  return {
    join: sql`left join ${qualifiedTable(set.entry.valuesTable)} as ${sql.id(SORT_ALIAS)}
      on ${sql.id(SORT_ALIAS, "tenant_id")} = ${sql.id("row_source", "tenant_id")}
      and ${sql.id(SORT_ALIAS, "record_id")} = ${sql.id("row_source", "id")}
      and ${sql.id(SORT_ALIAS, "field_id")} = ${field.fieldId}::uuid
      and ${sql.id(SORT_ALIAS, "ordinal")} = 0`,
    orderBy: sql`${column} ${direction} nulls last, ${sql.id("row_source", "id")} asc`,
  };
}
