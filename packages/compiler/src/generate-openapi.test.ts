// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "bun:test";
import type {
  CompiledEntityContract,
  CompiledField,
} from "./authoring/types.js";
import { deriveEntityOperationErrors } from "./authoring/compiler/entity-operation-errors.js";
import { renderOpenApiSpec } from "./generate-openapi.js";
import type { PlatformSchemaManifest } from "./schema.js";

/**
 * The fixtures below spell each Operation's policy flags by hand; the errors
 * the compiler derives from those flags are filled in here, after a test has
 * mutated the flags, so the projection under test sees what the compiler
 * would have emitted.
 */
function withDerivedErrors(entity: CompiledEntityContract): CompiledEntityContract {
  for (const operation of Object.values(entity.entityOperations)) {
    if (!operation) continue;
    operation.errors = deriveEntityOperationErrors(entity.entity.name, operation.intent, {
      concurrency: operation.concurrency,
      confirmation: operation.interaction?.confirmation ?? { mode: "none" },
      recordPermissions: entity.authorization?.rowAccess?.recordPermissions !== undefined,
    });
  }
  return entity;
}

function field(
  overrides: Partial<CompiledField> & Pick<CompiledField, "key">,
): CompiledField {
  const { key, ...rest } = overrides;
  return {
    key,
    baseType: "string",
    osfType: rest.baseType ?? "string",
    cardinality: "single",
    required: false,
    label: { en: key },
    render: { component: "Input" },
    ...rest,
  };
}

const contract = {
  authoringVersion: 2,
  entity: {
    name: "Relation",
    title: "Relation",
    labels: { en: "Relation", nl: "Relatie" },
    description: {
      en: "Canonical relation aggregate.",
      nl: "Canonieke relatie-aggregate.",
    },
  },
  model: {
    fields: [
      field({
        key: "displayName",
        required: true,
        label: { en: "Display name" },
        description: { en: "Human-readable relation name." },
        validation: { minLength: 1, maxLength: 200 },
        defaultValue: "Unnamed relation",
      }),
      field({
        key: "relationType",
        required: true,
        label: { en: "Relation type" },
        render: {
          component: "ReferenceSelect",
          props: { referentieGroep: "RELATIONTYPE" },
        },
      }),
      field({
        key: "metadata",
        baseType: "object",
        label: { en: "Metadata" },
        children: [
          field({
            key: "source",
            required: true,
            label: { en: "Source" },
            defaultValue: "api",
          }),
          field({ key: "notes", label: { en: "Notes" } }),
        ],
      }),
      field({
        key: "externalId",
        immutable: true,
        label: { en: "External ID" },
        description: { en: "Identifier in the owning external system." },
        relationship: { kind: "belongsTo", entity: "ExternalSystem" },
        hints: {
          aiInstructions: "Resolve this with the external-system list tool.",
        },
      }),
      field({
        key: "generatedKey",
        required: true,
        deriveOnCreate: { from: "displayName", transform: "slug", onConflict: "suffix" },
      }),
      field({
        key: "iban",
        label: { en: "IBAN" },
        description: { en: "International bank account number." },
        validation: { maxLength: 34 },
        classification: { sensitivity: "confidential" },
      }),
      field({ key: "first", description: { en: "Business sequence value." } }),
      field({ key: "status", description: { en: "Current status." } }),
      field({ key: "statusIn", description: { en: "Status import marker." } }),
      field({
        key: "isOptedIn",
        baseType: "boolean",
        description: { en: "Whether the relation opted in." },
      }),
    ],
  },
  rest: {
    basePath: "relations",
    operations: {
      list: true,
      get: true,
      create: true,
      update: true,
      delete: true,
    },
  },
  entityOperations: {
    list: { id: "Relation.list", intent: "list" },
    get: { id: "Relation.get", intent: "get" },
    create: { id: "Relation.create", intent: "create" },
    update: {
      id: "Relation.update",
      intent: "update",
      concurrency: {
        version: { mode: "required", field: "updatedAt" },
        editLease: { mode: "required", expiresAfterInactivity: "PT15M" },
      },
      interaction: { confirmation: { mode: "none" } },
    },
    delete: {
      id: "Relation.delete",
      intent: "delete",
      concurrency: {
        version: { mode: "required", field: "updatedAt" },
        editLease: { mode: "required", expiresAfterInactivity: "PT15M" },
      },
      interaction: {
        confirmation: {
          mode: "challenge",
          challenge: {
            kind: "type-current-field",
            field: "displayName",
            issuedBy: "server",
            bindTo: ["subject", "tenant", "operation", "target.id", "target.version"],
            expiresAfter: "PT5M",
            singleUse: true,
          },
        },
      },
    },
  },
} as unknown as CompiledEntityContract;

