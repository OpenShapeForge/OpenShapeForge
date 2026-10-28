// SPDX-License-Identifier: BUSL-1.1
/**
 * The EXACT producer that shipped before the principal class was signed,
 * against the verifier that ships now.
 *
 * `legacyV2Producer` below is not a call into this package with a flag — it is
 * the v2 signing code reproduced literally, the way a host tier that has not
 * been redeployed still signs (a web tier, an MCP app, an operational script).
 * That is the only way this file can show a rolling upgrade works: a test that
 * asked the current package to sign v2 would be proving the current package
 * agrees with itself.
 *
 * Two properties, and the second is the security one:
 *
 *   1. a v2 bundle VERIFIES — the identity it names arrives, so the ordinary
 *      work those hops do keeps working while they are upgraded;
 *   2. a v2 bundle is UNCLASSIFIED — it never carries a principal class, so it
 *      reaches nothing reserved for a verified human, and appending the class
 *      header to it changes neither the verdict nor the identity.
 *
 * Forged, tampered, unsigned and v1 bundles are all refused outright.
 */
import { createHmac } from "node:crypto";
import { describe, expect, it } from "bun:test";
import {
  TRUSTED_CONTEXT_HEADERS,
  TRUSTED_CONTEXT_MAX_AGE_MS,
  applyTrustedContextHeaders,
  hasValidTrustedContextSignature,
  readTrustedContext,
  verifyTrustedContext,
} from "./trusted-context.js";

const SECRET = "v2-compat-suite-context-secret";
const NOW = 1_800_000_000_000;

const TENANT = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const ROLES = ["Platform.ApiKeys.Manage", "Relations.All.Read"];
const GROUPS = ["/openshapeforge-demo/acme/operations"];

/**
 * The v2 producer, verbatim.
 *
 * Copied from the shipped v2 implementation rather than imported: the payload
 * it builds (version, timestamp, tenant, user, roles, groups — six fields, no
 * principal class) and the headers it sets are the wire format every
 * not-yet-upgraded tier still emits. `version` is a parameter so the same code
 * also reproduces the v1 producer, which must stay refused.
 */
function legacyProducer(version: "v1" | "v2", nowMs: number = NOW): Headers {
  const headers = new Headers();
  const roles = ROLES.join(",");
  const groups = GROUPS.join(",");
  const timestamp = String(nowMs);
  const payload = version === "v2"
    ? ["v2", timestamp, TENANT, USER, roles, groups].join("\n")
    : ["v1", timestamp, TENANT, USER, roles].join("\n");
  headers.set(TRUSTED_CONTEXT_HEADERS.tenantId, TENANT);
  headers.set(TRUSTED_CONTEXT_HEADERS.userId, USER);
  headers.set(TRUSTED_CONTEXT_HEADERS.roles, roles);
  headers.set(TRUSTED_CONTEXT_HEADERS.groups, groups);
  headers.set(TRUSTED_CONTEXT_HEADERS.timestamp, timestamp);
  headers.set(
    TRUSTED_CONTEXT_HEADERS.signature,
    createHmac("sha256", SECRET).update(payload).digest("hex"),
  );
  return headers;
}

const read = { secret: SECRET, nowMs: NOW };

describe("a v2 producer reaching the current verifier", () => {
  it("verifies, and names the identity it signed", () => {
    const headers = legacyProducer("v2");
    expect(hasValidTrustedContextSignature(headers, read)).toBe(true);
    expect(readTrustedContext(headers, read)).toEqual({
      tenantId: TENANT,
      userId: USER,
      roles: ROLES,
      groups: GROUPS,
    });
    expect(verifyTrustedContext(headers, read)?.version).toBe("v2");
  });

  it("carries no principal class, so nothing can require a person from it", () => {
    const identity = readTrustedContext(legacyProducer("v2"), read);
    expect(identity.principalKind).toBeUndefined();
    expect("principalKind" in identity).toBe(false);
  });

  it("cannot be upgraded to a person by adding the class header to it", () => {
    // The whole point of signing the class: a captured or replayed v2 bundle
    // with `person` appended must verify as v2 and stay unclassified, not
    // borrow an authority its producer never established.
    for (const claimed of ["person", "service"]) {
      const headers = legacyProducer("v2");
      headers.set(TRUSTED_CONTEXT_HEADERS.principalKind, claimed);
      const verified = verifyTrustedContext(headers, read);
      expect(verified?.version).toBe("v2");
      expect(verified?.identity.principalKind).toBeUndefined();
      expect(readTrustedContext(headers, read).principalKind).toBeUndefined();
    }
  });

  it("is still held to the replay window", () => {
    const stale = legacyProducer("v2", NOW - (TRUSTED_CONTEXT_MAX_AGE_MS + 1_000));
    expect(hasValidTrustedContextSignature(stale, read)).toBe(false);
    expect(readTrustedContext(stale, read).tenantId).toBeNull();
  });

  it("is still held to the signature over its roles and groups", () => {
    for (const header of [TRUSTED_CONTEXT_HEADERS.roles, TRUSTED_CONTEXT_HEADERS.groups]) {
      const tampered = legacyProducer("v2");
      tampered.set(header, "Platform.SystemBypass");
      expect(hasValidTrustedContextSignature(tampered, read)).toBe(false);
      expect(readTrustedContext(tampered, read).tenantId).toBeNull();
    }
  });

  it("is refused under a different secret", () => {
    const headers = legacyProducer("v2");
    expect(hasValidTrustedContextSignature(headers, { secret: "other", nowMs: NOW })).toBe(false);
  });
});

