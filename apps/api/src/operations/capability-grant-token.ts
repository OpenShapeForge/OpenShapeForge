// SPDX-License-Identifier: BUSL-1.1
/**
 * The capability grant token: `<grantId>.<secret>`. The id locates the row
 * (a primary-key lookup, so an attacker cannot make the database compare
 * against every hash), the secret is what the row's `token_hash` is the
 * SHA-256 of. Only the secret is secret; the id is also what operators see
 * in `grants.list`.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const GRANT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const GRANT_SECRET = /^[A-Za-z0-9_-]{43}$/;

export type ParsedGrantToken = { id: string; secret: string };

export function mintGrantSecret(): string {
  return randomBytes(32).toString("base64url");
}

export function renderGrantToken(id: string, secret: string): string {
  return `${id}.${secret}`;
}

/** Undefined for anything that is not shaped like a token; never throws. */
export function parseGrantToken(token: string): ParsedGrantToken | undefined {
  const separator = token.indexOf(".");
  if (separator <= 0) return undefined;
  const id = token.slice(0, separator).toLowerCase();
  const secret = token.slice(separator + 1);
  if (!GRANT_ID.test(id) || !GRANT_SECRET.test(secret)) return undefined;
  return { id, secret };
}

export function hashGrantSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/**
 * Compared against when the id names no row, so a probe for ids costs the
 * same as a probe for secrets.
 */
export const DECOY_GRANT_HASH = hashGrantSecret("openshapeforge:capability-grant:decoy");

/** Constant-time comparison of a presented secret against a stored hex hash. */
export function grantSecretMatches(secret: string, storedHash: string): boolean {
  const presented = Buffer.from(hashGrantSecret(secret), "hex");
  const stored = Buffer.from(storedHash, "hex");
  if (presented.length !== stored.length) {
    timingSafeEqual(presented, presented);
    return false;
  }
  return timingSafeEqual(presented, stored);
}

/** `Authorization: Grant <token>`; undefined for any other header. */
export function grantTokenFromAuthorization(header: string | undefined): string | undefined {
  if (typeof header !== "string") return undefined;
  const match = /^\s*Grant\s+(\S+)\s*$/i.exec(header);
  return match?.[1];
}
