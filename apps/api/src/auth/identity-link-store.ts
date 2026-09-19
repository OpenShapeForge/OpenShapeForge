// SPDX-License-Identifier: BUSL-1.1
/**
 * The SQL behind the identity ↔ Relation link (see ./identity-link.ts for
 * the model): the identity upsert, the link row read and insert, the roles
 * column write, the e-mail candidate lookup and the row → state projection.
 * Every statement runs on the caller's session, so RLS on
 * platform.identities and platform.identity_relations (and the trigger on
 * `roles`) is what fences it; nothing here decides authorization.
 */
import { sql, type Transaction } from "kysely";
import type { DB } from "../generated/db/types.js";
import type { IdentityClaims, IdentityLinkState, IdentityLinkStatus } from "./identity-link.js";


export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type LinkRow = {
  identity_id: string;
  issuer: string;
  subject: string;
  status: IdentityLinkStatus;
  relation_id: string | null;
  candidate_relation_id: string | null;
  linked_by: string | null;
  display_name: string | null;
  relation_type: string | null;
  needs_role_assignment: boolean;
  roles: string[] | null;
};

export async function upsertIdentity(
  trx: Transaction<DB>,
  claims: IdentityClaims,
  displayName: string,
): Promise<string> {
  const result = await sql<{ id: string }>`
    insert into platform.identities (issuer, subject, email, display_name)
    values (${claims.issuer}, ${claims.subject}, ${claims.email ?? null}, ${displayName})
    on conflict (issuer, subject) do update
      set email = coalesce(excluded.email, platform.identities.email),
          display_name = coalesce(excluded.display_name, platform.identities.display_name),
          updated_at = case
            when excluded.email is distinct from platform.identities.email
              or excluded.display_name is distinct from platform.identities.display_name
            then now() else platform.identities.updated_at end
    returning id
  `.execute(trx);
  return result.rows[0]!.id;
}

export async function readLinkRow(
  trx: Transaction<DB>,
  identityId: string,
  tenantId: string,
): Promise<LinkRow | null> {
  const result = await sql<LinkRow>`
    select ir.identity_id, i.issuer, i.subject, ir.status, ir.relation_id,
           ir.candidate_relation_id, ir.linked_by, ir.needs_role_assignment, ir.roles,
           coalesce(linked.display_name, candidate.display_name) as display_name,
           coalesce(linked.relation_type, candidate.relation_type) as relation_type
      from platform.identity_relations ir
      join platform.identities i on i.id = ir.identity_id
      left join erp.relations linked
        on linked.id = ir.relation_id and linked.tenant_id = ir.tenant_id
      left join erp.relations candidate
        on candidate.id = ir.candidate_relation_id and candidate.tenant_id = ir.tenant_id
     where ir.identity_id = ${identityId} and ir.tenant_id = ${tenantId}
  `.execute(trx);
  return result.rows[0] ?? null;
}

/** The roles column, bound as jsonb and unpacked: the driver serialises a JS
 * array as JSON for a jsonb parameter but not as a PostgreSQL array literal. */
function rolesArray(roles: readonly string[]) {
  return sql`(
    select coalesce(array_agg(value), '{}'::text[])
      from jsonb_array_elements_text(${[...new Set(roles)].sort()}::jsonb)
  )`;
}

/** Write `roles` for (identity, tenant); the caller's session must pass the column's trigger. */
/** Only a LINKED row may hold roles: a pending confirmation is nobody's yet. Returns whether a row was written. */
export async function writeMembershipRoles(
  trx: Transaction<DB>,
  tenantId: string,
  identityId: string,
  roles: readonly string[],
): Promise<boolean> {
  const result = await sql<{ identity_id: string }>`
    update platform.identity_relations
       set roles = ${rolesArray(roles)},
           needs_role_assignment = false,
           updated_at = now()
     where identity_id = ${identityId}
       and tenant_id = ${tenantId}
       and status = 'linked'
    returning identity_id
  `.execute(trx);
  return result.rows.length > 0;
}

export async function insertLinkRow(
  trx: Transaction<DB>,
  row: {
    identityId: string;
    tenantId: string;
    status: IdentityLinkStatus;
    relationId: string | null;
    candidateRelationId: string | null;
    linkedBy: string | null;
    /** Only on an elevated session: the column's trigger refuses it otherwise. */
    roles?: readonly string[];
  },
): Promise<LinkRow | null> {
  const inserted = await sql<{ identity_id: string }>`
    insert into platform.identity_relations
      (identity_id, tenant_id, status, relation_id, candidate_relation_id, linked_at, linked_by,
       needs_role_assignment, roles)
    values
      (${row.identityId}, ${row.tenantId}, ${row.status}, ${row.relationId},
       ${row.candidateRelationId},
       ${row.status === "linked" ? sql`now()` : null}, ${row.linkedBy},
       false, ${rolesArray(row.roles ?? [])})
    on conflict (identity_id, tenant_id) do nothing
    returning identity_id
  `.execute(trx);
  if (inserted.rows.length === 0) return null;
  return readLinkRow(trx, row.identityId, row.tenantId);
}

export async function relationsWithEmail(
  trx: Transaction<DB>,
  tenantId: string,
  email: string,
): Promise<Array<{ id: string; display_name: string }>> {
  const result = await sql<{ id: string; display_name: string }>`
    select distinct r.id, r.display_name
      from erp.relations r
      join erp.contact_details cd
        on cd.relation_id = r.id and cd.tenant_id = r.tenant_id
     where r.tenant_id = ${tenantId}
       and lower(cd.type) = 'email'
       and lower(cd.value) = lower(${email})
  `.execute(trx);
  return result.rows;
}

export function toState(row: LinkRow, identity: { issuer: string; subject: string }): IdentityLinkState {
  const roles = [...new Set(row.roles ?? [])].sort();
  return {
    identityId: row.identity_id,
    issuer: row.issuer ?? identity.issuer,
    subject: row.subject ?? identity.subject,
    status: row.status,
    relationId: row.relation_id,
    displayName: row.display_name,
    relationType: row.relation_type,
    candidateRelationId: row.candidate_relation_id,
    linkedBy: row.linked_by,
    // A linked member with no roles here — confirmed a candidate, or linked
    // by an administrator, without ever being invited as anything — is
    // waiting for a role exactly as a JIT-created one whose invitation could
    // not be recorded. Derived, so the two cannot disagree.
    needsRoleAssignment:
      row.needs_role_assignment || (row.status === "linked" && roles.length === 0),
    roles,
  };
}


