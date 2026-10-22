// SPDX-License-Identifier: BUSL-1.1
import { sql, type RawBuilder } from "kysely";
import { isEmployeeInvitationRole, normalisedEmail, recordEmployeeInvitation, toInvitation } from "../auth/employee-invitations.js";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import { withSystemSession } from "../db/session.js";
import { FirstAdministratorError, invitationDeliveryUnconfirmed, type FirstAdministratorClients } from "./first-tenant-administrator.js";
import { KeycloakAdminError } from "./keycloak-organization-admin.js";
import { deliverInvitation, invitationOutcome, tenantSignInUrl } from "./invitation-outcome.js";
import { systemSessionForAdministrator, type PlatformAdministrator } from "./platform-admin.js";

type Dependencies = {
  db: OpenShapeForgeDatabase;
  administrator: PlatformAdministrator;
  firstAdministrator?: FirstAdministratorClients;
  log?: (error: unknown) => void;
  correlationId?: string;
};

type InvitationAction = "list" | "get" | "create" | "revoke" | "resend";
type Input = { slug: string; invitationId?: string; email?: string; roles?: string[]; firstName?: string; lastName?: string };
const AUDIT_ACTION: Readonly<Record<InvitationAction, string>> = {
  list: "control.list-tenant-invitations",
  get: "control.get-tenant-invitation",
  create: "control.create-tenant-invitation",
  revoke: "control.revoke-tenant-invitation",
  resend: "control.resend-tenant-invitation",
};

/**
 * Reads take no lock. Create and resend serialise operator actions on the
 * tenant without the `for key share` conflict that `for update` has, so the
 * tenant's foreign-key inserts (sign-ins, receipts, jobs) do not wait for the
 * Keycloak calls made under it. Revoke keeps `for update`: its pending-row
 * update matches by e-mail and relies on a tenant-side invitation insert for
 * that address landing only after it commits.
 */
const TENANT_LOCK: Readonly<Record<InvitationAction, RawBuilder<unknown>>> = {
  list: sql``,
  get: sql``,
  create: sql` for no key update`,
  revoke: sql` for update`,
  resend: sql` for no key update`,
};

function invitationTimestamp(value: number | null): string | null {
  return value == null ? null : new Date(value * 1000).toISOString();
}

function invitationCanBeRevoked(status: string | null): boolean {
  return status?.toUpperCase() !== "EXPIRED";
}

