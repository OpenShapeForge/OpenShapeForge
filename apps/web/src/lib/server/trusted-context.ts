// SPDX-License-Identifier: BUSL-1.1
import "server-only";

import { applyTrustedContextHeaders as applyTrustedContextHeadersCore } from "@openshapeforge/auth";

type TrustedContextSession = {
  tenantId?: string | null;
  sub?: string | null;
  roles?: readonly string[] | null;
  /**
   * Keycloak group paths from the access token. Forwarded so the API can
   * authorize on group membership at the route/GraphQL boundary.
   */
  groups?: readonly string[] | null;
};

function internalContextSecret() {
  return process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET ?? null;
}

export function applyTrustedContextHeaders(
  headers: Headers,
  session: TrustedContextSession,
) {
  applyTrustedContextHeadersCore(
    headers,
    {
      tenantId: session.tenantId ?? null,
      userId: session.sub ?? null,
      roles: [...(session.roles ?? [])],
      groups: [...(session.groups ?? [])],
    },
    { secret: internalContextSecret() },
  );
}
