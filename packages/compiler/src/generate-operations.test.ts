// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import type { CompilerPlugin, PluginOperationContract } from "./plugins.js";
import { renderOpenApiSpec } from "./generate-openapi.js";
import {
  auditOperationSurfaceCollisions,
  assertOperationRuntimeModules,
  collectPluginOperations,
  operationOpenApiPaths,
  renderOperationCatalog,
} from "./generate-operations.js";
import type { PlatformSchemaManifest } from "./schema.js";

const operation: PluginOperationContract = {
  key: "demo.quote.publish",
  title: "Publish quote",
  description: "Publishes an immutable quote snapshot.",
  handler: "publishQuote",
  inputSchema: {
    type: "object",
    required: ["quoteId", "idempotencyKey"],
    properties: {
      quoteId: { type: "string", format: "uuid" },
      idempotencyKey: { type: "string", minLength: 1 },
    },
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string", format: "uuid" } },
    additionalProperties: false,
  },
  errors: [{ status: 409, code: "CONFLICT", description: "Quote is not publishable" }],
  auth: { mode: "session", roles: ["seller"], scopes: ["quotes:write"] },
  tenancy: { mode: "required" },
  idempotency: { mode: "idempotency-key", header: "Idempotency-Key", inputField: "idempotencyKey" },
  transports: {
    rest: { method: "POST", path: "/api/demo/quotes/:quoteId/publish", response: { status: 202, kind: "json" } },
    mcp: { enabled: true, name: "demo_publish_quote" },
    graphql: { enabled: true, kind: "mutation", field: "demoPublishQuote" },
    typescript: { enabled: true, functionName: "publishQuote" },
  },
};

const context = { repoRoot: "/repo", authoringDir: "/repo/authoring", webPresent: false };

