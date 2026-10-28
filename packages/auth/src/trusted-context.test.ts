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

describe("trusted-context principal class", () => {
  const now = 1_700_000_000_000;

  /** The identity plus whatever class the producer claims to have established. */
  function signed(principalKind?: string): Headers {
    const headers = new Headers();
    applyTrustedContextHeaders(
      headers,
      { ...IDENTITY, ...(principalKind ? { principalKind: principalKind as never } : {}) },
      { secret: SECRET, nowMs: now },
    );
    return headers;
  }

  it("carries the class the signer established, both ways", () => {
    for (const kind of ["person", "service"] as const) {
      const headers = signed(kind);
      expect(readTrustedContext(headers, { secret: SECRET, nowMs: now }).principalKind).toBe(kind);
    }
  });

  it("establishes no class when the producer asserts none", () => {
    // A health probe, a fixture, any hop that forwards an identity it did not
    // authenticate. Absent is the default and must never read as a person.
    const read = readTrustedContext(signed(), { secret: SECRET, nowMs: now });
    expect(read.principalKind).toBeUndefined();
    expect(read.tenantId).toBe("tenant-acme");
  });

  it("signs no class for a word outside the two it knows", () => {
    // Normalised at the producer rather than forwarded, so an unrecognised
    // value can never arrive looking like a verdict somebody made.
    const headers = signed("admin");
    expect(headers.get("x-user-principal-kind")).toBeNull();
    expect(readTrustedContext(headers, { secret: SECRET, nowMs: now }).principalKind)
      .toBeUndefined();
  });

  it("refuses a class a caller wrote onto an otherwise valid bundle", () => {
    // The forgery that matters: a bundle this deployment really signed, for a
    // principal it classified as nothing, with the header appended in flight.
    const headers = signed();
    headers.set("x-user-principal-kind", "person");
    expect(hasValidTrustedContextSignature(headers, { secret: SECRET, nowMs: now })).toBe(false);
    expect(readTrustedContext(headers, { secret: SECRET, nowMs: now })).toMatchObject({
      tenantId: null,
      userId: null,
    });
  });

  it("refuses a class swapped for another on a signed bundle", () => {
    const headers = signed("service");
    headers.set("x-user-principal-kind", "person");
    expect(hasValidTrustedContextSignature(headers, { secret: SECRET, nowMs: now })).toBe(false);
  });

  it("refuses a class stripped from a signed bundle", () => {
    // Removing the header must invalidate too: the payload is positional and
    // the empty field is still signed, so a downgrade is a tamper.
    const headers = signed("person");
    headers.delete("x-user-principal-kind");
    expect(hasValidTrustedContextSignature(headers, { secret: SECRET, nowMs: now })).toBe(false);
  });

  it("clears an inbound class before signing its own", () => {
    // A client's own copy of the header is dropped with the rest of the
    // bundle, so a proxied request cannot smuggle one past the producer.
    const headers = new Headers({ "x-user-principal-kind": "person" });
    applyTrustedContextHeaders(headers, IDENTITY, { secret: SECRET, nowMs: now });
    expect(headers.get("x-user-principal-kind")).toBeNull();
    expect(readTrustedContext(headers, { secret: SECRET, nowMs: now }).principalKind)
      .toBeUndefined();
  });
});
