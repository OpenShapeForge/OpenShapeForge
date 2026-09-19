// SPDX-License-Identifier: BUSL-1.1
/**
 * Platform-operator administration of one tenant's members. Membership,
 * credentials and passkey recovery are Keycloak's (the organization's
 * members); a member's ROLES in the tenant are the tenant's own record,
 * `platform.identity_relations.roles` (auth/identity-link.ts) — never a
 * client role on the Keycloak user, which would be user-wide and apply in
 * every organization the account is a member of. The `roles` a member is
 * listed with here are read from that row, and assigning or removing them
 * writes it; a member who has not signed in to the tenant yet has no row and
 * receives their roles from the invitation on first sign-in.
 */
import { sql, type Transaction } from "kysely";
import {
  employeeInvitationRoleGrants,
  isEmployeeInvitationRole,
  memberRoleClientId,
  type EmployeeInvitationRole,
} from "../auth/employee-invitations.js";
import { invalidateIdentityLink } from "../auth/identity-link.js";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import type { DB } from "../generated/db/types.js";
import { withSystemSession } from "../db/session.js";
import type { KeycloakTenantMemberAdminClient } from "./keycloak-organization-members.js";
import { systemSessionForAdministrator, type PlatformAdministrator } from "./platform-admin.js";
import { ControlInputError } from "./organization-naming.js";

type Dependencies = {
  db: OpenShapeForgeDatabase;
  administrator: PlatformAdministrator;
  members: KeycloakTenantMemberAdminClient;
};

type TenantIdentity = { id: string; slug: string; status: string; keycloak_organization_id: string | null };

function providerId(value: string, label: string): string {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(value)) throw new ControlInputError(`${label} must be an identifier returned by this tenant administration API.`);
  return value;
}

async function withTenant<T>(deps: Dependencies, operation: string, slug: string, target: string | undefined,
  work: (tenant: TenantIdentity, trx: Transaction<DB>) => Promise<T>): Promise<T> {
  if (!/^[a-z][a-z0-9-]*$/.test(slug)) throw new ControlInputError("slug must be a tenant slug.");
  const reason = `${operation} tenant="${slug}"${target ? ` ${target}` : ""}`;
  return withSystemSession(deps.db, systemSessionForAdministrator(deps.administrator, reason), async (trx) => {
    const tenant = (await sql<TenantIdentity>`
      select id::text as id, slug, status, keycloak_organization_id
        from platform.tenants where slug = ${slug} for update
    `.execute(trx)).rows[0];
    if (!tenant) throw new ControlInputError("The tenant does not exist.");
    if (!tenant.keycloak_organization_id) throw new ControlInputError("The tenant has no linked Keycloak organization.");
    return work(tenant, trx as Transaction<DB>);
  });
}

type MembershipRow = { identity_id: string; issuer: string; subject: string; roles: string[] | null };

/** The tenant's membership rows keyed by Keycloak user id (the token `sub`). */
async function membershipsBySubject(trx: Transaction<DB>, tenantId: string): Promise<Map<string, MembershipRow>> {
  const rows = await sql<MembershipRow>`
    select ir.identity_id, i.issuer, i.subject, ir.roles
      from platform.identity_relations ir
      join platform.identities i on i.id = ir.identity_id
     where ir.tenant_id = ${tenantId}::uuid
  `.execute(trx);
  return new Map(rows.rows.map((row) => [row.subject, row]));
}

async function memberWithSummary(deps: Dependencies, trx: Transaction<DB>, tenant: TenantIdentity, memberId: string) {
  const member = await deps.members.getMember(tenant.keycloak_organization_id!, memberId, memberRoleClientId());
  if (!member) throw new ControlInputError("The member does not exist in this tenant.");
  const credentials = await deps.members.listCredentials(member.memberId);
  const membership = (await membershipsBySubject(trx, tenant.id)).get(memberId);
  return {
    ...member,
    roles: [...(membership?.roles ?? [])].sort(),
    credentialCount: credentials.length,
    credentialTypes: [...new Set(credentials.map((credential) => credential.type))].sort(),
  };
}

export async function listTenantMembers(deps: Dependencies, slug: string) {
  return withTenant(deps, "control.list-tenant-members", slug, undefined, async (tenant, trx) => {
    const memberships = await membershipsBySubject(trx, tenant.id);
    return {
      tenantSlug: slug,
      members: await Promise.all((await deps.members.listMembers(tenant.keycloak_organization_id!, memberRoleClientId()))
        .map(async (member) => {
          const credentials = await deps.members.listCredentials(member.memberId);
          return { tenantSlug: slug, ...member, roles: [...(memberships.get(member.memberId)?.roles ?? [])].sort(),
            credentialCount: credentials.length,
            credentialTypes: [...new Set(credentials.map((credential) => credential.type))].sort() };
        })),
    };
  });
}

