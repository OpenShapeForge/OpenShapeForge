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
    const aliased = {
      ...operation,
      transports: {
        ...operation.transports,
        rest: {
          ...operation.transports.rest,
          aliases: ["/api/rest/v1/legacy-quotes/:quoteId/publish"],
        },
      },
    };
    const plugins: CompilerPlugin[] = [{ name: "demo", operations: [aliased] }];
    const collected = collectPluginOperations(plugins, context);
    expect(JSON.parse(renderOperationCatalog(collected)).operations[0].key).toBe(operation.key);
    expect(collected).toHaveLength(1);
    const paths = operationOpenApiPaths(collected) as Record<string, Record<string, any>>;
    const canonical = paths["/api/demo/quotes/{quoteId}/publish"]!.post;
    const alias = paths["/api/rest/v1/legacy-quotes/{quoteId}/publish"]!.post;
    expect(canonical.operationId).toBe(operation.key);
    expect(canonical.responses["202"]).toBeDefined();
    expect(canonical.parameters[0]).toMatchObject({
      name: "quoteId",
      in: "path",
      required: true,
    });
    expect(canonical.parameters[1]).toMatchObject({
      name: "Idempotency-Key",
      in: "header",
      required: true,
    });
    expect(canonical.requestBody.content["application/json"].schema.properties)
      .not.toHaveProperty("idempotencyKey");
    expect(canonical.requestBody.content["application/json"].schema)
      .not.toHaveProperty("required");
    expect(alias).toMatchObject({
      deprecated: true,
      "x-osf-rest-alias": {
        canonicalOperationId: operation.key,
        canonicalPath: "/api/demo/quotes/{quoteId}/publish",
      },
    });
    expect(alias.operationId).not.toBe(operation.key);
    expect(alias.parameters).toEqual(canonical.parameters);
    expect(alias.requestBody).toEqual(canonical.requestBody);
    expect(alias.responses).toEqual(canonical.responses);
  });

  test("validates and documents REST projections for declared errors", () => {
    const represented: PluginOperationContract = {
      ...operation,
      errors: [{
        status: 409,
        code: "CONFLICT",
        description: "Quote is not publishable",
        schema: {
          type: "object",
          required: ["error"],
          properties: { error: { const: "conflict" } },
          additionalProperties: false,
        },
        rest: {
          body: { error: "conflict" },
          contentType: "application/problem+json",
        },
      }],
    };
    const collected = collectPluginOperations(
      [{ name: "demo", operations: [represented] }],
      context,
    );
    const paths = operationOpenApiPaths(collected) as Record<string, Record<string, any>>;
    expect(paths["/api/demo/quotes/{quoteId}/publish"]!.post.responses["409"])
      .toMatchObject({
        content: {
          "application/problem+json": {
            schema: represented.errors[0]!.schema,
            example: { error: "conflict" },
          },
        },
      });

    const dynamic = {
      ...represented,
      errors: [{
        ...represented.errors[0]!,
        rest: { contentType: "application/problem+json" },
      }],
    };
    const dynamicPaths = operationOpenApiPaths(
      collectPluginOperations([{ name: "demo", operations: [dynamic] }], context),
    ) as Record<string, Record<string, any>>;
    expect(dynamicPaths["/api/demo/quotes/{quoteId}/publish"]!.post.responses["409"])
      .toEqual({
        description: "Quote is not publishable",
        content: {
          "application/problem+json": { schema: represented.errors[0]!.schema },
        },
      });

    expect(() => collectPluginOperations([{ name: "demo", operations: [{
      ...represented,
      errors: [{ ...represented.errors[0]!, rest: { body: { error: "other" } } }],
    }] }], context)).toThrow(/fixed REST body does not match/);
    expect(() => collectPluginOperations([{ name: "demo", operations: [{
      ...operation,
      errors: [{
        status: 409,
        code: "CONFLICT",
        description: "Quote is not publishable",
        rest: { body: { error: { code: "OTHER", message: "Conflict." } } },
      }],
    }] }], context)).toThrow(/must carry the same error.code/);
    expect(() => collectPluginOperations([{ name: "demo", operations: [{
      ...operation,
      errors: [{
        status: 409,
        code: "CONFLICT",
        description: "Quote is not publishable",
        schema: {},
        rest: { body: Number.NaN },
      }],
    }] }], context)).toThrow(/must be a JSON value/);
    expect(() => collectPluginOperations([{ name: "demo", operations: [{
      ...represented,
      errors: [{
        ...represented.errors[0]!,
        rest: { contentType: "text/plain" },
      }],
    }] }], context)).toThrow(/must be a JSON media type/);
    for (const contentType of [
      "application/json; charset=iso-8859-1",
      "application/json; charset=utf-8",
      "application/json\r\nx-unsafe: value",
    ]) {
      expect(() => collectPluginOperations([{ name: "demo", operations: [{
        ...represented,
        errors: [{
          ...represented.errors[0]!,
          rest: { contentType },
        }],
      }] }], context)).toThrow(/must be a JSON media type/);
    }
  });

  test("documents multiple error codes at one status without changing single-error output", () => {
    const single = operationOpenApiPaths(
      collectPluginOperations([{ name: "demo", operations: [operation] }], context),
    ) as Record<string, Record<string, any>>;
    expect(JSON.stringify(single["/api/demo/quotes/{quoteId}/publish"]!.post.responses["409"]))
      .toBe(
        '{"description":"Quote is not publishable","content":{"application/json":{"schema":{"$ref":"#/components/schemas/Error"}}}}',
      );

    const errors = [
      {
        status: 503,
        code: "SERVICE_UNAVAILABLE",
        description: "The service is temporarily unavailable.",
      },
      {
        status: 503,
        code: "AUTHENTICATION_UNAVAILABLE",
        description: "Authentication is temporarily unavailable.",
      },
    ];
    const shared = (declaredErrors: typeof errors) => {
      const compiled = collectPluginOperations([{ name: "demo", operations: [{
        ...operation,
        errors: declaredErrors,
      }] }], context);
      const paths = operationOpenApiPaths(compiled) as Record<string, Record<string, any>>;
      return paths["/api/demo/quotes/{quoteId}/publish"]!.post.responses["503"];
    };
    const response = shared(errors);
    expect(response).toEqual({
      description:
        "AUTHENTICATION_UNAVAILABLE: Authentication is temporarily unavailable.\n\n" +
        "SERVICE_UNAVAILABLE: The service is temporarily unavailable.",
      content: {
        "application/json": {
          schema: {
            oneOf: [
              {
                title: "AUTHENTICATION_UNAVAILABLE",
                description: "Authentication is temporarily unavailable.",
                allOf: [
                  { $ref: "#/components/schemas/Error" },
                  {
                    type: "object",
                    required: ["error"],
                    properties: {
                      error: {
                        type: "object",
                        required: ["code"],
                        properties: { code: { const: "AUTHENTICATION_UNAVAILABLE" } },
                      },
                    },
                  },
                ],
              },
              {
                title: "SERVICE_UNAVAILABLE",
                description: "The service is temporarily unavailable.",
                allOf: [
                  { $ref: "#/components/schemas/Error" },
                  {
                    type: "object",
                    required: ["error"],
                    properties: {
                      error: {
                        type: "object",
                        required: ["code"],
                        properties: { code: { const: "SERVICE_UNAVAILABLE" } },
                      },
                    },
                  },
                ],
              },
            ],
          },
        },
      },
    });
    expect(JSON.stringify(shared([...errors].reverse()))).toBe(JSON.stringify(response));
  });

  test("keeps shared-status schemas, fixed examples, and JSON media types honest", () => {
    const problemSchema = (value: string) => ({
      type: "object",
      required: ["error"],
      properties: { error: { const: value } },
      additionalProperties: false,
    });
    const errors: PluginOperationContract["errors"] = [
      {
        status: 503,
        code: "SECONDARY_UNAVAILABLE",
        description: "The secondary dependency is unavailable.",
        schema: problemSchema("secondary_unavailable"),
        rest: {
          body: { error: "secondary_unavailable" },
          contentType: "application/problem+json",
        },
      },
      {
        status: 503,
        code: "PRIMARY_UNAVAILABLE",
        description: "The primary dependency is unavailable.",
        schema: problemSchema("primary_unavailable"),
        rest: {
          body: { error: "primary_unavailable" },
          contentType: "application/problem+json",
        },
      },
      {
        status: 503,
        code: "VENDOR_UNAVAILABLE",
        description: "The external dependency is unavailable.",
        schema: problemSchema("vendor_unavailable"),
        rest: {
          body: { error: "vendor_unavailable" },
          contentType: "application/vnd.example.error+json",
        },
      },
    ];
    const compiled = collectPluginOperations([{ name: "demo", operations: [{
      ...operation,
      errors,
    }] }], context);
    const paths = operationOpenApiPaths(compiled) as Record<string, Record<string, any>>;
    const response = paths["/api/demo/quotes/{quoteId}/publish"]!.post.responses["503"];

    expect(Object.keys(response.content)).toEqual([
      "application/problem+json",
      "application/vnd.example.error+json",
    ]);
    expect(response.content["application/problem+json"]).toEqual({
      schema: {
        anyOf: [
          {
            title: "PRIMARY_UNAVAILABLE",
            description: "The primary dependency is unavailable.",
            allOf: [errors[1]!.schema],
          },
          {
            title: "SECONDARY_UNAVAILABLE",
            description: "The secondary dependency is unavailable.",
            allOf: [errors[0]!.schema],
          },
        ],
      },
      examples: {
        PRIMARY_UNAVAILABLE: {
          summary: "The primary dependency is unavailable.",
          value: { error: "primary_unavailable" },
        },
        SECONDARY_UNAVAILABLE: {
          summary: "The secondary dependency is unavailable.",
          value: { error: "secondary_unavailable" },
        },
      },
    });
    expect(response.content["application/vnd.example.error+json"]).toEqual({
      schema: errors[2]!.schema,
      example: { error: "vendor_unavailable" },
    });
  });

  test("rejects duplicate status and code pairs while allowing either value to differ", () => {
    const duplicate = {
      status: 503,
      code: "SERVICE_UNAVAILABLE",
      description: "The service is temporarily unavailable.",
    };
    expect(() => collectPluginOperations([{ name: "demo", operations: [{
      ...operation,
      errors: [duplicate, { ...duplicate, rest: { contentType: "application/problem+json" } }],
    }] }], context)).toThrow(/duplicate error status 503 and code "SERVICE_UNAVAILABLE"/);
    expect(() => collectPluginOperations([{ name: "demo", operations: [{
      ...operation,
      errors: [duplicate, { ...duplicate, status: 502 }],
    }] }], context)).not.toThrow();
    expect(() => collectPluginOperations([{ name: "demo", operations: [{
      ...operation,
      errors: [duplicate, { ...duplicate, code: "AUTHENTICATION_UNAVAILABLE" }],
    }] }], context)).not.toThrow();
  });

  test("projects session operations onto bearer and configured OAuth security schemes", () => {
    const collected = collectPluginOperations([{ name: "demo", operations: [operation] }], context);
    const paths = operationOpenApiPaths(collected, ["bearerAuth", "oauth2Auth"]) as Record<
      string,
      Record<string, any>
    >;

    expect(paths["/api/demo/quotes/{quoteId}/publish"]!.post.security).toEqual([
      { bearerAuth: [] },
      { oauth2Auth: ["quotes:write"] },
    ]);
  });

  test("requires OAuth authoring to describe every session operation scope", () => {
    const collected = collectPluginOperations([{ name: "demo", operations: [operation] }], context);

    expect(() => renderOpenApiSpec({ version: 1, tables: [] }, "fixture", {
      operations: collected,
      documentation: {
        title: "Example API",
        description: "Authenticate before using protected operations.",
        oauth2: {
          description: "Sign in through the host identity provider.",
          authorizationUrl: "https://identity.example.com/oauth/authorize",
          tokenUrl: "https://identity.example.com/oauth/token",
          clientId: "public-docs-client",
          scopes: { openid: "Sign in" },
        },
      },
    })).toThrow(/scopes do not describe required operation scope.*quotes:write/);
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
    expect(() => collectPluginOperations([{ name: "demo", operations: [
      operation,
      {
        ...operation,
        key: "demo.quote.send",
        inputSchema: {
          ...operation.inputSchema,
          required: ["documentId", "idempotencyKey"],
          properties: {
            documentId: { type: "string", format: "uuid" },
            idempotencyKey: { type: "string", minLength: 1 },
          },
        },
        transports: {
          ...operation.transports,
          rest: {
            ...operation.transports.rest,
            path: "/api/demo/quotes/:documentId/publish",
          },
        },
      },
    ] }], context)).toThrow(/Duplicate plugin operation REST route/);
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
      documentation: {
        title: "Example API",
        description: "Authenticate before using protected operations.",
        oauth2: {
          description: "Sign in through the host identity provider.",
          authorizationUrl: "https://identity.example.com/oauth/authorize",
          tokenUrl: "https://identity.example.com/oauth/token",
          clientId: "public-docs-client",
          scopes: { openid: "Sign in" },
        },
      },
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
    expect(spec.components.securitySchemes.oauth2Auth.description).toBe(
      "Sign in through the host identity provider.",
    );
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

  test("requires safe aliases with canonical path parameters and no reserved-root takeover", () => {
    const withAliases = (aliases: string[]): PluginOperationContract => ({
      ...operation,
      transports: {
        ...operation.transports,
        rest: { ...operation.transports.rest, aliases },
      },
    });
    expect(() => collectPluginOperations([
      { name: "demo", operations: [withAliases(["/outside/api/:quoteId"])] },
    ], context)).toThrow(/safe absolute \/api/);
    expect(() => collectPluginOperations([
      { name: "demo", operations: [withAliases(["/api/rest"])] },
    ], context)).toThrow(/reserved API namespace root/);
    expect(() => collectPluginOperations([
      { name: "demo", operations: [withAliases(["/api/legacy/:id/publish"])] },
    ], context)).toThrow(/path parameters must match/);
    expect(() => collectPluginOperations([
      { name: "demo", operations: [withAliases([
        "/api/legacy/:quoteId/publish",
        "/api/legacy/:quoteId/publish",
      ])] },
    ], context)).toThrow(/Duplicate plugin operation REST route/);
  });

  test("audits aliases against core and generated REST while allowing collision-free nesting", () => {
    const aliasOperation = (
      method: PluginOperationContract["transports"]["rest"]["method"],
      alias: string,
    ): PluginOperationContract => ({
      ...operation,
      transports: {
        ...operation.transports,
        rest: { ...operation.transports.rest, method, aliases: [alias] },
      },
    });
    const emptyManifest: PlatformSchemaManifest = { version: 1, tables: [] };
    const coreCollision = collectPluginOperations([{ name: "demo", operations: [
      aliasOperation("GET", "/api/rest/v1/connectors/:quoteId"),
    ] }], context);
    expect(() => auditOperationSurfaceCollisions(coreCollision, emptyManifest, [], 60))
      .toThrow(/normalized REST route shape.*core connector catalog.*plugin operation/);

    const staticCoreOverlap = collectPluginOperations([{ name: "demo", operations: [{
      ...operation,
      inputSchema: {
        ...operation.inputSchema,
        required: ["idempotencyKey"],
        properties: { idempotencyKey: { type: "string", minLength: 1 } },
      },
      transports: {
        ...operation.transports,
        rest: {
          ...operation.transports.rest,
          method: "GET",
          path: "/api/demo/connectors/acme",
          aliases: ["/api/rest/v1/connectors/acme"],
        },
      },
    }] }], context);
    expect(() => auditOperationSurfaceCollisions(staticCoreOverlap, emptyManifest, [], 60))
      .toThrow(/overlapping REST route.*core connector catalog.*plugin operation/);

    const exactCoreCollision = collectPluginOperations([{ name: "demo", operations: [{
      ...operation,
      inputSchema: {
        type: "object",
        required: ["idempotencyKey"],
        properties: { idempotencyKey: { type: "string", minLength: 1 } },
        additionalProperties: false,
      },
      transports: {
        ...operation.transports,
        rest: {
          ...operation.transports.rest,
          method: "GET",
          path: "/api/demo/documents",
          aliases: ["/api/rest/openapi.json"],
        },
      },
    }] }], context);
    expect(() => auditOperationSurfaceCollisions(exactCoreCollision, emptyManifest, [], 60))
      .toThrow(/REST route.*core REST OpenAPI.*plugin operation/);

    for (const [path, owner] of [
      ["/api/rest/docs/swagger-initializer.js", "core REST documentation"],
      ["/api/rest/docs/oauth2-redirect.html", "core REST OAuth callback"],
    ] as const) {
      const docsCollision = collectPluginOperations([{ name: "demo", operations: [{
        ...operation,
        inputSchema: {
          type: "object",
          required: ["idempotencyKey"],
          properties: { idempotencyKey: { type: "string", minLength: 1 } },
          additionalProperties: false,
        },
        transports: {
          ...operation.transports,
          rest: {
            ...operation.transports.rest,
            method: "GET",
            path: "/api/demo/documents",
            aliases: [path],
          },
        },
      }] }], context);
      expect(() => auditOperationSurfaceCollisions(docsCollision, emptyManifest, [], 60))
        .toThrow(new RegExp(`REST route.*${owner}.*plugin operation`));
    }

    const generatedManifest: PlatformSchemaManifest = {
      version: 1,
      tables: [{
        schema: "public",
        name: "legacy_quotes",
        tenantScoped: true,
        generatedCrud: true,
        columns: [{ name: "id", type: "uuid", primaryKey: true }],
        source: {
          rest: {
            basePath: "legacy-quotes",
            operations: { list: true, get: true, create: true, update: true, delete: true },
          },
        },
      }],
    };
    const generatedCollision = collectPluginOperations([{ name: "demo", operations: [
      aliasOperation("PATCH", "/api/rest/v1/legacy-quotes/:quoteId"),
    ] }], context);
    expect(() => auditOperationSurfaceCollisions(generatedCollision, generatedManifest, [], 60))
      .toThrow(/normalized REST route shape.*entity public.legacy_quotes.*plugin operation/);

    const staticGeneratedOverlap = collectPluginOperations([{ name: "demo", operations: [{
      ...operation,
      inputSchema: {
        ...operation.inputSchema,
        required: ["idempotencyKey"],
        properties: { idempotencyKey: { type: "string", minLength: 1 } },
      },
      transports: {
        ...operation.transports,
        rest: {
          ...operation.transports.rest,
          method: "PATCH",
          path: "/api/demo/legacy-quotes/current",
          aliases: ["/api/rest/v1/legacy-quotes/current"],
        },
      },
    }] }], context);
    expect(() => auditOperationSurfaceCollisions(staticGeneratedOverlap, generatedManifest, [], 60))
      .toThrow(/overlapping REST route.*entity public.legacy_quotes.*plugin operation/);

    const nested = collectPluginOperations([{ name: "demo", operations: [
      aliasOperation("POST", "/api/rest/v1/legacy-quotes/:quoteId/publish"),
    ] }], context);
    expect(() => auditOperationSurfaceCollisions(nested, generatedManifest, [], 60))
      .not.toThrow();
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
