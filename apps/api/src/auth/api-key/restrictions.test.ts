// SPDX-License-Identifier: BUSL-1.1
/**
 * Where an API key may be used from and what a browser key may call, without a
 * database: validation of the three lists and the per-request rules. The
 * resolver wiring and the CORS handshake are proven end to end in
 * __tests__/api-key-restrictions.e2e.test.ts.
 */
import { describe, expect, test } from "bun:test";
import {
  addressAllowed,
  ApiKeyRestrictionError,
  ApiKeyRestrictionInputError,
  assertKeyUsableHere,
  CLIENT_ADDRESS_HEADER,
  endpointAllowed,
  keyRequestContext,
  normalizeAllowedEndpoints,
  normalizeAllowedIps,
  normalizeAllowedOrigins,
  REQUEST_TARGET_HEADER,
  requestTarget,
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
    expect(() => normalizeAllowedIps(Array.from({ length: 21 }, (_, i) => `10.0.0.${i}`))).toThrow(/at most 20/);
  });
});

describe("normalizeAllowedOrigins", () => {
  test("accepts exact https origins and loopback http, normalized", () => {
    expect(normalizeAllowedOrigins([
      "https://Shop.Example.com", "https://shop.example.com/", "https://app.example.com:8443", "http://localhost:5173",
    ])).toEqual(["https://shop.example.com", "https://app.example.com:8443", "http://localhost:5173"]);
  });

  test.each([
    ["plain http", "http://shop.example.com"],
    ["wildcard", "https://*.example.com"],
    ["a path", "https://shop.example.com/checkout"],
    ["a query", "https://shop.example.com?x=1"],
    ["credentials", "https://user:pw@shop.example.com"],
    ["not a URL", "shop.example.com"],
  ])("refuses %s", (_name, origin) => {
    expect(() => normalizeAllowedOrigins([origin])).toThrow(ApiKeyRestrictionInputError);
  });
});

describe("normalizeAllowedEndpoints", () => {
  test("accepts GET and POST under /api/, normalizing method case and a trailing slash", () => {
    expect(normalizeAllowedEndpoints([
      "get /api/rest/v1/relations", "POST /api/rest/v1/relations/:id/", "GET  /api/rest/v1/relations",
    ])).toEqual(["GET /api/rest/v1/relations", "POST /api/rest/v1/relations/:id"]);
  });

  test("empty and absent mean none", () => {
    expect(normalizeAllowedEndpoints(undefined)).toEqual([]);
    expect(normalizeAllowedEndpoints([])).toEqual([]);
  });

  test.each([
    ["no method", "/api/rest/v1/relations"],
    ["another method", "DELETE /api/rest/v1/relations/:id"],
    ["outside /api/", "GET /admin/things"],
    ["a query", "GET /api/rest/v1/relations?first=1"],
    ["a wildcard", "GET /api/rest/v1/*"],
    ["dot segments", "GET /api/rest/../control/v1"],
    ["an empty parameter", "GET /api/rest/v1/relations/:"],
    ["GraphQL", "POST /api/graphql"],
    ["MCP", "POST /api/mcp"],
    ["the control plane", "POST /api/control/v1/tenants"],
    ["key management", "POST /api/api-key-integrations/create"],
    ["personal keys", "POST /api/personal-api-keys/mine/list"],
  ])("refuses %s", (_name, endpoint) => {
    expect(() => normalizeAllowedEndpoints([endpoint])).toThrow(ApiKeyRestrictionInputError);
  });

  test("refuses more than 50 entries", () => {
    expect(() => normalizeAllowedEndpoints(Array.from({ length: 51 }, (_, i) => `GET /api/x/${i}`))).toThrow(/at most 50/);
  });
});

describe("matching", () => {
  test("addresses: single, range, IPv6 and mapped IPv4; nothing outside or unknown", () => {
    const list = ["203.0.113.7", "198.51.100.0/24", "2001:db8::/32"];
    expect(addressAllowed([], null)).toBe(true);
    expect(addressAllowed(list, "203.0.113.7")).toBe(true);
    expect(addressAllowed(list, "198.51.100.200")).toBe(true);
    expect(addressAllowed(list, "2001:db8:1::5")).toBe(true);
    expect(addressAllowed(list, "::ffff:198.51.100.9")).toBe(true);
    expect(addressAllowed(list, "203.0.113.8")).toBe(false);
    expect(addressAllowed(list, null)).toBe(false);
    expect(addressAllowed(list, "garbage")).toBe(false);
  });

  test("endpoints: exact method and path, one segment per parameter, deny by default", () => {
    const list = ["GET /api/rest/v1/relations", "GET /api/rest/v1/relations/:id", "POST /api/forms/contact"];
    expect(endpointAllowed(list, "GET /api/rest/v1/relations")).toBe(true);
    expect(endpointAllowed(list, "GET /api/rest/v1/relations/")).toBe(true);
    expect(endpointAllowed(list, "GET /api/rest/v1/relations/0b6e")).toBe(true);
    expect(endpointAllowed(list, "POST /api/forms/contact")).toBe(true);
    expect(endpointAllowed(list, "POST /api/rest/v1/relations")).toBe(false);
    expect(endpointAllowed(list, "GET /api/rest/v1/relations/0b6e/notes")).toBe(false);
    expect(endpointAllowed(list, "GET /api/rest/v1/accounts")).toBe(false);
    expect(endpointAllowed([], "GET /api/rest/v1/relations")).toBe(false);
    expect(endpointAllowed(list, null)).toBe(false);
  });

  test("the stamped target drops the query and upper-cases the method", () => {
    expect(requestTarget("get", "/api/rest/v1/relations?first=1")).toBe("GET /api/rest/v1/relations");
  });
});

