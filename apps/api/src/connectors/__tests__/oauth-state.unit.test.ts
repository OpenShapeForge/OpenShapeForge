// SPDX-License-Identifier: BUSL-1.1
/**
 * The state parameter's own properties, without a database.
 *
 * The claim itself — single-use, expiry, tenant scoping — is one SQL statement
 * and belongs in the db-backed suite; a stub here would prove the statement I
 * wrote matches the statement I wrote. What IS provable without a database is
 * everything the claim depends on being true beforehand: that a state is
 * unguessable, that it carries its tenant, that a tampered one is refused
 * before it reaches a query, and that PKCE is a real S256 pair.
 */
import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { buildPkce, buildState, parseState, stateEquals } from "../oauth-state.js";

const TENANT = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
const USER = "9f8e7d6c-5b4a-4392-8281-706f5e4d3c2b";

describe("state", () => {
  it("carries the tenant and user it belongs to, so the callback needs no RLS bypass", () => {
    const { state } = buildState(TENANT, USER);
    expect(parseState(state)?.tenantId).toBe(TENANT);
    // The callback has no session of its own, and the database refuses an
    // anonymous one — so the state has to say who to act as.
    expect(parseState(state)?.userId).toBe(USER);
  });

  it("is unguessable and never repeats", () => {
    const seen = new Set(Array.from({ length: 200 }, () => buildState(TENANT, USER).state));
    expect(seen.size).toBe(200);
    // 32 random bytes, base64url — the secret half alone is >= 43 chars.
    const secret = buildState(TENANT, USER).state.split(".")[2]!;
    expect(secret.length).toBeGreaterThanOrEqual(43);
  });

  // Only the secret half is hashed. Knowing which tenant a flow belonged to
  // must not let anyone recompute the stored hash.
  it("hashes only the secret half", () => {
    const { state, secretHash } = buildState(TENANT, USER);
    const secret = state.split(".")[2]!;
    const expected = createHash("sha256")
      .update(secret)
      .digest("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(secretHash).toBe(expected);
    expect(parseState(state)?.secretHash).toBe(secretHash);
  });

  // A tenant id that is not a UUID would reach a ::uuid cast and error, and an
  // error that depends on attacker input is a probe worth denying.
  it.each([
    ["no separators", "abcdef"],
    ["only two parts", `${TENANT}.abcdef`],
    ["tenant that is not a uuid", `not-a-uuid.${USER}.abcdef`],
    ["user that is not a uuid", `${TENANT}.not-a-uuid.abcdef`],
    ["empty tenant", `.${USER}.abcdef`],
    ["empty secret", `${TENANT}.${USER}.`],
    ["sql-ish tenant", `1;drop table x.${USER}.abcdef`],
  ])("refuses a malformed state: %s", (_label, state) => {
    expect(parseState(state)).toBeUndefined();
  });

  it("does not accept a state whose secret was altered", () => {
    const { state, secretHash } = buildState(TENANT, USER);
    const tampered = `${state.slice(0, -1)}${state.endsWith("A") ? "B" : "A"}`;
    expect(parseState(tampered)?.secretHash).not.toBe(secretHash);
  });
});

describe("PKCE", () => {
  it("produces a real S256 challenge for its verifier", () => {
    const { verifier, challenge } = buildPkce();
    const expected = createHash("sha256")
      .update(verifier)
      .digest("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(challenge).toBe(expected);
  });

  it("meets the RFC 7636 verifier length floor", () => {
    expect(buildPkce().verifier.length).toBeGreaterThanOrEqual(43);
  });

  it("never repeats a verifier", () => {
    const seen = new Set(Array.from({ length: 200 }, () => buildPkce().verifier));
    expect(seen.size).toBe(200);
  });
});

describe("comparison", () => {
  it("compares equal and unequal values correctly", () => {
    expect(stateEquals("abc", "abc")).toBe(true);
    expect(stateEquals("abc", "abd")).toBe(false);
    expect(stateEquals("abc", "abcd")).toBe(false);
  });
});
