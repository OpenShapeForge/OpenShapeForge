// SPDX-License-Identifier: BUSL-1.1
/**
 * The link between a login and a party.
 *
 * A bearer token proves an IDENTITY: who, at which identity provider
 * (`iss` + `sub`). What the organization cares about is the PARTY that
 * identity acts as — a Relation of the tenant: the employee, the supplier
 * contact, the customer contact. Which of those the person is, is a
 * RelationRole on that Relation; the link itself says only "this login is
 * that Relation".
 *
 * Identity is platform-level (one Keycloak account signs in to several
 * tenants), the party is per tenant, so the link is per (identity, tenant):
 * platform.identities and platform.identity_relations
 * (db/migrations/identity-link.ts).
 *
 * Three ways a link comes about:
 *
 *   1. Just in time, on the first session in a tenant (`resolveIdentityLink`,
 *      called from identity.ts on the bearer path). If NO Relation in the
 *      tenant carries the token's e-mail, a Relation of type person is created
 *      through the generated CRUD path and linked. If one DOES, nothing is
 *      linked silently: the row is recorded as `pending_confirmation` with the
 *      Relation as candidate, and stays that way until somebody confirms.
 *   2. The person confirms the pending candidate (`confirmPendingLink`, MCP
 *      tool confirm_my_link).
 *   3. An organization administrator links an identity to a Relation
 *      explicitly (`linkIdentityToRelation`, MCP tool link_identity).
 *
 * The result rides on the session as `session.relation`; `sessionRelation()`
 * is the accessor every other surface should read it through.
 *
 * Trusted-context and API key sessions carry no e-mail and are not people
 * signing in, so they never link; the accessor answers null for them.
 */
import { sql, type Transaction } from "kysely";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import type { DB } from "../generated/db/types.js";
import { withDbSession, type DbSessionInput } from "../db/session.js";
import {
  createGeneratedEntityForTable,
  getGeneratedCrudTables,
} from "../graphql/generated-crud.js";
import { HttpError } from "../rest/http-error.js";

export const IDENTITY_LINK_ADMIN_ROLE = "Organization.All.ReadWrite";

/** What the token says about the person. Shaped by `identityClaimsFromToken`. */
export type IdentityClaims = {
  issuer: string;
  subject: string;
  email?: string | undefined;
  name?: string | undefined;
  givenName?: string | undefined;
  familyName?: string | undefined;
  preferredUsername?: string | undefined;
};

export type IdentityLinkStatus = "linked" | "pending_confirmation";

/** The full per-(identity, tenant) state, as carried on the session. */
export type IdentityLinkState = {
  identityId: string;
  issuer: string;
  subject: string;
  status: IdentityLinkStatus;
  /** Set when linked. */
  relationId: string | null;
  /** Display name of the linked Relation (or of the candidate while pending). */
  displayName: string | null;
  /**
   * `relation_type` of the linked Relation (or of the candidate while
   * pending): "person" for a just-in-time link, whatever an administrator
   * linked otherwise. Null when neither exists.
   */
  relationType: string | null;
  /** Set while pending, when the e-mail matched exactly one Relation. */
  candidateRelationId: string | null;
  linkedBy: string | null;
};

/** What a linked session resolves to: the party the login acts as. */
export type SessionRelation = {
  relationId: string;
  displayName: string | null;
};

/**
 * The Relation a session is linked to, or null: not linked yet (pending, or
 * no link), or a session that cannot link at all (trusted-context, API key).
 */
export function sessionRelation(
  session: { relation?: IdentityLinkState | null | undefined } | null | undefined,
): SessionRelation | null {
  const link = session?.relation;
  if (!link || link.status !== "linked" || !link.relationId) return null;
  return { relationId: link.relationId, displayName: link.displayName };
}

/** Flatten the claims a verified token carries about the person. */
export function identityClaimsFromToken(
  claims: Record<string, unknown>,
): IdentityClaims | null {
  const issuer = stringClaim(claims.iss);
  const subject = stringClaim(claims.sub);
  if (!issuer || !subject) return null;
  return {
    issuer,
    subject,
    email: stringClaim(claims.email),
    name: stringClaim(claims.name),
    givenName: stringClaim(claims.given_name),
    familyName: stringClaim(claims.family_name),
    preferredUsername: stringClaim(claims.preferred_username),
  };
}

