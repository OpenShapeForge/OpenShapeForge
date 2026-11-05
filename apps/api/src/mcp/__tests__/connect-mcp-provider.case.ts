// SPDX-License-Identifier: BUSL-1.1
import { beforeEach, expect, it, mock } from "bun:test";
import { HttpError } from "../../rest/http-error.js";
let allowed = true;
let found: any;
let invoked = 0;
mock.module("../catalog.js", () => ({ catalogDerivedTools: [{ connect: { name: "connect_service" }, execution: { providerTable: "integration.adapters" } }] }));
mock.module("../derived-tools.js", () => ({ derivedHelperAvailable: () => true, deriveToolName: (s: string) => s, derivedToolsFromRows: () => [] }));
mock.module("../execution-bindings.js", () => ({ loadOrderedBindings: async () => [] }));
mock.module("../catalog-rows.js", () => ({ serializeRow: (_table: any, row: any) => row }));
mock.module("../derived-session-tools.js", () => ({ DERIVED_TOOLS_ROW_LIMIT: 500 }));
mock.module("../session-connections.js", () => ({ runtimeRowByFilter: async () => found, runtimeBindingReader: () => ({}) }));
mock.module("../../operations/entity/index.js", () => ({ getGeneratedEntity: async () => { if (!allowed) throw new HttpError(403, "FORBIDDEN", "Denied"); return found; }, listGeneratedEntitiesForTable: async () => ({ rows: [] }) }));
mock.module("../dispatch-connect-provider.js", () => ({ connectProviderStep: async () => { invoked++; return { structuredContent: { action: "authorize" } }; } }));
mock.module("../tool-results.js", () => ({ ok: (value: any) => ({ structuredContent: value }), failed: (error: any) => ({ error: error.code }) }));
const { connectToolCall } = await import("../dispatch-connect-tool.js");
const ctx = (tool: string) => ({ name: "connect_service", db: {}, session: { tenantId: "tenant", userId: "user", roles: ["integration_admin"] }, tables: new Map(), request: { params: { arguments: { tool } } } }) as any;
beforeEach(() => { allowed = true; invoked = 0; found = { id: "adapter", discovery: "mcp", auth: { profile: "oauth2AuthorizationCode", connectionScope: "user" } }; });
it("connects an authorized MCP provider through the existing helper", async () => {
  expect(await connectToolCall(ctx("mcp:docs"))).toMatchObject({ structuredContent: { action: "authorize" } });
  expect(invoked).toBe(1);
});
it("does not bypass the provider's canonical read authorization", async () => {
  allowed = false;
  expect(await connectToolCall(ctx("mcp:docs"))).toMatchObject({ error: "FORBIDDEN" });
  expect(invoked).toBe(0);
});
it("rejects non-MCP and malformed provider identifiers", async () => {
  found.discovery = "openapi";
  expect(await connectToolCall(ctx("mcp:docs"))).toMatchObject({ error: "NOT_FOUND" });
  expect(await connectToolCall(ctx("mcp:../../bad"))).toMatchObject({ error: "VALIDATION" });
  expect(invoked).toBe(0);
});
