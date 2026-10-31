// SPDX-License-Identifier: BUSL-1.1
/** Current-model invariant DDL: every stored business row journals in its writer transaction. */
import { sql } from "kysely";
import { createHash } from "node:crypto";
import auditCatalog from "../../generated/operations/audit.json" with { type: "json" };
import manifest from "../../generated/db/manifest.json" with { type: "json" };
import type { OpenShapeForgeDatabase } from "../connection.js";
import type { GeneratedCrudTable } from "../../operations/entity/types.js";
import type { RuntimeEntityValueCarrier } from "@openshapeforge/plugin-runtime";

type Config = { entity: string; entityIds: string[]; aggregate: string; schema: string; table: string; pk: string;
  fields: Record<string, { name: string; hidden: boolean; exact: boolean }>; visibility: string[];
  tracked: Record<string, string>;
  trackingTargets: Record<string, string>;
  parents: Array<{ column: string; entity: string }> };

type Timelines = Readonly<Record<string, { include?: readonly string[]; parents?: readonly string[] }>>;
export function auditTableConfigs(tables: readonly GeneratedCrudTable[], timelines: Timelines = auditCatalog.timelines, entityNames: Readonly<Record<string, string>> = auditCatalog.entityNames): Config[] {
  const business = tables.filter(table => table.source?.authoringEntityName && table.primaryKey && table.tenantScoped);
  const parentEdges = new Map<string, Array<{ parent: GeneratedCrudTable; column: string }>>();
  for (const parent of business) {
    const relations = parent.source?.graphql?.relationships ?? [];
    const includes = timelines[parent.source!.authoringEntityName!]?.include ?? [];
    for (const name of includes) if (!relations.some(relation => relation.name === name && relation.resolve === "hasMany" && relation.foreignKey && !relation.via && !relation.through)) {
      throw new Error(`${parent.source!.authoringEntityName}: audit timeline include ${name} requires a stored child relationship.`);
    }
    for (const relation of relations.filter(relation => relation.resolve === "hasMany" && (relation.ownership === "owned" || includes.includes(relation.name)))) {
      const child = business.find(table => table.source?.graphql?.typeName === relation.target);
      if (!child || !relation.foreignKey || relation.via || relation.through) throw new Error(`${parent.source!.authoringEntityName}: audit timeline child ${relation.name} requires an exact stored tenant reference.`);
      const edges = parentEdges.get(child.name) ?? [];
      edges.push({ parent, column: relation.foreignKey }); parentEdges.set(child.name, edges);
    }
  }
  for (const child of business) {
    for (const name of timelines[child.source!.authoringEntityName!]?.parents ?? []) {
      const relation = child.source?.graphql?.relationships?.find(item => item.name === name);
      const parent = business.find(table => table.source?.graphql?.typeName === relation?.target);
      if (!relation || relation.resolve !== "belongsTo" || !relation.foreignKey || relation.via || relation.through || !parent) throw new Error("Audit timeline parents require an exact stored reference.");
      const edges = parentEdges.get(child.name) ?? [];
      if (!edges.some(edge => edge.parent.name === parent.name && edge.column === relation.foreignKey)) edges.push({ parent, column: relation.foreignKey });
      parentEdges.set(child.name, edges);
    }
  }
  function config(table: GeneratedCrudTable): Config {
    const physicalColumns = new Set((manifest.entityValues.carriers as unknown as RuntimeEntityValueCarrier[])
      .filter(carrier => carrier.schema === table.schema && carrier.table === table.table)
      .flatMap(carrier => Object.values(carrier.definitions).flatMap(definition => definition.references
        .flatMap(reference => [reference.column, ...(reference.parameterColumn ? [reference.parameterColumn] : [])]))));
    return { entity: table.source!.authoringEntityName!,
      entityIds: Object.entries(entityNames).filter(([, name]) => name === table.source!.authoringEntityName).map(([id]) => id).sort(), aggregate: table.source!.graphql?.singleQueryName ?? table.source!.authoringEntityName!,
      schema: table.schema, table: table.table, pk: table.primaryKey!, visibility: (table.realtime?.visibilityColumns ?? []).filter(name => {
        const column = table.columns.find(column => column.name === name);
        return column && !physicalColumns.has(name) && (!table.retention || name === "id" || name.endsWith("_id")) && !column.classification && !column.fieldPolicy && !/password|secret|token|credential|private.?key|cipher|encrypted/i.test(name);
      }),
      tracked: Object.fromEntries((table.source?.computedFields ?? []).flatMap(field => {
        if (field.resolver !== "temporalThreshold") return [];
        const column = table.columns.find(column => column.sourceField === field.trackedField);
        if (!column) throw new Error(`${table.name}: temporal tracked field has no stored column.`);
        return [[column.name, field.trackedField]];
      })),
      trackingTargets: Object.fromEntries((table.source?.computedFields ?? []).flatMap(field => {
        if (field.resolver !== "temporalThreshold") return [];
        const relationship = table.source?.graphql?.relationships?.find(item => item.name === field.trackedField && item.resolve === "belongsTo");
        if (!relationship) throw new Error(`${table.name}: temporal tracked relationship is missing.`);
        return [[field.trackedField, relationship.target]];
      })),
      fields: Object.fromEntries(table.columns.filter(column => column.sourceField).map(column => [column.name, {
        name: column.sourceField!, exact: ["numeric", "bigint"].includes(column.type), hidden: !!table.retention || !!column.classification || !!column.fieldPolicy || /password|secret|token|credential|private.?key|cipher|encrypted/i.test(column.name),
      }])), parents: (parentEdges.get(table.name) ?? []).map(edge => ({ column: edge.column, entity: edge.parent.source!.authoringEntityName! })) };
  }
  return business.map(table => config(table));
}

