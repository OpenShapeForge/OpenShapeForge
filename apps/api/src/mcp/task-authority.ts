// SPDX-License-Identifier: BUSL-1.1
import { createHash } from "node:crypto";
import type { TrustedSessionContext } from "../auth/trusted-context.js";

/** Stable authority, never a token, transient session or self-described client name. */
export function taskAuthorityHash(session: TrustedSessionContext): string | undefined {
  if (!session.tenantId || !session.userId || (session.credential === "bearer" && !session.oauthClientId)) return undefined;
  return createHash("sha256").update(JSON.stringify([
    session.issuer ?? null, session.credential, session.oauthClientId ?? null,
    [...new Set(session.oauthScopes ?? [])].sort(), session.appPrincipal?.integrationId ?? null,
  ])).digest("hex");
}
