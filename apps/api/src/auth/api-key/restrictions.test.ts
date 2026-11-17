// SPDX-License-Identifier: BUSL-1.1
/**
 * Where an API key may be used from, without a database: validation of the
 * network allowlist and the per-request rules. The resolver wiring is proven
 * end to end in __tests__/api-key-restrictions.e2e.test.ts.
 */
import { describe, expect, test } from "bun:test";
import {
  addressAllowed,
  ApiKeyRestrictionError,
  ApiKeyRestrictionInputError,
  assertKeyUsableHere,
  CLIENT_ADDRESS_HEADER,
  keyRequestContext,
  normalizeAllowedIps,
  storedList,
} from "./restrictions.js";

describe("normalizeAllowedIps", () => {
  test("accepts addresses and ranges in both families, deduplicated", () => {
    expect(normalizeAllowedIps([
      "203.0.113.7", " 198.51.100.0/24 ", "2001:DB8::/32", "::1", "::ffff:192.0.2.1", "203.0.113.7",
    ])).toEqual(["203.0.113.7", "198.51.100.0/24", "2001:db8::/32", "::1", "192.0.2.1"]);
  });

  test("absent, null and empty all mean any address", () => {
    expect(normalizeAllowedIps(undefined)).toEqual([]);
    expect(normalizeAllowedIps(null)).toEqual([]);
    expect(normalizeAllowedIps([])).toEqual([]);
  });

  test.each([
    ["not an address", ["example.com"]],
    ["bad octet", ["256.1.1.1"]],
    ["v4 prefix too long", ["10.0.0.0/33"]],
    ["v6 prefix too long", ["2001:db8::/129"]],
    ["non-numeric prefix", ["10.0.0.0/x"]],
    ["two slashes", ["10.0.0.0/8/8"]],
    ["non-string", [42]],
    ["not a list", "10.0.0.1"],
  ])("refuses %s", (_name, input) => {
    expect(() => normalizeAllowedIps(input)).toThrow(ApiKeyRestrictionInputError);
  });

  test("refuses more than 20 entries", () => {
    const many = Array.from({ length: 21 }, (_, i) => `10.0.0.${i}`);
    expect(() => normalizeAllowedIps(many)).toThrow(/at most 20/);
  });
});

describe("addressAllowed", () => {
  const list = ["203.0.113.7", "198.51.100.0/24", "2001:db8::/32"];

  test("an empty list admits every address, even an unknown one", () => {
    expect(addressAllowed([], null)).toBe(true);
    expect(addressAllowed([], "192.0.2.1")).toBe(true);
  });

  test("matches single addresses, ranges and IPv6", () => {
    expect(addressAllowed(list, "203.0.113.7")).toBe(true);
    expect(addressAllowed(list, "198.51.100.200")).toBe(true);
    expect(addressAllowed(list, "2001:db8:1::5")).toBe(true);
    expect(addressAllowed(list, "::ffff:198.51.100.9")).toBe(true);
  });

  test("refuses addresses outside, and an address the server could not establish", () => {
    expect(addressAllowed(list, "203.0.113.8")).toBe(false);
    expect(addressAllowed(list, "198.51.101.1")).toBe(false);
    expect(addressAllowed(list, "2001:db9::1")).toBe(false);
    expect(addressAllowed(list, null)).toBe(false);
    expect(addressAllowed(list, "garbage")).toBe(false);
  });
});

describe("assertKeyUsableHere", () => {
  const at = (clientAddress: string | null, origin: string | null = null) => ({ clientAddress, origin });

  test("a key without an allowlist works from anywhere outside a browser", () => {
    expect(() => assertKeyUsableHere([], at("192.0.2.1"), "integration")).not.toThrow();
    expect(() => assertKeyUsableHere([], at(null), "personal")).not.toThrow();
  });

  test("the network allowlist refuses other addresses with a 403", () => {
    expect(() => assertKeyUsableHere(["203.0.113.0/24"], at("203.0.113.9"), "integration")).not.toThrow();
    try {
      assertKeyUsableHere(["203.0.113.0/24"], at("192.0.2.1"), "integration");
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiKeyRestrictionError);
      expect((error as ApiKeyRestrictionError).status).toBe(403);
      expect((error as ApiKeyRestrictionError).code).toBe("API_KEY_RESTRICTED");
      expect((error as Error).message).toMatch(/network address/);
    }
    expect(() => assertKeyUsableHere(["203.0.113.0/24"], at(null), "personal")).toThrow(ApiKeyRestrictionError);
  });

  test("every key kind is refused when a browser presents it, even from an allowed network", () => {
    for (const kind of ["integration", "personal"] as const) {
      expect(() => assertKeyUsableHere([], at("192.0.2.1", "https://shop.example.com"), kind))
        .toThrow(/cannot be used from a web browser/);
      expect(() => assertKeyUsableHere(["203.0.113.0/24"], at("203.0.113.1", "https://shop.example.com"), kind))
        .toThrow(ApiKeyRestrictionError);
    }
  });
});

describe("request context and stored lists", () => {
  test("reads the server-stamped address and the browser origin", () => {
    const headers = new Headers({ [CLIENT_ADDRESS_HEADER]: "203.0.113.7", origin: "https://shop.example.com" });
    expect(keyRequestContext(headers)).toEqual({ clientAddress: "203.0.113.7", origin: "https://shop.example.com" });
    expect(keyRequestContext(new Headers())).toEqual({ clientAddress: null, origin: null });
  });

  test("a stored list tolerates null, text and junk", () => {
    expect(storedList(null)).toEqual([]);
    expect(storedList('["10.0.0.1"]')).toEqual(["10.0.0.1"]);
    expect(storedList(["a", 1, "", "b"])).toEqual(["a", "b"]);
    expect(storedList("not json")).toEqual([]);
  });
});
