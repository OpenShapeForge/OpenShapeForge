// SPDX-License-Identifier: BUSL-1.1
import { sql } from "kysely";
import { memberRoleClientId } from "../auth/employee-invitations.js";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import { withSystemSession } from "../db/session.js";
import type { KeycloakTenantMemberAdminClient } from "./keycloak-organization-members.js";
import type { MemberRoleAdminClient } from "./member-role-admin.js";
import { systemSessionForAdministrator, type PlatformAdministrator } from "./platform-admin.js";
import { ControlInputError } from "./organization-naming.js";

const ALLOWED_ROLES = new Set(["org_admin", "org_employee"]);

type Dependencies = {
  db: OpenShapeForgeDatabase;
  administrator: PlatformAdministrator;
  members: KeycloakTenantMemberAdminClient;
  memberRoles: MemberRoleAdminClient;
};

type TenantIdentity = { id: string; slug: string; status: string; keycloak_organization_id: string | null };

function providerId(value: string, label: string): string {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(value)) throw new ControlInputError(`${label} must be an identifier returned by this tenant administration API.`);
  return value;
}

async function withTenant<T>(deps: Dependencies, operation: string, slug: string, target: string | undefined,
  work: (tenant: TenantIdentity) => Promise<T>): Promise<T> {
  if (!/^[a-z][a-z0-9-]*$/.test(slug)) throw new ControlInputError("slug must be a tenant slug.");
  const reason = `${operation} tenant="${slug}"${target ? ` ${target}` : ""}`;
  return withSystemSession(deps.db, systemSessionForAdministrator(deps.administrator, reason), async (trx) => {
    const tenant = (await sql<TenantIdentity>`
      select id::text as id, slug, status, keycloak_organization_id
        from platform.tenants where slug = ${slug} for update
    `.execute(trx)).rows[0];
    if (!tenant) throw new ControlInputError("The tenant does not exist.");
    if (!tenant.keycloak_organization_id) throw new ControlInputError("The tenant has no linked Keycloak organization.");
    return work(tenant);
  });
}

async function memberWithSummary(deps: Dependencies, organizationId: string, memberId: string) {
  const member = await deps.members.getMember(organizationId, memberId, memberRoleClientId());
  if (!member) throw new ControlInputError("The member does not exist in this tenant.");
  const credentials = await deps.members.listCredentials(member.memberId);
  return {
    ...member,
    credentialCount: credentials.length,
    credentialTypes: [...new Set(credentials.map((credential) => credential.type))].sort(),
  };
}

export async function listTenantMembers(deps: Dependencies, slug: string) {
  return withTenant(deps, "control.list-tenant-members", slug, undefined, async (tenant) => ({
    tenantSlug: slug,
    members: await Promise.all((await deps.members.listMembers(tenant.keycloak_organization_id!, memberRoleClientId()))
      .map(async (member) => {
        const credentials = await deps.members.listCredentials(member.memberId);
        return { tenantSlug: slug, ...member, credentialCount: credentials.length,
          credentialTypes: [...new Set(credentials.map((credential) => credential.type))].sort() };
      })),
  }));
}

export async function getTenantMember(deps: Dependencies, slug: string, memberId: string) {
  providerId(memberId, "memberId");
  return withTenant(deps, "control.get-tenant-member", slug, `member="${memberId}"`, async (tenant) => ({
    tenantSlug: slug,
    ...(await memberWithSummary(deps, tenant.keycloak_organization_id!, memberId)),
  }));
}

export async function listTenantCredentials(deps: Dependencies, slug: string, memberId: string) {
  providerId(memberId, "memberId");
  return withTenant(deps, "control.list-tenant-credentials", slug, `member="${memberId}"`, async (tenant) => {
    await memberWithSummary(deps, tenant.keycloak_organization_id!, memberId);
    return { tenantSlug: slug, memberId, credentials: (await deps.members.listCredentials(memberId))
      .map((credential) => ({ tenantSlug: slug, memberId, ...credential })) };
  });
}

