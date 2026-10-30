// SPDX-License-Identifier: BUSL-1.1
/**
 * Verification of a provider's HMAC over the exact request bytes.
 *
 * Everything here is pure and bounded, and that is the point: this is the one
 * computation an unauthenticated stranger can reach, so it does no I/O, parses
 * nothing out of the payload, and spends work proportional to the body it
 * already decided to accept.
 *
 * Four bounds, each closing a specific way this goes wrong:
 *
 *  1. The algorithm comes from the registration and must be in
 *     `RUNTIME_INBOUND_HASH_ALGORITHMS`. `createHmac` accepts every digest
 *     OpenSSL knows — `md5` and `sha1` included — so forwarding tenant-authored
 *     configuration into it would let a registration downgrade itself.
 *  2. The presented digest must have EXACTLY the algorithm's byte length. A
 *     short digest that happened to match a prefix would otherwise compare
 *     equal under a length-tolerant comparison, and `timingSafeEqual` throws on
 *     unequal lengths rather than answering, so the length check has to come
 *     first either way.
 *  3. The comparison is `timingSafeEqual` over the raw digests, never `===`
 *     over strings and never a re-encoded round trip.
 *  4. The body is bounded before any HMAC runs (`INBOUND_MAX_BODY_BYTES`, which
 *     a registration may lower and never raise).
 *
 * The signature is read from one declared header and nothing else. An absent
 * header is not a weaker proof, it is no proof: there is deliberately no path
 * where a delivery without the declared header is admitted.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  RUNTIME_INBOUND_HASH_ALGORITHMS, RUNTIME_INBOUND_SIGNATURE_ENCODINGS,
  type RuntimeInboundHashAlgorithm, type RuntimeInboundSignatureEncoding,
  type RuntimeInboundSignatureScheme,
} from "@openshapeforge/plugin-runtime";

/** The host ceiling on a delivery body. A registration may only lower it. */
export const INBOUND_MAX_BODY_BYTES = 256 * 1024;

/** Longest header value considered at all; a digest plus prefix is far shorter. */
export const INBOUND_MAX_SIGNATURE_HEADER_BYTES = 512;

/** Digest length per admitted algorithm, in bytes. */
const DIGEST_BYTES: Readonly<Record<RuntimeInboundHashAlgorithm, number>> = {
  sha256: 32,
  sha512: 64,
};

const HEADER_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const HEX = /^[0-9a-f]+$/i;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export function isInboundHashAlgorithm(value: unknown): value is RuntimeInboundHashAlgorithm {
  return typeof value === "string" && (RUNTIME_INBOUND_HASH_ALGORITHMS as readonly string[]).includes(value);
}

export function isInboundSignatureEncoding(value: unknown): value is RuntimeInboundSignatureEncoding {
  return typeof value === "string" && (RUNTIME_INBOUND_SIGNATURE_ENCODINGS as readonly string[]).includes(value);
}

/**
 * Validate a scheme before it is stored or used. Returns the normalised scheme
 * or `undefined`; callers decide whether that is a refusal to register or a
 * refusal to admit, and both are refusals.
 *
 * Header names are lowercased because that is how every HTTP/2 and Fastify
 * header arrives; a registration that spelled one with capitals would
 * otherwise look fine and match nothing.
 */
export function normalizeInboundSignatureScheme(
  scheme: RuntimeInboundSignatureScheme | undefined,
): RuntimeInboundSignatureScheme | undefined {
  if (!scheme || typeof scheme !== "object") return undefined;
  const header = typeof scheme.header === "string" ? scheme.header.trim().toLowerCase() : "";
  if (!HEADER_NAME.test(header)) return undefined;
  if (!isInboundHashAlgorithm(scheme.algorithm) || !isInboundSignatureEncoding(scheme.encoding)) return undefined;
  if (scheme.prefix !== undefined) {
    if (typeof scheme.prefix !== "string" || scheme.prefix.length > 32 || /[^\x21-\x7e]/.test(scheme.prefix)) {
      return undefined;
    }
  }
  return {
    header, algorithm: scheme.algorithm, encoding: scheme.encoding,
    ...(scheme.prefix ? { prefix: scheme.prefix } : {}),
  };
}

/** A header name a registration may read a delivery id or event name from. */
export function normalizeInboundHeaderName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const header = value.trim().toLowerCase();
  return HEADER_NAME.test(header) ? header : undefined;
}

/**
 * Decode the presented digest, or `undefined`.
 *
 * The prefix is compared as an exact literal rather than split on `=`: Jira
 * sends `sha256=<hex>`, and splitting would also accept `sha1=<hex>` or any
 * other label the provider never agreed to.
 */
export function parseInboundSignature(
  presented: string | undefined,
  scheme: RuntimeInboundSignatureScheme,
): Buffer | undefined {
  if (typeof presented !== "string") return undefined;
  if (Buffer.byteLength(presented, "utf8") > INBOUND_MAX_SIGNATURE_HEADER_BYTES) return undefined;
  const value = presented.trim();
  const prefix = scheme.prefix ?? "";
  if (!value.startsWith(prefix)) return undefined;
  const encoded = value.slice(prefix.length);
  if (encoded.length === 0) return undefined;
  const expected = DIGEST_BYTES[scheme.algorithm];
  if (scheme.encoding === "hex") {
    if (encoded.length !== expected * 2 || !HEX.test(encoded)) return undefined;
    return Buffer.from(encoded, "hex");
  }
  // Base64's own round trip is the shape check: Buffer.from ignores anything it
  // does not recognise, so a value with stray characters would silently decode
  // to a shorter digest that the length check alone would catch only sometimes.
  if (!BASE64.test(encoded)) return undefined;
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.byteLength !== expected || decoded.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "")) {
    return undefined;
  }
  return decoded;
}

export type InboundSignatureCheck = {
  scheme: RuntimeInboundSignatureScheme;
  /** The provider's shared secret, already decrypted by the host. */
  secret: string;
  /** The exact request bytes, unmodified and unparsed. */
  body: Uint8Array;
  /** The raw declared header value, exactly as received. */
  presented: string | undefined;
  /** The effective ceiling for this endpoint; never above the host's own. */
  maxBodyBytes?: number;
};

/**
 * Whether the delivery is genuine. False for every other case — no header, a
 * malformed digest, a body over the bound, an empty secret — with no
 * distinction between them, because the caller must not be able to report one.
 */
export function verifyInboundSignature(input: InboundSignatureCheck): boolean {
  const scheme = normalizeInboundSignatureScheme(input.scheme);
  if (!scheme) return false;
  if (typeof input.secret !== "string" || input.secret.length === 0) return false;
  if (!(input.body instanceof Uint8Array)) return false;
  const ceiling = Math.min(input.maxBodyBytes ?? INBOUND_MAX_BODY_BYTES, INBOUND_MAX_BODY_BYTES);
  if (input.body.byteLength > ceiling) return false;
  const presented = parseInboundSignature(input.presented, scheme);
  if (!presented) return false;
  const expected = createHmac(scheme.algorithm, input.secret).update(input.body).digest();
  // Lengths are equal by construction (parseInboundSignature enforced the
  // algorithm's digest length), which is what makes timingSafeEqual answerable.
  return expected.byteLength === presented.byteLength && timingSafeEqual(expected, presented);
}
