// SPDX-License-Identifier: BUSL-1.1
/**
 * The API key wire format.
 *
 * `osf_live_<lookupId>_<secret><crc>`
 *
 * Three properties, each paying for itself:
 *
 *   - a STABLE PREFIX, so secret scanners can match the credential with a low
 *     false-positive rate, and so `resolveSessionContext` can route to this
 *     path without touching the JWKS verifier;
 *   - a SPLIT into a public lookup half and a secret half, so the database is
 *     searched by an indexed non-secret column and the secret is only ever
 *     compared, never queried;
 *   - a CRC32 CHECKSUM over everything before it, so a malformed or fabricated
 *     key is rejected before any database read. This is GitHub's token-format
 *     design, and the reason it matters here is that an unauthenticated caller
 *     would otherwise get a free indexed lookup per request.
 *
 * The secret is compared against a SHA-256 hash. That is deliberate rather than
 * a password KDF: the secret is 32 bytes from a CSPRNG, not a human-chosen
 * value, so there is no dictionary to slow down, and an auth path that ran
 * argon2 per request would be a denial-of-service lever pointed at ourselves.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** Environment segment. Only `live` today; `test` is reserved. */
export const API_KEY_PREFIX = "osf_live_";

const LOOKUP_ID_BYTES = 8;
const SECRET_BYTES = 32;
const CHECKSUM_CHARS = 6;

/**
 * Base62, matching the alphabet GitHub uses. Chosen over base64url because a
 * key gets pasted into shells, CI variables and YAML — `-` and `_` survive
 * those, but they also make double-click selection stop early in several
 * terminals, and `_` is already the field separator here.
 */
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function toBase62(bytes: Buffer): string {
  // Interpreted as one big-endian integer. Leading zero bytes would otherwise
  // vanish, so they are re-added as leading '0' characters.
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);

  let out = "";
  while (value > 0n) {
    out = BASE62[Number(value % 62n)] + out;
    value /= 62n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = "0" + out;
  }
  return out === "" ? "0" : out;
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(input: string): number {
  let crc = 0xffffffff;
  const bytes = Buffer.from(input, "utf8");
  for (const byte of bytes) {
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ byte) & 0xff]!;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Left-padded so the checksum is always the same width and can be sliced off. */
function checksumFor(body: string): string {
  const crc = crc32(body);
  const bytes = Buffer.from([
    (crc >>> 24) & 0xff,
    (crc >>> 16) & 0xff,
    (crc >>> 8) & 0xff,
    crc & 0xff,
  ]);
  return toBase62(bytes).padStart(CHECKSUM_CHARS, "0");
}

export type MintedApiKey = {
  /** The full credential. Shown once, never stored, never recoverable. */
  token: string;
  /** The public half, stored as the indexed lookup column. */
  lookupId: string;
  /** SHA-256 of the secret half, hex. What the database stores. */
  secretHash: string;
};

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/** Generate a fresh credential. The caller persists `lookupId` + `secretHash`. */
export function mintApiKey(): MintedApiKey {
  const lookupId = toBase62(randomBytes(LOOKUP_ID_BYTES));
  const secret = toBase62(randomBytes(SECRET_BYTES));
  const body = `${API_KEY_PREFIX}${lookupId}_${secret}`;
  return {
    token: `${body}${checksumFor(body)}`,
    lookupId,
    secretHash: hashSecret(secret),
  };
}

export type ParsedApiKey = {
  lookupId: string;
  secret: string;
};

/** True when a bearer credential is shaped like one of ours. Cheap, no parsing. */
export function looksLikeApiKey(candidate: string): boolean {
  return candidate.startsWith(API_KEY_PREFIX);
}

/**
 * Parse and checksum-verify. Returns undefined for anything that is not a
 * well-formed key of ours — the caller must treat that as "reject", never as
 * "try another credential path".
 *
 * Deliberately returns no reason: a caller that could distinguish "bad
 * checksum" from "unknown key" learns whether a lookup id exists.
 */
export function parseApiKey(candidate: string): ParsedApiKey | undefined {
  if (!looksLikeApiKey(candidate)) return undefined;
  if (candidate.length <= API_KEY_PREFIX.length + CHECKSUM_CHARS + 2) return undefined;

  const body = candidate.slice(0, -CHECKSUM_CHARS);
  const presented = candidate.slice(-CHECKSUM_CHARS);
  if (!constantTimeEquals(presented, checksumFor(body))) return undefined;

  const rest = body.slice(API_KEY_PREFIX.length);
  const separator = rest.indexOf("_");
  if (separator <= 0) return undefined;

  const lookupId = rest.slice(0, separator);
  const secret = rest.slice(separator + 1);
  if (lookupId === "" || secret === "") return undefined;

  // Every character must be in the alphabet we mint from; anything else is a
  // fabrication that happened to carry a valid checksum shape.
  if (!isBase62(lookupId) || !isBase62(secret)) return undefined;

  return { lookupId, secret };
}

function isBase62(value: string): boolean {
  for (const char of value) {
    if (!BASE62.includes(char)) return false;
  }
  return true;
}

/**
 * Length-safe constant-time comparison. `timingSafeEqual` throws on a length
 * mismatch, which would itself be a timing signal, so unequal lengths are
 * folded into a comparison against a same-length buffer.
 */
export function constantTimeEquals(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  if (a.length !== b.length) {
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

/** Verify a presented secret against the stored hash, in constant time. */
export function secretMatches(secret: string, storedHash: string): boolean {
  return constantTimeEquals(hashSecret(secret), storedHash);
}