export async function getTenantCredential(deps: Dependencies, slug: string, memberId: string, credentialId: string) {
  providerId(memberId, "memberId");
  providerId(credentialId, "credentialId");
  return withTenant(deps, "control.get-tenant-credential", slug, `member="${memberId}" credential="${credentialId}"`, async (tenant) => {
    await memberWithSummary(deps, tenant.keycloak_organization_id!, memberId);
    const credential = (await deps.members.listCredentials(memberId)).find((item) => item.credentialId === credentialId);
    if (!credential) throw new ControlInputError("The credential does not exist for this member.");
    return { tenantSlug: slug, memberId, ...credential };
  });
}

function roles(input: unknown): string[] {
  if (!Array.isArray(input) || input.length === 0 || input.some((role) => typeof role !== "string" || !ALLOWED_ROLES.has(role))) {
    throw new ControlInputError("roles must contain only org_admin or org_employee.");
  }
  return [...new Set(input as string[])];
}

export async function changeTenantMemberRoles(deps: Dependencies, slug: string, memberId: string, input: unknown, mode: "assign" | "remove") {
  providerId(memberId, "memberId");
  return withTenant(deps, `control.${mode}-tenant-member-roles`, slug, `member="${memberId}"`, async (tenant) => {
    await memberWithSummary(deps, tenant.keycloak_organization_id!, memberId);
    const selected = roles(input);
    if (mode === "assign") await deps.memberRoles.grantClientRoles(memberId, memberRoleClientId(), selected);
    else await deps.memberRoles.revokeClientRoles(memberId, memberRoleClientId(), selected);
    await deps.memberRoles.forceReauthentication(memberId).catch(() => undefined);
    return { tenantSlug: slug, memberId, roles: selected, action: mode === "assign" ? "assigned" : "removed" };
  });
}

export async function removeTenantMembership(deps: Dependencies, slug: string, memberId: string) {
  providerId(memberId, "memberId");
  return withTenant(deps, "control.remove-tenant-membership", slug, `member="${memberId}"`, async (tenant) => ({
    tenantSlug: slug,
    memberId,
    removed: await deps.members.removeMember(tenant.keycloak_organization_id!, memberId),
  }));
}

export async function requestPasskeyRecovery(deps: Dependencies, slug: string, memberId: string) {
  providerId(memberId, "memberId");
  return withTenant(deps, "control.request-passkey-recovery", slug, `member="${memberId}"`, async (tenant) => {
    const member = await memberWithSummary(deps, tenant.keycloak_organization_id!, memberId);
    if (!member.enabled || !member.email) throw new ControlInputError("Passkey recovery requires an enabled member with an email address.");
    await deps.members.sendPasskeyRecovery(memberId);
    return { tenantSlug: slug, memberId, email: member.email, action: "recovery_email_sent", expiresInSeconds: 900 };
  });
}

export async function revokeTenantCredential(deps: Dependencies, slug: string, memberId: string, credentialId: string, recoveryConfirmed: boolean) {
  providerId(memberId, "memberId");
  providerId(credentialId, "credentialId");
  return withTenant(deps, "control.revoke-tenant-credential", slug, `member="${memberId}" credential="${credentialId}"`, async (tenant) => {
    await memberWithSummary(deps, tenant.keycloak_organization_id!, memberId);
    const credentials = await deps.members.listCredentials(memberId);
    if (!credentials.some((credential) => credential.credentialId === credentialId)) throw new ControlInputError("The credential does not exist for this member.");
    if (credentials.length === 1 && !recoveryConfirmed) throw new ControlInputError("The last credential requires a confirmed recovery route.");
    return { tenantSlug: slug, memberId, credentialId, revoked: await deps.members.deleteCredential(memberId, credentialId) };
  });
}
