// SPDX-License-Identifier: BUSL-1.1
/**
 * Who may use the control plane, and how an authenticated operator becomes a
 * system-bypass database session.
 *
 * THE MAPPING THIS FILE EXISTS TO MAKE EXPLICIT
 * --------------------------------------------
 * `withSystemSession` demands the role `Platform.SystemBypass`, and the control
 * realm deliberately does NOT mint it: `authorization.control.yaml` says so in
 * as many words, because a role that disables row-level security across every
 * tenant has no business sitting in an interactive login token where a stolen
 * session, a mis-scoped composite or a token-exchange mistake would carry it.
 *
 * So the elevation is a SERVER-SIDE decision made here, and it is deliberately
 * one line of policy with three preconditions in front of it:
 *
 *   1. the bearer verifies against the CONTROL realm — its own issuer and JWKS,
 *      never the tenant realm's (see config.ts);
 *   2. the token was minted for the control realm's one gateway client, and
 *      carries a subject; and
 *   3. the subject holds the realm role `platform-operator`.
 *
 * Only then does {@link systemSessionForOperator} attach `Platform.SystemBypass`
 * — to a session object that never leaves the process, for the duration of one
 * callback. The token is never rewritten and nothing downstream can re-present
 * the elevation.
 *
 * AUDITABILITY
 * ------------
 * `withSystemSession`'s `reason` is required and non-empty for exactly this
 * case, so every mutation names the operation and its target, and
 * `actorSubject` is the issuer-qualified subject rather than a bare uuid: `sub`
 * is only unique WITHIN an issuer, and `platform.system_bypass_audit` is a
 * single table that will one day hold rows from more than one. An audit row that
 * cannot identify its actor unambiguously is not an audit row.
 */
import { createBearerVerifier, type BearerVerifier } from "@openshapeforge/auth";
import { SYSTEM_BYPASS_ROLE, type SystemSessionInput } from "../db/session.js";
import type { ControlPlaneConfig } from "./config.js";

/**
 * The control realm's single realm role. Holding it means "may use the control
 * plane"; it composes nothing, because the authority to change anything lives on
 * the far side of a server-side call rather than in the token.
 */
export const PLATFORM_OPERATOR_ROLE = "platform-operator";

export type ControlAuthErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "CONTROL_PLANE_NOT_CONFIGURED";

export class ControlAuthorizationError extends Error {
  readonly code: ControlAuthErrorCode;
  constructor(code: ControlAuthErrorCode, message: string) {
    super(message);
    this.name = "ControlAuthorizationError";
    this.code = code;
  }
}

/** An authenticated, authorized platform operator. */
export type ControlOperator = {
  /** The `sub` claim, unique within `issuer` and only within it. */
  subject: string;
  /** The control realm that vouched for the subject. */
  issuer: string;
  /** `preferred_username`, for human-readable audit context. Optional. */
  username: string | undefined;
};

const BEARER_AUTHORIZATION = /^Bearer\s+(.+)$/i;

/**
 * Verifiers are cached per (issuer, jwksUri) rather than per call:
 * `createRemoteJWKSet` keeps its own key cache, and rebuilding it every request
 * would re-fetch the JWKS on every request.
 *
 * No `audience` option, deliberately — a real operator token carries no `aud` at
 * all, because the control realm has no resource-server client to put there. The
 * party check is on `azp` below; config.ts explains the choice in full.
 */
const verifierCache = new Map<string, BearerVerifier>();

function verifierFor(config: ControlPlaneConfig): BearerVerifier {
  const key = `${config.operator.issuer}|${config.operator.jwksUri}`;
  const existing = verifierCache.get(key);
  if (existing) return existing;
  const verifier = createBearerVerifier({
    issuer: config.operator.issuer,
    jwksUri: config.operator.jwksUri,
  });
  verifierCache.set(key, verifier);
  return verifier;
}

/** Test-only: drop cached verifiers so a changed config is picked up. */
export function __resetControlVerifiersForTests(): void {
  verifierCache.clear();
}

export type ResolveOperatorOptions = {
  /** Injected by tests so the JWKS fetch can be bypassed. */
  verifier?: BearerVerifier;
};

/**
 * Authenticate and authorize the caller as a platform operator.
 *
 * Bearer only, and only against the control realm. There is deliberately no
 * trusted-context fallback: `readTrustedSessionContext` accepts HMAC-signed
 * headers carrying arbitrary roles, which on the tenant surface is a considered
 * trade-off between two tenant-scoped mechanisms, and on a cross-tenant control
 * surface would mean anything holding the shared context secret could claim to
 * be an operator.
 */
