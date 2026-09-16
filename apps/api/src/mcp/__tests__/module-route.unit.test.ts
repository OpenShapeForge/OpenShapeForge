// SPDX-License-Identifier: BUSL-1.1
import { afterEach, describe, expect, it } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import type { RuntimeModule } from "../../modules/contract.js";
import {
  MCP_MOUNT_PATH,
  hasDynamicModuleToolProjection,
  hasMcpSurface,
  registerGeneratedMcpServer,
} from "../generated-mcp-server.js";

const opened: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((app) => app.close()));
});

describe("module-only MCP transport registration", () => {
  it("treats an MCP module as a sufficient surface with no core tools", () => {
    const module: RuntimeModule = { name: "module", mcp: {} };
    expect(hasMcpSurface([], { tools: 0, operationTools: 0, connectors: 0 })).toBe(false);
    expect(hasMcpSurface([module], { tools: 0, operationTools: 0, connectors: 0 })).toBe(true);
    expect(hasDynamicModuleToolProjection([{
      name: "decorator",
      mcp: { decorateTool: (tool) => tool },
    }])).toBe(true);
  });

  it("registers all methods on the canonical route for an MCP module", async () => {
    const app = Fastify();
    opened.push(app);
    registerGeneratedMcpServer(app, {
      modules: [{ name: "module", mcp: {} }],
    });
    await app.ready();
    for (const method of ["GET", "POST", "DELETE"] as const) {
      expect(app.hasRoute({ method, url: MCP_MOUNT_PATH })).toBe(true);
    }
  });
});
