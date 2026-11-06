// SPDX-License-Identifier: BUSL-1.1
/** Server-only host transport. Never exported from the browser entry point. */
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import { once } from "node:events";

export const hopByHopHeaders = [
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade",
] as const;
const httpToken = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export function stripHopByHopHeaders(headers: Headers): Headers {
  const nominated = (headers.get("connection") ?? "").split(",")
    .map(name => name.trim().toLowerCase()).filter(name => httpToken.test(name));
  for (const header of [...hopByHopHeaders, ...nominated]) headers.delete(header);
  return headers;
}

/** Stream with backpressure on a dedicated socket, including early API refusals.
 * Hosts retain ownership of routing and trusted forwarding/header policy.
 */
export async function forwardRuntimeRequest(request: Request, upstream: URL, options: {
  maxBodyBytes?: number;
  headers?: Headers;
} = {}): Promise<Response> {
  const maxBodyBytes = options.maxBodyBytes ?? 12 * 1024 * 1024;
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 0) throw new Error("Invalid proxy body limit.");
  const tooLarge = () => new Response("Request body too large.", { status: 413 });
  const headers = stripHopByHopHeaders(new Headers(options.headers ?? request.headers));
  const length = headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))) {
    void request.body?.cancel().catch(() => undefined);
    return new Response("Invalid content length.", { status: 400 });
  }
  if (length !== null && Number(length) > maxBodyBytes) {
    void request.body?.cancel().catch(() => undefined);
    return tooLarge();
  }
  headers.set("host", new URL(request.url).host);
  const forwardedHeaders: IncomingHttpHeaders = Object.fromEntries(headers);
  const send = upstream.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise<Response>((resolve, reject) => {
    const reader = !["GET", "HEAD"].includes(request.method) ? request.body?.getReader() : undefined;
    const upload = new AbortController();
    let stopped = false;
    const stopInput = () => {
      stopped = true;
      upload.abort();
      void reader?.cancel().catch(() => undefined);
    };
    const forwarded = send(upstream, {
      method: request.method, headers: forwardedHeaders, agent: false, signal: request.signal,
    }, response => {
      stopInput();
      if (!forwarded.writableEnded) forwarded.end();
      const responseHeaders = new Headers();
      for (let i = 0; i < response.rawHeaders.length; i += 2) {
        responseHeaders.append(response.rawHeaders[i]!, response.rawHeaders[i + 1]!);
      }
      const status = response.statusCode ?? 502;
      const noBody = request.method === "HEAD" || [204, 205, 304].includes(status);
      if (noBody) response.resume();
      resolve(new Response(noBody ? null : Readable.toWeb(response) as unknown as ReadableStream<Uint8Array>, {
        status, headers: stripHopByHopHeaders(responseHeaders),
      }));
    });
    forwarded.once("error", error => { stopInput(); reject(error); });
    // Let the API authenticate before the caller has finished uploading.
    forwarded.flushHeaders();
    void (async () => {
      let received = 0;
      while (reader && !stopped) {
        const { value, done } = await reader.read();
        if (done || stopped) break;
        received += value.byteLength;
        if (received > maxBodyBytes) {
          stopInput();
          resolve(tooLarge());
          forwarded.destroy();
          return;
        }
        if (!forwarded.write(value)) await once(forwarded, "drain", { signal: AbortSignal.any([request.signal, upload.signal]) });
      }
      if (!stopped) forwarded.end();
    })().catch(error => { if (!stopped) { stopInput(); forwarded.destroy(error); reject(error); } });
  });
}
