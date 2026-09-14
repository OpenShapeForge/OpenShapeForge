// SPDX-License-Identifier: BUSL-1.1
import { sql } from "kysely";
import type { OpenShapeForgeDatabase } from "../connection.js";
import { APP_ROLE } from "./app-role.js";

/** Published snapshots are the only cross-tenant surface. The definer has no
 * BYPASSRLS and can read only these two bookkeeping tables, never source data. */
export async function applyBlueprintsMigration(db: OpenShapeForgeDatabase) {
  await sql`
    -- The definer role is declared in the database role contract; the host
    -- provisions it and the chain verified the migrate role's membership.
    grant usage on schema app, platform to openshapeforge_blueprint_reader;
    grant execute on function app.current_tenant(), app.current_user_id() to openshapeforge_blueprint_reader;

    create table if not exists platform.blueprint_libraries (
      tenant_id uuid primary key references platform.tenants(id) on delete cascade,
      blueprint_tenant_id uuid not null references platform.tenants(id),
      check (tenant_id <> blueprint_tenant_id)
    );
    create table if not exists platform.blueprint_versions (
      tenant_id uuid not null references platform.tenants(id),
      entity_name text not null,
      blueprint_id text not null check (length(blueprint_id) > 0),
      version integer not null check (version > 0),
      source_record_id uuid not null,
      label text not null,
      reader_roles text[] not null check (cardinality(reader_roles) > 0),
      values_json jsonb not null check (jsonb_typeof(values_json) = 'object'),
      created_at timestamptz not null default now(),
      primary key (tenant_id, entity_name, blueprint_id, version)
    );
    create table if not exists platform.blueprint_copies (
      tenant_id uuid not null references platform.tenants(id) on delete cascade,
      entity_name text not null,
      record_id uuid not null,
      blueprint_tenant_id uuid not null,
      blueprint_id text not null,
      source_version integer not null,
      primary key (tenant_id, entity_name, record_id),
      foreign key (blueprint_tenant_id, entity_name, blueprint_id, source_version)
        references platform.blueprint_versions(tenant_id, entity_name, blueprint_id, version),
      check (tenant_id <> blueprint_tenant_id)
    );
    alter table platform.blueprint_libraries enable row level security;
    alter table platform.blueprint_libraries force row level security;
    alter table platform.blueprint_versions enable row level security;
    alter table platform.blueprint_versions force row level security;
    alter table platform.blueprint_copies enable row level security;
    alter table platform.blueprint_copies force row level security;

    drop policy if exists blueprint_libraries_own on platform.blueprint_libraries;
    create policy blueprint_libraries_own on platform.blueprint_libraries for select
      using (tenant_id = app.current_tenant());
    drop policy if exists blueprint_libraries_reader on platform.blueprint_libraries;
    create policy blueprint_libraries_reader on platform.blueprint_libraries for select
      to openshapeforge_blueprint_reader using (true);
    drop policy if exists blueprint_versions_own on platform.blueprint_versions;
    create policy blueprint_versions_own on platform.blueprint_versions for select
      using (tenant_id = app.current_tenant());
    drop policy if exists blueprint_versions_reader on platform.blueprint_versions;
    create policy blueprint_versions_reader on platform.blueprint_versions for select
      to openshapeforge_blueprint_reader using (true);
    drop policy if exists blueprint_versions_publish on platform.blueprint_versions;
    create policy blueprint_versions_publish on platform.blueprint_versions for insert
      with check (
        tenant_id = app.current_tenant()
        and app.current_user_id() is not null
        and 'platform-operator' = any(string_to_array(current_setting('app.roles', true), ','))
        and exists (select 1 from erp.tenants t where t.tenant_id = app.current_tenant() and t.tenant_kind = 'blueprint')
      );
    drop policy if exists blueprint_copies_own on platform.blueprint_copies;
    create policy blueprint_copies_own on platform.blueprint_copies
      using (tenant_id = app.current_tenant() and app.current_user_id() is not null)
      with check (
        tenant_id = app.current_tenant() and app.current_user_id() is not null
        and exists (
          select 1 from platform.blueprint_libraries l
          where l.tenant_id = app.current_tenant()
            and l.blueprint_tenant_id = blueprint_copies.blueprint_tenant_id
        )
      );

    grant select on platform.blueprint_libraries, platform.blueprint_versions
      to openshapeforge_blueprint_reader;
    create or replace function app.read_blueprints(
      entity text, source_blueprint_id text default null, search text default null,
      page_limit integer default 20, page_offset integer default 0
    ) returns table(tenant_id uuid, blueprint_id text, version integer, label text, values_json jsonb)
    language sql stable security definer
    set search_path = pg_catalog
    as $fn$
      select latest.tenant_id, latest.blueprint_id, latest.version, latest.label, latest.values_json
      from (
        select distinct on (v.blueprint_id)
          v.tenant_id, v.blueprint_id, v.version, v.label, v.values_json, v.reader_roles
        from platform.blueprint_versions v
        join platform.blueprint_libraries l on l.blueprint_tenant_id = v.tenant_id
        where l.tenant_id = app.current_tenant()
          and app.current_user_id() is not null
          and v.entity_name = $1
          and ($2 is null or v.blueprint_id = $2)
        order by v.blueprint_id, v.version desc
      ) latest
      where latest.reader_roles && string_to_array(current_setting('app.roles', true), ',')
        and ($3 is null or latest.label ilike '%' || $3 || '%'
          or latest.blueprint_id ilike '%' || $3 || '%')
      order by latest.label, latest.blueprint_id
      limit greatest(1, least(coalesce($4, 20), 100))
      offset greatest(coalesce($5, 0), 0)
    $fn$;
    -- Postgres requires the incoming owner to hold CREATE on the schema at the
    -- moment of the transfer (a superuser migrator skips that check; the
    -- restricted one does not). Grant it for the transfer only.
    grant create on schema app to openshapeforge_blueprint_reader;
    alter function app.read_blueprints(text, text, text, integer, integer)
      owner to openshapeforge_blueprint_reader;
    revoke create on schema app from openshapeforge_blueprint_reader;
    revoke all on function app.read_blueprints(text, text, text, integer, integer) from public;
    grant execute on function app.read_blueprints(text, text, text, integer, integer) to ${sql.id(APP_ROLE)};
  `.execute(db);
}

/** Reapply after the general app-role grant sweep. RLS independently denies
 * snapshot update/delete and library mutation, even before these revokes. */
export async function applyBlueprintsGrants(db: OpenShapeForgeDatabase) {
  await sql`
    revoke insert, update, delete on platform.blueprint_libraries from ${sql.id(APP_ROLE)};
    revoke update, delete on platform.blueprint_versions from ${sql.id(APP_ROLE)};
    revoke all on function app.read_blueprints(text, text, text, integer, integer) from public;
  `.execute(db);
}