describe("assertKeyUsableHere", () => {
  const none = { allowedIps: [], allowedOrigins: [], allowedEndpoints: [] };
  const browser = {
    allowedIps: [], allowedOrigins: ["https://shop.example.com"], allowedEndpoints: ["GET /api/rest/v1/relations"],
  };
  const at = (clientAddress: string | null, origin: string | null = null, target: string | null = "GET /api/rest/v1/relations") =>
    ({ clientAddress, origin, target });

  test("a server key without restrictions works from anywhere outside a browser", () => {
    expect(assertKeyUsableHere(none, at("192.0.2.1"), "integration")).toEqual({ browser: false });
  });

  test("the network allowlist refuses other addresses with a 403", () => {
    const fenced = { ...none, allowedIps: ["203.0.113.0/24"] };
    expect(assertKeyUsableHere(fenced, at("203.0.113.9"), "integration")).toEqual({ browser: false });
    try {
      assertKeyUsableHere(fenced, at("192.0.2.1"), "integration");
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiKeyRestrictionError);
      expect((error as ApiKeyRestrictionError).status).toBe(403);
      expect((error as ApiKeyRestrictionError).code).toBe("API_KEY_RESTRICTED");
    }
  });

  test("a server key and a personal key are refused when a browser presents them", () => {
    expect(() => assertKeyUsableHere(none, at("192.0.2.1", "https://shop.example.com"), "integration"))
      .toThrow(/cannot be used from a web browser/);
    expect(() => assertKeyUsableHere(browser, at("192.0.2.1", "https://shop.example.com"), "personal"))
      .toThrow(/personal API key cannot be used from a web browser/);
  });

  test("a browser key needs one of its sites AND one of its endpoints", () => {
    expect(assertKeyUsableHere(browser, at("192.0.2.1", "https://shop.example.com"), "integration")).toEqual({ browser: true });
    expect(() => assertKeyUsableHere(browser, at("192.0.2.1", "https://evil.example.com"), "integration")).toThrow(/web site/);
    expect(() => assertKeyUsableHere(browser, at("192.0.2.1"), "integration")).toThrow(/web site/);
    expect(() => assertKeyUsableHere(browser, at("192.0.2.1", "https://shop.example.com", "POST /api/rest/v1/relations"), "integration"))
      .toThrow(/may not call this endpoint/);
    expect(() => assertKeyUsableHere(browser, at("192.0.2.1", "https://shop.example.com", null), "integration"))
      .toThrow(/may not call this endpoint/);
  });

  test("a browser key with no endpoints can call nothing", () => {
    const empty = { ...browser, allowedEndpoints: [] };
    expect(() => assertKeyUsableHere(empty, at("192.0.2.1", "https://shop.example.com"), "integration"))
      .toThrow(/may not call this endpoint/);
  });

  test("the network fence applies to a browser key too", () => {
    const both = { ...browser, allowedIps: ["203.0.113.0/24"] };
    expect(() => assertKeyUsableHere(both, at("192.0.2.1", "https://shop.example.com"), "integration")).toThrow(/network address/);
    expect(assertKeyUsableHere(both, at("203.0.113.1", "https://shop.example.com"), "integration")).toEqual({ browser: true });
  });
});

describe("request context and stored lists", () => {
  test("reads the server-stamped address and target, and the browser origin", () => {
    const headers = new Headers({
      [CLIENT_ADDRESS_HEADER]: "203.0.113.7", [REQUEST_TARGET_HEADER]: "GET /api/x", origin: "https://shop.example.com",
    });
    expect(keyRequestContext(headers)).toEqual({ clientAddress: "203.0.113.7", origin: "https://shop.example.com", target: "GET /api/x" });
    expect(keyRequestContext(new Headers())).toEqual({ clientAddress: null, origin: null, target: null });
  });

  test("a stored list tolerates null, text and junk", () => {
    expect(storedList(null)).toEqual([]);
    expect(storedList('["10.0.0.1"]')).toEqual(["10.0.0.1"]);
    expect(storedList(["a", 1, "", "b"])).toEqual(["a", "b"]);
    expect(storedList("not json")).toEqual([]);
  });
});
