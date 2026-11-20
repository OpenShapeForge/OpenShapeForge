// SPDX-License-Identifier: BUSL-1.1
import { sql, type Transaction } from "kysely";
import { authorizationListFields } from "../../auth/authorization-profile-decision.js";
import { bindAuthorizationProfileRules, type AuthorizationProfileRules } from "../../auth/authorization-profile-session.js";
import type { DbSessionInput } from "../../db/session.js";
import {
  assertClassifiedQueryAllowed,
  assertElicitedQueryAllowed,
  projectRows,
  readGeneratedCrudTable,
} from "./catalog.js";
import { fieldColumnMap, fieldNameForColumn } from "./columns.js";
import { assertBoundFieldQueryAllowed } from "./field-bindings.js";
import { authorizedListWhere, buildSortExpression, encodeOffsetCursor, normalizeLimit, tenantFixedWhere } from "./queries.js";
import { serializeEntityRow } from "./serialize-result.js";
import { temporalReadOperations } from "./temporal-threshold-resolver.js";
import type { GeneratedCrudTable, GeneratedEntityRow } from "./types.js";

/** One entity's first page of labels: what its list Operation would return, reduced to id and label. */
export type LabelPage = { items: Array<{ id: string; label: string }>; nextCursor: string | null };
export type LabelSource = {
  /** The caller's own key for this source; the result is keyed by it. */
  key: string;
  table: GeneratedCrudTable;
  /** The same structured filter the entity's list Operation would be given. */
  filter: Record<string, unknown>;
  /** The authored field whose value is the label. */
  labelField: string;
};

/** The list Operation whose authorization state governs a source's rows. */
export const labelSourceOperation = (table: GeneratedCrudTable) => `${table.source?.authoringEntityName}.list`;

/**
 * Whether a table's first list page can be read as one branch of a combined
 * statement. The combined read returns exactly a list page's rows, so it only
 * takes tables whose list page needs nothing beyond its own predicate: no
 * second read at another isolation level, and a record identity the caller
 * can read back as `id`.
 */
export function labelSearchable(table: GeneratedCrudTable): boolean {
  const key = table.columns.find((column) => column.name === table.primaryKey);
  return !!key && fieldNameForColumn(key) === "id" && !!table.source?.authoringEntityName &&
    temporalReadOperations(table).length === 0;
}

/**
 * The first list page of several entities in ONE statement, reduced to id and
 * label per row.
 *
 * This is not a second way to decide who sees what. Each branch is the
 * entity's own list read: the same role gate, the same query guards, the same
 * predicate (`authorizedListWhere`, under that entity's own list Operation
 * state), the same order and page size, the same projection and serialization.
 * Row-level security evaluates each table under its own list state as well,
 * because the caller declares every `<Entity>.list` as a read dependency of
 * the audited Operation before the transaction opens — the mechanism a
 * relationship filter already uses to read a second entity in one statement.
 *
 * The declaration is proven here, in this transaction, before any row is
 * read: when it is absent the function answers `undefined` and reads nothing,
 * so a caller that forgot to declare falls back to the per-entity Operations
 * instead of reading under the wrong state.
 *
 * A source this session may not list, or may not filter by the given fields,
 * is left out of the result — exactly as its list Operation would refuse it.
 */
export async function readLabelPages<Database>(
  trx: Transaction<Database>,
  session: DbSessionInput,
  sources: readonly LabelSource[],
  limit: number | undefined,
): Promise<Map<string, LabelPage> | undefined> {
  const settings = (await sql<{ rules: AuthorizationProfileRules | null; declared: string[] | null }>`
    select nullif(current_setting('app.authorization_rules',true),'')::jsonb as rules,
      coalesce(nullif(current_setting('app.audit_read_operations',true),''),'[]')::jsonb as declared
  `.execute(trx)).rows[0];
  const declared = new Set(Array.isArray(settings?.declared) ? settings.declared : []);
  if (sources.some((source) => !labelSearchable(source.table) || !declared.has(labelSourceOperation(source.table)))) return undefined;
  const rules = settings?.rules ?? undefined;
  // The same current transaction policy for query admission and output.
  bindAuthorizationProfileRules(session, rules);
  const pageSize = normalizeLimit(limit);
  const admitted = sources.flatMap((source) => {
    try {
      const table = readGeneratedCrudTable(source.table.name, "list", session);
      if (table !== source.table) return [];
      const query = { filter: source.filter };
      assertClassifiedQueryAllowed(table, session, query);
      assertElicitedQueryAllowed(table, query);
      assertBoundFieldQueryAllowed(table, query);
      const where = authorizedListWhere(table, session, source.filter, tenantFixedWhere(table, session), rules, labelSourceOperation(table));
      return [{ source, table, where, orderBy: buildSortExpression(table, undefined) }];
    } catch {
      return [];
    }
  });
  const pages = new Map<string, LabelPage>();
  if (admitted.length === 0) return pages;
  // `position` carries each branch's own order through the union.
  const branches = admitted.map(({ table, where, orderBy }, index) => sql`(
    select ${sql.lit(index)}::int as source, row_number() over (order by ${orderBy}) as position, to_jsonb(row_source.*) as row
    from ${sql.id(table.schema, table.table)} as row_source
    where ${where}
    order by ${orderBy}
    limit ${pageSize + 1}
  )`);
  const result = await sql<{ source: number; position: string | number; row: GeneratedEntityRow }>`
    ${sql.join(branches, sql` union all `)}
  `.execute(trx);
  admitted.forEach(({ source, table }, index) => {
    const stored = result.rows.filter((entry) => entry.source === index)
      .sort((left, right) => Number(left.position) - Number(right.position)).map((entry) => entry.row);
    const projected = projectRows(table, session, stored.slice(0, pageSize));
    const listFields = authorizationListFields(session, table.source?.authoringEntityName);
    const labelColumn = fieldColumnMap(table).get(source.labelField);
    // A list page limited to named fields carries no other value, the label included.
    const labelListed = !listFields || (!!labelColumn && listFields.includes(fieldNameForColumn(labelColumn)));
    const items = projected.flatMap((row) => {
      const value = serializeEntityRow(table, row);
      const label = labelListed ? value[source.labelField] : undefined;
      return typeof value.id === "string" && typeof label === "string" ? [{ id: value.id, label }] : [];
    });
    if (items.length) pages.set(source.key, { items, nextCursor: stored.length > pageSize ? encodeOffsetCursor(pageSize) : null });
  });
  return pages;
}
