// SPDX-License-Identifier: BUSL-1.1
/**
 * The explicit half of the identity ↔ Relation link (see ./identity-link.ts
 * for the just-in-time half and the model): the person confirming a
 * candidate, and the organization administrator's tools — linking a login to
 * a Relation, listing members who hold no roles here yet, and recording a
 * member's roles for this tenant (`set_member_role`).
 */
import { sql } from "kysely";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import { UUID_PATTERN } from "../db/session.js";
import { withDbSession } from "../db/session.js";
import { HttpError } from "../rest/http-error.js";
import { actingPartyColumns, actingPartyTable } from "./identity-contract.js";
import {
  invalidateIdentityLink,
  readLinkRow,
  toState,
  writeMembershipRoles,
  type IdentityLinkState,
  type SessionInput,
} from "./identity-link.js";
import { IDENTITY_LINK_ADMIN_ROLE } from "./organization-roles.js";


/**
 * The person confirms the candidate the just-in-time path recorded for them.
 * Only ever links the SESSION's own identity, and only to its recorded
 * candidate — there is no argument to point it elsewhere.
 */
export async function confirmPendingLink(
  db: OpenShapeForgeDatabase,
  session: SessionInput & { relation?: IdentityLinkState | null | undefined },
): Promise<IdentityLinkState> {
  const current = session.relation;
  if (!current) {
    throw new HttpError(
      409,
      "NO_IDENTITY_LINK",
      "This session carries no identity to confirm; sign in with a bearer token.",
    );
  }
  if (current.status === "linked") {
    throw new HttpError(409, "ALREADY_LINKED", "You are already linked to a Relation.");
  }
  if (!current.candidateRelationId) {
    throw new HttpError(
      409,
      "NO_CANDIDATE",
      "There is no candidate Relation to confirm; ask an organization administrator to link you.",
    );
  }
  const state = await withDbSession(db, session, async (trx) => {
    const row = await readLinkRow(trx, current.identityId, session.tenantId);
    if (!row || row.status !== "pending_confirmation" || !row.candidate_relation_id) {
      throw new HttpError(409, "NO_CANDIDATE", "There is no pending candidate to confirm any more.");
    }
    await sql`
      update platform.identity_relations
         set status = 'linked',
             relation_id = ${row.candidate_relation_id},
             candidate_relation_id = null,
             linked_at = now(),
             linked_by = ${current.identityId},
             updated_at = now()
       where identity_id = ${current.identityId}
         and tenant_id = ${session.tenantId}
    `.execute(trx);
    const updated = await readLinkRow(trx, current.identityId, session.tenantId);
    if (!updated) throw new HttpError(500, "INTERNAL", "The link vanished while confirming it.");
    return toState(updated, current);
  });
  console.info(
    `[auth] Identity ${state.identityId} confirmed its link to Relation ${state.relationId} ` +
      `in tenant ${session.tenantId}.`,
  );
  invalidateIdentityLink(state.issuer, state.subject, session.tenantId);
  session.relation = state;
  return state;
}

export type LinkIdentityInput = {
  /** E-mail of the identity to link (as its identity provider reports it). */
  identityEmail?: string | undefined;
  /** Or the identity id, e.g. from a pending row. */
  identityId?: string | undefined;
  relationId: string;
};

/**
 * An organization administrator links an identity to a Relation of the
 * tenant. The identity must be known here — it has signed in to this tenant
 * before (linked or pending) — which is also what the RLS on
 * platform.identities lets the administrator see. Re-linking an already
 * linked identity is allowed: the previous Relation is left as it is.
 */
