// SPDX-License-Identifier: BUSL-1.1
/**
 * Routes reachable without an operator session.
 *
 * Same shape and same idiom as `apps/web/src/lib/public-routes.ts`, but the
 * list is short and it is meant to STAY short: this app's whole surface is
 * tenant administration, so anything public here is a way to interact with the
 * control plane without holding `platform-operator`.
 *
 * `/not-authorized` is public in the sense that it needs no operator role —
 * that is exactly who it is for. It renders no control-plane data.
 */
const PUBLIC_PATH_PREFIXES = ["/login", "/not-authorized"] as const;

export function isKnownPublicPath(pathname: string | null | undefined): boolean {
  if (!pathname) {
    return false;
  }

  // The NextAuth handler routes: sign-in start, the OIDC callback, CSRF. The
  // callback in particular MUST be reachable unauthenticated, because it is
  // what turns an unauthenticated visitor into a session in the first place.
  if (pathname.startsWith("/api/auth")) {
    return true;
  }

  return PUBLIC_PATH_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}
