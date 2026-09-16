// SPDX-License-Identifier: BUSL-1.1
/**
 * The route layer's own concerns: body parsing and error presentation.
 *
 * `roles/api.ts` hands routes an unparsed buffer, so the route owns turning it
 * into an object — and owns the failure. A malformed body reaching the redacted
 * 500 branch tells a client nothing about a mistake it made itself, which is
 * exactly the regression these pin.
 */
import { describe, expect, it } from "bun:test";
import { ControlInputError } from "../organization-naming.js";
import { parseJsonBody } from "../rest-routes.js";

describe("parseJsonBody", () => {
  it("parses a buffer, a string and an already-parsed object alike", () => {
    const expected = { slug: "acme", name: "Acme" };
    expect(parseJsonBody(Buffer.from(JSON.stringify(expected)))).toEqual(expected);
    expect(parseJsonBody(JSON.stringify(expected))).toEqual(expected);
    expect(parseJsonBody(expected)).toEqual(expected);
  });

  it("treats an absent or empty body as an empty object", () => {
    // The field-level validators produce the actual message, so an empty body
    // should reach them rather than failing here with something vaguer.
    expect(parseJsonBody(undefined)).toEqual({});
    expect(parseJsonBody(null)).toEqual({});
    expect(parseJsonBody(Buffer.from("   "))).toEqual({});
  });

  it("rejects malformed JSON as caller input, not as an internal fault", () => {
    const error = (() => {
      try {
        parseJsonBody(Buffer.from("{not json"));
      } catch (caught) {
        return caught;
      }
    })();

    expect(error).toBeInstanceOf(ControlInputError);
    expect((error as ControlInputError).code).toBe("CONTROL_INVALID_INPUT");
  });

  it("does not echo the offending body back in the error", () => {
    // A cross-tenant surface should not get into the habit of reflecting request
    // bodies into responses.
    try {
      parseJsonBody(Buffer.from('{"slug": "secret-tenant-name'));
      throw new Error("expected a rejection");
    } catch (caught) {
      expect((caught as Error).message).not.toContain("secret-tenant-name");
    }
  });

  it("rejects a JSON array and a JSON scalar", () => {
    expect(() => parseJsonBody(Buffer.from("[1,2,3]"))).toThrow(/must be a JSON object/);
    expect(() => parseJsonBody(Buffer.from('"acme"'))).toThrow(/must be a JSON object/);
  });
});
