// SPDX-License-Identifier: BUSL-1.1
/**
 * Structured query over tenant fields (§5.6). A filter
 * `{ extensions: { <key>: { <operator>: <value> } } }` becomes an EXISTS
 * semi-join on the typed index, one per predicate, with the operator
 * vocabulary of structuredFilter for the field's index column; a sort on
 * `extensions.<key>` a page read in two bounded parts (extensionSortedPage),
 * nulls last, with the id as tiebreaker. A classified tenant field is never a
 * filter or sort key —
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

/** A sort on one tenant field: which index rows order the page, and in which direction. */
export type ExtensionSortPlan = {
  readonly valuesTable: string;
  readonly fieldId: string;
  /** The index column the field's value lands in. */
  readonly column: string;
  readonly direction: "asc" | "desc";
};

/** The plan of a tenant field sort; undefined for any other sort. */
export function extensionSort(
  table: GeneratedCrudTable,
  session: DbSessionInput,
  sort: { field?: string | null; direction?: string | null } | null | undefined,
): ExtensionSortPlan | undefined {
  if (typeof sort?.field !== "string" || !sort.field.startsWith(EXTENSION_SORT_PREFIX) || !extensibleEntityOf(table)) return undefined;
  const set = provenSet(table, session);
  const { field, shape } = fieldFor(set, sort.field.slice(EXTENSION_SORT_PREFIX.length));
  if (shape.collection) extensionError(`extensions.${field.key} holds several values and cannot be sorted on.`, "BAD_USER_INPUT");
  return {
    valuesTable: set.entry.valuesTable,
    fieldId: field.fieldId,
    column: shape.column === "ref" ? "value_ref_id" : `value_${shape.column}`,
    direction: typeof sort.direction === "string" && sort.direction.toLowerCase() === "desc" ? "desc" : "asc",
  };
}

/**
 * One page of a tenant field sort, in two bounded parts (§5.6, the phase-0
 * measurement #372): `<value> <direction> nulls last, id <direction>`.
 *
 * A LEFT JOIN on the index row cannot use the partial value index (the
 * planner cannot prove it holds the rows without a value), so it sorts every
 * row of the tenant. Instead the rows WITH a value come straight from the
 * index in (value, record_id) order, offset and limit applied there; only a
 * page that runs past the last of them reads the rows WITHOUT one, in id
 * order. `nulls last` is then the order of the two parts, not a sort key.
 * The second part's offset is the page offset minus the number of valued
 * rows, which is known without counting unless the page starts beyond all of
 * them (then they are counted, once). The tiebreaker follows the direction,
 * so a descending page is the same index read backwards.
 *
 * `where` is the list's whole predicate under the alias `row_source`, tenant
 * predicate included, and applies to both parts; every index row read is
 * pinned to the session's tenant as well. A single-valued field has only
 * ordinal 0 (the cardinality of a field never changes, and a collection is
 * refused above), so the index rows are not filtered on it: the index does
 * not hold the ordinal, and the filter would cost a heap visit per row.
 */
export function extensionSortedPage(input: {
  plan: ExtensionSortPlan;
  entityTable: RawBuilder<unknown>;
  tenantId: string;
  where: RawBuilder<unknown>;
  offset: number;
  fetch: number;
}): RawBuilder<{ row: Record<string, unknown> }> {
  const { plan, entityTable, tenantId, where, offset, fetch } = input;
  const values = qualifiedTable(plan.valuesTable);
  const value = sql.id(SORT_ALIAS, plan.column);
  const direction = sql.raw(plan.direction);
  const valuedRows = sql`from ${values} as ${sql.id(SORT_ALIAS)}
    join ${entityTable} as row_source
      on row_source.tenant_id = ${sql.id(SORT_ALIAS, "tenant_id")} and row_source.id = ${sql.id(SORT_ALIAS, "record_id")}
    where ${sql.id(SORT_ALIAS, "tenant_id")} = ${tenantId}::uuid
      and ${sql.id(SORT_ALIAS, "field_id")} = ${plan.fieldId}::uuid
      and ${value} is not null
      and (${where})`;
  return sql<{ row: Record<string, unknown> }>`
    with valued as materialized (
      select ${sql.id(SORT_ALIAS, "record_id")} as id, ${value} as sort_value
      ${valuedRows}
      order by ${value} ${direction}, ${sql.id(SORT_ALIAS, "record_id")} ${direction}
      offset ${offset} limit ${fetch}
    ), unvalued as (
      select row_source.id
      from ${entityTable} as row_source
      where (${where})
        and not exists (select 1 from ${values} as ${sql.id(SORT_ALIAS)}
          where ${sql.id(SORT_ALIAS, "tenant_id")} = row_source.tenant_id
            and ${sql.id(SORT_ALIAS, "record_id")} = row_source.id
            and ${sql.id(SORT_ALIAS, "field_id")} = ${plan.fieldId}::uuid
            and ${value} is not null)
      order by row_source.id ${direction}
      offset (case when (select count(*) from valued) > 0 then 0
        else greatest(${offset}::bigint - (select count(*) ${valuedRows}), 0) end)
      limit (${fetch}::bigint - (select count(*) from valued))
    ), page as (
      select 0 as part, id, sort_value from valued
      union all
      select 1, id, null from unvalued
    )
    select to_jsonb(row_source.*) as row
    from page
    join ${entityTable} as row_source on row_source.tenant_id = ${tenantId}::uuid and row_source.id = page.id
    order by page.part, page.sort_value ${direction}, page.id ${direction}`;
}
