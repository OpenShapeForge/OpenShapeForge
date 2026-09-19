// SPDX-License-Identifier: BUSL-1.1
/**
 * An organization administrator inviting a colleague — the step BEFORE
 * identity-link.ts has anything to do. Three operations, all gated the same
 * way `link_identity` is (`IDENTITY_LINK_ADMIN_ROLE`, i.e.
 * `Organization.All.ReadWrite`):
 *
 *   inviteEmployee    — converge Keycloak Organization membership with a
 *                       local admission. A new member receives Keycloak's
 *                       signed invitation e-mail; an existing member skips
 *                       that redundant delivery. Both paths record the
 *                       intended role in `platform.employee_invitations` so
 *                       it can be applied once the person actually signs in.
 *   listInvitations   — the tenant's invitations still `status = 'pending'`.
 *   revokeInvitation  — DELETE the invitation at Keycloak and mark the row
 *                       `revoked`. Keycloak first, for the same reason
 *                       `inviteEmployee` calls Keycloak first: the state that
 *                       actually lets somebody in is the one over there.
 *
 * WHAT REVOKING REALLY DOES (measured, Keycloak 26.5.3)
 * ---------------------------------------------------------------------------
 * An earlier version of this header said Keycloak exposes no admin-API
 * resource for an unaccepted invitation, so revoking could only ever be
 * Hubble-side bookkeeping. That was wrong. `/organizations/{id}/invitations`
 * exists, lists pending invitations, and accepts a DELETE — measured against
 * the running local Keycloak by sending a real invitation and withdrawing it
 * (keycloak-organization-members.ts's header carries the verbatim responses).
 * What that means here:
 *
 *   - the mail already sitting in the person's inbox STOPS WORKING. Opening
 *     the delivered link after the DELETE answers HTTP 400 with Keycloak's
 *     own "The link you clicked is no longer valid. It may have expired or
 *     already been used." So an invitation is genuinely withdrawable, which
 *     is the whole point of `revokeInvitation` existing;
 *   - the address is FREED. `invite-user` for that same address answers 204
 *     again right after the DELETE. The 409 "User already has a pending
 *     invitation" only stands while an invitation is actually pending, so
 *     re-inviting somebody you just withdrew works;
 *   - a second DELETE answers 404, which the client reports as `false`
 *     ("there was nothing left to un-send") rather than as a failure.
 *
 * Keycloak still creates no user and no member record until the person
 * accepts, so `platform.employee_invitations` remains the system of record
 * for WHO was invited, WITH WHAT ROLE, BY WHOM — Keycloak knows only the
 * address and the deadline.
 *
 * APPLYING THE INVITED ROLE ON FIRST SIGN-IN
 * ---------------------------------------------------------------------------
 * `ensureIdentityLink` (./identity-link.ts) calls `findPendingInvitation`
 * before it creates anything, and `acceptInvitation` once the Relation
 * exists: the invited roles are written to `platform.identity_relations.roles`
 * for THIS (identity, tenant) and the row moves to `accepted`. Nothing is
 * granted in Keycloak — a client role on the user would be user-wide and
 * apply in every organization the account is a member of. Two consequences
 * worth knowing here:
 *
 *   - that lookup is also the ADMISSION check. No Relation carrying the
 *     token's e-mail and no pending invitation means the person is refused
 *     (`NotInvitedError`), not silently given a Relation of their own. An
 *     invitation is the only way into a tenant that nobody has linked you to.
 *   - both writes need `Organization.All.ReadWrite` — the invitation table's
 *     RLS `with check`, and the trigger on `identity_relations.roles` — and
 *     the person signing in does not have it. The runtime therefore performs
 *     them on an elevated db session (see `acceptInvitation`): the runtime
 *     records the acceptance on behalf of the administrator who invited, the
 *     invitee never holds the role that made the write legal.
 */
import { sql, type Transaction } from "kysely";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import type { DB } from "../generated/db/types.js";
import { withDbSession, type DbSessionInput } from "../db/session.js";
import { HttpError } from "../rest/http-error.js";
// From the leaf module, NOT from ./identity-link.js: this module and that one
// import each other, and EMPLOYEE_INVITATION_ROLE_GRANTS below reads both of
// these while evaluating. See ./organization-roles.ts.
import { IDENTITY_LINK_ADMIN_ROLE, NEEDS_ROLE_ASSIGNMENT_ROLES } from "./organization-roles.js";
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

