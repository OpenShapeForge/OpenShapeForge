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
 * So the elevation is a SERVER-SIDE decision, and it is deliberately one line
 * of policy with three preconditions in front of it:
 *
 *   1. the bearer verifies against the CONTROL realm — its own issuer and JWKS,
 *      never the tenant realm's (see config.ts) — which {@link verifyControlBearer}
 *      below is the one implementation of;
 *   2. the token was minted for an admitted client and carries a subject; and
 *   3. the subject holds a control-realm platform role, and the Operation being
 *      invoked names that role in its `auth.roles`.
 *
 * The second and third are decided in `control-session.ts` (the door) and in
 * the operations runtime (per Operation). Only then does
 * {@link systemSessionForOperator} attach `Platform.SystemBypass` — to a
 * session object that never leaves the process, for the duration of one
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
 * The control realm's single platform role. Holding it means "may use the
 * control plane" across tenant lifecycle, organization, reconciliation,
 * catalog, notice and audit Operations. It composes nothing, because the
 * authority to change anything lives on the far side of a server-side call
 * rather than in the token.
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
  /** Identifies an interactive platform-MCP elevation in the shared audit log. */
  auditSource?: "platform-mcp" | undefined;
  /** Tool name prepended to each lower-level service reason for safe projection. */
  auditAction?: string | undefined;
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
 * The first precondition, shared by every control-realm surface: a bearer
 * token that verifies against the CONTROL realm. Returns the verified claims
 * for the caller's own party and role checks; throws UNAUTHENTICATED with a
 * non-enumerating message otherwise.
 *
 * Bearer only, and only against the control realm. There is deliberately no
 * trusted-context fallback: `readTrustedSessionContext` accepts HMAC-signed
 * headers carrying arbitrary roles, which on the tenant surface is a considered
 * trade-off between two tenant-scoped mechanisms, and on a cross-tenant control
 * surface would mean anything holding the shared context secret could claim to
 * be an operator. An API key is refused for the same reason: it names a
 * tenant, and nothing on a cross-tenant surface may.
 */
export async function verifyControlBearer(
  headers: Headers,
  config: ControlPlaneConfig,
  options: ResolveOperatorOptions = {},
): Promise<Record<string, unknown>> {
  const authorization = headers.get("authorization");
  const match = authorization ? BEARER_AUTHORIZATION.exec(authorization) : null;
  if (!match) {
    throw new ControlAuthorizationError(
      "UNAUTHENTICATED",
      "The control plane requires an Authorization: Bearer token from the control realm.",
    );
  }

  const verifier = options.verifier ?? verifierFor(config);
  try {
    const { claims } = (await verifier(match[1]!)) as unknown as {
      claims: Record<string, unknown>;
    };
    return claims;
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
}

/**
 * Realm roles only. `resource_access` client roles are deliberately NOT
 * merged the way identity.ts merges them for tenant sessions: there, entity
 * roles only exist per-client so merging is required to authorize anything at
 * all. Here there are marker roles on one realm, and widening the search to
 * every client's role list would let any client that happens to define a role
 * with the same name mint control-plane access.
 */
export function realmRolesOf(claims: Record<string, unknown>): string[] {
  const realmAccess = claims.realm_access;
  const realmRoles =
    realmAccess && typeof realmAccess === "object" && !Array.isArray(realmAccess)
      ? (realmAccess as { roles?: unknown }).roles
      : undefined;
  return Array.isArray(realmRoles)
    ? realmRoles.filter((role): role is string => typeof role === "string")
    : [];
}

/**
 * THE ELEVATION. Turns an authorized operator into the input `withSystemSession`
 * requires.
 *
 * Everything that decides whether this is safe has already happened: the caller
 * proved a control-realm identity holding the Operation's role. What this adds is
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
    reason:
      `${operator.auditSource ?? "control-plane"}: ` +
      `${operator.auditAction ? `${operator.auditAction} ` : ""}${reason}`,
  };
}
