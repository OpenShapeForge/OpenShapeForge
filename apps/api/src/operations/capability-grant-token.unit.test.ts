// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  grantSecretMatches,
  grantTokenFromAuthorization,
  hashGrantSecret,
  mintGrantSecret,
  parseGrantToken,
  renderGrantToken,
} from "./capability-grant-token.js";

describe("capability grant token", () => {
  test("round-trips id and secret and rejects anything else", () => {
    const id = randomUUID();
    const secret = mintGrantSecret();
    expect(parseGrantToken(renderGrantToken(id, secret))).toEqual({ id, secret });
    expect(parseGrantToken(renderGrantToken(id.toUpperCase(), secret))?.id).toBe(id);
    expect(parseGrantToken(`${id}.${secret}x`)).toBeUndefined();
    expect(parseGrantToken(`${id}.${secret.slice(1)}`)).toBeUndefined();
    expect(parseGrantToken(`not-a-uuid.${secret}`)).toBeUndefined();
    expect(parseGrantToken(secret)).toBeUndefined();
    expect(parseGrantToken("")).toBeUndefined();
    expect(parseGrantToken(`${id}.${secret.replace(/./, "+")}`)).toBeUndefined();
  });

  test("hashes are hex SHA-256 and compare in constant time by shape", () => {
    const secret = mintGrantSecret();
    const hash = hashGrantSecret(secret);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(grantSecretMatches(secret, hash)).toBe(true);
    expect(grantSecretMatches(mintGrantSecret(), hash)).toBe(false);
    expect(grantSecretMatches(secret, "abcd")).toBe(false);
    expect(grantSecretMatches(secret, "")).toBe(false);
  });

  test("reads only the Grant authorization scheme", () => {
    expect(grantTokenFromAuthorization("Grant abc.def")).toBe("abc.def");
    expect(grantTokenFromAuthorization("grant   abc.def ")).toBe("abc.def");
    expect(grantTokenFromAuthorization("Bearer abc.def")).toBeUndefined();
    expect(grantTokenFromAuthorization("Grant")).toBeUndefined();
    expect(grantTokenFromAuthorization("Grant a b")).toBeUndefined();
    expect(grantTokenFromAuthorization(undefined)).toBeUndefined();
  });
});
