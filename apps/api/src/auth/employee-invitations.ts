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
 * Wired. `ensureIdentityLink` (./identity-link.ts) calls
 * `findPendingInvitation` before it creates anything, and `acceptInvitation`
 * once the Relation exists: the invited composite client role is granted on
 * the audience client through `control/member-role-admin.ts` and the row
 * moves to `accepted`. Two consequences worth knowing here:
 *
 *   - that lookup is also the ADMISSION check. No Relation carrying the
 *     token's e-mail and no pending invitation means the person is refused
 *     (`NotInvitedError`), not silently given a Relation of their own. An
 *     invitation is the only way into a tenant that nobody has linked you to.
 *   - the accept write needs `Organization.All.ReadWrite` to pass the table's
 *     RLS `with check`, and the person signing in does not have it. The
 *     runtime therefore performs that one write on an elevated db session
 *     (see `acceptInvitation`): the runtime records the acceptance, the
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
import { readControlPlaneConfig } from "../control/config.js";
import { createMemberRoleAdminClient } from "../control/member-role-admin.js";

export { IDENTITY_LINK_ADMIN_ROLE as EMPLOYEE_INVITATION_ADMIN_ROLE };

export const EMPLOYEE_INVITATION_ROLES = ["org_admin", "org_employee"] as const;
export type EmployeeInvitationRole = (typeof EMPLOYEE_INVITATION_ROLES)[number];

export function isEmployeeInvitationRole(value: string): value is EmployeeInvitationRole {
  return (EMPLOYEE_INVITATION_ROLES as readonly string[]).includes(value);
}

/**
 * The Keycloak client roles each invited role carries on the audience client.
 * One table, read by both the automatic path (`acceptInvitation`, on first
 * sign-in) and the manual one (`set_member_role`, mcp/identity-link-tools.ts)
 * — a second copy of a table that decides what an administrator can do is the
 * kind of duplication that drifts silently.
 *
 * `org_admin` grants exactly the role that gates every organization-admin
 * surface here; `org_employee` grants exactly the minimal read-only set a
 * JIT-created identity's session already runs on, so granting it changes
 * nothing but makes that access durable once the flag is cleared.
 */
export const EMPLOYEE_INVITATION_ROLE_GRANTS: Readonly<
  Record<EmployeeInvitationRole, readonly string[]>
> = {
  org_admin: [IDENTITY_LINK_ADMIN_ROLE],
  org_employee: NEEDS_ROLE_ASSIGNMENT_ROLES,
};

/**
 * A host may attach its product persona to the canonical organization intent.
 * The OSF baseline role always remains part of the grant: authorization of the
 * shared invitation and identity tools must not depend on a host role name.
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
 * The client entity roles live on. Reuses the same env var the API key path
 * already reads for the identical question (auth/api-key/runtime-config.ts)
 * rather than inventing a second name for "which client is the audience
 * client" — defaults to the base layer's `erp-provider`; Hubble's runtime
 * config sets it to `hubble-api` (the renamed audience client).
 */
export function memberRoleClientId(): string {
  return process.env.OPENSHAPEFORGE_API_KEY_ROLE_CLIENT_ID?.trim() || "erp-provider";
}

/**
 * How long after acceptance the invited role is still carried on the session
 * from Hubble's own record instead of from the token.
 *
 * The grant lands in Keycloak while the person is already holding a token
 * that was minted seconds earlier, so that token cannot contain it. Without
 * this window an invited administrator would sign in, be an ordinary reader,
 * and have to sign out and back in to become what they were invited as —
 * precisely the "authenticated but half-working" session this change exists
 * to remove. Bounded by the access token's own lifetime, and anchored on the
 * row's `accepted_at`, so it closes by itself exactly when the token that
 * predates the grant can no longer be in play. After that the token is the
 * only authority again: a role an administrator later takes away in Keycloak
 * really is gone, which a permanent union of this table would have quietly
 * prevented.
 */
export const INVITED_ROLE_GRACE_MS = 15 * 60_000;

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
 * The role of a recently ACCEPTED invitation for `email`, while it is still
 * inside {@link INVITED_ROLE_GRACE_MS}. Null otherwise — including for an
 * acceptance older than the window, which is the whole point (see that
 * constant). Same tenant-isolated read as above.
 */
