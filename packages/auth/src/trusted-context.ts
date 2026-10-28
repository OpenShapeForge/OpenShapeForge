// SPDX-License-Identifier: BUSL-1.1
import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  AuthIdentity,
  HeadersLike,
  ReadonlyHeadersLike,
  TrustedContextHeaderNames,
} from "./types.js";

export const TRUSTED_CONTEXT_HEADERS: TrustedContextHeaderNames = {
  tenantId: "x-tenant-id",
  userId: "x-user-id",
  roles: "x-user-roles",
  groups: "x-user-groups",
  principalKind: "x-user-principal-kind",
  timestamp: "x-openshapeforge-context-timestamp",
  signature: "x-openshapeforge-context-signature",
};

export const TRUSTED_CONTEXT_MAX_AGE_MS = 5 * 60 * 1000;

/**
 * How far a signed timestamp may sit in the FUTURE and still be accepted. The
 * freshness window is asymmetric: the past side spans the full replay window
 * (legitimate latency between the signer and this verifier), but the future
 * side allows only a small clock-skew tolerance. A symmetric abs() window
 * would let a holder of the secret (or a captured bundle) pre-date a bundle up
 * to the full window ahead of now, extending its usable lifetime; rejecting
 * meaningfully future-dated timestamps closes that.
 */
export const TRUSTED_CONTEXT_MAX_CLOCK_SKEW_MS = 30 * 1000;

/**
 * Payload version. v3 includes the PRINCIPAL CLASS the signer verified, so a
 * consumer can require a human without taking a caller's word for it; v2
 * (groups, no principal class) and v1 (neither) are no longer accepted —
 * every producer in the workspace ships from the same package version, and a
 * tier that has not been redeployed reads as unauthenticated rather than as
 * an unclassified principal.
 */
const PAYLOAD_VERSION = "v3";

/**
 * What the SIGNER established about the principal behind the bundle, not what
 * the caller claims to be.
 *
 * "person" means the producer completed an interactive human login and holds
 * its artifacts; "service" means it verified a machine principal. The value
 * is ABSENT when the producer established neither — an internal probe, a
 * fixture, a hop that forwards an identity it did not authenticate — and
 * absence is never a permissive reading: a consumer that needs a human
 * refuses it. Anything outside this set read off the wire is discarded, so an
 * unknown word can never be mistaken for a known one.
 */
export type TrustedPrincipalKind = "person" | "service";

function readPrincipalKind(raw: string | null | undefined): TrustedPrincipalKind | undefined {
  return raw === "person" || raw === "service" ? raw : undefined;
}

export type ApplyTrustedContextOptions = {
  /** HMAC secret. If omitted, identity headers are still applied but unsigned (caller is responsible for trust). */
  secret?: string | null;
  /** Override Date.now() for tests. */
  nowMs?: number;
};

export type ReadTrustedContextOptions = {
  secret?: string | null;
  nowMs?: number;
  /** Trust unsigned headers — only honored when no secret is configured (test/unit-test mode). */
  allowUnsigned?: boolean;
};