/**
 * The organization-scoped roles each invited role carries — what lands in
 * `platform.identity_relations.roles` for the tenant, as DECLARED names. One
 * table, read by both the automatic path (first sign-in) and the manual one
 * (`set_member_role`, mcp/identity-link-tools.ts) — a second copy of a table
 * that decides what an administrator can do is the kind of duplication that
 * drifts silently.
 *
 * Each entry starts with the persona name itself (`org_admin`,
 * `org_employee`): the realm may declare a composite of that name, and
 * auth/person-roles.ts expands it at session time exactly as Keycloak used to
 * expand it into `resource_access` — so an invited administrator holds
 * whatever the realm says an administrator holds. Where the realm declares
 * no such composite the name is inert, and the OSF baseline beside it is what
 * counts: `org_admin` carries the role that gates every organization-admin
 * surface here; `org_employee` carries the minimal read-only set a
 * JIT-created identity's session runs on. `whoami` reads the persona name
 * off the session to say what the person is.
 */
export const EMPLOYEE_INVITATION_ROLE_GRANTS: Readonly<
  Record<EmployeeInvitationRole, readonly string[]>
> = {
  org_admin: ["org_admin", IDENTITY_LINK_ADMIN_ROLE],
  org_employee: ["org_employee", ...NEEDS_ROLE_ASSIGNMENT_ROLES],
};

/**
 * A host may attach its product persona under another name. The OSF baseline
 * always remains part of the grant: authorization of the shared invitation
 * and identity tools must not depend on a host role name.
 */
export function employeeInvitationRoleGrants(
  role: EmployeeInvitationRole,
  env: NodeJS.ProcessEnv = process.env,
): readonly string[] {
  const configured = (role === "org_admin"
    ? env.OPENSHAPEFORGE_ORG_ADMIN_CLIENT_ROLE
    : env.OPENSHAPEFORGE_ORG_EMPLOYEE_CLIENT_ROLE)?.trim();
  const baseline = EMPLOYEE_INVITATION_ROLE_GRANTS[role];
  return configured && !baseline.includes(configured)
    ? [...baseline, configured]
    : baseline;
}

/**
 * The Keycloak client that service-account entity roles live on. Reuses the
 * same env var the API key path already reads for the identical question
 * (auth/api-key/runtime-config.ts) — defaults to the base layer's
 * `erp-provider`; a host's runtime config sets it to its renamed audience
 * client. Person roles no longer live there (see the module header); this
 * remains for the control plane's Keycloak member reads.
 */
