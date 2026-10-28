// SPDX-License-Identifier: BUSL-1.1
import { HttpError } from "../rest/http-error.js";

/** Enforce a byte budget while consuming, before decoding or parsing a provider body. */
export async function readBoundedResponse(response: Response, maxBytes = 20 * 1024 * 1024): Promise<string> {
  const oversized = () => new HttpError(502, "PROVIDER_RESPONSE_TOO_LARGE", "Provider response exceeds the supported size.");
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw oversized();
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw oversized();
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return new TextDecoder().decode(bytes);
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

/** Production credentials and browser authorization redirects require TLS. */
export function assertOutboundTls(url: URL, production = process.env.NODE_ENV === "production"): void {
  if (url.protocol !== "https:" && (url.protocol !== "http:" || production)) {
    throw new HttpError(403, "EGRESS_DENIED", "Outbound production endpoints require HTTPS.");
  }
}
