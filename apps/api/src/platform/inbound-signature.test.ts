// SPDX-License-Identifier: BUSL-1.1
/**
 * The bounded HMAC verifier an unauthenticated stranger reaches.
 *
 * The cases that matter are the refusals: an absent header, a digest of the
 * wrong length, a prefix that names another algorithm, bytes that were
 * re-serialized on the way in, and a registration that tries to name a digest
 * outside the admitted set.
 */
import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import type { RuntimeInboundSignatureScheme } from "@openshapeforge/plugin-runtime";
import {
  INBOUND_MAX_BODY_BYTES, isInboundHashAlgorithm, normalizeInboundHeaderName,
  normalizeInboundSignatureScheme, parseInboundSignature, verifyInboundSignature,
} from "./inbound-signature.js";

const secret = "synthetic-unit-fixture-inbound-secret-0123456789";
/** Jira Cloud's admin webhook envelope. */
const jira: RuntimeInboundSignatureScheme = {
  header: "x-hub-signature", algorithm: "sha256", encoding: "hex", prefix: "sha256=",
};
/** Deliberately spelled with the whitespace a provider actually sends. */
const body = Buffer.from('{ "webhookEvent": "user_created", "user": { "accountId": "a1" } }');
const digest = (bytes: Uint8Array = body, algorithm: "sha256" | "sha512" = "sha256", key = secret) =>
  createHmac(algorithm, key).update(bytes).digest();
const hex = (...args: Parameters<typeof digest>) => `sha256=${digest(...args).toString("hex")}`;

test("the Jira envelope verifies the exact bytes and nothing adjacent", () => {
  expect(verifyInboundSignature({ scheme: jira, secret, body, presented: hex() })).toBe(true);
  // The same JSON VALUE, re-serialized compactly. This is the mistake the
  // route's raw-bytes parser exists to prevent: an equal object, a different
  // message, and a signature that must not verify.
  const reserialized = Buffer.from(JSON.stringify(JSON.parse(body.toString("utf8"))));
  expect(reserialized.equals(body)).toBe(false);
  expect(verifyInboundSignature({ scheme: jira, secret, body: reserialized, presented: hex() })).toBe(false);
  // Another tenant's secret over the same bytes.
  expect(verifyInboundSignature({ scheme: jira, secret, body, presented: hex(body, "sha256", `${secret}x`) })).toBe(false);
  // A body that is one byte longer.
  expect(verifyInboundSignature({ scheme: jira, secret, body: Buffer.concat([body, Buffer.from(" ")]), presented: hex() })).toBe(false);
});

test("an unsigned delivery is no proof rather than a weaker one", () => {
  for (const presented of [undefined, "", "   ", "sha256=", "not-a-signature"]) {
    expect(verifyInboundSignature({ scheme: jira, secret, body, presented })).toBe(false);
  }
});

test("the prefix is an exact literal, so another algorithm's label is refused", () => {
  const raw = digest().toString("hex");
  expect(verifyInboundSignature({ scheme: jira, secret, body, presented: `sha256=${raw}` })).toBe(true);
  expect(verifyInboundSignature({ scheme: jira, secret, body, presented: `sha1=${raw}` })).toBe(false);
  expect(verifyInboundSignature({ scheme: jira, secret, body, presented: raw })).toBe(false);
  expect(verifyInboundSignature({ scheme: jira, secret, body, presented: `SHA256=${raw}` })).toBe(false);
});

test("a digest of the wrong length is refused before any comparison", () => {
  const raw = digest().toString("hex");
  // A correct prefix of the correct digest: equal under any length-tolerant
  // comparison, and the reason the length check precedes timingSafeEqual.
  expect(parseInboundSignature(`sha256=${raw.slice(0, 32)}`, jira)).toBeUndefined();
  expect(parseInboundSignature(`sha256=${raw}00`, jira)).toBeUndefined();
  expect(parseInboundSignature(`sha256=${"z".repeat(64)}`, jira)).toBeUndefined();
  // A sha512 digest presented against a sha256 registration.
  expect(parseInboundSignature(`sha256=${digest(body, "sha512").toString("hex")}`, jira)).toBeUndefined();
  expect(parseInboundSignature(`sha256=${raw}`, jira)?.toString("hex")).toBe(raw);
});

