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
      fetch: (webRequest, options) => this.handleRequest(webRequest, options),
    })(incoming, response, parsedBody);
  }
}
