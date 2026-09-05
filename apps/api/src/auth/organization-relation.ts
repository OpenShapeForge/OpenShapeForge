// SPDX-License-Identifier: BUSL-1.1
/**
 * The tenant ↔ organization-Relation link (`platform.tenants.relation_id`,
 * db/migrations/organization-relation-link.ts): which Relation of this
 * tenant IS the organization itself, so an assistant can read its
 * `businessContext` ("what does this company do") through
 * `osf://organization/profile` (mcp/organization-profile-tools.ts) instead of
 * a human re-explaining it in every conversation.
 *
 * Deliberately separate from auth/identity-link.ts: that module links a LOGIN
 * to the Relation a PERSON acts as; this one links the TENANT itself to the
 * Relation that represents the organization as a whole. Both are one-Relation
 * pointers gated the same way (`Organization.All.ReadWrite`,
 * `IDENTITY_LINK_ADMIN_ROLE` — reused here rather than duplicated under a new
 * name, since it is the same role and the same reasoning: an organization
 * administrator, not an ordinary member, decides what the assistant is told
 * this company is).
 */
import { sql } from "kysely";
import { IDENTITY_LINK_ADMIN_ROLE } from "./identity-link.js";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import { withDbSession, type DbSessionInput } from "../db/session.js";
import { HttpError } from "../rest/http-error.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type SessionInput = DbSessionInput & { tenantId: string; userId: string };

export type OrganizationProfile =
  | { configured: false; message: string }
  | { configured: true; relationId: string; name: string; businessContext: string | null };

/**
 * An organization administrator points the tenant at the Relation that IS
 * this organization. Refuses a Relation from another tenant (RLS already
 * fences the read, this is the same defence-in-depth `linkIdentityToRelation`
 * uses) and a Relation whose `relationType` is not `organization` — pointing
 * this at a person or a supplier would make `osf://organization/profile`
 * answer a question nobody asked.
 */
export async function setOrganizationRelation(
  db: OpenShapeForgeDatabase,
  session: SessionInput,
  relationId: string,
): Promise<{ relationId: string; name: string }> {
  if (!(session.roles ?? []).includes(IDENTITY_LINK_ADMIN_ROLE)) {
    throw new HttpError(
      403,
      "FORBIDDEN",
      `Setting the organization Relation requires the ${IDENTITY_LINK_ADMIN_ROLE} role.`,
    );
  }
  if (!UUID_PATTERN.test(relationId)) {
    throw new HttpError(400, "VALIDATION", "relationId must be a UUID.");
  }

  return withDbSession(db, session, async (trx) => {
    const relation = await sql<{ id: string; display_name: string; relation_type: string }>`
      select id, display_name, relation_type
        from erp.relations
       where id = ${relationId} and tenant_id = ${session.tenantId}
    `.execute(trx);
    if (relation.rows.length === 0) {
      throw new HttpError(404, "RELATION_NOT_FOUND", "No such Relation in this organization.");
    }
    const found = relation.rows[0]!;
    if (found.relation_type !== "organization") {
      throw new HttpError(
        422,
        "NOT_AN_ORGANIZATION",
        `Relation ${found.id} has relationType "${found.relation_type}", not "organization".`,
      );
    }

    const updated = await sql<{ id: string }>`
      update platform.tenants
         set relation_id = ${found.id}, updated_at = now()
       where id = ${session.tenantId}
      returning id
    `.execute(trx);
    if (updated.rows.length === 0) {
      throw new HttpError(500, "INTERNAL", "The tenant row vanished while linking it.");
    }
    return { relationId: found.id, name: found.display_name };
  });
}

/**
 * `osf://organization/profile`'s answer: the organization Relation's name and
 * `businessContext`, or a helpful "not configured" message when
 * `platform.tenants.relation_id` is unset — never an error, so a fresh tenant
 * with nothing configured yet still resolves the resource.
 */
export async function getOrganizationProfile(
  db: OpenShapeForgeDatabase,
  session: SessionInput,
): Promise<OrganizationProfile> {
  return withDbSession(db, session, async (trx) => {
    const tenant = await sql<{ relation_id: string | null }>`
      select relation_id from platform.tenants where id = ${session.tenantId}
    `.execute(trx);
    const relationId = tenant.rows[0]?.relation_id ?? null;
    if (!relationId) {
      return {
        configured: false,
        message:
          "No organization Relation is configured yet. An organization administrator can run " +
          "set_organization_relation with the id of the Relation (relationType: organization) " +
          "that represents this company.",
      };
    }

    const relation = await sql<{ display_name: string; business_context: string | null }>`
      select display_name, business_context
        from erp.relations
       where id = ${relationId} and tenant_id = ${session.tenantId}
    `.execute(trx);
    const found = relation.rows[0];
    if (!found) {
      // The linked Relation was deleted out from under the link (FK is
      // ON DELETE SET NULL, so this is a narrow race, not the steady state).
      return {
        configured: false,
        message:
          "The configured organization Relation no longer exists. An organization administrator " +
          "can run set_organization_relation again with a current Relation's id.",
      };
    }
    return {
      configured: true,
      relationId,
      name: found.display_name,
      businessContext: found.business_context,
    };
  });
}