test("base64 and sha512 envelopes verify, and a malformed base64 digest does not", () => {
  const scheme: RuntimeInboundSignatureScheme = { header: "x-signature", algorithm: "sha512", encoding: "base64" };
  const expected = digest(body, "sha512").toString("base64");
  expect(verifyInboundSignature({ scheme, secret, body, presented: expected })).toBe(true);
  expect(verifyInboundSignature({ scheme, secret, body, presented: `${expected.slice(0, -4)}!!!!` })).toBe(false);
  expect(verifyInboundSignature({ scheme, secret, body, presented: expected.slice(0, 20) })).toBe(false);
  // A hex digest presented to a base64 registration.
  expect(verifyInboundSignature({
    scheme, secret, body, presented: digest(body, "sha512").toString("hex"),
  })).toBe(false);
});

test("the body bound is enforced before hashing, and an endpoint may only lower it", () => {
  const large = Buffer.alloc(INBOUND_MAX_BODY_BYTES + 1, 7);
  expect(verifyInboundSignature({ scheme: jira, secret, body: large, presented: hex(large) })).toBe(false);
  const small = Buffer.alloc(64, 7);
  expect(verifyInboundSignature({ scheme: jira, secret, body: small, presented: hex(small), maxBodyBytes: 64 })).toBe(true);
  expect(verifyInboundSignature({ scheme: jira, secret, body: small, presented: hex(small), maxBodyBytes: 32 })).toBe(false);
  // A registration cannot raise the host's ceiling by asking for more.
  const beyond = Buffer.alloc(INBOUND_MAX_BODY_BYTES + 1, 7);
  expect(verifyInboundSignature({
    scheme: jira, secret, body: beyond, presented: hex(beyond), maxBodyBytes: INBOUND_MAX_BODY_BYTES * 4,
  })).toBe(false);
});

test("the admitted algorithm set is closed, so a registration cannot downgrade itself", () => {
  for (const algorithm of ["md5", "sha1", "sha224", "SHA256", "", "blake2b512"]) {
    expect(isInboundHashAlgorithm(algorithm)).toBe(false);
    expect(normalizeInboundSignatureScheme({
      ...jira, algorithm: algorithm as RuntimeInboundSignatureScheme["algorithm"],
    })).toBeUndefined();
  }
  for (const algorithm of ["sha256", "sha512"] as const) {
    expect(normalizeInboundSignatureScheme({ ...jira, algorithm })?.algorithm).toBe(algorithm);
  }
});

test("a scheme is normalised to the lowercase header names HTTP actually delivers", () => {
  expect(normalizeInboundSignatureScheme({ ...jira, header: "X-Hub-Signature" })?.header).toBe("x-hub-signature");
  expect(normalizeInboundHeaderName("X-Atlassian-Webhook-Identifier")).toBe("x-atlassian-webhook-identifier");
  for (const header of ["", " ", "has space", "-leading", "a".repeat(64), "has:colon"]) {
    expect(normalizeInboundSignatureScheme({ ...jira, header })).toBeUndefined();
    expect(normalizeInboundHeaderName(header)).toBeUndefined();
  }
  expect(normalizeInboundSignatureScheme({ ...jira, encoding: "base32" as "hex" })).toBeUndefined();
  expect(normalizeInboundSignatureScheme({ ...jira, prefix: "x".repeat(33) })).toBeUndefined();
  expect(normalizeInboundSignatureScheme(undefined)).toBeUndefined();
});

test("an empty secret never verifies, however well-formed the digest is", () => {
  expect(verifyInboundSignature({ scheme: jira, secret: "", body, presented: hex(body, "sha256", "") })).toBe(false);
});
