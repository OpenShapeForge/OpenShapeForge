// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import { packageTarballsHaveSameContents } from "./package-tarball-equivalence.mjs";

test("package identity ignores compression while retaining every tar byte", () => {
  const archive = Buffer.from("synthetic tar content".repeat(100));
  const fast = gzipSync(archive, { level: 1 });
  const small = gzipSync(archive, { level: 9 });
  expect(fast.equals(small)).toBe(false);
  expect(packageTarballsHaveSameContents(fast, small)).toBe(true);
  expect(packageTarballsHaveSameContents(fast, gzipSync(Buffer.concat([archive, Buffer.from("changed file")])))).toBe(false);
  expect(() => packageTarballsHaveSameContents(fast, Buffer.from("invalid gzip"))).toThrow();
});