/** Readiness must not accept a database that can silently omit row auditing. */
export async function auditHistoryReady(db: OpenShapeForgeDatabase, tables: readonly GeneratedCrudTable[] = manifest.tables as unknown as GeneratedCrudTable[], timelines: Timelines = auditCatalog.timelines): Promise<boolean> {
  const expected = auditTableConfigs(tables, timelines);
  const result = await sql<{ name: string; handler: string; config: string | null; identity: boolean }>`select case when t.tgnargs=1 then convert_from(substring(t.tgargs from 1 for octet_length(t.tgargs)-1),'UTF8') else null end as config,n.nspname||'.'||c.relname as name,p.proname as handler, position('actorIdentityId' in p.prosrc)>0 as identity
    from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
    join pg_proc p on p.oid=t.tgfoid join pg_namespace fn on fn.oid=p.pronamespace
    where not t.tgisinternal and t.tgenabled in ('O','A') and fn.nspname='platform'
      and (t.tgname='audit_business_row' and p.proname='audit_business_row'
        or t.tgname='track_field_value_since' and p.proname='track_field_value_since'
        or t.tgname='audit_event_envelope' and p.proname='audit_event_envelope')`.execute(db);
  const active = new Map(result.rows.filter(row => row.handler === "audit_business_row").map(row => [row.name, row.config]));
  const tracked = new Map(result.rows.filter(row => row.handler === "track_field_value_since").map(row => [row.name, row.config]));
  return result.rows.some(row => row.name === "platform.entity_events" && row.handler === "audit_event_envelope" && row.identity) &&
    expected.every(config => active.get(`${config.schema}.${config.table}`) === JSON.stringify(config) &&
      (!Object.keys(config.tracked).length || tracked.get(`${config.schema}.${config.table}`) === JSON.stringify(config)));
}

export async function applyAuditHistory(db: OpenShapeForgeDatabase, tables: readonly GeneratedCrudTable[] = manifest.tables as unknown as GeneratedCrudTable[], timelines: Timelines = auditCatalog.timelines): Promise<void> {
  if (db.isTransaction) return installAuditHistory(db, tables, timelines);
  await db.transaction().execute(tx => installAuditHistory(tx, tables, timelines));
}

