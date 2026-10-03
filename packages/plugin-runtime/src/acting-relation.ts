// SPDX-License-Identifier: BUSL-1.1
/**
 * The Relation a session acts as, as the database sees it — one definition for
 * the host and its plugins (the host's apps/api/src/db/acting-relation.ts
 * re-exports it).
 *
 * A person-owned record (a personal Connection, a PersonalInstruction, a
 * Task's assignee) and a plugin-written "…door" field (a quote's
 * "Aangemaakt door", a proposal's "Gepubliceerd door", #937) reference the
 * acting party — the Relation the login is linked to — never a login or an
 * Account. The session carries that link in one of two shapes: the verified
 * identity link a resolver attached (`relation`, status `linked`), or a bare
 * id a server-side replay recorded (`relationId`: a job running as the person
 * who enqueued it). Neither is ever read from a caller's input.
 *
 * `applyDbSession` writes the answer to the `app.relation_id` GUC, which
 * `app.current_relation_id()` reads for owner-axis row policies; runtime code
 * that writes or filters an owner column asks `actingRelationId` so the value
 * it writes is the one the policy compares against.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ActingRelationSource = {
  /** A plugin sees this as `unknown` (PluginSessionContext.relation); it is narrowed here. */
  relation?: unknown;
  relationId?: string | null | undefined;
} | null | undefined;

/** The acting Relation's id, or null when the session is not linked to one. */
export function actingRelationId(session: ActingRelationSource): string | null {
  const link = session?.relation;
  if (link && typeof link === "object") {
    const { status, relationId } = link as { status?: unknown; relationId?: unknown };
    if (status === "linked" && typeof relationId === "string" && UUID.test(relationId)) return relationId;
  }
  const replayed = session?.relationId;
  return typeof replayed === "string" && UUID.test(replayed) ? replayed : null;
}

/** Whether an owner column's value is the session's acting Relation; never true for an unlinked session. */
export function ownedByActingRelation(owner: unknown, session: ActingRelationSource): boolean {
  const relationId = actingRelationId(session);
  return relationId !== null && owner === relationId;
}
