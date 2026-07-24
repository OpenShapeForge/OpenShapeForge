import { createHmac, timingSafeEqual } from "node:crypto";
import type { AuthIdentity, TrustedContextHeaderNames } from "./types.js";

export const TRUSTED_CONTEXT_HEADERS: TrustedContextHeaderNames = {
  tenantId: "x-tenant-id",
  userId: "x-user-id",
  roles: "x-user-roles",
  groups: "x-user-groups",
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
 * Payload version. v2 includes Keycloak group paths in the signed bundle so
 * an attacker cannot swap groups without invalidating the HMAC. v1 (without
 * groups) is no longer accepted — every producer in the workspace ships from
 * the same package version.
 */
const PAYLOAD_VERSION = "v2";

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
}) {
  return [
    PAYLOAD_VERSION,
    input.timestamp,
    input.tenantId ?? "",
    input.userId ?? "",
    input.roles,
    input.groups,
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

type IdentityInput = Pick<AuthIdentity, "tenantId" | "userId" | "roles" | "groups">;

/**
 * Replaces any existing trusted-context headers on `headers` with values
 * derived from `identity`, then attaches an HMAC signature when a secret is
 * provided. Inbound copies of the identity/signature headers are always
 * cleared first so a client cannot smuggle their own.
 */
export function applyTrustedContextHeaders(
  headers: Headers,
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

  if (tenantId) headers.set(TRUSTED_CONTEXT_HEADERS.tenantId, tenantId);
  if (userId) headers.set(TRUSTED_CONTEXT_HEADERS.userId, userId);
  if (roles) headers.set(TRUSTED_CONTEXT_HEADERS.roles, roles);
  if (groups) headers.set(TRUSTED_CONTEXT_HEADERS.groups, groups);

  const secret = options.secret ?? null;
  if (!secret || !tenantId) return;

  const timestamp = String(options.nowMs ?? Date.now());
  headers.set(TRUSTED_CONTEXT_HEADERS.timestamp, timestamp);
  headers.set(
    TRUSTED_CONTEXT_HEADERS.signature,
    sign(secret, payloadString({ timestamp, tenantId, userId, roles, groups })),
  );
}

function verifySignature(
  headers: Headers,
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
    }),
  );

  return signaturesMatch(signature, expected);
}

function readIdentityHeaders(headers: Headers): IdentityInput {
  return {
    tenantId: headers.get(TRUSTED_CONTEXT_HEADERS.tenantId),
    userId: headers.get(TRUSTED_CONTEXT_HEADERS.userId),
    roles: splitDelimited(headers.get(TRUSTED_CONTEXT_HEADERS.roles)),
    groups: splitDelimited(headers.get(TRUSTED_CONTEXT_HEADERS.groups)),
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
  headers: Headers,
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
  headers: Headers,
  options: ReadTrustedContextOptions = {},
): boolean {
  return verifySignature(headers, readIdentityHeaders(headers), options);
}
