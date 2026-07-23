// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "bun:test";
import {
  TRUSTED_CONTEXT_MAX_AGE_MS,
  TRUSTED_CONTEXT_MAX_CLOCK_SKEW_MS,
  applyTrustedContextHeaders,
  hasValidTrustedContextSignature,
  readTrustedContext,
} from "./trusted-context.js";
import type { AuthIdentity } from "./types.js";

const SECRET = "unit-test-context-secret";

const IDENTITY: Pick<AuthIdentity, "tenantId" | "userId" | "roles" | "groups"> = {
  tenantId: "tenant-acme",
  userId: "user-42",
  roles: ["operator", "viewer"],
  groups: ["/openshapeforge-demo/tenant-acme/operations"],
};

/** Signs a bundle at `signedAtMs` and returns the resulting headers. */
function signedHeaders(signedAtMs: number): Headers {
  const headers = new Headers();
  applyTrustedContextHeaders(headers, IDENTITY, { secret: SECRET, nowMs: signedAtMs });
  return headers;
}

describe("trusted-context freshness window", () => {
  const now = 1_700_000_000_000;

  it("accepts a bundle signed at the same instant", () => {
    const headers = signedHeaders(now);
    expect(hasValidTrustedContextSignature(headers, { secret: SECRET, nowMs: now })).toBe(true);
    expect(readTrustedContext(headers, { secret: SECRET, nowMs: now }).tenantId).toBe(
      "tenant-acme",
    );
  });

  it("accepts a past-dated bundle within the replay window", () => {
    const headers = signedHeaders(now - (TRUSTED_CONTEXT_MAX_AGE_MS - 1_000));
    expect(hasValidTrustedContextSignature(headers, { secret: SECRET, nowMs: now })).toBe(true);
  });

  it("rejects a past-dated bundle beyond the replay window", () => {
    const headers = signedHeaders(now - (TRUSTED_CONTEXT_MAX_AGE_MS + 1_000));
    expect(hasValidTrustedContextSignature(headers, { secret: SECRET, nowMs: now })).toBe(false);
    expect(readTrustedContext(headers, { secret: SECRET, nowMs: now }).tenantId).toBeNull();
  });

  it("accepts a slightly future-dated bundle within the clock-skew allowance", () => {
    const headers = signedHeaders(now + (TRUSTED_CONTEXT_MAX_CLOCK_SKEW_MS - 1_000));
    expect(hasValidTrustedContextSignature(headers, { secret: SECRET, nowMs: now })).toBe(true);
  });

  it("rejects a future-dated bundle beyond the clock-skew allowance", () => {
    const headers = signedHeaders(now + (TRUSTED_CONTEXT_MAX_CLOCK_SKEW_MS + 1_000));
    expect(hasValidTrustedContextSignature(headers, { secret: SECRET, nowMs: now })).toBe(false);
    expect(readTrustedContext(headers, { secret: SECRET, nowMs: now }).tenantId).toBeNull();
  });

  it("rejects a bundle pre-dated far into the future (former abs() gap)", () => {
    // A holder of the secret pre-dates a bundle to almost the full replay
    // window ahead of now. The old symmetric abs() window accepted this;
    // the asymmetric window must reject it.
    const headers = signedHeaders(now + (TRUSTED_CONTEXT_MAX_AGE_MS - 1_000));
    expect(hasValidTrustedContextSignature(headers, { secret: SECRET, nowMs: now })).toBe(false);
  });
});
