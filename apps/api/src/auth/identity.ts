// SPDX-License-Identifier: BUSL-1.1
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import { withSessionRelation } from "./identity-link.js";
import { assertSessionAddressesOrganization } from "./organization-address.js";
import type { TrustedSessionContext } from "./trusted-context.js";
import { EMPTY_SESSION, resolveCredentialSession, type ResolveSessionOptions } from "./session-resolver.js";

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
  const session = await withSessionRelation(await resolveCredentialSession(headers, options), options);
  return assertSessionAddressesOrganization(
    headers,
    session,
    { db: options.db, bound: options.organization !== undefined },
    EMPTY_SESSION,
  );
}