const manifest: PlatformSchemaManifest = {
  version: 1,
  tables: [
    {
      schema: "erp",
      name: "relations",
      tenantScoped: true,
      generatedCrudEligible: true,
      columns: [
        { name: "id", type: "uuid", primaryKey: true },
        { name: "tenant_id", type: "uuid", required: true },
        {
          name: "display_name",
          type: "text",
          required: true,
          sourceField: "displayName",
        },
        {
          name: "relation_type",
          type: "text",
          required: true,
          sourceField: "relationType",
        },
        { name: "metadata", type: "jsonb", sourceField: "metadata" },
        {
          name: "external_id",
          type: "text",
          sourceField: "externalId",
          immutable: true,
        },
        {
          name: "generated_key",
          type: "text",
          required: true,
          sourceField: "generatedKey",
          deriveOnCreate: {
            sourceField: "displayName",
            sourceColumn: "display_name",
            transform: "slug",
            onConflict: "suffix",
            conflictColumns: ["tenant_id", "generated_key"],
          },
        },
        { name: "iban", type: "text", sourceField: "iban" },
        { name: "business_first", type: "text", sourceField: "first" },
        { name: "status", type: "text", sourceField: "status" },
        { name: "status_in", type: "text", sourceField: "statusIn" },
        { name: "is_opted_in", type: "boolean", sourceField: "isOptedIn" },
        { name: "marker", type: "text", sourceField: "marker" },
        {
          name: "marker_in",
          type: "text",
          sourceField: "markerIn",
          classification: "confidential",
        },
        {
          name: "private_marker",
          type: "text",
          sourceField: "privateMarker",
          classification: "pii",
        },
        {
          name: "sequence_number",
          type: "bigint",
          sourceField: "sequenceNumber",
        },
        {
          name: "relation_group_id",
          type: "uuid",
          sourceField: "relationGroupId",
        },
        { name: "created_at", type: "timestamptz", required: true },
      ],
      source: {
        authoringEntityName: "Relation",
        rest: contract.rest!,
        mcp: {
          toolPrefix: "relation",
          tools: "dedicated",
          operations: {
            list: true,
            get: true,
            create: true,
            update: true,
            delete: true,
          },
          elicitOnCreate: {
            sourceField: "externalId",
            sourceEntity: "ExternalSystem",
            definitionsField: "metadata",
            into: "metadata",
          },
        },
      },
    },
  ],
};

type TestParameter = {
  name: string;
  in: string;
  required?: boolean;
  description?: string;
  style?: string;
  explode?: boolean;
  schema: Record<string, unknown>;
};

type TestOperation = {
  tags?: string[];
  parameters?: TestParameter[];
  requestBody?: any;
  responses?: Record<string, any>;
};

function spec() {
  return JSON.parse(
    renderOpenApiSpec(manifest, "fixture", {
      entities: [{ contract: withDerivedErrors(contract) }],
      referentiedata: {
        RELATIONTYPE: [
          { value: "person", label: { en: "Person", nl: "Persoon" } },
          {
            value: "organization",
            label: { en: "Organization", nl: "Organisatie" },
          },
        ],
      },
    }),
  ) as {
    tags: Array<{ name: string; description?: string }>;
    paths: Record<
      string,
      {
        parameters?: TestParameter[];
        get?: TestOperation;
        post?: TestOperation;
        patch?: TestOperation;
        delete?: TestOperation;
      }
    >;
    components: { schemas: Record<string, Record<string, unknown>> };
  };
}

