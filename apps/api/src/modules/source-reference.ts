// SPDX-License-Identifier: BUSL-1.1
/** Stable, non-reversible identifiers for core-owned connection authority. */
import { createHmac, timingSafeEqual } from "node:crypto";

export type InvocationSourceReferenceIdentity = {
  tenantId: string;
  actorId: string | null;
  scope: "tenant" | "personal";
  connectionTable: string;
  connectionId: string;
};

function secret(): string {
  return (
    process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET?.trim() ||
    "openshapeforge-local-dev-context-secret"
  );
}

function canonical(identity: InvocationSourceReferenceIdentity): string {
  return JSON.stringify([
    1,
    identity.tenantId,
    identity.scope,
    identity.scope === "personal" ? identity.actorId : null,
    identity.connectionTable,
    identity.connectionId,
  ]);
}

function assertValidIdentity(identity: InvocationSourceReferenceIdentity): void {
  if (
    !identity.tenantId ||
    !identity.connectionTable ||
    !identity.connectionId ||
    (identity.scope === "personal" && !identity.actorId)
  ) {
    throw new Error("Invocation source identity is incomplete.");
  }
}

export function mintInvocationSourceReference(
  identity: InvocationSourceReferenceIdentity,
): string {
  assertValidIdentity(identity);
  const digest = createHmac("sha256", secret())
    .update("openshapeforge:module-source-reference:v1\0")
    .update(canonical(identity))
    .digest("base64url");
  return `msr1.${digest}`;
}

export function invocationSourceReferenceMatches(
  reference: string,
  identity: InvocationSourceReferenceIdentity,
): boolean {
  const expected = mintInvocationSourceReference(identity);
  const left = Buffer.from(reference);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function sameInvocationSourceReference(
  leftReference: string,
  rightReference: string,
): boolean {
  const left = Buffer.from(leftReference);
  const right = Buffer.from(rightReference);
  return left.length === right.length && timingSafeEqual(left, right);
}
