// SPDX-License-Identifier: BUSL-1.1
/** Serve the latest per-request protocol beside existing sessionful initialize clients. */
import { createMcpHandler, isLegacyRequest, type Server } from "@modelcontextprotocol/server";
import { toNodeHandler, toWebRequest, type NodeIncomingMessageLike } from "@modelcontextprotocol/node";
import type { FastifyReply, FastifyRequest } from "fastify";

/** Authentication has already run; a modern request never reuses an earlier principal. */
export async function handleModernMcpRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  buildServer: () => Server | Promise<Server>,
  releaseServer: (server: Server) => void = () => {},
): Promise<boolean> {
  const nodeRequest: NodeIncomingMessageLike = {
    method: request.method,
    url: request.raw.url ?? request.url,
    headers: request.headers,
    [Symbol.asyncIterator]: request.raw[Symbol.asyncIterator].bind(request.raw),
  };
  const probe = await toWebRequest(nodeRequest, request.body);
  if (await isLegacyRequest(probe, request.body)) return false;
  let server: Server | undefined;
  const handler = createMcpHandler(async () => {
    server = await buildServer();
    return server;
  }, { legacy: "reject" });
  reply.hijack();
  try {
    await toNodeHandler(handler)(nodeRequest, reply.raw, request.body);
  } finally {
    if (server) releaseServer(server);
    await handler.close();
  }
  return true;
}
