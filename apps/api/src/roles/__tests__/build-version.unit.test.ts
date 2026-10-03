// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createApiApp } from "../api.js";
import { API_BUILD_IDENTITY } from "../../config/build-identity.js";
import { __buildGeneratedMcpServerForTests } from "../../mcp/generated-mcp-server.js";
import { __buildPlatformServerForTests } from "../../mcp/control-mcp-server.js";
import { ModulePlatformRuntime } from "../../modules/platform.js";
import type { OpenShapeForgeDatabase } from "../../db/connection.js";

test("API health, OpenAPI and GraphQL responses identify the same running software", async () => {
  const app = createApiApp({ cors: false });
  try {
    const health = await app.inject("/api/health");
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject(API_BUILD_IDENTITY);
    const spec = await app.inject("/api/rest/openapi.json");
    expect(spec.statusCode).toBe(200);
    expect(spec.json().info.version).toBe(API_BUILD_IDENTITY.version);
    const graphql = await app.inject("/api/graphql?query=%7B__typename%7D");
    expect(graphql.headers["x-software-version"]).toBe(API_BUILD_IDENTITY.version);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const response = await fetch(`${address}/api/health`, {
      headers: { "x-software-version": "untrusted-client-value" },
      redirect: "error", signal: AbortSignal.timeout(10_000),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-software-version")).toBe(API_BUILD_IDENTITY.version);
    expect(await response.json()).toMatchObject(API_BUILD_IDENTITY);
  } finally {
    await app.close();
  }
});

test("tenant and platform MCP initialize advertise the running software version", async () => {
  const db = {} as OpenShapeForgeDatabase;
  const platform = new ModulePlatformRuntime(db);
  const tenant = __buildGeneratedMcpServerForTests({ db, modulePlatform: platform, modules: [],
    session: { tenantId: "11111111-1111-4111-8111-111111111111", userId: "22222222-2222-4222-8222-222222222222",
      roles: [], groups: [], scope: "self", credential: "trusted-context" } as never });
  const control = __buildPlatformServerForTests({ context: { db }, operations: [],
    session: { operator: { userId: "operator", displayName: "Version test" } } as never });
  for (const server of [tenant, control]) {
    const client = new Client({ name: "version-test", version: "1" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      expect(client.getServerVersion()?.version).toBe(API_BUILD_IDENTITY.version);
    } finally {
      platform.unregisterServer(server);
      await client.close();
      await server.close();
    }
  }
});