export function memberRoleClientId(): string {
  return process.env.OPENSHAPEFORGE_API_KEY_ROLE_CLIENT_ID?.trim() || "erp-provider";
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

export function normalisedEmail(email: string): string {
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

export function toInvitation(row: InvitationRow): EmployeeInvitation {
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
 * pre-selected role. An existing organization member needs no second e-mail,
 * but still needs this local admission record: Keycloak membership alone does
 * not create an OSF Relation or identity link. A 409 is accepted only after a
 * fresh membership read proves that this exact address became a member in a
 * race; every other Keycloak failure remains fail-closed.
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
    const existingMember = await keycloak.hasMemberByEmail(organizationId, email);
    if (!existingMember) {
      try {
        await keycloak.inviteUser(organizationId, {
          email,
          firstName: input.firstName,
          lastName: input.lastName,
        });
      } catch (error) {
        const converged = error instanceof KeycloakAdminError && error.status === 409 &&
          await keycloak.hasMemberByEmail(organizationId, email);
        if (!converged) throw error;
      }
    }
  } catch (error) {
    rethrowKeycloakError(error);
  }

  const invitation = await withDbSession(db, session, (trx) =>
    recordEmployeeInvitation(trx, session.tenantId, actor, input, email),
  );
  console.info(`[auth] ${actor} invited ${email} to tenant ${session.tenantId} as ${input.role}.`);
  return invitation;
}

/** Shared persistence after Keycloak confirms delivery; caller owns authorization. */
export async function recordEmployeeInvitation(
  trx: Transaction<DB>, tenantId: string, actor: string, input: InviteEmployeeInput,
  email = normalisedEmail(input.email),
): Promise<EmployeeInvitation> {
    const inserted = await sql<InvitationRow>`
      insert into platform.employee_invitations
        (tenant_id, email, role, first_name, last_name, invited_by)
      values
        (${tenantId}, ${email}, ${input.role},
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
    return toInvitation(inserted.rows[0]!);
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

// ---------------------------------------------------------------------------
// First sign-in: admission, and the invited role
//
// Called from ./identity-link.ts's just-in-time path. Kept here because this
// module owns `platform.employee_invitations` — its RLS, its status shape and
// the meaning of each status live in one place.

export type PendingInvitationMatch = { id: string; role: EmployeeInvitationRole };

/**
 * The tenant's still-pending invitation for `email`, or null. A plain read
 * through the caller's own RLS session: the table's `using` clause is tenant
 * isolation only, so the person signing in may see whether they were invited
 * — which is exactly the question being asked — without holding any role.
 */
export async function findPendingInvitation(
  trx: Transaction<DB>,
  tenantId: string,
  email: string,
): Promise<PendingInvitationMatch | null> {
  const result = await sql<{ id: string; role: string }>`
    select id, role
      from platform.employee_invitations
     where tenant_id = ${tenantId}
       and lower(email) = lower(${email})
       and status = 'pending'
     order by invited_at desc
     limit 1
  `.execute(trx);
  const row = result.rows[0];
  if (!row || !isEmployeeInvitationRole(row.role)) return null;
  return { id: row.id, role: row.role };
}

/**
 * Claim the invitation: flip it from `pending` to `accepted` inside the
 * caller's transaction and return the role it holds AT THAT MOMENT, or null
 * when it is no longer pending (revoked, or already spent). The caller
 * (identity-link-admission.ts) records the roles for the returned role in
 * the same transaction, so an administrator's revoke or role change between
 * the lookup and the claim is never overwritten with what was read earlier.
 * The invitation table's RLS `with check` demands `Organization.All.ReadWrite`;
 * the caller runs this on the runtime's elevated session, on behalf of the
 * administrator who invited.
 */
export async function claimPendingInvitation(
  trx: Transaction<DB>,
  tenantId: string,
  invitationId: string,
): Promise<EmployeeInvitationRole | null> {
  const result = await sql<{ role: string }>`
    update platform.employee_invitations
       set status = 'accepted',
           accepted_at = now(),
           updated_at = now()
     where id = ${invitationId}
       and tenant_id = ${tenantId}
       and status = 'pending'
    returning role
  `.execute(trx);
  const role = result.rows[0]?.role;
  return role && isEmployeeInvitationRole(role) ? role : null;
}

export type RevokeInvitationInput = { email: string };

export type RevokedInvitation = EmployeeInvitation & {
  /**
   * True when Keycloak still held the invitation and it was deleted there —
   * the delivered link is now dead. False when Keycloak had nothing left
   * (already accepted, already withdrawn, or expired), in which case only the
   * Hubble row changed. Reported rather than hidden: "the mail no longer
   * works" and "there was nothing left to stop" are different answers to an
   * administrator who is revoking because something went wrong.
   */
  keycloakInvitationDeleted: boolean;
};

/**
 * Withdraw the tenant's PENDING invitation for `email`: DELETE it at Keycloak
 * so the delivered link stops working and the address is free again, then
 * mark the row `revoked`.
 *
 * Keycloak first, mirroring `inviteEmployee`. If the admin API fails, nothing
 * is marked revoked and the administrator can retry — the opposite order
 * would leave Hubble claiming an invitation was withdrawn while the link in
 * somebody's inbox still lets them in, which is the one outcome a revoke must
 * never produce.
 *
 * `keycloak` may be undefined on a deployment with no control-plane
 * credentials. That is not silently downgraded to bookkeeping: it is a 503,
 * because "revoked" would otherwise mean something weaker than the caller
 * has every reason to assume.
 */
export async function revokeInvitation(
  db: OpenShapeForgeDatabase,
  session: SessionInput & { relation?: { identityId: string } | null | undefined },
  keycloak: KeycloakOrganizationMembersClient | undefined,
  input: RevokeInvitationInput,
): Promise<RevokedInvitation> {
  requireAdmin(session);
  const email = normalisedEmail(input.email);
  const actor = session.relation?.identityId ?? session.userId;

  if (!keycloak) {
    throw new HttpError(
      503,
      "CONTROL_PLANE_UNCONFIGURED",
      "Withdrawing an invitation needs the Keycloak admin credentials; without them the " +
        "invitation e-mail would keep working and revoking would mean nothing.",
    );
  }

  const { organizationId } = await withDbSession(db, session, (trx) =>
    tenantOrganization(trx, session.tenantId),
  );

  let keycloakInvitationDeleted = false;
  try {
    const pending = await keycloak.findPendingInvitationByEmail(organizationId, email);
    if (pending) {
      keycloakInvitationDeleted = await keycloak.deleteInvitation(organizationId, pending.id);
    }
  } catch (error) {
    rethrowKeycloakError(error);
  }

  const row = await withDbSession(db, session, async (trx) => {
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
    return toInvitation(row);
  });

  console.info(
    `[auth] ${actor} revoked the invitation for ${email} in tenant ${session.tenantId}; ` +
      `Keycloak invitation ${keycloakInvitationDeleted ? "deleted (the link is dead)" : "was already gone"}.`,
  );
  return { ...row, keycloakInvitationDeleted };
}
