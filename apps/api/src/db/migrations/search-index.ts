// SPDX-License-Identifier: BUSL-1.1
/**
 * Current-model invariant DDL: the search index application search finds its
 * candidates in.
 *
 * `platform.search_entries` holds one row per record of every entity search
 * reads from a table: the record's searchable text, lower-cased. A trigger on
 * the entity's table keeps the row current in the writer's own transaction,
 * so the index is never behind a committed write. Two indexes answer a query
 * for one tenant and entity: the record-order key, which finds the first
 * matches of a common term without reading the rest, and a trigram index,
 * which finds the matches of a rare term without reading the entity at all.
 *
 * Only values every reader of the entity may filter by are indexed: a
 * classified or policy-bound field never enters. The index decides nothing
 * about access — a match is a candidate, and the entity's own list predicate
 * reads it again (operations/entity/label-search.ts).
 *
 * The trigram index needs `pg_trgm` and `btree_gin`. Where the database does
 * not offer them the index is not installed, any earlier installation is
 * removed, and search reads the entity tables themselves as before.
 */
import { sql } from "kysely";
import catalog from "../../generated/operations/catalog.json" with { type: "json" };
import manifest from "../../generated/db/manifest.json" with { type: "json" };
import type { OpenShapeForgeDatabase } from "../connection.js";
import { rlsBypassToken } from "../rls-bypass.js";
import { fieldColumnMap, fieldNameForColumn } from "../../operations/entity/columns.js";
import { APP_ROLE } from "./app-role.js";
import { WORKER_ROLE } from "./worker-role.js";
import type { GeneratedCrudTable } from "../../operations/entity/types.js";

/** What one entity's trigger indexes; also the trigger's argument, so the installed state is readable. */
export type SearchIndexConfig = { entity: string; schema: string; table: string; pk: string; columns: string[] };
export type SearchIndexSource = { entity: string; field?: string; descriptionField?: string };

export const SEARCH_INDEX_TRIGGER = "search_entry";

function catalogSources(): SearchIndexSource[] {
  const operation = (catalog.operations as unknown as Array<{ key?: string; implementation?: { type?: string; sources?: SearchIndexSource[] } }>)
    .find(entry => entry.key === "application.search" && entry.implementation?.type === "application-search");
  return operation?.implementation?.sources ?? [];
}

/** The entity's searchable text columns that every reader may filter by, in declaration order. */
export function searchIndexColumns(table: GeneratedCrudTable, fields: readonly string[]): string[] {
  const columns = fieldColumnMap(table);
  return [...new Set(fields)].flatMap(field => {
    const column = columns.get(field);
    return column && column.type === "text" && !column.classification && !column.fieldPolicy ? [column.name] : [];
  });
}

export function searchIndexConfigs(tables: readonly GeneratedCrudTable[], sources: readonly SearchIndexSource[]): SearchIndexConfig[] {
  const configs = sources.flatMap(source => {
    const table = tables.find(entry => entry.source?.authoringEntityName === source.entity);
    const key = table?.columns.find(column => column.name === table.primaryKey);
    if (!table || !key || !table.tenantScoped || key.type !== "uuid" || fieldNameForColumn(key) !== "id" || !source.field) return [];
    const columns = searchIndexColumns(table, [source.field, ...(source.descriptionField ? [source.descriptionField] : [])]);
    return columns.length ? [{ entity: source.entity, schema: table.schema, table: table.table, pk: key.name, columns }] : [];
  });
  // One trigger per table and one set of entries per entity: a table or an
  // entity that two sources would index differently is read without the index.
  const shared = (pick: (config: SearchIndexConfig) => string) => (config: SearchIndexConfig) => configs.filter(other => pick(other) === pick(config)).length === 1;
  return configs.filter(shared(config => `${config.schema}.${config.table}`)).filter(shared(config => config.entity));
}

