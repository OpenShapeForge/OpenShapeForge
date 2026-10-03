// SPDX-License-Identifier: BUSL-1.1
/**
 * The control-realm session for the canonical operations runtime.
 *
 * `authorization.ts` admits one platform role: `platform-operator`. An
 * admitted party may arrive through the pinned REST client, the MCP party
 * allow-list or the MCP resource audience. The operations runtime still
 * enforces each Operation's declared role, so every control declaration names
 * the same role. This resolver is the ONLY place a
 * `credential: "control-bearer"` session is minted.
 *
 * The preconditions are the union of the two existing surfaces, not a
 * relaxation of either:
 *
 *   1. the bearer verifies against the CONTROL realm (`verifyControlBearer`);
 *   2. it was minted for an admitted party — the operator client the REST
 *      control plane pins, any party on the platform MCP allow-list, or a
 *      token whose `aud` names the resource being called (RFC 8707, the
 *      device a self-registered MCP client uses because no allow-list can
 *      name a client id minted at registration time);
 *   3. it carries a subject and at least one control-realm marker role, so a
 *      realm member with no platform authority is refused with FORBIDDEN
 *      before any Operation is looked at — the same answer the old doors gave.
 *
 * What it carries: every realm role the token holds. The Operation's own
 * `auth.roles` is the authorization decision. Client roles
 * (`resource_access`) never count, for the reason `realmRolesOf` gives.
 */
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import { usesHostOrganizationContext } from "../config/host-organization.js";
import { HttpError } from "../rest/http-error.js";
import {
  ControlAuthorizationError,
  PLATFORM_OPERATOR_ROLE,
  realmRolesOf,
  type ResolveOperatorOptions,
  verifyControlBearer,
} from "./authorization.js";
import { platformMcpAuthorizedParties, type ControlPlaneConfig } from "./config.js";
import type { PlatformAdministrator } from "./platform-admin.js";
import { assertHostRealm, hasKeycloakRealmAdmin } from "./realm-boundary.js";

/**
 * The only realm role that means "may use the control plane at all".
 */
export const CONTROL_REALM_ROLES: readonly string[] = [PLATFORM_OPERATOR_ROLE];

/** A control session as a handler sees it: the administrator is guaranteed. */
export type ControlSessionContext = TrustedSessionContext & {
  credential: "control-bearer";
  administrator: PlatformAdministrator;
};

export type ControlSessionOptions = ResolveOperatorOptions & {
  /**
   * The canonical URL of the resource being called, so a token bound to it
   * by `aud` is admitted on that binding. Absent means only the party
   * allow-list applies — what the REST control routes want.
   */
  resource?: string | undefined;
};

/** The `azp` values admitted: the pinned operator client plus the MCP allow-list. */
export function controlAdmittedParties(config: ControlPlaneConfig): readonly string[] {
  return [...new Set([config.operator.clientId, ...platformMcpAuthorizedParties(config)])];
}

function audienceList(aud: unknown): string[] {
  if (typeof aud === "string") return [aud];
  if (Array.isArray(aud)) return aud.filter((v): v is string => typeof v === "string");
  return [];
}

function stringClaim(claims: Record<string, unknown>, key: string): string | null {
  const value = claims[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function isControlSession(
  session: TrustedSessionContext | undefined,
): session is ControlSessionContext {
  return session?.credential === "control-bearer" && session.administrator !== undefined;
}

/**
 * Build the session for an already verified administrator. Exported for the
 * transports that carry the administrator separately (tests included); the
 * resolver below is the only production caller.
 */
export function controlSessionFor(
  administrator: PlatformAdministrator,
  roles: readonly string[],
): ControlSessionContext {
  return {
    tenantId: null,
    userId: administrator.subject,
    roles: [...roles],
    groups: [],
    relationGroupIds: [],
    scope: "self",
    credential: "control-bearer",
    administrator,
  };
}

/**
 * Authenticate the caller as a control-realm operator and say which realm
 * roles they hold. A refusal is UNAUTHENTICATED for anything short of a
 * verified control-realm token from an admitted party, FORBIDDEN for a
 * verified identity holding no control-realm role; both carry the same
 * message whatever the cause within them, so nothing here enumerates
 * tenants, realms or clients.
 */
export async function resolveControlSession(
  headers: Headers,
  config: ControlPlaneConfig,
  options: ControlSessionOptions = {},
): Promise<ControlSessionContext> {
  if (usesHostOrganizationContext()) assertHostRealm(config);
  const claims = await verifyControlBearer(headers, config, options);

  const authorizedParty = stringClaim(claims, "azp") ?? "";
  const admittedByParty = controlAdmittedParties(config).includes(authorizedParty);
  const admittedByAudience =
    options.resource !== undefined && audienceList(claims.aud).includes(options.resource);
  if (!admittedByParty && !admittedByAudience) {
    throw new ControlAuthorizationError(
      "UNAUTHENTICATED",
      "The presented token was not issued for the platform's control plane.",
    );
  }

  const subject = stringClaim(claims, "sub");
  if (!subject) {
    throw new ControlAuthorizationError(
      "UNAUTHENTICATED",
      "The presented token carries no subject.",
    );
  }

  // Host-organization mode maps Keycloak's built-in realm administrator onto
  // the same single control-plane role used in the dedicated control realm.
  const roles = usesHostOrganizationContext()
    ? hasKeycloakRealmAdmin(claims) ? [...CONTROL_REALM_ROLES] : []
    : realmRolesOf(claims);
  if (!roles.some((role) => CONTROL_REALM_ROLES.includes(role))) {
    throw new ControlAuthorizationError(
      "FORBIDDEN",
      "Not authorized to use the control plane; a control-realm platform role is required.",
    );
  }

  const exp = claims.exp;
  const username = stringClaim(claims, "preferred_username") ?? undefined;
  return controlSessionFor(
    {
      subject,
      issuer: config.operator.issuer,
      username,
      name: stringClaim(claims, "name") ?? username ?? null,
      email: stringClaim(claims, "email"),
      authorizedParty,
      expiresAtMs: typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : null,
    },
    roles,
  );
}

/** A control refusal as the transport-neutral HTTP error the runtime projects. */
export function controlSessionHttpError(error: unknown): HttpError {
  if (error instanceof ControlAuthorizationError) {
    const status = error.code === "FORBIDDEN" ? 403 : error.code === "UNAUTHENTICATED" ? 401 : 503;
    return new HttpError(status, error.code, error.message);
  }
  if (error instanceof HttpError) return error;
  throw error;
}

/**
 * The `iss` of a bearer token, read WITHOUT verification and used for exactly
 * one thing: choosing which realm's verifier to hand the token to, so a
 * control-realm token is not first tried — and logged as a failure — against
 * the tenant realm on the shared runtime routes. A forged issuer only routes
 * the token to a verifier that will refuse it. Null for anything that is not
 * a three-part JWT with a string `iss`.
 */
export function bearerIssuerOf(headers: Headers): string | null {
  const authorization = headers.get("authorization");
  const match = authorization ? /^Bearer\s+(.+)$/i.exec(authorization) : null;
  const parts = match?.[1]?.trim().split(".");
  if (!parts || parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as unknown;
    const issuer = (payload as { iss?: unknown } | null)?.iss;
    return typeof issuer === "string" && issuer.length > 0 ? issuer : null;
  } catch {
    return null;
  }
}
