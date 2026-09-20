// SPDX-License-Identifier: BUSL-1.1
/**
 * What the browser-facing routes of the MCP plugin scope share with the
 * server that registers them: the Fastify scope, the registration options,
 * and the session admission used by the authenticated configuration API.
 * Split out of generated-mcp-server.ts.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import type { RuntimeModule } from "../modules/contract.js";
import type { ModulePlatformRuntime } from "../modules/platform.js";

export type McpRegistrationOptions = {
  db?: OpenShapeForgeDatabase | undefined;
  modules?: readonly RuntimeModule[];
  modulePlatform?: ModulePlatformRuntime;
  egressOwner?: RuntimeModule["egress"];
};

export type McpRouteContext = {
  instance: FastifyInstance;
  options: McpRegistrationOptions;
  requireMcpSession: (request: FastifyRequest) => Promise<{
    db: OpenShapeForgeDatabase;
    session: TrustedSessionContext;
    resource: string;
  }>;
};
