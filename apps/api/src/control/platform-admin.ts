// SPDX-License-Identifier: BUSL-1.1
/**
 * Who may use the platform administrator MCP (`/api/control/mcp`), and what
 * they become on the far side of the door.
 *
 * The same three preconditions `authorization.ts` puts in front of the REST
 * control plane, with two deliberate differences:
 *
 *   1. the authorized party is an ALLOW-LIST rather than one client. The REST
 *      surface is called by the admin gateway; an MCP client signs the person
 *      in interactively through a public PKCE client of the control realm
 *      (`codex-platform` in the reference setup), and both must be admitted.
 *      Everything the single pin protects against still holds: `admin-cli`
 *      is not on the list, and a name off the list is refused before a role
 *      is looked at.
 *   2. the marker role is `platform_admin` — a person who manages the
 *      integration catalog for every tenant — rather than
 *      `platform-operator`, which is the tenant lifecycle. One person may hold
 *      both; the surfaces do not imply each other.
 *
 * The elevation is the same one and made in the same place: an administrator
 * becomes a `Platform.SystemBypass` database session for exactly one call,
 * with an issuer-qualified actor and a reason naming the tool and its target
 * (`systemSessionForOperator`). No tenant, no organization: a platform
 * session names every tenant by slug and nothing in a token picks one.
 */
import {
  ControlAuthorizationError,
  realmRolesOf,
  type ResolveOperatorOptions,
  systemSessionForOperator,
  verifyControlBearer,
} from "./authorization.js";
import { platformMcpAuthorizedParties, type ControlPlaneConfig } from "./config.js";
import type { SystemSessionInput } from "../db/session.js";

/** The control realm's marker role for the integration catalog. */
export const PLATFORM_ADMIN_ROLE = "platform_admin";

/** An authenticated, authorized platform administrator. */
export type PlatformAdministrator = {
  /** The `sub` claim, unique within `issuer` and only within it. */
  subject: string;
  /** The control realm that vouched for the subject. */
  issuer: string;
  /** `preferred_username`, for audit context. */
  username: string | undefined;
  /** `name`, else `preferred_username`; display only. */
  name: string | null;
  email: string | null;
  /** The OAuth client the token was issued to (`azp`); display only. */
  authorizedParty: string;
  /** Token expiry in epoch milliseconds; null when the token carries none. */
  expiresAtMs: number | null;
};

function stringClaim(claims: Record<string, unknown>, key: string): string | null {
  const value = claims[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Authenticate and authorize the caller as a platform administrator.
 *
 * A refusal is one of two codes, and each carries the same message whatever
 * the cause within it: UNAUTHENTICATED for anything short of a verified
 * control-realm token from an admitted party (no header, a tenant-realm
 * token, an API key, trusted-context headers, `admin-cli`), FORBIDDEN for a
 * verified administrator-realm identity without the role. A tenant-realm
 * token fails signature verification against the control realm's JWKS, so
 * it is refused without this code ever learning it was a tenant token —
 * nothing here can enumerate tenants or realms.
 */
export async function resolvePlatformAdministrator(
  headers: Headers,
  config: ControlPlaneConfig,
  options: ResolveOperatorOptions = {},
): Promise<PlatformAdministrator> {
  const claims = await verifyControlBearer(headers, config, options);

  const authorizedParty = stringClaim(claims, "azp") ?? "";
  if (!platformMcpAuthorizedParties(config).includes(authorizedParty)) {
    throw new ControlAuthorizationError(
      "UNAUTHENTICATED",
      "The presented token was not issued for the platform administrator MCP.",
    );
  }

  const subject = stringClaim(claims, "sub");
  if (!subject) {
    throw new ControlAuthorizationError(
      "UNAUTHENTICATED",
      "The presented token carries no subject.",
    );
  }

  if (!realmRolesOf(claims).includes(PLATFORM_ADMIN_ROLE)) {
    throw new ControlAuthorizationError(
      "FORBIDDEN",
      `Not authorized to administer the platform; the ${PLATFORM_ADMIN_ROLE} realm role is required.`,
    );
  }

  const exp = claims.exp;
  const username = stringClaim(claims, "preferred_username") ?? undefined;
  return {
    subject,
    issuer: config.operator.issuer,
    username,
    name: stringClaim(claims, "name") ?? username ?? null,
    email: stringClaim(claims, "email"),
    authorizedParty,
    expiresAtMs: typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : null,
  };
}

/**
 * The elevation for one tool call. `reason` names the tool and its target so
 * `platform.system_bypass_audit` reads as a log of what the administrator did
 * (`platform-mcp: publish_catalog_entry service/record-finding`), with the
 * issuer-qualified actor and the timestamps the session layer records.
 */
export function systemSessionForAdministrator(
  administrator: PlatformAdministrator,
  reason: string,
): SystemSessionInput {
  // The operator's mapping, re-labelled: same actor form, same bypass role,
  // no tenant scope — the reason prefix is the only difference, so an audit
  // reader can tell the two surfaces apart.
  const session = systemSessionForOperator(
    {
      subject: administrator.subject,
      issuer: administrator.issuer,
      username: administrator.username,
    },
    reason,
  );
  return { ...session, reason: `platform-mcp: ${reason}` };
}
