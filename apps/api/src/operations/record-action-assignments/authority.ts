// SPDX-License-Identifier: BUSL-1.1
/**
 * The ONE authority this whole surface asks for, applied to every half of it.
 *
 * Why reading takes the same authority as writing
 * -----------------------------------------------
 * A listing of "which records has this application been given an action on" is
 * integration-management information, not record information. It names the
 * tenant's integrations, says which of them hold reach into the business data,
 * and does so across every action-capable entity at once. An ordinary
 * organization administrator holds no integration-management right and must
 * not acquire a view of the key estate by asking a record question — so
 * `list`, `get` and `set` all pass through here, and none of them is reachable
 * by holding only an entity's read roles.
 *
 * The two rules, both borrowed rather than invented
 * -------------------------------------------------
 *   1. `Platform.ApiKeys.Manage`, through the existing privilege ceiling of
 *      the provisioning surface (auth/api-key/ceiling.ts). Provisioning the
 *      integration took that role; seeing and changing what it may reach takes
 *      it too. Being a `Platform.*` role it is not one an entity grant can
 *      confer, so an external party cannot acquire it through business access;
 *   2. a verified PERSON, positively. The ceiling already refuses an
 *      `api-key` credential — a credential that can widen its own reach is a
 *      ladder — and the verified principal class must say `person`, so a
 *      bearer service-account token of the same integration cannot take the
 *      route its key is denied and an unclassified carrier cannot either. A
 *      capability grant is refused outright: it is a narrow single-purpose
 *      token and this is not that purpose.
 *
 * This is deliberately NOT a new permission model. Every refusal here is one
 * the delegation Operation (operations/record-action-operations.ts) already
 * raises for the same session; stating it before any record is read means the
 * read half refuses for the same reason the write half would, rather than
 * answering a question it would then decline to act on.
 */
import { operationFailure } from "@openshapeforge/operations";
import { ApiKeyAuthorizationError, assertMayManageApiKeys } from "../../auth/api-key/ceiling.js";
import type { TrustedSessionContext } from "../../auth/trusted-context.js";
import { resolvePrincipalClass } from "../../db/session.js";

function refuse(code: string, message: string, detail?: string): never {
  throw operationFailure({ code, message, retryable: false, ...(detail ? { detail } : {}) });
}

export function assertAssignmentManagerAuthority(session: TrustedSessionContext): void {
  if (!session.tenantId || !session.userId) {
    refuse("UNAUTHENTICATED", "An authenticated tenant session is required.");
  }
  if (session.credential === "grant") {
    refuse(
      "FORBIDDEN",
      "A capability grant cannot manage record action assignments.",
      "A grant carries one purpose; managing an integration's reach is not it.",
    );
  }
  // The carrier, before the roles. The ceiling below refuses an api-key
  // session too, but it reports the refusal as a role one — and the reason
  // here is not the caller's roles: a credential that can widen its own reach
  // is a ladder, however many roles it was issued with. Stated separately so
  // the answer names the rule that actually applied.
  if (session.credential === "api-key") {
    refuse(
      "FORBIDDEN",
      "API keys cannot manage API keys. Use an interactive session.",
      "Which records an integration may act on is part of that integration's " +
        "reach, so an API-key session cannot see or change it however it is " +
        "privileged.",
    );
  }
  // A POSITIVE verdict, not the absence of a machine one. The server either
  // classified this principal as a person or it did not, and "did not" covers
  // a Keycloak service account, a verified token that is neither person nor
  // service account, and an in-mesh bundle from a producer that predates the
  // signed class — all of which an exclusion list would have admitted.
  // Redeploying such a producer to sign the class is how it reaches this
  // surface, not a widening here.
  if (resolvePrincipalClass(session) !== "person") {
    refuse(
      "FORBIDDEN",
      "Only a verified person may manage record action assignments.",
      "An application that holds a record action cannot see or extend the estate of " +
        "actions, to itself or to anyone else, and a session this server could not " +
        "classify as a person is not evidence of one.",
    );
  }
  try {
    // The session's own verified class travels with it: the ceiling decides on
    // the carrier before it decides on a role, so dropping the class would
    // refuse for the wrong reason — or, if the ceiling ever stopped requiring
    // one, admit for no reason at all.
    assertMayManageApiKeys({
      roles: session.roles,
      credential: session.credential,
      ...(session.principalKind ? { principalKind: session.principalKind } : {}),
    });
  } catch (error) {
    if (error instanceof ApiKeyAuthorizationError) {
      refuse(
        "FORBIDDEN",
        "Not authorized to manage record action assignments.",
        "Which records an integration may act on is integration-management " +
          "information: it takes the API key management role, not an entity's " +
          "read or edit permission.",
      );
    }
    throw error;
  }
}
