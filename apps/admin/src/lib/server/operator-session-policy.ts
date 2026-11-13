// SPDX-License-Identifier: BUSL-1.1
/** Never infer missing operator rights from a temporarily unhydrated session. */
export function operatorSessionRedirect(
  session: { error?: string; isPlatformOperator?: boolean } | null | undefined,
  pathname: string,
): string | null {
  const callback = pathname.startsWith("/") && !pathname.startsWith("//") && !pathname.includes("://") ? pathname : "/";
  const login = `/login?callbackUrl=${encodeURIComponent(callback)}`;
  if (!session) return login;
  if (session.error === "RefreshTokenUnavailable") return `${login}&reason=session_unavailable`;
  if (session.error === "RefreshTokenError") return `${login}&reason=session_expired`;
  return session.isPlatformOperator ? null : "/not-authorized";
}
