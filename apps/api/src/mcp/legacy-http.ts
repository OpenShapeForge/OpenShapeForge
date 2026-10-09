// SPDX-License-Identifier: BUSL-1.1
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { toNodeHandler, type NodeIncomingMessageLike, type NodeServerResponseLike } from "@modelcontextprotocol/node";
import type { IncomingMessage } from "node:http";

/** Fastify has already consumed the body; use the SDK's parsed-body adapter. */
export class FastifyStreamableHTTPServerTransport extends WebStandardStreamableHTTPServerTransport {
  async handleNodeRequest(
    request: IncomingMessage,
    response: NodeServerResponseLike,
    parsedBody?: unknown,
  ): Promise<void> {
    const incoming: NodeIncomingMessageLike = {
      ...(request.method ? { method: request.method } : {}),
      ...(request.url ? { url: request.url } : {}),
      headers: request.headers,
      [Symbol.asyncIterator]: request[Symbol.asyncIterator].bind(request),
    };
    await toNodeHandler({
      fetch: async (webRequest, options) => {
        const result = await this.handleRequest(webRequest, options);
        if (webRequest.method !== "GET" || !result.ok || !result.body ||
            !result.headers.get("content-type")?.startsWith("text/event-stream")) return result;
        // Wake the Node adapter's pending read on disconnect and cancel this
        // exact SDK stream. Refused GETs cannot evict an active connection.
        const reader = result.body.getReader();
        const disconnected = () => { void reader.cancel().catch(() => {}); };
        const cleanup = () => webRequest.signal.removeEventListener("abort", disconnected);
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            // Flush HTTP headers even when the notification stream is silent.
            controller.enqueue(new TextEncoder().encode(": connected\n\n"));
            webRequest.signal.addEventListener("abort", disconnected, { once: true });
            if (webRequest.signal.aborted) disconnected();
          },
          async pull(controller) {
            try {
              const next = await reader.read();
              if (next.done) { cleanup(); controller.close(); }
              else controller.enqueue(next.value);
            } catch (error) { cleanup(); controller.error(error); }
          },
          async cancel() { cleanup(); await reader.cancel(); },
        });
        return new Response(body, { status: result.status, statusText: result.statusText, headers: result.headers });
      },
    })(incoming, response, parsedBody);
  }
}
