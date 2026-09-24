// SPDX-License-Identifier: BUSL-1.1
import { sql } from "kysely";
import { IDENTITY_LINK_ADMIN_ROLE } from "../../auth/organization-roles.js";
import type { OpenShapeForgeDatabase } from "../connection.js";
import { databaseRole } from "../database-roles.js";
import { ensureCheckConstraint } from "./sql-invariants.js";
import { APP_ROLE } from "./app-role.js";

const IDENTITY_RESOLVER_ROLE = databaseRole("identityResolver").name;

/**
 * The invariants of the login ↔ party link that the manifest cannot express.
 *
 * The two tables — platform.identities (one row per identity-provider login)
 * and platform.identity_relations (one row per identity × tenant, LINKED to
 * a Relation or PENDING confirmation) — are declared in
 * packages/compiler/config/platform-schema.yaml and created by the generated
 * step. This file runs after it and adds, idempotently on every migrate:
 *
 *   - the `lower(email)` lookup index (an expression index);
 *   - the status vocabulary and the columns each status requires, as checks;
 *   - `app.identity_subject()`, the boolean subject predicate the write policy needs;
 *   - row-level security and the two bespoke policies;
 *   - the guard on `roles`: the organization-scoped grant may only be changed
 *     by a session holding Organization.All.ReadWrite or by the audited
 *     bypass. The write policy below lets an identity write its OWN row
 *     (confirm_my_link, onboarding state), and without this trigger that
 *     same permission would let a person raise their own roles through any
 *     raw-SQL path — the one column on the row the person may never touch.
 *
 * Row-level security, consistent with the rest of platform.*:
 *   - identity_relations is tenant-fenced the way erp.relations is
 *     (`tenant_id = app.current_tenant()`), so a link made in tenant A is
 *     invisible from a session in tenant B. Writes additionally require the
 *     acting session to be the identity itself (the just-in-time path and
 *     confirm_my_link) or to hold Organization.All.ReadWrite (link_identity);
 *     the tools check the same thing, this is the defence in depth. The
 *     identity's subject is compared through app.identity_subject() so the two
 *     policies do not query each other (policy recursion).
 *   - identities has no tenant column. A session sees its OWN identity row
 *     (`subject = app.user_id`, compared as text: the subject is Keycloak's
 *     user id and a bypass session's actor is not a uuid, so the uuid cast in
 *     app.current_user_id() would fail there before the bypass clause could
 *     answer) and the identities that have a row —
 *     linked or pending — in its tenant. An administrator therefore cannot
 *     enumerate people who never signed in to their organization.
 */
