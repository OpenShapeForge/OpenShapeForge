// SPDX-License-Identifier: BUSL-1.1
import { gunzipSync } from "node:zlib";

/** Compression differences must not masquerade as changed immutable package contents. */
export function packageTarballsHaveSameContents(left, right) {
  const options = { maxOutputLength: 64 * 1024 * 1024 };
  return gunzipSync(left, options).equals(gunzipSync(right, options));
}
