// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { samePublishedTar } from "./published-tar.mjs";
const payload = Buffer.from("tar metadata and content ".repeat(100));
const published = gzipSync(payload, { level: 1 });
const integrity = `sha512-${createHash("sha512").update(published).digest("base64")}`;
test("accepts compression drift while retaining complete archive identity", () => {
  const candidate = gzipSync(payload, { level: 9 });
  expect(candidate.equals(published)).toBe(false);
  expect(samePublishedTar(candidate, published, integrity)).toBe(true);
});
test("refuses content or metadata drift, unauthenticated registry bytes and malformed archives", () => {
  expect(samePublishedTar(gzipSync(Buffer.from("changed tar metadata")), published, integrity)).toBe(false);
  expect(samePublishedTar(published, published, "sha512-wrong")).toBe(false);
  expect(samePublishedTar(Buffer.from("not gzip"), published, integrity)).toBe(false);
  expect(samePublishedTar(published, published, integrity, 10)).toBe(false);
});
