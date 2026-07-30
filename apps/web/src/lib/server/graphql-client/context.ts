// SPDX-License-Identifier: BUSL-1.1
import "server-only";

import { getCachedSession } from "@/lib/cached-session";
import { expandRolesWithRealmComposites } from "@/lib/server/compiler-authz";
import { applyTraceHeaders, readTraceContext } from "@/lib/server/trace-context";
import { applyTrustedContextHeaders } from "@/lib/server/trusted-context";
import { GraphqlProxyError } from "./errors";

function readBooleanEnv(value: string | undefined): boolean {
  return value === "1" || value === "true";
}

function shouldForwardGraphqlAccessToken(): boolean {
  const configured =
    process.env.OPENSHAPEFORGE_GRAPHQL_FORWARD_ACCESS_TOKEN ??
    process.env.GRAPHQL_FORWARD_ACCESS_TOKEN;

  if (configured == null) {
    return false;
  }

  return readBooleanEnv(configured);
}

function hasTrustedContextSecret(): boolean {
  return Boolean(process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET?.trim());
}

function isExpiredTimestamp(value: unknown, nowS: number): boolean {
  return typeof value === "number" && Number.isFinite(value) && value <= nowS;
}

function readDevSessionFallback(
  name: "OPENSHAPEFORGE_DEV_TENANT_ID" | "OPENSHAPEFORGE_DEV_USER_ID" | "OPENSHAPEFORGE_DEV_USER_ROLES",
): string | undefined {
  const usesTrustedLocalContext =
    shouldForwardGraphqlAccessToken() === false &&
    hasTrustedContextSecret();

  if (!usesTrustedLocalContext) {
    return undefined;
  }

  const value = (
    name === "OPENSHAPEFORGE_DEV_TENANT_ID"
      ? process.env.OPENSHAPEFORGE_DEV_TENANT_ID
      : name === "OPENSHAPEFORGE_DEV_USER_ID"
        ? process.env.OPENSHAPEFORGE_DEV_USER_ID
        : process.env.OPENSHAPEFORGE_DEV_USER_ROLES
  )?.trim();
  return value ? value : undefined;
}

function readDevSessionFallbackRoles(): string[] {
  return (
    readDevSessionFallback("OPENSHAPEFORGE_DEV_USER_ROLES")
      ?.split(",")
      .map((role) => role.trim())
      .filter(Boolean) ?? []
  );
}

function resolveGraphqlHeaderRoles(sessionRoles: readonly string[] | undefined): string[] {
  return expandRolesWithRealmComposites([
    ...(sessionRoles ?? []),
    ...readDevSessionFallbackRoles(),
  ]);
}

function isUuid(value: string | undefined): value is string {
  return Boolean(
    value &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        value,
      ),
  );
}

// Per-slug UUID overrides for local dev (trusted-context mode only). The
// fallback UUIDs must match what's in the DB (e.g. synthetic seed or manual
// inserts). Override via OPENSHAPEFORGE_DEV_TENANT_ID_<SLUG> env vars.
const DEV_TENANT_SLUG_UUIDS: Record<string, string | undefined> = {
  acme:
    process.env.OPENSHAPEFORGE_DEV_TENANT_ID ??
    "11111111-1111-4111-8111-111111111111",
  beta:
    process.env.OPENSHAPEFORGE_DEV_TENANT_ID_BETA ??
    "33333333-3333-4333-8333-333333333333",
};

function resolveTenantHeaderValue(sessionTenantId: string | undefined): string | undefined {
  if (isUuid(sessionTenantId)) {
    return sessionTenantId;
  }

  const usesTrustedLocalContext =
    !shouldForwardGraphqlAccessToken() && hasTrustedContextSecret();
  if (usesTrustedLocalContext && sessionTenantId) {
    const slugUuid = DEV_TENANT_SLUG_UUIDS[sessionTenantId];
    if (slugUuid && isUuid(slugUuid)) {
      return slugUuid;
    }
  }

  const fallbackTenantId = readDevSessionFallback("OPENSHAPEFORGE_DEV_TENANT_ID");
  if (fallbackTenantId) {
    return fallbackTenantId;
  }

  return sessionTenantId;
}

function resolveUserHeaderValue(sessionUserId: string | undefined): string | undefined {
  const fallbackUserId = readDevSessionFallback("OPENSHAPEFORGE_DEV_USER_ID");

  if (fallbackUserId) {
    return fallbackUserId;
  }

  if (isUuid(sessionUserId)) {
    return sessionUserId;
  }

  return sessionUserId;
}

export async function buildGraphqlGatewayRequestContext(input?: {
  accept?: string;
  contentType?: string | null;
  traceHeaders?: Headers;
}) {
  const session = await getCachedSession();
  if (!session) {
    throw new GraphqlProxyError("Not authenticated for GraphQL access.", 401);
  }

  const headers = new Headers();
  headers.set("Accept", input?.accept ?? "application/json");
  if (input?.contentType !== null) {
    headers.set("Content-Type", input?.contentType ?? "application/json");
  }
  applyTraceHeaders(headers, readTraceContext(input?.traceHeaders));

  const tenantId = resolveTenantHeaderValue(session.tenantId);
  const userId = resolveUserHeaderValue(session.sub);
  const roles = resolveGraphqlHeaderRoles(
    Array.isArray(session.roles) ? session.roles : undefined,
  );
  const nowS = Math.floor(Date.now() / 1000);
  if (
    isExpiredTimestamp(session.expiresAt, nowS) ||
    isExpiredTimestamp(session.refreshExpiresAt, nowS)
  ) {
    throw new GraphqlProxyError("Not authenticated for GraphQL access.", 401);
  }

  applyTrustedContextHeaders(headers, {
    ...session,
    tenantId,
    sub: userId,
    roles,
  });

  const shouldForwardToken = shouldForwardGraphqlAccessToken();
  if (!shouldForwardToken && !hasTrustedContextSecret()) {
    throw new GraphqlProxyError("GraphQL trusted context is not configured.", 500);
  }
  if (
    !shouldForwardToken &&
    (!headers.get("x-tenant-id") ||
      !headers.get("x-user-id") ||
      !headers.get("x-openshapeforge-context-signature"))
  ) {
    throw new GraphqlProxyError("GraphQL trusted context is incomplete.", 500);
  }

  if (shouldForwardToken) {
    if (!session.accessToken) {
      throw new GraphqlProxyError("Not authenticated for GraphQL access.", 401);
    }
    headers.set("Authorization", `Bearer ${session.accessToken}`);
  }

  return { headers, session };
}
