// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import {
  assertBearerCredential,
  assertJsonRpcContentType,
  classifyShortAddressRequest,
  McpTransportError,
  withoutCookieIdentity,
} from "../address.js";

describe("bolt 2: a JSON-RPC body only under application/json", () => {
  test("accepts application/json, with or without parameters", () => {
    expect(() => assertJsonRpcContentType("POST", "application/json")).not.toThrow();
    expect(() =>
      assertJsonRpcContentType("POST", "application/json; charset=utf-8"),
    ).not.toThrow();
  });

  test("refuses exactly the content-types that skip the CORS preflight", () => {
    // These three are the reason this check exists: a form auto-submitted from
    // any origin reaches this endpoint without a preflight to refuse it.
    for (const type of [
      "text/plain",
      "application/x-www-form-urlencoded",
      "multipart/form-data; boundary=x",
    ]) {
      let thrown: unknown;
      try {
        assertJsonRpcContentType("POST", type);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(McpTransportError);
      expect((thrown as McpTransportError).status).toBe(415);
      expect((thrown as McpTransportError).message).toContain("CORS preflight");
    }
  });

  test("refuses a missing content-type, and leaves non-POST alone", () => {
    expect(() => assertJsonRpcContentType("POST", undefined)).toThrow(McpTransportError);
    expect(() => assertJsonRpcContentType("GET", undefined)).not.toThrow();
    expect(() => assertJsonRpcContentType("DELETE", "text/plain")).not.toThrow();
  });
});

describe("bolt 1: a cookie is never an identity", () => {
  test("the cookie header does not survive into session resolution", () => {
    const headers = { cookie: "session=abc", authorization: "Bearer t" };
    expect(withoutCookieIdentity(headers)["cookie"]).toBeUndefined();
    // The original is not mutated: the raw request is still whatever it was.
    expect(headers["cookie"]).toBe("session=abc");
  });

  test("an organization resource requires a bearer token", () => {
    expect(() => assertBearerCredential({ authorization: "Bearer abc" })).not.toThrow();
    expect(() => assertBearerCredential({ authorization: "bearer abc" })).not.toThrow();
    expect(() => assertBearerCredential({ authorization: "Bearer" })).toThrow(McpTransportError);
    expect(() => assertBearerCredential({})).toThrow(McpTransportError);
  });

  test("a perfectly good session cookie is still not a credential", () => {
    let thrown: unknown;
    try {
      assertBearerCredential({ cookie: "session=abc" });
    } catch (error) {
      thrown = error;
    }
    expect((thrown as McpTransportError).status).toBe(401);
    // The message says WHY, because "401" alone reads like a broken token.
    expect((thrown as McpTransportError).message).toContain("same origin");
  });
});

describe("what Accept says a short address is for", () => {
  const intent = (
    method: string,
    accept?: string,
    contentType?: string,
  ) => classifyShortAddressRequest({ method, accept, contentType });

  test("the three cases the address structure names", () => {
    expect(intent("GET", "text/html,application/xhtml+xml")).toBe("app");
    expect(intent("POST", undefined, "application/json")).toBe("mcp");
    expect(intent("GET", "text/event-stream")).toBe("mcp-stream");
  });

  test("a POST that is not JSON is not a protocol this address speaks", () => {
    expect(intent("POST", undefined, "text/plain")).toBe("unacceptable");
    expect(intent("POST", "text/html", "application/x-www-form-urlencoded")).toBe(
      "unacceptable",
    );
  });

  test("the stream wins over html when a client asks for both", () => {
    expect(intent("GET", "text/event-stream, text/html")).toBe("mcp-stream");
  });

  test("no preference at all is the app — typing the address into a browser", () => {
    expect(intent("GET", undefined)).toBe("app");
    expect(intent("GET", "*/*")).toBe("app");
  });
});
