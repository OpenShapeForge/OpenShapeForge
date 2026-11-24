// SPDX-License-Identifier: BUSL-1.1
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import { withSessionRelation } from "./identity-link.js";
import { assertSessionAddressesOrganization } from "./organization-address.js";
import type { TrustedSessionContext } from "./trusted-context.js";
import { EMPTY_SESSION, resolveCredentialSession, type ResolveSessionOptions } from "./session-resolver.js";
import { assertMemberAccessActive, memberAccessIsRead } from './member-access-state.js';
import { withRuntimeSpan } from "@openshapeforge/observability";
import { resolveAuthorizationProfileAccess } from "./authorization-profile-session.js";
import { hasAuthorizationProfileAccess } from "./authorization-profile-decision.js";
import { withDbSession } from "../db/session.js";
import { SessionAuthenticationUnavailableError } from "./session-unavailable.js";

// The credential resolution itself — API key, bearer, trusted context — lives
// in ./session-resolver.ts; re-exported so every importer keeps one address.
export { __resetSessionResolverForTests, type ResolveSessionOptions } from "./session-resolver.js";
export { __setIdentityLinkForTests, mergeIdentityRoles, type IdentityLinkForTests } from "./bearer-session.js";

/**
 * Resolves the canonical session context for a request, and refuses it when
 * the request's short address names another organization than the
 * credential's (see {@link assertSessionAddressesOrganization}).
 */
export async function resolveSessionContext(
  headers: Headers,
  options: ResolveSessionOptions = {},
): Promise<TrustedSessionContext> {
  const credential = await withRuntimeSpan("auth.credential", () => resolveCredentialSession(headers, options));
  const session = await withRuntimeSpan("auth.relation", () => withSessionRelation(credential, options));
  return admitResolvedSession(headers, session, options);
}

/**
 * The last steps of every session: the member is not blocked, the request
 * addresses the credential's own organization, and the authorization rules
 * are bound. The member check and the rules are both read on this final
 * session, so they share one transaction — each rejoins it instead of opening
 * its own. Order, refusals and the deliberately uncached reads are unchanged.
 */
export async function admitResolvedSession(
  headers: Headers,
  session: TrustedSessionContext,
  options: ResolveSessionOptions = {},
): Promise<TrustedSessionContext> {
  const admit = async () => {
    await withRuntimeSpan("auth.member", () => assertMemberAccessActive(options.db, session));
    const addressed = await withRuntimeSpan("auth.address", () => assertSessionAddressesOrganization(
      headers,
      session,
      { db: options.db, bound: options.organization !== undefined },
      EMPTY_SESSION,
    ));
    return resolveAuthorizationProfileAccess(addressed, options.db);
  };
  const db = options.db;
  if (!db || !memberAccessIsRead(session) || hasAuthorizationProfileAccess(session)) return admit();
  let entered = false;
  try {
    return await withDbSession(db, session, () => { entered = true; return admit(); });
  } catch (error) {
    // The transaction could not be opened: the member check never ran.
    if (!entered) throw new SessionAuthenticationUnavailableError('Member access could not be verified; try again.');
    throw error;
  }
}