export async function linkIdentityToRelation(
  db: OpenShapeForgeDatabase,
  session: SessionInput & { relation?: IdentityLinkState | null | undefined },
  input: LinkIdentityInput,
): Promise<IdentityLinkState> {
  if (!(session.roles ?? []).includes(IDENTITY_LINK_ADMIN_ROLE)) {
    throw new HttpError(
      403,
      "FORBIDDEN",
      `Linking identities requires the ${IDENTITY_LINK_ADMIN_ROLE} role.`,
    );
  }
  const actor = session.relation?.identityId ?? session.userId;
  const email = input.identityEmail?.trim();
  if (!email && !input.identityId) {
    throw new HttpError(400, "VALIDATION", "Give identityEmail or identityId.");
  }
  if (!UUID_PATTERN.test(input.relationId)) {
    throw new HttpError(400, "VALIDATION", "relationId must be a UUID.");
  }
  if (input.identityId && !UUID_PATTERN.test(input.identityId)) {
    throw new HttpError(400, "VALIDATION", "identityId must be a UUID.");
  }

  const state = await withDbSession(db, session, async (trx) => {
    const identities = await sql<{
      id: string;
      issuer: string;
      subject: string;
      email: string | null;
      display_name: string | null;
    }>`
      select i.id, i.issuer, i.subject, i.email, i.display_name
        from platform.identities i
       where ${
         input.identityId
           ? sql`i.id = ${input.identityId}`
           : sql`lower(i.email) = lower(${email ?? ""})`
       }
         and exists (
           select 1 from platform.identity_relations ir
            where ir.identity_id = i.id and ir.tenant_id = ${session.tenantId}
         )
       order by i.created_at
    `.execute(trx);
    if (identities.rows.length === 0) {
      throw new HttpError(
        404,
        "IDENTITY_NOT_FOUND",
        input.identityId
          ? "No identity with that id has a record in this organization; list_pending_members names the ones that do."
          : "No identity with that e-mail has signed in to this organization yet; an identity without an e-mail (an integration, a web-only login) is linked by its identityId from list_pending_members.",
      );
    }
    if (identities.rows.length > 1) {
      throw new HttpError(
        409,
        "IDENTITY_AMBIGUOUS",
        "Several identities carry that e-mail; pass identityId instead.",
      );
    }
    const identity = identities.rows[0]!;

    const party = actingPartyColumns();
    const relation = await sql<{ id: string; display_name: string }>`
      select ${sql.id(party.id)} as id, ${sql.id(party.name)} as display_name
        from ${sql.table(actingPartyTable())}
       where ${sql.id(party.id)} = ${input.relationId}
         and ${sql.id(party.tenantId)} = ${session.tenantId}
    `.execute(trx);
    if (relation.rows.length === 0) {
      throw new HttpError(404, "RELATION_NOT_FOUND", "No such Relation in this organization.");
    }

    await sql`
      insert into platform.identity_relations
        (identity_id, tenant_id, status, relation_id, candidate_relation_id, linked_at, linked_by)
      values
        (${identity.id}, ${session.tenantId}, 'linked', ${input.relationId}, null, now(), ${actor})
      on conflict (identity_id, tenant_id) do update
        set status = 'linked',
            relation_id = excluded.relation_id,
            candidate_relation_id = null,
            linked_at = now(),
            linked_by = excluded.linked_by,
            updated_at = now()
    `.execute(trx);
    const row = await readLinkRow(trx, identity.id, session.tenantId);
    if (!row) throw new HttpError(500, "INTERNAL", "The link vanished while writing it.");
    return toState(row, { issuer: identity.issuer, subject: identity.subject });
  });
  console.info(
    `[auth] ${actor} linked identity ${state.identityId} to Relation ${state.relationId} ` +
      `in tenant ${session.tenantId}.`,
  );
  invalidateIdentityLink(state.issuer, state.subject, session.tenantId);
  if (session.relation?.identityId === state.identityId) session.relation = state;
  return state;
}


// ---------------------------------------------------------------------------
// Org-admin: pending role assignment

export type PendingRoleAssignment = {
  identityId: string;
  relationId: string;
  displayName: string | null;
  email: string | null;
  /** When this identity first signed in and got JIT-linked (linked_at). */
  firstSignInAt: string;
};

/**
 * An identity this organization has recorded but not linked: a person whose
 * web session made the row before any bearer login named their e-mail, or an
 * integration's service account, which has no e-mail at all. Named by its
 * identity id, which is what `link_identity` takes for it.
 */
export type UnlinkedIdentity = {
  identityId: string;
  displayName: string | null;
  email: string | null;
  candidateRelationId: string | null;
};

export async function listUnlinkedIdentities(
  db: OpenShapeForgeDatabase,
  session: SessionInput,
): Promise<UnlinkedIdentity[]> {
  if (!(session.roles ?? []).includes(IDENTITY_LINK_ADMIN_ROLE)) {
    throw new HttpError(
      403,
      "FORBIDDEN",
      `Listing pending members requires the ${IDENTITY_LINK_ADMIN_ROLE} role.`,
    );
  }
  return withDbSession(db, session, async (trx) => {
    const result = await sql<{ identity_id: string; display_name: string | null; email: string | null; candidate_relation_id: string | null }>`
      select ir.identity_id, i.display_name, i.email, ir.candidate_relation_id
        from platform.identity_relations ir
        join platform.identities i on i.id = ir.identity_id
       where ir.tenant_id = ${session.tenantId}
         and ir.status = 'pending_confirmation'
       order by i.created_at asc
    `.execute(trx);
    return result.rows.map((row) => ({
      identityId: row.identity_id,
      displayName: row.display_name,
      email: row.email,
      candidateRelationId: row.candidate_relation_id,
    }));
  });
}

