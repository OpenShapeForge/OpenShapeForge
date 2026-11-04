// SPDX-License-Identifier: BUSL-1.1
/**
 * Structured query over tenant fields. A filter
 * `{ extensions: { <key>: { <operator>: <value> } } }` becomes an EXISTS
 * semi-join on the typed index, one per predicate, with the operator
 * vocabulary of structuredFilter for the field's index column; a sort on
 * `extensions.<key>` a page read in two bounded parts (extensionSortedPage),
 * nulls last, with the id as tiebreaker. A classified tenant field is never a
 * filter or sort key —
 * the existing oracle guard ignores names it does not know, so this one
 * refuses them explicitly.
 *
 * Defaults: a create stores the default, so only records
 * written before the field existed hold none. A filter is default-aware for
 * a field that applies to every record (no `appliesWhen`): when the default
 * satisfies the predicate, records without an index row for the field match
 * too, as a reader sees them. A field with `appliesWhen` is filtered on
 * stored values only — whether a record without one would read the default
 * depends on the condition, which the index does not hold. A sort treats a
 * missing value as missing (nulls last), whatever the default.
 *
 * A measurement (an object type with an index projection) is a number in a
 * unit: it is filtered as `{ value: { <operator>: … }, unit: { eq: … } }`,
 * never on the number alone, and it is not a sort key in phase 1 — numbers
 * in different units do not order.
 */
import { sql, type RawBuilder } from "kysely";
import { operationFailure } from "@openshapeforge/operations";
import type { DbSessionInput } from "../../../db/session.js";
import { isCalendarDate, structuredFilter, type QueryField } from "../../../platform/structured-filter.js";
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
      predicates += shape.projection ? Object.keys(compoundPredicate(key, shape, predicate as Record<string, unknown>).value).length || 1
        : Object.keys(predicate as object).length;
    }
  }
  if (predicates > set.entry.limits.filtersPerQuery) {
    extensionError(`A query filters on at most ${set.entry.limits.filtersPerQuery} tenant field predicates; this one has ${predicates}.`, "BAD_USER_INPUT");
  }
  if (sortField !== undefined) assertSortable(sortField, fieldFor(set, sortField).shape);
}

function assertSortable(key: string, shape: ExtensionShape): void {
  if (shape.collection) extensionError(`extensions.${key} holds several values and cannot be sorted on.`, "BAD_USER_INPUT");
  if (shape.projection) extensionError(`extensions.${key} is a measurement; its values are in different units and cannot be sorted on.`, "BAD_USER_INPUT");
}

/**
 * A measurement predicate: `{ value: { <operator>: … }, unit: { eq: … } }`
 * (or `{ isNull }`). The unit is required: a number without its unit
 * compares kilowatt-hours with watt-hours.
 */
function compoundPredicate(key: string, shape: ExtensionShape, predicate: Record<string, unknown>): { value: Record<string, unknown>; unit?: string } {
  if (Object.keys(predicate).length === 1 && Object.hasOwn(predicate, "isNull")) return { value: {} };
  const valueComponent = shape.projection!.number;
  const unitComponent = shape.projection!.text;
  const unknown = Object.keys(predicate).filter((name) => name !== valueComponent && name !== unitComponent);
  const unit = unitComponent ? predicate[unitComponent] : undefined;
  if (unknown.length || !valueComponent || !unitComponent || !record(predicate[valueComponent]) ||
      !Object.keys(predicate[valueComponent] as object).length || !record(unit) ||
      Object.keys(unit).join() !== "eq" || typeof unit.eq !== "string") {
    extensionError(`extensions.${key} is a measurement; filter it as { ${valueComponent ?? "value"}: { <operator>: … }, ${unitComponent ?? "unit"}: { eq: "<unit>" } }.`, "BAD_USER_INPUT");
  }
  return { value: predicate[valueComponent!] as Record<string, unknown>, unit: (unit as { eq: string }).eq };
}

function valueColumn(shape: ExtensionShape, alias: string): { sql: RawBuilder<unknown>; kind: QueryField["kind"] } {
  switch (shape.column) {
    case "number": return { sql: sql.id(alias, "value_number"), kind: "number" };
    case "boolean": return { sql: sql.id(alias, "value_boolean"), kind: "boolean" };
    // A date is a calendar day, compared as one (a timestamp operand is refused).
    case "date": return { sql: sql.id(alias, "value_date"), kind: "date" };
    case "timestamp": return { sql: sql.id(alias, "value_timestamp"), kind: "timestamp" };
    // Compared as uuid, so the reference index serves it; the operands are
    // checked to be ids first (assertReferencePredicate).
    case "ref": return { sql: sql.id(alias, "value_ref_id"), kind: "text" };
    default: return { sql: sql.id(alias, "value_text"), kind: "text" };
  }
}

