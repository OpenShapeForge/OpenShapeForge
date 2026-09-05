// SPDX-License-Identifier: BUSL-1.1
/**
 * An organization administrator inviting a colleague — the step BEFORE
 * identity-link.ts has anything to do. Three operations, all gated the same
 * way `link_identity` is (`IDENTITY_LINK_ADMIN_ROLE`, i.e.
 * `Organization.All.ReadWrite`):
 *
 *   inviteEmployee    — call Keycloak's Organization `invite-user` (a mail
 *                       with a signed action-token link the person accepts;
 *                       see keycloak-organization-members.ts for what that
 *                       endpoint does and does not persist) and record the
 *                       intended role in `platform.employee_invitations` so
 *                       it can be applied once the person actually signs in.
 *   listInvitations   — the tenant's invitations still `status = 'pending'`.
 *   revokeInvitation  — mark a pending invitation `revoked`. This is
 *                       Hubble-side bookkeeping only: Keycloak exposes no
 *                       admin-API resource for an unaccepted invitation (see
 *                       keycloak-organization-members.ts) — it cannot be
 *                       un-sent through this or any other call, so a person
 *                       holding an already-delivered e-mail can still
 *                       complete it and join the Organization. Revoking only
 *                       means the pre-selected role will no longer be
 *                       waiting for them (see the FOLLOW-UP note below); it
 *                       also does NOT free the address up for a fresh invite
 *                       before the original action token's own expiry —
 *                       Keycloak still 409s a repeat invite-user call for the
 *                       same address even after Hubble shows no pending row.
 *
 * FOLLOW-UP: applying the role automatically on first sign-in
 * ---------------------------------------------------------------------------
 * Not wired yet. The integration point is `ensureIdentityLink` in
 * ./identity-link.ts, right after `createPersonRelation` returns a
 * `relationId` (the "Phase 2: nobody carries this e-mail — create the person
 * as a Relation" branch) — that is the one place a brand-new person's e-mail
 * is known and a Relation now exists for them. The safe addition there is:
 * look up `platform.employee_invitations` for a `status = 'pending'` row
 * matching `(tenant_id, lower(claims.email))`; if found, call a NEW Keycloak
 * admin operation (not implemented by this change) to assign the invited
 * composite client role (`org_admin`/`org_employee` on `hubble-api`) to the
 * identity's Keycloak user id, and mark the invitation row `accepted`. It
 * was left out of this change because it needs a role-assignment client this
 * repo does not have yet (`PUT
 * /admin/realms/{realm}/users/{id}/role-mappings/clients/{clientUuid}`, plus
 * resolving `hubble-api`'s client uuid and its two role ids) — a second
 * Keycloak surface with its own error handling and its own tests, not a
 * one-line change next to identity-link.ts's existing logic. `hans/idp-onboarding`
 * (list_pending_members / set_member_role, applied AFTER first sign-in) is
 * the natural place this could also plug in if that branch lands first: its
 * "apply a role to a newly-JIT-created identity" step could consult this same
 * table instead of (or in addition to) the default-minimal-role path it
 * introduces — the two are complementary, not overlapping, because this
 * table only ever names roles that were explicitly invited.
 */
import { sql, type Transaction } from "kysely";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import type { DB } from "../generated/db/types.js";
import { withDbSession, type DbSessionInput } from "../db/session.js";
import { HttpError } from "../rest/http-error.js";
import { IDENTITY_LINK_ADMIN_ROLE } from "./identity-link.js";
import {
  KeycloakAdminError,
  type KeycloakAdminErrorCode,
} from "../control/keycloak-organization-admin.js";
import type { KeycloakOrganizationMembersClient } from "../control/keycloak-organization-members.js";

export { IDENTITY_LINK_ADMIN_ROLE as EMPLOYEE_INVITATION_ADMIN_ROLE };

export const EMPLOYEE_INVITATION_ROLES = ["org_admin", "org_employee"] as const;
export type EmployeeInvitationRole = (typeof EMPLOYEE_INVITATION_ROLES)[number];

