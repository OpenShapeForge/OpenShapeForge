// SPDX-License-Identifier: BUSL-1.1
import {
  hasValidTrustedContextSignature as hasValidTrustedContextSignatureCore,
  readTrustedContext,
  type ReadTrustedContextOptions,
} from "@openshapeforge/auth";

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
 */
export type SessionCredential = "none" | "bearer" | "api-key" | "trusted-context";

export type TrustedSessionContext = {
  tenantId: string | null;
  userId: string | null;
  roles: string[];
  /**
   * Keycloak group paths the user belongs to. Empty when the trusted-context
   * carrier does not propagate group claims (current default — trusted-context
   * headers are minimal). The bearer JWT path can populate this.
   */
  groups: string[];
  /**
   * Effective access scope used by the DB session layer to set `app.scope`.
   * Defaults to "self" — the most restrictive option — until upstream
   * resolution determines otherwise.
   */
  scope: SessionScope;
  /** Which credential authenticated this session. */
  credential: SessionCredential;
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
  return {
    tenantId: base.tenantId,
    userId: base.userId,
    roles: base.roles,
    groups: base.groups ?? [],
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