function exists(set: ExtensionFieldSet, field: ExtensionField, predicate?: { column: RawBuilder<unknown>; sql: RawBuilder<unknown> }): RawBuilder<unknown> {
  // The value index is partial on `<column> is not null`; stating it lets a
  // predicate the planner cannot prove it from (a function of the column, as
  // startsWith and contains are) use the index too.
  return sql`exists (select 1 from ${qualifiedTable(set.entry.valuesTable)} as ${sql.id(VALUE_ALIAS)}
    where ${sql.id(VALUE_ALIAS, "tenant_id")} = ${sql.id("row_source", "tenant_id")}
      and ${sql.id(VALUE_ALIAS, "record_id")} = ${sql.id("row_source", "id")}
      and ${sql.id(VALUE_ALIAS, "field_id")} = ${field.fieldId}::uuid
      ${predicate ? sql`and ${predicate.column} is not null and ${predicate.sql}` : sql``})`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A reference compares by record id: equality, membership and order, never text. */
function assertReferencePredicate(key: string, predicate: Record<string, unknown>): void {
  for (const [operator, operand] of Object.entries(predicate)) {
    if (operator === "contains" || operator === "startsWith") {
      extensionError(`extensions.${key} is a reference; compare it by record id (eq, ne, in, isNull).`, "BAD_USER_INPUT");
    }
    const operands = operator === "in" && Array.isArray(operand) ? operand : [operand];
    if (operator !== "isNull" && operands.some((item) => typeof item !== "string" || !UUID.test(item))) {
      extensionError(`extensions.${key} is a reference; its filter values are record ids.`, "VALIDATION");
    }
  }
}

/**
 * Estimated selectivity of one tenant field predicate, most selective first,
 * from its operators alone (no planner statistics are read: that would cost a
 * round trip per query). Equality on a value, or an element of a collection,
 * selects few rows; a bounded range or prefix more; a one-sided range more
 * still; a substring cannot use the index at all; a boolean has two values;
 * `ne` and "has a value" keep nearly everything, and "has no value" is an
 * anti-join over every record. Ties go by key, so the same filter always
 * yields the same SQL whatever the order of its keys.
 */
export function extensionPredicateRank(shape: Pick<ExtensionShape, "column" | "collection">, operators: readonly string[]): number {
  if (shape.collection) return operators.includes("contains") ? 0 : 6;
  const has = (...names: string[]) => names.some((name) => operators.includes(name));
  if (shape.column === "boolean") return has("eq", "in") ? 4 : 5;
  if (has("eq", "in")) return 0;
  if ((has("gt", "gte") && has("lt", "lte")) || has("startsWith")) return 1;
  if (has("gt", "gte", "lt", "lte")) return 2;
  if (has("contains")) return 3;
  return 5;
}

/** Whether one stored scalar satisfies one operator, as the SQL of structuredFilter decides it. */
function scalarSatisfies(kind: QueryField["kind"], operator: string, operand: unknown, value: unknown): boolean {
  if (value === null || value === undefined) return operator === "isNull" && operand === true;
  const order = (left: unknown, right: unknown): number | undefined => {
    if (kind === "number") { const a = Number(left), b = Number(right); return Number.isFinite(a) && Number.isFinite(b) ? a - b : undefined; }
    if (kind === "timestamp") { const a = Date.parse(String(left)), b = Date.parse(String(right)); return Number.isFinite(a) && Number.isFinite(b) ? a - b : undefined; }
    if (kind === "boolean") return left === right ? 0 : undefined;
    if (kind === "date" && !isCalendarDate(right)) return undefined;
    return typeof left === "string" && typeof right === "string" ? (left < right ? -1 : left > right ? 1 : 0) : undefined;
  };
  const compared = order(value, operand);
  switch (operator) {
    case "isNull": return operand === false;
    case "eq": return compared === 0;
    case "ne": return compared !== undefined && compared !== 0;
    case "gt": return compared !== undefined && compared > 0;
    case "gte": return compared !== undefined && compared >= 0;
    case "lt": return compared !== undefined && compared < 0;
    case "lte": return compared !== undefined && compared <= 0;
    case "in": return Array.isArray(operand) && operand.some((item) => order(value, item) === 0);
    case "contains": return typeof value === "string" && typeof operand === "string" && value.toLowerCase().includes(operand.toLowerCase());
    case "startsWith": return typeof value === "string" && typeof operand === "string" && value.toLowerCase().startsWith(operand.toLowerCase());
    default: return false;
  }
}

/** The default a reader sees on a record without a value, when a filter may count it (see the module comment). */
function filterableDefault(field: ExtensionField): { value: unknown } | undefined {
  return field.definition.defaultValue !== undefined && (field.appliesWhen === null || field.appliesWhen === undefined)
    ? { value: field.definition.defaultValue } : undefined;
}

/**
 * The SQL of one `extensions` filter node, under the alias `row_source`: one
 * EXISTS per field (and one for its `isNull`), each answered from the index
 * alone, ordered by extensionPredicateRank so the most selective probe runs
 * first (the order that measured fastest for five filters on 200k records).
 * Postgres keeps the written order among filters of equal cost, so the rank
 * decides which probe a record meets first; where the planner turns the
 * EXISTS into semi-joins it orders them by its own estimates, which the
 * field-and-value statistics feed. The bounded walk with a candidate-set
 * fallback that the measurement also tried is not built: it needs a sort
 * index for every list order, which a list does not have.
 */
export function extensionFilterCondition(
  table: GeneratedCrudTable,
  session: DbSessionInput,
  value: unknown,
): RawBuilder<unknown> {
  const set = provenSet(table, session);
  if (!record(value)) extensionError("An extensions filter maps field keys to predicates.", "BAD_USER_INPUT");
  const conditions: Array<{ rank: number; key: string; sql: RawBuilder<unknown> }> = [];
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const { field, shape } = fieldFor(set, key);
    const predicate = { ...(raw as Record<string, unknown>) };
    const column = valueColumn(shape, VALUE_ALIAS);
    const fallback = filterableDefault(field);
    /** A probe for stored values, widened to records without one when the default matches too. */
    const probe = (stored: RawBuilder<unknown>, defaultMatches: boolean) =>
      fallback && defaultMatches ? sql`(${stored} or not ${exists(set, field)})` : stored;
    if (shape.column === "ref") assertReferencePredicate(key, shape.collection && Object.hasOwn(predicate, "contains") ? { eq: predicate.contains } : predicate);
    if (Object.hasOwn(predicate, "isNull")) {
      if (typeof predicate.isNull !== "boolean") extensionError("Invalid null filter.", "BAD_USER_INPUT");
      // With a default, a record without a value reads the default: never null.
      const condition = fallback
        ? (predicate.isNull ? sql`false` : sql`true`)
        : predicate.isNull ? sql`not ${exists(set, field)}` : exists(set, field);
      conditions.push({ rank: predicate.isNull ? 6 : 5, key, sql: condition });
      delete predicate.isNull;
    }
    if (shape.projection) {
      if (!Object.keys(predicate).length) continue;
      const compound = compoundPredicate(key, shape, predicate);
      const unitColumn = sql.id(VALUE_ALIAS, "value_text");
      const fallbackValue = record(fallback?.value) ? fallback!.value as Record<string, unknown> : undefined;
      const defaultMatches = fallbackValue !== undefined && fallbackValue[shape.projection.text!] === compound.unit &&
        Object.entries(compound.value).every(([operator, operand]) => scalarSatisfies("number", operator, operand, fallbackValue[shape.projection!.number!]));
      conditions.push({ rank: extensionPredicateRank(shape, Object.keys(compound.value)), key,
        sql: probe(exists(set, field, { column: column.sql, sql: sql`${structuredFilter({ value: compound.value }, { value: column })} and ${unitColumn} = ${compound.unit}` }), defaultMatches) });
      continue;
    }
    if (shape.collection) {
      if (Object.hasOwn(predicate, "contains")) {
        // One index row per element: "contains x" is "some element equals x".
        const defaultMatches = Array.isArray(fallback?.value) && (fallback!.value as unknown[]).includes(predicate.contains);
        conditions.push({ rank: extensionPredicateRank(shape, ["contains"]), key,
          sql: probe(exists(set, field, { column: column.sql, sql: structuredFilter({ value: { eq: predicate.contains } }, { value: column }) }), defaultMatches) });
      }
      continue;
    }
    if (Object.keys(predicate).length) {
      const defaultMatches = fallback !== undefined &&
        Object.entries(predicate).every(([operator, operand]) => scalarSatisfies(column.kind, operator, operand, fallback.value));
      conditions.push({ rank: extensionPredicateRank(shape, Object.keys(predicate)), key,
        sql: probe(exists(set, field, { column: column.sql, sql: structuredFilter({ value: predicate }, { value: column }) }), defaultMatches) });
    }
  }
  conditions.sort((left, right) => left.rank - right.rank || (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
  return conditions.length ? sql`(${sql.join(conditions.map((condition) => condition.sql), sql` and `)})` : sql`true`;
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
  assertSortable(field.key, shape);
  return {
    valuesTable: set.entry.valuesTable,
    fieldId: field.fieldId,
    column: shape.column === "ref" ? "value_ref_id" : `value_${shape.column}`,
    direction: typeof sort.direction === "string" && sort.direction.toLowerCase() === "desc" ? "desc" : "asc",
  };
}

/**
 * One page of a tenant field sort, in two bounded parts (a measurement of 200k records ×
 * 30 fields under RLS chose this shape): `<value> <direction> nulls last, id <direction>`.
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
