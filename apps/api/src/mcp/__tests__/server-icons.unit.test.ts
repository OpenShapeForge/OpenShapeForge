// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { Icon } from "@modelcontextprotocol/server";
import type { TrustedSessionContext } from "../../auth/trusted-context.js";
import type { RuntimeModule } from "../../modules/contract.js";
import type { ModulePlatformRuntime } from "../../modules/platform.js";
import { buildServer } from "../generated-mcp-server.js";
import { resolveServerIcons, validatedServerIcons } from "../server-icons.js";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAIAAABMXPacAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAARklEQVR4nO3BAQEAAACCIP+vbkhAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABA9wbAgAABWam+hQAAAABJRU5ErkJggg==";
const icon: Icon = { src: "data:image/png;base64," + PNG, mimeType: "image/png", sizes: ["128x128"] };
const session: TrustedSessionContext = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  userId: "22222222-2222-4222-8222-222222222222",
  roles: [], groups: [], scope: "self", credential: "bearer",
  issuer: "https://identity.example/realm",
};

describe("MCP initialize presentation", () => {
  test("uses only the active platform capability and allows one owning projection", async () => {
    const active = { ...session, roles: ["active-role"] };
    const services = {} as ModulePlatformRuntime["services"];
    let entered: TrustedSessionContext | undefined;
    const runtime = {
      services,
      async withActiveOperationSession(value: TrustedSessionContext, work: (active: TrustedSessionContext) => Promise<unknown>) {
        entered = value;
        return work(active);
      },
    } as unknown as ModulePlatformRuntime;
    const modules: RuntimeModule[] = [
      { name: "abstaining", mcp: { serverIcons: async () => undefined } },
      { name: "identity", mcp: { serverIcons: async (ctx) => {
        expect(ctx.session).toBe(active);
        expect(ctx.platform === services as unknown).toBe(true);
        return [icon];
      } } },
    ];
    expect(await resolveServerIcons(modules, runtime, session)).toEqual([icon]);
    expect(entered).toBe(session);
    await expect(resolveServerIcons([...modules, modules[1]!], runtime, session)).rejects.toThrow("Multiple modules");
    await expect(resolveServerIcons(modules, undefined, session)).rejects.toThrow("active platform capability");
    expect(await resolveServerIcons(undefined, undefined, session)).toBeUndefined();
  });

  test("rejects remote locations, incorrect MIME, oversized and mismatched PNG renditions", () => {
    for (const invalid of [
      { ...icon, src: "https://untrusted.example/image.png" },
      { ...icon, mimeType: "image/svg+xml" },
      { ...icon, sizes: ["512x512"] },
      { ...icon, src: icon.src + "\n" },
      { ...icon, src: "data:image/png;base64," + "A".repeat(256 * 1024) },
    ]) expect(() => validatedServerIcons([invalid])).toThrow();
    const mismatched = Buffer.from(PNG, "base64");
    mismatched.writeUInt32BE(1, 16);
    expect(() => validatedServerIcons([{ ...icon, src: "data:image/png;base64," + mismatched.toString("base64") }])).toThrow();
  });

  test("the actual SDK initialize response contains the projected icon without changing synchronous construction", async () => {
    const server = buildServer({} as never, session, undefined, undefined, undefined,
      undefined, false, new Map(), null, undefined, undefined, [icon]);
    const client = new Client({ name: "presentation-test", version: "1" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      expect(client.getServerVersion()).toMatchObject({ name: "openshapeforge", version: "1", icons: [icon] });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
