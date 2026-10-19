// SPDX-License-Identifier: BUSL-1.1
/** Account self-discovery. Native membership is read live, then intersected
 * with admitted, unblocked identities in the same configured tenant realm.
 * Each point read keeps RLS enabled in that tenant; no registry enumeration,
 * system bypass, caller-supplied account id or current-tenant roles are used.
 * A choice is informational: OAuth and ordinary session verification still
 * establish the next tenant independently.
 */
import { GraphQLError } from "graphql";
import { sql } from "kysely";
import { findPendingInvitation } from "../auth/employee-invitations.js";
import { realmFromIssuer } from "../auth/tenant-resolution.js";
import { lookupTenantForOrganization } from "../auth/tenant-resolution.js";
import { withDbSession } from "../db/session.js";
import { readControlPlaneConfig } from "../control/config.js";
import { createKeycloakOrganizationMembersClient } from "../control/keycloak-organization-members.js";
import type { GraphqlContext } from "./context.js";

export type AvailableTenant = { id: string; slug: string; name: string };
export const availableTenantTypeDefs = `type AvailableTenant { id: ID! slug: String! name: String! }`;
export const availableTenantQueryFields = `availableTenants: [AvailableTenant!]!`;
let provider: { realm: string; issuer: string; list(subject: string): Promise<readonly { id: string; enabled: boolean }[]> } | undefined;
const reads = new WeakMap<GraphqlContext, Promise<AvailableTenant[]>>();
function membershipProvider() {
  if (provider) return provider;
  const config = readControlPlaneConfig();
  if (!config.ok) throw new Error("Organization discovery is unavailable.");
  const client = createKeycloakOrganizationMembersClient(config.config.keycloak);
  provider = { realm: config.config.keycloak.tenantRealm, issuer: `${config.config.keycloak.baseUrl}/realms/${encodeURIComponent(config.config.keycloak.tenantRealm)}`, list: subject => client.listMemberOrganizations!(subject) };
  return provider;
}

export async function readAvailableTenants(context: GraphqlContext,
  memberships = membershipProvider,
  lookup = lookupTenantForOrganization,
): Promise<AvailableTenant[]> {
  const session = context.session;
  if (session.credential !== "bearer" || session.principalKind !== "person" || !session.issuer || !session.userId || !session.tenantId)
    throw new GraphQLError("Organization discovery requires an authenticated person.", { extensions: { code: "UNAUTHENTICATED", status: 401 } });
  if (!context.db) throw new GraphQLError("Organization discovery is unavailable.", { extensions: { code: "DATABASE_NOT_CONFIGURED", status: 503 } });
  try {
    const source = memberships();
    if (session.issuer !== source.issuer || realmFromIssuer(session.issuer) !== source.realm) throw new Error("Issuer realm mismatch.");
    const organizations = await source.list(session.userId);
    if (organizations.length > 100) throw new Error("Organization discovery exceeds its bound.");
    const result: AvailableTenant[] = [];
    const seen = new Set<string>();
    for (const organization of organizations) {
      if (!organization.enabled || seen.has(organization.id)) continue;
      seen.add(organization.id);
      const tenantId = await lookup(context.db, source.realm, organization.id);
      if (!tenantId) continue;
      const row = await withDbSession(context.db, { tenantId, userId: session.userId, roles: [], groups: [], scope: "self" }, async tx => {
        const tenant = (await sql<AvailableTenant & { membership_status: string | null; access_blocked: boolean }>`select t.id, t.slug, t.name,
          ir.status as membership_status, coalesce(ir.access_blocked,false) as access_blocked
          from platform.tenants t
          left join platform.identity_relations ir on ir.tenant_id=t.id
            and ir.identity_id=(select i.id from platform.identities i where i.issuer=${session.issuer!} and i.subject=${session.userId!})
          where t.id=${tenantId}::uuid and t.keycloak_realm=${source.realm}
            and t.keycloak_organization_id=${organization.id} and t.status='active'`.execute(tx)).rows[0];
        if (!tenant || tenant.access_blocked) return undefined;
        // A still-pending invitation already authorizes the first native sign-in.
        // Merely showing it must not create a Relation or claim that invitation.
        if (tenant.membership_status !== "linked" && !(session.verifiedEmail &&
          await findPendingInvitation(tx, tenantId, session.verifiedEmail))) return undefined;
        return { id: tenant.id, slug: tenant.slug, name: tenant.name };
      });
      if (row) result.push(row);
    }
    return result.sort((a,b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  } catch {
    throw new GraphQLError("Organizations could not be loaded. Try again.", { extensions: { code: "ORGANIZATION_DISCOVERY_UNAVAILABLE", status: 503 } });
  }
}

export function resolveAvailableTenants(_parent: unknown, _args: unknown, context: GraphqlContext) {
  let pending = reads.get(context);
  if (!pending) { pending = readAvailableTenants(context); reads.set(context, pending); }
  return pending;
}