function splitDelimited(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function joinDelimited(values: readonly string[] | null | undefined): string {
  return (values ?? [])
    .map((value) => value.trim())
    .filter(Boolean)
    .join(",");
}

function payloadString(input: {
  timestamp: string;
  tenantId: string | null;
  userId: string | null;
  roles: string;
  groups: string;
  principalKind: TrustedPrincipalKind | undefined;
}) {
  // Field count is fixed and every field is separated by the same newline, so
  // a value that itself contains one adds a segment and can never make two
  // different header sets produce the same payload.
  return [
    PAYLOAD_VERSION,
    input.timestamp,
    input.tenantId ?? "",
    input.userId ?? "",
    input.roles,
    input.groups,
    input.principalKind ?? "",
  ].join("\n");
}

function sign(secret: string, payload: string) {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

function signaturesMatch(left: string, right: string) {
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  return (
    leftBuffer.length === rightBuffer.length &&
    leftBuffer.length > 0 &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

/**
 * What travels in a bundle: the trusted-context floor of {@link AuthIdentity}
 * plus the signer's own verdict about the principal.
 *
 * `principalKind` is deliberately NOT part of `AuthIdentity`: no verifier in
 * this package produces it. It is a statement the PRODUCER of a hop makes
 * about how it authenticated, which is why it is signed here rather than
 * reconstructed by the consumer.
 */
export type TrustedContextIdentity =
  Pick<AuthIdentity, "tenantId" | "userId" | "roles" | "groups">
  & { principalKind?: TrustedPrincipalKind | undefined };

type IdentityInput = TrustedContextIdentity;

/**
 * Replaces any existing trusted-context headers on `headers` with values
 * derived from `identity`, then attaches an HMAC signature when a secret is
 * provided. Inbound copies of the identity/signature headers are always
 * cleared first so a client cannot smuggle their own.
 */
export function applyTrustedContextHeaders(
  headers: HeadersLike,
  identity: IdentityInput,
  options: ApplyTrustedContextOptions = {},
): void {
  for (const name of Object.values(TRUSTED_CONTEXT_HEADERS) as string[]) {
    headers.delete(name);
  }

  const tenantId = identity.tenantId?.trim() || null;
  const userId = identity.userId?.trim() || null;
  const roles = joinDelimited(identity.roles);
  const groups = joinDelimited(identity.groups);
  // Normalised rather than forwarded: a producer that passes something other
  // than the two known classes signs no class at all, which a consumer reads
  // as "not established" instead of as an unrecognised permission.
  const principalKind = readPrincipalKind(identity.principalKind);

  if (tenantId) headers.set(TRUSTED_CONTEXT_HEADERS.tenantId, tenantId);
  if (userId) headers.set(TRUSTED_CONTEXT_HEADERS.userId, userId);
  if (roles) headers.set(TRUSTED_CONTEXT_HEADERS.roles, roles);
  if (groups) headers.set(TRUSTED_CONTEXT_HEADERS.groups, groups);
  if (principalKind) headers.set(TRUSTED_CONTEXT_HEADERS.principalKind, principalKind);

  const secret = options.secret ?? null;
  if (!secret || !tenantId) return;

  const timestamp = String(options.nowMs ?? Date.now());
  headers.set(TRUSTED_CONTEXT_HEADERS.timestamp, timestamp);
  headers.set(
    TRUSTED_CONTEXT_HEADERS.signature,
    sign(secret, payloadString({ timestamp, tenantId, userId, roles, groups, principalKind })),
  );
}

function verifySignature(
  headers: ReadonlyHeadersLike,
  identity: IdentityInput,
  options: ReadTrustedContextOptions,
): boolean {
  const secret = options.secret ?? null;
  if (!secret) return false;

  const timestamp = headers.get(TRUSTED_CONTEXT_HEADERS.timestamp);
  const signature = headers.get(TRUSTED_CONTEXT_HEADERS.signature);
  if (!timestamp || !signature) return false;

  const parsedTimestamp = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(parsedTimestamp)) return false;

  const nowMs = options.nowMs ?? Date.now();
  const ageMs = nowMs - parsedTimestamp;
  // Reject stale bundles (older than the replay window) and meaningfully
  // future-dated bundles (beyond a small clock-skew allowance). The window is
  // deliberately asymmetric — see TRUSTED_CONTEXT_MAX_CLOCK_SKEW_MS.
  if (ageMs > TRUSTED_CONTEXT_MAX_AGE_MS) return false;
  if (ageMs < -TRUSTED_CONTEXT_MAX_CLOCK_SKEW_MS) return false;

  const expected = sign(
    secret,
    payloadString({
      timestamp,
      tenantId: identity.tenantId,
      userId: identity.userId,
      roles: joinDelimited(identity.roles),
      groups: joinDelimited(identity.groups),
      principalKind: identity.principalKind,
    }),
  );

  return signaturesMatch(signature, expected);
}

function readIdentityHeaders(headers: ReadonlyHeadersLike): IdentityInput {
  // The principal class is read through the same normalisation the signer
  // applied, so an inbound word the signer would have dropped cannot verify
  // against a signature that was computed without it.
  const principalKind = readPrincipalKind(headers.get(TRUSTED_CONTEXT_HEADERS.principalKind));
  return {
    tenantId: headers.get(TRUSTED_CONTEXT_HEADERS.tenantId),
    userId: headers.get(TRUSTED_CONTEXT_HEADERS.userId),
    roles: splitDelimited(headers.get(TRUSTED_CONTEXT_HEADERS.roles)),
    groups: splitDelimited(headers.get(TRUSTED_CONTEXT_HEADERS.groups)),
    ...(principalKind ? { principalKind } : {}),
  };
}

const EMPTY_IDENTITY: IdentityInput = {
  tenantId: null,
  userId: null,
  roles: [],
  groups: [],
};

/**
 * Reads tenant/user/roles/groups from trusted-context headers and verifies the HMAC
 * signature. Returns an empty identity when verification fails — callers fail
 * closed by checking for null.
 *
 * `allowUnsigned: true` returns the headers as-is, but ONLY when no secret is
 * configured. This is for unit-test fixtures and the local dev path where
 * OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET is intentionally unset.
 */
export function readTrustedContext(
  headers: ReadonlyHeadersLike,
  options: ReadTrustedContextOptions = {},
): IdentityInput {
  const identity = readIdentityHeaders(headers);
  const secret = options.secret ?? null;

  if (options.allowUnsigned === true && !secret) {
    return identity;
  }

  return verifySignature(headers, identity, options) ? identity : EMPTY_IDENTITY;
}

/** True iff the inbound headers carry a valid signature over the identity they claim. */
export function hasValidTrustedContextSignature(
  headers: ReadonlyHeadersLike,
  options: ReadTrustedContextOptions = {},
): boolean {
  return verifySignature(headers, readIdentityHeaders(headers), options);
}
