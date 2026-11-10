// SPDX-License-Identifier: BUSL-1.1
import "server-only";

import { redirect } from "next/navigation";
import type { Session } from "next-auth";
import { operatorSessionRedirect } from "./operator-session-policy";
import { getCachedSession } from "@/lib/cached-session";
import { isKnownPublicPath } from "@/lib/public-routes";

/**
 * Route gating for the control plane.
 *
 * `apps/web`'s route-authz answers "which roles does this ENTITY route need",
 * because its routes are compiler-generated per entity and each one carries its
 * own authored authorization. Nothing here is generated and there are no
 * entities, so the question collapses to a single one: does this session hold
 * `platform-operator`? That is the whole adaptation.
 *
 * Two outcomes, deliberately distinct:
 *
 *   - no session at all      → `/login`, carrying the callback URL, because the
 *                              honest response to "who are you" is to ask.
 *   - session, but no role   → `/not-authorized`. NOT an empty shell, and not a
 *                              silent redirect back to login that would loop
 *                              forever against a working identity. The operator
 *                              role is missing and the app says so.
 *
 * In practice the second outcome is nearly unreachable, because the NextAuth
 * `signIn` callback already refuses to mint a session without the role. It is
 * here anyway: a role revoked mid-session, or a future sign-in path that
 * forgets the callback, must fail closed at the page rather than at nothing.
 */

/** A session that has been checked, so pages can stop re-checking. */
export type OperatorSession = Session & { isPlatformOperator: true };

/**
 * Resolve the session for a gated route, or redirect.
 *
 * Returns only on success, so the return type is the proof: a caller holding an
 * `OperatorSession` cannot be looking at an unauthorized request.
 *
 * `redirect()` throws, which is why there is no `else` — anything after a
 * redirect in this function is unreachable by construction.
 */
export async function requireOperatorSession(
  pathname: string = "/",
): Promise<OperatorSession> {
  if (isKnownPublicPath(pathname)) {
    // A programming error rather than a request problem: a public route asked
    // to be gated. Fail loudly instead of redirecting the operator in circles.
    throw new Error(
      `requireOperatorSession called for the public path "${pathname}"; public paths must not be gated.`,
    );
  }

  const session = await getCachedSession();

  const destination = operatorSessionRedirect(session, pathname);
  if (destination) redirect(destination);

  return session as OperatorSession;
}
