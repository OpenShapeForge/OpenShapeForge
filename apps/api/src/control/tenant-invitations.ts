// SPDX-License-Identifier: BUSL-1.1
import { sql } from "kysely";
import { isEmployeeInvitationRole, normalisedEmail, recordEmployeeInvitation, toInvitation } from "../auth/employee-invitations.js";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import { withSystemSession } from "../db/session.js";
import { FirstAdministratorError, invitationDeliveryUnconfirmed, type FirstAdministratorClients } from "./first-tenant-administrator.js";
import { KeycloakAdminError } from "./keycloak-organization-admin.js";
import { systemSessionForAdministrator, type PlatformAdministrator } from "./platform-admin.js";

type Dependencies = {
  db: OpenShapeForgeDatabase;
  administrator: PlatformAdministrator;
  firstAdministrator?: FirstAdministratorClients;
  log?: (error: unknown) => void;
  correlationId?: string;
};

type InvitationAction = "list" | "get" | "create" | "revoke" | "resend";
type Input = { slug: string; invitationId?: string; email?: string; role?: string; firstName?: string; lastName?: string };
const AUDIT_ACTION: Readonly<Record<InvitationAction, string>> = {
  list: "control.list-tenant-invitations",
  get: "control.get-tenant-invitation",
  create: "control.create-tenant-invitation",
  revoke: "control.revoke-tenant-invitation",
  resend: "control.resend-tenant-invitation",
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
          where slug = ${input.slug}
          for update
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
          select id, email, role, first_name, last_name, status, invited_by, invited_at, revoked_at
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

        const pending = await clients.members.listInvitations(organization.id);
        const localFor = (email: string) => rows.find((row) => row.email.toLowerCase() === email.toLowerCase());
        if (action === "list") {
          return {
            tenant: input.slug,
            invitations: pending.map((invitation) => {
              const local = localFor(invitation.email);
              return {
                tenantSlug: input.slug,
                invitationId: invitation.id,
                email: invitation.email,
                firstName: invitation.firstName,
                lastName: invitation.lastName,
                status: invitation.status,
                sentAt: invitationTimestamp(invitation.sentDate),
                expiresAt: invitationTimestamp(invitation.expiresAt),
                role: local?.role ?? null,
                registrationStatus: local?.status ?? "untracked",
                canResend: Boolean(
                  local?.status === "pending" && tenant.status === "active" && organization.enabled,
                ),
                canRevoke: invitationCanBeRevoked(invitation.status),
              };
            }),
            unresolved: rows
              .filter(
                (row) => row.status === "pending" &&
                  !pending.some((invitation) => invitation.email.toLowerCase() === row.email.toLowerCase()),
              )
              .map((row) => ({ tenantSlug: input.slug, invitationId: row.id, ...toInvitation(row), status: "provider_missing" })),
          };
        }

        if (action === "create") {
          let email: string;
          try { email = normalisedEmail(String(input.email ?? "")).toLowerCase(); }
          catch { throw new FirstAdministratorError("INVALID_INPUT", "A valid email address is required."); }
          if (!input.role || !isEmployeeInvitationRole(input.role)) throw new FirstAdministratorError("INVALID_INPUT", "role must be org_admin or org_employee.");
          if (tenant.status !== "active" || !organization.enabled) throw new FirstAdministratorError("TENANT_NOT_READY", "Inviting requires an active tenant and organization.");
          const existing = await clients.members.findPendingInvitationByEmail(organization.id, email);
          if (!existing) {
            if (!(await clients.members.hasInvitationMailConfiguration())) throw new FirstAdministratorError("SMTP_NOT_CONFIGURED", "Configure SMTP before sending invitations.");
            await clients.members.inviteUser(organization.id, { email, ...(input.firstName ? { firstName: input.firstName } : {}), ...(input.lastName ? { lastName: input.lastName } : {}) });
          }
          const invitation = await recordEmployeeInvitation(trx, tenant.id, `${deps.administrator.issuer}#${deps.administrator.subject}`,
            { email, role: input.role, ...(input.firstName ? { firstName: input.firstName } : {}), ...(input.lastName ? { lastName: input.lastName } : {}) });
          return { tenantSlug: input.slug, invitationId: existing?.id ?? invitation.id, ...invitation };
        }

        const invitation = pending.find((row) => row.id === input.invitationId);
        if (action === "get") {
          if (!invitation) throw new FirstAdministratorError("INVITATION_NOT_FOUND", "This invitation is no longer outstanding in this organization.");
          const local = localFor(invitation.email);
          return { tenantSlug: input.slug, invitationId: invitation.id, email: invitation.email, firstName: invitation.firstName,
            lastName: invitation.lastName, status: invitation.status,
            sentAt: invitationTimestamp(invitation.sentDate), expiresAt: invitationTimestamp(invitation.expiresAt),
            role: local?.role ?? null, registrationStatus: local?.status ?? "untracked",
            canResend: Boolean(local?.status === "pending" && tenant.status === "active" && organization.enabled),
            canRevoke: invitationCanBeRevoked(invitation.status) };
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
        if (local?.status === "accepted") {
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
        if (!local || local.status !== "pending") {
          throw new FirstAdministratorError(
            "INVITATION_ROLE_MISSING",
            "No pending role assignment exists. Revoke this invitation and create a new authorized invitation.",
          );
        }
        if (!clients.members.resendInvitation) {
          throw new FirstAdministratorError("INVITATIONS_NOT_CONFIGURED", "Invitation resend is not configured.");
        }
        if (!(await clients.members.hasInvitationMailConfiguration())) {
          throw new FirstAdministratorError("SMTP_NOT_CONFIGURED", "Configure SMTP before resending invitations.");
        }
        // No automatic retry: a timeout does not prove that mail was not sent.
        await clients.members.resendInvitation(organization.id, invitation.id);
        return {
          tenant: input.slug,
          email: invitation.email,
          role: local.role,
          status: "resent",
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