/** Platform metadata only; never constructs a tenant member session or changes an invited role. */
export async function manageTenantInvitations(
  deps: Dependencies,
  action: InvitationAction,
  input: Input,
) {
  if (!/^[a-z][a-z0-9-]*$/.test(input.slug)) {
    throw new FirstAdministratorError("INVALID_INPUT", "A tenant slug is required.");
  }
  if (["get", "revoke", "resend"].includes(action) && (!input.invitationId || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.invitationId))) {
    throw new FirstAdministratorError("INVALID_INPUT", "Use an invitationId from list_tenant_invitations.");
  }
  const clients = deps.firstAdministrator;
  if (!clients) {
    throw new FirstAdministratorError(
      "INVITATIONS_NOT_CONFIGURED",
      "Tenant invitation service is not configured.",
    );
  }

  try {
    const auditTarget = input.invitationId
      ? `${input.slug} invitation="${input.invitationId}"`
      : input.slug;
    return await withSystemSession(
      deps.db,
      systemSessionForAdministrator(deps.administrator, `${AUDIT_ACTION[action]} ${auditTarget}`),
      async (trx) => {
        const tenant = (await sql<{
          id: string;
          status: string;
          keycloak_realm: string | null;
          keycloak_organization_id: string | null;
        }>`
          select id, status, keycloak_realm, keycloak_organization_id
          from platform.tenants
          where slug = ${input.slug}${TENANT_LOCK[action]}
        `.execute(trx)).rows[0];
        if (!tenant || tenant.keycloak_realm !== clients.tenantRealm) {
          throw new FirstAdministratorError(
            "TENANT_NOT_FOUND",
            "The tenant does not exist in the configured realm.",
          );
        }
        if (!tenant.keycloak_organization_id) {
          throw new FirstAdministratorError("TENANT_NOT_READY", "The tenant has no linked organization.");
        }

        const organization = await clients.organizations.getOrganization(tenant.keycloak_organization_id);
        if (organization.id !== tenant.keycloak_organization_id || organization.alias !== input.slug) {
          throw new FirstAdministratorError(
            "TENANT_NOT_READY",
            "The linked organization does not match the tenant.",
          );
        }

        const rows = (await sql<Parameters<typeof toInvitation>[0]>`
          select id, email, roles, first_name, last_name, status, invited_by, invited_at, revoked_at
          from platform.employee_invitations
          where tenant_id = ${tenant.id}
          order by invited_at desc
          limit 10001
        `.execute(trx)).rows;
        if (rows.length > 10000) {
          throw new FirstAdministratorError(
            "INVITATION_LIMIT_EXCEEDED",
            "Invitation history exceeds the supported bound.",
          );
        }

        const linkedEmails = new Set((!["list", "get", "resend"].includes(action) || rows.length === 0 ? [] : (await sql<{email:string}>`
          select lower(i.email) as email from platform.identity_relations ir
          join platform.identities i on i.id = ir.identity_id
          where ir.tenant_id = ${tenant.id} and ir.status = 'linked'
            and lower(i.email) in (${sql.join(rows.map(row => row.email.toLowerCase()))})
        `.execute(trx)).rows).map(row => row.email));
        const pending = await clients.members.listInvitations(organization.id);
        const localFor = (email: string) => rows.find((row) => row.email.toLowerCase() === email.toLowerCase());
        if (action === "list") {
          const withoutProvider = rows.filter((row) => row.status === "pending" &&
            !pending.some((invitation) => invitation.email.toLowerCase() === row.email.toLowerCase()));
          // A pending intent for an existing account waits for sign-in;
          // only an intent with neither an
          // account nor a provider invitation is drift. One member read, not one per row.
          const accounts = withoutProvider.length === 0 ? new Set<string>() : new Set(
            (await clients.members.listMembers(organization.id)).flatMap((member) => member.email ? [member.email.trim().toLowerCase()] : []),
          );
          const signInUrl = tenantSignInUrl(input.slug);
          const unresolved = withoutProvider.map((row) => {
            const member = accounts.has(row.email.trim().toLowerCase());
            return { tenantSlug: input.slug, invitationId: row.id, ...toInvitation(row),
              status: member ? "awaiting_sign_in" : "provider_missing", ...(member ? { signInUrl } : {}) };
          });
          return {
            tenant: input.slug,
            invitations: pending.map((invitation) => {
              const local = localFor(invitation.email);
              return {
                tenantSlug: input.slug,
                invitationId: local?.id ?? invitation.id,
                email: invitation.email,
                firstName: invitation.firstName,
                lastName: invitation.lastName,
                status: invitation.status,
                sentAt: invitationTimestamp(invitation.sentDate),
                expiresAt: invitationTimestamp(invitation.expiresAt),
                roles: local?.roles ?? [],
                registrationStatus: local?.status ?? "untracked",
                canResend: Boolean(
                  (local?.status === "pending" || (local?.status === "accepted" && linkedEmails.has(local.email.toLowerCase()))) && tenant.status === "active" && organization.enabled,
                ),
                canRevoke: local?.status !== "accepted" && invitationCanBeRevoked(invitation.status),
              };
            }),
            unresolved,
          };
        }

        if (action === "create") {
          let email: string;
          try { email = normalisedEmail(String(input.email ?? "")).toLowerCase(); }
          catch { throw new FirstAdministratorError("INVALID_INPUT", "A valid email address is required."); }
          if (!Array.isArray(input.roles) || input.roles.length === 0 || input.roles.some(role => !["org_admin", "org_employee"].includes(role) || !isEmployeeInvitationRole(role))) throw new FirstAdministratorError("INVALID_INPUT", "roles must select org_admin and/or org_employee.");
          if (tenant.status !== "active" || !organization.enabled) throw new FirstAdministratorError("TENANT_NOT_READY", "Inviting requires an active tenant and organization.");
          const names = { ...(input.firstName ? { firstName: input.firstName } : {}), ...(input.lastName ? { lastName: input.lastName } : {}) };
          const member = await clients.members.hasMemberByEmail(organization.id, email);
          const accepted = rows.find((row) => row.status === "accepted" && row.email.toLowerCase() === email);
          const admission = member && accepted ? (await sql<{roles: string[] | null}>`
            select ir.roles from platform.identity_relations ir
            join platform.identities i on i.id = ir.identity_id
            where ir.tenant_id = ${tenant.id} and ir.status = 'linked'
              and lower(i.email) = lower(${email})
          `.execute(trx)).rows : [];
          if (member && accepted && admission.length) {
            if (admission.length !== 1 || !input.roles.every(role => (admission[0]!.roles ?? []).includes(role))) throw new FirstAdministratorError("INVITATION_ROLE_CONFLICT", "This member is already admitted with another role. Use assign_tenant_member_roles; no email was sent and no role was changed.");
            const delivery = await deliverInvitation(clients.members, organization.id, { email, ...names }, { knownNonMember: !member });
            return { tenantSlug: input.slug, invitationId: accepted.id, ...toInvitation(accepted), ...invitationOutcome(input.slug, delivery) };
          }
          // Every explicit admission records current intent, including re-admission
          // after acceptance. Existing members receive the native sign-in notice.
          const delivery = await deliverInvitation(clients.members, organization.id, { email, ...names }, { knownNonMember: !member });
          const invitation = await recordEmployeeInvitation(trx, tenant.id, `${deps.administrator.issuer}#${deps.administrator.subject}`,
            { email, roles: input.roles, ...names });
          return { tenantSlug: input.slug, invitationId: invitation.id, ...invitation,
            ...invitationOutcome(input.slug, delivery) };
        }

        // Create returns the durable local intent id; Keycloak can replace its id
        // when a member is invited again. Resolve that local id within this tenant.
        const intent = rows.find(row => row.id === input.invitationId);
        const invitation = pending.find(row => row.id === input.invitationId) ??
          (intent ? pending.find(row => row.email.toLowerCase() === intent.email.toLowerCase()) : undefined);
        if (action === "get") {
          if (!invitation) throw new FirstAdministratorError("INVITATION_NOT_FOUND", "This invitation is no longer outstanding in this organization.");
          const local = localFor(invitation.email);
          return { tenantSlug: input.slug, invitationId: local?.id ?? invitation.id, email: invitation.email, firstName: invitation.firstName,
            lastName: invitation.lastName, status: invitation.status,
            sentAt: invitationTimestamp(invitation.sentDate), expiresAt: invitationTimestamp(invitation.expiresAt),
            roles: local?.roles ?? [], registrationStatus: local?.status ?? "untracked",
            canResend: Boolean((local?.status === "pending" || (local?.status === "accepted" && linkedEmails.has(local.email.toLowerCase()))) && tenant.status === "active" && organization.enabled),
            canRevoke: local?.status !== "accepted" && invitationCanBeRevoked(invitation.status) };
        }
        if (!invitation && action === "revoke") {
          const unresolved = rows.find((row) => row.id === input.invitationId && row.status === "pending");
          if (
            unresolved &&
            !pending.some((row) => row.email.toLowerCase() === unresolved.email.toLowerCase())
          ) {
            const updated = await sql`
              update platform.employee_invitations
              set status = 'revoked', revoked_at = now(),
                  revoked_by = ${`${deps.administrator.issuer}#${deps.administrator.subject}`}, updated_at = now()
              where tenant_id = ${tenant.id} and id = ${unresolved.id} and status = 'pending'
              returning id
            `.execute(trx);
            if (!updated.rows.length) {
              throw new FirstAdministratorError(
                "INVITATION_STATE_CHANGED",
                "The pending role assignment changed. Refresh; no member was removed.",
              );
            }
            return {
              tenant: input.slug,
              email: unresolved.email,
              status: "revoked",
              keycloakInvitationDeleted: false,
            };
          }
        }
        if (!invitation) {
          throw new FirstAdministratorError(
            "INVITATION_NOT_FOUND",
            "This invitation is no longer outstanding in this organization. Refresh the list.",
          );
        }

        const local = localFor(invitation.email);
        if (local?.status === "accepted" && action === "revoke") {
          throw new FirstAdministratorError(
            "INVITATION_ALREADY_ACCEPTED",
            "This invitation has already been accepted; use member administration.",
          );
        }

        if (action === "revoke") {
          const deleted = await clients.members.deleteInvitation(organization.id, invitation.id);
          const updated = await sql`
            update platform.employee_invitations
            set status = 'revoked', revoked_at = now(),
                revoked_by = ${`${deps.administrator.issuer}#${deps.administrator.subject}`}, updated_at = now()
            where tenant_id = ${tenant.id} and lower(email) = lower(${invitation.email}) and status = 'pending'
            returning id
          `.execute(trx);
          if (local?.status === "pending" && !updated.rows.length) {
            throw new FirstAdministratorError(
              "INVITATION_STATE_CHANGED",
              "The pending role assignment changed. Refresh; no member was removed.",
            );
          }
          return {
            tenant: input.slug,
            email: invitation.email,
            status: "revoked",
            keycloakInvitationDeleted: deleted,
          };
        }

        if (tenant.status !== "active" || !organization.enabled) {
          throw new FirstAdministratorError(
            "TENANT_NOT_READY",
            "Resending requires an active tenant and organization.",
          );
        }
        if (!local || !["pending", "accepted"].includes(local.status)) {
          throw new FirstAdministratorError(
            "INVITATION_ROLE_MISSING",
            "No authorized invitation exists. Revoke this invitation and create a new authorized invitation.",
          );
        }
        if (local.status === "accepted" && !linkedEmails.has(local.email.toLowerCase())) {
          throw new FirstAdministratorError("INVITATION_ADMISSION_MISSING", "This historical invitation has no current application admission. Create a new authorized invitation to restore access; no mail was sent.");
        }
        if (!(await clients.members.hasInvitationMailConfiguration())) {
          throw new FirstAdministratorError("SMTP_NOT_CONFIGURED", "Configure SMTP before resending invitations.");
        }
        // No automatic retry: a timeout does not prove that mail was not sent.
        // Keycloak's resend endpoint rejects existing organization members.
        // Their native invite-existing-user operation replaces the old notice.
        if (await clients.members.hasMemberByEmail(organization.id, invitation.email)) {
          const delivery = await deliverInvitation(clients.members, organization.id, { email: invitation.email });
          if (delivery !== "email_sent") throw new FirstAdministratorError("INVITATION_STATE_CHANGED", "The membership changed; no new mail was confirmed. Refresh before resending.");
        } else {
          if (!clients.members.resendInvitation) throw new FirstAdministratorError("INVITATIONS_NOT_CONFIGURED", "Invitation resend is not configured.");
          await clients.members.resendInvitation(organization.id, invitation.id);
        }
        return {
          tenant: input.slug,
          email: invitation.email,
          roles: local.roles,
          status: "resent",
          ...invitationOutcome(input.slug, "email_sent"),
        };
      },
    );
  } catch (error) {
    if (error instanceof KeycloakAdminError) {
      throw invitationDeliveryUnconfirmed(error, deps.log, deps.correlationId);
    }
    throw error;
  }
}