describe("rich generated REST OpenAPI", () => {
  it("puts committed host onboarding before generic safe-start guidance and provenance", () => {
    const rendered = JSON.parse(renderOpenApiSpec(manifest, "fixture", {
      entities: [{ contract: withDerivedErrors(contract) }],
      documentation: {
        title: "Example Product API",
        version: "2026-09",
        description: "Use this API to synchronize records.",
        externalDocs: {
          description: "Developer guide",
          url: "https://example.com/developers",
        },
      },
    })) as {
      info: { title: string; version: string; description: string };
      externalDocs: { description: string; url: string };
    };

    expect(rendered.info.title).toBe("Example Product API");
    expect(rendered.info.version).toBe("2026-09");
    expect(rendered.info.description).toStartWith("Use this API to synchronize records.");
    expect(rendered.info.description.indexOf("## Start here")).toBeGreaterThan(
      rendered.info.description.indexOf("Use this API to synchronize records."),
    );
    expect(rendered.info.description).toContain("```text");
    expect(rendered.info.description).toEndWith(
      "Generated by @openshapeforge/compiler. Source: fixture. Do not edit by hand.",
    );
    expect(rendered.externalDocs).toEqual({
      description: "Developer guide",
      url: "https://example.com/developers",
    });
  });

  it("keeps generic developer onboarding for hosts without committed REST API copy", () => {
    const rendered = JSON.parse(renderOpenApiSpec({ version: 1, tables: [] }, "fixture")) as {
      info: { title: string; version: string; description: string };
      paths: Record<string, unknown>;
    };

    // The file transport is core's and is documented for every host: any
    // record may own a file. An empty manifest documents nothing else.
    expect(Object.keys(rendered.paths).sort()).toEqual(["/api/artifacts", "/api/artifacts/{artifactId}/contents"]);
    expect(rendered.info.title).toBe("OpenShapeForge generated REST API");
    expect(rendered.info.version).toBe("1");
    expect(rendered.info.description).toContain("## Start here");
    expect(rendered.info.description).toContain("## Starter prompt");
    expect(rendered.info.description).toContain("Choose a documented operation");
    expect(rendered.info.description).toContain("Prefer a documented GET while exploring");
    expect(rendered.info.description).not.toContain("GET /api/rest/v1/{entity}");
    expect(rendered.info.description).not.toContain("Pick an entity");
    expect(rendered.info.description).toContain("public or custom authentication");
    expect(rendered.info.description).toContain("session-authenticated entity or operation");
    expect(rendered.info.description).toContain("satisfy any declared role");
    expect(rendered.info.description).not.toContain("Every operation needs a bearer token");
    expect(rendered.info.description).not.toContain("For a protected operation, the caller's roles");
    expect(rendered.info.description).toContain("Do not invent");
    expect(rendered.info.description).toEndWith(
      "Generated by @openshapeforge/compiler. Source: fixture. Do not edit by hand.",
    );
    expect((rendered as any).security).toEqual([{ bearerAuth: [] }]);
    expect((rendered as any).components.securitySchemes).toMatchObject({
      bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
    });
    expect((rendered as any).components.securitySchemes.bearerAuth.description).toBeUndefined();
    expect((rendered as any).components.securitySchemes.oauth2Auth).toBeUndefined();
  });

  it("emits host-authored OAuth Authorization Code metadata and public Swagger configuration", () => {
    const rendered = JSON.parse(renderOpenApiSpec(manifest, "fixture", {
      entities: [{ contract: withDerivedErrors(contract) }],
      documentation: {
        title: "Example Product API",
        description: "Authenticate before using protected operations.",
        bearerDescription: "Paste an access token issued for this API.",
        oauth2: {
          description: "Sign in through the host identity provider using Authorization Code with PKCE.",
          authorizationUrl: "https://identity.example.com/oauth/authorize",
          tokenUrl: "https://identity.example.com/oauth/token",
          clientId: "public-docs-client",
          scopes: {
            openid: "Sign in",
            profile: "Read profile claims",
          },
          redirectUrl: "https://api.example.com/api/rest/docs/oauth2-redirect.html",
        },
      },
    })) as any;

    expect(rendered.security).toEqual([{ bearerAuth: [] }, { oauth2Auth: [] }]);
    expect(rendered.components.securitySchemes.bearerAuth.description).toBe(
      "Paste an access token issued for this API.",
    );
    expect(rendered.components.securitySchemes.oauth2Auth).toEqual({
      type: "oauth2",
      description: "Sign in through the host identity provider using Authorization Code with PKCE.",
      flows: {
        authorizationCode: {
          authorizationUrl: "https://identity.example.com/oauth/authorize",
          tokenUrl: "https://identity.example.com/oauth/token",
          scopes: {
            openid: "Sign in",
            profile: "Read profile claims",
          },
        },
      },
      "x-swagger-ui-client-id": "public-docs-client",
      "x-swagger-ui-redirect-url":
        "https://api.example.com/api/rest/docs/oauth2-redirect.html",
    });
    expect(JSON.stringify(rendered)).not.toContain("clientSecret");
  });

  it("emits only allowed routes for a partial policy", () => {
    const partial = structuredClone(manifest);
    const table = partial.tables[0]!;
    table.generatedCrudEligible = true;
    table.source!.rest!.operations = {
      list: true,
      get: true,
      create: false,
      update: false,
      delete: false,
    };
    const rendered = JSON.parse(
      renderOpenApiSpec(partial, "fixture", {
        entities: [{ contract: withDerivedErrors(contract) }],
      }),
    ) as { paths: Record<string, Record<string, unknown>> };
    expect(Object.keys(rendered.paths["/api/rest/v1/relations"]!)).toEqual([
      "get",
    ]);
    expect(Object.keys(rendered.paths["/api/rest/v1/relations/{id}"]!)).toEqual(
      ["parameters", "get"],
    );
  });

  it("links each REST projection to its canonical operation contract", () => {
    const generated = spec();
    expect(generated.paths["/api/rest/v1/relations"]?.get)
      .toHaveProperty("x-osf-operation-id", "Relation.list");
    expect(generated.paths["/api/rest/v1/relations/{id}"]?.patch)
      .toHaveProperty("x-osf-operation-id", "Relation.update");
  });

  it("documents canonical data and operation-offer envelopes", () => {
    const generated = spec();
    const schemas = generated.components.schemas;

    expect(
      generated.paths["/api/rest/v1/relations"]?.get?.responses?.["200"]
        ?.content?.["application/json"]?.schema,
    ).toEqual({ $ref: "#/components/schemas/RelationListResult" });
    expect(schemas.RelationListResult).toMatchObject({
      required: ["data", "operations"],
      properties: {
        data: { $ref: "#/components/schemas/RelationListData" },
      },
    });
    expect(schemas.RelationListData).toMatchObject({
      properties: {
        items: {
          items: { $ref: "#/components/schemas/RelationResult" },
        },
      },
    });
    expect(schemas.OperationError!.required).toEqual([
      "code",
      "message",
      "retryable",
    ]);
    expect(schemas.OperationOffer!.oneOf).toHaveLength(2);
    expect(
      (schemas.OperationOffer!.oneOf as Array<{ properties: Record<string, unknown> }>)[0]!
        .properties.concurrency,
    ).toEqual({ $ref: "#/components/schemas/OperationConcurrency" });
    expect(schemas.OperationConcurrency).toMatchObject({
      properties: {
        editLease: {
          properties: { expiresAfterInactivity: { type: "string" } },
        },
      },
    });
    expect(
      generated.paths["/api/rest/v1/relations/{id}"]?.delete?.responses,
    ).toHaveProperty("200");
    expect(
      generated.paths["/api/rest/v1/relations/{id}"]?.delete?.responses,
    ).not.toHaveProperty("204");
  });

  it("documents canonical v2 mutation policy failures with the shared envelope", () => {
    const item = spec().paths["/api/rest/v1/relations/{id}"]!;
    const patchResponses = item.patch!.responses!;
    const deleteResponses = item.delete!.responses!;
    const operationFailure = {
      $ref: "#/components/schemas/OperationFailure",
    };

    expect(patchResponses["409"]?.description).toContain("VERSION_CONFLICT");
    expect(patchResponses["422"]?.description).toContain("VALIDATION");
    expect(patchResponses["423"]?.description).toContain("LOCKED");
    expect(deleteResponses["400"]?.description).toContain("BAD_USER_INPUT");
    expect(deleteResponses["409"]?.description).toContain("VERSION_CONFLICT");
    expect(deleteResponses["422"]?.description).toContain("VALIDATION");
    expect(deleteResponses["423"]?.description).toContain("LOCKED");
    expect(deleteResponses["428"]?.description).toContain(
      "CONFIRMATION_REQUIRED",
    );

    for (const response of [
      patchResponses["409"],
      patchResponses["422"],
      patchResponses["423"],
      deleteResponses["400"],
      deleteResponses["409"],
      deleteResponses["422"],
      deleteResponses["423"],
      deleteResponses["428"],
    ]) {
      expect(response?.content?.["application/json"]?.schema).toEqual(
        operationFailure,
      );
    }
  });

  it("projects acknowledgement and update challenges as canonical controls", () => {
    const protectedContract = structuredClone(contract);
    protectedContract.entityOperations.create!.interaction = {
      confirmation: { mode: "acknowledgement" },
    };
    protectedContract.entityOperations.update!.interaction.confirmation = {
      mode: "challenge",
      challenge: {
        kind: "type-current-field",
        field: "displayName",
        issuedBy: "server",
        bindTo: ["subject", "tenant", "operation", "target.id", "target.version"],
        expiresAfter: "PT5M",
        singleUse: true,
      },
    };
    const generated = JSON.parse(
      renderOpenApiSpec(manifest, "fixture", {
        entities: [{ contract: withDerivedErrors(protectedContract) }],
      }),
    ) as any;
    const create = generated.components.schemas.RelationInput;
    const update = generated.components.schemas.RelationUpdateInput;

    expect(create.required).not.toContain("confirmed");
    expect(create.properties.confirmed).toMatchObject({ type: "boolean" });
    expect(create.properties.confirmed).not.toHaveProperty("const");
    expect(update.dependentRequired).toEqual({
      confirmationToken: ["confirmationAnswer"],
      confirmationAnswer: ["confirmationToken"],
    });
    expect(
      generated.paths["/api/rest/v1/relations"].post.responses["428"].content[
        "application/json"
      ].schema,
    ).toEqual({ $ref: "#/components/schemas/OperationFailure" });
    expect(
      generated.paths["/api/rest/v1/relations/{id}"].patch.responses["428"]
        .content["application/json"].schema,
    ).toEqual({ $ref: "#/components/schemas/OperationFailure" });
  });

  it("leaves acknowledged controls optional for the canonical runtime to gate", () => {
    const acknowledgedContract = structuredClone(contract);
    for (const intent of ["create", "update", "delete"] as const) {
      acknowledgedContract.entityOperations[intent]!.interaction = {
        confirmation: { mode: "acknowledgement" },
      };
    }
    const generated = JSON.parse(
      renderOpenApiSpec(manifest, "fixture", {
        entities: [{ contract: withDerivedErrors(acknowledgedContract) }],
      }),
    ) as any;

    for (const schemaName of [
      "RelationInput",
      "RelationUpdateInput",
      "RelationDeleteInput",
    ]) {
      const inputSchema = generated.components.schemas[schemaName];
      expect(inputSchema.required).not.toContain("confirmed");
      expect(inputSchema.properties.confirmed).toMatchObject({ type: "boolean" });
      expect(inputSchema.properties.confirmed).not.toHaveProperty("const");
      expect(inputSchema.properties.confirmed.description).toContain(
        "Only true",
      );
    }
    for (const operation of [
      generated.paths["/api/rest/v1/relations"].post,
      generated.paths["/api/rest/v1/relations/{id}"].patch,
      generated.paths["/api/rest/v1/relations/{id}"].delete,
    ]) {
      expect(operation.responses["428"].content["application/json"].schema)
        .toEqual({ $ref: "#/components/schemas/OperationFailure" });
    }
  });

  it("emits an optional delete body for acknowledgement without concurrency", () => {
    const acknowledgedContract = structuredClone(contract);
    delete acknowledgedContract.entityOperations.delete!.concurrency;
    acknowledgedContract.entityOperations.delete!.interaction = {
      confirmation: { mode: "acknowledgement" },
    };
    const generated = JSON.parse(
      renderOpenApiSpec(manifest, "fixture", {
        entities: [{ contract: withDerivedErrors(acknowledgedContract) }],
      }),
    ) as any;
    const inputSchema = generated.components.schemas.RelationDeleteInput;
    const deleteOperation =
      generated.paths["/api/rest/v1/relations/{id}"].delete;

    expect(inputSchema.properties.confirmed).toMatchObject({ type: "boolean" });
    expect(inputSchema.required).toBeUndefined();
    expect(deleteOperation.requestBody).toMatchObject({
      required: false,
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/RelationDeleteInput" },
        },
      },
    });
    expect(deleteOperation.responses["428"].content["application/json"].schema)
      .toEqual({ $ref: "#/components/schemas/OperationFailure" });
  });

  it("keeps response properties storage-derived while retaining entity documentation", () => {
    const generated = spec();
    const relation = generated.components.schemas.Relation as {
      description?: string;
      properties: Record<string, Record<string, unknown>>;
    };

    expect(relation.description).toBe("Canonical relation aggregate.");
    expect(relation.properties.displayName).toEqual({ type: "string" });
    expect(relation.properties.relationType).toEqual({ type: "string" });
    expect(relation.properties.metadata).toEqual({});
    expect(relation.properties.iban).toEqual({ type: "string" });
    expect(relation.properties.relationGroupId).toEqual({
      type: "string",
      format: "uuid",
    });
  });

  it("models create requiredness, partial PATCH, immutability, and secure fields", () => {
    const schemas = spec().components.schemas;
    const create = schemas.RelationInput as {
      required?: string[];
      properties: Record<string, Record<string, unknown>>;
    };
    const update = schemas.RelationUpdateInput as {
      required?: string[];
      properties: Record<string, Record<string, unknown>>;
    };

    expect(create.required).toEqual(["relationType"]);
    expect(create.properties.externalId).toBeDefined();
    expect(create.properties.generatedKey).toBeUndefined();
    expect(create.properties.displayName).toMatchObject({
      type: "string",
      title: "Display name",
      description: "Human-readable relation name.",
      minLength: 1,
      maxLength: 200,
      default: "Unnamed relation",
    });
    expect(create.properties.relationType).toMatchObject({
      type: "string",
      enum: ["person", "organization"],
      title: "Relation type",
    });
    expect(create.properties.externalId?.description).toBe(
      "Identifier in the owning external system. References the ExternalSystem entity.",
    );
    expect(create.properties.iban).toEqual({ type: "string" });
    expect(update.required).toEqual(["expectedVersion", "leaseToken"]);
    expect(update.properties.expectedVersion).toMatchObject({
      type: "string",
      format: "date-time",
    });
    expect(update.properties.leaseToken).toMatchObject({
      type: "string",
      minLength: 1,
    });
    expect(update.properties.externalId).toBeUndefined();
    expect(update.properties.generatedKey).toBeUndefined();
    expect(update.properties.displayName?.default).toBeUndefined();
    expect(create.properties.metadata).toBeUndefined();
    expect(update.properties.metadata).toBeUndefined();
  });

  it("projects authored JSON schemas for plugin-backed canonical CRUD", () => {
    const pluginContract = structuredClone(contract) as CompiledEntityContract;
    pluginContract.entityOperations.create = {
      ...pluginContract.entityOperations.create!,
      key: "create",
      entityId: "relation",
      entityName: "Relation",
      name: "Create relation atomically",
      description: "Validate and create the canonical relation head.",
      implementation: {
        type: "plugin",
        plugin: "example",
        handler: "createRelation",
      },
      target: {
        entityId: "relation",
        entityName: "Relation",
        scope: "collection",
      },
      input: {
        kind: "json-schema",
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["requestKey", "definition"],
          properties: {
            requestKey: { type: "string", format: "uuid" },
            definition: { type: "object" },
          },
        },
      },
      output: {
        kind: "json-schema",
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["id", "displayName"],
          properties: {
            id: { type: "string", format: "uuid" },
            displayName: { type: "string" },
          },
        },
      },
      authorization: { action: "create", roles: ["Relations.Write"] },
      effects: { data: "write", external: "none" },
      reliability: { idempotency: { mode: "keyed", inputField: "requestKey" } },
      interaction: { confirmation: { mode: "acknowledgement" } },
      interfaces: {
        rest: {
          method: "POST",
          path: "/api/example/relations",
          response: { status: 202, kind: "json" },
        },
      },
    };
    pluginContract.entityOperations.update = {
      ...pluginContract.entityOperations.update!,
      key: "update",
      entityId: "relation",
      entityName: "Relation",
      name: "Update relation atomically",
      description: "Validate and update the canonical relation head.",
      implementation: {
        type: "plugin",
        plugin: "example",
        handler: "updateRelation",
      },
      target: {
        entityId: "relation",
        entityName: "Relation",
        scope: "record",
        inputField: "relationId",
      },
      input: {
        kind: "json-schema",
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["relationId", "requestKey", "definition"],
          properties: {
            relationId: { type: "string", format: "uuid" },
            requestKey: { type: "string", format: "uuid" },
            definition: { type: "object" },
          },
        },
      },
      output: {
        kind: "json-schema",
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["id", "displayName"],
          properties: {
            id: { type: "string", format: "uuid" },
            displayName: { type: "string" },
          },
        },
      },
      authorization: { action: "update", roles: ["Relations.Write"] },
      effects: { data: "write", external: "none" },
      reliability: { idempotency: { mode: "keyed", inputField: "requestKey" } },
      interaction: { confirmation: { mode: "none" } },
      interfaces: {
        rest: {
          method: "PUT",
          path: "/api/example/relations/:relationId",
          response: { kind: "json" },
        },
      },
    };

    const generated = JSON.parse(
      renderOpenApiSpec(manifest, "fixture", {
        entities: [{ contract: withDerivedErrors(pluginContract) }],
      }),
    ) as any;

    expect(generated.components.schemas.RelationInput).toMatchObject({
      required: ["requestKey", "definition"],
      properties: {
        requestKey: { type: "string", format: "uuid" },
        definition: { type: "object" },
        confirmed: { type: "boolean" },
      },
    });
    expect(generated.components.schemas.RelationInput.properties).not.toHaveProperty(
      "relationType",
    );
    expect(generated.components.schemas.RelationUpdateInput).toMatchObject({
      required: [
        "relationId",
        "requestKey",
        "definition",
        "expectedVersion",
        "leaseToken",
      ],
      properties: {
        relationId: { type: "string", format: "uuid" },
        expectedVersion: { type: "string", format: "date-time" },
        leaseToken: { type: "string" },
      },
    });
    expect(
      generated.paths["/api/example/relations"].post.responses["202"].content[
        "application/json"
      ].schema,
    ).toEqual({ $ref: "#/components/schemas/RelationCreateResult" });
    expect(generated.components.schemas.RelationCreateResult.properties.data)
      .toEqual({
        type: "object",
        additionalProperties: false,
        required: ["id", "displayName"],
        properties: {
          id: { type: "string", format: "uuid" },
          displayName: { type: "string" },
        },
      });
    expect(
      generated.paths["/api/example/relations/{relationId}"].put.responses["200"].content[
        "application/json"
      ].schema,
    ).toEqual({ $ref: "#/components/schemas/RelationUpdateResult" });
    expect(generated.paths["/api/rest/v1/relations"].post).toBeUndefined();
    expect(generated.paths["/api/rest/v1/relations/{id}"].patch).toBeUndefined();
    expect(
      generated.paths["/api/example/relations/{relationId}"].parameters,
    ).toEqual([
      expect.objectContaining({ name: "relationId", in: "path", required: true }),
    ]);
  });

  it("documents version-bound server confirmation controls for delete", () => {
    const generated = spec();
    const deletion = generated.components.schemas.RelationDeleteInput as {
      required: string[];
      properties: Record<string, Record<string, unknown>>;
      dependentRequired: Record<string, string[]>;
    };

    expect(deletion.required).toEqual(["expectedVersion", "leaseToken"]);
    expect(deletion.dependentRequired).toEqual({
      confirmationToken: ["confirmationAnswer"],
      confirmationAnswer: ["confirmationToken"],
    });
    expect(deletion.properties.expectedVersion).toMatchObject({
      type: "string",
      format: "date-time",
    });
    expect(deletion.properties.confirmationToken).toMatchObject({ minLength: 1 });
    expect(deletion.properties.leaseToken).toMatchObject({ minLength: 1 });
    expect(deletion.properties.confirmationAnswer?.description).toContain(
      "displayName",
    );
    expect(
      generated.paths["/api/rest/v1/relations/{id}"]?.delete?.requestBody
        ?.content?.["application/json"]?.schema,
    ).toEqual({ $ref: "#/components/schemas/RelationDeleteInput" });
  });

  it("documents the central edit-lease issuer instead of entity-specific lease routes", () => {
    const generated = spec();
    const acquireInput = generated.components.schemas.EditLeaseAcquireInput as {
      properties: { operationId: { enum: string[] } };
    };

    expect(generated.paths["/api/operation-leases"]?.post?.requestBody
      ?.content?.["application/json"]?.schema).toEqual({
        $ref: "#/components/schemas/EditLeaseAcquireInput",
      });
    expect(acquireInput.properties.operationId.enum).toEqual([
      "Relation.delete",
      "Relation.update",
    ]);
    const acquireData = generated.components.schemas.EditLeaseAcquireData as {
      required: string[];
      properties: Record<string, unknown>;
    };
    const renewData = generated.components.schemas.EditLeaseRenewData as {
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(acquireData.required).toContain("leaseToken");
    expect(acquireData.properties).toHaveProperty("leaseToken");
    expect(renewData.required).not.toContain("leaseToken");
    expect(renewData.properties).not.toHaveProperty("leaseToken");
    expect(
      generated.paths["/api/operation-leases"]?.post?.responses?.["201"]
        ?.content?.["application/json"]?.schema,
    ).toEqual({ $ref: "#/components/schemas/EditLeaseAcquireResult" });
    expect(
      generated.paths["/api/operation-leases/renew"]?.post?.responses?.["200"]
        ?.content?.["application/json"]?.schema,
    ).toEqual({ $ref: "#/components/schemas/EditLeaseRenewResult" });
    expect(generated.paths["/api/operation-leases/release"]?.post).toBeDefined();
    expect(
      Object.keys(generated.paths).some((path) =>
        /relations.*(?:lease|lock)|(?:lease|lock).*relations/i.test(path),
      ),
    ).toBe(false);
  });

  it("allowlists only strict-v2 lease operations actually projected to REST", () => {
    const restTable = structuredClone(manifest.tables[0]!);
    restTable.source!.rest!.operations.delete = false;

    const nonRestContract = structuredClone(contract);
    nonRestContract.entity.name = "PrivateRecord";
    nonRestContract.entityOperations.update!.id = "PrivateRecord.update";
    nonRestContract.entityOperations.delete!.id = "PrivateRecord.delete";
    delete nonRestContract.rest;
    nonRestContract.mcp = structuredClone(manifest.tables[0]!.source!.mcp!);
    nonRestContract.interfaces = {
      web: { operations: { update: true, delete: true } },
    };

    const nonRestTable = structuredClone(manifest.tables[0]!);
    nonRestTable.name = "private_records";
    nonRestTable.source!.authoringEntityName = "PrivateRecord";
    delete nonRestTable.source!.rest;

    const generated = JSON.parse(
      renderOpenApiSpec(
        { ...manifest, tables: [restTable, nonRestTable] },
        "fixture",
        { entities: [{ contract: withDerivedErrors(contract) }, { contract: withDerivedErrors(nonRestContract) }] },
      ),
    ) as any;
    expect(
      generated.components.schemas.EditLeaseAcquireInput.properties.operationId
        .enum,
    ).toEqual(["Relation.update"]);

    const nonRestOnly = JSON.parse(
      renderOpenApiSpec(
        { ...manifest, tables: [nonRestTable] },
        "fixture",
        { entities: [{ contract: withDerivedErrors(nonRestContract) }] },
      ),
    ) as any;
    expect(nonRestOnly.paths["/api/operation-leases"]).toBeUndefined();
    expect(
      nonRestOnly.components.schemas.EditLeaseAcquireInput,
    ).toBeUndefined();
  });

  it("bundles the recursive FieldDefinition contract in generated request schemas", () => {
    const semanticContract = structuredClone(contract);
    semanticContract.model.fields.push(
      field({
        key: "definition",
        baseType: "object",
        osfType: "fieldDefinition",
      }),
    );
    const semanticManifest = structuredClone(manifest);
    semanticManifest.tables[0]!.columns.push({
      name: "definition",
      type: "jsonb",
      sourceField: "definition",
    });
    const generated = JSON.parse(
      renderOpenApiSpec(semanticManifest, "fixture", {
        entities: [{ contract: withDerivedErrors(semanticContract) }],
      }),
    ) as { components: { schemas: Record<string, Record<string, unknown>> } };
    const create = generated.components.schemas.RelationInput as {
      properties: Record<string, Record<string, unknown>>;
      $defs?: Record<string, unknown>;
    };
    const fieldDefinition = generated.components.schemas
      .OpenShapeForgeFieldDefinition as {
      $ref?: string;
      $defs?: Record<string, unknown>;
    };

    expect(create.properties.definition?.$ref).toBe(
      "#/components/schemas/OpenShapeForgeFieldDefinition/$defs/fieldDefinition",
    );
    expect(create.$defs).toBeUndefined();
    expect(fieldDefinition.$ref).toBe(
      "#/components/schemas/OpenShapeForgeFieldDefinition/$defs/fieldDefinition",
    );
    expect(fieldDefinition.$defs).toMatchObject({
      fieldDefinition: {
        allOf: [
          {
            $ref: "#/components/schemas/OpenShapeForgeFieldDefinition/$defs/fieldDefinitionProperties",
          },
        ],
      },
    });
  });

  it("tags operations with the compiled entity description", () => {
    const generated = spec();
    expect(generated.tags).toEqual([
      {
        name: "Files",
        description: "Authenticated streaming transport for temporary and record-bound files. Storage policy and authorization remain server-side.",
      },
      {
        name: "Edit leases",
        description: "Central leases for long-running record write modes.",
      },
      { name: "Relation", description: "Canonical relation aggregate." },
    ]);
    expect(generated.paths["/api/rest/v1/relations"]?.post?.tags).toEqual([
      "Relation",
    ]);
  });

  it("documents pagination and sorting with the runtime defaults and supported fields", () => {
    const parameters =
      spec().paths["/api/rest/v1/relations"]?.get?.parameters ?? [];
    const byName = new Map(
      parameters.map((parameter) => [parameter.name, parameter]),
    );

    expect(byName.get("first")).toEqual({
      name: "first",
      in: "query",
      description:
        "Number of records to return. When absent it defaults to 50; supplied values are clamped to 1-200.",
      schema: { type: "integer", minimum: 1, maximum: 200, default: 50 },
    });
    expect(byName.get("after")?.description).toContain("nextCursor");
    expect(byName.get("sortField")?.schema).toEqual({
      type: "string",
      enum: [
        "id",
        "displayName",
        "relationType",
        "externalId",
        "generatedKey",
        "first",
        "status",
        "statusIn",
        "isOptedIn",
        "marker",
        "sequenceNumber",
        "relationGroupId",
        "createdAt",
      ],
      default: "id",
    });
    expect(byName.get("sortDirection")?.schema).toEqual({
      type: "string",
      enum: ["asc", "desc"],
      default: "asc",
    });
  });

  it("projects scalar field semantics into direct and explicit IN filters", () => {
    const parameters =
      spec().paths["/api/rest/v1/relations"]?.get?.parameters ?? [];
    const byName = new Map(
      parameters.map((parameter) => [parameter.name, parameter]),
    );

    expect(byName.get("displayName")).toMatchObject({
      description:
        "Human-readable relation name. Matches a case-insensitive substring. Repeat this parameter to instead match exactly against any supplied value.",
      schema: { type: "string" },
    });
    expect(byName.get("displayName")?.schema.default).toBeUndefined();
    expect(byName.get("displayNameIn")?.schema).toEqual({
      type: "array",
      items: { type: "string" },
    });
    expect(byName.get("relationType")?.schema).toEqual({ type: "string" });
    expect(byName.get("relationType")?.description).not.toContain(
      "Allowed values:",
    );
    expect(byName.get("relationTypeIn")?.description).not.toContain(
      "Allowed values:",
    );
    expect(byName.get("relationTypeIn")).toMatchObject({
      style: "form",
      explode: true,
      schema: {
        type: "array",
        items: { type: "string" },
      },
    });
    expect(byName.get("relationGroupId")?.schema).toEqual({
      type: "string",
      format: "uuid",
    });
    expect(byName.has("metadata")).toBe(false);
    expect(byName.has("metadataIn")).toBe(false);
    expect(byName.has("iban")).toBe(false);
    expect(byName.has("ibanIn")).toBe(false);
    expect(byName.has("tenantId")).toBe(false);
    expect(byName.has("tenantIdIn")).toBe(false);
    expect(byName.has("privateMarker")).toBe(false);
    expect(byName.has("privateMarkerIn")).toBe(false);
    expect(byName.get("sequenceNumber")?.schema).toEqual({ type: "integer" });
  });

  it("avoids transport and explicit-IN parameter name collisions", () => {
    const parameters =
      spec().paths["/api/rest/v1/relations"]?.get?.parameters ?? [];
    const names = parameters.map((parameter) => parameter.name);
    const byName = new Map(
      parameters.map((parameter) => [parameter.name, parameter]),
    );

    expect(new Set(names).size).toBe(names.length);
    expect(names.filter((name) => name === "first")).toHaveLength(1);
    expect(byName.get("first")?.description).toContain("Number of records");
    expect(byName.get("firstIn")?.description).toContain(
      "Business sequence value.",
    );
    expect(byName.has("statusIn")).toBe(false);
    expect(byName.get("statusInIn")?.description).toContain(
      "Status import marker.",
    );
    expect(byName.has("isOptedIn")).toBe(false);
    expect(byName.get("isOptedInIn")?.schema).toEqual({
      type: "array",
      items: { type: "boolean" },
    });
    expect(byName.has("markerIn")).toBe(false);
  });

  it("documents the item path identifier", () => {
    const parameters = spec().paths["/api/rest/v1/relations/{id}"]?.parameters;
    expect(parameters).toEqual([
      {
        name: "id",
        in: "path",
        required: true,
        description: "Unique identifier of the Relation record.",
        schema: { type: "string", format: "uuid" },
      },
    ]);
  });
});
