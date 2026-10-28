// SPDX-License-Identifier: BUSL-1.1
/**
 * What this tier can HONESTLY say about the principal behind a hop.
 *
 * Deliberately its own module, free of `server-only` and of any session
 * machinery: this is the rule, and a rule the API refuses credential
 * management on deserves to be readable and testable on its own. The hop
 * that signs it lives in `./trusted-context.ts`.
 */
import type { TrustedPrincipalKind } from "@openshapeforge/auth";

/** The fields of a session this rule is allowed to look at. */
export type PrincipalKindSession = {
  sub?: string | null;
  /**
   * The OIDC id token of the login this session was established by. Read for
   * one thing only — see {@link principalKindOf} — and never forwarded.
   */
  idToken?: string | null;
};

/**
 * The principal class to sign into a trusted-context bundle, or none.
 *
 * The API refuses some surfaces to anything it cannot show to be a human
 * (API key management is the one today), and the bundle's principal class is
 * how that verdict crosses the hop. Asserting it is therefore a claim about
 * how this tier authenticated, not a label it may attach for convenience.
 *
 * "person" rests on one property: the session carries the id token of an
 * OIDC authorization-code login, for a subject. That artifact is minted for
 * an authenticated end user and never by a client-credentials grant, so a
 * machine principal cannot produce a session that satisfies it. Anything
 * else — a session without one, a server-side probe, any token-less internal
 * call — asserts NOTHING, and the API reads that as a principal it may not
 * treat as human.
 */
export function principalKindOf(
  session: PrincipalKindSession,
): TrustedPrincipalKind | undefined {
  return session.idToken && session.sub ? "person" : undefined;
}
