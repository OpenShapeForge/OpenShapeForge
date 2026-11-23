// SPDX-License-Identifier: BUSL-1.1
import { sql, type Transaction } from "kysely";
import { authorizationListFields } from "../../auth/authorization-profile-decision.js";
import { bindAuthorizationProfileRules, type AuthorizationProfileRules } from "../../auth/authorization-profile-session.js";
import { SEARCH_INDEX_TRIGGER, searchIndexColumns, type SearchIndexConfig } from "../../db/migrations/search-index.js";
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
  /**
   * Set when `filter` is exactly "one of these text fields contains this
   * text". Such a source may find its candidates in the search index instead
   * of reading the whole entity; `filter` still decides every row returned.
   */
  match?: { fields: readonly string[]; text: string };
};

/** How many index candidates are read per row a page needs, so rows the session may not see rarely cost a second read. */
const CANDIDATE_FACTOR = 4;

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
 *
 * Where the search index (db/migrations/search-index.ts) covers a source's
 * text match, the branch does not read the entity to find its rows: it takes
 * the first matching record ids, in list order, from the index and applies
 * the same list predicate to those records only. The index names candidates
 * and nothing else — a candidate the predicate or row-level security rejects
 * is not returned, and the caller's own filter is still part of that
 * predicate. The first candidates in list order contain the first rows of
 * the list page, so the page is the same one; when so many candidates are
 * rejected that a full page is not proven, that source is read again without
 * the index.
 */
export async function readLabelPages<Database>(
  trx: Transaction<Database>,
  session: DbSessionInput,
  sources: readonly LabelSource[],
  limit: number | undefined,
): Promise<Map<string, LabelPage> | undefined> {
  const settings = (await sql<{ rules: AuthorizationProfileRules | null; declared: string[] | null; indexed: Record<string, string> | null }>`
    select nullif(current_setting('app.authorization_rules',true),'')::jsonb as rules,
      coalesce(nullif(current_setting('app.audit_read_operations',true),''),'[]')::jsonb as declared,
      (select jsonb_object_agg(n.nspname||'.'||c.relname, convert_from(substring(t.tgargs from 1 for octet_length(t.tgargs)-1),'UTF8'))
        from pg_catalog.pg_trigger t join pg_catalog.pg_class c on c.oid=t.tgrelid join pg_catalog.pg_namespace n on n.oid=c.relnamespace
          join pg_catalog.pg_proc p on p.oid=t.tgfoid join pg_catalog.pg_namespace fn on fn.oid=p.pronamespace
        where not t.tgisinternal and t.tgenabled in ('O','A') and t.tgnargs=1 and t.tgname=${SEARCH_INDEX_TRIGGER}
          and p.proname='search_entry' and fn.nspname='platform') as indexed
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
      return [{ source, table, where, orderBy: buildSortExpression(table, undefined), index: indexFor(table, source, session, settings?.indexed) }];
    } catch {
      return [];
    }
  });
  const pages = new Map<string, LabelPage>();
  if (admitted.length === 0) return pages;
  const candidateLimit = (pageSize + 1) * CANDIDATE_FACTOR;
  type Row = { source: number; position: string | number; row: GeneratedEntityRow & { candidates?: number } };
  const read = async (useIndex: boolean, only?: ReadonlySet<number>) => {
    const candidates: ReturnType<typeof sql>[] = [];
    // `position` carries each branch's own order through the union; 0 is a source's candidate count.
    const branches = admitted.flatMap(({ table, where, orderBy, index, source }, at) => {
      if (only && !only.has(at)) return [];
      const indexed = useIndex && index ? sql.id(`candidates_${at}`) : undefined;
      if (indexed) candidates.push(sql`${indexed} as materialized (
        select record_id from platform.search_entries
        where tenant_id = ${session.tenantId}::uuid and entity = ${index!.entity} and text_norm like ${containsPattern(source.match!.text)}
        order by record_id limit ${candidateLimit}
      )`);
      return [sql`(
        select ${sql.lit(at)}::int as source, row_number() over (order by ${orderBy}) as position, to_jsonb(row_source.*) as row
        from ${sql.id(table.schema, table.table)} as row_source
        where ${indexed ? sql`${sql.id("row_source", index!.pk)} in (select record_id from ${indexed}) and ` : sql``}${where}
        order by ${orderBy}
        limit ${pageSize + 1}
      )`, ...(indexed ? [sql`(select ${sql.lit(at)}::int, 0, jsonb_build_object('candidates', count(*)) from ${indexed})`] : [])];
    });
    if (!branches.length) return [];
    return (await sql<Row>`${candidates.length ? sql`with ${sql.join(candidates, sql`, `)} ` : sql``}${sql.join(branches, sql` union all `)}`.execute(trx)).rows;
  };
  const rows = await read(true);
  // A source whose candidates ran out before a full page was proven: its page may hold rows beyond them.
  const unproven = new Set(admitted.flatMap((_, at) => {
    const counted = rows.find((entry) => entry.source === at && Number(entry.position) === 0)?.row.candidates;
    const found = rows.filter((entry) => entry.source === at && Number(entry.position) > 0).length;
    return counted !== undefined && counted >= candidateLimit && found <= pageSize ? [at] : [];
  }));
  const result = { rows: [
    ...rows.filter((entry) => Number(entry.position) > 0 && !unproven.has(entry.source)),
    ...(unproven.size ? await read(false, unproven) : []),
  ] };
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

/** `%text%` for `like`, lower-cased by the database as the entries were, with the wildcards of `text` itself escaped. */
const containsPattern = (text: string) => sql`'%'||replace(replace(replace(lower(${text}::text),'\\','\\\\'),'%','\\%'),'_','\\_')||'%'`;

/** The installed index entry that covers exactly this source's match, if there is one. */
function indexFor(table: GeneratedCrudTable, source: LabelSource, session: DbSessionInput, installed: Record<string, string> | null | undefined): SearchIndexConfig | undefined {
  const stored = installed?.[`${table.schema}.${table.table}`];
  if (!source.match?.text || !session.tenantId || !stored) return undefined;
  let config: SearchIndexConfig;
  try { config = JSON.parse(stored) as SearchIndexConfig; } catch { return undefined; }
  const wanted = searchIndexColumns(table, source.match.fields);
  const fields = new Set(source.match.fields);
  return config.entity === table.source?.authoringEntityName && config.pk === table.primaryKey && Array.isArray(config.columns)
    && wanted.length === fields.size && wanted.length === config.columns.length && wanted.every((name) => config.columns.includes(name))
    ? config : undefined;
}