function stringClaim(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** The person's display name, in the order the token is trusted for it. */
export function displayNameFromClaims(claims: IdentityClaims): string {
  const combined = [claims.givenName, claims.familyName].filter(Boolean).join(" ").trim();
  return claims.name ?? (combined || undefined) ?? claims.preferredUsername ?? claims.subject;
}

/**
 * First/last name for the NaturalPerson row, or null when the token does not
 * say. Both are required on NaturalPerson and neither is guessed: a person
 * with only a username gets a Relation, not a person record with an invented
 * family name.
 */
export function personNameFromClaims(
  claims: IdentityClaims,
): { firstName: string; lastName: string } | null {
  if (claims.givenName && claims.familyName) {
    return { firstName: claims.givenName, lastName: claims.familyName };
  }
  const parts = (claims.name ?? "").split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return { firstName: parts[0]!, lastName: parts.slice(1).join(" ") };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Cache and single-flight
//
// Every request resolves a session, so the link is read once per request
// without this. Linked and pending states are cached briefly; a change made
// through this module invalidates its own key, and a change made by another
// replica shows up within the TTL. Concurrent first requests of one person
// share one in-flight resolution so the just-in-time path creates one
// Relation, not one per parallel request.

const LINK_CACHE_TTL_MS = 60_000;
const linkCache = new Map<string, { state: IdentityLinkState; expiresAtMs: number }>();
const inFlight = new Map<string, Promise<IdentityLinkState | null>>();

function cacheKey(issuer: string, subject: string, tenantId: string): string {
  return `${issuer}\n${subject}\n${tenantId}`;
}

export function invalidateIdentityLink(issuer: string, subject: string, tenantId: string): void {
  linkCache.delete(cacheKey(issuer, subject, tenantId));
}

/** Test-only. */
export function __resetIdentityLinkForTests(): void {
  linkCache.clear();
  inFlight.clear();
}

// ---------------------------------------------------------------------------
// Resolution (just in time)

type SessionInput = DbSessionInput & { tenantId: string; userId: string };

/**
 * The link state for this session's identity in this tenant, creating it
 * just in time on the first session. Never throws: a failure here must not
 * turn a valid token into an unauthenticated request, so it is logged and the
 * session simply carries no link.
 */
export async function resolveIdentityLink(
  db: OpenShapeForgeDatabase,
  session: SessionInput,
  claims: IdentityClaims,
): Promise<IdentityLinkState | null> {
  const key = cacheKey(claims.issuer, claims.subject, session.tenantId);
  const cached = linkCache.get(key);
  if (cached && cached.expiresAtMs > Date.now()) return cached.state;

  const pending = inFlight.get(key);
  if (pending) return pending;

  const work = (async () => {
    try {
      const state = await ensureIdentityLink(db, session, claims);
      if (state) {
        linkCache.set(key, { state, expiresAtMs: Date.now() + LINK_CACHE_TTL_MS });
      }
      return state;
    } catch (error) {
      console.warn(
        "[auth] Resolving the identity ↔ Relation link failed; the session carries no Relation:",
        error instanceof Error ? error.message : String(error),
      );
      return null;
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, work);
  return work;
}

async function ensureIdentityLink(
  db: OpenShapeForgeDatabase,
  session: SessionInput,
  claims: IdentityClaims,
): Promise<IdentityLinkState | null> {
  const displayName = displayNameFromClaims(claims);

  // Phase 1: the identity row, and the link if there is one.
  const found = await withDbSession(db, session, async (trx) => {
    const identityId = await upsertIdentity(trx, claims, displayName);
    const existing = await readLinkRow(trx, identityId, session.tenantId);
    if (existing) return { identityId, state: toState(existing, claims) };

    // No row yet: is there a Relation in this tenant with the token's e-mail?
    const candidates = claims.email
      ? await relationsWithEmail(trx, session.tenantId, claims.email)
      : [];
    if (candidates.length > 0 || !claims.email) {
      // Somebody may already be this Relation — do not decide for them. And
      // without an e-mail there is nothing to match on, so an administrator
      // has to link explicitly; the row exists so they can find the identity.
      const candidate = candidates.length === 1 ? candidates[0]! : null;
      const inserted = await insertLinkRow(trx, {
        identityId,
        tenantId: session.tenantId,
        status: "pending_confirmation",
        relationId: null,
        candidateRelationId: candidate?.id ?? null,
        linkedBy: null,
      });
      const row = inserted ?? (await readLinkRow(trx, identityId, session.tenantId));
      return { identityId, state: row ? toState(row, claims) : null };
    }
    return { identityId, state: null };
  });
  if (found.state) return found.state;

  // Phase 2: nobody carries this e-mail — create the person as a Relation.
  // Through the generated CRUD path (role-ungated variant: this is a runtime
  // surface acting for a person who may hold no Relations role), so the rows
  // get the same defaults, events and projections a REST create would.
  const relationId = await createPersonRelation(db, session, claims, displayName);
  if (!relationId) return null;

  return withDbSession(db, session, async (trx) => {
    const inserted = await insertLinkRow(trx, {
      identityId: found.identityId,
      tenantId: session.tenantId,
      status: "linked",
      relationId,
      candidateRelationId: null,
      linkedBy: "jit",
    });
    if (inserted) {
      console.info(
        `[auth] Linked identity ${found.identityId} (${claims.subject}) to new Relation ` +
          `${relationId} "${displayName}" in tenant ${session.tenantId} (just in time).`,
      );
    }
    // Lost a race with another replica: keep its link, ours stays an ordinary
    // unlinked Relation an administrator can clean up.
    const row = inserted ?? (await readLinkRow(trx, found.identityId, session.tenantId));
    return row ? toState(row, claims) : null;
  });
}

async function createPersonRelation(
  db: OpenShapeForgeDatabase,
  session: SessionInput,
  claims: IdentityClaims,
  displayName: string,
): Promise<string | null> {
  const tables = new Map(getGeneratedCrudTables().map((table) => [table.name, table]));
  const relations = tables.get("erp.relations");
  if (!relations) {
    console.warn("[auth] This deployment has no Relation entity; identities stay unlinked.");
    return null;
  }
  const relation = await createGeneratedEntityForTable(db, session, relations, {
    displayName,
    relationType: "person",
    status: "active",
  });
  const relationId = String(relation.id);

  const persons = tables.get("erp.natural_persons");
  const personName = personNameFromClaims(claims);
  if (persons && personName) {
    await createGeneratedEntityForTable(db, session, persons, {
      ...personName,
      relationId,
    });
  }
  const contactDetails = tables.get("erp.contact_details");
  if (contactDetails && claims.email) {
    await createGeneratedEntityForTable(db, session, contactDetails, {
      relationId,
      type: "email",
      value: claims.email,
      isPrimary: true,
      status: "active",
    });
  }
  return relationId;
}

// ---------------------------------------------------------------------------
// Explicit linking

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
        "No identity with that e-mail has signed in to this organization yet.",
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

    const relation = await sql<{ id: string; display_name: string }>`
      select id, display_name from erp.relations
       where id = ${input.relationId} and tenant_id = ${session.tenantId}
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
// SQL

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type LinkRow = {
  identity_id: string;
  issuer: string;
  subject: string;
  status: IdentityLinkStatus;
  relation_id: string | null;
  candidate_relation_id: string | null;
  linked_by: string | null;
  display_name: string | null;
  relation_type: string | null;
};

async function upsertIdentity(
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

async function readLinkRow(
  trx: Transaction<DB>,
  identityId: string,
  tenantId: string,
): Promise<LinkRow | null> {
  const result = await sql<LinkRow>`
    select ir.identity_id, i.issuer, i.subject, ir.status, ir.relation_id,
           ir.candidate_relation_id, ir.linked_by,
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

async function insertLinkRow(
  trx: Transaction<DB>,
  row: {
    identityId: string;
    tenantId: string;
    status: IdentityLinkStatus;
    relationId: string | null;
    candidateRelationId: string | null;
    linkedBy: string | null;
  },
): Promise<LinkRow | null> {
  const inserted = await sql<{ identity_id: string }>`
    insert into platform.identity_relations
      (identity_id, tenant_id, status, relation_id, candidate_relation_id, linked_at, linked_by)
    values
      (${row.identityId}, ${row.tenantId}, ${row.status}, ${row.relationId},
       ${row.candidateRelationId},
       ${row.status === "linked" ? sql`now()` : null}, ${row.linkedBy})
    on conflict (identity_id, tenant_id) do nothing
    returning identity_id
  `.execute(trx);
  if (inserted.rows.length === 0) return null;
  return readLinkRow(trx, row.identityId, row.tenantId);
}

async function relationsWithEmail(
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

function toState(row: LinkRow, identity: { issuer: string; subject: string }): IdentityLinkState {
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
  };
}
