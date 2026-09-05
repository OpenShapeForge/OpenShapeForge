// SPDX-License-Identifier: BUSL-1.1
import { sql } from "kysely";
import type { OpenShapeForgeDatabase } from "../connection.js";

/**
 * `platform.tenants.relation_id` — the tenant's own organization Relation
 * (auth/organization-relation.ts, mcp/organization-profile-tools.ts), used so
 * an assistant can read `Relation.businessContext` for "what does this
 * company do" without a human ever pasting a description into a prompt.
 *
 * WHY THIS IS A HAND-WRITTEN MIGRATION, NOT A `platform-schema.yaml` COLUMN
 * ---------------------------------------------------------------------------
 * `platform.tenants` IS declared in platform-schema.yaml (`tenantIdentityColumn:
 * id`), but that manifest cannot express this column: the compiler creates the
 * platform schema BEFORE the generated `erp` schema (a tenant registry has to
 * exist first — every tenant-scoped table's `tenant_id` points at it), so a
 * `references: { schema: erp, table: relations }` on a platform-schema.yaml
 * column would ask Postgres to foreign-key a table that does not exist yet.
 * Same reasoning as `platform.identity_relations.relation_id`
 * (identity-link.ts) and `platform.identity_relations.candidate_relation_id` —
 * this is idempotent DDL, applied AFTER the generated roll-forward, right next
 * to those for the same reason: the FK target, `erp.relations`, exists only
 * once that step has run.
 *
 * `add column if not exists` on a table the generated roll-forward already
 * owns is safe: the compiler's own DDL for `platform.tenants` is `CREATE TABLE
 * IF NOT EXISTS` (it never drops or redefines the table), so a column this
 * migration added is never fought over.
 *
 * WRITE ACCESS
 * ---------------------------------------------------------------------------
 * `platform.tenants` normally accepts writes only through the audited
 * `withSystemSession` bypass (see `control/tenant-registry.ts`) — its
 * generated `tenants_tenant_registry` policy's WITH CHECK is `app.bypass_rls()`
 * only, because every other mutable column (`status`, `name`,
 * `keycloak_organization_id`, ...) is control-plane-owned. `relation_id` is
 * different: it is a tenant's own self-service link (`set_organization_relation`,
 * for `Organization.All.ReadWrite`, mirroring the identity-link write gate),
 * not a control-plane operation, so it needs its own path into the row.
 *
 * A second PERMISSIVE policy, scoped to UPDATE only, is added rather than
 * touching the generated policy (which regenerates from platform-schema.yaml
 * and would drop a hand-edit on the next roll-forward that happens to
 * reapply it). Postgres OR's every permissive policy's USING/WITH CHECK
 * together, so this only ADDS a path — the generated policy's own protection
 * for every other column is untouched, and the application layer
 * (`setOrganizationRelation`) is what actually restricts the UPDATE
 * statement it issues to `relation_id`.
 */
export async function applyOrganizationRelationLinkMigration(db: OpenShapeForgeDatabase) {
  await sql`
    alter table platform.tenants
      add column if not exists relation_id uuid;

    -- Tenant-consistent since OSF #509. erp.relations is keyed on
    -- (tenant_id, id), and platform.tenants IS the tenant registry, so this
    -- row's own id is the tenant half of the key. The pair therefore says
    -- exactly what the link means: a tenant may only point at a Relation that
    -- lives in itself. A single-column key could not — a foreign-key check
    -- runs as the table owner with row level security bypassed.
    -- SET NULL names its column so unlinking cannot null the tenant's own id.
    do $organization_relation_link_fk$
    begin
      if not exists (
        select 1 from pg_constraint where conname = 'tenants_relation_id_fkey'
      ) then
        alter table platform.tenants
          add constraint tenants_relation_id_fkey
          foreign key (id, relation_id) references erp.relations (tenant_id, id)
          on delete set null (relation_id);
      end if;
    end
    $organization_relation_link_fk$;

    drop policy if exists tenants_relation_link_write on platform.tenants;
    create policy tenants_relation_link_write on platform.tenants
      for update
      using (
        app.bypass_rls()
        or (
          id = app.current_tenant()
          and 'Organization.All.ReadWrite' = any (
            string_to_array(coalesce(current_setting('app.roles', true), ''), ',')
          )
        )
      )
      with check (
        app.bypass_rls()
        or (
          id = app.current_tenant()
          and 'Organization.All.ReadWrite' = any (
            string_to_array(coalesce(current_setting('app.roles', true), ''), ',')
          )
        )
      );
  `.execute(db);
}
