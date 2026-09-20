// SPDX-License-Identifier: BUSL-1.1
import { sql } from "kysely";
import { IDENTITY_LINK_ADMIN_ROLE } from "../../auth/organization-roles.js";
import type { OpenShapeForgeDatabase } from "../connection.js";
import { ensureCheckConstraint } from "./sql-invariants.js";

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
 *   - `app.identity_subject()`, the point lookup the write policy needs;
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
 *     identity's subject is read through app.identity_subject() so the two
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
    -- The subject behind an identity id, for the write policy below. A
    -- function-scoped bypass (the same shape as app.tenant_for_keycloak_
    -- organization) rather than a subquery: the two tables' policies refer to
    -- each other, and a subquery in each direction is a policy recursion
    -- PostgreSQL refuses. A point lookup of one column, nothing else.
    create or replace function app.identity_subject(identity uuid) returns text
    language plpgsql volatile parallel unsafe
    as $$
    declare
      previous_bypass text := current_setting('app.bypass_rls', true);
      identity_subject text;
    begin
      perform set_config('app.bypass_rls', 'true', true);
      identity_subject := (select i.subject from platform.identities i where i.id = identity);
      perform set_config('app.bypass_rls', coalesce(previous_bypass, ''), true);
      return identity_subject;
    exception when others then
      raise;
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
        or subject = current_setting('app.user_id', true)
        or exists (
          select 1 from platform.identity_relations ir
           where ir.identity_id = identities.id
             and ir.tenant_id = app.current_tenant()
        )
      )
      with check (
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
            app.identity_subject(identity_id) = current_setting('app.user_id', true)
            or ${sql.lit(IDENTITY_LINK_ADMIN_ROLE)} = any (
              string_to_array(coalesce(current_setting('app.roles', true), ''), ',')
            )
          )
        )
      );
  `.execute(db);
}
