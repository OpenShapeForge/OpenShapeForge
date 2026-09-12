// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import type { CompilerPlugin, PluginOperationContract } from "./plugins.js";
import { renderOpenApiSpec } from "./generate-openapi.js";
import {
  auditOperationSurfaceCollisions,
  assertOperationRuntimeModules,
  buildStaticOperationCatalog,
  collectAuthoredEntityPluginOperations,
  collectPluginOperations,
  collectEntityOperations,
  operationOpenApiPaths,
  renderOperationCatalog,
} from "./generate-operations.js";
import type { CompiledPluginOperation } from "./generate-operations.js";
import type { CompiledEntityOperation } from "./authoring/types.js";
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
  test("distinguishes authenticated-session auth from an explicit deny-all role list", () => {
    const authenticated = {
      ...operation,
      auth: { mode: "session" as const },
    } satisfies PluginOperationContract;
    const denied = {
      ...operation,
      key: "demo.quote.denied",
      transports: {
        ...operation.transports,
        rest: { ...operation.transports.rest, path: "/api/demo/quotes/:quoteId/denied" },
      },
      auth: { mode: "session" as const, roles: [] },
    } satisfies PluginOperationContract;

    expect(collectPluginOperations([{ name: "demo", operations: [authenticated] }], context)[0]!.auth)
      .toEqual({ mode: "session" });
    expect(collectPluginOperations([{ name: "demo", operations: [denied] }], context)[0]!.auth)
      .toEqual({ mode: "session", roles: [] });
  });

  test("derives custom write controls once for every adapter input schema", () => {
    const [compiled] = collectAuthoredEntityPluginOperations([{
      contract: {
        pluginOperations: [{
          key: "approve",
          id: "demo.quote.approve",
          entityId: "example.Quote",
          entityName: "Quote",
          definition: {
            id: "demo.quote.approve",
            name: "Approve quote",
            description: "Approves a quote.",
            implementation: { type: "plugin", plugin: "new-owner", handler: "approveQuote" },
            target: { scope: "record", inputField: "quoteId" },
            input: {
              schema: {
                type: "object",
                required: ["quoteId"],
                properties: { quoteId: { type: "string", format: "uuid" } },
                additionalProperties: false,
              },
            },
            output: { schema: { type: "object", properties: {} } },
            errors: [],
            auth: {
              mode: "session",
              roles: ["Quotes.All.Approve"],
              recordPermission: "edit",
            },
            tenancy: { mode: "required" },
            effects: { data: "write", external: "none" },
            reliability: { idempotency: { mode: "natural" } },
            concurrency: {
              version: { mode: "required", field: "updatedAt" },
              editLease: { mode: "required", expiresAfterInactivity: "PT15M" },
            },
            confirmation: { mode: "none" },
          },
          interfaces: {
            rest: { method: "POST", path: "/api/demo/quotes/:quoteId/approve" },
            graphql: { kind: "mutation", field: "approveQuote" },
            mcp: { name: "approve_quote" },
            web: {},
          },
        }],
      },
    }] as never, context);

    expect(compiled!.key).toBe("demo.quote.approve");
    expect(compiled!.plugin).toBe("new-owner");

    expect(compiled!.inputSchema).toMatchObject({
      required: ["quoteId", "expectedVersion", "leaseToken"],
      properties: {
        expectedVersion: { type: "string", format: "date-time" },
        leaseToken: { type: "string", minLength: 1 },
      },
      additionalProperties: false,
    });
    expect(compiled!.auth).toEqual({
      mode: "session",
      roles: ["Quotes.All.Approve"],
      recordPermission: "edit",
    });
  });

  test("renders canonical entity operations beside plugin operations", () => {
  const entityOperation: CompiledEntityOperation = {
    key: "list",
    id: "Relation.list",
      entityId: "hubble.Relation",
    entityName: "Relation",
    name: "List Relation",
    description: "List Relation",
    implementation: { type: "entity" },
    effects: { data: "read", external: "none" },
    reliability: { idempotency: { mode: "natural" } },
      intent: "list",
      input: {
        kind: "collection-query",
        entityId: "hubble.Relation",
        filterMode: "declared-fields",
        sortMode: "declared-fields",
        pagination: { kind: "cursor", defaultLimit: 50, maxLimit: 200 },
      },
      output: { kind: "entity-connection", entityId: "hubble.Relation" },
      authorization: { action: "read", roles: ["Relations.Read"] },
      interaction: { confirmation: { mode: "none" } },
    };
    const entities = [{
      contract: {
        entity: {
          id: "hubble.Relation",
          name: "Relation",
          title: "Relation",
        },
        model: { fields: [], relationships: [] },
        storage: { columns: [] },
        entityOperations: { list: entityOperation },
      },
    }] as never;

    const collected = collectEntityOperations(entities);
    expect(collected).toEqual([entityOperation]);
    const catalog = buildStaticOperationCatalog([], collected, entities, {});
    expect(catalog.operations).toEqual([
      expect.objectContaining({
        ...entityOperation,
        inputSchema: expect.any(Object),
        outputSchema: expect.any(Object),
      }),
    ]);
    expect(JSON.parse(renderOperationCatalog(catalog))).toMatchObject({
      version: 1,
      operations: [],
      entityOperations: [{ id: "Relation.list" }],
    });
  });

  test("rejects a duplicate id across entity and plugin/module Operations", () => {
    const [compiledPlugin] = collectPluginOperations(
      [{ name: "demo", operations: [operation] }],
      context,
    );
    const entityOperation = {
      id: operation.key,
      key: "create",
      intent: "create",
      entityId: "hubble.Relation",
      entityName: "Relation",
      interaction: { confirmation: { mode: "none" } },
    } as CompiledEntityOperation;

    const entities = [{
      contract: {
        entity: { id: "hubble.Relation", name: "Relation", title: "Relation" },
        model: { fields: [], relationships: [] },
        storage: { columns: [] },
        entityOperations: { create: entityOperation },
      },
    }] as never;
    expect(() => buildStaticOperationCatalog(
      [compiledPlugin!],
      [entityOperation],
      entities,
      {},
    ))
      .toThrow(/Duplicate canonical Operation id/);
  });

  test("accepts only a safe canonical invoke Operation as a create prerequisite", () => {
    const target: CompiledEntityOperation = {
      id: "Adapter.create",
      key: "create",
      intent: "create",
      entityId: "osf-integration.Adapter",
      entityName: "Adapter",
      name: "Create adapter",
      description: "Create adapter",
      implementation: { type: "entity" },
      prerequisites: [{
        operation: "osf-integration.provider.setup-guide",
        receipt: { binding: "loginSession" },
      }],
      input: { kind: "entity-create", entityId: "osf-integration.Adapter" },
      output: { kind: "entity-record", entityId: "osf-integration.Adapter", nullable: false },
      authorization: { action: "create", roles: ["integration_admin"] },
      effects: { data: "write", external: "none" },
      reliability: { idempotency: { mode: "none" } },
      interaction: { confirmation: { mode: "none" } },
    };
    const entities = [{
      contract: {
        entity: { id: "osf-integration.Adapter", name: "Adapter", title: "Adapter" },
        model: { fields: [], relationships: [] },
        storage: { columns: [] },
        entityOperations: { create: target },
      },
    }] as never;
    const guideDefinition: PluginOperationContract = {
      ...operation,
      key: "osf-integration.provider.setup-guide",
      title: "Provider setup guide",
      description: "Shows the provider setup guide.",
      handler: "providerSetupGuide",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      auth: { mode: "session", roles: ["integration_admin"] },
      tenancy: { mode: "required" },
      effects: { data: "read", external: "none" },
      idempotency: { mode: "intrinsic" },
      transports: {
        rest: { method: "GET", path: "/api/osf-integration/provider/setup-guide", response: { kind: "json" } },
        mcp: { enabled: true, name: "provider_setup_guide" },
        graphql: { enabled: true, kind: "query", field: "providerSetupGuide" },
        typescript: { enabled: true, functionName: "providerSetupGuide" },
      },
    };
    const [guide] = collectPluginOperations(
      [{ name: "osf-integration", operations: [guideDefinition] }],
      context,
    );

    expect(() => buildStaticOperationCatalog([guide!], [target], entities, {}))
      .not.toThrow();
    expect(() => buildStaticOperationCatalog([], [target], entities, {}))
      .toThrow(/missing prerequisite Operation/);
    expect(() => buildStaticOperationCatalog([
      { ...guide!, effects: { data: "write", external: "none" } },
    ], [target], entities, {})).toThrow(/read\/no-external effects/);
    expect(() => buildStaticOperationCatalog([
      {
        ...guide!,
        inputSchema: {
          type: "object",
          required: ["provider"],
          properties: { provider: { type: "string" } },
        },
      },
    ], [target], entities, {})).toThrow(/no required input/);
  });

  test("collects deterministic canonical contracts and OpenAPI path parameters", () => {
    const plugins: CompilerPlugin[] = [{ name: "demo", operations: [operation] }];
    const collected = collectPluginOperations(plugins, context);
    const catalog = buildStaticOperationCatalog(collected, [], [], {});
    expect(catalog.operations[0]).toMatchObject({
      id: operation.key,
      key: operation.key,
      intent: "invoke",
    });
    expect(JSON.parse(renderOperationCatalog(catalog)).operations[0].key).toBe(operation.key);
    expect(collected).toHaveLength(1);
    const paths = operationOpenApiPaths(collected) as Record<string, Record<string, any>>;
    const canonical = paths["/api/demo/quotes/{quoteId}/publish"]!.post;
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
    expect(() => collectPluginOperations([{ name: "new-owner", operations: [operation] }], context))
      .toThrow(/stable lowercase key prefixed/);
    expect(() => collectPluginOperations([{ name: "demo", operations: [{
      ...operation,
      transports: {
        ...operation.transports,
        rest: { ...operation.transports.rest, path: "/api/admin/escape" },
      },
    }] }], context)).toThrow(/safe plugin root "\/api\/demo"/);
    expect(() => collectPluginOperations([{ name: "demo", operations: [{
      ...operation,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    }] }], context)).toThrow(/path parameter "quoteId" must be a required/);
    expect(() => collectPluginOperations([{ name: "../demo", operations: [{
      ...operation,
      key: "../demo.quote.publish",
    }] }], context)).toThrow(/stable lowercase key/);
    expect(() => collectPluginOperations([{ name: "health", operations: [{
      ...operation,
      key: "health.status.read",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      idempotency: { mode: "none" },
      transports: {
        ...operation.transports,
        rest: { method: "GET", path: "/api/health", response: { status: 200, kind: "json" } },
      },
    }] }], context)).toThrow(/reserved API namespace "health"/);
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

  test("allows a canonical operation at its exact plugin namespace root", () => {
    const rootOperation: PluginOperationContract = {
      ...operation,
      key: "session.current.read",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      idempotency: { mode: "none" },
      transports: {
        ...operation.transports,
        rest: { method: "GET", path: "/api/session", response: { status: 200, kind: "json" } },
      },
    };
    const plugins: CompilerPlugin[] = [{ name: "session", operations: [rootOperation] }];

    const first = collectPluginOperations(plugins, context);
    const second = collectPluginOperations(plugins, context);

    expect(first[0]!.transports.rest.path).toBe("/api/session");
    expect((operationOpenApiPaths(first) as Record<string, Record<string, unknown>>)["/api/session"])
      .toHaveProperty("get");
    expect(renderOperationCatalog(buildStaticOperationCatalog(first, [], [], {}))).toBe(
      renderOperationCatalog(buildStaticOperationCatalog(second, [], [], {})),
    );

    const hyphenated = collectPluginOperations([{ name: "user-session", operations: [{
      ...rootOperation,
      key: "user-session.current.read",
      transports: {
        ...rootOperation.transports,
        rest: { ...rootOperation.transports.rest, path: "/api/user-session" },
      },
    }] }], context);
    expect(hyphenated[0]!.transports.rest.path).toBe("/api/user-session");
  });

  test("keeps nested plugin paths and rejects another plugin namespace root", () => {
    expect(() => collectPluginOperations([{ name: "demo", operations: [operation] }], context))
      .not.toThrow();
    expect(() => collectPluginOperations([{ name: "session", operations: [{
      ...operation,
      key: "session.current.read",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      idempotency: { mode: "none" },
      transports: {
        ...operation.transports,
        rest: { method: "GET", path: "/api/other", response: { status: 200, kind: "json" } },
      },
    }] }], context)).toThrow(/safe plugin root "\/api\/session"/);
  });

  test("audits canonical REST routes against core and generated REST surfaces", () => {
    const compiledOperation = (
      method: PluginOperationContract["transports"]["rest"]["method"],
      path: string,
    ): CompiledPluginOperation => ({
      ...operation,
      plugin: "demo",
      id: operation.key,
      intent: "invoke",
      transports: {
        ...operation.transports,
        rest: { ...operation.transports.rest, method, path },
      },
    });
    const emptyManifest: PlatformSchemaManifest = { version: 1, tables: [] };
    const coreCollision = [compiledOperation("GET", "/api/rest/v1/connectors/:quoteId")];
    expect(() => auditOperationSurfaceCollisions(coreCollision, emptyManifest, [], 60))
      .toThrow(/normalized REST route shape.*core connector catalog.*plugin operation/);

    const staticCoreOverlap = [compiledOperation("GET", "/api/rest/v1/connectors/acme")];
    expect(() => auditOperationSurfaceCollisions(staticCoreOverlap, emptyManifest, [], 60))
      .toThrow(/overlapping REST route.*core connector catalog.*plugin operation/);

    const exactCoreCollision = [compiledOperation("GET", "/api/rest/openapi.json")];
    expect(() => auditOperationSurfaceCollisions(exactCoreCollision, emptyManifest, [], 60))
      .toThrow(/REST route.*core REST OpenAPI.*plugin operation/);

    for (const [path, owner] of [
      ["/api/rest/docs/swagger-initializer.js", "core REST documentation"],
      ["/api/rest/docs/oauth2-redirect.html", "core REST OAuth callback"],
    ] as const) {
      const docsCollision = [compiledOperation("GET", path)];
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
    const generatedCollision = [compiledOperation("PATCH", "/api/rest/v1/legacy-quotes/:quoteId")];
    expect(() => auditOperationSurfaceCollisions(generatedCollision, generatedManifest, [], 60))
      .toThrow(/normalized REST route shape.*entity public.legacy_quotes.*plugin operation/);

    const staticGeneratedOverlap = [
      compiledOperation("PATCH", "/api/rest/v1/legacy-quotes/current"),
    ];
    expect(() => auditOperationSurfaceCollisions(staticGeneratedOverlap, generatedManifest, [], 60))
      .toThrow(/overlapping REST route.*entity public.legacy_quotes.*plugin operation/);

    const canonical = collectPluginOperations([{ name: "demo", operations: [operation] }], context);
    expect(() => auditOperationSurfaceCollisions(canonical, generatedManifest, [], 60))
      .not.toThrow();

    const overflow = Array.from({ length: 61 }, (_unused, index) => {
      const compiled = compiledOperation("POST", `/api/demo/overflow/${index}`);
      return {
        ...compiled,
        key: `demo.overflow.${index}`,
        id: `demo.overflow.${index}`,
        transports: {
          ...compiled.transports,
          mcp: { enabled: true as const, name: `demo_overflow_${index}` },
          graphql: { enabled: false as const, reason: "Not exposed in this fixture." },
        },
      };
    });
    expect(auditOperationSurfaceCollisions(overflow, { version: 1, tables: [] }, [], 60))
      .toBe("searchable");

    const genericNameCollision = overflow.map((candidate, index) =>
      index === 0
        ? {
            ...candidate,
            transports: {
              ...candidate.transports,
              mcp: { enabled: true as const, name: "osf_search_operations" },
            },
          }
        : candidate
    );
    expect(() =>
      auditOperationSurfaceCollisions(
        genericNameCollision,
        { version: 1, tables: [] },
        [],
        60,
      )
    ).toThrow(/osf_search_operations.*plugin operation.*shared searchable Operation catalog/);
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
    manifest.tables[0]!.source!.graphql!.operations = { get: true, list: true, create: false, update: false, delete: false };
    expect(() => auditOperationSurfaceCollisions(collected, manifest, [], 60)).not.toThrow();
    manifest.tables[0]!.source!.graphql!.createMutationName = "createQuote";
    if (collected[0]!.transports.mcp.enabled) collected[0]!.transports.mcp.name = "demo_publish_create";
    expect(() => auditOperationSurfaceCollisions(collected, manifest, [], 60)).toThrow(/MCP tool/);
  });
});
