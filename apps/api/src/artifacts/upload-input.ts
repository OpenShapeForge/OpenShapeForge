// SPDX-License-Identifier: BUSL-1.1
/**
 * Input checks shared by both upload routes (`/api/artifacts` and the MCP
 * upload handoff).
 *
 * The upload routes hand the raw request stream to the storage provider, and
 * Fastify applies a route's `bodyLimit` only to bodies it parses itself — never
 * to a content-type parser that passes the payload through. So the limit is
 * enforced here: a declared length over it is refused before any byte is read,
 * and an undeclared (chunked) body stops at the first chunk past it.
 */
import { HttpError } from "../rest/http-error.js";

export const ARTIFACT_UPLOAD_LIMIT_BYTES = 64 * 1024 * 1024;

function tooLarge(): HttpError {
  return new HttpError(413, "ARTIFACT_TOO_LARGE", "The file exceeds the upload limit.");
}

export function limitUploadBody(
  source: AsyncIterable<Uint8Array>,
  declaredLength: string | string[] | undefined,
  limit = ARTIFACT_UPLOAD_LIMIT_BYTES,
): AsyncIterable<Uint8Array> {
  const declared = typeof declaredLength === "string" ? Number(declaredLength) : Number.NaN;
  if (Number.isFinite(declared) && declared > limit) throw tooLarge();
  return {
    async *[Symbol.asyncIterator]() {
      let received = 0;
      for await (const chunk of source) {
        received += chunk.byteLength;
        if (received > limit) throw tooLarge();
        yield chunk;
      }
    },
  };
}

/**
 * A stored file name is shown to every reader of the owning record, so it may
 * not carry line breaks (including U+2028/U+2029), path separators, control
 * characters other than tab, or bidi marks, overrides and isolates —
 * `invoice\u202Efdp.exe` would display as `invoiceexe.pdf`.
 */
const UNSAFE_FILE_NAME = /[\x00-\x08\x0a-\x1f\x7f-\x9f/\\\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

export function assertUploadFileName(name: string): void {
  if (!name || name.length > 255 || UNSAFE_FILE_NAME.test(name)) {
    throw new HttpError(400, "BAD_USER_INPUT", "The file name is invalid.");
  }
}