export async function applySearchIndex(
  db: OpenShapeForgeDatabase,
  tables: readonly GeneratedCrudTable[] = manifest.tables as unknown as GeneratedCrudTable[],
  sources: readonly SearchIndexSource[] = catalogSources(),
): Promise<{ installed: boolean; entities: number; rebuilt: string[] }> {
  if (db.isTransaction) return installSearchIndex(db, tables, sources);
  return db.transaction().execute(tx => installSearchIndex(tx, tables, sources));
}

async function installSearchIndex(db: OpenShapeForgeDatabase, tables: readonly GeneratedCrudTable[], sources: readonly SearchIndexSource[]) {
  // Composed hosts can adopt the API before regenerating their database schema.
  const table = await sql<{ present: boolean }>`select to_regclass('platform.search_entries') is not null as present`.execute(db);
  if (!table.rows[0]?.present) return { installed: false, entities: 0, rebuilt: [] };

  // A database that does not offer the extensions keeps working without the index.
  await sql.raw(`do $$ begin
    begin create extension if not exists pg_trgm; create extension if not exists btree_gin;
    exception when others then raise notice 'search index extensions unavailable: %', sqlerrm; end;
  end $$`).execute(db);
  const extensions = await sql<{ count: string | number; trigrams: string | null; role: string }>`select count(*) as count, current_user::text as role,
    (select quote_ident(n.nspname) from pg_extension e join pg_namespace n on n.oid=e.extnamespace where e.extname='pg_trgm') as trigrams
    from pg_extension where extname in ('pg_trgm','btree_gin')`.execute(db);
  // The trigger's definer may write every tenant's entries. That is only
  // sound for a migrate identity no runtime connection shares.
  const separate = ![APP_ROLE, WORKER_ROLE].includes(extensions.rows[0]?.role ?? APP_ROLE);
  const available = Number(extensions.rows[0]?.count) === 2 && !!extensions.rows[0]?.trigrams && separate;
  const configs = available ? searchIndexConfigs(tables, sources) : [];
  const literal = (value: string) => "E'" + value.replaceAll("\\", "\\\\").replaceAll("'", "''") + "'";
  await sql.raw(`
    create or replace function platform.search_entry() returns trigger
    language plpgsql security definer set search_path=pg_catalog as $$
    declare cfg jsonb=TG_ARGV[0]::jsonb; prior jsonb; current_row jsonb; body text; prior_body text;
    begin
      if TG_OP<>'INSERT' then prior=to_jsonb(OLD); end if;
      if TG_OP='DELETE' then
        delete from platform.search_entries where tenant_id=(prior->>'tenant_id')::uuid and entity=cfg->>'entity' and record_id=(prior->>(cfg->>'pk'))::uuid;
        return null;
      end if;
      current_row=to_jsonb(NEW);
      select lower(string_agg(coalesce(current_row->>name,''),E'\\n' order by position)) into body
        from jsonb_array_elements_text(cfg->'columns') with ordinality as listed(name,position);
      if TG_OP='UPDATE' then
        select lower(string_agg(coalesce(prior->>name,''),E'\\n' order by position)) into prior_body
          from jsonb_array_elements_text(cfg->'columns') with ordinality as listed(name,position);
        if prior_body=body and (prior->>'tenant_id')=(current_row->>'tenant_id') and (prior->>(cfg->>'pk'))=(current_row->>(cfg->>'pk')) then return null; end if;
        delete from platform.search_entries where tenant_id=(prior->>'tenant_id')::uuid and entity=cfg->>'entity' and record_id=(prior->>(cfg->>'pk'))::uuid
          and ((prior->>'tenant_id')<>(current_row->>'tenant_id') or (prior->>(cfg->>'pk'))<>(current_row->>(cfg->>'pk')));
      end if;
      insert into platform.search_entries(tenant_id,entity,record_id,text_norm)
        values((current_row->>'tenant_id')::uuid,cfg->>'entity',(current_row->>(cfg->>'pk'))::uuid,body)
        on conflict (tenant_id,entity,record_id) do update set text_norm=excluded.text_norm;
      return null;
    end $$;
    revoke all on function platform.search_entry() from public;
    -- The trigger writes as its definer, whatever session context the writer
    -- of the business row carries: a worker's write has no tenant context to
    -- satisfy the tenant policy with, and must not fail on its index entry.
    drop policy if exists search_entries_maintainer on platform.search_entries;
    ${separate ? "create policy search_entries_maintainer on platform.search_entries to current_user using (true) with check (true);" : ""}
  `).execute(db);
  const installed = await sql<{ schema: string; table: string; enabled: boolean; config: string | null }>`
    select n.nspname as schema, c.relname as table, t.tgenabled in ('O','A') as enabled,
      case when t.tgnargs=1 then convert_from(substring(t.tgargs from 1 for octet_length(t.tgargs)-1),'UTF8') else null end as config
    from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
    where not t.tgisinternal and t.tgname=${SEARCH_INDEX_TRIGGER}`.execute(db);
  const wanted = new Map(configs.map(config => [`${config.schema}.${config.table}`, config]));
  const current = new Set<string>();
  // The migrator is not a BYPASSRLS role: reading every tenant's rows to
  // build their entries needs the transaction-local maintenance context.
  const previousBypass = (await sql<{ value: string | null }>`select current_setting('app.bypass_rls', true) as value`.execute(db)).rows[0]?.value ?? "";
  await sql`select set_config('app.bypass_rls',${rlsBypassToken()},true)`.execute(db);
  const rebuilt: string[] = [];
  try {
    for (const row of installed.rows) {
      const name = `${row.schema}.${row.table}`;
      const config = wanted.get(name);
      if (config && row.enabled && row.config === JSON.stringify(config)) { current.add(name); continue; }
      await sql`drop trigger if exists ${sql.id(SEARCH_INDEX_TRIGGER)} on ${sql.id(row.schema, row.table)}`.execute(db);
    }
    for (const config of configs) {
      if (current.has(`${config.schema}.${config.table}`)) continue;
      const qualified = sql.id(config.schema, config.table);
      // No writer may slip between the entries built here and the trigger that keeps them.
      await sql`lock table ${qualified} in share row exclusive mode`.execute(db);
      await sql`delete from platform.search_entries where entity=${config.entity}`.execute(db);
      const body = sql.join(config.columns.map(name => sql`coalesce(${sql.id(name)},'')`), sql`||E'\n'||`);
      await sql`insert into platform.search_entries(tenant_id,entity,record_id,text_norm)
        select tenant_id, ${config.entity}, ${sql.id(config.pk)}, lower(${body}) from ${qualified}`.execute(db);
      await sql`create trigger ${sql.id(SEARCH_INDEX_TRIGGER)} after insert or update or delete on ${qualified}
        for each row execute function platform.search_entry(${sql.raw(literal(JSON.stringify(config)))})`.execute(db);
      rebuilt.push(config.entity);
    }
    // Entries of an entity that is no longer indexed would never be maintained again.
    if (configs.length) await sql`delete from platform.search_entries where entity not in (${sql.join(configs.map(config => sql`${config.entity}`))})`.execute(db);
    else await sql`delete from platform.search_entries`.execute(db);
  } finally {
    await sql`select set_config('app.bypass_rls',${previousBypass},true)`.execute(db);
  }
  if (available) {
    // Built after the entries: on a first installation the index is built
    // over all of them at once instead of row by row. Entity is part of it so
    // a term common in one entity costs the others nothing. Writes go through
    // the pending list: without it every row costs the writer about a
    // millisecond, which a bulk import cannot afford.
    await sql.raw(`create index if not exists search_entries_text_idx on platform.search_entries using gin (tenant_id, entity, text_norm ${extensions.rows[0]!.trigrams}.gin_trgm_ops)`).execute(db);
    // The choice between the two indexes is made from these statistics.
    if (rebuilt.length) await sql`analyze platform.search_entries`.execute(db);
  }
  return { installed: available, entities: configs.length, rebuilt };
}