describe("first-class plugin operations", () => {
  test("collects deterministic canonical contracts and OpenAPI path parameters", () => {
    const plugins: CompilerPlugin[] = [{ name: "demo", operations: [operation] }];
    const collected = collectPluginOperations(plugins, context);
    expect(JSON.parse(renderOperationCatalog(collected)).operations[0].key).toBe(operation.key);
    const paths = operationOpenApiPaths(collected) as Record<string, Record<string, any>>;
    expect(paths["/api/demo/quotes/{quoteId}/publish"]!.post.operationId).toBe(operation.key);
    expect(paths["/api/demo/quotes/{quoteId}/publish"]!.post.responses["202"]).toBeDefined();
    expect(paths["/api/demo/quotes/{quoteId}/publish"]!.post.parameters[0]).toMatchObject({
      name: "quoteId",
      in: "path",
      required: true,
    });
    expect(paths["/api/demo/quotes/{quoteId}/publish"]!.post.parameters[1]).toMatchObject({
      name: "Idempotency-Key",
      in: "header",
      required: true,
    });
    expect(paths["/api/demo/quotes/{quoteId}/publish"]!.post.requestBody.content["application/json"].schema.properties)
      .not.toHaveProperty("idempotencyKey");
    expect(paths["/api/demo/quotes/{quoteId}/publish"]!.post.requestBody.content["application/json"].schema)
      .not.toHaveProperty("required");
  });

  test("keeps REST idempotency exclusively in the header for query operations", () => {
    const queryOperation: PluginOperationContract = {
      ...operation,
      inputSchema: {
        type: "object",
        required: ["quoteId", "limit", "idempotencyKey"],
        properties: {
          quoteId: { type: "string", format: "uuid" },
          limit: { type: "integer", minimum: 1 },
          idempotencyKey: { type: "string", minLength: 1 },
        },
        additionalProperties: false,
      },
      transports: {
        ...operation.transports,
        rest: { ...operation.transports.rest, method: "DELETE" },
      },
    };
    const paths = operationOpenApiPaths(
      collectPluginOperations([{ name: "demo", operations: [queryOperation] }], context),
    ) as Record<string, Record<string, any>>;
    const parameters = paths["/api/demo/quotes/{quoteId}/publish"]!.delete.parameters;
    expect(parameters.filter((parameter: any) => parameter.name === "idempotencyKey")).toHaveLength(0);
    expect(parameters).toContainEqual(expect.objectContaining({ name: "Idempotency-Key", in: "header", required: true }));
    expect(parameters).toContainEqual(expect.objectContaining({ name: "limit", in: "query", required: true }));
  });

  test("refuses duplicate routes and dishonest binary projections", () => {
    expect(() => collectPluginOperations([
      { name: "demo", operations: [operation, { ...operation, key: "demo.quote.send" }] },
    ], context)).toThrow(/Duplicate plugin operation REST route/);
    expect(() => collectPluginOperations([{ name: "demo", operations: [{
      ...operation,
      transports: {
        ...operation.transports,
        rest: { ...operation.transports.rest, response: { kind: "binary" } },
      },
    }] }], context)).toThrow(/binary responses cannot project/);
  });

  test("requires explicit disabled reasons for custom auth projections", () => {
    expect(() => collectPluginOperations([{ name: "demo", operations: [{
      ...operation,
      auth: {
        mode: "custom",
        scheme: "Signing",
        description: "Buyer signing token",
        securityScheme: { type: "apiKey", in: "header", name: "X-Signing-Token" },
      },
    }] }], context)).toThrow(/custom auth can only project to REST/);
  });

  test("requires an honest auth and client projection contract", () => {
    expect(() => collectPluginOperations([{ name: "demo", operations: [{
      ...operation,
      auth: { mode: "public" },
    }] }], context)).toThrow(/public operations cannot project to the authenticated MCP endpoint/);

    const withoutTypescript = {
      ...operation,
      transports: { ...operation.transports, typescript: undefined },
    } as unknown as PluginOperationContract;
    expect(() => collectPluginOperations([
      { name: "demo", operations: [withoutTypescript] },
    ], context)).toThrow(/explicit TypeScript projection or disabled reason/);
  });

  test("rejects conflicting definitions for a reused custom security scheme", () => {
    const custom = (key: string, name: string, path: string): PluginOperationContract => ({
      ...operation,
      key: `demo.${key}`,
      auth: {
        mode: "custom",
        scheme: "Signing",
        description: "Buyer signing token",
        securityScheme: { type: "apiKey", in: "header", name },
      },
      transports: {
        ...operation.transports,
        rest: { ...operation.transports.rest, path },
        mcp: { enabled: false, reason: "The MCP endpoint uses authenticated sessions." },
        graphql: { enabled: false, reason: "The GraphQL endpoint uses authenticated sessions." },
        typescript: { enabled: true, functionName: key.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase()) },
      },
    });
    expect(() => collectPluginOperations([{ name: "demo", operations: [
      custom("sign-one", "X-Signing-Token", "/api/demo/sign-one"),
      custom("sign-two", "X-Other-Token", "/api/demo/sign-two"),
    ] }], context)).toThrow(/conflicting custom security scheme/);
  });

  test("renders the declared custom OpenAPI security scheme exactly", () => {
    const custom: PluginOperationContract = {
      ...operation,
      auth: {
        mode: "custom",
        scheme: "Signing",
        description: "Buyer signing token",
        securityScheme: { type: "apiKey", in: "cookie", name: "quote_signing" },
      },
      transports: {
        ...operation.transports,
        mcp: { enabled: false, reason: "The MCP endpoint uses authenticated sessions." },
        graphql: { enabled: false, reason: "The GraphQL endpoint uses authenticated sessions." },
      },
    };
    const compiled = collectPluginOperations([{ name: "demo", operations: [custom] }], context);
    const spec = JSON.parse(renderOpenApiSpec({ version: 1, tables: [] }, "fixture", {
      operations: compiled,
    })) as any;

    expect(spec.components.securitySchemes.Signing).toEqual({
      description: "Buyer signing token",
      type: "apiKey",
      in: "cookie",
      name: "quote_signing",
    });
    expect(spec.paths["/api/demo/quotes/{quoteId}/publish"].post.security).toEqual([
      { Signing: [] },
    ]);
  });

  test("fails compilation when an operation plugin has no runtime module", () => {
    const collected = collectPluginOperations([{ name: "demo", operations: [operation] }], context);
    expect(() => assertOperationRuntimeModules(collected, [])).toThrow(/runtime module that is not registered: demo/);
    expect(() => assertOperationRuntimeModules(collected, ["demo"])).not.toThrow();
  });

  test("requires safe plugin-owned paths and declared path parameters", () => {
    expect(() => collectPluginOperations([{ name: "demo", operations: [{
      ...operation,
      transports: {
        ...operation.transports,
        rest: { ...operation.transports.rest, path: "/api/admin/escape" },
      },
    }] }], context)).toThrow(/safe \/api\/demo\/ path/);
    expect(() => collectPluginOperations([{ name: "demo", operations: [{
      ...operation,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    }] }], context)).toThrow(/path parameter "quoteId" must be a required/);
    for (const reserved of ["api-keys", "documents", "health"]) {
      expect(() => collectPluginOperations([{ name: reserved, operations: [{
        ...operation,
        key: `${reserved}.quote.publish`,
        transports: {
          ...operation.transports,
          rest: { ...operation.transports.rest, path: `/api/${reserved}/quotes/:quoteId/publish` },
        },
      }] }], context)).toThrow(/reserved API namespace/);
    }
  });

  test("rejects duplicate or invalid generated TypeScript function names", () => {
    expect(() => collectPluginOperations([{ name: "demo", operations: [{
      ...operation,
      transports: { ...operation.transports, typescript: { enabled: true, functionName: "not-valid" } },
    }] }], context)).toThrow(/invalid TypeScript function name/);
    expect(() => collectPluginOperations([{ name: "demo", operations: [
      operation,
      {
        ...operation,
        key: "demo.quote.cancel",
        transports: {
          ...operation.transports,
          rest: { ...operation.transports.rest, path: "/api/demo/quotes/:quoteId/cancel" },
          mcp: { enabled: false, reason: "Not exposed in this fixture." },
          graphql: { enabled: false, reason: "Not exposed in this fixture." },
        },
      },
    ] }], context)).toThrow(/Duplicate plugin operation TypeScript function/);
  });

  test("refuses collisions with existing entity GraphQL and MCP surfaces", () => {
    const manifest: PlatformSchemaManifest = {
      version: 1,
      tables: [{
        schema: "demo",
        name: "quotes",
        tenantScoped: true,
        generatedCrud: true,
        columns: [{ name: "id", type: "uuid", primaryKey: true }],
        source: {
          graphql: {
            typeName: "Quote",
            singleQueryName: "quote",
            listQueryName: "quotes",
            createMutationName: "demoPublishQuote",
            updateMutationName: "updateQuote",
            deleteMutationName: "deleteQuote",
            relationships: [],
          },
          mcp: {
            toolPrefix: "demo_publish",
            tools: "dedicated",
            operations: { list: false, get: false, create: true, update: false, delete: false },
          },
        },
      }],
    };
    const collected = collectPluginOperations([{ name: "demo", operations: [operation] }], context);
    expect(() => auditOperationSurfaceCollisions(collected, manifest, [], 60)).toThrow(/GraphQL root field/);
    manifest.tables[0]!.source!.graphql!.createMutationName = "createQuote";
    if (collected[0]!.transports.mcp.enabled) collected[0]!.transports.mcp.name = "demo_publish_create";
    expect(() => auditOperationSurfaceCollisions(collected, manifest, [], 60)).toThrow(/MCP tool/);
  });
});