export async function getTenantMember(deps: Dependencies, slug: string, memberId: string) {
  providerId(memberId, "memberId");
  return withTenant(deps, "control.get-tenant-member", slug, `member="${memberId}"`, async (tenant, trx) => ({
    tenantSlug: slug,
    ...(await memberWithSummary(deps, trx, tenant, memberId)),
  }));
}

export async function listTenantCredentials(deps: Dependencies, slug: string, memberId: string) {
  providerId(memberId, "memberId");
  return withTenant(deps, "control.list-tenant-credentials", slug, `member="${memberId}"`, async (tenant, trx) => {
    await memberWithSummary(deps, trx, tenant, memberId);
    return { tenantSlug: slug, memberId, credentials: (await deps.members.listCredentials(memberId))
      .map((credential) => ({ tenantSlug: slug, memberId, ...credential })) };
  });
}

export async function getTenantCredential(deps: Dependencies, slug: string, memberId: string, credentialId: string) {
  providerId(memberId, "memberId");
  providerId(credentialId, "credentialId");
  return withTenant(deps, "control.get-tenant-credential", slug, `member="${memberId}" credential="${credentialId}"`, async (tenant, trx) => {
    await memberWithSummary(deps, trx, tenant, memberId);
    const credential = (await deps.members.listCredentials(memberId)).find((item) => item.credentialId === credentialId);
    if (!credential) throw new ControlInputError("The credential does not exist for this member.");
    return { tenantSlug: slug, memberId, ...credential };
  });
}

function roles(input: unknown): EmployeeInvitationRole[] {
  if (!Array.isArray(input) || input.length === 0 || input.some((role) => typeof role !== "string" || !isEmployeeInvitationRole(role))) {
    throw new ControlInputError("roles must contain only org_admin or org_employee.");
  }
  return [...new Set(input as EmployeeInvitationRole[])];
}

/**
 * Assign or remove personas on the member's membership row for THIS tenant.
 * Written under the audited bypass session, which the column's trigger
 * accepts; effective on the person's next request (the link cache entry is
 * invalidated here, other replicas pick it up within a minute). No sign-out
 * is needed: the token never carried these.
 */
export async function changeTenantMemberRoles(deps: Dependencies, slug: string, memberId: string, input: unknown, mode: "assign" | "remove") {
  providerId(memberId, "memberId");
  return withTenant(deps, `control.${mode}-tenant-member-roles`, slug, `member="${memberId}"`, async (tenant, trx) => {
    await memberWithSummary(deps, trx, tenant, memberId);
    const selected = roles(input);
    const membership = (await membershipsBySubject(trx, tenant.id)).get(memberId);
    if (!membership) {
      throw new ControlInputError(
        "The member has not signed in to this tenant yet; invite them and their roles are recorded on first sign-in.",
      );
    }
    const grants = new Set(selected.flatMap((role) => employeeInvitationRoleGrants(role)));
    const current = new Set(membership.roles ?? []);
    const next = mode === "assign"
      ? [...new Set([...current, ...grants])]
      : [...current].filter((role) => !grants.has(role));
    await sql`
      update platform.identity_relations
         set roles = (
               select coalesce(array_agg(value), '{}'::text[])
                 from jsonb_array_elements_text(${[...next].sort()}::jsonb)
             ),
             needs_role_assignment = false,
             updated_at = now()
       where identity_id = ${membership.identity_id}::uuid and tenant_id = ${tenant.id}::uuid
    `.execute(trx);
    invalidateIdentityLink(membership.issuer, membership.subject, tenant.id);
    return { tenantSlug: slug, memberId, roles: [...next].sort(), action: mode === "assign" ? "assigned" : "removed" };
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
  return withTenant(deps, "control.request-passkey-recovery", slug, `member="${memberId}"`, async (tenant, trx) => {
    const member = await memberWithSummary(deps, trx, tenant, memberId);
    if (!member.enabled || !member.email) throw new ControlInputError("Passkey recovery requires an enabled member with an email address.");
    await deps.members.sendPasskeyRecovery(memberId);
    return { tenantSlug: slug, memberId, email: member.email, action: "recovery_email_sent", expiresInSeconds: 900 };
  });
}

export async function revokeTenantCredential(deps: Dependencies, slug: string, memberId: string, credentialId: string, recoveryConfirmed: boolean) {
  providerId(memberId, "memberId");
  providerId(credentialId, "credentialId");
  return withTenant(deps, "control.revoke-tenant-credential", slug, `member="${memberId}" credential="${credentialId}"`, async (tenant, trx) => {
    await memberWithSummary(deps, trx, tenant, memberId);
    const credentials = await deps.members.listCredentials(memberId);
    if (!credentials.some((credential) => credential.credentialId === credentialId)) throw new ControlInputError("The credential does not exist for this member.");
    if (credentials.length === 1 && !recoveryConfirmed) throw new ControlInputError("The last credential requires a confirmed recovery route.");
    return { tenantSlug: slug, memberId, credentialId, revoked: await deps.members.deleteCredential(memberId, credentialId) };
  });
}