describe("what the verifier still refuses", () => {
  it("refuses v1, whose groups were outside the signature", () => {
    const headers = legacyProducer("v1");
    expect(hasValidTrustedContextSignature(headers, read)).toBe(false);
    expect(readTrustedContext(headers, read).tenantId).toBeNull();
  });

  it("refuses an unsigned bundle when a secret is configured", () => {
    const headers = new Headers();
    headers.set(TRUSTED_CONTEXT_HEADERS.tenantId, TENANT);
    headers.set(TRUSTED_CONTEXT_HEADERS.userId, USER);
    headers.set(TRUSTED_CONTEXT_HEADERS.roles, ROLES.join(","));
    headers.set(TRUSTED_CONTEXT_HEADERS.principalKind, "person");
    expect(hasValidTrustedContextSignature(headers, read)).toBe(false);
    expect(readTrustedContext(headers, read)).toEqual({
      tenantId: null, userId: null, roles: [], groups: [],
    });
  });

  it("refuses a forged signature of the right length", () => {
    const headers = legacyProducer("v2");
    const forged = headers.get(TRUSTED_CONTEXT_HEADERS.signature)!
      .replace(/^./, (first) => (first === "0" ? "1" : "0"));
    headers.set(TRUSTED_CONTEXT_HEADERS.signature, forged);
    expect(hasValidTrustedContextSignature(headers, read)).toBe(false);
  });

  it("refuses a v2 signature replayed onto another identity", () => {
    const headers = legacyProducer("v2");
    headers.set(TRUSTED_CONTEXT_HEADERS.userId, "33333333-3333-4333-8333-333333333333");
    expect(hasValidTrustedContextSignature(headers, read)).toBe(false);
  });
});

describe("a current v3 producer is unchanged by v2 acceptance", () => {
  it("carries the class its signer verified", () => {
    const headers = new Headers();
    applyTrustedContextHeaders(headers, {
      tenantId: TENANT, userId: USER, roles: ROLES, groups: GROUPS, principalKind: "person",
    }, { secret: SECRET, nowMs: NOW });
    const verified = verifyTrustedContext(headers, read);
    expect(verified?.version).toBe("v3");
    expect(verified?.identity.principalKind).toBe("person");
  });

  it("signs v3 with no class when its signer established none", () => {
    const headers = new Headers();
    applyTrustedContextHeaders(headers, {
      tenantId: TENANT, userId: USER, roles: ROLES, groups: GROUPS,
    }, { secret: SECRET, nowMs: NOW });
    const verified = verifyTrustedContext(headers, read);
    expect(verified?.version).toBe("v3");
    expect(verified?.identity.principalKind).toBeUndefined();
  });

  it("refuses a v3 bundle whose class header was swapped after signing", () => {
    const headers = new Headers();
    applyTrustedContextHeaders(headers, {
      tenantId: TENANT, userId: USER, roles: ROLES, groups: GROUPS, principalKind: "service",
    }, { secret: SECRET, nowMs: NOW });
    headers.set(TRUSTED_CONTEXT_HEADERS.principalKind, "person");
    // Not a v2 fallback either: the v2 payload has six fields and this
    // signature covers seven, so neither version matches.
    expect(verifyTrustedContext(headers, read)).toBeNull();
    expect(readTrustedContext(headers, read).tenantId).toBeNull();
  });

  it("refuses a v3 bundle whose class header was stripped after signing", () => {
    const headers = new Headers();
    applyTrustedContextHeaders(headers, {
      tenantId: TENANT, userId: USER, roles: ROLES, groups: GROUPS, principalKind: "person",
    }, { secret: SECRET, nowMs: NOW });
    headers.delete(TRUSTED_CONTEXT_HEADERS.principalKind);
    expect(verifyTrustedContext(headers, read)).toBeNull();
  });
});