export async function resolveControlOperator(
  headers: Headers,
  config: ControlPlaneConfig,
  options: ResolveOperatorOptions = {},
): Promise<ControlOperator> {
  const authorization = headers.get("authorization");
  const match = authorization ? BEARER_AUTHORIZATION.exec(authorization) : null;
  if (!match) {
    throw new ControlAuthorizationError(
      "UNAUTHENTICATED",
      "The control plane requires an Authorization: Bearer token from the control realm.",
    );
  }

  const verifier = options.verifier ?? verifierFor(config);
  let claims: Record<string, unknown>;
  try {
    ({ claims } = (await verifier(match[1]!)) as unknown as {
      claims: Record<string, unknown>;
    });
  } catch (error) {
    // The reason is logged, not returned: signature/issuer/audience/expiry
    // failures are an oracle for an attacker probing which realm this endpoint
    // trusts, and an operator with a genuinely broken token learns nothing
    // useful from the distinction either.
    console.warn(
      "[control] Operator bearer verification failed:",
      error instanceof Error ? error.message : String(error),
    );
    throw new ControlAuthorizationError(
      "UNAUTHENTICATED",
      "The presented token is not a valid control-realm operator token.",
    );
  }

  // The authorized-party check. Without it a valid issuer alone would let in a
  // token minted by Keycloak's built-in PUBLIC `admin-cli` client — obtainable
  // by any realm user with a direct-access grant and NO client secret — which
  // would reduce the control plane's credential requirement from
  // "password AND the gateway's secret" to "password". `aud` cannot carry this:
  // the control realm has no resource-server client, so no operator token has
  // one. Same reasoning as the SPI's own ALLOWED_ADMIN_CLIENTS allow-list, and
  // like it, this is defence in depth rather than the authorization decision —
  // the role check below is that.
  const authorizedParty = typeof claims.azp === "string" ? claims.azp : "";
  if (authorizedParty !== config.operator.clientId) {
    throw new ControlAuthorizationError(
      "UNAUTHENTICATED",
      "The presented token was not issued for the control plane's client.",
    );
  }

  const subject = typeof claims.sub === "string" ? claims.sub.trim() : "";
  if (!subject) {
    throw new ControlAuthorizationError(
      "UNAUTHENTICATED",
      "The presented token carries no subject.",
    );
  }

  // Realm roles only. `resource_access` client roles are deliberately NOT
  // merged the way identity.ts merges them for tenant sessions: there, entity
  // roles only exist per-client so merging is required to authorize anything at
  // all. Here there is one marker role on one realm, and widening the search to
  // every client's role list would let any client that happens to define a role
  // named `platform-operator` mint control-plane access.
  const realmAccess = claims.realm_access;
  const realmRoles =
    realmAccess && typeof realmAccess === "object" && !Array.isArray(realmAccess)
      ? (realmAccess as { roles?: unknown }).roles
      : undefined;
  const holdsOperatorRole =
    Array.isArray(realmRoles) && realmRoles.includes(PLATFORM_OPERATOR_ROLE);
  if (!holdsOperatorRole) {
    throw new ControlAuthorizationError(
      "FORBIDDEN",
      `Not authorized to use the control plane; the ${PLATFORM_OPERATOR_ROLE} realm role is required.`,
    );
  }

  const username =
    typeof claims.preferred_username === "string" && claims.preferred_username.trim()
      ? claims.preferred_username.trim()
      : undefined;

  return { subject, issuer: config.operator.issuer, username };
}

/**
 * THE ELEVATION. Turns an authorized operator into the input `withSystemSession`
 * requires.
 *
 * Everything that decides whether this is safe has already happened: the caller
 * proved a control-realm identity holding `platform-operator`. What this adds is
 * the role the database session needs and the audit trail that makes the
 * addition reviewable — an issuer-qualified actor and a reason naming the
 * operation and its target.
 *
 * `tenantId` is left unset on purpose. A bypass session that names a tenant
 * reads as scoped to it; the control plane's writes are cross-tenant by nature
 * (the registry row IS the tenant, and it may not exist yet), so claiming a
 * scope the session does not have would make the audit trail misleading rather
 * than more precise.
 */
export function systemSessionForOperator(
  operator: ControlOperator,
  reason: string,
): SystemSessionInput {
  if (!reason || reason.trim().length === 0) {
    throw new Error("A control-plane system session requires a non-empty reason.");
  }
  const actor = operator.username
    ? `${operator.issuer}#${operator.subject} (${operator.username})`
    : `${operator.issuer}#${operator.subject}`;
  return {
    actorSubject: actor,
    roles: [SYSTEM_BYPASS_ROLE],
    reason: `control-plane: ${reason}`,
  };
}
