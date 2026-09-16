// SPDX-License-Identifier: BUSL-1.1
import { sql } from "kysely";
import type { OpenShapeForgeDatabase } from "../connection.js";

/**
 * `platform.employee_invitations` — the pending-role side of an organization
 * administrator inviting a colleague (auth/employee-invitations.ts,
 * mcp/employee-invitation-tools.ts).
 *
 * WHY THIS EXISTS SEPARATELY FROM `platform.identity_relations`
 * ---------------------------------------------------------------------------
 * `identity_relations` (identity-link.ts) only ever gets a row once a person
 * has SIGNED IN at least once — it links a login to a Relation. An invitation
 * happens strictly BEFORE that: nobody has signed in yet, there is no
 * `platform.identities` row to attach anything to, and Keycloak exposes no
 * admin-API resource for an unaccepted `invite-user` call — it cannot be
 * listed, read or deleted, only silently deduped against a repeat invite
 * (verified against the running realm — see keycloak-organization-members.ts).
 * So the one thing
 * this deployment can hold onto between "an admin invited someone" and "that
 * person's first sign-in" is this table: e-mail, the role that was meant for
 * them, and who invited them. It is intentionally NOT a queue of Keycloak
 * state to reconcile against — Keycloak has none — it is Hubble's own memory
 * of an intent, matched by e-mail at first-sign-in time (the specific
 * integration point is named in identity-link.ts's header, next to
 * `ensureIdentityLink`).
 *
 * Not manifest-managed, like platform.identities / identity_relations: this
 * is idempotent DDL applied on every migrate run, positioned right after the
 * identity-link migration in migration-chain.ts for the same reason theirs
 * runs after the generated step — the foreign key targets
 * platform.tenants, which the generated roll-forward creates.
 *
 * SHAPE
 * ---------------------------------------------------------------------------
 *   - One row per (tenant, lower(email)) while `status = 'pending'`: a
 *     partial unique index, not a table-wide one, so revoking and re-inviting
 *     the same address is not a conflict — only two simultaneously PENDING
 *     invitations for the same address in the same tenant are.
 *   - `role` is constrained to the two composite client roles
 *     `local-dev-accounts.py` assigns today (`org_admin`, `org_employee`).
 *     Whatever applies the role after sign-in is free to grow that list; the
 *     check constraint here only has to track what an invitation itself may
 *     name.
 *   - `status` starts `pending`; `revoke_invitation` sets `revoked`.
 *     `accepted` is reserved for the day the sign-in path in
 *     identity-link.ts actually consumes a matching row (see its header) —
 *     nothing sets it yet, so no row exists in that state today. Listing and
 *     revoking are keyed off `status = 'pending'`, so once that wiring lands
 *     no other module needs to change.
 *
 * ROW-LEVEL SECURITY
 * ---------------------------------------------------------------------------
 * Tenant-fenced like every other row in platform.* that carries a tenant_id.
 * Writes additionally require the acting session to hold
 * `Organization.All.ReadWrite` — the same defence-in-depth the identity-link
 * write policy uses: the MCP tool layer checks the same role, this is the
 * belt under the braces for any other path that might reach this table.
 */
export async function applyEmployeeInvitationsMigration(db: OpenShapeForgeDatabase) {
  await sql`
    create schema if not exists platform;

    create table if not exists platform.employee_invitations (
      id            uuid primary key default gen_random_uuid(),
      tenant_id     uuid not null references platform.tenants (id) on delete cascade,
      email         text not null,
      role          text not null check (role in ('org_admin', 'org_employee')),
      first_name    text,
      last_name     text,
      status        text not null default 'pending'
                      check (status in ('pending', 'revoked', 'accepted')),
      -- 'jit' is never written here (an invitation always predates a sign-in),
      -- but the column carries the same shape as identity_relations.linked_by:
      -- the platform.identities id of the administrator who invited, when
      -- they themselves are linked, otherwise their session user id.
      invited_by    text not null,
      invited_at    timestamptz not null default now(),
      revoked_at    timestamptz,
      revoked_by    text,
      accepted_at   timestamptz,
      created_at    timestamptz not null default now(),
      updated_at    timestamptz not null default now(),
      constraint employee_invitations_status_shape check (
        (status = 'pending' and revoked_at is null and accepted_at is null)
        or (status = 'revoked' and revoked_at is not null and accepted_at is null)
        or (status = 'accepted' and accepted_at is not null)
      )
    );

    create unique index if not exists employee_invitations_pending_email_uidx
      on platform.employee_invitations (tenant_id, lower(email))
      where status = 'pending';

    create index if not exists employee_invitations_tenant_status_idx
      on platform.employee_invitations (tenant_id, status);

    alter table platform.employee_invitations enable row level security;
    alter table platform.employee_invitations force row level security;

    drop policy if exists employee_invitations_tenant_isolation on platform.employee_invitations;
    create policy employee_invitations_tenant_isolation on platform.employee_invitations
      using (
        app.bypass_rls()
        or tenant_id = app.current_tenant()
      )
      with check (
        app.bypass_rls()
        or (
          tenant_id = app.current_tenant()
          and 'Organization.All.ReadWrite' = any (
            string_to_array(coalesce(current_setting('app.roles', true), ''), ',')
          )
        )
      );
  `.execute(db);
}