export function isEmployeeInvitationRole(value: string): value is EmployeeInvitationRole {
  return (EMPLOYEE_INVITATION_ROLES as readonly string[]).includes(value);
}

type SessionInput = DbSessionInput & { tenantId: string; userId: string };

export type InviteEmployeeInput = {
  email: string;
  firstName?: string | undefined;
  lastName?: string | undefined;
  role: EmployeeInvitationRole;
};

export type EmployeeInvitation = {
  id: string;
  email: string;
  role: EmployeeInvitationRole;
  firstName: string | null;
  lastName: string | null;
  status: "pending" | "revoked" | "accepted";
  invitedBy: string;
  invitedAt: string;
  revokedAt: string | null;
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function requireAdmin(session: { roles?: readonly string[] | null | undefined }): void {
  if (!(session.roles ?? []).includes(IDENTITY_LINK_ADMIN_ROLE)) {
    throw new HttpError(
      403,
      "FORBIDDEN",
      `Inviting employees requires the ${IDENTITY_LINK_ADMIN_ROLE} role.`,
    );
  }
}

function normalisedEmail(email: string): string {
  const trimmed = email.trim();
  if (!trimmed || !EMAIL_PATTERN.test(trimmed)) {
    throw new HttpError(400, "VALIDATION", "email must be a valid e-mail address.");
  }
  return trimmed;
}

/** Status code → HTTP status for a Keycloak admin-API failure surfaced from a tool call. */
const KEYCLOAK_STATUS_BY_CODE: Record<KeycloakAdminErrorCode, number> = {
  KEYCLOAK_ADMIN_ORGANIZATION_NOT_FOUND: 409,
  KEYCLOAK_ADMIN_REJECTED: 400,
  // Not 403: the OPERATOR is authorized; the platform's own service account
  // (or its SMTP configuration) is not. Same convention as rest-routes.ts.
  KEYCLOAK_ADMIN_UNAUTHORIZED: 502,
  KEYCLOAK_ADMIN_UNAVAILABLE: 502,
};

function rethrowKeycloakError(error: unknown): never {
  if (error instanceof KeycloakAdminError) {
    throw new HttpError(
      KEYCLOAK_STATUS_BY_CODE[error.code] ?? 502,
      error.code,
      error.message,
    );
  }
  throw error;
}

/** This tenant's Keycloak Organization id and realm, read through RLS as "my own tenant row". */
async function tenantOrganization(
  trx: Transaction<DB>,
  tenantId: string,
): Promise<{ organizationId: string; realm: string }> {
  const result = await sql<{
    keycloak_organization_id: string | null;
    keycloak_realm: string | null;
  }>`
    select keycloak_organization_id, keycloak_realm
      from platform.tenants
     where id = ${tenantId}
  `.execute(trx);
  const row = result.rows[0];
  if (!row?.keycloak_organization_id || !row.keycloak_realm) {
    throw new HttpError(
      409,
      "TENANT_NOT_PROVISIONED",
      "This tenant has no linked Keycloak Organization yet; it cannot invite members.",
    );
  }
  return { organizationId: row.keycloak_organization_id, realm: row.keycloak_realm };
}

type InvitationRow = {
  id: string;
  email: string;
  role: string;
  first_name: string | null;
  last_name: string | null;
  status: "pending" | "revoked" | "accepted";
  invited_by: string;
  invited_at: Date | string;
  revoked_at: Date | string | null;
};

function toInvitation(row: InvitationRow): EmployeeInvitation {
  return {
    id: row.id,
    email: row.email,
    role: row.role as EmployeeInvitationRole,
    firstName: row.first_name,
    lastName: row.last_name,
    status: row.status,
    invitedBy: row.invited_by,
    invitedAt: new Date(row.invited_at).toISOString(),
    revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : null,
  };
}

/**
 * Invite `input.email` into the tenant's Keycloak Organization and record the
 * pre-selected role. The Keycloak call happens first: recording an intent
 * this deployment never actually sent is worse than a Keycloak call whose
 * intent never got recorded (the administrator can retry `invite_employee`
 * either way, and a lost DB row after a successful invite is the strictly
 * safer failure of the two — the person still gets the e-mail).
 */
export async function inviteEmployee(
  db: OpenShapeForgeDatabase,
  session: SessionInput & { relation?: { identityId: string } | null | undefined },
  keycloak: KeycloakOrganizationMembersClient,
  input: InviteEmployeeInput,
): Promise<EmployeeInvitation> {
  requireAdmin(session);
  const email = normalisedEmail(input.email);
  if (!isEmployeeInvitationRole(input.role)) {
    throw new HttpError(
      400,
      "VALIDATION",
      `role must be one of ${EMPLOYEE_INVITATION_ROLES.join(", ")}.`,
    );
  }
  const actor = session.relation?.identityId ?? session.userId;

  const { organizationId } = await withDbSession(db, session, (trx) =>
    tenantOrganization(trx, session.tenantId),
  );

  try {
    await keycloak.inviteUser(organizationId, {
      email,
      firstName: input.firstName,
      lastName: input.lastName,
    });
  } catch (error) {
    rethrowKeycloakError(error);
  }

  const row = await withDbSession(db, session, async (trx) => {
    const inserted = await sql<InvitationRow>`
      insert into platform.employee_invitations
        (tenant_id, email, role, first_name, last_name, invited_by)
      values
        (${session.tenantId}, ${email}, ${input.role},
         ${input.firstName ?? null}, ${input.lastName ?? null}, ${actor})
      on conflict (tenant_id, lower(email)) where status = 'pending'
      do update set
        role = excluded.role,
        first_name = excluded.first_name,
        last_name = excluded.last_name,
        invited_by = excluded.invited_by,
        invited_at = now(),
        updated_at = now()
      returning id, email, role, first_name, last_name, status, invited_by, invited_at, revoked_at
    `.execute(trx);
    return inserted.rows[0]!;
  });

  console.info(
    `[auth] ${actor} invited ${email} to tenant ${session.tenantId} as ${input.role}.`,
  );
  return toInvitation(row);
}

/** Every invitation this tenant still has `status = 'pending'`, newest first. */
export async function listInvitations(
  db: OpenShapeForgeDatabase,
  session: SessionInput,
): Promise<EmployeeInvitation[]> {
  requireAdmin(session);
  return withDbSession(db, session, async (trx) => {
    const result = await sql<InvitationRow>`
      select id, email, role, first_name, last_name, status, invited_by, invited_at, revoked_at
        from platform.employee_invitations
       where tenant_id = ${session.tenantId}
         and status = 'pending'
       order by invited_at desc
    `.execute(trx);
    return result.rows.map(toInvitation);
  });
}

export type RevokeInvitationInput = { email: string };

/**
 * Mark the tenant's PENDING invitation for `email` as revoked. Hubble-side
 * only — see this module's header for why Keycloak has nothing to un-send.
 */
export async function revokeInvitation(
  db: OpenShapeForgeDatabase,
  session: SessionInput & { relation?: { identityId: string } | null | undefined },
  input: RevokeInvitationInput,
): Promise<EmployeeInvitation> {
  requireAdmin(session);
  const email = normalisedEmail(input.email);
  const actor = session.relation?.identityId ?? session.userId;

  return withDbSession(db, session, async (trx) => {
    const result = await sql<InvitationRow>`
      update platform.employee_invitations
         set status = 'revoked',
             revoked_at = now(),
             revoked_by = ${actor},
             updated_at = now()
       where tenant_id = ${session.tenantId}
         and lower(email) = lower(${email})
         and status = 'pending'
      returning id, email, role, first_name, last_name, status, invited_by, invited_at, revoked_at
    `.execute(trx);
    const row = result.rows[0];
    if (!row) {
      throw new HttpError(
        404,
        "INVITATION_NOT_FOUND",
        `No pending invitation for "${email}" in this organization.`,
      );
    }
    console.info(`[auth] ${actor} revoked the invitation for ${email} in tenant ${session.tenantId}.`);
    return toInvitation(row);
  });
}
