// SPDX-License-Identifier: BUSL-1.1
import {
  hasValidTrustedContextSignature as hasValidTrustedContextSignatureCore,
  readTrustedContext,
  type ReadTrustedContextOptions,
} from "@openshapeforge/auth";
import type { IdentityLinkState } from "./identity-link.js";
import type { PlatformAdministrator } from "../control/platform-admin.js";

export type SessionScope = "tenant" | "group" | "self";

/**
 * Which credential produced a session.
 *
 * Carried so a control can depend on it rather than on a convention. The one
 * that does today: API key management refuses an "api-key" session, because a
 * credential that can mint or widen credentials is a privilege-escalation
 * ladder (Immich GHSA-237r-x578-h5mv is that bug, shipped).
 *
 * "none" is the unauthenticated empty session. It is spelled out rather than
 * left undefined so no consumer can read a missing value as a permissive one.
 *
 * "control-bearer" is a token of the platform's CONTROL realm
 * (control/control-session.ts): a platform operator acting across every
 * tenant and for none in particular. It never satisfies a tenant Operation,
 * and a tenant credential never satisfies a control one — the operations
 * runtime keys both refusals on this discriminant.
 */
export type SessionCredential =
  | "none"
  | "bearer"
  | "api-key"
  | "trusted-context"
  | "control-bearer"
  /**
   * A capability grant resolved by core for an `auth.mode: capability`
   * Operation: a tenant, no user, no roles, and exactly the Operations and
   * the one record the grant names (`grant`). Only those Operations accept
   * it; a session Operation refuses it like an unauthenticated call.
   */
  | "grant";

/** What a capability grant covers, as core verified it from the grant row. */
export type CapabilityGrantSession = {
  id: string;
  subject: { entity: string; id: string };
  /** Opaque beyond its `kind`; whatever the issuer recorded about the recipient. */
  recipient: { kind: string; [key: string]: unknown };
  operations: readonly string[];
  /** Records beside the subject the issuer delegated, each with its intents. */
  records: readonly { entity: string; id: string; intents: readonly ("get" | "update")[] }[];
  expiresAt: string;
  /** Single-use grants are consumed in the handler's transaction. */
  maxUses: number | null;
};

export type TrustedSessionContext = {
  tenantId: string | null;
  userId: string | null;
  /** Opaque core binding to the verified bearer login session, when available. */
  loginSessionBinding?: string;
  /** Verified tenant-local Relation label; display only, never authorization. */
  userDisplayName?: string | null;
  /**
   * The issuer of the identity behind `userId`: the token's `iss` on the
   * bearer and API-key paths, the realm this deployment trusts for a
   * trusted-context bundle. With `userId` (the subject) it names one
   * platform.identities row, which is how the session finds its Relation.
   */
  issuer?: string;
  /** Display language from verified identity claims; never a permission or client input. */
  locale?: string;
  roles: string[];
  /** OAuth scopes from a verified bearer token; empty on non-bearer carriers. */
  oauthScopes?: string[];
  /**
   * Keycloak group paths the user belongs to. Empty when the trusted-context
   * carrier does not propagate group claims (current default — trusted-context
   * headers are minimal). The bearer JWT path can populate this.
   */
  groups: string[];
  /**
   * Active RelationGroup memberships derived by the server from the linked
   * Relation. This is deliberately separate from Keycloak group paths and
   * platform org-unit scopes; inbound claims never populate it.
   */
  relationGroupIds?: readonly string[];
  /**
   * Effective access scope used by the DB session layer to set `app.scope`.
   * Defaults to "self" — the most restrictive option — until upstream
   * resolution determines otherwise.
   */
  scope: SessionScope;
  /** Which credential authenticated this session. */
  credential: SessionCredential;
  /**
   * The verified platform operator behind a "control-bearer" session: the
   * audit actor (`subject`/`issuer`/`username`) and the display facts whoami
   * reports. Present exactly when `credential` is "control-bearer"; `userId`
   * repeats `subject` so session-shaped code keeps working, and `tenantId`
   * is null because no tenant context exists on the control realm.
   */
  administrator?: PlatformAdministrator;
  /**
   * The verified capability grant behind a "grant" session. Present exactly
   * when `credential` is "grant"; `userId` then carries the grant id so the
   * session layer, receipts and events have an actor, and `roles` is empty.
   */
  grant?: CapabilityGrantSession;
  // ---- identity ↔ Relation link (auth/identity-link.ts) ----
  /**
   * The party this session acts as in the tenant: the identity ↔ Relation
   * link, resolved with the token's claims on the bearer path and read by
   * user id for a trusted-context or API-key session (identity.ts,
   * withSessionRelation). Read it through `sessionRelation(session)`.
   */
  relation?: IdentityLinkState | null;
  // ---- end identity ↔ Relation link ----
};

type AppOptions = {
  nowMs?: number;
  secret?: string | null;
  allowUnsigned?: boolean;
};

function resolveOptions(options: AppOptions): ReadTrustedContextOptions {
  const merged: ReadTrustedContextOptions = {
    secret: options.secret ?? process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET ?? null,
  };
  if (options.nowMs !== undefined) merged.nowMs = options.nowMs;
  if (options.allowUnsigned !== undefined) merged.allowUnsigned = options.allowUnsigned;
  return merged;
}

export function readTrustedSessionContext(
  headers: Headers,
  options: AppOptions = {},
): TrustedSessionContext {
  const base = readTrustedContext(headers, resolveOptions(options));
  // A trusted-context bundle is what the web tier hands on after verifying a
  // token of the realm this deployment trusts; that realm is the identity's
  // issuer. Without one configured no identity can be named, and no link read.
  const issuer = process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER?.trim();
  return {
    tenantId: base.tenantId,
    userId: base.userId,
    ...(issuer ? { issuer } : {}),
    roles: base.roles,
    groups: base.groups ?? [],
    relationGroupIds: [],
    scope: "self",
    credential: "trusted-context",
  };
}

export function hasValidTrustedContextSignature(
  headers: Headers,
  options: AppOptions = {},
): boolean {
  return hasValidTrustedContextSignatureCore(headers, resolveOptions(options));
}
