// SPDX-License-Identifier: BUSL-1.1
import { sql, type Kysely } from "kysely";
import type { VersionedMigration } from "../versioned-runner.js";

/**
 * 0010_relation-group-memberships
 *
 * Replaces the legacy single Relation.relation_group_id authoring input with
 * an explicit many-to-many membership entity. The old column is deliberately
 * retained: it remains a read-only provenance field, while existing non-null
 * links are copied once into erp.relation_group_memberships.
 *
 * RelationGroup.relation_id is NOT a membership. It is retained as the
 * group's optional ownership/context relation and is never backfilled here.
 *
 * The migration runs before the generated roll-forward. On an upgrade it
 * therefore creates the new table in its exact generated column shape so it
 * can preserve legacy links before the compiler takes ownership. On a fresh
 * install the old parent tables do not exist yet, so the generated schema
 * creates all three tables directly and this migration is a no-op.
 *
 * Existing groups did not have a type and may have had a null status. They are
 * assigned the neutral `general` type and an `active` status so current access
 * is preserved. Unknown non-null statuses are refused rather than silently
 * remapped to a different lifecycle meaning.
 *
 * Applied migrations are immutable: platform.schema_migrations records the
 * sha256 of THIS FILE and re-verifies it on every migrate run. Once this
 * migration has been applied anywhere, do not edit it — transform forward in
 * a new migration instead.
 */

async function tableExists(
  db: Kysely<any>,
  schema: string,
  table: string,
): Promise<boolean> {
  const result = await sql<{ present: boolean }>`
    select to_regclass(${`${schema}.${table}`}) is not null as present
  `.execute(db);
  return result.rows[0]?.present ?? false;
}

const migration: VersionedMigration = {
  version: "0010_relation-group-memberships",
  fileUrl: import.meta.url,
  async up(db: Kysely<any>): Promise<void> {
    const groupsExist = await tableExists(db, "erp", "relation_groups");
    const relationsExist = await tableExists(db, "erp", "relations");

    if (!groupsExist) return;

    await sql`
      alter table erp.relation_groups
        add column if not exists group_type text
    `.execute(db);
    await sql`
      update erp.relation_groups
      set group_type = 'general'
      where group_type is null
    `.execute(db);

    await sql`
      alter table erp.relation_groups
        add column if not exists status text
    `.execute(db);
    await sql`
      update erp.relation_groups
      set status = 'active'
      where status is null
    `.execute(db);

    const invalidStatuses = await sql<{ count: string }>`
      select count(*)::text as count
      from erp.relation_groups
      where status not in ('active', 'inactive')
    `.execute(db);
    if (invalidStatuses.rows[0]?.count !== "0") {
      throw new Error(
        "RelationGroup migration refused: existing status is not active or inactive.",
      );
    }

    await sql`
      alter table erp.relation_groups
        alter column group_type set not null,
        alter column status set default 'active',
        alter column status set not null
    `.execute(db);

    if (!relationsExist) return;

    await sql`
      create table if not exists erp.relation_group_memberships (
        id uuid primary key not null default gen_random_uuid(),
        tenant_id uuid not null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        external_id text,
        source_authority text,
        source_organization text,
        source_administration text,
        relation_id uuid not null,
        relation_group_id uuid not null,
        status text not null default 'active'
      )
    `.execute(db);
    await sql`
      create unique index if not exists relation_group_memberships_tenant_relation_group_uidx
      on erp.relation_group_memberships (tenant_id, relation_id, relation_group_id)
    `.execute(db);

    const invalidLegacyLinks = await sql<{ count: string }>`
      select count(*)::text as count
      from erp.relations as relation
      where relation.relation_group_id is not null
        and not exists (
          select 1
          from erp.relation_groups as relation_group
          where relation_group.id = relation.relation_group_id
            and relation_group.tenant_id = relation.tenant_id
        )
    `.execute(db);
    if (invalidLegacyLinks.rows[0]?.count !== "0") {
      throw new Error(
        "RelationGroup membership migration refused: a legacy relation_group_id does not reference a group in the same tenant.",
      );
    }

    await sql`
      insert into erp.relation_group_memberships (
        tenant_id,
        relation_id,
        relation_group_id,
        status
      )
      select
        relation.tenant_id,
        relation.id,
        relation.relation_group_id,
        'active'
      from erp.relations as relation
      where relation.relation_group_id is not null
      on conflict (tenant_id, relation_id, relation_group_id) do nothing
    `.execute(db);
  },
};

export default migration;
