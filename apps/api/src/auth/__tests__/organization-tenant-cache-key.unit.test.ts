// SPDX-License-Identifier: BUSL-1.1
/**
 * The (realm, organization id) cache key stays unambiguous, and stays text.
 *
 * It used to be joined on a literal NUL byte, which made auth/identity.ts --
 * the one file about identity and authorization -- binary: `file` reported
 * "data" and `grep` answered "binary file matches" instead of showing the
 * line. NUL was not even a safe separator here: `realmFromIssuer`
 * percent-decodes the realm out of `iss`, so "%00" in an issuer puts a NUL
 * inside the realm itself.
 */
import { describe, expect, it } from "bun:test";
import { organizationTenantCacheKey, realmFromIssuer } from "../tenant-resolution.js";

const NUL = "\u0000";

describe("organizationTenantCacheKey", () => {
  it("keeps apart two pairs that a plain separator would merge", () => {
    expect(organizationTenantCacheKey("a:b", "c")).not.toBe(
      organizationTenantCacheKey("a", "b:c"),
    );
  });

  it("keeps apart the pairs the NUL separator itself could merge", () => {
    // A realm reaches this function through decodeURIComponent, so "%00" in
    // the issuer's realm segment produces a realm that contains a NUL.
    const realm = realmFromIssuer("https://kc.example/realms/a%00b");
    expect(realm).toBe(`a${NUL}b`);
    expect(organizationTenantCacheKey(realm!, "c")).not.toBe(
      organizationTenantCacheKey("a", `${NUL}b:c`),
    );
  });

  it("is stable for one pair and distinct for another", () => {
    expect(organizationTenantCacheKey("hubble", "org-1")).toBe(
      organizationTenantCacheKey("hubble", "org-1"),
    );
    expect(organizationTenantCacheKey("hubble", "org-1")).not.toBe(
      organizationTenantCacheKey("hubble", "org-2"),
    );
  });

  it("is text, so the file it lives in stays greppable", () => {
    const control = new RegExp(`[${NUL}-\\u001f]`);
    expect(control.test(organizationTenantCacheKey("hubble", "org-1"))).toBe(
      false,
    );
  });
});
