// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import {
  API_KEY_PREFIX,
  constantTimeEquals,
  hashSecret,
  looksLikeApiKey,
  mintApiKey,
  parseApiKey,
  secretMatches,
} from "./format.js";

describe("mintApiKey", () => {
  test("round-trips through parseApiKey", () => {
    const minted = mintApiKey();
    const parsed = parseApiKey(minted.token);

    expect(parsed).toBeDefined();
    expect(parsed!.lookupId).toBe(minted.lookupId);
    expect(hashSecret(parsed!.secret)).toBe(minted.secretHash);
  });

  test("carries the scannable prefix", () => {
    expect(mintApiKey().token.startsWith(API_KEY_PREFIX)).toBe(true);
    expect(looksLikeApiKey(mintApiKey().token)).toBe(true);
  });

  test("never stores the secret in recoverable form", () => {
    const minted = mintApiKey();
    // The hash is what persists; the token must not be derivable from it.
    expect(minted.token).not.toContain(minted.secretHash);
    expect(minted.secretHash).toHaveLength(64);
  });

  test("mints distinct credentials", () => {
    const tokens = new Set(Array.from({ length: 200 }, () => mintApiKey().token));
    expect(tokens.size).toBe(200);
  });

  test("the secret half carries real entropy", () => {
    // 32 bytes base62-encoded is ~43 characters; a regression that shortened
    // the secret would still round-trip, so assert the width directly.
    const parsed = parseApiKey(mintApiKey().token)!;
    expect(parsed.secret.length).toBeGreaterThanOrEqual(40);
  });
});

describe("parseApiKey rejects", () => {
  test("a credential that is not ours", () => {
    expect(parseApiKey("Bearer eyJhbGciOiJIUzI1NiIs")).toBeUndefined();
    expect(parseApiKey("sk_live_abcdefghijklmnop")).toBeUndefined();
    expect(parseApiKey("")).toBeUndefined();
  });

  test("a fabricated key with the right prefix but no valid checksum", () => {
    // This is the case the checksum exists for: an attacker who knows the
    // format must not be able to spend a database lookup per guess.
    expect(parseApiKey(`${API_KEY_PREFIX}deadbeef_notarealsecretatall`)).toBeUndefined();
  });

  test("a key whose body was tampered with after minting", () => {
    const minted = mintApiKey();
    const flipped =
      minted.token.slice(0, API_KEY_PREFIX.length) +
      (minted.token[API_KEY_PREFIX.length] === "a" ? "b" : "a") +
      minted.token.slice(API_KEY_PREFIX.length + 1);

    expect(flipped).not.toBe(minted.token);
    expect(parseApiKey(flipped)).toBeUndefined();
  });

  test("a key whose checksum was tampered with", () => {
    const minted = mintApiKey();
    const last = minted.token.at(-1);
    const tampered = minted.token.slice(0, -1) + (last === "z" ? "y" : "z");

    expect(parseApiKey(tampered)).toBeUndefined();
  });

  test("a truncated key", () => {
    const minted = mintApiKey();
    expect(parseApiKey(minted.token.slice(0, 20))).toBeUndefined();
    expect(parseApiKey(API_KEY_PREFIX)).toBeUndefined();
  });

  test("a key with no secret half", () => {
    expect(parseApiKey(`${API_KEY_PREFIX}lookuponly`)).toBeUndefined();
  });

  test("characters outside the minting alphabet", () => {
    // A checksum-valid body built from characters we never mint is still a
    // fabrication; parsing it would put attacker-chosen bytes in a query.
    const smuggled = `${API_KEY_PREFIX}ab_cd'; drop table x--`;
    expect(parseApiKey(smuggled)).toBeUndefined();
  });
});

describe("secretMatches", () => {
  test("accepts the minted secret and rejects any other", () => {
    const minted = mintApiKey();
    const parsed = parseApiKey(minted.token)!;

    expect(secretMatches(parsed.secret, minted.secretHash)).toBe(true);
    expect(secretMatches(`${parsed.secret}x`, minted.secretHash)).toBe(false);
    expect(secretMatches("", minted.secretHash)).toBe(false);
    expect(secretMatches(parsed.secret, mintApiKey().secretHash)).toBe(false);
  });
});

describe("constantTimeEquals", () => {
  test("compares equal and unequal values without throwing on length mismatch", () => {
    expect(constantTimeEquals("abc", "abc")).toBe(true);
    expect(constantTimeEquals("abc", "abd")).toBe(false);
    // node's timingSafeEqual throws on differing lengths; that must not leak out.
    expect(constantTimeEquals("abc", "abcdef")).toBe(false);
    expect(constantTimeEquals("", "")).toBe(true);
    expect(constantTimeEquals("", "a")).toBe(false);
  });
});