export async function applyIdentityLinkMigration(db: OpenShapeForgeDatabase) {
  await sql`
    create index if not exists identities_email_idx
      on platform.identities (lower(email));
  `.execute(db);

  await ensureCheckConstraint(db, {
    table: "platform.identity_relations",
    name: "identity_relations_status_check",
    expression: "status in ('linked', 'pending_confirmation')",
  });
  await ensureCheckConstraint(db, {
    table: "platform.identity_relations",
    name: "identity_relations_status_shape",
    expression: `
      (status = 'linked' and relation_id is not null and linked_at is not null and linked_by is not null)
      or (status = 'pending_confirmation' and relation_id is null)
    `,
  });

  await sql`
    -- These two SECURITY DEFINER functions are deliberately point lookups.
    -- Their non-login owner can SELECT only the named registry columns and is
    -- admitted by role-specific read policies. No statement-local bypass GUC
    -- is raised: a STABLE policy helper that observes such a temporary value
    -- can otherwise reuse the true result for the rest of the caller's write statement.
    grant usage on schema app, platform to ${sql.id(IDENTITY_RESOLVER_ROLE)};
    grant select (id, keycloak_realm, keycloak_organization_id)
      on platform.tenants to ${sql.id(IDENTITY_RESOLVER_ROLE)};
    grant select (id, subject)
      on platform.identities to ${sql.id(IDENTITY_RESOLVER_ROLE)};

    drop policy if exists tenants_identity_resolution on platform.tenants;
    create policy tenants_identity_resolution on platform.tenants for select
      to ${sql.id(IDENTITY_RESOLVER_ROLE)} using (true);
    drop policy if exists identities_identity_resolution on platform.identities;
    create policy identities_identity_resolution on platform.identities for select
      to ${sql.id(IDENTITY_RESOLVER_ROLE)} using (true);

    create or replace function app.tenant_for_keycloak_organization(
      realm text,
      organization_id text
    ) returns uuid
    language sql stable security definer
    set search_path = pg_catalog
    as $fn$
      select t.id
        from platform.tenants t
       where t.keycloak_realm = $1
         and t.keycloak_organization_id = $2
       limit 1
    $fn$;

    -- Older reruns may have the original text-returning helper underneath
    -- these policies. Remove its dependants before changing the return type.
    drop policy if exists identity_relations_insertable on platform.identity_relations;
    drop policy if exists identity_relations_updatable on platform.identity_relations;
    drop policy if exists identity_relations_deletable on platform.identity_relations;
    drop function if exists app.identity_subject(uuid);

    -- Keep the established function name, but expose only the predicate the
    -- policies need. The app role cannot use an identity UUID as a global
    -- subject-disclosure oracle.
    create or replace function app.identity_subject(identity uuid) returns boolean
    language sql stable security definer
    set search_path = pg_catalog
    as $fn$
      select exists (
        select 1
          from platform.identities i
         where i.id = $1
           and i.subject = current_setting('app.user_id', true)
      )
    $fn$;

    grant create on schema app to ${sql.id(IDENTITY_RESOLVER_ROLE)};
    alter function app.tenant_for_keycloak_organization(text, text)
      owner to ${sql.id(IDENTITY_RESOLVER_ROLE)};
    alter function app.identity_subject(uuid)
      owner to ${sql.id(IDENTITY_RESOLVER_ROLE)};
    revoke create on schema app from ${sql.id(IDENTITY_RESOLVER_ROLE)};
    revoke all on function app.tenant_for_keycloak_organization(text, text) from public;
    revoke all on function app.identity_subject(uuid) from public;
    grant execute on function app.tenant_for_keycloak_organization(text, text) to ${sql.id(APP_ROLE)};
    grant execute on function app.identity_subject(uuid) to ${sql.id(APP_ROLE)};

    alter table platform.identities enable row level security;
    alter table platform.identities force row level security;
    alter table platform.identity_relations enable row level security;
    alter table platform.identity_relations force row level security;

    drop policy if exists identities_visibility on platform.identities;
    drop policy if exists identities_insertable on platform.identities;
    drop policy if exists identities_updatable on platform.identities;
    drop policy if exists identities_deletable on platform.identities;
    create policy identities_visibility on platform.identities for select to ${sql.id(APP_ROLE)}
      using (
        app.bypass_rls()
        or subject = current_setting('app.user_id', true)
        or exists (
          select 1 from platform.identity_relations ir
           where ir.identity_id = identities.id
             and ir.tenant_id = app.current_tenant()
        )
      );
    create policy identities_insertable on platform.identities for insert to ${sql.id(APP_ROLE)}
      with check (
        app.bypass_rls()
        or subject = current_setting('app.user_id', true)
      );
    create policy identities_updatable on platform.identities for update to ${sql.id(APP_ROLE)}
      using (
        app.bypass_rls()
        or subject = current_setting('app.user_id', true)
      )
      with check (
        app.bypass_rls()
        or subject = current_setting('app.user_id', true)
      );
    create policy identities_deletable on platform.identities for delete to ${sql.id(APP_ROLE)}
      using (
        app.bypass_rls()
        or subject = current_setting('app.user_id', true)
      );

    create or replace function app.identity_relation_roles_guard() returns trigger
    language plpgsql
    as $$
    begin
      if tg_op = 'UPDATE' and new.roles is not distinct from old.roles then
        return new;
      end if;
      if tg_op = 'INSERT' and coalesce(array_length(new.roles, 1), 0) = 0 then
        return new;
      end if;
      if app.bypass_rls() or ${sql.lit(IDENTITY_LINK_ADMIN_ROLE)} = any (
        string_to_array(coalesce(current_setting('app.roles', true), ''), ',')
      ) then
        return new;
      end if;
      raise exception 'identity_relations.roles may only be changed by an organization administrator'
        using errcode = 'insufficient_privilege';
    end
    $$;

    drop trigger if exists identity_relations_roles_guard on platform.identity_relations;
    create trigger identity_relations_roles_guard
      before insert or update of roles on platform.identity_relations
      for each row execute function app.identity_relation_roles_guard();

    drop policy if exists identity_relations_tenant_isolation on platform.identity_relations;
    drop policy if exists identity_relations_insertable on platform.identity_relations;
    drop policy if exists identity_relations_updatable on platform.identity_relations;
    drop policy if exists identity_relations_deletable on platform.identity_relations;
    create policy identity_relations_tenant_isolation on platform.identity_relations for select to ${sql.id(APP_ROLE)}
      using (
        app.bypass_rls()
        or tenant_id = app.current_tenant()
      );
    create policy identity_relations_insertable on platform.identity_relations for insert to ${sql.id(APP_ROLE)}
      with check (
        app.bypass_rls()
        or (
          tenant_id = app.current_tenant()
          and (
            app.identity_subject(identity_id)
            or ${sql.lit(IDENTITY_LINK_ADMIN_ROLE)} = any (
              string_to_array(coalesce(current_setting('app.roles', true), ''), ',')
            )
          )
        )
      );
    create policy identity_relations_updatable on platform.identity_relations for update to ${sql.id(APP_ROLE)}
      using (
        app.bypass_rls()
        or (
          tenant_id = app.current_tenant()
          and (
            app.identity_subject(identity_id)
            or ${sql.lit(IDENTITY_LINK_ADMIN_ROLE)} = any (
              string_to_array(coalesce(current_setting('app.roles', true), ''), ',')
            )
          )
        )
      )
      with check (
        app.bypass_rls()
        or (
          tenant_id = app.current_tenant()
          and (
            app.identity_subject(identity_id)
            or ${sql.lit(IDENTITY_LINK_ADMIN_ROLE)} = any (
              string_to_array(coalesce(current_setting('app.roles', true), ''), ',')
            )
          )
        )
      );
    create policy identity_relations_deletable on platform.identity_relations for delete to ${sql.id(APP_ROLE)}
      using (
        app.bypass_rls()
        or (
          tenant_id = app.current_tenant()
          and (
            app.identity_subject(identity_id)
            or ${sql.lit(IDENTITY_LINK_ADMIN_ROLE)} = any (
              string_to_array(coalesce(current_setting('app.roles', true), ''), ',')
            )
          )
        )
      );
  `.execute(db);
}