async function installAuditHistory(db: OpenShapeForgeDatabase, tables: readonly GeneratedCrudTable[], timelines: Timelines): Promise<void> {
  const configs = auditTableConfigs(tables, timelines);
  const literal = (value: string) => "E'" + value.replaceAll("\\", "\\\\").replaceAll("'", "''") + "'";
  const registry = JSON.stringify(Object.fromEntries(configs.map(config => [config.entity, config])));
  const tag = `$audit_${createHash("sha256").update(registry).digest("hex")}$`;
  const registrySql = literal(registry);
  await sql.raw(`
    create or replace function platform.audit_config(entity text) returns jsonb
    language sql immutable set search_path=pg_catalog as ${tag} select ${registrySql}::jsonb -> entity ${tag};

    create or replace function platform.audit_entity_name(aggregate text) returns text
    language sql immutable set search_path=pg_catalog as ${tag}
      select min(value->>'entity') from jsonb_each(${registrySql}::jsonb)
      where key=aggregate or value->>'aggregate'=aggregate or value->'entityIds' ? aggregate
      having count(distinct value->>'entity')=1
    ${tag};

    create or replace function platform.audit_redact(value jsonb) returns jsonb
    language plpgsql immutable set search_path=pg_catalog as $$
    declare result jsonb; k text; v jsonb;
    begin
      if jsonb_typeof(value)='object' then
        result='{}'::jsonb;
        for k,v in select * from jsonb_each(value) loop
          result=result || jsonb_build_object(k,case when k ~* 'password|secret|token|credential|authorization|cookie|private.?key|cipher|encrypted' then '"[REDACTED]"'::jsonb else platform.audit_redact(v) end);
        end loop; return result;
      elsif jsonb_typeof(value)='array' then
        select coalesce(jsonb_agg(platform.audit_redact(e)),'[]') into result from jsonb_array_elements(value) e;
        return result;
      end if; return value;
    end $$;

    create or replace function platform.audit_recorded_subjects(cfg jsonb, record_key text, tenant_key uuid) returns jsonb
    language sql stable set search_path=pg_catalog as $$
      select case when jsonb_array_length(payload->'audit'->'afterSubjects')>0
        then payload->'audit'->'afterSubjects' else payload->'audit'->'beforeSubjects' end
      from platform.entity_events
      where tenant_id=tenant_key and aggregate_type=cfg->>'aggregate'
        and payload->'audit'->>'entityType'=cfg->>'entity' and aggregate_id=record_key
        and jsonb_typeof(payload->'audit'->'beforeSubjects')='array'
        and jsonb_typeof(payload->'audit'->'afterSubjects')='array'
      order by sequence desc limit 1
    $$;

    create or replace function platform.audit_subjects(cfg jsonb, row_data jsonb, visited text[] default '{}') returns jsonb
    language plpgsql stable set search_path=pg_catalog as $$
    declare result jsonb='[]'; edge jsonb; parent_row jsonb; parent_id text; tenant text; parent_cfg jsonb; identity text; prior_subjects jsonb;
    begin
      if row_data is null then return result; end if;
      identity=(cfg->>'entity') || ':' || (row_data->>(cfg->>'pk'));
      if identity=any(visited) then return result; end if;
      if cardinality(visited)>64 then raise exception 'Audit timeline ancestry exceeds 64 records'; end if;
      visited=array_append(visited,identity);
      result=jsonb_build_array(jsonb_build_object('entityType',cfg->>'entity','recordId',row_data->>(cfg->>'pk')));
      tenant=row_data->>'tenant_id';
      for edge in select * from jsonb_array_elements(cfg->'parents') loop
        parent_cfg=platform.audit_config(edge->>'entity');
        parent_id=row_data->>(edge->>'column');
        if parent_id is not null then
          result=result || jsonb_build_array(jsonb_build_object('entityType',edge->>'entity','recordId',parent_id));
          execute format('select to_jsonb(p) from %I.%I p where %I::text=$1 and tenant_id::text=$2',parent_cfg->>'schema',parent_cfg->>'table',parent_cfg->>'pk') into parent_row using parent_id,tenant;
          if parent_row is not null then result=result || platform.audit_subjects(parent_cfg,parent_row,visited);
          else
            prior_subjects=platform.audit_recorded_subjects(parent_cfg,parent_id,tenant::uuid);
            result=result || coalesce(prior_subjects,'[]'::jsonb);
          end if;
        end if;
      end loop;
      select coalesce(jsonb_agg(distinct e),'[]') into result from jsonb_array_elements(result) e;
      return result;
    end $$;

    create or replace function platform.audit_record_values(cfg jsonb, row_data jsonb) returns jsonb
    language plpgsql immutable set search_path=pg_catalog as $$
    declare result jsonb='{}'; k text; field jsonb;
    begin
      if row_data is null then return null; end if;
      for k,field in select * from jsonb_each(cfg->'fields') loop
        result=result || jsonb_build_object(field->>'name',case when (field->>'hidden')::boolean then '"[REDACTED]"'::jsonb when (field->>'exact')::boolean and row_data->k<>'null'::jsonb then to_jsonb(row_data->>k) else platform.audit_redact(row_data->k) end);
      end loop; return result;
    end $$;

    create or replace function platform.audit_business_row() returns trigger
    language plpgsql set search_path=pg_catalog as $$
    declare cfg jsonb=TG_ARGV[0]::jsonb; prior jsonb; current_row jsonb; event_row jsonb; before_subjects jsonb; after_subjects jsonb;
      before_values jsonb; after_values jsonb; changes jsonb; subjects jsonb; visibility jsonb;
    begin
      if TG_OP='UPDATE' and to_jsonb(OLD)=to_jsonb(NEW) then return NEW; end if;
      if TG_OP<>'INSERT' then prior=to_jsonb(OLD); end if;
      if TG_OP<>'DELETE' then current_row=to_jsonb(NEW); end if;
      event_row=coalesce(current_row,prior);
      before_values=platform.audit_record_values(cfg,prior); after_values=platform.audit_record_values(cfg,current_row);
      select coalesce(jsonb_agg(field->>'name' order by field->>'name'),'[]') into changes
        from jsonb_each(cfg->'fields') f(k,field) where (prior->k) is distinct from (current_row->k);
      before_subjects=platform.audit_subjects(cfg,prior); after_subjects=platform.audit_subjects(cfg,current_row);
      select coalesce(jsonb_agg(distinct e),'[]') into subjects from jsonb_array_elements(before_subjects||after_subjects) e;
      select coalesce(jsonb_object_agg(k,event_row->k),'{}') into visibility from jsonb_array_elements_text(cfg->'visibility') k;
      insert into platform.entity_events(tenant_id,aggregate_type,aggregate_id,event_type,payload,occurred_at)
        values((event_row->>'tenant_id')::uuid,cfg->>'aggregate',event_row->>(cfg->>'pk'),
          case TG_OP when 'INSERT' then 'created' when 'UPDATE' then 'updated' else 'deleted' end,
          jsonb_build_object('table',TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME,'schema',TG_TABLE_SCHEMA,'operation',case TG_OP when 'INSERT' then 'created' when 'UPDATE' then 'updated' else 'deleted' end, 'visibility',visibility,
            'audit',jsonb_build_object('entityType',cfg->>'entity','before',before_values,'after',after_values,'changedFields',changes,'subjects',subjects,'beforeSubjects',before_subjects,'afterSubjects',after_subjects)),clock_timestamp());
      return null;
    end $$;

    create or replace function platform.track_field_value_since() returns trigger
    language plpgsql security definer set search_path=pg_catalog as $$
    declare cfg jsonb=TG_ARGV[0]::jsonb; prior jsonb; current_row jsonb; event_row jsonb; tracked_column text; tracked_field text;
    begin
      if TG_OP<>'INSERT' then prior=to_jsonb(OLD); end if;
      if TG_OP<>'DELETE' then current_row=to_jsonb(NEW); end if;
      event_row=coalesce(current_row,prior);
      for tracked_column,tracked_field in select key,value from jsonb_each_text(cfg->'tracked') loop
        if TG_OP='DELETE' then
          delete from platform.field_value_since where tenant_id=(event_row->>'tenant_id')::uuid and entity_type=cfg->>'entity'
            and record_id=event_row->>(cfg->>'pk') and field_key=tracked_field;
        elsif TG_OP='INSERT' or (prior->tracked_column) is distinct from (current_row->tracked_column) then
          insert into platform.field_value_since(tenant_id,entity_type,record_id,field_key,since_at)
            values((event_row->>'tenant_id')::uuid,cfg->>'entity',event_row->>(cfg->>'pk'),tracked_field,clock_timestamp())
            on conflict (tenant_id,entity_type,record_id,field_key) do update set since_at=excluded.since_at;
        end if;
      end loop;
      return null;
    end $$;

    create or replace function platform.audit_event_envelope() returns trigger
    language plpgsql set search_path=pg_catalog as $$
    declare envelope jsonb=coalesce(NEW.payload->'audit','{}'::jsonb); identity text; correlation text; changes jsonb;
      entity text; cfg jsonb; source_row jsonb; observed_subjects jsonb;
    begin
      if TG_OP='UPDATE' then
        if (to_jsonb(NEW)-'delivery_sequence') is distinct from (to_jsonb(OLD)-'delivery_sequence') then raise exception 'Audit events are immutable' using errcode='42501'; end if;
        return NEW;
      elsif TG_OP='DELETE' then raise exception 'Audit events are append-only' using errcode='42501'; end if;
      if jsonb_typeof(NEW.payload)<>'object' then raise exception 'Audit payload must be an object' using errcode='22023'; end if;
      changes=coalesce(envelope->'changedFields',NEW.payload->'changedFields','[]'::jsonb);
      if jsonb_typeof(changes)<>'array' or exists(select 1 from jsonb_array_elements(changes) e where jsonb_typeof(e)<>'string') then raise exception 'Invalid audit changed fields' using errcode='22023'; end if;
      if envelope ? 'subjects' and (jsonb_typeof(envelope->'subjects')<>'array' or exists(select 1 from jsonb_array_elements(envelope->'subjects') e where jsonb_typeof(e->'entityType') is distinct from 'string' or jsonb_typeof(e->'recordId') is distinct from 'string')) then raise exception 'Invalid audit subjects' using errcode='22023'; end if;
      entity=coalesce(envelope->>'entityType',platform.audit_entity_name(NEW.aggregate_type),NEW.aggregate_type);
      if not (envelope ? 'subjects') then
        cfg=platform.audit_config(entity);
        if cfg is not null then
          execute format('select to_jsonb(p) from %I.%I p where %I::text=$1 and tenant_id=$2',cfg->>'schema',cfg->>'table',cfg->>'pk')
            into source_row using NEW.aggregate_id,NEW.tenant_id;
          if source_row is not null then observed_subjects=platform.audit_subjects(cfg,source_row);
          else observed_subjects=platform.audit_recorded_subjects(cfg,NEW.aggregate_id,NEW.tenant_id); end if;
        end if;
      end if;
      identity=coalesce(nullif(current_setting('app.audit_identity_id',true),''),nullif(current_setting('app.user_id',true),''),nullif(current_setting('app.audit_actor_subject',true),''));
      correlation=coalesce(nullif(current_setting('app.audit_correlation',true),''),pg_current_xact_id()::text);
      NEW.payload=platform.audit_redact(coalesce(NEW.payload,'{}'::jsonb)) || jsonb_build_object('audit',platform.audit_redact(envelope) || jsonb_build_object(
        'version',2,'entityType',entity,
        'actorIdentityId',nullif(current_setting('app.audit_identity_id',true),''),
        'actorSubject',coalesce(nullif(current_setting('app.audit_actor_subject',true),''),nullif(current_setting('app.user_id',true),'')),'actorIssuer',nullif(current_setting('app.audit_actor_issuer',true),''),
        'actorId',identity,'actorKind',coalesce(nullif(current_setting('app.audit_actor_kind',true),''),'system'),
        'operationId',nullif(current_setting('app.audit_operation',true),''),'correlationId',correlation,
        'changedFields',changes,
        'subjects',coalesce(envelope->'subjects',observed_subjects,jsonb_build_array(jsonb_build_object('entityType',entity,'recordId',NEW.aggregate_id)))));
      return NEW;
    end $$;
    create or replace function platform.audit_event_subjects(payload jsonb, entity text, record text) returns jsonb
    language sql immutable set search_path=pg_catalog as $$
      select coalesce(payload->'audit'->'subjects',jsonb_build_array(jsonb_build_object('entityType',entity,'recordId',record)))
    $$;
    create index if not exists audit_event_time_idx on platform.entity_events(tenant_id,occurred_at desc,id desc);
    create index if not exists audit_event_entity_idx on platform.entity_events(tenant_id,(coalesce(payload->'audit'->>'entityType',aggregate_type)),occurred_at desc,id desc);
    create index if not exists audit_event_subjects_idx on platform.entity_events using gin(platform.audit_event_subjects(payload,aggregate_type,aggregate_id));
    drop trigger if exists audit_event_envelope on platform.entity_events;
    create trigger audit_event_envelope before insert or update or delete on platform.entity_events for each row execute function platform.audit_event_envelope();
  `).execute(db);
  for (const config of configs) {
    const qualified = sql.id(config.schema, config.table);
    // Lock the business table before inspecting or replacing its tracking
    // trigger, so no writer can slip through while its configuration changes.
    await sql`lock table ${qualified} in access exclusive mode`.execute(db);
    const existing = await sql<{ config: string | null; enabled: boolean }>`select tgenabled in ('O','A') as enabled, case when tgnargs=1 then convert_from(substring(tgargs from 1 for octet_length(tgargs)-1),'UTF8') else null end as config
      from pg_trigger where tgrelid=${`${config.schema}.${config.table}`}::regclass and tgname='track_field_value_since' and not tgisinternal`.execute(db);
    const previous = existing.rows[0]?.config ? JSON.parse(existing.rows[0].config) as Config : undefined;
    const oldFields = new Set(Object.values(previous?.tracked ?? {}));
    const newFields = new Set(Object.values(config.tracked));
    const sourceColumn = (columns: Record<string, string> | undefined, field: string) => Object.entries(columns ?? {}).find(([, value]) => value === field)?.[0];
    // Renames conservatively invalidate coverage: a new identity must never
    // inherit timestamps recorded for a different field or entity.
    const resetFields = [...new Set([...oldFields, ...newFields])].filter(field => !existing.rows[0]?.enabled || previous?.entity !== config.entity ||
      sourceColumn(previous?.tracked, field) !== sourceColumn(config.tracked, field) ||
      previous?.trackingTargets?.[field] !== config.trackingTargets[field]);
    if (resetFields.length) {
      // The migrator is intentionally not a BYPASSRLS role. This transaction-
      // local maintenance context clears stale ages across tenants before a
      // tracker is enabled, and is restored before normal migration work.
      const previousBypass = (await sql<{ value: string | null }>`select current_setting('app.bypass_rls', true) as value`.execute(db)).rows[0]?.value ?? "";
      await sql`select set_config('app.bypass_rls','true',true)`.execute(db);
      try {
        await sql`delete from platform.field_value_since where entity_type=${config.entity} and field_key in (${sql.join(resetFields.map(field => sql`${field}`))})`.execute(db);
        if (previous?.entity && previous.entity !== config.entity) {
          await sql`delete from platform.field_value_since where entity_type=${previous.entity} and field_key in (${sql.join(resetFields.map(field => sql`${field}`))})`.execute(db);
        }
      } finally {
        await sql`select set_config('app.bypass_rls',${previousBypass},true)`.execute(db);
      }
    }
    await sql`drop trigger if exists audit_business_row on ${qualified}`.execute(db);
    const argument = literal(JSON.stringify(config));
    await sql`create trigger audit_business_row after insert or update or delete on ${qualified} for each row execute function platform.audit_business_row(${sql.raw(argument)})`.execute(db);
    await sql`drop trigger if exists track_field_value_since on ${qualified}`.execute(db);
    if (Object.keys(config.tracked).length) {
      await sql`create trigger track_field_value_since after insert or update or delete on ${qualified} for each row execute function platform.track_field_value_since(${sql.raw(argument)})`.execute(db);
    }
  }
}