export async function invitedRoleWithinGrace(
  trx: Transaction<DB>,
  tenantId: string,
  email: string,
): Promise<EmployeeInvitationRole | null> {
  const result = await sql<{ role: string }>`
    select role
      from platform.employee_invitations
     where tenant_id = ${tenantId}
       and lower(email) = lower(${email})
       and status = 'accepted'
       and accepted_at is not null
       and accepted_at > now() - make_interval(secs => ${INVITED_ROLE_GRACE_MS / 1000})
     order by accepted_at desc
     limit 1
  `.execute(trx);
  const role = result.rows[0]?.role;
  return role && isEmployeeInvitationRole(role) ? role : null;
}

/**
 * How the invited client roles reach Keycloak. A parameter rather than a
 * direct call so the admission path can be tested end to end against a real
 * database without a Keycloak — the alternative, letting the test rely on an
 * unconfigured control plane, would only ever exercise the FAILED grant.
 */
export type GrantInvitedRole = (
  keycloakSubject: string,
  clientId: string,
  roles: readonly string[],
) => Promise<readonly string[] | void>;

/** The real one: `control/member-role-admin.ts` against the tenant realm. */
const grantThroughKeycloak: GrantInvitedRole = async (keycloakSubject, clientId, roles) => {
  const controlPlane = readControlPlaneConfig();
  if (!controlPlane.ok) {
    throw new HttpError(
      503,
      "CONTROL_PLANE_UNCONFIGURED",
      `The Keycloak admin credentials are not configured; missing: ${controlPlane.missing.join(", ")}.`,
    );
  }
  const admin = createMemberRoleAdminClient(controlPlane.config.keycloak);
  return admin.grantClientRoles(keycloakSubject, clientId, roles);
};

export type AcceptInvitationResult = {
  role: EmployeeInvitationRole;
  /** Client roles actually granted on the audience client. */
  clientRoles: readonly string[];
  /**
   * False when Keycloak could not be asked (control plane unconfigured, or
   * the admin API refused/was unreachable). The invitation then stays
   * `pending` and the identity keeps `needs_role_assignment`, so an
   * administrator finishes it with `set_member_role` — admission itself is
   * unaffected, because the invitation is what admitted them.
   */
  granted: boolean;
};

/**
 * Grant the invited role in Keycloak and mark the invitation `accepted`.
 *
 * Keycloak first, then the row: a row that says `accepted` while the person
 * holds no role is a silent lie an administrator cannot see, whereas a
 * successful grant whose row never moved leaves the invitation pending — the
 * next sign-in simply grants the same roles again, which is idempotent
 * (`grantClientRoles` is additive).
 *
 * The status write runs on a DELIBERATELY ELEVATED db session. The table's
 * RLS `with check` demands `Organization.All.ReadWrite` for any write, and
 * the person signing in has nothing of the sort; it is the RUNTIME that is
 * recording "this invitation has now been used", on behalf of the
 * administrator who created it. The elevation is scoped to this one
 * statement and to the invitee's own tenant, and the invitee's session never
 * sees it.
 */
export async function acceptInvitation(
  db: OpenShapeForgeDatabase,
  session: SessionInput,
  invitation: PendingInvitationMatch,
  keycloakSubject: string,
  grantInvitedRole: GrantInvitedRole = grantThroughKeycloak,
): Promise<AcceptInvitationResult> {
  const clientRoles = employeeInvitationRoleGrants(invitation.role);
  let effectiveClientRoles = clientRoles;

  try {
    const effective = await grantInvitedRole(keycloakSubject, memberRoleClientId(), clientRoles);
    if (effective?.length) effectiveClientRoles = [...new Set(effective)];
  } catch (error) {
    // Never fatal: the invitation already decided the person may be here.
    // Refusing the session over a Keycloak hiccup would turn "you are invited"
    // into "you are locked out", which is the wrong failure of the two.
    console.warn(
      `[auth] Admitted ${session.userId} on invitation ${invitation.id}, but granting the ` +
        `invited role ${invitation.role} failed:`,
      error instanceof Error ? error.stack ?? error.message : String(error),
    );
    return { role: invitation.role, clientRoles, granted: false };
  }

  await withDbSession(
    db,
    { ...session, roles: [IDENTITY_LINK_ADMIN_ROLE] },
    async (trx) => {
      await sql`
        update platform.employee_invitations
           set status = 'accepted',
               accepted_at = now(),
               updated_at = now()
         where id = ${invitation.id}
           and tenant_id = ${session.tenantId}
           and status = 'pending'
      `.execute(trx);
    },
  );

  console.info(
    `[auth] ${session.userId} accepted invitation ${invitation.id} in tenant ` +
      `${session.tenantId}; granted ${invitation.role} (${clientRoles.join(", ")}).`,
  );
  return { role: invitation.role, clientRoles: effectiveClientRoles, granted: true };
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
