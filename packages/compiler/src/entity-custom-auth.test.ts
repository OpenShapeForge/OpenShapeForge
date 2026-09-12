// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import schema from "../config/schemas/core-entity.schema.json" with { type: "json" };
import { collectAuthoredEntityPluginOperations, operationOpenApiPaths } from "./generate-operations.js";

const auth = {
  mode: "custom" as const, scheme: "RecipientToken",
  description: "The handler verifies a recipient capability before resolving its tenant.",
  securityScheme: { type: "http" as const, scheme: "bearer", bearerFormat: "Recipient capability" },
};
const definition = {
  id: "example.recipient.read", name: "Read recipient view", description: "Read the capability-bound view.",
  implementation: { type: "plugin", plugin: "example", handler: "recipientRead" },
  target: { scope: "collection" },
  input: { schema: { type: "object", additionalProperties: false } },
  output: { schema: { type: "object" } }, errors: [], auth,
  tenancy: { mode: "derived", description: "Resolved only after capability verification." },
  effects: { data: "read", external: "none" },
  reliability: { idempotency: { mode: "natural" } }, confirmation: { mode: "none" },
};
function compile(projections: Record<string, unknown> = {}) {
  return collectAuthoredEntityPluginOperations([{
    contract: { pluginOperations: [{ key: "recipientRead", id: definition.id,
      entityId: "example.Record", entityName: "Record", definition,
      interfaces: { rest: { method: "GET", path: "/api/example/recipient" }, ...projections },
    }] },
  }] as never, { repoRoot: "/example", authoringDir: "/example/authoring", webPresent: false });
}

test("strict YAML accepts existing custom HTTP and API-key authentication without changing its contract", () => {
  const valid = new Ajv2020({ strict: false }).compile(schema.$defs.operationAuthV2);
  expect(valid(auth)).toBe(true);
  expect(valid({ ...auth, securityScheme: { type: "apiKey", in: "header", name: "X-Recipient-Capability" } })).toBe(true);
  expect(valid({ ...auth, scheme: "invalid scheme" })).toBe(false);
  expect(valid({ ...auth, securityScheme: { type: "http" } })).toBe(false);
  expect(valid({ ...auth, roles: ["administrator"] })).toBe(false);
});

test("custom auth stays REST-only and its security requirement reaches OpenAPI", () => {
  const compiled = compile();
  expect(compiled[0]!.auth).toEqual(auth);
  expect(compiled[0]!.transports.mcp.enabled).toBe(false);
  expect(compiled[0]!.transports.graphql.enabled).toBe(false);
  const paths = operationOpenApiPaths(compiled) as Record<string, { get: { security: unknown } }>;
  expect(paths["/api/example/recipient"]!.get.security).toEqual([{ RecipientToken: [] }]);
  expect(() => compile({ mcp: {} })).toThrow("custom auth can only project to REST");
  expect(() => compile({ graphql: {} })).toThrow("custom auth can only project to REST");
});
