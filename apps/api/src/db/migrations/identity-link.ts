// SPDX-License-Identifier: BUSL-1.1
import { sql } from "kysely";
import type { OpenShapeForgeDatabase } from "../connection.js";

/**
 * Runtime-owned tables that tie a login (an identity at the identity
 * provider) to the party it is in an organization: an OpenShapeForge Relation.
 *
 *   platform.identities          one row per (issuer, subject) — platform-level,
 *                                because the same person signs in to several
 *                                tenants with the same Keycloak account.
 *   platform.identity_relations  one row per (identity, tenant): either LINKED
 *                                to a Relation in that tenant, or PENDING with
 *                                the Relation the person is probably (an e-mail
 *                                match) but that nobody has confirmed yet.
 *
 * Neither table is manifest-managed (like platform.system_bypass_audit and
 * platform.mcp_handoffs), so this is idempotent DDL applied on every migrate
 * run rather than a versioned migration. It runs AFTER the generated
 * roll-forward on purpose: both foreign keys point at generated tables
 * (platform.tenants, erp.relations), which do not exist yet on a fresh
 * database while the versioned step runs. The app-role grant sweep that
 * follows covers the two tables like any other.
 *
 * Row-level security, consistent with the rest of platform.*:
 *   - identity_relations is tenant-fenced the way erp.relations is
 *     (`tenant_id = app.current_tenant()`), so a link made in tenant A is
 *     invisible from a session in tenant B. Writes additionally require the
 *     acting session to be the identity itself (the just-in-time path and
 *     confirm_my_link) or to hold Organization.All.ReadWrite (link_identity);
 *     the tools check the same thing, this is the defence in depth. The
 *     identity's subject is read through app.identity_subject() so the two
 *     policies do not query each other (policy recursion).
 *   - identities has no tenant column. A session sees its OWN identity row
 *     (`subject = app.current_user_id()`) and the identities that have a row —
 *     linked or pending — in its tenant. An administrator therefore cannot
 *     enumerate people who never signed in to their organization.
 */
export async function applyIdentityLinkMigration(db: OpenShapeForgeDatabase) {
  await sql`
    create schema if not exists platform;

    create table if not exists platform.identities (
      id            uuid primary key default gen_random_uuid(),
      issuer        text not null,
      subject       text not null,
      email         text,
      display_name  text,
      created_at    timestamptz not null default now(),
      updated_at    timestamptz not null default now(),
      unique (issuer, subject)
    );

    create index if not exists identities_email_idx
      on platform.identities (lower(email));

    create table if not exists platform.identity_relations (
      identity_id            uuid not null references platform.identities (id) on delete cascade,
      tenant_id              uuid not null references platform.tenants (id) on delete cascade,
      relation_id            uuid references erp.relations (id) on delete cascade,
      status                 text not null check (status in ('linked', 'pending_confirmation')),
      candidate_relation_id  uuid references erp.relations (id) on delete set null,
      linked_at              timestamptz,
      -- 'jit' for the just-in-time path, otherwise the platform.identities id
      -- of whoever linked: the person (confirm_my_link) or an administrator.
      linked_by              text,
      created_at             timestamptz not null default now(),
      updated_at             timestamptz not null default now(),
      primary key (identity_id, tenant_id),
      constraint identity_relations_status_shape check (
        (status = 'linked' and relation_id is not null and linked_at is not null and linked_by is not null)
        or (status = 'pending_confirmation' and relation_id is null)
      )
    );

    create index if not exists identity_relations_tenant_relation_idx
      on platform.identity_relations (tenant_id, relation_id);

    -- The subject behind an identity id, for the write policy below. A
    -- function-scoped bypass (the same shape as app.tenant_for_keycloak_
    -- organization) rather than a subquery: the two tables' policies refer to
    -- each other, and a subquery in each direction is a policy recursion
    -- PostgreSQL refuses. A point lookup of one column, nothing else.
    create or replace function app.identity_subject(identity uuid) returns text
    language plpgsql stable parallel safe
    set app.bypass_rls = 'true'
    as $$
    begin
      return (select i.subject from platform.identities i where i.id = identity);
    end
    $$;

    alter table platform.identities enable row level security;
    alter table platform.identities force row level security;
    alter table platform.identity_relations enable row level security;
    alter table platform.identity_relations force row level security;

    drop policy if exists identities_visibility on platform.identities;
    create policy identities_visibility on platform.identities
      using (
        app.bypass_rls()
        or subject = app.current_user_id()::text
        or exists (
          select 1 from platform.identity_relations ir
           where ir.identity_id = identities.id
             and ir.tenant_id = app.current_tenant()
        )
      )
      with check (
        app.bypass_rls()
        or subject = app.current_user_id()::text
      );

    drop policy if exists identity_relations_tenant_isolation on platform.identity_relations;
    create policy identity_relations_tenant_isolation on platform.identity_relations
      using (
        app.bypass_rls()
        or tenant_id = app.current_tenant()
      )
      with check (
        app.bypass_rls()
        or (
          tenant_id = app.current_tenant()
          and (
            app.identity_subject(identity_id) = app.current_user_id()::text
            or 'Organization.All.ReadWrite' = any (
              string_to_array(coalesce(current_setting('app.roles', true), ''), ',')
            )
          )
        )
      );
  `.execute(db);
}
