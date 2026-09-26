// SPDX-License-Identifier: BUSL-1.1
import { actingRelationId, type ActingRelationSource } from "../db/acting-relation.js";
import { HttpError } from "../rest/http-error.js";

/**
 * The acting Relation a person-owned write is bound to. A session that is
 * not linked to a Relation yet (a pending invitation, a service account)
 * owns nothing personal; it is refused with the corrective step instead of
 * a foreign-key failure further down.
 */
export function requireActingRelationId(session: ActingRelationSource, what: string): string {
  const relationId = actingRelationId(session);
  if (relationId) return relationId;
  throw new HttpError(
    403,
    "FORBIDDEN",
    `${what} belongs to the person you act as, and this sign-in is not linked to a person in this organization yet. ` +
      "Ask an organization administrator to link it (link_identity), then try again.",
  );
}