/**
 * Identities in this tenant awaiting a real role — `list_pending_members`:
 * linked here, but holding no roles here (see `toState`). Gated the same way
 * `linkIdentityToRelation` is: the caller must hold
 * Organization.All.ReadWrite. Ordered oldest first, so the longest-waiting
 * new hire surfaces first.
 */
export async function listPendingRoleAssignments(
  db: OpenShapeForgeDatabase,
  session: SessionInput,
): Promise<PendingRoleAssignment[]> {
  if (!(session.roles ?? []).includes(IDENTITY_LINK_ADMIN_ROLE)) {
    throw new HttpError(
      403,
      "FORBIDDEN",
      `Listing pending members requires the ${IDENTITY_LINK_ADMIN_ROLE} role.`,
    );
  }
  return withDbSession(db, session, async (trx) => {
    const party = actingPartyColumns();
    const result = await sql<{
      identity_id: string;
      relation_id: string;
      display_name: string | null;
      email: string | null;
      linked_at: string;
    }>`
      select ir.identity_id, ir.relation_id, r.${sql.id(party.name)} as display_name,
             i.email, ir.linked_at
        from platform.identity_relations ir
        join platform.identities i on i.id = ir.identity_id
        join ${sql.table(actingPartyTable())} r
          on r.${sql.id(party.id)} = ir.relation_id
         and r.${sql.id(party.tenantId)} = ir.tenant_id
       where ir.tenant_id = ${session.tenantId}
         and (ir.needs_role_assignment or cardinality(ir.roles) = 0)
         and ir.status = 'linked'
       order by ir.linked_at asc
    `.execute(trx);
    return result.rows.map((row) => ({
      identityId: row.identity_id,
      relationId: row.relation_id,
      displayName: row.display_name,
      email: row.email,
      firstSignInAt: row.linked_at,
    }));
  });
}

/**
 * `set_member_role`: record the roles an identity holds in THIS tenant and
 * clear `needs_role_assignment`. Replaces the whole set rather than adding to
 * it, so demoting an administrator to an employee is the same call as the
 * promotion. Gated on `IDENTITY_LINK_ADMIN_ROLE` here and again by the
 * trigger on the column, which refuses the write from any session without
 * that role in `app.roles`. Scoped to this tenant by RLS; the identity must
 * already have a row here (it signed in, or was linked by an administrator).
 *
 * Takes effect on the person's next request on this replica: the cache entry
 * is invalidated below, and other replicas pick it up within
 * LINK_CACHE_TTL_MS. No sign-out is needed — the token never carried these.
 */
export async function setMembershipRoles(
  db: OpenShapeForgeDatabase,
  session: SessionInput,
  identityId: string,
  roles: readonly string[],
): Promise<IdentityLinkState> {
  if (!(session.roles ?? []).includes(IDENTITY_LINK_ADMIN_ROLE)) {
    throw new HttpError(
      403,
      "FORBIDDEN",
      `Assigning roles requires the ${IDENTITY_LINK_ADMIN_ROLE} role.`,
    );
  }
  const state = await withDbSession(db, session, async (trx) => {
    const written = await writeMembershipRoles(trx, session.tenantId, identityId, roles);
    if (!written) {
      // No linked row for this identity here: unknown, or still pending
      // confirmation — roles on an unconfirmed link would be honoured the
      // moment the person confirms, for a Relation nobody verified is theirs.
      throw new HttpError(
        409,
        "IDENTITY_NOT_LINKED",
        "That identity is not linked to a Relation in this organization; link it first (link_identity or confirm_my_link).",
      );
    }
    const row = await readLinkRow(trx, identityId, session.tenantId);
    if (!row) throw new HttpError(500, "INTERNAL", "The link vanished while writing its roles.");
    return toState(row, { issuer: row.issuer, subject: row.subject });
  });
  invalidateIdentityLink(state.issuer, state.subject, session.tenantId);
  return state;
}

/** Resolve a relationId to its linked identityId in this tenant, for `set_member_role`. */
export async function identityIdForRelation(
  db: OpenShapeForgeDatabase,
  session: SessionInput,
  relationId: string,
): Promise<string | null> {
  return withDbSession(db, session, async (trx) => {
    // Several identities may be linked to one Relation (a re-link keeps the
    // old one); the most recently linked is the one an administrator means.
    const result = await sql<{ identity_id: string }>`
      select identity_id from platform.identity_relations
       where tenant_id = ${session.tenantId} and relation_id = ${relationId} and status = 'linked'
       order by linked_at desc nulls last, identity_id
       limit 1
    `.execute(trx);
    return result.rows[0]?.identity_id ?? null;
  });
}

