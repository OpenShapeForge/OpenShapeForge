// SPDX-License-Identifier: BUSL-1.1
import { sql } from "kysely";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import { withDbSession, type DbSessionInput } from "../db/session.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_RELATION_GROUPS = 256;

export type RelationGroupMembershipRow = {
  issuer: string;
  subject: string;
  identityTenantId: string;
  linkedRelationId: string;
  tenantId: string;
  relationId: string;
  relationGroupId: string;
  membershipStatus: string;
  groupStatus: string;
};

type LinkedSession = DbSessionInput & { tenantId: string; userId: string };
export type VerifiedIdentityReference = { issuer: string; subject: string };

export type RelationGroupMembershipDeps = {
  read?: (
    db: OpenShapeForgeDatabase,
    session: LinkedSession,
    identity: VerifiedIdentityReference,
  ) => Promise<readonly RelationGroupMembershipRow[]>;
  warn?: (message: string) => void;
};

async function readMemberships(
  db: OpenShapeForgeDatabase,
  session: LinkedSession,
  identityReference: VerifiedIdentityReference,
): Promise<readonly RelationGroupMembershipRow[]> {
  return withDbSession(db, session, async (trx) => {
    const result = await sql<RelationGroupMembershipRow>`
      select distinct
        identity.issuer as "issuer",
        identity.subject as "subject",
        identity_relation.tenant_id::text as "identityTenantId",
        identity_relation.relation_id::text as "linkedRelationId",
        membership.tenant_id::text as "tenantId",
        membership.relation_id::text as "relationId",
        membership.relation_group_id::text as "relationGroupId",
        membership.status::text as "membershipStatus",
        relation_group.status::text as "groupStatus"
      from platform.identities as identity
      inner join platform.identity_relations as identity_relation
        on identity_relation.identity_id = identity.id
       and identity_relation.tenant_id = ${session.tenantId}::uuid
       and identity_relation.status = 'linked'
      inner join erp.relation_group_memberships as membership
        on membership.tenant_id = identity_relation.tenant_id
       and membership.relation_id = identity_relation.relation_id
      inner join erp.relations as relation
        on relation.tenant_id = membership.tenant_id
       and relation.id = membership.relation_id
      inner join erp.relation_groups as relation_group
        on relation_group.tenant_id = membership.tenant_id
       and relation_group.id = membership.relation_group_id
      where identity.issuer = ${identityReference.issuer}
        and identity.subject = ${identityReference.subject}
        and membership.tenant_id = ${session.tenantId}::uuid
        and membership.status = 'active'
        and relation_group.status = 'active'
      limit ${MAX_RELATION_GROUPS + 1}
    `.execute(trx);
    return result.rows;
  });
}

/**
 * Resolve domain RelationGroup memberships for one verified bearer request.
 *
 * The login→Relation binding is accepted only from the server-managed
 * identity_relations state. Keycloak group claims and erp.accounts are never
 * consulted. There is intentionally no cache: a membership or group
 * revocation takes effect on the next request, including the next request on
 * an existing stateful MCP transport.
 */
export async function resolveRelationGroupMembershipIds(
  db: OpenShapeForgeDatabase,
  session: LinkedSession,
  identity: VerifiedIdentityReference | null | undefined,
  deps: RelationGroupMembershipDeps = {},
): Promise<readonly string[]> {
  if (!identity) return [];

  try {
    const rows = await (deps.read ?? readMemberships)(db, session, identity);
    const accepted = rows.filter(
      (row) =>
        row.issuer === identity.issuer &&
        row.subject === identity.subject &&
        row.identityTenantId === session.tenantId &&
        row.tenantId === session.tenantId &&
        row.relationId === row.linkedRelationId &&
        row.membershipStatus === "active" &&
        row.groupStatus === "active" &&
        UUID_PATTERN.test(row.relationGroupId),
    );
    if (accepted.length > MAX_RELATION_GROUPS) {
      throw new Error("RelationGroup membership limit exceeded.");
    }
    return [...new Set(accepted.map((row) => row.relationGroupId))].sort();
  } catch {
    (deps.warn ?? console.warn)(
      "[auth] RelationGroup memberships could not be resolved; no group-based record access was granted.",
    );
    return [];
  }
}
