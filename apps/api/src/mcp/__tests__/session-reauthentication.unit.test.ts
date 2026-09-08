// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { TrustedSessionContext } from "../../auth/trusted-context.js";
import type { OpenShapeForgeDatabase } from "../../db/connection.js";
import { ModulePlatformRuntime } from "../../modules/platform.js";
import { __buildGeneratedMcpServerForTests } from "../generated-mcp-server.js";
import {
  REAUTHENTICATE_TOOL,
  __authenticationSessionForTests,
  canReauthenticate,
  reauthenticate,
  rememberAuthenticationSession,
} from "../session-reauthentication.js";

const session = (
  overrides: Partial<TrustedSessionContext> = {},
): TrustedSessionContext => ({
  tenantId: "11111111-1111-4111-8111-111111111111",
  userId: "22222222-2222-4222-8222-222222222222",
  roles: [],
  oauthScopes: ["openid", "offline_access"],
  groups: [],
  scope: "self",
  credential: "bearer",
  ...overrides,
});

const bearerHeaders = (claims: Record<string, unknown>): Headers => {
  const encoded = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return new Headers({
    authorization: `Bearer ${encoded({ alg: "RS256" })}.${encoded(claims)}.signature`,
  });
};

describe("reauthenticate tool contract", () => {
  it("advertises OAuth at the documented top level and compatibility metadata", () => {
    expect(REAUTHENTICATE_TOOL.securitySchemes).toEqual([
      { type: "oauth2", scopes: [] },
    ]);
    expect(REAUTHENTICATE_TOOL._meta?.securitySchemes).toEqual(
      REAUTHENTICATE_TOOL.securitySchemes,
    );
    expect(REAUTHENTICATE_TOOL.annotations?.destructiveHint).toBe(true);
  });

  it("keeps the verified bearer sid private and refuses non-bearer sessions", () => {
    const current = session();
    rememberAuthenticationSession(current, bearerHeaders({ sid: "current-session" }));
    expect(canReauthenticate(current)).toBe(true);
    expect(__authenticationSessionForTests(current)).toEqual({
      id: "current-session",
      offlineAccess: true,
    });

    const apiKey = session({ credential: "api-key" });
    rememberAuthenticationSession(apiKey, bearerHeaders({ sid: "must-not-be-read" }));
    expect(canReauthenticate(apiKey)).toBe(false);
  });

  it("revokes only the current sid and returns the tool-level OAuth challenge", async () => {
    const current = session();
    rememberAuthenticationSession(current, bearerHeaders({ sid: "current-session" }));
    const calls: Array<{ id: string; offline: boolean }> = [];
    let requested = 0;

    const result = await reauthenticate(
      current,
      'Bearer resource_metadata="https://mcp.example/.well-known/oauth-protected-resource"',
      () => { requested += 1; },
      {
        revoke: async (id, offline) => {
          calls.push({ id, offline });
          return true;
        },
      },
    );

    expect(calls).toEqual([
      { id: "current-session", offline: true },
      { id: "current-session", offline: false },
    ]);
    expect(requested).toBe(1);
    expect(result.isError).toBe(true);
    expect(result._meta?.["mcp/www_authenticate"]).toEqual([
      'Bearer resource_metadata="https://mcp.example/.well-known/oauth-protected-resource", ' +
        'error="invalid_token", error_description="The current sign-in was ended. Sign in again to continue."',
    ]);
    expect(JSON.stringify(result)).not.toContain("current-session");
  });

  it("does not emit a challenge when exact-session revocation fails", async () => {
    const current = session({ oauthScopes: ["openid"] });
    rememberAuthenticationSession(current, bearerHeaders({ session_state: "legacy-session" }));
    let requested = 0;

    await expect(
      reauthenticate(
        current,
        "Bearer resource_metadata=metadata",
        () => { requested += 1; },
        { revoke: async () => { throw new Error("contains-sensitive-upstream-path"); } },
      ),
    ).rejects.toMatchObject({
      status: 502,
      code: "REAUTHENTICATION_FAILED",
      message: "The identity provider could not end this sign-in. No other session was changed.",
    });
    expect(requested).toBe(0);
  });

  it("is listed and callable through the generated MCP server", async () => {
    const current = session();
    rememberAuthenticationSession(current, bearerHeaders({ sid: "transport-session" }));
    const db = {} as OpenShapeForgeDatabase;
    const platform = new ModulePlatformRuntime(db);
    let requested = 0;
    const server = __buildGeneratedMcpServerForTests({
      db,
      session: current,
      modules: [],
      modulePlatform: platform,
      tables: new Map(),
      reauthentication: {
        challenge: 'Bearer resource_metadata="https://mcp.example/metadata"',
        onRequested: () => { requested += 1; },
        dependencies: { revoke: async () => true },
      },
    });
    const client = new Client(
      { name: "reauthentication-test", version: "1" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const messages: unknown[] = [];
      const receive = clientTransport.onmessage;
      clientTransport.onmessage = (message, extra) => {
        messages.push(message);
        receive?.(message, extra);
      };
      expect((await client.listTools()).tools.map((tool) => tool.name)).toContain(
        "reauthenticate",
      );
      const rawList = messages.find(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          "result" in message &&
          Array.isArray((message as { result?: { tools?: unknown } }).result?.tools),
      ) as { result: { tools: Array<Record<string, unknown>> } } | undefined;
      expect(
        rawList?.result.tools.find((tool) => tool.name === "reauthenticate")
          ?.securitySchemes,
      ).toEqual([{ type: "oauth2", scopes: [] }]);
      const result = await client.callTool({ name: "reauthenticate", arguments: {} });
      expect(result.isError).toBe(true);
      expect(result._meta?.["mcp/www_authenticate"]).toEqual([
        'Bearer resource_metadata="https://mcp.example/metadata", error="invalid_token", ' +
          'error_description="The current sign-in was ended. Sign in again to continue."',
      ]);
      expect(requested).toBe(1);
    } finally {
      platform.unregisterServer(server);
      await client.close();
      await server.close();
    }
  });
});
