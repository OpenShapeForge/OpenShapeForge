// SPDX-License-Identifier: BUSL-1.1
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
/** Compression alone may differ. Verify registry bytes and the entire bounded tar stream. */
export function samePublishedTar(candidate, published, integrity, maxOutputLength = 64 * 1024 * 1024) {
  if (`sha512-${createHash("sha512").update(published).digest("base64")}` !== integrity) return false;
  try { return gunzipSync(candidate, { maxOutputLength }).equals(gunzipSync(published, { maxOutputLength })); }
  catch { return false; }
}
