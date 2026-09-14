// SPDX-License-Identifier: BUSL-1.1
import { sql } from "kysely";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import { withSystemSession } from "../db/session.js";
import { toInvitation } from "../auth/employee-invitations.js";
import { systemSessionForAdministrator, type PlatformAdministrator } from "./platform-admin.js";
import { FirstAdministratorError, invitationDeliveryUnconfirmed, type FirstAdministratorClients } from "./first-tenant-administrator.js";
import { KeycloakAdminError } from "./keycloak-organization-admin.js";

type Dependencies = {
  db: OpenShapeForgeDatabase;
  administrator: PlatformAdministrator;
  firstAdministrator?: FirstAdministratorClients;
  log?: (error: unknown) => void;
  correlationId?: string;
};
type Input = { slug: string; invitationId?: string };
type Action = "list_tenant_invitations" | "revoke_tenant_invitation" | "resend_tenant_invitation";

/** Platform metadata only; never constructs a tenant member session or changes an invited role. */
export async function manageTenantInvitations(deps: Dependencies, action: Action, input: Input) {
  if (!/^[a-z][a-z0-9-]*$/.test(input.slug))
    throw new FirstAdministratorError("INVALID_INPUT", "A tenant slug is required.");
  if (action !== "list_tenant_invitations" && (!input.invitationId || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.invitationId)))
    throw new FirstAdministratorError("INVALID_INPUT", "Use an invitationId from list_tenant_invitations.");
  const clients = deps.firstAdministrator;
  if (!clients) throw new FirstAdministratorError("INVITATIONS_NOT_CONFIGURED", "Tenant invitation service is not configured.");
  try {
    return await withSystemSession(deps.db, systemSessionForAdministrator(deps.administrator,
      `${action} ${input.slug}`), async trx => {
      // Same lock as first-admin bootstrap: prevents competing platform decisions.
      const tenant = (await sql<{ id: string; status: string; keycloak_realm: string | null; keycloak_organization_id: string | null }>`
        select id, status, keycloak_realm, keycloak_organization_id from platform.tenants
        where slug = ${input.slug} for update
      `.execute(trx)).rows[0];
      if (!tenant || tenant.keycloak_realm !== clients.tenantRealm)
        throw new FirstAdministratorError("TENANT_NOT_FOUND", "The tenant does not exist in the configured realm.");
      if (!tenant.keycloak_organization_id)
        throw new FirstAdministratorError("TENANT_NOT_READY", "The tenant has no linked organization.");
      const organization = await clients.organizations.getOrganization(tenant.keycloak_organization_id);
      if (organization.id !== tenant.keycloak_organization_id || organization.alias !== input.slug)
        throw new FirstAdministratorError("TENANT_NOT_READY", "The linked organization does not match the tenant.");
      const rows = (await sql<Parameters<typeof toInvitation>[0]>`
        select id, email, role, first_name, last_name, status, invited_by, invited_at, revoked_at
        from platform.employee_invitations where tenant_id = ${tenant.id}
        order by invited_at desc limit 10001
      `.execute(trx)).rows;
      if (rows.length > 10000) throw new FirstAdministratorError("INVITATION_LIMIT_EXCEEDED", "Invitation history exceeds the supported bound.");
      const pending = await clients.members.listInvitations(organization.id);
      const localFor = (email: string) => rows.find(row => row.email.toLowerCase() === email.toLowerCase());
      if (action === "list_tenant_invitations") return {
        tenant: input.slug,
        invitations: pending.map(invitation => {
          const local = localFor(invitation.email);
          return {
            invitationId: invitation.id, email: invitation.email,
            firstName: invitation.firstName, lastName: invitation.lastName,
            status: invitation.status, sentAt: invitation.sentDate, expiresAt: invitation.expiresAt,
            role: local?.role ?? null, registrationStatus: local?.status ?? "untracked",
            canResend: Boolean(local?.status === "pending" && tenant.status === "active" && organization.enabled),
          };
        }),
        // A missing provider invitation is not proof of acceptance. Keep discrepancies visible.
        unresolved: rows.filter(row => row.status === "pending" &&
          !pending.some(invitation => invitation.email.toLowerCase() === row.email.toLowerCase()))
          .map(row => ({ ...toInvitation(row), status: "provider_missing" })),
      };
      // Keycloak 26.5 resolves invitation IDs globally. Always establish ownership from this org's list.
      const invitation = pending.find(row => row.id === input.invitationId);
      if (!invitation && action === "revoke_tenant_invitation") {
        const unresolved = rows.find(row => row.id === input.invitationId && row.status === "pending");
        if (unresolved && !pending.some(row => row.email.toLowerCase() === unresolved.email.toLowerCase())) {
          const updated = await sql`update platform.employee_invitations set status='revoked', revoked_at=now(),
            revoked_by=${`${deps.administrator.issuer}#${deps.administrator.subject}`}, updated_at=now()
            where tenant_id=${tenant.id} and id=${unresolved.id} and status='pending' returning id`.execute(trx);
          if (!updated.rows.length) throw new FirstAdministratorError("INVITATION_STATE_CHANGED", "The pending role assignment changed. Refresh; no member was removed.");
          return { tenant: input.slug, email: unresolved.email, status: "revoked", keycloakInvitationDeleted: false };
        }
      }
      if (!invitation) throw new FirstAdministratorError("INVITATION_NOT_FOUND", "This invitation is no longer outstanding in this organization. Refresh the list.");
      const local = localFor(invitation.email);
      if (local?.status === "accepted")
        throw new FirstAdministratorError("INVITATION_ALREADY_ACCEPTED", "This invitation has already been accepted; use member administration.");
      if (action === "revoke_tenant_invitation") {
        const deleted = await clients.members.deleteInvitation(organization.id, invitation.id);
        const updated = await sql`update platform.employee_invitations set status = 'revoked', revoked_at = now(),
          revoked_by = ${`${deps.administrator.issuer}#${deps.administrator.subject}`}, updated_at = now()
          where tenant_id = ${tenant.id} and lower(email) = lower(${invitation.email}) and status = 'pending' returning id`.execute(trx);
        if (local?.status === "pending" && !updated.rows.length) throw new FirstAdministratorError("INVITATION_STATE_CHANGED", "The pending role assignment changed. Refresh; no member was removed.");
        return { tenant: input.slug, email: invitation.email, status: "revoked", keycloakInvitationDeleted: deleted };
      }
      if (tenant.status !== "active" || !organization.enabled)
        throw new FirstAdministratorError("TENANT_NOT_READY", "Resending requires an active tenant and organization.");
      if (!local || local.status !== "pending")
        throw new FirstAdministratorError("INVITATION_ROLE_MISSING", "No pending role assignment exists. Revoke this invitation and create a new authorized invitation.");
      if (!clients.members.resendInvitation)
        throw new FirstAdministratorError("INVITATIONS_NOT_CONFIGURED", "Invitation resend is not configured.");
      if (!await clients.members.hasInvitationMailConfiguration())
        throw new FirstAdministratorError("SMTP_NOT_CONFIGURED", "Configure SMTP before resending invitations.");
      // Provider-native resend preserves the recipient and atomically replaces the old invitation.
      // No automatic retry: a timeout does not prove that mail was not sent.
      await clients.members.resendInvitation(organization.id, invitation.id);
      return { tenant: input.slug, email: invitation.email, role: local.role, status: "resent" };
    });
  } catch (error) {
    if (error instanceof KeycloakAdminError) throw invitationDeliveryUnconfirmed(error, deps.log, deps.correlationId);
    throw error;
  }
}
