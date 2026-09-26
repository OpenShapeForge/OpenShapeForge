// SPDX-License-Identifier: BUSL-1.1
/**
 * The Relation a session acts as, as the database sees it.
 *
 * A person-owned record (a personal Connection, a PersonalInstruction, a
 * Task's assignee) references the acting party — `identity.actingParty`,
 * the Relation the login is linked to — never a login or an Account. The
 * session carries that link in one of two shapes: the verified identity
 * link a resolver attached (`relation`, status `linked`), or a bare id a
 * server-side replay recorded (`relationId`: a job running as the person
 * who enqueued it). Neither is ever read from a caller's input.
 *
 * `applyDbSession` writes the answer to the `app.relation_id` GUC, which
 * `app.current_relation_id()` reads for owner-axis row policies; runtime code
 * that writes or filters an owner column asks `actingRelationId` so the value
 * it writes is the one the policy compares against.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ActingRelationSource = {
  relation?: { status?: string | null; relationId?: string | null } | null | undefined;
  relationId?: string | null | undefined;
} | null | undefined;

/** The acting Relation's id, or null when the session is not linked to one. */
export function actingRelationId(session: ActingRelationSource): string | null {
  const link = session?.relation;
  if (link && link.status === "linked" && typeof link.relationId === "string" && UUID.test(link.relationId)) {
    return link.relationId;
  }
  const replayed = session?.relationId;
  return typeof replayed === "string" && UUID.test(replayed) ? replayed : null;
}

/** Whether an owner column's value is the session's acting Relation; never true for an unlinked session. */
export function ownedByActingRelation(owner: unknown, session: ActingRelationSource): boolean {
  const relationId = actingRelationId(session);
  return relationId !== null && owner === relationId;
}
