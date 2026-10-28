// SPDX-License-Identifier: BUSL-1.1
/**
 * What this tier is willing to SAY about the principal behind a hop.
 *
 * The API refuses credential management to anything it cannot show to be a
 * human, and the bundle's principal class is how that verdict crosses the
 * hop — so this one rule is a security decision made here, and worth a test
 * of its own.
 */
import { describe, expect, test } from "bun:test";
import { principalKindOf } from "./principal-kind";

const SUB = "33333333-3333-4333-8333-333333333333";

describe("the principal class apps/web signs", () => {
  test("names a person for a session established by an interactive login", () => {
    expect(principalKindOf({ sub: SUB, idToken: "header.payload.signature" })).toBe("person");
  });

  test("names nothing for a session carrying no login artifact", () => {
    // A server-side probe, a development identity, any token-less internal
    // call. The identity still travels; the verdict does not, and the API
    // reads its absence as a principal it may not treat as human.
    expect(principalKindOf({ sub: SUB })).toBeUndefined();
  });

  test("names nothing when the id token is the session shape's placeholder", () => {
    // The session fills `idToken` with "" rather than leaving it out, so the
    // check has to be on the value and not on the key.
    expect(principalKindOf({ sub: SUB, idToken: "" })).toBeUndefined();
    expect(principalKindOf({ sub: SUB, idToken: null })).toBeUndefined();
  });

  test("names nothing without a subject to attach the verdict to", () => {
    for (const sub of [null, undefined, ""]) {
      expect(principalKindOf({ sub, idToken: "header.payload.signature" })).toBeUndefined();
    }
  });
});
