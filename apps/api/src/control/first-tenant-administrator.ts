// SPDX-License-Identifier: BUSL-1.1
import { sql } from "kysely";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import { withSystemSession } from "../db/session.js";
import { normalisedEmail, recordEmployeeInvitation, toInvitation, memberRoleClientId } from "../auth/employee-invitations.js";
import { IDENTITY_LINK_ADMIN_ROLE } from "../auth/organization-roles.js";
import { systemSessionForAdministrator, type PlatformAdministrator } from "./platform-admin.js";
import { KeycloakAdminError, type KeycloakOrganizationAdminClient } from "./keycloak-organization-admin.js";
import type { KeycloakOrganizationMembersClient, OrganizationBootstrapReads } from "./keycloak-organization-members.js";

export class FirstAdministratorError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
export type FirstAdministratorClients = {
  tenantRealm: string;
  members: KeycloakOrganizationMembersClient & OrganizationBootstrapReads;
  organizations: Pick<KeycloakOrganizationAdminClient, "getOrganization">;
};

/** Error shape deliberately restricted to fields that are safe in shared logs. */
export class KeycloakInvitationDiagnosticError extends Error {
  readonly code: KeycloakAdminError["code"];
  readonly status: number | undefined;
  readonly operation: KeycloakAdminError["operation"];
  readonly durationMs: number | undefined;
  readonly correlationId: string | undefined;

  constructor(error: KeycloakAdminError, correlationId?: string) {
    super("Keycloak invitation subcall failed.");
    this.name = "KeycloakInvitationDiagnosticError";
    this.code = error.code;
    this.status = error.status;
    this.operation = error.operation;
    this.durationMs = error.durationMs;
    this.correlationId = correlationId;
  }
}

export function invitationDeliveryUnconfirmed(
  error: KeycloakAdminError,
  log?: (error: unknown) => void,
  correlationId?: string,
): FirstAdministratorError {
  log?.(new KeycloakInvitationDiagnosticError(error, correlationId));
  return new FirstAdministratorError(
    "INVITATION_DELIVERY_UNCONFIRMED",
    "Keycloak did not confirm the invitation operation. Check its availability, service-account permissions and tenant-realm SMTP; no successful email delivery is claimed.",
  );
}

/** Only called behind a verified control-realm session (control-session.ts); never synthesizes a tenant identity. */
export async function inviteFirstTenantAdministrator(
  deps: { db: OpenShapeForgeDatabase; administrator: PlatformAdministrator; firstAdministrator?: FirstAdministratorClients; log?: (error: unknown) => void; correlationId?: string },
  input: { slug: string; email: string },
) {
  if (!/^[a-z][a-z0-9-]*$/.test(input.slug)) throw new FirstAdministratorError("INVALID_INPUT", "A tenant slug is required.");
  let email: string;
  try { email = normalisedEmail(input.email).toLowerCase(); }
  catch { throw new FirstAdministratorError("INVALID_INPUT", "A valid email address is required."); }
  const clients = deps.firstAdministrator;
  if (!clients) throw new FirstAdministratorError("INVITATIONS_NOT_CONFIGURED", "Tenant invitation service is not configured.");
  const actor = `${deps.administrator.issuer}#${deps.administrator.subject}`;
  try {
    return await withSystemSession(deps.db, systemSessionForAdministrator(deps.administrator,
      `control.invite-first-tenant-admin ${input.slug}`), async trx => {
      // Serialize bootstrap decisions per existing tenant, including remote mail.
      const tenant = (await sql<{ id: string; status: string; keycloak_realm: string | null; keycloak_organization_id: string | null }>`
        select id, status, keycloak_realm, keycloak_organization_id from platform.tenants
        where slug = ${input.slug} for update
      `.execute(trx)).rows[0];
      if (!tenant) throw new FirstAdministratorError("TENANT_NOT_FOUND", "The tenant does not exist.");
      if (tenant.status !== "active" || tenant.keycloak_realm !== clients.tenantRealm || !tenant.keycloak_organization_id)
        throw new FirstAdministratorError("TENANT_NOT_READY", "The tenant must be active and linked to the configured tenant realm.");
      const organization = await clients.organizations.getOrganization(tenant.keycloak_organization_id);
      if (!organization.enabled || organization.id !== tenant.keycloak_organization_id || organization.alias !== input.slug)
        throw new FirstAdministratorError("TENANT_NOT_READY", "The linked organization does not match the active tenant.");
      const prior = (await sql<Parameters<typeof toInvitation>[0]>`
        select id, email, role, first_name, last_name, status, invited_by, invited_at, revoked_at
        from platform.employee_invitations where tenant_id = ${tenant.id}
        and status in ('pending', 'accepted')
        and (role = 'org_admin' or lower(email) = ${email})
      `.execute(trx)).rows;
      if (prior.some(p => p.role !== "org_admin" || p.email.toLowerCase() !== email))
        throw new FirstAdministratorError("FIRST_ADMIN_ALREADY_ASSIGNED", "An administrator or conflicting invitation already exists; use the tenant administrator workflow.");
      const admins = await clients.members.organizationAdministrators(organization.id, memberRoleClientId(), IDENTITY_LINK_ADMIN_ROLE);
      if (admins.some(a => a.email?.toLowerCase() !== email))
        throw new FirstAdministratorError("FIRST_ADMIN_ALREADY_ASSIGNED", "This organization already has an administrator.");
      const previous = prior.find(p => p.email.toLowerCase() === email);
      if (previous?.status === "accepted") return { tenant: input.slug, ...toInvitation(previous) };
      if (admins.length) {
        // Keycloak membership and its role do not create the OSF Relation or
        // identity link required by tenant admission. Record the same local
        // intent as an e-mailed invitation, without sending redundant mail;
        // first sign-in will consume it and converge both identity stores.
        if (previous) return { tenant: input.slug, ...toInvitation(previous) };
        const invitation = await recordEmployeeInvitation(
          trx, tenant.id, actor, { email, role: "org_admin" },
        );
        return { tenant: input.slug, ...invitation };
      }
      const pending = await clients.members.findPendingInvitationByEmail(organization.id, email);
      if (pending && previous) return { tenant: input.slug, ...toInvitation(previous) };
      if (!pending) {
        if (!await clients.members.hasInvitationMailConfiguration())
          throw new FirstAdministratorError("SMTP_NOT_CONFIGURED", "Configure working SMTP (host and sender) on the tenant Keycloak realm before sending invitations.");
        await clients.members.inviteUser(organization.id, { email });
      }
      // Also repairs a confirmed Keycloak invite whose earlier DB commit failed.
      const invitation = await recordEmployeeInvitation(trx, tenant.id, actor, { email, role: "org_admin" });
      return { tenant: input.slug, ...invitation };
    });
  } catch (error) {
    if (error instanceof KeycloakAdminError) {
      throw invitationDeliveryUnconfirmed(error, deps.log, deps.correlationId);
    }
    throw error;
  }
}
